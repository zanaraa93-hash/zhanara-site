const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ADMIN_PASSWORD = "test-password-123456";

const SEED_PRODUCTS = [
  {
    id: "p-brand",
    title: "Ролик для бренда",
    description: "Короткий рекламный ролик",
    price: 50000,
    currency: "kzt",
    type: "service",
    quantity: 1,
    image: "/uploads/product-brand.jpg",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "p-reels",
    title: "Reels",
    description: "Вертикальное видео",
    price: null,
    currency: "usd",
    type: "product",
    quantity: 3,
    image: "/uploads/product-reels.jpg",
    createdAt: "2026-02-01T00:00:00.000Z",
  },
];

const createdDirs = [];
process.on("exit", () => {
  createdDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zhanara-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

function seedData(dataDir, { products = SEED_PRODUCTS } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "products.json"), JSON.stringify(products, null, 2));
  fs.writeFileSync(path.join(dataDir, "orders.json"), "[]");
  fs.writeFileSync(path.join(dataDir, "clients.json"), "[]");
}

function openRecords(dataDir) {
  const { DatabaseSync } = require("node:sqlite");
  const { DATABASE_FILE } = require("../server/core/storage");
  return new DatabaseSync(path.join(dataDir, DATABASE_FILE), { timeout: 5000 });
}

function readRecords(dataDir, collection) {
  const db = openRecords(dataDir);
  try {
    return db
      .prepare("SELECT body FROM records WHERE collection = ? ORDER BY seq")
      .all(collection)
      .map((row) => JSON.parse(row.body));
  } finally {
    db.close();
  }
}

function writeRecords(dataDir, collection, items) {
  const db = openRecords(dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM records WHERE collection = ?").run(collection);
    const insert = db.prepare("INSERT INTO records (collection, seq, id, body) VALUES (?, ?, ?, ?)");
    items.forEach((item, seq) => {
      const id = item && typeof item === "object" && item.id != null ? String(item.id) : null;
      insert.run(collection, seq, id, JSON.stringify(item));
    });
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // BEGIN itself may have failed.
    }
    throw err;
  } finally {
    db.close();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function baseEnv(overrides = {}) {
  // Every key the server reads is set explicitly so the developer's .env never
  // leaks into tests (dotenv does not override existing variables).
  return {
    ...process.env,
    ADMIN_PASSWORD,
    OPENAI_API_KEY: "",
    OPENAI_MODEL: "test-model",
    OPENAI_BASE_URL: "",
    OPENAI_REASONING_EFFORT: "none",
    AI_PROVIDER: "openai",
    CHAT_DAILY_LIMIT: "300",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    TELEGRAM_API_URL: "",
    TELEGRAM_RETRY_INTERVAL_MS: "",
    TELEGRAM_TIMEOUT_MS: "",
    OPENAI_TIMEOUT_MS: "",
    BACKUP_DIR: "",
    BACKUP_KEEP_DAYS: "",
    DB_AUTO_RESTORE_MAX_AGE_HOURS: "",
    LOG_DIR: "",
    SITE_URL: "https://example.test",
    TRUST_PROXY: "loopback",
    HOST: "127.0.0.1",
    ENABLED_MODULES: "",
    LOG_LEVEL: "error",
    NODE_PATH: path.join(ROOT, "node_modules"),
    ...overrides,
  };
}

async function startServer({ entry = path.join(ROOT, "server", "index.js"), cwd = ROOT, env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: baseEnv({ PORT: String(port), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Сервер завершился при старте:\n${output}`);
    try {
      await fetch(`${base}/api/products`);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`Сервер не поднялся за 15 с:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    base,
    child,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

// Minimal fake HTTP service (OpenAI, Telegram) that records every request.
async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const entry = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
      requests.push(entry);
      const reply = await handler(entry, requests.length);
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let ipCounter = 0;
// Tests connect over loopback and TRUST_PROXY=loopback, so the test client acts
// as the trusted proxy: a unique X-Forwarded-For gives every request its own
// rate-limit bucket unless a test pins one on purpose.
function uniqueIp() {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function api(base, method, url, { body, token, ip = uniqueIp(), raw, headers = {} } = {}) {
  const init = { method, headers: { "X-Forwarded-For": ip, ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (raw !== undefined) {
    init.body = raw;
  } else if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, init);
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Plain text / HTML responses are compared as text.
  }
  return { status: res.status, headers: res.headers, body: data };
}

function imageForm(fields, { withImage = true, name = "photo.png", type = "image/png" } = {}) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
  if (withImage) {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex"
    );
    form.append("image", new Blob([png], { type }), name);
  }
  return form;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  ROOT,
  ADMIN_PASSWORD,
  SEED_PRODUCTS,
  tempDir,
  seedData,
  readRecords,
  writeRecords,
  startServer,
  startMock,
  api,
  imageForm,
  uniqueIp,
  sleep,
  baseEnv,
};
