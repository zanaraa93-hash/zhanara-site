function formatPrice(item) {
  if (item.price == null) return "цену уточняем лично";
  const n = Number(item.price);
  const formatted = Number.isFinite(n) ? Math.round(n).toLocaleString("ru-RU") : String(item.price);
  const suffix = item.currency === "usd" ? " $" : item.currency === "rub" ? " ₽" : " ₸";
  return `${formatted}${suffix}`;
}

function orderTotals(items) {
  const totals = {};
  items.forEach((item) => {
    if (item.price === null || item.price === undefined) return;
    const currency = item.currency || "kzt";
    totals[currency] = (totals[currency] || 0) + Number(item.price) * Number(item.qty || 1);
  });
  return totals;
}

module.exports = { formatPrice, orderTotals };
