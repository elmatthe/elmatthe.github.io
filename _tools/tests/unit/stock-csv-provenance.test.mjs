// The three Stock Comparison CSV exports record where every series came from: the source
// that gave it, the source order at the moment of the request, what failed and what was
// skipped, per ticker. The rows the tool always wrote stay exactly as they were, and the
// provenance rows are marked so a reader can tell them apart or skip them. Parsed with the
// site's own CSV reader and, for pandas-style readers, by the "#" comment convention.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCsvRows, buildWorkbookSheets, provenanceRows, PROVENANCE_MARKER } from "../../../assets/js/stock-dashboard/export.js";
import { toCsv } from "../../../assets/js/shared/export-files.js";
import { parseCsv } from "../../../assets/js/market-data/csv.js";

const day = text => new Date(`${text}T00:00:00Z`);
const ORDER = "1. Yahoo Finance; 2. Alpha Vantage; 3. Marketstack (off); 4. Finnhub";
const comparison = (overrides = {}) => ({
  tickers: ["AAPL", "MSFT"], horizon: "3M", riskFree: 0.03, normalizedTo: null, excludedForCurrency: [], fxSources: {}, basis: "adjusted", frequency: "daily", periodsPerYear: 252,
  liveNote: "A note, with a comma.", sourceOrder: ORDER, requestedStart: "2026-08-01", requestedEnd: "2026-11-01", completedAt: "2026-11-03T15:00:00.000Z",
  source: "Several sources (Yahoo Finance (no key), Alpha Vantage (your key))",
  series: [
    { ticker: "AAPL", currency: "USD", nativeCurrency: "USD", priceBasis: "adjusted_close", frequency: "daily", observations: [{ date: day("2026-10-29"), price: 101.5 }, { date: day("2026-10-30"), price: 102.25 }] },
    { ticker: "MSFT", currency: "USD", nativeCurrency: "USD", priceBasis: "close", frequency: "daily", observations: [{ date: day("2026-10-29"), price: 50 }, { date: day("2026-10-30"), price: 51 }] },
  ],
  metrics: [
    { ticker: "AAPL", currency: "USD", nativeCurrency: "USD", priceBasis: "adjusted_close", frequency: "daily", totalReturn: 0.0074, annualizedReturn: 0.1, annualizedVolatility: 0.2, sharpe: 0.35, maxDrawdown: -0.05, returnObservations: 1, actualStart: "2026-10-29", actualEnd: "2026-10-30" },
    { ticker: "MSFT", currency: "USD", nativeCurrency: "USD", priceBasis: "close", frequency: "daily", totalReturn: 0.02, annualizedReturn: 0.2, annualizedVolatility: 0.3, sharpe: 0.5, maxDrawdown: -0.01, returnObservations: 1, actualStart: "2026-10-29", actualEnd: "2026-10-30" },
  ],
  matrix: { AAPL: { AAPL: 1, MSFT: 0.42 }, MSFT: { AAPL: 0.42, MSFT: 1 } },
  counts: { AAPL: { AAPL: 1, MSFT: 1 }, MSFT: { AAPL: 1, MSFT: 1 } },
  warnings: [], failures: ["ZZZQ: No source in your list could give usable price history."],
  provenance: [
    { ticker: "AAPL", source: "Yahoo Finance (no key)", via: "this site's data gateway", retrievedAt: "2026-11-03T14:59:00.000Z", cached: false, basis: "Adjusted close (dividends included)", triedFirst: [], skipped: ["Finnhub: provides latest prices only, not price history"], sourceOrder: ORDER },
    { ticker: "MSFT", source: "Alpha Vantage (your key)", via: "your Alpha Vantage key", retrievedAt: "2026-11-03T14:59:30.000Z", cached: true, cacheWhere: "browser", basis: "Close (price only)", triedFirst: ["Yahoo Finance: Yahoo Finance is unavailable right now."], skipped: ["Finnhub: provides latest prices only, not price history"], sourceOrder: ORDER },
  ],
  sourceAudit: [
    { ticker: "AAPL", status: "used", source: "Yahoo Finance (no key) (this site's data gateway)", sourceOrder: ORDER, triedFirst: [], skipped: ["Finnhub: provides latest prices only, not price history"], retrievedAt: "2026-11-03T14:59:00.000Z", cached: "no", reason: "" },
    { ticker: "MSFT", status: "used", source: "Alpha Vantage (your key) (your Alpha Vantage key)", sourceOrder: ORDER, triedFirst: ["Yahoo Finance: Yahoo Finance is unavailable right now."], skipped: ["Finnhub: provides latest prices only, not price history"], retrievedAt: "2026-11-03T14:59:30.000Z", cached: "yes", reason: "" },
    { ticker: "ZZZQ", status: "not used", source: "", sourceOrder: ORDER, triedFirst: ["Yahoo Finance: Yahoo Finance has no data for this symbol."], skipped: ["Finnhub: provides latest prices only, not price history"], retrievedAt: "", cached: "", reason: "ZZZQ: No source in your list could give usable price history." },
  ],
  ...overrides,
});
// The core rows exactly as earlier versions wrote them (numbers untouched).
const CORE = {
  metrics: [
    ["Ticker", "Currency", "Price basis", "Frequency", "Total return", "Annualized return", "Annualized volatility", "Sharpe ratio", "Max drawdown", "Return observations", "Actual start", "Actual end", "Source", "Native currency"],
    ["AAPL", "USD", "Adjusted close (dividends included)", "daily", 0.0074, 0.1, 0.2, 0.35, -0.05, 1, "2026-10-29", "2026-10-30", "Yahoo Finance (no key) (this site's data gateway)", "USD"],
    ["MSFT", "USD", "Close (price only)", "daily", 0.02, 0.2, 0.3, 0.5, -0.01, 1, "2026-10-29", "2026-10-30", "Alpha Vantage (your key) (your Alpha Vantage key)", "USD"],
    [], ["Price basis", "adjusted closes requested; plain closes (price return) used for MSFT"], ["Currency", "native currency (USD)"], ["Note", "A note, with a comma."],
  ],
  correlation: [["Ticker", "AAPL", "MSFT"], ["AAPL", 1, 0.42], ["MSFT", 0.42, 1], [], ["Shared returns", "AAPL", "MSFT"], ["AAPL", 1, 1], ["MSFT", 1, 1]],
  prices: [
    ["Date", "Ticker", "Price", "Price basis", "Currency", "Source", "Native currency"],
    ["2026-10-29", "AAPL", 101.5, "Adjusted close (dividends included)", "USD", "Yahoo Finance (no key) (this site's data gateway)", "USD"],
    ["2026-10-30", "AAPL", 102.25, "Adjusted close (dividends included)", "USD", "Yahoo Finance (no key) (this site's data gateway)", "USD"],
    ["2026-10-29", "MSFT", 50, "Close (price only)", "USD", "Alpha Vantage (your key) (your Alpha Vantage key)", "USD"],
    ["2026-10-30", "MSFT", 51, "Close (price only)", "USD", "Alpha Vantage (your key) (your Alpha Vantage key)", "USD"],
  ],
};

