// CPI FRED gateway (Cloudflare Worker) security and behaviour tests. The Worker
// module runs unchanged in Node 22 (Request, Response, fetch, crypto.subtle); FRED is
// mocked, so no request leaves this process and no real key is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, SERIES, LIMITS, redact, parseOrigins, FRED_OBSERVATIONS_URL } from "../../../_services/cpi-data-gateway/src/gateway.js";
import { FRED_SERIES } from "../../../assets/js/cpi/schema.js";

const ORIGIN = "https://elmatthe.github.io";
const KEY_A = "aaaaaaaaaa0123456789aaaaaaaaaa01";
const KEY_B = "bbbbbbbbbb0123456789bbbbbbbbbb02";
const NOW = Date.parse("2026-11-03T15:00:00Z");
const BASE = "https://cpi-data-gateway.example.workers.dev";
const env = (extra = {}) => ({ ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:4000`, DISABLED_SERIES: "", ...extra });

function fredPayload(url) {
  const u = new URL(url);
  const start = u.searchParams.get("observation_start");
  const end = u.searchParams.get("observation_end");
  const daily = SERIES[u.searchParams.get("series_id")] === "daily";
  const obs = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (daily || d.endsWith("-01")) obs.push({ realtime_start: "2026-11-03", realtime_end: "2026-11-03", date: d, value: d.endsWith("-05") ? "." : "4.33" });
  }
  return { realtime_start: "2026-11-03", realtime_end: "2026-11-03", observation_start: start, observation_end: end, units: "lin", output_type: 1, file_type: "json", order_by: "observation_date", sort_order: "asc", count: obs.length, offset: 0, limit: 100000, observations: obs };
}

function setup({ upstream, ...opts } = {}) {
  const calls = [];
  const logs = [];
  let t = NOW;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (upstream) return upstream(String(url), init, calls.length);
    return new Response(JSON.stringify(fredPayload(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const gw = createGateway({ fetchImpl, now: () => t, log: e => logs.push(JSON.stringify(e)), ...opts });
  return { gw, calls, logs, advance: ms => { t += ms; } };
}

function post(body, { origin = ORIGIN, ip = "198.51.100.7", path = "/v1/observations", headers = {}, raw = null } = {}) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": ip, ...headers },
    body: raw ?? JSON.stringify(body),
  });
}
const good = (extra = {}) => ({ series_id: "GS10", observation_start: "2024-01-01", observation_end: "2024-03-31", api_key: KEY_A, ...extra });
const read = async r => ({ status: r.status, headers: Object.fromEntries(r.headers), body: r.status === 204 ? null : await r.json() });

test("allowlist matches the browser schema: exactly the thirteen approved FRED series", () => {
  assert.deepEqual(Object.keys(SERIES), FRED_SERIES.map(c => c.sourceId));
  for (const c of FRED_SERIES) assert.equal(SERIES[c.sourceId], c.kind === "daily_eom" ? "daily" : "monthly", c.sourceId);
});

test("allowed endpoint: normalized observations, fixed upstream URL, key sent only to FRED", async () => {
  const { gw, calls } = setup();
  const r = await read(await gw.handle(post(good()), env()));
  assert.equal(r.status, 200);
  assert.equal(r.body.schema, "cpi-data-gateway.observations.v1");
  assert.deepEqual(r.body.observations, [{ date: "2024-01-01", value: "4.33" }, { date: "2024-02-01", value: "4.33" }, { date: "2024-03-01", value: "4.33" }]);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(`${u.origin}${u.pathname}`, FRED_OBSERVATIONS_URL);
  assert.deepEqual([...u.searchParams.keys()].sort(), ["api_key", "file_type", "limit", "observation_end", "observation_start", "series_id", "sort_order"]);
  assert.equal(calls[0].init.redirect, "manual", "redirects are never followed");
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["Accept", "User-Agent"], "no client header is forwarded");
  assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["set-cookie"], undefined);
  assert.ok(!JSON.stringify(r).includes(KEY_A), "the key is never returned");
});

test("daily series: missing '.' becomes null; up to ten years per request", async () => {
  const { gw } = setup();
  const r = await read(await gw.handle(post(good({ series_id: "DFF", observation_start: "2024-01-01", observation_end: "2024-01-10" })), env()));
  assert.equal(r.status, 200);
  assert.equal(r.body.observations.length, 10);
  assert.deepEqual(r.body.observations[4], { date: "2024-01-05", value: null });
  const ten = await gw.handle(post(good({ series_id: "DFF", observation_start: "2014-11-01", observation_end: "2024-10-31" })), env());
  assert.equal(ten.status, 200);
  const long = await read(await gw.handle(post(good({ series_id: "DFF", observation_start: "2010-01-01", observation_end: "2024-12-31" })), env()));
  assert.deepEqual([long.status, long.body.error.code], [400, "range_too_large"]);
});

test("rejected: unknown endpoints and methods", async () => {
  const { gw, calls } = setup();
  for (const path of ["/", "/v1", "/v1/observations/", "/v2/observations", "/v1/../v1/observations-x", "/fred/series/observations", "/v1/health/x"]) {
    const r = await read(await gw.handle(post(good(), { path }), env()));
    assert.equal(r.status, 404, path);
  }
  const get = await gw.handle(new Request(`${BASE}/v1/observations`, { headers: { Origin: ORIGIN } }), env());
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  const query = await read(await gw.handle(post(good(), { path: "/v1/observations?url=https://evil.example/" }), env()));
  assert.deepEqual([query.status, query.body.error.code], [400, "invalid_request"]);
  assert.equal(calls.length, 0);
});

test("rejected: series outside the allowlist, and request bodies with extra or missing fields", async () => {
  const { gw, calls } = setup();
  for (const series of ["DGS10", "gs10", "GS10 ", "../GS10", "GS10&api_key=x", "", null, 7, "SP500,GS10"]) {
    const r = await read(await gw.handle(post(good({ series_id: series })), env()));
    assert.deepEqual([r.status, r.body.error.code], [400, "unknown_series"], String(series));
  }
  for (const body of [{ ...good(), url: "https://evil.example" }, { ...good(), file_type: "xml" }, { series_id: "GS10" }, [good()], "GS10", null]) {
    const r = await read(await gw.handle(post(body), env()));
    assert.deepEqual([r.status, r.body.error.code], [400, "invalid_request"], JSON.stringify(body));
  }
  const notJson = await read(await gw.handle(post(null, { raw: "series_id=GS10" }), env()));
  assert.equal(notJson.body.error.code, "invalid_request");
  const form = await read(await gw.handle(post(good(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } }), env()));
  assert.deepEqual([form.status, form.body.error.code], [415, "unsupported_media_type"]);
  assert.equal(calls.length, 0);
});

test("rejected: invalid dates (format, calendar, order, before 1913, after this month)", async () => {
  const { gw, calls } = setup();
  for (const [start, end] of [["2024-1-01", "2024-03-31"], ["2024-02-30", "2024-03-31"], ["2024-03-01", "2024-01-31"], ["1912-12-01", "1913-01-31"], ["2026-11-01", "2027-01-31"], ["2024-01-15", "2024-03-31"], ["20240101", "20240331"], [null, "2024-03-31"]]) {
    const r = await read(await gw.handle(post(good({ observation_start: start, observation_end: end })), env()));
    assert.deepEqual([r.status, r.body.error.code], [400, "invalid_dates"], `${start}..${end}`);
  }
  const current = await gw.handle(post(good({ observation_start: "2026-11-01", observation_end: "2026-11-30" })), env());
  assert.equal(current.status, 200, "the current month is allowed");
  assert.equal(calls.length, 1);
});

test("rejected: oversized request bodies", async () => {
  const { gw, calls } = setup();
  const big = await read(await gw.handle(post(null, { raw: JSON.stringify({ ...good(), pad: "x".repeat(LIMITS.maxBodyBytes) }) }), env()));
  assert.deepEqual([big.status, big.body.error.code], [413, "body_too_large"]);
  const lying = await read(await gw.handle(post(null, { raw: JSON.stringify(good()), headers: { "Content-Length": "999999" } }), env()));
  assert.equal(lying.body.error.code, "body_too_large");
  assert.equal(calls.length, 0);
});

test("rejected: malformed keys, without echoing them", async () => {
  const { gw, calls } = setup();
  for (const key of ["", "ABCDEFGHIJ0123456789ABCDEFGHIJ01", "short", `${KEY_A}x`, "aaaaaaaaaa0123456789aaaaaaaaaa0!", 12345]) {
    const r = await read(await gw.handle(post(good({ api_key: key })), env()));
    assert.deepEqual([r.status, r.body.error.code], [400, "invalid_key_format"]);
    if (typeof key === "string" && key) assert.ok(!JSON.stringify(r).includes(key), "the submitted key is not reflected");
  }
  assert.equal(calls.length, 0);
});

test("restricted origins: production and configured development origins only", async () => {
  const { gw, calls } = setup();
  for (const origin of ["https://evil.example", "https://elmatthe.github.io.evil.example", "http://elmatthe.github.io", "null", null]) {
    const r = await read(await gw.handle(post(good(), { origin }), env()));
    assert.deepEqual([r.status, r.body.error.code], [403, "origin_not_allowed"], String(origin));
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(calls.length, 0);
  const dev = await gw.handle(post(good(), { origin: "http://127.0.0.1:4000" }), env());
  assert.equal(dev.status, 200);
  assert.equal((await gw.handle(post(good(), { origin: "http://127.0.0.1:4000" }), env({ ALLOWED_ORIGINS: ORIGIN }))).status, 403, "dev origins only when configured");
  assert.deepEqual([...parseOrigins("https://elmatthe.github.io, http://localhost:4000, http://evil.example, https://a.example/path, ftp://x, https://user:pw@b.example")], ["https://elmatthe.github.io", "http://localhost:4000"]);
});

test("preflight: allowed origin, POST and Content-Type only", async () => {
  const { gw, calls } = setup();
  const pre = (origin, method = "POST", headers = "content-type") => gw.handle(new Request(`${BASE}/v1/observations`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers } }), env());
  const ok = await pre(ORIGIN);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(ok.headers.get("access-control-allow-methods"), "POST");
  assert.equal(ok.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(ok.headers.get("access-control-allow-credentials"), null, "credentials are never allowed");
  for (const r of [await pre("https://evil.example"), await pre(ORIGIN, "GET"), await pre(ORIGIN, "POST", "content-type, authorization"), await pre(ORIGIN, "POST", "cookie")]) {
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(calls.length, 0);
});

test("health: status without secrets, no upstream request", async () => {
  const { gw, calls } = setup();
  const r = await read(await gw.handle(new Request(`${BASE}/v1/health`), env({ DISABLED_SERIES: "SP500" })));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.deepEqual(r.body.series, FRED_SERIES.map(c => c.sourceId));
  assert.deepEqual(r.body.disabled, ["SP500"]);
  assert.ok(!/key|secret|token/i.test(Object.keys(r.body).join()), "no secret fields");
  assert.equal(calls.length, 0);
  assert.equal((await gw.handle(new Request(`${BASE}/v1/health`, { method: "POST", body: "{}" }), env())).status, 405);
});

test("rate limiting: per caller per minute, fail closed, separate callers independent", async () => {
  const { gw, advance } = setup();
  let last;
  for (let i = 0; i < LIMITS.perClientPerMinute; i += 1) last = await gw.handle(post(good()), env());
  assert.equal(last.status, 200);
  const limited = await read(await gw.handle(post(good()), env()));
  assert.deepEqual([limited.status, limited.body.error.code, limited.headers["retry-after"]], [429, "rate_limited", "30"]);
  assert.equal((await gw.handle(post(good(), { ip: "203.0.113.9" }), env())).status, 200, "another caller is not affected");
  advance(60000);
  assert.equal((await gw.handle(post(good()), env())).status, 200, "the window resets");
  // Cloudflare's Rate Limiting binding, when configured; an error in it fails closed.
  const deny = setup();
  const keys = [];
  const r1 = await deny.gw.handle(post(good()), env({ RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } }));
  assert.equal(r1.status, 429);
  assert.match(keys[0], /^[0-9a-f]{24}$/, "the binding sees a hash, not the IP address");
  const broken = await deny.gw.handle(post(good()), env({ RATE_LIMITER: { limit: async () => { throw new Error("binding down"); } } }));
  assert.equal(broken.status, 503);
  assert.equal(deny.calls.length, 0);
});

test("concurrency: at most three requests in flight per caller", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { gw } = setup({ upstream: async url => { await gate; return new Response(JSON.stringify(fredPayload(url)), { status: 200 }); } });
  const pending = [1, 2, 3].map(() => gw.handle(post(good()), env()));
  await new Promise(r => setTimeout(r, 20));
  const fourth = await read(await gw.handle(post(good()), env()));
  assert.deepEqual([fourth.status, fourth.body.error.code], [429, "rate_limited"]);
  release();
  assert.deepEqual((await Promise.all(pending)).map(r => r.status), [200, 200, 200]);
});

test("timeouts and provider outages: clear codes, retry hints, nothing leaked", async () => {
  const outage = setup({ upstream: async () => new Response("<html>Service Unavailable</html>", { status: 503 }) });
  const down = await read(await outage.gw.handle(post(good()), env()));
  assert.deepEqual([down.status, down.body.error.code, down.body.error.retryable], [502, "upstream_unavailable", true]);
  const net = setup({ upstream: async url => { throw new TypeError(`fetch failed for ${url}`); } });
  const n = await read(await net.gw.handle(post(good()), env()));
  assert.deepEqual([n.status, n.body.error.code], [502, "upstream_unavailable"]);
  assert.ok(!net.logs.join().includes(KEY_A) && !net.logs.join().includes("api_key"), "the runtime's error text (with the URL) is not logged");
  const limited = setup({ upstream: async () => new Response(JSON.stringify({ error_code: 429, error_message: "Too Many Requests.  Exceeded Rate Limit" }), { status: 429 }) });
  const l = await read(await limited.gw.handle(post(good()), env()));
  assert.deepEqual([l.status, l.body.error.code], [429, "upstream_rate_limited"]);
  const redirect = setup({ upstream: async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }) });
  assert.equal((await read(await redirect.gw.handle(post(good()), env()))).body.error.code, "upstream_invalid");
  assert.equal(redirect.calls.length, 1, "the redirect is not followed");
});

test("timeouts: the upstream request is aborted after the limit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = setup({ upstream: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
  const pending = slow.gw.handle(post(good()), env());
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  t.mock.timers.tick(LIMITS.upstreamTimeoutMs);
  const r = await read(await pending);
  assert.deepEqual([r.status, r.body.error.code], [504, "upstream_timeout"]);
});

test("invalid credentials: FRED's rejection becomes key_rejected with a fixed message", async () => {
  const { gw, logs } = setup({ upstream: async () => new Response(JSON.stringify({ error_code: 400, error_message: `Bad Request.  The value for variable api_key is not registered. ${KEY_A}` }), { status: 400 }) });
  const r = await read(await gw.handle(post(good()), env()));
  assert.deepEqual([r.status, r.body.error.code, r.body.error.message], [401, "key_rejected", "FRED rejected the key."]);
  assert.ok(!JSON.stringify(r).includes(KEY_A) && !logs.join().includes(KEY_A), "neither the response nor the log contains the key, even when FRED echoes it");
  const other = setup({ upstream: async () => new Response(JSON.stringify({ error_code: 400, error_message: "Bad Request. The series does not exist." }), { status: 400 }) });
  assert.equal((await read(await other.gw.handle(post(good()), env()))).body.error.code, "upstream_rejected");
});

test("response validation: malformed, oversized or out-of-window answers are refused", async () => {
  const cases = [
    "not json",
    JSON.stringify({ observations: "x", count: 1 }),
    JSON.stringify({ observations: [{ date: "2024-01-01", value: "1" }], count: 2 }),
    JSON.stringify({ observations: [{ date: "2023-12-01", value: "1" }], count: 1 }),
    JSON.stringify({ observations: [{ date: "2024-01-15", value: "1" }], count: 1 }),
    JSON.stringify({ observations: [{ date: "2024-01-01", value: "<script>" }], count: 1 }),
    JSON.stringify({ observations: [{ date: "2024-01-01", value: 1 }], count: 1 }),
    JSON.stringify({ observations: [{ date: "2024-01-01", value: "1" }, { date: "2024-01-01", value: "2" }], count: 2 }),
    "x".repeat(LIMITS.maxUpstreamBytes + 1),
  ];
  for (const body of cases) {
    const { gw } = setup({ upstream: async () => new Response(body, { status: 200 }) });
    const r = await read(await gw.handle(post(good()), env()));
    assert.deepEqual([r.status, r.body.error.code], [502, "upstream_invalid"], body.slice(0, 60));
  }
});

test("no credential logging and no reflected secrets across every outcome", async () => {
  const outcomes = [
    async () => new Response(JSON.stringify(fredPayload(`${FRED_OBSERVATIONS_URL}?series_id=GS10&observation_start=2024-01-01&observation_end=2024-03-31`)), { status: 200 }),
    async () => new Response("oops", { status: 500 }),
    async url => { throw new Error(`connect ECONNREFUSED ${url}`); },
    async () => new Response(`{"error_message":"api_key=${KEY_A}"}`, { status: 403 }),
  ];
  for (const upstream of outcomes) {
    const { gw, logs } = setup({ upstream });
    const r = await gw.handle(post(good()), env());
    const text = await r.text();
    assert.ok(!text.includes(KEY_A), "response");
    assert.ok(!logs.join().includes(KEY_A) && !/api_key=/.test(logs.join()) && !logs.join().includes("198.51.100.7"), `log: ${logs.join()}`);
  }
  assert.equal(redact(`https://api.stlouisfed.org/fred/series/observations?series_id=GS10&api_key=${KEY_A}&file_type=json`), "https://api.stlouisfed.org/fred/series/observations?series_id=GS10&api_key=[redacted]&file_type=json");
  assert.equal(redact(`key ${KEY_B} here`), "key [redacted] here");
});

