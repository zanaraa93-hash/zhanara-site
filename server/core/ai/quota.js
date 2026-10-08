function createDailyQuota({ limit, logger, now = () => new Date() }) {
  let day = "";
  let used = 0;

  return function take() {
    const today = now().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= limit) {
      if (used === limit) {
        logger.warn(`Дневной лимит ИИ-ответов (${limit}) исчерпан — до конца суток отвечает встроенный бот.`);
        used += 1;
      }
      return false;
    }
    used += 1;
    return true;
  };
}

module.exports = { createDailyQuota };
