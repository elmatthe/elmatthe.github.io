// Upstream adapter for Yahoo Finance chart data (the gateway's only upstream).
//
// What this endpoint is, and is not:
//   * https://query1.finance.yahoo.com/v8/finance/chart/{symbol} is an UNOFFICIAL,
//     undocumented Yahoo Finance endpoint. Yahoo publishes no API documentation, no
//     service levels and no licence for it. It is not the Python `yfinance` library
//     (an independent open-source client of the same endpoints).
//   * Running it through a Cloudflare Worker does not remove Yahoo's rate limits or its
//     blocking of automated clients, and it does not license the data. Yahoo's Terms of
//     Service prohibit collecting data "using any automated means" and redistributing
//     the services (see _tools/PROVIDER_MATRIX.md, "Keyless gateway").
//   * This adapter sends an honest, identifying User-Agent. It does not imitate a
//     browser, obtain cookies or "crumbs", rotate addresses or otherwise work around
//     bot detection. If Yahoo refuses the request, the gateway reports it and stops.
// The gateway therefore keeps this source OFF unless its operator records a written
// authorization (SOURCE_AUTHORIZATION; README.md, "Activation gate").
//
// The URL is always built here from a fixed base and an allowlisted symbol; nothing
// the client sends is copied into it except that validated symbol and an allowlisted
// range.

import { MINOR_UNITS, INSTRUMENT_TYPES } from "./venues.js";

export const SOURCE_ID = "yahoo-chart";
export const YAHOO_CHART_ORIGIN = "https://query1.finance.yahoo.com";
export const YAHOO_CHART_PATH = "/v8/finance/chart/";
export const SOURCE_INFO = Object.freeze({
  id: SOURCE_ID,
  provider: "Yahoo Finance",
  dataset: "Yahoo Finance chart data (unofficial, undocumented endpoint)",
  official: false,
  attribution: "Data: Yahoo Finance (unofficial chart endpoint), relayed by this site's market-data gateway. Not an exchange's official price.",
});

// Calendar days each history range covers, and the one interval served.
export const HISTORY_RANGES = Object.freeze({ "1mo": 31, "3mo": 92, "6mo": 184, "1y": 366, "2y": 731, "5y": 1827 });
export const HISTORY_INTERVALS = Object.freeze(["1d"]);
export const MAX_OBSERVATIONS = 2000;
const MAX_PRICE = 1e9;

export const ADJUSTMENT = Object.freeze({
  close: "Yahoo Finance close: adjusted for splits, not for dividends (price return).",
  adjClose: "Yahoo Finance adjusted close: adjusted for splits and for dividend and capital-gain distributions (total return), as Yahoo calculates it.",
});

export class UpstreamError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.code = code;
    this.detail = detail; // for logs only (never returned to the client)
  }
}

export function chartUrl(symbol, { kind, range = null }) {
  const url = new URL(`${YAHOO_CHART_ORIGIN}${YAHOO_CHART_PATH}${encodeURIComponent(symbol)}`);
  if (kind === "quote") {
    url.searchParams.set("range", "5d");
    url.searchParams.set("interval", "1d");
  } else {
    if (!Object.hasOwn(HISTORY_RANGES, range)) throw new UpstreamError("invalid_range");
    url.searchParams.set("range", range);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "div,split");
    url.searchParams.set("includeAdjustedClose", "true");
  }
  url.searchParams.set("includePrePost", "false");
  // Defence in depth: the request can only ever go to the fixed host and path.
  if (url.origin !== YAHOO_CHART_ORIGIN || url.pathname !== `${YAHOO_CHART_PATH}${symbol}`) throw new UpstreamError("invalid_symbol");
  return url.toString();
}

