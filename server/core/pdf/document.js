const PDFDocument = require("pdfkit");
const brand = require("./brand");
const { fontPaths } = require("./fonts");

const PAGE = { width: 595.28, height: 841.89 };

// Creates an A4 document with the shared fonts, lets draw() fill it (it may be
// async) and resolves with the finished file. Nothing is written to disk.
function renderPdf({ title, subject, creationDate }, draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      bufferPages: true,
      info: {
        Title: title,
        Author: `${brand.name} · ${brand.tagline}`,
        Subject: subject,
        CreationDate: creationDate ? new Date(creationDate) : new Date(),
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    (async () => {
      Object.entries(fontPaths()).forEach(([name, file]) => doc.registerFont(name, file));
      await draw(doc);
      doc.end();
    })().catch(reject);
  });
}

module.exports = { PAGE, renderPdf };
