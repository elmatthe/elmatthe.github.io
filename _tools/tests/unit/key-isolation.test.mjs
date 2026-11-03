// API-key lifecycle: per-key cache isolation (R01) and key storage/redaction (R05).
// Everything is mocked; no request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { createMarketData, loadSettings, keyFingerprint } from "../../../assets/js/market-data/index.js";
import * as F from "./fixtures.mjs";

const NOW = Date.parse("2026-11-02T18:00:00Z");
const DAY = 86400000;
const KEY_A = "KEYAAAAA11111111";
const KEY_B = "KEYBBBBB22222222";
const noSleep = async () => {};
const d = s => new Date(`${s}T00:00:00Z`);
const YEAR = { start: d("2025-11-02"), end: d("2026-11-02") };

// Alpha Vantage stub that records which key every request used. `gate` (optional)
// holds responses until released; `limitFor` makes a key answer with the daily limit.
function server({ gate = null, limitFor = new Set(), honourAbort = false } = {}) {
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(String(raw));
    calls.push({ url, key: url.searchParams.get("apikey"), fn: url.searchParams.get("function") });
    if (gate) {
      await (honourAbort
        ? new Promise((resolve, reject) => { gate.then(resolve); init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })
        : gate);
    }
    if (url.hostname !== "www.alphavantage.co") return F.response(404, "{}");
    if (limitFor.has(url.searchParams.get("apikey"))) return F.response(200, F.AV_RATE_LIMIT);
    const fn = url.searchParams.get("function");
    const symbol = url.searchParams.get("symbol") || url.searchParams.get("keywords");
    if (fn === "SYMBOL_SEARCH") return F.response(200, symbol === "AAPL" ? F.avSearch([["AAPL", "United States", "USD", "Apple Inc"]]) : F.avSearch([]));
    if (fn === "GLOBAL_QUOTE") return F.response(200, F.avGlobalQuote(symbol, symbol === "AAPL" ? 230.5 : 10, "2026-10-30"));
    if (fn === "TIME_SERIES_WEEKLY_ADJUSTED") return F.response(200, F.avWeekly(symbol, [["2026-10-16", 100, 99], ["2026-10-23", 101, 100], ["2026-10-30", 103, 102]]));
    return F.response(400, "{}");
  };
  return { fetchImpl, calls };
}

const make = (opts = {}) => createMarketData({ local: F.memory(), session: F.memory(), now: () => NOW, sleep: noSleep, minSpacingMs: 0, ...opts });
const keysIn = store => Array.from({ length: store.length }, (_, i) => store.key(i));
const dataKeysFor = (store, key) => keysIn(store).filter(k => k.startsWith(`md.av.v2.${keyFingerprint(key)}.`) && !k.endsWith(".usage"));

test("key A -> key B: no cached data, listing or request count is reused across keys", async () => {
  const local = F.memory();
  const { fetchImpl, calls } = server();
  const md = make({ local, fetchImpl });
  md.setApiKey(KEY_A);
  const a = await md.quote("AAPL");
  await md.history("AAPL", YEAR);
  assert.equal(a.provenance.cached, false);
  assert.equal(md.usage().count, 3, "search + quote + weekly history");
  assert.ok(dataKeysFor(local, KEY_A).length >= 3);

  md.setApiKey(KEY_B);
  assert.equal(md.usage().count, 0, "key B starts with its own count");
  assert.equal(dataKeysFor(local, KEY_A).length, 0, "key A's saved responses are removed on change");
  const b = await md.quote("AAPL");
  assert.equal(b.provenance.cached, false, "not served from key A's cache");
  const h = await md.history("AAPL", YEAR);
  assert.equal(h.provenance.cached, false);
  assert.deepEqual(calls.slice(3).map(c => [c.key, c.fn]), [[KEY_B, "SYMBOL_SEARCH"], [KEY_B, "GLOBAL_QUOTE"], [KEY_B, "TIME_SERIES_WEEKLY_ADJUSTED"]],
    "the listing is looked up again with key B, not reused from key A");
  assert.equal(md.usage().count, 3);

  // Back to A the same day: A's own count is restored; its data was discarded.
  md.setApiKey(KEY_A);
  assert.equal(md.usage().count, 3);
  await md.quote("AAPL");
  assert.equal(calls.at(-1).key, KEY_A);
  assert.equal(md.usage().count, 5);
});