// Trading date of an epoch time in a venue's time zone, as YYYY-MM-DD.
export function dateIn(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

const cleanText = (value, max) => {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : null;
};
const isPrice = v => typeof v === "number" && Number.isFinite(v) && v > 0 && v < MAX_PRICE;
// Minor units (pence) to major units without binary noise (245.6 * 0.01 -> 2.456).
const scaled = (v, scale) => (scale === 1 ? v : Number((v * scale).toPrecision(12)));

function parseBody(text) {
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new UpstreamError("upstream_invalid", "not JSON"); }
  const chart = body?.chart;
  if (!chart || typeof chart !== "object" || Array.isArray(chart)) throw new UpstreamError("upstream_invalid", "no chart object");
  if (chart.error) {
    const code = String(chart.error?.code || "");
    if (/not ?found/i.test(code)) throw new UpstreamError("symbol_not_found", code.slice(0, 40));
    throw new UpstreamError("upstream_invalid", `chart.error ${code.slice(0, 40)}`);
  }
  if (chart.result === null || (Array.isArray(chart.result) && chart.result.length === 0)) throw new UpstreamError("symbol_not_found", "empty result");
  if (!Array.isArray(chart.result) || chart.result.length !== 1) throw new UpstreamError("upstream_invalid", "result is not one item");
  const result = chart.result[0];
  if (!result || typeof result !== "object" || !result.meta || typeof result.meta !== "object") throw new UpstreamError("upstream_invalid", "no meta");
  return result;
}

// Checks that the answer is for exactly the listing that was asked for.
function listingOf(meta, { symbol, mic, venue }) {
  if (typeof meta.symbol !== "string" || meta.symbol.toUpperCase() !== symbol) throw new UpstreamError("listing_mismatch", "symbol differs");
  if (!INSTRUMENT_TYPES.includes(meta.instrumentType)) throw new UpstreamError("unsupported_instrument", String(meta.instrumentType).slice(0, 20));
  if (!venue.exchanges.includes(meta.exchangeName)) throw new UpstreamError("listing_mismatch", `exchange ${String(meta.exchangeName).slice(0, 12)}`);
  const rawCurrency = typeof meta.currency === "string" ? meta.currency : null;
  if (!rawCurrency) throw new UpstreamError("currency_unknown", "no currency");
  if (!venue.currencies.includes(rawCurrency)) throw new UpstreamError("currency_mismatch", `currency ${rawCurrency.slice(0, 5)}`);
  const minor = MINOR_UNITS[rawCurrency];
  return {
    listing: {
      symbol, mic, venueName: venue.name, exchangeCode: meta.exchangeName,
      exchangeName: cleanText(meta.fullExchangeName, 60), instrumentType: meta.instrumentType,
      name: cleanText(meta.longName, 120) || cleanText(meta.shortName, 120), timeZone: venue.timeZone,
    },
    currency: minor || rawCurrency,
    rawCurrency,
    quoteUnit: minor ? "minor" : "major",
    unitScale: minor ? 0.01 : 1,
  };
}

// Latest regular-session price. Returns the md-gateway.quote.v1 body without the
// retrieval and cache fields (the gateway adds those).
export function normalizeQuote(text, { symbol, mic, venue, now }) {
  const result = parseBody(text);
  const meta = result.meta;
  const id = listingOf(meta, { symbol, mic, venue });
  const rawPrice = meta.regularMarketPrice;
  if (!isPrice(rawPrice)) throw new UpstreamError("no_price", "regularMarketPrice missing or not positive");
  const seconds = meta.regularMarketTime;
  const nowS = Math.floor(now / 1000);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > nowS + 600 || seconds < nowS - 5 * 366 * 86400) throw new UpstreamError("upstream_invalid", "regularMarketTime invalid");
  const tradingDate = dateIn(seconds * 1000, venue.timeZone);
  const missing = [];
  const optional = (value, field) => {
    if (value === undefined || value === null) { missing.push(field); return null; }
    if (!isPrice(value)) throw new UpstreamError("upstream_invalid", `${field} invalid`);
    return scaled(value, id.unitScale);
  };
  const dayHigh = optional(meta.regularMarketDayHigh, "dayHigh");
  const dayLow = optional(meta.regularMarketDayLow, "dayLow");
  let volume = null;
  if (Number.isFinite(meta.regularMarketVolume) && meta.regularMarketVolume >= 0) volume = meta.regularMarketVolume;
  else missing.push("volume");
  // Previous session close, from the daily bars of the same answer (never invented).
  let previousClose = null;
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes) && closes.length === ts.length) {
    for (let i = ts.length - 1; i >= 0; i -= 1) {
      if (!Number.isInteger(ts[i]) || dateIn(ts[i] * 1000, venue.timeZone) >= tradingDate) continue;
      if (closes[i] === null) continue;
      if (!isPrice(closes[i])) throw new UpstreamError("upstream_invalid", "close invalid");
      previousClose = scaled(closes[i], id.unitScale);
      break;
    }
  }
  if (previousClose === null) missing.push("previousClose");
  return {
    schema: "md-gateway.quote.v1",
    source: SOURCE_INFO,
    listing: id.listing,
    currency: id.currency, rawCurrency: id.rawCurrency, quoteUnit: id.quoteUnit, unitScale: id.unitScale,
    price: scaled(rawPrice, id.unitScale), rawPrice,
    priceBasis: "regular_market_price", adjusted: false,
    tradingDate, sourceTime: new Date(seconds * 1000).toISOString(),
    delay: { realTime: false, note: "Yahoo Finance does not state the delay of this price. Prices from many exchanges are delayed (often 15–20 minutes) during trading hours." },
    dayHigh, dayLow, volume, previousClose, missing,
  };
}

