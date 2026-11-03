// CPI FRED gateway: a Cloudflare Worker that lets the CPI Web Scraper page on
// https://elmatthe.github.io read the thirteen approved FRED series with each
// visitor's OWN FRED API key. FRED's API sends no CORS headers, so a browser cannot
// call it directly; this Worker is the smallest possible bridge, not a proxy.
//
// What it does, and nothing else:
//   POST /v1/observations  {series_id, observation_start, observation_end, api_key}
//        -> one GET to https://api.stlouisfed.org/fred/series/observations (fixed URL),
//           validated and normalized to {date, value} observations
//   GET  /v1/health        -> service status, approved series and limits (no secrets)
//   OPTIONS /v1/observations -> CORS preflight for allowed origins only
// Every other method, path, series, date or body is refused.
//
// Security properties (each is covered by _tools/tests/unit/gateway.test.mjs):
//   * no owner key: every request carries the visitor's own key, in the POST body;
//   * the key is sent only to FRED, in the form FRED requires, and is never logged,
//     stored, cached or returned; error messages are fixed texts, never FRED's or the
//     runtime's own wording;
//   * fixed upstream host and path, no redirects followed, no client headers forwarded;
//   * only the thirteen series, dates from 1913-01-01 to the end of the current month,
//     at most ~10 years per request for daily series, bodies of at most 1 KB, upstream
//     answers of at most 3 MB, a 15-second upstream timeout;
//   * browser origins restricted to ALLOWED_ORIGINS (CORS is not authentication: the
//     rate limits, the allowlists and the visitor's own FRED key are the protection);
//   * per-caller rate limits (Cloudflare's Rate Limiting binding when configured, and
//     an in-memory limiter in every isolate), bounded concurrency, no cookies, no shared
//     cache (Cache-Control: no-store), so one visitor's data is never served to another.
//
// Free-tier design: one subrequest and one small JSON parse per request (Workers Free
// allows 50 subrequests and 10 ms of CPU per request, 100,000 requests per day). No KV,
// Durable Objects, R2 or paid feature is used.
//
// The Worker entry point is src/worker.js (default export only: the Workers runtime
// treats every named export of the main module as an entry point).

export const VERSION = "1.0.0";
export const FRED_OBSERVATIONS_URL = "https://api.stlouisfed.org/fred/series/observations";
export const SCHEMA = "cpi-data-gateway.observations.v1";

// The thirteen approved series (assets/js/cpi/schema.js; checked by the parity tests).
export const SERIES = Object.freeze({
  CPIAUCNS: "monthly", CPIAUCSL: "monthly", CPILFENS: "monthly", CPILFESL: "monthly", UNRATE: "monthly",
  FEDFUNDS: "monthly", DFF: "daily", SP500: "daily", T10Y2Y: "daily", GS10: "monthly", GS2: "monthly",
  PCEPI: "monthly", PCEPILFE: "monthly",
});

export const LIMITS = Object.freeze({
  maxBodyBytes: 1024,
  maxUpstreamBytes: 3 * 1024 * 1024,
  maxObservations: 6000,
  upstreamTimeoutMs: 15000,
  maxDailySpanDays: 3700, // ten calendar years and a margin
  minDate: "1913-01-01",
  perClientPerMinute: 60, // in-memory, per isolate
  perClientInFlight: 3,
  perIsolateInFlight: 6, // Workers allow 6 simultaneous outgoing connections per request
});

export const DEFAULT_ORIGINS = Object.freeze(["https://elmatthe.github.io"]);
const KEY_PATTERN = /^[a-z0-9]{32}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const BODY_KEYS = ["api_key", "observation_end", "observation_start", "series_id"];

const MESSAGES = {
  not_found: "Not found.",
  method_not_allowed: "Method not allowed.",
  https_required: "HTTPS is required.",
  origin_not_allowed: "Requests from this origin are not accepted.",
  unsupported_media_type: "Send a JSON body (Content-Type: application/json).",
  body_too_large: "The request body is too large.",
  invalid_request: "The request is not valid.",
  unknown_series: "This series is not available through this gateway.",
  series_disabled: "This series is disabled by the gateway operator.",
  invalid_dates: "Use observation_start and observation_end as YYYY-MM-DD, from 1913-01-01 to the end of the current month, start before end.",
  range_too_large: "The date range is too long for a daily series (at most ten years per request).",
  invalid_key_format: "That is not a FRED API key (32 lower-case letters and digits).",
  rate_limited: "Too many requests. Wait a minute and try again.",
  busy: "The gateway is busy. Try again shortly.",
  key_rejected: "FRED rejected the key.",
  upstream_rate_limited: "FRED is limiting requests for this key. Wait a minute and try again.",
  upstream_unavailable: "FRED is temporarily unavailable.",
  upstream_timeout: "FRED did not answer in time.",
  upstream_invalid: "FRED returned an unexpected response.",
  upstream_rejected: "FRED refused the request.",
};
const STATUS = {
  not_found: 404, method_not_allowed: 405, https_required: 403, origin_not_allowed: 403, unsupported_media_type: 415,
  body_too_large: 413, invalid_request: 400, unknown_series: 400, series_disabled: 403, invalid_dates: 400,
  range_too_large: 400, invalid_key_format: 400, rate_limited: 429, busy: 503, key_rejected: 401,
  upstream_rate_limited: 429, upstream_unavailable: 502, upstream_timeout: 504, upstream_invalid: 502, upstream_rejected: 502,
};
const RETRYABLE = new Set(["rate_limited", "busy", "upstream_rate_limited", "upstream_unavailable", "upstream_timeout"]);

