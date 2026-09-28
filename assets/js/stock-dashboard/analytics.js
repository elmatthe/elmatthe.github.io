// Dependency-free adjusted-price comparison analytics.
//
// Browser port of the TipRanks Automation Tool comparison engine
// (scripts/services/analytics.py and scripts/services/comparison.py on
// feature/0.1.0-initial-dashboard). Semantics are kept identical so results match
// the desktop tool:
//   * daily log returns, keyed by the exact (previous date, current date) interval;
//   * pairwise correlations only over identical intervals, with observation counts,
//     and "unavailable" below three shared returns or at zero variance;
//   * annualized return = exp(mean log return x 252) - 1,
//     annualized volatility = sample stdev x sqrt(252);
//   * max drawdown from the running peak of adjusted closes.
// Sharpe ratio and benchmark regression are carried over from the website's
// previous dashboard and computed on the same exact-interval log returns.

export const HORIZONS = ["1D", "1M", "3M", "6M", "9M", "YTD", "1Y", "3Y", "5Y"];
export const TRADING_DAYS = 252;
export const MIN_CORRELATION_OBSERVATIONS = 3;

const DAY_MS = 86400000;

export const isoDate = date => date.toISOString().slice(0, 10);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

function monthsAgo(value, months) {
  const index = value.getUTCFullYear() * 12 + value.getUTCMonth() - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(value.getUTCDate(), lastDay),
    value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()));
}

// Returns { start, end } as Date objects in UTC.
export function resolveHorizon(horizon, now = new Date()) {
  if (!HORIZONS.includes(horizon)) throw new Error("Unsupported comparison horizon.");
  const end = new Date(now.getTime());
  let start;
  // Ten calendar days reliably spans weekends and ordinary exchange holidays; the
  // comparison later keeps only the latest two proven-complete observations.
  if (horizon === "1D") start = new Date(end.getTime() - 10 * DAY_MS);
  else if (horizon === "YTD") start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  else if (horizon.endsWith("M")) start = monthsAgo(end, parseInt(horizon, 10));
  else start = monthsAgo(end, parseInt(horizon, 10) * 12);
  return { start, end };
}

// A daily bar dated today is not proven to be a completed session, so it is
// excluded to keep intraday values out of returns (same rule as the desktop tool).
export function completedObservations(observations, now = new Date()) {
  const today = isoDate(now);
  return observations.filter(item => isoDate(item.date) < today);
}

// Shapes one fetched/offline series for a horizon: completed sessions only, trimmed
// to the requested start, and the last two observations for 1D.
export function prepareHistory(series, horizon, range, now = new Date()) {
  let observations = completedObservations(series.observations, now)
    .filter(item => item.date >= range.start || horizon === "1D");
  if (horizon === "1D") observations = observations.slice(-2);
  const warnings = [];
  if (observations.length && horizon !== "1D" &&
      observations[0].date.getTime() > range.start.getTime() + 7 * DAY_MS) {
    warnings.push(`${series.ticker}: requested history is only partially available.`);
  }
  return { ...series, observations, warnings };
}

export function alignLogReturns(histories) {
  const result = {};
  for (const [ticker, history] of Object.entries(histories)) {
    const rows = [];
    let previous = null;
    let previousDate = null;
    for (const item of history.observations) {
      const price = finite(item.price);
      const currentDate = isoDate(item.date);
      if (previous && price && previous > 0 && price > 0) {
        rows.push({ interval: `${previousDate}|${currentDate}`, previousDate, currentDate, value: Math.log(price / previous) });
      }
      previous = price;
      previousDate = currentDate;
    }
    result[ticker] = rows;
  }
  return result;
}

export function pairReturns(left, right) {
  const b = new Map(right.map(row => [row.interval, row.value]));
  const x = [];
  const y = [];
  const intervals = left.map(row => row.interval).filter(key => b.has(key)).sort();
  const a = new Map(left.map(row => [row.interval, row.value]));
  for (const key of intervals) { x.push(a.get(key)); y.push(b.get(key)); }
  return { x, y };
}

const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;

export function pearson(x, y) {
  if (x.length < MIN_CORRELATION_OBSERVATIONS) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const denominator = Math.sqrt(sxx * syy);
  return denominator ? finite(sxy / denominator) : null;
}

export function correlationMatrix(returns) {
  const tickers = Object.keys(returns);
  const matrix = {};
  const counts = {};
  for (const left of tickers) {
    matrix[left] = {};
    counts[left] = {};
    for (const right of tickers) {
      const { x, y } = pairReturns(returns[left], returns[right]);
      counts[left][right] = x.length;
      matrix[left][right] = pearson(x, y);
    }
  }
  return { matrix, counts };
}

