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
import { sourceState } from "./activation.js";

export const VERSION = "1.3.0";

export const UPSTREAM_LIMITS = Object.freeze({
  maxUpstreamBytes: 2 * 1024 * 1024,
  upstreamTimeoutMs: 8000,
  upstreamPerMinute: 20, // actual starts in any 60 seconds, worldwide
  upstreamInFlight: 2,
  upstreamMinSpacingMs: 1000, // between two actual starts, worldwide
  upstreamQueueMaxWaitMs: 15000, // a request waits at most this long for its turn
  upstreamQueuePollMs: 200, // how often a waiting request looks again
  upstreamLeaseGraceMs: 2000, // a lease expires this long after its timeout; expiry quarantines its marker and never frees its place
});
const BUDGET_WINDOW_MS = 60000;

// After the data source refuses the gateway, no upstream request is sent for this long
// (seconds). Answers already cached are still served.
export const COOLDOWN_SECONDS = Object.freeze({ upstream_rate_limited: 900, upstream_blocked: 1800, upstream_unavailable: 120 });
// The longest wait the gateway keeps by itself. A longer Retry-After from the data source
// is never shortened into an early retry: the source stays halted until the owner approves
// that incident (UPSTREAM_INCIDENT_APPROVAL, M4, below).
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

// Reads at most `limit` bytes of a body; null when it is larger. Past the limit nothing more
// is read, and the stream is cancelled without waiting for the cancellation: one that never
// settles must not hold the answer, and its outcome changes nothing (R7/L5).
async function readCapped(stream, limit) {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try { Promise.resolve(reader.cancel()).catch(() => { /* closed */ }); } catch (_) { /* closed */ }
      return null;
    }
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
// haltCode       set: no upstream request until the owner approves the incident, whatever the clock says
// failures       consecutive 5xx / timeout / network failures
// starts         times of the actual starts in the last minute (spacing and budget)
// unresolved     admitted requests whose outcome is not known yet (markers)
// incident       M4: the open incident, or null: { generation, nonce, openedAt, scope: { halt, markers } }
// lastGeneration the last incident generation issued (it only grows)
// approvalResult the last time an owner approval was evaluated and rejected: { at, result, generation }
const EMPTY_STATE = Object.freeze({ cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: Object.freeze([]), unresolved: Object.freeze([]), incident: null, lastGeneration: 0, approvalResult: null });

const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isStopCode = value => Object.hasOwn(COOLDOWN_SECONDS, value);
const NONCE = /^[a-z2-7]{26}$/;
const MARKER_ID = /^[A-Za-z0-9._-]{1,64}$/;
function wellFormedIncident(incident, lastGeneration) {
  if (incident === null) return true;
  const scope = incident?.scope;
  return Number.isSafeInteger(incident.generation) && incident.generation >= 1 && incident.generation <= lastGeneration
    && typeof incident.nonce === "string" && NONCE.test(incident.nonce) && isTime(incident.openedAt)
    && scope && (scope.halt === null || isStopCode(scope.halt))
    && Array.isArray(scope.markers) && scope.markers.every(id => typeof id === "string" && MARKER_ID.test(id))
    && new Set(scope.markers).size === scope.markers.length && (scope.halt !== null || scope.markers.length > 0);
}
function verifiedState(state) {
  if (state === null || state === undefined) return EMPTY_STATE; // a coordinator that never recorded anything
  // Non-SQL adapters can still supply the old shape. SQLite migration is conservative below.
  const unresolved = state.unresolved ?? (Object.hasOwn(state, "unresolved") ? null : []);
  // State written before M4 has no incident fields: it is "legacy", and initialization binds it.
  const legacy = !Object.hasOwn(state, "incident");
  const incident = legacy ? null : state.incident;
  const lastGeneration = state.lastGeneration ?? 0;
  const wellFormed = isTime(state.cooldownUntil)
    && (state.cooldownCode === null ? state.cooldownUntil === 0 : isStopCode(state.cooldownCode))
    && (state.haltCode === null || isStopCode(state.haltCode))
    && isTime(state.failures)
    && Array.isArray(state.starts) && state.starts.every(isTime)
    && Array.isArray(unresolved) && unresolved.length <= UPSTREAM_LIMITS.upstreamInFlight
    && unresolved.every(marker => marker && typeof marker.id === "string" && MARKER_ID.test(marker.id)
      && isTime(marker.startedAt) && state.starts.includes(marker.startedAt))
    && new Set(unresolved.map(marker => marker.id)).size === unresolved.length
    && isTime(lastGeneration) && wellFormedIncident(incident, lastGeneration);
  if (!wellFormed) throw new Error("coordinator state is not well formed");
  return { ...state, unresolved, incident, lastGeneration, approvalResult: state.approvalResult ?? null, legacy };
}

