const crypto = require("crypto");
const { safeEqual, sha256 } = require("../../core/utils/crypto");

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

module.exports = {
  name: "auth",
  setup(core) {
    const { password, sessionTtlMs } = core.config.admin;
    const sessions = core.storage.repository("sessions");

    // Sessions are disposable: a broken session list only logs everyone out, so
    // it is reset instead of blocking the admin panel. A damaged database file
    // is not reset — clear() rethrows and startup stops.
    try {
      sessions.list();
    } catch (err) {
      core.logger.warn(`Файл сессий повреждён, все входы сброшены: ${err.message}`);
      sessions.clear();
    }

    // Only a hash is stored, so a leaked sessions file cannot be used to log in.
    const findSession = (token) => {
      if (!token) return null;
      return sessions.get(sha256(token)) || null;
    };

    const pruneExpired = () =>
      sessions.transaction((items, tx) => {
        const now = Date.now();
        const alive = items.filter((session) => session.expires >= now);
        if (alive.length === items.length) return tx.skipWrite();
        items.splice(0, items.length, ...alive);
      });

    function requireAuth(req, res, next) {
      const token = bearerToken(req);
      let session;
      try {
        session = findSession(token);
      } catch (err) {
        return next(err);
      }
      if (!session || session.expires < Date.now()) {
        if (session) {
          sessions.remove(session.id).catch((err) => core.logger.error("Не удалось удалить истёкшую сессию", { error: err.message }));
        }
        return res.status(401).json({ error: "Нужна авторизация" });
      }
      next();
    }

    core.services.register("auth", { requireAuth });

    const timer = setInterval(() => {
      pruneExpired().catch((err) => core.logger.error("Не удалось почистить сессии:", err.message));
    }, 60 * 60 * 1000);
    timer.unref();
    core.onStop(() => clearInterval(timer));

    core.http.route((router, { auth, rateLimit, asyncHandler }) => {
      const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: "Слишком много попыток входа. Подождите 15 минут.",
      });

      router.post(
        "/api/login",
        loginLimiter,
        asyncHandler(async (req, res) => {
          if (!password) {
            return res.status(503).json({
              error: core.config.admin.weakPassword
                ? "Вход отключён: пароль в ADMIN_PASSWORD слишком короткий. Задайте длинный случайный пароль в .env и перезапустите сайт."
                : "Вход отключён: задайте ADMIN_PASSWORD в .env",
            });
          }
          if (!safeEqual(req.body?.password, password)) {
            core.logger.warn("auth.login неверный пароль", { ip: req.ip, requestLogId: req.id });
            return res.status(401).json({ error: "Неверный пароль" });
          }
          const token = crypto.randomBytes(32).toString("hex");
          const now = Date.now();
          // Expired sessions are removed by the hourly cleanup above.
          await sessions.insert({ id: sha256(token), createdAt: new Date(now).toISOString(), expires: now + sessionTtlMs });
          core.audit("admin.login", { ip: req.ip });
          res.json({ token });
        })
      );

      router.get("/api/session", auth, (_req, res) => {
        res.json({ ok: true });
      });

      router.post(
        "/api/logout",
        asyncHandler(async (req, res) => {
          const token = bearerToken(req);
          if (token) await sessions.remove(sha256(token));
          res.json({ ok: true });
        })
      );
    });
  },
};
