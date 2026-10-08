import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TELEGRAM, WHATSAPP } from "../lib/contacts.js";
import { readJson, writeJson } from "../lib/storage.js";

const MAX_FILES = 5;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
// Photos are shrunk in the browser before upload, so larger originals are fine.
const MAX_PHOTO_SIZE = 25 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1600;
const SHRINKABLE_IMAGE = /^image\/(jpeg|png|webp)$/i;
const SAFE_LINK = /^https:\/\/(?:t\.me|wa\.me|(?:www\.)?instagram\.com)(?:[/?#]|$)/i;
const TRAILING_PUNCT = /[.,!?;:)\]»"'…]+$/;
const SCROLLABLE = ".chat-messages, .chat-input, .chat-attach-list";
const SIZE_KEY = "zhanara-chat-size";
const MIN_W = 300;
const MIN_H = 320;
const FILE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,.pdf,.txt,.doc,.docx";

const GREETING = {
  id: 0,
  role: "assistant",
  text: "Здравствуйте. Подскажу по роликам и заказу. Если нужно поговорить с Жанарой лично — переведу в Telegram или WhatsApp.",
  handoff: true,
  waLink: WHATSAPP,
};

function clampSize(width, height) {
  const maxW = Math.max(MIN_W, Math.min(720, window.innerWidth - 32));
  const maxH = Math.max(MIN_H, window.innerHeight - 120);
  return {
    width: Math.round(Math.min(maxW, Math.max(MIN_W, width))),
    height: Math.round(Math.min(maxH, Math.max(MIN_H, height))),
  };
}

function loadSize() {
  const saved = readJson(localStorage, SIZE_KEY, null);
  return saved && saved.width && saved.height ? clampSize(saved.width, saved.height) : null;
}

function whatsappLink(history) {
  const notes = history
    .filter((item) => item.role === "user")
    .map((item) => item.content)
    .slice(-3)
    .join("\n");
  const text = notes ? `Здравствуйте, Жанара! Пишу с сайта.\n\n${notes}` : "Здравствуйте, Жанара! Пишу с сайта.";
  return `${WHATSAPP}?text=${encodeURIComponent(text)}`;
}

function wantsHandoff(text) {
  return /(t\.me\/|wa\.me\/|телеграм|telegram|whatsapp|ватсап|перевед|связ|жанаре)/i.test(String(text || ""));
}

// Contact lines like "Telegram: https://t.me/..." are replaced by the handoff
// buttons below the reply, otherwise the bubble shows the same links twice.
function stripContactLines(text) {
  return String(text || "")
    .replace(
      /^[ \t]*(?:telegram|whatsapp|телеграм|ватсап|вотсап)[ \t]*:?[ \t]*https:\/\/(?:t\.me|wa\.me)\/\S*[ \t]*$/gim,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Phone photos are often 3–10 MB and 4000+ px; the model does not need more
// than ~1600 px to see details, and a smaller upload is faster and cheaper.
// GIFs are left as is to keep animation; any failure falls back to the original.
async function shrinkPhoto(file) {
  if (!SHRINKABLE_IMAGE.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    // JPEG has no transparency: without a background, clear PNG areas turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

// Files are parsed on the server once; chat messages then carry only their ids.
async function uploadAttachments(files) {
  const form = new FormData();
  const prepared = await Promise.all(files.map((item) => shrinkPhoto(item.file)));
  prepared.forEach((file) => form.append("files", file, file.name));
  const res = await fetch("/api/chat/attachments", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось отправить файлы");
  return Array.isArray(data.attachments) ? data.attachments : [];
}

function isAllowedFile(file) {
  if (/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) return true;
  if (file.type === "application/pdf" || file.type === "text/plain") return true;
  if (file.type === "application/msword") return true;
  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  return /\.(jpe?g|png|webp|gif|pdf|txt|docx?)$/i.test(file.name);
}

function LinkifiedText({ text }) {
  const parts = String(text || "").split(/(https:\/\/[^\s<>"']+)/g);
  return parts.map((part, index) => {
    const tail = part.startsWith("https://") ? part.match(TRAILING_PUNCT)?.[0] || "" : "";
    const url = tail ? part.slice(0, -tail.length) : part;
    if (!SAFE_LINK.test(url)) return part;
    const host = new URL(url).hostname.replace(/^www\./, "");
    const label = host === "t.me" ? "Telegram" : host === "wa.me" ? "WhatsApp" : "Instagram";
    return (
      <span key={index}>
        <a href={url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
        {tail}
      </span>
    );
  });
}

function Bubble({ message }) {
  if (message.role === "assistant") {
    return (
      <div className="chat-bubble chat-bubble-assistant">
        <LinkifiedText text={message.text} />
        {message.handoff && (
          <div className="chat-handoff">
            <a className="chat-handoff-btn" href={TELEGRAM} target="_blank" rel="noopener noreferrer">
              Telegram
            </a>
            <a className="chat-handoff-btn" href={message.waLink} target="_blank" rel="noopener noreferrer">
              WhatsApp
            </a>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="chat-bubble chat-bubble-user">
      {message.files?.length > 0 && (
        <div className="chat-bubble-files">
          {message.files.map((item) =>
            item.url ? <img key={item.id} src={item.url} alt={item.file.name} /> : <span key={item.id}>{item.file.name}</span>
          )}
        </div>
      )}
      {message.text && <div>{message.text}</div>}
    </div>
  );
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState([]);
  const [attachError, setAttachError] = useState("");
  const [size, setSize] = useState(loadSize);
  const [resizing, setResizing] = useState(false);

  const panelRef = useRef(null);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const formRef = useRef(null);
  const history = useRef([]);
  const sending = useRef(false);
  const seq = useRef(0);

  const nextId = () => ++seq.current;

  const closeChat = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    const onKey = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeChat();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeChat]);

  useEffect(() => {
    const onResize = () => setSize((current) => current && clampSize(current.width, current.height));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // React registers wheel/touch listeners as passive, so preventDefault needs native ones.
  // Only the open panel swallows scrolling; over the toggle button the page scrolls as usual.
  useEffect(() => {
    const panel = panelRef.current;
    const onWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const scroller = event.target.closest?.(SCROLLABLE);
      if (!scroller) return;
      // Firefox reports mouse wheels in lines (deltaMode 1), not pixels.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop += event.deltaY * unit;
    };
    const onTouchMove = (event) => {
      event.stopPropagation();
      if (!event.target.closest?.(SCROLLABLE)) event.preventDefault();
    };
    panel.addEventListener("wheel", onWheel, { passive: false });
    panel.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      panel.removeEventListener("wheel", onWheel);
      panel.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  const objectUrls = useRef(new Set());
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = messagesRef.current;
      list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, typing]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 120);
    el.style.height = `${Math.max(next, 44)}px`;
    el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
  }, [input, open]);

  function startResize(axes, event) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const panel = panelRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;
    setResizing(true);

    function onMove(moveEvent) {
      if (moveEvent.pointerType === "mouse" && moveEvent.buttons === 0) return;
      const width = axes.includes("w") ? startW + (startX - moveEvent.clientX) : startW;
      const height = axes.includes("n") ? startH + (startY - moveEvent.clientY) : startH;
      setSize(clampSize(width, height));
    }

    function onUp() {
      setResizing(false);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      writeJson(localStorage, SIZE_KEY, { width: panel.offsetWidth, height: panel.offsetHeight });
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function addPendingFiles(fileList) {
    let error = "";
    const next = [...pending];
    Array.from(fileList || []).forEach((file) => {
      if (next.length >= MAX_FILES) {
        error = "Можно прикрепить не больше 5 файлов";
        return;
      }
      if (!isAllowedFile(file)) {
        error = "Можно прикрепить изображение, PDF, TXT или Word";
        return;
      }
      const isPhoto = SHRINKABLE_IMAGE.test(file.type);
      if (file.size > (isPhoto ? MAX_PHOTO_SIZE : MAX_FILE_SIZE)) {
        error = isPhoto ? "Фото больше 25 МБ" : "Файл больше 5 МБ";
        return;
      }
      const url = file.type.startsWith("image/") ? URL.createObjectURL(file) : "";
      if (url) objectUrls.current.add(url);
      next.push({ id: nextId(), file, url });
    });
    setAttachError(error);
    setPending(next);
  }

  function removePending(id) {
    const removed = pending.find((item) => item.id === id);
    if (removed?.url) {
      URL.revokeObjectURL(removed.url);
      objectUrls.current.delete(removed.url);
    }
    setPending(pending.filter((item) => item.id !== id));
  }

  function addAssistant(text) {
    const handoff = wantsHandoff(text);
    const message = {
      id: nextId(),
      role: "assistant",
      text: handoff ? stripContactLines(text) : text,
      handoff,
      waLink: whatsappLink(history.current),
    };
    setMessages((prev) => [...prev, message]);
  }

  async function send() {
    const message = input.trim();
    if ((!message && !pending.length) || sending.current) return;
    const files = pending;

    sending.current = true;
    setPending([]);
    setAttachError("");
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text: message, files }]);
    setInput("");
    setTyping(true);

    let attachmentIds = [];
    let failedNote = "";
    if (files.length) {
      try {
        const results = await uploadAttachments(files);
        attachmentIds = results.filter((item) => item.status === "ok" && item.id).map((item) => item.id);
        const failed = results.filter((item) => item.status !== "ok");
        if (failed.length) {
          failedNote = `Не удалось прочитать: ${failed.map((item) => `${item.name} (${item.error})`).join("; ")}`;
        }
      } catch (err) {
        failedNote = `Файлы не загрузились: ${err.message}`;
      }
    }
    const fileNote = files.length ? `Прикреплённые файлы: ${files.map((item) => item.file.name).join(", ")}` : "";
    history.current.push({
      role: "user",
      // Notes go first: the server keeps only the first 500 characters.
      content: [fileNote, failedNote, message].filter(Boolean).join("\n\n"),
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
    });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.current.slice(-12) }),
      });
      const data = await res.json().catch(() => ({}));
      setTyping(false);
      const reply =
        data.reply ||
        data.error ||
        "Сейчас не могу ответить. Напишите в Telegram или WhatsApp — Жанара ответит лично.";
      addAssistant(reply);
      if (res.ok && data.reply) history.current.push({ role: "assistant", content: reply });
    } catch {
      setTyping(false);
      addAssistant("Связь с сервером оборвалась. Напишите напрямую: Telegram @Zhanara84 или WhatsApp +7 775 267 08 44.");
    } finally {
      sending.current = false;
      inputRef.current?.focus();
    }
  }

  return (
    <div className={open ? "chat-widget is-open" : "chat-widget"} id="chat-widget">
      <div
        id="chat-panel"
        className={resizing ? "chat-panel is-resizing" : "chat-panel"}
        hidden={!open}
        ref={panelRef}
        style={size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined}
      >
        <div
          className="chat-resize chat-resize-n"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Изменить высоту чата"
          onPointerDown={(event) => startResize("n", event)}
        ></div>
        <div
          className="chat-resize chat-resize-w"
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину чата"
          onPointerDown={(event) => startResize("w", event)}
        ></div>
        <div
          className="chat-resize chat-resize-nw"
          role="separator"
          aria-label="Изменить ширину и высоту чата"
          onPointerDown={(event) => startResize("nw", event)}
        ></div>
        <div className="chat-head">
          <p className="chat-kicker">AI-консультант</p>
          <button className="chat-close" type="button" aria-label="Закрыть чат" onClick={closeChat}>
            ×
          </button>
        </div>
        <div className="chat-messages" ref={messagesRef}>
          {messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
          {typing && (
            <div className="chat-bubble chat-bubble-assistant chat-typing" aria-label="Консультант печатает">
              <span></span>
              <span></span>
              <span></span>
            </div>
          )}
        </div>
        <form
          className="chat-form"
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className="chat-attach-list" hidden={pending.length === 0}>
            {pending.map((item) => (
              <div className="chat-attach-chip" key={item.id}>
                {item.url && <img src={item.url} alt="" />}
                <span>{item.file.name}</span>
                <button type="button" aria-label={`Убрать ${item.file.name}`} onClick={() => removePending(item.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="chat-attach-error" hidden={!attachError}>
            {attachError}
          </p>
          <div className="chat-form-row">
            <button className="chat-attach" type="button" aria-label="Прикрепить файл" onClick={() => fileRef.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8.2 12.4V7.4a2.6 2.6 0 0 1 5.2 0v8.2a3.8 3.8 0 0 1-7.6 0V8.6" />
              </svg>
            </button>
            <input
              className="chat-file"
              type="file"
              multiple
              hidden
              accept={FILE_ACCEPT}
              ref={fileRef}
              onChange={(event) => {
                addPendingFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <label className="sr-only" htmlFor="chat-input">
              Сообщение консультанту
            </label>
            <textarea
              id="chat-input"
              className="chat-input"
              rows={1}
              maxLength={500}
              autoComplete="off"
              placeholder="Напишите вопрос…"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                formRef.current?.requestSubmit();
              }}
            ></textarea>
            <button className="chat-send" type="submit" aria-label="Отправить">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </form>
      </div>
      <button
        className="chat-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="chat-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sr-only">Открыть чат с Жанарой</span>
        <svg className="chat-icon-open" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7A2.5 2.5 0 0 1 16.5 16H12l-4.2 3.2c-.7.54-1.8.04-1.8-.83V16H7.5A2.5 2.5 0 0 1 5 13.5z" />
        </svg>
      </button>
    </div>
  );
}
