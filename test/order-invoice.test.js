const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFParse } = require("pdf-parse");
const {
  ADMIN_PASSWORD,
  tempDir,
  seedData,
  readRecords,
  startServer,
  startMock,
  api,
  imageForm,
  uniqueIp,
  sleep,
} = require("./helpers");
const { buildInvoice, invoiceFileName } = require("../server/modules/order-invoice/model");

const KAZAKH = "Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і";

function product(id, overrides = {}) {
  return {
    id,
    title: `Товар ${id}`,
    description: "",
    price: 1000,
    currency: "kzt",
    type: "product",
    quantity: 1,
    image: `/uploads/${id}-missing.jpg`,
    createdAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

async function startShop(products, env = {}) {
  const dataDir = tempDir("invoice");
  const uploadsDir = tempDir("invoice-up");
  seedData(dataDir, { products });
  const server = await startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, ...env } });
  const login = await api(server.base, "POST", "/api/login", { body: { password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  return { server, dataDir, token: login.body.token };
}

async function placeOrder(base, items, extra = {}) {
  const res = await api(base, "POST", "/api/orders", {
    body: { items, customerName: "Айгерім", customerContact: "87001234567", ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function downloadInvoice(base, token, id, query = "") {
  const headers = { "X-Forwarded-For": uniqueIp() };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/orders/${encodeURIComponent(id)}/invoice.pdf${query}`, { headers });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

async function pdfText(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return await parser.getText();
  } finally {
    await parser.destroy();
  }
}

const compact = (text) => text.replace(/\s+/g, "");

async function invoiceText(base, token, id) {
  const { res, body } = await downloadInvoice(base, token, id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
  const parsed = await pdfText(body);
  return { ...parsed, flat: compact(parsed.text), headers: res.headers, body };
}

test("invoice model uses only the stored snapshot and never adds up different currencies", () => {
  const order = {
    id: "3f2a9c1e-77aa-4b1b-9d0e-1234567890ab",
    createdAt: "2026-09-15T08:30:00.000Z",
    status: "in_progress",
    customerName: "Айгерім",
    customerContact: "87001234567",
    note: "внутренняя заметка",
    requestId: "req-123456789",
    telegramNotified: true,
    task: "",
    deadline: "2026-10-20",
    reference: "javascript:alert(1)",
    items: [
      { id: "p1", title: "Брендинг", price: 10000, currency: "kzt", type: "service", qty: 2, image: "/uploads/a.jpg" },
      { id: "p2", title: "Мелочь", price: 0.1, currency: "kzt", type: "product", qty: 3, image: "" },
      { id: "p3", title: "Консультация", price: 49.99, currency: "usd", type: "service", qty: 3, image: "" },
      { id: "p4", title: "По запросу", price: null, currency: "usd", type: "service", qty: 1, image: "" },
    ],
    totals: { kzt: 20000.3, usd: 149.97 },
  };
  const invoice = buildInvoice(order);
  assert.equal(invoice.number, "3f2a9c1e");
  assert.equal(invoiceFileName(order), "invoice-order-3f2a9c1e.pdf");
  assert.equal(invoice.status, "В работе");
  assert.equal(invoice.client.phone, "+7 700 123 45 67");
  assert.deepEqual(
    invoice.rows.map((row) => [row.n, row.qty, row.price, row.sum]),
    [
      ["1", "2", "10\u00a0000\u00a0₸", "20\u00a0000\u00a0₸"],
      ["2", "3", "0,1\u00a0₸", "0,3\u00a0₸"],
      ["3", "3", "49,99\u00a0$", "149,97\u00a0$"],
      ["4", "1", "по запросу", "—"],
    ]
  );
  assert.deepEqual(invoice.totals, [
    { label: "Итого, ₸", amount: "20\u00a0000,3\u00a0₸" },
    { label: "Итого, $", amount: "149,97\u00a0$" },
  ]);
  assert.equal(invoice.hasPriceOnRequest, true);
  assert.equal(invoice.totalsMismatch, false);
  assert.deepEqual(invoice.details, { task: "", deadline: "20.10.2026", reference: "" });

  const serialized = JSON.stringify(invoice);
  ["req-123456789", "внутренняя заметка", "telegramNotified", "/uploads/", "p1", order.id].forEach((leak) =>
    assert.ok(!serialized.includes(leak), `в счёт не должно попасть «${leak}»`)
  );
  assert.doesNotMatch(serialized, /undefined|null|NaN/);

  const tampered = buildInvoice({ ...order, totals: { kzt: 1, usd: 149.97 } });
  assert.equal(tampered.totalsMismatch, true);
  assert.equal(tampered.totals[0].amount, "20\u00a0000,3\u00a0₸", "итог берётся из позиций, а не из испорченного поля");

  const bare = buildInvoice({ id: "o-7", items: [{ title: "Без данных" }] });
  assert.equal(bare.date, "");
  assert.equal(bare.status, "");
  assert.deepEqual(bare.client, { name: "", phone: "" });
  assert.doesNotMatch(JSON.stringify(bare), /undefined|null|NaN/);
});

test("invoice requires the admin token and returns 404 for unknown orders", async () => {
  const { server, token } = await startShop([product("p1")]);
  try {
    const order = await placeOrder(server.base, [{ id: "p1", qty: 1 }]);

    const anonymous = await downloadInvoice(server.base, "", order.id);
    assert.equal(anonymous.res.status, 401);
    assert.doesNotMatch(String(anonymous.res.headers.get("content-type")), /pdf/);

    const forged = await downloadInvoice(server.base, "not-a-real-token", order.id);
    assert.equal(forged.res.status, 401);

    for (const id of ["00000000-0000-0000-0000-000000000000", "../../etc/passwd", "..\\server.js", "a".repeat(200)]) {
      const missing = await api(server.base, "GET", `/api/orders/${encodeURIComponent(id)}/invoice.pdf`, { token });
      assert.equal(missing.status, 404, id);
      assert.deepEqual(missing.body, { error: "Заказ не найден" });
    }
  } finally {
    await server.stop();
  }
});

test("old invoice keeps the snapshot price and title after the product is edited and deleted", async () => {
  const { server, token } = await startShop([]);
  try {
    const created = await api(server.base, "POST", "/api/products", {
      token,
      body: imageForm({ title: "Ролик Әсем", price: "10000", currency: "kzt", type: "service" }),
    });
    assert.equal(created.status, 201);
    const productId = created.body.id;

    const order = await placeOrder(server.base, [{ id: productId, qty: 3 }]);
    const stored = (await api(server.base, "GET", "/api/orders", { token })).body.find((item) => item.id === order.id);
    assert.equal(stored.items[0].price, 10000, "в заказе сохранена цена на момент заказа");

    const edited = await api(server.base, "PUT", `/api/products/${productId}`, {
      token,
      body: imageForm({ title: "Новое название", price: "20000", currency: "kzt", type: "service" }, { withImage: false }),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.price, 20000);

    const afterEdit = await invoiceText(server.base, token, order.id);
    assert.ok(afterEdit.flat.includes("10000₸"), "цена из снимка заказа");
    assert.ok(afterEdit.flat.includes("30000₸"), "10 000 × 3");
    assert.ok(!afterEdit.flat.includes("20000"), "текущая цена каталога не используется");
    assert.ok(!afterEdit.flat.includes("60000"), "заказ не пересчитан по новой цене");
    assert.ok(afterEdit.flat.includes(compact("Ролик Әсем")), "название из снимка заказа");
    assert.ok(!afterEdit.flat.includes("Новоеназвание"));

    assert.equal((await api(server.base, "DELETE", `/api/products/${productId}`, { token })).status, 200);
    const afterDelete = await invoiceText(server.base, token, order.id);
    assert.equal(afterDelete.text, afterEdit.text, "удалённый товар не мешает и документ не меняется");
  } finally {
    await server.stop();
  }
});

test("browser cannot change prices, titles or totals of an invoice", async () => {
  const { server, dataDir, token } = await startShop([product("p1", { title: "Настоящий товар", price: 25000 })]);
  try {
    // A cart with a price that differs from the catalog is refused, not silently repriced.
    const tampered = await api(server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p1", qty: 2, price: 1, title: "Подмена", currency: "usd", total: 2 }], customerName: "Айгерім", customerContact: "87001234567" },
    });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.code, "catalog_changed");
    assert.deepEqual(tampered.body.changed, [{ id: "p1", title: "Настоящий товар", price: 25000, currency: "kzt" }]);
    assert.equal(readRecords(dataDir, "orders").length, 0);

    const order = await placeOrder(server.base, [{ id: "p1", qty: 2, title: "Подмена", total: 2 }]);
    const { flat } = await invoiceText(server.base, token, order.id);
    assert.ok(flat.includes("25000₸") && flat.includes("50000₸"));
    assert.ok(!flat.includes("Подмена") && !flat.includes("$"));

    const withQuery = await downloadInvoice(server.base, token, order.id, "?price=1&total=1&title=Подмена&qty=99");
    assert.equal(withQuery.res.status, 200);
    assert.equal((await pdfText(withQuery.body)).text, (await pdfText((await downloadInvoice(server.base, token, order.id)).body)).text);
  } finally {
    await server.stop();
  }
});

test("invoice shows the stored order: client, Kazakh text, big amounts, details, file name", async () => {
  const longTitle = `Очень длинное название услуги с цифрами 2026 и ${KAZAKH} — проверка переноса строк внутри таблицы счёта`;
  const { server, token } = await startShop([
    product("big", { title: "Дорогой товар", price: 999999999 }),
    product("long", { title: longTitle, price: 15000, type: "service" }),
    product("word", { title: "Оченьдлинноесловобезпробеловкотороедолжнопереноситься123", price: 500 }),
    product("emoji", { title: "✨ Reels 🎬 пакет", price: null, currency: "usd" }),
    product("usd", { title: "Консультация", price: 49.99, currency: "usd" }),
  ]);
  try {
    const order = await placeOrder(
      server.base,
      ["big", "long", "word", "emoji", "usd"].map((id) => ({ id, qty: id === "big" ? 99 : 1 })),
      {
        customerName: "Айгерім Нұрланқызы",
        task: `Снять ролик.\nСубтитры: ${KAZAKH}`,
        deadline: "2026-12-31",
        reference: "https://instagram.com/p/abc",
      }
    );
    const { text, flat, headers } = await invoiceText(server.base, token, order.id);
    const number = order.id.replace(/-/g, "").slice(0, 8);
    assert.equal(headers.get("content-disposition"), `attachment; filename="invoice-order-${number}.pdf"`);
    assert.equal(headers.get("cache-control"), "no-store");

    assert.ok(flat.includes("СЧЁТ-ФАКТУРА"));
    assert.ok(flat.includes(`№${number}`));
    assert.ok(flat.includes("Жанара"));
    assert.ok(flat.includes(compact("Айгерім Нұрланқызы")));
    assert.ok(flat.includes("+77001234567"));
    assert.ok(flat.includes("Новый"), "статус заказа");
    assert.ok(flat.includes(compact(longTitle)), "длинное название целиком, без обрезки");
    assert.ok(flat.includes("Оченьдлинноесловобезпробеловкотороедолжнопереноситься123"));
    assert.ok(flat.includes(compact(KAZAKH)));
    assert.ok(flat.includes("999999999₸") && flat.includes("98999999901₸"), "99 × 999 999 999");
    assert.ok(flat.includes("Reelsпакет") && !/[✨🎬]/u.test(text), "эмодзи убраны без квадратов");
    assert.ok(flat.includes("Итого,₸") && flat.includes("Итого,$"), "итоги по валютам отдельно");
    assert.ok(flat.includes("99000015401₸"), "итог в тенге: 98 999 999 901 + 15 000 + 500");
    assert.ok(flat.includes("49,99$"));
    assert.ok(flat.includes("31.12.2026") && flat.includes("https://instagram.com/p/abc"));
    assert.ok(flat.includes("Детализаказа") && flat.includes("Снятьролик."));
    ["1", "2", "3", "4", "5"].forEach((n) => assert.ok(text.includes(n)));

    [order.id, "/uploads/", "missing.jpg", "undefined", "null", "NaN", "telegramNotified", "requestId"].forEach((leak) =>
      assert.ok(!text.includes(leak), `в PDF не должно быть «${leak}»`)
    );
  } finally {
    await server.stop();
  }
});

test("invoice with one item and no task, and a 40-item invoice spread over pages", async () => {
  const products = Array.from({ length: 40 }, (_, i) => product(`p${i + 1}`, { title: `Позиция номер ${i + 1}`, price: 1000 + i }));
  const { server, token } = await startShop(products);
  try {
    const single = await placeOrder(server.base, [{ id: "p1", qty: 1 }]);
    const one = await invoiceText(server.base, token, single.id);
    assert.equal(one.total, 1);
    assert.ok(one.flat.includes("Позицияномер1") && one.flat.includes("Итого:1000₸"));
    assert.ok(!one.flat.includes("Детализаказа"), "пустая задача не выводится");

    const large = await placeOrder(server.base, products.map((item) => ({ id: item.id, qty: 2 })));
    const many = await invoiceText(server.base, token, large.id);
    assert.ok(many.total >= 2, "таблица переносится на следующую страницу");
    assert.ok(many.flat.includes(`стр.${many.total}из${many.total}`));
    products.forEach((item) => assert.ok(many.flat.includes(compact(item.title)), item.title));
    const expectedTotal = products.reduce((sum, item) => sum + item.price * 2, 0);
    assert.ok(many.flat.includes(`${expectedTotal}₸`), "итог совпадает с суммой позиций");
  } finally {
    await server.stop();
  }
});

test("downloading an invoice is read-only: no order, client or Telegram changes", async () => {
  const mock = await startMock(() => ({ body: { ok: true } }));
  const { server, dataDir, token } = await startShop([product("p1", { price: 7000 })], {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_URL: mock.url,
  });
  try {
    const order = await placeOrder(server.base, [{ id: "p1", qty: 2 }]);
    for (let i = 0; i < 50 && readRecords(dataDir, "orders")[0]?.telegramStatus !== "sent"; i += 1) await sleep(50);
    assert.equal(mock.requests.length, 1);
    const patched = await api(server.base, "PATCH", `/api/orders/${order.id}`, {
      token,
      body: { note: "СЕКРЕТНАЯ ЗАМЕТКА", status: "done", version: 1 },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    await sleep(100);

    const before = {
      orders: readRecords(dataDir, "orders"),
      clients: readRecords(dataDir, "clients"),
      products: readRecords(dataDir, "products"),
    };
    const first = await invoiceText(server.base, token, order.id);
    const second = await invoiceText(server.base, token, order.id);
    await sleep(200);

    assert.equal(first.text, second.text, "повторное скачивание даёт тот же документ");
    assert.ok(first.flat.includes("Готово"));
    assert.ok(!first.flat.includes("СЕКРЕТНАЯЗАМЕТКА"), "внутренняя заметка не попадает в счёт");
    assert.deepEqual(readRecords(dataDir, "orders"), before.orders);
    assert.deepEqual(readRecords(dataDir, "clients"), before.clients);
    assert.deepEqual(readRecords(dataDir, "products"), before.products);
    assert.equal(mock.requests.length, 1, "повторных уведомлений в Telegram нет");
  } finally {
    await server.stop();
    await mock.close();
  }
});
