// Per-provider request scheduler shared by every market-data adapter.
//
// One scheduler exists per provider and key. It serializes that provider's requests
// in this page and, where the browser supports the Web Locks API, across every
// open tab and tool on this site (the Rebalancer and the Stock tool share a key, so
// they must share its spacing). Timing is kept in local storage under a name that
// carries only the key's fingerprint, never the key, so a second tab waits for the
// first tab's last request.
//
// Rules, each optional:
//   minSpacingMs        minimum time between the START of two requests
//   minGapAfterMs       minimum time between the END of one request and the start of the next
//                       (a slow response must not be followed by an immediate one)
//   perMinute           at most this many request starts in any rolling 60 seconds
//   jitterMs            up to this much random extra wait, so tabs do not fire in lockstep
// The scheduler only spaces requests. Quotas (per day or month) are counted by the
// usage counter and judged by the provider's own answers.

import { DataError } from "./http.js";

const MINUTE = 60000;

const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DataError("Request cancelled.", { kind: "aborted" })); return; }
  const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, Math.max(0, ms));
  const onAbort = () => { clearTimeout(timer); reject(new DataError("Request cancelled.", { kind: "aborted" })); };
  signal?.addEventListener?.("abort", onAbort, { once: true });
});

export function createScheduler({
  name,
  minSpacingMs = 0,
  minGapAfterMs = 0,
  perMinute = null,
  jitterMs = 0,
  storage = null,
  now = () => Date.now(),
  sleep = abortableSleep,
  random = Math.random,
  locks = globalThis.navigator?.locks,
} = {}) {
  if (!name) throw new Error("scheduler needs a name");
  const storageKey = `md.sched.v1.${name}`;
  let memory = { lastStart: 0, lastEnd: 0, starts: [] };
  let chain = Promise.resolve();

  const read = () => {
    if (!storage) return memory;
    try {
      const entry = JSON.parse(storage.getItem(storageKey) || "null");
      if (entry && Number.isFinite(entry.lastStart) && Number.isFinite(entry.lastEnd) && Array.isArray(entry.starts)) return entry;
    } catch (_) { /* unreadable: fall back to this page's own record */ }
    return memory;
  };
  const write = entry => {
    memory = entry;
    if (!storage) return;
    try { storage.setItem(storageKey, JSON.stringify(entry)); } catch (_) { /* spacing still applies in this page */ }
  };

  // Milliseconds to wait before the next start, from the shared record.
  function waitFor(entry, at) {
    let wait = 0;
    if (minSpacingMs) wait = Math.max(wait, entry.lastStart + minSpacingMs - at);
    if (minGapAfterMs && entry.lastEnd) wait = Math.max(wait, entry.lastEnd + minGapAfterMs - at);
    if (perMinute) {
      const recent = entry.starts.filter(t => at - t < MINUTE && t <= at);
      if (recent.length >= perMinute) wait = Math.max(wait, recent[recent.length - perMinute] + MINUTE - at);
    }
    return Math.max(0, wait);
  }

  async function runExclusive(task, signal) {
    for (;;) {
      const at = now();
      const wait = waitFor(read(), at);
      if (wait <= 0) break;
      await sleep(wait + Math.round(random() * jitterMs), signal);
    }
    if (signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted" });
    const startedAt = now();
    const entry = read();
    write({ lastStart: startedAt, lastEnd: entry.lastEnd, starts: [...entry.starts.filter(t => startedAt - t < MINUTE), startedAt].slice(-Math.max(perMinute || 0, 1) * 2) });
    try {
      return await task();
    } finally {
      const after = read();
      write({ ...after, lastEnd: now() });
    }
  }

  function withLock(task, signal) {
    if (!locks?.request) return runExclusive(task, signal);
    // The lock is held while waiting and while the request runs, so no other tab
    // starts a request for this provider and key in the meantime.
    return locks.request(`md-sched:${name}`, { signal }, () => runExclusive(task, signal))
      .catch(error => { if (error?.name === "AbortError") throw new DataError("Request cancelled.", { kind: "aborted" }); throw error; });
  }

  return {
    // Runs task() under the provider's spacing rules. Requests from this page run
    // one at a time, in order.
    run(task, { signal } = {}) {
      const result = chain.then(() => withLock(task, signal));
      chain = result.catch(() => {});
      return result;
    },
    // How long a request started now would wait (for progress messages).
    estimateWaitMs() { return waitFor(read(), now()); },
    get name() { return name; },
  };
}
