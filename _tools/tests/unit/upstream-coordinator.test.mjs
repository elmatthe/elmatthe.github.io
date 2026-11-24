// The upstream coordinator: admission, stops, reactivation and every way it can fail, with
// several Worker isolates sharing one coordinator, on a clock the test controls. Timers can
// be made to fire late, or never. Yahoo is synthetic. The same scenarios run against the real
// Workers runtime and real SQLite in ../worker-runtime/gateway-runtime.test.cjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGateway, LIMITS, COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, VERSION } from "../../../_services/market-data-gateway/src/gateway.js";
import { UpstreamCoordinatorCore, APPROVAL_DRAIN_MS } from "../../../_services/market-data-gateway/src/coordinator.js";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { localCoordinator, memoryStorage, COORDINATOR_ON } from "../fixtures/local-coordinator.mjs";

const ORIGIN = "https://elmatthe.github.io";
const BASE = "https://market-data-gateway.example.workers.dev";
const NOW = Date.parse("2026-11-03T15:00:00Z");
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: ORIGIN };
const quote = s => `/v1/quote?symbol=${encodeURIComponent(s)}`;

// A clock whose timers fire only when the test says so: `advance` fires them on time, `jump`
// moves time first and fires them late, `forgetTimers` means they never fire at all.
function virtualClock() {
  let t = NOW;
  let timers = [];
  const turn = () => new Promise(resolve => setTimeout(resolve, 1));
  return {
    now: () => t,
    pending: () => timers.length,
    sleep: ms => new Promise(resolve => { timers.push({ at: t + Math.max(0, ms), resolve }); }),
    forgetTimers() { timers = []; },
    move(ms) { t += ms; }, // time passes and no timer has fired yet
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        await turn();
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > target) break;
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      t = target;
      await turn();
    },
    async jump(ms) {
      t += ms;
      const due = timers.filter(timer => timer.at <= t);
      timers = timers.filter(timer => timer.at > t);
      due.forEach(timer => timer.resolve());
      await turn();
      await turn();
    },
  };
}
async function until(condition, label) {
  const giveUp = Date.now() + 3000;
  while (Date.now() < giveUp) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(condition(), `timed out waiting for: ${label}`);
}

// One coordinator, a synthetic Yahoo that answers when the test releases a request, and any
// number of isolates. `elapsed` is what a test compares deadlines with. `violations` is the
// core promise, checked at the moment of every start: it is on disk, and no stop is.
function world({ limits = {}, coordinatorEnv = { ...COORDINATOR_ON }, storage = memoryStorage(), cache = null } = {}) {
  const clock = virtualClock();
  const held = [];
  const starts = [];
  const violations = [];
  const answer = yahooFetch({ now: clock.now });
  const fetchImpl = (url, init) => {
    const symbol = decodeURIComponent(new URL(String(url)).pathname.split("/").pop());
    starts.push({ at: clock.now() - NOW, symbol });
    const disk = storage.peek();
    if (!disk?.starts.includes(clock.now())) violations.push(`${symbol}: started before its start was on disk`);
    if (disk?.haltCode || disk?.cooldownUntil > clock.now()) violations.push(`${symbol}: started after a stop was recorded`);
    return new Promise((resolve, reject) => {
      held.push({ symbol, ok: () => resolve(answer(url, init)), status: (status, headers = {}) => resolve(new Response("x", { status, headers })), raw: resolve, reject, signal: init.signal, url: String(url) });
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const applied = { upstreamTimeoutMs: 600000, ...limits };
  const coordinator = localCoordinator({ fetchImpl, now: clock.now, sleep: clock.sleep, limits: applied, env: coordinatorEnv, storage });
  let client = 0;
  const isolate = ({ env = {} } = {}) => {
    const gw = createGateway({ now: clock.now, log: () => {}, cache, limits: applied });
    const bound = { ...ON, UPSTREAM_COORDINATOR: coordinator, ...env };
    return {
      ask(symbol, { signal, ctx } = {}) {
        client += 1;
        return gw.handle(new Request(`${BASE}${quote(symbol)}`, { signal, headers: { Origin: ORIGIN, "CF-Connecting-IP": `10.60.${client >> 8}.${client & 255}` } }), bound, ctx);
      },
      async health() {
        const r = await gw.handle(new Request(`${BASE}/v1/health`, { headers: { Origin: ORIGIN } }), bound);
        return r.json();
      },
    };
  };
  // Requests started together can reach the coordinator in any order: the Worker hashes the client
  // address first, asynchronously. `enter` makes the order definite, so an assertion about first
  // come first served means what it says. It returns an array, of answers still pending.
  const enter = async (asker, symbols, options) => {
    const answers = [];
    for (const symbol of symbols) {
      const before = coordinator.arrivals.length;
      answers.push(asker.ask(symbol, options));
      await until(() => coordinator.arrivals.length > before, `${symbol} reaches the coordinator`);
    }
    return answers;
  };
  return { clock, held, starts, violations, coordinator, storage, isolate, enter, elapsed: () => clock.now() - NOW };
}
// The value the owner reads from storage (Data Studio) to approve the current incident (M4).
const approvalFor = storage => {
  const { incident } = storage.peek();
  return `g${incident.generation}-${incident.nonce}`;
};
const code = async r => (await r.clone().json()).error?.code;
const releaseAll = w => w.held.splice(0).forEach(h => h.ok());
const refused = async (r, expected, retryAfter) => {
  assert.equal(await code(r), expected);
  if (retryAfter !== undefined) assert.equal(r.headers.get("retry-after"), String(retryAfter));
};

/* ---------------- R4. unresolved outcomes survive loss of memory ---------------- */
for (const seconds of [3600, 172800]) {
  test(`H1: failed ${seconds}s stop persistence stays quarantined after immediate restart and storage recovery`, async () => {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const answer = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "durably admitted");
    const admitted = w.storage.peek();
    w.storage.failWrites = true;
    w.held.shift().status(429, { "Retry-After": String(seconds) });
    const first = await answer;
    w.coordinator.restart();
    w.storage.failWrites = false;
    await w.clock.jump(40 * 86400000); // neither budget nor any possible cooldown remains
    let settled = false;
    const pending = w.isolate().ask("MSFT").finally(() => { settled = true; });
    await until(() => settled || w.starts.length === 2, "restart admits or refuses");
    releaseAll(w); // allow the vulnerable R3 implementation to finish, then assert it was unsafe
    const next = await pending;
    assert.equal(next.status, 503);
    await refused(next, "busy", 60);
    assert.equal(w.starts.length, 1, "the unsafe second upstream request NEVER occurs");
    assert.equal(first.status, 503, "an uncommitted stop is not reported as confirmed");
    assert.equal(admitted.unresolved.length, 1, "the admission had a durable marker before fetch");
    assert.equal(w.storage.peek().unresolved.length, 1);
    assert.equal((await w.isolate().health()).upstream.state, "unverified");
  });
}

test("H1: live observed refusal can be finalized when storage recovers, without counting SQL failure as a provider failure", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const first = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  w.storage.failWrites = true;
  w.held.shift().status(429, { "Retry-After": "3600" });
  await refused(await first, "busy", 60);
  assert.equal(w.storage.peek().unresolved.length, 1);
  w.storage.failWrites = false;
  await refused(await w.isolate().ask("MSFT"), "upstream_rate_limited", 3600);
  assert.equal(w.storage.peek().failures, 0);
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000);
  assert.equal(w.starts.length, 1);
  w.coordinator.restart();
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 3600);
});

for (const status of [200, 302, 400, 401, 403, 404, 429, 503]) {
  test(`H1: HTTP ${status} always durably finalizes its marker, including unchanged failure count`, async () => {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    assert.equal(w.storage.peek().unresolved.length, 1);
    const writes = w.storage.writes;
    if (status === 200) w.held.shift().ok(); else w.held.shift().status(status);
    await first;
    assert.equal(w.storage.writes, writes + 1, "finalization is required even without another state change");
    assert.deepEqual(w.storage.peek().unresolved, []);
    w.coordinator.restart();
    assert.notEqual((await w.isolate().health()).upstream.state, "unverified");
  });
}

for (const refusalFirst of [false, true]) {
  test(`H1: two in-flight outcomes preserve one another's markers and stop (refusal first: ${refusalFirst})`, async () => {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const answers = await w.enter(w.isolate(), ["AAPL", "MSFT"]);
    await until(() => w.starts.length === 2, "two authorized requests");
    const markers = w.storage.peek().unresolved;
    assert.equal(markers.length, 2);
    assert.notEqual(markers[0].id, markers[1].id);
    const first = refusalFirst ? 1 : 0;
    if (refusalFirst) w.held[1].status(429, { "Retry-After": "3600" }); else w.held[0].ok();
    await answers[first];
    assert.equal(w.storage.peek().unresolved.length, 1);
    assert.ok(markers.some(m => m.id === w.storage.peek().unresolved[0].id));
    if (refusalFirst) w.held[0].ok(); else w.held[1].status(429, { "Retry-After": "3600" });
    await answers[1 - first];
    assert.deepEqual(w.storage.peek().unresolved, []);
    assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000);
    await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 3600);
    assert.equal(w.starts.length, 2);
  });
}

test("H1/M4: only the owner's approval of the current incident resolves restart uncertainty; a failed transaction and older values do not", async () => {
  const env = { ...COORDINATOR_ON, UPSTREAM_INCIDENT_APPROVAL: `g1-${"a".repeat(26)}`, UPSTREAM_REACTIVATION_ID: "before-uncertainty" };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  await w.isolate().health();
  const answer = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  w.storage.failWrites = true;
  w.held.shift().status(429, { "Retry-After": "172800" });
  await answer;
  w.coordinator.restart();
  w.storage.failWrites = false;
  await refused(await w.isolate().ask("MSFT"), "busy", 60);
  assert.equal(w.storage.peek().approvalResult.result, "mismatch", "a value set before the incident cannot name it");
  await w.clock.jump(APPROVAL_DRAIN_MS);
  env.UPSTREAM_INCIDENT_APPROVAL = approvalFor(w.storage);
  w.storage.failApproval = true;
  deployOff(w, env); // the owner's source-off deployment: its start's approval transaction fails
  assert.equal(w.storage.peek().unresolved.length, 1);
  assert.deepEqual(w.storage.approvals(), [], "failed transaction did not consume the approval");
  w.storage.failApproval = false;
  await refused(await w.isolate().ask("SPY"), "source_disabled"); // M1: nothing is sent, even for an enabled caller
  assert.equal((await w.isolate().health()).upstream.state, "unverified"); // retries the start, never the approval
  assert.deepEqual(w.storage.approvals(), []);
  assert.equal(w.starts.length, 1);
  deployOff(w, env); // the next start evaluates it again
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.deepEqual(w.storage.approvals(), [1]);
  deployOn(w, env);
  await reachable(w, "SPY");
  const later = w.isolate().ask("VST");
  await until(() => w.starts.length === 3, "later admission");
  w.storage.failWrites = true;
  w.held.shift().status(429, { "Retry-After": "3600" });
  await later;
  w.coordinator.restart();
  w.storage.failWrites = false;
  await w.clock.jump(APPROVAL_DRAIN_MS);
  for (const value of [`g1-${"a".repeat(26)}`, env.UPSTREAM_INCIDENT_APPROVAL]) {
    env.UPSTREAM_INCIDENT_APPROVAL = value;
    w.coordinator.restart();
    await refused(await w.isolate().ask("SAP.DE"), "busy", 60);
  }
  assert.equal(w.storage.peek().approvalResult.result, "consumed");
  assert.equal(w.starts.length, 3);
});

test("H1: reactivation history without its state row is inconsistent, not pristine", async () => {
  const storage = memoryStorage();
  storage.legacyReactivation({ cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: [], unresolved: [] }, "previous-owner");
  storage.corrupt(null);
  const w = world({ storage, coordinatorEnv: { ...COORDINATOR_ON, UPSTREAM_INCIDENT_APPROVAL: `g1-${"a".repeat(26)}` } });
  await refused(await w.isolate().ask("AAPL"), "busy", 60);
  assert.equal(w.starts.length, 0);
  assert.equal((await w.isolate().health()).upstream.state, "unverified");
  assert.deepEqual(storage.read().seen, ["previous-owner"]);
});

test("H1: malformed and inconsistent unresolved state fails closed without owner-id repair", async () => {
  const base = { cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: [NOW] };
  const marker = { id: "first", startedAt: NOW };
  for (const unresolved of [null, {}, [null], [{ id: "", startedAt: NOW }], [{ id: "bad", startedAt: -1 }], [marker, marker], [marker, { id: "second", startedAt: NOW }, { id: "third", startedAt: NOW }], [{ id: "missing-start", startedAt: NOW + 1 }]]) {
    const storage = memoryStorage();
    storage.corrupt({ ...base, unresolved });
    const w = world({ storage, coordinatorEnv: { ...COORDINATOR_ON, UPSTREAM_INCIDENT_APPROVAL: `g1-${"a".repeat(26)}` } });
    let settled = false;
    const answer = w.isolate().ask("AAPL").finally(() => { settled = true; });
    await until(() => settled || w.starts.length > 0, "malformed storage must be refused");
    releaseAll(w);
    const response = await answer;
    assert.equal(response.status, 503, JSON.stringify(unresolved));
    await refused(response, "busy", 60);
    assert.equal(w.starts.length, 0);
    assert.deepEqual(storage.peek().unresolved, unresolved);
  }
});

