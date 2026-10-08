import { useEffect, useRef, useState } from "react";
import { useBodyScrollLock } from "../lib/useBodyScrollLock.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";

const EMPTY = {
  title: "",
  price: "",
  currency: "kzt",
  quantity: "1",
  type: "product",
  description: "",
};

function fieldsFrom(product) {
  if (!product) return EMPTY;
  return {
    title: product.title,
    price: product.price ?? "",
    currency: product.currency || "kzt",
    quantity: String(product.quantity || 1),
    type: product.type || "product",
    description: product.description || "",
  };
}

// `product` is null for a new item; the modal is mounted only while open.
export default function ProductFormModal({ product, onClose, onSave }) {
  const isEdit = Boolean(product);
  const [fields, setFields] = useState(() => fieldsFrom(product));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(product?.image || "");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const titleRef = useRef(null);
  const inFlight = useRef(false);

  useBodyScrollLock(true);
  useDialogFocus(true, titleRef);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const setField = (name) => (event) => setFields((prev) => ({ ...prev, [name]: event.target.value }));

  function pickFile(next) {
    if (!next) return;
    setFile(next);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (!dropped || !dropped.type.startsWith("image/")) return;
    // Keep the <input required> satisfied so native validation passes.
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    fileRef.current.files = transfer.files;
    pickFile(dropped);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    const formData = new FormData();
    Object.entries(fields).forEach(([name, value]) => formData.append(name, value));
    if (product?.updatedAt) formData.append("updatedAt", product.updatedAt);
    if (file) formData.append("image", file);

    inFlight.current = true;
    setSaving(true);
    try {
      await onSave(formData);
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const dropClass = ["photo-drop", preview && "has-image", dragging && "is-drag"].filter(Boolean).join(" ");

  return (
    <div className="modal admin-modal">
      <div className="modal-backdrop" onClick={onClose}></div>
      <div className="modal-card admin-modal-card" role="dialog" aria-modal="true" aria-labelledby="form-title">
        <button className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
        <form className="admin-card" onSubmit={handleSubmit}>
          <h2 id="form-title">{isEdit ? "Редактировать товар" : "Новый товар"}</h2>
          <label className="field">
            <span>Название</span>
            <input ref={titleRef} type="text" name="title" maxLength={80} required value={fields.title} onChange={setField("title")} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Цена</span>
              <input type="number" name="price" min="0" step="1" value={fields.price} onChange={setField("price")} />
            </label>
            <label className="field">
              <span>Валюта</span>
              <select name="currency" required value={fields.currency} onChange={setField("currency")}>
                <option value="kzt">Тенге (тг)</option>
                <option value="usd">Доллары ($)</option>
                <option value="rub">Рубли (₽)</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Единиц в позиции (не остаток на складе)</span>
              <input
                type="number"
                name="quantity"
                min="1"
                max="9999"
                step="1"
                required
                value={fields.quantity}
                onChange={setField("quantity")}
              />
            </label>
            <label className="field">
              <span>Тип</span>
              <select name="type" required value={fields.type} onChange={setField("type")}>
                <option value="product">Товар</option>
                <option value="service">Услуга</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Описание</span>
            <textarea
              name="description"
              rows={4}
              maxLength={800}
              value={fields.description}
              onChange={setField("description")}
            ></textarea>
          </label>
          <div className="field">
            <span>Фото</span>
            <div
              className={dropClass}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragging(false);
              }}
              onDrop={handleDrop}
            >
              <input
                ref={fileRef}
                type="file"
                name="image"
                accept="image/jpeg,image/png,image/webp,image/gif"
                required={!isEdit}
                onChange={(event) => pickFile(event.target.files[0])}
              />
              <img src={preview || undefined} alt="Превью товара" hidden={!preview} />
            </div>
          </div>
          <p className="form-error" hidden={!error}>
            {error}
          </p>
          <div className="admin-form-actions">
            <button className="btn btn-gold" type="submit" disabled={saving}>
              {isEdit ? "Сохранить" : "Добавить товар"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
