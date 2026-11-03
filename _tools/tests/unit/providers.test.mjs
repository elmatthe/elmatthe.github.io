// Multi-provider quote service: adapters against shared response fixtures, routing,
// request estimates, opt-in fallback, per-provider key isolation and redaction.
// Every response is mocked; no request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMarketData, compareQuotes } from "../../../assets/js/market-data/index.js";
import { routeInstrument, planOf, PROVIDERS, providersFor } from "../../../assets/js/market-data/catalog.js";
import { ADAPTERS } from "../../../assets/js/market-data/providers/quote-adapters.js";
import { createInstrumentResolver } from "../../../assets/js/market-data/instruments.js";
import { SAMPLE_PORTFOLIO } from "../../../assets/js/portfolio-rebalancer/sample.js";
import * as F from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const REFERENCE = JSON.parse(fs.readFileSync(path.join(root, "assets/data/instruments.v1.json"), "utf8"));
const FIXTURES = JSON.parse(fs.readFileSync(path.join(root, "_tools/tests/fixtures/providers/quote-responses.json"), "utf8"));
const resolver = createInstrumentResolver(REFERENCE);
const NOW = Date.parse("2026-11-03T15:00:00Z");
const noSleep = async () => {};
const KEYS = { alphavantage: "AVKEY1234567", marketstack: "MSKEY1234567890ABCDEF", finnhub: "FHKEY1234567890ABCDEF" };
const HOSTS = { alphavantage: "www.alphavantage.co", marketstack: "api.marketstack.com", finnhub: "finnhub.io", massive: "api.massive.com" };

function make(handler, { keys = KEYS, local = F.memory(), session = F.memory(), ...opts } = {}) {
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(String(raw));
    calls.push({ url, headers: init?.headers || {} });
    return handler(url, init);
  };
  const md = createMarketData({ local, session, fetchImpl, now: () => NOW, sleep: noSleep, minSpacingMs: 0, reference: REFERENCE, ...opts });
  for (const [id, key] of Object.entries(keys)) md.setKey(id, key);
  return { md, calls, local, session };
}

test("browser offers exactly the qualified providers; Alpaca and Massive are not offered, with reasons", () => {
  assert.deepEqual(providersFor("browser"), ["alphavantage", "marketstack", "finnhub"]);
  assert.deepEqual(providersFor("desktop"), ["alphavantage", "marketstack", "finnhub", "alpaca"]);
  assert.equal(Object.keys(PROVIDERS).length, 5, "never more than five providers");
  assert.match(PROVIDERS.alpaca.unsupportedReason, /trading credentials|place trades/);
  assert.match(PROVIDERS.massive.unsupportedReason, /§1/);
  const { md } = make(() => F.response(500, "{}"), { keys: {} });
  assert.throws(() => md.setKey("alpaca", "X".repeat(20)), /not available/);
  assert.throws(() => md.setKey("massive", "X".repeat(20)), /not available/);
});

