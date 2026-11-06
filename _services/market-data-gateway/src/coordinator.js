// The upstream coordinator: the only code in this Worker that contacts the data source.
//
// One Durable Object (one object worldwide, addressed by the source's name; ./worker.js)
// runs this class, and every isolate of the Worker asks it for upstream data. Everything
// that protects the data source is decided here, against one persisted state:
//
//   * a stop (cooldown deadline, or a halt that needs the owner's reactivation);
//   * one actual start per second, first come first served, at most 2 in flight;
//   * at most 20 actual starts in any 60 seconds;
//   * one upstream request for identical concurrent requests.
//
// Why the coordinator makes the request itself, instead of granting permission to a Worker:
// a grant can be used late. A Worker that resumes after a stop was recorded would still
// start its request, which is the failure this design exists to remove. Here the decision,
// its write and the start of the request happen in one uninterrupted synchronous step (see
// the admission block in `run`), and a Durable Object runs one piece of JavaScript at a
// time, so no stop can be recorded between the decision and the start.
//
// Why state changes are synchronous: `state` is only ever read, changed and written with no
// `await` in between, so concurrent requests cannot lose each other's updates, and a
// deadline only ever moves later (`applyStop`).
//
// The admission write also protects the start: the runtime holds an outgoing fetch() until
// earlier writes are confirmed, and discards it and restarts the object if a write fails.
//
// Fail closed: state that cannot be read, is not well formed or cannot be written means no
// upstream request (`coordinator_unavailable`, which the Worker answers as `busy`).
//
// This file has no Cloudflare import so it can run in Node for fast tests; the real runtime
// is covered by _tools/tests/worker-runtime/.

import { parseSymbol } from "./venues.js";
import { UpstreamError, chartUrl } from "./yahoo-chart.js";

export const VERSION = "1.3.0";

export const UPSTREAM_LIMITS = Object.freeze({
  maxUpstreamBytes: 2 * 1024 * 1024,
  upstreamTimeoutMs: 8000,
  upstreamPerMinute: 20, // actual starts in any 60 seconds, worldwide
  upstreamInFlight: 2,
  upstreamMinSpacingMs: 1000, // between two actual starts, worldwide
  upstreamQueueMaxWaitMs: 15000, // a request waits at most this long for its turn
  upstreamQueuePollMs: 200, // how often a waiting request looks again
  upstreamLeaseGraceMs: 2000, // an in-flight place is reclaimed this long after its timeout
});
const BUDGET_WINDOW_MS = 60000;

// After the data source refuses the gateway, no upstream request is sent for this long
// (seconds). Answers already cached are still served.
export const COOLDOWN_SECONDS = Object.freeze({ upstream_rate_limited: 900, upstream_blocked: 1800, upstream_unavailable: 120 });
// The longest wait the gateway keeps by itself. A longer Retry-After from the data source
// is never shortened into an early retry: the source stays halted until the owner
// reactivates it with a new UPSTREAM_REACTIVATION_ID.
export const MAX_COOLDOWN_SECONDS = 86400;
// Consecutive 5xx / timeout / network failures before the short cooldown starts.
export const FAILURES_BEFORE_COOLDOWN = 3;

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

/* ---------------- persisted state ---------------- */
// cooldownUntil  absolute deadline in ms (only ever moves later); 0 when none was recorded
// cooldownCode   the refusal behind that deadline
// haltCode       set: no upstream request until a new reactivation id, whatever the clock says
// failures       consecutive 5xx / timeout / network failures
// starts         times of the actual starts in the last minute (spacing and budget)
const EMPTY_STATE = Object.freeze({ cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: Object.freeze([]), unresolved: Object.freeze([]) });

const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isStopCode = value => Object.hasOwn(COOLDOWN_SECONDS, value);
function verifiedState(state) {
  if (state === null || state === undefined) return EMPTY_STATE; // a coordinator that never recorded anything
  // Non-SQL adapters can still supply the old shape. SQLite migration is conservative below.
  const unresolved = state.unresolved ?? (Object.hasOwn(state, "unresolved") ? null : []);
  const wellFormed = isTime(state.cooldownUntil)
    && (state.cooldownCode === null ? state.cooldownUntil === 0 : isStopCode(state.cooldownCode))
    && (state.haltCode === null || isStopCode(state.haltCode))
    && isTime(state.failures)
    && Array.isArray(state.starts) && state.starts.every(isTime)
    && Array.isArray(unresolved) && unresolved.length <= UPSTREAM_LIMITS.upstreamInFlight
    && unresolved.every(marker => marker && typeof marker.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(marker.id)
      && isTime(marker.startedAt) && state.starts.includes(marker.startedAt))
    && new Set(unresolved.map(marker => marker.id)).size === unresolved.length;
  if (!wellFormed) throw new Error("coordinator state is not well formed");
  return { ...state, unresolved };
}

