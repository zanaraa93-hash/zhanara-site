const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  ADMIN_PASSWORD,
  tempDir,
  seedData,
  readRecords,
  writeRecords,
  startServer,
  startMock,
  api,
  imageForm,
  sleep,
  baseEnv,
} = require("./helpers");

async function freshServer(env = {}) {
  const dataDir = env.DATA_DIR || tempDir("core");
  if (!env.DATA_DIR) seedData(dataDir);
  const uploadsDir = env.UPLOADS_DIR || tempDir("up");
  const server = await startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, ...env } });
  return { server, dataDir, uploadsDir };
}

async function login(base) {
  const res = await api(base, "POST", "/api/login", { body: { password: ADMIN_PASSWORD } });
  assert.equal(res.status, 200);
  return res.body.token;
}

test("admin session survives a server restart and only a hash is stored", async () => {
  const { server, dataDir, uploadsDir } = await freshServer();
  const token = await login(server.base);
  await server.stop();

  const stored = JSON.stringify(readRecords(dataDir, "sessions"));
  assert.ok(!stored.includes(token), "токен не должен лежать в базе открытым текстом");
  assert.equal(JSON.parse(stored).length, 1);

  const again = await startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir } });
  try {
    assert.equal((await api(again.base, "GET", "/api/session", { token })).status, 200);
  } finally {
    await again.stop();
  }
});

test("expired sessions are rejected and a broken sessions file does not block startup", async () => {
  const dataDir = tempDir("sess");
  seedData(dataDir);
  fs.writeFileSync(path.join(dataDir, "sessions.json"), "{broken");
  const { server } = await freshServer({ DATA_DIR: dataDir });
  try {
    const token = await login(server.base);
    assert.equal((await api(server.base, "GET", "/api/session", { token })).status, 200);
    const sessions = readRecords(dataDir, "sessions");
    sessions[0].expires = Date.now() - 1000;
    writeRecords(dataDir, "sessions", sessions);
    assert.equal((await api(server.base, "GET", "/api/session", { token })).status, 401);
  } finally {
    await server.stop();
  }
});

test("parallel retries with one requestId create exactly one order", async () => {
  const { server, dataDir } = await freshServer();
  try {
    const body = { items: [{ id: "p-brand" }], customerName: "Анна", customerContact: "87771234567", requestId: "same-req-0001" };
    const results = await Promise.all(Array.from({ length: 8 }, () => api(server.base, "POST", "/api/orders", { body })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    const orders = readRecords(dataDir, "orders");
    assert.equal(orders.length, 1);
  } finally {
    await server.stop();
  }
});

test("parallel writes to different records never lose each other's changes", async () => {
  const { server, dataDir } = await freshServer();
  try {
    const token = await login(server.base);
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await api(server.base, "POST", "/api/orders", {
        body: { items: [{ id: "p-brand" }], customerName: `Клиент ${i}`, customerContact: `8777000000${i}` },
      });
      ids.push(res.body.id);
    }
    await Promise.all(
      ids.map((id, i) => api(server.base, "PATCH", `/api/orders/${id}`, { token, body: { note: `заметка ${i}`, version: 1 } }))
    );
    const orders = readRecords(dataDir, "orders");
    ids.forEach((id, i) => assert.equal(orders.find((o) => o.id === id).note, `заметка ${i}`));

    await sleep(200);
    const clients = (await api(server.base, "GET", "/api/clients", { token })).body;
    assert.equal(clients.length, 5);
    await Promise.all(
      clients.map((c, i) => api(server.base, "PATCH", `/api/clients/${c.id}`, { token, body: { note: `n${i}` } }))
    );
    const stored = readRecords(dataDir, "clients");
    clients.forEach((c, i) => assert.equal(stored.find((s) => s.id === c.id).note, `n${i}`));
  } finally {
    await server.stop();
  }
});

test("a corrupted data file is never overwritten with an empty list", async () => {
  const dataDir = tempDir("corrupt");
  seedData(dataDir);
  const ordersFile = path.join(dataDir, "orders.json");
  fs.writeFileSync(ordersFile, "");
  await assert.rejects(freshServer({ DATA_DIR: dataDir }), /пустой/);
  assert.equal(fs.readFileSync(ordersFile, "utf8"), "");
  assert.equal(readRecords(dataDir, "orders").length, 0);
});

test("health is green only when Telegram and AI work; live and ready stay separate", async () => {
  const tg = await startMock(() => ({ body: { ok: true } }));
  const ai = await startMock(() => ({ body: { choices: [{ message: { content: "ok" } }] } }));
  const healthy = await freshServer({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: tg.url,
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: ai.url,
  });
  try {
    const res = await api(healthy.server.base, "GET", "/api/health");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.storage, "ok");
    assert.equal(res.body.checks.telegram.state, "ok");
    assert.equal(res.body.checks.ai.state, "ok");
    assert.equal(res.body.checks.backup.status, "ok");
    assert.deepEqual(res.body.modules.loaded, ["auth", "products", "orders", "clients", "chat", "telegram", "catalog-pdf", "order-invoice"]);
    assert.deepEqual(res.body.modules.failed, []);
    assert.ok(res.headers.get("x-request-id"));
    assert.ok(!JSON.stringify(res.body).includes("123:abc"));
  } finally {
    await healthy.server.stop();
    await tg.close();
    await ai.close();
  }

  // Default test env: no Telegram token, no AI key.
  const { server } = await freshServer();
  try {
    const res = await api(server.base, "GET", "/api/health");
    assert.equal(res.status, 503);
    assert.equal(res.body.status, "degraded");
    assert.equal(res.body.checks.telegram.state, "not_configured");
    assert.equal(res.body.checks.ai.state, "not_configured");
    assert.equal((await api(server.base, "GET", "/api/live")).status, 200);
    const ready = await api(server.base, "GET", "/api/ready");
    assert.equal(ready.status, 200, "без Telegram заявки всё равно принимаются и сохраняются");
    assert.equal(ready.body.status, "ready");
  } finally {
    await server.stop();
  }
});

