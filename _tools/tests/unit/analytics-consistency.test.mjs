// Frequency/basis consistency (R02) and mixed-currency safeguards (R03) for the
// Stock Comparison tool. Deterministic: seeded paths, no network.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../../../assets/js/stock-dashboard/analytics.js";
import { buildWorkbookSheets, basisSummary, currencySummary, currencyRows } from "../../../assets/js/stock-dashboard/export.js";
import { buildFxAligner, normalizeSeries } from "../../../assets/js/market-data/fx-align.js";
import { parsePriceCsv } from "../../../assets/js/market-data/price-import.js";
import { selectBasis } from "../../../assets/js/market-data/contract.js";

const DAY = 86400000;
const d = s => new Date(`${s}T00:00:00Z`);
const iso = date => date.toISOString().slice(0, 10);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(seed) {
  const u = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

// Business-day closes from `start` (a Friday) for `weeks` weeks, driven by daily log
// returns; `shock` gives the daily return. Returns [{date, price}].
function dailyPath(start, weeks, shock, p0 = 100) {
  const out = [{ date: d(start), price: p0 }];
  let price = p0;
  for (let t = d(start).getTime() + DAY; out.length <= weeks * 5; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    price *= Math.exp(shock());
    out.push({ date: new Date(t), price });
  }
  return out;
}
// Weekly bars as Alpha Vantage dates them: the last trading day of each ISO week.
function weeklyFrom(daily) {
  const byWeek = new Map();
  for (const o of daily) byWeek.set(A.isoWeek(o.date), o);
  return [...byWeek.values()];
}
const series = (ticker, observations, frequency, extra = {}) => ({ ticker, observations, frequency, currency: "USD", priceBasis: "adjusted_close", ...extra });

/* ---------------- R02: daily vs weekly over the same window ---------------- */
test("daily and weekly samples of one path: what must match exactly, and what differs by convention", () => {
  const z = normals(20261102);
  const sigma = 0.012;
  const daily = dailyPath("2021-01-01", 260, () => 0.0003 + sigma * z()); // 5 years, Friday start
  const weekly = weeklyFrom(daily);
  assert.equal(iso(weekly[0].date), iso(daily[0].date));
  assert.equal(iso(weekly.at(-1).date), iso(daily.at(-1).date), "both windows start and end on the same close");
  const D = A.runComparison({ X: series("X", daily, "daily") }).metrics[0];
  const W = A.runComparison({ X: series("X", weekly, "weekly") }).metrics[0];
  const logTotal = Math.log(daily.at(-1).price / daily[0].price);

  // Identical by construction: same first and last price.
  assert.equal(D.totalReturn, W.totalReturn);
  // Annualized return: exp(mean log return x P) - 1, with P = 252 or 52.
  assert.ok(Math.abs(D.annualizedReturn - (Math.exp(logTotal / D.returnObservations * 252) - 1)) < 1e-12);
  assert.ok(Math.abs(W.annualizedReturn - (Math.exp(logTotal / W.returnObservations * 52) - 1)) < 1e-12);
  assert.equal(D.returnObservations, 5 * W.returnObservations, "no holidays in this path: five sessions per week");
  // Expected, not a bug: 52 weeks x 5 sessions = 260 sessions, but daily data is
  // annualized with 252, so the log-annualized returns differ by exactly 260/252.
  assert.ok(Math.abs(Math.log1p(W.annualizedReturn) / Math.log1p(D.annualizedReturn) - 260 / 252) < 1e-9);
  // Volatility: both estimate the same sigma; weekly carries the same 260/252 factor
  // (under the square root) plus sampling error from 5x fewer observations.
  const ratio = W.annualizedVolatility / D.annualizedVolatility;
  assert.ok(Math.abs(ratio / Math.sqrt(260 / 252) - 1) < 0.12, `weekly/daily volatility ratio ${ratio}`);
  assert.ok(Math.abs(D.annualizedVolatility / (sigma * Math.sqrt(252)) - 1) < 0.05, "daily estimate recovers the simulated volatility");
  // Weekly sampling can only miss intra-week troughs, never invent deeper ones.
  assert.ok(W.maxDrawdown >= D.maxDrawdown - 1e-15, `weekly ${W.maxDrawdown} vs daily ${D.maxDrawdown}`);
});

test("correlation and regression use only identical intervals at either frequency", () => {
  const z = normals(7);
  const common = [];
  const dailyA = dailyPath("2022-01-07", 104, () => { const c = z(); common.push(c); return 0.01 * c; });
  let i = 0;
  const dailyB = dailyPath("2022-01-07", 104, () => 0.01 * (0.8 * common[i++] + 0.6 * z()), 50);
  const rho = 0.8; // true correlation of daily returns
  const dr = A.runComparison({ A: series("A", dailyA, "daily"), B: series("B", dailyB, "daily") });
  const wr = A.runComparison({ A: series("A", weeklyFrom(dailyA), "weekly"), B: series("B", weeklyFrom(dailyB), "weekly") });
  assert.ok(Math.abs(dr.matrix.A.B - rho) < 0.06, String(dr.matrix.A.B));
  assert.ok(Math.abs(wr.matrix.A.B - rho) < 0.12, String(wr.matrix.A.B));
  assert.equal(dr.counts.A.B, dr.metrics[0].returnObservations);
  assert.equal(wr.periodsPerYear, 52);
  const reg = A.regression(wr.returns.B, wr.returns.A, 0.02, wr.periodsPerYear);
  assert.ok(Math.abs(reg.alphaAnnualized - reg.alpha * 52) < 1e-15, "weekly alpha annualized with 52");
  assert.ok(Math.abs(reg.beta - 0.8 * 50 / 50) < 0.15, String(reg.beta));
});

test("weekly bars dated Thursday (Friday holiday) still align with Friday bars by ISO week", () => {
  const x = [["2026-03-27", 100], ["2026-04-02", 102], ["2026-04-10", 101], ["2026-04-17", 103]].map(([s, p]) => ({ date: d(s), price: p }));
  const y = [["2026-03-27", 50], ["2026-04-03", 51], ["2026-04-10", 50.5], ["2026-04-17", 52]].map(([s, p]) => ({ date: d(s), price: p }));
  const r = A.runComparison({ X: series("X", x, "weekly"), Y: series("Y", y, "weekly") });
  assert.equal(r.counts.X.Y, 3, "Good Friday week aligned");
});

test("mixed frequencies are refused; unfinished periods are excluded at each frequency", () => {
  const obs = [{ date: d("2026-10-30"), price: 1 }, { date: d("2026-11-02"), price: 2 }];
  assert.throws(() => A.runComparison({ X: series("X", obs, "daily"), Y: series("Y", obs, "weekly") }), /same frequency/);
  const weekly = [d("2026-10-23"), d("2026-10-30"), d("2026-11-04")].map(date => ({ date, price: 1 }));
  assert.deepEqual(A.completedObservations(weekly, d("2026-11-04"), "weekly").map(o => iso(o.date)), ["2026-10-23", "2026-10-30"], "Wednesday: this week's bar is unfinished");
  assert.equal(A.completedObservations(weekly, d("2026-11-07"), "weekly").length, 3, "Saturday: the week is complete");
  const monthly = [d("2026-09-30"), d("2026-10-30"), d("2026-11-02")].map(date => ({ date, price: 1 }));
  assert.deepEqual(A.completedObservations(monthly, d("2026-11-20"), "monthly").map(o => iso(o.date)), ["2026-09-30", "2026-10-30"]);
  const daily = [d("2026-10-30"), d("2026-11-02")].map(date => ({ date, price: 1 }));
  assert.equal(A.completedObservations(daily, new Date("2026-11-02T15:00:00Z"), "daily").length, 1, "today's session is unfinished");
  assert.deepEqual(A.prepareHistory(series("W", weekly, "weekly"), "1D", { start: d("2026-10-20"), end: d("2026-11-04") }, d("2026-11-04")).observations, [], "1D needs daily data");
});

test("requested adjusted closes never silently become plain closes", () => {
  const daily = { symbol: "AAPL", observations: [{ date: d("2026-10-29"), close: 100, adjClose: null }, { date: d("2026-10-30"), close: 101, adjClose: null }] };
  const chosen = selectBasis(daily, "adjusted");
  assert.equal(chosen.priceBasis, "close");
  assert.match(chosen.warning, /no adjusted closes; unadjusted closes/);
  const mk = (bases, basis = "adjusted") => ({ basis, series: bases.map((b, i) => ({ ticker: `T${i}`, priceBasis: b })) });
  assert.equal(basisSummary(mk(["adjusted_close", "adjusted_close"])), "adjusted closes (total return)");
  assert.match(basisSummary(mk(["close", "close"])), /^plain closes \(price return\); adjusted closes were requested but are not available/);
  assert.equal(basisSummary(mk(["adjusted_close", "close"])), "adjusted closes requested; plain closes (price return) used for T1");
  assert.equal(basisSummary(mk(["close"], "close")), "plain closes (price return)");
  assert.match(basisSummary(mk(["synthetic"])), /synthetic/);
  const mixed = A.runComparison({ X: series("X", [{ date: d("2026-10-29"), price: 1 }, { date: d("2026-10-30"), price: 1.1 }], "daily"),
    Y: series("Y", [{ date: d("2026-10-29"), price: 1 }, { date: d("2026-10-30"), price: 1.2 }], "daily", { priceBasis: "close" }) });
  assert.equal(mixed.mixedBases, true);
  assert.match(mixed.warnings.join(" "), /adjusted closes .* plain closes/);
});

/* ---------------- R03: currency normalization safeguards ---------------- */
const fixings = (from, to, rate, step = 1) => {
  const out = [];
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += step * DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push({ date: new Date(t), rate });
  }
  return out;
};
const weekdays = (from, to, price = 10) => fixings(from, to, 0).map((p, i) => ({ date: p.date, price: price + i * 0.1 }));

