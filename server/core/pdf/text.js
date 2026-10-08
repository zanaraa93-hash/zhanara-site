const path = require("path");
// fontkit ships with PDFKit; resolving it from there keeps it the same copy PDFKit uses.
const fontkit = require(require.resolve("fontkit", { paths: [path.dirname(require.resolve("pdfkit"))] }));
const { fontPaths } = require("./fonts");

const glyphFonts = new Map();
function glyphFont(name) {
  if (!glyphFonts.has(name)) glyphFonts.set(name, fontkit.openSync(fontPaths()[name]));
  return glyphFonts.get(name);
}

// Emoji and scripts the fonts do not cover would print as empty boxes, so such
// characters are dropped; line breaks from old records become plain spaces.
function fitText(value, fontName) {
  const font = glyphFont(fontName);
  return [...String(value ?? "").normalize("NFC")]
    .map((ch) => (/\s/.test(ch) ? " " : font.hasGlyphForCodePoint(ch.codePointAt(0)) ? ch : ""))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Same as fitText, but keeps paragraph breaks for multi-line fields.
function fitParagraphs(value, fontName) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => fitText(line, fontName))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { fitText, fitParagraphs };