// Removes anything that looks like a FRED key or an api_key parameter from a string.
export function redact(text) {
  return String(text ?? "")
    .replace(/api_key=[^&\s"']*/gi, "api_key=[redacted]")
    .replace(/\b[a-z0-9]{32}\b/g, "[redacted]");
}

function isoDate(text) {
  const m = DATE.exec(String(text ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? text : null;
}
const endOfCurrentMonth = now => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

// Only exact https origins (or loopback http origins for development) are accepted.
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

export function createGateway({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = entry => console.log(JSON.stringify(entry)) } = {}) {
  const windows = new Map(); // client hash -> { start, count }
  const inFlight = new Map(); // client hash -> number
  let isolateInFlight = 0;

  const securityHeaders = () => ({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Strict-Transport-Security": "max-age=31536000",
  });
  const corsHeaders = origin => (origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" });

  function json(status, body, origin, extra = {}) {
    return new Response(JSON.stringify(body), { status, headers: { ...securityHeaders(), ...corsHeaders(origin), ...extra } });
  }
  function fail(code, origin, extra = {}) {
    const headers = RETRYABLE.has(code) ? { "Retry-After": code === "upstream_rate_limited" || code === "rate_limited" ? "30" : "2", ...extra } : extra;
    return json(STATUS[code], { error: { code, message: MESSAGES[code], retryable: RETRYABLE.has(code) } }, origin, headers);
  }

  // Fixed-window limiter per client in this isolate (Cloudflare runs many isolates, so
  // the Rate Limiting binding, when configured, is the cross-isolate limit).
  function allowLocal(client) {
    const t = now();
    const w = windows.get(client);
    if (!w || t - w.start >= 60000) {
      if (windows.size > 5000) for (const [k, v] of windows) if (t - v.start >= 60000) windows.delete(k);
      windows.set(client, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= LIMITS.perClientPerMinute;
  }

  async function observations(request, env, origin, client) {
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return fail("unsupported_media_type", origin);
    const declared = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return fail("body_too_large", origin);
    const text = await readCapped(request.body, LIMITS.maxBodyBytes);
    if (text === null) return fail("body_too_large", origin);
    let body;
    try { body = JSON.parse(text); } catch (_) { return fail("invalid_request", origin); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== BODY_KEYS.join()) return fail("invalid_request", origin);
    const { series_id: series, observation_start: start, observation_end: end, api_key: key } = body;
    if (typeof series !== "string" || !Object.prototype.hasOwnProperty.call(SERIES, series)) return fail("unknown_series", origin);
    const disabled = new Set(String(env.DISABLED_SERIES || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
    if (disabled.has(series)) return fail("series_disabled", origin);
    // The visitor's current month can already have begun east of UTC (up to UTC+14).
    if (!isoDate(start) || !isoDate(end) || start < LIMITS.minDate || end > endOfCurrentMonth(now() + 14 * 3600000) || start > end) return fail("invalid_dates", origin);
    const kind = SERIES[series];
    if (kind === "monthly" && !start.endsWith("-01")) return fail("invalid_dates", origin);
    if (kind === "daily" && daysBetween(start, end) > LIMITS.maxDailySpanDays) return fail("range_too_large", origin);
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return fail("invalid_key_format", origin);

    if (!allowLocal(client)) return fail("rate_limited", origin);
    if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: client });
        if (!success) return fail("rate_limited", origin);
      } catch (_) { return fail("busy", origin); } // fail closed
    }
    if (isolateInFlight >= LIMITS.perIsolateInFlight) return fail("busy", origin);
    if ((inFlight.get(client) || 0) >= LIMITS.perClientInFlight) return fail("rate_limited", origin);

    // The only upstream request: a fixed URL; parameters set one by one.
    const upstream = new URL(FRED_OBSERVATIONS_URL);
    upstream.searchParams.set("series_id", series);
    upstream.searchParams.set("api_key", key);
    upstream.searchParams.set("file_type", "json");
    upstream.searchParams.set("observation_start", start);
    upstream.searchParams.set("observation_end", end);
    upstream.searchParams.set("sort_order", "asc");
    upstream.searchParams.set("limit", "100000");
    isolateInFlight += 1;
    inFlight.set(client, (inFlight.get(client) || 0) + 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.upstreamTimeoutMs);
    let response;
    let raw;
    try {
      response = await fetchImpl(upstream.toString(), { method: "GET", headers: { Accept: "application/json", "User-Agent": `cpi-data-gateway/${VERSION}` }, redirect: "manual", signal: controller.signal });
      raw = response.status === 200 ? await readCapped(response.body, LIMITS.maxUpstreamBytes) : await readCapped(response.body, 4096);
    } catch (error) {
      const code = controller.signal.aborted ? "upstream_timeout" : "upstream_unavailable";
      log({ event: "upstream_error", code, series, error: error?.name || "Error" }); // never the message: it can contain the URL
      return fail(code, origin);
    } finally {
      clearTimeout(timer);
      isolateInFlight -= 1;
      const left = (inFlight.get(client) || 1) - 1;
      if (left > 0) inFlight.set(client, left); else inFlight.delete(client);
    }

    const status = response.status;
    if (status !== 200) {
      let code = "upstream_rejected";
      if (status >= 300 && status < 400) code = "upstream_invalid"; // redirects are never followed
      else if (status === 429) code = "upstream_rate_limited";
      else if (status === 401 || status === 403) code = "key_rejected";
      else if (status === 400 && /api_key/i.test(raw || "")) code = "key_rejected";
      else if (status >= 500) code = "upstream_unavailable";
      log({ event: "upstream_status", code, series, status });
      return fail(code, origin);
    }
    if (raw === null) { log({ event: "upstream_too_large", series }); return fail("upstream_invalid", origin); }
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { log({ event: "upstream_not_json", series }); return fail("upstream_invalid", origin); }
    const list = payload?.observations;
    if (!Array.isArray(list) || !Number.isInteger(payload.count) || payload.count !== list.length || list.length > LIMITS.maxObservations) {
      log({ event: "upstream_shape", series });
      return fail("upstream_invalid", origin);
    }
    const seen = new Set();
    const out = [];
    for (const o of list) {
      const date = isoDate(o?.date);
      const value = o?.value;
      if (!date || date < start || date > end || seen.has(date) || (kind === "monthly" && !date.endsWith("-01"))
        || typeof value !== "string" || (value !== "." && !DECIMAL.test(value))) {
        log({ event: "upstream_observation", series });
        return fail("upstream_invalid", origin);
      }
      seen.add(date);
      out.push({ date, value: value === "." ? null : value });
    }
    const result = {
      schema: SCHEMA, series_id: series, observation_start: start, observation_end: end, count: out.length, observations: out,
      source: "FRED, Federal Reserve Bank of St. Louis", retrieved_at: new Date(now()).toISOString(),
      notice: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    };
    if (series === "SP500") result.rights = "S&P 500 data: © S&P Dow Jones Indices LLC. Reproduction requires its prior written permission. Retrieved for the requester's own use with the requester's own key; not stored or cached by this gateway.";
    return json(200, result, origin);
  }

  async function handle(request, env = {}) {
    const url = new URL(request.url);
    const origins = parseOrigins(env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(","));
    const originHeader = request.headers.get("Origin");
    const origin = originHeader && origins.has(originHeader) ? originHeader : null;
    if (url.protocol !== "https:" && env.ALLOW_HTTP !== "true") return fail("https_required", origin);
    if (url.search) return fail("invalid_request", origin); // nothing is read from the query string

    if (url.pathname === "/v1/health") {
      if (!["GET", "HEAD"].includes(request.method)) return fail("method_not_allowed", origin, { Allow: "GET, HEAD" });
      return json(200, { status: "ok", service: "cpi-data-gateway", version: VERSION, series: Object.keys(SERIES), limits: { perClientPerMinute: LIMITS.perClientPerMinute, maxDailySpanDays: LIMITS.maxDailySpanDays, minDate: LIMITS.minDate }, disabled: String(env.DISABLED_SERIES || "").split(",").map(s => s.trim().toUpperCase()).filter(s => SERIES[s]) }, origin);
    }
    if (url.pathname !== "/v1/observations") return fail("not_found", origin);
    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method");
      const wanted = String(request.headers.get("Access-Control-Request-Headers") || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
      if (!origin || method !== "POST" || wanted.some(h => h !== "content-type")) return new Response(null, { status: 403, headers: { ...securityHeaders(), Vary: "Origin" } });
      return new Response(null, { status: 204, headers: { ...securityHeaders(), ...corsHeaders(origin), "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } });
    }
    if (request.method !== "POST") return fail("method_not_allowed", origin, { Allow: "POST, OPTIONS" });
    if (!origin) return fail("origin_not_allowed", null);
    const client = await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown");
    return observations(request, env, origin, client);
  }

  return { handle };
}