test("key A -> removed: nothing cached with A is served or labelled as live", async () => {
  const local = F.memory();
  const session = F.memory();
  const { fetchImpl, calls } = server();
  const md = make({ local, session, fetchImpl });
  md.setApiKey(KEY_A);
  await md.quote("AAPL");
  const sent = calls.length;
  const result = md.setApiKey("");
  assert.deepEqual(result, { persistence: "", saved: false });
  assert.equal(md.liveAvailable(), false);
  await assert.rejects(md.quote("AAPL"), e => e.kind === "not_configured");
  await assert.rejects(md.history("AAPL", YEAR), e => e.kind === "not_configured");
  assert.equal(calls.length, sent, "no request without a key");
  assert.equal(md.cacheSize(), 0);
  assert.equal(dataKeysFor(local, KEY_A).length, 0);
  assert.equal(local.getItem("md.settings.v1"), null);
  assert.equal(session.getItem("md.settings.v1"), null);
  // A fresh page load has no key either.
  assert.equal(make({ local, session, fetchImpl }).liveAvailable(), false);
});

test("key A -> same key A: caches, count and in-flight requests are kept", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const local = F.memory();
  const { fetchImpl, calls } = server();
  const md = make({ local, fetchImpl });
  md.setApiKey(KEY_A);
  await md.quote("AAPL");
  const sent = calls.length;
  md.setApiKey(` ${KEY_A} `);
  const again = await md.quote("AAPL");
  assert.equal(again.provenance.cached, true);
  assert.equal(calls.length, sent);
  assert.equal(md.usage().count, sent);
  // A request in flight survives re-saving the same key.
  const slow = server({ gate });
  const md2 = make({ fetchImpl: slow.fetchImpl });
  md2.setApiKey(KEY_A);
  const pending = md2.quote("AAPL");
  md2.setApiKey(KEY_A, { remember: false });
  release();
  assert.equal((await pending).quote.price, 230.5);
});

test("a key change during a request: no shared in-flight work, late answers are discarded, nothing is cached under either key", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const local = F.memory();
  const { fetchImpl, calls } = server({ gate });
  const md = make({ local, fetchImpl });
  md.setApiKey(KEY_A);
  const first = md.quote("AAPL");
  const firstHistory = md.history("AAPL", YEAR);
  await new Promise(r => setTimeout(r, 0));
  md.setApiKey(KEY_B);
  const second = md.quote("AAPL");
  await new Promise(r => setTimeout(r, 0));
  release();
  await assert.rejects(first, e => e.kind === "key_changed" && /key changed/.test(e.message));
  await assert.rejects(firstHistory, e => e.kind === "key_changed");
  const b = await second;
  assert.equal(b.quote.price, 230.5);
  assert.ok(calls.filter(c => c.key === KEY_B).length >= 2, "key B made its own requests instead of joining key A's");
  assert.equal(dataKeysFor(local, KEY_A).length, 0, "nothing from the retired key was written");
  assert.ok(dataKeysFor(local, KEY_B).length >= 2);

  // A fetch that honours abort is cancelled on the key change.
  let release2;
  const gate2 = new Promise(r => { release2 = r; });
  const aborting = server({ gate: gate2, honourAbort: true });
  const md2 = make({ fetchImpl: aborting.fetchImpl });
  md2.setApiKey(KEY_A);
  const pending = md2.quote("AAPL");
  await new Promise(r => setTimeout(r, 0));
  md2.setApiKey(KEY_B);
  await assert.rejects(pending, e => e.kind === "key_changed");
  release2();

  // A batch stops instead of mixing two keys' results.
  let release3;
  const gate3 = new Promise(r => { release3 = r; });
  const batchServer = server({ gate: gate3 });
  const md3 = make({ fetchImpl: batchServer.fetchImpl });
  md3.setApiKey(KEY_A);
  const batch = md3.quotes(["AAPL", "MSFT"]);
  await new Promise(r => setTimeout(r, 0));
  md3.setApiKey(KEY_B);
  release3();
  await assert.rejects(batch, e => e.kind === "key_changed");
  assert.ok(!batchServer.calls.some(c => c.key === KEY_B), "the batch did not continue with the new key");
});

test("a caller cancelling during a key change gets 'aborted', not another key's data", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { fetchImpl } = server({ gate });
  const md = make({ fetchImpl });
  md.setApiKey(KEY_A);
  const controller = new AbortController();
  const p = md.quote("AAPL", { signal: controller.signal });
  controller.abort();
  md.setApiKey(KEY_B);
  release();
  await assert.rejects(p, e => e.kind === "aborted");
});

