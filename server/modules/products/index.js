const crypto = require("crypto");
const { parseProductInput } = require("./model");
const { createProductsService } = require("./service");
const { createUploads } = require("./upload");

module.exports = {
  name: "products",
  setup(core) {
    const repo = core.storage.repository("products");
    repo.list();
    const service = createProductsService({ repo });
    const { handleUpload, removeImage } = createUploads({ uploadsDir: core.config.uploadsDir, logger: core.logger });

    core.services.register("products", service);

    core.ai.facts.set("catalog", () => service.catalogText());
    core.ai.prompt.addSection(
      "catalog",
      () => `Текущая витрина:\n${service.catalogText({ limit: service.promptCatalogLimit })}`,
      { order: 50 }
    );
    core.ai.tools.register({
      name: "search_catalog",
      description: "Ищет товары и услуги на витрине по словам из запроса. Возвращает название, цену и описание.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Слова для поиска, например «реклама» или «Reels»" } },
        required: ["query"],
      },
      handler: ({ query }) => ({ items: service.search(query) }),
    });

    core.http.route((router, { auth, asyncHandler }) => {
      router.get("/api/products", (_req, res) => {
        res.json(service.listSorted());
      });

      router.post(
        "/api/products",
        auth,
        handleUpload,
        asyncHandler(async (req, res) => {
          const uploaded = req.file ? `/uploads/${req.file.filename}` : "";
          const input = parseProductInput(req.body);
          if (input.error) {
            removeImage(uploaded);
            return res.status(400).json({ error: input.error });
          }
          if (!uploaded) return res.status(400).json({ error: "Добавьте фото товара" });

          const now = new Date().toISOString();
          // updatedAt from the start, so two admin tabs editing a brand-new product
          // hit the 409 check instead of silently overwriting each other.
          const product = {
            id: crypto.randomUUID(),
            ...input.value,
            image: uploaded,
            createdAt: now,
            updatedAt: now,
          };
          try {
            await repo.insert(product);
          } catch (err) {
            removeImage(uploaded);
            throw err;
          }
          core.events.emit("product.created", { product });
          res.status(201).json(product);
        })
      );

      router.put(
        "/api/products/:id",
        auth,
        handleUpload,
        asyncHandler(async (req, res) => {
          const uploaded = req.file ? `/uploads/${req.file.filename}` : "";
          let oldImage = "";
          let result;
          try {
            result = await repo.update(req.params.id, (current, tx) => {
              if (!current) {
                tx.skipWrite();
                return { status: 404, body: { error: "Товар не найден" } };
              }
              const input = parseProductInput(req.body);
              if (input.error) {
                tx.skipWrite();
                return { status: 400, body: { error: input.error } };
              }
              if (
                req.body?.updatedAt !== undefined &&
                current.updatedAt &&
                String(req.body.updatedAt) !== String(current.updatedAt)
              ) {
                tx.skipWrite();
                return {
                  status: 409,
                  body: { error: "Товар уже изменили. Закройте окно и откройте его заново." },
                };
              }
              if (uploaded) {
                oldImage = current.image;
                current.image = uploaded;
              }
              Object.assign(current, input.value, { updatedAt: new Date().toISOString() });
              return { status: 200, body: current };
            });
          } catch (err) {
            removeImage(uploaded);
            throw err;
          }

          if (result.status !== 200) {
            removeImage(uploaded);
            return res.status(result.status).json(result.body);
          }
          // Only after the new record is saved, so a failed write never leaves
          // the product pointing at a deleted photo.
          if (oldImage) removeImage(oldImage);
          core.events.emit("product.updated", { product: result.body });
          res.json(result.body);
        })
      );

      router.delete(
        "/api/products/:id",
        auth,
        asyncHandler(async (req, res) => {
          const removed = await repo.remove(req.params.id);
          if (!removed) return res.status(404).json({ error: "Товар не найден" });
          removeImage(removed.image);
          core.events.emit("product.deleted", { product: removed });
          res.json({ ok: true });
        })
      );
    });
  },
};
