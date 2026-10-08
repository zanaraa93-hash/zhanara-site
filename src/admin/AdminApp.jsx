import { useCallback, useEffect, useState } from "react";
import { getToken, jsonBody, request, setToken } from "./api.js";
import ClientsTab from "./ClientsTab.jsx";
import LoginScreen from "./LoginScreen.jsx";
import OrdersTab from "./OrdersTab.jsx";
import ProductsTab from "./ProductsTab.jsx";

const TABS = [
  { id: "products", label: "Товары" },
  { id: "orders", label: "Заказы" },
  { id: "clients", label: "Клиенты" },
];

const TELEGRAM_STATE_TEXT = {
  not_configured: "Telegram не настроен — новые заявки не приходят в Telegram, проверяйте вкладку «Заказы».",
  config_error: "Telegram отклоняет токен или чат — уведомления не доставляются. Исправьте .env и нажмите «Отправить в Telegram» у заказа.",
  rate_limited: "Telegram временно ограничил отправку — уведомления уйдут автоматически позже.",
};

const AI_STATE_TEXT = {
  not_configured: "ИИ-консультант не настроен — в чате отвечает встроенный бот.",
  breaker_open: "ИИ-провайдер не отвечает — в чате временно отвечает встроенный бот.",
  failing: "Последний запрос к ИИ завершился ошибкой — посетитель получил ответ встроенного бота.",
  daily_limit: "Дневной лимит ответов ИИ исчерпан — до конца суток отвечает встроенный бот.",
};

// Problems the admin must see without opening the server logs.
function SystemBanner({ status, error, onAcknowledge, onRetry }) {
  if (error) {
    return (
      <div className="admin-load-error" role="alert">
        <p className="form-error">Не удалось проверить состояние системы: {error}</p>
        <button className="crm-btn" type="button" onClick={onRetry}>
          Повторить
        </button>
      </div>
    );
  }
  if (!status || status.status === "ok") return null;
  const { telegram, ai, backup } = status.checks || {};
  const lines = [];
  if (backup?.recovery) {
    lines.push(
      `База была восстановлена из копии от ${new Date(backup.recovery.backupTakenAt).toLocaleString("ru-RU")}. Заявки после этого момента могли потеряться — сверьте их с перепиской.`
    );
  } else if (backup?.status === "degraded") {
    lines.push(`Запасная копия базы не сохраняется${backup.lastBackupError ? `: ${backup.lastBackupError}` : ""}.`);
  }
  if (telegram) {
    if (TELEGRAM_STATE_TEXT[telegram.state]) lines.push(TELEGRAM_STATE_TEXT[telegram.state]);
    if (telegram.undelivered) lines.push(`Заявок без уведомления в Telegram: ${telegram.undelivered} (фильтр «Не в Telegram»).`);
  }
  if (ai && AI_STATE_TEXT[ai.state]) lines.push(AI_STATE_TEXT[ai.state]);
  if (status.modules?.failed?.length) lines.push(`Не запустились модули: ${status.modules.failed.join(", ")}.`);
  if (!lines.length) return null;
  return (
    <div className="admin-load-error" role="alert">
      {lines.map((line) => (
        <p className="form-error" key={line}>
          {line}
        </p>
      ))}
      {backup?.recovery && (
        <button className="crm-btn" type="button" onClick={onAcknowledge}>
          Данные проверены — убрать предупреждение
        </button>
      )}
    </div>
  );
}

