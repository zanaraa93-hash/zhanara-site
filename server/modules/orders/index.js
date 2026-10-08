const crypto = require("crypto");
const { cleanText, cleanMultiline, parseDeadline, parseReference } = require("../../core/utils/text");
const { normalizePhone, isValidPhone } = require("../../core/utils/phone");
const { orderTotals } = require("../../core/utils/money");
const {
  ORDER_STATUSES,
  canTransition,
  parseOrderChannel,
  parseRequestId,
  orderNumber,
  compareWithCatalog,
  buildOrderItems,
  dedupKey,
  orderResponse,
} = require("./model");

const STATUS_LABELS = {
  new: "заявка получена, Жанара скоро свяжется",
  in_progress: "в работе",
  done: "готово",
  cancelled: "отменена",
};

// Repeats of the same order within this window return the saved one.
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

function catalogChangedMessage({ changed, removed }) {
  const parts = [];
  if (changed.length) parts.push("Цена изменилась");
  if (removed.length) parts.push("часть позиций больше нет на витрине");
  return `${parts.join(", ")}. Корзина обновлена — проверьте сумму и отправьте заявку ещё раз.`;
}

module.exports = {
  name: "orders",
  dependsOn: ["products"],
  async setup(core) {
    const repo = core.storage.repository("orders");
    const products = core.services.require("products");

    // Older orders carry a telegramNotified flag (or nothing at all). Every
    // order gets an explicit delivery state, so an unsent one can never age
    // out of the retry queue unnoticed.
    const migrated = await repo.transaction((items, tx) => {
      let count = 0;
      for (const order of items) {
        if (!order || typeof order !== "object") continue;
        let touched = false;
        if (!order.telegramStatus) {
          if (order.telegramNotified === true) order.telegramStatus = "sent";
          else if (order.telegramNotified === false) {
            order.telegramStatus = "pending";
            order.telegramNextAttemptAt = new Date().toISOString();
          } else order.telegramStatus = "unknown";
          order.telegramAttempts = order.telegramAttempts || 0;
          touched = true;
        }
        if ("telegramNotified" in order) {
          delete order.telegramNotified;
          touched = true;
        }
        if (!Number.isInteger(order.version)) {
          order.version = 1;
          touched = true;
        }
        if (touched) count += 1;
      }
      if (!count) tx.skipWrite();
      return count;
    });
    if (migrated) core.logger.info("Заказы переведены на явный статус доставки уведомлений", { orders: migrated });

    const list = () => repo.list().filter((order) => !order.deletedAt);

    // The chat can be used by anyone, so a phone number alone is not proof of
    // ownership: the order number from the success screen is required too, and
    // only the date and status of that one order are returned.
    function statusByOrder(phone, number) {
      const key = normalizePhone(phone);
      const wanted = String(number || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
      if (!isValidPhone(key) || wanted.length !== 8) {
        return { found: false, reason: "Нужны номер телефона из заявки и номер заявки (8 символов с экрана после отправки)" };
      }
      const order = list().find(
        (item) => orderNumber(item.id) === wanted && normalizePhone(item.customerContact) === key
      );
      if (!order) return { found: false };
      return {
        found: true,
        date: String(order.createdAt || "").slice(0, 10),
        status: STATUS_LABELS[order.status] || order.status,
      };
    }

    core.services.register("orders", { list, statusByOrder });

    core.ai.tools.register({
      name: "get_order_status",
      description:
        "Статус заявки посетителя. Нужны оба значения: номер телефона из заявки и номер заявки (8 символов, показан после отправки). Возвращает только дату и статус.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Номер телефона из заявки" },
          order_number: { type: "string", description: "Номер заявки, 8 символов" },
        },
        required: ["phone", "order_number"],
      },
      handler: ({ phone, order_number: number }) => statusByOrder(phone, number),
    });

    core.http.route((router, { auth, rateLimit, asyncHandler }) => {
      const orderLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 5,
        message: "Слишком много заявок подряд. Попробуйте позже или напишите в WhatsApp.",
      });

      // Lets the browser safely retry after a lost response without creating a
      // duplicate order. Runs before the limiter: a retry of an order that is
      // already saved must not be refused as "too many orders". Short ids still
      // go through the limiter: unlimited lookups would let them be guessed.
      function replayExisting(req, res, next) {
        const requestId = parseRequestId(req.body?.requestId);
        if (requestId.length < 16) return next();
        let existing;
        try {
          existing = repo.findBy("requestId", requestId);
        } catch (err) {
          return next(err);
        }
        if (existing && !existing.deletedAt) return res.status(200).json(orderResponse(existing));
        next();
      }

      router.post(
        "/api/orders",
        replayExisting,
        orderLimiter,
        asyncHandler(async (req, res) => {
          const requestId = parseRequestId(req.body?.requestId);

          const rawItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, 40) : [];
          const catalog = products.list();
          const check = compareWithCatalog(rawItems, catalog);
          if (check.changed.length || check.removed.length) {
            return res.status(409).json({ error: catalogChangedMessage(check), code: "catalog_changed", ...check });
          }
          const items = buildOrderItems(rawItems, catalog);
          if (!items.length) {
            return res.status(400).json({
              error: "Позиции из корзины больше нет на витрине. Обновите страницу и соберите корзину заново.",
            });
          }

          const customerName = cleanText(req.body?.customerName, 80);
          if (!customerName) {
            return res.status(400).json({ error: "Укажите имя" });
          }
          if (!isValidPhone(req.body?.customerContact)) {
            return res.status(400).json({ error: "Укажите корректный номер телефона" });
          }
          const task = cleanMultiline(req.body?.task, 1000);
          const deadline = parseDeadline(req.body?.deadline);
          const referenceRaw = cleanText(req.body?.reference, 300);
          const reference = parseReference(referenceRaw);
          if (referenceRaw && !reference) {
            return res.status(400).json({ error: "Проверьте ссылку на референс — например, instagram.com/..." });
          }

          const now = new Date().toISOString();
          const order = {
            id: crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            version: 1,
            status: "new",
            channel: parseOrderChannel(req.body?.channel),
            source: "cart",
            note: "",
            customerName,
            customerContact: cleanText(req.body?.customerContact, 40),
            task,
            deadline,
            reference,
            items,
            totals: orderTotals(items),
            telegramStatus: "pending",
            telegramAttempts: 0,
            telegramLastError: "",
            telegramLastAttemptAt: null,
            telegramNextAttemptAt: now,
          };
          if (requestId) order.requestId = requestId;
          order.dedupKey = dedupKey(order);

          // Both duplicate checks run under the lock: two parallel retries must
          // not both pass and create the same order twice.
          const saved = await repo.insertIfAbsent(order, "requestId", {
            recent: { field: "dedupKey", at: "createdAt", since: new Date(Date.now() - DEDUP_WINDOW_MS).toISOString() },
          });

          if (!saved.created) {
            core.audit("order.duplicate_replayed", {
              orderId: saved.item.id,
              matchedBy: saved.reason,
              requestId: requestId || undefined,
              requestLogId: req.id,
            });
            return res.status(200).json(orderResponse(saved.item));
          }
          core.audit("order.created", {
            orderId: order.id,
            requestId: requestId || undefined,
            requestLogId: req.id,
            items: items.length,
            totals: order.totals,
          });
          // 201 means "saved". Delivery to Telegram is tracked separately on
          // the order (telegramStatus) and shown in the admin panel.
          res.status(201).json(orderResponse(order));
          core.events.emit("order.created", { order });
        })
      );

      router.get("/api/orders", auth, (req, res) => {
        const deleted = req.query.view === "deleted";
        const orders = repo
          .list()
          .filter((order) => Boolean(order.deletedAt) === deleted)
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        res.json(orders);
      });

      // Every change names the version it was based on. A second tab holding
      // an older copy gets 409 instead of silently overwriting the first save.
      function versionGuard(body, current, fail) {
        const expected = Number(body.version);
        if (!Number.isInteger(expected)) return fail(428, "Обновите список заказов и повторите действие", "version_required");
        if (expected !== (current.version || 1)) {
          return fail(409, "Заказ уже изменили в другой вкладке. Список обновлён — проверьте и повторите.", "version_conflict");
        }
        return null;
      }

      router.patch(
        "/api/orders/:id",
        auth,
        asyncHandler(async (req, res) => {
          const body = req.body || {};
          const result = await repo.update(req.params.id, (current, tx) => {
            const fail = (status, error, code) => {
              tx.skipWrite();
              return { status, body: { error, code, order: current && !current.deletedAt ? current : undefined } };
            };
            if (!current || current.deletedAt) return fail(404, "Заказ не найден");
            const conflict = versionGuard(body, current, fail);
            if (conflict) return conflict;

            const next = {};
            const previousStatus = current.status;
            if (body.status !== undefined) {
              const status = String(body.status).toLowerCase();
              if (!ORDER_STATUSES.includes(status)) return fail(400, "Неизвестный статус заказа");
              if (!canTransition(current.status, status)) {
                return fail(409, "Такой переход статуса запрещён", "invalid_transition");
              }
              next.status = status;
            }
            if (body.note !== undefined) next.note = cleanText(body.note, 1000);
            // Only contact edits touch the client card: a status change on an old order
            // must not overwrite a name the admin or a newer order has since set.
            let contactChanged = false;
            let previousContact = "";
            if (body.customerName !== undefined) {
              const name = cleanText(body.customerName, 80);
              if (!name) return fail(400, "Имя не может быть пустым");
              contactChanged ||= name !== current.customerName;
              next.customerName = name;
            }
            if (body.customerContact !== undefined) {
              const contact = cleanText(body.customerContact, 40);
              if (!isValidPhone(contact)) return fail(400, "Укажите корректный номер телефона");
              if (contact !== current.customerContact) {
                contactChanged = true;
                previousContact = current.customerContact || "";
              }
              next.customerContact = contact;
            }
            Object.assign(current, next, { updatedAt: new Date().toISOString(), version: (current.version || 1) + 1 });
            return { status: 200, body: current, contactChanged, previousContact, previousStatus };
          });

          if (result.status !== 200) return res.status(result.status).json(result.body);
          const order = result.body;
          core.audit(order.status !== result.previousStatus ? "order.status_changed" : "order.updated", {
            orderId: order.id,
            from: order.status !== result.previousStatus ? result.previousStatus : undefined,
            to: order.status !== result.previousStatus ? order.status : undefined,
            version: order.version,
            fields: Object.keys(body).filter((key) => key !== "version").join(","),
          });
          // The client card is updated before the reply, so a reload cannot
          // rebuild a second card from the new phone and leave the note behind.
          const failures = await core.events.emit("order.updated", {
            order,
            contactChanged: result.contactChanged,
            previousContact: result.previousContact,
          });
          if (failures.length) {
            return res.json({
              ...order,
              warnings: ["Заказ сохранён, но карточка клиента не обновилась. Откройте вкладку «Клиенты» — она пересоберётся."],
            });
          }
          res.json(order);
        })
      );

      // Orders are never erased: a deleted order is hidden from the list and
      // the chat, keeps its data and audit history, and can be restored.
      router.delete(
        "/api/orders/:id",
        auth,
        asyncHandler(async (req, res) => {
          const result = await repo.update(req.params.id, (current, tx) => {
            if (!current || current.deletedAt) {
              tx.skipWrite();
              return null;
            }
            current.deletedAt = new Date().toISOString();
            current.updatedAt = current.deletedAt;
            current.version = (current.version || 1) + 1;
            return current;
          });
          if (!result) return res.status(404).json({ error: "Заказ не найден" });
          core.audit("order.deleted", { orderId: result.id, status: result.status, version: result.version });
          core.events.emit("order.deleted", { order: result });
          res.json({ ok: true, order: result });
        })
      );

      router.post(
        "/api/orders/:id/restore",
        auth,
        asyncHandler(async (req, res) => {
          const result = await repo.update(req.params.id, (current, tx) => {
            if (!current || !current.deletedAt) {
              tx.skipWrite();
              return null;
            }
            delete current.deletedAt;
            current.updatedAt = new Date().toISOString();
            current.version = (current.version || 1) + 1;
            return current;
          });
          if (!result) return res.status(404).json({ error: "Удалённый заказ не найден" });
          core.audit("order.restored", { orderId: result.id, version: result.version });
          res.json(result);
        })
      );
    });
  },
};
