// Yahoo Finance through this site's shared market-data gateway
// (_services/market-data-gateway, a Cloudflare Worker), in one normalized contract. No
// account or key is needed. It is one source in the visitor's ordered source list
// (./sources.js), at position 1 by default.
//
// Availability is explicit and is checked, never assumed:
//   not_configured  the site has no gateway URL (_data/market_data.yml is empty)
//   checking        the gateway's /v1/health has not answered yet
//   unreachable     the gateway could not be reached or refused this page
//   disabled        the gateway runs, but its Yahoo Finance source is switched off
//   enabled         the gateway serves Yahoo Finance
// Until a gateway is configured AND reports the source enabled, nothing is requested
// from it except that one health check, and the tools say why the source is unavailable.
//
// Requests carry only a ticker symbol and a history range. No holdings, share
// quantities, target weights, account types or keys are ever sent.
//
// Requests are gentle on purpose (slow is better than blocked): one at a time across
// every open tab of this site, at least 350 ms apart, answers reused from this browser
// (10 minutes for quotes, 12 hours for history), and after any "slow down" answer
// (rate limit, busy, Yahoo refusing the gateway) nothing more is sent until the time the
// gateway gives has passed. That pause is remembered across page loads. No request is
// ever retried in a loop; only a network error or timeout is retried, once.
//
// Every answer is checked again here (listing, venue, currency, unit, positive finite
// prices, real calendar dates in ascending order) before a tool can use it; anything
// that does not match the instrument that was asked for is refused, never substituted.

import { DataError, fetchText, validateBaseUrl, parseRetryAfter, withRetry } from "./http.js";
import { createScheduler } from "./scheduler.js";
import { createCache, memoryStorage } from "./cache.js";
import { isIsoDay, parseIsoDay, validateHistory } from "./contract.js";

export const KEYLESS_ID = "yahoo";
export const KEYLESS_NAME = "Yahoo Finance";
export const KEYLESS_PROVIDER = "Yahoo Finance";
export const KEYLESS_VIA = "this site's data gateway";
export const KEYLESS_PRICE_TYPE = "regular_market_price";
export const SCHEMAS = Object.freeze({ health: "md-gateway.health.v1", quote: "md-gateway.quote.v1", history: "md-gateway.history.v1", error: "md-gateway.error.v1" });

// Venues the gateway serves (MIC -> exchange suffix); the gateway's src/venues.js has
// the same list (checked by _tools/tests/unit/market-gateway.test.mjs).
export const KEYLESS_VENUES = Object.freeze({ US: "", XTSE: ".TO", XTSX: ".V", NEOE: ".NE", XLON: ".L", XETR: ".DE", XPAR: ".PA", XAMS: ".AS", XSWX: ".SW", XTKS: ".T", XSHG: ".SS", XSHE: ".SZ", XHKG: ".HK", XASX: ".AX" });
const US_FAMILY = ["US", "XNYS", "XNAS", "ARCX", "BATS", "XASE"];
const venueKey = mic => (US_FAMILY.includes(mic) ? "US" : mic);

// History ranges the gateway serves, with the calendar days each covers.
export const HISTORY_BUCKETS = Object.freeze([["1mo", 31], ["3mo", 92], ["6mo", 184], ["1y", 366], ["2y", 731], ["5y", 1827]]);
export function historyBucket(range) {
  const days = Math.ceil((range.end.getTime() - range.start.getTime()) / 86400000) + 3;
  return (HISTORY_BUCKETS.find(([, d]) => d >= days) || HISTORY_BUCKETS[HISTORY_BUCKETS.length - 1])[0];
}

const QUOTE_FRESH_MS = 10 * 60000;
const HISTORY_FRESH_MS = 12 * 3600000;
export const REQUEST_SPACING_MS = 350;
// The shortest pause after a "slow down" answer, whatever Retry-After says.
const MIN_PAUSE_MS = { rate_limited: 60000, unavailable: 30000, timeout: 30000 };
const PAUSE_KEY = "md.yahoo.v1.pause";

const SYMBOL = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){0,13}(?:\.[A-Z]{1,2})?$/;

