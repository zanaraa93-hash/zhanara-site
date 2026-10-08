// File type is decided by the bytes, never by the name or the browser-supplied
// MIME type: both are fully controlled by the uploader.
const startsWith = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, i) => buffer[offset + i] === byte);

const IMAGE_SIGNATURES = [
  { mime: "image/png", test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: "image/gif", test: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mime: "image/webp",
    test: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
];

function detectImage(buffer) {
  return IMAGE_SIGNATURES.find((sig) => sig.test(buffer))?.mime || "";
}

function isPdf(buffer) {
  return buffer.subarray(0, 1024).includes("%PDF-");
}

// DOCX is a ZIP archive; entry names are stored uncompressed in its headers.
function isDocx(buffer) {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) && buffer.includes("word/document.xml");
}

// Legacy .doc is an OLE compound file.
function isDoc(buffer) {
  return startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

const TEXT_EXTENSIONS = /\.(txt|md|csv)$/i;

function isPlainText(buffer, name) {
  if (!TEXT_EXTENSIONS.test(name || "")) return false;
  return !buffer.subarray(0, 8192).includes(0);
}

module.exports = { detectImage, isPdf, isDocx, isDoc, isPlainText };
