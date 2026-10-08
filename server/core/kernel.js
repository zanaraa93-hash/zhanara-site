const crypto = require("crypto");
const fs = require("fs");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { createEventBus } = require("./events");
const { createStorage } = require("./storage");
const { createServiceRegistry } = require("./services");
const { createHttp } = require("./http/app");
const { frontendBuilt } = require("./http/static");
const { createAI } = require("./ai");
const { createFiles } = require("./files");
const { loadModules } = require("./registry");

const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

function createCore({ env = process.env } = {}) {
  const { config, warnings } = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, dir: config.logDir });
  warnings.forEach((message) => logger.warn(`ВНИМАНИЕ: ${message}`));

  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const services = createServiceRegistry();
  const events = createEventBus({ logger: logger.child("events") });
  const storage = createStorage({
    dataDir: config.dataDir,
    logger: logger.child("storage"),
    backupDir: config.backup.dir,
    keepDaily: config.backup.keepDaily,
    autoRestoreMaxAgeHours: config.backup.autoRestoreMaxAgeHours,
  });
  const files = createFiles({ config, logger: logger.child("files") });
  const ai = createAI({ config, logger: logger.child("ai"), files });
  const http = createHttp({ config, logger: logger.child("http"), services });

  const auditLogger = logger.child("audit");
  let auditRepo = null;
  try {
    auditRepo = storage.repository("audit");
  } catch {
    // A broken database is reported by health and stops required modules.
  }

  // Critical actions go both to the log file and to the database, so the
  // history of an order survives a lost log and a lost log survives the database.
  function audit(action, fields = {}) {
    auditLogger.info(action, fields);
    if (!auditRepo) return Promise.resolve();
    return auditRepo
      .insert({ id: crypto.randomUUID(), at: new Date().toISOString(), action, ...fields })
      .catch((err) => logger.error("Не удалось записать событие аудита в базу", { action, error: err.message }));
  }

  const checks = new Map();
  const health = {
    register(name, fn) {
      checks.set(name, fn);
      return () => {
        if (checks.get(name) === fn) checks.delete(name);
      };
    },
  };

  health.register("ai", (options) => ai.health(options));

  const core = { config, logger, events, storage, services, ai, http, files, audit, health };
  let server = null;
  let stopHooks = [];
  let modulesState = { loaded: [], failed: [] };
  let stopping = null;
  const startedAt = Date.now();

  function storageCheck() {
    const problems = storage.health();
    return problems.length ? { status: "down", problems: problems.map((item) => item.name) } : { status: "ok" };
  }

  function backupCheck() {
    const state = storage.status();
    const result = {
      status: "ok",
      lastBackupOkAt: state.lastBackupOkAt,
      lastBackupError: state.lastBackupError || undefined,
    };
    // A copy is made at startup and after writes, so a quiet day without a new
    // copy is fine; a failed or never-made copy is not.
    if (state.lastBackupError || !state.lastBackupOkAt) result.status = "degraded";
    if (state.recovery) {
      result.status = "degraded";
      result.recovery = state.recovery;
    }
    return result;
  }

  function runChecks({ detailed }) {
    const results = { storage: storageCheck(), backup: backupCheck() };
    for (const [name, fn] of checks) {
      try {
        results[name] = fn({ detailed });
      } catch (err) {
        results[name] = { status: "down", error: err.message };
      }
    }
    const statuses = Object.values(results).map((item) => item.status);
    let status = "ok";
    if (statuses.includes("degraded") || modulesState.failed.length) status = "degraded";
    if (results.storage.status === "down") status = "down";
    if (!detailed) {
      for (const value of Object.values(results)) {
        delete value.lastError;
        delete value.lastBackupError;
        delete value.recovery;
        delete value.problems;
        delete value.error;
      }
    }
    return { status, checks: results };
  }

  function registerHealth() {
    // Liveness: the process answers. Used by the supervisor.
    http.app.get("/api/live", (_req, res) => {
      res.json({ status: "ok", uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    });

    // Readiness: orders can be accepted and stored. Telegram and AI are not
    // part of it: an order is saved and visible in the admin panel without them.
    http.app.get("/api/ready", (_req, res) => {
      const storageState = storageCheck();
      const ready = storageState.status === "ok" && modulesState.failed.length === 0;
      res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", storage: storageState.status });
    });

    // Full health: 200 only when every dependency works, so a monitor that
    // looks at the status code alone never sees green during an outage.
    http.app.get("/api/health", (_req, res) => {
      const { status, checks: results } = runChecks({ detailed: false });
      res.status(status === "ok" ? 200 : 503).json({
        ok: status === "ok",
        status,
        storage: results.storage.status === "ok" ? "ok" : "error",
        frontend: frontendBuilt(config) ? "ok" : "missing",
        modules: { loaded: modulesState.loaded, failed: modulesState.failed },
        checks: results,
      });
    });
  }

  function registerAdminRoutes() {
    http.mount(
      http.createRouter((router, { auth, asyncHandler }) => {
        router.get("/api/admin/status", auth, (_req, res) => {
          const { status, checks: results } = runChecks({ detailed: true });
          res.json({ status, checks: results, modules: modulesState });
        });

        router.post(
          "/api/admin/recovery/ack",
          auth,
          asyncHandler(async (_req, res) => {
            const record = await storage.acknowledgeRecovery();
            if (!record) return res.status(404).json({ error: "Нет неподтверждённого восстановления базы" });
            await audit("storage.recovery.acknowledged", { recoveredAt: record.at, backupFile: record.backupFile });
            res.json({ ok: true });
          })
        );
      })
    );
  }

  async function pruneAudit() {
    if (!auditRepo) return;
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_MS).toISOString();
    await auditRepo.transaction((items, tx) => {
      const kept = items.filter((item) => String(item.at || "") >= cutoff);
      if (kept.length === items.length) return tx.skipWrite();
      items.splice(0, items.length, ...kept);
    });
  }

  async function start(modules) {
    const result = await loadModules(core, modules, { enabled: config.enabledModules });
    modulesState = { loaded: result.loaded, failed: result.failed };
    stopHooks = result.stopHooks;
    registerHealth();
    registerAdminRoutes();
    http.finalize();

    const recovery = storage.status().recovery;
    if (recovery) {
      logger.error("База работает после автоматического восстановления из копии — проверьте заказы и подтвердите в админке", recovery);
      events.emit("storage.recovered", { recovery });
    }
    pruneAudit().catch((err) => logger.error("Не удалось почистить журнал аудита", { error: err.message }));

    await new Promise((resolve, reject) => {
      server = http.app.listen(config.port, config.host, resolve);
      server.once("error", reject);
    });
    logger.info(
      `Модули: ${result.loaded.join(", ")}${result.failed.length ? ` (не запустились: ${result.failed.join(", ")})` : ""}`,
      { host: config.host, port: server.address().port }
    );
    return server;
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (server) {
        await new Promise((resolve) => {
          const force = setTimeout(() => server.closeAllConnections(), config.shutdownTimeoutMs);
          server.close(() => {
            clearTimeout(force);
            resolve();
          });
          // Idle keep-alive connections would otherwise hold close() open.
          server.closeIdleConnections();
        });
      }
      const drained = await events.drain(config.shutdownTimeoutMs);
      if (!drained) logger.warn("Не все фоновые задачи успели завершиться до остановки.");
      stopHooks.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          logger.error("Ошибка при остановке модуля:", err?.message || err);
        }
      });
      await files.stop();
      try {
        storage.close();
      } catch (err) {
        logger.error("Не удалось закрыть базу:", err?.message || err);
      }
    })();
    return stopping;
  }

  return { ...core, start, stop };
}

module.exports = { createCore };
