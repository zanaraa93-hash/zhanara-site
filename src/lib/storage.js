export function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Returns false when the browser refused to save (private mode, full quota,
// storage disabled), so callers that depend on the value can react.
export function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`localStorage: не удалось сохранить ${key}:`, err?.name || err);
    return false;
  }
}