test("USD vs CAD normalized to USD: converted price by price, status recorded", () => {
  const cad = weekdays("2026-10-01", "2026-10-30", 40);
  const { series: out, excluded, details } = normalizeSeries({
    "XIU.TO": series("XIU.TO", cad, "daily", { currency: "CAD" }),
    SPY: series("SPY", weekdays("2026-10-01", "2026-10-30", 600), "daily"),
  }, "USD", { CAD: buildFxAligner(fixings("2026-09-25", "2026-10-30", 0.72)) });
  assert.deepEqual(excluded, []);
  assert.equal(out["XIU.TO"].currency, "USD");
  assert.equal(out["XIU.TO"].nativeCurrency, "CAD");
  assert.ok(Math.abs(out["XIU.TO"].observations[0].price - 40 * 0.72) < 1e-12);
  assert.equal(details["XIU.TO"].status, "converted");
  assert.equal(details.SPY.status, "same");
});

test("GBp-quoted and GBP-quoted listings end up on the same scale", () => {
  const { histories } = parsePriceCsv("Date,Ticker,Close,Currency\n2026-10-28,TSCO.L,812.5,GBp\n2026-10-29,TSCO.L,820,GBp\n2026-10-30,TSCO.L,815,GBp\n2026-10-28,TSCO2.L,8.125,GBP\n2026-10-29,TSCO2.L,8.2,GBP\n2026-10-30,TSCO2.L,8.15,GBP\n", "uk.csv");
  const pick = h => ({ ...series(h.symbol, selectBasis(h, "close").observations, h.frequency, { currency: h.currency, priceBasis: "close" }) });
  const { series: out } = normalizeSeries({ "TSCO.L": pick(histories["TSCO.L"]), "TSCO2.L": pick(histories["TSCO2.L"]) }, "USD", { GBP: buildFxAligner(fixings("2026-10-20", "2026-10-30", 1.3)) });
  out["TSCO.L"].observations.forEach((o, i) => assert.ok(Math.abs(o.price - out["TSCO2.L"].observations[i].price) < 1e-12));
  assert.ok(Math.abs(out["TSCO.L"].observations[0].price - 8.125 * 1.3) < 1e-12, "pence divided by 100 exactly once");
});

