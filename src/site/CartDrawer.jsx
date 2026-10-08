import { useRef } from "react";
import { formatPrice, totalsByCurrency } from "../lib/format.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";
import { useCart } from "./CartContext.jsx";

export default function CartDrawer({ open, onClose, onCheckout }) {
  const { items, changeQty, remove } = useCart();
  const totals = Object.entries(totalsByCurrency(items));
  const closeRef = useRef(null);
  useDialogFocus(open, closeRef);

  return (
    <div className="cart-drawer" hidden={!open}>
      <div className="cart-backdrop" onClick={onClose}></div>
      <aside className="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-title">
        <div className="cart-head">
          <h2 id="cart-title">Корзина</h2>
          <button ref={closeRef} className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="cart-items">
          {items.length === 0 ? (
            <p className="cart-empty">Корзина пока пустая. Добавьте позиции с витрины.</p>
          ) : (
            items.map((item) => (
              <article className="cart-item" key={item.id}>
                <img src={item.image} alt="" />
                <div className="cart-item-body">
                  <h3>{item.title}</h3>
                  <p>{formatPrice(item.price, item.currency)}</p>
                  <div className="cart-qty">
                    <button type="button" aria-label="Меньше" onClick={() => changeQty(item.id, -1)}>
                      −
                    </button>
                    <span>{item.qty}</span>
                    <button type="button" aria-label="Больше" onClick={() => changeQty(item.id, 1)}>
                      +
                    </button>
                  </div>
                </div>
                <button className="cart-remove" type="button" aria-label="Удалить" onClick={() => remove(item.id)}>
                  ×
                </button>
              </article>
            ))
          )}
        </div>
        <div className="cart-footer">
          <div className="cart-totals">
            {items.length > 0 && (
              <>
                <strong>Итого</strong>
                <span>
                  {totals.length
                    ? totals.map(([currency, amount]) => formatPrice(amount, currency)).join(" · ")
                    : "по запросу"}
                </span>
              </>
            )}
          </div>
          <p className="cart-hint">Оставьте имя и телефон — заявка сохранится, и Жанара свяжется с вами.</p>
          <div className="cart-checkout">
            <button className="btn btn-gold" type="button" disabled={items.length === 0} onClick={onCheckout}>
              Оформить заказ
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
