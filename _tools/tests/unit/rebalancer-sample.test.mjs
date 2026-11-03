// Portfolio Rebalancer: the unified 14-holding sample (no network).
//
// All fourteen rows are ordinary holdings: same row model, same activity rule, same
// valuation gate and plan. The four international examples (JPY, EUR, GBP in pence,
// CNY) have one share and 2.5% each; the ten Questrade targets are scaled to 90%.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as E from "../../../assets/js/portfolio-rebalancer/engine.js";
import * as R from "../../../assets/js/portfolio-rebalancer/rows.js";
import { SAMPLE_PORTFOLIO, INTERNATIONAL_EXAMPLE_TAG, isUnchangedInternationalExample, targetTotalBasisPoints } from "../../../assets/js/portfolio-rebalancer/sample.js";
import { createInstrumentResolver } from "../../../assets/js/market-data/instruments.js";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("../../../assets/data/instruments.v1.json", import.meta.url), "utf8"));
const resolver = createInstrumentResolver(REFERENCE);
const EXPECTED = [
  ["VEQT.TO", 305, 63], ["CNQ.TO", 48, 9], ["XQQ.TO", 27, 6.3], ["HEWB.TO", 14, 4.5], ["AAPL", 2, 1.8], ["VFV.TO", 8, 0.9],
  ["SPCX", 1, 0.9], ["CBRS", 4, 0.9], ["YNVD.NE", 4, 1.8], ["VST", 1, 0.9],
  ["7203.T", 1, 2.5], ["SAP.DE", 1, 2.5], ["VOD.L", 1, 2.5], ["600519.SS", 1, 2.5],
];
// Reference prices in major units and CAD per unit: identical to the Python parity test.
const PRICES = { "VEQT.TO": 60.84, "CNQ.TO": 75.12, "XQQ.TO": 68.0, "HEWB.TO": 74.04, AAPL: 338.32, "VFV.TO": 187.16, SPCX: 136.37, CBRS: 96.36, "YNVD.NE": 44.21, VST: 134.61, "7203.T": 2850, "SAP.DE": 220, "VOD.L": 72.15, "600519.SS": 1500 };
const CAD_PER = { CAD: 1, USD: 1.3978, EUR: 1.6, GBP: 1.85, JPY: 0.0091, CNY: 0.2102 };
const loaded = () => SAMPLE_PORTFOLIO.rows.map(r => R.createRow(r));

test("the sample is fourteen ordinary holdings in the exact order, shares and targets", () => {
  assert.deepEqual(SAMPLE_PORTFOLIO.rows.map(r => [r.ticker, r.shares, r.targetWeight]), EXPECTED);
  assert.equal(SAMPLE_PORTFOLIO.reportingCurrency, "CAD");
  assert.equal(SAMPLE_PORTFOLIO.mode, "new_money");
  assert.equal(SAMPLE_PORTFOLIO.budget, 3000);
  assert.ok(SAMPLE_PORTFOLIO.rows.every(r => r.accountType === ""), "account type blank for every holding");
  assert.ok(SAMPLE_PORTFOLIO.rows.every(r => !("group" in r) && !("price" in r)), "no separate group, no embedded price");
  const rows = loaded();
  assert.equal(rows.length, 14);
  assert.ok(rows.every(R.isActive), "every holding has shares and a target, so every one is priced and planned");
  assert.ok(rows.every(r => r.status === "draft" && !r.quote && !r.manual && R.effectivePrice(r) === null), "no prices before Get prices");
  assert.deepEqual(rows.filter(r => r.sampleTag === INTERNATIONAL_EXAMPLE_TAG).map(r => [r.ticker, r.shares]), [["7203.T", "1"], ["SAP.DE", "1"], ["VOD.L", "1"], ["600519.SS", "1"]]);
});

