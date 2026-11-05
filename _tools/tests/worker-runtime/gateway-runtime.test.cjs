// The market-data gateway in the real Workers runtime: workerd, real SQLite-backed Durable
// Object storage, real RPC, real restarts from disk, and separate Worker isolates sharing one
// coordinator. Yahoo is synthetic (../fixtures/yahoo-chart.mjs): every outbound request of the
// Workers is answered here, so no provider, live gateway or Cloudflare account is contacted
// (Wrangler itself may look for a newer version of itself). The only thing changed from production
// is the coordinator's clock, which can be moved forward (test-entry.mjs); the tests of the
// unmodified entry point use real time.
//
//   NODE_PATH=<folder with wrangler installed>/node_modules node --expose-gc _tools/tests/worker-runtime/gateway-runtime.test.cjs
//
// Miniflare and workerd come with the pinned Wrangler (see .github/workflows/ci.yml), so these
// are the same runtime and bundler the deployment uses. They are test tools only.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { Miniflare, Log, LogLevel } = require("miniflare");

const ROOT = path.resolve(__dirname, "../../..");
const SERVICE = path.join(ROOT, "_services/market-data-gateway");
const SRC = "_services/market-data-gateway/src";
const SOURCE_MODULES = ["worker.js", "gateway.js", "coordinator.js", "venues.js", "yahoo-chart.js"].map(f => `${SRC}/${f}`);
const TEST_ENTRY = "_tools/tests/worker-runtime/test-entry.mjs";
const CLIENT = "_tools/tests/worker-runtime/client-worker.mjs";
const ORIGIN = "https://elmatthe.github.io";
const COMPATIBILITY = (() => {
  const toml = fs.readFileSync(path.join(SERVICE, "wrangler.toml"), "utf8");
  return { date: toml.match(/^compatibility_date = "([^"]+)"/m)[1], flags: JSON.parse(toml.match(/^compatibility_flags = (\[.*\])/m)[1]) };
})();
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: ORIGIN };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DAY_MS = 86400000;

// In the system's temporary folder, not in this checkout: on Windows, workerd cannot open a
// SQLite file whose full path passes 260 characters, and a deep checkout path gets there (an
// "internal error" from the runtime, with no other symptom).
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "mdgw-"));
test.after(() => {
  // Windows may hold workerd's files for a moment; what is left is in the temporary folder.
  try { fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* best effort */ }
});

const manifest = (mainModule, names) => ({
  mainModule,
  modulesRoot: ROOT,
  modules: Object.fromEntries(names.map(name => [name, { type: "esm", contents: fs.readFileSync(path.join(ROOT, name), "utf8") }])),
});
const vars = values => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { type: "text", value }]));

let yahooFixture = null;
const loadYahoo = async () => (yahooFixture ||= await import(pathToFileURL(path.join(ROOT, "_tools/tests/fixtures/yahoo-chart.mjs")).href));

// The synthetic data source. `hold` keeps requests until the test answers each one.
function syntheticYahoo() {
  const yahoo = {
    calls: [],
    held: [],
    hold: false,
    answer: null, // (symbol) => Response, instead of the normal synthetic data
    strays: [], // anything a Worker isolate tried to send by itself
    async handle(request) {
      const symbol = decodeURIComponent(new URL(request.url).pathname.split("/").pop());
      yahoo.calls.push({ symbol, at: Date.now(), url: request.url });
      if (yahoo.hold) {
        const override = await new Promise(resolve => yahoo.held.push({ symbol, resolve }));
        if (override) return override;
      }
      if (yahoo.answer) {
        const response = yahoo.answer(symbol);
        if (response) return response;
      }
      const { yahooFetch } = await loadYahoo();
      return yahooFetch({})(request.url);
    },
  };
  return yahoo;
}
const refusal = (seconds, status = 429) => new Response("x", { status, headers: seconds === null ? {} : { "Retry-After": String(seconds) } });

// A response from Miniflare must be read as soon as it arrives: once its inner object is garbage
// collected, its unread body is cancelled and reading it fails with "Body has already been
// consumed". So every answer is read here. With --expose-gc, as in CI, collection is frequent, so
// a test that holds an unread response fails every time instead of now and then.
if (typeof global.gc === "function") setInterval(global.gc, 100).unref();
const readNow = async response => new Response(await response.text(), { status: response.status, headers: response.headers });

