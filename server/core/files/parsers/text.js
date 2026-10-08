// Russian .txt files saved on Windows are often in windows-1251, not UTF-8.
async function parse(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1251").decode(buffer);
  }
}

module.exports = { parse };
