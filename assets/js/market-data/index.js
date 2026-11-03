// Market-data service used by the Portfolio Rebalancer and the Stock Comparison tool.
//
// Sources, in the order a tool uses them:
//   1. Exchange rates: official, keyless, CORS-enabled central-bank data
//      (Bank of Canada, falling back to the ECB) via ./fx.js. Always available.
//   2. Security prices: the visitor's OWN keys for the providers in ./catalog.js
//      (Alpha Vantage, Marketstack, Finnhub; see _tools/PROVIDER_MATRIX.md). Keys and
//      everything fetched with them stay in this browser; each key has its own
//      storage namespace, request pacing and request count.
//   3. Prices the visitor deliberately enters or imports (handled by each tool), and
//      the clearly labelled synthetic demo of the Stock tool.
// There is no public relay or shared server in the path, and nothing here invents a
// price: when a source cannot answer, the caller gets a DataError that explains why.

import { DataError, createDeduper, fetchText, httpError } from "./http.js";
import { createCache, safeStorage, memoryStorage, storageKeys } from "./cache.js";
import { classifyFreshness } from "./contract.js";
import { createFxService } from "./fx.js";
import { createScheduler } from "./scheduler.js";
import { PROVIDERS, PROVIDER_IDS, CATALOG_VERSION, planOf, routeInstrument, providerAvailable, isUsVenue } from "./catalog.js";
import { ADAPTERS, normalizeCurrency } from "./providers/quote-adapters.js";
import { createInstrumentResolver, loadInstrumentReference } from "./instruments.js";
import { AV_PROVIDER, AV_DAILY_LIMIT, createAlphaVantageClient, createUsageCounter, toAvSymbol, pickListing, parseGlobalQuote, parseSeries, validKey, redactKey } from "./providers/alphavantage.js";

export { DataError } from "./http.js";
export { classifyFreshness, describeAge, FRESHNESS_LABEL, selectBasis, isoDay } from "./contract.js";
export { AV_DAILY_LIMIT, validKey } from "./providers/alphavantage.js";
export { fxSupported } from "./fx.js";
export { PROVIDERS, PROVIDER_IDS, planOf, providerAvailable } from "./catalog.js";

export const QUOTE_SCHEMA = "md.quote.v1";
const LEGACY_SETTINGS_KEY = "md.settings.v1";
const KEY_PREFIX = "md.key.v2."; // + provider id, in session or local storage
const PREFS_KEY = "md.prefs.v2"; // routing and plan choices (no secrets), local storage
// Everything fetched with a key is stored under "md.<provider>.v2.<fingerprint>.", so
// data, misses and request counts are never shared between keys. Alpha Vantage keeps
// its historical prefix "md.av.v2." so earlier caches of the same key remain valid.
const NAMESPACE = id => (id === "alphavantage" ? "md.av.v2." : `md.${id}.v2.`);
const LEGACY_PREFIXES = ["md.av.listing.v1:", "md.av.quote.v1:", "md.av.history.v1:", "md.av.usage.v1"];
const KEY_CHANGED_MESSAGE = "Your API key changed while this request was running. Nothing fetched with the previous key was used; run it again.";

