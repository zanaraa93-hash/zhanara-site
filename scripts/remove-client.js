// Removes one client card (e.g. test data) after a fresh backup, refusing if
// any order still uses that phone. The site must be stopped first.
//
//   node scripts/remove-client.js 77777777777
const crypto = require("crypto");
const { loadConfig } = require("../server/core/config");
const { createSqliteStorage } = require("../server/core/storage/sqlite");
const { normalizePhone } = require("../server/core/utils/phone");

async function main() {
  const phoneKey = normalizePhone(process.argv[2]);
  if (!phoneKey) throw new Error("укажите телефон клиента");
  const { config } = loadConfig();

  const alive = await fetch(`http://127.0.0.1:${config.port}/api/live`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
  if (alive) throw new Error("сайт запущен — остановите его, затем повторите");

  const storage = createSqliteStorage({
    dataDir: config.dataDir,
    backupDir: config.backup.dir,
    keepDaily: config.backup.keepDaily,
  });
  try {
    const orders = storage.repository("orders").list();
    const used = orders.filter((order) => normalizePhone(order.customerContact) === phoneKey);
    if (used.length) throw new Error(`номер есть в заказах (${used.length}) — карточку не удаляю`);
    const clients = storage.repository("clients");
    const client = clients.list().find((item) => (item.phoneKey || normalizePhone(item.phone)) === phoneKey);
    if (!client) throw new Error("клиента с таким номером нет");

    await storage.backupNow();
    const backup = storage.status();
    if (backup.lastBackupError) throw new Error(`не удалось сделать копию перед удалением: ${backup.lastBackupError}`);

    await clients.remove(client.id);
    await storage.repository("audit").insert({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action: "client.removed",
      clientId: client.id,
      reason: "test data",
      backupAt: backup.lastBackupOkAt,
    });
    console.log(`Карточка ${client.id} удалена. Копия перед удалением: ${backup.lastBackupOkAt}.`);
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error(`Не удалено: ${err.message}`);
  process.exit(1);
});
