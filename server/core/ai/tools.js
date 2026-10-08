const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_TIMEOUT_MS = 5000;
const MAX_RESULT_CHARS = 4000;

function createToolRegistry({ logger }) {
  const tools = new Map();

  function register(tool) {
    if (!tool || !TOOL_NAME.test(String(tool.name || ""))) {
      throw new Error(`Некорректное имя ИИ-инструмента: "${tool?.name}"`);
    }
    if (typeof tool.handler !== "function") throw new Error(`ИИ-инструмент "${tool.name}" без handler`);
    if (tools.has(tool.name)) throw new Error(`ИИ-инструмент "${tool.name}" уже зарегистрирован`);
    tools.set(tool.name, tool);
    return () => {
      if (tools.get(tool.name) === tool) tools.delete(tool.name);
    };
  }

  function definitions() {
    return [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    }));
  }

  // Never throws: the model gets an error object back and can answer anyway.
  async function run(name, rawArgs) {
    const tool = tools.get(name);
    if (!tool) return JSON.stringify({ error: `Инструмент ${name} недоступен` });

    let args = {};
    if (rawArgs) {
      try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      } catch {
        return JSON.stringify({ error: "Аргументы не являются корректным JSON" });
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};

    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.handler(args)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("таймаут")), TOOL_TIMEOUT_MS);
        }),
      ]);
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return text.slice(0, MAX_RESULT_CHARS);
    } catch (err) {
      logger.error(`ИИ-инструмент ${name} упал:`, err?.message || err);
      return JSON.stringify({ error: "Инструмент временно недоступен" });
    } finally {
      clearTimeout(timer);
    }
  }

  return { register, definitions, run, size: () => tools.size };
}

module.exports = { createToolRegistry };
