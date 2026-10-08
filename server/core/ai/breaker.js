// After `threshold` failures in a row the provider is skipped for `cooldownMs`,
// so visitors get the fallback at once instead of waiting for a timeout on
// every message. After the cooldown one trial request is let through.
function createCircuitBreaker({ threshold, cooldownMs, logger, now = () => Date.now() }) {
  let failures = 0;
  let openUntil = 0;
  let trialInFlight = false;

  return {
    canRequest() {
      if (failures < threshold) return true;
      if (now() < openUntil || trialInFlight) return false;
      trialInFlight = true;
      return true;
    },
    success() {
      if (failures >= threshold) logger.info("ИИ-провайдер снова отвечает.");
      failures = 0;
      openUntil = 0;
      trialInFlight = false;
    },
    failure() {
      failures += 1;
      trialInFlight = false;
      if (failures >= threshold) {
        openUntil = now() + cooldownMs;
        logger.warn(
          `ИИ-провайдер не отвечает ${failures} раз подряд — ${Math.round(cooldownMs / 1000)} с отвечает встроенный бот.`
        );
      }
    },
    // A request that finished without a verdict (e.g. empty reply) must not
    // leave the trial slot occupied forever.
    release() {
      trialInFlight = false;
    },
    state: () => ({ failures, open: failures >= threshold && now() < openUntil }),
  };
}

module.exports = { createCircuitBreaker };
