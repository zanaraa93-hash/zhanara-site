// Answers without any external model, by the first matching rule.
// rules: [{ test(text) -> boolean, reply(text) -> string }]
function createRuleProvider({ emptyReply, rules = [], defaultReply }) {
  return {
    name: "rules",
    reply(userText) {
      const text = String(userText || "").toLowerCase();
      if (!text) return typeof emptyReply === "function" ? emptyReply() : emptyReply;
      const rule = rules.find((item) => item.test(text));
      if (rule) return rule.reply(text);
      return typeof defaultReply === "function" ? defaultReply(text) : defaultReply;
    },
  };
}

const genericFallback = createRuleProvider({
  emptyReply: "Напишите ваш вопрос.",
  defaultReply: "Сейчас не могу ответить. Попробуйте чуть позже.",
});

module.exports = { createRuleProvider, genericFallback };
