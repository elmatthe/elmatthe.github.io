// Small bounded key/value cache over Web Storage (or an in-memory fallback).
//
// Entries carry their own savedAt timestamp. Callers decide freshness:
//   fresh  - age <= freshMs: use without a request;
//   stale  - age <= staleMs: use only when a refresh fails (stale-if-error), and the
//            UI must say the value is cached and how old it is;
//   expired - removed on read.
// Only market data is stored here (symbols, prices, FX). Portfolio holdings and
// analysis inputs are never written to storage by this module.

export function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

export function safeStorage(kind) {
  try {
    const store = globalThis[kind];
    if (!store) return null;
    const probe = "__md_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch (_) {
    return null; // private mode, disabled storage, or a sandboxed frame
  }
}

export function createCache({ storage = null, prefix = "md.cache.v1:", maxEntries = 60, now = () => Date.now() } = {}) {
  const store = storage || memoryStorage();
  const keys = () => {
    const out = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
    return out;
  };
  function readRaw(fullKey) {
    try {
      const entry = JSON.parse(store.getItem(fullKey) || "null");
      return entry && typeof entry.savedAt === "number" && "value" in entry ? entry : null;
    } catch (_) {
      return null;
    }
  }
  function evict(count) {
    const entries = keys().map(key => ({ key, savedAt: readRaw(key)?.savedAt ?? 0 })).sort((a, b) => a.savedAt - b.savedAt);
    entries.slice(0, count).forEach(e => { try { store.removeItem(e.key); } catch (_) { /* ignore */ } });
  }
  return {
    // Returns { value, savedAt, ageMs, fresh } or null. Entries older than staleMs are removed.
    get(key, { freshMs, staleMs = freshMs } = {}) {
      const fullKey = prefix + key;
      const entry = readRaw(fullKey);
      if (!entry) return null;
      const ageMs = now() - entry.savedAt;
      if (ageMs < 0 || ageMs > staleMs) {
        try { store.removeItem(fullKey); } catch (_) { /* ignore */ }
        return null;
      }
      return { value: entry.value, savedAt: entry.savedAt, ageMs, fresh: ageMs <= freshMs };
    },
    set(key, value) {
      const payload = JSON.stringify({ savedAt: now(), value });
      const existing = keys();
      if (existing.length >= maxEntries && !existing.includes(prefix + key)) evict(existing.length - maxEntries + 1);
      try {
        store.setItem(prefix + key, payload);
        return true;
      } catch (_) {
        // Quota exceeded: drop the older half and try once more; caching is optional.
        evict(Math.ceil(keys().length / 2));
        try { store.setItem(prefix + key, payload); return true; } catch (__) { return false; }
      }
    },
    remove(key) { try { store.removeItem(prefix + key); } catch (_) { /* ignore */ } },
    clear() { const all = keys(); all.forEach(k => { try { store.removeItem(k); } catch (_) { /* ignore */ } }); return all.length; },
    size() { return keys().length; },
  };
}