// Daily history for an allowlisted range. Missing closes stay null and are counted;
// zero, negative or non-numeric values make the whole answer invalid (fail closed).
// Dates are never filled in.
export function normalizeHistory(text, { symbol, mic, venue, range, now }) {
  const result = parseBody(text);
  const id = listingOf(result.meta, { symbol, mic, venue });
  const ts = result.timestamp;
  if (ts === undefined || (Array.isArray(ts) && ts.length === 0)) throw new UpstreamError("no_history", "no timestamps");
  if (!Array.isArray(ts) || ts.length > MAX_OBSERVATIONS) throw new UpstreamError("upstream_invalid", "timestamps invalid or too many");
  const closes = result.indicators?.quote?.[0]?.close;
  const adjRaw = result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(closes) || closes.length !== ts.length) throw new UpstreamError("upstream_invalid", "close array");
  if (adjRaw !== undefined && (!Array.isArray(adjRaw) || adjRaw.length !== ts.length)) throw new UpstreamError("upstream_invalid", "adjclose array");
  const adj = Array.isArray(adjRaw) ? adjRaw : null;
  const value = (v, field) => {
    if (v === null || v === undefined) return null;
    if (!isPrice(v)) throw new UpstreamError("upstream_invalid", `${field} not a positive number`);
    return scaled(v, id.unitScale);
  };
  const out = [];
  const missing = { rowsWithoutPrices: 0, closes: 0, adjCloses: 0, duplicateDates: 0 };
  let previous = -Infinity;
  const nowS = Math.floor(now / 1000);
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    if (!Number.isInteger(t) || t <= previous || t > nowS + 600) throw new UpstreamError("upstream_invalid", "timestamps not ascending");
    previous = t;
    const date = dateIn(t * 1000, venue.timeZone);
    const close = value(closes[i], "close");
    const adjClose = adj ? value(adj[i], "adjclose") : null;
    if (close === null && adjClose === null) { missing.rowsWithoutPrices += 1; continue; }
    if (close === null) missing.closes += 1;
    if (adj && adjClose === null) missing.adjCloses += 1;
    // Two bars on one trading date (Yahoo can append the running session): keep the later.
    if (out.length && out[out.length - 1][0] === date) { out[out.length - 1] = [date, close, adjClose]; missing.duplicateDates += 1; continue; }
    out.push([date, close, adjClose]);
  }
  if (!out.length) throw new UpstreamError("no_history", "no priced rows");
  const today = dateIn(now, venue.timeZone);
  return {
    schema: "md-gateway.history.v1",
    source: SOURCE_INFO,
    listing: id.listing,
    currency: id.currency, rawCurrency: id.rawCurrency, quoteUnit: id.quoteUnit, unitScale: id.unitScale,
    range, interval: "1d", frequency: "daily",
    adjustment: { ...ADJUSTMENT, adjCloseAvailable: Boolean(adj) && out.some(o => o[2] !== null) },
    observations: out,
    count: out.length, firstDate: out[0][0], lastDate: out[out.length - 1][0],
    lastBarMayBeIncomplete: out[out.length - 1][0] >= today,
    missing,
  };
}
