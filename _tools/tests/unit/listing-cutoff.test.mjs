// A reused ticker: prices dated before a security's listing date belong to a different
// security that used the same symbol earlier. They must never reach a calculation, a
// chart, a cached result or an export in the browser (the desktop rule is in
// _tools/shared_py/market_data/history.py; _tools/tests/test_market_data_parity.py checks
// that the two agree). The page's requests are answered by the REAL gateway code running
// in this process, whose upstream is the synthetic Yahoo fixtures: nothing leaves it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { testGateway } from "../fixtures/local-coordinator.mjs";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { createMarketData, selectBasis } from "../../../assets/js/market-data/index.js";
import { cutToListing } from "../../../assets/js/market-data/instruments.js";
import { memoryStorage } from "../../../assets/js/market-data/cache.js";
import * as A from "../../../assets/js/stock-dashboard/analytics.js";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("../../../assets/data/instruments.v1.json", import.meta.url), "utf8"));
const GATEWAY = "https://md.gateway.test";
const ORIGIN = "https://elmatthe.github.io";
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: ORIGIN };
const NOW = Date.parse("2026-11-03T15:00:00Z");
const AV_KEY = "TESTKEY12345";
const LISTED = "2026-06-12"; // SPCX's listedFrom in the reference
const iso = d => d.toISOString().slice(0, 10);
const RANGE_1Y = A.resolveHorizon("1Y", new Date(NOW));
const RANGE_4M = { start: new Date("2026-05-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") };

function avDaily(symbol) {
  const days = {};
  for (let t = Date.parse("2026-05-01T00:00:00Z"); t <= Date.parse("2026-09-01T00:00:00Z"); t += 86400000) {
    if (![0, 6].includes(new Date(t).getUTCDay())) days[new Date(t).toISOString().slice(0, 10)] = { "4. close": "50.00" };
  }
  return { "Meta Data": { "2. Symbol": symbol }, "Time Series (Daily)": days };
}

