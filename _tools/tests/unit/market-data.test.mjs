// Unit and mocked-integration tests for assets/js/market-data/.
// Run: node --test _tools/tests/unit/
import test from "node:test";
import assert from "node:assert/strict";
import { DataError, withRetry, backoffDelay, createDeduper, createLimiter, validateBaseUrl, fetchText, httpError, parseRetryAfter } from "../../../assets/js/market-data/http.js";
import { createCache } from "../../../assets/js/market-data/cache.js";
import { classifyFreshness, validateQuote, validateHistory, selectBasis, INTRADAY_MS, STALE_AFTER_MS } from "../../../assets/js/market-data/contract.js";
import { parseObservations, crossFromCad, crossHistory, observationsUrl, fetchLatestCadRates } from "../../../assets/js/market-data/providers/boc.js";
import { parseEcbCsv, toCadPer, ecbUrl } from "../../../assets/js/market-data/providers/ecb.js";
import { createFxService } from "../../../assets/js/market-data/fx.js";
import { toAvSymbol, parseAvBody, pickListing, parseGlobalQuote, parseSeries, createUsageCounter, redactKey, createAlphaVantageClient } from "../../../assets/js/market-data/providers/alphavantage.js";
import { createMarketData, historyKind, loadSettings } from "../../../assets/js/market-data/index.js";
import { parsePriceCsv, detectFrequency } from "../../../assets/js/market-data/price-import.js";
import { buildFxAligner, normalizeSeries } from "../../../assets/js/market-data/fx-align.js";
import { parseCsv } from "../../../assets/js/market-data/csv.js";
import { normalizeSymbol, normalizeSymbolList } from "../../../assets/js/market-data/symbols.js";
import * as F from "./fixtures.mjs";

const NOW = Date.parse("2026-11-02T18:00:00Z");
const noSleep = async () => {};

/* ---------------- http ---------------- */
test("withRetry retries transient errors with bounded attempts", async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(async () => { calls += 1; if (calls < 3) throw new DataError("x", { kind: "network" }); return "ok"; },
    { retries: 2, sleep: async ms => { delays.push(ms); }, random: () => 0.5 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0], "backoff grows");
});

test("withRetry does not retry definitive or client errors and gives up after the limit", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new DataError("nope", { kind: "not_found", definitive: true }); }, { sleep: noSleep }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw new DataError("busy", { kind: "unavailable" }); }, { retries: 2, sleep: noSleep }));
  assert.equal(calls, 3);
});

test("withRetry honours Retry-After but refuses waits beyond the cap", async () => {
  const waits = [];
  let n = 0;
  await withRetry(async () => { n += 1; if (n === 1) throw new DataError("rl", { kind: "rate_limited", retryAfterMs: 3000 }); return 1; }, { sleep: async ms => waits.push(ms), maxDelayMs: 5000, random: () => 0 });
  assert.equal(waits[0], 3000);
  n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw new DataError("rl", { kind: "rate_limited", retryAfterMs: 60000 }); }, { sleep: noSleep, maxDelayMs: 5000 }));
  assert.equal(n, 1);
});

test("backoff delay has jitter within [ceiling/2, ceiling]", () => {
  for (const r of [0, 0.25, 1]) {
    const d = backoffDelay(3, { baseMs: 500, maxDelayMs: 5000, random: () => r });
    assert.ok(d >= 2000 && d <= 4000, String(d));
  }
  assert.ok(backoffDelay(10, { baseMs: 500, maxDelayMs: 5000, random: () => 1 }) <= 5000);
});

test("parseRetryAfter handles seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("7"), 7000);
  assert.equal(parseRetryAfter(new Date(NOW + 10000).toUTCString(), NOW), 10000);
  assert.equal(parseRetryAfter("soon"), null);
});

test("deduper shares one in-flight request; limiter caps concurrency", async () => {
  const d = createDeduper();
  let runs = 0;
  const task = () => new Promise(r => { runs += 1; setTimeout(() => r(42), 5); });
  const [a, b] = await Promise.all([d.run("k", task), d.run("k", task)]);
  assert.equal(a, 42); assert.equal(b, 42); assert.equal(runs, 1);
  const limit = createLimiter(2);
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => { active += 1; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 3)); active -= 1; })));
  assert.equal(peak, 2);
});

