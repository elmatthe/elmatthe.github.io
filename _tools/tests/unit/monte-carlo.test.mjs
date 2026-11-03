// Monte Carlo engine: reproducibility, extreme inputs and numerical stability.
import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../../../assets/js/monte-carlo/engine.js";

const BASE = { currentPortfolio: 150000, annualContribution: 10000, contributionGrowth: 0, yearsToRetirement: 30, yearsInRetirement: 25,
  expectedReturn: 7, volatility: 12, inflation: 2.5, annualSpending: 60000, pensionIncome: 18000, simulations: 2000 };
const run = (raw, seed = 7) => E.runSimulation(E.validateInputs(raw), { normal: E.boxMuller(E.mulberry32(seed)) });
// null is allowed only where a value is genuinely undefined (real dollars at -100% inflation).
const finiteDeep = value => (typeof value === "number" ? Number.isFinite(value) : value && typeof value === "object" ? Object.values(value).every(v => v === null || finiteDeep(v)) : true);

test("same seed reproduces a run exactly; different seeds differ", () => {
  const a = run(BASE, 123);
  const b = run(BASE, 123);
  const c = run(BASE, 124);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.percentilesByYear, b.percentilesByYear);
  assert.notDeepEqual(a.summary, c.summary);
});

test("seeded normal draws have mean ~0 and variance ~1", () => {
  const normal = E.boxMuller(E.mulberry32(99));
  const n = 200000;
  let sum = 0; let sq = 0;
  for (let i = 0; i < n; i += 1) { const z = normal(); sum += z; sq += z * z; }
  const mean = sum / n;
  const variance = sq / n - mean ** 2;
  assert.ok(Math.abs(mean) < 0.01, String(mean));
  assert.ok(Math.abs(variance - 1) < 0.01, String(variance));
});

test("seed parsing", () => {
  assert.equal(E.parseSeed(""), null);
  assert.equal(E.parseSeed(" 42 "), 42);
  assert.equal(E.parseSeed(String(E.MAX_SEED)), E.MAX_SEED);
  for (const bad of ["-1", "1.5", "abc", "4294967296", "1e3"]) assert.throws(() => E.parseSeed(bad), /Seed must be/, bad);
});

test("extreme but valid inputs give finite results or the documented error, never NaN", () => {
  const cases = [
    { ...BASE, volatility: 300, simulations: 500 },
    { ...BASE, expectedReturn: -100, volatility: 0, simulations: 3 },
    { ...BASE, expectedReturn: 100, volatility: 50, yearsToRetirement: 120, yearsInRetirement: 120, simulations: 200 },
    { ...BASE, currentPortfolio: 1e15, annualContribution: 1e15, annualSpending: 1e15, pensionIncome: 0, simulations: 50 },
    { ...BASE, inflation: -100, simulations: 10 },
    { ...BASE, contributionGrowth: 100, yearsToRetirement: 120, simulations: 10 },
  ];
  for (const raw of cases) {
    try {
      const result = run(raw);
      assert.ok(finiteDeep(result.summary), JSON.stringify(raw));
      for (const row of result.percentilesByYear) assert.ok(finiteDeep(row.nominal), JSON.stringify(raw));
      assert.ok(result.summary.successProbability >= 0 && result.summary.successProbability <= 100);
    } catch (error) {
      assert.match(error.message, /non-finite/, JSON.stringify(raw));
    }
  }
});

test("inflation of -100% leaves nominal results intact and marks real values unavailable", () => {
  const r = run({ ...BASE, inflation: -100, simulations: 10 });
  assert.equal(r.summary.realAvailable, false);
  assert.equal(r.summary.medianFinal.real, null);
  assert.ok(Number.isFinite(r.summary.medianFinal.nominal));
  assert.ok(r.percentilesByYear.every(row => row.real.p50 === null));
  assert.equal(run(BASE).summary.realAvailable, true);
});

test("total loss in every year means certain ruin, and percentiles stay ordered", () => {
  const r = run({ ...BASE, expectedReturn: -100, volatility: 0, annualContribution: 0, simulations: 5 });
  assert.equal(r.summary.successProbability, 0);
  assert.equal(r.summary.medianRuinYear, 1);
  for (const row of run(BASE).percentilesByYear) {
    const { p10, p25, p50, p75, p90 } = row.nominal;
    assert.ok(p10 <= p25 && p25 <= p50 && p50 <= p75 && p75 <= p90);
  }
});