// 128 random bits, base32 (a-z, 2-7): the part of an approval nobody can know before the
// incident it names exists.
function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out + alphabet[(value << (5 - bits)) & 31];
}
// Every byte is compared, whatever differs first.
function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const sameScope = (a, b) => a.halt === b.halt && a.markers.length === b.markers.length && a.markers.every((id, i) => id === b.markers[i]);

// The six columns every version since R4 writes, exactly as stored. M4 keeps a copy (`m4_row`)
// beside them: if they differ, something else wrote the row (an older version after a rollback,
// or a manual edit), and the incident is bound afresh before any approval can match it.
const sealOf = (cooldownUntil, cooldownCode, haltCode, failures, startsText, unresolvedText) => JSON.stringify([cooldownUntil, cooldownCode, haltCode, failures, startsText, unresolvedText]);

// The Durable Object's SQLite storage (ctx.storage). Every call is synchronous and throws on
// failure (a full database, an exhausted daily allowance). A statement that returns is not yet
// committed: the runtime commits the implicit transaction later, and a commit can still fail
// (a deferred constraint, for example), in which case it resets the object and discards its
// outgoing messages. `confirm` is the commit acknowledgement: storage.sync() resolves only once
// every earlier write is on disk (R7/L3).
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
  // Before M4: identifiers used by UPSTREAM_REACTIVATION_ID. Kept, never written again.
  "CREATE TABLE IF NOT EXISTS reactivation_ids (id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL)",
  // M4: one row per incident generation the owner approved. Holds no secret.
  "CREATE TABLE IF NOT EXISTS incident_approvals (generation INTEGER PRIMARY KEY, approved_at INTEGER NOT NULL, scope TEXT NOT NULL)",
];
// M4 columns, added to an existing row without touching the others (additive migration).
const M4_COLUMNS = [
  ["incident_generation", "INTEGER NOT NULL DEFAULT 0"],
  ["incident_nonce", "TEXT"],
  ["incident_scope", "TEXT"],
  ["incident_opened_at", "INTEGER"],
  ["approval_result", "TEXT"],
  ["m4_row", "TEXT"],
];
const UPSERT_STATE = `INSERT INTO coordinator_state (id, cooldown_until, cooldown_code, halt_code, failures, starts, unresolved,
    incident_generation, incident_nonce, incident_scope, incident_opened_at, approval_result, m4_row)
  VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET cooldown_until = excluded.cooldown_until, cooldown_code = excluded.cooldown_code,
    halt_code = excluded.halt_code, failures = excluded.failures, starts = excluded.starts, unresolved = excluded.unresolved,
    incident_generation = excluded.incident_generation, incident_nonce = excluded.incident_nonce,
    incident_scope = excluded.incident_scope, incident_opened_at = excluded.incident_opened_at,
    approval_result = excluded.approval_result, m4_row = excluded.m4_row`;
