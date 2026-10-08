// Failure, duplicate and security scenarios for the production-readiness fixes.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const { ADMIN_PASSWORD, tempDir, seedData, readRecords, startServer, api, sleep } = require("./helpers");

async function freshServer(env = {}) {
  const dataDir = env.DATA_DIR || tempDir("prod");
  if (!env.DATA_DIR) seedData(dataDir);
  const server = await startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), ...env } });
  return { server, dataDir };
}

async function login(base) {
  const res = await api(base, "POST", "/api/login", { body: { password: ADMIN_PASSWORD } });
  assert.equal(res.status, 200);
  return res.body.token;
}

const ORDER = { items: [{ id: "p-brand", qty: 1, price: 50000, currency: "kzt" }], customerName: "Анна", customerContact: "87771234567", task: "ролик" };

test("duplicates: double click, lost response, F5 and two tabs without requestId give one order", async () => {
  const { server, dataDir } = await freshServer();
  try {
    // Two tabs / double click: same content at the same moment, no requestId.
    const parallel = await Promise.all([1, 2, 3].map(() => api(server.base, "POST", "/api/orders", { body: ORDER })));
    assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(parallel.map((r) => r.body.id)).size, 1);
    // F5 / browser retry with a new requestId after the response was lost.
    const retry = await api(server.base, "POST", "/api/orders", { body: { ...ORDER, requestId: "new-request-id-after-reload" } });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, parallel[0].body.id);
    assert.equal(readRecords(dataDir, "orders").length, 1);

    // A really different order is not swallowed.
    const other = await api(server.base, "POST", "/api/orders", { body: { ...ORDER, task: "другой ролик" } });
    assert.equal(other.status, 201);
    assert.equal(readRecords(dataDir, "orders").length, 2);
    await sleep(100);
    const audit = readRecords(dataDir, "audit").map((a) => a.action);
    assert.equal(audit.filter((a) => a === "order.created").length, 2);
    assert.equal(audit.filter((a) => a === "order.duplicate_replayed").length, 3);
  } finally {
    await server.stop();
  }
});

test("price consistency: the saved total equals the total the customer saw, or the order is refused", async () => {
  const { server, dataDir } = await freshServer();
  try {
    const stale = await api(server.base, "POST", "/api/orders", {
      body: { ...ORDER, items: [{ id: "p-brand", qty: 2, price: 40000, currency: "kzt" }] },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "catalog_changed");
    assert.equal(readRecords(dataDir, "orders").length, 0);
    const ok = await api(server.base, "POST", "/api/orders", {
      body: { ...ORDER, items: [{ id: "p-brand", qty: 2, price: 50000, currency: "kzt" }] },
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.totals, { kzt: 100000 });
    assert.match(ok.body.number, /^[0-9a-f]{8}$/);
    assert.deepEqual(readRecords(dataDir, "orders")[0].totals, ok.body.totals);
  } finally {
    await server.stop();
  }
});

test("order status machine, optimistic locking, soft delete and restore", async () => {
  const { server, dataDir } = await freshServer();
  try {
    const token = await login(server.base);
    const { body: created } = await api(server.base, "POST", "/api/orders", { body: ORDER });
    const patch = (body) => api(server.base, "PATCH", `/api/orders/${created.id}`, { token, body });

    assert.equal((await patch({ status: "done" })).status, 428);
    const done = await patch({ status: "done", version: 1 });
    assert.equal(done.status, 200);
    assert.equal(done.body.version, 2);
    const back = await patch({ status: "new", version: 2 });
    assert.equal(back.status, 409);
    assert.equal(back.body.code, "invalid_transition");

    // Two admin tabs: the second one still holds version 2.
    assert.equal((await patch({ status: "cancelled", version: 2 })).status, 409, "done → cancelled запрещён");
    assert.equal((await patch({ status: "in_progress", version: 2 })).status, 200);
    const stale = await patch({ note: "из старой вкладки", version: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "version_conflict");
    assert.equal(stale.body.order.version, 3, "в ответе свежая версия заказа для обновления вкладки");
    assert.equal((await patch({ status: "cancelled", version: 3 })).status, 200);
    const revive = await patch({ status: "done", version: 4 });
    assert.equal(revive.status, 409, "cancelled → done запрещён");

    const del = await api(server.base, "DELETE", `/api/orders/${created.id}`, { token });
    assert.equal(del.status, 200);
    assert.equal((await api(server.base, "GET", "/api/orders", { token })).body.length, 0);
    const deleted = await api(server.base, "GET", "/api/orders?view=deleted", { token });
    assert.equal(deleted.body.length, 1);
    assert.ok(deleted.body[0].deletedAt);
    assert.equal(readRecords(dataDir, "orders").length, 1, "запись в базе остаётся");
    assert.equal((await api(server.base, "PATCH", `/api/orders/${created.id}`, { token, body: { note: "x", version: 5 } })).status, 404);
    assert.equal((await api(server.base, "DELETE", `/api/orders/${created.id}`, { token })).status, 404);

    const restored = await api(server.base, "POST", `/api/orders/${created.id}/restore`, { token });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.deletedAt, undefined);
    assert.equal((await api(server.base, "GET", "/api/orders", { token })).body.length, 1);

    await sleep(100);
    const actions = readRecords(dataDir, "audit").map((a) => a.action);
    for (const action of ["order.created", "order.status_changed", "order.deleted", "order.restored", "admin.login"]) {
      assert.ok(actions.includes(action), action);
    }
  } finally {
    await server.stop();
  }
});

test("a deleted order frees its content for a new, real order", async () => {
  const { server } = await freshServer();
  try {
    const token = await login(server.base);
    const first = await api(server.base, "POST", "/api/orders", { body: ORDER });
    await api(server.base, "DELETE", `/api/orders/${first.body.id}`, { token });
    const again = await api(server.base, "POST", "/api/orders", { body: ORDER });
    assert.equal(again.status, 201);
    assert.notEqual(again.body.id, first.body.id);
  } finally {
    await server.stop();
  }
});

// The orders limiter allows 5 requests per 10 minutes per client address.
async function burst(base, xff) {
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await api(base, "POST", "/api/orders", { ip: xff(i), body: { items: [] } })).status);
  }
  return statuses;
}

