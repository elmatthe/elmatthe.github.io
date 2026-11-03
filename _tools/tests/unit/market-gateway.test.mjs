// Market-data gateway (Cloudflare Worker) tests: activation gate, allowlists, schema and
// value checks, CORS, rate limits, caching and failure handling. The Worker module runs
// unchanged in Node 22 (Request, Response, crypto.subtle); Yahoo Finance is replaced by
// the synthetic fixtures in ../fixtures/yahoo-chart.mjs, so nothing leaves this process.
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, sourceState, parseOrigins, LIMITS, CACHE_TTL_SECONDS } from "../../../_services/market-data-gateway/src/gateway.js";
import { VENUES, parseSymbol } from "../../../_services/market-data-gateway/src/venues.js";
import { chartUrl, HISTORY_RANGES } from "../../../_services/market-data-gateway/src/yahoo-chart.js";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { KEYLESS_VENUES } from "../../../assets/js/market-data/keyless.js";

const ORIGIN = "https://elmatthe.github.io";
const BASE = "https://market-data-gateway.example.workers.dev";
const NOW = Date.parse("2026-11-03T15:00:00Z"); // a Tuesday
const ON = { KEYLESS_SOURCE: "yahoo-chart", SOURCE_AUTHORIZATION: "test fixture only", ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:4000` };

function setup({ mode = {}, env = ON, cache = null, limits = {} } = {}) {
  let t = NOW;
  const calls = [];
  const logs = [];
  const upstream = yahooFetch({ now: () => t, mode });
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return upstream(url, init); };
  const gw = createGateway({ fetchImpl, now: () => t, log: e => logs.push(JSON.stringify(e)), cache, limits });
  const get = async (path, { origin = ORIGIN, ip = "198.51.100.7", method = "GET", headers = {}, e = env } = {}) => {
    const r = await gw.handle(new Request(`${BASE}${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": ip, ...headers } }), e);
    const text = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers), body: text ? JSON.parse(text) : null };
  };
  return { gw, get, calls, logs, advance: ms => { t += ms; } };
}
const quote = s => `/v1/quote?symbol=${encodeURIComponent(s)}`;
const history = (s, range = "1y") => `/v1/history?symbol=${encodeURIComponent(s)}&range=${range}&interval=1d`;

/* ---------------- activation gate ---------------- */
test("off by default: no setting, or no recorded authorization, means no upstream request", async () => {
  for (const env of [{}, { KEYLESS_SOURCE: "" }, { KEYLESS_SOURCE: "off" }, { KEYLESS_SOURCE: "yahoo-chart" }, { KEYLESS_SOURCE: "yahoo-chart", SOURCE_AUTHORIZATION: "   " }, { KEYLESS_SOURCE: "stooq", SOURCE_AUTHORIZATION: "x" }]) {
    const { get, calls } = setup({ env: { ...env, ALLOWED_ORIGINS: ORIGIN } });
    const h = await get("/v1/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.keyless.enabled, false, JSON.stringify(env));
    assert.ok(h.body.keyless.reason.length > 20);
    for (const path of [quote("AAPL"), history("AAPL")]) {
      const r = await get(path, { e: { ...env, ALLOWED_ORIGINS: ORIGIN } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, "source_disabled");
      assert.equal(r.body.error.retryable, false);
    }
    assert.equal(calls.length, 0, "no request reaches the data source while the source is off");
  }
  assert.match(sourceState({ KEYLESS_SOURCE: "yahoo-chart" }).reason, /no written authorization/);
  assert.equal(sourceState(ON).enabled, true);
});

test("health: no secrets, the authorization reference itself is never returned", async () => {
  const { get } = setup({ env: { ...ON, SOURCE_AUTHORIZATION: "Agreement REF-123 kept in owner files" } });
  const h = await get("/v1/health", { origin: null });
  assert.equal(h.status, 200);
  assert.equal(h.headers["access-control-allow-origin"], undefined, "no CORS grant without an allowed origin");
  assert.deepEqual(h.body.keyless, { enabled: true, source: "yahoo-chart", reason: null, provider: "Yahoo Finance", attribution: h.body.keyless.attribution, official: false });
  assert.ok(!JSON.stringify(h.body).includes("REF-123"));
  assert.deepEqual(h.body.history, { ranges: ["1mo", "3mo", "6mo", "1y", "2y", "5y"], intervals: ["1d"] });
});

/* ---------------- fixed upstream ---------------- */
test("upstream URL: fixed host and path, allowlisted parameters, honest User-Agent, no client headers, no redirects", async () => {
  const { get, calls } = setup();
  const r = await get(quote("VEQT.TO"), { headers: { Cookie: "session=secret", Authorization: "Bearer abc", "X-Forwarded-For": "10.0.0.1" } });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin, "https://query1.finance.yahoo.com");
  assert.equal(u.pathname, "/v8/finance/chart/VEQT.TO");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["includePrePost", "interval", "range"]);
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["Accept", "User-Agent"]);
  assert.match(calls[0].init.headers["User-Agent"], /^market-data-gateway\/\d/, "identifies itself; does not imitate a browser");
  assert.ok(!/Mozilla|Chrome|Safari/.test(calls[0].init.headers["User-Agent"]));
  await get(history("SAP.DE", "5y"));
  const h = new URL(calls[1].url);
  assert.equal(h.searchParams.get("range"), "5y");
  assert.equal(h.searchParams.get("interval"), "1d");
  assert.throws(() => chartUrl("AAPL", { kind: "history", range: "max" }));
});

