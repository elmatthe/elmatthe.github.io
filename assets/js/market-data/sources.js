// Market-data source priority: ONE ordered list of price sources, used by the Portfolio
// Rebalancer and the Stock Comparison tool on this website and in both desktop apps
// (market_data/sources.py carries the same rules; _tools/tests/test_market_data_parity.py
// checks that the two agree).
//
// Every source the platform offers has a position: 1 is tried first, 2 if 1 cannot give
// a usable answer, and so on. The list is not limited to four entries; a source added to
// the catalog later simply takes the next position.
//
// Rules:
//   * Yahoo Finance (through this site's data gateway) needs no key. In a fresh list it
//     is the only source switched on, at position 1.
//   * A personal-key provider joins the list switched off. Saving a NEW key switches it on
//     at the position it already has (by default below Yahoo Finance): saving a key never
//     moves a provider to the top. The visitor may then reorder freely.
//   * Removing a key switches that provider off but keeps its position, so the order is
//     unchanged if the key comes back. If nothing else would be on, Yahoo Finance is
//     switched back on, and the change is explained.
//   * A source is asked only for operations it actually has on this platform (a
//     latest-price-only source is never asked for price history), only for listings it
//     covers, and never while it is unavailable (no key, key rejected, a daily or monthly
//     limit reached, or paused after a rate limit).
//   * Deferred or unsupported providers (Massive; Alpaca on the website) never appear.

import { PROVIDERS, PROVIDER_IDS, providerAvailable, coverageGap as providerGap, planOf } from "./catalog.js";
import { keylessSymbol } from "./keyless.js";

export const SOURCES_VERSION = "2026-11-04.1";
export const YAHOO_ID = "yahoo";
export const OPERATIONS = Object.freeze(["quote", "history"]);

// Operations per source and platform, with the plain-language label shown in the list.
export const SOURCE_INFO = Object.freeze({
  yahoo: {
    id: "yahoo", name: "Yahoo Finance", needsKey: false,
    ops: { browser: ["quote", "history"], desktop: ["quote", "history"] },
    labels: { quote: "Latest prices", history: "Daily history up to 5 years (close and adjusted close)" },
    summary: "No key needed. Retrieved through this site's data gateway and briefly cached; quotes may be delayed.",
  },
  alphavantage: {
    id: "alphavantage", name: "Alpha Vantage", needsKey: true,
    ops: { browser: ["quote", "history"], desktop: ["quote", "history"] },
    labels: { quote: "Latest prices", history: "Daily closes as traded (up to about 4 months), weekly adjusted closes beyond" },
    summary: "Your own key. 25 requests per day on the free plan.",
  },
  marketstack: {
    id: "marketstack", name: "Marketstack", needsKey: true,
    ops: { browser: ["quote"], desktop: ["quote", "history"] },
    labels: { quote: "End-of-day prices", history: "Daily close and adjusted close" },
    summary: "Your own key. 100 requests per month on the free plan.",
  },
  finnhub: {
    id: "finnhub", name: "Finnhub", needsKey: true,
    ops: { browser: ["quote"], desktop: ["quote"] },
    labels: { quote: "Latest prices (US listings on the free plan)" },
    summary: "Your own key. 60 requests per minute on the free plan.",
  },
  alpaca: {
    id: "alpaca", name: "Alpaca", needsKey: true,
    ops: { browser: [], desktop: ["quote", "history"] },
    labels: { quote: "Latest trades (US listings; IEX exchange on the free plan)", history: "Daily bars (raw and adjusted)" },
    summary: "Your own key ID and secret (desktop apps only).",
  },
});

// Order used for sources a saved list does not mention yet.
export const DEFAULT_ORDER = Object.freeze(["yahoo", "alphavantage", "marketstack", "finnhub", "alpaca"]);

export const sourceName = id => SOURCE_INFO[id]?.name || PROVIDERS[id]?.name || String(id);
export const needsKey = id => Boolean(SOURCE_INFO[id]?.needsKey);

// Sources offered on a platform, in default order. A provider the catalog marks deferred
// or unsupported on this platform is not offered (and so never listed).
export function offeredSources(platform = "browser") {
  const known = [...DEFAULT_ORDER, ...PROVIDER_IDS.filter(id => !DEFAULT_ORDER.includes(id))];
  return known.filter(id => SOURCE_INFO[id] && (id === YAHOO_ID || providerAvailable(id, platform)) && capabilities(id, platform).length > 0);
}

export function capabilities(id, platform = "browser") {
  return [...(SOURCE_INFO[id]?.ops?.[platform] || [])];
}

