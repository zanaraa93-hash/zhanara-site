const fs = require("fs");
const path = require("path");

// The live records live in SQLite. These helpers only read the old JSON files
// once, while that database is being filled, and put a .bak back if the JSON
// file was cut off.

function ensureJsonArrayFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "[]", "utf8");
}

// Throws instead of returning [] on a broken file: an empty result here
// would be written back on the next save and wipe all existing records.
function readJsonArray(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  // Files are created as "[]", so an empty one means a write was cut off
  // (power loss, full disk) — not "no records".
  if (!raw.trim()) {
    throw new Error(`Файл ${file} пустой. Последняя рабочая копия: ${path.basename(file)}.bak`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Файл ${file} повреждён (${err.message}). Последняя рабочая копия: ${path.basename(file)}.bak`
    );
  }
  if (!Array.isArray(parsed)) throw new Error(`${path.basename(file)}: ожидался массив`);
  return parsed;
}

function writeJsonArray(file, items) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(items, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try {
      if (readJsonArray(file).length) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // Keep the last good backup instead of overwriting it with a broken file.
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows antivirus/indexers can briefly lock the target file.
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

// A crash can leave the live file empty or half-written while .bak still holds
// the previous complete copy. Restore that copy once, at startup, before any
// request can read the broken file. Mid-request recovery is intentionally not
// done: a reader must not replace a file another request is in the middle of writing.
function restoreJsonArrayFromBackup(file) {
  try {
    readJsonArray(file);
    return false;
  } catch {
    const bak = `${file}.bak`;
    let recovered;
    try {
      recovered = readJsonArray(bak);
    } catch {
      return false;
    }
    writeJsonArray(file, recovered);
    return true;
  }
}

module.exports = { ensureJsonArrayFile, readJsonArray, writeJsonArray, restoreJsonArrayFromBackup };
