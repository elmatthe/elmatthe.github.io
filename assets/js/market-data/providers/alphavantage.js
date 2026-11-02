// Alpha Vantage adapter (optional; uses the VISITOR'S OWN free API key).
//
// Why this provider: it is the only free tier evaluated (2026-11-02) that covers
// both US and TSX/TSX-V listings and answers browsers with
// `Access-Control-Allow-Origin: *`. Its terms limit free keys to personal,
// non-commercial use, so the key is entered by each visitor, stays in that
// visitor's browser (session or local storage, the visitor's choice), is sent only
// to www.alphavantage.co (as the apikey query parameter it requires), and the
// data it returns is used only in that visitor's own browser. The site never
// stores, shares or republishes it.
//
// Endpoints used (free tier):
//   SYMBOL_SEARCH                 listing region + currency (the evidence for a quote's currency)
//   GLOBAL_QUOTE                  latest price and its trading day (no intraday time)
//   TIME_SERIES_DAILY (compact)   last ~100 sessions, AS-TRADED closes (no split/dividend adjustment)
//   TIME_SERIES_WEEKLY_ADJUSTED   weekly closes and adjusted closes (splits and dividends), 20+ years
// Free-tier limit: 25 requests per day per key. Errors and limits arrive as HTTP 200
// bodies ("Error Message", "Information", "Note") and are mapped to DataError here.

import { DataError, fetchText, httpError } from "../http.js";
import { validateQuote, validateHistory, parseIsoDay, isIsoDay } from "../contract.js";

export const AV_PROVIDER = "Alpha Vantage";
export const AV_BASE = "https://www.alphavantage.co/query";
export const AV_DAILY_LIMIT = 25;
export const AV_ADJUSTMENT = {
  weekly: "Alpha Vantage weekly adjusted close: adjusted for splits and dividends (provider definition).",
  daily: "Alpha Vantage daily close: as traded, not adjusted for splits or dividends (price return only).",
};

// Yahoo-style suffix typed by users -> Alpha Vantage exchange suffix (documented examples).
const SUFFIX_MAP = { ".TO": ".TRT", ".V": ".TRV", ".L": ".LON", ".DE": ".DEX", ".BO": ".BSE", ".SS": ".SHH", ".SZ": ".SHZ" };
// Minor-unit codes as providers spell them; "GBp"/"ZAc" differ from GBP/ZAR only by case.
export const MINOR_UNITS = { GBX: ["GBP", 0.01], GBp: ["GBP", 0.01], ZAC: ["ZAR", 0.01], ZAc: ["ZAR", 0.01], ILA: ["ILS", 0.01] };
const KEY_PATTERN = /^[A-Za-z0-9]{8,64}$/;

export const validKey = key => typeof key === "string" && KEY_PATTERN.test(key.trim());

