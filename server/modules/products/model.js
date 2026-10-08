const { cleanText } = require("../../core/utils/text");

function parseCurrency(value) {
  const currency = String(value || "kzt").toLowerCase();
  return ["kzt", "usd", "rub"].includes(currency) ? currency : "kzt";
}

function parseType(value) {
  const type = String(value || "product").toLowerCase();
  return ["product", "service"].includes(type) ? type : "product";
}

function parseQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(9999, Math.floor(n));
}

function normalizeProduct(product) {
  return {
    ...product,
    currency: parseCurrency(product.currency),
    type: parseType(product.type),
    quantity: parseQuantity(product.quantity),
  };
}

// Returns { value } or { error } for the admin product form.
function parseProductInput(body = {}) {
  const title = cleanText(body.title, 80);
  const priceRaw = String(body.price ?? "").trim();
  const price = priceRaw === "" ? null : Number(priceRaw);
  if (!title) return { error: "Укажите название товара" };
  if (priceRaw !== "" && (!Number.isFinite(price) || price < 0)) return { error: "Цена должна быть числом" };
  return {
    value: {
      title,
      description: cleanText(body.description, 800),
      price,
      currency: parseCurrency(body.currency),
      type: parseType(body.type),
      quantity: parseQuantity(body.quantity),
    },
  };
}

module.exports = { parseCurrency, parseType, parseQuantity, normalizeProduct, parseProductInput };