// One coordinator and several isolates. `isolate-a` hosts the Durable Object, as in production
// every isolate of the one Worker addresses it. `real` runs the unmodified src/worker.js.
async function startWorld({ real = false, env = {}, coordinatorEnv = {}, persist = null, yahoo = syntheticYahoo(), storage = "sqlite", extra = [] } = {}) {
  const hostWorker = {
    config: {
      name: "isolate-a",
      compatibilityDate: COMPATIBILITY.date,
      compatibilityFlags: COMPATIBILITY.flags,
      manifest: real ? manifest(`${SRC}/worker.js`, SOURCE_MODULES) : manifest(TEST_ENTRY, [TEST_ENTRY, ...SOURCE_MODULES]),
      env: { UPSTREAM_COORDINATOR: { type: "durable-object", worker: "isolate-a", exportName: "UpstreamCoordinator" }, ...vars({ ...ON, ...env, ...coordinatorEnv }) },
      exports: { UpstreamCoordinator: { type: "durable-object", storage } },
    },
    dev: { outboundService: { type: "fetcher", handler: request => yahoo.handle(request) } },
  };
  const isolate = name => ({
    config: {
      name,
      compatibilityDate: COMPATIBILITY.date,
      compatibilityFlags: COMPATIBILITY.flags,
      manifest: manifest(`${SRC}/worker.js`, SOURCE_MODULES),
      env: { UPSTREAM_COORDINATOR: { type: "durable-object", worker: "isolate-a", exportName: "UpstreamCoordinator" }, ...vars({ ...ON, ...env }) },
    },
    dev: { outboundService: { type: "fetcher", handler: request => { yahoo.strays.push(request.url); return new Response("no", { status: 599 }); } } },
  });
  const isolateNames = ["isolate-a", "isolate-b", "isolate-c", ...extra.map(w => w.config.name)];
  const bindingName = name => name.replace(/-/g, "_").toUpperCase();
  const client = {
    config: {
      name: "client",
      compatibilityDate: COMPATIBILITY.date,
      manifest: manifest(CLIENT, [CLIENT]),
      env: Object.fromEntries(isolateNames.map(name => [bindingName(name), { type: "worker", worker: name }])),
    },
  };
  const options = {
    log: new Log(LogLevel.NONE),
    cf: false, // otherwise Miniflare downloads Cloudflare's request metadata and caches it here
    ...(persist ? { resourcePersistencePath: persist } : {}),
    workers: [hostWorker, isolate("isolate-b"), isolate("isolate-c"), client, ...extra],
  };
  const mf = new Miniflare(options);
  await mf.ready;
  const callers = await mf.getWorker("client");
  const host = await mf.getWorker("isolate-a");
  let clientNumber = 0;
  // Each caller has its own address, so the per-client limits stay out of the way.
  const callerUrl = (route, name, target, extraQuery = "") => {
    clientNumber += 1;
    const query = new URLSearchParams({ isolate: bindingName(name), path: target, ip: `203.0.113.${clientNumber % 250}` });
    return `https://client.test/${route}?${query}${extraQuery}`;
  };
  const world = {
    mf,
    yahoo,
    ask: (name, symbol) => callers.fetch(callerUrl("ask", name, `/v1/quote?symbol=${encodeURIComponent(symbol)}`)).then(readNow),
    askPath: (name, target) => callers.fetch(callerUrl("ask", name, target)).then(readNow),
    async health(name = "isolate-b") {
      return (await callers.fetch(callerUrl("ask", name, "/v1/health"))).json();
    },
    async test(pathAndQuery) {
      const response = await host.fetch(`https://gateway.test/__test/${pathAndQuery}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    advance: ms => world.test(`advance?ms=${ms}`),
    async row() {
      const [row] = await world.test(`sql?q=${encodeURIComponent("SELECT cooldown_until, cooldown_code, halt_code, failures, starts FROM coordinator_state WHERE id = 1")}`);
      return row ? { ...row, starts: JSON.parse(row.starts) } : null;
    },
    leave: (symbol, after) => callers.fetch(callerUrl("leave", "isolate-b", `/v1/quote?symbol=${encodeURIComponent(symbol)}`, `&after=${after}`)).then(r => r.text()),
    stop: () => mf.dispose(),
  };
  return world;
}
const withWorld = async (options, body) => {
  const world = await startWorld(options);
  try {
    await body(world);
    assert.deepEqual(world.yahoo.strays, [], "a Worker isolate must never contact the data source by itself");
  } finally {
    await world.stop();
  }
};
const held = async (yahoo, count) => {
  const giveUp = Date.now() + 8000;
  while (yahoo.held.length < count && Date.now() < giveUp) await sleep(5);
  assert.equal(yahoo.held.length, count, `expected ${count} upstream requests in flight`);
};
const expectError = async (response, code, status) => {
  const body = await response.clone().json();
  assert.equal(body.error?.code, code, JSON.stringify(body));
  if (status) assert.equal(response.status, status);
  return body.error;
};
const persistDir = name => {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* ---------------- the unmodified entry point ---------------- */
test("the unmodified Worker: answers come from synthetic Yahoo through the coordinator, in real SQLite", { timeout: 60000 }, () => withWorld({ real: true }, async world => {
  const h = await world.health();
  assert.equal(h.status, "ok");
  assert.equal(h.version, "1.3.0");
  assert.equal(h.keyless.enabled, true);
  assert.deepEqual(h.upstream, { state: "ok", code: null, retryAfterSeconds: 0 });

  const quote = await world.ask("isolate-b", "VEQT.TO");
  assert.equal(quote.status, 200);
  const body = await quote.json();
  assert.equal(body.schema, "md-gateway.quote.v1");
  assert.equal(body.currency, "CAD");
  assert.equal(body.cache.status, "miss");
  assert.ok(Number.isFinite(Date.parse(body.retrievedAt)));

  const history = await world.askPath("isolate-c", "/v1/history?symbol=SAP.DE&range=1y&interval=1d");
  assert.equal(history.status, 200);
  assert.ok((await history.json()).observations.length > 100);
  assert.equal(world.yahoo.calls.length, 2);
  assert.match(world.yahoo.calls[0].url, /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/VEQT\.TO\?/);
  // Real time: the second start waited for the first, across isolates.
  assert.ok(world.yahoo.calls[1].at - world.yahoo.calls[0].at >= 900, `gap ${world.yahoo.calls[1].at - world.yahoo.calls[0].at} ms`);
}));

/* ---------------- 1. overdue admission ---------------- */
test("1. a queue ticket that wakes at 20 s, after its 15 s deadline, is refused and never sent, and uses no budget", { timeout: 60000 }, () => withWorld({}, async world => {
  world.yahoo.hold = true;
  const first = world.ask("isolate-b", "AAPL");
  await held(world.yahoo, 1);
  const late = world.ask("isolate-c", "MSFT"); // waits for its 1 s spacing
  await sleep(150);
  await world.advance(20000); // its real timer now resumes 20 s after it arrived
  const answer = await late;
  await expectError(answer, "throttled", 429);
  assert.deepEqual(world.yahoo.calls.map(c => c.symbol), ["AAPL"]);
  assert.equal((await world.row()).starts.length, 1, "no budget used for the refused ticket");
  world.yahoo.held.splice(0).forEach(h => h.resolve());
  assert.equal((await first).status, 200);
}));

/* ---------------- 2, 3, 4. deadlines recorded in either order, by different isolates ---------------- */
for (const [order, firstWait, secondWait] of [["3600 s recorded first", 3600, null], ["900 s recorded first", null, 3600]]) {
  test(`2 and 4. two isolates record 3600 s and 900 s (${order}); a new isolate stays away at 901 s`, { timeout: 60000 }, () => withWorld({}, async world => {
    world.yahoo.hold = true;
    const answers = [world.ask("isolate-a", "AAPL"), world.ask("isolate-b", "MSFT")];
    await held(world.yahoo, 2);
    const taken = world.yahoo.held.splice(0);
    taken.find(h => h.symbol === "AAPL").resolve(refusal(firstWait));
    await answers[0];
    taken.find(h => h.symbol === "MSFT").resolve(refusal(secondWait));
    await answers[1];

    await world.advance(901000);
    const before = world.yahoo.calls.length;
    const fresh = await world.ask("isolate-c", "SPY"); // has served nothing before this
    const error = await expectError(fresh, "upstream_rate_limited", 429);
    assert.ok(error.retryAfterSeconds > 2600 && error.retryAfterSeconds <= 2699, `retry after ${error.retryAfterSeconds}`);
    assert.equal(world.yahoo.calls.length, before, "no upstream request at 901 s");
    assert.equal((await world.health("isolate-c")).upstream.state, "cooling_down");

    world.yahoo.hold = false;
    await world.advance(2699000);
    assert.equal((await world.ask("isolate-c", "SPY")).status, 200, "resumes after the longer deadline");
  }));
}

for (const [order, firstWait, secondWait] of [["halt recorded first", 172800, null], ["ordinary cooldown recorded first", null, 172800]]) {
  test(`3. an ordinary cooldown never overwrites a manual-reactivation halt (${order})`, { timeout: 60000 }, () => withWorld({}, async world => {
    world.yahoo.hold = true;
    const answers = [world.ask("isolate-a", "AAPL"), world.ask("isolate-b", "MSFT")];
    await held(world.yahoo, 2);
    const taken = world.yahoo.held.splice(0);
    taken.find(h => h.symbol === "AAPL").resolve(refusal(firstWait));
    await answers[0];
    taken.find(h => h.symbol === "MSFT").resolve(refusal(secondWait));
    await answers[1];
    assert.equal((await world.row()).halt_code, "upstream_rate_limited");

    for (const after of [901000, 30 * DAY_MS]) {
      await world.advance(after);
      const error = await expectError(await world.ask("isolate-c", "SPY"), "upstream_rate_limited", 429);
      assert.equal(error.retryAfterSeconds, 86400);
      assert.equal(error.manualReactivationRequired, true);
    }
    assert.equal(world.yahoo.calls.length, 2);
    const h = await world.health("isolate-c");
    assert.deepEqual(h.upstream, { state: "halted", code: "upstream_rate_limited", retryAfterSeconds: 86400, manualReactivationRequired: true });
  }));
}

/* ---------------- 5, 6. restart from disk, reactivation ---------------- */
test("5. the unmodified Worker recovers a deadline from disk after a restart of the runtime", { timeout: 90000 }, async () => {
  const persist = persistDir("deadline");
  const yahoo = syntheticYahoo();
  yahoo.answer = () => refusal(3600);
  const first = await startWorld({ real: true, persist, yahoo });
  try {
    await expectError(await first.ask("isolate-b", "AAPL"), "upstream_rate_limited", 429);
  } finally {
    await first.stop();
  }

  yahoo.answer = null;
  const second = await startWorld({ real: true, persist, yahoo });
  try {
    const h = await second.health("isolate-c");
    assert.equal(h.upstream.state, "cooling_down");
    assert.ok(h.upstream.retryAfterSeconds > 3500 && h.upstream.retryAfterSeconds <= 3600, `retry after ${h.upstream.retryAfterSeconds}`);
    await expectError(await second.ask("isolate-c", "MSFT"), "upstream_rate_limited", 429);
    assert.equal(yahoo.calls.length, 1, "nothing sent after the restart");
    assert.deepEqual(yahoo.strays, []);
  } finally {
    await second.stop();
  }
});

test("5. spacing and budget survive the object being reset; a reset request is reported and not repeated", { timeout: 60000 }, () => withWorld({}, async world => {
  const answer = await world.ask("isolate-b", "AAPL");
  assert.equal(answer.status, 200);
  await world.test("reset");
  await world.ask("isolate-c", "MSFT"); // must wait out the second that started before the reset
  const row = await world.row();
  assert.equal(row.starts.length, 2, "the first start survived the reset");
  assert.ok(row.starts[1] - row.starts[0] >= 1000, `gap ${row.starts[1] - row.starts[0]} ms, from the persisted record`);

  // A reset while a request is in flight: its clients get an answer, and it is not repeated.
  world.yahoo.hold = true;
  await sleep(1000);
  const interrupted = world.ask("isolate-c", "SPY");
  await held(world.yahoo, 1);
  await world.test("reset");
  const refused = await interrupted;
  await expectError(refused, "busy", 503);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.equal(world.yahoo.calls.filter(c => c.symbol === "SPY").length, 1, "not repeated");
  world.yahoo.held.splice(0).forEach(h => h.resolve());
}));

test("6. reactivation in the real runtime: a new identifier ends a halt once; a used or restored one does not", { timeout: 120000 }, async () => {
  const persist = persistDir("reactivation");
  const yahoo = syntheticYahoo();
  const session = async (id, body) => {
    const world = await startWorld({ persist, yahoo, coordinatorEnv: id ? { UPSTREAM_REACTIVATION_ID: id } : {} });
    try { await body(world); } finally { await world.stop(); }
  };
  const haltNow = async (world, symbol) => {
    yahoo.answer = () => refusal(172800);
    await expectError(await world.ask("isolate-b", symbol), "upstream_rate_limited", 429);
    yahoo.answer = null;
    assert.equal((await world.health()).upstream.state, "halted");
    await world.advance(901000); // past the ordinary minimum, so only the halt is left
  };
  const stillHalted = async (world, symbol) => {
    const before = yahoo.calls.length;
    const error = await expectError(await world.ask("isolate-c", symbol), "upstream_rate_limited", 429);
    assert.equal(error.manualReactivationRequired, true);
    assert.equal(yahoo.calls.length, before);
  };

  await session(null, async world => { await haltNow(world, "AAPL"); });
  await session(null, async world => { await stillHalted(world, "MSFT"); }); // a restart alone changes nothing
  await session("2026-11-05", async world => {
    assert.equal((await world.health()).upstream.state, "ok");
    assert.equal((await world.ask("isolate-c", "MSFT")).status, 200);
    await sleep(1000);
    await haltNow(world, "SPY");
    await stillHalted(world, "VST"); // the same value, still in place, does nothing
  });
  await session("2026-11-05", async world => { await stillHalted(world, "VST"); }); // nor after a restart
  await session("2026-11-06", async world => {
    assert.equal((await world.ask("isolate-c", "VST")).status, 200);
    await sleep(1000);
    await haltNow(world, "SAP.DE");
  });
  await session("2026-11-05", async world => { await stillHalted(world, "VOD.L"); }); // a rollback restoring an old value
  await session("2026-11-07", async world => { assert.equal((await world.ask("isolate-c", "VOD.L")).status, 200); });
  assert.deepEqual(yahoo.strays, []);
});

/* ---------------- 7. storage that fails, for real ---------------- */
test("7. state that is not well formed in real SQLite: nothing is sent", { timeout: 60000 }, () => withWorld({}, async world => {
  assert.equal((await world.ask("isolate-b", "AAPL")).status, 200);
  const sent = world.yahoo.calls.length;
  for (const corruption of ["UPDATE coordinator_state SET starts = 'not json'", "UPDATE coordinator_state SET starts = '[]', cooldown_until = 'soon', cooldown_code = 'upstream_rate_limited'", "UPDATE coordinator_state SET cooldown_until = 0, cooldown_code = NULL, halt_code = 'made_up'"]) {
    await world.test(`sql?q=${encodeURIComponent(corruption)}`);
    await world.test("reset"); // the next instance reads it from disk
    const answer = await world.ask("isolate-c", "MSFT");
    await expectError(answer, "busy", 503);
    assert.equal(answer.headers.get("retry-after"), "60");
    const h = await world.health("isolate-c");
    assert.equal(h.upstream.state, "unverified");
    assert.equal(h.status, "degraded");
  }
  assert.equal(world.yahoo.calls.length, sent, "nothing was sent on state that could not be verified");
}));

test("7. a write that really fails: the admission is refused and nothing is sent", { timeout: 60000 }, () => withWorld({}, async world => {
  assert.equal((await world.ask("isolate-b", "AAPL")).status, 200);
  await world.test(`sql?q=${encodeURIComponent("DROP TABLE coordinator_state")}`); // a real SQLite error on the next write
  await sleep(1000);
  const sent = world.yahoo.calls.length;
  const answer = await world.ask("isolate-c", "MSFT");
  await expectError(answer, "busy", 503);
  assert.equal(world.yahoo.calls.length, sent);
  const h = await world.health("isolate-c");
  assert.equal(h.status, "degraded", "health says so while writes fail");
  assert.equal(h.upstream.state, "unverified");
}));

test("7. a stop is recorded on any refusal that names a wait, over a real fetch: a 302 with Retry-After", { timeout: 60000 }, () => withWorld({}, async world => {
  world.yahoo.answer = () => refusal(3600, 302);
  await expectError(await world.ask("isolate-b", "AAPL"), "upstream_invalid", 502);
  world.yahoo.answer = null;
  await sleep(1100);
  const error = await expectError(await world.ask("isolate-c", "MSFT"), "upstream_unavailable", 502);
  assert.ok(error.retryAfterSeconds > 3500 && error.retryAfterSeconds <= 3600, `retry after ${error.retryAfterSeconds}`);
  assert.equal(world.yahoo.calls.length, 1, "nothing more is sent");
}));

/* ---------------- 8. concurrency ---------------- */
test("8. concurrent requests from three isolates while a stop is recorded: one reaches the source, the rest are refused", { timeout: 60000 }, () => withWorld({}, async world => {
  world.yahoo.hold = true;
  const symbols = ["AAPL", "MSFT", "SPY", "VST", "SAP.DE", "VOD.L"];
  const answers = symbols.map((symbol, i) => world.ask(["isolate-a", "isolate-b", "isolate-c"][i % 3], symbol));
  await held(world.yahoo, 1);
  await sleep(100); // all of them are queued in the coordinator by now
  world.yahoo.held.shift().resolve(refusal(3600));
  const all = await Promise.all(answers);
  await sleep(1500); // past the moment any of them could have started
  assert.equal(world.yahoo.calls.length, 1, `nothing else was sent: ${JSON.stringify(world.yahoo.calls.map(c => c.symbol))}`);
  for (const answer of all) {
    assert.equal(answer.status, 429);
    const error = await expectError(answer, "upstream_rate_limited");
    assert.ok(error.retryAfterSeconds > 3500, `retry after ${error.retryAfterSeconds}`);
  }
  assert.equal((await world.row()).starts.length, 1, "only the real start was counted");
}));

test("8. one second between actual starts and one request for identical requests, across isolates", { timeout: 60000 }, () => withWorld({}, async world => {
  const answers = await Promise.all([world.ask("isolate-a", "AAPL"), world.ask("isolate-b", "MSFT"), world.ask("isolate-c", "SPY")]);
  assert.ok(answers.every(a => a.status === 200));
  const { starts } = await world.row();
  assert.equal(starts.length, 3);
  assert.ok(starts.slice(1).every((s, i) => s - starts[i] >= 1000), `starts ${starts}`);

  world.yahoo.hold = true;
  await sleep(1000);
  const shared = [world.ask("isolate-a", "VOD.L"), world.ask("isolate-b", "VOD.L"), world.ask("isolate-c", "VOD.L")];
  await held(world.yahoo, 1);
  await sleep(100);
  world.yahoo.held.splice(0).forEach(h => h.resolve());
  const bodies = await Promise.all((await Promise.all(shared)).map(r => r.json()));
  assert.equal(world.yahoo.calls.filter(c => c.symbol === "VOD.L").length, 1);
  assert.ok(bodies.every(b => b.retrievedAt === bodies[0].retrievedAt));
}));

/* ---------------- 9. a caller that goes away ---------------- */
test("9. a caller that goes away while queued: the coordinator drops it, it never starts, and no budget is used", { timeout: 60000 }, () => withWorld({}, async world => {
  world.yahoo.hold = true;
  const first = world.ask("isolate-c", "AAPL");
  await held(world.yahoo, 1);
  // Would start 1 s after AAPL if it stayed; its caller leaves first.
  assert.match(await world.leave("MSFT", 200), /rejected AbortError|status 499/);
  await sleep(1500);
  assert.deepEqual(world.yahoo.calls.map(c => c.symbol), ["AAPL"], "the cancelled request reached no one");
  assert.equal((await world.row()).starts.length, 1);
  world.yahoo.held.splice(0).forEach(h => h.resolve());
  assert.equal((await first).status, 200);
  world.yahoo.hold = false;
  assert.equal((await world.ask("isolate-c", "SPY")).status, 200, "the queue goes on");
}));

test("9. a caller that goes away while its request is in flight: it is not counted against the source", { timeout: 60000 }, () => withWorld({}, async world => {
  world.yahoo.hold = true;
  assert.match(await Promise.race([world.leave("MSFT", 400), sleep(5000).then(() => "the caller was never released")]), /rejected AbortError|status 499/);
  assert.equal(world.yahoo.calls.length, 1);
  await sleep(100);
  const row = await world.row();
  assert.equal(row.failures, 0);
  assert.equal(row.cooldown_until, 0);
  assert.equal((await world.health()).upstream.state, "ok");
  world.yahoo.held.splice(0).forEach(h => h.resolve());
}));

/* ---------------- 10. configuration and platform failures ---------------- */
test("10. a Worker without the binding, or with the wrong one, sends nothing and says so", { timeout: 60000 }, async () => {
  const yahoo = syntheticYahoo();
  const worker = (name, binding) => ({
    config: { name, compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags, manifest: manifest(`${SRC}/worker.js`, SOURCE_MODULES), env: { ...binding, ...vars(ON) } },
    dev: { outboundService: { type: "fetcher", handler: request => { yahoo.strays.push(request.url); return new Response("no", { status: 599 }); } } },
  });
  const world = await startWorld({ real: true, yahoo, extra: [worker("no-binding", {}), worker("plain-variable", vars({ UPSTREAM_COORDINATOR: "UpstreamCoordinator" }))] });
  try {
    for (const name of ["no-binding", "plain-variable"]) {
      const answer = await world.ask(name, "AAPL");
      await expectError(answer, "busy", 503);
      assert.equal(answer.headers.get("retry-after"), "60");
      const h = await world.health(name);
      assert.equal(h.upstream.state, "unverified", name);
      assert.equal(h.upstream.reason, "coordinator_binding_missing", name);
    }
    assert.equal(yahoo.calls.length, 0);
    assert.deepEqual(yahoo.strays, []);
  } finally {
    await world.stop();
  }
});

test("10. a class without SQLite storage (not available on Workers Free) fails closed", { timeout: 60000 }, () => withWorld({ real: true, storage: "legacy-kv" }, async world => {
  const answer = await world.ask("isolate-b", "AAPL");
  await expectError(answer, "busy", 503);
  assert.equal(world.yahoo.calls.length, 0);
  assert.equal((await world.health()).upstream.state, "unverified");
}));

test("10. a source that is switched off contacts nothing and does not need the coordinator", { timeout: 60000 }, () => withWorld({ real: true, env: { KEYLESS_SOURCE: "", OWNER_ATTESTATION: "" } }, async world => {
  await expectError(await world.ask("isolate-b", "AAPL"), "source_disabled", 503);
  const h = await world.health();
  assert.equal(h.keyless.enabled, false);
  assert.equal(world.yahoo.calls.length, 0);
}));

test("10. Workers Free: each admission writes one row, so the daily row allowance cannot be reached by the budget", { timeout: 60000 }, () => withWorld({}, async world => {
  assert.equal(await world.test("rows-written"), 1);
  // One write at admission and at most one for the outcome, at 20 starts a minute.
  assert.ok(20 * 60 * 24 * 2 < 100000);
}));

test("10. wrangler deploy --dry-run accepts both configurations and lists the coordinator", { timeout: 120000 }, () => {
  const wrangler = path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const run = env => {
    const outdir = path.join(TEMP, `dry-run-${env || "top"}`);
    const result = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", `--env=${env}`, `--outdir=${outdir}`], {
      cwd: SERVICE, encoding: "utf8", timeout: 100000, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    return output;
  };
  for (const env of ["", "production"]) {
    const output = run(env);
    assert.match(output, /env\.UPSTREAM_COORDINATOR \(UpstreamCoordinator\)\s+Durable Object/, output);
    assert.match(output, /env\.RATE_LIMITER/, output);
    assert.doesNotMatch(output, /UPSTREAM_LIMITER/, output);
    assert.match(output, /--dry-run: exiting now/, output);
  }
  assert.match(run("production"), /env\.KEYLESS_SOURCE \("yahoo-chart"\)/);
  assert.match(run(""), /env\.KEYLESS_SOURCE \(""\)/);
});
