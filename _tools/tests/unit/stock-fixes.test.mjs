// Stock Comparison analytics fixes (audit Appendix C: B1, B2, B4) against hand-made
// fixtures with known answers.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../../../assets/js/stock-dashboard/analytics.js";
import { sanitizeText } from "../../../assets/js/shared/export-files.js";

const DAY = 86400000;
function series(ticker, prices, { start = Date.parse("2026-08-03T00:00:00Z"), basis = "close", frequency = "daily" } = {}) {
  const observations = [];
  let t = start;
  for (const price of prices) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY;
    observations.push({ date: new Date(t), price });
    t += DAY;
  }
  return { ticker, currency: "USD", priceBasis: basis, frequency, observations };
}
const drift = (n, start = 100, step = 0.001, wiggle = 0.01) => Array.from({ length: n }, (_, i) => start * Math.exp(step * i + wiggle * Math.sin(i * 1.7)));

test("3-for-2 and 5-for-4 splits on unadjusted closes are detected and the series is left out", () => {
  const base = drift(60);
  const split32 = base.map((p, i) => (i >= 40 ? p / 1.5 : p));
  const split54 = base.map((p, i) => (i >= 30 ? p / 1.25 : p));
  assert.equal(A.splitLikeMoves(A.alignLogReturns({ X: series("X", split32) }).X)[0].split, "3-for-2 split");
  assert.equal(A.splitLikeMoves(A.alignLogReturns({ X: series("X", split54) }).X)[0].split, "5-for-4 split");
  const reverse = base.map((p, i) => (i >= 20 ? p * 10 : p));
  assert.equal(A.splitLikeMoves(A.alignLogReturns({ X: series("X", reverse) }).X)[0].split, "1-for-10 reverse split");
  const result = A.runComparison({ S: series("S", split32), T: series("T", drift(60, 50)), U: series("U", drift(60, 20, 0.002)) });
  assert.deepEqual(result.excluded.map(e => e.ticker), ["S"]);
  assert.ok(!result.metrics.some(m => m.ticker === "S"));
  assert.match(result.warnings.find(w => w.startsWith("S was left out")), /-3\d\.\d% on \d{4}-\d{2}-\d{2}, like a 3-for-2 split/);
});

test("adjusted closes are never excluded for a split; ordinary moves are not split-like", () => {
  const base = drift(60);
  const adjusted = { A: series("A", base.map((p, i) => (i >= 40 ? p / 1.5 : p)), { basis: "adjusted_close" }), B: series("B", drift(60, 50)) };
  assert.equal(A.runComparison(adjusted).excluded.length, 0, "an adjusted series is trusted (the provider adjusted it)");
  assert.equal(A.splitLikeMoves(A.alignLogReturns({ X: series("X", drift(250, 100, 0.0005, 0.03)) }).X).length, 0);
});

test("a constant benchmark has no beta, correlation or diversification flag (no meaningless numbers)", () => {
  const flat = series("FLAT", Array(60).fill(10));
  const moving = series("MOV", drift(60));
  const result = A.runComparison({ FLAT: flat, MOV: moving }, { riskFreeAnnual: 0.04 });
  assert.equal(result.matrix.MOV.FLAT, null);
  const reg = A.regression(result.returns.MOV, result.returns.FLAT, 0.04, 252);
  assert.equal(reg.beta, null);
  assert.match(reg.note, /no variance/);
  assert.ok(result.warnings.some(w => /FLAT: its price did not change/.test(w)));
});

test("1D: a single return is not annualized; under six months is flagged as a short sample", () => {
  const oneDay = A.runComparison({ A: series("A", [100, 98]), B: series("B", [50, 50.5]) });
  for (const m of oneDay.metrics) {
    assert.equal(m.annualizedReturn, null, "no -99.6% 'annualized' from one day");
    assert.equal(m.sharpe, null);
    assert.ok(Math.abs(m.totalReturn) > 0);
  }
  const threeMonths = A.runComparison({ A: series("A", drift(63)), B: series("B", drift(63, 50)) });
  assert.ok(threeMonths.metrics.every(m => m.shortSample));
  assert.ok(threeMonths.warnings.some(w => /less than six months/.test(w)));
  const year = A.runComparison({ A: series("A", drift(253)), B: series("B", drift(253, 50)) });
  assert.ok(year.metrics.every(m => !m.shortSample));
});

test("export sanitizer neutralizes LF and full-width formula prefixes too", () => {
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "\n=1", "＝1", "＋1", "－1", "＠1"]) assert.ok(sanitizeText(bad).startsWith("'"), JSON.stringify(bad));
  assert.equal(sanitizeText("VEQT.TO"), "VEQT.TO");
});
