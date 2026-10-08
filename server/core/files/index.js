const path = require("path");
const multer = require("multer");
const { cleanText } = require("../utils/text");
const { detectImage, isPdf, isDocx, isDoc, isPlainText } = require("./detect");
const { createParseRunner } = require("./runner");
const { createAttachmentStore } = require("./store");

const PARSERS_DIR = path.join(__dirname, "parsers");

function normalizeExtracted(text, maxChars) {
  const clean = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars };
}

// Strips any path the browser may have sent along with the name.
function fileName(raw) {
  return cleanText(path.basename(String(raw || "").replace(/\\/g, "/")), 120) || "файл";
}

function createFiles({ config, logger }) {
  const limits = config.files;
  const runner = createParseRunner({
    concurrency: limits.parserConcurrency,
    timeoutMs: limits.parseTimeoutMs,
    memoryMb: limits.parserMemoryMb,
  });
  const store = createAttachmentStore({
    ttlMs: limits.ttlMs,
    maxEntries: limits.maxStoredEntries,
    maxBytes: limits.maxStoredBytes,
  });
  const cleanup = setInterval(() => store.purgeExpired(), 10 * 60 * 1000);
  cleanup.unref();

  // Text parsers run in a child process by module path, so a parser is a plain module
  // exporting parse(buffer, options). Modules can add formats the same way.
  const parsers = [];
  function registerParser({ name, label, detect, modulePath, options = {} }) {
    if (!name || typeof detect !== "function" || !modulePath) {
      throw new Error(`Некорректный парсер файлов: "${name}"`);
    }
    if (parsers.some((parser) => parser.name === name)) throw new Error(`Парсер "${name}" уже зарегистрирован`);
    const entry = { name, label: label || name, detect, modulePath, options };
    parsers.push(entry);
    return () => {
      const index = parsers.indexOf(entry);
      if (index !== -1) parsers.splice(index, 1);
    };
  }

  registerParser({
    name: "pdf",
    label: "PDF",
    detect: (buffer) => isPdf(buffer),
    modulePath: path.join(PARSERS_DIR, "pdf.js"),
    options: { maxPages: limits.maxPdfPages },
  });
  registerParser({ name: "docx", label: "Word", detect: isDocx, modulePath: path.join(PARSERS_DIR, "docx.js") });
  registerParser({ name: "doc", label: "Word", detect: isDoc, modulePath: path.join(PARSERS_DIR, "doc.js") });
  registerParser({
    name: "text",
    label: "текстовый файл",
    detect: (buffer, name) => isPlainText(buffer, name),
    modulePath: path.join(PARSERS_DIR, "text.js"),
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    limits: { fileSize: limits.maxFileBytes, files: limits.maxFiles, fields: 10, parts: limits.maxFiles + 10 },
  });

  function uploadMiddleware(field = "files") {
    const handler = upload.array(field, limits.maxFiles);
    return (req, res, next) => {
      handler(req, res, (err) => {
        if (!err) return next();
        const messages = {
          LIMIT_FILE_SIZE: `Файл больше ${Math.round(limits.maxFileBytes / 1024 / 1024)} МБ`,
          LIMIT_FILE_COUNT: `Можно прикрепить не больше ${limits.maxFiles} файлов`,
          LIMIT_UNEXPECTED_FILE: `Можно прикрепить не больше ${limits.maxFiles} файлов`,
          LIMIT_PART_COUNT: "Слишком много частей в запросе",
        };
        res.status(400).json({ error: messages[err.code] || "Не удалось принять файлы" });
      });
    };
  }

  // Returns a public summary; the parsed content stays in the store.
  async function ingest(file) {
    const name = fileName(file.originalname);
    const buffer = file.buffer;
    const fail = (error) => ({ name, status: "error", error });
    if (!buffer?.length) return fail("файл пустой");

    const imageMime = detectImage(buffer);
    if (imageMime) {
      const dataUrl = `data:${imageMime};base64,${buffer.toString("base64")}`;
      const id = store.put({ name, kind: "image", label: "изображение", mime: imageMime, dataUrl });
      return { id, name, kind: "image", status: "ok" };
    }

    const parser = parsers.find((item) => item.detect(buffer, name));
    if (!parser) return fail("такой формат не поддерживается — подойдут PDF, Word, TXT или изображение");

    let raw;
    try {
      raw = await runner.run(parser.modulePath, buffer, parser.options);
    } catch (err) {
      logger.warn(`Не удалось прочитать «${name}» (${parser.name}): ${err.message}`);
      return fail(err.message);
    }
    const { text, truncated } = normalizeExtracted(raw, limits.maxTextChars);
    if (!text) {
      return fail(
        parser.name === "pdf"
          ? "в PDF нет текста (похоже на скан) — пришлите страницы как изображения"
          : "в файле нет текста"
      );
    }
    const id = store.put({ name, kind: "text", label: parser.label, text, truncated });
    return { id, name, kind: "text", status: "ok", truncated };
  }

  return {
    registerParser,
    uploadMiddleware,
    ingest,
    get: store.get,
    stats: store.stats,
    stop: () => {
      clearInterval(cleanup);
      return runner.stop();
    },
  };
}

module.exports = { createFiles, normalizeExtracted };
