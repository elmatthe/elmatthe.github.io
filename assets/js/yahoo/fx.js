// Currency conversion from Yahoo Finance FX symbols only.
//
// Yahoo quotes FX as `<FROM><TO>=X`: the price is TO units per one FROM unit.
// Rates are fetched through the same validated proxy pipeline as prices. There is
// no other FX provider; when Yahoo cannot supply a pair, callers keep the native
// currency and show a warning instead of substituting another source.

import { fetchHistory, fetchQuote } from "./yahoo.js";

export const NORMALIZE_TARGETS = ["USD", "CAD", "EUR", "GBP"];

export const fxSymbol = (from, to) => `${String(from).toUpperCase()}${String(to).toUpperCase()}=X`;

// Forward-fill aligner: the rate at or before a date; the leading edge back-fills
// from the earliest known rate.
export function buildFxAligner(points) {
  const sorted = [...points].sort((a, b) => a.date - b.date);
  return date => {
    if (!sorted.length) return null;
    let lo = 0;
    let hi = sorted.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const rate = sorted[found >= 0 ? found : 0].price;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  };
}

// Converts every series to `target`. Returns { series, warnings }; inputs are not mutated.
export function normalizeSeries(seriesByTicker, target, alignerByCurrency) {
  const warnings = [];
  const out = {};
  for (const [ticker, series] of Object.entries(seriesByTicker)) {
    const native = String(series.currency || "").toUpperCase();
    if (!native) {
      warnings.push(`${ticker}: listing currency unknown; left unconverted.`);
      out[ticker] = series;
      continue;
    }
    if (native === target) { out[ticker] = series; continue; }
    const aligner = alignerByCurrency[native];
    if (!aligner) {
      warnings.push(`Yahoo Finance FX ${fxSymbol(native, target)} unavailable; ${ticker} is shown in ${native}.`);
      out[ticker] = series;
      continue;
    }
    out[ticker] = {
      ...series,
      nativeCurrency: native,
      currency: target,
      observations: series.observations.map(p => {
        const rate = aligner(p.date);
        return { date: p.date, price: rate ? p.price * rate : p.price };
      }),
    };
  }
  return { series: out, warnings };
}

// Daily FX history for every native currency that differs from `target`.
// `offlineRates(native, target)` supplies synthetic demo rates without any request.
export async function resolveAligners(seriesByTicker, target, range, { pipeline, signal, offlineRates, onStatus } = {}) {
  const natives = [...new Set(Object.values(seriesByTicker)
    .map(s => String(s.currency || "").toUpperCase())
    .filter(c => c && c !== target))];
  const aligners = {};
  const sources = {};
  const warnings = [];
  // Pad the window so the first price date can forward-fill from a prior fixing.
  const padded = { start: new Date(range.start.getTime() - 10 * 86400000), end: range.end };
  for (const native of natives) {
    if (offlineRates) {
      const points = offlineRates(native, target);
      if (points) { aligners[native] = buildFxAligner(points); sources[native] = "Synthetic demo FX"; }
      continue;
    }
    const symbol = fxSymbol(native, target);
    onStatus?.(`Fetching Yahoo Finance FX ${symbol}…`);
    try {
      const { series } = await fetchHistory(pipeline, symbol, padded, { signal });
      aligners[native] = buildFxAligner(series.observations);
      sources[native] = `Yahoo Finance ${symbol}`;
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`Yahoo Finance FX ${symbol} unavailable: ${error.message}`);
    }
  }
  return { aligners, sources, warnings };
}

// Latest FROM→TO rate (TO units per one FROM unit). Resolves null when unavailable.
export async function fetchFxRate(pipeline, from, to, { signal } = {}) {
  if (String(from).toUpperCase() === String(to).toUpperCase()) return { rate: 1, symbol: null };
  const symbol = fxSymbol(from, to);
  const quote = await fetchQuote(pipeline, symbol, { signal });
  if (!(quote.price > 0)) throw new Error(`${symbol} returned no usable rate.`);
  return { rate: quote.price, symbol, quote };
}
