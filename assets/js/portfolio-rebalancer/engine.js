// Portfolio Rebalancer calculation engine (no DOM, no network).
//
// Two modes and three invariants, kept identical to the desktop program's
// scripts/portfolio_rebalancer/core.py:
//   New Money  - buy-only; buys are scaled down to fit the new-money budget.
//   Rebalance  - sells fund buys; buys are scaled down to fit sell proceeds.
//   Cross-account funding - warns when buys in one account type are not covered
//   by sells in the same account type, or a ticker trades in several accounts.
// Trades within 0.01% of the pool are treated as Hold.

export const HOLD_THRESHOLD_PCT = 0.0001;
export const MAX_ROWS = 50;

export const ACCOUNT_TYPES = ["", "TFSA", "RRSP", "RESP", "RRIF", "FHSA", "LIRA", "Margin", "Non-Registered", "Individual", "Crypto", "Other"];

// fxToUsd values are offline fallbacks used only when live FX is off or unavailable.
export const CURRENCY_OPTIONS = {
  USD: { code: "USD", locale: "en-US", label: "USD", fxToUsd: 1.00 },
  CAD: { code: "CAD", locale: "en-CA", label: "CAD", fxToUsd: 0.74 },
  JPN: { code: "JPY", locale: "ja-JP", label: "JPN", fxToUsd: 0.0067 },
  EUR: { code: "EUR", locale: "de-DE", label: "EUR", fxToUsd: 1.09 },
  GBP: { code: "GBP", locale: "en-GB", label: "GBP", fxToUsd: 1.28 },
  CHY_CNH: { code: "CNY", locale: "en-US", label: "CHY/CNH", fxToUsd: 0.14 },
};
export const CURRENCY_CODE_TO_KEY = { USD: "USD", CAD: "CAD", JPY: "JPN", EUR: "EUR", GBP: "GBP", CNY: "CHY_CNH", CNH: "CHY_CNH" };

const EXCHANGE_SUFFIX_HINTS = {
  USD: [""], CAD: [".TO", ".V", ""], JPN: [".T", ""],
  EUR: [".DE", ".AS", ".PA", ".MI", ".BR", ""], GBP: [".L", ""],
  CHY_CNH: [".SS", ".SZ", ".HK", ""],
};
const SUFFIX_TO_CURRENCY_KEY = {
  ".TO": "CAD", ".V": "CAD", ".T": "JPN", ".DE": "EUR", ".AS": "EUR",
  ".PA": "EUR", ".MI": "EUR", ".BR": "EUR", ".L": "GBP",
  ".SS": "CHY_CNH", ".SZ": "CHY_CNH", ".HK": "CHY_CNH",
};
const PREFIX_TO_SUFFIX = { "TSE:": ".TO", "TSX:": ".TO", "LSE:": ".L", "JPX:": ".T" };
const CROSS_MARKET_SUFFIXES = [".TO", ".V", ".L", ".T", ".DE", ".AS", ".PA", ".MI", ".BR", ".SS", ".SZ", ".HK", ""];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const pushUnique = (items, value) => { if (!items.includes(value)) items.push(value); };

export const currencyMeta = key => CURRENCY_OPTIONS[key] || CURRENCY_OPTIONS.USD;
export const fallbackFxToUsd = key => Number(currencyMeta(key).fxToUsd);

// Yahoo symbols to try for a ticker typed in a row of the given currency.
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
        return `'${prefix}' prefix not supported by Yahoo Finance. Try '${suggestion}' (${CURRENCY_OPTIONS[mappedKey].code}) or switch row currency.`;
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
    if (expectedKey === "CHY_CNH") return "For CNY live quotes, use .SS/.SZ/.HK only for securities listed on Shanghai/Shenzhen/HK exchanges. Verify the exact symbol at finance.yahoo.com.";
    return `For ${expectedCode} live quotes, try '${candidate}'. Verify the exact symbol at finance.yahoo.com.`;
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

// Yahoo quote currency -> { quoteCurrency, unitScale }. Pence (GBp/GBX) are 1/100 GBP.
export function normalizeQuoteCurrency(rawCurrency) {
  if (typeof rawCurrency !== "string" || !rawCurrency.trim()) return { quoteCurrency: null, unitScale: 1 };
  const cleaned = rawCurrency.trim();
  if (cleaned === "GBp" || cleaned === "GBX") return { quoteCurrency: "GBP", unitScale: 0.01 };
  const upper = cleaned.toUpperCase();
  return { quoteCurrency: upper === "CNH" ? "CNY" : upper, unitScale: 1 };
}

