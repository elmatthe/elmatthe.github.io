// Portfolio Rebalancer calculation engine (no DOM, no network).
//
// Two modes and three invariants, kept identical to the desktop program's
// scripts/portfolio_rebalancer/core.py (checked by _tools/tests/test_engine_parity.py):
//   New Money  - buy-only; buys are scaled down to fit the new-money budget.
//   Rebalance  - sells fund buys; buys are scaled down to fit sell proceeds.
//   Cross-account funding - warns when buys in one account type are not covered
//   by sells in the same account type, or a ticker trades in several accounts.
// Trades within 0.01% of the pool are treated as Hold.
//
// Valuation readiness (assessValuation) decides whether a plan may be shown at all:
// every holding that matters (shares > 0 or target > 0) needs a verified price in a
// confirmed currency, or a price the user explicitly supplied. Holdings with 0 shares
// and a 0% target are "not valued" and never block the plan.

export const HOLD_THRESHOLD_PCT = 0.0001;
export const MAX_ROWS = 50;
export const READINESS_SCHEMA = "md.valuation-readiness.v1";

export const ACCOUNT_TYPES = ["", "TFSA", "RRSP", "RESP", "RRIF", "FHSA", "LIRA", "Margin", "Non-Registered", "Individual", "Crypto", "Other"];

// fxToUsd (US dollars per one unit) are BUILT-IN ESTIMATES kept only for the
// engine's legacy API (and its parity tests). The web app never plans with them:
// it requires official rates or rates the user typed. They are the Bank of Canada
// daily average rates for DEFAULT_FX_AS_OF converted to USD per unit.
export const DEFAULT_FX_AS_OF = "2026-10-30";
export const DEFAULT_FX_SOURCE = `Bank of Canada daily average rates for ${DEFAULT_FX_AS_OF} (built-in estimate)`;
// Keys are ISO 4217 codes. "JPN" and "CHY_CNH" are the keys used before 2026-11 and
// remain accepted as aliases of JPY and CNY; their labels are now the ISO codes.
export const CURRENCY_OPTIONS = {
  USD: { code: "USD", locale: "en-US", label: "USD", fxToUsd: 1.00 },
  CAD: { code: "CAD", locale: "en-CA", label: "CAD", fxToUsd: 0.716332 },
  EUR: { code: "EUR", locale: "de-DE", label: "EUR", fxToUsd: 1.116189 },
  GBP: { code: "GBP", locale: "en-GB", label: "GBP", fxToUsd: 1.33947 },
  JPY: { code: "JPY", locale: "ja-JP", label: "JPY", fxToUsd: 0.006354 },
  CNY: { code: "CNY", locale: "zh-CN", label: "CNY", fxToUsd: 0.150287 },
  JPN: { code: "JPY", locale: "ja-JP", label: "JPY", fxToUsd: 0.006354, alias: "JPY" },
  CHY_CNH: { code: "CNY", locale: "zh-CN", label: "CNY", fxToUsd: 0.150287, alias: "CNY" },
};
// Display locale for currencies without a built-in estimate (rates must be loaded).
const EXTRA_LOCALES = { HKD: "zh-HK", CHF: "de-CH", AUD: "en-AU", INR: "en-IN", SEK: "sv-SE", NOK: "nb-NO", NZD: "en-NZ", SGD: "en-SG", MXN: "es-MX", ZAR: "en-ZA", KRW: "ko-KR", BRL: "pt-BR", TWD: "zh-TW", PLN: "pl-PL", TRY: "tr-TR", SAR: "ar-SA", THB: "th-TH", IDR: "id-ID", MYR: "ms-MY", PEN: "es-PE" };
// Legacy key or ISO code (any case, CNH and RMB included) -> ISO code.
export function isoCurrency(key) {
  const k = String(key || "").trim();
  if (k === "JPN") return "JPY";
  if (["CHY_CNH", "CHY/CNH", "CHY", "CNH", "RMB"].includes(k.toUpperCase())) return "CNY";
  return /^[A-Za-z]{3}$/.test(k) ? k.toUpperCase() : null;
}
export const CURRENCY_CODE_TO_KEY = { USD: "USD", CAD: "CAD", JPY: "JPY", EUR: "EUR", GBP: "GBP", CNY: "CNY", CNH: "CNY" };

