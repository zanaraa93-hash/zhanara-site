import { useRef } from "react";
import { formatPrice, typeLabel } from "../lib/format.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";
import { useCart } from "./CartContext.jsx";

export default function ProductModal({ product, onClose }) {
  const { add } = useCart();
  const closeRef = useRef(null);
  useDialogFocus(Boolean(product), closeRef);

  return (
    <div className="modal" hidden={!product}>
      <div className="modal-backdrop" onClick={onClose}></div>
      <article className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button ref={closeRef} className="modal-close" type="button" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
        {product && (
          <>
            <img src={product.image} alt={product.title} />
            <div className="modal-body">
              <h3 id="modal-title">{product.title}</h3>
              <p className="modal-price">
                {typeLabel(product.type)} · {formatPrice(product.price, product.currency, "Цена по запросу")}
              </p>
              <p>{product.description || "Напишите, и я расскажу детали и сроки."}</p>
              <div className="modal-actions">
                <button
                  className="btn btn-gold"
                  type="button"
                  onClick={() => {
                    add(product);
                    onClose();
                  }}
                >
                  В корзину
                </button>
              </div>
            </div>
          </>
        )}
      </article>
    </div>
  );
}
