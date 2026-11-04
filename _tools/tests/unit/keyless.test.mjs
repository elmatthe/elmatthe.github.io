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
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: ORIGIN };
const NOW = Date.parse("2026-11-03T15:00:00Z");
const AV_KEY = "TESTKEY12345";

// The browser side: fetch() calls to the gateway go to the real gateway handler; Alpha
// Vantage answers with its daily-limit notice (to test fallback); anything else fails.
function world({ env = ON, mode = {}, avLimited = false, gatewayDown = false, local = memoryStorage() } = {}) {
  let t = NOW;
  const calls = { gateway: [], av: 0, yahoo: [] };
  const upstreamMode = { ...mode, calls: calls.yahoo };
  const gw = createGateway({ fetchImpl: yahooFetch({ now: () => t, mode: upstreamMode }), now: () => t, log: () => {}, cache: null, limits: { upstreamMinSpacingMs: 0 }, sleep: async () => {} });
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
  const md = createMarketData({ local, session: memoryStorage(), fetchImpl, now: () => t, reference: REFERENCE, gatewayUrl: GATEWAY, minSpacingMs: 0, sleep: async () => {}, locks: null });
  return { md, calls, local, upstreamMode, advance: ms => { t += ms; } };
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
  assert.equal(resolveMarketGateway("https://gw.example", { hostname: "127.0.0.1", search: "?mdgateway=none" }), "", "local testing can switch the gateway off");
  assert.equal(resolveMarketGateway("https://gw.example", { hostname: "elmatthe.github.io", search: "?mdgateway=none" }), "https://gw.example");
  assert.equal(historyBucket({ start: new Date(NOW - 10 * 86400000), end: new Date(NOW) }), "1mo");
  assert.equal(historyBucket({ start: new Date(NOW - 365 * 86400000), end: new Date(NOW) }), "2y");
  assert.equal(historyBucket({ start: new Date(NOW - 3 * 365 * 86400000), end: new Date(NOW) }), "5y");
});

test("availability: not configured sends nothing; disabled and unreachable gateways are reported, not assumed", async () => {
  let requests = 0;
  const none = createKeylessSource({ baseUrl: "", fetchImpl: async () => { requests += 1; throw new Error("no"); } });
  assert.equal((await none.check()).state, "not_configured");
  assert.equal(requests, 0, "no request at all without a configured gateway");
  assert.deepEqual(none.availability(), { available: false, code: "not_configured", reason: "not available on this site yet", short: "not available on this site yet" });
  await assert.rejects(none.quote(resolver.resolve("AAPL")), e => e.kind === "not_configured");
  assert.equal(createKeylessSource({ baseUrl: "http://gw.example" }).configured(), false, "plain HTTP is refused outside this computer");

  const off = world({ env: { ALLOWED_ORIGINS: ORIGIN } });
  const st = await off.md.keyless.check();
  assert.equal(st.state, "disabled");
  assert.match(st.reason, /switched off/);
  await assert.rejects(off.md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === "not_configured" && /No source in your list can give a usable price \(Yahoo Finance: switched off on this site at the moment\)/.test(e.message));
  assert.equal(off.calls.gateway.length, 1, "only the health check was sent");
  assert.equal(off.calls.yahoo.length, 0);

  const down = world({ gatewayDown: true });
  assert.equal((await down.md.keyless.check()).state, "unreachable");
  assert.equal(down.md.hasPriceSource(), false);
});

test("new browser, no keys: the free source prices all fourteen sample holdings with exact listing, currency and unit", async () => {
  const { md, calls } = world();
  assert.equal((await md.keyless.check()).state, "enabled");
  assert.deepEqual(md.sources.enabledOrder(), [KEYLESS_ID], "zero keys: Yahoo Finance is the only source switched on");
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
  assert.equal(md.estimate([id]).perProvider[KEYLESS_ID].requests, 0, "the estimate knows the saved copy is free");
});

