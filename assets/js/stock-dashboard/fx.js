// Currency normalization: convert each security's prices into one target currency
// before any returns are computed, so cross-currency comparisons reflect
// performance rather than FX drift.
//
// Primary source: Frankfurter (European Central Bank reference rates), which sends
// CORS headers and needs no proxy. Fallback: Yahoo Finance `<FROM><TO>=X` pairs
// through the proxy pipeline.

import { fetchHistory } from "./yahoo.js";

const FRANKFURTER_HOSTS = ["https://api.frankfurter.dev/v1", "https://api.frankfurter.app"];
export const NORMALIZE_TARGETS = ["USD", "CAD", "EUR", "GBP"];

const day = date => date.toISOString().slice(0, 10);

export function parseFrankfurter(payload, from, to) {
  const rates = payload?.rates;
  if (!rates || typeof rates !== "object") throw new Error("FX response missing rates");
  const points = Object.entries(rates)
    .map(([date, row]) => ({ date: new Date(`${date}T00:00:00Z`), price: row?.[to] }))
    .filter(p => !Number.isNaN(p.date.getTime()) && typeof p.price === "number" && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.date - b.date);
  if (!points.length) throw new Error(`No ${from}->${to} rates returned`);
  return points;
}

async function fetchFrankfurter(from, to, range, { signal, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  // Pad the start so the first price date can forward-fill from a prior fixing.
  const start = new Date(range.start.getTime() - 10 * 86400000);
  let lastError = null;
  for (const host of FRANKFURTER_HOSTS) {
    try {
      const url = `${host}/${day(start)}..${day(range.end)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const response = await fetchImpl(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseFrankfurter(await response.json(), from, to);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("FX source unavailable");
}

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
    return Number.isFinite(rate) ? rate : null;
  };
}

// Converts series in place-free fashion. Returns { series, warnings }.
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
      warnings.push(`FX rates unavailable for ${native}→${target}; ${ticker} is shown in ${native}.`);
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

// Resolves aligners for every native currency that differs from target.
// `offlineRates` (for synthetic demo data) bypasses the network entirely.
export async function resolveAligners(seriesByTicker, target, range, { pipeline, signal, offlineRates, onStatus, fetchImpl } = {}) {
  const natives = [...new Set(Object.values(seriesByTicker)
    .map(s => String(s.currency || "").toUpperCase())
    .filter(c => c && c !== target))];
  const aligners = {};
  const sources = {};
  const warnings = [];
  for (const native of natives) {
    if (offlineRates) {
      const points = offlineRates(native, target);
      if (points) { aligners[native] = buildFxAligner(points); sources[native] = "Synthetic demo FX"; }
      continue;
    }
    onStatus?.(`Fetching FX ${native}→${target} (ECB reference rates)…`);
    try {
      aligners[native] = buildFxAligner(await fetchFrankfurter(native, target, range, { signal, fetchImpl }));
      sources[native] = "ECB reference rates (Frankfurter)";
      continue;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    onStatus?.(`ECB rates unavailable for ${native}; trying Yahoo Finance ${native}${target}=X…`);
    try {
      const { series } = await fetchHistory(pipeline, `${native}${target}=X`, range, { signal });
      aligners[native] = buildFxAligner(series.observations);
      sources[native] = "Yahoo Finance FX";
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push(`FX ${native}→${target} unavailable from ECB and Yahoo Finance.`);
    }
  }
  return { aligners, sources, warnings };
}
