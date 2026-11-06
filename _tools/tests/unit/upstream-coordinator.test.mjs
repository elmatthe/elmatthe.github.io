// The upstream coordinator: admission, stops, reactivation and every way it can fail, with
// several Worker isolates sharing one coordinator, on a clock the test controls. Timers can
// be made to fire late, or never. Yahoo is synthetic. The same scenarios run against the real
// Workers runtime and real SQLite in ../worker-runtime/gateway-runtime.test.cjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGateway, LIMITS, COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS, VERSION } from "../../../_services/market-data-gateway/src/gateway.js";
import { UpstreamCoordinatorCore } from "../../../_services/market-data-gateway/src/coordinator.js";
import { yahooFetch } from "../fixtures/yahoo-chart.mjs";
import { localCoordinator, memoryStorage } from "../fixtures/local-coordinator.mjs";

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
function world({ limits = {}, coordinatorEnv = {}, storage = memoryStorage(), cache = null } = {}) {
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
      held.push({ symbol, ok: () => resolve(answer(url, init)), status: (status, headers = {}) => resolve(new Response("x", { status, headers })), raw: resolve, reject });
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

test("H1: only a fresh owner identifier resolves restart uncertainty; failed transaction and old identifiers do not", async () => {
  const env = { UPSTREAM_REACTIVATION_ID: "before-uncertainty" };
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
  env.UPSTREAM_REACTIVATION_ID = "owner-after-drain";
  w.storage.failReactivation = true;
  await refused(await w.isolate().ask("SPY"), "busy", 60);
  assert.equal(w.storage.peek().unresolved.length, 1);
  assert.ok(!w.storage.read().seen.includes("owner-after-drain"), "failed transaction did not consume the identifier");
  w.storage.failReactivation = false;
  await reachable(w, "SPY");
  assert.deepEqual(w.storage.peek().unresolved, []);
  assert.ok(w.storage.read().seen.includes("owner-after-drain"));
  const later = w.isolate().ask("VST");
  await until(() => w.starts.length === 3, "later admission");
  w.storage.failWrites = true;
  w.held.shift().status(429, { "Retry-After": "3600" });
  await later;
  w.coordinator.restart();
  w.storage.failWrites = false;
  for (const id of ["before-uncertainty", "owner-after-drain"]) {
    env.UPSTREAM_REACTIVATION_ID = id;
    await refused(await w.isolate().ask("SAP.DE"), "busy", 60);
  }
  assert.equal(w.starts.length, 3);
});

test("H1: reactivation history without its state row is inconsistent, not pristine", async () => {
  const storage = memoryStorage();
  storage.reactivate({ cooldownUntil: 0, cooldownCode: null, haltCode: null, failures: 0, starts: [], unresolved: [] }, "previous-owner");
  storage.corrupt(null);
  const w = world({ storage, coordinatorEnv: { UPSTREAM_REACTIVATION_ID: "new-owner" } });
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
    const w = world({ storage, coordinatorEnv: { UPSTREAM_REACTIVATION_ID: "cannot-repair" } });
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

test("H1: network rejection is finalized as unavailable; SQL rejection stays unverified", async () => {
  for (const failWrites of [false, true]) {
    const w = world({ limits: { upstreamMinSpacingMs: 0 } });
    const first = w.isolate().ask("AAPL");
    await until(() => w.starts.length === 1, "admission");
    w.storage.failWrites = failWrites;
    w.held.shift().reject(new TypeError("synthetic network failure"));
    await refused(await first, failWrites ? "busy" : "upstream_unavailable");
    assert.equal(w.storage.peek().unresolved.length, failWrites ? 1 : 0);
    assert.equal(w.storage.peek().failures, failWrites ? 0 : 1);
    w.storage.failWrites = false;
    if (failWrites) {
      w.coordinator.restart();
      await refused(await w.isolate().ask("MSFT"), "busy", 60);
      assert.equal(w.starts.length, 1);
    }
  }
});

test("H1: an identifier observed while a request is active cannot clear its later aborted unknown outcome", async () => {
  const env = {};
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const gone = new AbortController();
  const first = w.isolate().ask("AAPL", { signal: gone.signal });
  await until(() => w.starts.length === 1, "admission");
  env.UPSTREAM_REACTIVATION_ID = "observed-while-active";
  assert.equal((await w.isolate().health()).upstream.state, "ok", "healthy current-instance concurrency is not uncertainty");
  assert.equal(w.storage.peek().unresolved.length, 1, "reactivation never erases an active admission");
  gone.abort();
  assert.equal((await first).status, 499);
  await until(() => w.storage.peek().unresolved.length === 1, "unknown marker remains");
  w.coordinator.restart();
  await w.clock.jump(40 * 86400000);
  await refused(await w.isolate().ask("MSFT"), "busy", 60);
  assert.equal(w.starts.length, 1);
});

test("H1: an unexpected outcome-processing exception cannot orphan an admission in the live instance", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const core = new UpstreamCoordinatorCore({ storage, log: () => {}, limits: { upstreamMinSpacingMs: 0 }, fetchImpl: async () => {
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
  const core = new UpstreamCoordinatorCore({ storage, log: () => {}, limits: { upstreamTimeoutMs: 5, upstreamMinSpacingMs: 0 }, fetchImpl: () => {
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
  const build = () => new UpstreamCoordinatorCore({ storage, now: () => t, log: () => {}, fetchImpl: async () => {
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
  const core = new UpstreamCoordinatorCore({ storage, now: () => NOW, log: () => {}, limits: { upstreamTimeoutMs: 5 }, fetchImpl: async (_url, init) => {
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

/* ---------------- 5. UPSTREAM_REACTIVATION_ID ---------------- */
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

test("reactivation: only an identifier this coordinator has never seen ends a halt, and only once", async () => {
  const env = {};
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  await halt(w, "AAPL");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000); // past the ordinary minimum

  for (const bad of ["", "   ", "has space", "../etc", "x".repeat(41)]) {
    env.UPSTREAM_REACTIVATION_ID = bad;
    await blockedStill(w, "MSFT", `a malformed id does nothing: ${JSON.stringify(bad)}`);
  }
  delete env.UPSTREAM_REACTIVATION_ID;
  await blockedStill(w, "MSFT", "no id does nothing");

  env.UPSTREAM_REACTIVATION_ID = "2026-11-05";
  await reachable(w, "MSFT");
  assert.equal((await w.isolate().health()).upstream.state, "ok");

  // The same value left in place cannot authorize a later halt.
  await halt(w, "SPY");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  await blockedStill(w, "VST", "a used id does nothing");

  env.UPSTREAM_REACTIVATION_ID = "2026-11-06";
  await reachable(w, "VST");

  // A rollback that restores an older value cannot end a halt either, even after a restart.
  await halt(w, "SAP.DE");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  env.UPSTREAM_REACTIVATION_ID = "2026-11-05";
  w.coordinator.restart();
  await blockedStill(w, "VOD.L", "an older id does nothing after a rollback");
  env.UPSTREAM_REACTIVATION_ID = "2026-11-06";
  w.coordinator.restart();
  await blockedStill(w, "VOD.L", "the latest used id does nothing after a restart");

  env.UPSTREAM_REACTIVATION_ID = "2026-11-07";
  w.coordinator.restart();
  await reachable(w, "VOD.L");
});

test("reactivation: an identifier set before a halt does not authorize it in advance", async () => {
  const env = { UPSTREAM_REACTIVATION_ID: "set-early" };
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  assert.equal((await w.isolate().health()).upstream.state, "ok"); // the coordinator has seen it
  await halt(w, "AAPL");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  await blockedStill(w, "MSFT", "the id was already used up when the halt began");
});

test("reactivation: the identifier is read by the coordinator alone; a value in a Worker's settings does nothing", async () => {
  const w = world({ limits: { upstreamMinSpacingMs: 0 } });
  await halt(w, "AAPL");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  const before = w.starts.length;
  await refused(await w.isolate({ env: { UPSTREAM_REACTIVATION_ID: "from-the-worker" } }).ask("MSFT"), "upstream_rate_limited");
  assert.equal(w.starts.length, before);
});

test("reactivation ends only a halt: an ordinary cooldown still runs to its deadline", async () => {
  const env = {};
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  const answers = [...await w.enter(w.isolate(), ["AAPL"]), ...await w.enter(w.isolate(), ["MSFT"])];
  await until(() => w.starts.length === 2, "both");
  w.held[0].status(429, { "Retry-After": "172800" }); // a halt
  await answers[0];
  w.held[1].status(429, { "Retry-After": "3600" }); // an ordinary cooldown under it
  await answers[1];
  await w.clock.advance(1000000);
  env.UPSTREAM_REACTIVATION_ID = "2026-11-05";
  await refused(await w.isolate().ask("SPY"), "upstream_rate_limited", 2600);
  assert.equal(w.starts.length, 2);
  await w.clock.advance(2600000);
  await reachable(w, "SPY");

  // An ordinary cooldown alone: a new id does not shorten it.
  const plain = {};
  const p = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: plain });
  const refusedOnce = p.isolate().ask("AAPL");
  await until(() => p.starts.length === 1, "start");
  p.held.shift().status(429, { "Retry-After": "3600" });
  await refusedOnce;
  plain.UPSTREAM_REACTIVATION_ID = "not-for-cooldowns";
  await refused(await p.isolate().ask("MSFT"), "upstream_rate_limited", 3600);
  assert.equal(p.starts.length, 1);
});

test("reactivation that cannot be written leaves the halt in force", async () => {
  const env = {};
  const w = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: env });
  await halt(w, "AAPL");
  await w.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  w.storage.failWrites = true;
  env.UPSTREAM_REACTIVATION_ID = "2026-11-05";
  const answer = await w.isolate().ask("MSFT");
  assert.equal(answer.status, 503);
  await refused(answer, "busy");
  assert.equal(w.starts.length, 1);
  assert.equal(w.storage.peek().haltCode, "upstream_rate_limited");
  w.storage.failWrites = false;
  await reachable(w, "MSFT");

  // Only the transaction fails, while ordinary writes work: the halt must not be ended in memory
  // and then written out by the next admission, with the identifier never recorded as used.
  const only = {};
  const v = world({ limits: { upstreamMinSpacingMs: 0 }, coordinatorEnv: only });
  await halt(v, "AAPL");
  await v.clock.jump(COOLDOWN_SECONDS.upstream_rate_limited * 1000);
  v.storage.failReactivation = true;
  only.UPSTREAM_REACTIVATION_ID = "2026-11-05";
  const refused1 = await v.isolate().ask("MSFT");
  assert.equal(refused1.status, 503);
  await refused(refused1, "busy", 60);
  assert.equal(v.starts.length, 1, "nothing is sent on a reactivation that was not recorded");
  assert.equal(v.storage.peek().haltCode, "upstream_rate_limited");
  assert.equal((await v.isolate().health()).upstream.state, "unverified");
  v.storage.failReactivation = false;
  await reachable(v, "MSFT"); // not used up by the failed attempt
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
  const core = new UpstreamCoordinatorCore({ storage: memoryStorage(), fetchImpl: () => { throw new Error("must not be called"); }, log: () => {} });
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
  assert.doesNotMatch(toml, /UPSTREAM_REACTIVATION_ID/, "a value kept in the configuration would be used up by the first deployment");

  const worker = await read("src/worker.js");
  assert.match(worker, /export class UpstreamCoordinator extends DurableObject/);
  assert.equal((worker.match(/^export (?!default)/gm) || []).length, 1, "the only named export of the main module");

  const gateway = (await read("src/gateway.js")).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(gateway, /\bfetch\s*\(/, "the Worker never contacts the data source");
  assert.doesNotMatch(gateway, /chartUrl|query1\.finance/, "the Worker cannot even build the address");
  assert.doesNotMatch(gateway, /UPSTREAM_REACTIVATION_ID/, "reactivation is read by the coordinator alone");
  assert.doesNotMatch(gateway, /state\/cooldown/, "no stop in the Cache API");
});

test("the error contract is unchanged: no code a client does not know", async () => {
  const source = await readFile(new URL("../../../_services/market-data-gateway/src/gateway.js", import.meta.url), "utf8");
  const statuses = source.slice(source.indexOf("const STATUS = {"), source.indexOf("const RETRY_AFTER"));
  assert.doesNotMatch(statuses, /coordinator/, "a coordinator failure reaches clients as `busy`");
  const client = await readFile(new URL("../../../assets/js/market-data/keyless.js", import.meta.url), "utf8");
  assert.match(client, /\bbusy\b/);
});