test("daily quota accounting is per key and survives reloads", async () => {
  let t = NOW;
  const local = F.memory();
  const limited = new Set([KEY_A]);
  const { fetchImpl, calls } = server({ limitFor: limited });
  const md = make({ local, fetchImpl, now: () => t });
  md.setApiKey(KEY_A);
  await assert.rejects(md.quote("AAPL"), e => e.kind === "rate_limited" && e.definitive);
  const afterLimit = calls.length;
  // Reload: key A is still known to be exhausted today, so no request is spent.
  const reloaded = make({ local, fetchImpl, now: () => t });
  assert.equal(reloaded.usage().count, afterLimit);
  await assert.rejects(reloaded.quote("MSFT"), e => e.kind === "rate_limited");
  assert.equal(calls.length, afterLimit);
  // Key B is not limited by key A's exhaustion and has its own count.
  reloaded.setApiKey(KEY_B);
  assert.equal(reloaded.usage().count, 0);
  assert.equal((await reloaded.quote("AAPL")).quote.price, 230.5);
  assert.equal(reloaded.usage().count, 2);
  // Next UTC day: key A's count and exhaustion reset.
  t += DAY;
  limited.clear();
  const nextDay = make({ local, fetchImpl, now: () => t });
  nextDay.setApiKey(KEY_A);
  assert.equal(nextDay.usage().count, 0);
  assert.equal((await nextDay.quote("AAPL")).quote.price, 230.5);
});

