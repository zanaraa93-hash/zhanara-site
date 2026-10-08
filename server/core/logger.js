const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_FIELD = /pass(word)?|token|secret|api[-_]?key|authorization|cookie/i;
const LOG_RETENTION_DAYS = 30;

// Applied to every line: an error message may quote a URL or header that
// carries a credential (Telegram puts the bot token into the URL path).
function redact(text) {
  return String(text)
    .replace(/bot\d+:[\w-]+/g, "bot***")
    .replace(/\bsk-[\w-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer ***");
}

function isFields(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function formatArg(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  return util.inspect(value, { depth: 4, breakLength: Infinity });
}

function formatFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      if (SECRET_FIELD.test(key)) return `${key}=***`;
      const text =
        value instanceof Error ? value.message : typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key}=${/[\s"=]/.test(text) ? JSON.stringify(text) : text}`;
    })
    .join(" ");
}

// One file per day, appended synchronously: a line written right before a
// crash must still be on disk for the investigation.
function createFileSink(dir) {
  let currentDay = "";
  let file = "";
  let broken = false;

  function prune() {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^server-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  }

  return function write(line, iso) {
    if (broken) return;
    try {
      const day = iso.slice(0, 10);
      if (day !== currentDay) {
        fs.mkdirSync(dir, { recursive: true });
        currentDay = day;
        file = path.join(dir, `server-${day}.log`);
        prune();
      }
      fs.appendFileSync(file, `${line}\n`);
    } catch (err) {
      broken = true;
      console.error(`${new Date().toISOString()} ERROR logger Файл журнала недоступен, пишу только в консоль: ${err.message}`);
    }
  };
}

function createLogger({ level = "info", scope = "", dir = "", sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const fileSink = sink !== undefined ? sink : dir ? createFileSink(dir) : null;

  function write(lvl, args) {
    if (LEVELS[lvl] < threshold) return;
    const parts = [...args];
    const fields = parts.length > 1 && isFields(parts[parts.length - 1]) ? parts.pop() : null;
    const iso = new Date().toISOString();
    const message = parts.map(formatArg).join(" ");
    const tail = fields ? formatFields(fields) : "";
    const line = redact(`${iso} ${lvl.toUpperCase().padEnd(5)} ${scope || "app"} ${message}${tail ? ` ${tail}` : ""}`);
    const method = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
    method(line);
    if (fileSink) fileSink(line, iso);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    child: (childScope) =>
      createLogger({ level, scope: scope ? `${scope}:${childScope}` : childScope, sink: fileSink }),
  };
}

module.exports = { createLogger, redact };
