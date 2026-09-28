// Ticker input sanitization shared by the site's browser tools.
//
// Symbols are trimmed, upper-cased and bounded before any request is built. The
// pattern accepts Yahoo Finance equities/ETFs (AAPL, BRK-B), exchange suffixes
// (XIU.TO, ISF.L, 7203.T), indexes (^GSPC), FX (CADUSD=X) and futures (CL=F), and
// rejects free-form text, whitespace, path characters and query strings.

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
