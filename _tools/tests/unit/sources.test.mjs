// The ordered market-data source list (assets/js/market-data/sources.js): defaults,
// persistence repair, migration of the previous routing choice, moves, switching on and
// off, keys added and removed, and the per-identity plan (capabilities, coverage,
// availability, extra requirements). Pure functions: no network, no storage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as S from "../../../assets/js/market-data/sources.js";
import { createInstrumentResolver } from "../../../assets/js/market-data/instruments.js";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("../../../assets/data/instruments.v1.json", import.meta.url), "utf8"));
const resolver = createInstrumentResolver(REFERENCE);
const id = t => resolver.resolve(t);

test("offered sources: Yahoo Finance and the enabled providers; deferred or unsupported providers never appear", () => {
  assert.deepEqual(S.offeredSources("browser"), ["yahoo", "alphavantage", "marketstack", "finnhub"]);
  assert.deepEqual(S.offeredSources("desktop"), ["yahoo", "alphavantage", "marketstack", "finnhub", "alpaca"]);
  assert.ok(!S.offeredSources("browser").includes("massive") && !S.offeredSources("desktop").includes("massive"), "Massive's adapter exists but it is not offered");
  assert.deepEqual(S.capabilities("finnhub", "browser"), ["quote"]);
  assert.deepEqual(S.capabilities("marketstack", "browser"), ["quote"], "the website has no Marketstack history");
  assert.deepEqual(S.capabilities("marketstack", "desktop"), ["quote", "history"]);
  assert.deepEqual(S.capabilities("alpaca", "browser"), []);
  assert.deepEqual(S.capabilities("yahoo", "desktop"), ["quote", "history"]);
});

test("defaults: a fresh list has every offered source, Yahoo Finance first and the only one on", () => {
  const p = S.normalizePriority(null, { platform: "browser" });
  assert.deepEqual(p.order, ["yahoo", "alphavantage", "marketstack", "finnhub"]);
  assert.deepEqual(p.enabled, { yahoo: true, alphavantage: false, marketstack: false, finnhub: false });
  assert.deepEqual(p.notes, []);
});

test("repair: unknown, deferred and duplicate entries are dropped; missing sources are appended; nothing is lost", () => {
  const p = S.normalizePriority({ order: ["finnhub", "massive", "finnhub", "nope", "yahoo"], enabled: { finnhub: true, yahoo: false } }, { platform: "browser", configured: ["finnhub"] });
  assert.deepEqual(p.order, ["finnhub", "yahoo", "alphavantage", "marketstack"]);
  assert.equal(p.enabled.finnhub, true);
  assert.equal(p.enabled.yahoo, false, "the visitor's choice is kept while another source can be used");
  // A list with nothing usable switches Yahoo Finance back on and says so.
  const none = S.normalizePriority({ order: ["yahoo", "finnhub"], enabled: { yahoo: false, finnhub: true } }, { platform: "browser", configured: [] });
  assert.equal(none.enabled.yahoo, true);
  assert.match(none.notes[0], /Yahoo Finance was switched back on/);
  // A desktop list keeps Alpaca; the browser drops it.
  assert.ok(S.normalizePriority({ order: ["alpaca", "yahoo"] }, { platform: "desktop" }).order[0] === "alpaca");
  assert.ok(!S.normalizePriority({ order: ["alpaca", "yahoo"] }, { platform: "browser" }).order.includes("alpaca"));
});

