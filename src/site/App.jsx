import { useEffect, useState } from "react";
import { useBodyScrollLock } from "../lib/useBodyScrollLock.js";
import { useCart } from "./CartContext.jsx";
import CartDrawer from "./CartDrawer.jsx";
import ChatWidget from "./ChatWidget.jsx";
import Header from "./Header.jsx";
import OrderModal from "./OrderModal.jsx";
import ProductModal from "./ProductModal.jsx";
import { About, Contact, Footer, Hero, Process, Services } from "./Sections.jsx";
import Shop from "./Shop.jsx";

function Toast() {
  const { toast } = useCart();
  return (
    <p className="cart-toast" hidden={!toast}>
      {toast}
    </p>
  );
}

export default function App() {
  const { items } = useCart();
  const [product, setProduct] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [orderBusy, setOrderBusy] = useState(false);

  useBodyScrollLock(Boolean(product) || cartOpen || orderOpen);

  // One Escape closes only the topmost layer. Capture phase keeps this ahead of
  // the chat widget's listener (the chat sits below the modals), and
  // preventDefault tells it the key is already handled. A running order
  // request keeps its dialog open, so its result cannot be missed.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (orderOpen) {
        if (!orderBusy) setOrderOpen(false);
      } else if (cartOpen) setCartOpen(false);
      else if (product) setProduct(null);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [orderOpen, orderBusy, cartOpen, product]);

  return (
    <>
      <Header onOpenCart={() => setCartOpen(true)} />
      <main>
        <Hero />
        <About />
        <Services />
        <Process />
        <Shop onOpenProduct={setProduct} />
        <Contact />
      </main>
      <Footer />

      <ProductModal product={product} onClose={() => setProduct(null)} />
      <CartDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onCheckout={() => items.length && setOrderOpen(true)}
      />
      <OrderModal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        onSubmitted={() => setCartOpen(false)}
        onBusyChange={setOrderBusy}
      />
      <Toast />
      <ChatWidget />
    </>
  );
}