test("ENABLED_MODULES switches features off without touching code", async () => {
  const { server } = await freshServer({ ENABLED_MODULES: "auth,products" });
  try {
    assert.equal((await api(server.base, "GET", "/api/products")).status, 200);
    assert.equal((await api(server.base, "POST", "/api/orders", { body: {} })).status, 404);
    assert.equal((await api(server.base, "POST", "/api/chat", { body: {} })).status, 404);
    const health = await api(server.base, "GET", "/api/health");
    assert.deepEqual(health.body.modules.loaded, ["auth", "products"]);
  } finally {
    await server.stop();
  }
});

test("required module without its dependency stops startup with a clear message", async () => {
  const dataDir = tempDir("deps");
  seedData(dataDir);
  await assert.rejects(
    startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), ENABLED_MODULES: "auth,orders" } }),
    /Модуль "orders" не запущен: нет модулей products/
  );
});

test("without auth module admin routes fail closed", async () => {
  const { server } = await freshServer({ ENABLED_MODULES: "products,orders" });
  try {
    const res = await api(server.base, "GET", "/api/orders", { token: "anything" });
    assert.equal(res.status, 503);
    const del = await api(server.base, "DELETE", "/api/products/p-brand", { token: "anything" });
    assert.equal(del.status, 503);
  } finally {
    await server.stop();
  }
});

test("Telegram gets the order notification after the response", async () => {
  const mock = await startMock(() => ({ body: { ok: true } }));
  const { server } = await freshServer({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: mock.url,
  });
  try {
    const res = await api(server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand", qty: 2 }], customerName: "Анна", customerContact: "87771234567", deadline: "2026-12-31" },
    });
    assert.equal(res.status, 201);
    for (let i = 0; i < 50 && !mock.requests.length; i += 1) await sleep(50);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, "/bot123:abc/sendMessage");
    const { chat_id, text } = mock.requests[0].body;
    assert.equal(chat_id, "42");
    assert.match(text, /Новая заявка с сайта/);
    assert.match(text, /Телефон: \+7 777 123 45 67/);
    assert.match(text, /WhatsApp: https:\/\/wa\.me\/77771234567/);
    assert.match(text, /Итого: 100\s000 ₸/);
    assert.match(text, /Когда нужно: 31\.12\.2026/);
  } finally {
    await server.stop();
    await mock.close();
  }
});

test("Telegram outage never affects the order", async () => {
  const mock = await startMock(() => ({ status: 502, body: { ok: false } }));
  const { server, dataDir } = await freshServer({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: mock.url,
  });
  try {
    const res = await api(server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand" }], customerName: "Анна", customerContact: "87771234567" },
    });
    assert.equal(res.status, 201);
    await sleep(300);
    assert.equal(readRecords(dataDir, "orders").length, 1);
    assert.equal(readRecords(dataDir, "clients").length, 1);
  } finally {
    await server.stop();
    await mock.close();
  }
});

test("uploaded photo is removed when the product is rejected or replaced", async () => {
  const { server, uploadsDir } = await freshServer();
  try {
    const token = await login(server.base);
    const listUploads = () => fs.readdirSync(uploadsDir);
    await api(server.base, "POST", "/api/products", { token, body: imageForm({ title: "" }) });
    await api(server.base, "PUT", "/api/products/missing", { token, body: imageForm({ title: "A" }) });
    await api(server.base, "PUT", "/api/products/p-brand", { token, body: imageForm({ title: "A", price: "x" }) });
    assert.deepEqual(listUploads(), []);

    const created = await api(server.base, "POST", "/api/products", { token, body: imageForm({ title: "B" }) });
    assert.equal(listUploads().length, 1);
    await api(server.base, "PUT", `/api/products/${created.body.id}`, { token, body: imageForm({ title: "C" }) });
    assert.equal(listUploads().length, 1, "старое фото удаляется после замены");
    await api(server.base, "DELETE", `/api/products/${created.body.id}`, { token });
    assert.deepEqual(listUploads(), []);
  } finally {
    await server.stop();
  }
});

test("pages are served with SITE_URL and server code is never exposed", async () => {
  const hasDist = fs.existsSync(path.join(__dirname, "..", "dist", "index.html"));
  const { server } = await freshServer();
  try {
    const page = await api(server.base, "GET", "/");
    if (hasDist) {
      assert.equal(page.status, 200);
      assert.ok(!page.body.includes("__SITE_URL__"));
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.equal((await api(server.base, "GET", "/admin")).status, 200);
    } else {
      assert.equal(page.status, 503);
    }
    for (const url of ["/server/index.js", "/server/core/config.js", "/test/helpers.js", "/package.json", "/data/sessions.json", "/data/site.db"]) {
      assert.equal((await api(server.base, "GET", url)).status, 404, url);
    }
  } finally {
    await server.stop();
  }
});

test("unit: failing optional module is rolled back completely; required one stops startup", async () => {
  const { createCore } = require("../server/core/kernel");
  const dataDir = tempDir("unit");
  seedData(dataDir);
  const env = baseEnv({ DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), PORT: "0" });

  const broken = {
    name: "broken",
    optional: true,
    setup(core) {
      core.http.route((router) => router.get("/api/broken", (_req, res) => res.json({ bad: true })));
      core.ai.tools.register({ name: "broken_tool", handler: () => "x" });
      core.ai.prompt.addSection("broken", () => "BROKEN SECTION");
      core.services.register("broken", {});
      core.events.on("order.created", () => {
        throw new Error("не должен вызываться");
      });
      throw new Error("сбой в setup");
    },
  };
  const core = createCore({ env });
  const server = await core.start([require("../server/modules/auth"), broken]);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await api(base, "GET", "/api/broken")).status, 404);
    assert.equal(core.ai.tools.definitions().length, 0);
    assert.ok(!core.ai.prompt.build().includes("BROKEN"));
    assert.equal(core.services.has("broken"), false);
    const health = await api(base, "GET", "/api/health");
    assert.deepEqual(health.body.modules, { loaded: ["auth"], failed: ["broken"] });
    assert.equal(health.status, 503);
  } finally {
    await core.stop();
  }

  const core2 = createCore({ env });
  try {
    await assert.rejects(core2.start([{ ...broken, optional: false }]), /Модуль "broken" не запустился: сбой в setup/);
  } finally {
    await core2.stop();
  }
});