test("migration of the previous routing choice keeps the visitor's priorities", () => {
  assert.deepEqual(S.migrateLegacy({ routing: "auto", fallback: false }, { configured: [] }).order[0], "yahoo");
  const auto = S.migrateLegacy({ routing: "auto" }, { configured: ["alphavantage", "finnhub"] });
  assert.deepEqual(auto.order, ["finnhub", "alphavantage", "yahoo", "marketstack"], "Automatic: the saved keys stay ahead of Yahoo Finance, as before");
  assert.equal(auto.enabled.alphavantage && auto.enabled.finnhub && auto.enabled.yahoo, true);
  const chosen = S.migrateLegacy({ routing: "alphavantage", fallback: false }, { configured: ["alphavantage", "finnhub"] });
  assert.deepEqual(chosen.order.slice(0, 2), ["alphavantage", "finnhub"]);
  assert.equal(chosen.enabled.alphavantage, true);
  assert.equal(chosen.enabled.finnhub, false, "without fallback, only the chosen provider was used");
  const keyless = S.migrateLegacy({ routing: "keyless", fallback: true }, { configured: ["marketstack"] });
  assert.deepEqual(keyless.order.slice(0, 2), ["yahoo", "marketstack"]);
  assert.equal(keyless.enabled.marketstack, true);
});

test("moves: any position, clamped, the rest keep their relative order", () => {
  const p = S.normalizePriority(null, {});
  assert.deepEqual(S.moveSource(p, "finnhub", 0).order, ["finnhub", "yahoo", "alphavantage", "marketstack"]);
  assert.deepEqual(S.moveSource(p, "yahoo", 99).order, ["alphavantage", "marketstack", "finnhub", "yahoo"]);
  assert.deepEqual(S.moveSource(p, "yahoo", -5).order, p.order);
  assert.deepEqual(S.moveSource(p, "marketstack", 1).order, ["yahoo", "marketstack", "alphavantage", "finnhub"]);
  assert.deepEqual(S.moveSource(p, "nope", 0).order, p.order);
  assert.notEqual(S.moveSource(p, "finnhub", 0).order, p.order, "a new list is returned");
});

test("switching on and off: no provider without a key; the last usable source stays on", () => {
  const p = S.normalizePriority(null, {});
  const r1 = S.setSourceEnabled(p, "alphavantage", true, { configured: [] });
  assert.equal(r1.changed, false);
  assert.match(r1.note, /Add your Alpha Vantage key first/);
  const r2 = S.setSourceEnabled(p, "yahoo", false, { configured: [] });
  assert.equal(r2.changed, false);
  assert.match(r2.note, /stays on: it is the only source/);
  const on = S.setSourceEnabled(p, "alphavantage", true, { configured: ["alphavantage"] }).priority;
  const off = S.setSourceEnabled(on, "yahoo", false, { configured: ["alphavantage"] });
  assert.equal(off.changed, true);
  assert.equal(off.priority.enabled.yahoo, false);
});

test("keys: a new key switches the provider on where it stands (never at the top); removal switches it off and keeps its place", () => {
  const p = S.normalizePriority(null, {});
  const added = S.keyChanged(p, "finnhub", { hasKey: true, isNew: true, configured: ["finnhub"] });
  assert.deepEqual(added.priority.order, p.order, "no reordering");
  assert.equal(added.priority.enabled.finnhub, true);
  assert.match(added.note, /Finnhub is switched on at position 4 of 4, after Yahoo Finance/);
  const replaced = S.keyChanged(added.priority, "finnhub", { hasKey: true, isNew: false, configured: ["finnhub"] });
  assert.equal(replaced.note, null, "a replacement key changes nothing in the list");
  const yahooOff = S.setSourceEnabled(added.priority, "yahoo", false, { configured: ["finnhub"] }).priority;
  const removed = S.keyChanged(yahooOff, "finnhub", { hasKey: false, configured: ["finnhub"] });
  assert.equal(removed.priority.enabled.finnhub, false);
  assert.equal(removed.priority.order.indexOf("finnhub"), 3, "keeps position 4");
  assert.equal(removed.priority.enabled.yahoo, true, "nothing else could be used: Yahoo Finance back on");
  assert.match(removed.note, /keeps position 4[\s\S]*Yahoo Finance was switched back on/);
});

