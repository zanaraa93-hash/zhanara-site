const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir, seedData, startServer, startMock, api } = require("./helpers");

const textReply = (content) => ({ body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] } });
const toolReply = (name, args, id = "call_1") => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});

async function serverWithMock(handler, env = {}, entry) {
  const mock = await startMock(handler);
  const dataDir = tempDir("ai");
  seedData(dataDir);
  const extra = entry
    ? { NODE_OPTIONS: `--require ${path.join(__dirname, "fetch-redirect.js")}`, FETCH_REDIRECT_OPENAI: mock.url }
    : {};
  const server = await startServer({
    entry,
    cwd: entry ? path.dirname(entry) : undefined,
    env: {
      DATA_DIR: dataDir,
      UPLOADS_DIR: tempDir("up"),
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: mock.url,
      ...extra,
      ...env,
    },
  });
  return {
    mock,
    server,
    dataDir,
    chat: (content) => api(server.base, "POST", "/api/chat", { body: { messages: [{ role: "user", content }] } }),
    close: async () => {
      await server.stop();
      await mock.close();
    },
  };
}

test("plain answer goes through the provider with the same payload as before", async () => {
  const ctx = await serverWithMock(() => textReply("Ответ <b>модели</b>"));
  try {
    const res = await ctx.chat("Привет");
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, "Ответ модели");
    const sent = ctx.mock.requests[0].body;
    assert.equal(sent.model, "test-model");
    assert.equal(sent.max_completion_tokens, 1200);
    assert.equal(sent.reasoning_effort, "none");
    assert.equal(sent.messages[0].role, "system");
    assert.deepEqual(sent.messages.slice(1), [{ role: "user", content: "Привет" }]);
    assert.deepEqual(
      sent.tools.map((tool) => tool.function.name).sort(),
      ["get_order_status", "search_catalog"]
    );
  } finally {
    await ctx.close();
  }
});

const legacy = process.env.LEGACY_SERVER;
test(
  "system prompt equals the legacy one except the files paragraph, plus the tools hint",
  { skip: !legacy || !fs.existsSync(legacy) ? "LEGACY_SERVER не задан" : false },
  async () => {
    const before = await serverWithMock(() => textReply("ok"), {}, legacy);
    const after = await serverWithMock(() => textReply("ok"));
    try {
      await before.chat("Привет");
      await after.chat("Привет");
      const oldPayload = before.mock.requests[0].body;
      const newPayload = after.mock.requests[0].body;
      const { FILES_PARAGRAPH, IMAGES_PARAGRAPH } = require("../server/modules/chat/persona");
      const OLD_FILES_PARAGRAPH =
        "Если человек прикрепил файлы, ты видишь только их имена, не содержимое. Подтверди, что вложение получено, и попроси коротко написать, что с ним сделать. Чтобы Жанара открыла сам файл, предложи отправить его ей в Telegram или WhatsApp.";
      const oldPrompt = oldPayload.messages[0].content;
      assert.ok(oldPrompt.includes(OLD_FILES_PARAGRAPH));
      const expected = oldPrompt.replace(OLD_FILES_PARAGRAPH, `${FILES_PARAGRAPH}\n\n${IMAGES_PARAGRAPH}`);
      const newPrompt = newPayload.messages[0].content;
      assert.ok(
        newPrompt.startsWith(`${expected}\n\nИнструменты:\n`),
        "новый промпт = старый, где заменён только абзац про файлы, + подсказка про инструменты"
      );
      assert.deepEqual(newPayload.messages.slice(1), oldPayload.messages.slice(1));
      for (const key of ["model", "max_completion_tokens", "reasoning_effort"]) {
        assert.equal(newPayload[key], oldPayload[key], key);
      }
    } finally {
      await before.close();
      await after.close();
    }
  }
);