test("H1: recovered sibling finalization commits the known refusal without losing either request's outcome", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const answers = await w.enter(w.isolate(), ["AAPL", "MSFT"]);
  await until(() => w.starts.length === 2, "both admissions");
  w.storage.failWrites = true;
  w.held[0].status(429, { "Retry-After": "3600" });
  await refused(await answers[0], "busy", 60);
  assert.equal(w.storage.peek().unresolved.length, 2, "the failed transaction erased no marker");
  w.storage.failWrites = false;
  w.held[1].ok();
  assert.equal((await answers[1]).status, 200);
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000);
  w.coordinator.restart();
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 3600);
  assert.equal(w.starts.length, 2);
});

// R5 (independent R4 review H2): a request can reach the provider and be refused, and the
// connection close before the coordinator sees a status. No status means no known outcome.
test("H2: network rejection before any HTTP status keeps its marker, with or without a working write", async () => {
  for (const failWrites of [false, true]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    w.storage.failWrites = failWrites;
    w.held.shift().reject(new TypeError("synthetic network failure"));
    await refused(await first, "busy", 60);
    assert.equal(w.storage.peek().unresolved.length, 1, "an unobserved outcome is never finalized");
    assert.equal(w.storage.peek().failures, failWrites ? 0 : 1, "the breaker still counts the failure when it can be written");
    w.storage.failWrites = false;
    await refused(await w.isolate().ask("MSFT"), "busy", 60);
    w.coordinator.restart();
    await w.clock.jump(40 * 86400000);
    await refused(await w.isolate().ask("SPY"), "busy", 60);
    assert.equal((await w.isolate().health()).upstream.state, "unverified");
    assert.equal(w.starts.length, 1, "no second upstream request");
    assert.equal(w.storage.peek().unresolved.length, 1);
  }
});

// R6 (independent R5 review M5, owner decision): an HTTP 200 status is not proof that the
// upstream work completed. A 200 whose body does not finish is an unknown outcome, whether it
// is interrupted, times out or is cancelled. (R5 finalized the interrupted case; this test
// replaces the R5 test that asserted that.)
const firstHalf = new TextEncoder().encode('{"chart":{"result":[{"meta":');
// A 200 body that sends its first half and then waits. `signal` errors it, as a real fetch
// body is errored by its request's abort; `honoursAbort: false` is a transport that ignores it.
function unfinishedBody(signal, { honoursAbort = true } = {}) {
  let control;
  const stream = new ReadableStream({
    start(controller) {
      control = controller;
      controller.enqueue(firstHalf);
      if (honoursAbort) signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  });
  return { response: new Response(stream, { status: 200 }), interrupt: () => control.error(new TypeError("synthetic connection lost mid-body")) };
}
// After an unknown outcome: restart, 40 days, health unverified and no second upstream request.
async function staysQuarantined(w, label) {
  await refused(await w.isolate().ask("MSFT"), "busy", 60);
  w.coordinator.restart();
  await w.clock.jump(40 * 86400000);
  await refused(await w.isolate().ask("SPY"), "busy", 60);
  assert.equal((await w.isolate().health()).upstream.state, "unverified", label);
  assert.equal(w.starts.length, 1, `${label}: no further upstream request while the outcome is unknown`);
  assert.equal(w.storage.peek().unresolved.length, 1, label);
}

test("M5: an HTTP 200 whose body is interrupted keeps its marker, with or without a working write", async () => {
  for (const failWrites of [false, true]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    const h = w.held.shift();
    const body = unfinishedBody(h.signal);
    h.raw(body.response);
    await new Promise(resolve => setTimeout(resolve, 5)); // the status and first half are read
    w.storage.failWrites = failWrites;
    body.interrupt();
    await refused(await first, "busy", 60);
    assert.equal(w.storage.peek().unresolved.length, 1, "a status without its body is not a known outcome");
    assert.equal(w.storage.peek().failures, failWrites ? 0 : 1, "the breaker counts it when it can be written");
    w.storage.failWrites = false;
    await staysQuarantined(w, `interrupted (failWrites ${failWrites})`);
  }
});

test("M5: an HTTP 200 whose body times out keeps its marker, even when the transport ignores the abort", async () => {
  for (const honoursAbort of [true, false]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0, upstreamTimeoutMs: 30 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    const h = w.held.shift();
    const body = unfinishedBody(h.signal, { honoursAbort });
    h.raw(body.response);
    await until(() => h.signal.aborted, "the upstream timeout fires");
    if (honoursAbort) {
      await refused(await first, "busy", 60);
      assert.equal(w.storage.peek().failures, 1, "a timeout counts toward the breaker");
    } else {
      // The body never ends, so the request never settles; the timer alone quarantines.
      assert.equal((await w.isolate().health()).upstream.state, "unverified");
      await refused(await w.isolate().ask("MSFT"), "busy", 60);
      body.interrupt(); // let it finish late: still unknown
      await refused(await first, "busy", 60);
    }
    assert.equal(w.storage.peek().unresolved.length, 1);
    await staysQuarantined(w, `timed out (honoursAbort ${honoursAbort})`);
  }
});

test("M5: a client that leaves after HTTP 200 headers, before the body ends, leaves its marker", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const gone = new AbortController();
  const first = w.isolate().ask("AAPL", { signal: gone.signal });
  await until(() => w.starts.length === 1, "admission");
  const h = w.held.shift();
  h.raw(unfinishedBody(h.signal).response);
  await new Promise(resolve => setTimeout(resolve, 5));
  gone.abort();
  assert.equal((await first).status, 499);
  await until(() => h.signal.aborted, "the upstream request is aborted");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(w.storage.peek().unresolved.length, 1, "a client abort cannot complete the provider's answer");
  assert.equal(w.storage.peek().failures, 0, "a cancellation is not a provider failure");
  await staysQuarantined(w, "cancelled after headers");
});

test("M5 control: a complete HTTP 200 streamed in parts still finalizes, and the next request goes out", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const first = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  const h = w.held.shift();
  const bytes = new Uint8Array(await (await yahooFetch({ now: w.clock.now })(h.url)).arrayBuffer());
  const half = Math.floor(bytes.length / 2);
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, half)); c.enqueue(bytes.slice(half)); c.close(); } });
  h.raw(new Response(stream, { status: 200 }));
  assert.equal((await first).status, 200);
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.equal(w.storage.peek().failures, 0);
  w.coordinator.restart();
  assert.equal((await w.isolate().health()).upstream.state, "ok");
  const next = w.isolate().ask("MSFT");
  await until(() => w.starts.length === 2, "capacity returns");
  releaseAll(w);
  assert.equal((await next).status, 200);
});

/* ---------------- R6/L3. a stop is logged as started only once it is on disk ---------------- */
// Each log entry is recorded with what storage had committed at that moment. The commit
// acknowledgement (storage.sync()) is asynchronous: `settle` lets it arrive.
const settle = () => new Promise(resolve => setImmediate(resolve));
function loggedCore({ status = 429, retryAfter = "3600", failAfterAdmission = false } = {}) {
  const storage = memoryStorage();
  const logs = [];
  const core = new UpstreamCoordinatorCore({
    storage, env: COORDINATOR_ON, now: () => NOW, log: entry => logs.push({ ...entry, disk: storage.peekCommitted() }), limits: { upstreamMinSpacingMs: 0 },
    fetchImpl: async () => {
      if (failAfterAdmission) storage.failWrites = true; // the admission is on disk; the outcome write fails
      return new Response("x", { status, headers: { "Retry-After": retryAfter } });
    },
  });
  return { storage, logs, core, events: name => logs.filter(l => l.event === name) };
}

test("L3: cooldown_started is logged only once the stop is on disk", async () => {
  for (const [retryAfter, halted] of [["3600", false], ["172800", true]]) {
    const { core, logs, events } = loggedCore({ retryAfter });
    assert.equal((await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "a" })).code, "upstream_rate_limited");
    await settle();
    const started = events("cooldown_started");
    assert.equal(started.length, halted ? 2 : 1, JSON.stringify(logs));
    for (const entry of started) {
      assert.ok(entry.disk.cooldownUntil >= NOW + 900000, "the deadline was on disk when it was logged");
      if (entry.halted) assert.equal(entry.disk.haltCode, "upstream_rate_limited", "the halt was on disk when it was logged");
    }
    assert.equal(started[0].seconds, halted ? COOLDOWN_SECONDS.upstream_rate_limited : 3600);
    assert.equal(events("cooldown_not_persisted").length, 0);
  }
});

test("L3: a stop whose write fails is logged as not persisted, never as started, until a later write confirms it", async () => {
  for (const [retryAfter, halted] of [["3600", false], ["172800", true]]) {
    const { core, storage, logs, events } = loggedCore({ retryAfter, failAfterAdmission: true });
    assert.equal((await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "a" })).code, "coordinator_unavailable");
    assert.equal(events("cooldown_started").length, 0, `no durable stop is claimed: ${JSON.stringify(logs)}`);
    const failedAt = logs.findIndex(l => l.event === "coordinator_write_failed");
    const pending = events("cooldown_not_persisted");
    assert.ok(failedAt >= 0);
    assert.equal(pending.length, halted ? 2 : 1);
    assert.ok(logs.indexOf(pending[0]) > failedAt, "the stop is reported with the failure that kept it off disk");
    assert.equal(pending[0].code, "upstream_rate_limited");
    if (halted) assert.equal(pending[1].halted, true);
    assert.equal(storage.peek().cooldownUntil, 0, "and indeed it is not on disk");
    assert.equal(core.status().state, "unverified", "still failing: nothing confirmed");
    assert.equal(events("cooldown_started").length, 0);
    storage.failWrites = false;
    assert.equal(core.status().state, "unverified", "health only reads (M4/D4): it does not rewrite");
    assert.equal(storage.peek().cooldownUntil, 0);
    const asked = core.fetchChart({ kind: "quote", symbol: "MSFT", client: "b" }); // the data path writes the held outcome, synchronously
    const status = core.status();
    assert.equal(status.state, halted ? "halted" : "cooling_down");
    assert.equal(events("cooldown_started").length, 0, "written, but not yet confirmed as committed");
    assert.equal((await asked).code, "upstream_rate_limited");
    await settle();
    const started = events("cooldown_started");
    assert.equal(started.length, halted ? 2 : 1);
    for (const entry of started) assert.ok(entry.disk.cooldownUntil >= NOW + 900000, "confirmed only after the write");
    if (halted) assert.equal(started[1].disk.haltCode, "upstream_rate_limited");
    core.status();
    await settle();
    assert.equal(events("cooldown_started").length, halted ? 2 : 1, "a confirmed stop is not logged again");
  }
});

test("L3: a failed stop write followed by a restart never logs the stop as started", async () => {
  const { core, storage, events } = loggedCore({ failAfterAdmission: true });
  await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "a" });
  storage.failWrites = false;
  const logs = [];
  const restarted = new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, now: () => NOW, log: entry => logs.push(entry), fetchImpl: () => assert.fail("no upstream request") });
  assert.equal(restarted.status().state, "unverified", "the lost outcome is quarantined");
  await settle();
  assert.equal(events("cooldown_started").length + logs.filter(l => l.event === "cooldown_started").length, 0);
});

/* ---------------- R7/L3. a statement that returned is not a commit ---------------- */
// The R6 review's counterexample: the outcome UPDATE returns, then the implicit commit fails
// (a deferred foreign key in real SQLite, ../worker-runtime/). Here `commits: "manual"` holds
// each batch until the test commits or rolls it back. Yahoo answers when the test says.
function commitCore({ env = { ...COORDINATOR_ON }, storage = memoryStorage() } = {}) {
  const logs = [];
  const answers = [];
  const core = new UpstreamCoordinatorCore({
    storage, env, now: () => NOW, limits: { upstreamMinSpacingMs: 0 },
    log: entry => logs.push({ ...entry, disk: storage.peekCommitted() }),
    fetchImpl: () => new Promise(resolve => answers.push(resolve)),
  });
  const ask = symbol => core.fetchChart({ kind: "quote", symbol, client: symbol });
  const refuse = (index, seconds) => answers[index](new Response("x", { status: 429, headers: { "Retry-After": String(seconds) } }));
  const events = name => logs.filter(l => l.event === name);
  return { storage, logs, core, answers, ask, refuse, events };
}

