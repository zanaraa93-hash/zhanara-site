import { useEffect, useRef, useState } from "react";
import { TELEGRAM, WHATSAPP } from "../lib/contacts.js";
import { formatDeadline, formatPrice, totalsByCurrency, typeLabel } from "../lib/format.js";
import { readJson, writeJson } from "../lib/storage.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";
import { useCart } from "./CartContext.jsx";

const CONTACT_KEY = "zhanara-contact";
const PENDING_KEY = "zhanara-order-pending";
const EMPTY_BRIEF = { task: "", deadline: "", reference: "" };

// crypto.randomUUID() is missing on plain-HTTP pages; getRandomValues() is not.
function makeRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function itemsKey(items) {
  return [...items]
    .map((item) => `${item.id}:${Number(item.qty) || 1}`)
    .sort()
    .join("|");
}

function submissionFingerprint(key, fields) {
  return JSON.stringify({
    items: key,
    name: fields.name,
    phone: fields.phone,
    task: fields.task,
    deadline: fields.deadline,
    reference: fields.reference,
  });
}

// The pending attempt also lives in memory: when localStorage refuses to save
// it, a retry on the same page still reuses the request id, and after a
// reload the server recognises the repeat by its content.
let memoryPending = null;

function validPending(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!/^[\w-]{8,64}$/.test(String(parsed.requestId || ""))) return null;
  if (typeof parsed.fingerprint !== "string" || typeof parsed.itemsKey !== "string") return null;
  return parsed;
}

function readPending() {
  return validPending(readJson(localStorage, PENDING_KEY, null)) || memoryPending;
}

function writePending(pending) {
  memoryPending = pending;
  return writeJson(localStorage, PENDING_KEY, pending);
}

function clearPending() {
  memoryPending = null;
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch (err) {
    console.warn("localStorage: не удалось удалить незавершённую заявку:", err?.name || err);
  }
}

const SUBMIT_TIMEOUT_MS = 20000;

function loadContact() {
  const parsed = readJson(localStorage, CONTACT_KEY, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function todayIso() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function isValidPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function orderMessage(items, name, phone, details = {}) {
  const lines = items.map((item, index) => {
    const price = formatPrice(item.price, item.currency);
    return `${index + 1}. ${item.title} × ${item.qty} — ${price} (${typeLabel(item.type).toLowerCase()})`;
  });
  const totals = Object.entries(totalsByCurrency(items));
  const totalText = totals.length
    ? totals.map(([currency, amount]) => formatPrice(amount, currency)).join(", ")
    : "цена по запросу";
  const extra = [];
  if (details.task) extra.push(`Задача: ${details.task}`);
  const deadline = formatDeadline(details.deadline);
  if (deadline) extra.push(`Когда нужно: ${deadline}`);
  if (details.reference) extra.push(`Референс: ${details.reference}`);
  const extraText = extra.length ? `\n\n${extra.join("\n")}` : "";
  return `Здравствуйте, Жанара! Хочу оформить заказ.\n\nИмя: ${name}\nТелефон: ${phone}\n\n${lines.join("\n")}\n\nИтого: ${totalText}${extraText}`;
}

function priceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The server always charges the current catalog price. A cart that sat in an
// open tab can show an older one, so the customer is asked to re-check first.
// Returns null when the catalog cannot be loaded: the server stays authoritative.
async function catalogChanges(items) {
  let list;
  try {
    const response = await fetch("/api/products", { cache: "no-store" });
    if (!response.ok) return null;
    list = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const byId = new Map(list.map((product) => [product.id, product]));
  const changed = [];
  const removed = [];
  items.forEach((item) => {
    const product = byId.get(item.id);
    if (!product) {
      removed.push(item.title);
      return;
    }
    const price = priceValue(product.price);
    const currency = product.currency || "kzt";
    if (priceValue(item.price) !== price || (item.currency || "kzt") !== currency) {
      changed.push(`${product.title} — теперь ${formatPrice(price, currency)}`);
    }
  });
  return { list, changed, removed };
}

function changesMessage({ changed, removed }) {
  const parts = [];
  if (changed.length) parts.push(`Цена изменилась: ${changed.join("; ")}.`);
  if (removed.length) parts.push(`Уже нет на витрине: ${removed.join(", ")}.`);
  parts.push("Корзина обновлена — проверьте сумму и отправьте заявку ещё раз.");
  return parts.join(" ");
}

class OrderError extends Error {
  constructor(message, code = "") {
    super(message);
    this.code = code;
  }
}

async function saveOrder(items, { name, phone, requestId, task, deadline, reference }) {
  let response;
  try {
    response = await postOrder(items, { name, phone, requestId, task, deadline, reference });
  } catch (err) {
    // The order may already be saved; the same request id makes a resend safe.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new OrderError(
      timedOut
        ? "Сервер не ответил вовремя. Заявка могла сохраниться — нажмите «Отправить заявку» ещё раз, она не задвоится."
        : "Нет связи с сервером. Проверьте интернет и нажмите «Отправить заявку» ещё раз — заявка не задвоится.",
      "network"
    );
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new OrderError(data?.error || `Не удалось отправить заявку (ошибка ${response.status})`, data?.code || "");
  }
  // A 2xx without the saved order is not a confirmation.
  if (!data || typeof data.id !== "string") {
    throw new OrderError("Сервер не подтвердил заявку. Нажмите «Отправить заявку» ещё раз — она не задвоится.", "network");
  }
  return data;
}

function postOrder(items, { name, phone, requestId, task, deadline, reference }) {
  return fetch("/api/orders", {
    method: "POST",
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      channel: "site",
      customerName: name,
      customerContact: phone,
      task,
      deadline,
      reference,
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        price: item.price,
        currency: item.currency || "kzt",
        type: item.type || "product",
        qty: item.qty,
        image: item.image || "",
      })),
    }),
  });
}