test("TRUST_PROXY A: no proxy — a forged X-Forwarded-For does not bypass the rate limit", async () => {
  const { server } = await freshServer({ TRUST_PROXY: "" });
  try {
    const statuses = await burst(server.base, (i) => `203.0.113.${i + 1}`);
    assert.equal(statuses[5], 429, statuses.join(","));
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY B: a trusted local proxy — every real client gets its own limit", async () => {
  const { server } = await freshServer({ TRUST_PROXY: "loopback" });
  try {
    const statuses = await burst(server.base, (i) => `203.0.113.${i + 1}`);
    assert.ok(!statuses.includes(429), statuses.join(","));
    const same = await burst(server.base, () => "198.51.100.7");
    assert.equal(same[5], 429);
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY C: the request did not come from the configured proxy — headers are ignored", async () => {
  const { server } = await freshServer({ TRUST_PROXY: "10.9.9.9" });
  try {
    const statuses = await burst(server.base, (i) => `203.0.113.${i + 1}`);
    assert.equal(statuses[5], 429, statuses.join(","));
  } finally {
    await server.stop();
  }
});

test("TRUST_PROXY=true or a hop count is refused at startup with a warning", async () => {
  const { server } = await freshServer({ TRUST_PROXY: "true", LOG_LEVEL: "warn" });
  try {
    assert.match(server.output(), /TRUST_PROXY="true" небезопасен/);
    const statuses = await burst(server.base, (i) => `203.0.113.${i + 1}`);
    assert.equal(statuses[5], 429);
  } finally {
    await server.stop();
  }
});

test("admin: a short password disables login; admin API without a session is 401", async () => {
  const { server } = await freshServer({ ADMIN_PASSWORD: "admin123", LOG_LEVEL: "warn" });
  try {
    const res = await api(server.base, "POST", "/api/login", { body: { password: "admin123" } });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /слишком короткий/);
    assert.ok(!server.output().includes("admin123"), "пароль не попадает в лог");
    for (const [method, url] of [
      ["GET", "/api/orders"],
      ["GET", "/api/clients"],
      ["GET", "/api/admin/status"],
      ["POST", "/api/orders/x/notify"],
      ["DELETE", "/api/orders/x"],
    ]) {
      assert.equal((await api(server.base, method, url)).status, 401, `${method} ${url}`);
    }
  } finally {
    await server.stop();
  }
});

test("admin: wrong passwords are logged without the password and audited on success", async () => {
  const { server, dataDir } = await freshServer({ LOG_LEVEL: "warn" });
  try {
    const wrong = await api(server.base, "POST", "/api/login", { body: { password: "guess-guess-guess-1" } });
    assert.equal(wrong.status, 401);
    await login(server.base);
    await sleep(50);
    assert.ok(!server.output().includes("guess-guess-guess-1"));
    assert.ok(!server.output().includes(ADMIN_PASSWORD));
    const audit = readRecords(dataDir, "audit").filter((a) => a.action === "admin.login");
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(ADMIN_PASSWORD));
  } finally {
    await server.stop();
  }
});

