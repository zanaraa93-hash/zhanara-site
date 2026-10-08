const crypto = require("crypto");
const express = require("express");
const { createRateLimiter } = require("./rateLimit");
const { registerStatic } = require("./static");

// Express 4 does not catch rejected promises from async handlers on its own.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createHttp({ config, logger, services }) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy !== false) {
    try {
      app.set("trust proxy", config.trustProxy);
    } catch (err) {
      // Express rejects unknown names and bad subnets; a typo must not stop the site.
      app.set("trust proxy", false);
      logger.warn(`ВНИМАНИЕ: TRUST_PROXY="${config.trustProxy}" не распознан (${err.message}), прокси не доверяю.`);
    }
  }

  app.use((req, res, next) => {
    req.id = crypto.randomBytes(4).toString("hex");
    res.set({
      "X-Request-Id": req.id,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    });
    next();
  });

  app.use(express.json({ limit: "100kb" }));

  // Resolved per request so modules can be registered in any order, and a
  // missing auth module fails closed instead of leaving admin routes open.
  function auth(req, res, next) {
    const authService = services.get("auth");
    if (!authService) {
      return res.status(503).json({ error: "Вход в админку сейчас недоступен" });
    }
    return authService.requireAuth(req, res, next);
  }

  const helpers = { auth, rateLimit: (options) => createRateLimiter({ ...options, logger }), asyncHandler };
  let finalized = false;

  // Routes are collected into a router that the kernel mounts only after the
  // module's setup() has fully succeeded.
  function createRouter(register) {
    if (finalized) throw new Error("Маршруты нельзя добавлять после запуска сервера");
    const router = express.Router();
    register(router, helpers);
    return router;
  }

  function mount(router) {
    if (finalized) throw new Error("Маршруты нельзя добавлять после запуска сервера");
    app.use(router);
  }

  function finalize() {
    finalized = true;
    registerStatic(app, config);

    app.use("/api", (_req, res) => {
      res.status(404).json({ error: "Не найдено" });
    });

    app.use((_req, res) => {
      res.status(404).type("text/plain; charset=utf-8").send("Страница не найдена");
    });

    app.use((err, req, res, next) => {
      if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Некорректный запрос" });
      }
      if (err.type === "entity.too.large") {
        return res.status(413).json({ error: "Слишком большой запрос" });
      }
      logger.error(`Ошибка запроса ${req.method} ${req.path}`, { requestLogId: req.id, error: err?.stack || String(err) });
      if (res.headersSent) return next(err);
      res.status(500).json({ error: "Серверная ошибка" });
    });
  }

  return { app, helpers, createRouter, mount, finalize };
}

module.exports = { createHttp, asyncHandler };
