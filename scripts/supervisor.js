// Keeps the site running: restarts the server after a crash or when it stops
// answering /api/live. Started by the scheduled task (install-autostart.ps1)
// or by "Открыть сайт.bat"; it does not depend on a console window staying open.
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("../server/core/config");
const { createLogger } = require("../server/core/logger");

const ROOT = path.resolve(__dirname, "..");
const { config } = loadConfig();
const logger = createLogger({ level: "info", scope: "supervisor", dir: config.logDir });

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const HEALTHY_RUN_MS = 60 * 1000;
const PROBE_INTERVAL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_FAILURES_TO_RESTART = 3;
const probeHost = ["0.0.0.0", "::", ""].includes(config.host) ? "127.0.0.1" : config.host;
const liveUrl = `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${config.port}/api/live`;

let child = null;
let crashes = 0;
let stopping = false;
let probeFailures = 0;
let restartTimer = null;

function start() {
  restartTimer = null;
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  logger.info("Сервер запущен", { pid: child.pid });
  probeFailures = 0;

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt > HEALTHY_RUN_MS) crashes = 0;
    const delay = BACKOFF_MS[Math.min(crashes, BACKOFF_MS.length - 1)];
    crashes += 1;
    logger.error("Сервер остановился, перезапуск", { code, signal: signal || undefined, restartInMs: delay, crashesInRow: crashes });
    restartTimer = setTimeout(start, delay);
  });
}

async function probe() {
  if (!child || stopping) return;
  try {
    const res = await fetch(liveUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    probeFailures = 0;
  } catch (err) {
    probeFailures += 1;
    logger.warn("Сервер не ответил на проверку живости", { url: liveUrl, failures: probeFailures, error: err.message });
    if (probeFailures >= PROBE_FAILURES_TO_RESTART && child) {
      logger.error("Сервер завис — принудительный перезапуск", { pid: child.pid });
      probeFailures = 0;
      child.kill();
    }
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  logger.info("Остановка по запросу");
  if (!child) process.exit(0);
  const running = child;
  running.once("exit", () => process.exit(0));
  // Windows has no SIGTERM: kill() ends the process at once, so the server is
  // first asked over IPC to finish requests and close the database.
  running.send({ type: "shutdown" }, (err) => {
    if (err) running.kill();
  });
  setTimeout(() => {
    running.kill();
    process.exit(0);
  }, config.shutdownTimeoutMs + 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows sends SIGHUP when the console window is closed; the process is
// killed a few seconds later, so the server is asked to stop right away.
process.on("SIGHUP", shutdown);
process.on("uncaughtException", (err) => {
  logger.error("Сбой самого супервизора", { error: err.stack || err.message });
});

setInterval(probe, PROBE_INTERVAL_MS);
start();
