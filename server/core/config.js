const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

function resolveDir(value, fallback) {
  return value ? path.resolve(ROOT, value) : fallback;
}

function parseList(value) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function parsePort(value, warnings) {
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  // 0 means "any free port" (used by tests).
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    warnings.push(`PORT="${value}" — некорректный порт, использую 3000.`);
    return 3000;
  }
  return port;
}

function parsePositiveInt(name, value, fallback, warnings) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    warnings.push(`${name}="${value}" — ожидалось целое число больше нуля, использую ${fallback}.`);
    return fallback;
  }
  return n;
}

// Only named proxy addresses are trusted: "loopback" for nginx/Caddy on the
// same machine, or explicit IPs/subnets. A hop count or "true" would make
// Express take the client address from X-Forwarded-For even on a direct
// connection, so anyone could pick a fresh address and skip rate limits.
function parseTrustProxy(value, warnings) {
  const text = String(value ?? "").trim();
  if (!text || /^(0|false|no|off)$/i.test(text)) return false;
  if (/^(true|yes|on|\d+)$/i.test(text)) {
    warnings.push(
      `TRUST_PROXY="${value}" небезопасен: укажите адрес прокси (например loopback или 10.0.0.5). Прокси не доверяю, лимиты считаются по адресу подключения.`
    );
    return false;
  }
  if (/^[\w.:/,\s-]+$/.test(text)) return text;
  warnings.push(`TRUST_PROXY="${value}" — непонятное значение, прокси не доверяю.`);
  return false;
}

function parseHost(value, warnings) {
  const text = String(value ?? "").trim();
  if (!text) return "127.0.0.1";
  if (!/^[\w.:-]+$/.test(text)) {
    warnings.push(`HOST="${value}" — некорректный адрес, слушаю только 127.0.0.1.`);
    return "127.0.0.1";
  }
  return text;
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

const MIN_ADMIN_PASSWORD = 16;

function loadConfig(env = process.env) {
  const warnings = [];

  const dataDir = resolveDir(env.DATA_DIR, path.join(ROOT, "data"));
  const config = {
    root: ROOT,
    dataDir,
    logDir: resolveDir(env.LOG_DIR, path.join(dataDir, "logs")),
    uploadsDir: resolveDir(env.UPLOADS_DIR, path.join(ROOT, "uploads")),
    distDir: path.join(ROOT, "dist"),
    imgDir: path.join(ROOT, "img"),
    port: parsePort(env.PORT, warnings),
    host: parseHost(env.HOST, warnings),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, warnings),
    backup: {
      dir: resolveDir(env.BACKUP_DIR, path.join(dataDir, "backups")),
      keepDaily: parsePositiveInt("BACKUP_KEEP_DAYS", env.BACKUP_KEEP_DAYS, 14, warnings),
      // A broken database is replaced from a backup automatically only when
      // that backup is this fresh; an older one needs a human decision.
      autoRestoreMaxAgeHours: parsePositiveInt(
        "DB_AUTO_RESTORE_MAX_AGE_HOURS",
        env.DB_AUTO_RESTORE_MAX_AGE_HOURS,
        24,
        warnings
      ),
    },
    siteUrl: String(env.SITE_URL || "").replace(/\/+$/, ""),
    logLevel: String(env.LOG_LEVEL || "info").toLowerCase(),
    enabledModules: parseList(env.ENABLED_MODULES),
    shutdownTimeoutMs: 10000,
    admin: {
      password: env.ADMIN_PASSWORD || "",
      sessionTtlMs: 12 * 60 * 60 * 1000,
    },
    ai: {
      provider: String(env.AI_PROVIDER || "openai").toLowerCase(),
      dailyLimit: parsePositiveInt("CHAT_DAILY_LIMIT", env.CHAT_DAILY_LIMIT, 300, warnings),
      requestBudgetMs: 40000,
      maxToolRounds: 3,
      attachmentTextBudget: 24000,
      maxImagesPerRequest: 3,
      breaker: { threshold: 3, cooldownMs: 2 * 60 * 1000 },
      openai: {
        apiKey: env.OPENAI_API_KEY || "",
        model: env.OPENAI_MODEL || "gpt-5.4",
        baseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
        timeoutMs: parsePositiveInt("OPENAI_TIMEOUT_MS", env.OPENAI_TIMEOUT_MS, 25000, warnings),
        // GPT-5.x counts hidden reasoning against max_completion_tokens; without a low
        // effort the whole budget can go to reasoning and the reply comes back empty.
        reasoningEffort: env.OPENAI_REASONING_EFFORT ?? "none",
      },
    },
    files: {
      maxFileBytes: 5 * 1024 * 1024,
      maxFiles: 5,
      maxTextChars: 12000,
      maxPdfPages: 30,
      parseTimeoutMs: 15000,
      parserConcurrency: 2,
      parserMemoryMb: 256,
      ttlMs: 2 * 60 * 60 * 1000,
      maxStoredEntries: 300,
      maxStoredBytes: 150 * 1024 * 1024,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      chatId: env.TELEGRAM_CHAT_ID || "",
      apiUrl: String(env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, ""),
      timeoutMs: parsePositiveInt("TELEGRAM_TIMEOUT_MS", env.TELEGRAM_TIMEOUT_MS, 10000, warnings),
      // Node turns a timer above ~24.8 days into 1 ms, which would hammer the API.
      retryIntervalMs: Math.min(
        parsePositiveInt("TELEGRAM_RETRY_INTERVAL_MS", env.TELEGRAM_RETRY_INTERVAL_MS, 60 * 1000, warnings),
        24 * 60 * 60 * 1000
      ),
    },
  };

  if (!config.admin.password) {
    warnings.push("ADMIN_PASSWORD не задан в .env — вход в админку отключён.");
  } else if (config.admin.password.length < MIN_ADMIN_PASSWORD) {
    // A short password with a public address is guessable; the panel stays
    // locked until a proper one is set rather than running with a weak one.
    warnings.push(
      `ADMIN_PASSWORD короче ${MIN_ADMIN_PASSWORD} символов — вход в админку отключён. Задайте длинный случайный пароль в .env.`
    );
    config.admin.password = "";
    config.admin.weakPassword = true;
  }
  if (!isLoopbackHost(config.host)) {
    warnings.push(
      `Сервер слушает ${config.host}: порт доступен из сети по HTTP. Для доступа извне используйте reverse proxy с HTTPS и HOST=127.0.0.1.`
    );
  }
  if (!config.telegram.botToken || !config.telegram.chatId) {
    warnings.push("Уведомления о заявках в Telegram выключены: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.");
  }
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
    warnings.push(`LOG_LEVEL="${env.LOG_LEVEL}" — допустимо debug, info, warn, error. Использую info.`);
    config.logLevel = "info";
  }

  return { config, warnings };
}

module.exports = { loadConfig, ROOT, MIN_ADMIN_PASSWORD, isLoopbackHost };
