// The counterexamples of the independent review of PR 46, as one script that runs against
// any checkout of the market-data gateway, so the failure on the original commit and the
// pass on the corrected one can be seen with one command each. Yahoo is synthetic.
//
//   git worktree add ../base de720dc2ce8bd8bdfa105d725fd928fcb3d86c85
//   node _tools/tests/r3_reproduction.mjs --src ../base/_services/market-data-gateway/src   (exit 1)
//   node _tools/tests/r3_reproduction.mjs                                                   (exit 0)
//
// Not a *.test.mjs file: on the original commit it is meant to fail. The regressions that
// CI runs are in unit/upstream-coordinator.test.mjs and worker-runtime/.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { yahooFetch } from "./fixtures/yahoo-chart.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf("--src");
const src = path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(here, "../../_services/market-data-gateway/src"));
const { createGateway } = await import(pathToFileURL(path.join(src, "gateway.js")).href);
const coordinated = existsSync(path.join(src, "coordinator.js"));
const local = coordinated ? await import("./fixtures/local-coordinator.mjs") : null;

const ORIGIN = "https://elmatthe.github.io";
const NOW = Date.parse("2026-11-03T15:00:00Z");
const ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission", ALLOWED_ORIGINS: ORIGIN };

// One "world": a clock, a synthetic Yahoo, what the isolates share, and any number of
// isolates. The original code shares state through the Cache API (last writer wins); the
// corrected code through the coordinator, which is also the only thing that reaches Yahoo.
function world({ wake = null } = {}) {
  const w = { t: NOW, calls: [], held: [], store: new Map() };
  w.now = () => w.t;
  w.sleep = wake ? async ms => { w.t = wake(w.t, ms); } : async ms => { w.t += ms; };
  const answer = yahooFetch({ now: w.now });
  w.fetchImpl = (url, init) => {
    w.calls.push({ at: w.t - NOW, symbol: decodeURIComponent(new URL(String(url)).pathname.split("/").pop()) });
    return new Promise(resolve => w.held.push({ ok: () => resolve(answer(url, init)), refuse: headers => resolve(new Response("x", { status: 429, headers })) }));
  };
  const cache = { match: async k => (w.store.has(k) ? new Response(w.store.get(k)) : undefined), put: async (k, r) => { w.store.set(k, await r.text()); }, delete: async k => w.store.delete(k) };
  const coordinator = local?.localCoordinator({ fetchImpl: w.fetchImpl, now: w.now, sleep: w.sleep, log: () => {} });
  w.isolate = () => {
    const gw = coordinated
      ? createGateway({ now: w.now, log: () => {}, cache })
      : createGateway({ fetchImpl: w.fetchImpl, now: w.now, sleep: w.sleep, log: () => {}, cache });
    let client = 0;
    return symbol => {
      client += 1;
      return gw.handle(new Request(`https://gateway.test/v1/quote?symbol=${symbol}`, { headers: { Origin: ORIGIN, "CF-Connecting-IP": `10.9.${client}.1` } }), coordinated ? { ...ON, UPSTREAM_COORDINATOR: coordinator } : ON);
    };
  };
  return w;
}
const settle = async (w, count) => {
  const giveUp = Date.now() + 2000;
  while (w.calls.length < count && Date.now() < giveUp) await new Promise(r => setTimeout(r, 1));
  if (w.calls.length < count) throw new Error(`expected ${count} upstream requests, saw ${w.calls.length}`);
};

const scenarios = {
  // B2: the only other request is in flight; the waiter's 1 s timer resumes 20 s late.
  async "B2 a queue ticket that wakes at 20 s, after its 15 s deadline, is refused and never sent"() {
    const w = world({ wake: t => t + 20000 });
    const ask = w.isolate();
    const first = ask("AAPL");
    await settle(w, 1);
    const late = await Promise.race([ask("MSFT"), new Promise(r => setTimeout(() => r(null), 200))]);
    const sentLate = w.calls.find(c => c.symbol === "MSFT");
    w.held.forEach(h => h.ok());
    await first;
    if (sentLate) return `upstream request started at ${sentLate.at} ms, after the 15000 ms deadline`;
    if (!late || late.status !== 429) return `expected a refusal, got ${late?.status ?? "no answer"}`;
    return null;
  },
  // B3: the long wait is recorded first and the short one last, by another isolate.
  async "B3 a 900 s refusal recorded after a 3600 s refusal does not shorten it"() {
    return raceShortAfterLong({ "Retry-After": "3600" }, "a one-hour wait");
  },
  async "B3 an ordinary 900 s cooldown does not overwrite a stop that needs manual reactivation"() {
    return raceShortAfterLong({ "Retry-After": "172800" }, "a manual-reactivation stop");
  },
};
async function raceShortAfterLong(longHeaders, what) {
  const w = world();
  const [a, b] = [w.isolate(), w.isolate()];
  const answers = [a("AAPL"), b("MSFT")];
  await settle(w, 2);
  w.held[0].refuse(longHeaders);
  await answers[0];
  w.held[1].refuse({});
  await answers[1];
  await new Promise(r => setTimeout(r, 5)); // the isolates' writes to their shared state
  w.t += 901000;
  const before = w.calls.length;
  const fresh = await Promise.race([w.isolate()("SPY"), new Promise(r => setTimeout(() => r(null), 200))]);
  w.held.forEach(h => h.ok());
  if (w.calls.length !== before) return `a new isolate contacted Yahoo at 901 s despite ${what}`;
  if (fresh?.status !== 429) return `expected a refusal at 901 s, got ${fresh?.status ?? "no answer"}`;
  return null;
}

console.log(`gateway source: ${src}\n${coordinated ? "coordinated (Durable Object design)" : "original (per-isolate queue, Cache API cooldown)"}`);
let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  const problem = await run();
  if (problem) failed += 1;
  console.log(`${problem ? "FAIL" : "PASS"}  ${name}${problem ? `\n      ${problem}` : ""}`);
}
process.exit(failed ? 1 : 0);