test("unavailable storage: the key and caches live in memory for this page; nothing throws", async () => {
  const { fetchImpl, calls } = server();
  const md = createMarketData({ local: null, session: null, fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  assert.equal(md.liveAvailable(), false);
  assert.deepEqual(md.setApiKey(KEY_A), { persistence: "memory", saved: false });
  assert.deepEqual(md.settings, { hasKey: true, persistence: "memory" });
  await md.quote("AAPL");
  const sent = calls.length;
  assert.equal((await md.quote("AAPL")).provenance.cached, true, "in-memory cache works");
  assert.equal(calls.length, sent);
  assert.equal(md.usage().count, sent, "requests are still counted without storage");
});

test("storage that throws on every call, and corrupted entries, are tolerated", async () => {
  const broken = { get length() { throw new Error("SecurityError"); }, key() { throw new Error("SecurityError"); },
    getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); }, removeItem() { throw new Error("SecurityError"); } };
  const { fetchImpl } = server();
  const md = createMarketData({ local: broken, session: broken, fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  assert.equal(md.setApiKey(KEY_A).persistence, "memory");
  assert.equal((await md.quote("AAPL")).quote.price, 230.5);
  assert.equal(md.cacheSize(), 0);
  assert.doesNotThrow(() => md.clearCache());

  const local = F.memory();
  local.setItem("md.settings.v1", "{not json");
  local.setItem(`md.av.v2.${keyFingerprint(KEY_A)}.usage`, "garbage");
  assert.equal(loadSettings(local).alphaVantageKey, "");
  local.setItem("md.settings.v1", JSON.stringify({ alphaVantageKey: "bad key!" }));
  assert.equal(loadSettings(local).alphaVantageKey, "", "an invalid stored key is ignored");
  local.setItem("md.settings.v1", JSON.stringify({ alphaVantageKey: KEY_A }));
  local.setItem(`md.av.v2.${keyFingerprint(KEY_A)}.quote:AAPL`, "{broken");
  const md2 = createMarketData({ local, session: F.memory(), fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0 });
  assert.equal(md2.usage().count, 0);
  assert.equal((await md2.quote("AAPL")).provenance.cached, false, "a corrupted entry is a miss");
});

test("pre-release (unnamespaced) Alpha Vantage cache entries are discarded on load", () => {
  const local = F.memory();
  for (const k of ["md.av.listing.v1:AAPL", "md.av.quote.v1:AAPL", "md.av.history.v1:weekly:AAPL", "md.av.usage.v1"]) local.setItem(k, JSON.stringify({ savedAt: NOW, value: {} }));
  local.setItem("md.fx.v1:other", "kept");
  make({ local });
  assert.deepEqual(keysIn(local), ["md.fx.v1:other"]);
});

/* ---------------- R05: where the key is stored, and that it never leaks ---------------- */
test("remember / session-only storage, switching between them, and removal", () => {
  const local = F.memory();
  const session = F.memory();
  const md = make({ local, session });
  const SLOT = "md.key.v2.alphavantage";
  assert.deepEqual(md.setApiKey(KEY_A, { remember: false }), { persistence: "session", saved: true });
  assert.equal(local.getItem(SLOT), null, "session-only keys are not written to local storage");
  assert.equal(session.getItem(SLOT), KEY_A);
  assert.equal(loadSettings(local, session).persistence, "session");
  assert.deepEqual(md.setApiKey(KEY_A, { remember: true }), { persistence: "local", saved: true });
  assert.equal(session.getItem(SLOT), null, "only one copy is kept");
  assert.equal(loadSettings(local, session).alphaVantageKey, KEY_A);
  // A new tab (empty session storage) still sees a remembered key...
  assert.equal(make({ local, session: F.memory() }).settings.persistence, "local");
  // ...but not a session-only one.
  md.setApiKey(KEY_B, { remember: false });
  assert.equal(local.getItem(SLOT), null, "choosing session-only also forgets the remembered key");
  assert.equal(make({ local, session: F.memory() }).liveAvailable(), false);
  md.setApiKey("");
  assert.equal(session.getItem(SLOT), null);
  // A session copy wins over a remembered one in the same tab.
  local.setItem(SLOT, KEY_A);
  session.setItem(SLOT, KEY_B);
  assert.deepEqual(loadSettings(local, session), { alphaVantageKey: KEY_B, persistence: "session" });
});

test("a key saved by an earlier version is moved to its provider slot in the same storage", () => {
  const local = F.memory();
  local.setItem("md.settings.v1", JSON.stringify({ alphaVantageKey: KEY_A }));
  const md = make({ local });
  assert.equal(md.liveAvailable(), true);
  assert.deepEqual(md.settings, { hasKey: true, persistence: "local" });
  assert.equal(local.getItem("md.key.v2.alphavantage"), KEY_A);
  assert.equal(local.getItem("md.settings.v1"), null, "the old record is removed after the move");
  const session = F.memory();
  session.setItem("md.settings.v1", JSON.stringify({ alphaVantageKey: KEY_B }));
  const tab = make({ local: F.memory(), session });
  assert.deepEqual(tab.settings, { hasKey: true, persistence: "session" }, "a session-only key stays session-only");
});

test("the key is sent only to Alpha Vantage and appears nowhere else", async () => {
  const local = F.memory();
  const session = F.memory();
  const all = [];
  const av = server();
  const fetchImpl = async (raw, init) => {
    const url = new URL(String(raw));
    all.push(url);
    if (url.hostname === "www.bankofcanada.ca") return F.response(200, F.bocJson([{ d: "2026-10-30", FXUSDCAD: 1.396 }]));
    return av.fetchImpl(raw, init);
  };
  const md = make({ local, session, fetchImpl });
  md.setApiKey(KEY_A, { remember: false });
  const results = [await md.quote("AAPL"), await md.history("AAPL", YEAR), await md.fx.latest(["USD"])];
  const bad = server({ limitFor: new Set([KEY_A]) });
  const md2 = make({ fetchImpl: bad.fetchImpl });
  md2.setApiKey(KEY_A);
  const error = await md2.quote("AAPL").catch(e => e);
  for (const url of all.filter(u => u.searchParams.has("apikey"))) {
    assert.equal(`${url.origin}${url.pathname}`, "https://www.alphavantage.co/query");
  }
  assert.ok(all.filter(u => u.hostname !== "www.alphavantage.co").every(u => !String(u).includes(KEY_A)), "exchange-rate requests never carry the key");
  assert.ok(!JSON.stringify(results).includes(KEY_A), "results and provenance never include the key");
  assert.ok(!String(error.message).includes(KEY_A) && !JSON.stringify(error).includes(KEY_A));
  assert.ok(!JSON.stringify(md.settings).includes(KEY_A), "the settings getter does not expose the key");
  for (const store of [local, session]) {
    for (const k of keysIn(store)) {
      assert.ok(!k.includes(KEY_A), `storage name ${k} contains the key`);
      if (!k.startsWith("md.key.v2.")) assert.ok(!String(store.getItem(k)).includes(KEY_A), `${k} contains the key`);
    }
  }
});

test("key fingerprints are stable, distinct and do not contain the key", () => {
  assert.equal(keyFingerprint(KEY_A), keyFingerprint(` ${KEY_A} `));
  assert.notEqual(keyFingerprint(KEY_A), keyFingerprint(KEY_B));
  assert.match(keyFingerprint(KEY_A), /^k[0-9a-z]{1,7}$/);
  const seen = new Set(Array.from({ length: 2000 }, (_, i) => keyFingerprint(`KEY${String(i).padStart(13, "0")}`)));
  assert.equal(seen.size, 2000, "no collisions among 2,000 similar keys");
});
