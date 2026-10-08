const fs = require("fs");
const path = require("path");
const { detectImage } = require("../files/detect");

// Uploads are capped at 5 MB; anything larger did not come through the admin form.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// PNGs are decoded to raw pixels; a huge canvas in a small file would exhaust memory.
const MAX_PNG_PIXELS = 25 * 1000 * 1000;
const UPLOAD_PATH = /^\/uploads\/[^/\\]+$/;

// Only "/uploads/<file>" inside the configured uploads folder is ever read:
// no other folders, no "..", no absolute paths, no URLs.
function resolveUploadPath(image, uploadsDir) {
  const value = String(image || "");
  if (!UPLOAD_PATH.test(value)) return null;
  const name = path.basename(value);
  if (!name || name === "." || name === ".." || name.startsWith(".")) return null;
  const root = path.resolve(uploadsDir);
  const file = path.resolve(root, name);
  return path.dirname(file) === root ? file : null;
}

function pngPixels(buffer) {
  // IHDR is always the first chunk: width and height are at bytes 16..23.
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return Infinity;
  return buffer.readUInt32BE(16) * buffer.readUInt32BE(20);
}

// Returns { buffer, mime }, { buffer: null } when no image is set, or
// { error } — never throws, so one bad photo only turns into a placeholder.
async function loadUploadImage(image, uploadsDir) {
  if (!String(image || "").trim()) return { buffer: null };
  const file = resolveUploadPath(image, uploadsDir);
  if (!file) return { error: "путь к фото не из папки uploads" };
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch {
    return { error: "файл фото не найден" };
  }
  if (!stat.isFile()) return { error: "фото не является файлом" };
  if (stat.size === 0) return { error: "файл фото пустой" };
  if (stat.size > MAX_IMAGE_BYTES) return { error: "файл фото слишком большой" };

  let buffer;
  try {
    buffer = await fs.promises.readFile(file);
  } catch {
    return { error: "файл фото не читается" };
  }
  const mime = detectImage(buffer);
  if (mime !== "image/jpeg" && mime !== "image/png") {
    return { error: mime ? `формат ${mime} не поддерживается в PDF` : "файл не является изображением" };
  }
  if (mime === "image/png" && pngPixels(buffer) > MAX_PNG_PIXELS) {
    return { error: "фото слишком большого разрешения" };
  }
  return { buffer, mime };
}

module.exports = { loadUploadImage, resolveUploadPath };
