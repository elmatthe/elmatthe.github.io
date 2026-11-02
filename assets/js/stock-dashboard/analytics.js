// Dependency-free comparison analytics for the Stock Comparison & Analytics page.
//
// The site's client-side analytics engine:
//   * log returns between consecutive observations of one series. Each return is
//     keyed by its interval: the exact (previous date, current date) pair for daily
//     data, the (previous ISO week, current ISO week) pair for weekly data and the
//     (previous month, current month) pair for monthly data;
//   * pairwise correlations only over identical intervals, with observation counts,
//     and "unavailable" below three shared returns or at zero variance;
//   * P periods per year: 252 (daily), 52 (weekly) or 12 (monthly);
//     annualized return = exp(mean log return x P) - 1,
//     annualized volatility = sample stdev x sqrt(P);
//   * Sharpe ratio on the same log-return basis: (mean x P - ln(1 + rf)) / volatility;
//   * max drawdown from the running peak of the chosen price basis;
//   * OLS regression of excess log returns against a chosen benchmark.
// An observation for a period that may still be in progress (today's daily bar,
// this week's weekly bar on a weekday, this month's monthly bar) is excluded.
// Every series in one comparison must have the same frequency.

export const HORIZONS = ["1D", "1M", "3M", "6M", "9M", "YTD", "1Y", "3Y", "5Y"];
export const TRADING_DAYS = 252;
export const PERIODS_PER_YEAR = { daily: 252, weekly: 52, monthly: 12 };
export const MIN_CORRELATION_OBSERVATIONS = 3;
// |log return| above ln(1.8) in one period is flagged as a possible unadjusted
// split or data error (a 2:1 split shows as ln(0.5) = -0.69).
export const LARGE_MOVE_LOG = Math.log(1.8);

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

// ISO-8601 week label (e.g. 2026-W44) of a UTC date.
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
export const periodLabel = (date, frequency = "daily") =>
  frequency === "weekly" ? isoWeek(date) : frequency === "monthly" ? isoDate(date).slice(0, 7) : isoDate(date);

// An observation for a period that may still be trading is excluded so unfinished
// values stay out of returns: today's daily bar (same rule as the desktop tool),
// this ISO week's bar from Monday to Friday, and this month's monthly bar.
export function completedObservations(observations, now = new Date(), frequency = "daily") {
  if (frequency === "weekly") {
    const weekday = now.getUTCDay();
    if (weekday === 0 || weekday === 6) return observations.slice();
    const current = isoWeek(now);
    return observations.filter(item => isoWeek(item.date) !== current);
  }
  if (frequency === "monthly") {
    const month = isoDate(now).slice(0, 7);
    return observations.filter(item => isoDate(item.date).slice(0, 7) < month);
  }
  const today = isoDate(now);
  return observations.filter(item => isoDate(item.date) < today);
}

// Shapes one fetched/offline series for a horizon: completed periods only, trimmed
// to the requested start, and the last two observations for 1D (daily data only).
export function prepareHistory(series, horizon, range, now = new Date()) {
  const frequency = series.frequency || "daily";
  if (horizon === "1D" && frequency !== "daily") {
    return { ...series, observations: [], warnings: [`${series.ticker}: the 1D horizon needs daily prices; this series is ${frequency}.`] };
  }
  let observations = completedObservations(series.observations, now, frequency)
    .filter(item => item.date >= range.start || horizon === "1D");
  if (horizon === "1D") observations = observations.slice(-2);
  const warnings = [];
  const slack = frequency === "monthly" ? 35 : frequency === "weekly" ? 10 : 7;
  if (observations.length && horizon !== "1D" &&
      observations[0].date.getTime() > range.start.getTime() + slack * DAY_MS) {
    warnings.push(`${series.ticker}: requested history is only partially available (first price ${isoDate(observations[0].date)}).`);
  }
  return { ...series, observations, warnings };
}

