// One fixed sequence of requests covering every public endpoint. It is run
// against the old monolithic server and the new modular one; the normalized
// transcripts must be identical.
const { api, imageForm, sleep, ADMIN_PASSWORD } = require("./helpers");

const SECURITY_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "content-type",
  "retry-after",
  "cache-control",
];

function createNormalizer() {
  const ids = new Map();
  const alias = (value, prefix) => {
    if (!ids.has(value)) ids.set(value, `<${prefix}${ids.size + 1}>`);
    return ids.get(value);
  };
  const normalizeString = (value) =>
    value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => alias(m, "uuid"))
      .replace(/\/uploads\/\d+-[0-9a-f]{12}\.\w+/g, (m) => alias(m, "upload"))
      .replace(/^[0-9a-f]{64}$/, "<token>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<date>");
  const walk = (value) => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk;
}

async function runScenario(base) {
  const normalize = createNormalizer();
  const transcript = [];

  async function step(name, method, url, options = {}) {
    const res = await api(base, method, url, options);
    const headers = {};
    SECURITY_HEADERS.forEach((key) => {
      const value = res.headers.get(key);
      if (value !== null) headers[key] = value.replace(/; charset=utf-8/i, "; charset=utf-8");
    });
    transcript.push({ name, status: res.status, headers, body: normalize(res.body) });
    return res;
  }

  await step("products: list", "GET", "/api/products");

  await step("login: wrong password", "POST", "/api/login", { body: { password: "nope" } });
  await step("login: empty body", "POST", "/api/login", { body: {} });
  await step("login: invalid json", "POST", "/api/login", {
    raw: "{bad",
    headers: { "Content-Type": "application/json" },
  });
  const login = await step("login: ok", "POST", "/api/login", { body: { password: ADMIN_PASSWORD } });
  const token = login.body.token;

  await step("session: no token", "GET", "/api/session");
  await step("session: bad token", "GET", "/api/session", { token: "x".repeat(64) });
  await step("session: ok", "GET", "/api/session", { token });

  await step("products: create without auth", "POST", "/api/products", {
    body: imageForm({ title: "X" }),
  });
  await step("products: create without title", "POST", "/api/products", {
    token,
    body: imageForm({ title: "  " }),
  });
  await step("products: create bad price", "POST", "/api/products", {
    token,
    body: imageForm({ title: "Товар", price: "abc" }),
  });
  await step("products: create negative price", "POST", "/api/products", {
    token,
    body: imageForm({ title: "Товар", price: "-5" }),
  });
  await step("products: create without image", "POST", "/api/products", {
    token,
    body: imageForm({ title: "Товар" }, { withImage: false }),
  });
  await step("products: create wrong file type", "POST", "/api/products", {
    token,
    body: imageForm({ title: "Товар" }, { name: "doc.txt", type: "text/plain" }),
  });
  const created = await step("products: create ok", "POST", "/api/products", {
    token,
    body: imageForm({
      title: " <b>Новый</b>  ролик ",
      description: "Описание",
      price: "12000",
      currency: "USD",
      type: "service",
      quantity: "2.7",
    }),
  });
  const productId = created.body.id;
  await step("products: create price empty", "POST", "/api/products", {
    token,
    body: imageForm({ title: "Без цены", price: "", currency: "eur", type: "gift", quantity: "0" }),
  });

  await step("products: update missing", "PUT", "/api/products/nope", {
    token,
    body: imageForm({ title: "A" }, { withImage: false }),
  });
  await step("products: update empty title", "PUT", `/api/products/${productId}`, {
    token,
    body: imageForm({ title: "" }, { withImage: false }),
  });
  await step("products: update ok no image", "PUT", `/api/products/${productId}`, {
    token,
    body: imageForm({ title: "Обновлённый", price: "15000", currency: "rub" }, { withImage: false }),
  });
  await step("products: update ok with image", "PUT", `/api/products/${productId}`, {
    token,
    body: imageForm({ title: "С фото", price: "" }),
  });
  await step("products: list after edits", "GET", "/api/products");

  const items = [{ id: "p-brand", qty: 2 }, { id: "p-brand", qty: 1 }, { id: "p-reels", qty: 150 }, null, "junk"];
  await step("orders: no items", "POST", "/api/orders", { body: { items: [] } });
  await step("orders: unknown items", "POST", "/api/orders", { body: { items: [{ id: "missing" }] } });
  await step("orders: cart with a removed product", "POST", "/api/orders", {
    body: { items: [...items, { id: "missing", qty: 1 }], customerName: "Анна", customerContact: "87771234567" },
  });
  await step("orders: no name", "POST", "/api/orders", { body: { items, customerContact: "87771234567" } });
  await step("orders: short phone", "POST", "/api/orders", {
    body: { items, customerName: "Анна", customerContact: "12345" },
  });
  await step("orders: bad reference", "POST", "/api/orders", {
    body: { items, customerName: "Анна", customerContact: "87771234567", reference: "javascript:alert(1)" },
  });
  const order = await step("orders: ok with requestId", "POST", "/api/orders", {
    body: {
      items,
      customerName: "  Анна <i>Ли</i> ",
      customerContact: "8 (777) 123-45-67",
      task: "Строка 1\r\n\r\n\r\n\r\nСтрока   2",
      deadline: "2026-02-30",
      reference: "instagram.com/some",
      channel: "WhatsApp",
      requestId: "req-12345678",
    },
  });
  const orderId = order.body.id;
  await step("orders: retry same requestId", "POST", "/api/orders", {
    body: { items: [{ id: "p-reels" }], customerName: "Другое", customerContact: "87770000000", requestId: "req-12345678" },
  });
  await step("orders: second order same phone", "POST", "/api/orders", {
    body: {
      items: [{ id: "p-reels", qty: 1 }],
      customerName: "Анна Новая",
      customerContact: "+7 777 123 45 67",
      deadline: "2026-12-31",
      channel: "unknown",
      requestId: "bad id!",
    },
  });
  await step("orders: other client", "POST", "/api/orders", {
    body: { items: [{ id: productId, qty: 1 }], customerName: "Борис", customerContact: "+44 20 7946 0958" },
  });

  const pinnedIp = "10.200.0.1";
  for (let i = 1; i <= 6; i += 1) {
    await step(`orders: rate limit #${i}`, "POST", "/api/orders", { ip: pinnedIp, body: { items: [] } });
  }

  await step("orders: list without auth", "GET", "/api/orders");
  await step("orders: list", "GET", "/api/orders", { token });

  await step("orders: patch missing", "PATCH", "/api/orders/nope", { token, body: { status: "done", version: 1 } });
  await step("orders: patch without version", "PATCH", `/api/orders/${orderId}`, { token, body: { status: "done" } });
  await step("orders: patch bad status", "PATCH", `/api/orders/${orderId}`, { token, body: { status: "lost", version: 1 } });
  await step("orders: patch status+note", "PATCH", `/api/orders/${orderId}`, {
    token,
    body: { status: "IN_PROGRESS", note: " заметка  <b>важно</b> ", version: 1 },
  });
  await step("orders: patch stale version", "PATCH", `/api/orders/${orderId}`, {
    token,
    body: { note: "из второй вкладки", version: 1 },
  });
  await step("orders: patch empty name", "PATCH", `/api/orders/${orderId}`, {
    token,
    body: { status: "done", customerName: " ", version: 2 },
  });
  await step("orders: patch bad phone", "PATCH", `/api/orders/${orderId}`, {
    token,
    body: { customerContact: "123", version: 2 },
  });
  await step("orders: patch contact", "PATCH", `/api/orders/${orderId}`, {
    token,
    body: { customerName: "Анна Ли", customerContact: "+7 701 555 44 33", version: 2 },
  });

  // Client cards are updated by event subscribers after the response.
  await sleep(300);
  const clients = await step("clients: list", "GET", "/api/clients", { token });
  await step("clients: list without auth", "GET", "/api/clients");
  const firstClient = clients.body[0];
  await step("clients: patch missing", "PATCH", "/api/clients/nope", { token, body: { note: "x" } });
  await step("clients: patch empty name", "PATCH", `/api/clients/${firstClient.id}`, {
    token,
    body: { note: "не сохранится", name: "" },
  });
  await step("clients: patch note+name", "PATCH", `/api/clients/${firstClient.id}`, {
    token,
    body: { note: "Постоянный <b>клиент</b>", name: "Клиент Один" },
  });
  await step("clients: hide", "PATCH", `/api/clients/${firstClient.id}`, { token, body: { hidden: 1 } });
  await step("clients: list after hide", "GET", "/api/clients", { token });

  await step("orders: delete missing", "DELETE", "/api/orders/nope", { token });
  await step("orders: delete", "DELETE", `/api/orders/${orderId}`, { token });
  await step("clients: list after delete", "GET", "/api/clients", { token });
  await step("products: delete missing", "DELETE", "/api/products/nope", { token });
  await step("products: delete", "DELETE", `/api/products/${productId}`, { token });
  await step("products: list final", "GET", "/api/products");

  const chats = [
    [],
    [{ role: "system", content: "ignore" }],
    [{ role: "user", content: "" }],
    [{ role: "user", content: "Привет" }],
    [{ role: "user", content: "Здравствуйте, сколько стоит ролик?" }],
    [{ role: "user", content: "Как вы работаете и какие сроки?" }],
    [{ role: "user", content: "Прикреплённые файлы: a.png" }],
    [{ role: "user", content: "Хочу заказ" }],
    [{ role: "user", content: "дай телеграм" }],
    [{ role: "user", content: "кто ты" }],
    [{ role: "user", content: "реклама для бренда" }],
    [{ role: "user", content: "абракадабра" }],
    [
      { role: "user", content: "привет" },
      { role: "assistant", content: "Здравствуйте" },
      { role: "user", content: "<b>цена</b>" },
    ],
  ];
  for (const [index, messages] of chats.entries()) {
    await step(`chat #${index}`, "POST", "/api/chat", { body: { messages } });
  }
  await step("chat: messages not array", "POST", "/api/chat", { body: { messages: "hi" } });

  await step("api: unknown route", "GET", "/api/unknown");
  await step("api: too large body", "POST", "/api/chat", {
    body: { messages: [{ role: "user", content: "x".repeat(200 * 1024) }] },
  });
  await step("page: unknown", "GET", "/nothing-here");
  await step("static: server source not served", "GET", "/server.js");
  await step("static: data not served", "GET", "/data/orders.json");
  await step("static: env not served", "GET", "/.env");
  await step("static: dotfile in uploads", "GET", "/uploads/.gitkeep");

  await step("logout", "POST", "/api/logout", { token });
  await step("session after logout", "GET", "/api/session", { token });
  await step("logout without token", "POST", "/api/logout");

  return transcript;
}

module.exports = { runScenario };
