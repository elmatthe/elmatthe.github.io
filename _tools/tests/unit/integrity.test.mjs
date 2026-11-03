// G1/G2 integrity tests: Alpha Vantage notice classification (verbatim fixtures shared
// with the desktop tests), the persisted daily-limit record, the request scheduler,
// instrument identity, the Rebalancer row state machine and the valuation gate.
// Run: node --test _tools/tests/unit/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAvNotice, parseAvBody, createAlphaVantageClient, createUsageCounter } from "../../../assets/js/market-data/providers/alphavantage.js";
import { createScheduler } from "../../../assets/js/market-data/scheduler.js";
import { createInstrumentResolver } from "../../../assets/js/market-data/instruments.js";
import * as R from "../../../assets/js/portfolio-rebalancer/rows.js";
import * as E from "../../../assets/js/portfolio-rebalancer/engine.js";
import { SAMPLE_PORTFOLIO } from "../../../assets/js/portfolio-rebalancer/sample.js";
import * as F from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const NOTICES = JSON.parse(fs.readFileSync(path.join(root, "_tools/tests/fixtures/providers/alphavantage-notices.json"), "utf8"));
const REFERENCE = JSON.parse(fs.readFileSync(path.join(root, "assets/data/instruments.v1.json"), "utf8"));
const noSleep = async () => {};

/* ---------------- Alpha Vantage notices ---------------- */
test("every verbatim Alpha Vantage notice is classified as the fixture says", () => {
  for (const n of NOTICES.notices) {
    const body = JSON.stringify({ [n.field]: n.text });
    assert.throws(() => parseAvBody(body, { symbol: "AAPL" }), e => {
      assert.equal(e.kind, n.expect.kind, n.name);
      assert.equal(e.quotaScope ?? null, n.expect.quotaScope, n.name);
      if (n.expect.redacts) {
        assert.ok(!e.message.includes(n.expect.redacts), `${n.name}: message leaks the key`);
        assert.ok(!String(e.notice).includes(n.expect.redacts), `${n.name}: notice leaks the key`);
      }
      if (n.field !== "Error Message" || n.expect.kind !== "not_found") assert.ok(e.notice && e.notice.length <= 400, `${n.name}: provider wording kept`);
      return true;
    }, n.name);
  }
});

test("a notice that mentions both a per-second limit and '25 requests per day' is always a burst", () => {
  const burstPhrases = ["spreading out your free API requests", "1 request per second", "raise the per-second burst limit", "Our standard API call frequency is 5 calls per minute"];
  const dailyPhrases = ["(25 requests per day)", "our standard API rate limit is 25 requests per day", "to instantly remove all daily rate limits", "daily request limit"];
  for (const b of burstPhrases) for (const d of dailyPhrases) for (const order of [0, 1]) {
    const text = order ? `${d}. ${b}.` : `${b}. ${d}.`;
    assert.deepEqual(classifyAvNotice(text), { kind: "rate_limited", quotaScope: "burst" }, text);
  }
  assert.equal(classifyAvNotice("Something new from the provider").kind, "provider_notice");
});

function avQuoteServer(sequence) {
  let i = 0;
  const fn = F.stubFetch(() => {
    const next = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return F.response(200, typeof next === "string" ? next : JSON.stringify(next));
  });
  return fn;
}
const BURST_2026 = { Information: NOTICES.notices.find(n => n.name === "burst-2026").text };
const DAILY = { Information: NOTICES.notices.find(n => n.name === "daily").text };
const QUOTE = F.avGlobalQuote("AAPL", 230, "2026-10-30");

test("a burst notice is retried with back-off and never recorded as the daily limit", async () => {
  const storage = F.memory();
  const usage = createUsageCounter(storage, { key: "u" });
  const waits = [];
  const fetchImpl = avQuoteServer([BURST_2026, BURST_2026, QUOTE]);
  const client = createAlphaVantageClient({ apiKey: "TESTKEY123", fetchImpl, usage, sleep: async ms => { waits.push(ms); } });
  const body = await client.globalQuote("AAPL");
  assert.equal(body["Global Quote"]["05. price"], "230");
  assert.deepEqual(waits, [2000, 5000]);
  assert.equal(usage.dailyLimit, null);
  assert.equal(usage.count, 3, "three requests were sent and counted");
  // A burst that never clears gives up after three retries with a retryable error, still not stored.
  const stuck = createAlphaVantageClient({ apiKey: "TESTKEY123", fetchImpl: avQuoteServer([BURST_2026]), usage, sleep: noSleep });
  await assert.rejects(stuck.globalQuote("AAPL"), e => e.kind === "rate_limited" && e.quotaScope === "burst" && e.retryable === true);
  assert.equal(usage.dailyLimit, null);
});

