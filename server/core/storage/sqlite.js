const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readJsonArray, restoreJsonArrayFromBackup } = require("./jsonStore");
const { createMutex } = require("./mutex");

// SQLite is the copy bundled with this Node binary (node:sqlite). Nothing is
// downloaded or compiled: DatabaseSync talks to that library directly.
const DATABASE_FILE = "site.db";
const BUSY_TIMEOUT_MS = 5000;
// A full copy costs as much as the whole database, so it is not made on every
// write. At most this much of the latest work is missing from site.db.bak.
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function configure(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
}

function sqlString(file) {
  return `'${String(file).replace(/'/g, "''")}'`;
}

// readOnly so a health check cannot turn a broken file into a new empty database.
function inspectDatabase(file) {
  if (!fs.existsSync(file)) return { state: "missing" };
  if (fs.statSync(file).size === 0) return { state: "empty" };
  let handle;
  try {
    handle = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    const check = handle.prepare("PRAGMA quick_check").get();
    if (!check || check.quick_check !== "ok") {
      return { state: "corrupt", detail: check ? String(check.quick_check) : "проверка не вернула результат" };
    }
    return { state: "ok" };
  } catch (err) {
    if (/busy|locked/i.test(err.message)) return { state: "busy", detail: err.message };
    return { state: "corrupt", detail: err.message };
  } finally {
    try {
      if (handle) handle.close();
    } catch {
      // The handle may already be unusable.
    }
  }
}

function databaseError(file, inspection) {
  if (inspection.state === "empty") return new Error(`Файл ${file} пустой. Это не база SQLite.`);
  const detail = inspection.detail ? ` (${inspection.detail})` : "";
  return new Error(`Файл ${file} повреждён${detail}.`);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

// The damaged file is kept under a unique name for investigation; an earlier
// broken copy is never overwritten.
function moveAside(file) {
  const broken = `${file}.broken-${stamp()}`;
  if (fs.existsSync(file)) fs.renameSync(file, broken);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${file}${suffix}`;
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${broken}${suffix}`);
  }
  return broken;
}

// A readable SQLite file is not enough: it must hold the records table, or
// "restoring" it would silently start the site with no data.
function verifyBackupFile(file) {
  const inspection = inspectDatabase(file);
  if (inspection.state !== "ok") return { ok: false, error: inspection.detail || inspection.state };
  let handle;
  try {
    handle = new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    const table = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'").get();
    if (!table) return { ok: false, error: "в файле нет таблицы records" };
    const collections = {};
    handle
      .prepare("SELECT collection, COUNT(*) AS n FROM records GROUP BY collection")
      .all()
      .forEach((row) => {
        collections[row.collection] = Number(row.n);
      });
    const newest = handle
      .prepare("SELECT MAX(json_extract(body, '$.createdAt')) AS at FROM records WHERE collection = 'orders'")
      .get();
    return { ok: true, collections, newestOrderAt: newest?.at || null, takenAt: fs.statSync(file).mtime.toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      if (handle) handle.close();
    } catch {
      // The handle may already be unusable.
    }
  }
}

