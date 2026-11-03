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

// Alpha Vantage reports limits and errors as HTTP-200 JSON bodies. Their wording has
// changed several times, and the per-second "burst" notice ALSO mentions "(25 requests
// per day)" (2025-12 and 2026 wordings), so the rules below are ordered and specific:
//   1. burst: "spreading out", "per second", "burst" or the legacy per-minute
//      "call frequency" Note. Transient: retried with back-off, never stored.
//   2. daily: only the daily-limit sentence itself ("rate limit is N requests per day",
//      "remove all daily rate limits"). Stops this key until 00:00 UTC.
//   3. premium endpoint -> entitlement; 4. demo key -> auth.
//   5. anything else in Information/Note -> provider_notice: shown verbatim, never
//      treated as a definitive limit.
// "Error Message": apikey -> auth; otherwise the symbol/function has no data.
const AV_RULES = [
  { test: /spreading out|per[- ]second|\bburst\b|call frequency|requests? per minute|calls? per minute/i, kind: "rate_limited", quotaScope: "burst" },
  { test: /rate limit is \d+ (?:requests|calls) per day|remove all daily rate limits|daily (?:rate|request) limit (?:is|has been) (?:reached|exceeded)/i, kind: "rate_limited", quotaScope: "daily" },
  { test: /premium endpoint|premium feature|premium (?:plan )?(?:only|required)/i, kind: "entitlement" },
  { test: /\bdemo\b/i, kind: "auth" },
];

// Classifies a notice text (Information or Note field). Exported for the fixture tests.
export function classifyAvNotice(text) {
  const rule = AV_RULES.find(r => r.test.test(String(text || "")));
  return rule ? { kind: rule.kind, quotaScope: rule.quotaScope || null } : { kind: "provider_notice", quotaScope: null };
}

const notice = text => redactKey(String(text || "")).replace(/\s+/g, " ").trim().slice(0, 400);

// Maps Alpha Vantage's HTTP-200 error bodies to DataError; returns the parsed body otherwise.
export function parseAvBody(text, { symbol = "" } = {}) {
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new DataError("Alpha Vantage response was not JSON", { kind: "invalid", provider: AV_PROVIDER }); }
  if (!body || typeof body !== "object") throw new DataError("Alpha Vantage response was empty", { kind: "invalid", provider: AV_PROVIDER });
  const info = String(body.Information || body.Note || "");
  if (info) {
    const { kind, quotaScope } = classifyAvNotice(info);
    const said = notice(info);
    if (kind === "rate_limited" && quotaScope === "burst") {
      throw new DataError("Alpha Vantage asked for slower requests (its per-second limit). This is temporary.", { kind, quotaScope, provider: AV_PROVIDER, retryAfterMs: 2000, notice: said, hint: "Wait a few seconds and retry; requests are spaced automatically." });
    }
    if (kind === "rate_limited") {
      throw new DataError("Alpha Vantage says this key has reached its daily request limit.", { kind, quotaScope, definitive: true, provider: AV_PROVIDER, notice: said, hint: "Alpha Vantage counts every use of the key (other devices and apps included). Its free plan allows 25 requests per day." });
    }
    if (kind === "entitlement") throw new DataError(`${symbol ? `${symbol}: ` : ""}this data is a premium Alpha Vantage feature, not available with a free key.`, { kind, definitive: true, provider: AV_PROVIDER, notice: said });
    if (kind === "auth") throw new DataError("The Alpha Vantage demo key only works for the documentation examples. Add your own free key.", { kind, definitive: true, provider: AV_PROVIDER, notice: said });
    throw new DataError(`Alpha Vantage sent a notice instead of data: ${said.slice(0, 160)}`, { kind: "provider_notice", provider: AV_PROVIDER, notice: said, hint: "This is not treated as a daily limit. Retry later." });
  }
  if (body["Error Message"]) {
    const message = String(body["Error Message"]);
    if (/apikey/i.test(message)) throw new DataError("Alpha Vantage rejected the API key. Check the key in Settings.", { kind: "auth", definitive: true, provider: AV_PROVIDER, notice: notice(message) });
    throw new DataError(`${symbol || "Symbol"}: Alpha Vantage has no data for this symbol.`, { kind: "not_found", definitive: true, provider: AV_PROVIDER, notice: notice(message) });
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

// Low-level client. Requests go through `scheduler` (per key, shared across tabs):
// at least 1.2 s between starts and 1.1 s after the previous response ends, plus a
// little jitter. A burst notice is retried after 2, 5 and 10 seconds and never
// stored. Only Alpha Vantage's own daily-limit wording blocks the key, and only until
// 00:00 UTC; the visitor can "Check again" with a single request at any time.
export const AV_BURST_BACKOFF_MS = [2000, 5000, 10000];

export function avSchedulerRules() {
  return { minSpacingMs: 1200, minGapAfterMs: 1100, jitterMs: 300 };
}

export function createAlphaVantageClient({ apiKey, fetchImpl = (...a) => globalThis.fetch(...a), usage = null, scheduler = null, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), backoffMs = AV_BURST_BACKOFF_MS } = {}) {
  if (!validKey(apiKey)) return null;
  const key = apiKey.trim();
  let rejectedKey = false; // "apikey is invalid": kept for this page only, never stored
  let chain = Promise.resolve();
  const schedule = scheduler ? (task, signal) => scheduler.run(task, { signal }) : task => task();

  const localLimitError = hit => new DataError(
    `Alpha Vantage reported this key's daily limit at ${new Date(hit.at).toISOString().slice(11, 16)} UTC. This browser sends no more Alpha Vantage requests until 00:00 UTC unless you choose "Check again".`,
    { kind: "rate_limited", quotaScope: "daily", definitive: true, provider: AV_PROVIDER, notice: hit.notice || null, hint: "Check again (1 request), wait for the reset, or use another configured source.", retryable: false },
  );

  async function send(params, { signal, symbol, probe = false } = {}) {
    if (rejectedKey) throw new DataError("Alpha Vantage rejected the API key. Check the key in Settings.", { kind: "auth", definitive: true, provider: AV_PROVIDER });
    const hit = usage?.dailyLimit;
    if (hit && !probe) throw localLimitError(hit);
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted", provider: AV_PROVIDER });
      const res = await schedule(async () => {
        usage?.increment();
        const query = new URLSearchParams({ ...params, apikey: key });
        return fetchText(`${AV_BASE}?${query}`, { fetchImpl, signal, provider: AV_PROVIDER, timeoutMs: 15000 });
      }, signal);
      if (!res.ok) {
        const error = httpError(res.status, { provider: AV_PROVIDER, headers: res.headers, text: res.text });
        error.message = redactKey(error.message, key);
        throw error;
      }
      try {
        const body = parseAvBody(res.text, { symbol });
        if (probe) usage?.clearDailyLimit?.();
        return body;
      } catch (error) {
        error.message = redactKey(error.message, key);
        if (error.notice) error.notice = redactKey(error.notice, key);
        if (error.kind === "rate_limited" && error.quotaScope === "burst" && attempt < backoffMs.length) {
          await sleep(backoffMs[attempt], signal);
          continue;
        }
        if (error.kind === "auth" && /rejected/.test(error.message)) rejectedKey = true;
        if (error.kind === "rate_limited" && error.quotaScope === "daily") usage?.markDailyLimit?.(error.notice);
        throw error;
      }
    }
  }
  // Calls are queued in order so concurrent callers (a comparison and a snapshot)
  // never overtake each other.
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
    // "Check again": one GLOBAL_QUOTE for IBM (Alpha Vantage's documented example)
    // that is sent even while the daily limit is recorded. Success clears the record.
    async probe(opts = {}) { return call({ function: "GLOBAL_QUOTE", symbol: "IBM" }, { ...opts, probe: true, symbol: "IBM" }); },
    get dailyLimit() { return usage?.dailyLimit || null; },
    get exhausted() { return Boolean(usage?.dailyLimit) || rejectedKey; },
  };
}

