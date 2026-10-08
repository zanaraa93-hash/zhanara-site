import { useCallback, useEffect, useState } from "react";
import { formatDeadline } from "../lib/format.js";
import { jsonBody } from "./api.js";
import {
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  TELEGRAM_LABELS,
  formatAdminPrice,
  formatDate,
  formatTotals,
  shortId,
  sourceLabel,
  whatsappLink,
} from "./format.js";
import usePdfDownload from "./usePdfDownload.js";

const FILTERS = [
  { value: "all", label: "Все" },
  { value: "new", label: "Новые" },
  { value: "in_progress", label: "В работе" },
  { value: "done", label: "Готово" },
  { value: "cancelled", label: "Отмена" },
  { value: "undelivered", label: "Не в Telegram" },
  { value: "deleted", label: "Удалённые" },
];

const UNDELIVERED = new Set(["pending", "retrying", "failed", "dead", "unknown"]);

function OrderBrief({ order }) {
  const deadline = formatDeadline(order.deadline);
  const hasReference = /^https?:\/\//i.test(order.reference || "");
  if (!order.task && !deadline && !hasReference) return null;
  return (
    <div className="order-card-brief">
      {order.task && (
        <p>
          <b>Задача:</b> {order.task}
        </p>
      )}
      {deadline && (
        <p>
          <b>Когда нужно:</b> {deadline}
        </p>
      )}
      {hasReference && (
        <p>
          <b>Референс:</b>{" "}
          <a href={order.reference} target="_blank" rel="noopener noreferrer">
            {order.reference}
          </a>
        </p>
      )}
    </div>
  );
}

function TelegramState({ order, onNotify, busy }) {
  const state = order.telegramStatus || "unknown";
  const canRetry = state !== "sent" && state !== "sending";
  return (
    <div className={`order-card-telegram tg-${state}`}>
      <span>
        Telegram: <b>{TELEGRAM_LABELS[state] || state}</b>
        {order.telegramAttempts ? ` · попыток: ${order.telegramAttempts}` : ""}
        {state === "retrying" && order.telegramNextAttemptAt ? ` · следующая ${formatDate(order.telegramNextAttemptAt)}` : ""}
      </span>
      {order.telegramLastError && state !== "sent" && <small>Последняя ошибка: {order.telegramLastError}</small>}
      {canRetry && (
        <button className="crm-btn" type="button" disabled={busy} aria-busy={busy} onClick={() => onNotify(order)}>
          {busy ? "Отправляем…" : "Отправить в Telegram"}
        </button>
      )}
    </div>
  );
}

