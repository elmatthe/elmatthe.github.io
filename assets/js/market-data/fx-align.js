// Aligning daily FX fixings to price dates and converting price series.
//
// Fixings are "target units per one native unit". A price dated D uses the latest
// fixing dated on or before D (forward fill across weekends and holidays). Price
// dates that precede every fixing are dropped rather than converted with a later
// rate, and an observation is never left in its native currency inside a series
// that claims to be converted.

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

// Converts every series to `target`. alignerByCurrency[native] converts native ->
// target. Returns { series, warnings, details }. Inputs are not mutated.
export function normalizeSeries(seriesByTicker, target, alignerByCurrency, { maxGapDays = 7 } = {}) {
  const warnings = [];
  const details = {};
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
      warnings.push(`${ticker}: no ${native}→${target} exchange rates were available; shown in ${native}, so it is not comparable in ${target}.`);
      out[ticker] = series;
      continue;
    }
    let dropped = 0;
    let maxGap = 0;
    const observations = [];
    for (const p of series.observations) {
      const fx = aligner(p.date);
      if (!fx) { dropped += 1; continue; }
      maxGap = Math.max(maxGap, fx.gapDays);
      observations.push({ date: p.date, price: p.price * fx.rate });
    }
    if (dropped) warnings.push(`${ticker}: ${dropped} price${dropped === 1 ? "" : "s"} before the first available ${native}→${target} rate ${dropped === 1 ? "was" : "were"} dropped.`);
    if (maxGap > maxGapDays) warnings.push(`${ticker}: some prices used a ${native}→${target} rate up to ${maxGap} days older than the price.`);
    details[ticker] = { native, dropped, maxGapDays: maxGap };
    out[ticker] = { ...series, nativeCurrency: native, currency: target, observations };
  }
  return { series: out, warnings, details };
}
