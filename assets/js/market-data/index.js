// Market-data service used by the Portfolio Rebalancer and the Stock Comparison tool.
//
// Sources, in the order a tool uses them:
//   1. Exchange rates: official, keyless, CORS-enabled central-bank data
//      (Bank of Canada, falling back to the ECB) via ./fx.js. Always available.
//   2. Security prices: the visitor's OWN free Alpha Vantage key (optional). The key
//      and everything fetched with it stay in this browser.
//   3. Prices the visitor enters or imports (handled by each tool), and the
//      clearly labelled synthetic demo.
// There is no public relay or shared server in the path, and nothing here invents a
// price: when a source cannot answer, the caller gets a DataError to explain.

import { DataError, createDeduper } from "./http.js";
import { createCache, safeStorage, memoryStorage, storageKeys } from "./cache.js";
import { classifyFreshness } from "./contract.js";
import { createFxService } from "./fx.js";
import { AV_PROVIDER, AV_DAILY_LIMIT, createAlphaVantageClient, createUsageCounter, toAvSymbol, pickListing, parseGlobalQuote, parseSeries, validKey } from "./providers/alphavantage.js";

export { DataError } from "./http.js";
export { classifyFreshness, describeAge, FRESHNESS_LABEL, selectBasis, isoDay } from "./contract.js";
export { AV_DAILY_LIMIT, validKey } from "./providers/alphavantage.js";
export { fxSupported } from "./fx.js";

const SETTINGS_KEY = "md.settings.v1";
// Everything fetched with a key is stored under that key's own namespace,
// "md.av.v2.<fingerprint>.<kind>:", so data, misses and request counts are never
// shared between keys. Exchange rates need no key and keep their shared cache.
const AV_NAMESPACE = "md.av.v2.";
// Entries written before per-key namespaces existed (pre-release builds of this
// page); their key is unknown, so they are discarded on start.
const LEGACY_PREFIXES = ["md.av.listing.v1:", "md.av.quote.v1:", "md.av.history.v1:", "md.av.usage.v1"];
const KEY_CHANGED_MESSAGE = "Your Alpha Vantage key changed while this request was running. Nothing fetched with the previous key was used; run it again.";