test("the server listens on loopback only by default", async (t) => {
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((addr) => addr && addr.family === "IPv4" && !addr.internal);
  if (!external) return t.skip("нет внешнего сетевого интерфейса");
  const { server } = await freshServer({ HOST: "" });
  try {
    assert.equal((await api(server.base, "GET", "/api/live")).status, 200);
    const port = new URL(server.base).port;
    await assert.rejects(
      fetch(`http://${external.address}:${port}/api/live`, { signal: AbortSignal.timeout(3000) }),
      "сайт не должен быть доступен с внешнего интерфейса"
    );
  } finally {
    await server.stop();
  }
});

test("structured logs: timestamp, level, module, request id; no tokens or phone numbers in errors", async () => {
  const { server } = await freshServer({ LOG_LEVEL: "info" });
  try {
    await api(server.base, "POST", "/api/orders", { body: ORDER });
    await sleep(100);
    const lines = server.output().split(/\r?\n/).filter(Boolean);
    const created = lines.find((line) => line.includes("order.created"));
    assert.ok(created, server.output());
    assert.match(created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR)\s+\S+ /);
    assert.match(created, /orderId=[0-9a-f-]{36}/);
    assert.match(created, /requestLogId=\S+/);
    assert.ok(!server.output().includes("87771234567"), "телефон клиента не пишется в лог");
  } finally {
    await server.stop();
  }
});