test("targets total exactly 100.0%; the ten Questrade targets are the earlier ones scaled to 90%", () => {
  assert.equal(targetTotalBasisPoints(SAMPLE_PORTFOLIO.rows), 10000);
  const earlier = [70, 10, 7, 5, 2, 1, 1, 1, 2, 1];
  SAMPLE_PORTFOLIO.rows.slice(0, 10).forEach((r, i) => assert.equal(Math.round(r.targetWeight * 100), Math.round(earlier[i] * 90), r.ticker));
  assert.equal(targetTotalBasisPoints(SAMPLE_PORTFOLIO.rows.slice(10)), 1000, "four international holdings at 2.5% each");
  assert.deepEqual(E.weightWarnings(SAMPLE_PORTFOLIO.rows.map(r => ({ targetWeight: r.targetWeight }))), [], "no 'does not add up to 100' warning");
});

test("YNVD.NE is the Cboe Canada ETF in CAD; legacy YNVD.TO is the same instrument; neither is a TSX listing", () => {
  const ne = resolver.resolve("YNVD.NE");
  const to = resolver.resolve("YNVD.TO");
  assert.equal(ne.canonicalId, "NEOE:YNVD");
  assert.equal(to.canonicalId, ne.canonicalId, "the brokerage display alias resolves to the same security");
  assert.equal(ne.mic, "NEOE");
  assert.notEqual(ne.mic, "XTSE");
  assert.equal(ne.currency, "CAD");
  assert.match(ne.name, /NVIDIA \(NVDA\) Yield Shares Purpose ETF/);
  assert.equal(ne.displayTicker, "YNVD.NE");
  assert.equal(to.displayTicker, "YNVD.TO", "the alias is kept as typed");
});

test("international holdings keep their listing currency and exact units (pence are divided by 100)", () => {
  const want = { "7203.T": ["XTKS:7203", "JPY", 1], "SAP.DE": ["XETR:SAP", "EUR", 1], "VOD.L": ["XLON:VOD", "GBP", 0.01], "600519.SS": ["XSHG:600519", "CNY", 1] };
  for (const [ticker, [id, currency, scale]] of Object.entries(want)) {
    const r = resolver.resolve(ticker);
    assert.deepEqual([r.canonicalId, r.currency, r.unitScale], [id, currency, scale], ticker);
  }
  // A user-supplied VOD.L price entered in pence becomes pounds; GBX itself is not a currency.
  const vod = R.setManualPrice(R.createRow({ ticker: "VOD.L", shares: 1, targetWeight: 2.5 }), { price: 7215, currency: "GBP", unitScale: 0.01 });
  assert.equal(vod.manual.price, 72.15);
  assert.equal(vod.manual.currency, "GBP");
  assert.equal(R.effectivePrice(vod).price, 72.15);
});

test("invalid currencies and units are rejected for user-supplied prices", () => {
  const row = R.createRow({ ticker: "VOD.L", shares: 1, targetWeight: 2.5 });
  for (const bad of ["", "gbp", "GB", "GBPX", "US$", null]) assert.throws(() => R.setManualPrice(row, { price: 1, currency: bad }), /currency/, String(bad));
  assert.throws(() => R.setManualPrice(row, { price: 7215, currency: "GBX" }), /minor unit/);
  assert.throws(() => R.setManualPrice(row, { price: 1, currency: "GBP", unitScale: 0.5 }), /pence/);
  for (const bad of [0, -1, NaN, Infinity, "abc"]) assert.throws(() => R.setManualPrice(row, { price: bad, currency: "GBP" }), /greater than 0/, String(bad));
});

test("zero and missing prices never value a holding; the plan stays withheld", () => {
  const rows = loaded();
  const now = Date.parse("2026-11-03T15:00:00Z");
  const fxAvailable = () => true;
  let v = E.assessValuation(rows.map(r => R.valuationRow(r, { now, fxAvailable })));
  assert.equal(v.ready, false);
  assert.equal(v.required, 14);
  assert.equal(v.unpriced.length, 14);
  // A failed quote and a zero price are not prices.
  const failed = { ...rows[13], status: "failed", quote: null, error: { kind: "not_covered", message: "Not covered" } };
  assert.equal(R.effectivePrice(failed), null);
  v = E.assessValuation([{ rowId: "x", ticker: "600519.SS", shares: "1", targetWeight: "2.5", price: 0, currency: "CNY", fxAvailable: true, source: { kind: "provider", currencyVerified: true, freshness: "current" } }]);
  assert.equal(v.ready, false);
  assert.match(v.unpriced[0].reason, /no price/);
});