test("unknown, unsupported or rate-less currencies are left out of a normalized comparison, never kept unconverted", () => {
  const { histories } = parsePriceCsv("Date,Close\n2026-10-01,10\n2026-10-02,11\n2026-10-05,12\n", "NOCUR.csv");
  const input = {
    SPY: series("SPY", weekdays("2026-10-01", "2026-10-30", 600), "daily"),
    NOCUR: series("NOCUR", selectBasis(histories.NOCUR, "close").observations, "daily", { currency: histories.NOCUR.currency }),
    "DDD.BA": series("DDD.BA", weekdays("2026-10-01", "2026-10-30", 900), "daily", { currency: "ARS" }),
    "XIU.TO": series("XIU.TO", weekdays("2026-10-01", "2026-10-30", 40), "daily", { currency: "CAD" }),
  };
  assert.equal(histories.NOCUR.currency, null, "a file without a Currency column has no currency");
  const { series: out, excluded, details } = normalizeSeries(input, "USD", { CAD: buildFxAligner(fixings("2026-09-25", "2026-10-30", 0.72)) });
  assert.deepEqual(Object.keys(out).sort(), ["SPY", "XIU.TO"]);
  assert.ok(Object.values(out).every(s => s.currency === "USD"), "every kept series is in the target currency");
  assert.deepEqual(excluded.map(e => [e.ticker, e.reason]), [["NOCUR", "unknown_currency"], ["DDD.BA", "no_rates"]]);
  assert.match(excluded[1].message, /no ARS→USD exchange rates.*left out.*Native currencies/);
  assert.equal(details.NOCUR.status, "unknown_currency");
  // In native-currency mode the unknown currency is never assumed to match.
  const native = A.runComparison({ SPY: input.SPY, NOCUR: input.NOCUR });
  assert.equal(native.mixedCurrencies, true);
  assert.match(native.warnings.join(" "), /Mixed currencies \(USD, unknown\)/);
  assert.equal(A.runComparison({ SPY: input.SPY, SPY2: { ...input.SPY, ticker: "SPY2" } }).mixedCurrencies, false, "same-currency comparisons are unaffected");
});