export function sqlStorage(storage) {
  const { sql } = storage;
  const upsert = state => {
    const starts = JSON.stringify(state.starts);
    const unresolved = JSON.stringify(state.unresolved ?? []);
    const incident = state.incident ?? null;
    return sql.exec(UPSERT_STATE, state.cooldownUntil, state.cooldownCode, state.haltCode, state.failures, starts, unresolved,
      state.lastGeneration ?? 0, incident?.nonce ?? null, incident ? JSON.stringify(incident.scope) : null, incident?.openedAt ?? null,
      state.approvalResult ? JSON.stringify(state.approvalResult) : null,
      sealOf(state.cooldownUntil, state.cooldownCode, state.haltCode, state.failures, starts, unresolved));
  };
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
      const columns = new Set(sql.exec("PRAGMA table_info(coordinator_state)").toArray().map(column => column.name));
      const missing = M4_COLUMNS.filter(([name]) => !columns.has(name));
      if (missing.length) storage.transactionSync(() => { for (const [name, type] of missing) sql.exec(`ALTER TABLE coordinator_state ADD COLUMN ${name} ${type}`); });
      const [row] = sql.exec(`SELECT cooldown_until, cooldown_code, halt_code, failures, starts, unresolved,
        incident_generation, incident_nonce, incident_scope, incident_opened_at, approval_result, m4_row FROM coordinator_state WHERE id = 1`).toArray();
      const seen = sql.exec("SELECT id FROM reactivation_ids").toArray().map(r => r.id);
      const approvals = sql.exec("SELECT generation FROM incident_approvals").toArray().map(r => r.generation);
      if (!row) return { state: null, seen, approvals, sealed: true };
      const state = {
        cooldownUntil: row.cooldown_until, cooldownCode: row.cooldown_code, haltCode: row.halt_code, failures: row.failures,
        starts: JSON.parse(row.starts), unresolved: JSON.parse(row.unresolved), lastGeneration: row.incident_generation,
        approvalResult: row.approval_result === null ? null : JSON.parse(row.approval_result),
      };
      // A row no M4 code has written yet has no incident fields at all: legacy (see verifiedState).
      if (row.m4_row !== null) {
        state.incident = row.incident_nonce === null && row.incident_scope === null ? null
          : { generation: row.incident_generation, nonce: row.incident_nonce, openedAt: row.incident_opened_at, scope: JSON.parse(row.incident_scope) };
      }
      const sealed = row.m4_row === sealOf(row.cooldown_until, row.cooldown_code, row.halt_code, row.failures, row.starts, row.unresolved);
      return { state, seen, approvals, sealed };
    },
    write: state => upsert(state).rowsWritten,
    confirm: () => storage.sync(),
    // One transaction: an approval is never recorded as used unless the incident it clears is
    // cleared with it, and the reverse.
    approve(state, generation, scope, at) {
      storage.transactionSync(() => {
        sql.exec("INSERT INTO incident_approvals (generation, approved_at, scope) VALUES (?, ?, ?)", generation, at, JSON.stringify(scope));
        upsert(state);
      });
    },
  };
}

