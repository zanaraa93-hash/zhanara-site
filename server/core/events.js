// Handlers run after the current request finishes and are isolated from each
// other: a failing subscriber is logged and never breaks the emitter or other
// subscribers.
function createEventBus({ logger }) {
  const handlers = new Map();
  const pending = new Set();

  function on(event, handler, { name = "" } = {}) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    const entry = { handler, name };
    handlers.get(event).add(entry);
    return () => handlers.get(event)?.delete(entry);
  }

  // Resolves to the list of failed handlers ({ handler, error }), never rejects:
  // a caller that waits can report a partial success instead of hiding it.
  function emit(event, payload) {
    const entries = [...(handlers.get(event) || [])];
    const runs = entries.map((entry) => {
      const run = Promise.resolve()
        .then(() => entry.handler(payload))
        .then(
          () => null,
          (err) => {
            logger.error(`Обработчик события ${event}${entry.name ? ` (${entry.name})` : ""} упал`, {
              event,
              handler: entry.name || undefined,
              error: err?.message || String(err),
            });
            return { handler: entry.name || "", error: err?.message || String(err) };
          }
        )
        .finally(() => pending.delete(run));
      pending.add(run);
      return run;
    });
    return Promise.all(runs).then((results) => results.filter(Boolean));
  }

  // Waits for in-flight handlers (e.g. Telegram notifications) before shutdown.
  async function drain(timeoutMs) {
    if (!pending.size) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // Handlers started while waiting (e.g. a periodic retry) are awaited too,
    // otherwise they could still be writing after the database is closed.
    const done = (async () => {
      while (pending.size) await Promise.all([...pending]);
      return true;
    })();
    const finished = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return finished;
  }

  return { on, emit, drain, pendingCount: () => pending.size };
}

module.exports = { createEventBus };
