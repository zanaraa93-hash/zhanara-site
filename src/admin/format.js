export const STATUS_LABELS = {
  new: "Новый",
  in_progress: "В работе",
  done: "Готово",
  cancelled: "Отмена",
};

// Mirrors STATUS_TRANSITIONS on the server, which has the final say.
export const STATUS_TRANSITIONS = {
  new: ["in_progress", "done", "cancelled"],
  in_progress: ["new", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["new"],
};

export const TELEGRAM_LABELS = {
  pending: "ожидает отправки",
  sending: "отправляется",
  retrying: "повтор запланирован",
  sent: "доставлено",
  failed: "ошибка — нужна проверка",
  dead: "не доставлено после всех попыток",
  unknown: "не отслеживалось (старый заказ)",
};

export function formatAdminPrice(price, currency) {
  if (price === null || price === undefined || price === "") return "по запросу";
  const amount = new Intl.NumberFormat("ru-RU").format(Number(price));
  if (currency === "usd") return `$${amount}`;
  if (currency === "rub") return `${amount} ₽`;
  return `${amount} ₸`;
}

export function formatTotals(totals) {
  if (!totals || !Object.keys(totals).length) return "по запросу";
  return Object.entries(totals)
    .map(([currency, amount]) => formatAdminPrice(amount, currency))
    .join(" · ");
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8);
}

export function sourceLabel(order) {
  if (order.source === "cart" || order.channel === "site") return "корзина";
  if (order.channel === "whatsapp") return "WhatsApp";
  if (order.channel === "telegram") return "Telegram";
  return "заказ";
}

export function whatsappLink(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return `https://wa.me/${digits}`;
}