function OrderCard({ order, api, onStatus, onDelete, onRestore, onNotify, deleted }) {
  // The chosen value is shown only while the request runs; afterwards the
  // select always reflects the server copy, including after a 409 reload.
  const [pendingStatus, setPendingStatus] = useState(null);
  const status = pendingStatus ?? order.status;
  const [notifying, setNotifying] = useState(false);
  const wa = whatsappLink(order.customerContact);
  const invoice = usePdfDownload(api);
  const allowed = [order.status, ...(STATUS_TRANSITIONS[order.status] || [])];

  async function notify() {
    setNotifying(true);
    try {
      await onNotify(order);
    } finally {
      setNotifying(false);
    }
  }

  return (
    <article className="order-card">
      <div className="order-card-head">
        <p className="order-card-id">
          #{shortId(order.id)} · {sourceLabel(order)}
        </p>
        <span className={`crm-status crm-status-${order.status}`}>{STATUS_LABELS[order.status] || order.status}</span>
      </div>
      <p className="order-card-client">
        {order.customerName || "Без имени"} · {order.customerContact || "—"}
      </p>
      <time className="order-card-date">{formatDate(order.createdAt)}</time>
      {deleted && <p className="form-error">Удалён {formatDate(order.deletedAt)}</p>}
      <OrderBrief order={order} />
      <div className="order-card-items">
        {(order.items || []).map((item, index) => (
          <div className="order-line" key={`${item.id}-${index}`}>
            <span className="order-line-title">{item.title}</span>
            <span className="order-line-price">
              {item.qty} × {formatAdminPrice(item.price, item.currency)}
            </span>
          </div>
        ))}
      </div>
      <p className="order-card-total">{formatTotals(order.totals)}</p>
      {!deleted && <TelegramState order={order} onNotify={notify} busy={notifying} />}
      <div className="order-card-actions">
        {deleted ? (
          <button className="crm-btn" type="button" onClick={() => onRestore(order)}>
            Восстановить
          </button>
        ) : (
          <>
            <select
              className="order-status-select"
              aria-label="Статус заказа"
              value={status}
              disabled={pendingStatus !== null}
              onChange={async (event) => {
                setPendingStatus(event.target.value);
                try {
                  await onStatus(order, event.target.value);
                } finally {
                  setPendingStatus(null);
                }
              }}
            >
              {Object.entries(STATUS_LABELS)
                .filter(([value]) => allowed.includes(value))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
            {wa ? (
              <a className="crm-btn" href={wa} target="_blank" rel="noopener noreferrer">
                WhatsApp
              </a>
            ) : (
              <button className="crm-btn" type="button" disabled>
                WhatsApp
              </button>
            )}
            <button
              className="crm-btn"
              type="button"
              disabled={invoice.busy}
              aria-busy={invoice.busy}
              onClick={() => invoice.download(`/api/orders/${encodeURIComponent(order.id)}/invoice.pdf`, "invoice.pdf")}
            >
              {invoice.busy ? "Формируем PDF…" : "Скачать счёт-фактуру"}
            </button>
            <button className="crm-btn crm-btn-danger" type="button" onClick={() => onDelete(order)}>
              Удалить
            </button>
          </>
        )}
      </div>
      <p className="form-error" role="alert" hidden={!invoice.error}>
        {invoice.error}
      </p>
    </article>
  );
}

export default function OrdersTab({ orders, api, reloadOrders, reloadClients, reloadStatus }) {
  const [filter, setFilter] = useState("all");
  const [deletedOrders, setDeletedOrders] = useState({ state: "idle", list: [], error: "" });

  const loadDeleted = useCallback(async () => {
    setDeletedOrders((prev) => ({ ...prev, state: "loading", error: "" }));
    try {
      const list = await api("/api/orders?view=deleted");
      setDeletedOrders({ state: "ready", list, error: "" });
    } catch (err) {
      setDeletedOrders({ state: "error", list: [], error: err.message });
    }
  }, [api]);

  useEffect(() => {
    if (filter === "deleted") loadDeleted();
  }, [filter, loadDeleted]);

  const showingDeleted = filter === "deleted";
  let list = orders;
  if (showingDeleted) list = deletedOrders.list;
  else if (filter === "undelivered") list = orders.filter((order) => UNDELIVERED.has(order.telegramStatus || "unknown"));
  else if (filter !== "all") list = orders.filter((order) => order.status === filter);

  async function refresh() {
    // Both loaders report their own errors on screen instead of throwing.
    await Promise.all([reloadOrders(), reloadStatus?.()]);
  }

  async function changeStatus(order, status) {
    let saved = true;
    try {
      const result = await api(`/api/orders/${order.id}`, jsonBody("PATCH", { status, version: order.version || 1 }));
      if (result?.warnings?.length) alert(result.warnings.join("\n"));
    } catch (err) {
      saved = false;
      alert(err.message);
    }
    await refresh();
    return saved;
  }

  async function remove(order) {
    if (!confirm("Удалить этот заказ? Его можно будет восстановить во вкладке «Удалённые».")) return;
    try {
      await api(`/api/orders/${order.id}`, { method: "DELETE" });
      await Promise.all([refresh(), reloadClients()]);
    } catch (err) {
      alert(err.message);
    }
  }

  async function restore(order) {
    try {
      await api(`/api/orders/${order.id}/restore`, { method: "POST" });
      await Promise.all([loadDeleted(), refresh(), reloadClients()]);
    } catch (err) {
      alert(err.message);
    }
  }

  async function notify(order) {
    try {
      await api(`/api/orders/${order.id}/notify`, { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    await refresh();
  }

  let empty = "";
  if (showingDeleted) {
    if (deletedOrders.state === "loading") empty = "Загружаем удалённые заказы…";
    else if (deletedOrders.state === "error") empty = "";
    else empty = "Удалённых заказов нет.";
  } else if (orders.length) {
    empty = "Нет заказов с таким фильтром.";
  } else {
    empty = "Пока заказов нет. Когда клиент оформит заявку — она появится здесь.";
  }

  return (
    <div className="admin-tab-panel">
      <div className="crm-toolbar">
        <h1>Заказы</h1>
        <div className="crm-filters">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? "crm-filter is-active" : "crm-filter"}
              type="button"
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {showingDeleted && deletedOrders.state === "error" && (
        <div className="admin-load-error" role="alert">
          <p className="form-error">Не удалось загрузить удалённые заказы: {deletedOrders.error}</p>
          <button className="crm-btn" type="button" onClick={loadDeleted}>
            Повторить
          </button>
        </div>
      )}
      <div className="crm-grid">
        {list.length === 0 ? (
          empty && <p className="crm-empty">{empty}</p>
        ) : (
          list.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              api={api}
              deleted={showingDeleted}
              onStatus={changeStatus}
              onDelete={remove}
              onRestore={restore}
              onNotify={notify}
            />
          ))
        )}
      </div>
    </div>
  );
}
