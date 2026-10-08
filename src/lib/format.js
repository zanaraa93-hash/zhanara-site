const SITE_CURRENCY = { kzt: "тг", usd: "$", rub: "руб" };

export function formatPrice(price, currency, empty = "по запросу") {
  if (price === null || price === undefined || price === "") return empty;
  const suffix = SITE_CURRENCY[currency] || "тг";
  const amount = new Intl.NumberFormat("ru-RU").format(Number(price));
  return currency === "usd" ? `${suffix}${amount}` : `${amount} ${suffix}`;
}

export function typeLabel(type) {
  return type === "service" ? "Услуга" : "Товар";
}

export function formatDeadline(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

export function totalsByCurrency(items) {
  const totals = {};
  items.forEach((item) => {
    if (item.price === null || item.price === undefined || item.price === "") return;
    const currency = item.currency || "kzt";
    totals[currency] = (totals[currency] || 0) + Number(item.price) * Number(item.qty || 1);
  });
  return totals;
}
