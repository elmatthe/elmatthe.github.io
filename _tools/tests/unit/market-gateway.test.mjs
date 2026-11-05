// Market-data gateway (Cloudflare Worker) tests: activation gate, allowlists, schema and
// value checks, CORS, rate limits, caching and failure handling. The Worker module runs
// unchanged in Node 22 (Request, Response, crypto.subtle); Yahoo Finance is replaced by
// the synthetic fixtures in ../fixtures/yahoo-chart.mjs, so nothing leaves this process.
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, sourceState, parseOrigins, LIMITS, CACHE_TTL_SECONDS, COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, OWNER_ATTESTATION_VALUE } from "../../../_services/market-data-gateway/src/gateway.js";
import { VENUES, parseSymbol } from "../../../_services/market-data-gateway/src/venues.js";
import { chartUrl, HISTORY_RANGES } from "../../../_services/market-data-gateway/src/yahoo-chart.js";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { localCoordinator } from "../fixtures/local-coordinator.mjs";
import { KEYLESS_VENUES } from "../../../assets/js/market-data/keyless.js";

const ORIGIN = "https://elmatthe.github.io";
const BASE = "https://market-data-gateway.example.workers.dev";
const NOW = Date.parse("2026-11-03T15:00:00Z"); // a Tuesday
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:4000` };

// Upstream spacing is switched off here unless a test asks for it (`spaced`): it has its
// own tests below. `sleep` advances the fake clock, so waits take no real time.
function setup({ mode = {}, env = ON, cache = null, limits = {}, spaced = false, sleepAdvancesClock = true } = {}) {
  let t = NOW;
  const calls = [];
  const logs = [];
  const sleeps = [];
  const upstream = yahooFetch({ now: () => t, mode });
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init, at: t }); return upstream(url, init); };
  const sleep = async ms => { sleeps.push(ms); if (sleepAdvancesClock) t += ms; };
  const applied = spaced ? limits : { upstreamMinSpacingMs: 0, ...limits };
  const log = e => logs.push(JSON.stringify(e));
  const coordinator = localCoordinator({ fetchImpl, now: () => t, sleep, log, limits: applied });
  const gw = createGateway({ now: () => t, log, cache, limits: applied });
  const get = async (path, { origin = ORIGIN, ip = "198.51.100.7", method = "GET", headers = {}, e = env } = {}) => {
    const r = await gw.handle(new Request(`${BASE}${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": ip, ...headers } }), { UPSTREAM_COORDINATOR: coordinator, ...e });
    const text = await r.text();
    return { status: r.status, headers: Object.fromEntries(r.headers), body: text ? JSON.parse(text) : null };
  };
  return { gw, get, calls, logs, sleeps, coordinator, advance: ms => { t += ms; }, now: () => t };
}
const quote = s => `/v1/quote?symbol=${encodeURIComponent(s)}`;
const history = (s, range = "1y") => `/v1/history?symbol=${encodeURIComponent(s)}&range=${range}&interval=1d`;