test("tool loop: search_catalog result is passed back to the model", async () => {
  const ctx = await serverWithMock((req, n) =>
    n === 1 ? toolReply("search_catalog", { query: "reels" }) : textReply("Reels есть, цену уточняем лично.")
  );
  try {
    const res = await ctx.chat("Есть reels?");
    assert.equal(res.body.reply, "Reels есть, цену уточняем лично.");
    assert.equal(ctx.mock.requests.length, 2);
    const second = ctx.mock.requests[1].body.messages;
    const toolMsg = second.find((m) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    const result = JSON.parse(toolMsg.content);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Reels");
    assert.equal(result.items[0].price, "цену уточняем лично");
    assert.ok(second.some((m) => m.role === "assistant" && m.tool_calls), "tool_calls должны вернуться модели");
  } finally {
    await ctx.close();
  }
});

test("get_order_status needs the phone and the order number, and never leaks names, contacts or items", async () => {
  let args = {};
  const ctx = await serverWithMock((req) =>
    req.body.messages.some((m) => m.role === "tool") ? textReply("Ответ.") : toolReply("get_order_status", args)
  );
  const toolResult = () => {
    const last = ctx.mock.requests[ctx.mock.requests.length - 1];
    return last.body.messages.find((m) => m.role === "tool").content;
  };
  try {
    const order = await api(ctx.server.base, "POST", "/api/orders", {
      body: { items: [{ id: "p-brand" }], customerName: "Секретное Имя", customerContact: "+7 777 123 45 67", task: "секрет" },
    });
    assert.equal(order.status, 201);
    assert.match(order.body.number, /^[0-9a-f]{8}$/);

    args = { phone: "8 777 123 45 67", order_number: order.body.number };
    await ctx.chat(`Какой статус моей заявки ${order.body.number}? 87771234567`);
    const result = JSON.parse(toolResult());
    assert.equal(result.found, true);
    assert.deepEqual(Object.keys(result).sort(), ["date", "found", "status"]);
    assert.ok(!/Секретное|секрет|Ролик|777/.test(toolResult()), toolResult());

    args = { phone: "8 777 123 45 67" };
    await ctx.chat("Какой статус моей заявки? 87771234567");
    assert.equal(JSON.parse(toolResult()).found, false, "по одному телефону статус не выдаётся");

    args = { phone: "8 701 000 00 00", order_number: order.body.number };
    await ctx.chat("А заявки соседа?");
    assert.equal(JSON.parse(toolResult()).found, false, "чужой телефон с верным номером — не найдено");
  } finally {
    await ctx.close();
  }
});

test("tool loop is capped: the model is forced to answer without tools", async () => {
  const ctx = await serverWithMock((req) =>
    req.body.tools ? toolReply("search_catalog", { query: "x" }) : textReply("Финальный ответ")
  );
  try {
    const res = await ctx.chat("зациклись");
    assert.equal(res.body.reply, "Финальный ответ");
    assert.equal(ctx.mock.requests.length, 4, "3 раунда с инструментами + 1 без");
    assert.equal(ctx.mock.requests[3].body.tools, undefined);
  } finally {
    await ctx.close();
  }
});

test("unknown tool and broken arguments do not crash the chat", async () => {
  const ctx = await serverWithMock((req, n) => {
    if (n === 1) return toolReply("rm_rf", {});
    if (n === 2) {
      const reply = toolReply("search_catalog", {});
      reply.body.choices[0].message.tool_calls[0].function.arguments = "{broken";
      return reply;
    }
    return textReply("Всё хорошо");
  });
  try {
    const res = await ctx.chat("тест");
    assert.equal(res.body.reply, "Всё хорошо");
    const msgs = ctx.mock.requests[2].body.messages.filter((m) => m.role === "tool");
    assert.match(msgs[0].content, /недоступен/);
    assert.match(msgs[1].content, /JSON/);
  } finally {
    await ctx.close();
  }
});

test("provider errors fall back to rules; breaker stops calling a dead provider", async () => {
  const ctx = await serverWithMock(() => ({ status: 500, body: { error: "down" } }));
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.chat("сколько стоит?");
      assert.equal(res.status, 200);
      assert.match(res.body.reply, /Ориентир по витрине/);
    }
    assert.equal(ctx.mock.requests.length, 3);
    const res = await ctx.chat("сколько стоит?");
    assert.match(res.body.reply, /Ориентир по витрине/);
    assert.equal(ctx.mock.requests.length, 3, "после 3 ошибок подряд провайдер не вызывается");
  } finally {
    await ctx.close();
  }
});