test("B4: every CSV keeps its core rows byte for byte, then one marked provenance section", () => {
  for (const kind of ["metrics", "correlation", "prices"]) {
    const text = toCsv(buildCsvRows(kind, comparison()));
    const core = toCsv(CORE[kind]);
    assert.ok(text.startsWith(core), `${kind}: the original rows come first, unchanged`);
    const rest = text.slice(core.length);
    assert.ok(rest.startsWith(`\r\n${PROVENANCE_MARKER},`), `${kind}: a blank line, then the marked section`);
    assert.ok(rest.trimEnd().split("\r\n").slice(1).every(line => line.startsWith(`${PROVENANCE_MARKER},`)), `${kind}: every section line is marked`);
    assert.ok(text.endsWith("\r\n"));
    assert.ok(!/(^|[^\r])\n/.test(text), `${kind}: CRLF line endings throughout`);
  }
});

test("B4: a reader that skips '#' lines gets exactly the numeric table", () => {
  const text = toCsv(buildCsvRows("prices", comparison()));
  const data = text.split("\r\n").filter(line => line && !line.startsWith("#"));
  assert.equal(data.join("\r\n") + "\r\n", toCsv(CORE.prices));
  const table = parseCsv(data.join("\n"));
  assert.deepEqual(table.map(r => r[2]).slice(1).map(Number), [101.5, 102.25, 50, 51]);
});

test("B4: parsed with a real CSV reader, the section states source, request-time order, failures, skips and reasons per ticker", () => {
  for (const kind of ["metrics", "correlation", "prices"]) {
    const rows = parseCsv(toCsv(buildCsvRows(kind, comparison()))).filter(r => r[0] === PROVENANCE_MARKER);
    const section = Object.fromEntries(rows.filter(r => r[1] !== "Ticker" && r.length === 3).map(r => [r[1], r[2]]));
    assert.equal(section["Source order at the request (first tried first)"], ORDER, kind);
    assert.equal(section["Exported from the comparison completed at (UTC)"], "2026-11-03T15:00:00.000Z", kind);
    const header = rows.find(r => r[1] === "Ticker");
    assert.deepEqual(header.slice(1), ["Ticker", "Status", "Source used", "Source order at the request", "Sources tried first", "Sources skipped", "Retrieved at (UTC)", "Cached", "Reason not used"], kind);
    const byTicker = Object.fromEntries(rows.filter(r => r.length === header.length && r[1] !== "Ticker").map(r => [r[1], Object.fromEntries(header.slice(1).map((name, i) => [name, r[i + 1]]))]));
    assert.deepEqual(Object.keys(byTicker), ["AAPL", "MSFT", "ZZZQ"], kind);
    assert.equal(byTicker.AAPL["Source used"], "Yahoo Finance (no key) (this site's data gateway)");
    assert.equal(byTicker.AAPL["Sources tried first"], "");
    assert.equal(byTicker.MSFT["Source used"], "Alpha Vantage (your key) (your Alpha Vantage key)");
    assert.match(byTicker.MSFT["Sources tried first"], /Yahoo Finance is unavailable/);
    assert.match(byTicker.MSFT["Sources skipped"], /^Finnhub: provides latest prices only/);
    assert.equal(byTicker.MSFT.Cached, "yes");
    assert.equal(byTicker.ZZZQ.Status, "not used");
    assert.equal(byTicker.ZZZQ["Source used"], "");
    assert.match(byTicker.ZZZQ["Reason not used"], /^ZZZQ: No source/);
  }
});

