const crypto = require("crypto");

// Parsed attachments live only in memory for a limited time: visitors' files
// are never written to disk. Oldest entries are evicted first when full.
function createAttachmentStore({ ttlMs, maxEntries, maxBytes, now = () => Date.now() }) {
  const entries = new Map();
  let totalBytes = 0;

  const sizeOf = (entry) => (entry.text?.length || 0) * 2 + (entry.dataUrl?.length || 0);

  function drop(id) {
    const entry = entries.get(id);
    if (!entry) return;
    totalBytes -= entry.bytes;
    entries.delete(id);
  }

  function purgeExpired() {
    const current = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= current) drop(id);
    }
  }

  function put(data) {
    purgeExpired();
    const id = crypto.randomBytes(16).toString("hex");
    const entry = { ...data, id, expiresAt: now() + ttlMs };
    entry.bytes = sizeOf(entry);
    entries.set(id, entry);
    totalBytes += entry.bytes;
    for (const oldId of entries.keys()) {
      if (entries.size <= maxEntries && totalBytes <= maxBytes) break;
      if (oldId !== id) drop(oldId);
    }
    return id;
  }

  function get(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      drop(id);
      return null;
    }
    return entry;
  }

  return { put, get, purgeExpired, stats: () => ({ entries: entries.size, bytes: totalBytes }) };
}

module.exports = { createAttachmentStore };
