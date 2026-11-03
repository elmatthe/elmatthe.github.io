// Transport utilities shared by every market-data provider (browser and Node tests).
//
// No DOM access: everything here works in a browser, in Node 18+ and in a
// Cloudflare Worker. Providers build on these helpers instead of calling fetch
// directly so that every request has a timeout, a response-size cap, bounded retry
// with jitter, and a single error type the UI can explain.

export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

// kind: network | timeout | http | rate_limited | invalid | not_found | aborted | auth |
//       unavailable | not_configured | too_large | key_changed | entitlement |
//       not_covered | ambiguous | currency_mismatch | provider_notice | superseded |
//       budget_withheld | stale
// rate_limited carries quotaScope: "burst" | "minute" | "daily" | "monthly" | "unknown".
// A burst or per-minute throttle is transient; only a daily or monthly limit stops a
// provider until its reset, and only when the provider's own wording says so.
export class DataError extends Error {
  constructor(message, { kind = "network", status = null, definitive = false, provider = null, retryAfterMs = null, attempts = [], quotaScope = null, notice = null, hint = null, instrument = null, retryable = null } = {}) {
    super(message);
    this.name = "DataError";
    this.kind = kind;
    this.status = status;
    this.definitive = definitive; // the provider answered "no such instrument": retrying elsewhere will not help
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
    this.quotaScope = quotaScope;
    this.notice = notice; // the provider's own wording, key redacted, at most 400 characters
    this.hint = hint; // what the user can do about it
    this.instrument = instrument;
    this.explicitRetryable = retryable;
  }

  get retryable() { return this.explicitRetryable ?? isRetryable(this); }

  // The shared DataError contract (md.data-error.v1), the same shape the desktop apps produce.
  toContract() {
    const kind = this.kind === "rate_limited" ? `quota_${this.quotaScope || "unknown"}` : this.kind === "aborted" ? "cancelled" : this.kind;
    return {
      schema: "md.data-error.v1",
      kind,
      provider: this.provider,
      affectedInstrument: this.instrument,
      retryable: this.retryable,
      retryAfterMs: Number.isFinite(this.retryAfterMs) ? this.retryAfterMs : null,
      redactedNotice: this.notice,
      resolutionHint: this.hint,
      quotaScope: this.quotaScope,
      message: this.message,
    };
  }
}

export function isRetryable(error) {
  if (!(error instanceof DataError) || error.definitive) return false;
  if (error.kind === "rate_limited") return error.quotaScope !== "daily" && error.quotaScope !== "monthly";
  return ["network", "timeout", "unavailable", "provider_notice"].includes(error.kind);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function linkSignals(outer, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DataError("timed out", { kind: "timeout" })), ms);
  const onAbort = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: controller.signal, done: () => { clearTimeout(timer); outer?.removeEventListener("abort", onAbort); } };
}

// Reads a response body as text, refusing bodies larger than maxBytes.
async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DataError(`response too large (${declared} bytes)`, { kind: "too_large" });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (text.length > maxBytes) throw new DataError("response too large", { kind: "too_large" });
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* already closed */ }
      throw new DataError("response too large", { kind: "too_large" });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// GET (or, with `body`, POST) a URL and return { status, ok, text, headers }. Network
// failures, timeouts and aborts become DataError; HTTP error statuses are returned for
// the caller to judge. Requests never carry cookies or a referrer.
export async function fetchText(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, headers = {}, provider = null, body = undefined } = {}) {
  if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted", provider });
  const timer = linkSignals(signal, timeoutMs);
  try {
    let response;
    try {
      const init = { signal: timer.signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json", ...headers } };
      if (body !== undefined) Object.assign(init, { method: "POST", body, cache: "no-store" });
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted", provider });
      if (timer.signal.aborted) throw new DataError("timed out", { kind: "timeout", provider });
      // Browsers report CORS refusals and DNS/connection failures identically.
      throw new DataError("network or CORS error", { kind: "network", provider });
    }
    let text;
    try {
      text = await readBounded(response, maxBytes);
    } catch (error) {
      if (error instanceof DataError) { error.provider = provider; throw error; }
      if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted", provider });
      if (timer.signal.aborted) throw new DataError("timed out", { kind: "timeout", provider });
      throw new DataError("connection closed while reading the response", { kind: "network", provider });
    }
    return { status: response.status, ok: response.ok, text, headers: response.headers };
  } finally {
    timer.done();
  }
}

// Turns a non-OK HTTP status into a DataError.
export function httpError(status, { provider = null, headers = null, text = "" } = {}) {
  const lower = String(text).slice(0, 300).toLowerCase();
  if (status === 429 || lower.includes("too many requests") || lower.includes("rate limit")) {
    return new DataError("rate limited by the data provider", { kind: "rate_limited", quotaScope: "unknown", status, provider, retryAfterMs: parseRetryAfter(headers?.get?.("retry-after")) });
  }
  if (status === 404) return new DataError("not found", { kind: "not_found", status, provider });
  if (status === 401 || status === 403) return new DataError(`access refused (HTTP ${status})`, { kind: "http", status, provider });
  return new DataError(`HTTP ${status}`, { kind: status >= 500 ? "unavailable" : "http", status, provider });
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DataError("Request cancelled.", { kind: "aborted" })); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new DataError("Request cancelled.", { kind: "aborted" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

// Exponential backoff with full jitter, bounded in attempts and delay. A provider's
// Retry-After is honoured up to maxDelayMs; longer waits are not attempted.
export function backoffDelay(attempt, { baseMs = 500, maxDelayMs = 5000, random = Math.random } = {}) {
  const ceiling = Math.min(maxDelayMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

export async function withRetry(task, { retries = 2, baseMs = 500, maxDelayMs = 5000, signal, random = Math.random, sleep = defaultSleep, shouldRetry = isRetryable, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await task(attempt);
    } catch (error) {
      if (signal?.aborted || error?.kind === "aborted") throw error;
      if (attempt >= retries || !shouldRetry(error)) throw error;
      let delay = backoffDelay(attempt, { baseMs, maxDelayMs, random });
      if (Number.isFinite(error.retryAfterMs)) {
        if (error.retryAfterMs > maxDelayMs) throw error; // provider asked for a longer pause than we will wait
        delay = Math.max(delay, error.retryAfterMs);
      }
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}

// Shares one in-flight promise per key so duplicate requests (two rows with the
// same ticker, a double click) cost a single network call.
export function createDeduper() {
  const inflight = new Map();
  return {
    run(key, task) {
      if (inflight.has(key)) return inflight.get(key);
      const promise = Promise.resolve().then(task).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    get size() { return inflight.size; },
  };
}

// Runs at most `limit` tasks at once.
export function createLimiter(limit = 2) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

// Validates an owner- or viewer-supplied base URL: https only (or loopback for
// local testing), no credentials, no query or fragment.
export function validateBaseUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch (_) { return null; }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, "");
}