test("empty model reply falls back to rules", async () => {
  const ctx = await serverWithMock(() => textReply("   "));
  try {
    const res = await ctx.chat("привет");
    assert.match(res.body.reply, /Я AI-консультант Жанары/);
  } finally {
    await ctx.close();
  }
});

test("every reply says whether it came from the model or the fallback; failures show in health", async () => {
  const replies = [
    textReply("от модели"),
    { body: {} },
    { body: { choices: [] } },
    { status: 200, body: { choices: [{ message: { role: "assistant" } }] } },
  ];
  const ctx = await serverWithMock((_req, n) => replies[Math.min(n, replies.length) - 1]);
  try {
    const ok = await ctx.chat("a");
    assert.equal(ok.body.reply, "от модели");
    assert.equal(ok.body.source, "ai");

    const missingChoices = await ctx.chat("привет");
    assert.equal(missingChoices.status, 200);
    assert.equal(missingChoices.body.source, "fallback", "ответ без choices — это сбой, а не пустой ответ модели");
    assert.match(missingChoices.body.reply, /Я AI-консультант Жанары/);

    const health = await api(ctx.server.base, "GET", "/api/health");
    assert.equal(health.body.checks.ai.status, "degraded");
    assert.equal(health.body.checks.ai.state, "failing");
    assert.equal(health.body.checks.ai.answeredByAi, 1);
    assert.equal(health.body.checks.ai.answeredByFallback, 1);
    assert.ok(!JSON.stringify(health.body).includes("sk-test"));

    assert.equal((await ctx.chat("привет")).body.source, "fallback");
    assert.equal((await ctx.chat("привет")).body.source, "fallback");
    const open = await api(ctx.server.base, "GET", "/api/health");
    assert.equal(open.body.checks.ai.state, "breaker_open");
  } finally {
    await ctx.close();
  }
});

test("provider 400, 429 and timeout all end in a marked fallback, never an empty or fake answer", async () => {
  for (const [label, reply, env] of [
    ["400", () => ({ status: 400, body: { error: { message: "bad request" } } }), {}],
    ["429", () => ({ status: 429, body: { error: { message: "rate limit" } } }), {}],
    ["timeout", () => new Promise((resolve) => setTimeout(() => resolve(textReply("поздно")), 3000)), { OPENAI_TIMEOUT_MS: "1000" }],
  ]) {
    const ctx = await serverWithMock(reply, env);
    try {
      const started = Date.now();
      const res = await ctx.chat("привет");
      assert.equal(res.status, 200, label);
      assert.equal(res.body.source, "fallback", label);
      assert.match(res.body.reply, /Я AI-консультант Жанары/, label);
      if (label === "timeout") assert.ok(Date.now() - started < 2900, "клиент не ждёт зависшего провайдера");
      const health = await api(ctx.server.base, "GET", "/api/health");
      assert.equal(health.body.checks.ai.state, "failing", label);
    } finally {
      await ctx.close();
    }
  }
});

test("daily quota switches to rules without calling the provider", async () => {
  const ctx = await serverWithMock(() => textReply("от модели"), { CHAT_DAILY_LIMIT: "2" });
  try {
    assert.equal((await ctx.chat("a")).body.reply, "от модели");
    assert.equal((await ctx.chat("b")).body.reply, "от модели");
    assert.match((await ctx.chat("привет")).body.reply, /Я AI-консультант Жанары/);
    assert.equal(ctx.mock.requests.length, 2);
  } finally {
    await ctx.close();
  }
});

test("AI_PROVIDER=none answers with rules only", async () => {
  const ctx = await serverWithMock(() => textReply("не должен"), { AI_PROVIDER: "none" });
  try {
    assert.match((await ctx.chat("привет")).body.reply, /Я AI-консультант Жанары/);
    assert.equal(ctx.mock.requests.length, 0);
  } finally {
    await ctx.close();
  }
});