const EXCHANGE_SUFFIX_HINTS = {
  USD: [""], CAD: [".TO", ".V", ".NE", ""], JPY: [".T", ""], JPN: [".T", ""],
  EUR: [".DE", ".AS", ".PA", ".MI", ".BR", ""], GBP: [".L", ""],
  CNY: [".SS", ".SZ", ""], CHY_CNH: [".SS", ".SZ", ""], HKD: [".HK", ""],
};
const SUFFIX_TO_CURRENCY_KEY = {
  ".TO": "CAD", ".V": "CAD", ".NE": "CAD", ".T": "JPY", ".DE": "EUR", ".AS": "EUR",
  ".PA": "EUR", ".MI": "EUR", ".BR": "EUR", ".L": "GBP",
  ".SS": "CNY", ".SZ": "CNY", ".HK": "HKD",
};
const PREFIX_TO_SUFFIX = { "TSE:": ".TO", "TSX:": ".TO", "LSE:": ".L", "JPX:": ".T" };
const CROSS_MARKET_SUFFIXES = [".TO", ".V", ".NE", ".L", ".T", ".DE", ".AS", ".PA", ".MI", ".BR", ".SS", ".SZ", ".HK", ""];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const pushUnique = (items, value) => { if (!items.includes(value)) items.push(value); };

export function currencyMeta(key) {
  if (CURRENCY_OPTIONS[key]) return CURRENCY_OPTIONS[key];
  const code = isoCurrency(key);
  if (code && CURRENCY_OPTIONS[code]) return CURRENCY_OPTIONS[code];
  if (code) return { code, locale: EXTRA_LOCALES[code] || "en-US", label: code, fxToUsd: NaN };
  return CURRENCY_OPTIONS.USD;
}
export const fallbackFxToUsd = key => Number(currencyMeta(key).fxToUsd);

// Exchange-suffixed symbols to try for a ticker typed in a row of the given currency
// (Yahoo-style suffixes such as .TO; the data layer maps them to its provider).
export function buildTickerCandidates(ticker, currencyKey) {
  const clean = String(ticker || "").trim().toUpperCase();
  if (!clean) return [];
  for (const [prefix, preferredSuffix] of Object.entries(PREFIX_TO_SUFFIX)) {
    if (clean.startsWith(prefix)) {
      const stripped = clean.slice(prefix.length).trim();
      if (!stripped) return [];
      const inferredKey = SUFFIX_TO_CURRENCY_KEY[preferredSuffix] || currencyKey;
      const ordered = [preferredSuffix, ...(EXCHANGE_SUFFIX_HINTS[inferredKey] || [""]).filter(s => s !== preferredSuffix)];
      const out = [];
      ordered.forEach(suffix => pushUnique(out, suffix ? stripped + suffix : stripped));
      return out;
    }
  }
  if (clean.includes("=")) return [clean];
  if (clean.includes(".")) {
    const dot = clean.lastIndexOf(".");
    const stem = clean.slice(0, dot);
    const suffix = clean.slice(dot);
    if (stem && has(SUFFIX_TO_CURRENCY_KEY, suffix)) {
      const out = [clean];
      const inferredKey = SUFFIX_TO_CURRENCY_KEY[suffix] || currencyKey;
      [currencyKey, inferredKey].forEach(key => (EXCHANGE_SUFFIX_HINTS[key] || [""]).forEach(alt => pushUnique(out, alt ? stem + alt : stem)));
      return out;
    }
    return [clean];
  }
  const out = [];
  (EXCHANGE_SUFFIX_HINTS[currencyKey] || [""]).forEach(suffix => pushUnique(out, suffix ? clean + suffix : clean));
  return out;
}

