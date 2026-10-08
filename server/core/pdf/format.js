// One price and date format for every PDF. The storefront, the admin and
// Telegram each format prices differently; this file does not touch any of them.
const CURRENCY_SIGNS = { kzt: "₸", usd: "$", rub: "₽" };
const PRICE_ON_REQUEST = "Цена по запросу";

// No rounding beyond what is stored: the PDF shows the exact admin value.
const amountFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 20 });
const pluralRules = new Intl.PluralRules("ru-RU");
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

// ru-RU groups digits with U+202F; a plain no-break space keeps the amount on one line in any font.
const nbsp = (text) => text.replace(/[\u202f\u00a0]/g, "\u00a0");

const currencySign = (currency) => CURRENCY_SIGNS[currency] || CURRENCY_SIGNS.kzt;

function formatPdfPrice(price, currency, empty = PRICE_ON_REQUEST) {
  if (price === null || price === undefined || price === "") return empty;
  const amount = Number(price);
  if (!Number.isFinite(amount)) return empty;
  return `${nbsp(amountFormat.format(amount))}\u00a0${currencySign(currency)}`;
}

// Digits after the decimal point as stored, e.g. 99.5 -> 1, 1e-7 -> 7.
function decimalsOf(value) {
  const [mantissa, exponent] = String(Number(value)).toLowerCase().split("e");
  const fraction = (mantissa.split(".")[1] || "").length;
  return Math.max(0, fraction - Number(exponent || 0));
}

// Removes binary floating-point noise (0.1 * 3 = 0.30000000000000004)
// without rounding away digits that were really stored.
function roundTo(value, decimals) {
  const n = Number(value);
  // Beyond 1e15 a double has no fractional digits left to clean up.
  if (!Number.isFinite(n) || Math.abs(n) >= 1e15) return n;
  return Number(n.toFixed(Math.min(Math.max(0, decimals), 12)));
}

function typeLabel(type) {
  return type === "service" ? "Услуга" : "Товар";
}

function positionsLabel(count) {
  const forms = { one: "позиция", few: "позиции", many: "позиций", other: "позиции" };
  return `${count} ${forms[pluralRules.select(count)]}`;
}

function formatPdfDate(date) {
  return dateFormat.format(date).replace(/\s?г\.$/, "");
}

// Server-local date, the same day the admin sees in the document.
function fileDateStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  PRICE_ON_REQUEST,
  currencySign,
  formatPdfPrice,
  decimalsOf,
  roundTo,
  typeLabel,
  positionsLabel,
  formatPdfDate,
  fileDateStamp,
};
