// The system prompt is assembled from sections that modules contribute.
// Lower order goes first; sections with equal order keep registration order.
function createPromptBuilder({ logger }) {
  const sections = new Map();
  let counter = 0;

  function addSection(name, render, { order = 50 } = {}) {
    if (sections.has(name)) throw new Error(`Секция промпта "${name}" уже зарегистрирована`);
    if (typeof render !== "function") throw new Error(`Секция промпта "${name}": нужна функция`);
    const entry = { name, render, order, seq: counter++ };
    sections.set(name, entry);
    return () => {
      if (sections.get(name) === entry) sections.delete(name);
    };
  }

  function build() {
    return [...sections.values()]
      .sort((a, b) => a.order - b.order || a.seq - b.seq)
      .map((entry) => {
        try {
          return String(entry.render() || "").trim();
        } catch (err) {
          // One broken section must not take the whole assistant down.
          logger.error(`Секция промпта "${entry.name}" упала:`, err?.message || err);
          return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return { addSection, build, has: (name) => sections.has(name) };
}

// Named data sources (e.g. the catalog) shared by prompt sections and the
// rule-based fallback, so neither has to know which module owns the data.
function createFacts({ logger }) {
  const facts = new Map();

  return {
    set(name, fn) {
      if (facts.has(name)) throw new Error(`Источник данных "${name}" уже зарегистрирован`);
      facts.set(name, fn);
      return () => {
        if (facts.get(name) === fn) facts.delete(name);
      };
    },
    get(name, fallback = "") {
      const fn = facts.get(name);
      if (!fn) return fallback;
      try {
        return fn();
      } catch (err) {
        logger.error(`Источник данных "${name}" упал:`, err?.message || err);
        return fallback;
      }
    },
  };
}

module.exports = { createPromptBuilder, createFacts };