test("adapters: every shared fixture produces the expected quote or error", async () => {
  for (const c of FIXTURES.cases) {
    const identity = resolver.resolve(c.ticker);
    if (c.provider === "massive") {
      // Implemented but deferred: exercised at adapter level only.
      const a = ADAPTERS.massive;
      if (c.expect.kind) {
        assert.throws(() => { if (c.status !== 200) throw a.classify(c.status, c.body); a.parse(c.body, { symbol: c.symbol, identity }); }, e => e.kind === c.expect.kind && (e.quotaScope ?? null) === (c.expect.quotaScope ?? null), c.name);
      } else {
        const raw = a.parse(c.body, { symbol: c.symbol, identity });
        assert.equal(raw.rawPrice, c.expect.price, c.name);
        assert.equal(raw.tradingDate, c.expect.tradingDate, c.name);
      }
      continue;
    }
    const { md } = make(url => (url.hostname === HOSTS[c.provider] ? F.response(c.status, c.body) : F.response(404, "{}")));
    const result = md.priceWith(c.provider, identity);
    if (c.expect.kind) {
      await assert.rejects(result, e => {
        assert.equal(e.kind, c.expect.kind, c.name);
        if (c.expect.quotaScope) assert.equal(e.quotaScope, c.expect.quotaScope, c.name);
        return true;
      }, c.name);
      if (c.expect.persist) {
        const status = md.providerStatus(c.provider);
        assert.equal(status.limitRecord?.scope, c.expect.quotaScope, `${c.name}: limit recorded`);
        await assert.rejects(md.priceWith(c.provider, resolver.resolve("VST")), e => e.quotaScope === c.expect.quotaScope && /Check again/.test(e.message), `${c.name}: no further requests`);
      }
    } else {
      const q = await result;
      assert.equal(q.schema, "md.quote.v1");
      assert.ok(Math.abs(q.nativePriceMajorUnits - c.expect.price) < 1e-9, `${c.name}: ${q.nativePriceMajorUnits}`);
      assert.equal(q.nativeCurrency, c.expect.currency, c.name);
      assert.equal(q.tradingDate, c.expect.tradingDate, c.name);
      if (c.expect.priceType) assert.equal(q.priceType, c.expect.priceType, c.name);
      if (c.expect.currencyEvidence) assert.equal(q.currencyEvidence, c.expect.currencyEvidence, c.name);
      if (c.expect.quoteUnit) assert.equal(q.quoteUnit, c.expect.quoteUnit, c.name);
      assert.equal(q.currencyVerified, true, c.name);
      assert.equal(q.canonicalId, identity.canonicalId);
    }
  }
});

test("Alpha Vantage: curated instruments cost one request (no search); YNVD.TO is never sent as a TSX symbol", async () => {
  const { md, calls } = make(url => {
    const fn = url.searchParams.get("function");
    if (fn === "GLOBAL_QUOTE") return F.response(200, F.avGlobalQuote(url.searchParams.get("symbol"), url.searchParams.get("symbol") === "VOD.LON" ? 7215 : 60.5, "2026-11-02"));
    return F.response(200, F.avSearch([]));
  }, { keys: { alphavantage: KEYS.alphavantage } });
  const veqt = await md.priceInstrument(resolver.resolve("VEQT.TO"));
  assert.deepEqual([veqt.providerSymbol, veqt.nativeCurrency, veqt.currencyEvidence], ["VEQT.TRT", "CAD", "curated_reference"]);
  assert.equal(calls.length, 1);
  const vod = await md.priceInstrument(resolver.resolve("VOD.L"));
  assert.equal(vod.nativePriceMajorUnits, 72.15, "pence converted to pounds");
  await assert.rejects(md.priceInstrument(resolver.resolve("YNVD.TO")), e => e.kind === "not_covered" && /Cboe Canada/.test(e.message));
  await assert.rejects(md.priceInstrument(resolver.resolve("7203.T")), e => e.kind === "not_covered");
  assert.ok(!calls.some(c => /YNVD/.test(String(c.url))), "no request for YNVD at all");
});

