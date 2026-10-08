const path = require("path");
const { createPdfRunner, assertPdfReady } = require("../../core/pdf/runner");
const { buildInvoice, invoiceFileName, invoiceNumber } = require("./model");

const ORDER_ID = /^[\w-]{1,64}$/;

// Read-only: downloading an invoice never changes the order, the client card
// or Telegram, and never takes prices or titles from the current catalog.
module.exports = {
  name: "order-invoice",
  dependsOn: ["orders"],
  optional: true,
  setup(core) {
    assertPdfReady();

    const orders = core.storage.repository("orders");
    const runner = createPdfRunner({ renderer: path.join(__dirname, "render.js"), timeoutMs: 30000, memoryMb: 256 });
    core.onStop(() => runner.stop());

    core.http.route((router, { auth, rateLimit, asyncHandler }) => {
      const invoiceLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30,
        message: "Слишком много запросов счетов подряд. Подождите минуту.",
      });

      router.get(
        "/api/orders/:id/invoice.pdf",
        auth,
        invoiceLimiter,
        asyncHandler(async (req, res) => {
          const id = String(req.params.id || "");
          if (!ORDER_ID.test(id)) return res.status(404).json({ error: "Заказ не найден" });

          let order;
          try {
            order = orders.get(id);
          } catch (err) {
            core.logger.error(`Счёт-фактура: не удалось прочитать заказ (id запроса ${req.id}):`, err);
            return res.status(500).json({ error: "Не удалось получить данные заказа. Попробуйте ещё раз." });
          }
          if (!order || typeof order !== "object") return res.status(404).json({ error: "Заказ не найден" });

          let invoice;
          try {
            invoice = buildInvoice(order);
          } catch (err) {
            core.logger.error(`Счёт-фактура № ${invoiceNumber(order)}: данные заказа не разобраны (id запроса ${req.id}):`, err);
            return res.status(500).json({ error: "Не удалось сформировать PDF. Попробуйте ещё раз." });
          }
          if (!invoice.rows.length) {
            return res.status(422).json({ error: "В заказе нет позиций — счёт-фактуру сформировать нельзя." });
          }
          if (invoice.totalsMismatch) {
            core.logger.warn(`Счёт-фактура № ${invoice.number}: сохранённый итог не совпадает с позициями, итог пересчитан по позициям.`);
          }

          let result;
          try {
            result = await runner.render({ invoice, generatedAt: new Date().toISOString() });
          } catch (err) {
            core.logger.error(`Счёт-фактура № ${invoiceNumber(order)} не сформирована (id запроса ${req.id}): ${err.message}`);
            return res.status(500).json({ error: "Не удалось сформировать PDF. Попробуйте ещё раз." });
          }

          const warnings = [...result.warnings];
          if (invoice.totalsMismatch) warnings.push("итог пересчитан по позициям");
          result.warnings.forEach((warning) => core.logger.warn(`Счёт-фактура № ${invoice.number}: ${warning}`, { requestLogId: req.id }));

          res.attachment(invoiceFileName(order));
          res.set("Cache-Control", "no-store");
          res.set("X-PDF-Warnings", String(warnings.length));
          res.send(result.pdf);
        })
      );
    });
  },
};
