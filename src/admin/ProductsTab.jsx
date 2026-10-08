import { useCallback, useState } from "react";
import { typeLabel } from "../lib/format.js";
import { formatAdminPrice } from "./format.js";
import ProductFormModal from "./ProductFormModal.jsx";
import usePdfDownload from "./usePdfDownload.js";

export default function ProductsTab({ products, api, reload }) {
  // undefined = closed, null = creating, object = editing
  const [editing, setEditing] = useState(undefined);
  const [notice, setNotice] = useState("");
  const { busy: exporting, error: exportError, download } = usePdfDownload(api);

  const closeModal = useCallback(() => setEditing(undefined), []);

  function downloadCatalog() {
    setNotice("");
    download("/api/products/catalog.pdf", "catalog.pdf");
  }

  function openModal(product) {
    setNotice("");
    setEditing(product);
  }

  async function save(formData) {
    const wasEdit = Boolean(editing);
    try {
      if (wasEdit) await api(`/api/products/${editing.id}`, { method: "PUT", body: formData });
      else await api("/api/products", { method: "POST", body: formData });
    } catch (err) {
      await reload().catch(() => {});
      throw err;
    }
    closeModal();
    setNotice(wasEdit ? "Товар обновлён" : "Товар добавлен на сайт");
    await reload();
  }

  async function remove(product) {
    if (!confirm(`Удалить «${product.title}»?`)) return;
    try {
      await api(`/api/products/${product.id}`, { method: "DELETE" });
      if (editing?.id === product.id) closeModal();
      await reload();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="admin-tab-panel">
      <p className="section-index">витрина</p>
      <div className="section-head admin-head">
        <div>
          <h1>Товары</h1>
          <p>
            {products.length
              ? `${products.length} на витрине. Правки сразу видны на сайте.`
              : "Пока нет позиций. Добавьте первый товар."}
          </p>
        </div>
        <div className="admin-item-actions">
          <button className="btn btn-gold" type="button" onClick={() => openModal(null)}>
            Добавить товар
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={downloadCatalog}
            disabled={exporting || !products.length}
            aria-busy={exporting}
            title={products.length ? undefined : "Нет товаров для формирования каталога"}
          >
            {exporting ? "Формируем PDF…" : "Скачать каталог PDF"}
          </button>
        </div>
      </div>
      <p className="form-ok" hidden={!notice}>
        {notice}
      </p>
      <p className="form-error" role="alert" hidden={!exportError}>
        {exportError}
      </p>
      <div className="admin-list">
        {products.map((product) => (
          <article className="admin-item" key={product.id}>
            <img src={product.image} alt="" />
            <div>
              <h3>{product.title}</h3>
              <p>{formatAdminPrice(product.price, product.currency)}</p>
              <p className="item-meta">
                {typeLabel(product.type)} · в позиции {Number(product.quantity) || 1} шт.
              </p>
            </div>
            <div className="admin-item-actions">
              <button className="btn btn-ghost" type="button" onClick={() => openModal(product)}>
                Изменить
              </button>
              <button className="btn btn-rose" type="button" onClick={() => remove(product)}>
                Удалить
              </button>
            </div>
          </article>
        ))}
      </div>

      {editing !== undefined && (
        <ProductFormModal key={editing?.id || "new"} product={editing} onClose={closeModal} onSave={save} />
      )}
    </div>
  );
}
