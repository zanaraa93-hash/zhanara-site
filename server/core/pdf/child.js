// Builds one PDF in a separate process. PDFKit decodes PNGs with png-js,
// which throws zlib errors from an async callback: in the server process a
// single broken photo would be an uncaught exception that stops the site.
// argv[2] is the renderer module chosen by server code, never by a request.
const PNG = require("png-js");
const { loadUploadImage } = require("./images");

const PNG_PROBE_TIMEOUT_MS = 5000;

let probeFailed = null;
let replied = false;

function reply(message, code = 0) {
  if (replied) return;
  replied = true;
  process.send(message, () => process.exit(code));
}

process.on("uncaughtException", (err) => {
  if (probeFailed) return probeFailed(err);
  reply({ ok: false, error: String(err?.message || err) }, 1);
});

// Nobody is waiting for the file any more (timeout or server stop).
process.on("disconnect", () => process.exit(0));

const { render } = require(process.argv[2]);

// Decodes the PNG the same way PDFKit will, so a broken file is caught here
// and replaced by a placeholder instead of failing the whole document later.
function probePng(buffer) {
  return new Promise((resolve) => {
    let timer;
    const done = (ok) => {
      clearTimeout(timer);
      probeFailed = null;
      resolve(ok);
    };
    probeFailed = () => done(false);
    timer = setTimeout(() => done(false), PNG_PROBE_TIMEOUT_MS);
    try {
      new PNG(buffer).decodePixels(() => done(true));
    } catch {
      done(false);
    }
  });
}

// Returns { buffer } (null when no image is set) or { error } with a reason.
async function loadImage(image, uploadsDir) {
  const loaded = await loadUploadImage(image, uploadsDir);
  if (loaded.error || !loaded.buffer) return loaded;
  if (loaded.mime === "image/png" && !(await probePng(loaded.buffer))) return { error: "PNG повреждён" };
  return { buffer: loaded.buffer };
}

process.once("message", async (job) => {
  const warnings = [];
  try {
    const pdf = await render(job, { loadImage, warn: (message) => warnings.push(String(message)) });
    reply({ ok: true, pdf, warnings });
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) }, 1);
  }
});