test("browser adapter and gateway serve the same venues with the same suffixes", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(VENUES).map(([mic, v]) => [mic, v.suffix])), KEYLESS_VENUES);
});

/* ---------------- the sample's listings ---------------- */
test("international listings: exact listing, currency and unit (GBp to GBP), trading date in the venue's time zone", async () => {
  const { get } = setup();
  const expected = {
    AAPL: ["US", "USD", "USD", 1], "VEQT.TO": ["XTSE", "CAD", "CAD", 1], "YNVD.NE": ["NEOE", "CAD", "CAD", 1], "7203.T": ["XTKS", "JPY", "JPY", 1],
    "SAP.DE": ["XETR", "EUR", "EUR", 1], "VOD.L": ["XLON", "GBP", "GBp", 0.01], "600519.SS": ["XSHG", "CNY", "CNY", 1], "DLR-U.TO": ["XTSE", "USD", "USD", 1],
  };
  for (const [symbol, [mic, currency, raw, scale]] of Object.entries(expected)) {
    const r = await get(quote(symbol), { ip: `203.0.113.${Object.keys(expected).indexOf(symbol)}` });
    assert.equal(r.status, 200, symbol);
    const b = r.body;
    assert.equal(b.schema, "md-gateway.quote.v1");
    assert.equal(b.listing.symbol, symbol);
    assert.equal(b.listing.mic, mic);
    assert.equal(b.currency, currency, symbol);
    assert.equal(b.rawCurrency, raw, symbol);
    assert.equal(b.unitScale, scale, symbol);
    assert.equal(b.quoteUnit, scale === 1 ? "major" : "minor");
    assert.ok(Math.abs(b.price - b.rawPrice * scale) < 1e-9, symbol);
    assert.ok(b.price > 0 && Number.isFinite(b.price));
    assert.match(b.tradingDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(b.tradingDate, new Intl.DateTimeFormat("en-CA", { timeZone: VENUES[mic].timeZone }).format(new Date(b.sourceTime)), `${symbol}: date in the venue's zone`);
    assert.equal(b.priceBasis, "regular_market_price");
    assert.equal(b.adjusted, false);
    assert.equal(b.delay.realTime, false, "never labelled real-time");
    assert.equal(b.source.official, false);
    assert.equal(b.cache.status, "miss");
    assert.ok(Date.parse(b.retrievedAt) === NOW);
  }
});

test("history: daily, ascending, unique dates, both bases kept separately, missing values counted not filled", async () => {
  const { get } = setup();
  const r = await get(history("VEQT.TO", "1y"));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.schema, "md-gateway.history.v1");
  assert.equal(b.frequency, "daily");
  assert.ok(b.count > 240 && b.count < 270, String(b.count));
  const dates = b.observations.map(o => o[0]);
  assert.deepEqual(dates, [...new Set(dates)].sort());
  assert.ok(b.observations.every(([, c, a]) => (c === null || c > 0) && (a === null || a > 0)));
  assert.ok(b.missing.rowsWithoutPrices > 0, "days the source reports without a price are dropped and counted");
  assert.equal(b.adjustment.adjCloseAvailable, true);
  assert.match(b.adjustment.close, /splits, not for dividends/);
  assert.ok(b.observations.some(([, c, a]) => c !== a), "adjusted and unadjusted values are not the same series");
  const noAdj = await get(history("NOADJ", "1mo"));
  assert.equal(noAdj.status, 200);
  assert.equal(noAdj.body.adjustment.adjCloseAvailable, false);
  assert.ok(noAdj.body.observations.every(o => o[2] === null), "no adjusted closes are invented");
  const pence = await get(history("VOD.L", "1mo"));
  assert.ok(pence.body.observations.every(([, c]) => c < 2), "London history converted from pence to pounds");
});