test("validateBaseUrl allows https/loopback only, without credentials or query", () => {
  assert.equal(validateBaseUrl("https://x.example.com/"), "https://x.example.com");
  assert.equal(validateBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  for (const bad of ["http://evil.example.com", "https://u:p@x.com", "https://x.com/?url=1", "javascript:alert(1)", "ftp://x"]) assert.equal(validateBaseUrl(bad), null, bad);
});

test("fetchText enforces a response size cap and a timeout", async () => {
  const big = async () => new Response("x".repeat(2000));
  await assert.rejects(fetchText("https://a.example/", { fetchImpl: big, maxBytes: 1000 }), e => e.kind === "too_large");
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(fetchText("https://a.example/", { fetchImpl: hang, timeoutMs: 20 }), e => e.kind === "timeout");
  const refused = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchText("https://a.example/", { fetchImpl: refused }), e => e.kind === "network");
});

test("httpError classifies statuses", () => {
  assert.equal(httpError(429).kind, "rate_limited");
  assert.equal(httpError(503).kind, "unavailable");
  assert.equal(httpError(404).kind, "not_found");
  assert.equal(httpError(400).kind, "http");
});

/* ---------------- cache ---------------- */
test("cache returns fresh, then stale, then expires; evicts oldest when full", () => {
  let t = NOW;
  const c = createCache({ storage: F.memory(), now: () => t, maxEntries: 2 });
  c.set("a", { v: 1 });
  assert.equal(c.get("a", { freshMs: 1000, staleMs: 5000 }).fresh, true);
  t += 2000;
  const stale = c.get("a", { freshMs: 1000, staleMs: 5000 });
  assert.equal(stale.fresh, false); assert.equal(stale.value.v, 1);
  t += 4000;
  assert.equal(c.get("a", { freshMs: 1000, staleMs: 5000 }), null);
  c.set("b", 1); t += 1; c.set("c", 2); t += 1; c.set("d", 3);
  assert.equal(c.size(), 2);
  assert.equal(c.get("b", { freshMs: 1e9 }), null, "oldest evicted");
});

