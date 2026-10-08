const { PDFParse } = require("pdf-parse");

async function parse(buffer, { maxPages }) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // No page markers: otherwise a scan without text looks like "-- 1 of 1 --".
    const result = await parser.getText({ first: maxPages, pageJoiner: "" });
    return result.text || "";
  } catch (err) {
    if (err?.name === "PasswordException") throw new Error("PDF защищён паролем");
    throw new Error("PDF повреждён или не читается");
  } finally {
    await parser.destroy().catch(() => {});
  }
}

module.exports = { parse };
