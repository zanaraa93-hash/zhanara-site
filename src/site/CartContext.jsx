import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { readJson, writeJson } from "../lib/storage.js";

const CART_KEY = "zhanara-cart";
const CART_LOCK_KEY = "zhanara-cart-lock";

const CartContext = createContext(null);

function clampQty(value) {
  return Math.max(1, Math.min(99, Math.floor(Number(value)) || 1));
}

function sameItems(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// localStorage is user-editable and may hold data from older site versions.
// A bare array is the previous format; newer carts carry a revision so one tab
// cannot write its stale copy over a change another tab already saved.
function normalizeItems(parsed) {
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  return parsed
    .filter((item) => item && typeof item === "object" && typeof item.id === "string" && item.id)
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .map((item) => {
      const price = item.price === null || item.price === "" ? null : Number(item.price);
      return {
        id: item.id,
        title: String(item.title || ""),
        price: Number.isFinite(price) && price >= 0 ? price : null,
        currency: typeof item.currency === "string" ? item.currency : "kzt",
        type: item.type === "service" ? "service" : "product",
        image: typeof item.image === "string" ? item.image : "",
        qty: clampQty(item.qty),
      };
    });
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Quota or private mode: the cart write below reports its own failure by no-op.
  }
}

// Two tabs can read the same cart and both save. The lock makes the second
// tab wait and then apply its change on top of the first save.
function withCartLock(fn) {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  let held = false;
  try {
    while (Date.now() - started < 200) {
      const current = storageGet(CART_LOCK_KEY);
      const stamp = Number(String(current || "").split("|")[1]);
      const stale = !current || !Number.isFinite(stamp) || Date.now() - stamp > 2000;
      if (!stale) continue;
      if (!storageSet(CART_LOCK_KEY, `${token}|${Date.now()}`)) break;
      const seen = storageGet(CART_LOCK_KEY);
      if (seen && seen.startsWith(`${token}|`)) {
        held = true;
        return fn();
      }
    }
    return fn();
  } finally {
    if (held) {
      const seen = storageGet(CART_LOCK_KEY);
      if (seen && seen.startsWith(`${token}|`)) storageRemove(CART_LOCK_KEY);
    }
  }
}

function loadState() {
  const parsed = readJson(localStorage, CART_KEY, []);
  if (Array.isArray(parsed)) return { rev: 0, items: normalizeItems(parsed) };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
    const rev = Number(parsed.rev);
    return { rev: Number.isFinite(rev) && rev > 0 ? rev : 0, items: normalizeItems(parsed.items) };
  }
  return { rev: 0, items: [] };
}

export function CartProvider({ children }) {
  const revRef = useRef(0);
  const itemsRef = useRef([]);
  const [items, setItems] = useState(() => {
    const loaded = loadState();
    revRef.current = loaded.rev;
    itemsRef.current = loaded.items;
    return loaded.items;
  });
  itemsRef.current = items;
  // The latest catalog seen by this tab. The shop renders it, so prices on the
  // cards change together with the cart when checkout finds a newer catalog.
  const [catalog, setCatalog] = useState(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);

  useEffect(() => {
    withCartLock(() => {
      const stored = loadState();
      if (stored.rev > revRef.current) {
        revRef.current = stored.rev;
        itemsRef.current = stored.items;
        if (!sameItems(stored.items, items)) setItems(stored.items);
        return;
      }
      if (sameItems(stored.items, items)) return;
      const nextRev = Math.max(revRef.current, stored.rev) + 1;
      revRef.current = nextRev;
      itemsRef.current = items;
      writeJson(localStorage, CART_KEY, { rev: nextRev, items });
    });
  }, [items]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== CART_KEY) return;
      const stored = loadState();
      if (stored.rev <= revRef.current) return;
      revRef.current = stored.rev;
      itemsRef.current = stored.items;
      setItems((prev) => (sameItems(prev, stored.items) ? prev : stored.items));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = useCallback((text, duration = 1800) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), duration);
  }, []);

  // Start from the newest cart another tab may have written, then apply our change.
  const change = useCallback((recipe) => {
    let nextItems = null;
    withCartLock(() => {
      const stored = loadState();
      const base = stored.rev > revRef.current ? stored.items : itemsRef.current;
      if (stored.rev > revRef.current) revRef.current = stored.rev;
      const next = recipe(base);
      if (sameItems(next, base)) {
        nextItems = base;
        return;
      }
      const nextRev = Math.max(revRef.current, stored.rev) + 1;
      revRef.current = nextRev;
      itemsRef.current = next;
      writeJson(localStorage, CART_KEY, { rev: nextRev, items: next });
      nextItems = next;
    });
    if (nextItems) setItems((prev) => (sameItems(prev, nextItems) ? prev : nextItems));
  }, []);

  const add = useCallback(
    (product) => {
      change((prev) => {
        if (prev.some((item) => item.id === product.id)) {
          return prev.map((item) =>
            item.id === product.id ? { ...item, qty: clampQty(Number(item.qty) + 1) } : item
          );
        }
        return [
          ...prev,
          {
            id: product.id,
            title: product.title,
            price: product.price,
            currency: product.currency || "kzt",
            type: product.type || "product",
            image: product.image,
            qty: 1,
          },
        ];
      });
      showToast("Добавлено в корзину");
    },
    [change, showToast]
  );

  const changeQty = useCallback(
    (id, delta) => {
      change((prev) =>
        prev.map((item) => (item.id === id ? { ...item, qty: clampQty(Number(item.qty) + delta) } : item))
      );
    },
    [change]
  );

  const remove = useCallback(
    (id) => {
      change((prev) => prev.filter((item) => item.id !== id));
    },
    [change]
  );

  const clear = useCallback(() => change(() => []), [change]);

  // Drops items that left the catalog and refreshes price/title of the rest.
  const sync = useCallback(
    (products) => {
      setCatalog(Array.isArray(products) ? products : []);
      const byId = new Map((products || []).map((product) => [product.id, product]));
      change((prev) =>
        prev
          .filter((item) => byId.has(item.id))
          .map((item) => {
            const product = byId.get(item.id);
            return {
              ...item,
              title: product.title,
              price: product.price,
              currency: product.currency || "kzt",
              type: product.type || "product",
              image: product.image,
            };
          })
      );
    },
    [change]
  );

  const count = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);

  const value = useMemo(
    () => ({ items, count, add, changeQty, remove, clear, sync, catalog, toast, showToast }),
    [items, count, add, changeQty, remove, clear, sync, catalog, toast, showToast]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
