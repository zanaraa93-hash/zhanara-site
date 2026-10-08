const crypto = require("crypto");
const { normalizeProduct } = require("../products/model");
const { normalizePhone } = require("../../core/utils/phone");

const ORDER_STATUSES = ["new", "in_progress", "done", "cancelled"];
const ORDER_CHANNELS = ["whatsapp", "telegram", "site"];

// A finished order can only be reopened for corrections, a cancelled one only
// brought back as new. "cancelled → done" or "done → new" would rewrite history.
const STATUS_TRANSITIONS = {
  new: ["in_progress", "done", "cancelled"],
  in_progress: ["new", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["new"],
};

// pending   — saved, not sent yet (also while Telegram is not configured)
// sending   — an attempt is in progress
// retrying  — a temporary failure, the next attempt is scheduled
// sent      — Telegram accepted the message
// failed    — a permanent error (bad token, chat not found); needs a person
// dead      — temporary errors did not stop after every scheduled attempt
// unknown   — orders saved before delivery was tracked
const TELEGRAM_STATES = ["pending", "sending", "retrying", "sent", "failed", "dead", "unknown"];

function canTransition(from, to) {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

function parseOrderChannel(value) {
  const channel = String(value || "site").toLowerCase();
  return ORDER_CHANNELS.includes(channel) ? channel : "site";
}

function parseRequestId(value) {
  return /^[\w-]{8,64}$/.test(String(value || "")) ? String(value) : "";
}

// The number the customer sees on the success screen and can quote later.
function orderNumber(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8).toLowerCase();
}

function priceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The customer must agree to the price that will be stored. Items sent with a
// price that no longer matches the catalog, or that left the catalog, stop the
// order instead of being silently repriced or dropped.
function compareWithCatalog(rawItems, products) {
  const byId = new Map(products.map((product) => [product.id, normalizeProduct(product)]));
  const changed = [];
  const removed = [];
  rawItems.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const product = byId.get(String(item.id || ""));
    if (!product) {
      removed.push(String(item.title || item.id || "").slice(0, 80));
      return;
    }
    if (!("price" in item)) return;
    const expected = priceValue(item.price);
    const actual = priceValue(product.price);
    const currency = String(item.currency || "kzt").toLowerCase();
    if (expected !== actual || currency !== product.currency) {
      changed.push({ id: product.id, title: product.title, price: actual, currency: product.currency });
    }
  });
  return { changed, removed };
}

function buildOrderItems(rawItems, products) {
  const byId = new Map(products.map((product) => [product.id, normalizeProduct(product)]));
  const merged = new Map();
  rawItems.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const product = byId.get(String(item.id || ""));
    if (!product) return;
    const qty = Math.min(99, Math.max(1, Math.floor(Number(item.qty) || 1)));
    const existing = merged.get(product.id);
    if (existing) {
      existing.qty = Math.min(99, existing.qty + qty);
      return;
    }
    merged.set(product.id, {
      id: product.id,
      title: product.title,
      price: priceValue(product.price),
      currency: product.currency,
      type: product.type,
      qty,
      image: product.image || "",
    });
  });
  return [...merged.values()];
}

// Same phone, same items and same brief: a double click, a browser retry or
// a resend after a lost response, even when the request id was lost too.
function dedupKey(order) {
  const items = order.items
    .map((item) => `${item.id}:${item.qty}`)
    .sort()
    .join("|");
  const source = [normalizePhone(order.customerContact), items, order.task, order.deadline, order.reference].join("\n");
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function orderResponse(order) {
  return {
    id: order.id,
    number: orderNumber(order.id),
    createdAt: order.createdAt,
    items: order.items,
    totals: order.totals,
    task: order.task || "",
    deadline: order.deadline || "",
    reference: order.reference || "",
  };
}

module.exports = {
  ORDER_STATUSES,
  ORDER_CHANNELS,
  STATUS_TRANSITIONS,
  TELEGRAM_STATES,
  canTransition,
  parseOrderChannel,
  parseRequestId,
  orderNumber,
  compareWithCatalog,
  buildOrderItems,
  dedupKey,
  orderResponse,
};
