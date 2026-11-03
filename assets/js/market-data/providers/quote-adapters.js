// Latest-price adapters for Marketstack, Finnhub and Massive (Alpha Vantage has its
// own module). Each adapter only builds a request and turns the answer into raw quote
// fields or a classified DataError; pacing, keys, caching and the md.quote.v1 contract
// are handled by the quote service (../quotes.js).
//
// Every answer is checked against the instrument that was asked for: a different
// symbol, a different exchange or an unexpected currency is never used.

import { DataError } from "../http.js";
import { isIsoDay } from "../contract.js";
import { venueMatches } from "../catalog.js";

const MINOR = { GBX: ["GBP", 0.01], GBp: ["GBP", 0.01], ZAC: ["ZAR", 0.01], ZAc: ["ZAR", 0.01], ILA: ["ILS", 0.01] };
export function normalizeCurrency(raw) {
  const text = String(raw ?? "").trim();
  if (MINOR[text]) return { currency: MINOR[text][0], unitScale: MINOR[text][1], raw: text };
  const code = text.toUpperCase();
  if (MINOR[code]) return { currency: MINOR[code][0], unitScale: MINOR[code][1], raw: text };
  return /^[A-Z]{3}$/.test(code) ? { currency: code === "CNH" ? "CNH" : code, unitScale: 1, raw: text } : { currency: null, unitScale: 1, raw: text || null };
}

const parseJson = (text, provider) => {
  try { return JSON.parse(text); } catch (_) { throw new DataError(`${provider} response was not JSON.`, { kind: "invalid", provider }); }
};
const positive = v => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const shortNotice = text => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);

// Trading date of an epoch time in a time zone, as YYYY-MM-DD.
export function dateIn(ms, timeZone = "America/New_York") {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (_) { return new Date(ms).toISOString().slice(0, 10); }
}

/* ---------------------------------------------------------------- Marketstack */
export const MARKETSTACK = {
  id: "marketstack",
  name: "Marketstack",
  base: "https://api.marketstack.com/v2/eod/latest",
  request(symbol, key) {
    return { url: `${this.base}?${new URLSearchParams({ access_key: key, symbols: symbol })}`, headers: {} };
  },
  // Marketstack error bodies: { error: { code, message } } with an HTTP status.
  classify(status, text) {
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
    const code = String(body?.error?.code || "").toLowerCase();
    const message = shortNotice(body?.error?.message || "");
    const p = { provider: "Marketstack", notice: message || null, status };
    if (code === "usage_limit_reached") return new DataError("Marketstack says this key has used its monthly request allowance.", { ...p, kind: "rate_limited", quotaScope: "monthly", definitive: true, hint: "Marketstack counts every symbol as one request. The allowance renews on your plan's billing date." });
    if (code === "rate_limit_reached" || status === 429) return new DataError("Marketstack asked for slower requests (per-second limit).", { ...p, kind: "rate_limited", quotaScope: "burst", retryAfterMs: 1500 });
    if (["invalid_access_key", "missing_access_key", "inactive_user"].includes(code) || status === 401) return new DataError("Marketstack rejected the access key. Check it in Settings.", { ...p, kind: "auth", definitive: true });
    if (["function_access_restricted", "https_access_restricted"].includes(code) || status === 403) return new DataError("Your Marketstack plan does not include this data.", { ...p, kind: "entitlement", definitive: true });
    if (["no_valid_symbols_provided", "invalid_symbols"].includes(code) || status === 404 || status === 422) return new DataError("Marketstack has no end-of-day data for this symbol.", { ...p, kind: "not_found", definitive: true });
    if (status >= 500) return new DataError(`Marketstack is unavailable (HTTP ${status}).`, { ...p, kind: "unavailable" });
    return new DataError(`Marketstack refused the request (HTTP ${status}${code ? `, ${code}` : ""}).`, { ...p, kind: "http" });
  },
  parse(text, { symbol, identity }) {
    const body = parseJson(text, this.name);
    if (body?.error) throw this.classify(200, text);
    const rows = Array.isArray(body?.data) ? body.data : [];
    const row = rows.find(r => String(r?.symbol || "").toUpperCase() === symbol.toUpperCase());
    if (!row) throw new DataError(`Marketstack returned no end-of-day price for ${symbol}.`, { kind: "not_found", definitive: true, provider: this.name });
    if (!venueMatches(identity.mic, row.exchange)) {
      throw new DataError(`Marketstack's ${symbol} is listed on ${row.exchange || "an unknown exchange"}, not ${identity.venueName}. It was not used.`, { kind: "ambiguous", definitive: true, provider: this.name });
    }
    const cur = normalizeCurrency(row.price_currency);
    const close = positive(Number(row.close));
    const day = String(row.date || "").slice(0, 10);
    if (close === null) throw new DataError(`Marketstack returned no valid close for ${symbol}.`, { kind: "invalid", provider: this.name });
    if (!isIsoDay(day)) throw new DataError(`Marketstack returned an invalid date for ${symbol}.`, { kind: "invalid", provider: this.name });
    return {
      rawPrice: close, rawCurrency: cur.raw, currency: cur.currency, unitScale: cur.unitScale, currencySource: cur.currency ? "provider_quote" : null,
      tradingDate: day, asOf: null, priceType: "eod_close", adjusted: false, venueReturned: String(row.exchange || ""), name: row.name || null,
    };
  },
};