test("routing of the 14-row sample with each key set, and the request estimate before any fetch", () => {
  const ids = SAMPLE_PORTFOLIO.rows.map(r => resolver.resolve(r.ticker));
  const plans = { alphavantage: planOf("alphavantage"), marketstack: planOf("marketstack"), finnhub: planOf("finnhub") };
  const first = (identity, configured) => routeInstrument(identity, { configured, plans }).candidates[0]?.id || null;
  const byTicker = configured => Object.fromEntries(ids.map(i => [i.displayTicker, first(i, configured)]));
  assert.deepEqual(byTicker(["alphavantage", "finnhub"]), {
    "VEQT.TO": "alphavantage", "CNQ.TO": "alphavantage", "XQQ.TO": "alphavantage", "HEWB.TO": "alphavantage", AAPL: "finnhub", "VFV.TO": "alphavantage",
    SPCX: "finnhub", CBRS: "finnhub", "YNVD.TO": null, VST: "finnhub", "7203.T": null, "SAP.DE": "alphavantage", "VOD.L": "alphavantage", "600519.SS": "alphavantage",
  });
  const withMs = byTicker(["marketstack"]);
  assert.equal(withMs["YNVD.TO"], null, "YNVD is not in Marketstack's ticker list");
  assert.equal(withMs["7203.T"], "marketstack");
  const { md } = make(() => F.response(500, "{}"), { keys: { alphavantage: KEYS.alphavantage, finnhub: KEYS.finnhub } });
  const active = ids.slice(0, 10);
  const est = md.estimate(active);
  assert.equal(est.perProvider.alphavantage.requests, 5, "five TSX ETFs/stocks, curated: one GLOBAL_QUOTE each");
  assert.equal(est.perProvider.finnhub.requests, 4);
  assert.deepEqual(est.uncovered.map(u => u.displayTicker), ["YNVD.TO"]);
  assert.equal(est.perProvider.alphavantage.remaining, 25);
  const avOnly = make(() => F.response(500, "{}"), { keys: { alphavantage: KEYS.alphavantage } }).md.estimate(active);
  assert.equal(avOnly.perProvider.alphavantage.requests, 9, "Alpha Vantage only: 9 requests, within 25");
});

test("fallback is opt-in and says which source failed first", async () => {
  const handler = url => {
    if (url.hostname === HOSTS.finnhub) return F.response(429, JSON.stringify({ error: "API limit reached." }));
    if (url.hostname === HOSTS.alphavantage) return F.response(200, F.avGlobalQuote("AAPL", 230, "2026-11-02"));
    return F.response(404, "{}");
  };
  const { md } = make(handler, { keys: { alphavantage: KEYS.alphavantage, finnhub: KEYS.finnhub } });
  await assert.rejects(md.priceInstrument(resolver.resolve("AAPL")), e => e.kind === "rate_limited" && e.provider === "Finnhub");
  md.setRouting({ fallback: true });
  const q = await md.priceInstrument(resolver.resolve("AAPL"), { useCache: false });
  assert.equal(q.provider, "Alpha Vantage");
  assert.equal(q.fallbackFrom[0].provider, "Finnhub");
  // A single chosen provider never silently uses another one.
  md.setRouting({ mode: "finnhub", fallback: true });
  await assert.rejects(md.priceInstrument(resolver.resolve("AAPL"), { useCache: false }), e => e.provider === "Finnhub");
});

test("keys: each goes only to its own provider host and appears in no result, error or other storage value", async () => {
  const handler = url => {
    if (url.hostname === HOSTS.alphavantage) return F.response(200, JSON.stringify({ Information: `We have detected your API key as ${KEYS.alphavantage} and our standard API rate limit is 25 requests per day.` }));
    if (url.hostname === HOSTS.marketstack) return F.response(200, JSON.stringify({ data: [{ close: 101, price_currency: "USD", symbol: "AAPL", exchange: "XNAS", date: "2026-11-02T00:00:00+0000" }] }));
    if (url.hostname === HOSTS.finnhub) return F.response(401, JSON.stringify({ error: `Invalid API key ${KEYS.finnhub}` }));
    return F.response(404, "{}");
  };
  const { md, calls, local, session } = make(handler);
  const outputs = [];
  outputs.push(await md.priceWith("marketstack", resolver.resolve("AAPL")));
  outputs.push(await md.priceWith("alphavantage", resolver.resolve("AAPL")).catch(e => e.toContract()));
  outputs.push(await md.priceWith("finnhub", resolver.resolve("AAPL")).catch(e => e.toContract()));
  outputs.push(md.providers(), md.estimate([resolver.resolve("AAPL")]));
  const text = JSON.stringify(outputs);
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), `a key leaked into results: ${key.slice(0, 4)}…`);
  for (const c of calls) {
    const s = String(c.url) + JSON.stringify(c.headers);
    for (const [id, key] of Object.entries(KEYS)) if (s.includes(key)) assert.equal(c.url.hostname, HOSTS[id], `${id} key sent to ${c.url.hostname}`);
  }
  for (const store of [local, session]) {
    for (let i = 0; i < store.length; i += 1) {
      const name = store.key(i);
      if (name.startsWith("md.key.v2.")) continue;
      for (const key of Object.values(KEYS)) assert.ok(!name.includes(key) && !String(store.getItem(name)).includes(key), `${name} holds a key`);
    }
  }
  assert.ok(text.includes("[redacted]"), "a provider notice that echoed the key is kept, redacted");
});