// Returns the Alpha Vantage symbol for a user symbol, or throws a definitive
// DataError when the listing is outside what this adapter supports.
export function toAvSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  if (!s) throw new DataError("Ticker is required.", { kind: "invalid", definitive: true, provider: AV_PROVIDER });
  if (s.startsWith("^")) throw new DataError(`${s}: market indexes are a premium Alpha Vantage feature and are not available with a free key. Import index prices from a CSV file instead.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  if (s.includes("=")) throw new DataError(`${s}: FX and futures symbols are not fetched from Alpha Vantage. Exchange rates come from the Bank of Canada or the ECB.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  const dot = s.lastIndexOf(".");
  if (dot > 0) {
    const suffix = s.slice(dot);
    if (SUFFIX_MAP[suffix]) return s.slice(0, dot) + SUFFIX_MAP[suffix];
    if (Object.values(SUFFIX_MAP).includes(suffix)) return s;
    // Class shares such as BRK.B (no exchange suffix) pass through unchanged.
    if (suffix.length === 2 && /^[A-Z]$/.test(suffix[1]) && !["T", "V", "L"].includes(suffix[1])) return s;
    throw new DataError(`${s}: the ${suffix} exchange is not supported by this site's Alpha Vantage connection. Enter the price manually.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  }
  return s;
}

const num = value => {
  const n = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(n) ? n : null;
};

// Alpha Vantage notices can quote the caller's key ("detected your API key as ...").
// Messages shown to the user (and possibly exported) never contain it.
export function redactKey(message, key = "") {
  let text = String(message ?? "").replace(/(api ?key (?:as|is|=)\s*)[A-Za-z0-9]+/gi, "$1[redacted]");
  if (key && key.length >= 4) text = text.split(key).join("[redacted]");
  return text;
}

// Maps Alpha Vantage's HTTP-200 error bodies to DataError; returns the parsed body otherwise.
export function parseAvBody(text, { symbol = "" } = {}) {
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new DataError("Alpha Vantage response was not JSON", { kind: "invalid", provider: AV_PROVIDER }); }
  if (!body || typeof body !== "object") throw new DataError("Alpha Vantage response was empty", { kind: "invalid", provider: AV_PROVIDER });
  const info = String(body.Information || body.Note || "");
  if (info) {
    // Rate-limit notices also mention "premium plans", so they are recognised first.
    // A burst notice ("spreading out ... 1 request per second") is transient; only
    // the daily notice means the key is done for the day.
    if (/per day|daily/i.test(info) && /rate limit|requests/i.test(info)) throw new DataError("Alpha Vantage daily request limit reached for this API key (the free plan allows 25 requests per day).", { kind: "rate_limited", definitive: true, provider: AV_PROVIDER, scope: "daily" });
    if (/rate limit|per second|per minute|spreading out|call frequency|burst/i.test(info)) throw Object.assign(new DataError("Alpha Vantage asked for slower requests; retrying shortly.", { kind: "rate_limited", provider: AV_PROVIDER, retryAfterMs: 1500 }), { scope: "burst" });
    if (/demo/i.test(info)) throw new DataError("The Alpha Vantage demo key only works for the documentation examples. Add your own free key.", { kind: "auth", definitive: true, provider: AV_PROVIDER });
    if (/premium endpoint|premium feature|premium plan/i.test(info)) throw new DataError(`${symbol ? `${symbol}: ` : ""}this data is a premium Alpha Vantage feature, not available with a free key.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
    throw new DataError(`Alpha Vantage: ${redactKey(info).slice(0, 160)}`, { kind: "unavailable", provider: AV_PROVIDER });
  }
  if (body["Error Message"]) {
    const message = String(body["Error Message"]);
    if (/apikey/i.test(message)) throw new DataError("Alpha Vantage rejected the API key. Check the key in Settings.", { kind: "auth", definitive: true, provider: AV_PROVIDER });
    throw new DataError(`${symbol || "Symbol"}: Alpha Vantage has no data for this symbol.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  }
  return body;
}

export function currencyFromSearch(raw) {
  const trimmed = String(raw || "").trim();
  if (MINOR_UNITS[trimmed]) return { currency: MINOR_UNITS[trimmed][0], rawCurrency: trimmed, unitScale: MINOR_UNITS[trimmed][1] };
  const code = trimmed.toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? { currency: code, rawCurrency: raw, unitScale: 1 } : { currency: null, rawCurrency: raw || null, unitScale: 1 };
}

// SYMBOL_SEARCH body -> listing for exactly `avSymbol`, or null.
export function pickListing(body, avSymbol) {
  const matches = Array.isArray(body?.bestMatches) ? body.bestMatches : [];
  const hit = matches.find(m => String(m?.["1. symbol"] || "").toUpperCase() === avSymbol);
  if (!hit) return null;
  return {
    avSymbol,
    name: String(hit["2. name"] || "").slice(0, 120) || null,
    instrumentType: String(hit["3. type"] || "").toUpperCase().slice(0, 20) || null,
    region: String(hit["4. region"] || "").slice(0, 40) || null,
    timezone: String(hit["7. timezone"] || "").slice(0, 20) || null,
    ...currencyFromSearch(hit["8. currency"]),
  };
}

export function parseGlobalQuote(body, symbol, listing) {
  const q = body?.["Global Quote"];
  if (!q || typeof q !== "object" || !Object.keys(q).length) {
    throw new DataError(`${symbol}: Alpha Vantage returned no quote for this symbol.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  }
  const scale = listing?.unitScale ?? 1;
  const price = num(q["05. price"]);
  const day = String(q["07. latest trading day"] || "");
  const quote = {
    requestedSymbol: symbol,
    symbol: String(q["01. symbol"] || listing?.avSymbol || symbol),
    name: listing?.name ?? null,
    instrumentType: listing?.instrumentType ?? null,
    exchange: listing?.region ?? null,
    currency: listing?.currency ?? null,
    rawCurrency: listing?.rawCurrency ?? null,
    unitScale: scale,
    price: price === null ? null : price * scale,
    previousClose: num(q["08. previous close"]) === null ? null : num(q["08. previous close"]) * scale,
    changePercent: num(q["10. change percent"]),
    dayHigh: num(q["03. high"]) === null ? null : num(q["03. high"]) * scale,
    dayLow: num(q["04. low"]) === null ? null : num(q["04. low"]) * scale,
    volume: num(q["06. volume"]),
    priceKind: "latest_trading_day",
    priceTime: null,
    sessionDate: isIsoDay(day) ? day : null,
    provider: AV_PROVIDER,
  };
  return validateQuote(quote, AV_PROVIDER);
}

// TIME_SERIES_DAILY or TIME_SERIES_WEEKLY_ADJUSTED body -> normalized history.
export function parseSeries(body, symbol, listing, kind) {
  const key = kind === "weekly" ? "Weekly Adjusted Time Series" : "Time Series (Daily)";
  const series = body?.[key];
  if (!series || typeof series !== "object") throw new DataError(`${symbol}: Alpha Vantage returned no price history.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER });
  const scale = listing?.unitScale ?? 1;
  const positive = v => { const n = num(v); return n !== null && n > 0 ? n * scale : null; };
  const observations = Object.keys(series)
    .filter(isIsoDay)
    .sort()
    .map(day => ({ date: parseIsoDay(day), close: positive(series[day]["4. close"]), adjClose: kind === "weekly" ? positive(series[day]["5. adjusted close"]) : null }))
    .filter(o => o.close !== null || o.adjClose !== null);
  return validateHistory({
    requestedSymbol: symbol,
    symbol: listing?.avSymbol || symbol,
    name: listing?.name ?? null,
    instrumentType: listing?.instrumentType ?? null,
    exchange: listing?.region ?? null,
    timezone: String(body?.["Meta Data"]?.["4. Time Zone"] || body?.["Meta Data"]?.["5. Time Zone"] || "").slice(0, 40) || null,
    currency: listing?.currency ?? null,
    rawCurrency: listing?.rawCurrency ?? null,
    unitScale: scale,
    frequency: kind === "weekly" ? "weekly" : "daily",
    observations,
    adjustment: { adjCloseAvailable: kind === "weekly", adjClose: AV_ADJUSTMENT.weekly, close: kind === "weekly" ? "Alpha Vantage weekly close: as traded (price return)." : AV_ADJUSTMENT.daily },
    market: {},
    provider: AV_PROVIDER,
  }, AV_PROVIDER);
}

// Low-level client. `usage` tracks requests per UTC day in this browser so the UI
// can warn before the free quota runs out (the count is an estimate: other devices
// using the same key are not seen).
export function createAlphaVantageClient({ apiKey, fetchImpl = (...a) => globalThis.fetch(...a), usage = null, minSpacingMs = 1200, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!validKey(apiKey)) return null;
  const key = apiKey.trim();
  let last = 0;
  let exhaustedDay = null; // UTC day on which the daily limit (or a key rejection) was reported
  let chain = Promise.resolve();
  const today = () => new Date(now()).toISOString().slice(0, 10);
  // The daily limit is also remembered in this key's usage record, so a reload (or
  // switching back to this key) does not spend another request to rediscover it.
  const exhausted = () => exhaustedDay === today() || Boolean(usage?.exhausted);
  const limitError = () => new DataError("Alpha Vantage daily request limit reached for this API key (the free plan allows 25 requests per day).", { kind: "rate_limited", definitive: true, provider: AV_PROVIDER });

  async function send(params, { signal, symbol } = {}) {
    if (exhausted()) throw limitError();
    for (let attempt = 0; ; attempt += 1) {
      const wait = last + minSpacingMs - now();
      if (wait > 0) await sleep(wait);
      if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted", provider: AV_PROVIDER });
      last = now();
      usage?.increment();
      const query = new URLSearchParams({ ...params, apikey: key });
      const res = await fetchText(`${AV_BASE}?${query}`, { fetchImpl, signal, provider: AV_PROVIDER, timeoutMs: 15000 });
      if (!res.ok) throw httpError(res.status, { provider: AV_PROVIDER, headers: res.headers, text: res.text });
      try {
        return parseAvBody(res.text, { symbol });
      } catch (error) {
        error.message = redactKey(error.message, key);
        if (error.scope === "burst" && attempt === 0) { await sleep(error.retryAfterMs || 1500); continue; }
        if ((error.kind === "rate_limited" && error.definitive) || error.kind === "auth") exhaustedDay = today(); // stop spending requests today
        if (error.kind === "rate_limited" && error.definitive) usage?.markExhausted?.();
        throw error;
      }
    }
  }
  // Requests are serialized so concurrent callers (a comparison and a snapshot) keep
  // the provider's spacing.
  function call(params, opts) {
    const run = chain.then(() => send(params, opts));
    chain = run.catch(() => {});
    return run;
  }
  return {
    async search(keywords, opts) { return call({ function: "SYMBOL_SEARCH", keywords }, opts); },
    async globalQuote(avSymbol, opts) { return call({ function: "GLOBAL_QUOTE", symbol: avSymbol }, opts); },
    async daily(avSymbol, opts) { return call({ function: "TIME_SERIES_DAILY", symbol: avSymbol, outputsize: "compact" }, opts); },
    async weeklyAdjusted(avSymbol, opts) { return call({ function: "TIME_SERIES_WEEKLY_ADJUSTED", symbol: avSymbol }, opts); },
    get exhausted() { return exhausted(); },
  };
}

// Per-browser daily request counter (UTC day) for ONE key: the caller gives each key
// its own storage name, so a different key never inherits this count. The count is
// an estimate (other devices using the same key are not seen). Unreadable or
// unavailable storage counts as zero and never throws.
export function createUsageCounter(storage, { now = () => Date.now(), key = "md.av.usage.v1" } = {}) {
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const read = () => {
    try {
      const entry = JSON.parse(storage?.getItem(key) || "null");
      return entry && entry.day === today() && Number.isInteger(entry.count) && entry.count >= 0
        ? { day: entry.day, count: entry.count, exhausted: entry.exhausted === true }
        : { day: today(), count: 0, exhausted: false };
    } catch (_) { return { day: today(), count: 0, exhausted: false }; }
  };
  const write = e => { try { storage?.setItem(key, JSON.stringify(e)); } catch (_) { /* optional */ } };
  return {
    get count() { return read().count; },
    get exhausted() { return read().exhausted; },
    increment() { const e = read(); e.count += 1; write(e); return e.count; },
    markExhausted() { const e = read(); e.exhausted = true; write(e); },
  };
}