// Per-browser request counter for ONE provider key (the caller gives each key its
// own storage name). It counts requests THIS browser sent since 00:00 UTC and in
// the current UTC month. It is not the provider's count: other devices, apps and
// tabs in other browsers using the same key are not seen. It also remembers when the
// provider itself reported its daily limit (with the redacted notice) for the rest of
// that UTC day. Records written by earlier versions that stored only a bare
// "exhausted" flag are ignored: that flag could have come from a misread burst notice.
// Unreadable or unavailable storage counts as zero and never throws.
export function createUsageCounter(storage, { now = () => Date.now(), key = "md.av.usage.v1" } = {}) {
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const blank = () => ({ day: today(), month: today().slice(0, 7), count: 0, monthCount: 0, limit: null });
  const read = () => {
    try {
      const entry = JSON.parse(storage?.getItem(key) || "null");
      if (!entry || typeof entry !== "object") return blank();
      const t = today();
      const sameDay = entry.day === t && Number.isInteger(entry.count) && entry.count >= 0;
      const sameMonth = entry.month === t.slice(0, 7) && Number.isInteger(entry.monthCount) && entry.monthCount >= 0;
      // A recorded limit applies for the rest of its UTC day (daily) or month (monthly).
      const raw = entry.limit && Number.isFinite(entry.limit.at) ? entry.limit : null;
      const at = raw ? new Date(raw.at).toISOString() : "";
      const applies = raw && ((raw.scope === "daily" && at.slice(0, 10) === t) || (raw.scope === "monthly" && at.slice(0, 7) === t.slice(0, 7)));
      const limit = applies ? { scope: raw.scope, at: raw.at, notice: typeof raw.notice === "string" ? raw.notice.slice(0, 400) : null } : null;
      return { day: t, month: t.slice(0, 7), count: sameDay ? entry.count : 0, monthCount: sameMonth ? entry.monthCount : 0, limit };
    } catch (_) { return blank(); }
  };
  const write = e => { try { storage?.setItem(key, JSON.stringify(e)); } catch (_) { /* optional */ } };
  return {
    get count() { return read().count; },
    get monthCount() { return read().monthCount; },
    get limit() { return read().limit; },
    get dailyLimit() { const l = read().limit; return l && l.scope === "daily" ? { at: l.at, notice: l.notice } : null; },
    get exhausted() { return Boolean(read().limit); },
    increment() { const e = read(); e.count += 1; e.monthCount += 1; write(e); return e.count; },
    markLimit(scope, noticeText = null) { const e = read(); e.limit = { scope, at: now(), notice: noticeText ? String(noticeText).slice(0, 400) : null }; write(e); },
    markDailyLimit(noticeText = null) { this.markLimit("daily", noticeText); },
    clearLimit() { const e = read(); e.limit = null; write(e); },
    clearDailyLimit() { this.clearLimit(); },
    // When a recorded limit stops applying here: next 00:00 UTC (daily) or the first
    // day of next UTC month (monthly). The provider's own reset may differ.
    resetsAt() {
      const l = read().limit;
      const d = new Date(`${today()}T00:00:00Z`);
      if (l?.scope === "monthly") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      return d.getTime() + 86400000;
    },
  };
}
