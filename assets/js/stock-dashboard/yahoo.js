// Yahoo Finance chart (v8) adapter for the browser.
//
// Mirrors the TipRanks Automation Tool's YahooFinanceProvider contract
// (scripts/providers/yahoo_finance.py): adjusted closes only, finite and
// non-negative values, ascending unique dates, listing currency preserved, and
// provider payloads discarded after normalization. Only the keyless v8 chart
// endpoint is used; Yahoo's quote/quoteSummary endpoints need a session crumb that
// a static site cannot obtain.

import { FetchError } from "./proxy.js";
import { normalizeSymbol } from "./symbols.js";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const CACHE_PREFIX = "sdd.yahoo.v1:";
const CACHE_TTL_MS = 15 * 60000;
// Minor-unit listing currencies: prices are quoted in 1/100 of the ISO currency.
const MINOR_UNITS = { GBP: ["GBp", "GBX"], ZAR: ["ZAc", "ZAC"], ILS: ["ILA"] };

function minorUnitMajor(currency) {
  for (const [major, minors] of Object.entries(MINOR_UNITS)) if (minors.includes(currency)) return major;
  return null;
}

export function chartUrls(symbol, { start, end }) {
  const period1 = Math.floor(start.getTime() / 1000);
  const period2 = Math.floor(end.getTime() / 1000) + 86400;
  const query = `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true&includePrePost=false`;
  return HOSTS.map(host => `${host}/v8/finance/chart/${encodeURIComponent(symbol)}${query}`);
}

const finiteNonNegative = value => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

// Parses and validates a chart response body. Throws FetchError(definitive) for an
// unknown symbol so the pipeline stops trying other proxies.
export function parseChart(text, symbol) {
  if (!text || (text[0] !== "{" && text[0] !== "[")) throw new Error("response was not JSON (proxy error page?)");
  let payload;
  try { payload = JSON.parse(text); } catch (_) { throw new Error("response JSON could not be parsed"); }
  const chart = payload?.chart;
  if (!chart || typeof chart !== "object") throw new Error("response did not contain chart data");
  if (chart.error) {
    const code = String(chart.error.code || "");
    if (/not.?found/i.test(code) || /no data found|delisted/i.test(String(chart.error.description || ""))) {
      throw new FetchError(`${symbol}: Yahoo Finance has no data for this symbol.`, { kind: "not_found", definitive: true });
    }
    throw new Error(`Yahoo Finance error: ${code || "unknown"}`);
  }
  const result = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!result || !result.meta) throw new Error("chart result missing");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  const closes = result.indicators?.quote?.[0]?.close;
  const meta = result.meta;
  let currency = typeof meta.currency === "string" ? meta.currency.trim() : "";
  let scale = 1;
  const major = minorUnitMajor(currency);
  if (major) { currency = major; scale = 0.01; }
  currency = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  const usedAdjusted = Array.isArray(adjusted);
  // Daily bars are stamped at the session open; shift by the exchange offset so the
  // calendar date is the exchange's trading date (e.g. ASX opens before 00:00 UTC).
  const offset = Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 0;
  const byDate = new Map();
  timestamps.forEach((stamp, index) => {
    const raw = usedAdjusted ? adjusted[index] : Array.isArray(closes) ? closes[index] : null;
    const price = finiteNonNegative(raw);
    if (price === null || !Number.isFinite(stamp)) return;
    const day = new Date((stamp + offset) * 1000).toISOString().slice(0, 10);
    byDate.set(day, { date: new Date(`${day}T00:00:00Z`), price: price * scale });
  });
  const observations = [...byDate.values()].sort((a, b) => a.date - b.date);
  const scaled = value => (finiteNonNegative(value) === null ? null : value * scale);
  return {
    ticker: symbol,
    currency,
    observations,
    priceBasis: usedAdjusted ? "adjusted_close" : "close",
    minorUnitConverted: Boolean(major),
    identity: {
      displayName: meta.longName || meta.shortName || null,
      assetType: meta.instrumentType || null,
      exchange: meta.fullExchangeName || meta.exchangeName || null,
      currency,
      providerSymbol: meta.symbol || symbol,
      timezone: meta.exchangeTimezoneName || null,
    },
    market: {
      price: scaled(meta.regularMarketPrice),
      dayHigh: scaled(meta.regularMarketDayHigh),
      dayLow: scaled(meta.regularMarketDayLow),
      week52High: scaled(meta.fiftyTwoWeekHigh),
      week52Low: scaled(meta.fiftyTwoWeekLow),
      volume: finiteNonNegative(meta.regularMarketVolume),
      marketTime: Number.isFinite(meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    },
  };
}

function storage() {
  try { return window.sessionStorage; } catch (_) { return null; }
}

function cacheKey(symbol, range) {
  // Day-granular window so repeated runs within the TTL reuse the response.
  return `${CACHE_PREFIX}${symbol}:${range.start.toISOString().slice(0, 10)}:${range.end.toISOString().slice(0, 10)}`;
}

function revive(series) {
  return { ...series, observations: series.observations.map(([ms, price]) => ({ date: new Date(ms), price })) };
}

function readCache(key, now) {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || now - entry.savedAt > CACHE_TTL_MS) { storage()?.removeItem(key); return null; }
    return { series: revive(entry.series), savedAt: entry.savedAt, proxy: entry.proxy };
  } catch (_) {
    return null;
  }
}

function writeCache(key, series, proxy, now) {
  const compact = { ...series, observations: series.observations.map(o => [o.date.getTime(), o.price]) };
  try { storage()?.setItem(key, JSON.stringify({ savedAt: now, proxy, series: compact })); }
  catch (_) { clearCache(); } // quota exceeded: drop old entries, caching is optional
}

export function clearCache() {
  const store = storage();
  if (!store) return 0;
  const keys = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
  }
  keys.forEach(key => store.removeItem(key));
  return keys.length;
}

export function cacheSize() {
  const store = storage();
  if (!store) return 0;
  let count = 0;
  for (let i = 0; i < store.length; i += 1) if (store.key(i)?.startsWith(CACHE_PREFIX)) count += 1;
  return count;
}

// Fetches one symbol's daily history for a window. Returns the normalized series plus
// provenance { source, via, retrievedAt, cached }.
export async function fetchHistory(pipeline, rawSymbol, range, { signal, onAttempt, useCache = true, retry = false } = {}) {
  const symbol = normalizeSymbol(rawSymbol);
  const key = cacheKey(symbol, range);
  const now = Date.now();
  if (useCache) {
    const hit = readCache(key, now);
    if (hit) {
      return { series: hit.series, provenance: { source: "Yahoo Finance", via: hit.proxy, retrievedAt: new Date(hit.savedAt).toISOString(), cached: true } };
    }
  }
  const { data, proxy } = await pipeline.fetchValidated(chartUrls(symbol, range), text => parseChart(text, symbol), { signal, onAttempt, retry });
  if (data.observations.length < 2) {
    throw new FetchError(`${symbol}: Yahoo Finance returned fewer than two daily prices for this window.`, { kind: "not_found", definitive: true });
  }
  writeCache(key, data, proxy.label, now);
  return { series: data, provenance: { source: "Yahoo Finance", via: proxy.label, retrievedAt: new Date(now).toISOString(), cached: false } };
}
