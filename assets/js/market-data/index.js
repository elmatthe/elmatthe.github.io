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
import { createCache, safeStorage } from "./cache.js";
import { classifyFreshness } from "./contract.js";
import { createFxService } from "./fx.js";
import { AV_PROVIDER, AV_DAILY_LIMIT, createAlphaVantageClient, createUsageCounter, toAvSymbol, pickListing, parseGlobalQuote, parseSeries, validKey } from "./providers/alphavantage.js";

export { DataError } from "./http.js";
export { classifyFreshness, describeAge, FRESHNESS_LABEL, selectBasis, isoDay } from "./contract.js";
export { AV_DAILY_LIMIT, validKey } from "./providers/alphavantage.js";
export { fxSupported } from "./fx.js";

const SETTINGS_KEY = "md.settings.v1";

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

export function loadSettings(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SETTINGS_KEY) || "null") || {};
    return { alphaVantageKey: validKey(parsed.alphaVantageKey) ? parsed.alphaVantageKey.trim() : "" };
  } catch (_) {
    return { alphaVantageKey: "" };
  }
}

function saveSettings(storage, settings) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; } catch (_) { return false; }
}

// "daily" when the requested window fits Alpha Vantage's free daily series,
// otherwise "weekly" (adjusted closes).
export function historyKind(range) {
  return range.end.getTime() - range.start.getTime() <= DAILY_WINDOW_DAYS * DAY ? "daily" : "weekly";
}