export default function AdminApp() {
  // null while the stored token is being verified
  const [authed, setAuthed] = useState(() => (getToken() ? null : false));
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const [tab, setTab] = useState("products");
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [clients, setClients] = useState([]);
  // Per-section load errors: an empty list must never be shown in place of
  // data that simply failed to load, or it looks like everything was deleted.
  const [errors, setErrors] = useState({});
  const [system, setSystem] = useState({ status: null, error: "" });

  const signOut = useCallback(() => {
    setToken("");
    setAuthed(false);
    setOrders([]);
    setClients([]);
    setErrors({});
    setSystem({ status: null, error: "" });
  }, []);

  // Only a 401 ends the session; network and server errors are shown instead.
  const api = useCallback(
    async (url, options) => {
      try {
        return await request(url, options);
      } catch (err) {
        if (err.status === 401) signOut();
        throw err;
      }
    },
    [signOut]
  );

  const load = useCallback(
    async (key) => {
      const setters = { products: setProducts, orders: setOrders, clients: setClients };
      try {
        setters[key](await api(`/api/${key}`));
        setErrors((prev) => ({ ...prev, [key]: "" }));
      } catch (err) {
        if (err.status !== 401) setErrors((prev) => ({ ...prev, [key]: err.message }));
      }
    },
    [api]
  );

  const loadProducts = useCallback(() => load("products"), [load]);
  const loadOrders = useCallback(() => load("orders"), [load]);
  const loadClients = useCallback(() => load("clients"), [load]);
  const loadStatus = useCallback(async () => {
    try {
      setSystem({ status: await api("/api/admin/status"), error: "" });
    } catch (err) {
      if (err.status !== 401) setSystem({ status: null, error: err.message });
    }
  }, [api]);
  const loadAll = useCallback(
    () => Promise.all([loadProducts(), loadOrders(), loadClients(), loadStatus()]),
    [loadProducts, loadOrders, loadClients, loadStatus]
  );

  async function acknowledgeRecovery() {
    if (!confirm("Вы сверили заказы после восстановления базы?")) return;
    try {
      await api("/api/admin/recovery/ack", { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    await loadStatus();
  }

  useEffect(() => {
    if (authed !== null) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await api("/api/session");
      } catch (err) {
        if (!cancelled && err.status !== 401) setBootError(err.message);
        return;
      }
      if (cancelled) return;
      setBootError("");
      setAuthed(true);
      loadAll();
    })();
    return () => {
      cancelled = true;
    };
  }, [authed, bootAttempt, api, loadAll]);

  async function login(password) {
    const data = await api("/api/login", jsonBody("POST", { password }));
    setToken(data.token);
    setTab("products");
    setErrors({});
    setAuthed(true);
    loadAll();
  }

  function logout() {
    const token = getToken();
    if (token) {
      // The token is dropped locally either way; if the server did not get the
      // logout, its session simply expires after the normal session lifetime.
      fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })
        .then((res) => {
          if (!res.ok) console.warn(`Выход: сервер ответил ${res.status}, сессия истечёт сама`);
        })
        .catch((err) => console.warn("Выход: сервер недоступен, сессия истечёт сама:", err?.message || err));
    }
    signOut();
  }

  function openTab(id) {
    setTab(id);
    load(id);
    loadStatus();
  }

  const newOrders = orders.filter((order) => order.status === "new").length;
  const badges = { orders: newOrders, clients: clients.length };
  const tabError = errors[tab];

  return (
    <>
      <header className="header">
        <a className="logo" href="/">
          Жанара<span>Админка</span>
        </a>
        <nav className="admin-nav">
          <a href="/#shop">К витрине</a>
          <button className="admin-logout" type="button" hidden={!authed} onClick={logout}>
            Выйти
          </button>
        </nav>
      </header>

      <main>
        {authed === null && bootError && (
          <section className="admin-login">
            <p className="section-index">нет связи</p>
            <h1>Админка недоступна</h1>
            <p className="form-error" role="alert">
              {bootError}
            </p>
            <button
              className="btn btn-gold"
              type="button"
              onClick={() => {
                setBootError("");
                setBootAttempt((n) => n + 1);
              }}
            >
              Повторить
            </button>
          </section>
        )}
        {authed === false && <LoginScreen onLogin={login} />}
        {authed && (
          <section className="admin-panel">
            <div className="admin-tabs" role="tablist" aria-label="Разделы админки">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  className={tab === item.id ? "admin-tab is-active" : "admin-tab"}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => openTab(item.id)}
                >
                  {item.label}
                  {item.id in badges && (
                    <span className="admin-tab-badge" hidden={badges[item.id] === 0}>
                      {badges[item.id]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <SystemBanner
              status={system.status}
              error={system.error}
              onAcknowledge={acknowledgeRecovery}
              onRetry={loadStatus}
            />

            {tabError ? (
              <div className="admin-load-error" role="alert">
                <p className="form-error">Не удалось загрузить данные: {tabError}</p>
                <button className="crm-btn" type="button" onClick={() => load(tab)}>
                  Повторить
                </button>
              </div>
            ) : (
              <>
                {tab === "products" && <ProductsTab products={products} api={api} reload={loadProducts} />}
                {tab === "orders" && (
                  <OrdersTab
                    orders={orders}
                    api={api}
                    reloadOrders={loadOrders}
                    reloadClients={loadClients}
                    reloadStatus={loadStatus}
                  />
                )}
                {tab === "clients" && <ClientsTab clients={clients} api={api} reload={loadClients} />}
              </>
            )}
          </section>
        )}
      </main>
    </>
  );
}