function totalsText(totals) {
  const entries = Object.entries(totals || {});
  return entries.length ? entries.map(([currency, amount]) => formatPrice(amount, currency)).join(", ") : "цена по запросу";
}

export default function OrderModal({ open, onClose, onSubmitted, onBusyChange }) {
  const { items, clear, sync, showToast } = useCart();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [brief, setBrief] = useState(EMPTY_BRIEF);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(null);
  const inFlight = useRef(false);

  // While the request is running the dialog stays open: closing it would hide
  // the result, and an error the customer never sees means a lost order.
  useEffect(() => {
    onBusyChange?.(submitting);
    if (!submitting) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [submitting, onBusyChange]);

  function requestClose() {
    if (inFlight.current) return;
    onClose();
  }
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const nameRef = useRef(null);
  const phoneRef = useRef(null);

  useDialogFocus(open, nameRef);

  useEffect(() => {
    if (!open) return;
    const pending = readPending();
    const key = itemsKey(itemsRef.current);
    if (pending && pending.itemsKey === key) {
      // After a refresh the form state is empty. Restore the attempt that may
      // already be saved so the retry sends the same request id.
      setName((prev) => prev || pending.name || "");
      setPhone((prev) => prev || pending.phone || "");
      setBrief((prev) => ({
        task: prev.task || pending.task || "",
        deadline: prev.deadline || pending.deadline || "",
        reference: prev.reference || pending.reference || "",
      }));
    } else {
      const contact = loadContact();
      setName(contact.name || "");
      setPhone(contact.phone || "");
    }
    setError("");
    return () => {
      setError("");
      setMessage("");
      setSaved(null);
    };
  }, [open]);

  const setBriefField = (field) => (event) => setBrief((prev) => ({ ...prev, [field]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    if (inFlight.current) return;

    if (!items.length) {
      setError("Корзина пуста");
      return;
    }
    const cleanName = name.trim();
    const cleanPhone = normalizePhone(phone);
    if (!cleanName) {
      setError("Укажите имя");
      nameRef.current?.focus();
      return;
    }
    if (!isValidPhone(cleanPhone)) {
      setError("Укажите корректный номер телефона");
      phoneRef.current?.focus();
      return;
    }

    const fields = {
      name: cleanName,
      phone: cleanPhone,
      task: brief.task.trim(),
      deadline: brief.deadline,
      reference: brief.reference.trim(),
    };

    const key = itemsKey(items);
    const fingerprint = submissionFingerprint(key, fields);
    const pending = readPending();
    // Same cart and same form reuse the id, including after a reload. A changed
    // form gets a new id, otherwise the server would keep the first copy and
    // drop the correction.
    const isRetry = Boolean(pending && pending.fingerprint === fingerprint);

    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      // A retry may already be saved on the server. Changing the cart now would
      // give it a new request id and create a second order instead of replaying it.
      if (!isRetry) {
        const check = await catalogChanges(items);
        if (check && (check.changed.length || check.removed.length)) {
          sync(check.list);
          setError(changesMessage(check));
          return;
        }
      }

      const requestId = isRetry ? pending.requestId : makeRequestId();
      // A refused write is survivable: the id is kept in memory for retries
      // on this page, and the server matches repeats by content within a short window.
      writePending({ requestId, fingerprint, itemsKey: key, ...fields });

      let order;
      try {
        order = await saveOrder(items, { ...fields, requestId });
      } catch (err) {
        if (err.code === "catalog_changed") {
          // Nothing was saved: the server refused to store a price the customer did not see.
          clearPending();
          const check = await catalogChanges(items);
          if (check) sync(check.list);
        }
        throw err;
      }
      clearPending();
      writeJson(localStorage, CONTACT_KEY, { name: cleanName, phone: cleanPhone });
      const confirmed = Array.isArray(order.items) && order.items.length ? order.items : items;
      setMessage(orderMessage(confirmed, cleanName, cleanPhone, order));
      setSaved({ number: order.number || "", totals: order.totals || {}, phone: cleanPhone });
      setBrief(EMPTY_BRIEF);
      clear();
      onSubmitted();
      showToast("Заявка сохранена");
    } catch (err) {
      setError(err.message || "Не удалось отправить заявку");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function copyForTelegram() {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      showToast("Текст заказа скопирован — вставьте в Telegram");
    } catch {
      showToast("Откройте Telegram и отправьте состав заказа");
    }
  }

  const success = Boolean(message);

  return (
    <div className="modal order-modal" hidden={!open}>
      <div className="modal-backdrop" onClick={requestClose}></div>
      <div className="modal-card order-modal-card" role="dialog" aria-modal="true" aria-labelledby="order-modal-title">
        <button
          className="modal-close"
          type="button"
          aria-label="Закрыть"
          onClick={requestClose}
          disabled={submitting}
          title={submitting ? "Дождитесь ответа сервера" : undefined}
        >
          ×
        </button>
        <form className="order-form" onSubmit={handleSubmit}>
          <p className="section-index">заявка</p>
          <h2 id="order-modal-title">Оформить заказ</h2>
          <div id="order-form-fields" hidden={success}>
            <p className="order-form-lead">Укажите имя и телефон — Жанара свяжется с вами.</p>
            <label className="field">
              <span>Имя</span>
              <input
                ref={nameRef}
                type="text"
                name="name"
                maxLength={80}
                autoComplete="name"
                required
                placeholder="Как к вам обращаться"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Телефон</span>
              <input
                ref={phoneRef}
                type="tel"
                name="phone"
                maxLength={40}
                autoComplete="tel"
                required
                placeholder="+7 ___ ___ __ __"
                value={phone}
                onChange={(event) => setPhone(event.target.value.replace(/[^\d+\s()-]/g, ""))}
              />
            </label>
            <label className="field">
              <span>
                Задача <em>необязательно</em>
              </span>
              <textarea
                name="task"
                rows={3}
                maxLength={1000}
                placeholder="Для кого ролик, какое настроение, куда его ставить"
                value={brief.task}
                onChange={setBriefField("task")}
              ></textarea>
            </label>
            <div className="order-form-row">
              <label className="field">
                <span>
                  Когда нужно <em>необязательно</em>
                </span>
                <input
                  type="date"
                  name="deadline"
                  min={open ? todayIso() : undefined}
                  value={brief.deadline}
                  onChange={setBriefField("deadline")}
                />
              </label>
              <label className="field">
                <span>
                  Референс <em>необязательно</em>
                </span>
                <input
                  type="text"
                  inputMode="url"
                  name="reference"
                  maxLength={300}
                  autoComplete="off"
                  placeholder="Ссылка на пример"
                  value={brief.reference}
                  onChange={setBriefField("reference")}
                />
              </label>
            </div>
            <p className="form-error" hidden={!error}>
              {error}
            </p>
            <div className="order-form-actions">
              <button className="btn btn-gold" type="submit" disabled={submitting}>
                {submitting ? "Отправляем…" : "Отправить заявку"}
              </button>
            </div>
            <p className="order-form-lead" hidden={!submitting} role="status">
              Отправляем заявку — не закрывайте окно, пока не появится ответ.
            </p>
          </div>
          <div className="order-success" hidden={!success}>
            <p className="order-success-title">Заявка сохранена</p>
            {saved && (
              <p>
                {saved.number && (
                  <>
                    Номер заявки: <b>{saved.number}</b>.{" "}
                  </>
                )}
                Итого: {totalsText(saved.totals)}.
              </p>
            )}
            <p>Жанара свяжется с вами по указанному телефону. Если хотите быстрее — напишите ей в мессенджер.</p>
            <div className="order-form-actions">
              <a
                className="btn btn-gold"
                href={`${WHATSAPP}?text=${encodeURIComponent(message)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Написать в WhatsApp
              </a>
              <a
                className="btn btn-ghost"
                href={TELEGRAM}
                target="_blank"
                rel="noopener noreferrer"
                onClick={copyForTelegram}
              >
                Написать в Telegram
              </a>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