export function buildTickerInputHint(tickerSymbol, currencyKey) {
  const cleaned = String(tickerSymbol || "").trim().toUpperCase();
  if (!cleaned) return "";
  const expectedKey = has(CURRENCY_OPTIONS, currencyKey) ? currencyKey : "USD";
  const expectedCode = CURRENCY_OPTIONS[expectedKey].code;
  for (const [prefix, suffix] of Object.entries(PREFIX_TO_SUFFIX)) {
    if (cleaned.startsWith(prefix)) {
      const base = cleaned.slice(prefix.length).trim();
      if (!base) return "";
      const suggestion = base + suffix;
      const mappedKey = SUFFIX_TO_CURRENCY_KEY[suffix] || expectedKey;
      if (mappedKey !== expectedKey) {
        return `'${prefix}' prefixes are not used here. Try '${suggestion}' (${CURRENCY_OPTIONS[mappedKey].code}) or switch row currency.`;
      }
      return `'${prefix}' prefix not supported. Try '${suggestion}'.`;
    }
  }
  if (cleaned.includes(".")) {
    const dotSuffix = `.${cleaned.split(".").pop()}`;
    const mapped = SUFFIX_TO_CURRENCY_KEY[dotSuffix];
    if (mapped && mapped !== expectedKey) return `'${dotSuffix}' implies ${CURRENCY_OPTIONS[mapped].code} but row is ${expectedCode} - check row currency.`;
    return "";
  }
  const candidate = buildTickerCandidates(cleaned, expectedKey).find(c => c !== cleaned);
  if (candidate) {
    if (isoCurrency(expectedKey) === "CNY") return "For CNY listings, use .SS or .SZ only for securities listed in Shanghai or Shenzhen. Check the exact symbol with your broker.";
    return `For a ${expectedCode} listing, try '${candidate}'. Check the exact symbol with your broker.`;
  }
  return "";
}

export function extractBareTicker(tickerSymbol) {
  let base = String(tickerSymbol || "").trim().toUpperCase();
  if (!base) return "";
  const prefix = Object.keys(PREFIX_TO_SUFFIX).find(p => base.startsWith(p));
  if (prefix) base = base.slice(prefix.length).trim();
  if (base.includes(".")) {
    const stem = base.slice(0, base.lastIndexOf("."));
    if (stem) return stem;
  }
  return base;
}

export function buildCrossMarketCandidates(tickerSymbol, attempted = []) {
  const bare = extractBareTicker(tickerSymbol);
  if (!bare) return [];
  const tried = new Set(attempted.map(c => String(c).trim().toUpperCase()));
  const out = [];
  CROSS_MARKET_SUFFIXES.forEach(suffix => {
    const candidate = suffix ? bare + suffix : bare;
    if (!tried.has(candidate)) pushUnique(out, candidate);
  });
  return out;
}

// Number parsing shared with the desktop app (core.parse_number): blank, whitespace,
// "nan", "inf", 1e999 and anything that is not a plain decimal number are rejected
// rather than read as 0. Returns a finite number or null.
export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim();
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Validates raw row values. `requirePrice` is false when live prices may fill gaps.
// Shares and target weight are required (a blank target is an error, never 0%).
export function validatePositions(rows, { requirePrice }) {
  if (!rows.length) throw new Error("Add at least one security row.");
  const positions = rows.map((row, idx) => {
    const n = idx + 1;
    const ticker = String(row.ticker || "").trim().toUpperCase();
    const shares = parseNumber(row.shares);
    const blankPrice = row.price === "" || row.price === null || row.price === undefined;
    const price = blankPrice ? null : parseNumber(row.price);
    const targetWeight = parseNumber(row.targetWeight);
    if (!ticker) throw new Error(`Row ${n}: ticker is required.`);
    if (!/^[A-Z0-9^][A-Z0-9.:=^-]{0,19}$/.test(ticker)) throw new Error(`Row ${n}: "${ticker.slice(0, 20)}" is not a valid ticker symbol.`);
    if (shares === null || shares < 0) throw new Error(`Row ${n}: shares/units must be a number of 0 or more.`);
    if (!blankPrice && price === null) throw new Error(`Row ${n}: price must be a number.`);
    if (requirePrice && (price === null || price <= 0)) throw new Error(`Row ${n}: price must be greater than 0.`);
    if (!requirePrice && price !== null && price <= 0) throw new Error(`Row ${n}: manual price must be greater than 0 when provided.`);
    if (targetWeight === null || targetWeight < 0) throw new Error(`Row ${n}: target weight must be a number of 0 or more.`);
    if (!isoCurrency(row.currencyKey) || (!has(CURRENCY_OPTIONS, row.currencyKey) && !/^[A-Z]{3}$/.test(row.currencyKey))) throw new Error(`Row ${n}: row currency is invalid.`);
    return {
      rowIndex: idx, ticker, shares, price, currencyKey: row.currencyKey,
      currencyLabel: currencyMeta(row.currencyKey).label, targetWeight, accountType: row.accountType || "",
    };
  });
  if (!positions.some(p => p.targetWeight > 0)) throw new Error("At least one target weight must be greater than 0.");
  return positions;
}

