import { useRef, useState } from "react";

export default function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const inFlight = useRef(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onLogin(password);
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="admin-login">
      <p className="section-index">вход</p>
      <h1>Админка витрины</h1>
      <p>Товары, заказы и клиенты — всё в одном месте.</p>
      <form className="admin-card" onSubmit={handleSubmit}>
        <label className="field">
          <span>Пароль</span>
          <div className="password-wrap">
            <input
              ref={inputRef}
              type={visible ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className={visible ? "password-toggle is-open" : "password-toggle"}
              type="button"
              aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
              aria-pressed={visible}
              onClick={() => {
                setVisible((value) => !value);
                inputRef.current?.focus();
              }}
            >
              <svg className="icon-eye" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg className="icon-eye-off" viewBox="0 0 24 24" aria-hidden="true" hidden>
                <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                <circle cx="12" cy="12" r="3" />
                <path d="M4 4l16 16" />
              </svg>
            </button>
          </div>
        </label>
        <p className="form-error" hidden={!error}>
          {error}
        </p>
        <button className="btn btn-gold" type="submit" disabled={busy}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </section>
  );
}