function backupCandidates(file, backupDir) {
  const list = [`${file}.bak`];
  if (backupDir && fs.existsSync(backupDir)) {
    fs.readdirSync(backupDir)
      .filter((name) => /^site-\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .forEach((name) => list.push(path.join(backupDir, name)));
  }
  return list
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ file: candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Replaces a missing or broken database with the newest verified backup, but
// only a fresh one: an old copy would quietly roll back days of orders. The
// returned record is kept in the database and shown in health and the admin
// panel until someone acknowledges it.
function restoreBackup(file, { logger, backupDir, maxAgeHours, reason }) {
  const verified = backupCandidates(file, backupDir)
    .map((candidate) => ({ ...candidate, check: verifyBackupFile(candidate.file) }))
    .find((candidate) => candidate.check.ok);
  if (!verified) return { restored: false, why: "нет ни одной проверенной запасной копии" };
  const ageMs = Date.now() - verified.mtimeMs;
  const ageHours = Math.round((ageMs / 3600000) * 10) / 10;
  if (ageMs > maxAgeHours * 3600000) {
    return {
      restored: false,
      why: `самая свежая запасная копия (${path.basename(verified.file)}) старше ${maxAgeHours} ч (${ageHours} ч) — восстановите вручную: npm run db:restore`,
    };
  }
  const tmp = `${file}.${process.pid}.restore`;
  try {
    fs.copyFileSync(verified.file, tmp);
    if (!verifyBackupFile(tmp).ok) {
      fs.rmSync(tmp, { force: true });
      return { restored: false, why: "копия повредилась при копировании" };
    }
    let brokenFile = "";
    if (fs.existsSync(file)) {
      brokenFile = moveAside(file);
    } else {
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    }
    fs.renameSync(tmp, file);
    const recovery = {
      at: new Date().toISOString(),
      reason,
      backupFile: path.basename(verified.file),
      backupTakenAt: new Date(verified.mtimeMs).toISOString(),
      backupAgeHours: ageHours,
      brokenFile: brokenFile ? path.basename(brokenFile) : "",
      collections: verified.check.collections,
      newestOrderAt: verified.check.newestOrderAt,
    };
    if (logger) {
      logger.error(
        "БАЗА ВОССТАНОВЛЕНА ИЗ ЗАПАСНОЙ КОПИИ. Всё, что записано после момента копии, потеряно — сверьте заказы с Telegram/WhatsApp.",
        recovery
      );
    }
    return { restored: true, recovery };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return { restored: false, why: `не удалось восстановить: ${err.message}` };
  }
}

// Writes a verified copy to site.db.bak and, once a day, a dated generation
// in the backup folder. Returns an error message instead of swallowing it,
// so health can report a backup that keeps failing.
function saveBackup(db, file, { backupDir, keepDaily }) {
  const tmp = `${file}.${process.pid}.bak-tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO ${sqlString(tmp)}`);
    const check = verifyBackupFile(tmp);
    if (!check.ok) throw new Error(`копия не прошла проверку: ${check.error}`);
    fs.copyFileSync(tmp, `${file}.bak`);
    if (backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      const daily = path.join(backupDir, `site-${new Date().toISOString().slice(0, 10)}.db`);
      fs.copyFileSync(tmp, daily);
      const generations = fs
        .readdirSync(backupDir)
        .filter((name) => /^site-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .sort()
        .reverse();
      generations.slice(keepDaily).forEach((name) => fs.rmSync(path.join(backupDir, name), { force: true }));
    }
    fs.rmSync(tmp, { force: true });
    return null;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return err.message;
  }
}

// The file appears only after the schema is in it. Two processes starting
// together must not observe a zero-byte database and refuse to open it.
function publishNewDatabase(file) {
  const tmp = `${file}.${process.pid}.tmp`;
  const db = new DatabaseSync(tmp, { timeout: BUSY_TIMEOUT_MS });
  try {
    configure(db);
    ensureSchema(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // The handle may already be unusable.
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  db.close();
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw err;
  }
}

function openDatabase(file, { logger, backupDir, maxAgeHours }) {
  // An empty or broken file is not opened as a fresh database: that would hide
  // the loss. A missing or broken file is replaced only from a fresh backup.
  const inspection = inspectDatabase(file);
  let recovery = null;
  if (inspection.state !== "ok" && inspection.state !== "busy") {
    const attempt = restoreBackup(file, { logger, backupDir, maxAgeHours, reason: inspection.state });
    recovery = attempt.recovery || null;
    const firstRun = inspection.state === "missing" && backupCandidates(file, backupDir).length === 0;
    if (!attempt.restored && firstRun) {
      try {
        publishNewDatabase(file);
      } catch (err) {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { error: err };
      }
    } else if (!attempt.restored) {
      const base =
        inspection.state === "missing"
          ? new Error(`Файл ${file} пропал, а запасные копии есть.`)
          : databaseError(file, inspection);
      base.message += ` Автовосстановление не выполнено: ${attempt.why}.`;
      return { error: base };
    }
  }
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    return { error: new Error(`Файл ${file} пустой. Это не база SQLite.`) };
  }
  let db;
  try {
    db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    const check = db.prepare("PRAGMA quick_check").get();
    if (!check || check.quick_check !== "ok") {
      throw new Error(check ? String(check.quick_check) : "проверка не вернула результат");
    }
    configure(db);
  } catch (err) {
    try {
      if (db) db.close();
    } catch {
      // The handle may already be unusable.
    }
    const message = /пустой|поврежд/.test(err.message) ? err.message : `Файл ${file} повреждён (${err.message}).`;
    return { error: new Error(message) };
  }
  return { db, recovery };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT,
      body TEXT NOT NULL,
      PRIMARY KEY (collection, seq)
    );
    DROP INDEX IF EXISTS records_by_id;
    DROP INDEX IF EXISTS records_by_request;
    CREATE INDEX IF NOT EXISTS records_by_id_seq ON records (collection, id, seq);
    CREATE INDEX IF NOT EXISTS records_by_request_seq ON records (collection, json_extract(body, '$.requestId'), seq);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function idOf(item) {
  return item && typeof item === "object" && item.id != null ? String(item.id) : null;
}

function readAll(db, name) {
  return db
    .prepare("SELECT body FROM records WHERE collection = ? ORDER BY seq")
    .all(name)
    .map((row) => JSON.parse(row.body));
}

function readRows(db, name) {
  return db.prepare("SELECT seq, id, body FROM records WHERE collection = ? ORDER BY seq").all(name);
}

function nextSeq(db, name) {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM records WHERE collection = ?").get(name);
  return row && row.seq != null ? Number(row.seq) + 1 : 0;
}

function writeAll(db, name, items) {
  db.prepare("DELETE FROM records WHERE collection = ?").run(name);
  const insert = db.prepare("INSERT INTO records (collection, seq, id, body) VALUES (?, ?, ?, ?)");
  items.forEach((item, seq) => {
    insert.run(name, seq, idOf(item), JSON.stringify(item));
  });
}

// Writes only the rows that changed. A record keeps its seq while it stays in
// the same relative order, so list order is preserved without renumbering.
// Records that moved or were added get fresh seqs after the current maximum.
function writeChanges(db, name, rows, origin, next) {
  const byId = new Map();
  rows.forEach((row) => {
    if (row.id != null && !byId.has(row.id)) byId.set(row.id, row);
  });
  let maxSeq = rows.reduce((max, row) => Math.max(max, Number(row.seq)), -1);
  const used = new Set();
  const plan = [];
  let lastSeq = -Infinity;
  let appending = false;
  for (const item of next) {
    let row = item && typeof item === "object" ? origin.get(item) : undefined;
    if (!row || used.has(row)) {
      const id = idOf(item);
      row = id != null ? byId.get(id) : undefined;
      if (row && used.has(row)) row = undefined;
    }
    if (row && !appending && Number(row.seq) > lastSeq) {
      used.add(row);
      lastSeq = Number(row.seq);
      plan.push({ row, item });
    } else {
      appending = true;
      maxSeq += 1;
      plan.push({ row: null, seq: maxSeq, item });
    }
  }

  let changed = 0;
  const remove = db.prepare("DELETE FROM records WHERE collection = ? AND seq = ?");
  rows.forEach((row) => {
    if (used.has(row)) return;
    remove.run(name, row.seq);
    changed += 1;
  });
  const update = db.prepare("UPDATE records SET id = ?, body = ? WHERE collection = ? AND seq = ?");
  const insert = db.prepare("INSERT INTO records (collection, seq, id, body) VALUES (?, ?, ?, ?)");
  plan.forEach(({ row, seq, item }) => {
    const body = JSON.stringify(item);
    const id = idOf(item);
    if (!row) {
      insert.run(name, seq, id, body);
      changed += 1;
    } else if (row.body !== body || (row.id ?? null) !== id) {
      update.run(id, body, name, row.seq);
      changed += 1;
    }
  });
  return changed;
}

function newestReadable(files) {
  const present = files.filter((candidate) => fs.existsSync(candidate));
  present.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  let lastError = null;
  for (const candidate of present) {
    try {
      return readJsonArray(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
}

function readLegacy(jsonFile) {
  const backup = `${jsonFile}.bak`;
  const migrated = `${jsonFile}.migrated`;
  if (!fs.existsSync(jsonFile) && !fs.existsSync(backup) && !fs.existsSync(migrated)) return { missing: true };
  try {
    if (fs.existsSync(jsonFile)) {
      restoreJsonArrayFromBackup(jsonFile);
      return { items: readJsonArray(jsonFile) };
    }
    // The renamed snapshot is the file that was actually imported. The .bak
    // next to it can be an older copy and must not win just because it exists.
    const items = newestReadable([migrated, backup]);
    if (!items) return { missing: true };
    return { items };
  } catch (err) {
    return { error: err };
  }
}

function createSqliteStorage({
  dataDir,
  logger,
  backupDir = path.join(dataDir, "backups"),
  keepDaily = 14,
  autoRestoreMaxAgeHours = 24,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DATABASE_FILE);
  const opened = openDatabase(file, { logger, backupDir, maxAgeHours: autoRestoreMaxAgeHours });
  const db = opened.db || null;
  const openError = opened.error || null;
  // One connection, so every collection shares one mutex. SQLite itself allows
  // only one transaction on that connection; the mutex keeps the second caller
  // waiting instead of starting a nested BEGIN.
  const exclusive = createMutex();
  const repositories = new Map();
  const broken = new Map();
  let closed = false;
  let lastBackupAt = 0;
  let lastBackupOkAt = 0;
  let lastBackupError = "";
  let backupTimer = null;

  function backupNow() {
    clearTimeout(backupTimer);
    backupTimer = null;
    if (!db || closed) return;
    const error = saveBackup(db, file, { backupDir, keepDaily });
    lastBackupAt = Date.now();
    if (error) {
      lastBackupError = error;
      if (logger) logger.error("Не удалось сохранить запасную копию базы", { error });
    } else {
      lastBackupError = "";
      lastBackupOkAt = lastBackupAt;
    }
  }

  // Must be called outside an open transaction: VACUUM INTO cannot run inside one.
  function scheduleBackup() {
    if (backupTimer || closed) return;
    const wait = lastBackupAt + BACKUP_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      backupNow();
      return;
    }
    backupTimer = setTimeout(() => {
      backupTimer = null;
      exclusive(() => backupNow()).catch((err) => {
        lastBackupError = err.message;
        if (logger) logger.error("Не удалось сохранить запасную копию базы", { error: err.message });
      });
    }, wait);
    backupTimer.unref();
  }

  if (db) {
    ensureSchema(db);
    if (opened.recovery) writeMeta("recovery:last", JSON.stringify(opened.recovery));
    backupNow();
  }

  function readMeta(key) {
    if (!db || closed) return null;
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  function writeMeta(key, value) {
    if (value === null) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else markImported(key, value);
  }

  function recoveryRecord() {
    try {
      const raw = readMeta("recovery:last");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return { at: "", reason: "запись о восстановлении нечитаема" };
    }
  }

  // Only after a person has checked the restored data.
  function acknowledgeRecovery() {
    return exclusive(() => {
      assertOpen();
      const record = recoveryRecord();
      writeMeta("recovery:last", null);
      return record;
    });
  }

  function status() {
    return {
      file,
      backupDir,
      lastBackupAt: lastBackupAt ? new Date(lastBackupAt).toISOString() : null,
      lastBackupOkAt: lastBackupOkAt ? new Date(lastBackupOkAt).toISOString() : null,
      lastBackupError,
      recovery: openError ? null : recoveryRecord(),
    };
  }

  function assertOpen() {
    if (closed) throw new Error(`База ${file} уже закрыта`);
    if (openError) throw openError;
  }

  function markImported(flag, value) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(flag, value);
  }

  // Copies the newest legacy JSON file into the database once. A later empty
  // database must not be filled from a stale JSON file, and a corrupt JSON
  // file must not be replaced with an empty collection.
  function importLegacy(name) {
    assertOpen();
    const flag = `imported:${name}`;
    const jsonFile = path.join(dataDir, `${name}.json`);
    let imported = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT value FROM meta WHERE key = ?").get(flag)) {
        db.exec("COMMIT");
        return;
      }
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = ?").get(name).n);
      if (count > 0) {
        markImported(flag, "existing");
        db.exec("COMMIT");
        return;
      }
      const legacy = readLegacy(jsonFile);
      if (legacy.missing) {
        markImported(flag, "absent");
        db.exec("COMMIT");
        return;
      }
      if (legacy.error) {
        if (name === "sessions") {
          markImported(flag, "reset");
          db.exec("COMMIT");
          if (logger) logger.warn(`Файл сессий повреждён, все входы сброшены: ${legacy.error.message}`);
          return;
        }
        broken.set(name, legacy.error);
        db.exec("ROLLBACK");
        return;
      }
      writeAll(db, name, legacy.items);
      markImported(flag, "json");
      db.exec("COMMIT");
      imported = true;
      backupNow();
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // BEGIN itself may have failed.
      }
      throw err;
    }

    if (!imported || !fs.existsSync(jsonFile)) return;
    try {
      const migrated = `${jsonFile}.migrated`;
      if (fs.existsSync(migrated)) fs.rmSync(migrated);
      fs.renameSync(jsonFile, migrated);
    } catch (err) {
      if (logger) logger.warn(`Не удалось переименовать ${jsonFile}: ${err.message}`);
    }
  }

  function createRepository(name) {
    if (db) importLegacy(name);

    function fail() {
      assertOpen();
      const problem = broken.get(name);
      if (problem) throw problem;
    }

    const list = () => {
      fail();
      return readAll(db, name);
    };

    // Indexed lookups: they read one row, not the whole collection.
    function rowById(id) {
      if (id == null) return null;
      return db
        .prepare("SELECT seq, id, body FROM records WHERE collection = ? AND id = ? ORDER BY seq LIMIT 1")
        .get(name, String(id));
    }

    const get = (id) => {
      fail();
      const row = rowById(id);
      return row ? JSON.parse(row.body) : undefined;
    };

    const findBy = (field, value) => {
      fail();
      if (!FIELD_NAME.test(String(field))) throw new Error(`Недопустимое поле: "${field}"`);
      if (value == null || value === "") return undefined;
      const row = db
        .prepare(
          `SELECT body FROM records WHERE collection = ? AND json_extract(body, '$.${field}') = ? ORDER BY seq LIMIT 1`
        )
        .get(name, typeof value === "number" ? value : String(value));
      return row ? JSON.parse(row.body) : undefined;
    };

    // One BEGIN IMMEDIATE ... COMMIT under the shared mutex. fn returns
    // { result, changed }; a backup is scheduled only when something was written.
    function atomic(fn) {
      return exclusive(async () => {
        fail();
        db.exec("BEGIN IMMEDIATE");
        let outcome;
        try {
          outcome = await fn();
          db.exec("COMMIT");
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Ignore a rollback when BEGIN never started.
          }
          throw err;
        }
        if (outcome.changed) scheduleBackup();
        return outcome.result;
      });
    }

    function insertRow(item) {
      db.prepare("INSERT INTO records (collection, seq, id, body) VALUES (?, ?, ?, ?)").run(
        name,
        nextSeq(db, name),
        idOf(item),
        JSON.stringify(item)
      );
    }

    // Whole-collection edits for rare admin jobs. Only rows that actually
    // changed are written, so a small edit stays cheap on disk.
    function transaction(fn) {
      return atomic(async () => {
        const rows = readRows(db, name);
        const origin = new WeakMap();
        const items = rows.map((row) => {
          const item = JSON.parse(row.body);
          if (item && typeof item === "object") origin.set(item, row);
          return item;
        });
        let write = true;
        const result = await fn(items, {
          skipWrite: () => {
            write = false;
          },
        });
        const changed = write ? writeChanges(db, name, rows, origin, items) : 0;
        return { result, changed };
      });
    }

    const insert = (item) =>
      atomic(async () => {
        insertRow(item);
        return { result: item, changed: 1 };
      });

    // Newest record with field = value whose `at` field is not older than
    // `since` and that is not soft-deleted.
    function findRecent({ field, at, since }, target) {
      if (!FIELD_NAME.test(String(field)) || !FIELD_NAME.test(String(at))) throw new Error("Недопустимое поле");
      const key = target?.[field];
      if (key == null || key === "") return undefined;
      const row = db
        .prepare(
          `SELECT body FROM records WHERE collection = ? AND json_extract(body, '$.${field}') = ?
             AND json_extract(body, '$.${at}') >= ? AND json_extract(body, '$.deletedAt') IS NULL
           ORDER BY seq DESC LIMIT 1`
        )
        .get(name, String(key), since);
      return row ? JSON.parse(row.body) : undefined;
    }

    // The duplicate checks and the insert happen in one transaction, so two
    // parallel requests with the same value cannot both be created. `recent`
    // also catches a repeat of the same content within a short window, for
    // retries that arrive without the original request id.
    const insertIfAbsent = (item, field, { recent } = {}) =>
      atomic(async () => {
        const value = item ? item[field] : undefined;
        if (value != null && value !== "") {
          const existing = findBy(field, value);
          if (existing) return { result: { item: existing, created: false, reason: field }, changed: 0 };
        }
        if (recent) {
          const existing = findRecent(recent, item);
          if (existing) return { result: { item: existing, created: false, reason: recent.field }, changed: 0 };
        }
        insertRow(item);
        return { result: { item, created: true }, changed: 1 };
      });

    // fn gets the stored record (or null) and may change it in place.
    const update = (id, fn) =>
      atomic(async () => {
        const row = rowById(id);
        const item = row ? JSON.parse(row.body) : null;
        let write = Boolean(row);
        const result = await fn(item, {
          skipWrite: () => {
            write = false;
          },
        });
        if (!write) return { result, changed: 0 };
        const body = JSON.stringify(item);
        if (body === row.body) return { result, changed: 0 };
        db.prepare("UPDATE records SET id = ?, body = ? WHERE collection = ? AND seq = ?").run(
          idOf(item),
          body,
          name,
          row.seq
        );
        return { result, changed: 1 };
      });

    const remove = (id) =>
      atomic(async () => {
        const row = rowById(id);
        if (!row) return { result: null, changed: 0 };
        db.prepare("DELETE FROM records WHERE collection = ? AND seq = ?").run(name, row.seq);
        return { result: JSON.parse(row.body), changed: 1 };
      });

    return {
      list,
      find: (predicate) => list().find(predicate),
      get,
      findBy,
      transaction,
      insert,
      insertIfAbsent,
      update,
      remove,
      replaceAll: (next) =>
        transaction((items) => {
          items.splice(0, items.length, ...next);
        }),
      // Sessions are disposable. Other collections are not cleared on startup.
      clear() {
        if (openError) throw openError;
        broken.delete(name);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM records WHERE collection = ?").run(name);
          markImported(`imported:${name}`, "reset");
          db.exec("COMMIT");
          scheduleBackup();
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Ignore a rollback when BEGIN never started.
          }
          throw err;
        }
      },
      health() {
        list();
        return true;
      },
    };
  }

  function repository(name) {
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name)) throw new Error(`Недопустимое имя хранилища: "${name}"`);
    if (!repositories.has(name)) repositories.set(name, createRepository(name));
    return repositories.get(name);
  }

  function health() {
    const problems = [];
    for (const [name, repo] of repositories) {
      try {
        repo.health();
      } catch (err) {
        problems.push({ name, error: err.message });
      }
    }
    return problems;
  }

  function close() {
    if (!db || closed) return;
    try {
      backupNow();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      // A busy or broken connection should still be closed; the WAL stays and is applied on next open.
      if (logger) logger.warn("Не удалось завершить запись журнала базы при остановке", { error: err.message });
    }
    closed = true;
    clearTimeout(backupTimer);
    backupTimer = null;
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  return {
    driver: "sqlite",
    file,
    repository,
    health,
    close,
    status,
    acknowledgeRecovery,
    backupNow: () => exclusive(() => backupNow()),
  };
}

module.exports = { createSqliteStorage, DATABASE_FILE, verifyBackupFile, moveAside };
