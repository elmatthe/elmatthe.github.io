// Price freshness on every day of the week, with fixed dates: the synthetic Yahoo answer
// (../fixtures/yahoo-chart.mjs), the gateway's real quote normalizer, the Rebalancer's real
// freshness rule and its real valuation gate. The browser test of stale prices
// (../browser/sources.test.js, case 5) used "two calendar days old", which on a Monday is
// Friday's close: current, so it failed every Monday. Its fixture now counts sessions; these
// tests pin why, without a browser or the real date.
import test from "node:test";
import assert from "node:assert/strict";
import { yahooChartResponse } from "../fixtures/yahoo-chart.mjs";
import { chartUrl, normalizeQuote } from "../../../_services/market-data-gateway/src/yahoo-chart.js";
import { parseSymbol } from "../../../_services/market-data-gateway/src/venues.js";
import { freshnessOf, STALE_SESSIONS, TOO_OLD_SESSIONS } from "../../../assets/js/portfolio-rebalancer/rows.js";
import { assessValuation } from "../../../assets/js/portfolio-rebalancer/engine.js";

const SYMBOLS = ["AAPL", "VEQT.TO", "SAP.DE", "7203.T"]; // New York, Toronto, Frankfurt, Tokyo
const DAY = 86400000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// What the app would see for one symbol at `now` with this fixture mode.
function seen(symbol, now, mode) {
  const parsed = parseSymbol(symbol);
  const reply = yahooChartResponse(chartUrl(symbol, { kind: "quote" }), { now, mode });
  assert.equal(reply.status, 200, symbol);
  const quote = normalizeQuote(reply.body, { ...parsed, now });
  return { symbol, quote, ...freshnessOf(quote.tradingDate, now, parsed.venue.timeZone) };
}
function valuation(rows) {
  return assessValuation(rows.map(r => ({
    rowId: r.symbol, ticker: r.symbol, shares: 1, targetWeight: 25, price: r.quote.price, currency: r.quote.currency, fxAvailable: true,
    source: { kind: "provider", currencyVerified: true, freshness: r.freshness, tradingDate: r.quote.tradingDate },
  })));
}
// Two whole weeks, Monday 2026-11-16 to Sunday 2026-11-29, at three times of day (UTC).
const moments = [];
for (let d = 0; d < 14; d += 1) for (const hour of [3, 17, 23]) moments.push(Date.parse("2026-11-16T00:00:00Z") + d * DAY + hour * 3600000);
const label = now => `${WEEKDAY[new Date(now).getUTCDay()]} ${new Date(now).toISOString()}`;

test("the R5 failure, reproduced: two calendar days before a Monday is Friday's close, which is current; on a Tuesday it is stale", () => {
  const monday = Date.parse("2026-11-23T17:00:00Z");
  const tuesday = Date.parse("2026-11-24T17:00:00Z");
  for (const symbol of ["AAPL", "VEQT.TO"]) {
    const mon = seen(symbol, monday, { staleDays: 2 });
    assert.equal(mon.quote.tradingDate, "2026-11-20");
    assert.equal(mon.freshness, "current", "so 'staleDays: 2' cannot test staleness on a Monday");
    const tue = seen(symbol, tuesday, { staleDays: 2 });
    assert.equal(tue.quote.tradingDate, "2026-11-20");
    assert.equal(tue.freshness, "stale");
  }
});

test("a price two sessions old is stale on every day of the week, in every time zone, and the plan waits for it", () => {
  for (const now of moments) {
    const rows = SYMBOLS.map(symbol => seen(symbol, now, { staleSessions: 2 }));
    for (const r of rows) {
      assert.equal(r.freshness, "stale", `${r.symbol} on ${label(now)} (${r.quote.tradingDate})`);
      assert.equal(r.missed, 2, `${r.symbol} on ${label(now)}`);
    }
    const plan = valuation(rows);
    assert.equal(plan.ready, false, label(now));
    assert.equal(plan.stale.length, SYMBOLS.length);
  }
});

test("the latest session is current on every day of the week, weekends included: no false alarm", () => {
  for (const now of moments) {
    const rows = SYMBOLS.map(symbol => seen(symbol, now, {}));
    for (const r of rows) assert.equal(r.freshness, "current", `${r.symbol} on ${label(now)} (${r.quote.tradingDate})`);
    const plan = valuation(rows);
    assert.equal(plan.ready, true, label(now));
    assert.deepEqual(plan.stale, []);
  }
});

test("on a Monday, Friday's close is current; on Saturday and Sunday too", () => {
  for (const day of ["2026-11-21", "2026-11-22", "2026-11-23"]) {
    const r = seen("AAPL", Date.parse(`${day}T17:00:00Z`), {});
    assert.equal(r.quote.tradingDate, "2026-11-20", day);
    assert.equal(r.freshness, "current", day);
  }
});

// The policy is pinned with literals, independently of the exported constants (R7/L6): a
// threshold moved from four sessions to five (or three) must fail here.
test("the policy itself: one missed session is stale and four are too old", () => {
  assert.equal(STALE_SESSIONS, 1);
  assert.equal(TOO_OLD_SESSIONS, 4);
});

test("sessions, not days, set the threshold: one missed session is stale, four are too old, never current", () => {
  for (const now of moments) {
    for (const [sessions, expected] of [[1, "stale"], [2, "stale"], [3, "stale"], [4, "too_old"], [5, "too_old"]]) {
      const r = seen("AAPL", now, { staleSessions: sessions });
      assert.equal(r.missed, sessions, label(now));
      assert.equal(r.freshness, expected, `${sessions} sessions on ${label(now)}`);
    }
  }
});

// Market closures: the browser does not know exchange holidays (rows.js), so the last real
// close before a holiday counts one missed session. That is cautious, never optimistic: the
// price is shown as older than the latest session and the plan waits until it is accepted.
for (const [name, now, close] of [
  ["Tuesday after US Labor Day (Monday 2026-09-07)", "2026-09-08T17:00:00Z", "2026-09-04"],
  ["Monday after Good Friday (2026-04-03)", "2026-04-06T17:00:00Z", "2026-04-02"],
  ["Friday after US Thanksgiving (Thursday 2026-11-26)", "2026-11-27T17:00:00Z", "2026-11-25"],
]) {
  test(`market closure, ${name}: the last real close is flagged for acceptance, never presented as current`, () => {
    const at = Date.parse(now);
    const r = seen("AAPL", at, { staleSessions: 1 }); // the source's latest session is the close before the holiday
    assert.equal(r.quote.tradingDate, close);
    assert.equal(r.freshness, "stale");
    assert.equal(r.missed, 1);
    assert.equal(valuation([r]).ready, false);
  });
}
