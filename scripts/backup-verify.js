// Proves the backups can actually be restored: every copy is checked, and the
// newest one is restored into a temporary folder and opened like the real site
// would open it. Exit code 1 means there is no restorable backup.
//
//   npm run backup:verify
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("../server/core/config");
const { createSqliteStorage, verifyBackupFile, DATABASE_FILE } = require("../server/core/storage/sqlite");

function main() {
  const { config } = loadConfig();
  const live = path.join(config.dataDir, DATABASE_FILE);
  const candidates = [`${live}.bak`];
  if (fs.existsSync(config.backup.dir)) {
    fs.readdirSync(config.backup.dir)
      .filter((name) => /^site-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .forEach((name) => candidates.push(path.join(config.backup.dir, name)));
  }

  const results = candidates
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, ...verifyBackupFile(file) }))
    .sort((a, b) => String(b.takenAt || "").localeCompare(String(a.takenAt || "")));
  results.forEach((item) => {
    const where = path.relative(config.root, item.file);
    if (item.ok) console.log(`OK   ${where}  копия от ${item.takenAt}  записи: ${JSON.stringify(item.collections)}`);
    else console.log(`FAIL ${where}  ${item.error}`);
  });

  const newest = results.find((item) => item.ok);
  if (!newest) {
    console.error("Нет ни одной проверенной запасной копии.");
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhanara-restore-test-"));
  try {
    fs.copyFileSync(newest.file, path.join(tmp, DATABASE_FILE));
    const storage = createSqliteStorage({ dataDir: tmp, backupDir: path.join(tmp, "backups") });
    const counts = {};
    for (const name of Object.keys(newest.collections)) counts[name] = storage.repository(name).list().length;
    storage.close();
    const same = Object.keys(newest.collections).every((name) => counts[name] === newest.collections[name]);
    if (!same) throw new Error(`после восстановления число записей другое: ${JSON.stringify(counts)}`);

    if (fs.existsSync(live)) {
      const current = verifyBackupFile(live);
      if (current.ok) {
        console.log(`Рабочая база сейчас: ${JSON.stringify(current.collections)}, последний заказ ${current.newestOrderAt}`);
        console.log(`В копии последний заказ: ${newest.newestOrderAt}`);
      }
    }
    console.log(`Восстановление проверено: ${path.relative(config.root, newest.file)} открывается и читается полностью.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`Проверка восстановления не прошла: ${err.message}`);
  process.exit(1);
}
