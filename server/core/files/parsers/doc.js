const WordExtractor = require("word-extractor");

async function parse(buffer) {
  try {
    const doc = await new WordExtractor().extract(buffer);
    return doc.getBody() || "";
  } catch {
    throw new Error("документ Word (.doc) повреждён или не читается");
  }
}

module.exports = { parse };
