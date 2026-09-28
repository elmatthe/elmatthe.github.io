// Resilient browser CORS-proxy pipeline for Yahoo Finance requests.
//
// Yahoo Finance does not send CORS headers, so a static GitHub Pages site can only
// read it through a proxy. Public proxies come and go (corsproxy.io stopped serving
// anonymous requests in 2026 and now needs an API key), so every request walks an
// ordered chain, validates the body instead of trusting HTTP 200, and puts failing
// proxies on a cooldown so later requests skip them immediately.
//
// Viewer-specific settings (an optional corsproxy.io key or a self-hosted proxy)
// live in this browser's localStorage only.

const SETTINGS_KEY = "sdd.proxy.settings.v1";
const HEALTH_KEY = "sdd.proxy.health.v1";
const PREFERRED_TTL_MS = 24 * 3600000;
const DEFAULT_TIMEOUT_MS = 10000;
const COOLDOWN_MS = { failure: 60000, rateLimited: 300000, rejected: 30 * 60000, recentlyWorking: 15000 };
const RECENT_SUCCESS_MS = 5 * 60000;

export class FetchError extends Error {
  constructor(message, { kind = "network", status = null, definitive = false, attempts = [] } = {}) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;            // network | timeout | http | rate_limited | invalid | not_found | aborted | unavailable
    this.status = status;
    this.definitive = definitive; // upstream said "no such symbol": trying other proxies will not help
    this.attempts = attempts;
  }
}

const enc = encodeURIComponent;

export const PROXIES = [
  {
    id: "site",
    label: "Site proxy",
    build: (url, settings) => settings.siteTemplate.replace("{url}", enc(url)),
    available: settings => Boolean(settings.siteTemplate),
    note: "Proxy configured by the site owner (data-site-proxy on the page).",
  },
  {
    id: "custom",
    label: "Custom proxy (Settings)",
    build: (url, settings) => settings.customTemplate.replace("{url}", enc(url)),
    available: settings => Boolean(settings.customTemplate),
    note: "Your own proxy URL template, e.g. a Cloudflare Worker.",
  },
  {
    id: "corsproxy",
    label: "corsproxy.io",
    build: (url, settings) => settings.corsproxyKey
      ? `https://corsproxy.io/?key=${enc(settings.corsproxyKey)}&url=${enc(url)}`
      : `https://corsproxy.io/?url=${enc(url)}`,
    available: () => true,
    note: "Requires a free API key since 2026; anonymous requests are rejected.",
  },
  {
    id: "allorigins-raw",
    label: "AllOrigins (raw)",
    build: url => `https://api.allorigins.win/raw?url=${enc(url)}`,
    available: () => true,
  },
  {
    id: "allorigins-json",
    label: "AllOrigins (JSON wrapper)",
    build: url => `https://api.allorigins.win/get?url=${enc(url)}`,
    unwrap: body => {
      const wrapper = JSON.parse(body);
      if (typeof wrapper?.contents !== "string") throw new Error("missing contents");
      return wrapper.contents;
    },
    available: () => true,
  },
  {
    id: "codetabs",
    label: "CodeTabs",
    build: url => `https://api.codetabs.com/v1/proxy/?quest=${enc(url)}`,
    available: () => true,
  },
  {
    id: "corslol",
    label: "cors.lol",
    build: url => `https://api.cors.lol/?url=${enc(url)}`,
    available: () => true,
  },
];

function safeStorage() {
  try { return window.localStorage; } catch (_) { return null; }
}

export function loadSettings() {
  const defaults = { customTemplate: "", corsproxyKey: "", disabled: [] };
  try {
    const raw = safeStorage()?.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      customTemplate: validateTemplate(parsed.customTemplate || "") ? parsed.customTemplate : "",
      corsproxyKey: typeof parsed.corsproxyKey === "string" ? parsed.corsproxyKey.slice(0, 200) : "",
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter(id => typeof id === "string") : [],
    };
  } catch (_) {
    return defaults;
  }
}

export function saveSettings(settings) {
  try { safeStorage()?.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; } catch (_) { return false; }
}

// A custom template must be an https URL containing a single {url} placeholder.
export function validateTemplate(template) {
  if (!template) return true;
  if (typeof template !== "string" || template.split("{url}").length !== 2) return false;
  try {
    const parsed = new URL(template.replace("{url}", "x"));
    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch (_) {
    return false;
  }
}

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); },
  };
}