export function alignLogReturns(histories) {
  const result = {};
  for (const [ticker, history] of Object.entries(histories)) {
    const frequency = history.frequency || "daily";
    const rows = [];
    let previous = null;
    let previousDate = null;
    for (const item of history.observations) {
      const price = finite(item.price);
      if (!(price > 0)) continue; // never a zero or invalid price
      const currentDate = isoDate(item.date);
      if (previous) {
        rows.push({ interval: `${periodLabel(new Date(`${previousDate}T00:00:00Z`), frequency)}|${periodLabel(item.date, frequency)}`, previousDate, currentDate, value: Math.log(price / previous) });
      }
      previous = price;
      previousDate = currentDate;
    }
    result[ticker] = rows;
  }
  return result;
}

// Periods whose log return magnitude exceeds LARGE_MOVE_LOG.
export function largeMoves(returnRows, threshold = LARGE_MOVE_LOG) {
  return returnRows.filter(r => Math.abs(r.value) > threshold).map(r => ({ date: r.currentDate, change: Math.exp(r.value) - 1 }));
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

export function comparisonMetrics(histories, returns, riskFreeAnnual = 0, periodsPerYear = TRADING_DAYS) {
  return Object.entries(histories).map(([ticker, history]) => {
    const prices = history.observations.map(item => item.price).filter(p => finite(p) > 0);
    const values = returns[ticker].map(row => row.value);
    const total = prices.length > 1 && prices[0] > 0 ? prices[prices.length - 1] / prices[0] - 1 : null;
    const m = values.length ? mean(values) : null;
    const variance = values.length > 1 ? values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1) : null;
    const annual = m !== null ? Math.exp(m * periodsPerYear) - 1 : null;
    const volatility = variance !== null ? Math.sqrt(variance * periodsPerYear) : null;
    let maxDrawdown = prices.length ? 0 : null;
    let peak = prices.length ? prices[0] : null;
    for (const price of prices) {
      peak = Math.max(peak, price);
      maxDrawdown = Math.min(maxDrawdown, price / peak - 1);
    }
    // Continuous-compounding Sharpe on the same log-return basis.
    const sharpe = m !== null && volatility ? (m * periodsPerYear - Math.log(1 + riskFreeAnnual)) / volatility : null;
    return {
      ticker,
      currency: history.currency || null,
      priceBasis: history.priceBasis || null,
      frequency: history.frequency || "daily",
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
export function regression(yReturns, xReturns, riskFreeAnnual = 0, periodsPerYear = TRADING_DAYS) {
  const rfPer = Math.log(1 + riskFreeAnnual) / periodsPerYear;
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
    alpha: finite(alpha), alphaAnnualized: finite(alpha * periodsPerYear), beta: finite(beta),
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
  const list = Object.values(histories);
  const frequencies = [...new Set(list.map(h => h.frequency || "daily"))];
  if (frequencies.length > 1) throw new Error(`Every series must have the same frequency; got ${frequencies.join(" and ")}.`);
  const frequency = frequencies[0] || "daily";
  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const currencies = [...new Set(list.map(h => h.currency).filter(Boolean))].sort();
  const bases = [...new Set(list.map(h => h.priceBasis).filter(Boolean))];
  const warnings = [];
  if (currencies.length > 1) {
    warnings.push(`Mixed currencies (${currencies.join(", ")}): returns and correlations include each currency's own exchange-rate moves; choose "Normalize to currency" to compare in one currency.`);
  }
  if (bases.length > 1) {
    warnings.push("Some series use adjusted closes (dividends included) and others plain closes (price only), so their returns are not directly comparable.");
  }
  const returns = alignLogReturns(histories);
  for (const [ticker, rows] of Object.entries(returns)) {
    const moves = largeMoves(rows);
    if (moves.length) warnings.push(`${ticker}: ${moves.length} unusually large one-period move${moves.length === 1 ? "" : "s"} (${moves.slice(0, 3).map(m => `${m.date} ${(m.change * 100).toFixed(0)}%`).join(", ")}): possibly an unadjusted split or a data error. Check before relying on the results.`);
  }
  const { matrix, counts } = correlationMatrix(returns);
  const metrics = comparisonMetrics(histories, returns, riskFreeAnnual, periodsPerYear);
  return { returns, matrix, counts, metrics, currencies, warnings, frequency, periodsPerYear };
}
