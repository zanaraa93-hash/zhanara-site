const path = require("path");
const { fork } = require("child_process");

const CHILD_FILE = path.join(__dirname, "child.js");

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async function withSlot(fn) {
    if (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function createParseRunner({ concurrency, timeoutMs, memoryMb }) {
  const withSlot = createSemaphore(concurrency);
  const children = new Set();

  function runOnce(modulePath, buffer, options) {
    return new Promise((resolve, reject) => {
      const child = fork(CHILD_FILE, [], {
        execArgv: [`--max-old-space-size=${memoryMb}`],
        // Visitors' documents are handled without the server's secrets.
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
      const timer = setTimeout(() => finish(reject, new Error("файл слишком долго обрабатывается")), timeoutMs);
      child.once("message", (msg) => (msg?.ok ? finish(resolve, msg.text) : finish(reject, new Error(msg?.error || "не удалось прочитать файл"))));
      child.once("error", () => finish(reject, new Error("не удалось запустить обработку файла")));
      // "close" (not "exit") fires only after the IPC channel is drained, so a
      // reply sent right before exiting is never lost.
      child.once("close", () => finish(reject, new Error("не удалось прочитать файл — он повреждён или слишком сложный")));
      child.send({ modulePath, buffer, options });
    });
  }

  return {
    run: (modulePath, buffer, options) => withSlot(() => runOnce(modulePath, buffer, options)),
    stop: async () => {
      children.forEach((child) => child.kill());
      children.clear();
    },
  };
}

module.exports = { createParseRunner, createSemaphore };
