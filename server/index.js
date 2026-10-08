const { createCore } = require("./core/kernel");
const modules = require("./modules");

async function main() {
  const core = createCore();

  process.on("unhandledRejection", (reason) => {
    core.logger.error("Необработанная ошибка в промисе:", reason);
  });
  // The process is restarted by the supervisor (see scripts/supervisor.js),
  // so after an unknown failure it is safer to exit than to keep running.
  process.on("uncaughtException", (err) => {
    core.logger.error("Критическая ошибка, сервер останавливается:", err);
    shutdown(1, "uncaughtException");
  });

  let exiting = false;
  function shutdown(code, reason) {
    if (exiting) return;
    exiting = true;
    core.logger.info("Остановка сервера", { reason, pid: process.pid });
    // Hard stop in case a hanging request or subscriber blocks the graceful path.
    setTimeout(() => {
      core.logger.error("Остановка не завершилась вовремя — принудительный выход", { reason });
      process.exit(code);
    }, core.config.shutdownTimeoutMs + 2000).unref();
    core
      .stop()
      .then(() => core.logger.info("Сервер остановлен, база закрыта", { reason }))
      .catch((err) => core.logger.error("Ошибка при остановке:", err))
      .finally(() => process.exit(code));
  }
  process.on("SIGINT", () => shutdown(0, "SIGINT"));
  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGHUP", () => shutdown(0, "SIGHUP"));
  process.on("message", (message) => {
    if (message?.type === "shutdown") shutdown(0, "supervisor");
  });
  // Started by the supervisor: if it is killed, this process must not stay
  // behind holding the port, or the next supervisor could never start a server.
  if (process.send) process.on("disconnect", () => shutdown(0, "supervisor_gone"));

  try {
    await core.start(modules);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      core.logger.error(
        `Порт ${core.config.port} уже занят — сайт, скорее всего, уже запущен в другом окне или как служба. Закройте его и запустите снова.`
      );
    } else {
      core.logger.error("Сервер не запустился:", err);
    }
    try {
      await core.stop();
    } catch (stopErr) {
      core.logger.error("Ошибка при остановке:", stopErr);
    }
    process.exit(1);
  }

  const shown = core.config.host === "0.0.0.0" || core.config.host === "::" ? "localhost" : core.config.host;
  core.logger.info(`Сайт:   http://${shown}:${core.config.port}`);
  core.logger.info(`Админка: http://${shown}:${core.config.port}/admin`);
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} ERROR app Сервер не запустился:`, err);
  process.exit(1);
});