// Non-fatal input checks: the same ticker listed twice in the same account usually
// means a duplicated row (each row is still valued and traded separately).
export function duplicateWarnings(positions) {
  const seen = new Map();
  const warnings = [];
  positions.forEach(p => {
    const key = `${p.ticker}|${p.accountType || ""}`;
    if (seen.has(key)) warnings.push(`${p.ticker}${p.accountType ? ` (${p.accountType})` : ""} is listed in rows ${seen.get(key) + 1} and ${p.rowIndex + 1}; each row is treated as a separate holding.`);
    else seen.set(key, p.rowIndex);
  });
  return warnings;
}

// Target weights are normalized (10/10/20 means 25/25/50). Says so when they do not
// add up to 100, so a typo is not silently rescaled (same text as core.weight_warnings).
export function weightWarnings(positions) {
  const total = positions.reduce((sum, p) => sum + p.targetWeight, 0);
  if (!(total > 0) || Math.abs(total - 100) < 0.005) return [];
  return [`Target weights add up to ${total.toFixed(2)}%, not 100%; each target is divided by ${(total / 100).toFixed(4)} so that they add up to 100%.`];
}

export const fxToReporting = (currencyKey, reportingKey, fxToUsdMap) =>
  (has(fxToUsdMap, currencyKey) ? Number(fxToUsdMap[currencyKey]) : fallbackFxToUsd(currencyKey)) /
  (has(fxToUsdMap, reportingKey) ? Number(fxToUsdMap[reportingKey]) : fallbackFxToUsd(reportingKey));

export function attachFxValues(positions, fxToUsdMap, reportingKey) {
  return positions.map(p => {
    if (p.price === null || !(p.price > 0)) throw new Error(`${p.ticker}: price must be greater than 0.`);
    const fx = fxToReporting(p.currencyKey, reportingKey, fxToUsdMap);
    if (!(fx > 0) || !Number.isFinite(fx)) throw new Error(`${p.ticker}: no exchange rate from ${currencyMeta(p.currencyKey).code} to ${currencyMeta(reportingKey).code}.`);
    const currentValueLocal = p.shares * p.price;
    return {
      rowIndex: p.rowIndex, ticker: p.ticker, shares: p.shares, price: p.price,
      currencyKey: p.currencyKey, currencyLabel: currencyMeta(p.currencyKey).label,
      targetWeight: p.targetWeight, accountType: p.accountType || "",
      fxToReporting: fx, currentValueLocal, currentValue: currentValueLocal * fx,
    };
  });
}

// Scales every Buy by `scale` (0 < scale < 1). Local values use the row's stored rate,
// never a value divided by the scale (the desktop crashed on scale 0: RB-01).
function scaleBuys(results, scale) {
  results.forEach(r => {
    if (r.action !== "Buy") return;
    r.tradeValue *= scale;
    r.tradeValueLocal = r.fxToReporting ? r.tradeValue / r.fxToReporting : 0;
    r.tradeShares = r.price ? r.tradeValueLocal / r.price : 0;
    r.postTradeShares = r.shares + r.tradeShares;
  });
}