export class ProxyPipeline {
  constructor({ fetchImpl = (...args) => window.fetch(...args), now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS, siteTemplate = "" } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.siteTemplate = siteTemplate && validateTemplate(siteTemplate) ? siteTemplate : "";
    this.settings = { ...loadSettings(), siteTemplate: this.siteTemplate };
    this.health = new Map(PROXIES.map(p => [p.id, { state: "untested", cooldownUntil: 0, lastError: null, lastLatencyMs: null, successes: 0, failures: 0, lastSuccessAt: 0 }]));
    this.preferred = null;
    this.listeners = new Set();
    this.restoreHealth();
  }

  // Remembering cooldowns and the last working proxy across visits means a returning
  // viewer goes straight to a proxy that works instead of re-trying dead ones.
  restoreHealth() {
    try {
      const saved = JSON.parse(safeStorage()?.getItem(HEALTH_KEY) || "null");
      if (!saved) return;
      const now = this.now();
      if (typeof saved.preferred === "string" && this.health.has(saved.preferred) && now - saved.savedAt < PREFERRED_TTL_MS) {
        this.preferred = saved.preferred;
      }
      for (const [id, entry] of Object.entries(saved.cooldowns || {})) {
        if (this.health.has(id) && entry.until > now) {
          Object.assign(this.health.get(id), { state: String(entry.state || "failing"), cooldownUntil: entry.until, lastError: String(entry.error || "") });
        }
      }
    } catch (_) { /* optional convenience */ }
  }

  persistHealth() {
    const cooldowns = {};
    this.health.forEach((entry, id) => {
      if (entry.cooldownUntil > this.now()) cooldowns[id] = { until: entry.cooldownUntil, state: entry.state, error: entry.lastError };
    });
    try { safeStorage()?.setItem(HEALTH_KEY, JSON.stringify({ savedAt: this.now(), preferred: this.preferred, cooldowns })); } catch (_) { /* optional */ }
  }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { this.listeners.forEach(listener => { try { listener(this.snapshot()); } catch (_) { /* UI listener errors never break fetching */ } }); }

  updateSettings(next) {
    this.settings = { ...this.settings, ...next, siteTemplate: this.siteTemplate };
    const { siteTemplate, ...viewerSettings } = this.settings;
    saveSettings(viewerSettings);
    // A new key or template deserves a fresh chance.
    ["custom", "corsproxy"].forEach(id => Object.assign(this.health.get(id), { state: "untested", cooldownUntil: 0, lastError: null }));
    this.persistHealth();
    this.emit();
  }

  resetHealth() {
    this.health.forEach(entry => Object.assign(entry, { state: "untested", cooldownUntil: 0, lastError: null }));
    this.preferred = null;
    this.persistHealth();
    this.emit();
  }

  isEnabled(proxy) {
    return proxy.available(this.settings) && !this.settings.disabled.includes(proxy.id);
  }

  snapshot() {
    const now = this.now();
    return PROXIES.map(proxy => {
      const health = this.health.get(proxy.id);
      return {
        id: proxy.id, label: proxy.label, note: proxy.note || "",
        enabled: this.isEnabled(proxy), configured: proxy.available(this.settings),
        state: health.state, lastError: health.lastError, lastLatencyMs: health.lastLatencyMs,
        coolingDownFor: Math.max(0, health.cooldownUntil - now), preferred: this.preferred === proxy.id,
        successes: health.successes, failures: health.failures,
      };
    });
  }

  recentlyWorked(proxy) {
    const at = this.health.get(proxy.id).lastSuccessAt;
    return at > 0 && this.now() - at < RECENT_SUCCESS_MS;
  }

  // `retry` lets a retry pass reuse proxies that worked in the last few minutes even
  // while they sit in a short cooldown (typically a burst rate limit).
  orderedCandidates({ retry = false } = {}) {
    const now = this.now();
    const enabled = PROXIES.filter(p => this.isEnabled(p));
    const ready = enabled.filter(p => this.health.get(p.id).cooldownUntil <= now || (retry && this.recentlyWorked(p)));
    // Owner/viewer-controlled proxies always lead; then the proxy that last worked.
    ready.sort((a, b) => {
      const rank = p => (p.id === "site" ? -3 : p.id === "custom" ? -2 : p.id === this.preferred ? -1 : PROXIES.indexOf(p));
      return rank(a) - rank(b);
    });
    return { ready, enabled };
  }

  markFailure(proxy, kind, message) {
    const health = this.health.get(proxy.id);
    health.failures += 1;
    health.lastError = message;
    let cooldown = COOLDOWN_MS.failure;
    if (kind === "rate_limited") cooldown = COOLDOWN_MS.rateLimited;
    if (kind === "rejected") cooldown = COOLDOWN_MS.rejected;
    else if (this.recentlyWorked(proxy)) cooldown = COOLDOWN_MS.recentlyWorking;
    health.state = kind === "rejected" ? "needs-key" : kind === "rate_limited" ? "rate-limited" : "failing";
    health.cooldownUntil = this.now() + cooldown;
    if (this.preferred === proxy.id) this.preferred = null;
    this.persistHealth();
  }

