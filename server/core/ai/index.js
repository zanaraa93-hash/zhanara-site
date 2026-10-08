const { cleanText } = require("../utils/text");
const { createToolRegistry } = require("./tools");
const { createPromptBuilder, createFacts } = require("./prompt");
const { createDailyQuota } = require("./quota");
const { createCircuitBreaker } = require("./breaker");
const { createOpenAIProvider } = require("./providers/openai");
const { genericFallback } = require("./providers/fallback");
const { pickAttachmentIds, toProviderMessages } = require("./attachments");

const HISTORY_LIMIT = 12;
const MESSAGE_CHARS = 500;
const REPLY_CHARS = 1200;

const providerFactories = {
  openai: ({ config, logger }) => createOpenAIProvider({ ...config.ai.openai, logger }),
  none: () => null,
};

function sanitizeHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-HISTORY_LIMIT)
    .map((item) => {
      const message = { role: item.role, content: cleanText(item.content, MESSAGE_CHARS) };
      const attachments = item.role === "user" ? pickAttachmentIds(item.attachments) : [];
      if (attachments.length) {
        message.attachments = attachments;
        if (!message.content) message.content = "(файл без сообщения)";
      }
      return message;
    })
    .filter((item) => item.content);
}

function cleanReply(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, REPLY_CHARS);
}

function createAI({ config, logger, files }) {
  const tools = createToolRegistry({ logger });
  const prompt = createPromptBuilder({ logger });
  const facts = createFacts({ logger });
  const takeQuota = createDailyQuota({ limit: config.ai.dailyLimit, logger });
  const breaker = createCircuitBreaker({ ...config.ai.breaker, logger });
  let fallback = genericFallback;

  const factory = providerFactories[config.ai.provider];
  if (!factory) {
    logger.warn(`AI_PROVIDER="${config.ai.provider}" не поддерживается — отвечает встроенный бот.`);
  }
  const provider = factory ? factory({ config, logger }) : null;
  if (provider && !provider.available) {
    logger.info(`ИИ-провайдер ${provider.name} не настроен (нет ключа) — отвечает встроенный бот.`);
  }

  function setFallback(next) {
    if (!next || typeof next.reply !== "function") throw new Error("Запасной провайдер должен иметь reply()");
    const previous = fallback;
    fallback = next;
    return () => {
      if (fallback === next) fallback = previous;
    };
  }

  async function runProvider(history, lastUserText) {
    const startedAt = Date.now();
    const remaining = () => config.ai.requestBudgetMs - (Date.now() - startedAt);
    const conversation = [
      { role: "system", content: prompt.build() },
      ...toProviderMessages(history, {
        resolve: (id) => files?.get(id) || null,
        supportsImages: Boolean(provider.supportsImages),
        textBudget: config.ai.attachmentTextBudget,
        maxImages: config.ai.maxImagesPerRequest,
      }),
    ];
    const toolDefs = tools.definitions();

    for (let round = 0; round <= config.ai.maxToolRounds; round += 1) {
      if (remaining() <= 0) throw new Error("ИИ не уложился в отведённое время");
      // The last round is sent without tools so the model has to answer in text.
      const offerTools = toolDefs.length && round < config.ai.maxToolRounds;
      const result = await provider.complete({
        messages: conversation,
        tools: offerTools ? toolDefs : undefined,
        timeoutMs: remaining(),
      });

      if (!offerTools || !result.toolCalls.length) return cleanReply(result.text);

      conversation.push(result.assistantMessage);
      for (const call of result.toolCalls) {
        logger.debug(`ИИ вызывает инструмент ${call.name}`);
        const output = await tools.run(call.name, call.arguments);
        conversation.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
    return "";
  }

  // Counters since start: the fallback is a deliberate product behaviour, but
  // a provider that keeps failing must be visible, not hidden behind it.
  const stats = {
    ai: 0,
    fallback: 0,
    fallbackReasons: {},
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: "",
    quotaExhausted: false,
  };

  function useFallback(text, reason) {
    stats.fallback += 1;
    stats.fallbackReasons[reason] = (stats.fallbackReasons[reason] || 0) + 1;
    return { reply: fallback.reply(text), source: "fallback", reason };
  }

  function providerFailed(message) {
    breaker.failure();
    stats.consecutiveFailures += 1;
    stats.lastFailureAt = new Date().toISOString();
    stats.lastError = String(message).slice(0, 300);
    logger.error("ai.provider ошибка, отвечает встроенный бот", { error: stats.lastError, consecutive: stats.consecutiveFailures });
  }

  // Returns { reply, source: "ai" | "fallback", reason? }.
  async function chat(messages) {
    const history = sanitizeHistory(messages);
    const lastUser = [...history].reverse().find((item) => item.role === "user");
    if (!lastUser) return useFallback("", "empty_message");

    if (!provider?.available) return useFallback(lastUser.content, "not_configured");
    if (!breaker.canRequest()) return useFallback(lastUser.content, "breaker_open");
    if (!takeQuota()) {
      breaker.release();
      stats.quotaExhausted = true;
      return useFallback(lastUser.content, "daily_limit");
    }
    stats.quotaExhausted = false;

    let reply = "";
    try {
      reply = await runProvider(history, lastUser.content);
    } catch (err) {
      providerFailed(err.message);
      return useFallback(lastUser.content, "provider_error");
    }
    if (!reply) {
      providerFailed("модель вернула пустой ответ");
      return useFallback(lastUser.content, "empty_reply");
    }
    breaker.success();
    stats.ai += 1;
    stats.consecutiveFailures = 0;
    stats.lastSuccessAt = new Date().toISOString();
    return { reply, source: "ai" };
  }

  // AI is an extra: the site works without it, so its problems make health
  // "degraded", never "down".
  function health({ detailed } = {}) {
    let state = "ok";
    if (config.ai.provider === "none") state = "disabled";
    else if (!provider?.available) state = "not_configured";
    else if (breaker.state().open) state = "breaker_open";
    else if (stats.consecutiveFailures > 0) state = "failing";
    else if (stats.quotaExhausted) state = "daily_limit";
    const result = {
      status: state === "ok" || state === "disabled" ? "ok" : "degraded",
      state,
      provider: provider?.available ? provider.name : "rules",
      answeredByAi: stats.ai,
      answeredByFallback: stats.fallback,
    };
    if (detailed) {
      result.fallbackReasons = stats.fallbackReasons;
      result.consecutiveFailures = stats.consecutiveFailures;
      result.lastSuccessAt = stats.lastSuccessAt || undefined;
      result.lastFailureAt = stats.lastFailureAt || undefined;
      result.lastError = stats.lastError || undefined;
    }
    return result;
  }

  return {
    tools,
    prompt,
    facts,
    chat,
    setFallback,
    health,
    status: () => ({
      provider: provider?.available ? provider.name : "rules",
      breaker: breaker.state(),
      tools: tools.size(),
    }),
  };
}

module.exports = { createAI, sanitizeHistory };