/* ---------------- refused before any upstream request ---------------- */
test("unsupported and invalid symbols are refused without an upstream request", async () => {
  const { get, calls } = setup();
  const cases = {
    "^GSPC": "unsupported_listing", "CAD=X": "unsupported_listing", "CL=F": "unsupported_listing", "RELIANCE.BO": "unsupported_listing", "ABC.MX": "unsupported_listing",
    aapl: "invalid_symbol", "AAPL/../X": "invalid_symbol", "A B": "invalid_symbol", "AAPL.TO.L": "invalid_symbol", "": "invalid_symbol", "ABCDEFGHIJKLMNOPQRSTU": "invalid_symbol",
    "-AAPL": "invalid_symbol", ".TO": "invalid_symbol", "AAPL%2F": "invalid_symbol", "https://evil.example/x": "invalid_symbol",
  };
  for (const [symbol, code] of Object.entries(cases)) {
    const r = await get(quote(symbol));
    assert.equal(r.body.error.code, code, symbol);
    assert.equal(r.status, 400, symbol);
    assert.equal(r.body.error.definitive, true);
  }
  assert.equal(calls.length, 0);
  assert.equal(parseSymbol("BRK-B").mic, "US");
  assert.equal(parseSymbol("DLR-U.TO").mic, "XTSE");
});

test("query validation: only the listed parameters, each once; ranges and intervals allowlisted", async () => {
  const { get, calls } = setup();
  const bad = [
    "/v1/quote", "/v1/quote?symbol=AAPL&symbol=MSFT", "/v1/quote?symbol=AAPL&range=1y", "/v1/quote?symbol=AAPL&shares=305", "/v1/quote?symbol=AAPL&target=63",
    "/v1/history?symbol=AAPL&range=1y", "/v1/history?symbol=AAPL&range=1y&interval=1d&account=TFSA", "/v1/health?x=1",
  ];
  for (const path of bad) assert.equal((await get(path)).body.error.code, "invalid_request", path);
  for (const path of [history("AAPL", "10y"), history("AAPL", "max"), "/v1/history?symbol=AAPL&range=1y&interval=1wk", "/v1/history?symbol=AAPL&range=1y&interval=1m"]) {
    assert.equal((await get(path)).body.error.code, "invalid_range", path);
  }
  assert.equal((await get(`/v1/quote?symbol=${"A".repeat(300)}`)).body.error.code, "invalid_request", "URL length bounded");
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(HISTORY_RANGES), ["1mo", "3mo", "6mo", "1y", "2y", "5y"]);
});

