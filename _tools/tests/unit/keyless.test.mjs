// Free (keyless) source in the shared market-data layer: availability states, symbol
// mapping, answer re-validation, routing and fallback, caching and privacy. The page's
// requests are answered by the REAL gateway code (_services/market-data-gateway) running
// in this process, whose upstream is the synthetic Yahoo fixtures; nothing leaves the
// process and no real key is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createGateway } from "../../../_services/market-data-gateway/src/gateway.js";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { createMarketData, KEYLESS_ID } from "../../../assets/js/market-data/index.js";
import { createKeylessSource, keylessSymbol, resolveMarketGateway, historyBucket } from "../../../assets/js/market-data/keyless.js";
import { createInstrumentResolver } from "../../../assets/js/market-data/instruments.js";
import { memoryStorage } from "../../../assets/js/market-data/cache.js";
import { SAMPLE_PORTFOLIO } from "../../../assets/js/portfolio-rebalancer/sample.js";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("../../../assets/data/instruments.v1.json", import.meta.url), "utf8"));
const resolver = createInstrumentResolver(REFERENCE);
const GATEWAY = "https://md.gateway.test";
const ORIGIN = "https://elmatthe.github.io";
const ON = { KEYLESS_SOURCE: "yahoo-chart", SOURCE_AUTHORIZATION: "test fixture only", ALLOWED_ORIGINS: ORIGIN };
const NOW = Date.parse("2026-11-03T15:00:00Z");
const AV_KEY = "TESTKEY12345";