test("percentileSorted matches numpy linear interpolation on small arrays", () => {
  const sorted = Float64Array.from([1, 2, 3, 4]);
  assert.equal(E.percentileSorted(sorted, 0.5), 2.5);
  assert.equal(E.percentileSorted(sorted, 0.1), 1.3);
  assert.equal(E.percentileSorted(Float64Array.from([5]), 0.9), 5);
});

test("spending basis: retirement-year dollars stay the default; today's dollars are converted", () => {
  const legacy = E.validateInputs(BASE);
  assert.equal(legacy.spendingBasis, "retirement");
  assert.deepEqual(E.firstYearWithdrawal(legacy), { entered: 42000, factor: 1, nominal: 42000, basis: "retirement" });
  const today = E.validateInputs({ ...BASE, spendingBasis: "today" });
  const first = E.firstYearWithdrawal(today);
  assert.ok(Math.abs(first.nominal - 88097.838321435) < 1e-6, String(first.nominal));
  const a = run(BASE, 5);
  const b = run({ ...BASE, spendingBasis: "today" }, 5);
  assert.equal(a.summary.netWithdrawal, 42000);
  assert.equal(b.summary.netWithdrawal, first.nominal);
  assert.equal(b.summary.netWithdrawalEntered, 42000);
  assert.ok(b.summary.successProbability < a.summary.successProbability);
  assert.throws(() => E.validateInputs({ ...BASE, spendingBasis: "nominal" }), /Spending basis/);
});

test("one number grammar: decimals and exponents yes; hex, nan, inf, underscores and non-ASCII digits no", () => {
  for (const ok of ["7", "-3.5", "+2", ".5", "5.", "1e3", "1.5E-2", " 42 "]) assert.notEqual(E.parseNumberText(ok), null, ok);
  for (const bad of ["", "abc", "nan", "NaN", "inf", "Infinity", "0x10", "1_000", "1,000", "١٠", "1e", "--1"]) assert.equal(E.parseNumberText(bad), null, bad);
  assert.equal(E.validateInputs({ ...BASE, yearsToRetirement: "30.0", simulations: "1e2" }).simulations, 100);
});

test("assumption warnings flag likely percent mix-ups and impossible returns without changing inputs", () => {
  const codes = raw => E.assumptionWarnings(E.validateInputs(raw)).map(w => w.code);
  assert.deepEqual(codes(BASE), []);
  assert.deepEqual(codes({ ...BASE, expectedReturn: 0.07 }), ["return_looks_fractional"]);
  assert.deepEqual(codes({ ...BASE, volatility: 50 }), ["volatility_high", "returns_below_total_loss"]);
  assert.deepEqual(codes({ ...BASE, volatility: 28 }), []);
  assert.deepEqual(codes({ ...BASE, inflation: -100 }), ["real_values_undefined"]);
  assert.ok(Math.abs(E.totalLossProbability({ expectedReturn: 7, volatility: 50 }) - 0.0162) < 0.0005);
  const r = run({ ...BASE, volatility: 50, simulations: 100 });
  assert.equal(r.warnings.length, 2);
  assert.equal(r.engineVersion, E.ENGINE_VERSION);
  assert.match(r.model, /arithmetic expected return/);
});

test("typical compound growth is below the arithmetic mean and matches simulation medians", () => {
  assert.ok(Math.abs(E.typicalGrowth(7, 12) - 6.33) < 0.01);
  assert.ok(Math.abs(E.typicalGrowth(7, 0) - 7) < 1e-12);
  assert.equal(E.typicalGrowth(-100, 10), null);
  // The audit measured a median CAGR of 6.34% at 7%/12% over 100,000 paths.
  assert.ok(Math.abs(E.typicalGrowth(7, 12) - 6.34) < 0.05);
});

test("draw count: ruined paths stop drawing, and the summary reports how many draws were used", () => {
  let used = 0;
  const normal = () => { used += 1; return 0; };
  const r = E.runSimulation(E.validateInputs({ ...BASE, expectedReturn: -100, volatility: 0, annualContribution: 0, simulations: 4 }), { normal });
  assert.equal(r.summary.draws, used);
  assert.equal(used, 4 * (30 + 1));
});
