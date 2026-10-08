const crypto = require("crypto");
const { cleanText } = require("../../core/utils/text");
const { normalizePhone } = require("../../core/utils/phone");

function phoneOf(client) {
  return client.phoneKey || normalizePhone(client.phone);
}

function joinNotes(left, right) {
  const parts = [left, right].map((value) => String(value || "").trim()).filter(Boolean);
  const merged = [];
  parts.forEach((part) => {
    if (!merged.some((item) => item.includes(part) || part.includes(item))) merged.push(part);
  });
  return merged.join("\n").slice(0, 2000);
}

function createClientsService({ repo, listOrders }) {
  function upsertFromOrder(order, { isNewOrder = false, previousContact = "" } = {}) {
    const phoneKey = normalizePhone(order.customerContact);
    if (!phoneKey) return Promise.resolve();
    const previousKey = normalizePhone(previousContact);

    return repo.transaction((clients) => {
      const index = clients.findIndex((item) => phoneOf(item) === phoneKey);
      const previousIndex =
        previousKey && previousKey !== phoneKey ? clients.findIndex((item) => phoneOf(item) === previousKey) : -1;
      // Other orders still on the old number belong to that card. A corrected
      // number on the only order moves the same card, note included.
      const oldStillUsed =
        previousIndex !== -1 &&
        listOrders().some((item) => item.id !== order.id && normalizePhone(item.customerContact) === previousKey);

      const apply = (client) => {
        if (order.customerName) client.name = cleanText(order.customerName, 80);
        if (order.customerContact) client.phone = cleanText(order.customerContact, 40) || phoneKey;
        client.phoneKey = phoneKey;
        if (isNewOrder) client.hidden = false;
        client.updatedAt = new Date().toISOString();
      };

      if (previousIndex !== -1 && !oldStillUsed) {
        const previous = clients[previousIndex];
        if (index === -1) {
          apply(previous);
          return;
        }
        const target = clients[index];
        target.note = joinNotes(target.note, previous.note);
        if (!target.name && previous.name) target.name = previous.name;
        target.hidden = Boolean(target.hidden) && Boolean(previous.hidden);
        apply(target);
        clients.splice(previousIndex, 1);
        return;
      }

      if (index === -1) {
        clients.push({
          id: crypto.randomUUID(),
          name: cleanText(order.customerName, 80),
          phone: cleanText(order.customerContact, 40) || phoneKey,
          phoneKey,
          note: "",
          hidden: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      apply(clients[index]);
    });
  }

  // Rebuilds the CRM list from stored cards plus orders: merges duplicate cards
  // and recreates cards that are missing (e.g. a failed update after an order).
  function buildList() {
    return repo.transaction((stored, tx) => {
      const orders = listOrders();
      const byPhone = new Map();
      let dirty = false;

      stored.forEach((client) => {
        const key = client.phoneKey || normalizePhone(client.phone) || client.id;
        const duplicate = byPhone.get(key);
        if (duplicate) {
          // Merge instead of letting the later record silently replace the earlier
          // one and drop its note on the next save.
          if (client.note && !duplicate.note.includes(client.note)) {
            duplicate.note = [duplicate.note, client.note].filter(Boolean).join("\n").slice(0, 2000);
          }
          if (!duplicate.name && client.name) duplicate.name = client.name;
          duplicate.hidden = duplicate.hidden && Boolean(client.hidden);
          dirty = true;
          return;
        }
        byPhone.set(key, {
          id: client.id,
          name: client.name || "",
          phone: client.phone || "",
          phoneKey: key,
          note: client.note || "",
          hidden: Boolean(client.hidden),
          createdAt: client.createdAt || "",
          updatedAt: client.updatedAt || "",
          ordersCount: 0,
          lastOrderAt: "",
        });
      });

      orders.forEach((order) => {
        const key = normalizePhone(order.customerContact);
        if (!key) return;
        if (!byPhone.has(key)) {
          byPhone.set(key, {
            id: crypto.randomUUID(),
            name: order.customerName || "",
            phone: order.customerContact || "",
            phoneKey: key,
            note: "",
            hidden: false,
            createdAt: order.createdAt || new Date().toISOString(),
            updatedAt: order.createdAt || new Date().toISOString(),
            ordersCount: 0,
            lastOrderAt: "",
          });
          dirty = true;
        }
        const client = byPhone.get(key);
        client.ordersCount += 1;
        if (!client.name && order.customerName) client.name = order.customerName;
        if (!client.phone && order.customerContact) client.phone = order.customerContact;
        if (!client.lastOrderAt || String(order.createdAt) > String(client.lastOrderAt)) {
          client.lastOrderAt = order.createdAt || "";
        }
      });

      // The order.created handler unhides a client who orders again. If that
      // handler never ran, the card stays hidden and drops out of the CRM even
      // though the order is saved. A later order than the hide itself is enough
      // to bring the card back; older orders must not undo an intentional hide.
      for (const client of byPhone.values()) {
        if (
          client.hidden &&
          client.updatedAt &&
          client.lastOrderAt &&
          String(client.lastOrderAt) > String(client.updatedAt)
        ) {
          client.hidden = false;
          client.updatedAt = new Date().toISOString();
          dirty = true;
        }
      }

      if (dirty) {
        const next = [...byPhone.values()].map((client) => ({
          id: client.id,
          name: client.name,
          phone: client.phone,
          phoneKey: client.phoneKey,
          note: client.note || "",
          hidden: Boolean(client.hidden),
          createdAt: client.createdAt,
          updatedAt: client.updatedAt,
        }));
        stored.splice(0, stored.length, ...next);
      } else {
        tx.skipWrite();
      }

      return [...byPhone.values()]
        .filter((client) => !client.hidden)
        .sort((a, b) =>
          String(b.lastOrderAt || b.updatedAt || "").localeCompare(String(a.lastOrderAt || a.updatedAt || ""))
        );
    });
  }

  return { upsertFromOrder, buildList };
}

module.exports = { createClientsService };