// A clean list from whatever was saved (or nothing). `configured` lists providers that
// have a key now. Returns { order, enabled, notes }.
export function normalizePriority(saved, { platform = "browser", configured = [] } = {}) {
  const offered = offeredSources(platform);
  const order = [];
  for (const id of Array.isArray(saved?.order) ? saved.order : []) if (offered.includes(id) && !order.includes(id)) order.push(id);
  for (const id of offered) if (!order.includes(id)) order.push(id);
  const enabled = {};
  for (const id of order) {
    const value = saved?.enabled?.[id];
    enabled[id] = typeof value === "boolean" ? value : id === YAHOO_ID;
  }
  const notes = [];
  ensureSomethingOn({ order, enabled }, configured, notes);
  return { order, enabled, notes };
}

// Yahoo Finance is switched back on when no other source could be used.
function ensureSomethingOn(priority, configured, notes) {
  const usable = priority.order.filter(id => priority.enabled[id] && (!needsKey(id) || configured.includes(id)));
  if (!usable.length && priority.enabled[YAHOO_ID] === false) {
    priority.enabled[YAHOO_ID] = true;
    notes.push(`${sourceName(YAHOO_ID)} was switched back on because no other source in your list can be used.`);
  }
}

// The previous settings ({ routing: "auto" | provider | "keyless", fallback }) as a list,
// so a visitor's earlier choice survives: their chosen provider stays first, and with
// "Automatic" their keys stay ahead of Yahoo Finance, as before.
export function migrateLegacy(prefs, { platform = "browser", configured = [] } = {}) {
  const offered = offeredSources(platform);
  const keyed = ["finnhub", "alphavantage", "marketstack", "alpaca"].filter(id => offered.includes(id) && configured.includes(id));
  const routing = typeof prefs?.routing === "string" ? prefs.routing : "auto";
  const fallback = prefs?.fallback === true;
  let order;
  const enabled = {};
  if (routing === "keyless") {
    order = [YAHOO_ID, ...keyed];
    keyed.forEach(id => { enabled[id] = fallback; });
    enabled[YAHOO_ID] = true;
  } else if (offered.includes(routing) && routing !== YAHOO_ID && configured.includes(routing)) {
    order = [routing, ...keyed.filter(id => id !== routing), YAHOO_ID];
    enabled[routing] = true;
    keyed.filter(id => id !== routing).forEach(id => { enabled[id] = fallback; });
    enabled[YAHOO_ID] = fallback;
  } else {
    order = keyed.length ? [...keyed, YAHOO_ID] : [YAHOO_ID];
    keyed.forEach(id => { enabled[id] = true; });
    enabled[YAHOO_ID] = true;
  }
  return normalizePriority({ order, enabled }, { platform, configured });
}

// Moves a source to a position (0-based, clamped). Returns a new priority.
export function moveSource(priority, id, toIndex) {
  const order = priority.order.filter(x => x !== id);
  if (order.length === priority.order.length) return { ...priority, order: [...priority.order] };
  const at = Math.max(0, Math.min(order.length, Math.trunc(Number(toIndex) || 0)));
  order.splice(at, 0, id);
  return { ...priority, order, enabled: { ...priority.enabled } };
}

// Switches a source on or off. A provider without a key cannot be switched on; Yahoo
// Finance cannot be switched off while it is the only source that could be used.
// Returns { priority, changed, note }.
export function setSourceEnabled(priority, id, on, { configured = [] } = {}) {
  const next = { ...priority, order: [...priority.order], enabled: { ...priority.enabled } };
  if (!next.order.includes(id)) return { priority: next, changed: false, note: `${sourceName(id)} is not offered here.` };
  if (on && needsKey(id) && !configured.includes(id)) return { priority: next, changed: false, note: `Add your ${sourceName(id)} key first; it is then switched on.` };
  if (!on) {
    const others = next.order.filter(x => x !== id && next.enabled[x] && (!needsKey(x) || configured.includes(x)));
    if (!others.length) return { priority: next, changed: false, note: `${sourceName(id)} stays on: it is the only source in your list that can be used. Add a key for another source first.` };
  }
  const changed = next.enabled[id] !== Boolean(on);
  next.enabled[id] = Boolean(on);
  return { priority: next, changed, note: null };
}