test("unit: cyclic and duplicate modules are rejected", async () => {
  const { sortByDependencies } = require("../server/core/registry");
  assert.throws(
    () =>
      sortByDependencies([
        { name: "a", dependsOn: ["b"], setup() {} },
        { name: "b", dependsOn: ["a"], setup() {} },
      ]),
    /Циклическая зависимость/
  );
  const { createCore } = require("../server/core/kernel");
  const dataDir = tempDir("dup");
  seedData(dataDir);
  const core = createCore({ env: baseEnv({ DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), PORT: "0" }) });
  try {
    await assert.rejects(core.start([{ name: "x", setup() {} }, { name: "x", setup() {} }]), /подключён дважды/);
  } finally {
    await core.stop();
  }
});

test("unit: graceful stop waits for in-flight event handlers", async () => {
  const { createCore } = require("../server/core/kernel");
  const dataDir = tempDir("stop");
  seedData(dataDir);
  const core = createCore({ env: baseEnv({ DATA_DIR: dataDir, UPLOADS_DIR: tempDir("up"), PORT: "0" }) });
  let finished = false;
  await core.start([
    {
      name: "slow",
      setup(c) {
        c.events.on("tick", async () => {
          await sleep(300);
          finished = true;
        });
      },
    },
  ]);
  core.events.emit("tick", {});
  await core.stop();
  assert.equal(finished, true);
});

test("unit: storage transactions are serialized even with awaits inside", async () => {
  const { createStorage } = require("../server/core/storage");
  const storage = createStorage({ dataDir: tempDir("tx") });
  const repo = storage.repository("items");
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      repo.transaction(async (items) => {
        await sleep(Math.random() * 10);
        items.push({ id: String(i) });
      })
    )
  );
  assert.equal(repo.list().length, 20);

  await assert.rejects(
    repo.transaction(() => {
      throw new Error("boom");
    }),
    /boom/
  );
  await repo.insert({ id: "after-error" });
  assert.equal(repo.list().length, 21, "после ошибки в транзакции хранилище продолжает работать");
  storage.close();
});

test("unit: storage writes only changed rows and keeps the list order", async () => {
  const { createStorage } = require("../server/core/storage");
  const { DatabaseSync } = require("node:sqlite");
  const dir = tempDir("delta");
  const storage = createStorage({ dataDir: dir });
  const repo = storage.repository("items");
  await repo.replaceAll([{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }]);
  const seqs = () => {
    const db = new DatabaseSync(path.join(dir, "site.db"), { readOnly: true });
    try {
      return db.prepare("SELECT id, seq FROM records WHERE collection = 'items' ORDER BY seq").all().map((r) => `${r.id}:${r.seq}`);
    } finally {
      db.close();
    }
  };
  const before = seqs();

  await repo.update("b", (item) => {
    item.n = 20;
  });
  assert.deepEqual(seqs(), before, "правка одной записи не трогает остальные");
  assert.equal(repo.get("b").n, 20);

  await repo.insert({ id: "d", n: 4 });
  await repo.remove("a");
  await repo.transaction((items) => {
    items.find((item) => item.id === "c").n = 30;
    items.unshift({ id: "z", n: 0 });
  });
  assert.deepEqual(
    repo.list().map((item) => item.id),
    ["z", "b", "c", "d"],
    "порядок списка сохраняется после точечных правок"
  );
  assert.equal(repo.get("c").n, 30);
  assert.equal(repo.get("missing"), undefined);

  const skipped = await repo.update("missing", (item, tx) => {
    tx.skipWrite();
    return item;
  });
  assert.equal(skipped, null);
  storage.close();
});

test("unit: insertIfAbsent creates one record for parallel calls with the same key", async () => {
  const { createStorage } = require("../server/core/storage");
  const storage = createStorage({ dataDir: tempDir("unique") });
  const repo = storage.repository("orders");
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => repo.insertIfAbsent({ id: `o${i}`, requestId: "same-key-1" }, "requestId"))
  );
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => r.item.id)).size, 1);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.findBy("requestId", "same-key-1").id, results[0].item.id);
  const plain = await repo.insertIfAbsent({ id: "no-key" }, "requestId");
  assert.equal(plain.created, true);
  assert.throws(() => repo.findBy("bad field'", "x"), /Недопустимое поле/);
  storage.close();
});

test("unit: a corrupt legacy file is restored from the backup and then imported", async () => {
  const { writeJsonArray } = require("../server/core/storage/jsonStore");
  const { createStorage } = require("../server/core/storage");
  const file = path.join(tempDir("bak"), "orders.json");
  writeJsonArray(file, [{ id: "a" }]);
  writeJsonArray(file, [{ id: "a" }, { id: "b" }]);
  fs.writeFileSync(file, "{broken");
  const revived = createStorage({ dataDir: path.dirname(file) });
  assert.deepEqual(
    revived.repository("orders").list().map((item) => item.id),
    ["a"],
    "битый файл заменяется предыдущей целой копией"
  );
  revived.close();

  const lonelyDir = tempDir("nobak");
  const lonely = path.join(lonelyDir, "orders.json");
  fs.writeFileSync(lonely, "");
  const broken = createStorage({ dataDir: lonelyDir });
  const orders = broken.repository("orders");
  assert.throws(() => orders.list(), /пустой/);
  assert.equal(fs.readFileSync(lonely, "utf8"), "");
  await assert.rejects(orders.insert({ id: "x" }));
  assert.equal(readRecords(lonelyDir, "orders").length, 0);
  broken.close();
});