// Turns every Buy into a Hold with no trade (nothing can fund it).
function holdBuys(results) {
  results.forEach(r => {
    if (r.action !== "Buy") return;
    Object.assign(r, { action: "Hold", tradeValue: 0, tradeValueLocal: 0, tradeShares: 0, postTradeShares: r.shares });
  });
}

// Returns { summary, results, warnings }. `money` formats reporting-currency amounts.
export function calculateRebalancePlan(enriched, mode, budget, { money = v => `$${v.toFixed(2)}` } = {}) {
  const totalCurrent = enriched.reduce((sum, p) => sum + p.currentValue, 0);
  const totalWeight = enriched.reduce((sum, p) => sum + p.targetWeight, 0);
  let pool;
  if (mode === "new_money") {
    if (!(budget > 0)) throw new Error("New money budget must be greater than 0.");
    pool = totalCurrent + budget;
  } else {
    pool = totalCurrent;
  }
  if (!(pool > 0)) throw new Error("Portfolio value must be greater than 0.");
  if (!(totalWeight > 0)) throw new Error("At least one target weight must be greater than 0.");
  const threshold = pool * HOLD_THRESHOLD_PCT;
  const warnings = [];

  const results = enriched.map(p => {
    const targetWeightNorm = p.targetWeight / totalWeight;
    const targetValue = targetWeightNorm * pool;
    let tradeValue = targetValue - p.currentValue;
    const base = {
      rowIndex: p.rowIndex, ticker: p.ticker, currencyKey: p.currencyKey, currencyLabel: p.currencyLabel, shares: p.shares, price: p.price,
      currentValue: p.currentValue, targetWeightNorm, targetValue, accountType: p.accountType, fxToReporting: p.fxToReporting,
    };
    if (mode === "new_money" && tradeValue <= 0) {
      return { ...base, tradeValue: 0, tradeValueLocal: 0, tradeShares: 0, action: "Hold", postTradeShares: p.shares };
    }
    let action = "Hold";
    if (tradeValue > threshold) action = "Buy";
    else if (tradeValue < -threshold) action = "Sell";
    if (Math.abs(tradeValue) <= threshold) tradeValue = 0;
    const tradeValueLocal = tradeValue !== 0 ? tradeValue / p.fxToReporting : 0;
    const tradeShares = tradeValue !== 0 ? tradeValueLocal / p.price : 0;
    return { ...base, tradeValue, tradeValueLocal, tradeShares, action, postTradeShares: p.shares + tradeShares };
  });

  let totalBuys = results.reduce((s, r) => s + (r.action === "Buy" ? r.tradeValue : 0), 0);
  const totalSells = results.reduce((s, r) => s + (r.action === "Sell" ? Math.abs(r.tradeValue) : 0), 0);

  // Invariant 1: new-money budget cap.
  if (mode === "new_money" && totalBuys > budget + 0.01 && totalBuys > 0) {
    const scale = budget / totalBuys;
    scaleBuys(results, scale);
    const scaled = results.reduce((s, r) => s + (r.action === "Buy" ? r.tradeValue : 0), 0);
    warnings.push(`Buy recommendations scaled down by ${((1 - scale) * 100).toFixed(1)}% to stay within the new-money budget of ${money(budget)} (raw need was ${money(totalBuys)}; scaled to ${money(scaled)}).`);
    totalBuys = scaled;
  }
  // Invariant 2: rebalance is self-funding. With no sell proceeds at all (every
  // overweight holding is inside the hold band) nothing can be bought (RB-01).
  if (mode === "rebalance" && totalBuys > totalSells + 0.01 && totalBuys > 0) {
    if (totalSells > 0) {
      const scale = totalSells / totalBuys;
      scaleBuys(results, scale);
      const scaled = results.reduce((s, r) => s + (r.action === "Buy" ? r.tradeValue : 0), 0);
      warnings.push(`Buy recommendations scaled down by ${((1 - scale) * 100).toFixed(1)}% to stay within sell proceeds of ${money(totalSells)} (raw need was ${money(totalBuys)}; scaled to ${money(scaled)}).`);
      totalBuys = scaled;
    } else {
      holdBuys(results);
      warnings.push(`No sells are needed (every overweight holding is within the 0.01% hold band), so the ${money(totalBuys)} of buys cannot be funded in Rebalance mode and are shown as Hold. Use New Money mode to invest new cash.`);
      totalBuys = 0;
    }
  }
  // Invariant 3: cross-account funding.
  if (results.some(r => r.accountType)) {
    if (mode === "rebalance") {
      const sells = {};
      const buys = {};
      results.forEach(r => {
        const at = r.accountType || "Unspecified";
        if (r.action === "Sell") sells[at] = (sells[at] || 0) + Math.abs(r.tradeValue);
        if (r.action === "Buy") buys[at] = (buys[at] || 0) + r.tradeValue;
      });
      Object.entries(buys).forEach(([at, buyAmt]) => {
        const sellAmt = sells[at] || 0;
        if (buyAmt > sellAmt + 0.01) {
          warnings.push(`${at}: recommended buys total ${money(buyAmt)} but same-account sells only total ${money(sellAmt)}. The gap of ${money(buyAmt - sellAmt)} must come from existing cash or new contributions — proceeds from other account types cannot be transferred without triggering a withdrawal/contribution event.`);
        }
      });
    }
    const tickerAccounts = {};
    results.forEach(r => {
      if (r.action !== "Hold" && r.accountType) (tickerAccounts[r.ticker] ||= new Set()).add(r.accountType);
    });
    Object.entries(tickerAccounts).forEach(([ticker, accounts]) => {
      if (accounts.size > 1) {
        warnings.push(mode === "rebalance"
          ? `${ticker} appears in multiple account types (${[...accounts].sort().join(", ")}) — sells from one account can’t fund buys in another.`
          : `${ticker} is bought in multiple account types (${[...accounts].sort().join(", ")}) — make sure each account has the cash for its part.`);
      }
    });
  }

  // Cash the plan leaves unspent: the unused budget (New Money) or sell proceeds not
  // reinvested, for example when the only remaining buy is inside the hold band.
  const cashLeft = mode === "new_money" ? Math.max(0, budget - totalBuys) : Math.max(0, totalSells - totalBuys);
  return {
    summary: { totalCurrent, pool, totalBuys, totalSells, mode, budget: mode === "new_money" ? budget : 0, cashLeft },
    results,
    warnings,
  };
}