test("cross-user privacy: no shared cache, each request uses its own key, no cookies", async () => {
  const { gw, calls } = setup();
  const a = await gw.handle(post(good({ api_key: KEY_A }), { ip: "198.51.100.1" }), env());
  const b = await gw.handle(post(good({ api_key: KEY_B }), { ip: "198.51.100.2" }), env());
  assert.equal(calls.length, 2, "the second visitor's identical request is not served from the first one's answer");
  assert.equal(new URL(calls[0].url).searchParams.get("api_key"), KEY_A);
  assert.equal(new URL(calls[1].url).searchParams.get("api_key"), KEY_B);
  for (const r of [a, b]) {
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("vary"), "Origin");
  }
  const textA = await a.text();
  assert.ok(!textA.includes(KEY_B) && !textA.includes(KEY_A));
});

test("operator kill switch: a disabled series is refused before any request; SP500 carries its rights notice", async () => {
  const { gw, calls } = setup();
  const off = await read(await gw.handle(post(good({ series_id: "SP500", observation_start: "2024-01-01", observation_end: "2024-01-31" })), env({ DISABLED_SERIES: "SP500" })));
  assert.deepEqual([off.status, off.body.error.code], [403, "series_disabled"]);
  assert.equal(calls.length, 0);
  const on = await read(await gw.handle(post(good({ series_id: "SP500", observation_start: "2024-01-01", observation_end: "2024-01-31" })), env()));
  assert.equal(on.status, 200);
  assert.match(on.body.rights, /S&P Dow Jones Indices/);
});

test("https only (http is allowed for local development only when configured)", async () => {
  const { gw } = setup();
  const r = await gw.handle(new Request("http://127.0.0.1:8787/v1/observations", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(good()) }), env());
  assert.equal(r.status, 403);
  assert.equal((await gw.handle(new Request("http://127.0.0.1:8787/v1/observations", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(good()) }), env({ ALLOW_HTTP: "true" }))).status, 200);
});