test("FX that starts later than prices, or goes stale, drops those prices; too few left excludes the series", () => {
  const prices = weekdays("2026-09-01", "2026-10-30", 40);
  const late = normalizeSeries({ X: series("X", prices, "daily", { currency: "CAD" }) }, "USD", { CAD: buildFxAligner(fixings("2026-10-01", "2026-10-30", 0.72)) });
  assert.equal(late.series.X.observations[0].date.toISOString().slice(0, 10), "2026-10-01");
  assert.equal(late.details.X.dropped, 22);
  assert.match(late.warnings.join(" "), /22 prices before the first available CAD→USD rate were dropped/);
  // Rates stop on 2026-10-09: prices more than 7 days later are not converted with that old rate.
  const stale = normalizeSeries({ X: series("X", prices, "daily", { currency: "CAD" }) }, "USD", { CAD: buildFxAligner(fixings("2026-08-25", "2026-10-09", 0.72)) });
  assert.equal(stale.series.X.observations.at(-1).date.toISOString().slice(0, 10), "2026-10-16");
  assert.equal(stale.details.X.staleDropped, 10);
  assert.match(stale.warnings.join(" "), /10 prices had no CAD→USD rate within 7 days/);
  // Rates only after every price: nothing convertible, so the series is left out.
  const none = normalizeSeries({ X: series("X", prices, "daily", { currency: "CAD" }), Y: series("Y", prices, "daily") }, "USD", { CAD: buildFxAligner(fixings("2026-11-03", "2026-11-10", 0.72)) });
  assert.deepEqual(none.excluded.map(e => [e.ticker, e.reason]), [["X", "no_overlap"]]);
  assert.deepEqual(Object.keys(none.series), ["Y"]);
});

test("exports state the currency and price basis actually used for every ticker", () => {
  const spy = series("SPY", weekdays("2026-10-01", "2026-10-30", 600), "weekly");
  const xiu = { ...series("XIU.TO", weekdays("2026-10-01", "2026-10-30", 30), "weekly"), nativeCurrency: "CAD", priceBasis: "close" };
  const result = A.runComparison({ SPY: spy, "XIU.TO": xiu });
  const comparison = {
    tickers: ["SPY", "XIU.TO"], horizon: "1Y", riskFree: 0, normalizedTo: "USD", excludedForCurrency: ["DDD.BA"], fxSources: { CAD: "Bank of Canada daily rates" },
    basis: "adjusted", frequency: result.frequency, periodsPerYear: result.periodsPerYear, mixedCurrencies: result.mixedCurrencies, mixedBases: result.mixedBases,
    liveNote: "LIVE NOTE", requestedStart: "2025-11-02", requestedEnd: "2026-11-02", source: "Alpha Vantage (your key)", series: [spy, xiu],
    metrics: result.metrics, matrix: result.matrix, counts: result.counts, warnings: result.warnings, provenance: [],
    regression: { benchmark: "SPY", rows: [{ ticker: "XIU.TO", ...A.regression(result.returns["XIU.TO"], result.returns.SPY, 0, 52) }] },
  };
  assert.equal(currencySummary(comparison), "normalized to USD (left out, not convertible: DDD.BA)");
  assert.deepEqual(currencyRows(comparison), [["SPY", "USD", "USD", "Already in USD"], ["XIU.TO", "CAD", "USD", "Converted from CAD with Bank of Canada daily rates"]]);
  const sheets = Object.fromEntries(buildWorkbookSheets({ comparison, generatedAt: "2026-11-02T00:00:00Z" }).map(s => [s.name, s.rows]));
  const text = rows => rows.map(r => (Array.isArray(r) ? r : r.cells).join("|")).join("\n");
  const readMe = text(sheets["Read Me & Sources"]);
  assert.match(readMe, /Price basis\|adjusted closes requested; plain closes \(price return\) used for XIU\.TO/);
  assert.match(readMe, /Sampling frequency\|weekly \(52 periods per year\)/);
  assert.match(readMe, /Currency\|normalized to USD \(left out, not convertible: DDD\.BA\)/);
  assert.match(readMe, /XIU\.TO\|CAD\|USD\|Converted from CAD/);
  assert.match(readMe, /Data note\|LIVE NOTE/);
  assert.match(text(sheets["Executive Summary"]), /XIU\.TO\|USD\|CAD\|close/);
  assert.match(text(sheets["Model & Calculations"]), /Alpha \(per week\)/);
  assert.match(text(sheets["Raw Data Ingestion"]), /Native currency/);
  // Native mode with mixed currencies says so.
  assert.equal(currencySummary({ series: [spy, { ...xiu, currency: "CAD", nativeCurrency: undefined }] }), "native currencies, mixed (CAD, USD)");
});
