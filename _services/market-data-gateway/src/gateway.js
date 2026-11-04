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
// Security properties (each covered by _tools/tests/unit/market-gateway.test.mjs):
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
//   * the data source is protected first: upstream requests are spaced (one actual start
//     per second per isolate, first come first served, at most 2 in flight, waiting at most
//     15 s), budgeted (20 started per minute per isolate, plus a per-location binding),
//     coalesced (one upstream request for identical concurrent requests), cached (answers
//     10 min / 12 h, definitive refusals 30 min), and stopped entirely for 15 minutes after
//     Yahoo answers 429 and 30 minutes after 401/403, or for as long as Yahoo's own
//     Retry-After says when that is longer (a circuit breaker; no retry is ever sent
//     upstream). A wait above MAX_COOLDOWN_SECONDS stops the source until the owner
//     reactivates it (UPSTREAM_REACTIVATION_ID);
//   * logs hold an event name, a code, a venue and a status: never an IP address or a URL.
//
// Free-plan design: at most one upstream subrequest per request, one JSON parse, a small
// in-memory cache per isolate plus the Cache API (functional on a custom domain; see
// README.md), optional Rate Limiting bindings. No KV, D1, R2, Durable Objects or paid
// feature is used.

import { VENUES, parseSymbol } from "./venues.js";
import { SOURCE_ID, SOURCE_INFO, HISTORY_RANGES, HISTORY_INTERVALS, UpstreamError, chartUrl, normalizeQuote, normalizeHistory } from "./yahoo-chart.js";

export const VERSION = "1.2.0";

// The exact value of OWNER_ATTESTATION that switches the source on (with KEYLESS_SOURCE).
export const OWNER_ATTESTATION_VALUE = "owner-confirms-yahoo-permission";
export const DEFAULT_ORIGINS = Object.freeze(["https://elmatthe.github.io"]);

// Limits are deliberately conservative: a slow answer is better than an upstream block.
export const LIMITS = Object.freeze({
  maxUrlLength: 256,
  maxUpstreamBytes: 2 * 1024 * 1024,
  upstreamTimeoutMs: 8000,
  perClientPerMinute: 30, // in-memory, per isolate (the RATE_LIMITER binding is cross-isolate)
  perClientInFlight: 2,
  upstreamPerMinute: 20, // per isolate (the UPSTREAM_LIMITER binding is per Cloudflare location)
  upstreamInFlight: 2,
  upstreamMinSpacingMs: 1000, // between the actual starts of two upstream requests in one isolate
  upstreamQueueMaxWaitMs: 15000, // a request waits at most this long for its turn
  upstreamQueuePollMs: 200, // how often a waiting request looks again (see acquireSlot)
  upstreamLeaseGraceMs: 2000, // an in-flight place is reclaimed this long after its timeout
  memoryCacheEntries: 300,
});

// After the data source refuses the gateway, no upstream request is sent for this long
// (seconds). Answers already cached are still served.
export const COOLDOWN_SECONDS = Object.freeze({ upstream_rate_limited: 900, upstream_blocked: 1800, upstream_unavailable: 120 });
// The longest wait the gateway keeps by itself. A longer Retry-After from the data source
// is never shortened into an early retry: the source stays stopped until the owner
// reactivates it by setting a new UPSTREAM_REACTIVATION_ID.
export const MAX_COOLDOWN_SECONDS = 86400;
// Consecutive 5xx / timeout / network failures before the short cooldown starts.
export const FAILURES_BEFORE_COOLDOWN = 3;

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

// The data source's Retry-After as an absolute time in ms, or null when it does not
// extend anything: delta seconds or an IMF-fixdate (RFC 9110). Malformed, negative and past
// values are ignored, so the minimum cooldown always stands. A number too large to
// represent is a very long wait, not a malformed one (Infinity).
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
export function parseUpstreamRetryAfter(value, nowMs) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 64) return null;
  if (/^\d+$/.test(raw)) {
    const at = nowMs + Number(raw) * 1000;
    if (!Number.isSafeInteger(at)) return Infinity;
    return at > nowMs ? at : null;
  }
  if (!HTTP_DATE.test(raw)) return null;
  const at = Date.parse(raw);
  // The round trip refuses dates that do not exist, such as 31 February.
  if (!Number.isFinite(at) || new Date(at).toUTCString() !== raw) return null;
  return at > nowMs ? at : null;
}

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