test("a key change for one provider retires only that provider's work and caches", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const handler = async url => {
    if (url.hostname === HOSTS.marketstack) { await gate; return F.response(200, JSON.stringify({ data: [{ close: 101, price_currency: "USD", symbol: "AAPL", exchange: "XNAS", date: "2026-11-02T00:00:00+0000" }] })); }
    if (url.hostname === HOSTS.finnhub) return F.response(200, JSON.stringify({ c: 100, t: 1793653200 }));
    return F.response(404, "{}");
  };
  const { md } = make(handler);
  const pending = md.priceWith("marketstack", resolver.resolve("AAPL"));
  md.setKey("marketstack", "MSKEYNEW000000000000");
  release();
  await assert.rejects(pending, e => e.kind === "key_changed" || e.kind === "aborted");
  const fh = await md.priceWith("finnhub", resolver.resolve("AAPL"));
  assert.equal(fh.nativePriceMajorUnits, 100, "Finnhub unaffected");
});

test("cross-check compares only the same listing, session, currency and price type", () => {
  const base = { canonicalId: "XNAS:AAPL", nativeCurrency: "USD", priceType: "eod_close", tradingDate: "2026-11-02", nativePriceMajorUnits: 100 };
  assert.equal(compareQuotes(base, { ...base, nativePriceMajorUnits: 100.05 }).label, "Consistent");
  assert.equal(compareQuotes(base, { ...base, nativePriceMajorUnits: 100.6 }).label, "Minor difference");
  const big = compareQuotes(base, { ...base, nativePriceMajorUnits: 1.0 });
  assert.equal(big.label, "Investigate");
  assert.match(big.causes[0], /factor of 100/);
  assert.match(compareQuotes(base, { ...base, tradingDate: "2026-10-30" }).reason, /different sessions/);
  assert.match(compareQuotes(base, { ...base, priceType: "last_trade" }).reason, /different price types/);
  assert.match(compareQuotes(base, { ...base, canonicalId: "XTSE:AAPL" }).reason, /different instruments/);
  assert.equal(compareQuotes(base, { ...base, priceType: "latest_trading_day" }).comparable, true, "two closes of the same session");
});

test("paid plans change pacing and budgets but never mean unlimited", () => {
  const ms = planOf("marketstack", "basic");
  assert.equal(ms.limits.perMonth, 10000);
  const av = planOf("alphavantage", "premium", { limit: 150 });
  assert.equal(av.limits.perMinute, 150);
  assert.ok(av.pacing.minSpacingMs >= 400);
  const fh = planOf("finnhub", "paid", { limit: 150, international: true });
  assert.equal(fh.international, true);
  // International Finnhub quotes carry no currency: only curated identities qualify.
  assert.equal(PROVIDERS.finnhub.symbolFor(resolver.resolve("VEQT.TO"), fh), "VEQT.TO");
  assert.equal(PROVIDERS.finnhub.symbolFor(resolver.resolve("RY.TO"), fh), null);
  for (const id of Object.keys(PROVIDERS)) for (const p of PROVIDERS[id].plans) assert.ok(!/unlimited/i.test(p.label), `${id}/${p.id}`);
});