function world({ mode = {}, local = memoryStorage(), reference = REFERENCE, rewrite = null } = {}) {
  let t = NOW;
  const calls = { history: [], av: [] };
  const upstreamMode = { ...mode };
  const gw = testGateway({ fetchImpl: yahooFetch({ now: () => t, mode: upstreamMode }), now: () => t, limits: { upstreamMinSpacingMs: 0 }, sleep: async () => {} });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === GATEWAY) {
      if (u.pathname === "/v1/history") calls.history.push(String(url));
      const res = await gw.handle(new Request(String(url), { headers: { ...init.headers, Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.1" } }), ON);
      if (rewrite && u.pathname === "/v1/history" && res.status === 200) {
        const body = await res.json();
        return new Response(JSON.stringify(rewrite(body)), { status: 200, headers: { "content-type": "application/json" } });
      }
      return res;
    }
    if (u.hostname === "www.alphavantage.co") {
      calls.av.push(u.searchParams.get("function"));
      const symbol = u.searchParams.get("symbol") || u.searchParams.get("keywords");
      const fn = u.searchParams.get("function");
      const body = fn === "SYMBOL_SEARCH" ? { bestMatches: [{ "1. symbol": symbol, "2. name": `Mock ${symbol}`, "4. region": "United States", "8. currency": "USD", "9. matchScore": "1.0000" }] }
        : fn === "GLOBAL_QUOTE" ? { "Global Quote": { "01. symbol": symbol, "05. price": "50.00", "07. latest trading day": "2026-11-02" } } : avDaily(symbol);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new TypeError(`unexpected host ${u.host}`);
  };
  const md = createMarketData({ local, session: memoryStorage(), fetchImpl, now: () => t, reference, gatewayUrl: GATEWAY, minSpacingMs: 0, sleep: async () => {}, locks: null });
  const raw = async (symbol, range = "2y") => (await (await fetchImpl(`${GATEWAY}/v1/history?symbol=${symbol}&range=${range}&interval=1d`)).json()).observations;
  return { md, calls, local, upstreamMode, raw, advance: ms => { t += ms; } };
}
const seriesOf = (h, ticker) => {
  const chosen = selectBasis(h, "adjusted");
  return { ticker, currency: h.currency, observations: chosen.observations, priceBasis: chosen.priceBasis, frequency: h.frequency || "daily" };
};

test("B1: SPCX prices from before 2026-06-12 cannot enter its statistics; the boundary date and later remain", async () => {
  const w = world();
  await w.md.keyless.check();
  const rawRows = await w.raw("SPCX");
  const start = iso(RANGE_1Y.start);
  const preListingInWindow = rawRows.filter(o => o[0] >= start && o[0] < LISTED);
  assert.ok(preListingInWindow.length >= 154, `the synthetic source really offers earlier prices in the 1Y window (${preListingInWindow.length})`);
  const { history, provenance } = await w.md.historyBySources("SPCX", RANGE_1Y, {});
  const dates = history.observations.map(o => iso(o.date));
  assert.ok(dates.length > 90, String(dates.length));
  assert.ok(dates.every(d => d >= LISTED), `first date ${dates[0]}`);
  assert.equal(dates[0], LISTED, "the listing date itself is kept (a Friday)");
  assert.deepEqual(dates, rawRows.map(o => o[0]).filter(d => d >= LISTED), "nothing else is removed");
  assert.equal(provenance.sourceId, "yahoo");
  assert.deepEqual(history.listing.listedFrom, LISTED);
  assert.ok(history.listing.removed >= 154);
  assert.match(history.listing.note, /^SPCX: listed only since 2026-06-12; earlier history under this symbol belongs to a different security and is not used\.$/);

  // Everything calculated from it: metrics, returns, correlation, regression.
  const other = (await w.md.historyBySources("AAPL", RANGE_1Y, {})).history;
  const prepared = {};
  for (const [ticker, h] of [["SPCX", history], ["AAPL", other]]) prepared[ticker] = A.prepareHistory(seriesOf(h, ticker), "1Y", RANGE_1Y, new Date(NOW));
  assert.ok(prepared.SPCX.observations.every(o => iso(o.date) >= LISTED));
  assert.ok(prepared.SPCX.warnings.some(x => /partially available \(first price 2026-06-12\)/.test(x)), "the shorter history is said plainly");
  const result = A.runComparison(prepared, { riskFreeAnnual: 0.03 });
  const metrics = Object.fromEntries(result.metrics.map(m => [m.ticker, m]));
  assert.equal(metrics.SPCX.actualStart, LISTED);
  assert.ok(metrics.AAPL.actualStart < LISTED, "another ticker keeps its full window");
  const postListing = prepared.SPCX.observations.length;
  assert.equal(metrics.SPCX.returnObservations, postListing - 1);
  assert.ok(result.counts.SPCX.AAPL <= postListing - 1, "correlation only over the new security's dates");
  assert.ok(result.returns.SPCX.every(r => r.previousDate >= LISTED && r.currentDate > LISTED), "no return reaches back before the listing");
  assert.ok(A.regression(result.returns.SPCX, result.returns.AAPL, 0.03, result.periodsPerYear).n <= postListing - 1);
});

test("B1: the day before the listing date is removed; the listing date and the day after stay (exact boundaries)", async () => {
  const rewrite = body => ({ ...body, observations: [["2026-06-10", 400, 390], ["2026-06-11", 400, 390], ["2026-06-12", 51, 50], ["2026-06-15", 52, 51]], count: 4 });
  const w = world({ rewrite });
  await w.md.keyless.check();
  const { history } = await w.md.historyBySources("SPCX", RANGE_1Y, {});
  assert.deepEqual(history.observations.map(o => [iso(o.date), o.close]), [["2026-06-12", 51], ["2026-06-15", 52]]);
  assert.equal(history.listing.removed, 2);
});

test("B1: copies saved in this browser are cut too: the boundary is applied every time a series is read", async () => {
  const w = world();
  await w.md.keyless.check();
  const first = await w.md.historyBySources("SPCX", RANGE_1Y, {});
  assert.equal(w.calls.history.length, 1);
  const stored = [...Array(w.local.length).keys()].map(i => w.local.key(i)).find(k => k.startsWith("md.keyless.v1.history:SPCX"));
  assert.ok(JSON.parse(w.local.getItem(stored)).value.observations.some(o => o[0] < LISTED), "the saved copy holds the source's whole answer");
  const second = await w.md.historyBySources("SPCX", RANGE_1Y, {});
  assert.equal(w.calls.history.length, 1, "read from this browser");
  assert.equal(second.provenance.cached, true);
  assert.ok(second.history.observations.every(o => iso(o.date) >= LISTED));
  assert.equal(second.history.observations.length, first.history.observations.length);
});

test("B1: a damaged saved copy is not used; a fresh request is made and cut", async () => {
  for (const damage of [
    () => "{not json",
    good => JSON.stringify({ ...good, value: { ...good.value, observations: "junk" } }),
    good => JSON.stringify({ ...good, value: { ...good.value, observations: [["not-a-date", 1, 1]] } }),
    good => JSON.stringify({ ...good, value: { ...good.value, observations: [[LISTED, -5, -5]] } }),
    good => JSON.stringify({ ...good, value: null }),
  ]) {
    const w = world();
    await w.md.keyless.check();
    await w.md.historyBySources("SPCX", RANGE_1Y, {});
    const key = [...Array(w.local.length).keys()].map(i => w.local.key(i)).find(k => k.startsWith("md.keyless.v1.history:SPCX"));
    w.local.setItem(key, damage(JSON.parse(w.local.getItem(key))));
    const again = await w.md.historyBySources("SPCX", RANGE_1Y, {});
    assert.equal(w.calls.history.length, 2, "the damaged copy was replaced by a new request");
    assert.ok(again.history.observations.length > 90);
    assert.ok(again.history.observations.every(o => iso(o.date) >= LISTED));
  }
});

test("B1: only listings with a listing date are cut; each uses its own date", async () => {
  const w = world();
  await w.md.keyless.check();
  const aapl = (await w.md.historyBySources("AAPL", RANGE_1Y, {})).history;
  assert.equal(aapl.observations.length, (await w.raw("AAPL")).length, "no date on file: nothing is removed");
  assert.equal(aapl.listing, undefined);
  const cbrs = (await w.md.historyBySources("CBRS", RANGE_1Y, {})).history;
  assert.equal(iso(cbrs.observations[0].date), "2026-05-14");
});

test("B1: when a source has only earlier prices nothing is used, the source is reported, and the next source is asked", async () => {
  const stale = world({ mode: { staleDays: 200 } });
  await stale.md.keyless.check();
  await assert.rejects(stale.md.historyBySources("SPCX", RANGE_1Y, {}), e => {
    assert.equal(e.attempts.length, 1);
    assert.equal(e.attempts[0].providerId, "yahoo");
    assert.match(e.attempts[0].message, /listed only since 2026-06-12/);
    assert.match(e.attempts[0].message, /different security/);
    return true;
  });
  // With a second source in the list, it answers, and its own earlier prices are cut as well.
  const both = world({ mode: { staleDays: 200 } });
  await both.md.keyless.check();
  both.md.setApiKey(AV_KEY, { remember: true });
  const { history, provenance } = await both.md.historyBySources("SPCX", RANGE_4M, {});
  assert.equal(provenance.sourceId, "alphavantage");
  assert.equal(provenance.attempts[0].providerId, "yahoo");
  assert.ok(history.observations.length > 40);
  assert.ok(history.observations.every(o => iso(o.date) >= LISTED));
});

test("B1: Alpha Vantage's series is cut on every read: fresh, saved, and in a snapshot", async () => {
  const w = world();
  await w.md.keyless.check();
  w.md.setApiKey(AV_KEY, { remember: true });
  w.md.sources.setEnabled("yahoo", false);
  const first = await w.md.historyBySources("SPCX", RANGE_4M, {});
  assert.equal(first.provenance.sourceId, "alphavantage");
  assert.ok(first.history.observations.every(o => iso(o.date) >= LISTED));
  assert.equal(iso(first.history.observations[0].date), LISTED);
  const requests = w.calls.av.length;
  const second = await w.md.historyBySources("SPCX", RANGE_4M, {});
  assert.equal(w.calls.av.length, requests, "served from this browser");
  assert.ok(second.provenance.cached);
  assert.ok(second.history.observations.every(o => iso(o.date) >= LISTED));
  const snap = await w.md.snapshotBySources("SPCX", RANGE_4M, {});
  assert.ok(snap.history.observations.every(o => iso(o.date) >= LISTED));
});

test("B1: a snapshot from Yahoo Finance shows only the new security's prices", async () => {
  const w = world();
  await w.md.keyless.check();
  const snap = await w.md.snapshotBySources("SPCX", RANGE_1Y, {});
  assert.equal(snap.sourceId, "yahoo");
  assert.ok(snap.history.observations.every(o => iso(o.date) >= LISTED));
  assert.match(snap.history.listing.note, /listed only since 2026-06-12/);
});

test("B1: an unreadable listing date in the reference fails closed", async () => {
  const reference = JSON.parse(JSON.stringify(REFERENCE));
  reference.instruments.find(i => i.id === "XNAS:SPCX").listedFrom = "soon";
  const w = world({ reference });
  await w.md.keyless.check();
  await assert.rejects(w.md.historyBySources("SPCX", RANGE_1Y, {}), e => /listing date/.test(e.attempts?.[0]?.message || ""));
});

test("B1: cutToListing is pure, keeps an empty answer empty, and every listing date on file is a real date", () => {
  const observations = [{ date: new Date("2026-06-11T00:00:00Z"), close: 1, adjClose: 1 }, { date: new Date("2026-06-12T00:00:00Z"), close: 2, adjClose: 2 }];
  const history = { symbol: "SPCX", observations };
  const identity = { displayTicker: "SPCX", canonicalId: "XNAS:SPCX", listedFrom: LISTED };
  const out = cutToListing(history, identity);
  assert.equal(history.observations.length, 2, "the input (possibly shared with another caller) is not changed");
  assert.equal(out.observations.length, 1);
  assert.equal(cutToListing({ symbol: "X", observations: [] }, identity).observations.length, 0);
  assert.equal(cutToListing(history, { displayTicker: "AAPL", listedFrom: null }), history);
  assert.equal(cutToListing(history, null), history);
  // Asked only for dates after the listing: nothing was removed, so there is nothing to say.
  const after = cutToListing({ symbol: "SPCX", observations: [observations[1]] }, identity, { rangeStart: new Date("2026-07-01T00:00:00Z") });
  assert.equal(after.listing.note, null);
  const listed = REFERENCE.instruments.filter(i => i.listedFrom);
  assert.ok(listed.length >= 2);
  for (const i of listed) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(i.listedFrom) && new Date(`${i.listedFrom}T00:00:00Z`).toISOString().startsWith(i.listedFrom), i.id);
});