test("re-validation in the browser: a gateway answer for another listing, currency or unit is refused", async () => {
  const tamper = change => ({ answer: u => {
    if (!u.pathname.endsWith("/v1/quote")) return null;
    return (async () => {
      const gw = createGateway({ fetchImpl: yahooFetch({ now: () => NOW }), now: () => NOW, log: () => {}, cache: null, limits: { upstreamMinSpacingMs: 0 } });
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
    await assert.rejects(md.priceInstrument(resolver.resolve("SAP.DE")), e => e.attempts[0].kind === kind && pattern.test(e.attempts[0].message), String(change));
  }
});

test("failures: rate limits, outages, timeouts and unsupported listings explain themselves; no fabricated price", async () => {
  for (const [mode, kind] of [[{ limited: true }, "rate_limited"], [{ down: true }, "unavailable"], [{ blocked: true }, "unavailable"]]) {
    const { md, calls } = world({ mode });
    await md.keyless.check();
    await assert.rejects(md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === kind && e.provider === "Yahoo Finance" && e.attempts.length === 1, JSON.stringify(mode));
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

test("order: Yahoo Finance first by default; a new key joins below it; reordering and fallback follow the list", async () => {
  const { md, calls } = world({ avLimited: true });
  await md.keyless.check();
  const added = md.setKey("alphavantage", AV_KEY);
  assert.match(added.note, /Alpha Vantage is switched on at position 2 of 4, after Yahoo Finance/, "a saved key never jumps to the top");
  const veqt = resolver.resolve("VEQT.TO");
  assert.deepEqual(md.route(veqt).candidates.map(c => c.id), [KEYLESS_ID, "alphavantage"]);
  const first = await md.priceInstrument(veqt);
  assert.equal(first.providerId, KEYLESS_ID);
  assert.equal(calls.av, 0, "the first source answered: Alpha Vantage is not asked");
  // Yahoo Finance moved to the bottom: Alpha Vantage first; its daily limit makes Yahoo Finance answer, and the limit stays visible.
  md.sources.move(KEYLESS_ID, 9);
  assert.deepEqual(md.sources.order(), ["alphavantage", "marketstack", "finnhub", KEYLESS_ID]);
  assert.deepEqual(md.route(veqt).candidates.map(c => c.id), ["alphavantage", KEYLESS_ID]);
  const q = await md.priceInstrument(veqt, { useCache: false });
  assert.equal(q.providerId, KEYLESS_ID);
  assert.equal(q.fallbackFrom.length, 1);
  assert.equal(q.fallbackFrom[0].provider, "Alpha Vantage");
  assert.equal(q.fallbackFrom[0].kind, "rate_limited");
  assert.equal(q.fallbackFrom[0].quotaScope, "daily");
  assert.ok(md.providerStatus("alphavantage").limitRecord, "the daily limit stays recorded on the key's card");
  // The exhausted provider is now skipped without a request.
  const sentAv = calls.av;
  const plan = md.route(veqt);
  assert.deepEqual(plan.candidates.map(c => c.id), [KEYLESS_ID]);
  assert.match(plan.skipped.find(x => x.id === "alphavantage").reason, /reported its daily limit/);
  await md.priceInstrument(veqt, { useCache: false });
  assert.equal(calls.av, sentAv, "no request to a provider whose daily limit is recorded");
  // Listings no key covers use Yahoo Finance wherever it stands.
  assert.deepEqual(md.route(resolver.resolve("7203.T")).candidates.map(c => c.id), [KEYLESS_ID]);
  assert.deepEqual(md.route(resolver.resolve("YNVD.NE")).candidates.map(c => c.id), [KEYLESS_ID]);
  // Yahoo Finance switched off: nothing is left that can answer; the reason is given.
  assert.equal(md.sources.setEnabled(KEYLESS_ID, false).changed, true);
  await assert.rejects(md.priceInstrument(veqt, { useCache: false }), e => e.kind === "not_configured" && /Alpha Vantage: daily limit reached/.test(e.message));
  // Removing the only key switches Yahoo Finance back on, with an explanation.
  const removed = md.setKey("alphavantage", "");
  assert.match(removed.note, /Yahoo Finance was switched back on because no other source in your list can be used/);
  assert.deepEqual(md.sources.enabledOrder(), [KEYLESS_ID]);
  assert.deepEqual(md.sources.order(), ["alphavantage", "marketstack", "finnhub", KEYLESS_ID], "the order itself is kept");
});

test("pauses: after a rate limit nothing more is sent until Retry-After has passed, across reloads; one outage does not pause", async () => {
  const local = memoryStorage();
  const limited = world({ mode: { limited: true }, local });
  await limited.md.keyless.check();
  await assert.rejects(limited.md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === "rate_limited" && /Yahoo Finance: rate-limited/.test(e.message));
  assert.equal(limited.md.keyless.pauseState().paused, true);
  assert.ok(limited.md.keyless.pauseState().minutesLeft >= 15, "the gateway's 15-minute cooldown is honoured");
  const sent = limited.calls.gateway.filter(u => u.includes("/v1/quote")).length;
  for (const t of ["MSFT", "SPY", "VEQT.TO"]) await assert.rejects(limited.md.priceInstrument(resolver.resolve(t)), e => /paused after a rate limit/.test(e.message), t);
  assert.equal(limited.calls.gateway.filter(u => u.includes("/v1/quote")).length, sent, "no request while paused");
  assert.equal(limited.md.sources.list()[0].status, "unavailable");
  // A new page in the same browser (same storage) keeps the pause.
  const reload = world({ local });
  await reload.md.keyless.check();
  assert.equal(reload.md.keyless.pauseState().paused, true);
  assert.equal(reload.md.hasPriceSource(), false);
  await assert.rejects(reload.md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === "not_configured" && /Yahoo Finance: paused after a rate limit/.test(e.message));
  assert.equal(reload.calls.gateway.filter(u => u.includes("/v1/quote")).length, 0);
  // After the pause, requests resume.
  reload.advance(16 * 60000);
  assert.equal(reload.md.keyless.pauseState().paused, false);
  assert.equal((await reload.md.priceInstrument(resolver.resolve("AAPL"))).providerId, KEYLESS_ID);

  // A single outage for one listing does not stop the others; the gateway's breaker (three failures) does.
  const flaky = world({ mode: { downFor: ["AAPL"] } });
  await flaky.md.keyless.check();
  await assert.rejects(flaky.md.priceInstrument(resolver.resolve("AAPL")), e => /Yahoo Finance: unavailable/.test(e.message));
  assert.equal(flaky.md.keyless.pauseState().paused, false);
  assert.equal((await flaky.md.priceInstrument(resolver.resolve("MSFT"))).providerId, KEYLESS_ID);
  const down = world({ mode: { down: true } });
  await down.md.keyless.check();
  for (const t of ["AAPL", "MSFT", "SPY"]) await assert.rejects(down.md.priceInstrument(resolver.resolve(t)));
  assert.equal(down.md.keyless.pauseState().paused, true, "the breaker's long Retry-After pauses the page");
  assert.equal(down.md.keyless.pauseState().kind, "unavailable");
  await assert.rejects(down.md.priceInstrument(resolver.resolve("VST")), e => /paused after an outage/.test(e.message));
  assert.equal(down.calls.yahoo.length, 3, "nothing more reached the data source");
  // The gateway reporting its own cooldown in /v1/health pauses a fresh page before any request.
  let quoteRequests = 0;
  const store = memoryStorage();
  const fresh = createKeylessSource({ baseUrl: GATEWAY, storage: store, now: () => NOW, sleep: async () => {}, locks: null, fetchImpl: async url => {
    if (String(url).endsWith("/v1/health")) return new Response(JSON.stringify({ schema: "md-gateway.health.v1", keyless: { enabled: true }, upstream: { state: "cooling_down", code: "upstream_rate_limited", retryAfterSeconds: 600 } }), { status: 200 });
    quoteRequests += 1;
    throw new Error("must not be called");
  } });
  await fresh.check();
  assert.equal(fresh.availability().code, "paused");
  assert.equal(fresh.pauseState().minutesLeft, 10);
  await assert.rejects(fresh.quote(resolver.resolve("AAPL")), e => e.paused === true && e.kind === "rate_limited");
  assert.equal(quoteRequests, 0);
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
