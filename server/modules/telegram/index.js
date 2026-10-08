const { normalizePhone, formatPhoneDisplay } = require("../../core/utils/phone");
const { formatPrice } = require("../../core/utils/money");

function orderNotificationText(order) {
  const lines = order.items.map((item, index) => `${index + 1}. ${item.title} × ${item.qty} — ${formatPrice(item)}`);
  const totals = Object.entries(order.totals || {})
    .map(([currency, amount]) => formatPrice({ price: amount, currency }))
    .join(", ");
  const phone = normalizePhone(order.customerContact);
  const parts = [
    "Новая заявка с сайта",
    "",
    `Имя: ${order.customerName}`,
    `Телефон: ${formatPhoneDisplay(order.customerContact)}`,
    phone ? `WhatsApp: https://wa.me/${phone}` : "",
    "",
    ...lines,
    `Итого: ${totals || "цена по запросу"}`,
  ];
  if (order.task) parts.push("", `Задача: ${order.task}`);
  if (order.deadline) parts.push(`Когда нужно: ${order.deadline.split("-").reverse().join(".")}`);
  if (order.reference) parts.push(`Референс: ${order.reference}`);
  return parts.filter((line, i, all) => line || all[i - 1]).join("\n").slice(0, 4000);
}

// Delays before attempts 2..11 for temporary failures (5xx, network, timeout):
// about 16 hours in total, then the notification is "dead" and waits for a person.
const BACKOFF_MS = [30, 60, 120, 300, 900, 1800, 3600, 7200, 14400, 28800].map((s) => s * 1000);
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
// An attempt still marked "sending" after this was cut off by a crash or restart.
const SENDING_STALE_MS = 2 * 60 * 1000;
// A notification waiting longer than this turns health "degraded".
const PENDING_ALERT_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_AFTER_S = 30;