// Whole-share alternative to a fractional plan (identical in core.apply_whole_shares):
//   1. Sells and buys are rounded DOWN to whole shares (never sell or buy more than
//      the fractional plan says).
//   2. If rounding makes buys cost more than the cash available (the budget in New
//      Money, whole-share sell proceeds in Rebalance), one share at a time is removed
//      from the largest buy until they fit.
//   3. Leftover cash then buys one more share at a time of the holding that is
//      furthest below its target, among the plan's Buy rows, while a share fits.
// Returns new result rows (whole* fields added) and { totalBuys, totalSells, cashLeft }.
export function applyWholeShares(plan, { maxSteps = 100000 } = {}) {
  const { mode, budget } = plan.summary;
  const EPS = 1e-9;
  const rows = plan.results.map(r => {
    const unitReporting = r.price * r.fxToReporting;
    let whole = 0;
    if (r.action === "Buy") whole = Math.floor(r.tradeShares + EPS);
    if (r.action === "Sell") whole = -Math.min(Math.floor(-r.tradeShares + EPS), Math.floor(r.shares + EPS));
    return { ...r, unitReporting, wholeShares: whole };
  });
  const sum = side => rows.reduce((s, r) => s + (side === "buy" ? (r.wholeShares > 0 ? r.wholeShares * r.unitReporting : 0) : (r.wholeShares < 0 ? -r.wholeShares * r.unitReporting : 0)), 0);
  const available = () => (mode === "new_money" ? budget : sum("sell"));
  let steps = 0;
  while (sum("buy") > available() + EPS && steps < maxSteps) {
    const largest = rows.filter(r => r.wholeShares > 0).sort((a, b) => b.wholeShares * b.unitReporting - a.wholeShares * a.unitReporting || a.rowIndex - b.rowIndex)[0];
    if (!largest) break;
    largest.wholeShares -= 1;
    steps += 1;
  }
  for (;;) {
    if (steps >= maxSteps) break;
    const left = available() - sum("buy");
    const candidates = rows
      .filter(r => r.action === "Buy" && r.unitReporting <= left + EPS)
      .map(r => ({ r, shortfall: r.targetValue - (r.currentValue + r.wholeShares * r.unitReporting) }))
      .filter(c => c.shortfall > EPS);
    if (!candidates.length) break;
    candidates.sort((a, b) => b.shortfall - a.shortfall || a.r.rowIndex - b.r.rowIndex);
    candidates[0].r.wholeShares += 1;
    steps += 1;
  }
  const results = rows.map(({ unitReporting, ...r }) => ({
    ...r,
    wholeAction: r.wholeShares > 0 ? "Buy" : r.wholeShares < 0 ? "Sell" : "Hold",
    wholeTradeValueLocal: r.wholeShares * r.price,
    wholeTradeValue: r.wholeShares * unitReporting,
    wholePostTradeShares: r.shares + r.wholeShares,
  }));
  const totalBuys = sum("buy");
  const totalSells = sum("sell");
  return { results, totalBuys, totalSells, cashLeft: Math.max(0, available() - totalBuys) };
}