// Validates raw row values. `requirePrice` is false when live prices may fill gaps.
export function validatePositions(rows, { requirePrice }) {
  if (!rows.length) throw new Error("Add at least one security row.");
  const positions = rows.map((row, idx) => {
    const n = idx + 1;
    const ticker = String(row.ticker || "").trim().toUpperCase();
    const shares = Number(row.shares);
    const price = row.price === "" || row.price === null || row.price === undefined ? null : Number(row.price);
    const targetWeight = Number(row.targetWeight);
    if (!ticker) throw new Error(`Row ${n}: ticker is required.`);
    if (!/^[A-Z0-9^][A-Z0-9.:=^-]{0,19}$/.test(ticker)) throw new Error(`Row ${n}: "${ticker.slice(0, 20)}" is not a valid ticker symbol.`);
    if (!Number.isFinite(shares) || shares < 0) throw new Error(`Row ${n}: shares/units must be a non-negative number.`);
    if (price !== null && !Number.isFinite(price)) throw new Error(`Row ${n}: price must be a number.`);
    if (requirePrice && (price === null || price <= 0)) throw new Error(`Row ${n}: price must be greater than 0.`);
    if (!requirePrice && price !== null && price <= 0) throw new Error(`Row ${n}: manual price must be greater than 0 when provided.`);
    if (!Number.isFinite(targetWeight) || targetWeight < 0) throw new Error(`Row ${n}: target weight must be 0 or greater.`);
    if (!has(CURRENCY_OPTIONS, row.currencyKey)) throw new Error(`Row ${n}: row currency is invalid.`);
    return {
      rowIndex: idx, ticker, shares, price, currencyKey: row.currencyKey,
      currencyLabel: currencyMeta(row.currencyKey).label, targetWeight, accountType: row.accountType || "",
    };
  });
  if (!positions.some(p => p.targetWeight > 0)) throw new Error("At least one target weight must be greater than 0.");
  return positions;
}

export const fxToReporting = (currencyKey, reportingKey, fxToUsdMap) =>
  (has(fxToUsdMap, currencyKey) ? Number(fxToUsdMap[currencyKey]) : fallbackFxToUsd(currencyKey)) /
  (has(fxToUsdMap, reportingKey) ? Number(fxToUsdMap[reportingKey]) : fallbackFxToUsd(reportingKey));

export function attachFxValues(positions, fxToUsdMap, reportingKey) {
  return positions.map(p => {
    if (p.price === null || !(p.price > 0)) throw new Error(`${p.ticker}: price must be greater than 0.`);
    const fx = fxToReporting(p.currencyKey, reportingKey, fxToUsdMap);
    const currentValueLocal = p.shares * p.price;
    return {
      rowIndex: p.rowIndex, ticker: p.ticker, shares: p.shares, price: p.price,
      currencyKey: p.currencyKey, currencyLabel: currencyMeta(p.currencyKey).label,
      targetWeight: p.targetWeight, accountType: p.accountType || "",
      fxToReporting: fx, currentValueLocal, currentValue: currentValueLocal * fx,
    };
  });
}

function scaleBuys(results, scale) {
  results.forEach(r => {
    if (r.action !== "Buy") return;
    r.tradeValue *= scale;
    r.tradeValueLocal = r.fxToReporting ? r.tradeValue / r.fxToReporting : 0;
    r.tradeShares = r.price ? r.tradeValueLocal / r.price : 0;
    r.postTradeShares = r.shares + r.tradeShares;
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
      ticker: p.ticker, currencyKey: p.currencyKey, currencyLabel: p.currencyLabel, shares: p.shares, price: p.price,
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
  // Invariant 2: rebalance is self-funding.
  if (mode === "rebalance" && totalBuys > totalSells + 0.01 && totalBuys > 0) {
    const scale = totalSells / totalBuys;
    scaleBuys(results, scale);
    const scaled = results.reduce((s, r) => s + (r.action === "Buy" ? r.tradeValue : 0), 0);
    warnings.push(`Buy recommendations scaled down by ${((1 - scale) * 100).toFixed(1)}% to stay within sell proceeds of ${money(totalSells)} (raw need was ${money(totalBuys)}; scaled to ${money(scaled)}).`);
    totalBuys = scaled;
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
      if (accounts.size > 1) warnings.push(`${ticker} appears in multiple account types (${[...accounts].sort().join(", ")}) — sells from one account can’t fund buys in another.`);
    });
  }

  return {
    summary: { totalCurrent, pool, totalBuys, totalSells, mode, budget: mode === "new_money" ? budget : 0 },
    results,
    warnings,
  };
}