// Reads at most `limit` bytes of a body; null when it is larger.
async function readCapped(stream, limit) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch (_) { /* closed */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
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
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = entry => console.log(JSON.stringify(entry)),
  cache = globalThis.caches?.default || null, // Cache API (per data center); null in tests or where unavailable
  limits = {}, // tests only: shorter timeouts or smaller limits
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const L = { ...LIMITS, ...limits };
  const allowClient = windowCounter(L.perClientPerMinute, 60000, now);
  const allowUpstream = windowCounter(L.upstreamPerMinute, 60000, now);
  const clientInFlight = new Map();
  let cooldown = null; // { code, until } or { code, halted: true } while the data source is not contacted
  let reactivationId = ""; // the owner's current UPSTREAM_REACTIVATION_ID
  let consecutiveFailures = 0;
  const pending = new Map(); // cache key -> in-flight upstream work (coalescing)
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

  /* ---------------- upstream protection: cooldown, spacing, budget ---------------- */
  // The cooldown is kept in this isolate and, best effort, in the Cache API so other
  // isolates in the same data center respect it too. It is an absolute deadline, or
  // { halted: true }: no deadline at all, until the owner reactivates the source.
  const cooldownUrl = base => `${base}/__cache/${SOURCE_ID}/${VERSION}/state/cooldown${reactivationId ? `/${reactivationId}` : ""}`;
  function cooldownLeft() {
    if (!cooldown) return 0;
    if (cooldown.halted) return MAX_COOLDOWN_SECONDS;
    const left = Math.ceil((cooldown.until - now()) / 1000);
    if (left <= 0) { cooldown = null; return 0; }
    return left;
  }
  // The owner's explicit reactivation: a new value of the non-sensitive setting
  // UPSTREAM_REACTIVATION_ID ends a stop and leaves the stored one behind.
  function applyReactivation(env) {
    const raw = String(env.UPSTREAM_REACTIVATION_ID ?? "").trim();
    const id = /^[A-Za-z0-9._-]{1,40}$/.test(raw) ? raw : "";
    if (id === reactivationId) return;
    reactivationId = id;
    if (cooldown?.halted) cooldown = null;
  }
  async function loadCooldown(base) {
    if (cooldownLeft() || !cache) return;
    try {
      const response = await cache.match(cooldownUrl(base));
      if (!response) return;
      const entry = await response.json();
      if (!Object.hasOwn(COOLDOWN_SECONDS, entry?.code) || !Number.isFinite(entry.startedAt) || entry.startedAt > now() + 60000) return;
      if (entry.halted !== undefined) {
        if (entry.halted === true) cooldown = { code: entry.code, until: null, halted: true };
        return;
      }
      // Only a well-formed entry is honoured: started in the past, at least its minimum and
      // at most the maximum long. A corrupted or far-future entry is ignored, so it can
      // never stop the source for longer than intended. (An outage that named a short wait
      // of its own has no minimum: it was started without one.)
      const length = entry.until - entry.startedAt;
      const minimum = entry.code === "upstream_unavailable" ? 1 : COOLDOWN_SECONDS[entry.code] * 1000;
      if (Number.isFinite(entry.until) && length >= minimum && length <= MAX_COOLDOWN_SECONDS * 1000 && entry.until > now()) {
        cooldown = { code: entry.code, until: entry.until };
      }
    } catch (_) { /* optional */ }
  }
  // Starts or extends the cooldown: the configured minimum (unless `useMinimum` is false)
  // or the data source's own deadline, whichever is later. It is never shortened.
  function startCooldown(base, code, ctx, { directedUntil = null, useMinimum = true } = {}) {
    if (!Object.hasOwn(COOLDOWN_SECONDS, code) || cooldown?.halted) return;
    const startedAt = now();
    const until = Math.max(useMinimum ? startedAt + COOLDOWN_SECONDS[code] * 1000 : 0, directedUntil ?? 0);
    if (until <= startedAt) return;
    const halted = until - startedAt > MAX_COOLDOWN_SECONDS * 1000;
    if (!halted && cooldown && cooldown.until >= until) return;
    cooldown = halted ? { code, until: null, halted: true } : { code, until };
    const seconds = halted ? null : Math.ceil((until - startedAt) / 1000);
    log({ event: "cooldown_started", code, seconds, ...(halted ? { halted: true } : {}) });
    if (!cache) return;
    const entry = halted ? { code, startedAt, halted: true } : { code, startedAt, until };
    const put = cache.put(cooldownUrl(base), new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${halted ? 31536000 : seconds}` } })).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
  }
  // Waits for this isolate's next upstream start, first come first served. The decision
  // and the start happen in one uninterrupted step, so no two requests can pass together:
  // at most upstreamInFlight in flight, at least upstreamMinSpacingMs between actual
  // starts, and a wait of at most upstreamQueueMaxWaitMs. Returns { lease } or { refused }.
  //
  // Each waiter runs on its own timers and looks again on its own. In a Worker a request's
  // timers and promises end with that request, so a waiter must never depend on another
  // request to wake it. For the same reason a place in flight is a lease that expires: a
  // request whose context ended can no longer give its place back.
  const slotQueue = [];
  const leases = new Set();
  let lastUpstreamStart = -Infinity;
  const inFlightAt = t => {
    for (const lease of leases) if (lease.expiresAt <= t) leases.delete(lease);
    return leases.size;
  };
  async function acquireSlot(signal) {
    if (signal?.aborted) return { refused: "cancelled" };
    const arrived = now();
    // A queue this long could not be served in time: refused at once, and it stays bounded.
    const ahead = Math.max(0, lastUpstreamStart + L.upstreamMinSpacingMs - arrived) + slotQueue.length * L.upstreamMinSpacingMs;
    if (ahead > L.upstreamQueueMaxWaitMs) return { refused: "throttled" };
    const ticket = { deadline: arrived + L.upstreamQueueMaxWaitMs };
    slotQueue.push(ticket);
    const leave = () => { const i = slotQueue.indexOf(ticket); if (i >= 0) slotQueue.splice(i, 1); };
    signal?.addEventListener("abort", leave, { once: true });
    let waited = 0; // also ends the wait if the clock does not move
    try {
      for (;;) {
        if (signal?.aborted) return { refused: "cancelled" };
        // The cooldown may have started while this request waited for its turn.
        if (cooldownLeft()) return { refused: cooldown.code, cooling: true };
        const t = now();
        // A waiter whose context ended cannot leave by itself; its deadline removes it.
        while (slotQueue[0] && slotQueue[0] !== ticket && slotQueue[0].deadline <= t) slotQueue.shift();
        const first = slotQueue[0] === ticket;
        const spacingLeft = lastUpstreamStart + L.upstreamMinSpacingMs - t;
        const room = inFlightAt(t) < L.upstreamInFlight;
        if (first && room && spacingLeft <= 0) {
          // The budget counts requests that really start.
          if (!allowUpstream("upstream")) return { refused: "throttled" };
          lastUpstreamStart = t;
          const lease = { expiresAt: t + L.upstreamTimeoutMs + L.upstreamLeaseGraceMs };
          leases.add(lease);
          return { lease };
        }
        const left = Math.min(ticket.deadline - t, L.upstreamQueueMaxWaitMs - waited);
        if (left <= 0) return { refused: "throttled" };
        const wait = Math.min(left, first && room ? spacingLeft : L.upstreamQueuePollMs);
        waited += wait;
        await sleep(wait);
      }
    } finally {
      leave();
      signal?.removeEventListener("abort", leave);
    }
  }

  async function upstream(url, env, signal) {
    if (cooldownLeft()) return { error: cooldown.code, cooling: true };
    if (env.UPSTREAM_LIMITER && typeof env.UPSTREAM_LIMITER.limit === "function") {
      try {
        const { success } = await env.UPSTREAM_LIMITER.limit({ key: SOURCE_ID });
        if (!success) return { error: "throttled" };
      } catch (_) { return { error: "busy" }; } // fail closed
    }
    const slot = await acquireSlot(signal);
    if (slot.refused) return { error: slot.refused, cooling: Boolean(slot.cooling), cancelled: slot.refused === "cancelled" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), L.upstreamTimeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": `market-data-gateway/${VERSION} (+https://elmatthe.github.io/projects/portfolio-rebalancer/)` },
        redirect: "manual",
        signal: controller.signal,
      });
      // The only upstream header ever read, and only on a refusal.
      const retryAfterAt = response.status === 200 ? null : parseUpstreamRetryAfter(response.headers?.get?.("Retry-After"), now());
      const text = await readCapped(response.body, response.status === 200 ? L.maxUpstreamBytes : 4096);
      return { status: response.status, text, retryAfterAt };
    } catch (error) {
      if (signal?.aborted) return { error: "cancelled", cancelled: true };
      return { error: controller.signal.aborted ? "upstream_timeout" : "upstream_unavailable", name: error?.name || "Error" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      leases.delete(slot.lease);
    }
  }
  function statusCode(status, text) {
    if (status >= 300 && status < 400) return "upstream_invalid"; // redirects are never followed
    if (status === 404) return /not ?found|no data/i.test(text || "") ? "symbol_not_found" : "upstream_invalid";
    if (status === 429) return "upstream_rate_limited";
    if (status === 401 || status === 403) return "upstream_blocked";
    if (status >= 500) return "upstream_unavailable";
    return "upstream_rejected";
  }
  // Updates the circuit breaker after an upstream outcome (a code, or null for success).
  // `directedUntil` is the data source's own Retry-After, as an absolute time.
  function recordOutcome(base, code, ctx, directedUntil = null) {
    if (code === "upstream_rate_limited" || code === "upstream_blocked") { consecutiveFailures = 0; startCooldown(base, code, ctx, { directedUntil }); return; }
    if (code === "upstream_unavailable" || code === "upstream_timeout") {
      consecutiveFailures += 1;
      if (consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) { consecutiveFailures = 0; startCooldown(base, "upstream_unavailable", ctx, { directedUntil }); }
      // One outage that names its own wait is honoured for that wait, without the minimum.
      else if (directedUntil !== null) startCooldown(base, "upstream_unavailable", ctx, { directedUntil, useMinimum: false });
      return;
    }
    consecutiveFailures = 0;
  }
  // A refusal answered while the source is cooling down carries the time really left.
  const failCooling = (code, origin) => fail(code, origin, { "Retry-After": String(Math.max(1, cooldownLeft())) }, cooldown?.halted ? { retryable: false, manualReactivationRequired: true } : {});

  // One upstream fetch and its normalization. Returns { body } or { code }.
  async function fetchAndNormalize(base, kind, parsed, range, env, ctx, signal) {
    const url = chartUrl(parsed.symbol, { kind, range });
    const res = await upstream(url, env, signal);
    if (res.error) {
      if (!res.cooling && !res.cancelled) { // a client leaving says nothing about the source
        log({ event: "upstream_error", code: res.error, mic: parsed.mic, error: res.name || null });
        recordOutcome(base, res.error, ctx);
      }
      return { code: res.error, cooling: Boolean(res.cooling) };
    }
    if (res.status !== 200) {
      const code = statusCode(res.status, res.text);
      log({ event: "upstream_status", code, mic: parsed.mic, status: res.status });
      recordOutcome(base, code, ctx, res.retryAfterAt);
      return { code, cooling: Boolean(cooldownLeft()) && Object.hasOwn(COOLDOWN_SECONDS, code) };
    }
    recordOutcome(base, null, ctx);
    if (res.text === null) { log({ event: "upstream_too_large", mic: parsed.mic }); return { code: "upstream_invalid" }; }
    try {
      const args = { symbol: parsed.symbol, mic: parsed.mic, venue: parsed.venue, range, now: now() };
      const body = kind === "quote" ? normalizeQuote(res.text, args) : normalizeHistory(res.text, args);
      body.retrievedAt = new Date(now()).toISOString();
      return { body };
    } catch (error) {
      const code = error instanceof UpstreamError && MESSAGES[error.code] ? error.code : "upstream_invalid";
      log({ event: "upstream_refused", code, mic: parsed.mic, detail: error instanceof UpstreamError ? error.detail : "exception" });
      return { code };
    }
  }

  // One client's wait for shared work. A client that leaves stops waiting at once; the
  // work itself is cancelled only when no client is left.
  function waitForWork(work, signal) {
    work.clients += 1;
    if (!signal) return work.promise;
    return new Promise((resolve, reject) => {
      const leave = () => {
        work.clients -= 1;
        if (work.clients === 0) work.controller.abort();
        resolve({ code: "cancelled" });
      };
      if (signal.aborted) { leave(); return; }
      signal.addEventListener("abort", leave, { once: true });
      work.promise.then(value => { signal.removeEventListener("abort", leave); resolve(value); }, error => { signal.removeEventListener("abort", leave); reject(error); });
    });
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
    await loadCooldown(base);
    if (cooldownLeft()) return failCooling(cooldown.code, origin);
    // Identical concurrent requests in this isolate share one upstream request.
    let work = pending.get(key);
    const shared = Boolean(work);
    if (!work) {
      const controller = new AbortController();
      const promise = fetchAndNormalize(base, kind, parsed, range, env, ctx, controller.signal)
        .then(async out => {
          // Stored here, not by the first client, which may already have left.
          if (out.body) await cachePut(base, key, out.body, ttl, ctx);
          else if (DEFINITIVE.has(out.code)) await cachePut(base, key, { refusal: out.code }, CACHE_TTL_SECONDS.refusal, ctx);
          return out;
        })
        .finally(() => pending.delete(key));
      work = { promise, controller, clients: 0 };
      pending.set(key, work);
      // Keeps the request's context alive until its place in the queue or in flight has
      // been given back, even if this client disconnects.
      if (ctx?.waitUntil) ctx.waitUntil(promise.catch(() => {}));
    }
    const out = await waitForWork(work, signal);
    if (out.code) {
      if (out.code === "cancelled") return fail("cancelled", origin);
      return out.cooling || (Object.hasOwn(COOLDOWN_SECONDS, out.code) && cooldownLeft()) ? failCooling(out.code, origin) : fail(out.code, origin);
    }
    return json(200, { ...out.body, cache: { status: shared ? "hit" : "miss", ageSeconds: 0, ttlSeconds: ttl } }, origin);
  }

  function health(env, origin) {
    const state = sourceState(env);
    return json(200, {
      schema: "md-gateway.health.v1", status: "ok", service: "market-data-gateway", version: VERSION,
      keyless: {
        enabled: state.enabled, source: state.source, reason: state.reason, activation: state.activation,
        provider: state.source === SOURCE_ID ? SOURCE_INFO.provider : null,
        attribution: state.enabled ? SOURCE_INFO.attribution : null,
        official: false,
      },
      // Whether the data source is being left alone after it refused this gateway.
      upstream: !cooldownLeft() ? { state: "ok", code: null, retryAfterSeconds: 0 }
        : cooldown.halted ? { state: "halted", code: cooldown.code, retryAfterSeconds: MAX_COOLDOWN_SECONDS, manualReactivationRequired: true }
          : { state: "cooling_down", code: cooldown.code, retryAfterSeconds: cooldownLeft() },
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
    applyReactivation(env);

    if (url.pathname === "/v1/health") {
      if (!["GET", "HEAD"].includes(request.method)) return fail("method_not_allowed", origin, { Allow: "GET, HEAD" });
      if (url.search) return fail("invalid_request", origin);
      await loadCooldown(url.origin);
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
