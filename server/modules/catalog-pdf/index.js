const path = require("path");
const { createPdfRunner, assertPdfReady } = require("../../core/pdf/runner");
const { positionsLabel, formatPdfDate, fileDateStamp } = require("../../core/pdf/format");

// Only fields the storefront shows to visitors; ids, timestamps and the admin
// quantity never reach the PDF generator.
function toCatalogItem(product) {
  return {
    title: String(product.title || ""),
    description: String(product.description || ""),
    price: product.price ?? null,
    currency: product.currency,
    type: product.type,
    image: String(product.image || ""),
  };
}

module.exports = {
  name: "catalog-pdf",
  dependsOn: ["products"],
  optional: true,
  setup(core) {
    assertPdfReady();

    const products = core.services.require("products");
    const runner = createPdfRunner({ renderer: path.join(__dirname, "render.js"), timeoutMs: 60000, memoryMb: 512 });
    core.onStop(() => runner.stop());

    core.http.route((router, { auth, rateLimit, asyncHandler }) => {
      const catalogLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        message: "Каталог уже формируется слишком часто. Подождите минуту.",
      });

      router.get(
        "/api/products/catalog.pdf",
        auth,
        catalogLimiter,
        asyncHandler(async (req, res) => {
          let items;
          try {
            // Same list and order as GET /api/products, i.e. the storefront.
            items = products.listSorted().map(toCatalogItem);
          } catch (err) {
            core.logger.error(`Каталог PDF: не удалось прочитать товары (id ${req.id}):`, err);
            return res.status(500).json({ error: "Не удалось прочитать товары из базы. Попробуйте ещё раз." });
          }
          if (!items.length) return res.status(404).json({ error: "Нет товаров для формирования каталога" });

          const now = new Date();
          let result;
          try {
            result = await runner.render({
              items,
              uploadsDir: core.config.uploadsDir,
              dateLabel: formatPdfDate(now),
              countLabel: positionsLabel(items.length),
              generatedAt: now.toISOString(),
            });
          } catch (err) {
            core.logger.error(`Каталог PDF не сформирован (id ${req.id}): ${err.message}`);
            return res.status(500).json({ error: "Не удалось сформировать PDF-каталог. Попробуйте ещё раз." });
          }
          result.warnings.forEach((warning) => core.logger.warn(`Каталог PDF: ${warning}`, { requestLogId: req.id }));

          res.attachment(`catalog-${fileDateStamp(now)}.pdf`);
          res.set("Cache-Control", "no-store");
          // The PDF is still useful with a placeholder photo, but the admin must
          // know it is not the complete document.
          res.set("X-PDF-Warnings", String(result.warnings.length));
          res.send(result.pdf);
        })
      );
    });
  },
};
