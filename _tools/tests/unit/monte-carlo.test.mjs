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
