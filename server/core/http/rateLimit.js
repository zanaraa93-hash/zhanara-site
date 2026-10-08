// Keyed by req.ip: the socket address, or the client address reported by a
// proxy listed in TRUST_PROXY (Express ignores X-Forwarded-For otherwise).
function createRateLimiter({ windowMs, max, message, logger }) {
  const hits = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.reset <= now) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      // Once per address and window: a flood of refusals for many different
      // visitors from one address is the sign of a proxy that is not trusted.
      if (entry.count === max + 1 && logger) {
        logger.warn("rate_limit превышен лимит", { ip: key, path: req.path, max, windowSec: Math.round(windowMs / 1000) });
      }
      res.set("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { createRateLimiter };
