// Manual restore for the cases the server refuses to do on its own (the
// newest backup is too old). The site must be stopped first.
//
//   npm run db:restore                 newest verified backup
//   npm run db:restore -- <file>       a specific backup file
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig } = require("../server/core/config");
const { verifyBackupFile, moveAside, DATABASE_FILE } = require("../server/core/storage/sqlite");

async function main() {
  const { config } = loadConfig();
  const live = path.join(config.dataDir, DATABASE_FILE);

  const alive = await fetch(`http://127.0.0.1:${config.port}/api/live`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
  if (alive) throw new Error("сайт запущен — остановите его (и задачу ZhanaraSite), затем повторите");

  let source = process.argv[2] ? path.resolve(process.argv[2]) : "";
  if (!source) {
    const candidates = [`${live}.bak`];
    if (fs.existsSync(config.backup.dir)) {
      fs.readdirSync(config.backup.dir)
        .filter((name) => /^site-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .forEach((name) => candidates.push(path.join(config.backup.dir, name)));
    }
    source = candidates
      .filter((file) => fs.existsSync(file) && verifyBackupFile(file).ok)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  if (!source) throw new Error("нет проверенной запасной копии");
  const check = verifyBackupFile(source);
  if (!check.ok) throw new Error(`копия ${source} не прошла проверку: ${check.error}`);

  const broken = fs.existsSync(live) ? moveAside(live) : "";
  fs.copyFileSync(source, live);
  const recovery = {
    at: new Date().toISOString(),
    reason: "manual",
    backupFile: path.basename(source),
    backupTakenAt: check.takenAt,
    brokenFile: broken ? path.basename(broken) : "",
    collections: check.collections,
    newestOrderAt: check.newestOrderAt,
  };
  const db = new DatabaseSync(live);
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('recovery:last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(recovery));
  db.close();
  console.log(`База восстановлена из ${source}. Прежний файл сохранён как ${broken || "(не было)"}.`);
  console.log("После запуска сайта сверьте заказы и подтвердите восстановление в админке.");
}

main().catch((err) => {
  console.error(`Восстановление не выполнено: ${err.message}`);
  process.exit(1);
});