test("B4: tickers can differ: per-ticker order is kept even when the list changed during a run", () => {
  const c = comparison();
  c.sourceAudit[1].sourceOrder = "1. Alpha Vantage; 2. Yahoo Finance";
  const rows = parseCsv(toCsv(buildCsvRows("metrics", c))).filter(r => r[0] === PROVENANCE_MARKER && r[2] === "used");
  assert.equal(rows[0][4], ORDER);
  assert.equal(rows[1][4], "1. Alpha Vantage; 2. Yahoo Finance");
});

test("B4: hostile text cannot become a formula or break the section; line breaks are flattened", () => {
  const c = comparison();
  c.sourceAudit[2] = { ...c.sourceAudit[2], ticker: "=HYPERLINK(1)", triedFirst: ["@evil: x", "+1"], skipped: ["-2\r\nsecond line"], reason: "=cmd|'/c calc'!A1\nrest", sourceOrder: "=1+1" };
  const text = toCsv(buildCsvRows("correlation", c));
  const rows = parseCsv(text).filter(r => r[0] === PROVENANCE_MARKER);
  const hostile = rows.find(r => r[1].includes("HYPERLINK"));
  for (const cell of hostile.slice(1)) assert.ok(!/^[=+\-@]/.test(cell), `not a formula: ${cell}`);
  assert.equal(hostile[1], "'=HYPERLINK(1)");
  assert.equal(hostile[6], "'-2 second line");
  assert.equal(hostile[8], "", "the 'Cached' cell");
  assert.match(hostile[9], /^'=cmd/);
  assert.ok(text.trimEnd().split("\r\n").filter(l => l.includes("HYPERLINK")).length === 1, "still one line");
});

test("B4: CSV-file and demo comparisons say plainly that no source list was involved", () => {
  const c = comparison({ sourceOrder: null, source: "Synthetic demo", liveNote: null, sourceAudit: [{ ticker: "AAPL", status: "used", source: "Synthetic demo (generated in your browser)", sourceOrder: null, triedFirst: [], skipped: [], retrievedAt: "2026-11-03T15:00:00.000Z", cached: "no", reason: "" }] });
  const rows = provenanceRows(c);
  assert.ok(rows.some(r => r[1] === "Source order at the request (first tried first)" && /no source list was used/.test(r[2])));
  assert.equal(rows.at(-1)[4], "not applicable");
});

test("B4: a comparison saved without an audit still states what it knows", () => {
  const c = comparison({ sourceAudit: undefined });
  const rows = provenanceRows(c).filter(r => r[2] === "used");
  assert.deepEqual(rows.map(r => r[1]), ["AAPL", "MSFT"]);
  assert.equal(rows[1][3], "Alpha Vantage (your key) (your Alpha Vantage key)");
  assert.equal(rows[1][7], "2026-11-03T14:59:30.000Z");
});

test("B4: the workbook carries the same provenance: order per ticker, and tickers not used", () => {
  const [readMe] = buildWorkbookSheets({ comparison: comparison(), generatedAt: "2026-11-03T15:00:00.000Z" });
  const rows = readMe.rows.map(r => (r.header ? r.cells : r));
  const header = rows.find(r => r[0] === "Ticker" && r[1] === "Source");
  assert.equal(header.at(-1), "Source order at the request");
  const msft = rows.find(r => r[0] === "MSFT" && r[1] === "Alpha Vantage (your key)");
  assert.equal(msft.at(-1), ORDER);
  const notUsed = rows.findIndex(r => r[0] === "Tickers not used");
  assert.ok(notUsed > 0);
  assert.equal(rows[notUsed + 1][0], "ZZZQ");
  assert.match(rows[notUsed + 1][1], /^ZZZQ: No source/);
  assert.equal(rows[notUsed + 1].at(-1), ORDER);
});

test("B4: no key reaches a provenance row (keys are redacted before they get here; this checks the export adds none)", () => {
  const text = ["metrics", "correlation", "prices"].map(kind => toCsv(buildCsvRows(kind, comparison()))).join("");
  assert.ok(!/apikey|token=|access_key/i.test(text));
});
