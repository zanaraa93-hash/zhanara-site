const { createRuleProvider } = require("../../core/ai/providers/fallback");
const { INTRO, RULES, NO_CATALOG, toolsHint, fallbackRules } = require("./persona");

module.exports = {
  name: "chat",
  optional: true,
  setup(core) {
    core.ai.prompt.addSection("persona", () => INTRO, { order: 10 });
    // Keeps the prompt valid when the products module is switched off.
    core.ai.prompt.addSection(
      "catalog-placeholder",
      () => (core.services.has("products") ? "" : `Текущая витрина:\n${NO_CATALOG}`),
      { order: 50 }
    );
    core.ai.prompt.addSection("rules", () => RULES, { order: 90 });
    core.ai.prompt.addSection("tools-hint", () => toolsHint(core.services.has), { order: 95 });

    core.ai.setFallback(createRuleProvider(fallbackRules(() => core.ai.facts.get("catalog"))));

    core.http.route((router, { rateLimit, asyncHandler }) => {
      const chatLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 30,
        message: "Слишком много сообщений. Напишите Жанаре в Telegram @Zhanara84.",
      });
      const uploadLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 20,
        message: "Слишком много файлов подряд. Отправьте их Жанаре в Telegram @Zhanara84.",
      });

      // Files are parsed once here; chat messages then refer to them by id, so
      // the content survives across turns without being re-uploaded.
      router.post(
        "/api/chat/attachments",
        uploadLimiter,
        core.files.uploadMiddleware("files"),
        asyncHandler(async (req, res) => {
          const incoming = Array.isArray(req.files) ? req.files : [];
          if (!incoming.length) return res.status(400).json({ error: "Прикрепите файл" });
          const attachments = [];
          for (const file of incoming) attachments.push(await core.files.ingest(file));
          res.json({ attachments });
        })
      );

      // `source` tells the widget (and anyone debugging) whether the model or
      // the built-in rules answered; the reason is kept in server logs/health.
      router.post("/api/chat", chatLimiter, async (req, res) => {
        try {
          const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
          const { reply, source } = await core.ai.chat(incoming);
          res.json({ reply, source });
        } catch (err) {
          core.logger.error("Чат упал", { requestLogId: req.id, error: err?.stack || String(err) });
          res.status(500).json({ error: "Сейчас чат недоступен. Напишите в Telegram @Zhanara84." });
        }
      });
    });
  },
};