class TelegramError extends Error {
  constructor(message, { kind, status = 0, retryAfterMs = 0 }) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// config: the token or chat is wrong — every message will fail the same way.
// permanent: this message can never be delivered as is.
// rate_limited: Telegram asked to wait retry_after seconds.
// temporary: worth retrying later.
function classify(status, body, headers) {
  const description = String(body?.description || "").slice(0, 200);
  const message = `${status} ${description}`.trim();
  if (status === 429) {
    const seconds = Number(body?.parameters?.retry_after) || Number(headers.get("retry-after")) || DEFAULT_RETRY_AFTER_S;
    return new TelegramError(message, { kind: "rate_limited", status, retryAfterMs: Math.max(1, seconds) * 1000 });
  }
  if (status === 401 || status === 403 || status === 404) return new TelegramError(message, { kind: "config", status });
  if (status === 400) {
    const config = /chat not found|bot was blocked|not enough rights|kicked|deactivated/i.test(description);
    return new TelegramError(message, { kind: config ? "config" : "permanent", status });
  }
  return new TelegramError(message, { kind: "temporary", status });
}

const ACTIVE_STATES = new Set(["pending", "retrying"]);

module.exports = {
  name: "telegram",
  dependsOn: ["orders"],
  optional: true,
  setup(core) {
    const { botToken, chatId, apiUrl, retryIntervalMs, timeoutMs } = core.config.telegram;
    const configured = Boolean(botToken && chatId);
    const orders = core.storage.repository("orders");
    const channel = { configError: "", pausedUntil: 0, lastError: "", lastErrorAt: null, lastSuccessAt: null };

    function summary() {
      const counts = { pending: 0, sending: 0, retrying: 0, failed: 0, dead: 0, unknown: 0, sent: 0 };
      let oldestWaitingAt = null;
      for (const order of orders.list()) {
        if (order.deletedAt) continue;
        const state = order.telegramStatus || "unknown";
        counts[state] = (counts[state] || 0) + 1;
        if (ACTIVE_STATES.has(state) || state === "sending") {
          if (!oldestWaitingAt || String(order.createdAt) < oldestWaitingAt) oldestWaitingAt = String(order.createdAt);
        }
      }
      return { counts, oldestWaitingAt };
    }

    core.health.register("telegram", ({ detailed }) => {
      const { counts, oldestWaitingAt } = summary();
      const waitingTooLong = oldestWaitingAt && Date.now() - Date.parse(oldestWaitingAt) > PENDING_ALERT_MS;
      let state = "ok";
      if (!configured) state = "not_configured";
      else if (channel.configError) state = "config_error";
      else if (Date.now() < channel.pausedUntil) state = "rate_limited";
      const degraded = state !== "ok" || counts.failed > 0 || counts.dead > 0 || waitingTooLong;
      const result = {
        status: degraded ? "degraded" : "ok",
        state,
        undelivered: counts.pending + counts.sending + counts.retrying + counts.failed + counts.dead,
        counts,
      };
      if (detailed) {
        result.lastError = channel.configError || channel.lastError || undefined;
        result.lastErrorAt = channel.lastErrorAt || undefined;
        result.lastSuccessAt = channel.lastSuccessAt || undefined;
        result.oldestWaitingAt = oldestWaitingAt || undefined;
      }
      return result;
    });

    if (!configured) {
      core.logger.warn("Telegram не настроен: заявки сохраняются со статусом уведомления «pending» и видны в админке.");
      core.http.route((router, { auth }) => {
        router.post("/api/orders/:id/notify", auth, (_req, res) => {
          res.status(503).json({ error: "Telegram не настроен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env и перезапустите сайт." });
        });
      });
      return;
    }

    async function sendText(text) {
      let res;
      try {
        res = await fetch(`${apiUrl}/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err.name === "TimeoutError" ? `нет ответа за ${Math.round(timeoutMs / 1000)} с` : err.message;
        throw new TelegramError(`сеть: ${reason}`, {
          kind: "temporary",
        });
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw classify(res.status, body, res.headers);
      // Telegram always answers JSON with ok: true on success; anything else
      // (a proxy page, an empty body) is not a confirmed delivery.
      if (!body || body.ok !== true) {
        throw new TelegramError(`${res.status} ответ без подтверждения доставки`, { kind: "temporary", status: res.status });
      }
    }

    // Moves the order into "sending" under the database lock, so the sweep, a
    // new order and a manual retry can never send the same order twice at once.
    function claim(orderId, { manual }) {
      return orders.update(orderId, (order, tx) => {
        const skip = () => {
          tx.skipWrite();
          return null;
        };
        if (!order || order.deletedAt || order.telegramStatus === "sent") return skip();
        const now = Date.now();
        const stale = order.telegramStatus === "sending" && now - Date.parse(order.telegramLastAttemptAt || 0) > SENDING_STALE_MS;
        if (order.telegramStatus === "sending" && !stale) return skip();
        if (!manual && !stale) {
          if (!ACTIVE_STATES.has(order.telegramStatus)) return skip();
          if (order.telegramNextAttemptAt && Date.parse(order.telegramNextAttemptAt) > now) return skip();
        }
        order.telegramStatus = "sending";
        order.telegramAttempts = (order.telegramAttempts || 0) + 1;
        order.telegramLastAttemptAt = new Date(now).toISOString();
        order.telegramNextAttemptAt = null;
        return { ...order };
      });
    }

    function finish(orderId, error) {
      return orders.update(orderId, (order, tx) => {
        if (!order) {
          tx.skipWrite();
          return null;
        }
        const now = Date.now();
        if (!error) {
          order.telegramStatus = "sent";
          order.telegramSentAt = new Date(now).toISOString();
          order.telegramLastError = "";
          order.telegramNextAttemptAt = null;
          return { ...order };
        }
        order.telegramLastError = error.message;
        if (error.kind === "config" || error.kind === "permanent") {
          order.telegramStatus = "failed";
          order.telegramNextAttemptAt = null;
        } else if (error.kind === "rate_limited") {
          order.telegramStatus = "retrying";
          order.telegramNextAttemptAt = new Date(now + error.retryAfterMs).toISOString();
        } else if ((order.telegramAttempts || 0) >= MAX_ATTEMPTS) {
          order.telegramStatus = "dead";
          order.telegramNextAttemptAt = null;
        } else {
          const delay = BACKOFF_MS[Math.max(0, (order.telegramAttempts || 1) - 1)] || BACKOFF_MS[BACKOFF_MS.length - 1];
          order.telegramStatus = "retrying";
          order.telegramNextAttemptAt = new Date(now + delay).toISOString();
        }
        return { ...order };
      });
    }

    const inFlight = new Set();
    // Delivered but not yet recorded (the database write failed): never resend these.
    const unrecorded = new Set();

    async function attempt(orderId, { manual = false } = {}) {
      if (!manual && (channel.configError || Date.now() < channel.pausedUntil)) return null;
      if (inFlight.has(orderId) || unrecorded.has(orderId)) return null;
      inFlight.add(orderId);
      try {
        const order = await claim(orderId, { manual });
        if (!order) return null;
        let error = null;
        try {
          await sendText(orderNotificationText(order));
        } catch (err) {
          error = err instanceof TelegramError ? err : new TelegramError(err.message, { kind: "temporary" });
        }
        const fields = { orderId, attempt: order.telegramAttempts, manual: manual || undefined };
        if (!error) {
          channel.lastSuccessAt = new Date().toISOString();
          channel.configError = "";
        } else {
          channel.lastError = error.message;
          channel.lastErrorAt = new Date().toISOString();
          if (error.kind === "config") channel.configError = error.message;
          if (error.kind === "rate_limited") channel.pausedUntil = Date.now() + error.retryAfterMs;
        }
        let final;
        try {
          final = await finish(orderId, error);
        } catch (err) {
          if (!error) unrecorded.add(orderId);
          core.logger.error("telegram.record не удалось записать результат отправки", { ...fields, error: err.message });
          return null;
        }
        if (!error) {
          core.audit("telegram.sent", fields);
        } else {
          core.logger.error("telegram.send не доставлено", {
            ...fields,
            kind: error.kind,
            status: error.status || undefined,
            error: error.message,
            next: final?.telegramStatus,
            nextAttemptAt: final?.telegramNextAttemptAt || undefined,
          });
          if (error.kind === "config") {
            core.logger.error("Telegram отклонил токен или чат — автоматические отправки остановлены до исправления .env или ручного повтора");
          }
          if (final && (final.telegramStatus === "failed" || final.telegramStatus === "dead")) {
            core.audit(`telegram.${final.telegramStatus}`, { ...fields, error: error.message });
          }
        }
        return final;
      } finally {
        inFlight.delete(orderId);
      }
    }

    async function sweep() {
      for (const orderId of [...unrecorded]) {
        try {
          await finish(orderId, null);
          unrecorded.delete(orderId);
        } catch (err) {
          core.logger.error("telegram.record повторная запись результата не удалась", { orderId, error: err.message });
        }
      }
      if (channel.configError || Date.now() < channel.pausedUntil) return;
      const now = Date.now();
      const due = orders
        .list()
        .filter((order) => {
          if (order.deletedAt) return false;
          if (order.telegramStatus === "sending") {
            return now - Date.parse(order.telegramLastAttemptAt || 0) > SENDING_STALE_MS;
          }
          if (!ACTIVE_STATES.has(order.telegramStatus)) return false;
          return !order.telegramNextAttemptAt || Date.parse(order.telegramNextAttemptAt) <= now;
        })
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      // One at a time: a rate limit or a bad token stops the rest of the batch.
      for (const order of due) {
        if (channel.configError || Date.now() < channel.pausedUntil) break;
        await attempt(order.id);
      }
    }

    let sweeping = false;
    async function runSweep() {
      if (sweeping) return;
      sweeping = true;
      try {
        await sweep();
      } finally {
        sweeping = false;
      }
    }

    // Through the event bus, so shutdown waits for an attempt in progress
    // instead of closing the database under it.
    core.events.on("order.created", ({ order }) => attempt(order.id));
    core.events.on("telegram.sweep", runSweep);
    core.events.on("storage.recovered", ({ recovery }) =>
      sendText(
        `ВНИМАНИЕ: база сайта была повреждена и восстановлена из копии от ${recovery.backupTakenAt}. ` +
          `Заявки после этого момента могли потеряться — сверьте их с перепиской и подтвердите восстановление в админке.`
      ).catch((err) => core.logger.error("Не удалось отправить в Telegram предупреждение о восстановлении базы", { error: err.message }))
    );

    core.events.emit("telegram.sweep");
    const timer = setInterval(() => core.events.emit("telegram.sweep"), retryIntervalMs);
    timer.unref();
    core.onStop(() => clearInterval(timer));

    core.http.route((router, { auth, asyncHandler }) => {
      // The manual way out of "failed", "dead" and "unknown". It also re-checks
      // a token that was rejected before, after the .env has been fixed.
      router.post(
        "/api/orders/:id/notify",
        auth,
        asyncHandler(async (req, res) => {
          const order = orders.get(req.params.id);
          if (!order || order.deletedAt) return res.status(404).json({ error: "Заказ не найден" });
          if (order.telegramStatus === "sent") return res.status(409).json({ error: "Уведомление уже доставлено", order });
          if (Date.now() < channel.pausedUntil) {
            const seconds = Math.ceil((channel.pausedUntil - Date.now()) / 1000);
            res.set("Retry-After", String(seconds));
            return res.status(429).json({ error: `Telegram просит подождать ещё ${seconds} с`, order });
          }
          const final = await attempt(order.id, { manual: true });
          core.audit("telegram.manual_retry", { orderId: order.id, result: final?.telegramStatus || "busy" });
          if (!final) return res.status(409).json({ error: "Уведомление уже отправляется. Обновите список через минуту.", order: orders.get(order.id) });
          if (final.telegramStatus === "sent") return res.json(final);
          res.status(502).json({ error: `Telegram не принял уведомление: ${final.telegramLastError}`, order: final });
        })
      );
    });
  },
  orderNotificationText,
  classify,
};
