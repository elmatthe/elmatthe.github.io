// Aligning daily FX fixings to price dates and converting price series.
//
// Fixings are "target units per one native unit". A price dated D uses the latest
// fixing dated on or before D (forward fill across weekends and holidays). Price
// dates that precede every fixing, or that are more than a week past the latest
// fixing, are dropped rather than converted with an unrelated rate, and a series is
// never left in its native currency inside a comparison that claims to be converted.

const DAY_MS = 86400000;

// points: [{ date: Date | "YYYY-MM-DD", rate }]
export function buildFxAligner(points) {
  const sorted = points
    .map(p => ({ date: p.date instanceof Date ? p.date : new Date(`${p.date}T00:00:00Z`), rate: p.rate }))
    .filter(p => Number.isFinite(p.date.getTime()) && Number.isFinite(p.rate) && p.rate > 0)
    .sort((a, b) => a.date - b.date);
  const aligner = date => {
    let lo = 0;
    let hi = sorted.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return null;
    return { rate: sorted[found].rate, fixingDate: sorted[found].date, gapDays: Math.round((date - sorted[found].date) / DAY_MS) };
  };
  aligner.points = sorted.length;
  aligner.first = sorted[0]?.date || null;
  aligner.last = sorted[sorted.length - 1]?.date || null;
  return aligner;
}

// Converts series to `target` for a comparison. alignerByCurrency[native] converts
// native -> target. Returns { series, excluded, details, warnings }:
//   series    only series that are entirely in `target` (already in it, or converted
//             price by price). A series is never left partly or wholly in another
//             currency inside a comparison that claims to be in `target`.
//   excluded  [{ ticker, native, reason, message }] for series that could not be
//             converted: reason "unknown_currency" | "no_rates" | "no_overlap".
//   details   per ticker { native, status: "same" | "converted" | <reason>,
//             dropped, staleDropped, maxGapDays }.
// A price uses the latest fixing on or before its date. Prices dated before the
// first fixing, or more than maxGapDays after the latest fixing (stale or missing
// rates), are dropped and counted rather than converted with an unrelated rate.
export function normalizeSeries(seriesByTicker, target, alignerByCurrency, { maxGapDays = 7, minObservations = 2 } = {}) {
  const warnings = [];
  const details = {};
  const excluded = [];
  const out = {};
  const exclude = (ticker, native, reason, message) => {
    details[ticker] = { ...(details[ticker] || { native, dropped: 0, staleDropped: 0, maxGapDays: 0 }), status: reason };
    excluded.push({ ticker, native, reason, message });
  };
  for (const [ticker, series] of Object.entries(seriesByTicker)) {
    const native = String(series.currency || "").toUpperCase() || null;
    if (!native) {
      exclude(ticker, null, "unknown_currency", `${ticker}: its currency is unknown, so it cannot be converted to ${target}. It was left out of this ${target} comparison; choose "Native currencies" to include it, or add a Currency column to your file.`);
      continue;
    }
    if (native === target) {
      out[ticker] = series;
      details[ticker] = { native, status: "same", dropped: 0, staleDropped: 0, maxGapDays: 0 };
      continue;
    }
    const aligner = alignerByCurrency[native];
    if (!aligner) {
      exclude(ticker, native, "no_rates", `${ticker}: no ${native}→${target} exchange rates were available, so it was left out of this ${target} comparison. Choose "Native currencies" to compare it in ${native}.`);
      continue;
    }
    let dropped = 0;
    let staleDropped = 0;
    let maxGap = 0;
    const observations = [];
    for (const p of series.observations) {
      const fx = aligner(p.date);
      if (!fx) { dropped += 1; continue; }
      if (fx.gapDays > maxGapDays) { staleDropped += 1; continue; }
      maxGap = Math.max(maxGap, fx.gapDays);
      observations.push({ date: p.date, price: p.price * fx.rate });
    }
    details[ticker] = { native, status: "converted", dropped, staleDropped, maxGapDays: maxGap };
    if (observations.length < minObservations) {
      exclude(ticker, native, "no_overlap", `${ticker}: fewer than ${minObservations} of its prices have a ${native}→${target} rate within ${maxGapDays} days, so it was left out of this ${target} comparison.`);
      continue;
    }
    if (dropped) warnings.push(`${ticker}: ${dropped} price${dropped === 1 ? "" : "s"} before the first available ${native}→${target} rate ${dropped === 1 ? "was" : "were"} dropped.`);
    if (staleDropped) warnings.push(`${ticker}: ${staleDropped} price${staleDropped === 1 ? "" : "s"} had no ${native}→${target} rate within ${maxGapDays} days and ${staleDropped === 1 ? "was" : "were"} dropped rather than converted with an old rate.`);
    out[ticker] = { ...series, nativeCurrency: native, currency: target, observations };
  }
  return { series: out, excluded, details, warnings };
}
