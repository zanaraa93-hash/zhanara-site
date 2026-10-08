// Starts the server against a COPY of data/ in a temp folder and prints the
// migrated state. Nothing in data/ is opened for writing.
//
//   node scripts/rehearse-on-copy.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { startServer, api, ADMIN_PASSWORD } = require(path.join(ROOT, "test", "helpers"));

const mask = (phone) => String(phone || "").replace(/\d(?=\d{2})/g, "*");

(async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "zhanara-rehearse-"));
  for (const name of fs.readdirSync(path.join(ROOT, "data"))) {
    const src = path.join(ROOT, "data", name);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(copy, name));
  }
  const server = await startServer({ env: { DATA_DIR: copy, UPLOADS_DIR: path.join(ROOT, "uploads"), LOG_LEVEL: "info" } });
  try {
    const token = (await api(server.base, "POST", "/api/login", { body: { password: ADMIN_PASSWORD } })).body.token;
    const orders = (await api(server.base, "GET", "/api/orders", { token })).body;
    console.log("orders:", orders.length);
    for (const o of orders) {
      console.log(
        o.id.slice(0, 8),
        o.createdAt,
        `status=${o.status}`,
        `tg=${o.telegramStatus}`,
        `v=${o.version}`,
        `legacyFlag=${"telegramNotified" in o}`,
        `phone=${mask(o.customerContact)}`
      );
    }
    const status = await api(server.base, "GET", "/api/admin/status", { token });
    console.log(
      "admin/status",
      status.status,
      JSON.stringify({ status: status.body.status, telegram: status.body.checks.telegram, ai: status.body.checks.ai.state, backup: status.body.checks.backup })
    );
    const health = await api(server.base, "GET", "/api/health");
    console.log("health", health.status, health.body.status);
    const clients = (await api(server.base, "GET", "/api/clients", { token })).body;
    console.log("clients:", clients.map((c) => `${mask(c.phone)} orders=${c.ordersCount}`).join(" | "));
    const test7 = orders.filter((o) => String(o.customerContact).replace(/\D/g, "").endsWith("7777777777"));
    console.log("orders using 77777777777:", test7.length);
  } finally {
    await server.stop();
    console.log("--- server output (tail) ---");
    console.log(server.output().split("\n").slice(-15).join("\n"));
    fs.rmSync(copy, { recursive: true, force: true });
  }
})();