// The Durable Object's SQLite storage (ctx.storage). Every call is synchronous and throws on
// failure (a full database, an exhausted daily allowance).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS coordinator_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cooldown_until INTEGER NOT NULL,
    cooldown_code TEXT,
    halt_code TEXT,
    failures INTEGER NOT NULL,
    starts TEXT NOT NULL,
    unresolved TEXT NOT NULL DEFAULT '[]'
  )`,
  "CREATE TABLE IF NOT EXISTS reactivation_ids (id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL)",
];
const UPSERT_STATE = `INSERT INTO coordinator_state (id, cooldown_until, cooldown_code, halt_code, failures, starts, unresolved)
  VALUES (1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET cooldown_until = excluded.cooldown_until, cooldown_code = excluded.cooldown_code,
    halt_code = excluded.halt_code, failures = excluded.failures, starts = excluded.starts, unresolved = excluded.unresolved`;
export function sqlStorage(storage) {
  const { sql } = storage;
  const upsert = state => sql.exec(UPSERT_STATE, state.cooldownUntil, state.cooldownCode, state.haltCode, state.failures, JSON.stringify(state.starts), JSON.stringify(state.unresolved ?? []));
  return {
    read() {
      for (const statement of SCHEMA) sql.exec(statement);
      if (!sql.exec("PRAGMA table_info(coordinator_state)").toArray().some(column => column.name === "unresolved")) {
        storage.transactionSync(() => {
          sql.exec("ALTER TABLE coordinator_state ADD COLUMN unresolved TEXT NOT NULL DEFAULT '[]'");
          // R3 cannot establish which recorded starts finished. Do not silently bless them.
          const [legacy] = sql.exec("SELECT starts FROM coordinator_state WHERE id = 1").toArray();
          if (legacy) {
            const starts = JSON.parse(legacy.starts);
            if (!Array.isArray(starts) || !starts.every(isTime)) throw new Error("invalid legacy starts");
            if (starts.length) sql.exec("UPDATE coordinator_state SET unresolved = ? WHERE id = 1", JSON.stringify([{ id: "legacy-outcome", startedAt: starts.at(-1) }]));
          }
        });
      }
      const [row] = sql.exec("SELECT cooldown_until, cooldown_code, halt_code, failures, starts, unresolved FROM coordinator_state WHERE id = 1").toArray();
      const seen = sql.exec("SELECT id FROM reactivation_ids").toArray().map(r => r.id);
      if (!row) return { state: null, seen };
      return { state: { cooldownUntil: row.cooldown_until, cooldownCode: row.cooldown_code, haltCode: row.halt_code, failures: row.failures, starts: JSON.parse(row.starts), unresolved: JSON.parse(row.unresolved) }, seen };
    },
    write: state => upsert(state).rowsWritten,
    // One transaction: an id is never recorded as used unless its effect is recorded too.
    reactivate(state, id, at) {
      storage.transactionSync(() => {
        sql.exec("INSERT INTO reactivation_ids (id, first_seen_at) VALUES (?, ?)", id, at);
        upsert(state);
      });
    },
  };
}

/* ---------------- the coordinator ---------------- */
const REACTIVATION_ID = /^[A-Za-z0-9._-]{1,40}$/;
export const COORDINATOR_UNAVAILABLE = "coordinator_unavailable";
const UNVERIFIED_RETRY_SECONDS = 60;
export { UNVERIFIED_RETRY_SECONDS };

function statusCode(status) {
  if (status >= 300 && status < 400) return "upstream_invalid"; // redirects are never followed
  if (status === 429) return "upstream_rate_limited";
  if (status === 401 || status === 403) return "upstream_blocked";
  if (status >= 500) return "upstream_unavailable";
  return "upstream_rejected";
}

export class UpstreamCoordinatorCore {
  constructor({ storage, env = {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = entry => console.log(JSON.stringify(entry)), limits = {} }) {
    this.storage = storage;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    this.L = { ...UPSTREAM_LIMITS, ...limits };
    this.state = null; // loaded on first use; null means not verified yet
    this.seen = new Set();
    this.unsaved = false; // a known state/outcome is held in memory but its write failed
    this.quarantine = new Set(); // inherited or locally unknown outcomes; never expires
    this.queue = []; // works waiting for their turn, first come first served
    this.leases = new Set(); // places in flight
    this.works = new Map(); // upstream URL -> the work identical requests share
    this.clients = new Map(); // client id -> the work it is waiting for
  }

  /* ---------------- state ---------------- */
  // Throws when the state cannot be verified; callers refuse in that case.
  ready() {
    if (!this.state) {
      const { state, seen } = this.storage.read();
      // Reactivation always writes its state and history together. History without the
      // state row is lost/corrupt storage, not a pristine coordinator.
      if (state == null && seen.length) throw new Error("coordinator state missing");
      this.state = verifiedState(state);
      this.seen = new Set(seen);
      this.quarantine = new Set(this.state.unresolved.map(marker => marker.id));
    }
    if (this.unsaved) {
      this.storage.write(this.state);
      this.unsaved = false;
    }
    this.inFlightAt(this.now());
    this.applyReactivation();
    if (this.quarantine.size) throw new Error("unresolved upstream outcome");
  }

  // UPSTREAM_REACTIVATION_ID is single use. A value this coordinator has never seen ends a
  // halt, and is recorded in the same transaction. A value it has seen does nothing, ever:
  // leaving the value in place cannot authorize a later halt, and a rollback that restores
  // an older value cannot end one. An empty or malformed value does nothing. Halts and
  // quarantined uncertainty can be ended; an ordinary cooldown runs to its deadline.
  applyReactivation() {
    const id = String(this.env.UPSTREAM_REACTIVATION_ID ?? "").trim();
    if (!REACTIVATION_ID.test(id) || this.seen.has(id)) return;
    // Never release a still-running local request with an owner identifier. Observe and
    // consume identifiers during healthy operation so they cannot authorize later loss.
    if (this.quarantine.size && this.leases.size) throw new Error("upstream work still active");
    const next = { ...this.state, haltCode: null, unresolved: this.state.unresolved.filter(marker => !this.quarantine.has(marker.id)) };
    this.storage.reactivate(next, id, this.now());
    const ended = this.state.haltCode !== null;
    this.seen.add(id);
    this.state = next;
    this.quarantine.clear();
    if (ended) this.log({ event: "source_reactivated" });
  }

  currentStop(t = this.now()) {
    const { haltCode, cooldownUntil, cooldownCode } = this.state;
    if (haltCode) return { code: haltCode, halted: true, retryAfterSeconds: MAX_COOLDOWN_SECONDS };
    if (cooldownUntil > t) return { code: cooldownCode, halted: false, retryAfterSeconds: Math.ceil((cooldownUntil - t) / 1000) };
    return null;
  }

  // Memory first: a stop holds in this object even if writing it fails. The failure makes
  // `ready` refuse everything until the write succeeds.
  commitOutcome(next) {
    this.state = next;
    try {
      this.storage.write(next);
      this.unsaved = false;
      return true;
    } catch (_) {
      this.unsaved = true;
      this.log({ event: "coordinator_write_failed" });
      return false;
    }
  }

  // A deadline only ever moves later, whichever refusal is recorded first; a halt stays
  // until it is reactivated, and an ordinary cooldown recorded under it does not touch it.
  // `directedUntil` is the data source's own Retry-After, as an absolute time.
  applyStop(state, code, directedUntil, useMinimum) {
    const t = this.now();
    const directed = directedUntil ?? 0;
    const halts = directed - t > MAX_COOLDOWN_SECONDS * 1000;
    const until = Math.max(useMinimum ? t + COOLDOWN_SECONDS[code] * 1000 : 0, halts ? 0 : directed);
    const next = { ...state };
    if (until > next.cooldownUntil) {
      next.cooldownUntil = until;
      next.cooldownCode = code;
      this.log({ event: "cooldown_started", code, seconds: Math.ceil((until - t) / 1000) });
    }
    if (halts && !next.haltCode) {
      next.haltCode = code;
      this.log({ event: "cooldown_started", code, seconds: null, halted: true });
    }
    return next;
  }

  // Updates the circuit breaker after an upstream outcome (a code, or null for a real success).
  recordOutcome(code, directedUntil = null, admissionId = null, unknown = false) {
    const state = this.state;
    let next;
    if (code === "upstream_rate_limited" || code === "upstream_blocked") {
      next = this.applyStop({ ...state, failures: 0 }, code, directedUntil, true);
    } else if (code === "upstream_unavailable" || code === "upstream_timeout") {
      const failures = state.failures + 1;
      if (failures >= FAILURES_BEFORE_COOLDOWN) next = this.applyStop({ ...state, failures: 0 }, "upstream_unavailable", directedUntil, true);
      // One outage that names its own wait is honoured for that wait, without the minimum.
      else if (directedUntil !== null) next = this.applyStop({ ...state, failures }, "upstream_unavailable", directedUntil, false);
      else next = { ...state, failures };
    } else if (code === null) {
      next = { ...state, failures: 0 };
    } else {
      // Any other refusal (a redirect, a 400, a 404). It does not end a run of failures; only a
      // real success does. A wait the source names is honoured whatever the status.
      next = directedUntil === null ? { ...state } : this.applyStop(state, "upstream_unavailable", directedUntil, false);
    }
    if (admissionId !== null) {
      if (!state.unresolved.some(marker => marker.id === admissionId)) return false;
      if (unknown) this.quarantine.add(admissionId);
      else {
        next.unresolved = state.unresolved.filter(marker => marker.id !== admissionId);
        this.quarantine.delete(admissionId);
      }
    }
    return this.commitOutcome(next);
  }

  /* ---------------- answers ---------------- */
  stopReply(code, stop) {
    return { code, cooling: true, halted: stop.halted, retryAfterSeconds: stop.retryAfterSeconds };
  }
  // A refusal answered while the source is stopped carries the time really left. An unknown
  // symbol is the one answer that says nothing about waiting.
  refusalReply(code) {
    const stop = code === "symbol_not_found" ? null : this.currentStop();
    return stop ? this.stopReply(code, stop) : { code };
  }

  /* ---------------- the methods the Worker calls ---------------- */
  // { kind, symbol, range, client } -> { text, retrievedAt, shared } or { code, ... }.
  // `client` identifies this caller for `cancel`.
  async fetchChart({ kind, symbol, range = null, client }) {
    try {
      this.ready();
    } catch (_) {
      this.log({ event: "coordinator_state_unverified" });
      return { code: COORDINATOR_UNAVAILABLE };
    }
    const stop = this.currentStop();
    if (stop) return this.stopReply(stop.code, stop);
    // The Worker has checked these already; the coordinator never takes a URL from anyone.
    const parsed = parseSymbol(symbol);
    if (parsed.error) return { code: parsed.error };
    let url;
    try { url = chartUrl(parsed.symbol, { kind, range }); } catch (error) { return { code: error instanceof UpstreamError ? error.code : "invalid_request" }; }

    let work = this.works.get(url);
    // Work past every limit can no longer produce an answer: its wake never came, or its
    // request never settled. Nobody joins it, or everyone after it would wait for nothing.
    if (work && this.now() > work.staleAt) {
      this.drop(work, "throttled");
      work = null;
    }
    const shared = Boolean(work);
    if (!work) {
      work = this.enqueue(url, parsed.mic);
      if (!work) return { code: "throttled" };
    }
    work.clients.add(client);
    this.clients.set(client, work);
    try {
      const reply = await work.promise;
      return reply.code ? reply : { ...reply, shared };
    } finally {
      work.clients.delete(client);
      this.clients.delete(client);
    }
  }

  // Queued work can be discarded. An admitted abort says nothing about the provider's
  // outcome: retain its marker and quarantine until the outcome is known or the owner acts.
  cancel(client) {
    const work = this.clients.get(client);
    if (!work) return;
    work.clients.delete(client);
    this.clients.delete(client);
    if (work.clients.size === 0) this.drop(work, "cancelled");
  }

  // `reason` is what anyone still waiting for this work is told.
  drop(work, reason) {
    work.dropped = reason;
    if (this.works.get(work.url) === work) this.works.delete(work.url);
    this.leaveQueue(work);
    if (work.admissionId && this.state.unresolved.some(marker => marker.id === work.admissionId)) this.quarantine.add(work.admissionId);
    work.controller.abort();
  }

  status() {
    try {
      this.ready();
    } catch (_) {
      this.log({ event: "coordinator_state_unverified" });
      return { state: "unverified", code: null, retryAfterSeconds: UNVERIFIED_RETRY_SECONDS, reason: "coordinator_state_unverified" };
    }
    const stop = this.currentStop();
    if (!stop) return { state: "ok", code: null, retryAfterSeconds: 0 };
    if (stop.halted) return { state: "halted", code: stop.code, retryAfterSeconds: stop.retryAfterSeconds, manualReactivationRequired: true };
    return { state: "cooling_down", code: stop.code, retryAfterSeconds: stop.retryAfterSeconds };
  }

  /* ---------------- the queue ---------------- */
  spacingLeft(t) {
    const last = this.state.starts.at(-1);
    return last === undefined ? -Infinity : last + this.L.upstreamMinSpacingMs - t;
  }
  inFlightAt(t) {
    for (const lease of this.leases) {
      if (lease.expiresAt <= t && this.state.unresolved.some(marker => marker.id === lease.id)) this.quarantine.add(lease.id);
    }
    return this.leases.size;
  }
  leaveQueue(work) {
    const at = this.queue.indexOf(work);
    if (at >= 0) this.queue.splice(at, 1);
  }

  // Null when the queue could not be served in time: refused at once, so it stays bounded.
  enqueue(url, mic) {
    const t = this.now();
    const ahead = Math.max(0, this.spacingLeft(t)) + this.queue.length * this.L.upstreamMinSpacingMs;
    if (ahead > this.L.upstreamQueueMaxWaitMs) return null;
    const deadline = t + this.L.upstreamQueueMaxWaitMs;
    const work = { url, mic, deadline, staleAt: deadline, clients: new Set(), controller: new AbortController(), dropped: null, promise: null };
    this.queue.push(work);
    this.works.set(url, work);
    work.promise = this.run(work).finally(() => {
      this.leaveQueue(work);
      if (this.works.get(url) === work) this.works.delete(url);
    });
    return work;
  }

  // Waits for this work's turn, then starts it. Each waiter runs on its own timers. A timer
  // can resume late, so every condition is checked against the clock on every wake, in this
  // order, before anything is admitted: a late wake is refused and uses no budget.
  async run(work) {
    const L = this.L;
    let waited = 0; // also ends the wait if the clock does not move
    for (;;) {
      if (work.dropped) return { code: work.dropped };
      const t = this.now();
      if (t > work.deadline) {
        const stop = !this.unsaved && !this.quarantine.size && this.currentStop(t);
        return stop ? this.stopReply(stop.code, stop) : this.throttled(work);
      }
      try { this.ready(); } catch (_) { return { code: COORDINATOR_UNAVAILABLE }; }
      const stop = this.currentStop(t);
      if (stop) return this.stopReply(stop.code, stop);
      // A waiter whose wake never comes cannot leave by itself; its deadline removes it.
      while (this.queue[0] && this.queue[0] !== work && this.queue[0].deadline < t) this.queue.shift();
      const first = this.queue[0] === work;
      const spacingLeft = this.spacingLeft(t);
      const room = this.inFlightAt(t) < L.upstreamInFlight;
      if (first && room && spacingLeft <= 0) {
        // Admission: from here to the fetch() call inside `start` there is no `await`, so
        // nothing else can run between the checks above and the request starting.
        const refused = this.admit(t, work);
        if (refused) return refused === "throttled" ? this.throttled(work) : { code: refused };
        this.leaveQueue(work);
        return this.start(work, t);
      }
      const left = Math.min(work.deadline - t, L.upstreamQueueMaxWaitMs - waited);
      if (left <= 0) return this.throttled(work);
      const wait = Math.min(left, first && room ? spacingLeft : L.upstreamQueuePollMs);
      waited += wait;
      await this.sleep(wait);
    }
  }

  throttled(work) {
    this.log({ event: "upstream_throttled", mic: work.mic });
    return { code: "throttled" };
  }

  // The budget counts requests that really start, and the start is on disk before it can
  // leave this object. Returns a refusal code, or null when admitted.
  admit(t, work) {
    const starts = this.state.starts.filter(start => t - start < BUDGET_WINDOW_MS);
    if (starts.length >= this.L.upstreamPerMinute) return "throttled";
    if (this.state.unresolved.length >= this.L.upstreamInFlight) return "throttled";
    const id = crypto.randomUUID();
    const next = { ...this.state, starts: [...starts, t], unresolved: [...this.state.unresolved, { id, startedAt: t }] };
    try {
      this.storage.write(next);
    } catch (_) {
      // Nothing has changed, but writing does not work: `ready` refuses everything, and health
      // says so, until it does.
      this.unsaved = true;
      this.log({ event: "coordinator_write_failed" });
      return COORDINATOR_UNAVAILABLE;
    }
    this.state = next;
    work.admissionId = id;
    this.unsaved = false;
    return null;
  }

  // The fetch() call is in this function's synchronous part, before its first `await`.
  async start(work, t) {
    const L = this.L;
    // An expired lease cannot prove a completed provider outcome. It quarantines instead
    // of reclaiming authorization; the persisted marker outlives every local timer.
    const lease = { id: work.admissionId, expiresAt: t + L.upstreamTimeoutMs + L.upstreamLeaseGraceMs };
    this.leases.add(lease);
    work.staleAt = lease.expiresAt;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (this.state.unresolved.some(marker => marker.id === work.admissionId)) this.quarantine.add(work.admissionId);
      work.controller.abort();
    }, L.upstreamTimeoutMs);
    try {
      let response, text, networkError, fetchFailed = false;
      // Only fetch/body failures belong to the provider failure counter. SQL exceptions
      // are handled by commitOutcome, outside this catch, and never become Yahoo failures.
      try {
        response = await this.fetchImpl(work.url, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": `market-data-gateway/${VERSION} (+https://elmatthe.github.io/projects/portfolio-rebalancer/)` },
          redirect: "manual",
          signal: work.controller.signal,
        });
        if (response.status === 200) text = await readCapped(response.body, L.maxUpstreamBytes);
      } catch (error) {
        fetchFailed = true;
        networkError = error;
      }
      if (fetchFailed || !response) {
        const unknown = timedOut || Boolean(work.dropped) || work.controller.signal.aborted || networkError?.name === "AbortError";
        const code = timedOut ? "upstream_timeout" : "upstream_unavailable";
        const saved = this.recordOutcome(work.dropped ? "cancelled" : code, null, work.admissionId, unknown);
        if (!saved) return { code: COORDINATOR_UNAVAILABLE };
        if (work.dropped) return { code: work.dropped };
        this.log({ event: "upstream_error", code, mic: work.mic });
        return unknown ? { code: COORDINATOR_UNAVAILABLE } : this.refusalReply(code);
      }
      if (response.status === 200) {
        if (!this.recordOutcome(null, null, work.admissionId)) return { code: COORDINATOR_UNAVAILABLE };
        return { text, retrievedAt: this.now() };
      }
      // The only upstream header ever read, and only on a refusal. A stop is recorded in the
      // same step the refusal arrives, before anything else is awaited.
      const retryAfterAt = parseUpstreamRetryAfter(response.headers?.get?.("Retry-After"), this.now());
      let code = statusCode(response.status);
      if (!this.recordOutcome(code, retryAfterAt, work.admissionId)) return { code: COORDINATOR_UNAVAILABLE };
      if (response.status === 404) {
        // Only the reply depends on the body; nothing waits for it to be cancelled otherwise.
        // The HTTP outcome and its stop are already durable; a body error cannot record
        // a second outcome or erase a competing admission.
        let body;
        try { body = await readCapped(response.body, 4096); } catch (_) { /* invalid body */ }
        code = /not ?found|no data/i.test(body || "") ? "symbol_not_found" : "upstream_invalid";
      } else {
        Promise.resolve(response.body?.cancel()).catch(() => { /* closed */ });
      }
      this.log({ event: "upstream_status", code, mic: work.mic, status: response.status });
      return this.refusalReply(code);
    } finally {
      clearTimeout(timer);
      this.leases.delete(lease);
      // No exception path may turn an orphaned admission into apparently healthy local
      // capacity. Known unsaved outcomes are held separately by commitOutcome.
      if (this.state.unresolved.some(marker => marker.id === work.admissionId)) this.quarantine.add(work.admissionId);
    }
  }
}