test("plan: order, capability, availability, coverage and extra requirements decide; nothing else is asked", () => {
  const priority = { order: ["finnhub", "alphavantage", "yahoo", "marketstack"], enabled: { finnhub: true, alphavantage: true, yahoo: true, marketstack: false } };
  const quoteAapl = S.planSources(id("AAPL"), "quote", { priority });
  assert.deepEqual(quoteAapl.candidates.map(c => [c.id, c.symbol]), [["finnhub", "AAPL"], ["alphavantage", "AAPL"], ["yahoo", "AAPL"]]);
  assert.deepEqual(quoteAapl.skipped, [{ id: "marketstack", code: "off", reason: "switched off in your source list" }]);
  const tsx = S.planSources(id("VEQT.TO"), "quote", { priority });
  assert.deepEqual(tsx.candidates.map(c => [c.id, c.symbol]), [["alphavantage", "VEQT.TRT"], ["yahoo", "VEQT.TO"]]);
  assert.match(tsx.skipped.find(x => x.id === "finnhub").reason, /does not cover Toronto Stock Exchange on the free plan/);
  const ynvd = S.planSources(id("YNVD.TO"), "quote", { priority });
  assert.deepEqual(ynvd.candidates.map(c => [c.id, c.symbol]), [["yahoo", "YNVD.NE"]], "Questrade's YNVD.TO is the Cboe Canada listing for every source");
  // History: a latest-price-only source is never a candidate.
  const hist = S.planSources(id("AAPL"), "history", { priority });
  assert.deepEqual(hist.candidates.map(c => c.id), ["alphavantage", "yahoo"]);
  assert.deepEqual(hist.skipped.find(x => x.id === "finnhub"), { id: "finnhub", code: "no_capability", reason: "provides latest prices only, not price history" });
  // Availability: an exhausted, rejected or paused source is skipped with its reason.
  const state = { alphavantage: { available: false, code: "rate_limited", reason: "reported its daily limit at 14:02 UTC", short: "daily limit reached" }, yahoo: { available: false, code: "paused", reason: "paused for about 12 more minutes", short: "paused after a rate limit" } };
  const limited = S.planSources(id("AAPL"), "quote", { priority, state });
  assert.deepEqual(limited.candidates.map(c => c.id), ["finnhub"]);
  assert.deepEqual(S.describeSkipped(limited.skipped, { short: true }), ["Alpha Vantage: daily limit reached", "Yahoo Finance: paused after a rate limit"]);
  assert.deepEqual(S.describeSkipped(limited.skipped, { includeOff: true }).length, 3);
  // An extra requirement (for example one frequency per comparison).
  const weeklyOnly = S.planSources(id("AAPL"), "history", { priority, require: x => (x === "yahoo" ? "would give daily prices" : null) });
  assert.deepEqual(weeklyOnly.candidates.map(c => c.id), ["alphavantage"]);
  assert.equal(weeklyOnly.skipped.find(x => x.id === "yahoo").code, "incompatible");
  // Unresolved tickers and unsupported exchanges.
  assert.deepEqual(S.planSources(id("^GSPC"), "quote", { priority }).candidates, []);
  assert.match(S.planSources(id("RELIANCE.BO"), "quote", { priority }).skipped.find(x => x.id === "yahoo").reason, /does not cover/);
});

test("short failure phrases are listing-independent", () => {
  assert.equal(S.shortFailure({ kind: "rate_limited", quotaScope: "daily" }), "daily limit reached");
  assert.equal(S.shortFailure({ kind: "rate_limited", quotaScope: "minute", paused: true }), "paused after a rate limit");
  assert.equal(S.shortFailure({ kind: "unavailable", paused: true }), "paused after an outage");
  assert.equal(S.shortFailure({ kind: "auth" }), "rejected the key");
  assert.equal(S.shortFailure({ kind: "ambiguous" }), "answered for a different listing");
  assert.equal(S.shortFailure({ kind: "currency_mismatch" }), "could not confirm the currency");
  assert.equal(S.shortFailure({ kind: "weird" }), "failed");
});
