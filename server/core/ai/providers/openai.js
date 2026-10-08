class ProviderError extends Error {}

// Messages use the OpenAI chat format, which is the canonical format of the AI
// layer: other providers translate to and from it.
function createOpenAIProvider({ apiKey, model, baseUrl, timeoutMs, reasoningEffort, logger }) {
  async function complete({ messages, tools, timeoutMs: budgetMs }) {
    const payload = {
      model,
      max_completion_tokens: 1200,
      messages,
    };
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
    if (tools?.length) {
      payload.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, budgetMs ?? timeoutMs))),
      });
    } catch (err) {
      throw new ProviderError(`OpenAI недоступен (${err.name}): ${err.message}`);
    }

    if (!res.ok) {
      const details = await res.text().catch(() => "");
      throw new ProviderError(`OpenAI ответил ${res.status}: ${details.slice(0, 300)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new ProviderError(`OpenAI вернул ${res.status} с нечитаемым телом: ${err.message}`);
    }
    if (!Array.isArray(data?.choices) || !data.choices.length) {
      throw new ProviderError(`OpenAI вернул ${res.status} без choices`);
    }
    const choice = data.choices[0];
    const message = choice?.message || {};
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter((call) => call?.type === "function" && call.function?.name)
      .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" }));
    const text = String(message.content || "");

    if (!text.trim() && !toolCalls.length) {
      logger.error(
        `OpenAI вернул пустой ответ (finish_reason=${choice?.finish_reason}, reasoning_tokens=${data?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"})`
      );
    }

    return {
      text,
      toolCalls,
      // Echoed back verbatim so the follow-up request carries the tool_calls.
      assistantMessage: toolCalls.length
        ? { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }
        : { role: "assistant", content: text },
    };
  }

  return { name: "openai", available: Boolean(apiKey), supportsImages: true, complete };
}

module.exports = { createOpenAIProvider, ProviderError };