test("unit: legacy json is imported once and a damaged database is left untouched", async () => {
  const { createStorage } = require("../server/core/storage");
  const dir = tempDir("import");
  fs.writeFileSync(path.join(dir, "orders.json"), JSON.stringify([{ id: "a", note: "привет" }]));
  const first = createStorage({ dataDir: dir });
  assert.equal(first.repository("orders").list()[0].note, "привет");
  first.close();
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "orders.json.migrated")), true);
  fs.writeFileSync(path.join(dir, "orders.json"), JSON.stringify([{ id: "other" }]));
  const second = createStorage({ dataDir: dir });
  assert.deepEqual(
    second.repository("orders").list().map((item) => item.id),
    ["a"]
  );
  second.close();

  const damagedDir = tempDir("baddb");
  const damaged = path.join(damagedDir, "site.db");
  fs.writeFileSync(damaged, "{broken");
  const bad = createStorage({ dataDir: damagedDir });
  assert.throws(() => bad.repository("orders").list(), /поврежд/);
  assert.equal(fs.readFileSync(damaged, "utf8"), "{broken");
  bad.close();

  const emptyDir = tempDir("emptydb");
  const emptyFile = path.join(emptyDir, "site.db");
  fs.writeFileSync(emptyFile, "");
  const empty = createStorage({ dataDir: emptyDir });
  assert.throws(() => empty.repository("orders").list(), /пустой/);
  assert.equal(fs.statSync(emptyFile).size, 0);
  empty.close();
});

test("unit: a deleted database is restored from its own backup, not from an older JSON file", async () => {
  const { createStorage } = require("../server/core/storage");
  const dir = tempDir("snap");
  const storage = createStorage({ dataDir: dir });
  await storage.repository("orders").insert({ id: "live", note: "после перехода" });
  storage.close();
  const backup = path.join(dir, "site.db.bak");
  assert.equal(fs.existsSync(backup), true);
  fs.rmSync(path.join(dir, "site.db"), { force: true });
  fs.writeFileSync(path.join(dir, "orders.json.bak"), JSON.stringify([{ id: "stale" }]));
  fs.writeFileSync(path.join(dir, "orders.json.migrated"), JSON.stringify([{ id: "migrated" }]));
  const restored = createStorage({ dataDir: dir });
  assert.deepEqual(
    restored.repository("orders").list().map((item) => item.id),
    ["live"]
  );
  restored.close();

  const legacyDir = tempDir("legacy-new");
  const migrated = path.join(legacyDir, "orders.json.migrated");
  const jsonBak = path.join(legacyDir, "orders.json.bak");
  fs.writeFileSync(jsonBak, JSON.stringify([{ id: "old-a" }, { id: "old-b" }]));
  fs.writeFileSync(migrated, JSON.stringify([{ id: "new-a" }, { id: "new-b" }, { id: "new-c" }]));
  const older = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(jsonBak, older, older);
  const fromJson = createStorage({ dataDir: legacyDir });
  assert.deepEqual(
    fromJson.repository("orders").list().map((item) => item.id),
    ["new-a", "new-b", "new-c"]
  );
  fromJson.close();
});

test("unit: a broken database is replaced from the backup and the broken file is kept aside", async () => {
  const { createStorage } = require("../server/core/storage");
  const dir = tempDir("repair");
  const storage = createStorage({ dataDir: dir });
  await storage.repository("orders").insert({ id: "kept" });
  storage.close();
  const dbFile = path.join(dir, "site.db");
  fs.writeFileSync(dbFile, "{broken");
  const repaired = createStorage({ dataDir: dir });
  assert.deepEqual(
    repaired.repository("orders").list().map((item) => item.id),
    ["kept"]
  );
  const broken = fs.readdirSync(dir).filter((name) => /^site\.db\.broken-\d{8}-\d{6}$/.test(name));
  assert.equal(broken.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, broken[0]), "utf8"), "{broken");
  const recovery = repaired.status().recovery;
  assert.equal(recovery.reason, "corrupt");
  assert.equal(recovery.brokenFile, broken[0]);
  assert.ok(recovery.backupTakenAt);
  assert.deepEqual(recovery.collections, { orders: 1 });
  await repaired.acknowledgeRecovery();
  assert.equal(repaired.status().recovery, null);
  repaired.close();
});

test("unit: an old backup is never applied automatically; a fresh one is, and stays flagged", async () => {
  const { createStorage } = require("../server/core/storage");
  const dir = tempDir("old-backup");
  const storage = createStorage({ dataDir: dir });
  await storage.repository("orders").insert({ id: "kept", createdAt: "2026-01-01T00:00:00.000Z" });
  storage.close();
  const dbFile = path.join(dir, "site.db");
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(`${dbFile}.bak`, old, old);
  for (const name of fs.readdirSync(path.join(dir, "backups"))) fs.utimesSync(path.join(dir, "backups", name), old, old);
  fs.writeFileSync(dbFile, "{broken");

  const refused = createStorage({ dataDir: dir, autoRestoreMaxAgeHours: 24 });
  assert.throws(() => refused.repository("orders").list(), /старше 24 ч/);
  assert.equal(fs.readFileSync(dbFile, "utf8"), "{broken", "повреждённый файл не тронут");
  refused.close();

  const allowed = createStorage({ dataDir: dir, autoRestoreMaxAgeHours: 72 });
  assert.deepEqual(allowed.repository("orders").list().map((item) => item.id), ["kept"]);
  assert.ok(allowed.status().recovery.backupAgeHours >= 47);
  allowed.close();

  const reopened = createStorage({ dataDir: dir });
  assert.ok(reopened.status().recovery, "предупреждение не исчезает само после перезапуска");
  reopened.close();
});

test("unit: every backup generation can be restored into a temporary database", async () => {
  const { createSqliteStorage: createStorage, verifyBackupFile } = require("../server/core/storage/sqlite");
  const dir = tempDir("backup-restore");
  const storage = createStorage({ dataDir: dir, keepDaily: 3 });
  await storage.repository("orders").insert({ id: "o1", createdAt: "2026-10-01T00:00:00.000Z" });
  await storage.repository("orders").insert({ id: "o2", createdAt: "2026-10-05T00:00:00.000Z" });
  await storage.backupNow();
  assert.equal(storage.status().lastBackupError, "");
  storage.close();

  const backups = [path.join(dir, "site.db.bak"), ...fs.readdirSync(path.join(dir, "backups")).map((n) => path.join(dir, "backups", n))];
  assert.ok(backups.length >= 2);
  for (const file of backups) {
    const check = verifyBackupFile(file);
    assert.equal(check.ok, true, file);
    assert.deepEqual(check.collections, { orders: 2 });
    assert.equal(check.newestOrderAt, "2026-10-05T00:00:00.000Z");
    const restoreDir = tempDir("restore-target");
    fs.copyFileSync(file, path.join(restoreDir, "site.db"));
    const restored = createStorage({ dataDir: restoreDir });
    assert.deepEqual(restored.repository("orders").list().map((o) => o.id), ["o1", "o2"]);
    assert.equal(restored.status().recovery, null);
    restored.close();
  }
  assert.equal(verifyBackupFile(path.join(dir, "missing.db")).ok, false);
});

