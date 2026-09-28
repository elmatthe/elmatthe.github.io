// Ticker input sanitization for the browser dashboard.
//
// Adapted from the TipRanks Automation Tool's `normalize_symbol` contract
// (scripts/providers/base.py). The desktop tool deliberately limits itself to
// US/Canadian equities; the website also accepts Yahoo index (^GSPC), FX (CADUSD=X),
// futures (CL=F) and international suffixes (ISF.L), so the pattern is wider but
// keeps the same rules: trimmed, upper-cased, bounded length, no free-form text.

export const MAX_TICKERS = 10;
export const MIN_COMPARE_TICKERS = 2;

const SYMBOL_PATTERN = /^\^?[A-Z0-9](?:[A-Z0-9-]|\.(?=[A-Z0-9])){0,14}(?:=X|=F)?$/;
const MAX_SYMBOL_LENGTH = 20;

export class SymbolError extends Error {
  constructor(message, symbol) {
    super(message);
    this.name = "SymbolError";
    this.symbol = symbol;
  }
}

export function normalizeSymbol(value) {
  if (typeof value !== "string") throw new SymbolError("Ticker must be text.", String(value));
  const symbol = value.trim().toUpperCase();
  if (!symbol) throw new SymbolError("Ticker is required.", symbol);
  if (symbol.length > MAX_SYMBOL_LENGTH || !SYMBOL_PATTERN.test(symbol)) {
    throw new SymbolError(`"${symbol.slice(0, MAX_SYMBOL_LENGTH)}" is not a valid Yahoo Finance ticker.`, symbol);
  }
  return symbol;
}

// Validates a list of raw inputs. Returns { symbols, errors } instead of throwing so
// the UI can point at every bad row at once.
export function normalizeSymbolList(values, { min = 1, max = MAX_TICKERS } = {}) {
  const symbols = [];
  const errors = [];
  const seen = new Set();
  values.forEach((raw, index) => {
    if (typeof raw === "string" && !raw.trim()) return;
    try {
      const symbol = normalizeSymbol(raw);
      if (seen.has(symbol)) errors.push({ index, message: `${symbol} is listed more than once.` });
      else { seen.add(symbol); symbols.push(symbol); }
    } catch (error) {
      errors.push({ index, message: error.message });
    }
  });
  if (!errors.length && symbols.length < min) {
    errors.push({ index: -1, message: min === 1 ? "Enter a ticker." : `Enter at least ${min} tickers.` });
  }
  if (symbols.length > max) errors.push({ index: -1, message: `At most ${max} tickers are allowed.` });
  return { symbols, errors };
}

// Free-text "AAPL, MSFT SPY" splitting for single-field inputs.
export function splitSymbolText(text) {
  return String(text || "").split(/[\s,;]+/).filter(Boolean);
}
