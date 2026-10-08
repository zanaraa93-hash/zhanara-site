const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { PDFParse } = require("pdf-parse");
const { ADMIN_PASSWORD, tempDir, seedData, startServer, api, uniqueIp } = require("./helpers");
const { formatPdfPrice: formatCatalogPrice, positionsLabel, typeLabel } = require("../server/core/pdf/format");
const { resolveUploadPath } = require("../server/core/pdf/images");
const { fitText } = require("../server/core/pdf/text");

const URL_PATH = "/api/products/catalog.pdf";

// A complete RGB PNG: the 1x1 sample in helpers.js is enough for the upload
// check but png-js (used by PDFKit) rejects it as incomplete.
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xb7)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG_OK = makePng(40, 20);

function product(overrides) {
  return {
    description: "",
    price: 1000,
    currency: "kzt",
    type: "product",
    quantity: 7,
    image: "",
    createdAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

async function serverWith(products, files = {}) {
  const dataDir = tempDir("catalog");
  const uploadsDir = tempDir("catalog-up");
  seedData(dataDir, { products });
  Object.entries(files).forEach(([name, content]) => fs.writeFileSync(path.join(uploadsDir, name), content));
  const server = await startServer({ env: { DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir } });
  const login = await api(server.base, "POST", "/api/login", { body: { password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  return { server, token: login.body.token, uploadsDir };
}

async function downloadCatalog(base, token) {
  const res = await fetch(`${base}${URL_PATH}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": uniqueIp() },
  });
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

test("catalog prices keep every digit and never round", () => {
  assert.equal(formatCatalogPrice(50000, "kzt"), "50\u00a0000\u00a0₸");
  assert.equal(formatCatalogPrice(1234567.89, "rub"), "1\u00a0234\u00a0567,89\u00a0₽");
  assert.equal(formatCatalogPrice(99.5, "usd"), "99,5\u00a0$");
  assert.equal(formatCatalogPrice(0.125, "usd"), "0,125\u00a0$");
  assert.equal(formatCatalogPrice(0, "kzt"), "0\u00a0₸");
  assert.equal(formatCatalogPrice(null, "kzt"), "Цена по запросу");
  assert.equal(formatCatalogPrice("", "kzt"), "Цена по запросу");
  assert.equal(typeLabel("service"), "Услуга");
  assert.equal(typeLabel("product"), "Товар");
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(positionsLabel), [
    "1 позиция",
    "2 позиции",
    "5 позиций",
    "11 позиций",
    "21 позиция",
    "22 позиции",
  ]);
});

test("catalog text drops glyphs the fonts lack instead of printing empty boxes", () => {
  assert.equal(fitText("✨ Рилсы под ключ 🎬🔥", "serif"), "Рилсы под ключ");
  assert.equal(fitText("Эмодзи 👍🏽 и ❤️ текст", "sans"), "Эмодзи и текст");
  assert.equal(fitText("Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і", "serif"), "Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і");
  assert.equal(fitText("Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і", "sans"), "Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і");
  assert.equal(fitText("Строка 1\n\nСтрока 2\tконец", "sans"), "Строка 1 Строка 2 конец");
  assert.equal(fitText(null, "sans"), "");
});

test("catalog reads photos only from the uploads folder", () => {
  const root = path.resolve(tempDir("paths"));
  assert.equal(resolveUploadPath("/uploads/photo.png", root), path.join(root, "photo.png"));
  [
    "/uploads/../secret.txt",
    "/uploads/..",
    "/uploads/sub/photo.png",
    "/uploads/..\\secret.txt",
    "/uploads/.env",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "https://example.com/photo.png",
    "//evil.test/photo.png",
    "../uploads/photo.png",
    "",
    null,
  ].forEach((value) => assert.equal(resolveUploadPath(value, root), null, `путь ${value} должен быть отклонён`));
});

test("catalog PDF requires the admin token", async () => {
  const { server } = await serverWith([product({ id: "p1", title: "Товар" })]);
  try {
    const anonymous = await api(server.base, "GET", URL_PATH);
    assert.equal(anonymous.status, 401);
    assert.equal(typeof anonymous.body.error, "string");

    const forged = await api(server.base, "GET", URL_PATH, { token: "not-a-real-token" });
    assert.equal(forged.status, 401);
    assert.doesNotMatch(String(forged.headers.get("content-type")), /pdf/);
  } finally {
    await server.stop();
  }
});

test("catalog PDF is built from the database with storefront fields only", async () => {
  const products = [
    product({
      id: "p-secret-id-123",
      title: "Брендинг — Әсем Ғажайып Қызмет",
      description: "Қазақ әріптері: Ә Ғ Қ Ң Ө Ұ Ү Һ І",
      price: 50000,
      currency: "kzt",
      type: "service",
      quantity: 42,
      image: "/uploads/photo.png",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    product({
      id: "p-reels-xyz",
      title: "Reels пакет",
      price: null,
      currency: "usd",
      createdAt: "2026-02-01T00:00:00.000Z",
    }),
    product({
      id: "p-long",
      title: "Очень длинное название товара ".repeat(4).trim(),
      description: "Подробное описание услуги. ".repeat(40).trim(),
      price: 1234567.89,
      currency: "rub",
      createdAt: "2026-02-15T00:00:00.000Z",
    }),
  ];
  const { server, token } = await serverWith(products, { "photo.png": PNG_OK });
  try {
    const { res, body } = await downloadCatalog(server.base, token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="catalog-\d{4}-\d{2}-\d{2}\.pdf"$/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(body.includes("/Subtype /Image"), "фото из uploads должно попасть в PDF");

    const { text, total } = await pdfText(body);
    assert.equal(total, 2, "обложка + одна страница карточек");
    const flat = compact(text);
    assert.ok(flat.includes("Каталогтоваров"));
    assert.ok(flat.includes("Жанара"));
    assert.ok(flat.includes("3позиции"));
    assert.ok(flat.includes(compact("Брендинг — Әсем Ғажайып Қызмет")), "казахские буквы в названии");
    assert.ok(flat.includes(compact("Ә Ғ Қ Ң Ө Ұ Ү Һ І")), "казахские буквы в описании");
    assert.ok(flat.includes("50000₸"));
    assert.ok(flat.includes("1234567,89₽"));
    assert.ok(flat.includes("Ценапозапросу"));
    assert.ok(flat.includes("УСЛУГА") && flat.includes("ТОВАР"));
    assert.ok(text.includes("…"), "длинные тексты обрезаются многоточием");

    // Storefront order: newest first, the same as GET /api/products.
    const order = ["Очень", "Reels", "Брендинг"].map((word) => flat.indexOf(word));
    assert.deepEqual([...order].sort((a, b) => a - b), order);

    ["p-secret-id-123", "p-reels-xyz", "2026-01-01", "createdAt", "quantity", "42шт", "/uploads/"].forEach((leak) =>
      assert.ok(!flat.includes(leak) && !body.includes(leak), `в PDF не должно быть «${leak}»`)
    );
  } finally {
    await server.stop();
  }
});

test("broken, missing and unsafe photos become placeholders and the server keeps working", async () => {
  const brokenPng = Buffer.from(PNG_OK);
  brokenPng.fill(0xff, 41, 60);
  const hugePng = Buffer.from(PNG_OK);
  hugePng.writeUInt32BE(100000, 16);
  hugePng.writeUInt32BE(100000, 20);
  const products = [
    ["Битый PNG", "/uploads/broken.png"],
    ["Огромный PNG", "/uploads/huge.png"],
    ["Текст вместо фото", "/uploads/fake.jpg"],
    ["Нет файла", "/uploads/missing.jpg"],
    ["Обход пути", "/uploads/../secret.txt"],
    ["Абсолютный путь", "C:\\Windows\\win.ini"],
    ["Внешняя ссылка", "https://example.com/a.png"],
    ["WebP", "/uploads/photo.webp"],
    ["Без фото", ""],
  ].map(([title, image], i) => product({ id: `p${i}`, title, image, createdAt: `2026-03-0${i + 1}T00:00:00.000Z` }));
  const { server, token, uploadsDir } = await serverWith(products, {
    "broken.png": brokenPng,
    "huge.png": hugePng,
    "fake.jpg": "это не картинка",
    "photo.webp": Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"),
  });
  fs.writeFileSync(path.join(uploadsDir, "..", "secret.txt"), "SECRET-CONTENT");
  try {
    const { res, body } = await downloadCatalog(server.base, token);
    assert.equal(res.status, 200);
    assert.ok(!body.includes("/Subtype /Image"), "ни одно неподходящее фото не должно встроиться");
    const { text, total } = await pdfText(body);
    assert.equal(total, 1 + Math.ceil(products.length / 4));
    const flat = compact(text);
    products.forEach((item) => assert.ok(flat.includes(compact(item.title)), `карточка «${item.title}» на месте`));
    assert.ok(!flat.includes("SECRET-CONTENT"));

    const alive = await api(server.base, "GET", "/api/products");
    assert.equal(alive.status, 200);
    const again = await downloadCatalog(server.base, token);
    assert.equal(again.res.status, 200);
  } finally {
    await server.stop();
  }
});

test("empty catalog returns a clear JSON error instead of a PDF", async () => {
  const { server, token } = await serverWith([]);
  try {
    const res = await api(server.base, "GET", URL_PATH, { token });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Нет товаров для формирования каталога" });
  } finally {
    await server.stop();
  }
});

test("large catalog spreads over full pages without empty ones", async () => {
  const products = Array.from({ length: 9 }, (_, i) =>
    product({ id: `p${i}`, title: `Позиция номер ${i + 1}`, createdAt: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` })
  );
  const { server, token } = await serverWith(products);
  try {
    const { res, body } = await downloadCatalog(server.base, token);
    assert.equal(res.status, 200);
    const { text, total } = await pdfText(body);
    assert.equal(total, 4, "обложка + 3 страницы по 4 карточки");
    assert.ok(compact(text).includes("стр.4из4"));
    products.forEach((item) => assert.ok(compact(text).includes(compact(item.title))));
  } finally {
    await server.stop();
  }
});
