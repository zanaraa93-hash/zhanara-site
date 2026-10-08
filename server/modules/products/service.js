const { formatPrice } = require("../../core/utils/money");
const { normalizeProduct } = require("./model");

const PROMPT_CATALOG_LIMIT = 30;

function createProductsService({ repo }) {
  const list = () => repo.list().map(normalizeProduct);

  const listSorted = () => list().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const catalogLine = (item) => `• ${item.title} — ${formatPrice(item)}. ${item.description || ""}`.trim();

  function catalogText({ limit = Infinity } = {}) {
    const items = list();
    if (!items.length) {
      return "Витрина пока обновляется. Ориентир по сайту: ролик для бренда, личный образ, рекламный кадр, Reels/Shorts.";
    }
    const lines = items.slice(0, limit).map(catalogLine);
    if (items.length > limit) {
      lines.push(`…и ещё ${items.length - limit}. Для остальных позиций используй инструмент search_catalog.`);
    }
    return lines.join("\n");
  }

  function search(query, max = 10) {
    const words = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 1);
    const items = list();
    const matches = words.length
      ? items.filter((item) => {
          const haystack = `${item.title} ${item.description || ""}`.toLowerCase();
          return words.some((word) => haystack.includes(word));
        })
      : items;
    return matches.slice(0, max).map((item) => ({
      title: item.title,
      price: formatPrice(item),
      type: item.type === "service" ? "услуга" : "товар",
      description: item.description || "",
    }));
  }

  return { list, listSorted, catalogText, search, promptCatalogLimit: PROMPT_CATALOG_LIMIT };
}

module.exports = { createProductsService };
