// Holding rows for the Portfolio Rebalancer: a small state machine with no DOM.
//
//   empty --type--> draft --commit (Enter / leaving the field)--> resolved | invalid |
//   unsupported | unresolved --price--> pricing --> priced | failed | not_covered
//   any state --ticker edited--> draft (revision + 1; identity, quote, manual price and
//   errors cleared; shares, target and account kept)
//
// Every request is tagged with a token { rowId, revision, canonicalId, provider }.
// A response is applied only if the row still has that revision, instrument and
// provider, so a late answer for a previous ticker can never fill in the new one.

let nextId = 1;

export const ROW_STATES = ["empty", "draft", "resolved", "invalid", "unsupported", "unresolved", "pricing", "priced", "failed", "not_covered"];

export function createRow({ ticker = "", shares = "", targetWeight = "", accountType = "", group = "main" } = {}) {
  const text = String(ticker || "").trim().toUpperCase();
  return {
    id: `r${nextId++}`,
    revision: 0,
    ticker: text,
    shares: shares === null || shares === undefined ? "" : String(shares),
    targetWeight: targetWeight === null || targetWeight === undefined ? "" : String(targetWeight),
    accountType: accountType || "",
    group,
    status: text ? "draft" : "empty",
    identity: null,
    quote: null, // md.quote.v1 from a provider, for this row's current instrument only
    error: null, // md.data-error.v1
    manual: null, // { price, currency, unitScale, kind: "manual" | "csv", label, at }
    useManual: false,
    crossCheck: null,
    committedTicker: null,
  };
}

// The user changed the ticker text. Everything that belonged to the previous
// instrument is cleared at once; shares, target and account stay.
export function editTicker(row, text) {
  const ticker = String(text || "").trim().toUpperCase();
  if (ticker === row.ticker) return row;
  return {
    ...row,
    ticker,
    revision: row.revision + 1,
    status: ticker ? "draft" : "empty",
    identity: null,
    quote: null,
    error: null,
    manual: null,
    useManual: false,
    crossCheck: null,
    committedTicker: null,
  };
}

export const editField = (row, field, value) => {
  if (!["shares", "targetWeight", "accountType"].includes(field)) throw new Error(`not an editable field: ${field}`);
  return { ...row, [field]: String(value ?? "") };
};

// The ticker was committed and resolved locally (no network).
export function applyIdentity(row, identity) {
  if (identity.displayTicker !== row.ticker) return row; // resolved text is no longer in the box
  const status = identity.status === "resolved" ? "resolved" : identity.status === "empty" ? "empty" : identity.status;
  return { ...row, identity, status, error: identity.status === "resolved" ? null : null, committedTicker: row.ticker };
}

// Any change of data source retires quotes from the previous one.
export function resetQuote(row) {
  if (!row.quote && !row.error && row.status !== "pricing") return row;
  return { ...row, revision: row.revision + 1, quote: null, error: null, crossCheck: null, status: row.identity?.status === "resolved" ? "resolved" : row.status === "pricing" ? "draft" : row.status };
}

export function requestToken(row, provider) {
  return { rowId: row.id, revision: row.revision, canonicalId: row.identity?.canonicalId || null, provider };
}

export const tokenMatches = (row, token) => Boolean(row && token && row.id === token.rowId && row.revision === token.revision
  && (row.identity?.canonicalId || null) === token.canonicalId);

export function markPricing(row, token) {
  if (!tokenMatches(row, token)) return row;
  return { ...row, status: "pricing", error: null };
}

// Applies a provider answer. Returns the row unchanged (and `applied: false`) when
// the answer belongs to an earlier revision, another instrument or another provider.
export function applyQuote(row, token, quote) {
  if (!tokenMatches(row, token) || (quote && token.provider && quote.provider !== token.provider)) return { row, applied: false };
  if (quote.canonicalId !== row.identity?.canonicalId) return { row, applied: false };
  return { row: { ...row, status: "priced", quote, error: null }, applied: true };
}

export function applyError(row, token, error) {
  if (!tokenMatches(row, token)) return { row, applied: false };
  const status = error.kind === "not_covered" ? "not_covered" : "failed";
  return { row: { ...row, status, error, quote: null }, applied: true };
}