/* ---------------------------------------------------------------- Finnhub */
export const FINNHUB = {
  id: "finnhub",
  name: "Finnhub",
  base: "https://finnhub.io/api/v1/quote",
  // Browsers: token as a query parameter (Finnhub's CORS preflight does not allow its header).
  request(symbol, key, { useHeader = false } = {}) {
    if (useHeader) return { url: `${this.base}?${new URLSearchParams({ symbol })}`, headers: { "X-Finnhub-Token": key } };
    return { url: `${this.base}?${new URLSearchParams({ symbol, token: key })}`, headers: {} };
  },
  classify(status, text) {
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
    const message = shortNotice(body?.error || text);
    const p = { provider: "Finnhub", notice: message || null, status };
    if (status === 429) return new DataError("Finnhub's per-minute limit was reached.", { ...p, kind: "rate_limited", quotaScope: "minute", retryAfterMs: 5000 });
    if (status === 401) return new DataError("Finnhub rejected the API key. Check it in Settings.", { ...p, kind: "auth", definitive: true });
    if (status === 403) return new DataError("Your Finnhub plan does not include this market.", { ...p, kind: "entitlement", definitive: true });
    if (status >= 500) return new DataError(`Finnhub is unavailable (HTTP ${status}).`, { ...p, kind: "unavailable" });
    return new DataError(`Finnhub refused the request (HTTP ${status}).`, { ...p, kind: "http" });
  },
  parse(text, { symbol, identity }) {
    const body = parseJson(text, this.name);
    if (body?.error) throw new DataError(`Finnhub: ${shortNotice(body.error)}`, { kind: /access|premium|subscri/i.test(body.error) ? "entitlement" : "provider_notice", provider: this.name, notice: shortNotice(body.error) });
    const price = positive(body?.c);
    const t = Number(body?.t);
    // Finnhub answers an unknown symbol with zeros rather than an error.
    if (price === null || !(t > 0)) throw new DataError(`Finnhub has no quote for ${symbol}.`, { kind: "not_found", definitive: true, provider: this.name });
    const ms = t * 1000;
    return {
      rawPrice: price, rawCurrency: null, currency: null, unitScale: 1, currencySource: null,
      tradingDate: dateIn(ms, identity.timeZone || "America/New_York"), asOf: new Date(ms).toISOString(), priceType: "last_trade", adjusted: false,
    };
  },
};

/* ---------------------------------------------------------------- Massive */
export const MASSIVE = {
  id: "massive",
  name: "Massive",
  base: "https://api.massive.com/v2/aggs/ticker",
  request(symbol, key) {
    return { url: `${this.base}/${encodeURIComponent(symbol)}/prev?adjusted=false`, headers: { Authorization: `Bearer ${key}` } };
  },
  classify(status, text) {
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
    const message = shortNotice(body?.message || body?.error || "");
    const p = { provider: "Massive", notice: message || null, status };
    if (status === 429) return new DataError("Massive's per-minute limit was reached.", { ...p, kind: "rate_limited", quotaScope: "minute", retryAfterMs: 12000 });
    if (status === 401) return new DataError("Massive rejected the API key.", { ...p, kind: "auth", definitive: true });
    if (status === 403) return new DataError("Your Massive plan does not include this data.", { ...p, kind: "entitlement", definitive: true });
    if (status === 404) return new DataError("Massive has no data for this symbol.", { ...p, kind: "not_found", definitive: true });
    if (status >= 500) return new DataError(`Massive is unavailable (HTTP ${status}).`, { ...p, kind: "unavailable" });
    return new DataError(`Massive refused the request (HTTP ${status}).`, { ...p, kind: "http" });
  },
  parse(text, { symbol, identity }) {
    const body = parseJson(text, this.name);
    const bar = Array.isArray(body?.results) ? body.results[0] : null;
    if (!bar || String(bar.T || body.ticker || "").toUpperCase() !== symbol.toUpperCase()) throw new DataError(`Massive has no previous close for ${symbol}.`, { kind: "not_found", definitive: true, provider: this.name });
    const close = positive(Number(bar.c));
    const t = Number(bar.t);
    if (close === null || !(t > 0)) throw new DataError(`Massive returned an invalid bar for ${symbol}.`, { kind: "invalid", provider: this.name });
    return {
      rawPrice: close, rawCurrency: null, currency: null, unitScale: 1, currencySource: null,
      tradingDate: dateIn(t, identity.timeZone || "America/New_York"), asOf: null, priceType: "previous_close", adjusted: false,
    };
  },
};

export const ADAPTERS = { marketstack: MARKETSTACK, finnhub: FINNHUB, massive: MASSIVE };