test("unit: a hidden client returns after a newer order if the live update was missed", async () => {
  const { createStorage } = require("../server/core/storage");
  const { createClientsService } = require("../server/modules/clients/service");
  const storage = createStorage({ dataDir: tempDir("hidden") });
  const clients = storage.repository("clients");
  const orders = storage.repository("orders");
  await clients.insert({
    id: "c1",
    name: "Анна",
    phone: "87771234567",
    phoneKey: "77771234567",
    note: "важное",
    hidden: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
  });
  await orders.insert({
    id: "old",
    createdAt: "2026-03-01T00:00:00.000Z",
    customerName: "Анна",
    customerContact: "87771234567",
  });
  const service = createClientsService({ repo: clients, listOrders: () => orders.list() });
  assert.equal((await service.buildList()).length, 0, "старый заказ не снимает скрытие");

  await orders.insert({
    id: "new",
    createdAt: "2026-03-03T00:00:00.000Z",
    customerName: "Анна",
    customerContact: "87771234567",
  });
  const list = await service.buildList();
  assert.equal(list.length, 1);
  assert.equal(list[0].note, "важное");
  assert.equal(list[0].id, "c1");
  storage.close();
});

test("unit: correcting the only order phone keeps the client note on the same card", async () => {
  const { createStorage } = require("../server/core/storage");
  const { createClientsService } = require("../server/modules/clients/service");
  const storage = createStorage({ dataDir: tempDir("phone-move") });
  const clients = storage.repository("clients");
  const orders = storage.repository("orders");
  await clients.insert({
    id: "c1",
    name: "Анна",
    phone: "87771234567",
    phoneKey: "77771234567",
    note: "важное",
    hidden: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  await orders.insert({
    id: "o1",
    customerName: "Анна",
    customerContact: "87770000000",
    createdAt: "2026-03-02T00:00:00.000Z",
  });
  const service = createClientsService({ repo: clients, listOrders: () => orders.list() });
  await service.upsertFromOrder(
    { id: "o1", customerName: "Анна", customerContact: "87770000000" },
    { previousContact: "87771234567" }
  );
  const stored = clients.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "c1");
  assert.equal(stored[0].note, "важное");
  assert.equal(stored[0].phoneKey, "77770000000");
  storage.close();
});

test("unit: a phone change leaves the old card when another order still uses that number", async () => {
  const { createStorage } = require("../server/core/storage");
  const { createClientsService } = require("../server/modules/clients/service");
  const storage = createStorage({ dataDir: tempDir("phone-shared") });
  const clients = storage.repository("clients");
  const orders = storage.repository("orders");
  await clients.insert({
    id: "c1",
    name: "Анна",
    phone: "87771234567",
    phoneKey: "77771234567",
    note: "важное",
    hidden: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  await orders.insert({ id: "o1", customerName: "Анна", customerContact: "87770000000", createdAt: "2026-03-02T00:00:00.000Z" });
  await orders.insert({ id: "o2", customerName: "Анна", customerContact: "87771234567", createdAt: "2026-03-03T00:00:00.000Z" });
  const service = createClientsService({ repo: clients, listOrders: () => orders.list() });
  await service.upsertFromOrder(
    { id: "o1", customerName: "Анна", customerContact: "87770000000" },
    { previousContact: "87771234567" }
  );
  const stored = clients.list();
  assert.equal(stored.length, 2);
  assert.equal(stored.find((item) => item.id === "c1").note, "важное");
  assert.equal(stored.find((item) => item.id === "c1").phoneKey, "77771234567");
  assert.equal(stored.find((item) => item.phoneKey === "77770000000").note, "");
  storage.close();
});

test("a stale client note does not overwrite a newer one", async () => {
  const { server } = await freshServer();
  try {
    const token = await login(server.base);
    await api(server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand" }], customerName: "Анна", customerContact: "87771234567" },
    });
    let client;
    for (let i = 0; i < 40 && !client; i += 1) {
      await sleep(50);
      client = (await api(server.base, "GET", "/api/clients", { token })).body[0];
    }
    await sleep(300);
    client = (await api(server.base, "GET", "/api/clients", { token })).body[0];
    assert.ok(client);
    const saved = await api(server.base, "PATCH", `/api/clients/${client.id}`, {
      token,
      body: { note: "новая", updatedAt: client.updatedAt },
    });
    assert.equal(saved.status, 200);
    const stale = await api(server.base, "PATCH", `/api/clients/${client.id}`, {
      token,
      body: { note: "старая", updatedAt: client.updatedAt },
    });
    assert.equal(stale.status, 409);
    const again = (await api(server.base, "GET", "/api/clients", { token })).body[0];
    assert.equal(again.note, "новая");
  } finally {
    await server.stop();
  }
});

test("editing an order phone keeps the client note on the same card", async () => {
  const { server } = await freshServer();
  try {
    const token = await login(server.base);
    const created = await api(server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand" }], customerName: "Анна", customerContact: "87771234567" },
    });
    assert.equal(created.status, 201);
    let client;
    for (let i = 0; i < 40 && !client; i += 1) {
      await sleep(50);
      client = (await api(server.base, "GET", "/api/clients", { token })).body[0];
    }
    assert.ok(client);
    const noted = await api(server.base, "PATCH", `/api/clients/${client.id}`, {
      token,
      body: { note: "важное", updatedAt: client.updatedAt },
    });
    assert.equal(noted.status, 200);
    const patched = await api(server.base, "PATCH", `/api/orders/${created.body.id}`, {
      token,
      body: { customerContact: "87770000000", version: 1 },
    });
    assert.equal(patched.status, 200);
    const clients = (await api(server.base, "GET", "/api/clients", { token })).body;
    assert.equal(clients.length, 1);
    assert.equal(clients[0].id, client.id);
    assert.equal(clients[0].note, "важное");
    assert.equal(clients[0].ordersCount, 1);
  } finally {
    await server.stop();
  }
});

test("unsent telegram notification is delivered after restart", async () => {
  const dataDir = tempDir("tg-retry");
  seedData(dataDir);
  const fail = await startMock(() => ({ status: 502, body: { ok: false } }));
  const first = await freshServer({
    DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: fail.url,
  });
  try {
    const res = await api(first.server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand" }], customerName: "Анна", customerContact: "87771234567" },
    });
    assert.equal(res.status, 201);
    await waitForOrder(dataDir, (o) => o.telegramStatus === "retrying");
    assert.equal(fail.requests.length, 1);
  } finally {
    await first.server.stop();
    await fail.close();
  }
  const before = readRecords(dataDir, "orders");
  assert.equal(before[0].telegramStatus, "retrying");
  assert.equal(before[0].telegramAttempts, 1);
  assert.match(before[0].telegramLastError, /^502/);
  assert.ok(before[0].telegramNextAttemptAt);
  // The scheduled retry is 30 s away; move it into the past as if that time passed.
  before[0].telegramNextAttemptAt = new Date(Date.now() - 1000).toISOString();
  writeRecords(dataDir, "orders", before);

  const ok = await startMock(() => ({ body: { ok: true } }));
  const second = await freshServer({
    DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: ok.url,
  });
  try {
    let order;
    for (let i = 0; i < 50; i += 1) {
      order = readRecords(dataDir, "orders")[0];
      if (order.telegramStatus === "sent") break;
      await sleep(50);
    }
    assert.equal(ok.requests.length, 1);
    assert.equal(order.telegramStatus, "sent");
    assert.equal(order.telegramAttempts, 2);
    assert.ok(order.telegramSentAt);
  } finally {
    await second.server.stop();
    await ok.close();
  }
});

