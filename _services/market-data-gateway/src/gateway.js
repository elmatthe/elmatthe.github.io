// Market-data gateway: a Cloudflare Worker (Workers Free plan) that gives the
// Portfolio Rebalancer and Stock Comparison pages on https://elmatthe.github.io a
// keyless source of ordinary market data, in one normalized JSON contract.
//
// Endpoints (GET only; nothing else is accepted):
//   GET /v1/health                                  status, whether the keyless source is on, limits
//   GET /v1/quote?symbol=VEQT.TO                    latest regular-session price of one listing
//   GET /v1/history?symbol=VEQT.TO&range=1y&interval=1d   bounded daily history
//   OPTIONS on the two data paths                   CORS preflight for allowed origins
//
// THE KEYLESS SOURCE IS OFF BY DEFAULT. It is used only when the operator sets
// KEYLESS_SOURCE = "yahoo-chart" AND OWNER_ATTESTATION = "owner-confirms-yahoo-permission"
// (README.md, "Activation"). The attestation is a plain, non-sensitive flag: the owner
// confirms that their own written permission from Yahoo covers this use; no document,
// reference or correspondence is stored here. Without both values, every data request
// is answered with `source_disabled` and no upstream request is made. A fresh deployment
// of wrangler.toml's top-level settings is therefore always switched off.
//
// Security properties (each covered by _tools/tests/unit/market-gateway.test.mjs and
// upstream-coordinator.test.mjs):
//   * no credentials, keys or secrets exist in this gateway, its requests or its answers;
//   * a fixed upstream origin and path (./yahoo-chart.js); the only client input copied
//     into the upstream URL is an allowlisted symbol (./venues.js) and an allowlisted
//     range; no client header is forwarded; redirects are never followed;
//   * strict query validation (only the listed parameters, each once, bounded length);
//   * upstream answers of at most 2 MB, at most 2,000 observations, an 8-second timeout,
//     and a full schema and value check; invalid or mismatched data is refused (fail
//     closed), never repaired or replaced by another listing;
//   * the request carries only a ticker symbol and a range: no holdings, quantities,
//     targets or account data exist in this contract;
//   * restrictive CORS (ALLOWED_ORIGINS). CORS is not authentication: a script can send
//     any Origin. Abuse is bounded by the per-client and per-upstream rate limits, the
//     allowlists, the cache and Cloudflare's free-plan daily cap. Requests with no Origin
//     at all (the desktop apps) are accepted only when ALLOW_NO_ORIGIN = "true";
//   * the data source is protected first, by one coordinator worldwide (./coordinator.js,
//     a SQLite-backed Durable Object), which is also the only code that contacts it: one
//     actual start per second, first come first served, at most 2 in flight, waiting at most
//     15 s; at most 20 starts in any 60 seconds; one upstream request for identical
//     concurrent requests; and stopped entirely for 15 minutes after Yahoo answers 429 and
//     30 minutes after 401/403, or for as long as Yahoo's own Retry-After says when that is
//     longer (a circuit breaker; no retry is ever sent upstream). A wait above
//     MAX_COOLDOWN_SECONDS halts the source until the owner reactivates it
//     (UPSTREAM_REACTIVATION_ID). If the coordinator cannot be reached or its state cannot
//     be verified, nothing is sent (fail closed). This file makes no upstream request;
//   * answers are cached (10 min / 12 h, definitive refusals 30 min). The caches are for
//     speed only: no safety decision depends on them;
//   * logs hold an event name, a code, a venue and a status: never an IP address or a URL.
//
// Free-plan design: this Worker makes one coordinator call per health or uncached data request
// (and one more if the client disconnects) and one JSON parse, with a small in-memory cache per isolate plus the Cache API (functional on a custom
// domain; see README.md) and an optional per-client Rate Limiting binding. The coordinator
// is a SQLite-backed Durable Object, the only kind Workers Free offers. No KV, D1, R2 or paid
// feature is used.

