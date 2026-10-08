const mammoth = require("mammoth");

async function parse(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch {
    throw new Error("документ Word повреждён или не читается");
  }
}

module.exports = { parse };
