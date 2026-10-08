const { cleanText } = require("./text");

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

function formatPhoneDisplay(value) {
  const digits = normalizePhone(value);
  if (!digits) return cleanText(value, 40);
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

function isValidPhone(value) {
  const length = String(value || "").replace(/\D/g, "").length;
  return length >= 10 && length <= 15;
}

module.exports = { normalizePhone, formatPhoneDisplay, isValidPhone };
