const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { createSemaphore } = require("../files/runner");

const CHILD_FILE = path.join(__dirname, "child.js");

// renderer: absolute path to a module exporting render(job, { loadImage, warn }) -> Promise<Buffer>.
function createPdfRunner({ renderer, timeoutMs = 60000, memoryMb = 512 }) {
  if (!path.isAbsolute(renderer)) throw new Error("Путь к генератору PDF должен быть абсолютным");
  fs.accessSync(renderer, fs.constants.R_OK);
  // One document at a time per runner: a second click waits instead of doubling the load.
  const withSlot = createSemaphore(1);
  const children = new Set();
  let stopped = false;

  function runOnce(job) {
    return new Promise((resolve, reject) => {
      if (stopped) return reject(new Error("сервер останавливается"));
      const child = fork(CHILD_FILE, [renderer], {
        execArgv: [`--max-old-space-size=${memoryMb}`],
        // PDFs need no secrets from .env.
        env: { SystemRoot: process.env.SystemRoot || "", PATH: process.env.PATH || "" },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
      children.add(child);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("генерация PDF заняла слишком много времени")), timeoutMs);
      child.once("message", (msg) => {
        if (!msg?.ok || !msg.pdf) return finish(reject, new Error(msg?.error || "генератор PDF не вернул файл"));
        const pdf = Buffer.from(msg.pdf.buffer, msg.pdf.byteOffset, msg.pdf.byteLength);
        finish(resolve, { pdf, warnings: Array.isArray(msg.warnings) ? msg.warnings : [] });
      });
      child.once("error", (err) => finish(reject, new Error(`не удалось запустить генератор PDF: ${err.message}`)));
      // "close" fires after the IPC channel is drained, so a reply sent right before exit is not lost.
      child.once("close", (code) => finish(reject, new Error(`генератор PDF завершился с кодом ${code}`)));
      try {
        child.send(job, (err) => {
          if (err) finish(reject, new Error(`не удалось передать задание генератору PDF: ${err.message}`));
        });
      } catch (err) {
        finish(reject, new Error(`не удалось передать задание генератору PDF: ${err.message}`));
      }
    });
  }

  return {
    render: (job) => withSlot(() => runOnce(job)),
    stop() {
      stopped = true;
      children.forEach((child) => child.kill());
      children.clear();
    },
  };
}

// For optional modules: a missing font or an uninstalled pdfkit (npm install
// not run after an update) fails only that module at startup, not the site.
function assertPdfReady() {
  const { fontPaths } = require("./fonts");
  Object.values(fontPaths()).forEach((file) => fs.accessSync(file, fs.constants.R_OK));
  require.resolve("pdfkit");
}

module.exports = { createPdfRunner, assertPdfReady };
