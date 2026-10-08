const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

function createUploads({ uploadsDir, logger }) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype);
      cb(ok ? null : new Error("Можно загружать только JPG, PNG, WEBP или GIF"), ok);
    },
  });

  function handleUpload(req, res, next) {
    upload.single("image")(req, res, (err) => {
      if (!err) return next();
      const message = err.code === "LIMIT_FILE_SIZE" ? "Файл больше 5 МБ" : err.message;
      res.status(400).json({ error: message });
    });
  }

  function removeImage(imagePath) {
    if (!imagePath || !imagePath.startsWith("/uploads/")) return;
    const file = path.join(uploadsDir, path.basename(imagePath));
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      // A locked or missing photo must not fail the product change itself.
      logger.warn(`Не удалось удалить фото ${file}: ${err.message}`);
    }
  }

  return { handleUpload, removeImage };
}

module.exports = { createUploads };