for (const [seconds, halted] of [[3600, false], [172800, true]]) {
  test(`R7/L3: a ${seconds} s stop whose commit fails after its statement returned is never logged as started`, async () => {
    const { storage, logs, core, answers, ask, refuse, events } = commitCore();
    storage.commits = "manual";
    const reply = ask("AAPL");
    await until(() => answers.length === 1, "admission");
    storage.commit(); // the admission is committed, as the output gate requires before the fetch leaves
    await settle();
    refuse(0, seconds);
    assert.equal((await reply).code, "upstream_rate_limited");
    assert.ok(storage.peek().cooldownUntil > NOW, "the statement returned: the uncommitted row has the stop");
    await settle();
    assert.equal(events("cooldown_started").length, 0, "not committed yet, so not claimed");

    storage.rollback(); // the commit fails
    await settle();
    assert.equal(events("cooldown_started").length, 0, `no uncommitted stop is claimed: ${JSON.stringify(logs)}`);
    const failed = events("coordinator_write_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stage, "commit");
    const lost = events("cooldown_not_persisted");
    assert.equal(lost.length, halted ? 2 : 1, "the stop is reported as not persisted");
    assert.ok(logs.indexOf(lost[0]) > logs.indexOf(failed[0]));
    if (halted) assert.equal(lost[1].halted, true);
    const disk = storage.peek();
    assert.equal(disk.cooldownUntil, 0, "the commit really failed");
    assert.equal(disk.haltCode, null);
    assert.equal(disk.unresolved.length, 1, "the admission marker survives");

    assert.equal(core.status().state, "unverified", "this instance's memory is ahead of disk: it trusts neither");
    assert.equal((await ask("MSFT")).code, "coordinator_unavailable");
    assert.equal(answers.length, 1, "no second upstream request");
    await settle();
    assert.equal(storage.peek().cooldownUntil, 0, "and it writes nothing more");

    // The runtime resets the object; the next instance reads disk, where the marker quarantines.
    storage.commits = "auto";
    const restarted = commitCore({ storage });
    assert.equal(restarted.core.status().state, "unverified");
    assert.equal((await restarted.ask("SPY")).code, "coordinator_unavailable");
    assert.equal(restarted.answers.length, 0, "no upstream request after the restart either");
    await settle();
    assert.equal(events("cooldown_started").length + restarted.events("cooldown_started").length, 0);
  });

  test(`R7/L3: a ${seconds} s stop is logged as started once its commit is confirmed, and only then`, async () => {
    const { storage, core, answers, ask, refuse, events } = commitCore();
    storage.commits = "manual";
    const reply = ask("AAPL");
    await until(() => answers.length === 1, "admission");
    storage.commit();
    await settle();
    refuse(0, seconds);
    await reply;
    await settle();
    assert.equal(events("cooldown_started").length, 0);
    storage.commit();
    await settle();
    const started = events("cooldown_started");
    assert.equal(started.length, halted ? 2 : 1);
    for (const entry of started) assert.ok(entry.disk.cooldownUntil > NOW, "committed when it was logged");
    if (halted) assert.equal(started[1].disk.haltCode, "upstream_rate_limited");
    assert.equal(events("cooldown_not_persisted").length, 0);
    core.status();
    core.status();
    await settle();
    assert.equal(events("cooldown_started").length, halted ? 2 : 1, "never logged twice");
  });
}

test("R7/L3: a commit acknowledgement that never settles holds no answer, claims no stop, and the stop still holds", async () => {
  const { storage, core, answers, ask, refuse, events } = commitCore();
  storage.commits = "never";
  const reply = ask("AAPL");
  await until(() => answers.length === 1, "admission");
  refuse(0, 3600);
  assert.equal((await reply).code, "upstream_rate_limited", "the answer does not wait for the acknowledgement");
  await settle();
  assert.equal(events("cooldown_started").length, 0);
  assert.equal(core.status().state, "cooling_down");
  assert.equal((await ask("MSFT")).code, "upstream_rate_limited");
  assert.equal(answers.length, 1);
});

for (const [order, firstSeconds, secondSeconds] of [["cooldown first", 3600, 172800], ["halt first", 172800, 3600]]) {
  test(`R7/L3: concurrent stops (${order}) are logged once each, in the order recorded, whatever order their acknowledgements arrive in`, async () => {
    const { storage, ask, answers, refuse, events, logs } = commitCore();
    const replies = [ask("AAPL"), ask("MSFT")];
    await until(() => answers.length === 2, "two admissions");
    await settle();
    storage.commits = "manual";
    refuse(0, firstSeconds);
    await replies[0];
    refuse(1, secondSeconds);
    await replies[1];
    storage.commit({ reverse: true });
    await settle();
    const started = events("cooldown_started").map(({ seconds, halted = false }) => ({ seconds, halted }));
    const expected = firstSeconds === 3600
      ? [{ seconds: 3600, halted: false }, { seconds: null, halted: true }] // the halt's own 900 s cannot shorten 3600 s
      : [{ seconds: 900, halted: false }, { seconds: null, halted: true }, { seconds: 3600, halted: false }];
    assert.deepEqual(started, expected, JSON.stringify(logs));
    const disk = storage.peekCommitted();
    assert.equal(disk.haltCode, "upstream_rate_limited", "the ordinary cooldown did not touch the halt");
    assert.equal(disk.cooldownUntil, NOW + 3600000);
    assert.deepEqual(disk.unresolved, []);
    storage.commits = "auto";
    await settle();
    assert.equal(events("cooldown_started").length, expected.length, "no duplicates");
  });
}

test("R7/L3: failed-write recovery is logged as started only when the rewrite's commit is confirmed; a failed rewrite commit quarantines", async () => {
  for (const rewriteCommits of [true, false]) {
    const { core, storage, logs, events } = loggedCore({ failAfterAdmission: true });
    assert.equal((await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "a" })).code, "coordinator_unavailable");
    assert.equal(events("cooldown_not_persisted").length, 1, "statement failure");
    storage.failWrites = false;
    storage.commits = "manual";
    assert.equal((await core.fetchChart({ kind: "quote", symbol: "MSFT", client: "b" })).code, "upstream_rate_limited", "the held outcome is rewritten");
    assert.equal(core.status().state, "cooling_down");
    await settle();
    assert.equal(events("cooldown_started").length, 0, "rewritten, not yet committed");
    if (rewriteCommits) {
      storage.commit();
      await settle();
      assert.equal(events("cooldown_started").length, 1);
      assert.equal(events("cooldown_started")[0].disk.cooldownUntil, NOW + 3600000);
      assert.equal(core.status().state, "cooling_down");
    } else {
      storage.rollback();
      await settle();
      assert.equal(events("cooldown_started").length, 0, JSON.stringify(logs));
      assert.equal(events("cooldown_not_persisted").length, 2, "the statement failure, then the commit failure");
      assert.equal(core.status().state, "unverified");
      assert.equal(storage.peek().unresolved.length, 1, "the marker is still on disk");
      storage.commits = "auto";
      const restarted = new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, now: () => NOW, log: () => {}, fetchImpl: () => assert.fail("no upstream request") });
      assert.equal(restarted.status().state, "unverified");
    }
  }
});

test("R7/L3, M4: an approval whose commit fails is not reported, consumes nothing, and ends no halt", async () => {
  const { storage, answers, ask, refuse, events } = commitCore();
  const reply = ask("AAPL");
  await until(() => answers.length === 1, "admission");
  refuse(0, 172800);
  await reply;
  await settle();
  assert.equal(events("cooldown_started").length, 2, "the halt is committed");
  assert.equal(events("incident_opened").length, 1);
  const env = { UPSTREAM_INCIDENT_APPROVAL: approvalFor(storage) };

  storage.commits = "manual";
  const approving = commitCore({ env, storage }); // the deployment that carries the approval
  assert.equal(approving.core.status().state, "cooling_down", "the statement returned: the halt ends, its 900 s minimum remains");
  await settle();
  assert.equal(approving.events("incident_resolved").length, 0, "not committed, so not reported");
  storage.rollback();
  await settle();
  assert.equal(approving.events("incident_resolved").length, 0);
  assert.equal(approving.core.status().state, "unverified", "an instance whose commit failed trusts nothing it holds");
  assert.equal((await approving.ask("MSFT")).code, "source_disabled", "the approving deployment has the source off (M1)");
  assert.equal(answers.length + approving.answers.length, 1);
  assert.equal(storage.peek().haltCode, "upstream_rate_limited", "the halt is still on disk");
  assert.deepEqual(storage.approvals(), [], "the approval was not recorded");

  storage.commits = "auto";
  const restarted = commitCore({ storage });
  assert.equal(restarted.core.status().state, "halted", "the next instance reads the halt");
  const fresh = commitCore({ env, storage });
  assert.equal(fresh.core.status().state, "cooling_down", "the approval, never recorded, still ends the halt once");
  await settle();
  assert.equal(fresh.events("incident_resolved").length, 1, "reported once it is committed");
  assert.deepEqual(storage.approvals(), [storage.peek().lastGeneration]);
  const replay = commitCore({ env, storage });
  assert.equal(replay.core.status().state, "cooling_down");
  await settle();
  assert.equal(replay.events("incident_resolved").length, 0, "a used approval does nothing more");
  assert.equal(storage.peek().approvalResult.result, "consumed");
});