// The browser side: fetch() calls to the gateway go to the real gateway handler; Alpha
// Vantage answers with its daily-limit notice (to test fallback); anything else fails.
function world({ env = ON, mode = {}, avLimited = false, gatewayDown = false } = {}) {
  let t = NOW;
  const calls = { gateway: [], av: 0, yahoo: [] };
  const gw = createGateway({ fetchImpl: yahooFetch({ now: () => t, mode: { ...mode, calls: calls.yahoo } }), now: () => t, log: () => {}, cache: null });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === GATEWAY) {
      calls.gateway.push(String(url));
      if (gatewayDown) throw new TypeError("Failed to fetch");
      if (mode.answer) { const custom = mode.answer(u); if (custom) return custom; }
      return gw.handle(new Request(String(url), { headers: { ...init.headers, Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.1" } }), env);
    }
    if (u.hostname === "www.alphavantage.co") {
      calls.av += 1;
      const body = avLimited ? { Information: "We have detected your API key as TESTKEY12345 and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits." }
        : { "Global Quote": { "01. symbol": u.searchParams.get("symbol"), "05. price": "45.10", "07. latest trading day": "2026-11-02" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new TypeError(`unexpected host ${u.host}`);
  };
  const md = createMarketData({ local: memoryStorage(), session: memoryStorage(), fetchImpl, now: () => t, reference: REFERENCE, gatewayUrl: GATEWAY, minSpacingMs: 0, sleep: async () => {}, locks: null });
  return { md, calls, advance: ms => { t += ms; } };
}

test("symbol mapping: the 14 sample holdings and class/unit lines; unsupported venues get no symbol", () => {
  const map = Object.fromEntries(SAMPLE_PORTFOLIO.rows.map(r => [r.ticker, keylessSymbol(resolver.resolve(r.ticker))]));
  assert.deepEqual(map, {
    "VEQT.TO": "VEQT.TO", "CNQ.TO": "CNQ.TO", "XQQ.TO": "XQQ.TO", "HEWB.TO": "HEWB.TO", AAPL: "AAPL", "VFV.TO": "VFV.TO", SPCX: "SPCX", CBRS: "CBRS",
    "YNVD.NE": "YNVD.NE", VST: "VST", "7203.T": "7203.T", "SAP.DE": "SAP.DE", "VOD.L": "VOD.L", "600519.SS": "600519.SS",
  });
  assert.equal(keylessSymbol(resolver.resolve("YNVD.TO")), "YNVD.NE", "Questrade's YNVD.TO is the Cboe Canada listing, never a TSX symbol");
  assert.equal(keylessSymbol(resolver.resolve("BRK.B")), "BRK-B");
  assert.equal(keylessSymbol(resolver.resolve("DLR-U.TO")), "DLR-U.TO");
  for (const t of ["RELIANCE.BO", "ABC.CN", "SAP.F", "^GSPC", "CADUSD=X"]) assert.equal(keylessSymbol(resolver.resolve(t)), null, t);
});

test("gateway URL: the site's setting; an override only on a page served from this computer", () => {
  assert.equal(resolveMarketGateway("", { hostname: "elmatthe.github.io", search: "?mdgateway=https://evil.example" }), "");
  assert.equal(resolveMarketGateway("https://gw.example", { hostname: "elmatthe.github.io", search: "?mdgateway=https://evil.example" }), "https://gw.example");
  assert.equal(resolveMarketGateway("", { hostname: "127.0.0.1", search: "?mdgateway=https://md.gateway.test" }), "https://md.gateway.test");
  assert.equal(historyBucket({ start: new Date(NOW - 10 * 86400000), end: new Date(NOW) }), "1mo");
  assert.equal(historyBucket({ start: new Date(NOW - 365 * 86400000), end: new Date(NOW) }), "2y");
  assert.equal(historyBucket({ start: new Date(NOW - 3 * 365 * 86400000), end: new Date(NOW) }), "5y");
});

test("availability: not configured sends nothing; disabled and unreachable gateways are reported, not assumed", async () => {
  let requests = 0;
  const none = createKeylessSource({ baseUrl: "", fetchImpl: async () => { requests += 1; throw new Error("no"); } });
  assert.equal((await none.check()).state, "not_configured");
  assert.equal(requests, 0, "no request at all without a configured gateway");
  assert.match(none.coverageGap(resolver.resolve("AAPL")), /not set up/);
  await assert.rejects(none.quote(resolver.resolve("AAPL")), e => e.kind === "not_configured");
  assert.equal(createKeylessSource({ baseUrl: "http://gw.example" }).configured(), false, "plain HTTP is refused outside this computer");

  const off = world({ env: { ALLOWED_ORIGINS: ORIGIN } });
  const st = await off.md.keyless.check();
  assert.equal(st.state, "disabled");
  assert.match(st.reason, /switched off/);
  await assert.rejects(off.md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === "not_configured" && /No available source/.test(e.message));
  assert.equal(off.calls.gateway.length, 1, "only the health check was sent");
  assert.equal(off.calls.yahoo.length, 0);

  const down = world({ gatewayDown: true });
  assert.equal((await down.md.keyless.check()).state, "unreachable");
  assert.equal(down.md.hasPriceSource(), false);
});

test("new browser, no keys: the free source prices all fourteen sample holdings with exact listing, currency and unit", async () => {
  const { md, calls } = world();
  assert.equal((await md.keyless.check()).state, "enabled");
  assert.equal(md.routing.mode, "auto");
  assert.equal(md.hasPriceSource(), true);
  const quotes = {};
  for (const r of SAMPLE_PORTFOLIO.rows) {
    const identity = resolver.resolve(r.ticker);
    assert.deepEqual(md.route(identity).candidates.map(c => c.id), [KEYLESS_ID], r.ticker);
    quotes[r.ticker] = await md.priceInstrument(identity);
  }
  for (const [ticker, q] of Object.entries(quotes)) {
    const id = resolver.resolve(ticker);
    assert.equal(q.canonicalId, id.canonicalId, ticker);
    assert.equal(q.nativeCurrency, id.currency, ticker);
    assert.equal(q.provider, "Yahoo Finance");
    assert.equal(q.providerId, KEYLESS_ID);
    assert.equal(q.sourceTier, "free");
    assert.equal(q.priceType, "regular_market_price");
    assert.equal(q.currencyVerified, true);
    assert.equal(q.adjusted, false);
    assert.ok(q.nativePriceMajorUnits > 0);
    assert.ok(q.notes.some(n => /delayed/.test(n)), "the delay note travels with the quote");
  }
  assert.equal(quotes["VOD.L"].quoteUnit, "minor");
  assert.equal(quotes["VOD.L"].rawCurrency, "GBp");
  assert.ok(Math.abs(quotes["VOD.L"].nativePriceMajorUnits - quotes["VOD.L"].rawPrice / 100) < 1e-12, "pence converted to pounds");
  assert.equal(quotes["YNVD.NE"].providerSymbol, "YNVD.NE");
  // Privacy: only the symbol is ever sent.
  const sent = calls.gateway.filter(u => u.includes("/v1/quote"));
  assert.equal(sent.length, 14);
  for (const url of sent) assert.deepEqual([...new URL(url).searchParams.keys()], ["symbol"], url);
  assert.ok(!calls.gateway.some(u => /305|63|TFSA|shares|target|account/i.test(u)));
  assert.equal(calls.av, 0);
});

test("browser cache, gateway cache and expiry are labelled; a cached price is never presented as just retrieved", async () => {
  const { md, calls, advance } = world();
  await md.keyless.check();
  const id = resolver.resolve("SAP.DE");
  const first = await md.priceInstrument(id);
  assert.equal(first.cacheStatus, "live");
  advance(5 * 60000);
  const second = await md.priceInstrument(id);
  assert.equal(second.cacheStatus, "cached");
  assert.equal(second.cachedAgeMs, 5 * 60000);
  assert.equal(second.retrievedAt, first.retrievedAt);
  assert.equal(calls.gateway.filter(u => u.includes("/v1/quote")).length, 1, "the browser copy costs no request");
  advance(6 * 60000);
  const third = await md.priceInstrument(id);
  assert.equal(calls.gateway.filter(u => u.includes("/v1/quote")).length, 2, "after 10 minutes the browser asks again");
  assert.equal(third.cacheStatus, "live", "the gateway's 5-minute copy had expired too");
  // A second browser profile shortly after: the gateway's own copy, with its age.
  const other = world();
  await other.md.keyless.check();
  await other.md.priceInstrument(id);
  assert.equal(md.estimate([id]).perProvider.keyless.requests, 0, "the estimate knows the saved copy is free");
});

test("re-validation in the browser: a gateway answer for another listing, currency or unit is refused", async () => {
  const tamper = change => ({ answer: u => {
    if (!u.pathname.endsWith("/v1/quote")) return null;
    return (async () => {
      const gw = createGateway({ fetchImpl: yahooFetch({ now: () => NOW }), now: () => NOW, log: () => {}, cache: null });
      const r = await gw.handle(new Request(u.href, { headers: { Origin: ORIGIN } }), ON);
      const body = await r.json();
      change(body);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    })();
  } });
  const cases = [
    [b => { b.listing.symbol = "SAP.F"; }, "invalid", /different symbol/],
    [b => { b.listing.mic = "XFRA"; }, "invalid", /different exchange/],
    [b => { b.price = b.price * 100; }, "invalid", /price/],
    [b => { b.unitScale = 0.5; }, "invalid", /unit/],
    [b => { b.price = -1; b.rawPrice = -1; }, "invalid", /price/],
    [b => { b.tradingDate = "2026-02-30"; }, "invalid", /date/],
    [b => { b.currency = "USD"; b.rawCurrency = "USD"; }, "currency_mismatch", /trades in EUR/],
    [b => { b.delay.realTime = true; }, "invalid", /price basis/],
  ];
  for (const [change, kind, pattern] of cases) {
    const { md } = world({ mode: tamper(change) });
    await md.keyless.check();
    await assert.rejects(md.priceInstrument(resolver.resolve("SAP.DE")), e => e.kind === kind && pattern.test(e.message), String(change));
  }
});

test("failures: rate limits, outages, timeouts and unsupported listings explain themselves; no fabricated price", async () => {
  for (const [mode, kind] of [[{ limited: true }, "rate_limited"], [{ down: true }, "unavailable"], [{ blocked: true }, "unavailable"]]) {
    const { md, calls } = world({ mode });
    await md.keyless.check();
    await assert.rejects(md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === kind && e.provider === "Free source", JSON.stringify(mode));
    assert.equal(calls.gateway.filter(u => u.includes("/v1/quote")).length, 1, "a refusal is not retried");
  }
  const unknown = world();
  await unknown.md.keyless.check();
  await assert.rejects(unknown.md.priceInstrument(resolver.resolve("ZZZQ")), e => e.kind === "not_found" && e.definitive);
  const route = unknown.md.route(resolver.resolve("RELIANCE.BO"));
  assert.deepEqual(route.candidates, []);
  assert.match(route.skipped.find(s => s.id === KEYLESS_ID).reason, /does not cover/);

  let attempts = 0;
  const slow = createKeylessSource({ baseUrl: GATEWAY, timeoutMs: 30, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/v1/health")) return new Response(JSON.stringify({ schema: "md-gateway.health.v1", keyless: { enabled: true } }), { status: 200 });
    attempts += 1;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  } });
  await slow.check();
  await assert.rejects(slow.quote(resolver.resolve("AAPL")), e => e.kind === "timeout");
  assert.equal(attempts, 2, "a timeout is retried once, then reported");
});

test("routing: the visitor's own key comes first; fallback to the free source is opt-in, bounded and keeps the key's error visible", async () => {
  const { md, calls } = world({ avLimited: true });
  await md.keyless.check();
  md.setKey("alphavantage", AV_KEY);
  const veqt = resolver.resolve("VEQT.TO");
  assert.deepEqual(md.route(veqt).candidates.map(c => c.id), ["alphavantage", KEYLESS_ID]);
  await assert.rejects(md.priceInstrument(veqt), e => e.kind === "rate_limited" && e.quotaScope === "daily" && e.provider === "Alpha Vantage", "without opting in, the key's daily limit is reported, not hidden");
  assert.equal(calls.gateway.filter(u => u.includes("/v1/quote")).length, 0);
  md.setRouting({ fallback: true });
  const q = await md.priceInstrument(veqt);
  assert.equal(q.providerId, KEYLESS_ID);
  assert.equal(q.fallbackFrom.length, 1);
  assert.equal(q.fallbackFrom[0].provider, "Alpha Vantage");
  assert.equal(q.fallbackFrom[0].kind, "rate_limited");
  assert.equal(q.fallbackFrom[0].quotaScope, "daily");
  assert.ok(md.providerStatus("alphavantage").limitRecord, "the daily limit stays recorded on the key's card");
  // A provider chosen explicitly is used alone; the free source alone in its own mode.
  md.setRouting({ mode: "alphavantage" });
  assert.deepEqual(md.route(veqt).candidates.map(c => c.id), ["alphavantage"]);
  md.setRouting({ mode: KEYLESS_ID });
  assert.deepEqual(md.route(veqt).candidates.map(c => c.id), [KEYLESS_ID]);
  assert.equal(md.routing.mode, KEYLESS_ID);
  // Listings no saved key covers go to the free source in Automatic mode.
  md.setRouting({ mode: "auto" });
  assert.deepEqual(md.route(resolver.resolve("7203.T")).candidates.map(c => c.id), [KEYLESS_ID]);
  assert.deepEqual(md.route(resolver.resolve("YNVD.NE")).candidates.map(c => c.id), [KEYLESS_ID]);
});

test("history: both price bases kept apart, running session dropped, curated currency enforced, nothing filled in", async () => {
  const { md, calls } = world();
  await md.keyless.check();
  const range = { start: new Date(NOW - 365 * 86400000), end: new Date(NOW) };
  const { history, provenance } = await md.keylessHistory("VOD.L", range);
  assert.equal(history.currency, "GBP");
  assert.equal(history.unitScale, 0.01);
  assert.equal(history.frequency, "daily");
  assert.equal(history.adjustment.adjCloseAvailable, true);
  assert.match(history.adjustment.close, /not for dividends/);
  assert.ok(history.observations.every(o => o.date < new Date(NOW)));
  assert.ok(history.observations.some(o => o.adjClose !== null && o.close !== null && o.adjClose !== o.close));
  assert.equal(provenance.provider, "Yahoo Finance");
  assert.equal(provenance.sourceTier, "free");
  assert.equal(provenance.range, "2y");
  const url = new URL(calls.gateway.find(u => u.includes("/v1/history")));
  assert.deepEqual(Object.fromEntries(url.searchParams), { symbol: "VOD.L", range: "2y", interval: "1d" });
  const plain = await md.keylessHistory("NOADJ", { start: new Date(NOW - 20 * 86400000), end: new Date(NOW) });
  assert.equal(plain.history.adjustment.adjCloseAvailable, false);
  assert.ok(plain.history.observations.every(o => o.adjClose === null), "no adjusted close is invented");
  await assert.rejects(md.keylessHistory("^GSPC", range), e => e.kind === "not_covered");
  await assert.rejects(md.keylessHistory("NEGHIST", range), e => e.kind === "invalid");
});