test("cache survives a storage that throws (quota exceeded)", () => {
  const throwing = { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  const c = createCache({ storage: throwing });
  assert.equal(c.set("a", 1), false);
});

/* ---------------- contract ---------------- */
test("freshness classification thresholds", () => {
  assert.equal(classifyFreshness(new Date(NOW - INTRADAY_MS + 1000).toISOString(), NOW).status, "intraday");
  assert.equal(classifyFreshness(new Date(NOW - 3 * 86400000).toISOString(), NOW).status, "recent-close");
  assert.equal(classifyFreshness(new Date(NOW - STALE_AFTER_MS - 1000).toISOString(), NOW).status, "stale");
  assert.equal(classifyFreshness(null, NOW).status, "unknown");
});

test("quotes with missing, zero, negative or non-finite prices are rejected", () => {
  const base = { symbol: "X", currency: "USD", priceTime: null, sessionDate: "2026-10-30" };
  for (const price of [0, -1, NaN, Infinity, null, "12"]) assert.throws(() => validateQuote({ ...base, price }), e => e.kind === "invalid", String(price));
  assert.ok(validateQuote({ ...base, price: 12.5 }));
  assert.throws(() => validateQuote({ ...base, price: 1, currency: "usd$" }));
});

test("history must be ascending and unique with positive prices", () => {
  const d = s => new Date(`${s}T00:00:00Z`);
  assert.throws(() => validateHistory({ symbol: "X", currency: "USD", observations: [{ date: d("2026-01-02"), close: 1, adjClose: null }, { date: d("2026-01-02"), close: 1, adjClose: null }] }));
  assert.throws(() => validateHistory({ symbol: "X", currency: "USD", observations: [{ date: d("2026-01-02"), close: 0, adjClose: null }] }));
});

test("selectBasis never mixes adjusted and unadjusted values and warns on fallback", () => {
  const d = s => new Date(`${s}T00:00:00Z`);
  const h = { symbol: "X", observations: [{ date: d("2026-01-02"), close: 10, adjClose: 9 }, { date: d("2026-01-05"), close: 11, adjClose: null }, { date: d("2026-01-06"), close: 12, adjClose: 11 }] };
  const adj = selectBasis(h, "adjusted");
  assert.equal(adj.priceBasis, "adjusted_close");
  assert.deepEqual(adj.observations.map(o => o.price), [9, 11]);
  const close = selectBasis(h, "close");
  assert.deepEqual(close.observations.map(o => o.price), [10, 11, 12]);
  const fallback = selectBasis({ ...h, observations: h.observations.map(o => ({ ...o, adjClose: null })) }, "adjusted");
  assert.equal(fallback.priceBasis, "close");
  assert.match(fallback.warning, /no adjusted closes/);
});

/* ---------------- Bank of Canada ---------------- */
test("BoC parsing and cross rates (direction and derivation)", () => {
  const body = F.bocJson([
    { d: "2026-10-29", FXUSDCAD: 1.3985, FXEURCAD: 1.5601, FXJPYCAD: 0.00888 },
    { d: "2026-10-30", FXUSDCAD: 1.3960, FXEURCAD: 1.5582, FXJPYCAD: 0.008870 },
  ], ["FXUSDCAD", "FXEURCAD", "FXJPYCAD"]);
  const parsed = parseObservations(body, ["USD", "EUR", "JPY"]);
  assert.equal(parsed.USD.length, 2);
  const latest = { CAD: { date: null, cadPer: 1 }, USD: parsed.USD[1], EUR: parsed.EUR[1], JPY: parsed.JPY[1] };
  // USD -> CAD: 1 USD buys 1.3960 CAD (direct series).
  assert.equal(crossFromCad("USD", "CAD", latest).rate, 1.3960);
  assert.equal(crossFromCad("USD", "CAD", latest).method, "direct");
  // CAD -> USD is the inverse.
  assert.ok(Math.abs(crossFromCad("CAD", "USD", latest).rate - 1 / 1.3960) < 1e-12);
  // EUR -> USD derived through CAD: 1.5582 / 1.3960.
  const eurusd = crossFromCad("EUR", "USD", latest);
  assert.ok(Math.abs(eurusd.rate - 1.5582 / 1.3960) < 1e-12);
  assert.equal(eurusd.method, "cross");
  // USD -> JPY: 1.3960 / 0.008870 ≈ 157.38 yen per dollar.
  assert.ok(Math.abs(crossFromCad("USD", "JPY", latest).rate - 157.384) < 0.01);
  assert.equal(crossFromCad("USD", "USD", latest).rate, 1);
  const hist = crossHistory("EUR", "USD", parsed);
  assert.equal(hist.length, 2);
  assert.ok(Math.abs(hist[0].rate - 1.5601 / 1.3985) < 1e-12);
  assert.deepEqual(crossHistory("CAD", "USD", parsed).map(p => p.date), ["2026-10-29", "2026-10-30"]);
});

test("BoC rejects unsupported currencies and invalid values", () => {
  assert.throws(() => observationsUrl(["XYZ"]), e => e.definitive);
  assert.equal(observationsUrl(["USD", "EUR"], { recent: 5 }), "https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD/json?recent=5");
  assert.throws(() => parseObservations(F.bocJson([{ d: "2026-10-30", FXUSDCAD: -1 }]), ["USD"]), e => e.kind === "invalid");
  assert.throws(() => parseObservations("<html>", ["USD"]), e => e.kind === "invalid");
});

test("BoC latest fetch picks the most recent observation and handles a holiday gap", async () => {
  const fetchImpl = F.stubFetch(url => {
    assert.equal(url.hostname, "www.bankofcanada.ca");
    return F.response(200, F.bocJson([{ d: "2026-10-29", FXUSDCAD: 1.3985 }, { d: "2026-10-30", FXUSDCAD: 1.3960 }]));
  });
  const latest = await fetchLatestCadRates(["USD", "CAD"], { fetchImpl });
  assert.deepEqual(latest.USD, { date: "2026-10-30", cadPer: 1.396 });
  assert.equal(latest.CAD.cadPer, 1);
});

/* ---------------- ECB ---------------- */
test("ECB CSV parsing (quoted fields) and conversion to CAD-per-unit", () => {
  const csv = F.ecbCsv([["CAD", "2026-11-02", "1.5673"], ["USD", "2026-11-02", "1.1216"], ["JPY", "2026-11-02", "177.10"]]);
  const parsed = parseEcbCsv(csv);
  assert.equal(parsed.USD[0].perEur, 1.1216);
  const cad = toCadPer(parsed);
  assert.ok(Math.abs(cad.USD[0].cadPer - 1.5673 / 1.1216) < 1e-12, "CAD per USD = (CAD/EUR) / (USD/EUR)");
  assert.equal(cad.EUR[0].cadPer, 1.5673);
  assert.match(ecbUrl(["USD"], { last: 5 }), /D\.CAD\+USD\.EUR\.SP00\.A\?format=csvdata&lastNObservations=5/);
  assert.throws(() => parseEcbCsv("a,b\n1,2"), e => e.kind === "invalid");
});

/* ---------------- FX service ---------------- */
test("FX service falls back from the Bank of Canada to the ECB, then to a labelled stale cache", async () => {
  const storage = F.memory();
  let t = NOW;
  let bocUp = false;
  let ecbUp = true;
  const fetchImpl = F.stubFetch(url => {
    if (url.hostname === "www.bankofcanada.ca") return bocUp ? F.response(200, F.bocJson([{ d: "2026-10-30", FXUSDCAD: 1.396 }])) : F.response(503, "down");
    if (url.hostname === "data-api.ecb.europa.eu") return ecbUp ? F.response(200, F.ecbCsv([["CAD", "2026-11-02", "1.5673"], ["USD", "2026-11-02", "1.1216"]]), { "content-type": "text/csv" }) : F.response(500, "x");
    throw new Error(`unexpected host ${url.hostname}`);
  });
  const fx = createFxService({ fetchImpl, storage, now: () => t });
  const first = await fx.latest(["USD", "CAD"]);
  assert.equal(first.provider, "European Central Bank");
  assert.match(first.failures[0], /Bank of Canada/);
  assert.ok(Math.abs(fx.rate("USD", "CAD", first.cadPer).rate - 1.5673 / 1.1216) < 1e-12);
  // Within the hour: cached, no new request.
  const calls = fetchImpl.calls.length;
  const again = await fx.latest(["CAD", "USD"]);
  assert.equal(again.cached, true); assert.equal(fetchImpl.calls.length, calls);
  // Two hours later both sources are down: the cached value is served as stale.
  t += 2 * 3600000; ecbUp = false;
  const stale = await fx.latest(["USD", "CAD"]);
  assert.equal(stale.stale, true);
  // No cache at all: a clear error.
  const empty = createFxService({ fetchImpl, storage: F.memory(), now: () => t });
  await assert.rejects(empty.latest(["USD"]), e => e.kind === "unavailable" && /Bank of Canada/.test(e.message));
  bocUp = true;
  const boc = await empty.latest(["USD"]);
  assert.equal(boc.provider, "Bank of Canada");
});

/* ---------------- Alpha Vantage ---------------- */
test("symbol mapping to Alpha Vantage exchanges", () => {
  const ok = { "RY.TO": "RY.TRT", "XEQT.TO": "XEQT.TRT", "GPV.V": "GPV.TRV", "AAPL": "AAPL", "VFV.TO": "VFV.TRT", "TSCO.L": "TSCO.LON", "brk.b": "BRK.B", "SHOP.TRT": "SHOP.TRT", "VFIAX": "VFIAX" };
  for (const [input, expected] of Object.entries(ok)) assert.equal(toAvSymbol(input), expected, input);
  for (const bad of ["^GSPC", "^GSPTSE", "CADUSD=X", "7203.T", "BHP.AX", "MC.PA"]) assert.throws(() => toAvSymbol(bad), e => e.definitive, bad);
});

test("Alpha Vantage HTTP-200 error bodies are mapped to DataError kinds", () => {
  assert.throws(() => parseAvBody(F.AV_RATE_LIMIT), e => e.kind === "rate_limited");
  assert.throws(() => parseAvBody(F.AV_BAD_KEY), e => e.kind === "auth");
  assert.throws(() => parseAvBody(F.AV_BAD_SYMBOL, { symbol: "ZZZZ" }), e => e.kind === "not_found" && e.definitive);
  assert.throws(() => parseAvBody(F.AV_PREMIUM), e => e.kind === "not_found");
  assert.throws(() => parseAvBody(JSON.stringify({ Information: "The **demo** API key is for demo purposes only." })), e => e.kind === "auth");
  assert.throws(() => parseAvBody("<html>"), e => e.kind === "invalid");
  assert.throws(() => parseGlobalQuote({ "Global Quote": {} }, "ZZZZ"), e => e.kind === "not_found");
});

test("listing currency evidence: exact match only; GBX pence converted to GBP", () => {
  const body = JSON.parse(F.avSearch([["TSCO.LON", "United Kingdom", "GBX"], ["TSCDF", "United States", "USD"]]));
  const tsco = pickListing(body, "TSCO.LON");
  assert.equal(tsco.currency, "GBP"); assert.equal(tsco.unitScale, 0.01);
  assert.equal(pickListing(body, "TSCO"), null);
  const q = parseGlobalQuote(JSON.parse(F.avGlobalQuote("TSCO.LON", 412, "2026-10-30")), "TSCO.L", tsco);
  assert.equal(q.price, 4.12); assert.equal(q.currency, "GBP"); assert.equal(q.rawCurrency, "GBX");
  assert.equal(q.sessionDate, "2026-10-30");
});

test("weekly adjusted and daily series parse with the right basis", () => {
  const weekly = parseSeries(JSON.parse(F.avWeekly("XIU.TRT", [["2026-10-23", 40, 39.5], ["2026-10-16", 39, 38.5]])), "XIU.TO", { avSymbol: "XIU.TRT", currency: "CAD", unitScale: 1 }, "weekly");
  assert.equal(weekly.frequency, "weekly");
  assert.deepEqual(weekly.observations.map(o => o.adjClose), [38.5, 39.5]);
  const daily = parseSeries(JSON.parse(F.avDaily("AAPL", [["2026-10-29", 230], ["2026-10-30", 232]])), "AAPL", { avSymbol: "AAPL", currency: "USD", unitScale: 1 }, "daily");
  assert.equal(daily.frequency, "daily");
  assert.equal(daily.observations[1].adjClose, null);
  assert.match(daily.adjustment.close, /not adjusted/);
});

test("usage counter resets each UTC day", () => {
  let t = Date.parse("2026-11-02T23:59:00Z");
  const storage = F.memory();
  const u = createUsageCounter(storage, { now: () => t });
  u.increment(); u.increment();
  assert.equal(u.count, 2);
  t = Date.parse("2026-11-03T00:01:00Z");
  assert.equal(u.count, 0);
});

/* ---------------- market-data service ---------------- */
function avServer({ rateLimitAfter = Infinity, quotePrice = { "AAPL": 230.5, "RY.TRT": 180.25 } } = {}) {
  let served = 0;
  return F.stubFetch(url => {
    assert.equal(url.origin + url.pathname, "https://www.alphavantage.co/query");
    assert.equal(url.searchParams.get("apikey"), "TESTKEY123");
    served += 1;
    if (served > rateLimitAfter) return F.response(200, F.AV_RATE_LIMIT);
    const fn = url.searchParams.get("function");
    const symbol = url.searchParams.get("symbol") || url.searchParams.get("keywords");
    if (fn === "SYMBOL_SEARCH") {
      if (symbol === "AAPL") return F.response(200, F.avSearch([["AAPL", "United States", "USD", "Apple Inc"]]));
      if (symbol === "RY.TRT") return F.response(200, F.avSearch([]));
      if (symbol === "RY") return F.response(200, F.avSearch([["RY", "United States", "USD", "Royal Bank of Canada"], ["RY.TRT", "Toronto", "CAD", "Royal Bank of Canada"]]));
      return F.response(200, F.avSearch([]));
    }
    if (fn === "GLOBAL_QUOTE") return quotePrice[symbol] ? F.response(200, F.avGlobalQuote(symbol, quotePrice[symbol], "2026-10-30")) : F.response(200, JSON.stringify({ "Global Quote": {} }));
    if (fn === "TIME_SERIES_WEEKLY_ADJUSTED") return F.response(200, F.avWeekly(symbol, [["2026-10-16", 100, 99], ["2026-10-23", 101, 100], ["2026-10-30", 103, 102]]));
    if (fn === "TIME_SERIES_DAILY") return F.response(200, F.avDaily(symbol, [["2026-10-29", 100], ["2026-10-30", 101]]));
    return F.response(400, "{}");
  });
}

test("market data: no key -> not_configured, never a request", async () => {
  const fetchImpl = avServer();
  const md = createMarketData({ local: F.memory(), fetchImpl, now: () => NOW, sleep: noSleep });
  assert.equal(md.liveAvailable(), false);
  await assert.rejects(md.quote("AAPL"), e => e.kind === "not_configured");
  assert.equal(fetchImpl.calls.length, 0);
  assert.throws(() => md.setApiKey("bad key!"));
});

test("market data: quote uses search evidence for currency, caches, and dedupes", async () => {
  const local = F.memory();
  const fetchImpl = avServer();
  const md = createMarketData({ local, fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  md.setApiKey("TESTKEY123");
  assert.equal(loadSettings(local).alphaVantageKey, "TESTKEY123");
  const [a, b] = await Promise.all([md.quote("RY.TO"), md.quote("RY.TO")]);
  assert.equal(a.quote.price, 180.25);
  assert.equal(a.quote.currency, "CAD", "currency from the Toronto listing found via the stem search");
  assert.equal(a.quote.currencyVerified, true);
  assert.equal(a.quote.symbol, "RY.TRT");
  assert.equal(b.quote.price, 180.25);
  assert.equal(a.freshness.status, "recent-close");
  const used = fetchImpl.calls.length;
  assert.equal(used, 3, "search (full) + search (stem) + quote, once");
  const cached = await md.quote("RY.TO");
  assert.equal(cached.provenance.cached, true);
  assert.equal(fetchImpl.calls.length, used, "cached");
  assert.equal(md.usage().count, 3);
});

test("market data: rate limit stops the batch; unknown symbol is definitive", async () => {
  const fetchImpl = avServer({ rateLimitAfter: 2 });
  const md = createMarketData({ local: F.memory(), fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  md.setApiKey("TESTKEY123");
  const out = await md.quotes(["AAPL", "MSFT", "RY.TO", "XIU.TO"]);
  assert.equal(out.get("AAPL").quote.price, 230.5);
  assert.equal(out.get("MSFT").error.kind, "rate_limited");
  assert.equal(out.get("XIU.TO").error.kind, "rate_limited");
  assert.equal(fetchImpl.calls.length, 3, "no requests after the limit was reported");
  const md2 = createMarketData({ local: F.memory(), fetchImpl: avServer(), now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  md2.setApiKey("TESTKEY123");
  await assert.rejects(md2.quote("ZZZZ"), e => e.kind === "not_found" && e.definitive);
  await assert.rejects(md2.quote("^GSPC"), e => e.definitive && /premium/.test(e.message));
});

test("market data: stale quote is served (and labelled) when a refresh fails", async () => {
  const local = F.memory();
  let t = NOW;
  let limited = false;
  const base = avServer();
  const fetchImpl = async (url, init) => (limited ? F.response(200, F.AV_RATE_LIMIT) : base(url, init));
  const md = createMarketData({ local, fetchImpl, now: () => t, sleep: noSleep, minSpacingMs: 0 });
  md.setApiKey("TESTKEY123");
  await md.quote("AAPL");
  t += 3600000; limited = true;
  const md2 = createMarketData({ local, fetchImpl, now: () => t, sleep: noSleep, minSpacingMs: 0 });
  const stale = await md2.quote("AAPL");
  assert.equal(stale.provenance.stale, true);
  assert.match(stale.provenance.refreshError, /limit/);
});

test("market data: history chooses daily for short windows and weekly adjusted otherwise", async () => {
  const fetchImpl = avServer();
  const md = createMarketData({ local: F.memory(), fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  md.setApiKey("TESTKEY123");
  const d = (s) => new Date(`${s}T00:00:00Z`);
  assert.equal(historyKind({ start: d("2026-08-02"), end: d("2026-11-02") }), "daily");
  assert.equal(historyKind({ start: d("2025-11-02"), end: d("2026-11-02") }), "weekly");
  const { history } = await md.history("AAPL", { start: d("2025-11-02"), end: d("2026-11-02") });
  assert.equal(history.frequency, "weekly");
  assert.equal(history.currency, "USD");
  assert.ok(fetchImpl.calls.some(u => u.includes("TIME_SERIES_WEEKLY_ADJUSTED")));
});

/* ---------------- CSV import ---------------- */
test("price CSV import: combined desktop format", () => {
  const text = "Date,Ticker,Close,Adj Close,Currency\n2024-01-02,AAPL,100,99,USD\n2024-01-03,AAPL,102,101,USD\n2024-01-04,AAPL,101,100,USD\n2024-01-02,XIU.TO,30,29,CAD\n2024-01-03,XIU.TO,31,30,CAD\n2024-01-04,XIU.TO,32,31,CAD\n";
  const { histories } = parsePriceCsv(text, "prices.csv");
  assert.deepEqual(Object.keys(histories).sort(), ["AAPL", "XIU.TO"]);
  assert.equal(histories["XIU.TO"].currency, "CAD");
  assert.equal(histories.AAPL.frequency, "daily");
  assert.equal(histories.AAPL.observations[0].adjClose, 99);
});

test("price CSV import: per-ticker file, aliases, and strict validation", () => {
  const { histories, warnings } = parsePriceCsv("Date,Close,Adjusted Close\n2024-01-05,10,9.5\n2024-01-12,11,10.5\n2024-01-19,12,11.5\n", "VFV.TO.csv");
  assert.equal(histories["VFV.TO"].frequency, "weekly");
  assert.match(warnings[0], /no currency/);
  assert.throws(() => parsePriceCsv("Date,Ticker,Close\n2024-01-02,A,0\n", "x.csv"), /positive/);
  assert.throws(() => parsePriceCsv("Date,Ticker,Close\n2024-01-02,A,1\n2024-01-02,A,2\n", "x.csv"), /more than one row/);
  assert.throws(() => parsePriceCsv("Date,Ticker,Close\n01/02/2024,A,1\n", "x.csv"), /YYYY-MM-DD/);
  assert.throws(() => parsePriceCsv("Date,Ticker,Close,Currency\n2024-01-02,A,1,USD\n2024-01-03,A,1,CAD\n", "x.csv"), /more than one currency/);
  assert.throws(() => parsePriceCsv("Ticker,Close\nA,1\n", "x.csv"), /Date column/);
  assert.throws(() => parsePriceCsv("Date,Ticker,Close\n2024-01-02,A B,1\n", "x.csv"));
  assert.equal(detectFrequency([new Date("2024-01-31"), new Date("2024-02-29"), new Date("2024-03-31")]), "monthly");
});

test("CSV parser handles quotes, embedded commas, CRLF and BOM", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.throws(() => parseCsv('a,"b'), /unterminated/);
});

/* ---------------- FX alignment ---------------- */
test("FX alignment forward-fills, drops prices before the first fixing, and never leaves prices unconverted", () => {
  const d = s => new Date(`${s}T00:00:00Z`);
  const aligner = buildFxAligner([{ date: "2026-10-28", rate: 0.70 }, { date: "2026-10-30", rate: 0.72 }]);
  assert.equal(aligner(d("2026-10-29")).rate, 0.70);
  assert.equal(aligner(d("2026-11-02")).rate, 0.72);
  assert.equal(aligner(d("2026-10-27")), null);
  const { series, warnings } = normalizeSeries({
    "XIU.TO": { ticker: "XIU.TO", currency: "CAD", observations: [{ date: d("2026-10-27"), price: 40 }, { date: d("2026-10-29"), price: 41 }, { date: d("2026-11-02"), price: 42 }] },
    SPY: { ticker: "SPY", currency: "USD", observations: [{ date: d("2026-10-29"), price: 600 }] },
  }, "USD", { CAD: aligner });
  assert.deepEqual(series["XIU.TO"].observations.map(o => +o.price.toFixed(4)), [28.7, 30.24]);
  assert.equal(series["XIU.TO"].currency, "USD");
  assert.equal(series.SPY.observations[0].price, 600);
  assert.match(warnings[0], /dropped/);
});

/* ---------------- symbols ---------------- */
test("symbol validation accepts exchange suffixes, classes, indexes; rejects junk and duplicates", () => {
  for (const s of ["RY.TO", "brk-b", "BRK.B", "^GSPTSE", "CADUSD=X", "VFIAX", "XEQT.TO"]) assert.ok(normalizeSymbol(s));
  for (const s of ["", "A B", "../x", "AAPL?x=1", "<script>", "A".repeat(25)]) assert.throws(() => normalizeSymbol(s), s);
  const { symbols, errors } = normalizeSymbolList(["AAPL", "aapl", "MSFT"], { min: 2 });
  assert.deepEqual(symbols, ["AAPL", "MSFT"]);
  assert.match(errors[0].message, /more than once/);
});

/* ---------------- required instrument matrix ---------------- */
test("instrument matrix: every requested symbol is classified explicitly", () => {
  const supported = { "RY.TO": "RY.TRT", "TD.TO": "TD.TRT", "VEQT.TO": "VEQT.TRT", "XEQT.TO": "XEQT.TRT", "VFV.TO": "VFV.TRT", "XIU.TO": "XIU.TRT",
    AAPL: "AAPL", MSFT: "MSFT", NVDA: "NVDA", SPY: "SPY", VTI: "VTI", VFIAX: "VFIAX", "BBD-B.TO": "BBD-B.TRT", "BRK-B": "BRK-B", "BRK.B": "BRK.B" };
  for (const [input, av] of Object.entries(supported)) {
    assert.equal(normalizeSymbol(input), input.toUpperCase());
    assert.equal(toAvSymbol(input), av, input);
  }
  // Indexes and FX pairs are valid symbols but are not requested from Alpha Vantage.
  for (const unsupported of ["^GSPC", "^GSPTSE", "USDCAD=X", "CADUSD=X", "EURUSD=X", "USDJPY=X"]) {
    assert.ok(normalizeSymbol(unsupported));
    assert.throws(() => toAvSymbol(unsupported), e => e.definitive && e.kind === "not_found", unsupported);
  }
  // Punctuation that could reach a URL is rejected before any request.
  for (const bad of ["RY.TO/../x", "AAPL&apikey=x", "RY TO", "TD..TO", ".TO"]) assert.throws(() => normalizeSymbol(bad), bad);
});

test("FX matrix from one set of Bank of Canada fixings: USD/CAD, CAD/USD, EUR/USD, USD/JPY", () => {
  const latest = { CAD: { cadPer: 1, date: null }, USD: { cadPer: 1.3960, date: "2026-10-30" }, EUR: { cadPer: 1.5582, date: "2026-10-30" }, JPY: { cadPer: 0.008870, date: "2026-10-30" } };
  const pair = (a, b) => crossFromCad(a, b, latest).rate;
  assert.equal(pair("USD", "CAD"), 1.3960);
  assert.ok(Math.abs(pair("CAD", "USD") * pair("USD", "CAD") - 1) < 1e-15, "CAD/USD is the exact inverse of USD/CAD");
  assert.ok(Math.abs(pair("EUR", "USD") - 1.116189) < 1e-6);
  assert.ok(Math.abs(pair("USD", "JPY") - 157.384) < 1e-3);
  // Triangular consistency: EUR->JPY = EUR->USD x USD->JPY.
  assert.ok(Math.abs(pair("EUR", "JPY") - pair("EUR", "USD") * pair("USD", "JPY")) < 1e-9);
});

test("the API key never appears in error messages", async () => {
  assert.equal(redactKey("We have detected your API key as ABCD1234XYZ and ..."), "We have detected your API key as [redacted] and ...");
  const client = createAlphaVantageClient({ apiKey: "SECRETKEY99", minSpacingMs: 0, sleep: noSleep,
    fetchImpl: async () => F.response(200, JSON.stringify({ Information: "Unusual notice mentioning SECRETKEY99 for your account." })) });
  await assert.rejects(client.globalQuote("AAPL"), e => !e.message.includes("SECRETKEY99") && e.message.includes("[redacted]"));
});