test("only the daily wording records the limit; it blocks requests locally until 00:00 UTC; Check again clears it", async () => {
  let t = Date.parse("2026-11-03T14:02:00Z");
  const storage = F.memory();
  const usage = createUsageCounter(storage, { key: "u", now: () => t });
  const fetchImpl = avQuoteServer([DAILY, QUOTE]);
  const client = createAlphaVantageClient({ apiKey: "TESTKEY123", fetchImpl, usage, now: () => t, sleep: noSleep });
  await assert.rejects(client.globalQuote("AAPL"), e => e.quotaScope === "daily" && e.definitive && /standard API rate limit/.test(e.notice));
  assert.ok(usage.dailyLimit);
  assert.equal(fetchImpl.calls.length, 1);
  // A reload (new client, same storage) honours it without a request.
  const again = createAlphaVantageClient({ apiKey: "TESTKEY123", fetchImpl, usage: createUsageCounter(storage, { key: "u", now: () => t }), now: () => t, sleep: noSleep });
  await assert.rejects(again.globalQuote("MSFT"), e => e.quotaScope === "daily" && /14:02 UTC/.test(e.message) && e.retryable === false);
  assert.equal(fetchImpl.calls.length, 1, "no request while the recorded limit applies");
  // "Check again" sends one request and, on success, clears the record.
  await again.probe();
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(usage.dailyLimit, null);
  // The record expires at 00:00 UTC.
  usage.markDailyLimit("x");
  t = Date.parse("2026-11-04T00:00:01Z");
  assert.equal(usage.dailyLimit, null);
});

test("a stored 'exhausted' flag from the earlier version (possibly a misread burst) is ignored", () => {
  const storage = F.memory();
  const now = () => Date.parse("2026-11-03T15:00:00Z");
  storage.setItem("u", JSON.stringify({ day: "2026-11-03", count: 2, exhausted: true }));
  const usage = createUsageCounter(storage, { key: "u", now });
  assert.equal(usage.dailyLimit, null);
  assert.equal(usage.exhausted, false);
  assert.equal(usage.count, 2);
});

test("usage counts requests per UTC day and month; corrupted records count as zero", () => {
  let t = Date.parse("2026-10-31T23:59:00Z");
  const storage = F.memory();
  const u = createUsageCounter(storage, { key: "u", now: () => t });
  u.increment(); u.increment();
  assert.equal(u.count, 2);
  assert.equal(u.monthCount, 2);
  t = Date.parse("2026-11-01T00:01:00Z");
  assert.equal(u.count, 0);
  assert.equal(u.monthCount, 0);
  storage.setItem("u", "{not json");
  assert.equal(u.count, 0);
});

/* ---------------- scheduler ---------------- */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
}

test("scheduler: start spacing, gap after a slow response, per-minute cap", async () => {
  const clock = fakeClock();
  const s = createScheduler({ name: "t", minSpacingMs: 1200, minGapAfterMs: 1100, now: clock.now, sleep: clock.sleep });
  const starts = [];
  const slow = async () => { starts.push(clock.now()); clock.advance(3000); };
  await Promise.all([s.run(slow), s.run(slow), s.run(slow)]);
  assert.equal(starts[1] - starts[0], 3000 + 1100, "a slow response is followed by the gap, not an immediate request");
  assert.equal(starts[2] - starts[1], 4100);
  const clock2 = fakeClock();
  const m = createScheduler({ name: "m", perMinute: 5, now: clock2.now, sleep: clock2.sleep });
  const t2 = [];
  for (let i = 0; i < 7; i += 1) await m.run(async () => { t2.push(clock2.now()); });
  assert.equal(t2[4] - t2[0], 0);
  assert.ok(t2[5] - t2[0] >= 60000, "the sixth request waits for the rolling minute");
});