// The gateway symbol for a resolved instrument, or null when the gateway does not
// serve that listing. US class shares use a hyphen (BRK.B -> BRK-B), TSX US-dollar
// units "-U" (DLR.U -> DLR-U.TO).
export function keylessSymbol(identity) {
  if (!identity || identity.status !== "resolved" || !identity.localSymbol) return null;
  const venue = venueKey(identity.mic);
  if (!Object.hasOwn(KEYLESS_VENUES, venue)) return null;
  let local = identity.localSymbol;
  if (venue === "US") local = local.replace(/\./g, "-");
  else if (venue === "XTSE" && /\.U$/.test(local)) local = local.replace(/\.U$/, "-U");
  else if (local.includes(".")) return null;
  const symbol = `${local}${KEYLESS_VENUES[venue]}`;
  return symbol.length <= 20 && SYMBOL.test(symbol) ? symbol : null;
}

// The gateway the page uses: the one configured for the site, or a `?mdgateway=`
// override (a URL, or "none") only when the page itself is served from this computer
// (127.0.0.1 or localhost), so a link can never point production visitors elsewhere.
export function resolveMarketGateway(configured, location) {
  if (location && ["127.0.0.1", "localhost"].includes(location.hostname)) {
    const override = new URLSearchParams(location.search || "").get("mdgateway");
    if (override === "none") return ""; // local testing: as if no gateway were configured
    if (override) return override;
  }
  return configured || "";
}

const MESSAGES = {
  not_configured: "Yahoo Finance is not available on this site yet.",
  unreachable: "Yahoo Finance is not available right now: this site's data gateway could not be reached.",
  disabled: "Yahoo Finance is switched off on this site at the moment.",
  checking: "Yahoo Finance is still being checked.",
};

// Gateway error codes -> what the tools do with them. Messages are this page's own.
// `pause` marks answers after which nothing more is sent until Retry-After has passed:
// always for rate limits and refusals; for an outage or timeout only when the gateway's
// own circuit breaker is open (Retry-After of a minute or more), so one failed listing
// does not stop the others.
const ERRORS = {
  source_disabled: ["unavailable", "Yahoo Finance is switched off on this site at the moment.", { definitive: true }],
  origin_not_allowed: ["unavailable", "This site's data gateway does not accept requests from this page.", { definitive: true }],
  rate_limited: ["rate_limited", "Too many Yahoo Finance requests from this browser. Requests pause for a minute.", { quotaScope: "minute", pause: true }],
  throttled: ["rate_limited", "The data gateway's shared Yahoo Finance budget is used up for the moment. Requests pause briefly.", { quotaScope: "minute", pause: true }],
  upstream_rate_limited: ["rate_limited", "Yahoo Finance asked this site to slow down. Requests to it pause for a while.", { quotaScope: "minute", pause: true }],
  busy: ["unavailable", "The data gateway is busy. Requests pause briefly.", { pause: true }],
  upstream_unavailable: ["unavailable", "Yahoo Finance is unavailable right now.", { pause: "breaker" }],
  upstream_timeout: ["timeout", "Yahoo Finance did not answer in time.", { pause: "breaker" }],
  upstream_blocked: ["unavailable", "Yahoo Finance refused the data gateway's request. Requests to it pause for a while.", { pause: true }],
  upstream_rejected: ["unavailable", "Yahoo Finance refused the request."],
  upstream_invalid: ["invalid", "Yahoo Finance returned data that failed its checks, so it was not used."],
  symbol_not_found: ["not_found", "Yahoo Finance has no data for this symbol.", { definitive: true }],
  no_price: ["not_found", "Yahoo Finance returned no current price for this listing.", { definitive: true }],
  no_history: ["not_found", "Yahoo Finance returned no price history for this listing and period.", { definitive: true }],
  listing_mismatch: ["ambiguous", "Yahoo Finance answered for a different listing or exchange; the answer was not used.", { definitive: true }],
  currency_mismatch: ["currency_mismatch", "Yahoo Finance reported a currency this listing does not trade in; the answer was not used.", { definitive: true }],
  currency_unknown: ["currency_mismatch", "Yahoo Finance did not state the currency; the answer was not used.", { definitive: true }],
  unsupported_instrument: ["not_covered", "Yahoo Finance data here does not include this kind of instrument (index, currency, future).", { definitive: true }],
  unsupported_listing: ["not_covered", "Yahoo Finance data here does not include this exchange.", { definitive: true }],
  invalid_symbol: ["invalid", "Yahoo Finance does not accept this symbol.", { definitive: true }],
};