export function createMarketData({ local = safeStorage("localStorage"), fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), sleep, minSpacingMs = 1200 } = {}) {
  let settings = loadSettings(local);
  const usage = createUsageCounter(local, { now });
  const listings = createCache({ storage: local, prefix: "md.av.listing.v1:", maxEntries: 200, now });
  const quotesCache = createCache({ storage: local, prefix: "md.av.quote.v1:", maxEntries: 120, now });
  const historyCache = createCache({ storage: local, prefix: "md.av.history.v1:", maxEntries: 40, now });
  const dedupe = createDeduper();
  const fx = createFxService({ fetchImpl, storage: local, now });
  let client = null;
  const getClient = () => {
    if (!validKey(settings.alphaVantageKey)) return null;
    if (!client) client = createAlphaVantageClient({ apiKey: settings.alphaVantageKey, fetchImpl, usage, now, minSpacingMs, ...(sleep ? { sleep } : {}) });
    return client;
  };
  const requireClient = () => {
    const c = getClient();
    if (!c) throw new DataError("Live prices need your own free Alpha Vantage API key (Settings). Until then, enter prices manually or import a CSV file.", { kind: "not_configured" });
    return c;
  };

  // Listing (name, region, currency) for an Alpha Vantage symbol. Cached 30 days;
  // a miss is cached for a day so a mistyped symbol does not drain the quota.
  async function listing(avSymbol, { signal } = {}) {
    const hit = listings.get(avSymbol, { freshMs: 30 * DAY });
    // Hits are kept 30 days; a miss only for a day.
    if (hit && (hit.value.found || hit.ageMs <= DAY)) return hit.value.found ? hit.value.listing : null;
    return forCaller(dedupe.run(`listing:${avSymbol}`, async () => {
      const c = requireClient();
      let found = pickListing(await c.search(avSymbol, { symbol: avSymbol }), avSymbol);
      const stem = avSymbol.includes(".") ? avSymbol.slice(0, avSymbol.lastIndexOf(".")) : null;
      if (!found && stem) found = pickListing(await c.search(stem, { symbol: avSymbol }), avSymbol);
      listings.set(avSymbol, found ? { found: true, listing: found } : { found: false });
      return found;
    }), signal);
  }

  const provenance = (extra = {}) => ({ provider: AV_PROVIDER, via: "your Alpha Vantage key", retrievedAt: new Date(now()).toISOString(), cached: false, stale: false, ageMs: 0, ...extra });

  async function quote(symbol, { signal, useCache = true } = {}) {
    const avSymbol = toAvSymbol(symbol);
    // A definitive "no data" answer is remembered for an hour so a mistyped ticker
    // does not spend the visitor's daily requests on every run.
    const miss = useCache ? quotesCache.get(`miss:${avSymbol}`, { freshMs: HOUR }) : null;
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = quotesCache.get(avSymbol, { freshMs: 15 * MINUTE, staleMs: DAY });
    if (useCache && hit?.fresh) return withFreshness({ quote: { ...hit.value, requestedSymbol: symbol }, provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) });
    return forCaller(dedupe.run(`quote:${avSymbol}`, async () => {
      try {
        const c = requireClient();
        const info = await listing(avSymbol);
        const q = parseGlobalQuote(await c.globalQuote(avSymbol, { symbol }), symbol, info || { avSymbol });
        q.currencyVerified = Boolean(info?.currency);
        quotesCache.set(avSymbol, q);
        return withFreshness({ quote: q, provenance: provenance() });
      } catch (error) {
        if (error?.kind === "not_found" && error.definitive) quotesCache.set(`miss:${avSymbol}`, { message: error.message });
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
      // continuing still serves every remaining symbol that is cached.
      try { out.set(symbol, await quote(symbol, { signal })); }
      catch (error) {
        if (error?.kind === "aborted") throw error;
        out.set(symbol, { error });
      }
    }
    return out;
  }

  // Price history for a window. Daily (as traded) when the window fits the free
  // daily series, otherwise weekly adjusted closes. Returns { history, provenance }.
  async function history(symbol, range, { signal } = {}) {
    const avSymbol = toAvSymbol(symbol);
    const kind = historyKind(range);
    const key = `${kind}:${avSymbol}`;
    const miss = quotesCache.get(`miss:${key}`, { freshMs: HOUR });
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = historyCache.get(key, { freshMs: 12 * HOUR, staleMs: 7 * DAY });
    const revive = value => ({ ...value, requestedSymbol: symbol, observations: value.observations.map(([d, c, a]) => ({ date: new Date(`${d}T00:00:00Z`), close: c, adjClose: a })) });
    if (hit?.fresh) return { history: revive(hit.value), provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) };
    return forCaller(dedupe.run(`history:${key}`, async () => {
      try {
        const c = requireClient();
        const info = await listing(avSymbol);
        const body = kind === "daily" ? await c.daily(avSymbol, { symbol }) : await c.weeklyAdjusted(avSymbol, { symbol });
        const h = parseSeries(body, symbol, info || { avSymbol }, kind);
        h.observations = dropUnfinished(h.observations, kind, now());
        h.currencyVerified = Boolean(info?.currency);
        // Keep six years: enough for the 5Y horizon, small enough for storage.
        const cutoff = now() - 6 * 366 * DAY;
        const packed = { ...h, observations: h.observations.filter(o => o.date.getTime() >= cutoff).map(o => [o.date.toISOString().slice(0, 10), o.close, o.adjClose]) };
        historyCache.set(key, packed);
        return { history: revive(packed), provenance: provenance() };
      } catch (error) {
        if (error?.kind === "not_found" && error.definitive) quotesCache.set(`miss:${key}`, { message: error.message });
        if (error?.kind !== "aborted" && error?.kind !== "not_found" && error?.kind !== "not_configured" && hit) {
          return { history: revive(hit.value), provenance: provenance({ cached: true, stale: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString(), refreshError: error.message }) };
        }
        throw error;
      }
    }), signal);
  }

  return {
    fx,
    quote,
    quotes,
    history,
    historyKind,
    get settings() { return { ...settings }; },
    liveAvailable: () => Boolean(getClient()),
    usage: () => ({ count: usage.count, limit: AV_DAILY_LIMIT }),
    setApiKey(key) {
      const trimmed = String(key || "").trim();
      if (trimmed && !validKey(trimmed)) throw new Error("That does not look like an Alpha Vantage API key (letters and digits only).");
      settings = { ...settings, alphaVantageKey: trimmed };
      client = null;
      return saveSettings(local, settings);
    },
    clearCache() { return quotesCache.clear() + historyCache.clear() + listings.clear() + fx.clear(); },
    cacheSize() { return quotesCache.size() + historyCache.size(); },
  };
}