export function comparisonMetrics(histories, returns, riskFreeAnnual = 0) {
  return Object.entries(histories).map(([ticker, history]) => {
    const prices = history.observations.map(item => item.price);
    const values = returns[ticker].map(row => row.value);
    const total = prices.length > 1 && prices[0] > 0 ? prices[prices.length - 1] / prices[0] - 1 : null;
    const m = values.length ? mean(values) : null;
    const variance = values.length > 1 ? values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1) : null;
    const annual = m !== null ? Math.exp(m * TRADING_DAYS) - 1 : null;
    const volatility = variance !== null ? Math.sqrt(variance * TRADING_DAYS) : null;
    let maxDrawdown = prices.length ? 0 : null;
    let peak = prices.length ? prices[0] : null;
    for (const price of prices) {
      peak = Math.max(peak, price);
      maxDrawdown = Math.min(maxDrawdown, price / peak - 1);
    }
    // Continuous-compounding Sharpe on the same log-return basis.
    const sharpe = m !== null && volatility ? (m * TRADING_DAYS - Math.log(1 + riskFreeAnnual)) / volatility : null;
    return {
      ticker,
      currency: history.currency || null,
      priceObservations: prices.length,
      returnObservations: values.length,
      actualStart: history.observations.length ? isoDate(history.observations[0].date) : null,
      actualEnd: history.observations.length ? isoDate(history.observations[history.observations.length - 1].date) : null,
      totalReturn: finite(total),
      annualizedReturn: finite(annual),
      annualizedVolatility: finite(volatility),
      sharpe: finite(sharpe),
      maxDrawdown: finite(maxDrawdown),
    };
  });
}

/* ---------- Student-t two-tailed p-value (regularized incomplete beta) ---------- */
function betacf(a, b, x) {
  const fpmin = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}
function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}
export function tTwoTailedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return null;
  return betai(df / 2, 0.5, df / (df + t * t));
}

// OLS of excess log returns (y on benchmark x) over exact shared intervals.
export function regression(yReturns, xReturns, riskFreeAnnual = 0) {
  const rfPer = Math.log(1 + riskFreeAnnual) / TRADING_DAYS;
  const { x: ys0, y: xs0 } = pairReturns(yReturns, xReturns);
  const ys = ys0.map(v => v - rfPer);
  const xs = xs0.map(v => v - rfPer);
  const n = xs.length;
  const empty = { alpha: null, alphaAnnualized: null, beta: null, r2: null, t: null, p: null, n };
  if (n < 3) return empty;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!sxx) return empty;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (ys[i] - (alpha + beta * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : null;
  const se = Math.sqrt(ssRes / (n - 2) / sxx);
  const t = se ? beta / se : null;
  return {
    alpha: finite(alpha), alphaAnnualized: finite(alpha * TRADING_DAYS), beta: finite(beta),
    r2: finite(r2), t: finite(t), p: t === null ? null : finite(tTwoTailedP(t, n - 2)), n,
  };
}

export function diversificationFlags(tickers, matrix, { high = 0.85, low = 0.3 } = {}) {
  const flags = { high: [], low: [] };
  tickers.forEach((left, i) => tickers.slice(i + 1).forEach(right => {
    const value = matrix[left]?.[right];
    if (value === null || value === undefined) return;
    if (value >= high) flags.high.push({ left, right, value });
    else if (value <= low) flags.low.push({ left, right, value });
  }));
  return flags;
}

// Chart transforms keyed by ISO date.
export function indexedSeries(observations) {
  const base = observations.length ? observations[0].price : null;
  return observations.map(item => ({ date: isoDate(item.date), value: base ? item.price / base * 100 : null }));
}
export function drawdownSeries(observations) {
  let peak = -Infinity;
  return observations.map(item => {
    peak = Math.max(peak, item.price);
    return { date: isoDate(item.date), value: peak > 0 ? item.price / peak - 1 : null };
  });
}

// Full comparison run over already-prepared histories. Mirrors ComparisonService._execute.
export function runComparison(histories, { riskFreeAnnual = 0 } = {}) {
  const currencies = [...new Set(Object.values(histories).map(h => h.currency).filter(Boolean))].sort();
  const warnings = [];
  if (currencies.length > 1) {
    warnings.push("Mixed listing currencies are shown in native currency; values are not FX-normalized.");
  }
  const returns = alignLogReturns(histories);
  const { matrix, counts } = correlationMatrix(returns);
  const metrics = comparisonMetrics(histories, returns, riskFreeAnnual);
  return { returns, matrix, counts, metrics, currencies, warnings };
}