/* ---------------- upstream answers that are refused ---------------- */
test("mismatched, malformed and invalid upstream answers are refused (fail closed), never substituted", async () => {
  const { get } = setup();
  const cases = [
    [quote("OTCX"), 422, "listing_mismatch"], [quote("WRONGSYM"), 422, "listing_mismatch"], [quote("BADCUR.DE"), 422, "currency_mismatch"],
    [quote("IDXETF"), 422, "unsupported_instrument"], [quote("NOPRICE"), 422, "no_price"], [quote("ZZZQ"), 404, "symbol_not_found"],
    [history("NEGHIST", "1mo"), 502, "upstream_invalid"], [quote("BADJSON"), 502, "upstream_invalid"],
  ];
  for (const [path, status, code] of cases) {
    const r = await get(path, { ip: path });
    assert.equal(r.status, status, path);
    assert.equal(r.body.error.code, code, path);
    assert.equal(r.body.price, undefined);
    assert.ok(!/query1|finance\.yahoo|<html/i.test(JSON.stringify(r.body)), "fixed messages only, never upstream text or URLs");
  }
  for (const [flag, status, code] of [["huge", 502, "upstream_invalid"], ["redirect", 502, "upstream_invalid"], ["limited", 429, "upstream_rate_limited"], ["blocked", 502, "upstream_blocked"], ["down", 502, "upstream_unavailable"], ["networkError", 502, "upstream_unavailable"]]) {
    const { get: g } = setup({ mode: { [flag]: true } });
    const r = await g(quote("AAPL"));
    assert.equal(r.status, status, flag);
    assert.equal(r.body.error.code, code, flag);
    if (code === "upstream_rate_limited") assert.equal(r.headers["retry-after"], "300");
  }
});

test("upstream timeout: bounded, reported as upstream_timeout", async () => {
  const { get } = setup({ mode: { hang: true }, limits: { upstreamTimeoutMs: 30 } });
  const r = await get(quote("AAPL"));
  assert.equal(r.status, 504);
  assert.equal(r.body.error.code, "upstream_timeout");
  assert.equal(r.body.error.retryable, true);
  assert.equal(LIMITS.upstreamTimeoutMs, 8000);
});