test("scheduler: two pages sharing storage keep the spacing between them", async () => {
  const clock = fakeClock();
  const storage = F.memory();
  const a = createScheduler({ name: "av.k1", minSpacingMs: 1200, storage, now: clock.now, sleep: clock.sleep, locks: null });
  const b = createScheduler({ name: "av.k1", minSpacingMs: 1200, storage, now: clock.now, sleep: clock.sleep, locks: null });
  const starts = [];
  await a.run(async () => { starts.push(clock.now()); });
  await b.run(async () => { starts.push(clock.now()); });
  assert.equal(starts[1] - starts[0], 1200);
  assert.equal(b.estimateWaitMs(), 1200);
});

test("scheduler: a cancelled wait never sends the request", async () => {
  const s = createScheduler({ name: "c", minSpacingMs: 50, locks: null });
  await s.run(async () => {});
  const controller = new AbortController();
  let sent = false;
  const p = s.run(async () => { sent = true; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, e => e.kind === "aborted");
  assert.equal(sent, false);
});

/* ---------------- identity ---------------- */
const resolver = createInstrumentResolver(REFERENCE);

test("YNVD.TO keeps the Questrade text and resolves to the Cboe Canada ETF, never a TSX listing", () => {
  const r = resolver.resolve("ynvd.to");
  assert.equal(r.displayTicker, "YNVD.TO");
  assert.equal(r.canonicalId, "NEOE:YNVD");
  assert.equal(r.mic, "NEOE");
  assert.equal(r.currency, "CAD");
  assert.equal(r.currencyEvidence, "curated_reference");
  assert.match(r.name, /NVIDIA \(NVDA\) Yield Shares Purpose ETF/);
  assert.match(r.notes[0], /Questrade/);
  assert.equal(resolver.resolve("YNVD.NE").canonicalId, "NEOE:YNVD");
});

test("every sample row resolves to its verified listing and currency, with no price anywhere", () => {
  const expected = {
    "VEQT.TO": ["XTSE:VEQT", "CAD"], "CNQ.TO": ["XTSE:CNQ", "CAD"], "XQQ.TO": ["XTSE:XQQ", "CAD"], "HEWB.TO": ["XTSE:HEWB", "CAD"],
    AAPL: ["XNAS:AAPL", "USD"], "VFV.TO": ["XTSE:VFV", "CAD"], SPCX: ["XNAS:SPCX", "USD"], CBRS: ["XNAS:CBRS", "USD"],
    "YNVD.TO": ["NEOE:YNVD", "CAD"], VST: ["XNYS:VST", "USD"], "7203.T": ["XTKS:7203", "JPY"], "SAP.DE": ["XETR:SAP", "EUR"],
    "VOD.L": ["XLON:VOD", "GBP"], "600519.SS": ["XSHG:600519", "CNY"],
  };
  for (const row of SAMPLE_PORTFOLIO.rows) {
    const r = resolver.resolve(row.ticker);
    assert.deepEqual([r.canonicalId, r.currency], expected[row.ticker], row.ticker);
    assert.equal(r.status, "resolved");
  }
  assert.equal(resolver.resolve("VOD.L").unitScale, 0.01, "London quotes are in pence");
  assert.ok(!JSON.stringify(REFERENCE).match(/"(price|close|last|nav)"\s*:/i), "the reference holds no prices");
});

test("uncurated symbols: suffix gives a venue and an UNCONFIRMED currency; junk is rejected; nothing is guessed", () => {
  const ry = resolver.resolve("RY.TO");
  assert.deepEqual([ry.canonicalId, ry.currency, ry.currencyEvidence], ["XTSE:RY", "CAD", "venue_default_unconfirmed"]);
  const usd = resolver.resolve("DLR-U.TO");
  assert.deepEqual([usd.mic, usd.currency], ["XTSE", "USD"]);
  assert.equal(resolver.resolve("MSFT").mic, "US");
  assert.equal(resolver.resolve("BRK.B").mic, "US");
  assert.equal(resolver.resolve("TSX:RY").canonicalId, "XTSE:RY");
  assert.equal(resolver.resolve("^GSPC").status, "unsupported");
  assert.equal(resolver.resolve("CADUSD=X").status, "unsupported");
  assert.equal(resolver.resolve("AB.XYZ").status, "unresolved");
  assert.equal(resolver.resolve("bad ticker!").status, "invalid");
  assert.equal(resolver.resolve("0700.HK").currency, "HKD");
  assert.equal(resolver.resolve("TSCO.L").quoteUnit, "minor");
});

/* ---------------- row state machine ---------------- */
test("editing a ticker clears the previous instrument's price, source, currency and errors at once", () => {
  let row = R.createRow({ ticker: "VTI", shares: "120", targetWeight: "10" });
  row = R.applyIdentity(row, resolver.resolve("VTI"));
  const token = R.requestToken(row, "Finnhub");
  ({ row } = R.applyQuote(row, token, { canonicalId: "US:VTI", provider: "Finnhub", nativePriceMajorUnits: 250, nativeCurrency: "USD", currencyVerified: true, tradingDate: "2026-11-02" }));
  assert.equal(R.effectivePrice(row).price, 250);
  row = R.setManualPrice(row, { price: 251, currency: "USD" });
  const edited = R.editTicker(row, "VEQT.TO");
  assert.equal(edited.quote, null);
  assert.equal(edited.manual, null);
  assert.equal(edited.identity, null);
  assert.equal(R.effectivePrice(edited), null);
  assert.deepEqual([edited.shares, edited.targetWeight], ["120", "10"], "shares and target are kept");
  assert.equal(edited.revision, row.revision + 1);
});

test("a late answer for the previous ticker is never applied to the new one", () => {
  let row = R.applyIdentity(R.createRow({ ticker: "VTI", shares: "1", targetWeight: "1" }), resolver.resolve("VTI"));
  const oldToken = R.requestToken(row, "Finnhub");
  row = R.markPricing(row, oldToken);
  row = R.editTicker(row, "VEQT.TO");
  row = R.applyIdentity(row, resolver.resolve("VEQT.TO"));
  const late = R.applyQuote(row, oldToken, { canonicalId: "US:VTI", provider: "Finnhub", nativePriceMajorUnits: 250, nativeCurrency: "USD", currencyVerified: true, tradingDate: "2026-11-02" });
  assert.equal(late.applied, false);
  assert.equal(late.row.quote, null);
  const lateError = R.applyError(row, oldToken, { kind: "rate_limited", message: "x" });
  assert.equal(lateError.applied, false);
  // The same ticker re-typed after an edit is still a new revision.
  const round = R.applyIdentity(R.editTicker(R.editTicker(row, "VTI"), "VEQT.TO"), resolver.resolve("VEQT.TO"));
  assert.equal(R.applyQuote(round, R.requestToken(row, "Alpha Vantage"), { canonicalId: "XTSE:VEQT", provider: "Alpha Vantage", nativePriceMajorUnits: 60, nativeCurrency: "CAD", currencyVerified: true }).applied, false);
  // An answer from a different provider than the one asked is rejected too.
  const t = R.requestToken(round, "Alpha Vantage");
  assert.equal(R.applyQuote(round, t, { canonicalId: "XTSE:VEQT", provider: "Marketstack", nativePriceMajorUnits: 60, nativeCurrency: "CAD", currencyVerified: true }).applied, false);
  assert.equal(R.applyQuote(round, t, { canonicalId: "XTSE:VEQT", provider: "Alpha Vantage", nativePriceMajorUnits: 60, nativeCurrency: "CAD", currencyVerified: true }).applied, true);
});

test("freshness counts missed weekday sessions in the listing's time zone", () => {
  const now = Date.parse("2026-11-03T15:00:00Z"); // Tuesday
  assert.equal(R.freshnessOf("2026-11-02", now, "America/Toronto").freshness, "current");
  assert.equal(R.freshnessOf("2026-11-03", now, "America/Toronto").freshness, "current");
  assert.equal(R.freshnessOf("2026-10-30", now, "America/Toronto").freshness, "stale", "Monday missed");
  assert.equal(R.freshnessOf("2026-10-26", now, "America/Toronto").freshness, "too_old");
  assert.equal(R.freshnessOf(null, now).freshness, "unknown");
  const mondayMorning = Date.parse("2026-11-02T14:00:00Z");
  assert.equal(R.freshnessOf("2026-10-30", mondayMorning, "America/New_York").freshness, "current", "Friday close on Monday");
});

/* ---------------- valuation gate ---------------- */
const vrow = (ticker, shares, target, price, extra = {}) => ({ rowId: ticker, ticker, shares, targetWeight: target, price, currency: price ? "CAD" : null, fxAvailable: true, source: price ? { kind: "provider", currencyVerified: true, freshness: "current" } : {}, ...extra });

test("0 of 10 priced: no plan; 0-share 0% rows never block; manual prices are allowed but listed", () => {
  const ten = SAMPLE_PORTFOLIO.rows.map(r => vrow(r.ticker, r.shares, r.targetWeight, null));
  let v = E.assessValuation(ten);
  assert.equal(v.ready, false);
  assert.equal(v.required, 10);
  assert.equal(v.unpriced.length, 10);
  assert.equal(v.notValued.length, 4);
  assert.match(v.blockedReason, /10 of 10 holdings have no usable price/);
  const priced = SAMPLE_PORTFOLIO.rows.map(r => (r.group === "main" ? vrow(r.ticker, r.shares, r.targetWeight, 10) : vrow(r.ticker, 0, 0, null)));
  assert.equal(E.assessValuation(priced).ready, true, "the four test rows with no price do not block");
  priced[8] = vrow("YNVD.TO", 4, 2, 44, { source: { kind: "manual", freshness: "current" } });
  v = E.assessValuation(priced);
  assert.equal(v.ready, true);
  assert.deepEqual(v.manualOverrides.map(m => m.ticker), ["YNVD.TO"]);
});

test("unverified currency, too-old prices, missing FX and unaccepted stale prices block the plan", () => {
  assert.equal(E.assessValuation([vrow("A", 1, 1, 10, { source: { kind: "provider", currencyVerified: false, freshness: "current" } })]).ready, false);
  assert.equal(E.assessValuation([vrow("A", 1, 1, 10, { source: { kind: "provider", currencyVerified: true, freshness: "too_old" } })]).ready, false);
  assert.equal(E.assessValuation([vrow("A", 1, 1, 10, { fxAvailable: false })]).fxMissing.length, 1);
  const stale = [vrow("A", 1, 1, 10, { source: { kind: "provider", currencyVerified: true, freshness: "stale", tradingDate: "2026-10-29" } })];
  assert.equal(E.assessValuation(stale).ready, false);
  assert.equal(E.assessValuation(stale, { acceptStale: true }).ready, true);
  assert.equal(E.assessValuation([vrow("A", "", 1, 10)]).ready, false, "blank shares are not 0");
});

test("number parsing rejects blank, whitespace, nan, inf, 1e999, comma decimals and text", () => {
  for (const bad of ["", " ", "nan", "NaN", "inf", "Infinity", "-inf", "1e999", "1,5", "abc", "0x10", null, undefined, NaN, Infinity]) assert.equal(E.parseNumber(bad), null, String(bad));
  for (const [good, n] of [["0", 0], ["5", 5], [" 2.5 ", 2.5], [".5", 0.5], ["1e3", 1000], ["-0", -0], [7, 7]]) assert.equal(E.parseNumber(good), n, String(good));
  assert.throws(() => E.validatePositions([{ ticker: "A", shares: "1", price: "1", currencyKey: "USD", targetWeight: "" }], { requirePrice: true }), /target weight/);
});

test("rebalance with no sell proceeds holds the buys instead of 'Buy $0.00' (RB-01)", () => {
  const rows = [["A", 100.02], ["B", 100.02], ["C", 99.96]].map(([t, p], i) => ({ rowIndex: i, ticker: t, shares: 100, price: p, currencyKey: "USD", targetWeight: 1, accountType: "" }));
  const plan = E.calculateRebalancePlan(E.attachFxValues(rows, { USD: 1 }, "USD"), "rebalance", 0);
  assert.deepEqual(plan.results.map(r => r.action), ["Hold", "Hold", "Hold"]);
  assert.ok(plan.results.every(r => r.tradeValue === 0));
  assert.match(plan.warnings[0], /cannot be funded in Rebalance mode/);
});

test("whole shares: never more than the budget, top-up buys the most underweight, leftover reported", () => {
  const rows = [
    { rowIndex: 0, ticker: "A", shares: 10, price: 33, currencyKey: "USD", targetWeight: 50, accountType: "" },
    { rowIndex: 1, ticker: "B", shares: 0, price: 70, currencyKey: "USD", targetWeight: 50, accountType: "" },
  ];
  const plan = E.calculateRebalancePlan(E.attachFxValues(rows, { USD: 1 }, "USD"), "new_money", 500);
  const whole = E.applyWholeShares(plan);
  assert.ok(whole.totalBuys <= 500 + 1e-9);
  whole.results.forEach(r => assert.equal(r.wholeShares, Math.round(r.wholeShares)));
  assert.ok(Math.abs(whole.cashLeft - (500 - whole.totalBuys)) < 1e-9);
  assert.ok(whole.cashLeft < 33, "no whole share of a Buy row still fits");
});