test("telegram timeout: a hanging API is a temporary failure, the order is kept and retried later", async () => {
  const http = require("http");
  const hanging = http.createServer(() => {});
  await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${hanging.address().port}`;
  const { server, dataDir } = await freshServer({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: url,
    TELEGRAM_TIMEOUT_MS: "1000",
  });
  try {
    const res = await api(server.base, "POST", "/api/orders", { body: ORDER });
    assert.equal(res.status, 201, "ответ клиенту не ждёт Telegram");
    let order;
    for (let i = 0; i < 60; i += 1) {
      order = readRecords(dataDir, "orders")[0];
      if (order.telegramStatus === "retrying") break;
      await sleep(100);
    }
    assert.equal(order.telegramStatus, "retrying");
    assert.match(order.telegramLastError, /нет ответа за 1 с/);
  } finally {
    await server.stop();
    hanging.closeAllConnections();
    hanging.close();
  }
});

test("database locked by another process: no false 201, the next request works after the lock", async () => {
  const path = require("path");
  const { DatabaseSync } = require("node:sqlite");
  const { server, dataDir } = await freshServer();
  const locker = new DatabaseSync(path.join(dataDir, "site.db"));
  try {
    locker.exec("BEGIN EXCLUSIVE");
    const blocked = await api(server.base, "POST", "/api/orders", { body: ORDER });
    assert.ok(blocked.status >= 500, `ожидался отказ, получено ${blocked.status}`);
    assert.ok(blocked.body.error);
    assert.ok(!blocked.body.id, "клиент не получает номер несохранённой заявки");
    locker.exec("COMMIT");
    assert.equal(readRecords(dataDir, "orders").length, 0);
    const ok = await api(server.base, "POST", "/api/orders", { body: ORDER });
    assert.equal(ok.status, 201);
    assert.equal(readRecords(dataDir, "orders").length, 1);
    assert.match(server.output(), /ERROR/);
  } finally {
    try {
      locker.exec("ROLLBACK");
    } catch {
      // Already committed.
    }
    locker.close();
    await server.stop();
  }
});

test("restart after automatic recovery: health stays degraded until an admin acknowledges it", async () => {
  const fs = require("fs");
  const path = require("path");
  const dataDir = tempDir("recovery");
  seedData(dataDir);
  const first = await freshServer({ DATA_DIR: dataDir });
  try {
    assert.equal((await api(first.server.base, "POST", "/api/orders", { body: ORDER })).status, 201);
  } finally {
    await first.server.stop();
  }
  // Startup writes a verified backup; make sure the order is in it.
  const boot = await freshServer({ DATA_DIR: dataDir });
  await boot.server.stop();
  fs.writeFileSync(path.join(dataDir, "site.db"), "{broken");
  for (const side of ["site.db-wal", "site.db-shm"]) fs.rmSync(path.join(dataDir, side), { force: true });

  const recovered = await freshServer({ DATA_DIR: dataDir, LOG_LEVEL: "error" });
  try {
    const health = await api(recovered.server.base, "GET", "/api/health");
    assert.equal(health.status, 503);
    assert.equal(health.body.checks.backup.status, "degraded");
    assert.equal(health.body.checks.backup.recovery, undefined, "подробности только в админке");
    assert.match(recovered.server.output(), /БАЗА ВОССТАНОВЛЕНА ИЗ ЗАПАСНОЙ КОПИИ/);
    const token = await login(recovered.server.base);
    const status = await api(recovered.server.base, "GET", "/api/admin/status", { token });
    assert.equal(status.body.checks.backup.recovery.reason, "corrupt");
    assert.match(status.body.checks.backup.recovery.brokenFile, /^site\.db\.broken-/);
    assert.equal((await api(recovered.server.base, "GET", "/api/orders", { token })).body.length, 1, "заказ восстановлен");
    assert.ok(fs.readdirSync(dataDir).some((n) => n.startsWith("site.db.broken-")), "повреждённый файл сохранён");
  } finally {
    await recovered.server.stop();
  }

  const restarted = await freshServer({ DATA_DIR: dataDir });
  try {
    const health = await api(restarted.server.base, "GET", "/api/health");
    assert.equal(health.body.checks.backup.status, "degraded", "после перезапуска предупреждение не пропадает");
    const token = await login(restarted.server.base);
    assert.equal((await api(restarted.server.base, "POST", "/api/admin/recovery/ack", { token })).status, 200);
    const after = await api(restarted.server.base, "GET", "/api/health");
    assert.equal(after.body.checks.backup.status, "ok");
    await sleep(100);
    assert.ok(readRecords(dataDir, "audit").some((a) => a.action === "storage.recovery.acknowledged"));
  } finally {
    await restarted.server.stop();
  }
});

test("supervisor restarts a crashed server, and the server exits when the supervisor dies", async () => {
  const net = require("net");
  const path = require("path");
  const { spawn } = require("child_process");
  const { baseEnv, ROOT } = require("./helpers");
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
  const dataDir = tempDir("supervisor");
  seedData(dataDir);
  const supervisor = spawn(process.execPath, [path.join(ROOT, "scripts", "supervisor.js")], {
    cwd: ROOT,
    env: baseEnv({ PORT: String(port), DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), LOG_LEVEL: "info" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  supervisor.stdout.on("data", (c) => (output += c));
  supervisor.stderr.on("data", (c) => (output += c));
  const pids = () => [...output.matchAll(/Сервер запущен pid=(\d+)/g)].map((m) => Number(m[1]));
  const live = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/live`, { signal: AbortSignal.timeout(1000) })).status;
    } catch {
      return 0;
    }
  };
  const waitFor = async (fn, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.ok(await waitFor(async () => (await live()) === 200), output);
    const [first] = pids();
    process.kill(first);
    assert.ok(await waitFor(async () => pids().length === 2 && (await live()) === 200), output);
    assert.match(output, /Сервер остановился, перезапуск/);
    const second = pids()[1];
    assert.notEqual(second, first);

    supervisor.kill();
    assert.ok(await waitFor(async () => !alive(second), 10000), "сервер не должен остаться сиротой без супервизора");
  } finally {
    supervisor.kill();
    pids().filter(alive).forEach((pid) => process.kill(pid));
  }
});

test("unit: logger redacts secrets wherever they appear", () => {
  const { redact, createLogger } = require("../server/core/logger");
  const lines = [];
  const log = createLogger({ level: "debug", scope: "t", sink: (line) => lines.push(line) });
  log.error("ошибка https://api.telegram.org/bot123456:ABCdef_ghi/sendMessage", { password: "p", apiKey: "sk-abcdefghijklmnop", authorization: "Bearer xyz.abc" });
  const text = lines.join("\n");
  assert.ok(!/123456:ABCdef_ghi|sk-abcdefghijklmnop|xyz\.abc|password=p\b/.test(text), text);
  assert.ok(!redact("Bearer secret-token-value").includes("secret-token-value"));
});