import { VENUES, parseSymbol } from "./venues.js";
import { SOURCE_ID, SOURCE_INFO, HISTORY_RANGES, HISTORY_INTERVALS, UpstreamError, normalizeQuote, normalizeHistory } from "./yahoo-chart.js";
import { VERSION, COOLDOWN_SECONDS, COORDINATOR_UNAVAILABLE, UNVERIFIED_RETRY_SECONDS, UPSTREAM_LIMITS } from "./coordinator.js";

export { VERSION, COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, FAILURES_BEFORE_COOLDOWN, parseUpstreamRetryAfter } from "./coordinator.js";

// The exact value of OWNER_ATTESTATION that switches the source on (with KEYLESS_SOURCE).
export const OWNER_ATTESTATION_VALUE = "owner-confirms-yahoo-permission";
export const DEFAULT_ORIGINS = Object.freeze(["https://elmatthe.github.io"]);

// Limits are deliberately conservative: a slow answer is better than an upstream block.
export const LIMITS = Object.freeze({
  maxUrlLength: 256,
  perClientPerMinute: 30, // in-memory, per isolate (the RATE_LIMITER binding is cross-isolate)
  perClientInFlight: 2,
  memoryCacheEntries: 300,
  coordinatorStatusWaitMs: 3000, // how long health waits for the coordinator
  ...UPSTREAM_LIMITS,
});

// How long an answer is reused. Ages are always reported; a cached answer is never
// presented as newly retrieved (retrievedAt stays the time of the upstream request).
// A definitive refusal for a listing (unknown symbol, other exchange, other currency) is
// remembered for `refusal` seconds so repeated requests do not reach the data source.
export const CACHE_TTL_SECONDS = Object.freeze({ quote: 600, history: 12 * 3600, refusal: 1800 });

const MESSAGES = {
  not_found: "Not found.",
  method_not_allowed: "Method not allowed.",
  https_required: "HTTPS is required.",
  origin_not_allowed: "Requests from this origin are not accepted.",
  invalid_request: "The request is not valid.",
  invalid_symbol: "The symbol is not valid. Use upper-case letters and digits with an exchange suffix such as .TO, .L or .DE.",
  unsupported_listing: "This gateway does not serve this listing (indexes, currencies, futures and exchanges outside its list are not served).",
  invalid_range: "Use range 1mo, 3mo, 6mo, 1y, 2y or 5y with interval 1d.",
  source_disabled: "The keyless market-data source is switched off on this gateway.",
  rate_limited: "Too many requests from this client. Wait a minute and try again.",
  throttled: "The gateway's request budget for its data source is used up for the moment. Try again in a minute.",
  busy: "The gateway is busy. Try again shortly.",
  symbol_not_found: "The data source has no data for this symbol.",
  no_price: "The data source returned no current price for this listing.",
  no_history: "The data source returned no price history for this listing and range.",
  listing_mismatch: "The data source answered for a different listing or exchange; the answer was not used.",
  currency_mismatch: "The data source reported a currency this listing does not trade in; the answer was not used.",
  currency_unknown: "The data source did not state the currency; the answer was not used.",
  unsupported_instrument: "The data source reports this symbol as an index, currency, future or other instrument the gateway does not serve.",
  upstream_rate_limited: "The data source is limiting requests from this gateway. Try again later.",
  upstream_blocked: "The data source refused the gateway's request (it may not allow automated access from this server).",
  upstream_unavailable: "The data source is temporarily unavailable.",
  upstream_timeout: "The data source did not answer in time.",
  upstream_invalid: "The data source returned an unexpected or invalid response; it was not used.",
  upstream_rejected: "The data source refused the request.",
  cancelled: "The request was cancelled by the client.",
};
const STATUS = {
  not_found: 404, method_not_allowed: 405, https_required: 403, origin_not_allowed: 403, invalid_request: 400,
  invalid_symbol: 400, unsupported_listing: 400, invalid_range: 400, source_disabled: 503, rate_limited: 429,
  throttled: 429, busy: 503, symbol_not_found: 404, no_price: 422, no_history: 422, listing_mismatch: 422,
  currency_mismatch: 422, currency_unknown: 422, unsupported_instrument: 422, upstream_rate_limited: 429,
  upstream_blocked: 502, upstream_unavailable: 502, upstream_timeout: 504, upstream_invalid: 502, upstream_rejected: 502,
  cancelled: 499,
};
const RETRY_AFTER = { rate_limited: 60, throttled: 60, busy: 5, upstream_rate_limited: 300, upstream_unavailable: 30, upstream_timeout: 30 };
// The listing was answered definitively: another try will give the same result.
const DEFINITIVE = new Set(["invalid_symbol", "unsupported_listing", "symbol_not_found", "listing_mismatch", "currency_mismatch", "currency_unknown", "unsupported_instrument"]);