const positive = v => typeof v === "number" && Number.isFinite(v) && v > 0;
const short = (text, max = 300) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const invalid = message => new DataError(`The Yahoo Finance answer failed a check (${message}), so it was not used.`, { kind: "invalid", provider: KEYLESS_NAME });
const localDay = (ms, timeZone) => {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (_) { return new Date(ms).toISOString().slice(0, 10); }
};

export function createKeylessSource({ baseUrl = "", fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), storage = null, timeoutMs = 10000, sleep, locks = globalThis.navigator?.locks, spacingMs = REQUEST_SPACING_MS } = {}) {
  const base = validateBaseUrl(baseUrl);
  const store = storage || memoryStorage();
  const quotes = createCache({ storage: store, prefix: "md.keyless.v1.quote:", maxEntries: 150, now });
  const histories = createCache({ storage: store, prefix: "md.keyless.v1.history:", maxEntries: 20, now });
  // One request at a time across every tab of this site, spaced (Web Locks + local storage).
  const scheduler = createScheduler({ name: "yahoo.gateway", minSpacingMs: spacingMs, storage: store, now, locks, ...(sleep ? { sleep } : {}) });
  let status = base ? { state: "checking", message: MESSAGES.checking } : { state: "not_configured", message: MESSAGES.not_configured };
  let pending = null;
  let requests = 0;

  function setStatus(next) { status = { ...next, checkedAt: now() }; return status; }

  /* ---- pause after a "slow down" answer (kept across page loads) ---- */
  function readPause() {
    try {
      const p = JSON.parse(store.getItem(PAUSE_KEY) || "null");
      if (p && Number.isFinite(p.until) && p.until > now() && p.until - now() <= 2 * 3600000) return p;
    } catch (_) { /* unreadable: no pause */ }
    return null;
  }
  function pause(kind, retryAfterMs, message) {
    const ms = Math.max(MIN_PAUSE_MS[kind] || 5000, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    const until = now() + Math.min(ms, 2 * 3600000);
    const current = readPause();
    if (current && current.until >= until) return;
    try { store.setItem(PAUSE_KEY, JSON.stringify({ until, kind, message: short(message, 200) })); } catch (_) { /* this page only */ }
  }
  // { paused, untilMs, minutesLeft, reason } for messages and the source list.
  function pauseState() {
    const p = readPause();
    if (!p) return { paused: false, untilMs: null, minutesLeft: 0, kind: null, reason: null, short: null };
    const minutesLeft = Math.max(1, Math.ceil((p.until - now()) / 60000));
    const why = p.kind === "rate_limited" ? "after it asked this site to slow down" : "after it was unavailable";
    return { paused: true, untilMs: p.until, minutesLeft, kind: p.kind, reason: `paused for about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"} ${why}`, short: p.kind === "rate_limited" ? "paused after a rate limit" : "paused after an outage" };
  }
  const pausedError = () => {
    const p = pauseState();
    return new DataError(`Yahoo Finance is ${p.reason}. Nothing was sent; other sources in your list are tried instead.`, { kind: p.kind === "rate_limited" ? "rate_limited" : "unavailable", quotaScope: p.kind === "rate_limited" ? "minute" : null, provider: KEYLESS_NAME, paused: true, retryAfterMs: p.untilMs - now() });
  };

  // One GET /v1/health. Its answer decides whether the source is offered at all.
  function check({ force = false } = {}) {
    if (!base) return Promise.resolve(status);
    if (pending && !force) return pending;
    pending = (async () => {
      try {
        const res = await fetchText(`${base}/v1/health`, { fetchImpl, timeoutMs: 8000, provider: KEYLESS_NAME });
        if (!res.ok) return setStatus({ state: "unreachable", message: `${MESSAGES.unreachable} (HTTP ${res.status})` });
        let body;
        try { body = JSON.parse(res.text); } catch (_) { body = null; }
        if (body?.schema !== SCHEMAS.health || typeof body.keyless?.enabled !== "boolean") return setStatus({ state: "unreachable", message: `${MESSAGES.unreachable} (unexpected answer)` });
        if (!body.keyless.enabled) return setStatus({ state: "disabled", message: MESSAGES.disabled, reason: short(body.keyless.reason) || null });
        // The gateway is leaving Yahoo alone after a refusal: so does this page.
        if (body.upstream?.state === "cooling_down" && Number.isFinite(body.upstream.retryAfterSeconds)) pause("rate_limited", body.upstream.retryAfterSeconds * 1000, "the data gateway is pausing Yahoo Finance requests");
        return setStatus({ state: "enabled", message: null, provider: KEYLESS_PROVIDER, attribution: short(body.keyless.attribution) || null, version: short(body.version, 20) });
      } catch (_) {
        return setStatus({ state: "unreachable", message: `${MESSAGES.unreachable} (network, CORS or timeout)` });
      }
    })();
    return pending;
  }

  const enabled = () => status.state === "enabled";
  function unavailable() {
    return new DataError(status.state === "disabled" && status.reason ? `${status.message} ${status.reason}` : status.message || MESSAGES.not_configured, { kind: status.state === "not_configured" ? "not_configured" : "unavailable", definitive: true, provider: KEYLESS_NAME });
  }

  // Whether the source can be asked right now: { available, code, reason } (for the list).
  function availability() {
    if (!enabled()) {
      const reason = { checking: "still being checked", not_configured: "not available on this site yet", disabled: "switched off on this site at the moment", unreachable: "unavailable because this site's data gateway could not be reached" }[status.state] || "not available right now";
      return { available: false, code: status.state, reason, short: reason };
    }
    const p = pauseState();
    if (p.paused) return { available: false, code: "paused", reason: p.reason, short: p.short };
    return { available: true, code: null, reason: null };
  }

  function gatewayError(res) {
    let code = null;
    let bodyAfterMs = null;
    try {
      const body = JSON.parse(res.text);
      if (body?.schema === SCHEMAS.error) {
        code = String(body.error?.code || "");
        const sec = Number(body.error?.retryAfterSeconds);
        if (Number.isFinite(sec) && sec >= 0 && sec <= 7200) bodyAfterMs = sec * 1000;
      }
    } catch (_) { /* not JSON */ }
    const entry = ERRORS[code];
    if (code === "source_disabled") setStatus({ state: "disabled", message: MESSAGES.disabled, reason: null });
    if (code === "origin_not_allowed") setStatus({ state: "unreachable", message: `${MESSAGES.unreachable} (it does not accept this page)` });
    if (!entry) return new DataError(`The data gateway answered HTTP ${res.status}.`, { kind: res.status >= 500 ? "unavailable" : "http", status: res.status, provider: KEYLESS_NAME });
    const [kind, message, { pause: pauses = false, ...extra } = {}] = entry;
    const retryAfterMs = bodyAfterMs ?? parseRetryAfter(res.headers?.get?.("retry-after"), now());
    if (pauses === true || (pauses === "breaker" && retryAfterMs >= 60000)) pause(kind, retryAfterMs, message);
    return new DataError(message, { kind, status: res.status, provider: KEYLESS_NAME, retryAfterMs, gatewayCode: code, hint: kind === "rate_limited" ? "Other sources in your list are tried; you can also use your own price." : null, ...extra });
  }

  // One gateway GET, one at a time and spaced. A network error or timeout reaching the
  // gateway is retried once; a refusal or a rate limit is never retried (it pauses).
  async function get(path, params, signal) {
    if (!enabled()) throw unavailable();
    if (pauseState().paused) throw pausedError();
    const url = `${base}${path}?${new URLSearchParams(params)}`;
    return withRetry(() => scheduler.run(async () => {
      if (pauseState().paused) throw pausedError(); // a pause may have started while this waited
      requests += 1;
      const res = await fetchText(url, { fetchImpl, signal, timeoutMs, maxBytes: 1024 * 1024, provider: KEYLESS_NAME });
      if (!res.ok) throw gatewayError(res);
      try { return JSON.parse(res.text); } catch (_) { throw invalid("not JSON"); }
    }, { signal }), { retries: 1, baseMs: 800, maxDelayMs: 2000, signal, sleep, shouldRetry: e => e?.kind === "network" || (e?.kind === "timeout" && !e.gatewayCode) });
  }

  function checkListing(body, schema, symbol, identity) {
    if (body?.schema !== schema) throw invalid("schema");
    if (body.listing?.symbol !== symbol) throw invalid("different symbol");
    if (body.listing?.mic !== venueKey(identity.mic)) throw invalid("different exchange");
    if (!/^[A-Z]{3}$/.test(String(body.currency || ""))) throw invalid("currency");
    if (!(body.unitScale === 1 || body.unitScale === 0.01) || body.quoteUnit !== (body.unitScale === 1 ? "major" : "minor")) throw invalid("unit");
    if (typeof body.rawCurrency !== "string" || body.rawCurrency.length > 5) throw invalid("raw currency");
    if (!Number.isFinite(Date.parse(body.retrievedAt))) throw invalid("retrieval time");
    const cache = body.cache && ["hit", "miss"].includes(body.cache.status) && Number.isFinite(body.cache.ageSeconds) && body.cache.ageSeconds >= 0 ? { status: body.cache.status, ageSeconds: body.cache.ageSeconds } : null;
    if (!cache) throw invalid("cache record");
    return cache;
  }

  // Latest regular-session price: raw fields for the md.quote.v1 contract.
  async function quote(identity, { signal, useCache = true } = {}) {
    const symbol = keylessSymbol(identity);
    if (!enabled()) throw unavailable();
    if (!symbol) throw new DataError(`Yahoo Finance data here does not cover ${identity?.venueName || identity?.mic || "this listing"}.`, { kind: "not_covered", definitive: true, provider: KEYLESS_NAME });
    const hit = useCache ? quotes.get(symbol, { freshMs: QUOTE_FRESH_MS }) : null;
    if (hit?.fresh) return { ...hit.value, browserCacheAgeMs: hit.ageMs };
    const body = await get("/v1/quote", { symbol }, signal);
    const gatewayCache = checkListing(body, SCHEMAS.quote, symbol, identity);
    if (!positive(body.rawPrice) || !positive(body.price) || Math.abs(body.price - body.rawPrice * body.unitScale) > 1e-9 * Math.max(1, body.price)) throw invalid("price");
    if (!isIsoDay(body.tradingDate) || !Number.isFinite(Date.parse(body.sourceTime))) throw invalid("date");
    if (body.priceBasis !== KEYLESS_PRICE_TYPE || body.adjusted !== false || body.delay?.realTime !== false) throw invalid("price basis");
    const optional = v => (positive(v) ? v : null);
    const raw = {
      symbol, rawPrice: body.rawPrice, rawCurrency: body.rawCurrency, currency: body.currency, unitScale: body.unitScale,
      tradingDate: body.tradingDate, asOf: new Date(Date.parse(body.sourceTime)).toISOString(), priceType: KEYLESS_PRICE_TYPE,
      name: short(body.listing.name, 120) || null, exchangeName: short(body.listing.exchangeName, 60) || null, instrumentType: short(body.listing.instrumentType, 20) || null,
      retrievedAt: new Date(Date.parse(body.retrievedAt)).toISOString(), gatewayCache, delayNote: short(body.delay?.note) || null,
      previousClose: optional(body.previousClose), dayHigh: optional(body.dayHigh), dayLow: optional(body.dayLow),
      volume: Number.isFinite(body.volume) && body.volume >= 0 ? body.volume : null,
      missing: Array.isArray(body.missing) ? body.missing.filter(m => typeof m === "string").slice(0, 10) : [],
      attribution: short(body.source?.attribution) || status.attribution || null,
    };
    quotes.set(symbol, raw);
    return { ...raw, browserCacheAgeMs: null };
  }

  // Daily history covering `range` ({ start, end }), as md.history.v1 with both bases
  // kept separately. The latest bar is dropped while its session may still be trading.
  async function history(identity, range, { signal } = {}) {
    const symbol = keylessSymbol(identity);
    if (!enabled()) throw unavailable();
    if (!symbol) throw new DataError(`Yahoo Finance data here does not cover ${identity?.venueName || identity?.mic || "this listing"}.`, { kind: "not_covered", definitive: true, provider: KEYLESS_NAME });
    const bucket = historyBucket(range);
    const key = `${symbol}|${bucket}`;
    const hit = histories.get(key, { freshMs: HISTORY_FRESH_MS });
    let packed;
    let browserCacheAgeMs = null;
    if (hit?.fresh) { packed = hit.value; browserCacheAgeMs = hit.ageMs; }
    else {
      const body = await get("/v1/history", { symbol, range: bucket, interval: "1d" }, signal);
      const gatewayCache = checkListing(body, SCHEMAS.history, symbol, identity);
      if (body.frequency !== "daily" || body.interval !== "1d" || body.range !== bucket || !Array.isArray(body.observations) || body.observations.length > 2000) throw invalid("history shape");
      let previous = "";
      for (const o of body.observations) {
        if (!Array.isArray(o) || o.length !== 3 || !isIsoDay(o[0]) || o[0] <= previous) throw invalid("dates");
        if ((o[1] !== null && !positive(o[1])) || (o[2] !== null && !positive(o[2])) || (o[1] === null && o[2] === null)) throw invalid("prices");
        previous = o[0];
      }
      packed = {
        symbol, currency: body.currency, rawCurrency: body.rawCurrency, unitScale: body.unitScale, observations: body.observations,
        name: short(body.listing.name, 120) || null, exchangeName: short(body.listing.exchangeName, 60) || short(body.listing.venueName, 60) || null,
        instrumentType: short(body.listing.instrumentType, 20) || null, timeZone: short(body.listing.timeZone, 40) || identity.timeZone || "UTC",
        adjustment: { adjCloseAvailable: body.adjustment?.adjCloseAvailable === true, close: short(body.adjustment?.close) || null, adjClose: short(body.adjustment?.adjClose) || null },
        missing: body.missing && typeof body.missing === "object" ? { rowsWithoutPrices: Number(body.missing.rowsWithoutPrices) || 0, closes: Number(body.missing.closes) || 0, adjCloses: Number(body.missing.adjCloses) || 0, duplicateDates: Number(body.missing.duplicateDates) || 0 } : null,
        retrievedAt: new Date(Date.parse(body.retrievedAt)).toISOString(), gatewayCache, range: bucket,
        attribution: short(body.source?.attribution) || status.attribution || null,
      };
      histories.set(key, packed);
    }
    const today = localDay(now(), packed.timeZone);
    const rows = packed.observations.filter(o => o[0] < today);
    const h = validateHistory({
      requestedSymbol: identity.displayTicker, symbol, name: packed.name, instrumentType: packed.instrumentType, exchange: packed.exchangeName,
      currency: packed.currency, rawCurrency: packed.rawCurrency, unitScale: packed.unitScale, frequency: "daily",
      observations: rows.map(([d, c, a]) => ({ date: parseIsoDay(d), close: c, adjClose: a })),
      adjustment: packed.adjustment, provider: KEYLESS_PROVIDER, market: {},
    }, KEYLESS_NAME);
    return { ...h, keyless: { retrievedAt: packed.retrievedAt, gatewayCache: packed.gatewayCache, browserCacheAgeMs, range: packed.range, missing: packed.missing, droppedRunningSession: rows.length < packed.observations.length, attribution: packed.attribution } };
  }

  return {
    check,
    status: () => ({ ...status }),
    enabled,
    configured: () => Boolean(base),
    base: () => base,
    availability,
    pauseState,
    quote,
    history,
    requestsSent: () => requests,
    quoteCached: identity => { const s = keylessSymbol(identity); return Boolean(s && quotes.get(s, { freshMs: QUOTE_FRESH_MS })?.fresh); },
    clearCache: () => quotes.clear() + histories.clear(),
    clearPause: () => { try { store.removeItem(PAUSE_KEY); } catch (_) { /* none */ } },
    cacheSize: () => quotes.size() + histories.size(),
  };
}
