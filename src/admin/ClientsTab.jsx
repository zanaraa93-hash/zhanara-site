import { useState } from "react";
import { jsonBody } from "./api.js";
import { formatDate, whatsappLink } from "./format.js";

function ClientCard({ client, api, reload }) {
  const [note, setNote] = useState(client.note || "");
  const wa = whatsappLink(client.phone);
  const last = client.ordersCount > 0 ? `последний заказ ${formatDate(client.lastOrderAt)}` : "заказов пока нет";

  async function patch(body) {
    try {
      await api(`/api/clients/${client.id}`, jsonBody("PATCH", { ...body, updatedAt: client.updatedAt || "" }));
      await reload();
    } catch (err) {
      alert(err.message);
      await reload().catch(() => {});
    }
  }

  return (
    <article className="client-card">
      <div className="client-card-head">
        <h3>{client.name || "Без имени"}</h3>
        <span className="client-orders-badge">{client.ordersCount} зак.</span>
      </div>
      <p className="client-phone">{client.phone || "—"}</p>
      <p className="client-last">{last}</p>
      <label className="client-note-field">
        <span>Заметка</span>
        <textarea
          rows={3}
          maxLength={2000}
          placeholder="Комментарий по клиенту"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        ></textarea>
      </label>
      <div className="client-card-actions">
        <button className="crm-btn" type="button" onClick={() => patch({ note })}>
          Сохранить
        </button>
        {wa ? (
          <a className="crm-btn" href={wa} target="_blank" rel="noopener noreferrer">
            WhatsApp
          </a>
        ) : (
          <button className="crm-btn" type="button" disabled>
            WhatsApp
          </button>
        )}
        <button
          className="crm-btn crm-btn-danger"
          type="button"
          onClick={() => confirm("Скрыть этого клиента из списка?") && patch({ hidden: true })}
        >
          Скрыть
        </button>
      </div>
    </article>
  );
}

export default function ClientsTab({ clients, api, reload }) {
  return (
    <div className="admin-tab-panel">
      <div className="crm-toolbar">
        <h1>Клиенты</h1>
      </div>
      <div className="crm-grid clients-grid">
        {clients.length === 0 ? (
          <p className="crm-empty">Клиенты появятся здесь после первых заявок с сайта.</p>
        ) : (
          clients.map((client) => (
            <ClientCard key={`${client.id}:${client.updatedAt || ""}`} client={client} api={api} reload={reload} />
          ))
        )}
      </div>
    </div>
  );
}