// After a key is saved or removed. `isNew` is true when the provider had no key before.
// Returns { priority, note }.
export function keyChanged(priority, id, { hasKey, isNew = false, configured = [] } = {}) {
  const next = { ...priority, order: [...priority.order], enabled: { ...priority.enabled } };
  if (!next.order.includes(id)) return { priority: next, note: null };
  const position = next.order.indexOf(id) + 1;
  const name = sourceName(id);
  if (hasKey && isNew) {
    next.enabled[id] = true;
    const above = next.order.slice(0, position - 1).filter(x => next.enabled[x]).map(sourceName);
    return { priority: next, note: `${name} is switched on at position ${position} of ${next.order.length}${above.length ? `, after ${above.join(", ")}` : ""}. Move it up or down to change when it is tried.` };
  }
  if (!hasKey) {
    next.enabled[id] = false;
    const notes = [`${name} is switched off because its key was removed; it keeps position ${position}, so your order is unchanged if you add a key again.`];
    ensureSomethingOn(next, configured.filter(x => x !== id), notes);
    return { priority: next, note: notes.join(" ") };
  }
  return { priority: next, note: null };
}

// Why a source cannot cover an identity for an operation, or null. `plans` maps provider
// ids to plans (planOf). Yahoo Finance covers the gateway's fixed list of exchanges.
export function coverageGap(id, identity, { plans = {} } = {}) {
  if (!identity || identity.status !== "resolved") return "the ticker is not resolved";
  if (id === YAHOO_ID) return keylessSymbol(identity) ? null : `does not cover ${identity.venueName || identity.mic}`;
  const gap = providerGap(id, identity, plans[id] || planOf(id));
  return gap ? gap.replace(new RegExp(`^${PROVIDERS[id].name} `), "") : null;
}

export function symbolFor(id, identity, { plans = {} } = {}) {
  if (id === YAHOO_ID) return keylessSymbol(identity);
  return PROVIDERS[id]?.symbolFor(identity, plans[id] || planOf(id)) || null;
}

const OP_GAP = {
  quote: "does not provide latest prices here",
  history: "provides latest prices only, not price history",
};

// The sources to try, in order, for one identity and operation, and why the others are
// skipped. `state[id]` is { available, code, reason } (missing = available); `require`
// is an optional extra check (id) => reason | null (for example a history frequency).
// Returns { candidates: [{ id, symbol }], skipped: [{ id, code, reason }] }.
export function planSources(identity, op, { priority, platform = "browser", state = {}, plans = {}, require = null } = {}) {
  const candidates = [];
  const skipped = [];
  for (const id of priority.order) {
    if (!offeredSources(platform).includes(id)) continue;
    if (!priority.enabled[id]) { skipped.push({ id, code: "off", reason: "switched off in your source list" }); continue; }
    if (!capabilities(id, platform).includes(op)) { skipped.push({ id, code: "no_capability", reason: OP_GAP[op] || `does not provide ${op}` }); continue; }
    const st = state[id];
    if (st && st.available === false) { skipped.push({ id, code: st.code || "unavailable", reason: st.reason || "not available right now", short: st.short || st.reason || "not available right now" }); continue; }
    const gap = coverageGap(id, identity, { plans });
    if (gap) { skipped.push({ id, code: "not_covered", reason: gap }); continue; }
    const extra = require ? require(id) : null;
    if (extra) { skipped.push({ id, code: "incompatible", reason: extra }); continue; }
    candidates.push({ id, symbol: symbolFor(id, identity, { plans }) });
  }
  return { candidates, skipped };
}

// One line per skipped source, for messages and exports (`short` for one-line summaries).
export function describeSkipped(skipped, { includeOff = false, short = false } = {}) {
  return skipped.filter(s => includeOff || s.code !== "off").map(s => `${sourceName(s.id)}: ${short ? s.short || s.reason : s.reason}`);
}

// A short, listing-independent phrase for a failed attempt ({ kind, quotaScope, paused }),
// so the same cause reads the same for every holding it affects.
export function shortFailure(a) {
  if (a.kind === "auth") return "rejected the key";
  if (a.kind === "rate_limited") return ["daily", "monthly"].includes(a.quotaScope) ? `${a.quotaScope} limit reached` : a.paused ? "paused after a rate limit" : "rate-limited";
  if (a.paused) return "paused after an outage";
  return {
    not_found: "has no data for this listing", not_covered: "does not cover this listing", ambiguous: "answered for a different listing",
    currency_mismatch: "could not confirm the currency", invalid: "returned data that failed its checks", timeout: "did not answer in time",
    network: "could not be reached", unavailable: "unavailable", entitlement: "not included in your plan", not_configured: "not available",
  }[a.kind] || "failed";
}