async function waitForOrder(dataDir, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let order;
  while (Date.now() < deadline) {
    order = readRecords(dataDir, "orders")[0];
    if (order && predicate(order)) return order;
    await sleep(50);
  }
  return order;
}

const TG_ENV = (url) => ({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_URL: url, TELEGRAM_RETRY_INTERVAL_MS: "200" });
const ORDER_BODY = { items: [{ id: "p-brand", price: 50000, currency: "kzt" }], customerName: "Анна", customerContact: "87771234567" };

test("telegram 401/403: one attempt, order marked failed, no automatic retries, health degraded", async () => {
  for (const status of [401, 403]) {
    const mock = await startMock(() => ({ status, body: { ok: false, description: "Unauthorized" } }));
    const { server, dataDir } = await freshServer(TG_ENV(mock.url));
    try {
      assert.equal((await api(server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
      const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "failed");
      assert.equal(order.telegramStatus, "failed", String(status));
      assert.equal(order.telegramNextAttemptAt, null);
      await sleep(1200);
      assert.equal(mock.requests.length, 1, `после ${status} автоматических повторов нет`);
      const health = await api(server.base, "GET", "/api/health");
      assert.equal(health.status, 503);
      assert.equal(health.body.checks.telegram.state, "config_error");
      assert.equal(health.body.checks.telegram.counts.failed, 1);
      assert.ok(!server.output().includes("123:abc"), "токен бота не попадает в лог");
    } finally {
      await server.stop();
      await mock.close();
    }
  }
});

test("telegram 429: retry_after is honoured before the next attempt", async () => {
  const times = [];
  const mock = await startMock((_req, n) => {
    times.push(Date.now());
    return n === 1 ? { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } } } : { body: { ok: true } };
  });
  const { server, dataDir } = await freshServer(TG_ENV(mock.url));
  try {
    assert.equal((await api(server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
    const waiting = await waitForOrder(dataDir, (o) => o.telegramStatus === "retrying");
    assert.equal(waiting.telegramStatus, "retrying");
    const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "sent", 6000);
    assert.equal(order.telegramStatus, "sent");
    assert.equal(mock.requests.length, 2);
    assert.ok(times[1] - times[0] >= 2000, `повтор через ${times[1] - times[0]} мс, а Telegram просил 2000`);
  } finally {
    await server.stop();
    await mock.close();
  }
});

test("telegram 500 and timeouts: bounded backoff, never a tight loop", async () => {
  const mock = await startMock(() => ({ status: 500, body: { ok: false } }));
  const { server, dataDir } = await freshServer(TG_ENV(mock.url));
  try {
    assert.equal((await api(server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
    const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "retrying");
    await sleep(1500);
    assert.equal(mock.requests.length, 1, "следующая попытка только через 30 с");
    assert.ok(Date.parse(order.telegramNextAttemptAt) - Date.parse(order.telegramLastAttemptAt) >= 29000);
  } finally {
    await server.stop();
    await mock.close();
  }

  const unit = require("../server/modules/telegram");
  const headers = new Headers();
  assert.equal(unit.classify(500, {}, headers).kind, "temporary");
  assert.equal(unit.classify(502, null, headers).kind, "temporary");
  assert.equal(unit.classify(401, {}, headers).kind, "config");
  assert.equal(unit.classify(400, { description: "Bad Request: chat not found" }, headers).kind, "config");
  assert.equal(unit.classify(400, { description: "Bad Request: message is too long" }, headers).kind, "permanent");
  assert.equal(unit.classify(429, { parameters: { retry_after: 7 } }, headers).retryAfterMs, 7000);
});

test("telegram: the last scheduled attempt turns a temporary failure into dead", async () => {
  const mock = await startMock(() => ({ status: 503, body: { ok: false } }));
  const dataDir = tempDir("tg-dead");
  seedData(dataDir);
  const first = await freshServer({ DATA_DIR: dataDir });
  try {
    assert.equal((await api(first.server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
  } finally {
    await first.server.stop();
  }
  const orders = readRecords(dataDir, "orders");
  Object.assign(orders[0], { telegramStatus: "retrying", telegramAttempts: 10, telegramNextAttemptAt: new Date(Date.now() - 1000).toISOString() });
  writeRecords(dataDir, "orders", orders);
  const second = await freshServer({ DATA_DIR: dataDir, ...TG_ENV(mock.url) });
  try {
    const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "dead");
    assert.equal(order.telegramStatus, "dead");
    assert.equal(order.telegramAttempts, 11);
    await sleep(800);
    assert.equal(mock.requests.length, 1);
  } finally {
    await second.server.stop();
    await mock.close();
  }
});

test("telegram unavailable (connection refused) keeps the order and schedules a retry", async () => {
  const { server, dataDir } = await freshServer(TG_ENV("http://127.0.0.1:9"));
  try {
    assert.equal((await api(server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
    const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "retrying");
    assert.equal(order.telegramStatus, "retrying");
    assert.match(order.telegramLastError, /сеть/);
  } finally {
    await server.stop();
  }
});

test("old unsent orders are never dropped: legacy flags become explicit states and are delivered", async () => {
  const dataDir = tempDir("tg-legacy");
  seedData(dataDir);
  const boot = await freshServer({ DATA_DIR: dataDir });
  await boot.server.stop();
  const old = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  const base = { items: [{ id: "p-brand", title: "Ролик", qty: 1, price: 50000, currency: "kzt" }], totals: { kzt: 50000 }, customerName: "Старый", customerContact: "87771234567", status: "new" };
  writeRecords(dataDir, "orders", [
    { ...base, id: "legacy-unsent", createdAt: old, telegramNotified: false },
    { ...base, id: "legacy-sent", createdAt: old, telegramNotified: true },
    { ...base, id: "legacy-untracked", createdAt: old },
  ]);

  // Without Telegram: states are explicit, the unsent one is visible and health says so.
  const offline = await freshServer({ DATA_DIR: dataDir });
  try {
    const token = await login(offline.server.base);
    const list = (await api(offline.server.base, "GET", "/api/orders", { token })).body;
    const byId = Object.fromEntries(list.map((o) => [o.id, o]));
    assert.equal(byId["legacy-unsent"].telegramStatus, "pending");
    assert.equal(byId["legacy-sent"].telegramStatus, "sent");
    assert.equal(byId["legacy-untracked"].telegramStatus, "unknown");
    assert.ok(list.every((o) => !("telegramNotified" in o)));
    const status = await api(offline.server.base, "GET", "/api/admin/status", { token });
    assert.equal(status.body.checks.telegram.state, "not_configured");
    assert.equal(status.body.checks.telegram.undelivered, 1);
    const manual = await api(offline.server.base, "POST", "/api/orders/legacy-unsent/notify", { token });
    assert.equal(manual.status, 503);
  } finally {
    await offline.server.stop();
  }

  const ok = await startMock(() => ({ body: { ok: true } }));
  const online = await freshServer({ DATA_DIR: dataDir, ...TG_ENV(ok.url) });
  try {
    let unsent;
    for (let i = 0; i < 60; i += 1) {
      unsent = readRecords(dataDir, "orders").find((o) => o.id === "legacy-unsent");
      if (unsent.telegramStatus === "sent") break;
      await sleep(50);
    }
    assert.equal(unsent.telegramStatus, "sent", "заявка старше суток всё равно доставлена");
    assert.equal(ok.requests.length, 1, "доставленные и неотслеживаемые не отправляются повторно автоматически");

    const token = await login(online.server.base);
    const manual = await api(online.server.base, "POST", "/api/orders/legacy-untracked/notify", { token });
    assert.equal(manual.status, 200);
    assert.equal(manual.body.telegramStatus, "sent");
    const again = await api(online.server.base, "POST", "/api/orders/legacy-untracked/notify", { token });
    assert.equal(again.status, 409);
    assert.equal(ok.requests.length, 2);
    await sleep(100);
    const audit = readRecords(dataDir, "audit").map((a) => a.action);
    assert.ok(audit.includes("telegram.sent"));
    assert.ok(audit.includes("telegram.manual_retry"));
  } finally {
    await online.server.stop();
    await ok.close();
  }
});

test("manual retry after a fixed token reports the real result to the admin", async () => {
  let accept = false;
  const mock = await startMock(() => (accept ? { body: { ok: true } } : { status: 401, body: { ok: false, description: "Unauthorized" } }));
  const { server, dataDir } = await freshServer(TG_ENV(mock.url));
  try {
    const token = await login(server.base);
    const created = await api(server.base, "POST", "/api/orders", { body: ORDER_BODY });
    await waitForOrder(dataDir, (o) => o.telegramStatus === "failed");
    const refused = await api(server.base, "POST", `/api/orders/${created.body.id}/notify`, { token });
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /401/);
    assert.equal(refused.body.order.telegramStatus, "failed");
    accept = true;
    const sent = await api(server.base, "POST", `/api/orders/${created.body.id}/notify`, { token });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.telegramStatus, "sent");
  } finally {
    await server.stop();
    await mock.close();
  }
});

test("restart during a send: an interrupted attempt is picked up again, not lost", async () => {
  const dataDir = tempDir("tg-interrupted");
  seedData(dataDir);
  const boot = await freshServer({ DATA_DIR: dataDir });
  try {
    assert.equal((await api(boot.server.base, "POST", "/api/orders", { body: ORDER_BODY })).status, 201);
  } finally {
    await boot.server.stop();
  }
  const orders = readRecords(dataDir, "orders");
  Object.assign(orders[0], {
    telegramStatus: "sending",
    telegramAttempts: 1,
    telegramLastAttemptAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    telegramNextAttemptAt: null,
  });
  writeRecords(dataDir, "orders", orders);
  const ok = await startMock(() => ({ body: { ok: true } }));
  const { server } = await freshServer({ DATA_DIR: dataDir, ...TG_ENV(ok.url) });
  try {
    const order = await waitForOrder(dataDir, (o) => o.telegramStatus === "sent");
    assert.equal(order.telegramStatus, "sent");
    assert.equal(order.telegramAttempts, 2);
  } finally {
    await server.stop();
    await ok.close();
  }
});

test("a retry of a saved order is answered even when the order rate limit is used up", async () => {
  const { server, dataDir } = await freshServer();
  const ip = "10.99.0.1";
  // Different tasks: identical content within 10 minutes counts as a repeat.
  const order = (requestId) => ({
    items: [{ id: "p-brand" }],
    customerName: "Анна",
    customerContact: "87771234567",
    task: `задача ${requestId}`,
    requestId,
  });
  try {
    const savedId = "retry-request-000000";
    const first = await api(server.base, "POST", "/api/orders", { ip, body: order(savedId) });
    assert.equal(first.status, 201);
    for (let i = 1; i <= 4; i += 1) {
      assert.equal((await api(server.base, "POST", "/api/orders", { ip, body: order(`retry-request-00000${i}`) })).status, 201);
    }
    assert.equal((await api(server.base, "POST", "/api/orders", { ip, body: order("retry-request-000009") })).status, 429);

    const retry = await api(server.base, "POST", "/api/orders", { ip, body: order(savedId) });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, first.body.id);
    assert.equal(readRecords(dataDir, "orders").length, 5);

    // Short ids are easier to guess, so they never skip the limiter.
    const shortId = await api(server.base, "POST", "/api/orders", { ip, body: order("retry-request-000001".slice(0, 12)) });
    assert.equal(shortId.status, 429);
  } finally {
    await server.stop();
  }
});

test("a brand-new product is protected from a stale edit in a second admin tab", async () => {
  const { server } = await freshServer();
  try {
    const token = await login(server.base);
    const created = await api(server.base, "POST", "/api/products", { token, body: imageForm({ title: "Новый" }) });
    assert.equal(created.status, 201);
    assert.ok(created.body.updatedAt);

    await sleep(5);
    const firstTab = await api(server.base, "PUT", `/api/products/${created.body.id}`, {
      token,
      body: imageForm({ title: "Первая вкладка", updatedAt: created.body.updatedAt }, { withImage: false }),
    });
    assert.equal(firstTab.status, 200);
    const secondTab = await api(server.base, "PUT", `/api/products/${created.body.id}`, {
      token,
      body: imageForm({ title: "Вторая вкладка", updatedAt: created.body.updatedAt }, { withImage: false }),
    });
    assert.equal(secondTab.status, 409);
    const list = (await api(server.base, "GET", "/api/products")).body;
    assert.equal(list.find((p) => p.id === created.body.id).title, "Первая вкладка");
  } finally {
    await server.stop();
  }
});

test("unit: TRUST_PROXY trusts only named proxies, never a hop count", () => {
  const { loadConfig } = require("../server/core/config");
  const trust = (value) => loadConfig({ TRUST_PROXY: value }).config.trustProxy;
  ["", "0", "false", "FALSE", "no", "off"].forEach((value) => assert.equal(trust(value), false, value));
  assert.equal(trust(undefined), false);
  ["1", "2", "true", "yes", "on"].forEach((value) => {
    const loaded = loadConfig({ TRUST_PROXY: value });
    assert.equal(loaded.config.trustProxy, false, value);
    assert.ok(loaded.warnings.some((w) => w.includes("небезопасен")), value);
  });
  assert.equal(trust("loopback"), "loopback");
  assert.equal(trust("10.0.0.0/8, 127.0.0.1"), "10.0.0.0/8, 127.0.0.1");
  const bad = loadConfig({ TRUST_PROXY: "<script>" });
  assert.equal(bad.config.trustProxy, false);
  assert.ok(bad.warnings.some((w) => w.includes("TRUST_PROXY")));

  // A name Express does not know passes the format check but must not crash startup.
  const { createHttp } = require("../server/core/http/app");
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), error() {}, info() {} };
  const { app } = createHttp({ config: { ...loadConfig({}).config, trustProxy: "typo" }, logger, services: { get() {} } });
  assert.equal(app.get("trust proxy"), false);
  assert.ok(warnings.some((w) => w.includes("TRUST_PROXY")));
});

test("unit: stop waits for event handlers that start while it is already waiting", async () => {
  const { createEventBus } = require("../server/core/events");
  const bus = createEventBus({ logger: { error() {} } });
  let finished = false;
  bus.on("first", async () => {
    await sleep(30);
    bus.emit("second");
  });
  bus.on("second", async () => {
    await sleep(60);
    finished = true;
  });
  bus.emit("first");
  assert.equal(await bus.drain(2000), true);
  assert.equal(finished, true);
});

test("unit: two processes cannot overwrite each other's records", async () => {
  const dataDir = tempDir("cross");
  const storagePath = path.join(__dirname, "..", "server", "core", "storage");
  function run() {
    const code = `
      const { createStorage } = require(${JSON.stringify(storagePath)});
      const storage = createStorage({ dataDir: ${JSON.stringify(dataDir)} });
      const repo = storage.repository("items");
      (async () => {
        for (let i = 0; i < 15; i += 1) {
          await repo.transaction(async (items) => {
            await new Promise((resolve) => setTimeout(resolve, 2));
            items.push({ id: process.pid + "-" + i });
          });
        }
        storage.close();
        process.exit(0);
      })().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let errText = "";
      child.stderr.on("data", (chunk) => {
        errText += chunk;
      });
      child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(errText || `код ${status}`))));
    });
  }
  await Promise.all([run(), run()]);
  assert.equal(readRecords(dataDir, "items").length, 30);
});

test("unit: circuit breaker opens, cools down and lets one trial through", () => {
  const { createCircuitBreaker } = require("../server/core/ai/breaker");
  let now = 0;
  const logger = { info() {}, warn() {} };
  const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 1000, logger, now: () => now });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(breaker.canRequest(), true);
    breaker.failure();
  }
  assert.equal(breaker.canRequest(), false);
  now = 1500;
  assert.equal(breaker.canRequest(), true, "после паузы пропускается пробный запрос");
  assert.equal(breaker.canRequest(), false, "только один пробный запрос одновременно");
  breaker.success();
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.canRequest(), true);
});