/* ---------------- CORS and methods ---------------- */
test("CORS: only allowed origins; preflight for GET only; other methods and plain HTTP refused", async () => {
  const { get, calls } = setup();
  const ok = await get(quote("AAPL"));
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(ok.headers.vary, "Origin");
  assert.equal(ok.headers["cache-control"], "no-store");
  for (const origin of ["https://evil.example", "https://elmatthe.github.io.evil.example", "null", null]) {
    const r = await get(quote("AAPL"), { origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.body.error.code, "origin_not_allowed");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
  const pre = await get(quote("AAPL"), { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-methods"], "GET");
  assert.equal((await get(quote("AAPL"), { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } })).status, 403);
  assert.equal((await get(quote("AAPL"), { method: "OPTIONS", origin: "https://evil.example", headers: { "Access-Control-Request-Method": "GET" } })).status, 403);
  assert.equal((await get(quote("AAPL"), { method: "DELETE" })).body.error.code, "method_not_allowed");
  assert.equal((await get("/v1/anything")).body.error.code, "not_found");
  const plain = await setup().gw.handle(new Request("http://gw.example/v1/quote?symbol=AAPL", { headers: { Origin: ORIGIN } }), ON);
  assert.equal(plain.status, 403);
  assert.equal(calls.length, 1, "only the first, allowed request reached the source");
  assert.deepEqual([...parseOrigins("https://elmatthe.github.io, http://127.0.0.1:4000, http://evil.example, https://a.example/path, https://u:p@b.example")], ["https://elmatthe.github.io", "http://127.0.0.1:4000"]);
});

/* ---------------- rate limits ---------------- */
test("per-client limit in each isolate, the client-limit binding, and fail-closed binding errors", async () => {
  const { get, advance } = setup();
  for (let i = 0; i < LIMITS.perClientPerMinute; i += 1) assert.equal((await get(quote("AAPL"))).status, 200, `request ${i + 1}`);
  const over = await get(quote("AAPL"));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "rate_limited");
  assert.equal(over.headers["retry-after"], "60");
  assert.equal((await get(quote("AAPL"), { ip: "198.51.100.8" })).status, 200, "another client is not affected");
  advance(60000);
  assert.equal((await get(quote("AAPL"))).status, 200, "the window resets after a minute");

  const denied = setup({ env: { ...ON, RATE_LIMITER: { limit: async () => ({ success: false }) } } });
  assert.equal((await denied.get(quote("AAPL"))).body.error.code, "rate_limited");
  assert.equal(denied.calls.length, 0);
  const broken = setup({ env: { ...ON, RATE_LIMITER: { limit: async () => { throw new Error("binding down"); } } } });
  assert.equal((await broken.get(quote("AAPL"))).body.error.code, "busy", "a failing limiter fails closed");
  assert.equal(broken.calls.length, 0);
});

test("upstream budget: the shared limit stops new upstream requests but cached answers are still served", async () => {
  const { get, calls } = setup({ limits: { upstreamPerMinute: 2 } });
  assert.equal((await get(quote("AAPL"), { ip: "1" })).status, 200);
  assert.equal((await get(quote("MSFT"), { ip: "2" })).status, 200);
  const third = await get(quote("SPY"), { ip: "3" });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, "throttled");
  assert.equal(calls.length, 2);
  const cached = await get(quote("AAPL"), { ip: "4" });
  assert.equal(cached.status, 200);
  assert.equal(cached.body.cache.status, "hit");
  const binding = setup({ env: { ...ON, UPSTREAM_LIMITER: { limit: async ({ key }) => ({ success: key !== "yahoo-chart" }) } } });
  assert.equal((await binding.get(quote("AAPL"))).body.error.code, "throttled");
  assert.equal(binding.calls.length, 0);
});

/* ---------------- caching ---------------- */
test("cache: hits are labelled with their age and keep the original retrieval time; entries expire", async () => {
  const { get, calls, advance } = setup();
  const first = await get(quote("SAP.DE"));
  advance(120000);
  const second = await get(quote("SAP.DE"));
  assert.equal(calls.length, 1);
  assert.equal(second.body.cache.status, "hit");
  assert.equal(second.body.cache.ageSeconds, 120);
  assert.equal(second.body.cache.ttlSeconds, CACHE_TTL_SECONDS.quote);
  assert.equal(second.body.retrievedAt, first.body.retrievedAt, "a cached answer is never presented as newly retrieved");
  advance((CACHE_TTL_SECONDS.quote - 120) * 1000 + 1000);
  const third = await get(quote("SAP.DE"));
  assert.equal(third.body.cache.status, "miss");
  assert.equal(calls.length, 2, "expired entries are fetched again");
  await get(history("SAP.DE", "1y"));
  advance(3600000);
  assert.equal((await get(history("SAP.DE", "1y"))).body.cache.status, "hit");
  assert.equal((await get(history("SAP.DE", "2y"))).body.cache.status, "miss", "each range is its own entry");
});

test("Cache API: shared across isolates through caches.default, expiry enforced, failures are misses", async () => {
  const store = new Map();
  const deleted = [];
  const fake = {
    match: async key => (store.has(key) ? new Response(store.get(key)) : undefined),
    put: async (key, response) => { store.set(key, await response.text()); },
    delete: async key => { deleted.push(key); return store.delete(key); },
  };
  const a = setup({ cache: fake });
  await a.get(quote("7203.T"));
  assert.equal(store.size, 1);
  assert.match([...store.keys()][0], /^https:\/\/market-data-gateway\.example\.workers\.dev\/__cache\/yahoo-chart\//);
  const b = setup({ cache: fake }); // a fresh isolate: empty memory, same data-center cache
  const hit = await b.get(quote("7203.T"));
  assert.equal(hit.body.cache.status, "hit");
  assert.equal(b.calls.length, 0);
  const c = setup({ cache: fake });
  c.advance((CACHE_TTL_SECONDS.quote + 5) * 1000);
  assert.equal((await c.get(quote("7203.T"))).body.cache.status, "miss");
  assert.equal(deleted.length, 1);
  const broken = setup({ cache: { match: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); }, delete: async () => true } });
  assert.equal((await broken.get(quote("AAPL"))).status, 200, "a cache failure never fails the request");
});

/* ---------------- privacy ---------------- */
test("logs and answers never contain client addresses, upstream URLs or request headers", async () => {
  const mode = { down: true };
  const { get, logs } = setup({ mode });
  await get(quote("AAPL"), { ip: "192.0.2.55", headers: { Cookie: "a=b" } });
  mode.down = false;
  await get(quote("OTCX"), { ip: "192.0.2.55" });
  const text = logs.join("\n");
  assert.equal(logs.length, 2);
  assert.ok(!/192\.0\.2\.55|query1|finance\.yahoo|a=b/.test(text), text);
});
