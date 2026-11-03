// FRED client for the thirteen US series, through the owner's controlled gateway
// (_services/cpi-data-gateway). FRED's API sends no CORS headers, so a browser cannot
// call it directly; the gateway forwards only the approved series and dates, with the
// visitor's own key, and returns normalized observations.
//
//   * The key travels only in the HTTPS POST body to the gateway (never in a URL),
//     is never stored by this module, and never appears in a result or message.
//   * One gateway request per monthly series (the whole range), and one per window of
//     at most ten years for the three daily series, so each gateway call stays small
//     (Cloudflare Workers Free allows 10 ms of CPU per request).
//   * At most two requests at a time, bounded retries for transient answers, and a
//     rejected key, an unreachable gateway or a refused origin stops every remaining
//     request at once instead of repeating it thirteen times.

import { FRED_SERIES } from "./schema.js";
import { addMonths, lastDayOfMonth, monthsBetween } from "./dates.js";
import { normalizeFredObservations, requestWindow, seriesResult, DataShapeError } from "./engine.js";
import { DataError, createLimiter, fetchText, parseRetryAfter, validateBaseUrl, withRetry } from "../market-data/http.js";

export const FRED_KEY_PATTERN = /^[a-z0-9]{32}$/; // FRED: a 32-character lower-case alphanumeric string
export const DAILY_WINDOW_MONTHS = 120;
export const GATEWAY_SCHEMA = "cpi-data-gateway.observations.v1";
const FATAL = { key_rejected: "key_rejected", invalid_key_format: "key_rejected", origin_not_allowed: "gateway_unavailable", gateway_unavailable: "gateway_unavailable" };
const TRANSIENT = new Set(["rate_limited", "upstream_rate_limited", "upstream_unavailable", "upstream_timeout", "busy"]);

export const validFredKey = key => FRED_KEY_PATTERN.test(String(key || ""));

// The gateway the page uses: the one configured for the site, or a `?gateway=` override
// only when the page itself is served from this computer (127.0.0.1 or localhost), so
// a link can never send production visitors' keys to another server.
export function resolveGateway(configured, location) {
  if (location && ["127.0.0.1", "localhost"].includes(location.hostname)) {
    const override = new URLSearchParams(location.search || "").get("gateway");
    if (override) return override;
  }
  return configured || "";
}

// [{ column, start: YYYY-MM-DD, end: YYYY-MM-DD, months: [YYYY-MM, YYYY-MM] }]
export function planFredRequests(start, end, { today = new Date(), series = FRED_SERIES } = {}) {
  const out = [];
  for (const column of series) {
    const w = requestWindow(column, start, end, { today });
    if (!w) continue;
    if (column.kind === "monthly") { out.push({ column, start: `${w.start}-01`, end: lastDayOfMonth(w.end), months: [w.start, w.end] }); continue; }
    for (let from = w.start; from <= w.end; from = addMonths(from, DAILY_WINDOW_MONTHS)) {
      const to = monthsBetween(from, w.end) > DAILY_WINDOW_MONTHS ? addMonths(from, DAILY_WINDOW_MONTHS - 1) : w.end;
      out.push({ column, start: `${from}-01`, end: lastDayOfMonth(to), months: [from, to] });
    }
  }
  return out;
}

class GatewayError extends DataError {
  constructor(code, message, { status = null, retryAfterMs = null } = {}) {
    super(message, { kind: TRANSIENT.has(code) ? "unavailable" : code === "gateway_unavailable" ? "network" : "http", status, provider: "Data gateway", retryAfterMs });
    this.code = code;
  }
}

const GATEWAY_MESSAGES = {
  key_rejected: "FRED rejected the key. Check that it is your 32-character FRED API key.",
  invalid_key_format: "That is not a FRED API key (32 lower-case letters and digits).",
  origin_not_allowed: "The data gateway does not accept requests from this page.",
  series_disabled: "The gateway operator has disabled this series.",
  rate_limited: "Too many requests to the data gateway; wait a minute and try again.",
  upstream_rate_limited: "FRED is limiting requests for this key; wait a minute and try again.",
  upstream_unavailable: "FRED is temporarily unavailable.",
  upstream_timeout: "FRED did not answer in time.",
  busy: "The data gateway is busy; try again shortly.",
};