const ENDPOINT_PARAMS = { "/v1/quote": ["symbol"], "/v1/history": ["interval", "range", "symbol"] };

// Whether the keyless source may be used, and why not. Both settings are required.
export function sourceState(env = {}) {
  const configured = String(env.KEYLESS_SOURCE ?? "").trim();
  const attestation = String(env.OWNER_ATTESTATION ?? "").trim();
  if (!configured || configured === "none" || configured === "off") {
    return { enabled: false, source: "none", activation: null, reason: "The keyless source is switched off on this gateway (KEYLESS_SOURCE is not set)." };
  }
  if (configured !== SOURCE_ID) return { enabled: false, source: "none", activation: null, reason: "An unknown keyless source is configured; it stays switched off." };
  if (attestation !== OWNER_ATTESTATION_VALUE) {
    return { enabled: false, source: SOURCE_ID, activation: null, reason: "Yahoo Finance retrieval is switched off: the operator has not activated it on this gateway (OWNER_ATTESTATION is not set)." };
  }
  return { enabled: true, source: SOURCE_ID, activation: "owner_attestation", reason: null };
}

// Only exact https origins (or loopback http origins for local development) are accepted.
export function parseOrigins(value) {
  const out = new Set();
  for (const raw of String(value ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    let u;
    try { u = new URL(raw); } catch (_) { continue; }
    const loopback = ["127.0.0.1", "localhost"].includes(u.hostname);
    if (u.origin !== raw.replace(/\/$/, "") || u.username || u.password) continue;
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) out.add(u.origin);
  }
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Fixed-window counter keyed by a string, bounded in size.
function windowCounter(limit, windowMs, now) {
  const windows = new Map();
  return key => {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (windows.size > 5000) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  };
}

export function createGateway({
  now = () => Date.now(),
  log = entry => console.log(JSON.stringify(entry)),
  cache = globalThis.caches?.default || null, // Cache API (per data center); null in tests or where unavailable
  limits = {}, // tests only: shorter timeouts or smaller limits
} = {}) {
  const L = { ...LIMITS, ...limits };
  const allowClient = windowCounter(L.perClientPerMinute, 60000, now);
  const clientInFlight = new Map();
  const memory = new Map(); // cache key -> { body, storedAt, ttl }

  const securityHeaders = () => ({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Strict-Transport-Security": "max-age=31536000",
  });
  // Retry-After is exposed so a page can honour it (it is not a CORS-safelisted header).
  const corsHeaders = origin => (origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Retry-After", Vary: "Origin" } : { Vary: "Origin" });
  const json = (status, body, origin, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...securityHeaders(), ...corsHeaders(origin), ...extra } });
  function fail(code, origin, extra = {}, bodyExtra = {}) {
    const retryAfter = RETRY_AFTER[code];
    const headers = retryAfter ? { "Retry-After": String(retryAfter), ...extra } : extra;
    const after = Number(headers["Retry-After"]);
    const body = { code, message: MESSAGES[code], retryable: Boolean(retryAfter) || Number.isFinite(after), definitive: DEFINITIVE.has(code), ...(Number.isFinite(after) ? { retryAfterSeconds: after } : {}), ...bodyExtra };
    return json(STATUS[code], { schema: "md-gateway.error.v1", error: body }, origin, headers);
  }

  /* ---------------- cache: this isolate's memory, then the Cache API ---------------- */
  // Cache API keys live under the Worker's own hostname (the cache belongs to its zone).
  const cacheUrl = (base, key) => `${base}/__cache/${SOURCE_ID}/${VERSION}/${key}`;
  async function cacheGet(base, key) {
    const t = now();
    const hit = memory.get(key);
    if (hit) {
      if (t - hit.storedAt <= hit.ttl * 1000 && t >= hit.storedAt) return hit;
      memory.delete(key);
    }
    if (!cache) return null;
    try {
      const response = await cache.match(cacheUrl(base, key));
      if (!response) return null;
      const entry = await response.json();
      if (!entry || typeof entry.storedAt !== "number" || typeof entry.ttl !== "number" || !entry.body) return null;
      if (t - entry.storedAt > entry.ttl * 1000 || t < entry.storedAt) {
        try { await cache.delete(cacheUrl(base, key)); } catch (_) { /* expired anyway */ }
        return null;
      }
      memory.set(key, entry);
      return entry;
    } catch (_) { return null; } // the cache is optional; a failure is a miss
  }
  async function cachePut(base, key, body, ttl, ctx) {
    const entry = { body, storedAt: now(), ttl };
    if (memory.size >= L.memoryCacheEntries) memory.delete(memory.keys().next().value);
    memory.set(key, entry);
    if (!cache) return;
    const put = cache.put(cacheUrl(base, key), new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }

  /* ---------------- the upstream coordinator ---------------- */
  // Everything that protects the data source is decided by the coordinator, the only code
  // that contacts it. A coordinator that is missing, failing or silent means no upstream
  // request: no fallback exists here, and a failed call is never repeated, because it may
  // have started the upstream request.
  function coordinatorStub(env) {
    try {
      return env.UPSTREAM_COORDINATOR.getByName(SOURCE_ID);
    } catch (error) {
      log({ event: "coordinator_unreachable", error: error?.name || "Error" });
      return null;
    }
  }
  // An answer that is not understood is not trusted.
  function validReply(reply) {
    if (reply && Object.hasOwn(STATUS, reply.code)) return reply;
    if (reply && reply.code === COORDINATOR_UNAVAILABLE) return reply;
    if (reply && !reply.code && (typeof reply.text === "string" || reply.text === null) && Number.isFinite(reply.retrievedAt)) return reply;
    log({ event: "coordinator_unreachable", error: "malformed answer" });
    return { code: COORDINATOR_UNAVAILABLE };
  }

  // One client's request for upstream data. A client that leaves stops waiting at once, and
  // the coordinator is told so it can drop work nobody is waiting for.
  async function askCoordinator(request, env, ctx, signal) {
    const stub = coordinatorStub(env);
    if (!stub) return { code: COORDINATOR_UNAVAILABLE };
    if (signal?.aborted) return { code: "cancelled" };
    const client = crypto.randomUUID();
    const leave = () => {
      let told;
      try { told = Promise.resolve(stub.cancel(client)).catch(() => {}); } catch (_) { return; }
      if (ctx?.waitUntil) ctx.waitUntil(told);
    };
    let interrupt;
    const interrupted = new Promise(resolve => { interrupt = resolve; });
    const onAbort = () => { leave(); interrupt({ code: "cancelled" }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // The coordinator answers within its own limits; anything longer means it cannot be trusted.
    const timer = setTimeout(() => {
      log({ event: "coordinator_unreachable", error: "timeout" });
      leave();
      interrupt({ code: COORDINATOR_UNAVAILABLE });
    }, L.upstreamQueueMaxWaitMs + L.upstreamTimeoutMs + L.upstreamLeaseGraceMs);
    try {
      const call = (async () => stub.fetchChart({ ...request, client }))().then(validReply, error => {
        log({ event: "coordinator_unreachable", error: error?.name || "Error" });
        return { code: COORDINATOR_UNAVAILABLE };
      });
      return await Promise.race([call, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // The upstream state for health. Only asked when the source is on: a source that is off
  // contacts nothing, and needs no coordinator.
  async function upstreamStatus(env) {
    const unverified = reason => ({ state: "unverified", code: null, retryAfterSeconds: UNVERIFIED_RETRY_SECONDS, reason });
    const stub = coordinatorStub(env);
    if (!stub) return unverified("coordinator_binding_missing");
    let timer;
    try {
      const silent = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), L.coordinatorStatusWaitMs); });
      const status = await Promise.race([(async () => stub.status())(), silent]);
      return ["ok", "cooling_down", "halted", "unverified"].includes(status?.state) ? status : unverified("coordinator_unreachable");
    } catch (error) {
      log({ event: "coordinator_unreachable", error: error?.name || "Error" });
      return unverified("coordinator_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  // A refusal answered while the source is stopped carries the time really left.
  const failCooling = (out, origin) => fail(out.code, origin, { "Retry-After": String(Math.max(1, out.retryAfterSeconds)) }, out.halted ? { retryable: false, manualReactivationRequired: true } : {});

  // One upstream answer and its normalization. Returns { body, shared } or { code, ... }.
  async function fetchAndNormalize(kind, parsed, range, env, ctx, signal) {
    const reply = await askCoordinator({ kind, symbol: parsed.symbol, range }, env, ctx, signal);
    if (reply.code) return reply;
    if (reply.text === null) { log({ event: "upstream_too_large", mic: parsed.mic }); return { code: "upstream_invalid" }; }
    try {
      const args = { symbol: parsed.symbol, mic: parsed.mic, venue: parsed.venue, range, now: now() };
      const body = kind === "quote" ? normalizeQuote(reply.text, args) : normalizeHistory(reply.text, args);
      body.retrievedAt = new Date(reply.retrievedAt).toISOString();
      return { body, shared: Boolean(reply.shared) };
    } catch (error) {
      const code = error instanceof UpstreamError && MESSAGES[error.code] ? error.code : "upstream_invalid";
      log({ event: "upstream_refused", code, mic: parsed.mic, detail: error instanceof UpstreamError ? error.detail : "exception" });
      return { code };
    }
  }

  async function data(base, kind, params, env, origin, ctx, signal) {
    const parsed = parseSymbol(params.symbol);
    if (parsed.error) return fail(parsed.error, origin);
    let range = null;
    if (kind === "history") {
      range = params.range;
      if (!Object.hasOwn(HISTORY_RANGES, range) || !HISTORY_INTERVALS.includes(params.interval)) return fail("invalid_range", origin);
    }
    const key = kind === "quote" ? `quote/${parsed.symbol}` : `history/${parsed.symbol}/${range}/1d`;
    const ttl = CACHE_TTL_SECONDS[kind];
    const hit = await cacheGet(base, key);
    if (hit) {
      if (hit.body.refusal) return fail(hit.body.refusal, origin); // remembered definitive refusal
      const ageSeconds = Math.max(0, Math.floor((now() - hit.storedAt) / 1000));
      return json(200, { ...hit.body, cache: { status: "hit", ageSeconds, ttlSeconds: hit.ttl } }, origin);
    }
    const out = await fetchAndNormalize(kind, parsed, range, env, ctx, signal);
    if (out.code) {
      if (out.code === COORDINATOR_UNAVAILABLE) return fail("busy", origin, { "Retry-After": String(UNVERIFIED_RETRY_SECONDS) });
      if (out.code === "cancelled") return fail("cancelled", origin);
      if (DEFINITIVE.has(out.code)) await cachePut(base, key, { refusal: out.code }, CACHE_TTL_SECONDS.refusal, ctx);
      return out.cooling ? failCooling(out, origin) : fail(out.code, origin);
    }
    await cachePut(base, key, out.body, ttl, ctx);
    return json(200, { ...out.body, cache: { status: out.shared ? "hit" : "miss", ageSeconds: 0, ttlSeconds: ttl } }, origin);
  }

  async function health(env, origin) {
    const state = sourceState(env);
    // Whether the data source is being left alone after it refused this gateway, according to
    // the coordinator. `unverified` means that could not be confirmed: nothing is sent then.
    const upstream = state.enabled ? await upstreamStatus(env) : { state: "ok", code: null, retryAfterSeconds: 0 };
    return json(200, {
      schema: "md-gateway.health.v1", status: upstream.state === "unverified" ? "degraded" : "ok", service: "market-data-gateway", version: VERSION,
      keyless: {
        enabled: state.enabled, source: state.source, reason: state.reason, activation: state.activation,
        provider: state.source === SOURCE_ID ? SOURCE_INFO.provider : null,
        attribution: state.enabled ? SOURCE_INFO.attribution : null,
        official: false,
      },
      upstream,
      endpoints: Object.keys(ENDPOINT_PARAMS),
      venues: Object.keys(VENUES),
      history: { ranges: Object.keys(HISTORY_RANGES), intervals: HISTORY_INTERVALS },
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      limits: { perClientPerMinute: L.perClientPerMinute, upstreamPerMinute: L.upstreamPerMinute, upstreamMinSpacingMs: L.upstreamMinSpacingMs, cooldownSeconds: COOLDOWN_SECONDS },
    }, origin);
  }

  async function handle(request, env = {}, ctx = null) {
    let url;
    try { url = new URL(request.url); } catch (_) { return fail("invalid_request", null); }
    const origins = parseOrigins(env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(","));
    const originHeader = request.headers.get("Origin");
    const origin = originHeader && origins.has(originHeader) ? originHeader : null;
    if (url.protocol !== "https:" && env.ALLOW_HTTP !== "true") return fail("https_required", origin);
    if (request.url.length > L.maxUrlLength) return fail("invalid_request", origin);

    if (url.pathname === "/v1/health") {
      if (!["GET", "HEAD"].includes(request.method)) return fail("method_not_allowed", origin, { Allow: "GET, HEAD" });
      if (url.search) return fail("invalid_request", origin);
      return health(env, origin);
    }
    const expected = ENDPOINT_PARAMS[url.pathname];
    if (!expected) return fail("not_found", origin);
    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const wanted = String(request.headers.get("Access-Control-Request-Headers") || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
      if (!origin || method !== "GET" || wanted.some(h => h !== "accept")) return new Response(null, { status: 403, headers: { ...securityHeaders(), Vary: "Origin" } });
      return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHeaders(origin), "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Accept", "Access-Control-Max-Age": "600" } });
    }
    if (request.method !== "GET") return fail("method_not_allowed", origin, { Allow: "GET, OPTIONS" });
    // A browser always sends Origin on these cross-origin requests; a request with none is
    // a non-browser client (the desktop apps), accepted only when the operator allows it.
    // A present but unlisted Origin is always refused.
    if (!origin && !(originHeader === null && env.ALLOW_NO_ORIGIN === "true")) return fail("origin_not_allowed", null);

    // Exactly the expected parameters, each once.
    const names = [...url.searchParams.keys()];
    if (names.length !== expected.length || [...names].sort().join() !== expected.join()) return fail("invalid_request", origin);
    const params = Object.fromEntries(url.searchParams);

    const state = sourceState(env);
    if (!state.enabled) return fail("source_disabled", origin);

    const client = await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown");
    if (!allowClient(client)) return fail("rate_limited", origin);
    if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: client });
        if (!success) return fail("rate_limited", origin);
      } catch (_) { return fail("busy", origin); } // fail closed
    }
    if ((clientInFlight.get(client) || 0) >= L.perClientInFlight) return fail("rate_limited", origin);
    clientInFlight.set(client, (clientInFlight.get(client) || 0) + 1);
    try {
      return await data(url.origin, url.pathname === "/v1/quote" ? "quote" : "history", params, env, origin, ctx, request.signal);
    } finally {
      const left = (clientInFlight.get(client) || 1) - 1;
      if (left > 0) clientInFlight.set(client, left); else clientInFlight.delete(client);
    }
  }

  return { handle };
}
