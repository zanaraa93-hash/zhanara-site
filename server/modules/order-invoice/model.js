const { orderTotals } = require("../../core/utils/money");
const { formatPhoneDisplay } = require("../../core/utils/phone");
const { currencySign, decimalsOf, formatPdfDate, formatPdfPrice, roundTo, typeLabel } = require("../../core/pdf/format");

// The same labels the admin shows in the orders list.
const STATUS_LABELS = { new: "Новый", in_progress: "В работе", done: "Готово", cancelled: "Отмена" };
// Current forms cap titles at 80 and tasks at 1000 characters; the larger
// limits only keep a hand-edited old record from overflowing a page.
const MAX_TITLE_LENGTH = 500;
const MAX_TASK_LENGTH = 3000;

const isPriced = (price) => price !== null && price !== undefined && price !== "" && Number.isFinite(Number(price));

// The admin shows orders as "#" + the first 8 characters of the id; the
// invoice uses the same number so both can be matched at a glance.
function invoiceNumber(order) {
  return String(order.id || "").replace(/-/g, "").slice(0, 8);
}

function invoiceFileName(order) {
  return `invoice-order-${invoiceNumber(order).replace(/[^a-zA-Z0-9]/g, "") || "order"}.pdf`;
}

function formatDay(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : formatPdfDate(date);
}

function formatDeadline(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

// Only what was stored with the order: no current catalog prices or titles,
// no ids, tokens, internal notes or file paths. Totals come from the
// existing orderTotals() and are checked against the stored order.totals.
function buildInvoice(order) {
  const items = (Array.isArray(order.items) ? order.items : []).filter((item) => item && typeof item === "object");
  const decimalsByCurrency = {};

  const rows = items.map((item, index) => {
    const currency = item.currency || "kzt";
    const qty = Number(item.qty || 1);
    const row = {
      n: String(index + 1),
      title: String(item.title ?? "").slice(0, MAX_TITLE_LENGTH),
      type: typeLabel(item.type),
      qty: Number.isFinite(qty) ? String(qty) : String(item.qty ?? ""),
      price: formatPdfPrice(item.price, currency, "по запросу"),
      sum: "—",
    };
    if (isPriced(item.price) && Number.isFinite(qty)) {
      const decimals = decimalsOf(item.price) + decimalsOf(qty);
      decimalsByCurrency[currency] = Math.max(decimalsByCurrency[currency] || 0, decimals);
      row.sum = formatPdfPrice(roundTo(Number(item.price) * qty, decimals), currency);
    }
    return row;
  });

  const computed = orderTotals(items);
  const stored = order.totals && typeof order.totals === "object" ? order.totals : null;
  const matches =
    stored !== null &&
    Object.keys(stored).length === Object.keys(computed).length &&
    Object.entries(computed).every(
      ([currency, amount]) => Math.abs(Number(stored[currency]) - amount) <= 1e-6 * Math.max(1, Math.abs(amount))
    );
  const source = matches ? stored : computed;

  // Each currency gets its own line: amounts in different currencies are never added up.
  const totals = Object.keys(computed).map((currency) => ({
    label: Object.keys(computed).length > 1 ? `Итого, ${currencySign(currency)}` : "Итого",
    amount: formatPdfPrice(roundTo(Number(source[currency]), decimalsByCurrency[currency] || 0), currency),
  }));

  const reference = /^https?:\/\//i.test(String(order.reference || "")) ? String(order.reference) : "";

  return {
    number: invoiceNumber(order),
    date: formatDay(order.createdAt),
    status: STATUS_LABELS[order.status] || "",
    client: {
      name: String(order.customerName || "").trim(),
      phone: order.customerContact ? formatPhoneDisplay(order.customerContact) : "",
    },
    rows,
    totals,
    hasPriceOnRequest: rows.some((row) => row.sum === "—"),
    details: {
      task: String(order.task || "").trim().slice(0, MAX_TASK_LENGTH),
      deadline: formatDeadline(order.deadline),
      reference,
    },
    // Lets the route log a stored total that no longer matches its items.
    totalsMismatch: stored !== null && !matches,
  };
}

module.exports = { buildInvoice, invoiceNumber, invoiceFileName, STATUS_LABELS };