// ---------------------------------------------------------------- valuation readiness
// Each row: { rowId, ticker, shares, targetWeight, price, currency, fxAvailable,
//   source: { kind: "provider" | "manual" | "csv" | null, currencyVerified, freshness:
//   "current" | "stale" | "too_old" | "unknown", tradingDate, provider }, status, problem }
// Options: { acceptStale } (the user acknowledged stale prices for this plan).
// Returns md.valuation-readiness.v1: the plan may be shown only when `ready`.
export function assessValuation(rows, { acceptStale = false } = {}) {
  const out = { schema: READINESS_SCHEMA, ready: false, required: 0, priced: [], unpriced: [], stale: [], manualOverrides: [], notValued: [], fxMissing: [], blockedReason: null };
  for (const row of rows) {
    const shares = parseNumber(row.shares);
    const target = parseNumber(row.targetWeight);
    const ref = { rowId: row.rowId, ticker: row.ticker };
    if (shares === 0 && target === 0) { out.notValued.push({ ...ref, reason: "0 shares and a 0% target: not part of the plan" }); continue; }
    out.required += 1;
    const src = row.source || {};
    const price = parseNumber(row.price);
    let reason = null;
    if (shares === null || target === null) reason = "shares and target must be numbers";
    else if (!(price > 0)) reason = row.problem || "no price yet";
    else if (!row.currency) reason = "quote currency unknown";
    else if (src.kind === "provider" && !src.currencyVerified) reason = "the provider did not confirm the quote currency";
    else if (!["provider", "manual", "csv"].includes(src.kind)) reason = "price source unknown";
    else if (src.freshness === "too_old") reason = `price is too old (${src.tradingDate || "date unknown"})`;
    else if (!row.fxAvailable) { out.fxMissing.push({ ...ref, currency: row.currency }); reason = `no exchange rate for ${row.currency}`; }
    if (reason) { out.unpriced.push({ ...ref, reason }); continue; }
    if (src.kind === "manual" || src.kind === "csv") out.manualOverrides.push({ ...ref, kind: src.kind });
    if (src.freshness === "stale" || src.freshness === "unknown") out.stale.push({ ...ref, tradingDate: src.tradingDate || null, freshness: src.freshness });
    out.priced.push(ref);
  }
  if (!out.required) out.blockedReason = "Add at least one holding with shares or a target weight.";
  else if (out.unpriced.length) out.blockedReason = `${out.unpriced.length} of ${out.required} holding${out.required === 1 ? "" : "s"} ${out.unpriced.length === 1 ? "has" : "have"} no usable price.`;
  else if (out.stale.length && !acceptStale) out.blockedReason = `${out.stale.length} price${out.stale.length === 1 ? " is" : "s are"} older than the latest trading session. Review and accept them, or refresh.`;
  out.ready = !out.blockedReason;
  return out;
}
