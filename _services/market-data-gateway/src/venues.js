// Fixed listing allowlist for the market-data gateway.
//
// A symbol is accepted only if its exchange suffix is one of these, and an upstream
// answer is used only if it names an exchange code and a currency listed for that
// venue. Anything else is refused: the gateway never guesses another market, never
// substitutes a different symbol and never builds a URL from free text.
//
// `exchanges` are the exchange codes Yahoo Finance's chart data reports in
// `meta.exchangeName` for that venue, taken from public examples of the response. They
// have NOT been confirmed against live data from this gateway (no live request was
// made while building it): a wrong code only makes the gateway refuse a listing
// (fail closed). Confirm them in the owner-approved smoke test before activation
// (README.md, "Activation gate").
//
// `currencies` are the quote currencies accepted for the venue, exactly as Yahoo
// writes them ("GBp" is pence). Minor units are converted to major units with
// MINOR_UNITS and reported.
//
// The browser adapter (assets/js/market-data/keyless.js) carries the same venue list
// (MIC -> suffix); _tools/tests/unit/market-gateway.test.mjs checks the two agree.

export const VENUES = Object.freeze({
  US: { suffix: "", name: "US exchange", exchanges: ["NMS", "NGM", "NCM", "NYQ", "PCX", "ASE", "BTS", "NAS"], currencies: ["USD"], timeZone: "America/New_York" },
  XTSE: { suffix: ".TO", name: "Toronto Stock Exchange", exchanges: ["TOR"], currencies: ["CAD", "USD"], timeZone: "America/Toronto" },
  XTSX: { suffix: ".V", name: "TSX Venture Exchange", exchanges: ["VAN"], currencies: ["CAD"], timeZone: "America/Toronto" },
  NEOE: { suffix: ".NE", name: "Cboe Canada", exchanges: ["NEO"], currencies: ["CAD", "USD"], timeZone: "America/Toronto" },
  XLON: { suffix: ".L", name: "London Stock Exchange", exchanges: ["LSE"], currencies: ["GBp", "GBP", "USD", "EUR"], timeZone: "Europe/London" },
  XETR: { suffix: ".DE", name: "Xetra", exchanges: ["GER"], currencies: ["EUR"], timeZone: "Europe/Berlin" },
  XPAR: { suffix: ".PA", name: "Euronext Paris", exchanges: ["PAR"], currencies: ["EUR"], timeZone: "Europe/Paris" },
  XAMS: { suffix: ".AS", name: "Euronext Amsterdam", exchanges: ["AMS"], currencies: ["EUR"], timeZone: "Europe/Amsterdam" },
  XSWX: { suffix: ".SW", name: "SIX Swiss Exchange", exchanges: ["EBS"], currencies: ["CHF"], timeZone: "Europe/Zurich" },
  XTKS: { suffix: ".T", name: "Tokyo Stock Exchange", exchanges: ["JPX"], currencies: ["JPY"], timeZone: "Asia/Tokyo" },
  XSHG: { suffix: ".SS", name: "Shanghai Stock Exchange", exchanges: ["SHH"], currencies: ["CNY"], timeZone: "Asia/Shanghai" },
  XSHE: { suffix: ".SZ", name: "Shenzhen Stock Exchange", exchanges: ["SHZ"], currencies: ["CNY"], timeZone: "Asia/Shanghai" },
  XHKG: { suffix: ".HK", name: "Hong Kong Stock Exchange", exchanges: ["HKG"], currencies: ["HKD"], timeZone: "Asia/Hong_Kong" },
  XASX: { suffix: ".AX", name: "ASX", exchanges: ["ASX"], currencies: ["AUD"], timeZone: "Australia/Sydney" },
});

// Quote currencies that are 1/100 of a currency.
export const MINOR_UNITS = Object.freeze({ GBp: "GBP" });

// Security types the gateway serves. Indexes, currencies, futures, options and crypto
// are refused even when a symbol of that kind slips through the syntax check.
export const INSTRUMENT_TYPES = Object.freeze(["EQUITY", "ETF", "MUTUALFUND"]);

// Upper-case letters and digits, optional hyphens (BRK-B, DLR-U), then an optional
// allowlisted suffix. At most 20 characters. No "^", "=", "/", "%", spaces or dots
// other than the one before the suffix.
const STEM = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){0,13}$/;
export const MAX_SYMBOL_LENGTH = 20;

const SUFFIXES = Object.entries(VENUES)
  .filter(([, v]) => v.suffix)
  .map(([mic, v]) => ({ mic, suffix: v.suffix }))
  .sort((a, b) => b.suffix.length - a.suffix.length);

// Returns { symbol, mic, venue } or { error: "invalid_symbol" | "unsupported_listing" }.
export function parseSymbol(value) {
  const symbol = typeof value === "string" ? value : "";
  if (!symbol || symbol.length > MAX_SYMBOL_LENGTH || symbol !== symbol.trim()) return { error: "invalid_symbol" };
  if (/[\^=]/.test(symbol)) return { error: "unsupported_listing" }; // index (^GSPC), FX (CAD=X) or futures (CL=F) syntax
  if (!/^[A-Z0-9.\-]+$/.test(symbol)) return { error: "invalid_symbol" }; // includes lower case: send symbols upper-cased
  const dot = symbol.indexOf(".");
  if (dot === 0) return { error: "invalid_symbol" };
  if (dot === -1) return STEM.test(symbol) ? { symbol, mic: "US", venue: VENUES.US } : { error: "invalid_symbol" };
  if (symbol.indexOf(".", dot + 1) !== -1) return { error: "invalid_symbol" };
  const match = SUFFIXES.find(s => symbol.endsWith(s.suffix) && symbol.length > s.suffix.length);
  if (!match) return /^\.[A-Z]{1,3}$/.test(symbol.slice(dot)) ? { error: "unsupported_listing" } : { error: "invalid_symbol" };
  const stem = symbol.slice(0, -match.suffix.length);
  return STEM.test(stem) ? { symbol, mic: match.mic, venue: VENUES[match.mic] } : { error: "invalid_symbol" };
}