  markSuccess(proxy, latency) {
    Object.assign(this.health.get(proxy.id), { state: "ok", cooldownUntil: 0, lastError: null, lastLatencyMs: latency, lastSuccessAt: this.now() });
    this.health.get(proxy.id).successes += 1;
    this.preferred = proxy.id;
    this.persistHealth();
  }

  // Fetches `targetUrls` (alternates for the same resource, e.g. query1/query2 hosts)
  // through the proxy chain. `validate(text)` must return parsed data, or throw a
  // FetchError (definitive for "symbol not found") / any Error for a bad body.
  // `only` probes a single proxy regardless of its cooldown (used by Settings tests).
  async fetchValidated(targetUrls, validate, { signal, onAttempt, only, retry = false } = {}) {
    const urls = Array.isArray(targetUrls) ? targetUrls : [targetUrls];
    let { ready, enabled } = this.orderedCandidates({ retry });
    if (only) {
      enabled = PROXIES.filter(p => p.id === only && p.available(this.settings));
      ready = enabled;
    }
    const attempts = [];
    if (!enabled.length) {
      throw new FetchError("Every data proxy is disabled in Settings.", { kind: "unavailable" });
    }
    if (!ready.length) {
      const wait = Math.min(...enabled.map(p => this.health.get(p.id).cooldownUntil)) - this.now();
      throw new FetchError(`All data proxies failed recently; the next retry is available in ${Math.ceil(wait / 1000)}s.`, { kind: "unavailable" });
    }
    let hostIndex = 0;
    for (const proxy of ready) {
      if (signal?.aborted) throw new FetchError("Request cancelled.", { kind: "aborted" });
      const target = urls[hostIndex % urls.length];
      const started = this.now();
      onAttempt?.(proxy);
      const timer = withTimeout(signal, this.timeoutMs);
      try {
        let response;
        try {
          response = await this.fetchImpl(proxy.build(target, this.settings), {
            signal: timer.signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" },
          });
        } catch (error) {
          if (signal?.aborted) throw new FetchError("Request cancelled.", { kind: "aborted" });
          const timedOut = timer.signal.aborted;
          throw new FetchError(timedOut ? "timed out" : "network or CORS error", { kind: timedOut ? "timeout" : "network" });
        }
        const text = await response.text();
        if (!response.ok) {
          const lower = text.slice(0, 400).toLowerCase();
          if (proxy.id === "corsproxy" && (response.status === 401 || response.status === 403)) {
            throw new FetchError(this.settings.corsproxyKey ? "API key rejected" : "API key required", { kind: "rejected", status: response.status });
          }
          if (response.status === 429 || lower.includes("too many requests") || lower.includes("rate limit")) {
            hostIndex += 1; // the other Yahoo host may not be throttled for the next proxy
            throw new FetchError("rate limited", { kind: "rate_limited", status: response.status });
          }
          // Yahoo's own 404 body is JSON describing the symbol; let the validator judge it.
          if (response.status !== 404 || !text.trim().startsWith("{")) {
            throw new FetchError(`HTTP ${response.status}`, { kind: "http", status: response.status });
          }
        }
        let body = text;
        if (proxy.unwrap) {
          try { body = proxy.unwrap(text); } catch (_) { throw new FetchError("unexpected proxy wrapper", { kind: "invalid" }); }
        }
        let data;
        try {
          data = validate(body.replace(/^﻿/, "").trim());
        } catch (error) {
          if (error instanceof FetchError && error.definitive) {
            this.markSuccess(proxy, this.now() - started); // the proxy worked; the symbol did not
            this.emit();
            error.attempts = attempts;
            throw error;
          }
          throw new FetchError(error?.message || "unexpected response body", { kind: "invalid" });
        }
        this.markSuccess(proxy, this.now() - started);
        this.emit();
        return { data, proxy: { id: proxy.id, label: proxy.label }, attempts };
      } catch (error) {
        if (error instanceof FetchError && (error.definitive || error.kind === "aborted")) throw error;
        const kind = error instanceof FetchError ? error.kind : "network";
        attempts.push({ proxy: proxy.label, kind, message: error.message });
        this.markFailure(proxy, kind, error.message);
        this.emit();
      } finally {
        timer.done();
      }
    }
    throw new FetchError(describeFailure(attempts), { kind: "unavailable", attempts });
  }
}

export function describeFailure(attempts) {
  if (!attempts.length) return "No data proxy could be reached.";
  const details = attempts.map(a => `${a.proxy}: ${a.message}`).join("; ");
  return `No data proxy returned usable data (${details}).`;
}
