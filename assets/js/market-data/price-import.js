// Price files a visitor imports into the Stock Comparison tool (read locally; never
// uploaded). Same layouts as the desktop app's offline CSV mode:
//   1. one combined file:  Date, Ticker, Close, Adj Close, Currency
//   2. one file per ticker (ticker taken from the file name, e.g. XIU.TO.csv):
//      Date, Close[, Adj Close][, Currency]
// "Adjusted Close", "adj close" and "adj_close" are accepted for Adj Close.
// Dates are YYYY-MM-DD. Prices must be positive numbers; a blank cell is a missing
// value, anything else invalid stops the import with the row number.

import { csvRecords } from "./csv.js";
import { normalizeSymbol } from "./symbols.js";
import { validateHistory } from "./contract.js";

export const IMPORT_PROVIDER = "Your CSV file";
const ALIASES = { date: ["date"], ticker: ["ticker", "symbol"], close: ["close"], adj: ["adj close", "adjusted close", "adj_close", "adjclose"], currency: ["currency"] };
const DAY_MS = 86400000;

function column(headers, names) {
  const lower = headers.map(h => h.toLowerCase());
  const index = lower.findIndex(h => names.includes(h));
  return index >= 0 ? headers[index] : null;
}

// Median spacing of the dates decides the frequency; mixed spacing is rejected.
export function detectFrequency(dates) {
  if (dates.length < 3) return "daily";
  const gaps = [];
  for (let i = 1; i < dates.length; i += 1) gaps.push((dates[i] - dates[i - 1]) / DAY_MS);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 4) return "daily";
  if (median <= 10) return "weekly";
  if (median >= 25 && median <= 35) return "monthly";
  throw new Error(`dates are spaced about ${Math.round(median)} days apart; use daily, weekly or monthly prices.`);
}

function tickerFromFileName(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "").replace(/\.csv$/i, "");
  return normalizeSymbol(base);
}

// Parses one CSV file. Returns { histories: { TICKER: history }, warnings }.
export function parsePriceCsv(text, fileName = "prices.csv") {
  const { headers, records } = csvRecords(text);
  const dateCol = column(headers, ALIASES.date);
  const closeCol = column(headers, ALIASES.close);
  const adjCol = column(headers, ALIASES.adj);
  const tickerCol = column(headers, ALIASES.ticker);
  const currencyCol = column(headers, ALIASES.currency);
  if (!dateCol) throw new Error(`${fileName}: missing a Date column.`);
  if (!closeCol && !adjCol) throw new Error(`${fileName}: missing a Close or Adj Close column.`);
  const fallbackTicker = tickerCol ? null : tickerFromFileName(fileName);
  const groups = new Map();
  records.forEach((r, i) => {
    const line = i + 2;
    if (!Object.values(r).some(v => v !== "")) return;
    const ticker = tickerCol ? normalizeSymbol(r[tickerCol]) : fallbackTicker;
    const day = r[dateCol];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) throw new Error(`${fileName} line ${line}: date "${day.slice(0, 20)}" is not YYYY-MM-DD.`);
    const value = name => {
      if (!name || r[name] === "") return null;
      const n = Number(r[name].replace(/,/g, ""));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${fileName} line ${line}: ${name} "${r[name].slice(0, 20)}" must be a positive number.`);
      return n;
    };
    const close = value(closeCol);
    const adjClose = value(adjCol);
    if (close === null && adjClose === null) return;
    const currency = currencyCol ? r[currencyCol].toUpperCase() : "";
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(`${fileName} line ${line}: currency "${currency.slice(0, 10)}" is not a 3-letter code.`);
    if (!groups.has(ticker)) groups.set(ticker, { rows: new Map(), currencies: new Set() });
    const group = groups.get(ticker);
    if (group.rows.has(day)) throw new Error(`${fileName} line ${line}: ${ticker} has more than one row for ${day}.`);
    group.rows.set(day, { date: new Date(`${day}T00:00:00Z`), close, adjClose });
    if (currency) group.currencies.add(currency);
  });
  if (!groups.size) throw new Error(`${fileName}: no price rows found.`);
  const histories = {};
  const warnings = [];
  for (const [ticker, group] of groups) {
    if (group.currencies.size > 1) throw new Error(`${fileName}: ${ticker} lists more than one currency (${[...group.currencies].join(", ")}).`);
    const observations = [...group.rows.values()].sort((a, b) => a.date - b.date);
    let frequency;
    try { frequency = detectFrequency(observations.map(o => o.date)); }
    catch (error) { throw new Error(`${fileName}: ${ticker} ${error.message}`); }
    const currency = [...group.currencies][0] || null;
    if (!currency) warnings.push(`${ticker}: the file gives no currency; it cannot be converted to another currency.`);
    const hasAdj = observations.some(o => o.adjClose !== null);
    histories[ticker] = validateHistory({
      requestedSymbol: ticker, symbol: ticker, name: null, instrumentType: null, exchange: null, timezone: null,
      currency, rawCurrency: currency, unitScale: 1, frequency, observations,
      adjustment: { adjCloseAvailable: hasAdj, adjClose: "Adjusted close as supplied in your file.", close: "Close as supplied in your file." },
      market: {}, provider: IMPORT_PROVIDER, fileName: String(fileName).slice(0, 120),
    }, IMPORT_PROVIDER);
  }
  return { histories, warnings };
}