// Short, non-reversible label for a key, used only to name its storage namespace.
// 32 bits of a 53-bit string hash (cyrb53): a 16-character key has billions of strings
// with the same label, so the label cannot identify or recover the key. The raw key
// is never part of a storage name.
export function keyFingerprint(key, provider = "alphavantage") {
  const text = `${provider === "alphavantage" ? "md.av" : `md.${provider}`}:${String(key || "").trim()}`;
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
// Quotes are reused for this long without a request (end-of-day prices change once a day).
const QUOTE_FRESH_MS = { last_trade: 10 * MINUTE, latest_trading_day: 4 * HOUR, eod_close: 4 * HOUR, previous_close: 4 * HOUR };

const validProviderKey = (id, key) => typeof key === "string" && (PROVIDERS[id]?.keyPattern || /^[A-Za-z0-9]{8,64}$/).test(key.trim());

const readText = (storage, name) => { try { return storage?.getItem(name) ?? null; } catch (_) { return null; } };
const writeText = (storage, name, value) => { if (!storage) return false; try { storage.setItem(name, value); return true; } catch (_) { return false; } };
const removeItem = (storage, name) => { try { storage?.removeItem(name); } catch (_) { /* nothing stored */ } };

// How each storage choice is described to the visitor (shared by both tools).
export const KEY_STORAGE_TEXT = {
  local: "saved on this device (this browser's local storage) until you remove it",
  session: "kept for this tab only (session storage); the browser forgets it when the tab closes",
  memory: "kept only until you leave this page (browser storage is unavailable)",
};

// Moves a key saved by the previous version ({ alphaVantageKey } in md.settings.v1)
// to the per-provider slot, in the same storage it was in.
function migrateLegacyKey(store) {
  if (!store) return;
  const raw = readText(store, LEGACY_SETTINGS_KEY);
  if (!raw) return;
  try {
    const key = JSON.parse(raw)?.alphaVantageKey;
    if (validKey(key) && !readText(store, `${KEY_PREFIX}alphavantage`)) writeText(store, `${KEY_PREFIX}alphavantage`, key.trim());
  } catch (_) { /* unreadable: dropped */ }
  removeItem(store, LEGACY_SETTINGS_KEY);
}

// The visitor's Alpha Vantage key and where it is kept (compatibility helper).
export function loadSettings(local, session = null) {
  migrateLegacyKey(session);
  migrateLegacyKey(local);
  const s = readText(session, `${KEY_PREFIX}alphavantage`);
  if (validKey(s)) return { alphaVantageKey: s.trim(), persistence: "session" };
  const l = readText(local, `${KEY_PREFIX}alphavantage`);
  return validKey(l) ? { alphaVantageKey: l.trim(), persistence: "local" } : { alphaVantageKey: "", persistence: "" };
}

// "daily" when the requested window fits Alpha Vantage's free daily series,
// otherwise "weekly" (adjusted closes).
export function historyKind(range) {
  return range.end.getTime() - range.start.getTime() <= DAILY_WINDOW_DAYS * DAY ? "daily" : "weekly";
}

// Comparison of two quotes for the same instrument (optional cross-check). Never
// averages them; the plan always uses the row's chosen provider.
export function compareQuotes(a, b) {
  const out = { a, b, comparable: false, reason: null, diffPct: null, label: null, causes: [] };
  if (a.canonicalId !== b.canonicalId) { out.reason = "different instruments"; return out; }
  if (a.nativeCurrency !== b.nativeCurrency) { out.reason = `different currencies (${a.nativeCurrency} vs ${b.nativeCurrency})`; return out; }
  const closes = new Set(["eod_close", "latest_trading_day", "previous_close"]);
  const sameType = a.priceType === b.priceType || (closes.has(a.priceType) && closes.has(b.priceType));
  if (!sameType) { out.reason = `different price types (${a.priceType} vs ${b.priceType})`; return out; }
  if (a.tradingDate !== b.tradingDate) { out.reason = `different sessions (${a.tradingDate} vs ${b.tradingDate})`; return out; }
  out.comparable = true;
  out.diffPct = ((a.nativePriceMajorUnits - b.nativePriceMajorUnits) / b.nativePriceMajorUnits) * 100;
  const abs = Math.abs(out.diffPct);
  out.label = abs <= 0.10 ? "Consistent" : abs <= 1 ? "Minor difference" : "Investigate";
  if (out.label === "Investigate") {
    const ratio = a.nativePriceMajorUnits / b.nativePriceMajorUnits;
    const near = x => Math.abs(ratio - x) / x < 0.02 || Math.abs(1 / ratio - x) / x < 0.02;
    if (near(100)) out.causes.push("a factor of 100: pence vs pounds (unit problem)");
    if ([1.25, 1.5, 2, 3, 4, 5, 10].some(near)) out.causes.push("a ratio like a stock split: one source may be adjusted");
    out.causes.push("a corporate action on that date", "a stale feed at one source", "a different listing");
  }
  return out;
}

export function createMarketData({
  local = safeStorage("localStorage"),
  session: sessionStore = safeStorage("sessionStorage"),
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = () => Date.now(),
  sleep,
  random = Math.random,
  locks = globalThis.navigator?.locks,
  minSpacingMs = null, // tests only: overrides every provider's pacing
  reference = null, // instrument reference object (tests); the site loads the shipped JSON
  platform = "browser",
  referenceFetch = (...a) => globalThis.fetch(...a),
} = {}) {
  // Without usable storage everything lives in memory for this page view, so request
  // counts and caches still work until the page is closed.
  const store = local || memoryStorage();
  const fx = createFxService({ fetchImpl, storage: store, now });
  const sleeper = sleep || ((ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DataError("Request cancelled.", { kind: "aborted" })); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); reject(new DataError("Request cancelled.", { kind: "aborted" })); }, { once: true });
  }));

  migrateLegacyKey(sessionStore);
  migrateLegacyKey(local);

  // ---------------------------------------------------------------- keys and preferences
  const keys = {};
  for (const id of PROVIDER_IDS) {
    if (!providerAvailable(id, platform)) continue;
    const s = readText(sessionStore, `${KEY_PREFIX}${id}`);
    const l = readText(local, `${KEY_PREFIX}${id}`);
    if (validProviderKey(id, s)) keys[id] = { key: s.trim(), persistence: "session" };
    else if (validProviderKey(id, l)) keys[id] = { key: l.trim(), persistence: "local" };
  }
  let prefs = { routing: "auto", fallback: false, plans: {} };
  try {
    const saved = JSON.parse(readText(store, PREFS_KEY) || "null");
    if (saved && typeof saved === "object") prefs = { routing: typeof saved.routing === "string" ? saved.routing : "auto", fallback: saved.fallback === true, plans: saved.plans && typeof saved.plans === "object" ? saved.plans : {} };
  } catch (_) { /* defaults */ }
  if (prefs.routing !== "auto" && !providerAvailable(prefs.routing, platform)) prefs.routing = "auto";
  const savePrefs = () => writeText(store, PREFS_KEY, JSON.stringify(prefs));
  const planFor = id => planOf(id, prefs.plans[id]?.id, prefs.plans[id] || {});

  // ---------------------------------------------------------------- storage hygiene
  const removeWhere = test => {
    let removed = 0;
    for (const k of storageKeys(store)) {
      if (!test(k)) continue;
      try { store.removeItem(k); removed += 1; } catch (_) { /* ignore */ }
    }
    return removed;
  };
  const namespaces = PROVIDER_IDS.map(id => [id, NAMESPACE(id)]);
  // Only the current key's responses are kept: data saved with any other key (or with
  // a session-only key whose tab has closed) is removed on load and whenever a key
  // changes. Request counts are kept until their UTC month ends (they hold no market
  // data) unless the key is removed.
  const purgeKeyData = (id, keepFingerprint, { counts = false } = {}) => {
    const ns = NAMESPACE(id);
    return removeWhere(k => k.startsWith(ns) && (counts || !k.endsWith(".usage")) && !(keepFingerprint && k.startsWith(`${ns}${keepFingerprint}.`)));
  };
  removeWhere(k => LEGACY_PREFIXES.some(p => k.startsWith(p)));
  const month = new Date(now()).toISOString().slice(0, 7);
  removeWhere(k => {
    const ns = namespaces.find(([, prefix]) => k.startsWith(prefix));
    if (!ns || !k.endsWith(".usage")) return false;
    try {
      const entry = JSON.parse(store.getItem(k) || "null");
      return !(entry && (entry.month === month || String(entry.day || "").slice(0, 7) === month));
    } catch (_) { return true; }
  });
  for (const id of PROVIDER_IDS) purgeKeyData(id, keys[id] ? keyFingerprint(keys[id].key, id) : null);

  // ---------------------------------------------------------------- per-key sessions
  // Everything that belongs to one key: request pacing, request count, limit record,
  // caches and in-flight requests. A key change retires the session: its requests are
  // aborted and nothing it returns afterwards is used.
  const sessions = {};
  function session(id) {
    const entry = keys[id];
    if (!entry) return null;
    if (sessions[id]) return sessions[id];
    const fp = keyFingerprint(entry.key, id);
    const ns = `${NAMESPACE(id)}${fp}.`;
    const plan = planFor(id);
    const pacing = minSpacingMs === null ? plan.pacing : { minSpacingMs };
    const s = {
      id, fp, key: entry.key, plan, retired: false, rejected: false, controller: new AbortController(), dedupe: createDeduper(),
      usage: createUsageCounter(store, { now, key: `${ns}usage` }),
      scheduler: createScheduler({ name: `${id}.${fp}`, ...pacing, storage: store, now, sleep: sleeper, random, locks }),
      listings: createCache({ storage: store, prefix: `${ns}listing:`, maxEntries: 200, now }),
      quotes: createCache({ storage: store, prefix: `${ns}quote:`, maxEntries: 150, now }),
      history: createCache({ storage: store, prefix: `${ns}history:`, maxEntries: 40, now }),
    };
    if (id === "alphavantage") s.client = createAlphaVantageClient({ apiKey: entry.key, fetchImpl, usage: s.usage, scheduler: s.scheduler, now, sleep: sleeper });
    sessions[id] = s;
    return s;
  }
  const retire = id => {
    const s = sessions[id];
    if (!s) return;
    s.retired = true;
    s.controller.abort(new DataError(KEY_CHANGED_MESSAGE, { kind: "key_changed", provider: PROVIDERS[id].name }));
    delete sessions[id];
  };
  const keyChanged = id => new DataError(KEY_CHANGED_MESSAGE, { kind: "key_changed", provider: PROVIDERS[id].name });
  const ensureCurrent = s => { if (s.retired) throw keyChanged(s.id); };
  // ---------------------------------------------------------------- instruments
  // The curated identity reference is a static file of this site, loaded on first use
  // with the page's own fetch (never through a provider path).
  let resolver = reference ? createInstrumentResolver(reference) : null;
  let readyPromise = null;
  const ready = () => (readyPromise ||= resolver ? Promise.resolve(true) : loadInstrumentReference({ fetchImpl: referenceFetch })
    .then(ref => { resolver = createInstrumentResolver(ref); return true; })
    .catch(() => false));
  const resolve = text => {
    if (!resolver) throw new DataError("The instrument reference has not loaded yet.", { kind: "unavailable" });
    return resolver.resolve(text);
  };

  // ---------------------------------------------------------------- Alpha Vantage specifics
  const avNotConfigured = () => new DataError("Live prices need your own free Alpha Vantage API key (Settings). Until then, enter prices manually or import a CSV file.", { kind: "not_configured", provider: AV_PROVIDER });
  const requireAv = () => { const s = session("alphavantage"); if (!s) throw avNotConfigured(); return s; };
  // Shared (deduplicated) work listens only to the key session's controller: one
  // caller cancelling never cancels a request another caller is waiting for.
  const avOpts = (s, symbol) => ({ symbol, signal: s.controller.signal });

  // Listing (name, region, currency) for an Alpha Vantage symbol, from SYMBOL_SEARCH.
  // Only an exact match for the suffixed symbol counts. When the suffixed search lists
  // nothing, one search on the bare stem is tried (Alpha Vantage often lists ".TRT"
  // symbols only under the stem); the match must still be the exact suffixed symbol.
  // Hits are cached 180 days, misses a day.
  async function avListing(s, avSymbol) {
    const hit = s.listings.get(avSymbol, { freshMs: 180 * DAY });
    if (hit && (hit.value.found || hit.ageMs <= DAY)) return hit.value.found ? hit.value.listing : null;
    return s.dedupe.run(`listing:${avSymbol}`, async () => {
      let found = pickListing(await s.client.search(avSymbol, avOpts(s, avSymbol)), avSymbol);
      ensureCurrent(s);
      const stem = avSymbol.includes(".") ? avSymbol.slice(0, avSymbol.lastIndexOf(".")) : null;
      if (!found && stem) found = pickListing(await s.client.search(stem, avOpts(s, avSymbol)), avSymbol);
      ensureCurrent(s);
      s.listings.set(avSymbol, found ? { found: true, listing: found } : { found: false });
      return found;
    });
  }
  const avListingCached = avSymbol => Boolean(sessions.alphavantage?.listings.get(avSymbol, { freshMs: 180 * DAY })?.value?.found);

  const provenance = (extra = {}) => ({ provider: AV_PROVIDER, via: "your Alpha Vantage key", retrievedAt: new Date(now()).toISOString(), cached: false, stale: false, ageMs: 0, ...extra });

  function withFreshness(result) {
    const q = result.quote;
    // Alpha Vantage gives a trading day, not a time: judge age from the end of that day.
    const at = q.priceTime || (q.sessionDate ? `${q.sessionDate}T23:59:59Z` : null);
    return { ...result, freshness: classifyFreshness(at, now()) };
  }

  // Legacy single-symbol quote (Stock tool snapshot): { quote, provenance, freshness }.
  async function quote(symbol, { signal, useCache = true } = {}) {
    const avSymbol = toAvSymbol(symbol);
    const s = requireAv();
    const miss = useCache ? s.quotes.get(`miss:${avSymbol}`, { freshMs: HOUR }) : null;
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = s.quotes.get(`legacy:${avSymbol}`, { freshMs: 15 * MINUTE, staleMs: DAY });
    if (useCache && hit?.fresh) return withFreshness({ quote: { ...hit.value, requestedSymbol: symbol }, provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) });
    return forCaller(s.dedupe.run(`quote:${avSymbol}`, async () => {
      try {
        const info = await avListing(s, avSymbol);
        const q = parseGlobalQuote(await s.client.globalQuote(avSymbol, avOpts(s, symbol)), symbol, info || { avSymbol });
        ensureCurrent(s);
        q.currencyVerified = Boolean(info?.currency);
        s.quotes.set(`legacy:${avSymbol}`, q);
        return withFreshness({ quote: q, provenance: provenance() });
      } catch (error) {
        if (s.retired) throw keyChanged("alphavantage");
        if (error?.kind === "not_found" && error.definitive) s.quotes.set(`miss:${avSymbol}`, { message: error.message });
        if (!["aborted", "not_found", "not_configured"].includes(error?.kind) && hit) {
          return withFreshness({ quote: { ...hit.value, requestedSymbol: symbol }, provenance: provenance({ cached: true, stale: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString(), refreshError: error.message }) });
        }
        throw error;
      }
    }), signal);
  }

  async function quotes(symbols, { signal, onProgress } = {}) {
    const out = new Map();
    const unique = [...new Set(symbols)];
    for (const [i, symbol] of unique.entries()) {
      onProgress?.(symbol, i, unique.length);
      try { out.set(symbol, await quote(symbol, { signal })); }
      catch (error) {
        if (error?.kind === "aborted" || error?.kind === "key_changed") throw error;
        out.set(symbol, { error });
      }
    }
    return out;
  }

  // Price history for a window (Alpha Vantage). Daily (as traded) when the window fits
  // the free daily series, otherwise weekly adjusted closes. Returns { history, provenance }.
  async function history(symbol, range, { signal } = {}) {
    const avSymbol = toAvSymbol(symbol);
    const s = requireAv();
    const kind = historyKind(range);
    const key = `${kind}:${avSymbol}`;
    const miss = s.quotes.get(`miss:${key}`, { freshMs: HOUR });
    if (miss) throw new DataError(miss.value.message, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    const hit = s.history.get(key, { freshMs: 12 * HOUR, staleMs: 7 * DAY });
    const revive = value => ({ ...value, requestedSymbol: symbol, observations: value.observations.map(([d, c, a]) => ({ date: new Date(`${d}T00:00:00Z`), close: c, adjClose: a })) });
    if (hit?.fresh) return { history: revive(hit.value), provenance: provenance({ cached: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString() }) };
    return forCaller(s.dedupe.run(`history:${key}`, async () => {
      try {
        const info = await avListing(s, avSymbol);
        const body = kind === "daily" ? await s.client.daily(avSymbol, avOpts(s, symbol)) : await s.client.weeklyAdjusted(avSymbol, avOpts(s, symbol));
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
        if (s.retired) throw keyChanged("alphavantage");
        if (error?.kind === "not_found" && error.definitive) s.quotes.set(`miss:${key}`, { message: error.message });
        if (!["aborted", "not_found", "not_configured"].includes(error?.kind) && hit) {
          return { history: revive(hit.value), provenance: provenance({ cached: true, stale: true, ageMs: hit.ageMs, retrievedAt: new Date(hit.savedAt).toISOString(), refreshError: error.message }) };
        }
        throw error;
      }
    }), signal);
  }

  // Alpha Vantage requests a history run would send, before it runs: 0 for a series
  // saved in this browser, else 1 (series) + 1 (listing search) when the listing is
  // not saved, + 1 more if the stem must also be searched. Returns { min, max, cached }.
  function historyCost(symbols, range) {
    const s = sessions.alphavantage || session("alphavantage");
    const kind = historyKind(range);
    let min = 0;
    let max = 0;
    let cached = 0;
    for (const symbol of symbols) {
      let avSymbol;
      try { avSymbol = toAvSymbol(symbol); } catch (_) { continue; }
      if (s?.history.get(`${kind}:${avSymbol}`, { freshMs: 12 * HOUR })) { cached += 1; continue; }
      const listed = s?.listings.get(avSymbol, { freshMs: 180 * DAY })?.value?.found;
      min += listed ? 1 : 2;
      max += listed ? 1 : 3;
    }
    return { min, max, cached };
  }

  // ---------------------------------------------------------------- md.quote.v1 per provider
  // Price currency and unit for a provider's answer, checked against the instrument.
  // Returns { currency, unitScale, verified, evidence, note } or throws currency_mismatch.
  function settleCurrency(id, identity, raw, listing) {
    const name = PROVIDERS[id].name;
    if (raw.currency) {
      if (identity.currencyEvidence === "curated_reference" && raw.currency !== identity.currency) {
        throw new DataError(`${name} reports ${identity.displayTicker} in ${raw.rawCurrency || raw.currency}, but this listing trades in ${identity.currency}. The price was not used.`, { kind: "currency_mismatch", definitive: true, provider: name });
      }
      const note = identity.currencyEvidence !== "curated_reference" && identity.currency && raw.currency !== identity.currency
        ? `${name} reports this listing trades in ${raw.currency}, not ${identity.currency} as the exchange suffix suggested.` : null;
      return { currency: raw.currency, unitScale: raw.unitScale, verified: true, evidence: "provider_quote", note };
    }
    if (listing?.currency) return { currency: listing.currency, unitScale: listing.unitScale, verified: true, evidence: "provider_listing", note: identity.currency && listing.currency !== identity.currency ? `${name} lists this symbol in ${listing.currency}.` : null };
    if (identity.currencyEvidence === "curated_reference") return { currency: identity.currency, unitScale: identity.unitScale, verified: true, evidence: "curated_reference", note: null };
    // US-only services quote US-listed securities in US dollars.
    if (["finnhub", "massive", "alpaca"].includes(id) && isUsVenue(identity.mic)) return { currency: "USD", unitScale: 1, verified: true, evidence: "provider_market", note: null };
    return { currency: identity.currency, unitScale: identity.unitScale, verified: false, evidence: "venue_default_unconfirmed", note: `${name} did not state the currency.` };
  }

  function buildQuote(id, identity, symbol, raw, cur, s, cacheStatus = "live") {
    const q = {
      schema: QUOTE_SCHEMA,
      canonicalId: identity.canonicalId,
      displayTicker: identity.displayTicker,
      provider: PROVIDERS[id].name,
      providerId: id,
      providerSymbol: symbol,
      nativePriceMajorUnits: raw.rawPrice * cur.unitScale,
      nativeCurrency: cur.currency,
      quoteUnit: cur.unitScale === 1 ? "major" : "minor",
      rawPrice: raw.rawPrice,
      rawCurrency: raw.rawCurrency || null,
      priceType: raw.priceType,
      tradingDate: raw.tradingDate,
      asOf: raw.asOf || null,
      delayMinutes: null,
      adjusted: false,
      retrievedAt: new Date(now()).toISOString(),
      cacheStatus,
      attribution: `Data from ${PROVIDERS[id].name} with your own key.`,
      entitlement: s.plan.id,
      feed: s.plan.feed || null,
      currencyVerified: cur.verified,
      currencyEvidence: cur.evidence,
      notes: cur.note ? [cur.note] : [],
    };
    if (!(q.nativePriceMajorUnits > 0) || !Number.isFinite(q.nativePriceMajorUnits)) throw new DataError(`${PROVIDERS[id].name} returned an invalid price for ${symbol}.`, { kind: "invalid", provider: PROVIDERS[id].name });
    return q;
  }

  // One provider's latest price for a resolved instrument. Burst and per-minute
  // throttles are retried after 2, 5 and 10 seconds; a daily or monthly limit stops
  // that provider (recorded with the provider's own wording until the UTC day or month
  // ends, or until "Check again").
  async function priceWith(id, identity, { signal, useCache = true } = {}) {
    const name = PROVIDERS[id].name;
    const s = session(id);
    if (!s) throw new DataError(`No ${name} key is saved.`, { kind: "not_configured", provider: name });
    const symbol = PROVIDERS[id].symbolFor(identity, s.plan);
    if (!symbol) throw new DataError(`${name} has no symbol for ${identity.displayTicker}.`, { kind: "not_covered", definitive: true, provider: name });
    const cacheKey = `${identity.canonicalId}|${symbol}`;
    const miss = useCache ? s.quotes.get(`miss:${cacheKey}`, { freshMs: HOUR }) : null;
    if (miss) throw new DataError(miss.value.message, { kind: miss.value.kind || "not_found", definitive: true, provider: name });
    const hit = useCache ? s.quotes.get(cacheKey, { freshMs: 4 * HOUR }) : null;
    if (hit && hit.ageMs <= (QUOTE_FRESH_MS[hit.value.priceType] || 10 * MINUTE)) return { ...hit.value, cacheStatus: "cached", cachedAgeMs: hit.ageMs };
    if (s.rejected) throw rejected();
    const limitError = limit => new DataError(`${name} reported its ${limit.scope} limit at ${new Date(limit.at).toISOString().slice(11, 16)} UTC. No more ${name} requests are sent from this browser until the ${limit.scope === "monthly" ? "month" : "day"} ends (UTC) unless you choose "Check again".`, { kind: "rate_limited", quotaScope: limit.scope, definitive: true, provider: name, notice: limit.notice, retryable: false });
    const rejected = () => new DataError(`${name} rejected the key earlier on this page. Check it in Settings.`, { kind: "auth", definitive: true, provider: name });
    if (id !== "alphavantage" && s.usage.limit) throw limitError(s.usage.limit);

    const run = async () => {
      let raw;
      let listing = null;
      if (id === "alphavantage") {
        const avSymbol = symbol;
        if (identity.currencyEvidence !== "curated_reference") {
          listing = await avListing(s, avSymbol);
          if (!listing) throw new DataError(`Alpha Vantage's symbol search does not list ${avSymbol}${identity.mic === "XTSE" ? ". If your broker shows a Cboe Canada (NEO) listing with .TO, enter it with .NE" : ""}.`, { kind: "not_found", definitive: true, provider: name });
        }
        const q = parseGlobalQuote(await s.client.globalQuote(avSymbol, avOpts(s, identity.displayTicker)), identity.displayTicker, { avSymbol, unitScale: 1 });
        raw = { rawPrice: q.price, rawCurrency: null, currency: null, unitScale: 1, tradingDate: q.sessionDate, asOf: null, priceType: "latest_trading_day" };
      } else {
        const adapter = ADAPTERS[id];
        for (let attempt = 0; ; attempt += 1) {
          const req = adapter.request(symbol, s.key);
          // The limit and key checks run again when the request's turn comes: requests
          // queued behind the one that hit a limit are not sent.
          const res = await s.scheduler.run(() => {
            if (s.usage.limit) throw limitError(s.usage.limit);
            if (s.rejected) throw rejected();
            s.usage.increment();
            return fetchText(req.url, { fetchImpl, signal: s.controller.signal, provider: name, timeoutMs: 15000, headers: req.headers });
          }, { signal: s.controller.signal });
          try {
            if (!res.ok) throw adapter.classify(res.status, res.text);
            raw = adapter.parse(res.text, { symbol, identity });
            break;
          } catch (error) {
            if (error.message) error.message = redactKey(error.message, s.key);
            if (error.notice) error.notice = redactKey(error.notice, s.key);
            if (error.kind === "rate_limited" && ["burst", "minute", "unknown"].includes(error.quotaScope) && attempt < 3) {
              await sleeper(Math.max(error.retryAfterMs || 0, [2000, 5000, 10000][attempt]), s.controller.signal);
              continue;
            }
            if (error.kind === "auth") s.rejected = true;
            if (error.kind === "rate_limited" && ["daily", "monthly"].includes(error.quotaScope)) s.usage.markLimit(error.quotaScope, error.notice);
            throw error;
          }
        }
      }
      ensureCurrent(s);
      if (raw.currency === null && raw.rawCurrency) Object.assign(raw, normalizeCurrency(raw.rawCurrency), { rawCurrency: raw.rawCurrency });
      const cur = settleCurrency(id, identity, raw, listing);
      const q = buildQuote(id, identity, symbol, raw, cur, s);
      if (!q.rawCurrency && listing?.rawCurrency) q.rawCurrency = listing.rawCurrency;
      s.quotes.set(cacheKey, q);
      return q;
    };
    try {
      return await forCaller(s.dedupe.run(`q:${cacheKey}`, run), signal);
    } catch (error) {
      if (s.retired) throw keyChanged(id);
      if (error?.definitive && ["not_found", "ambiguous", "currency_mismatch"].includes(error.kind)) s.quotes.set(`miss:${cacheKey}`, { message: error.message, kind: error.kind });
      if (error instanceof DataError && !error.instrument) error.instrument = identity.canonicalId;
      throw error;
    }
  }

  const configured = () => Object.keys(keys).filter(id => providerAvailable(id, platform));
  const allPlans = () => Object.fromEntries(PROVIDER_IDS.map(id => [id, planFor(id)]));
  const route = (identity, mode = prefs.routing) => routeInstrument(identity, { mode, configured: configured(), plans: allPlans(), platform });

  // Errors after which a different provider could still answer.
  const FALLBACK_KINDS = new Set(["not_found", "not_covered", "entitlement", "auth", "rate_limited", "unavailable", "network", "timeout", "http", "provider_notice", "invalid", "ambiguous"]);

  // Latest price for a resolved instrument from the chosen source (or the first
  // eligible one in Automatic mode). Other providers are tried only when the user
  // enabled fallback; the returned quote then lists what was tried first.
  async function priceInstrument(identity, { signal, mode = prefs.routing, fallback = prefs.fallback, useCache = true } = {}) {
    if (!identity || identity.status !== "resolved") throw new DataError(identity?.reason || "The ticker is not resolved.", { kind: "invalid", definitive: true });
    const { candidates, skipped } = route(identity, mode);
    if (!candidates.length) {
      const reasons = skipped.map(x => `${PROVIDERS[x.id].name}: ${x.reason}`);
      throw new DataError(`No configured source covers ${identity.displayTicker} (${identity.venueName || identity.mic}).`, {
        kind: configured().length ? "not_covered" : "not_configured", definitive: true, instrument: identity.canonicalId,
        hint: reasons.length ? reasons.join("; ") : "Add a key for a provider that covers this market, or enter your own price.",
      });
    }
    const attempts = [];
    for (const [index, c] of candidates.entries()) {
      try {
        const q = await priceWith(c.id, identity, { signal, useCache });
        return attempts.length ? { ...q, fallbackFrom: attempts } : q;
      } catch (error) {
        if (error?.kind === "aborted" || error?.kind === "key_changed") throw error;
        attempts.push({ provider: PROVIDERS[c.id].name, kind: error?.kind, message: error?.message });
        const last = index === candidates.length - 1;
        if (!fallback || last || !FALLBACK_KINDS.has(error?.kind)) {
          if (error instanceof DataError) error.attempts = attempts;
          throw error;
        }
      }
    }
    throw new DataError("No source returned a price.", { kind: "unavailable" });
  }

  // Requests a batch would send, per provider, before anything is fetched.
  function estimate(identities, { mode = prefs.routing } = {}) {
    const perProvider = {};
    const uncovered = [];
    for (const identity of identities) {
      if (!identity || identity.status !== "resolved") { uncovered.push({ displayTicker: identity?.displayTicker, reason: identity?.reason || "not resolved" }); continue; }
      const { candidates, skipped } = route(identity, mode);
      if (!candidates.length) { uncovered.push({ displayTicker: identity.displayTicker, reason: skipped.map(x => `${PROVIDERS[x.id].name}: ${x.reason}`).join("; ") || "no provider configured" }); continue; }
      const { id, symbol } = candidates[0];
      const s = sessions[id];
      const cached = s?.quotes.get(`${identity.canonicalId}|${symbol}`, { freshMs: 4 * HOUR });
      const fresh = cached && cached.ageMs <= (QUOTE_FRESH_MS[cached.value.priceType] || 10 * MINUTE);
      const cost = fresh ? 0 : PROVIDERS[id].requestCost(identity, { listingCached: id === "alphavantage" && avListingCached(symbol) });
      perProvider[id] = perProvider[id] || { requests: 0, rows: 0 };
      perProvider[id].requests += cost;
      perProvider[id].rows += 1;
    }
    for (const [id, entry] of Object.entries(perProvider)) Object.assign(entry, budget(id));
    return { perProvider, uncovered, total: Object.values(perProvider).reduce((sum, e) => sum + e.requests, 0) };
  }

  // What this browser has sent with a provider's key, against the plan's limits.
  function budget(id) {
    const s = session(id);
    const plan = planFor(id);
    const sentToday = s?.usage.count ?? 0;
    const sentMonth = s?.usage.monthCount ?? 0;
    const out = { sentToday, sentMonth, planId: plan.id, planLabel: plan.label, remaining: null, period: null, limitRecord: id === "alphavantage" ? (s?.usage.dailyLimit ? { scope: "daily", ...s.usage.dailyLimit } : null) : (s?.usage.limit || null) };
    if (plan.limits.perDay) { out.remaining = Math.max(0, plan.limits.perDay - sentToday); out.period = "day"; }
    else if (plan.limits.perMonth) { out.remaining = Math.max(0, plan.limits.perMonth - sentMonth); out.period = "month"; }
    else if (plan.limits.perMinute) { out.period = "minute"; out.perMinute = plan.limits.perMinute; }
    return out;
  }

  // Optional cross-check of the same instrument from two providers.
  async function crossCheck(identity, ids, { signal } = {}) {
    const [a, b] = await Promise.all(ids.slice(0, 2).map(id => priceWith(id, identity, { signal })));
    return compareQuotes(a, b);
  }

  // "Check again": one request that is sent even while a limit is recorded; success
  // clears the record. Returns { ok, message }.
  async function checkAgain(id) {
    const s = session(id);
    if (!s) return { ok: false, message: `No ${PROVIDERS[id].name} key is saved.` };
    try {
      if (id === "alphavantage") await s.client.probe({ signal: s.controller.signal });
      else {
        s.usage.clearLimit();
        s.rejected = false;
        await priceWith(id, resolve("AAPL"), { useCache: false });
      }
      return { ok: true, message: `${PROVIDERS[id].name} answered normally.` };
    } catch (error) {
      return { ok: false, message: error.message, notice: error.notice || null, kind: error.kind, quotaScope: error.quotaScope || null };
    }
  }

  // ---------------------------------------------------------------- key management
  // Stores (or removes, with "") a provider key. remember: true keeps it in this
  // browser's local storage until removed; false keeps it in session storage, which
  // the browser clears when the tab closes. Saving one way removes any copy saved the
  // other way. Returns { persistence, saved }.
  function setKey(id, key, { remember = false } = {}) {
    if (!providerAvailable(id, platform)) throw new Error(`${PROVIDERS[id]?.name || id} is not available here.`);
    const trimmed = String(key || "").trim();
    if (trimmed && !validProviderKey(id, trimmed)) throw new Error(`That does not look like a ${PROVIDERS[id].name} key (letters and digits only).`);
    const previous = keys[id]?.key || "";
    let persistence = "";
    const name = `${KEY_PREFIX}${id}`;
    if (trimmed) {
      persistence = writeText(remember ? local : sessionStore, name, trimmed) ? (remember ? "local" : "session") : "memory";
      removeItem(remember ? sessionStore : local, name);
      keys[id] = { key: trimmed, persistence };
    } else {
      removeItem(local, name);
      removeItem(sessionStore, name);
      delete keys[id];
    }
    if (trimmed !== previous) {
      retire(id);
      // Removing a key also removes its request counts and limit record.
      purgeKeyData(id, trimmed ? keyFingerprint(trimmed, id) : null, { counts: !trimmed });
    }
    return { persistence, saved: persistence === "local" || persistence === "session" };
  }

  function forgetAllKeys() {
    for (const id of PROVIDER_IDS) {
      removeItem(local, `${KEY_PREFIX}${id}`);
      removeItem(sessionStore, `${KEY_PREFIX}${id}`);
      if (keys[id]) { retire(id); delete keys[id]; }
      purgeKeyData(id, null, { counts: true });
    }
    removeWhere(k => k.startsWith("md.sched.v1."));
  }

  function setPlan(id, planId, { limit = null, international = false } = {}) {
    prefs.plans[id] = { id: planId, ...(limit ? { limit } : {}), ...(international ? { international: true } : {}) };
    savePrefs();
    retire(id); // new pacing applies to the next request; caches stay
    return planFor(id);
  }

  function setRouting({ mode, fallback } = {}) {
    if (mode !== undefined) prefs.routing = mode === "auto" || providerAvailable(mode, platform) ? mode : "auto";
    if (fallback !== undefined) prefs.fallback = Boolean(fallback);
    savePrefs();
    return { mode: prefs.routing, fallback: prefs.fallback };
  }

  function providerStatus(id) {
    const p = PROVIDERS[id];
    const available = providerAvailable(id, platform);
    return {
      id, name: p.name, status: p.status[platform], available, reason: available ? null : p.unsupportedReason || null,
      configured: Boolean(keys[id]), persistence: keys[id]?.persistence || "", plan: planFor(id), ...(keys[id] ? budget(id) : {}),
    };
  }

  return {
    fx,
    ready,
    resolve,
    route,
    priceInstrument,
    priceWith,
    estimate,
    crossCheck,
    checkAgain,
    providerStatus,
    providers: () => PROVIDER_IDS.map(providerStatus),
    configuredProviders: configured,
    setKey,
    forgetAllKeys,
    setPlan,
    setRouting,
    get routing() { return { mode: prefs.routing, fallback: prefs.fallback }; },
    catalogVersion: CATALOG_VERSION,
    // ---- Alpha Vantage compatibility API (Stock Comparison tool)
    quote,
    quotes,
    history,
    historyKind,
    historyCost,
    get settings() { return { hasKey: Boolean(keys.alphavantage), persistence: keys.alphavantage?.persistence || "" }; },
    liveAvailable: () => Boolean(session("alphavantage")?.client),
    usage: () => {
      const s = session("alphavantage");
      return { count: s?.usage.count ?? 0, limit: AV_DAILY_LIMIT, dailyLimit: s?.usage.dailyLimit || null, resetsAt: s?.usage.resetsAt() ?? null };
    },
    setApiKey: (key, { remember = true } = {}) => setKey("alphavantage", key, { remember }),
    // Removes saved responses for every key (and saved exchange rates). Request counts
    // and limit records are kept so the provider's answers stay honoured.
    clearCache() { return PROVIDER_IDS.reduce((n, id) => n + purgeKeyData(id, null), 0) + fx.clear(); },
    cacheSize() { return Object.values(sessions).reduce((n, s) => n + s.quotes.size() + s.history.size(), 0); },
  };
}