// Short, non-reversible label for a key, used only to name its storage namespace.
// 32 bits of a 53-bit string hash (cyrb53): an Alpha Vantage key (16 characters,
// about 82 bits) has billions of strings with the same label, so the label cannot
// identify or recover the key, while two keys of one visitor colliding has a
// chance of about 1 in 4 billion. The raw key is never part of a storage name.
export function keyFingerprint(key) {
  const text = `md.av:${String(key || "").trim()}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `k${((h1 ^ h2) >>> 0).toString(36)}`;
}

// Resolves with `promise` unless this caller's own signal aborts first. Shared
// in-flight work is never cancelled by one caller.
function forCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DataError("Request cancelled.", { kind: "aborted" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DataError("Request cancelled.", { kind: "aborted" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(v => { signal.removeEventListener("abort", onAbort); resolve(v); }, e => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

// Drops observations for a period that may still be trading at `at`, so a cached
// series can never later present an unfinished bar as a completed close.
function dropUnfinished(observations, kind, at) {
  const day = new Date(at).toISOString().slice(0, 10);
  if (kind === "daily") return observations.filter(o => o.date.toISOString().slice(0, 10) < day);
  const weekday = new Date(at).getUTCDay();
  if (weekday === 0 || weekday === 6) return observations;
  const monday = new Date(Date.parse(`${day}T00:00:00Z`) - ((weekday + 6) % 7) * DAY);
  return observations.filter(o => o.date < monday);
}
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Alpha Vantage's free daily series ("compact") holds the latest ~100 sessions.
export const DAILY_WINDOW_DAYS = 135;

const readKey = storage => {
  try {
    const parsed = JSON.parse(storage?.getItem(SETTINGS_KEY) || "null") || {};
    return validKey(parsed.alphaVantageKey) ? parsed.alphaVantageKey.trim() : "";
  } catch (_) {
    return "";
  }
};
const writeKey = (storage, key) => {
  if (!storage) return false;
  try { storage.setItem(SETTINGS_KEY, JSON.stringify({ alphaVantageKey: key })); return true; } catch (_) { return false; }
};
const removeKey = storage => { try { storage?.removeItem(SETTINGS_KEY); } catch (_) { /* nothing stored */ } };

// How each storage choice is described to the visitor (shared by both tools).
export const KEY_STORAGE_TEXT = {
  local: "saved on this device (this browser's local storage) until you remove it",
  session: "kept for this tab only (session storage); the browser forgets it when the tab closes",
  memory: "kept only until you leave this page (browser storage is unavailable)",
};

// The visitor's key and where it is kept: "session" (this tab, until it closes),
// "local" (this browser, until removed) or "" when there is none. A session copy
// wins: it is the more recent, more specific choice for this tab.
export function loadSettings(local, session = null) {
  const fromSession = readKey(session);
  if (fromSession) return { alphaVantageKey: fromSession, persistence: "session" };
  const fromLocal = readKey(local);
  return fromLocal ? { alphaVantageKey: fromLocal, persistence: "local" } : { alphaVantageKey: "", persistence: "" };
}

// "daily" when the requested window fits Alpha Vantage's free daily series,
// otherwise "weekly" (adjusted closes).
export function historyKind(range) {
  return range.end.getTime() - range.start.getTime() <= DAILY_WINDOW_DAYS * DAY ? "daily" : "weekly";
}

export function createMarketData({ local = safeStorage("localStorage"), session: sessionStore = safeStorage("sessionStorage"), fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), sleep, minSpacingMs = 1200 } = {}) {
  // Without usable storage everything lives in memory for this page view, so the
  // request count and caches still work until the page is closed.
  const store = local || memoryStorage();
  let settings = loadSettings(local, sessionStore);
  const fx = createFxService({ fetchImpl, storage: store, now });
  const removeWhere = test => {
    let removed = 0;
    for (const k of storageKeys(store)) {
      if (!test(k)) continue;
      try { store.removeItem(k); removed += 1; } catch (_) { /* ignore */ }
    }
    return removed;
  };
  // Only the current key's responses are kept: data saved with any other key (or
  // with a session-only key whose tab has closed) is removed when the page loads and
  // whenever the key changes. Request counts are kept until their UTC day ends (they
  // hold no market data), so returning to a key the same day does not under-count.
  const purgeKeyData = keepFingerprint => removeWhere(k => k.startsWith(AV_NAMESPACE)
    && !k.endsWith(".usage") && !(keepFingerprint && k.startsWith(`${AV_NAMESPACE}${keepFingerprint}.`)));
  const today = new Date(now()).toISOString().slice(0, 10);
  removeWhere(k => {
    if (LEGACY_PREFIXES.some(p => k.startsWith(p))) return true;
    if (!k.startsWith(AV_NAMESPACE) || !k.endsWith(".usage")) return false;
    try { return JSON.parse(store.getItem(k) || "null")?.day !== today; } catch (_) { return true; }
  });
  purgeKeyData(settings.alphaVantageKey ? keyFingerprint(settings.alphaVantageKey) : null);

  // Everything that belongs to one key: its client (request spacing and limit
  // state), caches, request count and in-flight requests. A key change retires the
  // session: its requests are aborted and nothing it returns afterwards is used.
  let active = null;
  function keySession() {
    if (!validKey(settings.alphaVantageKey)) return null;
    if (active) return active;
    const fp = keyFingerprint(settings.alphaVantageKey);
    const ns = `${AV_NAMESPACE}${fp}.`;
    const usage = createUsageCounter(store, { now, key: `${ns}usage` });
    active = {
      fp, usage, retired: false, controller: new AbortController(), dedupe: createDeduper(),
      listings: createCache({ storage: store, prefix: `${ns}listing:`, maxEntries: 200, now }),
      quotes: createCache({ storage: store, prefix: `${ns}quote:`, maxEntries: 120, now }),
      history: createCache({ storage: store, prefix: `${ns}history:`, maxEntries: 40, now }),
      client: createAlphaVantageClient({ apiKey: settings.alphaVantageKey, fetchImpl, usage, now, minSpacingMs, ...(sleep ? { sleep } : {}) }),
    };
    return active;
  }
  const keyChanged = () => new DataError(KEY_CHANGED_MESSAGE, { kind: "key_changed", provider: AV_PROVIDER });
  const notConfigured = () => new DataError("Live prices need your own free Alpha Vantage API key (Settings). Until then, enter prices manually or import a CSV file.", { kind: "not_configured" });
  const requireSession = () => {
    const s = keySession();
    if (!s) throw notConfigured();
    return s;
  };
  // Throws if the key changed since `s` started, so a late answer can never be
  // labelled, cached or counted as coming from the current key.
  const ensureCurrent = s => { if (s.retired) throw keyChanged(); };
  const callOpts = (s, symbol) => ({ symbol, signal: s.controller.signal });

  // Listing (name, region, currency) for an Alpha Vantage symbol. Hits are cached
  // 30 days; a miss only for a day, so a mistyped symbol does not drain the quota.
  async function listing(s, avSymbol) {
    const hit = s.listings.get(avSymbol, { freshMs: 30 * DAY });
    if (hit && (hit.value.found || hit.ageMs <= DAY)) return hit.value.found ? hit.value.listing : null;
    return s.dedupe.run(`listing:${avSymbol}`, async () => {
      let found = pickListing(await s.client.search(avSymbol, callOpts(s, avSymbol)), avSymbol);
      ensureCurrent(s);
      const stem = avSymbol.includes(".") ? avSymbol.slice(0, avSymbol.lastIndexOf(".")) : null;
      if (!found && stem) found = pickListing(await s.client.search(stem, callOpts(s, avSymbol)), avSymbol);
      ensureCurrent(s);
      s.listings.set(avSymbol, found ? { found: true, listing: found } : { found: false });
      return found;
    });
  }

  const provenance = (extra = {}) => ({ provider: AV_PROVIDER, via: "your Alpha Vantage key", retrievedAt: new Date(now()).toISOString(), cached: false, stale: false, ageMs: 0, ...extra });

  async function quote(symbol, { signal, useCache = true } = {}) {
    const avSymbol = toAvSymbol(symbol);
    const s = requireSession();
    // A definitive "no data" answer is remembered for an hour so a mistyped ticker
    // does not spend the visitor's daily requests on every run.
    const miss = useCache ? s.quotes.get(`miss:${avSymbol}`, { freshMs: HOUR }) : null;
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = s.quotes.get(avSymbol, { freshMs: 15 * MINUTE, staleMs: DAY });
    if (useCache && hit?.fresh) return withFreshness({ quote: { ...hit.value, requestedSymbol: symbol }, provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) });
    return forCaller(s.dedupe.run(`quote:${avSymbol}`, async () => {
      try {
        const info = await listing(s, avSymbol);
        const q = parseGlobalQuote(await s.client.globalQuote(avSymbol, callOpts(s, symbol)), symbol, info || { avSymbol });
        ensureCurrent(s);
        q.currencyVerified = Boolean(info?.currency);
        s.quotes.set(avSymbol, q);
        return withFreshness({ quote: q, provenance: provenance() });
      } catch (error) {
        if (s.retired) throw keyChanged();
        if (error?.kind === "not_found" && error.definitive) s.quotes.set(`miss:${avSymbol}`, { message: error.message });
        if (error?.kind !== "aborted" && error?.kind !== "not_found" && error?.kind !== "not_configured" && hit) {
          return withFreshness({ quote: { ...hit.value, requestedSymbol: symbol }, provenance: provenance({ cached: true, stale: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString(), refreshError: error.message }) });
        }
        throw error;
      }
    }), signal);
  }

  function withFreshness(result) {
    const q = result.quote;
    // Alpha Vantage gives a trading day, not a time: judge age from the end of that day.
    const at = q.priceTime || (q.sessionDate ? `${q.sessionDate}T23:59:59Z` : null);
    return { ...result, freshness: classifyFreshness(at, now()) };
  }

  async function quotes(symbols, { signal, onProgress } = {}) {
    const out = new Map();
    const unique = [...new Set(symbols)];
    for (const [i, symbol] of unique.entries()) {
      onProgress?.(symbol, i, unique.length);
      // After a daily limit or key rejection the client sends no further requests, so
      // continuing still serves every remaining symbol that is cached. A key change
      // stops the batch: one run never mixes results from two keys.
      try { out.set(symbol, await quote(symbol, { signal })); }
      catch (error) {
        if (error?.kind === "aborted" || error?.kind === "key_changed") throw error;
        out.set(symbol, { error });
      }
    }
    return out;
  }

  // Price history for a window. Daily (as traded) when the window fits the free
  // daily series, otherwise weekly adjusted closes. Returns { history, provenance }.
  async function history(symbol, range, { signal } = {}) {
    const avSymbol = toAvSymbol(symbol);
    const s = requireSession();
    const kind = historyKind(range);
    const key = `${kind}:${avSymbol}`;
    const miss = s.quotes.get(`miss:${key}`, { freshMs: HOUR });
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = s.history.get(key, { freshMs: 12 * HOUR, staleMs: 7 * DAY });
    const revive = value => ({ ...value, requestedSymbol: symbol, observations: value.observations.map(([d, c, a]) => ({ date: new Date(`${d}T00:00:00Z`), close: c, adjClose: a })) });
    if (hit?.fresh) return { history: revive(hit.value), provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) };
    return forCaller(s.dedupe.run(`history:${key}`, async () => {
      try {
        const info = await listing(s, avSymbol);
        const body = kind === "daily" ? await s.client.daily(avSymbol, callOpts(s, symbol)) : await s.client.weeklyAdjusted(avSymbol, callOpts(s, symbol));
        ensureCurrent(s);
        const h = parseSeries(body, symbol, info || { avSymbol }, kind);
        h.observations = dropUnfinished(h.observations, kind, now());
        h.currencyVerified = Boolean(info?.currency);
        // Keep six years: enough for the 5Y horizon, small enough for storage.
        const cutoff = now() - 6 * 366 * DAY;
        const packed = { ...h, observations: h.observations.filter(o => o.date.getTime() >= cutoff).map(o => [o.date.toISOString().slice(0, 10), o.close, o.adjClose]) };
        s.history.set(key, packed);
        return { history: revive(packed), provenance: provenance() };
      } catch (error) {
        if (s.retired) throw keyChanged();
        if (error?.kind === "not_found" && error.definitive) s.quotes.set(`miss:${key}`, { message: error.message });
        if (error?.kind !== "aborted" && error?.kind !== "not_found" && error?.kind !== "not_configured" && hit) {
          return { history: revive(hit.value), provenance: provenance({ cached: true, stale: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString(), refreshError: error.message }) };
        }
        throw error;
      }
    }), signal);
  }

  // Stores (or removes, with "") the visitor's key. remember: true keeps it in this
  // browser's local storage until removed; false keeps it in session storage, which
  // the browser clears when the tab closes. Saving one way removes any copy saved
  // the other way. Returns { persistence, saved }: persistence is where the key
  // ended up ("local", "session", "memory" when storage is unavailable, or "").
  function setApiKey(key, { remember = true } = {}) {
    const trimmed = String(key || "").trim();
    if (trimmed && !validKey(trimmed)) throw new Error("That does not look like an Alpha Vantage API key (letters and digits only).");
    let persistence = "";
    if (trimmed) {
      // If the chosen storage refuses the write, the key is kept in memory for this
      // page only; it is never silently written to the other storage.
      persistence = writeKey(remember ? local : sessionStore, trimmed) ? (remember ? "local" : "session") : "memory";
      removeKey(remember ? sessionStore : local);
    } else {
      removeKey(local);
      removeKey(sessionStore);
    }
    if (trimmed !== settings.alphaVantageKey) {
      if (active) {
        active.retired = true;
        active.controller.abort(keyChanged());
        active = null;
      }
      purgeKeyData(trimmed ? keyFingerprint(trimmed) : null);
    }
    settings = { alphaVantageKey: trimmed, persistence };
    return { persistence, saved: persistence === "local" || persistence === "session" };
  }

  return {
    fx,
    quote,
    quotes,
    history,
    historyKind,
    // Where the key is kept; the key itself is not exposed.
    get settings() { return { hasKey: validKey(settings.alphaVantageKey), persistence: settings.persistence }; },
    liveAvailable: () => Boolean(keySession()?.client),
    usage: () => ({ count: keySession()?.usage.count ?? 0, limit: AV_DAILY_LIMIT }),
    setApiKey,
    // Removes saved responses for every key (and saved exchange rates). Request
    // counts are kept so the daily estimate stays honest.
    clearCache() { return purgeKeyData(null) + fx.clear(); },
    cacheSize() { const s = keySession(); return s ? s.quotes.size() + s.history.size() : 0; },
  };
}
