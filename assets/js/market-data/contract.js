// Normalized market-data contract shared by the Portfolio Rebalancer and the Stock
// Comparison dashboard.
//
// Transport parsing (providers/*), normalization (this file) and financial
// calculations (the tools' engines) stay separate. A value that fails these checks
// is never used: there are no fabricated or zero-dollar fallbacks.
//
// Quote
//   requestedSymbol  what the user typed (normalized upper case)
//   symbol           provider symbol actually returned (e.g. RY.TO)
//   name, instrumentType (EQUITY | ETF | MUTUALFUND | INDEX | CURRENCY | ...), exchange
//   currency         ISO code of `price` (minor units such as GBp already converted)
//   rawCurrency      currency exactly as the provider reported it; unitScale applied
//   price            > 0, finite
//   priceKind        "latest_trading_day" (provider's latest price for sessionDate) | "last_close"
//   priceTime        ISO timestamp of the price from the provider, or null
//   sessionDate      YYYY-MM-DD trading date of the price in the exchange time zone, or null
//   provider         data owner (e.g. "Yahoo Finance"); via: how it reached the browser
//   retrievedAt      ISO time the browser/gateway received it; cached/stale flags
//
// History
//   same identity fields, plus observations [{ date: Date (UTC midnight of the
//   exchange trading date), close, adjClose }] ascending and unique; close/adjClose
//   are > 0 or null. `adjustment` records what the provider says adjClose means.
//
// FX rate
//   { base, quote, rate (quote units per one base unit), date (YYYY-MM-DD),
//     provider, method: "direct" | "inverse" | "cross", series: [source series ids] }

import { DataError } from "./http.js";

export const SCHEMA = { quote: "md.quote.v1", history: "md.history.v1", fx: "md.fx.v1" };

export const INTRADAY_MS = 30 * 60000;
// Friday close to Tuesday morning after a Monday holiday is under four days.
export const STALE_AFTER_MS = 4 * 86400000;

export const isPositive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
export const isoDay = date => date.toISOString().slice(0, 10);
const CURRENCY = /^[A-Z]{3}$/;

// Strict YYYY-MM-DD: returns the UTC-midnight Date of a real calendar day, or null.
// JavaScript's own parser rolls impossible days forward ("2026-02-30" becomes
// 2 March), so the parsed date must round-trip to the same year, month and day.
// UTC midnight keeps the calendar day independent of the visitor's time zone.
export function parseIsoDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof text === "string" ? text : "");
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // also correct for years 0-99
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
export const isIsoDay = text => parseIsoDay(text) !== null;

function invalid(message, provider) {
  return new DataError(message, { kind: "invalid", provider });
}

// Freshness of a single price from its provider timestamp. "unknown" when the
// provider gave no time (the UI must then say so instead of implying live data).
export function classifyFreshness(priceTime, now = Date.now()) {
  const at = priceTime ? Date.parse(priceTime) : NaN;
  if (!Number.isFinite(at)) return { status: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - at);
  if (ageMs <= INTRADAY_MS) return { status: "intraday", ageMs };
  if (ageMs <= STALE_AFTER_MS) return { status: "recent-close", ageMs };
  return { status: "stale", ageMs };
}

export const FRESHNESS_LABEL = {
  intraday: "Intraday (may be delayed)",
  "recent-close": "Last available price",
  stale: "Stale: older than 4 days",
  unknown: "Price time unknown",
};

export function describeAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "unknown age";
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h old`;
  return `${Math.round(hours / 24)} days old`;
}

export function validateQuote(q, provider = null) {
  if (!q || typeof q !== "object") throw invalid("quote missing", provider);
  if (typeof q.symbol !== "string" || !q.symbol) throw invalid("quote has no symbol", provider);
  if (!isPositive(q.price)) throw invalid(`${q.symbol}: price is missing, zero or invalid`, provider);
  if (q.currency !== null && (typeof q.currency !== "string" || !CURRENCY.test(q.currency))) throw invalid(`${q.symbol}: invalid currency`, provider);
  if (q.priceTime !== null && q.priceTime !== undefined && !Number.isFinite(Date.parse(q.priceTime))) throw invalid(`${q.symbol}: invalid price time`, provider);
  if (q.sessionDate && !isIsoDay(q.sessionDate)) throw invalid(`${q.symbol}: invalid session date`, provider);
  if (!isPositive(q.unitScale ?? 1)) throw invalid(`${q.symbol}: invalid unit scale`, provider);
  return q;
}

export function validateHistory(h, provider = null) {
  if (!h || typeof h !== "object" || !Array.isArray(h.observations)) throw invalid("history missing", provider);
  if (h.currency !== null && (typeof h.currency !== "string" || !CURRENCY.test(h.currency))) throw invalid(`${h.symbol}: invalid currency`, provider);
  let previous = -Infinity;
  for (const o of h.observations) {
    if (!(o.date instanceof Date) || !Number.isFinite(o.date.getTime())) throw invalid(`${h.symbol}: invalid observation date`, provider);
    if (o.date.getTime() <= previous) throw invalid(`${h.symbol}: observations are not unique and ascending`, provider);
    previous = o.date.getTime();
    for (const field of ["close", "adjClose"]) {
      if (o[field] !== null && !isPositive(o[field])) throw invalid(`${h.symbol}: invalid ${field} on ${isoDay(o.date)}`, provider);
    }
  }
  return h;
}

// Chooses one price basis for a whole series; never mixes adjusted and unadjusted
// values inside a series. Returns { observations: [{date, price}], priceBasis, warning }.
export function selectBasis(history, basis = "adjusted") {
  const hasAdjusted = history.observations.some(o => o.adjClose !== null);
  if (basis === "adjusted" && hasAdjusted) {
    return { observations: history.observations.filter(o => o.adjClose !== null).map(o => ({ date: o.date, price: o.adjClose })), priceBasis: "adjusted_close", warning: null };
  }
  const observations = history.observations.filter(o => o.close !== null).map(o => ({ date: o.date, price: o.close }));
  const warning = basis === "adjusted"
    ? `${history.symbol}: the provider returned no adjusted closes; unadjusted closes (price return, dividends excluded) are used.`
    : null;
  return { observations, priceBasis: "close", warning };
}

export function validateFx(rate, provider = null) {
  if (!rate || !CURRENCY.test(rate.base || "") || !CURRENCY.test(rate.quote || "")) throw invalid("FX rate has invalid currencies", provider);
  if (!isPositive(rate.rate)) throw invalid(`${rate.base}/${rate.quote}: invalid rate`, provider);
  if (!isIsoDay(rate.date)) throw invalid(`${rate.base}/${rate.quote}: invalid rate date`, provider);
  return rate;
}