/* ---------------- R7/L5. an oversize body does not wait for its cancellation ---------------- */
const CAP = 2 * 1024 * 1024;
// An HTTP 200 body of `size` bytes in 64 KiB chunks whose cancellation behaves as `cancel` says.
function cappedBody(bytes, size, cancel) {
  const body = new Uint8Array(size).fill(0x20);
  body.set(bytes.subarray(0, Math.min(bytes.length, size)));
  let at = 0;
  const source = {
    pull(c) {
      if (at >= size) { c.close(); return; }
      c.enqueue(body.slice(at, at + 65536));
      at += 65536;
    },
  };
  if (cancel === "never") source.cancel = () => new Promise(() => {});
  if (cancel === "reject") source.cancel = () => Promise.reject(new Error("synthetic cancel failure"));
  if (cancel === "throw") source.cancel = () => { throw new Error("synthetic synchronous cancel failure"); };
  return new ReadableStream(source, { highWaterMark: 0 });
}
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: still pending after ${ms} ms`)), ms).unref())]);

for (const cancel of ["never", "reject", "throw"]) {
  test(`R7/L5: an HTTP 200 over 2 MiB whose cancellation ${cancel === "never" ? "never settles" : cancel === "reject" ? "rejects" : "throws"} is refused at once, finalized, and frees capacity`, async () => {
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const w = world({ limits: { upstreamMinSpacingMs: 0 } });
      const first = w.isolate().ask("AAPL");
      await until(() => w.starts.length === 1, "admission");
      const h = w.held.shift();
      const json = new Uint8Array(await (await yahooFetch({ now: w.clock.now })(h.url)).arrayBuffer());
      h.raw(new Response(cappedBody(json, CAP + 1, cancel), { status: 200 }));
      const answer = await within(first, 2000, "the oversize answer");
      assert.equal(answer.status, 502);
      assert.equal(await code(answer), "upstream_invalid");
      assert.deepEqual(w.storage.peek().unresolved, [], "a complete oversize answer finalizes (owner policy)");
      assert.equal(w.storage.peek().failures, 0);
      assert.equal((await w.isolate().health()).upstream.state, "ok");
      const next = w.isolate().ask("MSFT");
      await until(() => w.starts.length === 2, "capacity returns");
      releaseAll(w);
      assert.equal((await next).status, 200);
      await settle();
      assert.deepEqual(unhandled, [], "no unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}

test("R7/L5: the cap is exact: 2 MiB is accepted, 2 MiB plus one byte is not, with a cancellation that never settles", async () => {
  for (const [size, status] of [[CAP, 200], [CAP + 1, 502]]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    const h = w.held.shift();
    const json = new Uint8Array(await (await yahooFetch({ now: w.clock.now })(h.url)).arrayBuffer());
    h.raw(new Response(cappedBody(json, size, "never"), { status: 200 }));
    const answer = await within(first, 2000, `${size} bytes`);
    assert.equal(answer.status, status, `${size} bytes`);
    assert.deepEqual(w.storage.peek().unresolved, []);
  }
});

test("R7/L5: a body that fails below the cap is still incomplete: its marker stays (M5)", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const first = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  let sent = 0;
  const failing = new ReadableStream({
    pull(c) {
      if (sent >= CAP - 65536) { c.error(new TypeError("connection reset")); return; }
      c.enqueue(new Uint8Array(65536).fill(0x20));
      sent += 65536;
    },
    cancel: () => new Promise(() => {}),
  }, { highWaterMark: 0 });
  w.held.shift().raw(new Response(failing, { status: 200 }));
  await refused(await within(first, 2000, "the interrupted answer"), "busy");
  assert.equal(w.storage.peek().unresolved.length, 1);
  assert.equal((await w.isolate().health()).upstream.state, "unverified");
  assert.equal(w.starts.length, 1);
});

test("H1/M4: an approval in place while a request is active cannot clear its later aborted unknown outcome", async () => {
  const env = { ...COORDINATOR_ON, UPSTREAM_INCIDENT_APPROVAL: `g1-${"a".repeat(26)}` };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const gone = new AbortController();
  const first = w.isolate().ask("AAPL", { signal: gone.signal });
  await until(() => w.starts.length === 1, "admission");
  assert.equal((await w.isolate().health()).upstream.state, "ok", "healthy current-instance concurrency is not uncertainty");
  assert.equal(w.storage.peek().unresolved.length, 1, "an approval never erases an active admission");
  assert.equal(w.storage.peek().incident, null, "a healthy request is not an incident");
  gone.abort();
  assert.equal((await first).status, 499);
  await until(() => w.storage.peek().incident?.scope.markers.length === 1, "the unknown outcome opens an incident");
  w.coordinator.restart();
  await w.clock.jump(40 * 86400000);
  await refused(await w.isolate().ask("MSFT"), "busy", 60);
  assert.equal(w.storage.peek().approvalResult.result, "mismatch");
  assert.equal(w.starts.length, 1);
});

test("H1: an unexpected outcome-processing exception cannot orphan an admission in the live instance", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const core = new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, log: () => {}, limits: { upstreamMinSpacingMs: 0 }, fetchImpl: async () => {
    calls += 1;
    return { status: 429, headers: { get() { throw new Error("synthetic outcome-processing failure"); } } };
  } });
  await assert.rejects(core.fetchChart({ kind: "quote", symbol: "AAPL", client: "first" }), /synthetic outcome-processing failure/);
  assert.equal(core.status().state, "unverified");
  assert.equal((await core.fetchChart({ kind: "quote", symbol: "MSFT", client: "second" })).code, "coordinator_unavailable");
  assert.equal(storage.peek().unresolved.length, 1);
  assert.equal(calls, 1);
});

test("H1: a timeout quarantines immediately even when transport ignores abort", async () => {
  const storage = memoryStorage();
  let finish;
  let calls = 0;
  const core = new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, log: () => {}, limits: { upstreamTimeoutMs: 5, upstreamMinSpacingMs: 0 }, fetchImpl: () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = core.fetchChart({ kind: "quote", symbol: "AAPL", client: "first" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(core.status().state, "unverified");
  assert.equal((await core.fetchChart({ kind: "quote", symbol: "MSFT", client: "second" })).code, "coordinator_unavailable");
  assert.equal(calls, 1);
  assert.equal(storage.peek().unresolved.length, 1);
  finish(new Response("x", { status: 429, headers: { "Retry-After": "3600" } }));
  assert.equal((await pending).code, "upstream_rate_limited");
  assert.deepEqual(storage.peek().unresolved, []);
  assert.equal(core.status().state, "cooling_down");
});

test("H1: an unexpected AbortError also means unknown outcome without a local cancel", async () => {
  const storage = memoryStorage();
  let t = NOW;
  let calls = 0;
  const build = () => new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, now: () => t, log: () => {}, fetchImpl: async () => {
    calls += 1;
    throw new DOMException("synthetic transport abort", "AbortError");
  } });
  const core = build();
  assert.equal((await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "first" })).code, "coordinator_unavailable");
  assert.equal(storage.peek().unresolved.length, 1);
  assert.equal(core.status().state, "unverified");
  t += 40 * 86400000;
  assert.equal((await build().fetchChart({ kind: "quote", symbol: "MSFT", client: "second" })).code, "coordinator_unavailable");
  assert.equal(calls, 1);
});

test("H1: a transport ignoring timeout that later returns 429 durably preserves its actual Retry-After", async () => {
  const storage = memoryStorage();
  let signal;
  const core = new UpstreamCoordinatorCore({ storage, env: COORDINATOR_ON, now: () => NOW, log: () => {}, limits: { upstreamTimeoutMs: 5 }, fetchImpl: async (_url, init) => {
    signal = init.signal;
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response("x", { status: 429, headers: { "Retry-After": "3600" } });
  } });
  const reply = await core.fetchChart({ kind: "quote", symbol: "AAPL", client: "first" });
  assert.equal(signal.aborted, true, "the timer did fire while the transport ignored cancellation");
  assert.equal(reply.code, "upstream_rate_limited");
  assert.deepEqual(storage.peek().unresolved, []);
  assert.equal(storage.peek().cooldownUntil, NOW + 3600000);
  assert.equal(core.status().state, "cooling_down");
});

/* ---------------- 1. overdue admission ---------------- */
test("a ticket whose timer resumes at 20 s, after its 15 s deadline, is refused, never sent, and uses no budget (HTTP 200 and a start at 20 s on the original commit)", async () => {
  const w = world();
  const a = w.isolate();
  const first = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first start");
  const late = a.ask("MSFT");
  await until(() => w.clock.pending() > 0, "the second request waits for its 1 s spacing");
  await w.clock.jump(20000); // its 1 s timer resumes 19 s late
  const answer = await late;
  assert.equal(answer.status, 429);
  await refused(answer, "throttled");
  assert.ok(Number(answer.headers.get("retry-after")) > 0);
  assert.deepEqual(w.starts.map(s => s.symbol), ["AAPL"], "the overdue request reached no one");
  assert.equal(w.storage.peek().starts.length, 1, "no budget used for the refused ticket");
  releaseAll(w);
  assert.equal((await first).status, 200);
  const next = a.ask("SPY");
  await until(() => w.starts.length === 2, "the queue still works after a late wake");
  releaseAll(w);
  assert.equal((await next).status, 200);
});

test("the deadline is exact: admitted at exactly 15 s, refused 1 ms later", async () => {
  for (const [lateBy, expected] of [[15000, 200], [15001, 429]]) {
    const w = world({ limits: { upstreamInFlight: 1 } });
    const a = w.isolate();
    const first = a.ask("AAPL");
    await until(() => w.starts.length === 1, "first start");
    const queued = a.ask("MSFT");
    await until(() => w.clock.pending() > 0, "waiting");
    w.held.shift().ok();
    await first;
    await w.clock.jump(lateBy);
    await until(() => w.starts.length === (expected === 200 ? 2 : 1) && w.clock.pending() === 0, "the wake");
    releaseAll(w);
    assert.equal((await queued).status, expected, `woken at ${lateBy} ms`);
  }
});

test("a late wake does not disturb the others: first come first served, spacing and the in-flight limit hold", async () => {
  const w = world();
  const a = w.isolate();
  const blockers = await w.enter(a, ["AAPL", "MSFT"]);
  await until(() => w.starts.length === 1, "first");
  await w.clock.advance(1000);
  await until(() => w.starts.length === 2, "second"); // two in flight
  const [expires] = await w.enter(a, ["SPY"]); // deadline at 16 s
  await w.clock.advance(10000);
  const [survives] = await w.enter(a, ["VST"]); // deadline at 26 s
  await until(() => w.clock.pending() >= 2, "both waiting");
  releaseAll(w);
  await Promise.all(blockers);
  await w.clock.jump(6000); // t = 17 s: both wake late; only the first is past its deadline
  await until(() => w.starts.length === 3, "the next in line starts");
  await refused(await expires, "throttled");
  assert.deepEqual(w.starts.map(s => s.symbol), ["AAPL", "MSFT", "VST"]);
  assert.equal(w.starts[2].at, 17000);
  assert.deepEqual(w.violations, []);
  releaseAll(w);
  assert.equal((await survives).status, 200);
  assert.equal(w.storage.peek().starts.length, 3, "only real starts counted");
});

test("a reservation whose wake never comes expires at its deadline and does not block the queue", async () => {
  const w = world({ limits: { upstreamInFlight: 1 } });
  const a = w.isolate();
  const first = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const lostClient = new AbortController(); // ended below, so its real-time watchdog ends
  const lost = a.ask("MSFT", { signal: lostClient.signal }); // never woken again
  await until(() => w.clock.pending() > 0, "waiting");
  w.clock.forgetTimers();
  w.held.shift().ok();
  await first;
  await w.clock.jump(LIMITS.upstreamQueueMaxWaitMs - 3 * LIMITS.upstreamQueuePollMs);
  const next = a.ask("SPY");
  await until(() => w.clock.pending() > 0, "the next one waits behind the lost one");
  await w.clock.advance(LIMITS.upstreamQueuePollMs);
  assert.equal(w.starts.length, 1, "the lost reservation still holds its place within its 15 s");
  await w.clock.advance(3 * LIMITS.upstreamQueuePollMs);
  await until(() => w.starts.length === 2, "the lost reservation expired");
  assert.equal(w.starts[1].symbol, "SPY");
  releaseAll(w);
  assert.equal((await next).status, 200);
  lostClient.abort();
  assert.equal((await lost).status, 499);
});

test("a client that never left is told the truth when its overdue work is replaced", async () => {
  const w = world({ limits: { upstreamInFlight: 1 } });
  const a = w.isolate();
  const first = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const overdue = a.ask("MSFT");
  await until(() => w.clock.pending() > 0, "waiting");
  w.held.shift().ok();
  await first;
  w.clock.move(LIMITS.upstreamQueueMaxWaitMs + 1); // past its deadline; its timer has not fired
  const fresh = a.ask("MSFT"); // replaces the overdue work
  await until(() => w.starts.length === 2, "the new request starts");
  await w.clock.jump(0); // now its timer fires
  const answer = await overdue;
  assert.equal(answer.status, 429, "it did not leave, so it is not told it did");
  await refused(answer, "throttled");
  releaseAll(w);
  assert.equal((await fresh).status, 200);
});

test("nobody joins expired queued work; an admitted request that never settles quarantines the source", async () => {
  // A reservation whose wake never comes, and whose client's cancellation was lost.
  const queued = world({ limits: { upstreamInFlight: 1 } });
  const a = queued.isolate();
  const first = a.ask("AAPL");
  await until(() => queued.starts.length === 1, "first");
  const lostClient = new AbortController();
  const lost = a.ask("MSFT", { signal: lostClient.signal });
  await until(() => queued.clock.pending() > 0, "waiting");
  queued.clock.forgetTimers();
  queued.held.shift().ok();
  await first;
  await queued.clock.jump(LIMITS.upstreamQueueMaxWaitMs + 1);
  const fresh = a.ask("MSFT"); // the same symbol: new work, not the dead reservation
  await until(() => queued.starts.length === 2, "the new request starts");
  releaseAll(queued);
  assert.equal((await fresh).status, 200);
  lostClient.abort();
  assert.equal((await lost).status, 499);

  // A request that ignores its abort and never settles.
  const clock = virtualClock();
  const stuckStarts = [];
  const answer = yahooFetch({ now: clock.now });
  const fetchImpl = (url, init) => {
    stuckStarts.push(String(url));
    return stuckStarts.length === 1 ? new Promise(() => {}) : answer(url, init);
  };
  const limits = { upstreamTimeoutMs: 20, upstreamLeaseGraceMs: 10, upstreamMinSpacingMs: 0 };
  const coordinator = localCoordinator({ fetchImpl, now: clock.now, sleep: clock.sleep, limits });
  const stub = coordinator.getByName("yahoo-chart");
  const never = stub.fetchChart({ kind: "quote", symbol: "AAPL", client: "gone" });
  await until(() => stuckStarts.length === 1, "stuck start");
  await clock.jump(31);
  const reply = await stub.fetchChart({ kind: "quote", symbol: "AAPL", client: "next" });
  assert.equal(reply.code, "coordinator_unavailable");
  assert.equal(stuckStarts.length, 1, "lease expiry never forgets an unknown provider outcome");
  assert.equal(coordinator.storage.peek().unresolved.length, 1);
  assert.equal((await stub.status()).state, "unverified");
  assert.equal((await Promise.race([never, Promise.resolve("still waiting")])), "still waiting");
});

/* ---------------- 2. deadlines recorded in either order ---------------- */
for (const [order, first, second] of [["3600 s then 900 s", "3600", null], ["900 s then 3600 s", null, "3600"]]) {
  test(`two isolates record a 3600 s and a 900 s refusal (${order}): the longer one stands, and a new isolate stays away at 901 s`, async () => {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const [a, b] = [w.isolate(), w.isolate()];
    const answers = [...await w.enter(a, ["AAPL"]), ...await w.enter(b, ["MSFT"])];
    await until(() => w.starts.length === 2, "both in flight");
    w.held[0].status(429, first ? { "Retry-After": first } : {});
    await answers[0];
    w.held[1].status(429, second ? { "Retry-After": second } : {});
    await answers[1];
    assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000);

    await w.clock.advance(901000);
    const before = w.starts.length;
    const fresh = await w.isolate().ask("SPY");
    await refused(fresh, "upstream_rate_limited", 3600 - 901);
    assert.equal(w.starts.length, before, "no upstream request at 901 s");
    assert.deepEqual((await w.isolate().health()).upstream, { state: "cooling_down", code: "upstream_rate_limited", retryAfterSeconds: 3600 - 901 });

    await w.clock.advance((3600 - 901) * 1000 - 1);
    await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 1);
    assert.equal(w.starts.length, before, "not 1 ms before the deadline");
    await w.clock.advance(1);
    const resumed = w.isolate().ask("SPY");
    await until(() => w.starts.length === before + 1, "resumes exactly at the deadline");
    releaseAll(w);
    assert.equal((await resumed).status, 200);
  });
}

for (const [order, first, second] of [["halt first", "172800", null], ["ordinary cooldown first", null, "172800"]]) {
  test(`an ordinary cooldown never overwrites a manual-reactivation halt (${order})`, async () => {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const [a, b] = [w.isolate(), w.isolate()];
    const answers = [...await w.enter(a, ["AAPL"]), ...await w.enter(b, ["MSFT"])];
    await until(() => w.starts.length === 2, "both in flight");
    w.held[0].status(429, first ? { "Retry-After": first } : {});
    await answers[0];
    w.held[1].status(429, second ? { "Retry-After": second } : {});
    await answers[1];
    assert.equal(w.storage.peek().haltCode, "upstream_rate_limited");

    for (const after of [901000, 60 * 86400000]) {
      await w.clock.jump(after);
      const fresh = await w.isolate().ask("SPY");
      await refused(fresh, "upstream_rate_limited", MAX_COOLDOWN_SECONDS);
      assert.equal((await fresh.json()).error.manualReactivationRequired, true);
      assert.equal(w.starts.length, 2, `nothing sent ${after} ms later`);
    }
    assert.equal((await w.isolate().health()).upstream.state, "halted");
  });
}

test("a late answer can only lengthen a stop: a success or a short refusal after it changes nothing", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const a = w.isolate();
  const answers = await w.enter(a, ["AAPL", "MSFT"]);
  await until(() => w.starts.length === 2, "both in flight");
  const [long, ok] = w.held.splice(0);
  long.status(429, { "Retry-After": "3600" });
  await answers[0];
  const recorded = w.storage.peek().cooldownUntil;
  ok.ok(); // an answer to a request that started before the stop
  assert.equal((await answers[1]).status, 200);
  assert.equal(w.storage.peek().cooldownUntil, recorded, "a success does not end a stop");
  await w.clock.advance(1000000);
  await refused(await a.ask("SPY"), "upstream_rate_limited", 2600);
});

test("the stop lives in the coordinator alone: the Cache API can neither stop nor release the source", async () => {
  const store = new Map();
  const cache = {
    match: async key => (store.has(key) ? new Response(store.get(key)) : undefined),
    put: async (key, response) => { store.set(key, await response.text()); },
    delete: async key => store.delete(key),
  };
  const w = world({ cache, limits: { upstreamMinSpacingMs: 0 } });
  const a = w.isolate();
  // A forged stop in the cache stops nothing.
  store.set(`${BASE}/__cache/yahoo-chart/${VERSION}/state/cooldown`, JSON.stringify({ code: "upstream_rate_limited", startedAt: NOW, halted: true }));
  const free = a.ask("AAPL");
  await until(() => w.starts.length === 1, "not stopped by the cache");
  releaseAll(w);
  assert.equal((await free).status, 200);
  // A real stop is unaffected by the cache being emptied, or failing.
  const stopped = a.ask("MSFT");
  await until(() => w.starts.length === 2, "second");
  w.held.shift().status(429, { "Retry-After": "3600" });
  await stopped;
  assert.ok(![...store.keys()].some(k => /state\/cooldown/.test(k) && !store.get(k).includes("halted")), "no stop is written to the cache");
  store.clear();
  cache.match = async () => { throw new Error("cache down"); };
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 3600);
  assert.equal(w.starts.length, 2);
});

test("a wait the source names is honoured on any refusal: a redirect, a 400, a 404, a 451", async () => {
  for (const [status, expected, httpStatus] of [[302, "upstream_invalid", 502], [301, "upstream_invalid", 502], [400, "upstream_rejected", 502], [451, "upstream_rejected", 502], [404, "upstream_invalid", 502]]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const a = w.isolate();
    const answer = a.ask("AAPL");
    await until(() => w.starts.length === 1, "start");
    w.held.shift().status(status, { "Retry-After": "3600" });
    const first = await answer;
    assert.equal(first.status, httpStatus, `HTTP ${status}`);
    await refused(first, expected, 3600);
    assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000, `HTTP ${status}`);
    await w.clock.advance(901000);
    await refused(await w.isolate().ask("MSFT"), "upstream_unavailable", 3600 - 901);
    assert.equal(w.starts.length, 1, `nothing more is sent after HTTP ${status}`);
  }
  // Above 24 hours it is a halt here too.
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const answer = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "start");
  w.held.shift().status(302, { "Retry-After": "172800" });
  await answer;
  assert.equal((await w.isolate().health()).upstream.state, "halted");
});

test("only a real success ends a run of failures; a refusal that names no wait stops nothing by itself", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const a = w.isolate();
  const respond = async (symbol, status) => {
    const before = w.starts.length;
    const answer = a.ask(symbol);
    await until(() => w.starts.length === before + 1, `${symbol} starts`);
    if (status === 200) w.held.shift().ok(); else w.held.shift().status(status);
    return answer;
  };
  await respond("AAPL", 503);
  assert.equal((await respond("MSFT", 302)).status, 502);
  assert.equal(w.storage.peek().cooldownUntil, 0, "a redirect alone starts no cooldown (the owner may decide otherwise)");
  await respond("SPY", 503);
  await respond("VST", 400);
  await respond("SAP.DE", 503); // the third failure, with refusals in between
  await refused(await a.ask("VOD.L"), "upstream_unavailable", COOLDOWN_SECONDS.upstream_unavailable);
  assert.equal(w.starts.length, 5);

  const healthy = world({ limits: { upstreamMinSpacingMs: 0 } });
  const b = healthy.isolate();
  for (const [symbol, status] of [["AAPL", 503], ["MSFT", 503], ["SPY", 200], ["VST", 503], ["SAP.DE", 503]]) {
    const before = healthy.starts.length;
    const answer = b.ask(symbol);
    await until(() => healthy.starts.length === before + 1, `${symbol} starts`);
    if (status === 200) healthy.held.shift().ok(); else healthy.held.shift().status(status);
    await answer;
  }
  assert.equal(healthy.storage.peek().cooldownUntil, 0, "a success between them ended the run");
});

test("an upstream timeout retains an unknown outcome and prevents all further starts", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0, upstreamTimeoutMs: 5 } });
  const a = w.isolate();
  await refused(await a.ask("AAPL"), "busy", 60);
  assert.equal(w.storage.peek().unresolved.length, 1);
  await refused(await a.ask("MSFT"), "busy", 60);
  assert.equal(w.starts.length, 1, "timeout does not establish what the provider actually did");
  w.coordinator.restart();
  await w.clock.jump(40 * 86400000);
  await refused(await w.isolate().ask("SPY"), "busy", 60);
  assert.equal(w.starts.length, 1);
});

test("a stop is recorded the moment the refusal arrives, even if the body of the refusal never ends", async () => {
  const w = world();
  const a = w.isolate();
  const first = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const queued = a.ask("MSFT");
  await until(() => w.clock.pending() > 0, "queued");
  w.held.shift().raw({ status: 429, headers: new Headers({ "Retry-After": "3600" }), body: { cancel: () => new Promise(() => {}) } });
  await refused(await first, "upstream_rate_limited", 3600);
  assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000);
  await w.clock.jump(20000);
  await refused(await queued, "upstream_rate_limited");
  assert.equal(w.starts.length, 1, "nothing started after the refusal arrived");
});

/* ---------------- 3. every isolate under one set of limits ---------------- */
test("spacing, the in-flight limit and first come first served hold across isolates", async () => {
  const w = world();
  const isolates = [w.isolate(), w.isolate(), w.isolate()];
  const symbols = ["AAPL", "MSFT", "SPY", "VST", "SAP.DE", "VOD.L"];
  const answers = [];
  for (const [i, symbol] of symbols.entries()) answers.push(...await w.enter(isolates[i % 3], [symbol]));
  let peak = 0;
  await until(() => w.starts.length === 1, "first");
  for (let i = 0; i < 40 && w.starts.length < symbols.length; i += 1) {
    await w.clock.advance(400);
    peak = Math.max(peak, w.held.length);
    w.held.splice(0, i % 3 === 0 ? 2 : 1).forEach(h => h.ok());
  }
  await until(() => w.starts.length === symbols.length, "all started");
  releaseAll(w);
  assert.ok((await Promise.all(answers)).every(r => r.status === 200));
  const gaps = w.starts.slice(1).map((s, i) => s.at - w.starts[i].at);
  assert.ok(gaps.every(g => g >= LIMITS.upstreamMinSpacingMs), `gaps ${gaps}`);
  assert.deepEqual(w.starts.map(s => s.symbol), symbols);
  assert.ok(peak <= LIMITS.upstreamInFlight, `peak ${peak}`);
});

test("the budget holds across isolates in any 60 s window: no fresh burst at the turn of a minute", async () => {
  const w = world({ limits: { upstreamPerMinute: 3 } });
  const [a, b] = [w.isolate(), w.isolate()];
  // One request; afterwards the clock has moved on by one spacing.
  const run = async (isolate, symbol) => {
    const before = w.starts.length;
    let settled = false;
    const answer = isolate.ask(symbol).finally(() => { settled = true; });
    await until(() => settled || w.starts.length > before, `${symbol} started or refused`);
    await w.clock.advance(LIMITS.upstreamMinSpacingMs);
    releaseAll(w);
    return answer;
  };
  await w.clock.advance(57000);
  assert.equal((await run(a, "AAPL")).status, 200); // starts at 57 s
  assert.equal((await run(b, "MSFT")).status, 200); // 58 s
  assert.equal((await run(a, "SPY")).status, 200); // 59 s
  assert.equal(w.elapsed(), 60000);
  // A fixed window would allow three more here, six starts in six seconds.
  await refused(await run(b, "VST"), "throttled");
  assert.equal(w.starts.length, 3);
  await w.clock.advance(116999 - w.elapsed());
  await refused(await run(a, "VST"), "throttled"); // 59.999 s after the first start
  assert.equal(w.starts.length, 3);
  assert.equal((await run(b, "VST")).status, 200); // 60.999 s after the first start
  assert.equal(w.starts.length, 4);
  assert.deepEqual(w.violations, []);
});

test("identical requests from different isolates share one upstream request and one retrieval time", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const answers = [w.isolate().ask("VOD.L"), w.isolate().ask("VOD.L"), w.isolate().ask("VOD.L")];
  await until(() => w.starts.length === 1 && w.coordinator.arrivals.length === 3, "one start, three clients");
  await new Promise(resolve => setTimeout(resolve, 5));
  releaseAll(w);
  const bodies = await Promise.all((await Promise.all(answers)).map(r => r.json()));
  assert.equal(w.starts.length, 1);
  assert.equal(bodies.filter(b => b.cache.status === "miss").length, 1);
  assert.ok(bodies.every(b => b.retrievedAt === bodies[0].retrievedAt && b.price === bodies[0].price));
});

/* ---------------- 4. restart and recovery ---------------- */
test("a restarted coordinator recovers its deadline, its halt, its spacing, its budget and its failure count", async () => {
  // Deadline.
  const deadline = world({ limits: { upstreamMinSpacingMs: 0 } });
  const stopped = deadline.isolate().ask("AAPL");
  await until(() => deadline.starts.length === 1, "start");
  deadline.held.shift().status(429, { "Retry-After": "3600" });
  await stopped;
  deadline.coordinator.restart();
  await deadline.clock.advance(901000);
  await refused(await deadline.isolate().ask("MSFT"), "upstream_rate_limited", 3600 - 901);
  assert.equal(deadline.starts.length, 1);

  // Halt.
  const halted = world({ limits: { upstreamMinSpacingMs: 0 } });
  const stop = halted.isolate().ask("AAPL");
  await until(() => halted.starts.length === 1, "start");
  halted.held.shift().status(429, { "Retry-After": "172800" });
  await stop;
  halted.coordinator.restart();
  await halted.clock.jump(30 * 86400000);
  await refused(await halted.isolate().ask("MSFT"), "upstream_rate_limited", MAX_COOLDOWN_SECONDS);
  assert.equal(halted.starts.length, 1);

  // Spacing: a restart 100 ms after a start must not allow a second start 100 ms later.
  const spaced = world();
  const first = spaced.isolate().ask("AAPL");
  await until(() => spaced.starts.length === 1, "start");
  releaseAll(spaced);
  await first;
  await spaced.clock.advance(100);
  spaced.coordinator.restart();
  const second = spaced.isolate().ask("MSFT");
  await until(() => spaced.clock.pending() > 0, "waits for its turn");
  assert.equal(spaced.starts.length, 1);
  await spaced.clock.advance(899);
  assert.equal(spaced.starts.length, 1, "not before 1 s");
  await spaced.clock.advance(1);
  await until(() => spaced.starts.length === 2, "at 1 s");
  releaseAll(spaced);
  assert.equal((await second).status, 200);
  assert.equal(spaced.starts[1].at - spaced.starts[0].at, 1000);

  // Budget.
  const budget = world({ limits: { upstreamPerMinute: 1, upstreamMinSpacingMs: 0 } });
  const only = budget.isolate().ask("AAPL");
  await until(() => budget.starts.length === 1, "start");
  releaseAll(budget);
  await only;
  budget.coordinator.restart();
  await refused(await budget.isolate().ask("MSFT"), "throttled");
  assert.equal(budget.starts.length, 1);

  // Failure count: two failures, a restart, a third failure: the breaker opens.
  const failing = world({ limits: { upstreamMinSpacingMs: 0 } });
  for (const [i, symbol] of ["AAPL", "MSFT", "SPY"].entries()) {
    if (i === 2) failing.coordinator.restart();
    const answer = failing.isolate().ask(symbol);
    await until(() => failing.starts.length === i + 1, "start");
    failing.held.shift().status(503);
    assert.equal((await answer).status, 502);
  }
  await refused(await failing.isolate().ask("VST"), "upstream_unavailable", COOLDOWN_SECONDS.upstream_unavailable);
  assert.equal(failing.starts.length, 3);
});

/* ---------------- 5. M4: incident-bound approval (UPSTREAM_INCIDENT_APPROVAL) ---------------- */
async function halt(w, symbol) {
  const before = w.starts.length;
  const answer = w.isolate().ask(symbol);
  await until(() => w.starts.length === before + 1, "start");
  w.held.shift().status(429, { "Retry-After": "172800" });
  await answer;
  assert.equal((await w.isolate().health()).upstream.state, "halted");
}
const blockedStill = async (w, symbol, why) => {
  const before = w.starts.length;
  await refused(await w.isolate().ask(symbol), "upstream_rate_limited", MAX_COOLDOWN_SECONDS);
  assert.equal(w.starts.length, before, why);
};
async function reachable(w, symbol) {
  const before = w.starts.length;
  const answer = w.isolate().ask(symbol);
  await until(() => w.starts.length === before + 1, `${symbol} reaches the source`);
  releaseAll(w);
  assert.equal((await answer).status, 200);
}

// A new deployment restarts the coordinator with its own settings: the source on or off (M1).
function setSource(env, on) {
  if (on) Object.assign(env, COORDINATOR_ON);
  else { delete env.KEYLESS_SOURCE; delete env.OWNER_ATTESTATION; }
}
// The source-off deployment: the object starts at once and evaluates any approval (M4/D2). Since
// M1 it sends nothing, whoever asks.
function deployOff(w, env) {
  setSource(env, false);
  w.coordinator.restart();
  w.coordinator.start();
}
function deployOn(w, env) {
  setSource(env, true);
  w.coordinator.restart();
}
// The owner's recovery (gateway README): a source-off deployment carrying the approval, whose start
// evaluates it, then the source-on deployment with the value left in place (it is then `consumed`).
function approve(w, env, value = approvalFor(w.storage)) {
  env.UPSTREAM_INCIDENT_APPROVAL = value;
  deployOff(w, env);
  deployOn(w, env);
}
const lastResult = w => w.storage.peek().approvalResult?.result;

test("M4: an approval prepared before the incident cannot clear it, before or after a restart", async () => {
  // The value an owner could have set in advance: any generation, any nonce.
  for (const early of [`g1-${"a".repeat(26)}`, `g2-${"b".repeat(26)}`]) {
    const env = { ...COORDINATOR_ON, UPSTREAM_INCIDENT_APPROVAL: early };
    const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
    assert.equal((await w.isolate().health()).upstream.state, "ok");
    await halt(w, "AAPL");
    await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
    await blockedStill(w, "MSFT", "the value in place does nothing");
    w.coordinator.restart(); // the next deployment
    await blockedStill(w, "MSFT", "nor at the next start");
    assert.ok(["mismatch", "unknown_generation"].includes(lastResult(w)), lastResult(w));
    assert.equal(w.starts.length, 1);
  }
});

test("M4: the approval of the current incident clears it once, at the next start, with the source off; replay and later incidents do nothing", async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  await halt(w, "AAPL");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  const first = approvalFor(w.storage);
  assert.match(first, /^g1-[a-z2-7]{26}$/);
  env.UPSTREAM_INCIDENT_APPROVAL = first;
  await blockedStill(w, "MSFT", "not before the coordinator starts again: requests never evaluate it");
  approve(w, env, first);
  await reachable(w, "MSFT");
  assert.equal(w.starts.length, 2);
  assert.deepEqual(w.storage.approvals(), [1]);
  assert.equal(w.storage.peek().incident, null);

  // Replay: the same value at later starts, and with a new incident.
  w.coordinator.restart();
  assert.equal((await w.isolate().health()).upstream.state, "ok");
  assert.equal(lastResult(w), "consumed");
  await halt(w, "SPY");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  assert.equal(w.storage.peek().incident.generation, 2);
  w.coordinator.restart();
  await blockedStill(w, "VST", "an earlier incident's approval does nothing for a new one");
  assert.equal(lastResult(w), "consumed");
  approve(w, env);
  await reachable(w, "VST");
  assert.deepEqual(w.storage.approvals(), [1, 2]);
  assert.equal(w.starts.length, 4);

  for (const bad of ["", "   ", "G3-x", `g0-${"a".repeat(26)}`, `g1-${"A".repeat(26)}`, `g1-${"a".repeat(27)}`, "2026-11-05"]) {
    const v = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: { ...COORDINATOR_ON } });
    await halt(v, "AAPL");
    await v.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
    const nonce = v.storage.peek().incident.nonce;
    approve(v, v.coordinator.env, bad === "G3-x" ? `G1-${nonce}` : bad);
    await blockedStill(v, "MSFT", `a malformed or foreign value does nothing: ${JSON.stringify(bad)}`);
  }
});

test("M4: a change of the incident rotates it: an approval read before the change no longer matches", async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const answers = [...await w.enter(w.isolate(), ["AAPL"]), ...await w.enter(w.isolate(), ["MSFT"])];
  await until(() => w.starts.length === 2, "two in flight");
  w.held.shift().reject(new TypeError("connection reset before headers")); // an unknown outcome
  await refused(await answers[0], "busy");
  const scopeOne = w.storage.peek().incident;
  assert.equal(scopeOne.generation, 1);
  assert.deepEqual(scopeOne.scope.halt, null);
  assert.equal(scopeOne.scope.markers.length, 1);
  const early = approvalFor(w.storage);
  w.held.shift().status(429, { "Retry-After": "172800" }); // then a halt-level direction
  await answers[1];
  const scopeTwo = w.storage.peek().incident;
  assert.equal(scopeTwo.generation, 2, "the halt is a new generation");
  assert.notEqual(scopeTwo.nonce, scopeOne.nonce);
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000); // past the drain and the halt's own minimum
  approve(w, env, early);
  await refused(await w.isolate().ask("SPY"), "busy");
  assert.equal(lastResult(w), "stale_generation");
  approve(w, env);
  await reachable(w, "SPY");
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.equal(w.storage.peek().haltCode, null, "the halt and the unknown outcome end together");
  assert.equal(w.starts.length, 3);

  // A repeated halt-level direction while halted is new evidence: it rotates too.
  const v = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: { ...COORDINATOR_ON } });
  const pair = [...await v.enter(v.isolate(), ["AAPL"]), ...await v.enter(v.isolate(), ["MSFT"])];
  await until(() => v.starts.length === 2, "two in flight");
  v.held.shift().status(429, { "Retry-After": "172800" });
  await pair[0];
  const before = approvalFor(v.storage);
  v.held.shift().status(429, { "Retry-After": "259200" });
  await pair[1];
  assert.notEqual(approvalFor(v.storage), before);
  approve(v, v.coordinator.env, before);
  await blockedStill(v, "SPY", "approved before the second direction");
  // An ordinary refusal under the halt changes nothing about the incident.
  const w3 = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: { ...COORDINATOR_ON } });
  const both = [...await w3.enter(w3.isolate(), ["AAPL"]), ...await w3.enter(w3.isolate(), ["MSFT"])];
  await until(() => w3.starts.length === 2, "two in flight");
  w3.held.shift().status(429, { "Retry-After": "172800" });
  await both[0];
  const halted = approvalFor(w3.storage);
  w3.held.shift().status(429, { "Retry-After": "3600" });
  await both[1];
  assert.equal(approvalFor(w3.storage), halted, "a cooldown is not part of the incident");
});

test("M4: an approval is refused while the source is on, and while the incident's request may still be running", async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const answer = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  w.held.shift().reject(new TypeError("connection reset before headers"));
  await refused(await answer, "busy");
  env.UPSTREAM_INCIDENT_APPROVAL = approvalFor(w.storage);
  w.coordinator.restart(); // a deployment that leaves the source on
  await refused(await w.isolate().ask("MSFT"), "busy");
  assert.equal(lastResult(w), "source_on", "recovery is a deliberate source-off deployment (D2)");
  deployOff(w, env);
  assert.equal(lastResult(w), "work_may_be_running", "the request is 0 s old: it may still be running");
  assert.equal(w.storage.peek().unresolved.length, 1);
  await refused(await w.isolate().ask("MSFT"), "source_disabled"); // M1: an enabled caller gets nothing from it
  await w.clock.jump(APPROVAL_DRAIN_MS);
  deployOff(w, env);
  assert.deepEqual(w.storage.peek().unresolved, [], "the source-off start applied the approval");
  assert.deepEqual(w.storage.approvals(), [1]);
  deployOn(w, env); // and the source-on deployment after it
  await reachable(w, "MSFT");
  assert.equal(w.starts.length, 2);
});

test("M4: an approval ends only the incident: an ordinary cooldown still runs to its deadline", async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const answers = [...await w.enter(w.isolate(), ["AAPL"]), ...await w.enter(w.isolate(), ["MSFT"])];
  await until(() => w.starts.length === 2, "both");
  w.held[0].status(429, { "Retry-After": "172800" }); // a halt
  await answers[0];
  w.held[1].status(429, { "Retry-After": "3600" }); // an ordinary cooldown under it
  await answers[1];
  await w.clock.advance(1000000);
  approve(w, env);
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 2600);
  assert.equal(w.storage.peek().haltCode, null);
  assert.equal(w.starts.length, 2);
  await w.clock.advance(2600000);
  await reachable(w, "SPY");

  // An ordinary cooldown alone is no incident: there is nothing to approve.
  const p = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: { ...COORDINATOR_ON } });
  const refusedOnce = p.isolate().ask("AAPL");
  await until(() => p.starts.length === 1, "start");
  p.held.shift().status(429, { "Retry-After": "3600" });
  await refusedOnce;
  assert.equal(p.storage.peek().incident, null);
  approve(p, p.coordinator.env, `g1-${"a".repeat(26)}`);
  await refused(await p.isolate().ask("MSFT"), "upstream_rate_limited", 3600);
  assert.equal(lastResult(p), "no_incident");
  assert.equal(p.starts.length, 1);
});

test("M4: an approval that cannot be written leaves the incident in force and is not used up", async () => {
  for (const failure of ["failWrites", "failApproval"]) {
    const env = { ...COORDINATOR_ON };
    const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
    await halt(w, "AAPL");
    await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
    w.storage[failure] = true;
    env.UPSTREAM_INCIDENT_APPROVAL = approvalFor(w.storage);
    deployOff(w, env); // the start's approval cannot be recorded
    assert.equal(w.storage.peek().haltCode, "upstream_rate_limited");
    assert.deepEqual(w.storage.approvals(), []);
    assert.equal((await w.isolate().health()).upstream.state, "halted", "the retried start leaves the approval out: still halted");
    w.storage[failure] = false;
    // The same instance: requests and health retry the start, never the approval.
    assert.equal((await w.isolate().health()).upstream.state, "halted");
    await refused(await w.isolate().ask("MSFT"), "source_disabled");
    assert.deepEqual(w.storage.approvals(), []);
    assert.equal(w.starts.length, 1, "nothing is sent on an approval that was not recorded");
    deployOff(w, env); // the next start (a deployment) evaluates it again, and it still matches
    assert.deepEqual(w.storage.approvals(), [1]);
    deployOn(w, env);
    await reachable(w, "MSFT");
  }
});

test("M4: a row another writer changed while an incident was open cannot end it: what it removed stays halted", async () => {
  for (const [what, edit] of [
    ["the halt", row => ({ ...row, haltCode: null })],
    ["the unknown outcome", row => ({ ...row, unresolved: [] })],
  ]) {
    const env = { ...COORDINATOR_ON };
    const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
    if (what === "the halt") await halt(w, "AAPL");
    else {
      const answer = w.isolate().ask("AAPL");
      await until(() => w.starts.length === 1, "admission");
      w.held.shift().reject(new TypeError("connection reset before headers"));
      await refused(await answer, "busy");
    }
    await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
    const before = approvalFor(w.storage);
    w.storage.corrupt(edit(w.storage.peek())); // an older version or a manual edit; the seal no longer matches
    approve(w, env, before);
    await refused(await w.isolate().ask("MSFT"), what === "the halt" ? "upstream_rate_limited" : "upstream_unavailable", MAX_COOLDOWN_SECONDS);
    assert.equal(w.starts.length, 1, `${what} removed by other code is not a recovery`);
    assert.equal(lastResult(w), "stale_generation");
    assert.ok(w.storage.peek().haltCode, "halted under a new incident");
    approve(w, env); // the owner approves the new incident
    await reachable(w, "MSFT");
    assert.equal(w.starts.length, 2);
  }
});

test("M4: health reads change nothing, however often: no write, no rotation, no approval", async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const answer = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "admission");
  w.held.shift().reject(new TypeError("connection reset before headers"));
  await refused(await answer, "busy");
  await w.clock.jump(APPROVAL_DRAIN_MS);
  env.UPSTREAM_INCIDENT_APPROVAL = approvalFor(w.storage); // in env, but this instance has started
  const disk = JSON.stringify(w.storage.peek());
  const writes = w.storage.writes;
  for (let i = 0; i < 50; i++) assert.equal((await w.isolate().health()).upstream.state, "unverified");
  assert.equal(JSON.stringify(w.storage.peek()), disk);
  assert.equal(w.storage.writes, writes);
  assert.deepEqual(w.storage.approvals(), []);
  assert.equal(w.starts.length, 1);
  // A started instance's status alone, with a failed write held in memory: still nothing written.
  const core = new UpstreamCoordinatorCore({ storage: memoryStorage(), env: {}, now: () => NOW, log: () => {} });
  core.status();
  core.unsaved = true;
  const held = core.storage.writes;
  for (let i = 0; i < 10; i++) assert.equal(core.status().state, "unverified");
  assert.equal(core.storage.writes, held);
});

test("M4: state written before M4, or by other code, is bound to a new incident; the legacy identifier does nothing", async () => {
  // An R7 row: a halt and an unknown outcome, no incident fields, a legacy identifier in env.
  const storage = memoryStorage();
  storage.corrupt({ cooldownUntil: NOW + 900000, cooldownCode: "upstream_rate_limited", haltCode: "upstream_rate_limited", failures: 0, starts: [NOW], unresolved: [{ id: "r7-marker", startedAt: NOW }] });
  const env = { ...COORDINATOR_ON, UPSTREAM_REACTIVATION_ID: "never-seen-2026" };
  const w = world({ storage, limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  await refused(await w.isolate().ask("AAPL"), "busy");
  const bound = storage.peek().incident;
  assert.equal(bound.generation, 1);
  assert.deepEqual(bound.scope, { halt: "upstream_rate_limited", markers: ["r7-marker"] });
  assert.equal(storage.read().sealed, true, "written by M4 from now on");
  await w.clock.jump(APPROVAL_DRAIN_MS + 900000);
  w.coordinator.restart();
  await refused(await w.isolate().ask("AAPL"), "busy");
  assert.equal(w.starts.length, 0);
  approve(w, env);
  await reachable(w, "AAPL");

  // A rollback to an older version writes the row without the seal: a later approval prepared
  // for the M4 incident cannot match what the older code left.
  await halt(w, "MSFT");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  const old = approvalFor(storage);
  const row = storage.peek();
  storage.corrupt({ ...row, starts: [...row.starts, w.clock.now()] }); // an older version's own write
  approve(w, env, old);
  await blockedStill(w, "SPY", "rebound after a foreign write");
  assert.equal(lastResult(w), "stale_generation");
  assert.equal(storage.peek().incident.generation, row.incident.generation + 1);
  approve(w, env);
  await reachable(w, "SPY");
});

/* ---------------- M1. the coordinator enforces its own deployment's activation ---------------- */
test("M1: a coordinator whose deployment has the source off sends nothing for an enabled (stale) caller, and touches no storage", async () => {
  for (const coordinatorEnv of [
    {}, { KEYLESS_SOURCE: "" }, { KEYLESS_SOURCE: "yahoo-chart" }, { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "off" },
    { KEYLESS_SOURCE: "off", OWNER_ATTESTATION: "owner-confirms-yahoo-permission" }, { KEYLESS_SOURCE: "stooq", OWNER_ATTESTATION: "owner-confirms-yahoo-permission" },
  ]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv });
    const stale = w.isolate(); // an isolate of the previous version, whose settings still say on
    for (const symbol of ["AAPL", "VEQT.TO", "AAPL"]) {
      const r = await stale.ask(symbol);
      assert.equal(r.status, 503, JSON.stringify(coordinatorEnv));
      await refused(r, "source_disabled");
    }
    assert.equal(w.coordinator.arrivals.length, 3, "the stale caller did reach the coordinator");
    assert.equal(w.starts.length, 0, `nothing reaches the source: ${JSON.stringify(coordinatorEnv)}`);
    assert.equal(w.storage.writes, 0, "no admission and no budget");
    assert.equal(w.storage.peek(), null);
  }
  // Checked at entry, before storage: the answer is the same when its state cannot even be read.
  const w = world({ coordinatorEnv: {} });
  w.storage.failReads = true;
  await refused(await w.isolate().ask("AAPL"), "source_disabled");
  assert.equal(w.starts.length, 0);
});

test("M1: the reverse combination: a Worker with the source off never asks a coordinator that is on", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  for (const env of [{ OWNER_ATTESTATION: "" }, { KEYLESS_SOURCE: "" }]) {
    await refused(await w.isolate({ env }).ask("AAPL"), "source_disabled");
  }
  assert.equal(w.coordinator.arrivals.length, 0);
  assert.equal(w.starts.length, 0);
});

// The timeout turns a request let through (which then waits forever for its held answer) into a failure.
test("M1: work queued when the source goes off is refused immediately before admission: never sent, no budget", { timeout: 10000 }, async () => {
  const env = { ...COORDINATOR_ON };
  const w = world({ limits: { upstreamMinSpacingMs: 1000 }, coordinatorEnv: env });
  const answers = await w.enter(w.isolate(), ["AAPL", "MSFT", "SPY"]);
  await until(() => w.starts.length === 1, "the first is admitted; two wait for the spacing");
  const budget = w.storage.peek().starts.length;
  // The settings as the object sees them. In production they are fixed for an instance's life; the
  // check before admission is the second line behind the one at entry.
  setSource(env, false);
  releaseAll(w);
  await w.clock.advance(3000);
  assert.equal((await answers[0]).status, 200, "the request admitted while on completes");
  await refused(await answers[1], "source_disabled");
  await refused(await answers[2], "source_disabled");
  assert.equal(w.starts.length, 1);
  assert.equal(w.storage.peek().starts.length, budget, "no budget used");
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.deepEqual(w.violations, []);
});

/* ---------------- 6. storage that fails ---------------- */
test("state that cannot be read: nothing is sent, the answer says so, and it recovers by itself", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  w.storage.failReads = true;
  const a = w.isolate();
  const answer = await a.ask("AAPL");
  assert.equal(answer.status, 503);
  await refused(answer, "busy", 60);
  const body = await answer.json();
  assert.equal(body.error.retryAfterSeconds, 60);
  assert.equal(body.error.retryable, true);
  assert.equal(w.starts.length, 0);
  const h = await a.health();
  assert.equal(h.status, "degraded");
  assert.deepEqual(h.upstream, { state: "unverified", code: null, retryAfterSeconds: 60, reason: "coordinator_state_unverified" });
  w.storage.failReads = false;
  await reachable(w, "AAPL");
  assert.equal((await a.health()).status, "ok");
});

test("an admission that cannot be written is not admitted: nothing is sent and no budget is used", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const a = w.isolate();
  await reachable(w, "AAPL");
  const writes = w.storage.writes;
  w.storage.failWrites = true;
  await refused(await a.ask("MSFT"), "busy", 60);
  await refused(await a.ask("SPY"), "busy", 60);
  assert.equal(w.starts.length, 1, "the upstream request never starts unless its start is recorded");
  assert.equal(w.storage.writes, writes);
  const down = await a.health();
  assert.equal(down.status, "degraded", "health says so while writes fail");
  assert.equal(down.upstream.state, "unverified");
  w.storage.failWrites = false;
  assert.equal(w.storage.peek().starts.length, 1);
  await reachable(w, "MSFT");
  assert.equal((await a.health()).status, "ok", "and recovers by itself");
});

test("a stop that cannot be written still holds; everything is refused until it is written, and then it is on disk", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const a = w.isolate();
  const stopped = a.ask("AAPL");
  await until(() => w.starts.length === 1, "start");
  w.storage.failWrites = true; // the admission was written; the refusal cannot be
  w.held.shift().status(429, { "Retry-After": "3600" });
  await refused(await stopped, "busy", 60);
  assert.equal(w.storage.peek().cooldownUntil, 0, "not on disk yet");
  await refused(await a.ask("MSFT"), "busy", 60);
  assert.equal((await a.health()).upstream.state, "unverified");
  assert.equal(w.starts.length, 1);
  w.storage.failWrites = false;
  await refused(await a.ask("MSFT"), "upstream_rate_limited", 3600);
  assert.equal(w.storage.peek().cooldownUntil, NOW + 3600000, "written as soon as writing works");
  w.coordinator.restart();
  await refused(await a.ask("MSFT"), "upstream_rate_limited", 3600);
  assert.equal(w.starts.length, 1);
});

test("state that is not well formed is not trusted: nothing is sent, whatever it says", async () => {
  const good = { cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: [] };
  const corrupted = [
    { ...good, cooldownUntil: "soon", cooldownCode: "upstream_rate_limited" },
    { ...good, cooldownUntil: -1, cooldownCode: "upstream_rate_limited" },
    { ...good, cooldownUntil: 1.5, cooldownCode: "upstream_rate_limited" },
    { ...good, cooldownUntil: NOW + 1000, cooldownCode: null },
    { ...good, cooldownUntil: NOW + 1000, cooldownCode: "made_up" },
    { ...good, haltCode: "made_up" },
    { ...good, haltCode: 1 },
    { ...good, failures: "x" },
    { ...good, starts: "x" },
    { ...good, starts: [NOW, "x"] },
    { cooldownUntil: 0 },
    [],
    "text",
  ];
  for (const state of corrupted) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    w.storage.corrupt(state);
    const a = w.isolate();
    const answer = await a.ask("AAPL");
    assert.equal(answer.status, 503, JSON.stringify(state));
    await refused(answer, "busy", 60);
    assert.equal(w.starts.length, 0, JSON.stringify(state));
    assert.equal((await a.health()).upstream.state, "unverified", JSON.stringify(state));
  }
});

/* ---------------- 7. a stop while requests are queued ---------------- */
test("concurrent requests during activation: everything queued stops, nothing more is sent, and no one joins work after the stop", async () => {
  const w = world();
  const [a, b] = [w.isolate(), w.isolate()];
  const inFlight = [...await w.enter(a, ["AAPL"]), ...await w.enter(b, ["MSFT"])];
  await until(() => w.starts.length === 1, "first");
  await w.clock.advance(1000);
  await until(() => w.starts.length === 2, "second");
  const queued = ["SPY", "VST", "SAP.DE", "VOD.L", "7203.T", "VEQT.TO"].map((s, i) => (i % 2 ? a : b).ask(s));
  await until(() => w.clock.pending() >= 6, "all queued");
  w.held[0].status(429);
  await refused(await inFlight[0], "upstream_rate_limited", COOLDOWN_SECONDS.upstream_rate_limited);
  // A timer that is due, or long overdue, cannot get past the stop.
  await w.clock.jump(LIMITS.upstreamMinSpacingMs);
  const answers = await Promise.all(queued);
  for (const answer of answers) assert.equal(await code(answer), "upstream_rate_limited");
  assert.equal(w.starts.length, 2, "nothing queued reached the source");
  assert.equal(w.storage.peek().starts.length, 2);
  // A new client for the request still in flight is refused rather than joining it.
  await refused(await b.ask("MSFT"), "upstream_rate_limited");
  // The request that was already out can only lengthen the stop.
  w.held[1].status(429, { "Retry-After": "7200" });
  await inFlight[1];
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 7200);
  assert.equal(w.starts.length, 2);
  assert.deepEqual(w.violations, []);
});

test("a stop and a due timer at the same moment, in either order: nothing starts once the stop is recorded", async () => {
  for (let i = 0; i < 20; i += 1) {
    const w = world();
    const a = w.isolate();
    const first = a.ask("AAPL");
    await until(() => w.starts.length === 1, "first");
    const queued = a.ask("MSFT");
    await until(() => w.clock.pending() > 0, "queued");
    const refuse = () => w.held.shift().status(429, { "Retry-After": "3600" });
    if (i % 2) {
      refuse();
      await w.clock.jump(LIMITS.upstreamMinSpacingMs);
    } else {
      const due = w.clock.jump(LIMITS.upstreamMinSpacingMs);
      refuse();
      await due;
    }
    await first;
    // Whichever came first, the queued request is either refused or started before the stop.
    await until(() => w.starts.length === 2 || w.clock.pending() === 0, "the wake");
    releaseAll(w);
    const answer = await queued;
    assert.ok(answer.status === 200 || (await code(answer)) === "upstream_rate_limited", `status ${answer.status}`);
    assert.deepEqual(w.violations, [], `round ${i}`);
    if (answer.status !== 200) assert.equal(w.starts.length, 1, "a refused request reached no one");
  }
});

/* ---------------- 8. clients that leave ---------------- */
test("a client that leaves while queued: the coordinator is told, it leaves the queue, and no budget is used", async () => {
  const w = world({ limits: { upstreamInFlight: 1 } });
  const a = w.isolate();
  const first = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const gone = new AbortController();
  const waits = [];
  const leaving = a.ask("MSFT", { signal: gone.signal, ctx: { waitUntil: p => waits.push(p) } });
  const stays = a.ask("SPY");
  await until(() => w.clock.pending() >= 2, "both waiting");
  gone.abort();
  assert.equal((await leaving).status, 499);
  assert.ok(waits.length >= 1, "the message to the coordinator outlives the client");
  await Promise.all(waits);
  w.held.shift().ok();
  await first;
  await w.clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  await until(() => w.starts.length === 2, "the next in line");
  assert.deepEqual(w.starts.map(s => s.symbol), ["AAPL", "SPY"]);
  assert.equal(w.storage.peek().starts.length, 2);
  releaseAll(w);
  assert.equal((await stays).status, 200);
});

test("shared work: it continues for a client that stays, and a new client never joins work everyone has left", async () => {
  const w = world({ limits: { upstreamInFlight: 1 } });
  const [a, b] = [w.isolate(), w.isolate()];
  const blocker = a.ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const [first, second] = [new AbortController(), new AbortController()];
  const clients = [...await w.enter(a, ["MSFT"], { signal: first.signal }), ...await w.enter(b, ["MSFT"], { signal: second.signal })];
  await until(() => w.clock.pending() >= 1, "waiting");
  first.abort();
  assert.equal((await clients[0]).status, 499);
  second.abort();
  assert.equal((await clients[1]).status, 499);
  const fresh = b.ask("MSFT"); // new work for the same symbol, not the cancelled one
  await until(() => w.clock.pending() >= 1, "waiting again");
  w.held.shift().ok();
  await blocker;
  await w.clock.advance(LIMITS.upstreamMinSpacingMs + LIMITS.upstreamQueuePollMs);
  await until(() => w.starts.length === 2, "the new client's request starts");
  releaseAll(w);
  assert.equal((await fresh).status, 200);
  assert.equal(w.storage.peek().starts.length, 2);
});

test("cancellation: a coordinator that cannot be told does not disturb the client; an unknown client is ignored", async () => {
  const w = world({ limits: { upstreamInFlight: 1 } });
  const gw = createGateway({ now: w.clock.now, log: () => {}, cache: null, limits: { upstreamTimeoutMs: 600000 } });
  const real = w.coordinator.getByName("yahoo-chart");
  const flaky = { getByName: () => ({ ...real, cancel: () => { throw new Error("gone"); } }) };
  const first = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "first");
  const gone = new AbortController();
  const answer = gw.handle(new Request(`${BASE}${quote("MSFT")}`, { signal: gone.signal, headers: { Origin: ORIGIN, "CF-Connecting-IP": "10.61.0.1" } }), { ...ON, UPSTREAM_COORDINATOR: flaky });
  await until(() => w.clock.pending() >= 1, "waiting");
  gone.abort();
  assert.equal((await answer).status, 499);
  await real.cancel("nobody");
  // The message was lost: the reservation is bounded by its deadline.
  await w.clock.jump(LIMITS.upstreamQueueMaxWaitMs + 1);
  w.held.shift().ok();
  await first;
  await w.clock.jump(LIMITS.upstreamQueuePollMs);
  assert.equal(w.starts.length, 1, "an expired reservation is never admitted");
});

/* ---------------- 9. a missing or failing coordinator ---------------- */
test("no usable coordinator: every data request is refused, nothing is sent, and the failed call is not repeated", async () => {
  const realFetch = globalThis.fetch;
  let contacted = 0;
  globalThis.fetch = async () => { contacted += 1; return new Response("{}"); };
  try {
    let calls = 0;
    const counted = fn => ({ getByName: () => ({ fetchChart: (...a) => { calls += 1; return fn(...a); }, status: () => { throw new Error("down"); }, cancel: () => {} }) });
    const quota = Object.assign(new Error("Exceeded allowed rows written in Durable Objects free tier."), { retryable: false });
    const bindings = {
      "no binding": undefined,
      "a plain variable where the binding should be": "UpstreamCoordinator",
      "not a namespace": {},
      "getByName throws": { getByName: () => { throw new Error("bad"); } },
      "the call throws": counted(() => { throw new Error("bad"); }),
      "the call rejects (object reset)": counted(async () => { throw new Error("Durable Object reset because its code was updated."); }),
      "the daily allowance is used up": counted(async () => { throw quota; }),
      "an overloaded object": counted(async () => { throw Object.assign(new Error("Too many requests queued"), { overloaded: true }); }),
      "an empty answer": counted(async () => null),
      "an answer that is not understood": counted(async () => ({})),
      "an unknown refusal": counted(async () => ({ code: "made_up" })),
      "a text of the wrong type": counted(async () => ({ text: 5, retrievedAt: NOW })),
      "text without a retrieval time": counted(async () => ({ text: "{}" })),
    };
    for (const [name, binding] of Object.entries(bindings)) {
      calls = 0;
      const gw = createGateway({ now: () => NOW, log: () => {}, cache: null });
      const env = { ...ON, ...(binding === undefined ? {} : { UPSTREAM_COORDINATOR: binding }) };
      const r = await gw.handle(new Request(`${BASE}${quote("AAPL")}`, { headers: { Origin: ORIGIN, "CF-Connecting-IP": "10.62.0.1" } }), env);
      assert.equal(r.status, 503, name);
      const body = await r.json();
      assert.equal(body.error.code, "busy", name);
      assert.equal(body.error.retryAfterSeconds, 60, name);
      assert.equal(r.headers.get("retry-after"), "60", name);
      assert.ok(calls <= 1, `${name}: no repeated call`);
      const h = await (await gw.handle(new Request(`${BASE}/v1/health`, { headers: { Origin: ORIGIN } }), env)).json();
      assert.equal(h.upstream.state, "unverified", name);
      assert.equal(h.status, "degraded", name);
      assert.equal(h.keyless.enabled, true, name);
    }
    assert.equal(contacted, 0, "the Worker has no way to reach the data source by itself");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a coordinator that never answers: the data request and health both end, without reaching the source", async () => {
  const silent = { getByName: () => ({ fetchChart: () => new Promise(() => {}), status: () => new Promise(() => {}), cancel: async () => {} }) };
  const gw = createGateway({ now: () => NOW, log: () => {}, cache: null, limits: { upstreamQueueMaxWaitMs: 10, upstreamTimeoutMs: 10, upstreamLeaseGraceMs: 10, coordinatorStatusWaitMs: 10 } });
  const r = await gw.handle(new Request(`${BASE}${quote("AAPL")}`, { headers: { Origin: ORIGIN, "CF-Connecting-IP": "10.62.0.2" } }), { ...ON, UPSTREAM_COORDINATOR: silent });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "busy");
  const h = await (await gw.handle(new Request(`${BASE}/v1/health`), { ...ON, UPSTREAM_COORDINATOR: silent })).json();
  assert.equal(h.upstream.state, "unverified");
  assert.equal(h.upstream.reason, "coordinator_unreachable");
});

test("cached answers do not need the coordinator; a source that is off never asks it", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  const gw = createGateway({ now: w.clock.now, log: () => {}, cache: null });
  const headers = { Origin: ORIGIN, "CF-Connecting-IP": "10.63.0.1" };
  const stored = gw.handle(new Request(`${BASE}${quote("AAPL")}`, { headers }), { ...ON, UPSTREAM_COORDINATOR: w.coordinator });
  await until(() => w.starts.length === 1, "start");
  releaseAll(w);
  assert.equal((await stored).status, 200);
  const cached = await (await gw.handle(new Request(`${BASE}${quote("AAPL")}`, { headers }), ON)).json();
  assert.equal(cached.cache.status, "hit");

  let asked = 0;
  const counting = { getByName: () => { asked += 1; return {}; } };
  const off = { ALLOWED_ORIGINS: ORIGIN, UPSTREAM_COORDINATOR: counting };
  assert.equal((await gw.handle(new Request(`${BASE}${quote("MSFT")}`, { headers }), off)).status, 503);
  const h = await (await gw.handle(new Request(`${BASE}/v1/health`), off)).json();
  assert.equal(h.keyless.enabled, false);
  assert.equal(asked, 0);
});

test("the coordinator has one address, takes no URL, and re-checks what it is asked for", async () => {
  const w = world();
  const answer = w.isolate().ask("AAPL");
  await until(() => w.starts.length === 1, "start");
  releaseAll(w);
  await answer;
  await w.isolate().health();
  assert.ok(w.coordinator.names.length >= 2);
  assert.ok(w.coordinator.names.every(name => name === "yahoo-chart"), "one object worldwide");
  const core = new UpstreamCoordinatorCore({ storage: memoryStorage(), env: COORDINATOR_ON, fetchImpl: () => { throw new Error("must not be called"); }, log: () => {} });
  assert.equal((await core.fetchChart({ kind: "quote", symbol: "https://evil.example/", client: "c" })).code, "invalid_symbol");
  assert.equal((await core.fetchChart({ kind: "quote", symbol: "^GSPC", client: "c" })).code, "unsupported_listing");
  assert.equal((await core.fetchChart({ kind: "history", symbol: "AAPL", range: "max", client: "c" })).code, "invalid_range");
});

/* ---------------- 10. configuration ---------------- */
test("configuration: the coordinator is bound in both configurations, SQLite-backed, exported, and the Worker cannot reach the source itself", async () => {
  const read = async relative => (await readFile(new URL(`../../../_services/market-data-gateway/${relative}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const toml = (await read("wrangler.toml")).replace(/^#.*$/gm, "");
  const [top, prod] = toml.split("\n[env.production]\n");
  for (const section of [top, prod]) {
    assert.match(section, /durable_objects\.bindings\]\]\nname = "UPSTREAM_COORDINATOR"\nclass_name = "UpstreamCoordinator"\n/, "repeated: bindings are not inherited");
  }
  assert.match(top, /\[exports\.UpstreamCoordinator\]\ntype = "durable-object"\nstorage = "sqlite"\n/, "the only kind of Durable Object Workers Free offers");
  assert.doesNotMatch(toml, /\[\[migrations\]\]/, "exports and migrations are mutually exclusive");
  assert.doesNotMatch(toml, /UPSTREAM_REACTIVATION_ID|UPSTREAM_INCIDENT_APPROVAL/, "an approval is a secret set for one incident, never configuration");

  const worker = await read("src/worker.js");
  assert.match(worker, /export class UpstreamCoordinator extends DurableObject/);
  assert.equal((worker.match(/^export (?!default)/gm) || []).length, 1, "the only named export of the main module");

  const gateway = (await read("src/gateway.js")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(gateway, /\bfetch\s*\(/, "the Worker never contacts the data source");
  assert.doesNotMatch(gateway, /chartUrl|query1\.finance/, "the Worker cannot even build the address");
  assert.doesNotMatch(gateway, /UPSTREAM_REACTIVATION_ID|UPSTREAM_INCIDENT_APPROVAL/, "an approval is read by the coordinator alone");
  const coordinatorSource = (await read("src/coordinator.js")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(coordinatorSource, /UPSTREAM_REACTIVATION_ID/, "the pre-M4 identifier is no longer accepted (M4/D5)");
  assert.doesNotMatch(gateway, /state\/cooldown/, "no stop in the Cache API");
});

test("the error contract is unchanged: no code a client does not know", async () => {
  const source = await readFile(new URL("../../../_services/market-data-gateway/src/gateway.js", import.meta.url), "utf8");
  const statuses = source.slice(source.indexOf("const STATUS = {"), source.indexOf("const RETRY_AFTER"));
  assert.doesNotMatch(statuses, /coordinator/, "a coordinator failure reaches clients as `busy`");
  const client = await readFile(new URL("../../../assets/js/market-data/keyless.js", import.meta.url), "utf8");
  assert.match(client, /\bbusy\b/);
});
