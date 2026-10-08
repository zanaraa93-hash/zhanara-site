import { useEffect, useState } from "react";
import { formatPrice, typeLabel } from "../lib/format.js";
import { useCart } from "./CartContext.jsx";

function ProductCard({ product, onOpen }) {
  const { add } = useCart();

  return (
    <article
      className="product-card"
      onClick={(event) => {
        if (event.target.closest("button")) return;
        onOpen(product);
      }}
    >
      <div className="product-photo">
        <img src={product.image} alt={product.title} />
      </div>
      <div className="product-body">
        <h3>
          <button className="product-open" type="button" aria-haspopup="dialog" onClick={() => onOpen(product)}>
            {product.title}
          </button>
        </h3>
        <span className="product-type">{typeLabel(product.type)}</span>
        <p>{product.description || "Подробности — при заказе."}</p>
        <div className="product-footer">
          <span>{formatPrice(product.price, product.currency, "Цена по запросу")}</span>
          <button className="btn btn-gold" type="button" onClick={() => add(product)}>
            В корзину
          </button>
        </div>
      </div>
    </article>
  );
}

export default function Shop({ onOpenProduct }) {
  const { sync, catalog } = useCart();
  const products = catalog || [];
  const [status, setStatus] = useState({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/products");
        if (!response.ok) throw new Error("fail");
        const list = await response.json();
        if (cancelled) return;
        sync(list);
        setStatus({ state: "ready" });
      } catch {
        if (!cancelled) setStatus({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sync]);

  const message =
    status.state === "ready" && !products.length
      ? "Витрина пока пустая. Скоро здесь появятся товары."
      : status.state === "error"
        ? "Не удалось загрузить витрину. Обновите страницу или напишите Жанаре в WhatsApp."
        : "";

  return (
    <section className="shop" id="shop">
      <p className="section-index">04 — магазин</p>
      <div className="section-head">
        <h2>Витрина</h2>
        <p>Выберите формат, добавьте в корзину и оставьте заявку — Жанара свяжется с вами сама.</p>
      </div>
      <p className={status.state === "error" ? "shop-status is-error" : "shop-status"} hidden={!message}>
        {message}
      </p>
      <div className="products">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} onOpen={onOpenProduct} />
        ))}
      </div>
    </section>
  );
}