/* ---------------- activation gate ---------------- */
test("off by default: the source runs only with KEYLESS_SOURCE and the exact owner attestation", async () => {
  const envs = [
    {}, { KEYLESS_SOURCE: "" }, { KEYLESS_SOURCE: "off" }, { KEYLESS_SOURCE: "yahoo-chart" },
    { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "   " }, { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "true" },
    { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "yes" }, { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "Owner-Confirms-Yahoo-Permission" },
    // The previous document-reference setting no longer switches anything on.
    { KEYLESS_SOURCE: "yahoo-chart", SOURCE_AUTHORIZATION: "letter on file" },
    { KEYLESS_SOURCE: "stooq", OWNER_ATTESTATION: OWNER_ATTESTATION_VALUE },
  ];
  for (const env of envs) {
    const { get, calls } = setup({ env: { ...env, ALLOWED_ORIGINS: ORIGIN } });
    const h = await get("/v1/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.keyless.enabled, false, JSON.stringify(env));
    assert.equal(h.body.keyless.activation, null);
    assert.ok(h.body.keyless.reason.length > 20);
    for (const path of [quote("AAPL"), history("AAPL")]) {
      const r = await get(path, { e: { ...env, ALLOWED_ORIGINS: ORIGIN } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, "source_disabled");
      assert.equal(r.body.error.retryable, false);
    }
    assert.equal(calls.length, 0, "no request reaches the data source while the source is off");
  }
  assert.match(sourceState({ KEYLESS_SOURCE: "yahoo-chart" }).reason, /has not activated it/);
  assert.equal(sourceState(ON).enabled, true);
  assert.equal(sourceState(ON).activation, "owner_attestation");
  assert.equal(OWNER_ATTESTATION_VALUE, "owner-confirms-yahoo-permission");
});

test("wrangler.toml: fresh top-level settings are off; only [env.production] carries the owner's activation", async () => {
  const { readFile } = await import("node:fs/promises");
  // A Windows checkout may hold this file with CRLF line endings.
  const toml = (await readFile(new URL("../../../_services/market-data-gateway/wrangler.toml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const split = toml.indexOf("\n[env.production]\n");
  assert.ok(split > 0);
  const top = toml.slice(0, split);
  const prod = toml.slice(split);
  assert.match(top, /^KEYLESS_SOURCE = ""$/m);
  assert.match(top, /^OWNER_ATTESTATION = ""$/m);
  assert.match(top, /^ALLOW_NO_ORIGIN = "false"$/m);
  assert.match(prod, /^name = "market-data-gateway"$/m);
  assert.match(prod, /^KEYLESS_SOURCE = "yahoo-chart"$/m);
  assert.match(prod, new RegExp(`^OWNER_ATTESTATION = "${OWNER_ATTESTATION_VALUE}"$`, "m"));
  assert.match(prod, /^ALLOWED_ORIGINS = "https:\/\/elmatthe\.github\.io"$/m);
  assert.equal((prod.match(/\[\[env\.production\.ratelimits\]\]/g) || []).length, 1, "the client-limit binding repeated (not inherited)");
  assert.doesNotMatch(toml.replace(/^#.*$/gm, ""), /UPSTREAM_LIMITER/, "the coordinator's global budget replaced the per-location one");
  assert.ok(!/SOURCE_AUTHORIZATION|letter|correspondence|grant number/i.test(toml.replace(/^#.*$/gm, "")), "no authorization document or reference in the settings");
  assert.ok(!/kv_namespaces|d1_databases|r2_buckets|queues|usage_model|new_classes|legacy-kv/.test(toml.replace(/^#.*$/gm, "")), "no paid product, and no storage but the SQLite-backed coordinator");
});

test("health: no secrets; reports activation, upstream state and limits", async () => {
  const { get } = setup({ env: { ...ON, SOURCE_AUTHORIZATION: "Agreement REF-123 kept in owner files" }, spaced: true });
  const h = await get("/v1/health", { origin: null });
  assert.equal(h.status, 200);
  assert.equal(h.headers["access-control-allow-origin"], undefined, "no CORS grant without an allowed origin");
  assert.deepEqual(h.body.keyless, { enabled: true, source: "yahoo-chart", reason: null, activation: "owner_attestation", provider: "Yahoo Finance", attribution: h.body.keyless.attribution, official: false });
  assert.deepEqual(h.body.upstream, { state: "ok", code: null, retryAfterSeconds: 0 });
  assert.ok(!JSON.stringify(h.body).includes("REF-123"));
  assert.ok(!JSON.stringify(h.body).includes(OWNER_ATTESTATION_VALUE), "the attestation value is not echoed");
  assert.deepEqual(h.body.history, { ranges: ["1mo", "3mo", "6mo", "1y", "2y", "5y"], intervals: ["1d"] });
  assert.equal(h.body.limits.upstreamMinSpacingMs, LIMITS.upstreamMinSpacingMs);
  assert.deepEqual(h.body.cacheTtlSeconds, CACHE_TTL_SECONDS);
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
    if (code === "upstream_rate_limited") assert.equal(r.headers["retry-after"], String(COOLDOWN_SECONDS.upstream_rate_limited), "the cooldown that starts is announced");
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

/* ---------------- protecting the data source ---------------- */
test("spacing: upstream requests start at least upstreamMinSpacingMs apart; a queue longer than 15 s is refused (throttled)", async () => {
  const { get, calls } = setup({ spaced: true });
  const symbols = ["AAPL", "MSFT", "SPY", "VEQT.TO", "SAP.DE"];
  for (const [i, s] of symbols.entries()) assert.equal((await get(quote(s), { ip: `10.0.0.${i}` })).status, 200, s);
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  assert.ok(gaps.every(g => g >= LIMITS.upstreamMinSpacingMs), `gaps ${gaps.join(",")}`);
  assert.equal(LIMITS.upstreamMinSpacingMs, 1000);

  // Many different symbols at once: the ones that would wait more than 15 s are refused.
  // The clock does not move while they wait, so every request sees the whole queue.
  const burst = setup({ spaced: true, limits: { upstreamPerMinute: 100 }, sleepAdvancesClock: false });
  const many = Array.from({ length: 20 }, (_, i) => `T${String.fromCharCode(65 + i)}X`);
  const answers = await Promise.all(many.map((s, i) => burst.get(quote(s), { ip: `10.1.0.${i}` })));
  const throttled = answers.filter(a => a.body.error?.code === "throttled");
  assert.ok(throttled.length >= 1, "a long queue is cut off");
  assert.ok(burst.calls.length <= Math.floor(LIMITS.upstreamQueueMaxWaitMs / LIMITS.upstreamMinSpacingMs) + 1, `upstream calls ${burst.calls.length}`);
  assert.ok(throttled.every(a => a.status === 429 && a.headers["retry-after"]));
});

test("coalescing: identical concurrent requests send one upstream request", async () => {
  const { get, calls } = setup();
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => get(quote("VOD.L"), { ip: `10.2.0.${i}` })));
  assert.ok(answers.every(a => a.status === 200));
  assert.equal(calls.length, 1);
  assert.equal(answers.filter(a => a.body.cache.status === "miss").length, 1);
  assert.ok(answers.every(a => a.body.price === answers[0].body.price && a.body.retrievedAt === answers[0].body.retrievedAt));
});

test("definitive refusals are remembered (no repeated upstream request for an unknown or mismatched listing)", async () => {
  const { get, calls, advance } = setup();
  for (const s of ["ZZZQ", "OTCX", "BADCUR.DE"]) {
    const a = await get(quote(s));
    const b = await get(quote(s), { ip: "10.3.0.1" });
    assert.equal(a.body.error.code, b.body.error.code, s);
    assert.equal(b.body.error.definitive, true);
  }
  assert.equal(calls.length, 3, "one upstream request per listing");
  advance((CACHE_TTL_SECONDS.refusal + 1) * 1000);
  await get(quote("ZZZQ"));
  assert.equal(calls.length, 4, "the refusal expires");
  // Transient failures are never remembered as refusals.
  const mode = { down: true };
  const t = setup({ mode });
  await t.get(quote("AAPL"));
  mode.down = false;
  assert.equal((await t.get(quote("AAPL"))).status, 200);
});

test("circuit breaker: after HTTP 429 the data source is not contacted for 15 minutes; cached answers still served", async () => {
  const mode = {};
  const { get, calls, advance, logs } = setup({ mode });
  assert.equal((await get(quote("AAPL"))).status, 200);
  mode.limited = true;
  const first = await get(quote("MSFT"));
  assert.equal(first.status, 429);
  assert.equal(first.body.error.code, "upstream_rate_limited");
  assert.equal(first.headers["retry-after"], String(COOLDOWN_SECONDS.upstream_rate_limited));
  mode.limited = false; // even if Yahoo would answer again, nothing is sent during the cooldown
  const before = calls.length;
  for (const s of ["SPY", "VEQT.TO", "SAP.DE"]) {
    const r = await get(quote(s), { ip: s });
    assert.equal(r.body.error.code, "upstream_rate_limited", s);
    assert.ok(Number(r.headers["retry-after"]) > 0 && Number(r.headers["retry-after"]) <= COOLDOWN_SECONDS.upstream_rate_limited);
  }
  assert.equal((await get(quote("AAPL"), { ip: "cached" })).body.cache.status, "hit", "cached answers are still served");
  assert.equal(calls.length, before, "no upstream request during the cooldown");
  const h = await get("/v1/health");
  assert.equal(h.body.upstream.state, "cooling_down");
  assert.equal(h.body.upstream.code, "upstream_rate_limited");
  advance(COOLDOWN_SECONDS.upstream_rate_limited * 1000 + 1000);
  assert.equal((await get(quote("SPY"), { ip: "later" })).status, 200, "requests resume after the cooldown");
  assert.equal(calls.length, before + 1);
  assert.ok(logs.some(l => /cooldown_started/.test(l)));
});

test("circuit breaker: HTTP 403 stops upstream requests for 30 minutes; three consecutive 5xx for 2 minutes", async () => {
  const blockedMode = { blocked: true };
  const b = setup({ mode: blockedMode });
  assert.equal((await b.get(quote("AAPL"))).body.error.code, "upstream_blocked");
  blockedMode.blocked = false;
  const again = await b.get(quote("MSFT"));
  assert.equal(again.body.error.code, "upstream_blocked");
  assert.equal(again.headers["retry-after"], String(COOLDOWN_SECONDS.upstream_blocked));
  assert.equal(b.calls.length, 1);
  b.advance(COOLDOWN_SECONDS.upstream_blocked * 1000 + 1);
  assert.equal((await b.get(quote("MSFT"))).status, 200);

  const downMode = { down: true };
  const d = setup({ mode: downMode });
  for (let i = 0; i < 3; i += 1) assert.equal((await d.get(quote(["AAPL", "MSFT", "SPY"][i]))).body.error.code, "upstream_unavailable");
  downMode.down = false;
  const cooling = await d.get(quote("VST"));
  assert.equal(cooling.body.error.code, "upstream_unavailable");
  assert.equal(cooling.headers["retry-after"], String(COOLDOWN_SECONDS.upstream_unavailable));
  assert.equal(d.calls.length, 3);
  d.advance(COOLDOWN_SECONDS.upstream_unavailable * 1000 + 1);
  assert.equal((await d.get(quote("VST"))).status, 200);

  // Two failures then a success do not start a cooldown.
  const m = { down: true };
  const e = setup({ mode: m });
  await e.get(quote("AAPL"));
  await e.get(quote("MSFT"));
  m.down = false;
  assert.equal((await e.get(quote("SPY"))).status, 200);
  m.down = true;
  await e.get(quote("VST"));
  m.down = false;
  assert.equal((await e.get(quote("BRK-B"))).status, 200, "the failure count restarts after a success");
});

test("clients without an Origin header (desktop apps) only when ALLOW_NO_ORIGIN is true; unlisted origins always refused", async () => {
  const off = setup();
  assert.equal((await off.get(quote("AAPL"), { origin: null })).body.error.code, "origin_not_allowed");
  const on = setup({ env: { ...ON, ALLOW_NO_ORIGIN: "true" } });
  const r = await on.get(quote("AAPL"), { origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], undefined, "no CORS grant is given to a client without an Origin");
  for (const origin of ["https://evil.example", "null", "http://127.0.0.2:4000"]) {
    assert.equal((await on.get(quote("AAPL"), { origin, ip: origin || "empty" })).body.error.code, "origin_not_allowed", JSON.stringify(origin));
  }
  // The same limits apply to them.
  for (let i = 0; i < LIMITS.perClientPerMinute; i += 1) await on.get(quote("MSFT"), { origin: null, ip: "203.0.113.200" });
  assert.equal((await on.get(quote("MSFT"), { origin: null, ip: "203.0.113.200" })).body.error.code, "rate_limited");
});

test("no credentials or holdings: the upstream request carries only the symbol; client query extras are refused", async () => {
  const { get, calls } = setup();
  for (const extra of ["apikey=SECRETKEY123", "token=abc", "shares=10", "account=TFSA", "target=5"]) {
    assert.equal((await get(`/v1/quote?symbol=AAPL&${extra}`)).body.error.code, "invalid_request", extra);
  }
  await get(quote("AAPL"), { headers: { Authorization: "Bearer SECRETKEY123", "X-Api-Key": "SECRETKEY123" } });
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes("SECRETKEY123"));
});

/* ---------------- B2: actual upstream starts, hard queue expiry, cancellation ---------------- */
// A virtual clock: a timer fires only when the test moves time past it, in time order.
function virtualClock(start = NOW) {
  let t = start;
  const timers = [];
  const turn = () => new Promise(resolve => setTimeout(resolve, 1));
  const clock = {
    now: () => t,
    pending: () => timers.length,
    sleep: ms => new Promise(resolve => { timers.push({ at: t + Math.max(0, ms), resolve }); }),
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        await turn();
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > target) break;
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      t = target;
      await turn();
    },
  };
  return clock;
}
// Waits (in real time, briefly) for something the gateway does asynchronously.
async function until(condition, label) {
  const giveUp = Date.now() + 3000;
  while (Date.now() < giveUp) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(condition(), `timed out waiting for: ${label}`);
}
// A gateway whose upstream answers only when the test releases each request.
function heldGateway({ limits = {}, env = ON, cache = null, ignoreAbort = false } = {}) {
  const clock = virtualClock();
  const held = [];
  const starts = [];
  let inFlight = 0;
  let peak = 0;
  const answer = yahooFetch({ now: clock.now });
  const fetchImpl = async (url, init) => {
    const symbol = decodeURIComponent(new URL(String(url)).pathname.split("/").pop());
    starts.push({ at: clock.now() - NOW, symbol });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await new Promise((resolve, reject) => {
        held.push({ symbol, resolve, reject, ok: () => resolve(answer(url, init)), status: (status, headers = {}) => resolve(new Response("x", { status, headers })) });
        if (!ignoreAbort) init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    } finally { inFlight -= 1; }
  };
  const applied = { upstreamTimeoutMs: 600000, ...limits };
  const coordinator = localCoordinator({ fetchImpl, now: clock.now, sleep: clock.sleep, limits: applied });
  const bound = { UPSTREAM_COORDINATOR: coordinator, ...env };
  const gw = createGateway({ now: clock.now, log: () => {}, cache, limits: applied });
  let client = 0;
  const ask = (symbol, { signal, ctx } = {}) => {
    client += 1;
    return gw.handle(new Request(`${BASE}${quote(symbol)}`, { signal, headers: { Origin: ORIGIN, "CF-Connecting-IP": `10.50.0.${client}` } }), bound, ctx);
  };
  // Requests started together can reach the coordinator in any order: the Worker hashes the client
  // address first, asynchronously. This makes the order definite, so that an assertion about first
  // come first served means what it says.
  const askAll = async symbols => {
    const answers = [];
    for (const symbol of symbols) {
      const before = coordinator.arrivals.length;
      answers.push(ask(symbol));
      await until(() => coordinator.arrivals.length > before, `${symbol} reaches the coordinator`);
    }
    return answers;
  };
  return { clock, held, starts, ask, askAll, gw, bound, coordinator, peak: () => peak };
}
const gaps = starts => starts.slice(1).map((s, i) => s.at - starts[i].at);

test("B2: requests released together never start together: actual starts stay 1 s apart (was [0, 1000, 7000, 7000])", async () => {
  const { clock, held, starts, askAll, peak } = heldGateway();
  const answers = await askAll(["AAPL", "MSFT", "SPY", "VST"]);
  await until(() => starts.length === 1, "first start");
  assert.equal(starts[0].at, 0);
  await clock.advance(1000);
  await until(() => starts.length === 2, "second start");
  assert.equal(starts[1].at, 1000);
  await clock.advance(6000); // t = 7000: two in flight, two waiting past their reserved turns
  assert.equal(starts.length, 2, "nothing starts while both places are taken");
  held.splice(0).forEach(h => h.ok()); // both places free up at the same instant
  await Promise.all(answers.slice(0, 2));
  await clock.advance(LIMITS.upstreamQueuePollMs);
  assert.ok(starts.length <= 3, `at most one request may start at that moment; starts ${JSON.stringify(starts)}`);
  await clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  await until(() => starts.length === 4, "all four started");
  assert.ok(starts[2].at >= 7000, JSON.stringify(starts));
  assert.ok(starts[2].at <= 7000 + LIMITS.upstreamQueuePollMs, `prompt after capacity frees up: ${JSON.stringify(starts)}`);
  assert.ok(gaps(starts).every(g => g >= LIMITS.upstreamMinSpacingMs), `gaps ${gaps(starts).join(",")}`);
  assert.deepEqual(starts.map(s => s.symbol), ["AAPL", "MSFT", "SPY", "VST"], "first come, first served");
  assert.ok(peak() <= LIMITS.upstreamInFlight, `at most ${LIMITS.upstreamInFlight} in flight, saw ${peak()}`);
  held.splice(0).forEach(h => h.ok());
  assert.ok((await Promise.all(answers)).every(r => r.status === 200));
});

test("B2: many staggered completions keep spacing, the in-flight limit and order", async () => {
  const { clock, held, starts, askAll, peak } = heldGateway();
  const symbols = ["AAPL", "MSFT", "SPY", "VST", "SAP.DE", "VOD.L", "7203.T", "VEQT.TO"];
  const answers = await askAll(symbols);
  await until(() => starts.length === 1, "first start");
  for (let round = 0; round < 40 && starts.length < symbols.length; round += 1) {
    await clock.advance(700);
    held.splice(0, round % 3 === 0 ? 2 : 1).forEach(h => h.ok()); // sometimes two free up together
  }
  await until(() => starts.length === symbols.length, "all started");
  held.splice(0).forEach(h => h.ok());
  await clock.advance(10);
  assert.ok(gaps(starts).every(g => g >= LIMITS.upstreamMinSpacingMs), `gaps ${gaps(starts).join(",")}`);
  assert.deepEqual(starts.map(s => s.symbol), symbols);
  assert.ok(peak() <= LIMITS.upstreamInFlight);
  assert.ok((await Promise.all(answers)).every(r => r.status === 200));
});

test("B2: a request waits at most 15 s for capacity, then is refused and never sent", async () => {
  const { clock, held, starts, ask, askAll } = heldGateway();
  const first = await askAll(["AAPL", "MSFT"]);
  await until(() => starts.length === 1, "first start");
  await clock.advance(1000);
  await until(() => starts.length === 2, "second start");
  let settled = null;
  const queued = ask("SPY").then(r => { settled = r; return r; });
  await until(() => clock.pending() > 0, "the third request is waiting");
  await clock.advance(LIMITS.upstreamQueueMaxWaitMs - 1);
  assert.equal(settled, null, "still within its 15 s");
  await clock.advance(2);
  await until(() => settled !== null, "the wait to end at 15 s");
  assert.equal(settled.status, 429);
  const body = JSON.parse(await settled.text());
  assert.equal(body.error.code, "throttled");
  assert.ok(Number(settled.headers.get("retry-after")) > 0);
  assert.equal(starts.length, 2, "the refused request reached no one");
  await queued;
  held.splice(0).forEach(h => h.ok());
  assert.ok((await Promise.all(first)).every(r => r.status === 200));
  await clock.advance(LIMITS.upstreamMinSpacingMs);
  const later = ask("VST");
  await until(() => starts.length === 3, "capacity is usable again after an expiry");
  held.splice(0).forEach(h => h.ok());
  assert.equal((await later).status, 200);
});

test("B2: failed upstream requests give their place back", async () => {
  const { clock, held, starts, askAll } = heldGateway({ limits: { upstreamInFlight: 1, upstreamMinSpacingMs: 100 } });
  const [a, b] = await askAll(["AAPL", "MSFT"]);
  await until(() => starts.length === 1, "first start");
  held.shift().reject(new TypeError("fetch failed"));
  assert.equal((await a).status, 502);
  await clock.advance(500);
  await until(() => starts.length === 2, "the next request starts after a failure");
  held.shift().ok();
  assert.equal((await b).status, 200);
});

test("B2: a place held by a request that can never finish (its context ended) is reclaimed", async () => {
  const { clock, starts, ask, held } = heldGateway({ limits: { upstreamInFlight: 1, upstreamMinSpacingMs: 100, upstreamTimeoutMs: 1000 }, ignoreAbort: true });
  const stuck = new AbortController(); // ended below, so its real-time watchdog ends
  const never = ask("AAPL", { signal: stuck.signal }); // never answered
  await until(() => starts.length === 1, "first start");
  held.shift(); // nothing will ever settle this request, and it ignores its abort
  assert.equal(clock.pending(), 0);
  await clock.advance(LIMITS.upstreamQueueMaxWaitMs - 1000);
  const next = ask("MSFT");
  await until(() => starts.length === 2, "the lost place to be reclaimed");
  held.shift().ok();
  assert.equal((await next).status, 200);
  stuck.abort();
  assert.equal((await never).status, 499);
});

test("B2: a client that goes away while queued leaves the queue at once; no upstream request is sent for it", async () => {
  const { clock, held, starts, ask, askAll } = heldGateway();
  const first = await askAll(["AAPL", "MSFT"]);
  await until(() => starts.length === 1, "first start");
  await clock.advance(1000);
  await until(() => starts.length === 2, "second start");
  const gone = new AbortController();
  let settled = null;
  ask("SPY", { signal: gone.signal }).then(r => { settled = r; });
  const stays = ask("VST");
  await until(() => clock.pending() >= 2, "both are waiting");
  gone.abort();
  await until(() => settled !== null, "the cancelled request to end");
  assert.equal(settled.status, 499);
  assert.equal(JSON.parse(await settled.text()).error.code, "cancelled");
  held.splice(0).forEach(h => h.ok());
  await clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  await until(() => starts.length === 3, "the next in line starts");
  assert.deepEqual(starts.map(s => s.symbol), ["AAPL", "MSFT", "VST"], "the cancelled request reached no one");
  held.splice(0).forEach(h => h.ok());
  assert.equal((await stays).status, 200);
  await Promise.all(first);
});

test("B2: shared (coalesced) work is cancelled only when every client has gone; an in-flight request is aborted without counting as an outage", async () => {
  const { clock, held, starts, ask, askAll, gw, bound } = heldGateway();
  const blockers = await askAll(["AAPL", "MSFT"]);
  await until(() => starts.length === 1, "first start");
  await clock.advance(1000);
  await until(() => starts.length === 2, "second start");
  const a = new AbortController();
  const b = new AbortController();
  let aDone = null;
  ask("SPY", { signal: a.signal }).then(r => { aDone = r; });
  const stays = ask("SPY", { signal: b.signal });
  await until(() => clock.pending() > 0, "SPY is waiting");
  a.abort();
  await until(() => aDone !== null, "the first client to end");
  held.splice(0).forEach(h => h.ok());
  await clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  await until(() => starts.length === 3, "SPY still starts for the client that stayed");
  held.shift().ok();
  assert.equal((await stays).status, 200);
  await Promise.all(blockers);

  // Everyone leaves an in-flight request: it is aborted and the source is not blamed.
  await clock.advance(LIMITS.upstreamMinSpacingMs);
  for (let i = 0; i < 4; i += 1) {
    const c = new AbortController();
    const r = ask(["VST", "SAP.DE", "VOD.L", "7203.T"][i], { signal: c.signal });
    await clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
    await until(() => starts.length === 4 + i, "in-flight");
    c.abort();
    assert.equal((await r).status, 499);
  }
  const h = await gw.handle(new Request(`${BASE}/v1/health`, { headers: { Origin: ORIGIN } }), bound);
  assert.equal((await h.json()).upstream.state, "ok", "client cancellations are not upstream failures");
});

test("B2: a cooldown that starts while requests are queued stops them; none of them is sent", async () => {
  const { clock, held, starts, ask } = heldGateway();
  const answers = ["AAPL", "MSFT", "SPY", "VST"].map(s => ask(s));
  await until(() => starts.length === 1, "first start");
  held.shift().status(429);
  await clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  const all = await Promise.all(answers);
  assert.equal(starts.length, 1, "nothing more reached the source");
  assert.ok(all.every(r => r.status === 429), JSON.stringify(all.map(r => r.status)));
  for (const r of all) assert.ok(Number(r.headers.get("retry-after")) > 0);
});

test("B2: the upstream budget counts requests actually started, so a cancelled wait does not use it up", async () => {
  const { clock, held, starts, ask, askAll } = heldGateway({ limits: { upstreamPerMinute: 3 } });
  const blockers = await askAll(["AAPL", "MSFT"]);
  await until(() => starts.length === 1, "first start");
  await clock.advance(1000);
  await until(() => starts.length === 2, "second start");
  const gone = new AbortController();
  const cancelled = ask("SPY", { signal: gone.signal });
  await until(() => clock.pending() > 0, "waiting");
  gone.abort();
  assert.equal((await cancelled).status, 499);
  held.splice(0).forEach(h => h.ok());
  await Promise.all(blockers);
  await clock.advance(LIMITS.upstreamMinSpacingMs);
  const third = ask("VST");
  await until(() => starts.length === 3, "the third budgeted request");
  held.shift().ok();
  assert.equal((await third).status, 200, "the cancelled request did not use the budget");
  await clock.advance(LIMITS.upstreamMinSpacingMs);
  const fourth = await ask("SAP.DE");
  assert.equal(fourth.status, 429, "the budget still stops the fourth start");
  assert.equal(starts.length, 3);
});

test("B2: wrangler.toml turns on the request signal, so a client leaving really cancels its queued request", async () => {
  const { readFile } = await import("node:fs/promises");
  const toml = (await readFile(new URL("../../../_services/market-data-gateway/wrangler.toml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(toml.split("\n[env.production]\n")[0], /^compatibility_flags = \["enable_request_signal"\]$/m);
});

/* ---------------- B3: the data source's own Retry-After ---------------- */
function retryAfterSetup(extra = {}) {
  const mode = {};
  const s = setup({ mode, ...extra });
  return { ...s, mode };
}
const RA = (r, seconds) => {
  assert.equal(r.headers["retry-after"], String(seconds));
  assert.equal(r.body.error.retryAfterSeconds, seconds);
};

test("B3: 429 with Retry-After 3600 is honoured for the full hour, not 15 minutes (was a new upstream call at 901 s)", async () => {
  const { get, calls, advance, mode } = retryAfterSetup();
  mode.limited = true;
  mode.retryAfter = "3600";
  const first = await get(quote("AAPL"));
  assert.equal(first.status, 429);
  assert.equal(first.body.error.code, "upstream_rate_limited");
  RA(first, 3600);
  mode.limited = false;
  mode.retryAfter = null;
  const sent = calls.length;
  advance(901000);
  const at901 = await get(quote("MSFT"), { ip: "b" });
  assert.equal(at901.body.error.code, "upstream_rate_limited");
  RA(at901, 3600 - 901);
  assert.equal(calls.length, sent, "no upstream request at 901 s");
  const h = await get("/v1/health", { ip: "c" });
  assert.deepEqual(h.body.upstream, { state: "cooling_down", code: "upstream_rate_limited", retryAfterSeconds: 3600 - 901 });
  advance((3600 - 901) * 1000 - 1);
  RA(await get(quote("MSFT"), { ip: "d" }), 1);
  assert.equal(calls.length, sent, "still nothing 1 ms before the deadline");
  advance(1);
  assert.equal((await get(quote("MSFT"), { ip: "e" })).status, 200, "resumes exactly at the deadline");
  assert.equal(calls.length, sent + 1);
});

test("B3: 403, the HTTP-date form, and a 5xx carrying Retry-After", async () => {
  const blocked = retryAfterSetup();
  blocked.mode.blocked = true;
  blocked.mode.retryAfter = "7200";
  RA(await blocked.get(quote("AAPL")), 7200);
  blocked.mode.blocked = false;
  blocked.advance(1801000);
  assert.equal((await blocked.get(quote("AAPL"), { ip: "b" })).body.error.code, "upstream_blocked", "beyond the 30-minute minimum");
  assert.equal(blocked.calls.length, 1);

  const dated = retryAfterSetup();
  dated.mode.limited = true;
  dated.mode.retryAfter = new Date(NOW + 5400000).toUTCString();
  RA(await dated.get(quote("AAPL")), 5400);
  dated.mode.limited = false;
  dated.advance(5399000);
  RA(await dated.get(quote("MSFT"), { ip: "b" }), 1);
  dated.advance(1000);
  assert.equal((await dated.get(quote("MSFT"), { ip: "c" })).status, 200);

  // One 503 that names its own wait is honoured although three failures are not reached.
  const down = retryAfterSetup();
  down.mode.down = true;
  down.mode.retryAfter = "300";
  RA(await down.get(quote("AAPL")), 300);
  down.mode.down = false;
  down.advance(299000);
  assert.equal((await down.get(quote("MSFT"), { ip: "b" })).body.error.code, "upstream_unavailable");
  assert.equal(down.calls.length, 1);
  down.advance(1000);
  assert.equal((await down.get(quote("MSFT"), { ip: "c" })).status, 200);
});

test("B3: an invalid, negative, past or short Retry-After never shortens the minimum cooldown", async () => {
  const invalid = ["soon", "-5", "3600.5", "1e5", "+60", "", "12 34", "Tue, 99 Foo 2026 00:00:00 GMT", "Tue, 31 Feb 2026 00:00:00 GMT", "2026-11-03T16:00:00Z", new Date(NOW - 60000).toUTCString(), "0", "60"];
  for (const value of invalid) {
    const { get, calls, advance, mode } = retryAfterSetup();
    mode.limited = true;
    mode.retryAfter = value;
    RA(await get(quote("AAPL")), COOLDOWN_SECONDS.upstream_rate_limited);
    mode.limited = false;
    advance(COOLDOWN_SECONDS.upstream_rate_limited * 1000 - 1);
    assert.equal((await get(quote("MSFT"), { ip: "b" })).body.error.code, "upstream_rate_limited", JSON.stringify(value));
    assert.equal(calls.length, 1, JSON.stringify(value));
    advance(1);
    assert.equal((await get(quote("MSFT"), { ip: "c" })).status, 200, JSON.stringify(value));
  }
});

test("B3: a successful answer's Retry-After is ignored, and no client ever sees an upstream header", async () => {
  const { get, calls, mode } = retryAfterSetup();
  mode.alwaysRetryAfter = "3600";
  const ok = await get(quote("AAPL"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["retry-after"], undefined);
  assert.equal((await get(quote("MSFT"), { ip: "b" })).status, 200);
  assert.equal(calls.length, 2);
});

test("B3: concurrent refusals keep the longest deadline; repeated refusals extend it", async () => {
  const { clock, held, starts, ask } = heldGateway({ limits: { upstreamMinSpacingMs: 0 } });
  const a = ask("AAPL");
  const b = ask("MSFT");
  await until(() => starts.length === 2, "both in flight");
  held[0].status(429, { "Retry-After": "3600" });
  held[1].status(429, { "Retry-After": "60" });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 429);
  assert.equal(rb.status, 429);
  await clock.advance(1000);
  const r = await ask("SPY");
  assert.equal(r.headers.get("retry-after"), "3599", "the shorter answer does not replace the longer wait");
  assert.equal(starts.length, 2);

  const s = retryAfterSetup();
  s.mode.limited = true;
  s.mode.retryAfter = "1000";
  await s.get(quote("AAPL"));
  s.advance(1000000);
  s.mode.retryAfter = "2000";
  RA(await s.get(quote("MSFT"), { ip: "b" }), 2000);
  s.mode.limited = false;
  s.advance(1999000);
  RA(await s.get(quote("SPY"), { ip: "c" }), 1);
  assert.equal(s.calls.length, 2);
});

test("B3: a wait beyond the permitted maximum stops the source until the owner reactivates it; it is never retried early", async () => {
  assert.equal(MAX_COOLDOWN_SECONDS, 86400);
  for (const value of ["172800", "99999999999999999999999", new Date(NOW + 30 * 86400000).toUTCString()]) {
    const { get, calls, advance, mode, coordinator } = retryAfterSetup();
    mode.limited = true;
    mode.retryAfter = value;
    const first = await get(quote("AAPL"));
    assert.equal(first.body.error.code, "upstream_rate_limited", value);
    RA(first, MAX_COOLDOWN_SECONDS);
    assert.equal(first.body.error.manualReactivationRequired, true);
    mode.limited = false;
    const h = await get("/v1/health", { ip: "h" });
    assert.deepEqual(h.body.upstream, { state: "halted", code: "upstream_rate_limited", retryAfterSeconds: MAX_COOLDOWN_SECONDS, manualReactivationRequired: true });
    advance(60 * 86400000); // long after any date the source named
    RA(await get(quote("MSFT"), { ip: "b" }), MAX_COOLDOWN_SECONDS);
    assert.equal(calls.length, 1, "no automatic retry, however long it has been");
    // The owner's explicit reactivation (a new UPSTREAM_REACTIVATION_ID) clears it.
    coordinator.env.UPSTREAM_REACTIVATION_ID = "2026-11-05";
    assert.equal((await get(quote("MSFT"), { ip: "c" })).status, 200, value);
    assert.equal(calls.length, 2);
  }
  // Exactly the maximum is still an ordinary cooldown that ends by itself.
  const edge = retryAfterSetup();
  edge.mode.limited = true;
  edge.mode.retryAfter = String(MAX_COOLDOWN_SECONDS);
  RA(await edge.get(quote("AAPL")), MAX_COOLDOWN_SECONDS);
  edge.mode.limited = false;
  edge.advance(MAX_COOLDOWN_SECONDS * 1000);
  assert.equal((await edge.get(quote("MSFT"), { ip: "b" })).status, 200);
});