export function createFredClient({ gatewayUrl, fetchImpl = globalThis.fetch?.bind(globalThis), sleep, now = () => Date.now(), concurrency = 2, retryBaseMs = 1000 } = {}) {
  const base = validateBaseUrl(gatewayUrl);
  const configured = Boolean(base);

  async function call(path, body, { signal }) {
    let res;
    try {
      res = await fetchText(`${base}${path}`, { fetchImpl, signal, timeoutMs: 30000, maxBytes: 4 * 1024 * 1024, provider: "Data gateway", body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "Content-Type": "application/json" } });
    } catch (error) {
      if (error?.kind === "aborted") throw error;
      if (error?.kind === "too_large") throw new GatewayError("upstream_invalid", "The data gateway response was larger than allowed.");
      throw new GatewayError("gateway_unavailable", "The data gateway could not be reached.");
    }
    let json = null;
    try { json = JSON.parse(res.text); } catch (_) { /* handled below */ }
    if (!res.ok) {
      const code = typeof json?.error?.code === "string" ? json.error.code : res.status === 429 ? "rate_limited" : res.status >= 500 ? "upstream_unavailable" : "invalid_request";
      throw new GatewayError(code, GATEWAY_MESSAGES[code] || `The data gateway refused the request (${code}).`, { status: res.status, retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")) });
    }
    if (!json || typeof json !== "object") throw new GatewayError("upstream_invalid", "The data gateway returned a response that is not JSON.");
    return json;
  }

  async function health({ signal } = {}) {
    if (!configured) return { ok: false, reason: "gateway_not_configured" };
    try {
      const h = await call("/v1/health", undefined, { signal });
      return { ok: h.status === "ok", service: h.service, version: h.version, series: h.series };
    } catch (error) {
      if (error?.kind === "aborted") throw error;
      return { ok: false, reason: "gateway_unavailable", message: error.message };
    }
  }

  // Fetches start..end for the thirteen FRED series. Never throws for a source
  // failure: each series comes back as a seriesResult (with failedRanges for a failed
  // daily window). Throws only when cancelled or when the key is malformed.
  async function fetchRange(start, end, apiKey, { signal, today = new Date(), onProgress } = {}) {
    if (!validFredKey(apiKey)) throw new DataError(GATEWAY_MESSAGES.invalid_key_format, { kind: "auth" });
    const plan = planFredRequests(start, end, { today });
    const raw = Object.fromEntries(FRED_SERIES.map(c => [c.id, { observations: [], failed: [], status: null, message: null }]));
    let fatal = null;
    let done = 0;
    let requests = 0;
    const limit = createLimiter(concurrency);
    await Promise.all(plan.map(req => limit(async () => {
      if (signal?.aborted) return;
      const target = raw[req.column.id];
      if (fatal || target.status) return; // stopped, or this series already failed as a whole
      try {
        const body = await withRetry(async () => {
          if (fatal) throw fatal;
          requests += 1;
          return call("/v1/observations", { series_id: req.column.sourceId, observation_start: req.start, observation_end: req.end, api_key: apiKey }, { signal });
        }, { retries: 2, baseMs: retryBaseMs, maxDelayMs: 10000, signal, ...(sleep ? { sleep } : {}), shouldRetry: e => e instanceof GatewayError && (TRANSIENT.has(e.code) || e.code === "gateway_unavailable") });
        if (body.schema !== GATEWAY_SCHEMA || body.series_id !== req.column.sourceId || body.observation_start !== req.start || body.observation_end !== req.end || !Array.isArray(body.observations)) {
          throw new DataShapeError("the gateway answered for another request");
        }
        // Validated now (dates, values); daily windows are reduced together at the end.
        normalizeFredObservations(body.observations, { kind: req.column.kind, start: req.start, end: req.end });
        target.observations.push(...body.observations);
      } catch (error) {
        if (error?.kind === "aborted" || signal?.aborted) return;
        if (error instanceof GatewayError && FATAL[error.code]) {
          fatal = fatal || Object.assign(error, { reason: FATAL[error.code] });
          return;
        }
        const reason = error instanceof DataShapeError ? "provider_error"
          : error instanceof GatewayError && error.code === "series_disabled" ? "restricted"
            : error instanceof GatewayError && TRANSIENT.has(error.code) ? "source_unavailable" : "provider_error";
        const message = error instanceof DataShapeError ? `FRED ${req.column.sourceId}: unexpected observations (${error.message}).` : `FRED ${req.column.sourceId}: ${error.message}`;
        if (req.column.kind === "monthly" || reason === "restricted") Object.assign(target, { status: reason, message });
        else target.failed.push({ start: req.months[0], end: req.months[1], reason, message });
      } finally {
        done += 1;
        onProgress?.({ done, total: plan.length, label: `FRED ${req.column.sourceId}` });
      }
    })));
    if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted" });
    const retrievedAt = new Date(now()).toISOString();
    const series = {};
    for (const col of FRED_SERIES) {
      const r = raw[col.id];
      const source = { provider: "FRED", id: col.sourceId, retrievedAt, via: "gateway" };
      if (fatal) { series[col.id] = seriesResult({ status: fatal.reason, message: fatal.message, source }); continue; }
      if (r.status) { series[col.id] = seriesResult({ status: r.status, message: r.message, source }); continue; }
      const windows = plan.filter(p => p.column === col);
      if (!windows.length) { series[col.id] = seriesResult({ source }); continue; }
      try {
        const { values, flags } = normalizeFredObservations(r.observations, { kind: col.kind, start: windows[0].start, end: windows.at(-1).end });
        const allFailed = r.failed.length && r.failed.length === windows.length;
        series[col.id] = seriesResult({
          status: allFailed ? r.failed[0].reason : r.failed.length ? "partial" : "ok", message: r.failed[0]?.message || null,
          values, flags, failedRanges: allFailed ? [] : r.failed, source,
          notes: col.restricted ? ["S&P 500 data: © S&P Dow Jones Indices LLC; reproduction requires its permission. Retrieved for your own use with your own FRED key."] : [],
        });
      } catch (error) {
        series[col.id] = seriesResult({ status: "provider_error", message: `FRED ${col.sourceId}: unexpected observations (${error.message}).`, source });
      }
    }
    return { series, requests, planned: plan.length, retrievedAt, stopped: fatal ? { reason: fatal.reason, message: fatal.message } : null };
  }

  return { configured, base, health, fetchRange };
}
