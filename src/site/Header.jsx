import { useState } from "react";
import { useCart } from "./CartContext.jsx";

const LINKS = [
  { href: "#about", label: "О себе" },
  { href: "#services", label: "Услуги" },
  { href: "#process", label: "Как работаю" },
  { href: "#shop", label: "Магазин" },
];

export default function Header({ onOpenCart }) {
  const { count } = useCart();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  return (
    <header className="header" id="top">
      <a className="logo" href="#top">
        Жанара<span>AI Creator</span>
      </a>
      <div className="header-right">
        <button
          className="cart-btn"
          type="button"
          aria-label={count ? `Корзина, ${count}` : "Корзина"}
          onClick={onOpenCart}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6h15l-1.5 9h-12z" />
            <path d="M6 6L5 3H2" />
            <circle cx="9" cy="20" r="1.4" />
            <circle cx="18" cy="20" r="1.4" />
          </svg>
          <span className="cart-count" hidden={count === 0}>
            {count}
          </span>
        </button>
        <button
          className="nav-toggle"
          type="button"
          aria-expanded={navOpen}
          aria-controls="nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span className="sr-only">Меню</span>
          <span></span>
          <span></span>
        </button>
        <nav className={navOpen ? "nav open" : "nav"} id="nav">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={closeNav}>
              {link.label}
            </a>
          ))}
          <a href="#contact" className="nav-cta" onClick={closeNav}>
            Заказать
          </a>
        </nav>
      </div>
    </header>
  );
}
