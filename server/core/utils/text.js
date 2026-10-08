function cleanText(value, max) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanMultiline(value, max) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function parseDeadline(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? "" : text;
}

function parseReference(value) {
  const text = cleanText(value, 300);
  if (!text) return "";
  // People paste "instagram.com/..." without a scheme.
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    const isWeb = url.protocol === "http:" || url.protocol === "https:";
    return isWeb && url.hostname.includes(".") ? url.href : "";
  } catch {
    return "";
  }
}

module.exports = { cleanText, cleanMultiline, parseDeadline, parseReference };