/* ---------------- the coordinator ---------------- */
// UPSTREAM_INCIDENT_APPROVAL: `g<generation>-<nonce>` of the one incident it approves (M4).
const APPROVAL = /^g([1-9][0-9]{0,15})-([a-z2-7]{26})$/;
// An approval is refused while a request of the incident may still be running: an instance
// that shut down lets a request that touches no storage finish, for up to 30 s on a runtime
// update. The newest marker of the incident must be older than this.
export const APPROVAL_DRAIN_MS = 60000;
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
    this.durable = null; // the state last read from disk or whose commit storage confirmed
    this.unconfirmed = []; // writes whose statement succeeded, awaiting commit: { seq, state, event }
    this.writeSeq = 0;
    this.commitFailed = false; // storage refused to confirm a commit: memory is ahead of disk
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
    // The runtime resets an object whose commit failed. Until that happens this instance's
    // memory may hold effects disk does not (a rolled-back approval, for one), so it admits
    // nothing and writes nothing more; the next instance reads what disk really has.
    if (this.commitFailed) throw new Error("storage commit failed");
    if (!this.state) this.initialize();
    if (this.unsaved) {
      this.storage.write(this.state);
      this.unsaved = false;
      this.wrote(this.state);
    }
    this.inFlightAt(this.now());
    if (this.quarantine.size) throw new Error("unresolved upstream outcome");
  }

  // The object's start (worker.js runs it before any request is delivered; otherwise the first
  // call does): read and migrate the state, bind everything unresolved into the incident, and
  // evaluate the owner's approval. This is the only place an approval is ever evaluated, so no
  // request, health check or status read can apply one: a changed secret is a new deployment,
  // which restarts the object. Throws, leaving the instance unverified, if anything fails.
  initialize() {
    const { state: stored, seen, approvals = [], sealed = true } = this.storage.read();
    // Approval and reactivation history are written with the state. History without the
    // state row is lost/corrupt storage, not a pristine coordinator.
    if (stored == null && (seen.length || approvals.length)) throw new Error("coordinator state missing");
    const { legacy, ...read } = verifiedState(stored);
    const t = this.now();
    // After a restart nothing of this instance is in flight: every marker is an outcome nobody
    // knows, and with any halt it is the incident's exact scope. Anything else (a marker the
    // incident does not cover, a halt it does not name, state written before M4 or by other
    // code) gets a new generation and nonce, so an approval prepared for the old one can no
    // longer match.
    const scope = { halt: read.haltCode, markers: read.unresolved.map(marker => marker.id).sort() };
    const empty = scope.halt === null && scope.markers.length === 0;
    let next = read;
    if (empty) next = read.incident ? { ...read, incident: null } : read;
    else if (legacy || !sealed || !read.incident || !sameScope(read.incident.scope, scope)) next = this.openIncident(read, scope, t);

    // UPSTREAM_INCIDENT_APPROVAL (owner only, M4).
    const raw = String(this.env.UPSTREAM_INCIDENT_APPROVAL ?? "").trim();
    let approved = null;
    if (raw) {
      const result = this.evaluateApproval(raw, next, approvals, t);
      if (result === "accepted") {
        approved = next.incident;
        next = { ...next, haltCode: null, unresolved: next.unresolved.filter(marker => !approved.scope.markers.includes(marker.id)), incident: null, approvalResult: null };
      } else {
        this.log({ event: "incident_approval", result, generation: next.incident?.generation ?? null });
        const last = next.approvalResult;
        if (last?.result !== result || last?.generation !== (next.incident?.generation ?? null)) next = { ...next, approvalResult: { at: t, result, generation: next.incident?.generation ?? null } };
      }
    }
    if (approved) this.storage.approve(next, approved.generation, approved.scope, t);
    else if (next !== read || !sealed || legacy) this.storage.write(next);
    this.state = next;
    this.durable = read;
    this.quarantine = new Set(next.unresolved.map(marker => marker.id));
    if (next !== read || approved) this.wrote(next); // incident events are logged once committed
  }

  // Why an approval does or does not clear the current incident. Nothing here writes.
  evaluateApproval(raw, state, approvals, t) {
    const match = APPROVAL.exec(raw);
    if (!match) return "malformed";
    const generation = Number(match[1]);
    const incident = state.incident;
    if (approvals.includes(generation)) return "consumed";
    if (!incident) return "no_incident";
    if (generation < incident.generation) return "stale_generation";
    if (generation > incident.generation) return "unknown_generation";
    if (!sameSecret(match[2], incident.nonce)) return "mismatch";
    // Recovery is deliberate: the source is switched off while the owner approves (M4/D2).
    if (sourceState(this.env).enabled) return "source_on";
    const newest = Math.max(0, ...state.unresolved.filter(marker => incident.scope.markers.includes(marker.id)).map(marker => marker.startedAt));
    if (t - newest < APPROVAL_DRAIN_MS) return "work_may_be_running";
    return "accepted";
  }

  // A new incident generation, with a nonce made now, for exactly this scope.
  openIncident(state, scope, t) {
    const generation = state.lastGeneration + 1;
    return { ...state, lastGeneration: generation, incident: { generation, nonce: newNonce(), openedAt: t, scope } };
  }

  // The incident after an outcome (M4). `bind` is an admission whose outcome is now unknown;
  // `rotate` is a new halt-level direction from the source. Any change of scope, or a new
  // direction, means a new generation and nonce in the same write as the outcome.
  withIncident(next, bind, rotate) {
    const old = next.incident;
    const markers = new Set(old ? old.scope.markers : []);
    if (bind) markers.add(bind);
    for (const id of markers) if (!next.unresolved.some(marker => marker.id === id)) markers.delete(id);
    const scope = { halt: next.haltCode, markers: [...markers].sort() };
    if (scope.halt === null && scope.markers.length === 0) return old ? { ...next, incident: null } : next;
    if (old && !rotate && sameScope(old.scope, scope)) return next;
    return this.openIncident(next, scope, this.now());
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
    if (this.commitFailed) {
      // See `ready`: nothing more is written by an instance whose commit failed. Its marker on
      // disk keeps the outcome unresolved for the next instance.
      this.logStops(this.durable, next, "cooldown_not_persisted");
      return false;
    }
    try {
      this.storage.write(next);
    } catch (_) {
      this.unsaved = true;
      this.log({ event: "coordinator_write_failed" });
      this.logStops(this.durable, next, "cooldown_not_persisted");
      return false;
    }
    this.unsaved = false;
    this.wrote(next);
    return true;
  }

  // Durable logging (R6/L3, R7). A statement that returned is not a commit, so `durable` (the
  // state last confirmed on disk) moves, and `cooldown_started` / `incident_*` events are
  // logged, only when storage confirms the commit. Nothing here is awaited: the caller,
  // including the admission block, carries on synchronously, and an outgoing request is held by
  // the runtime's output gate until the same commit. Every write is the whole state row and a
  // confirmation covers every earlier write, so writes are confirmed strictly in order, each
  // once: a stop is logged once, in the order it was recorded, whatever order the
  // acknowledgements arrive in. A refused or failed confirmation is reported as not persisted
  // and nothing in it is ever reported as started.
  wrote(state, event = null) {
    const seq = ++this.writeSeq;
    this.unconfirmed.push({ seq, state, event });
    let confirmation;
    try { confirmation = Promise.resolve(this.storage.confirm()); } catch (error) { confirmation = Promise.reject(error); }
    confirmation.then(() => this.committed(seq), () => this.notCommitted(seq)).catch(() => { /* a log sink failed */ });
  }
  committed(seq) {
    if (this.commitFailed) return; // a failed commit before it: its own success proves nothing logged here
    while (this.unconfirmed.length && this.unconfirmed[0].seq <= seq) {
      const { state, event } = this.unconfirmed.shift();
      this.logStops(this.durable, state, "cooldown_started");
      this.logIncident(this.durable, state);
      if (event) this.log(event);
      this.durable = state;
    }
  }
  notCommitted(seq) {
    if (!this.unconfirmed.some(write => write.seq <= seq)) return; // confirmed already, or reported
    const lost = this.unconfirmed.at(-1).state;
    this.unconfirmed = [];
    this.commitFailed = true;
    this.unsaved = true;
    this.log({ event: "coordinator_write_failed", stage: "commit" });
    this.logStops(this.durable, lost, "cooldown_not_persisted");
  }
  // The generation only: the nonce never reaches a log.
  logIncident(before, after) {
    const was = before?.incident ?? null;
    const now = after.incident ?? null;
    if (now && now.generation !== was?.generation) this.log({ event: was ? "incident_rotated" : "incident_opened", generation: now.generation, halted: now.scope.halt !== null, unresolved: now.scope.markers.length });
    if (was && !now) this.log({ event: "incident_resolved", generation: was.generation });
  }
  logStops(before, after, event) {
    const was = before ?? EMPTY_STATE;
    if (after.cooldownUntil > was.cooldownUntil) this.log({ event, code: after.cooldownCode, seconds: Math.max(0, Math.ceil((after.cooldownUntil - this.now()) / 1000)) });
    if (after.haltCode && !was.haltCode) this.log({ event, code: after.haltCode, seconds: null, halted: true });
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
    }
    if (halts && !next.haltCode) next.haltCode = code;
    return next; // logged by commitOutcome, once the write has succeeded or failed
  }

  // Updates the circuit breaker after an upstream outcome (a code, or null for a real success).
  recordOutcome(code, directedUntil = null, admissionId = null, unknown = false) {
    const state = this.state;
    // A direction past the longest wait kept automatically: a halt, or more evidence for one.
    const haltDirected = directedUntil !== null && directedUntil - this.now() > MAX_COOLDOWN_SECONDS * 1000;
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
    // M4: the incident is bound in the same write as the outcome that changes it.
    return this.commitOutcome(this.withIncident(next, unknown ? admissionId : null, haltDirected));
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

  // Health. Reads only (M4/D4): it never rewrites, never reclassifies and never evaluates an
  // approval, however often it is asked. The object's one-time start is the only exception, when
  // a status call happens to be the first call an instance receives.
  status() {
    if (!this.state && !this.commitFailed) {
      try { this.initialize(); } catch (_) { /* reported as unverified below */ }
    }
    const t = this.now();
    const expired = [...this.leases].some(lease => lease.expiresAt <= t && this.state?.unresolved.some(marker => marker.id === lease.id));
    if (!this.state || this.commitFailed || this.unsaved || this.quarantine.size || expired) {
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
    this.wrote(next); // changes no stop; tracked so the next confirmed stop is compared with it
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
      let response, text, fetchFailed = false;
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
      } catch (_) {
        fetchFailed = true;
      }
      if (fetchFailed || !response) {
        // Only a complete answer is a known outcome, so every path here is unknown and keeps
        // its marker. With no HTTP status, the request may have reached the source and been
        // refused (a 429 whose headers were lost with the connection). An HTTP 200 whose body
        // did not finish (interrupted, timed out or cancelled) did not complete either: its
        // status alone is not proof that the upstream work ended (owner decision, R6/M5).
        // A refusal status never gets here: it is recorded before its body is touched.
        const code = timedOut ? "upstream_timeout" : "upstream_unavailable";
        const saved = this.recordOutcome(work.dropped ? "cancelled" : code, null, work.admissionId, true);
        if (!saved) return { code: COORDINATOR_UNAVAILABLE };
        if (work.dropped) return { code: work.dropped };
        this.log({ event: "upstream_error", code, mic: work.mic });
        return { code: COORDINATOR_UNAVAILABLE };
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