// The user deliberately supplies a price (or imports one from a CSV file). It is
// kept separately from any provider quote and labelled as user-supplied everywhere.
export function setManualPrice(row, { price, currency, unitScale = 1, kind = "manual", label = null, at = Date.now() }) {
  const n = Number(price);
  if (!(Number.isFinite(n) && n > 0)) throw new Error("Enter a price greater than 0.");
  if (!/^[A-Z]{3}$/.test(String(currency || ""))) throw new Error("Choose the currency the price is in.");
  return { ...row, manual: { price: n * unitScale, enteredPrice: n, currency, unitScale, kind, label: label || (kind === "csv" ? "Imported from CSV (user-supplied)" : "Entered by you (user-supplied)"), at }, useManual: true };
}

export const clearManualPrice = row => ({ ...row, manual: null, useManual: false });

export const isActive = row => {
  const shares = Number(row.shares);
  const target = Number(row.targetWeight);
  return !(row.shares !== "" && row.targetWeight !== "" && shares === 0 && target === 0);
};

// --------------------------------------------------------------- freshness
// Sessions missed between a quote's trading date and today in the listing's time
// zone, counting weekdays only (exchange holidays are not known to the browser, so a
// holiday shows as one missed session). 0 = the latest or previous session.
export function missedSessions(tradingDate, now, timeZone = "America/New_York") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tradingDate || ""))) return null;
  let today;
  try { today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now)); }
  catch (_) { today = new Date(now).toISOString().slice(0, 10); }
  const start = Date.parse(`${tradingDate}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  if (!(start <= end)) return 0;
  let missed = 0;
  for (let t = start + 86400000; t < end; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) missed += 1;
  }
  return missed;
}

export const STALE_SESSIONS = 1; // one missed weekday session or more: ask the user to accept it
export const TOO_OLD_SESSIONS = 4; // four or more: the price is not used

export function freshnessOf(tradingDate, now, timeZone) {
  const missed = missedSessions(tradingDate, now, timeZone);
  if (missed === null) return { freshness: "unknown", missed: null };
  if (missed >= TOO_OLD_SESSIONS) return { freshness: "too_old", missed };
  if (missed >= STALE_SESSIONS) return { freshness: "stale", missed };
  return { freshness: "current", missed };
}

// The price this row would contribute to a plan, with its provenance, or null.
export function effectivePrice(row) {
  if (row.useManual && row.manual) return { price: row.manual.price, currency: row.manual.currency, source: { kind: row.manual.kind, label: row.manual.label, currencyVerified: false, freshness: "current", tradingDate: null } };
  if (row.quote && row.status === "priced") {
    return {
      price: row.quote.nativePriceMajorUnits,
      currency: row.quote.nativeCurrency,
      source: { kind: "provider", provider: row.quote.provider, currencyVerified: row.quote.currencyVerified === true, tradingDate: row.quote.tradingDate, label: row.quote.label || row.quote.provider },
    };
  }
  return null;
}

// Input for engine.assessValuation.
export function valuationRow(row, { now, fxAvailable }) {
  const eff = effectivePrice(row);
  const source = eff ? { ...eff.source } : {};
  if (eff && source.kind === "provider") {
    const tz = row.identity?.timeZone || "America/New_York";
    source.freshness = freshnessOf(source.tradingDate, now, tz).freshness;
  }
  let problem = null;
  if (!eff) {
    if (!row.ticker) problem = "ticker missing";
    else if (row.status === "pricing") problem = "price is being fetched";
    else if (row.error) problem = row.error.message || row.error.kind;
    else if (row.identity && row.identity.status !== "resolved") problem = row.identity.reason || row.identity.status;
    else problem = "no price yet";
  }
  return {
    rowId: row.id, ticker: row.ticker, shares: row.shares, targetWeight: row.targetWeight,
    price: eff ? eff.price : null, currency: eff ? eff.currency : null,
    fxAvailable: eff ? fxAvailable(eff.currency) : false, source, problem,
  };
}