function planFor(rows, mode = "new_money", budget = 3000) {
  const positions = rows.map((r, i) => {
    const id = resolver.resolve(r.ticker);
    return { rowIndex: i, rowId: r.id, ticker: r.ticker, shares: E.parseNumber(r.shares), price: PRICES[r.ticker], currencyKey: id.currency, targetWeight: E.parseNumber(r.targetWeight), accountType: "" };
  });
  return { positions, plan: E.calculateRebalancePlan(E.attachFxValues(positions, CAD_PER, "CAD"), mode, budget) };
}

test("all fourteen holdings take part in valuation, allocation and the plan", () => {
  const { plan } = planFor(loaded());
  assert.equal(plan.results.length, 14);
  const by = Object.fromEntries(plan.results.map(r => [r.ticker, r]));
  assert.ok(Math.abs(by["VOD.L"].currentValue - 72.15 * 1.85) < 1e-9, "VOD.L: 1 share x 72.15 GBP x 1.85 CAD/GBP");
  assert.ok(Math.abs(by["7203.T"].currentValue - 2850 * 0.0091) < 1e-9);
  assert.ok(Math.abs(by["SAP.DE"].currentValue - 220 * 1.6) < 1e-9);
  assert.ok(Math.abs(by["600519.SS"].currentValue - 1500 * 0.2102) < 1e-9);
  for (const t of ["7203.T", "SAP.DE", "VOD.L", "600519.SS"]) assert.ok(Math.abs(by[t].targetWeightNorm - 0.025) < 1e-12, t);
  const total = plan.results.reduce((s, r) => s + r.currentValue, 0);
  assert.ok(Math.abs(plan.summary.totalCurrent - total) < 1e-9, "portfolio value includes every holding");
  assert.ok(plan.summary.totalBuys <= 3000 + 1e-9 && plan.summary.totalSells === 0, "New Money: budget cap, no sells");
  const rb = planFor(loaded(), "rebalance", 0).plan;
  assert.ok(rb.summary.totalBuys <= rb.summary.totalSells + 1e-9, "Rebalance: sells fund buys");
  const whole = E.applyWholeShares(plan);
  assert.ok(whole.results.every(r => Number.isInteger(r.wholeShares)) && whole.totalBuys <= 3000 + 1e-9);
});

test("removing a holding updates the portfolio: value, normalized targets and the 100% warning", () => {
  const rows = loaded().filter(r => r.ticker !== "VST");
  const { positions, plan } = planFor(rows);
  assert.equal(plan.results.length, 13);
  assert.ok(Math.abs(plan.results.reduce((s, r) => s + r.targetWeightNorm, 0) - 1) < 1e-12);
  assert.match(E.weightWarnings(positions)[0], /add up to 99\.10%, not 100%/);
});

test("Remove international examples removes only the four unchanged sample rows", () => {
  const rows = loaded();
  assert.deepEqual(rows.filter(isUnchangedInternationalExample).map(r => r.ticker), ["7203.T", "SAP.DE", "VOD.L", "600519.SS"]);
  // A user edit turns an example into an ordinary user holding: it stays.
  rows[10] = R.editField(rows[10], "shares", "2");
  rows[11] = R.setManualPrice(rows[11], { price: 220, currency: "EUR" });
  rows[12] = R.editTicker(rows[12], "TSCO.L");
  // The same security added by the user (no sample tag) is never matched.
  rows.push(R.createRow({ ticker: "600519.SS", shares: 1, targetWeight: 2.5 }));
  assert.deepEqual(rows.filter(isUnchangedInternationalExample).map(r => r.ticker), ["600519.SS"]);
  assert.equal(rows.filter(r => r.ticker === "600519.SS").length, 2);
  const kept = rows.filter(r => !isUnchangedInternationalExample(r));
  assert.equal(kept.length, 14);
  assert.equal(kept.filter(r => r.ticker === "600519.SS").length, 1, "only the loaded example was removed");
  assert.ok(kept.some(r => r.ticker === "7203.T" && r.shares === "2"));
  // Resetting an edited field to the loaded value makes it an unchanged example again.
  assert.equal(isUnchangedInternationalExample(R.editField(rows[10], "shares", "1")), true);
});
