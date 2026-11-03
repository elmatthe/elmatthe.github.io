// CPI dataset engine (no DOM, no network): turns source observations into the
// nineteen-column monthly dataset of the desktop CPI_Downloader, with a reason for
// every blank cell, and writes the CSV byte-for-byte as the desktop does.
//
// Conventions (identical to projects/CPI-Webscraper/scripts/data_sources.py):
//   * monthly series are used as published, keyed to the first day of the month;
//   * DFF, SP500 and T10Y2Y keep the latest valid daily observation of each calendar
//     month (independent of response order), and are blank for the current month;
//   * nothing is interpolated, forward-filled or substituted; history before a series
//     begins stays blank; a missing observation is blank, never zero.

import { COLUMNS, SERIES, HEADERS, MIN_MONTH, byId } from "./schema.js";
import { addMonths, currentMonth, monthRange } from "./dates.js";

// Why a cell is blank. Shown in the preview; the CSV leaves every one of them empty.
export const REASONS = Object.freeze({
  no_key: "FRED key not entered",
  gateway_unavailable: "Data gateway unavailable",
  gateway_not_configured: "Data gateway not configured on this site",
  not_published: "Not published yet",
  before_start: "Before the series begins",
  incomplete_month: "Month not finished",
  source_unavailable: "Source temporarily unavailable",
  restricted: "Restricted",
  provider_error: "Provider error",
  key_rejected: "FRED key rejected",
  missing: "No observation published",
  cancelled: "Not fetched (cancelled)",
});

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoDate = text => {
  const m = DATE.exec(String(text || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? text : null;
};
export const DECIMAL = /^-?\d+(\.\d+)?$/; // FRED values as published ("." means no value)

export class DataShapeError extends Error {}

// data_sources.numeric: a finite number, never a boolean.
function numeric(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") throw new DataShapeError("not a number");
  const n = typeof value === "number" ? value : DECIMAL.test(String(value)) ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new DataShapeError("not a finite number");
  return n;
}

// data_sources.reduce_daily_eom: [[YYYY-MM-DD, number|null]] -> { YYYY-MM: number },
// the latest dated valid observation in each month. Duplicate or invalid dates are errors.
export function reduceDailyEom(observations) {
  const seen = new Set();
  const latest = new Map();
  for (const [date, value] of observations) {
    if (!isoDate(date) || seen.has(date)) throw new DataShapeError("Invalid or duplicate daily observation date.");
    seen.add(date);
    if (value === null || value === undefined) continue;
    const v = numeric(value);
    const ym = date.slice(0, 7);
    if (!latest.has(ym) || date > latest.get(ym)[0]) latest.set(ym, [date, v]);
  }
  return Object.fromEntries([...latest].map(([ym, [, v]]) => [ym, v]));
}

// A source series as the engine needs it:
//   { status: "ok" | <REASONS key>, message, values: { YYYY-MM: number },
//     flags: { YYYY-MM: "missing" | "restricted" }, firstObserved, lastObserved,
//     failedRanges: [{ start, end, reason, message }], notes: [] }
export function seriesResult({ status = "ok", message = null, values = {}, flags = {}, failedRanges = [], notes = [], source = null } = {}) {
  const months = Object.keys(values).sort();
  return { status, message, values, flags, failedRanges, notes, source, firstObserved: months[0] || null, lastObserved: months.at(-1) || null };
}

export const failedSeries = (status, message) => seriesResult({ status, message });

// FRED observations ([{ date, value: "1.23" | "." | null }], as the gateway returns
// them) for one series and window -> { values, flags } after the desktop's checks:
// dates inside the window, no duplicates, first-of-month for monthly series.
export function normalizeFredObservations(observations, { kind, start, end }) {
  if (!Array.isArray(observations)) throw new DataShapeError("observations are not a list");
  const rows = [];
  for (const o of observations) {
    const date = isoDate(o?.date);
    if (!date || date < start || date > end || (kind === "monthly" && !date.endsWith("-01"))) throw new DataShapeError("observation outside the requested window");
    const raw = o.value;
    rows.push([date, raw === null || raw === "." ? null : numeric(raw)]);
  }
  if (kind === "daily_eom") return { values: reduceDailyEom(rows), flags: {} };
  const values = {};
  const flags = {};
  const seen = new Set();
  for (const [date, v] of rows) {
    if (seen.has(date)) throw new DataShapeError("duplicate monthly observation");
    seen.add(date);
    if (v === null) flags[date.slice(0, 7)] = "missing";
    else values[date.slice(0, 7)] = v;
  }
  return { values, flags };
}

// One Statistics Canada getDataFromVectorByReferencePeriodRange response (several
// vectors) -> { [vectorId]: { values, flags, revised, preliminary } }, validated like
// data_sources.fetch_statcan_vector_range: SUCCESS, responseStatusCode 0, the
// requested vectors exactly once, monthly first-of-month reference periods inside the
// chunk, no duplicates, numeric or null values, monthly frequency, units scale.
export function normalizeStatcanResponse(body, { vectors, start, end }) {
  if (!Array.isArray(body) || body.length !== vectors.length) throw new DataShapeError("unexpected number of vectors");
  const out = {};
  for (const item of body) {
    const data = item?.object;
    if (item?.status !== "SUCCESS" || !data || data.responseStatusCode !== 0 || !Array.isArray(data.vectorDataPoint)) throw new DataShapeError("unsuccessful vector response");
    const id = String(data.vectorId);
    if (!vectors.includes(id) || out[id]) throw new DataShapeError("unexpected or repeated vector");
    const values = {};
    const flags = {};
    let revised = 0;
    let preliminary = 0;
    for (const p of data.vectorDataPoint) {
      const date = isoDate(p?.refPer);
      if (!date || !date.endsWith("-01")) throw new DataShapeError("reference period is not a month");
      const ym = date.slice(0, 7);
      if (ym < start || ym > end || ym in values || ym in flags) throw new DataShapeError("reference period outside the request or repeated");
      if (p.frequencyCode !== undefined && p.frequencyCode !== 6) throw new DataShapeError("not a monthly series");
      if (p.scalarFactorCode !== undefined && p.scalarFactorCode !== 0) throw new DataShapeError("unexpected units scale");
      if (p.securityLevelCode === 1) { flags[ym] = "restricted"; continue; } // "x": suppressed under the Statistics Act
      if (p.value === null || p.value === undefined) { flags[ym] = "missing"; continue; } // "..": not available
      values[ym] = numeric(p.value);
      if (p.symbolCode === 3) revised += 1;
      if (p.symbolCode === 1) preliminary += 1;
    }
    out[id] = { values, flags, revised, preliminary };
  }
  for (const v of vectors) if (!out[v]) throw new DataShapeError("a requested vector is missing");
  return out;
}

// data_sources.validate_sources: a series with no observation at all in an established
// historical interval (after it began and more than three months ago) is a source
// problem, not a gap; the column is then blank with a provider error (the desktop stops
// the whole download; the browser keeps every other column).
export function flagEmptyHistory(result, column, start, end, { today = new Date(), provider = column.source === "fred" ? "FRED" : "Statistics Canada" } = {}) {
  if (!result || result.status !== "ok" || result.firstObserved || Object.keys(result.flags).length) return result;
  const lag = addMonths(currentMonth(today), -3);
  const first = column.sourceId === "SP500" ? addMonths(currentMonth(today), -(10 * 12 - 1)) : column.firstMonth;
  const from = first && first > start ? first : start;
  const to = end < lag ? end : lag;
  if (!first || from > to) return result;
  return { ...result, status: "provider_error", message: `${provider} returned no observations for ${column.header} between ${from} and ${to}, where the series is published; the column is left blank.` };
}

// The months a request for one series can return, after its first published month.
export function requestWindow(column, start, end, { today = new Date() } = {}) {
  let from = start;
  if (column.firstMonth && column.firstMonth > from) from = column.firstMonth;
  if (column.sourceId === "SP500") {
    const floor = addMonths(currentMonth(today), -12 * 12);
    if (floor > from) from = floor;
  }
  return from > end ? null : { start: from, end };
}

// The reason a cell is blank, or null when it has a value.
function cellReason(col, series, ym, current) {
  if (!series) return "cancelled";
  if (series.status !== "ok" && series.status !== "partial") return series.status;
  const failed = series.failedRanges.find(r => ym >= r.start && ym <= r.end);
  if (failed) return failed.reason;
  if (col.kind === "daily_eom" && ym === current) return "incomplete_month";
  if (ym in series.values) return null;
  if (series.flags[ym]) return series.flags[ym];
  if (col.firstMonth && ym < col.firstMonth) return "before_start";
  if (!col.firstMonth && (!series.firstObserved || ym < series.firstObserved)) return "before_start";
  if (!series.lastObserved || ym > series.lastObserved) return "not_published";
  return "missing";
}

// The full dataset for start..end (inclusive): one row per month, every month kept
// (rows are never dropped), 18 values with their blank reasons.
//   seriesById: { [column id]: seriesResult }
export function buildDataset({ start, end, seriesById, today = new Date(), retrievedAt = null }) {
  const months = monthRange(start, end);
  const current = currentMonth(today);
  const rows = months.map(ym => {
    const values = new Array(SERIES.length);
    const reasons = new Array(SERIES.length);
    SERIES.forEach((col, i) => {
      const s = seriesById[col.id];
      const reason = cellReason(col, s, ym, current);
      values[i] = reason ? null : s.values[ym];
      reasons[i] = reason;
    });
    return { date: `${ym}-01`, values, reasons };
  });
  return { schema: "cpi.dataset.v1", start, end, months: months.length, rows, series: seriesById, today: current, retrievedAt };
}

// Counts for the results header.
export function datasetStats(dataset) {
  const populated = SERIES.map(() => 0);
  const reasons = {};
  for (const row of dataset.rows) {
    row.values.forEach((v, i) => {
      if (v !== null) populated[i] += 1;
      else reasons[row.reasons[i]] = (reasons[row.reasons[i]] || 0) + 1;
    });
  }
  const populatedSeries = SERIES.filter((_, i) => populated[i] > 0).map(c => c.id);
  return {
    months: dataset.rows.length,
    populatedSeries,
    unavailableSeries: SERIES.filter((_, i) => populated[i] === 0).map(c => c.id),
    populatedCells: populated.reduce((a, b) => a + b, 0),
    blankCells: Object.values(reasons).reduce((a, b) => a + b, 0),
    blankByReason: reasons,
    perSeries: Object.fromEntries(SERIES.map((c, i) => [c.id, populated[i]])),
  };
}

// Canadian-only, US-only, complete or partial.
export function coverageLabel(stats) {
  const canada = SERIES.filter(c => c.source === "statcan").some(c => stats.perSeries[c.id] > 0);
  const us = SERIES.filter(c => c.source === "fred").some(c => stats.perSeries[c.id] > 0);
  if (canada && !us) return "canadian_only";
  if (!canada && us) return "us_only";
  if (!canada && !us) return "empty";
  return stats.unavailableSeries.length ? "partial" : "complete";
}

/* ---------------------------------------------------------------- CSV */

// Python's repr() of a float, so the CSV matches the desktop's csv.writer output byte
// for byte: shortest round-trip digits, "100.0" for whole numbers, "1e-05" and
// "1e+16" outside [1e-4, 1e16).
export function pyFloat(v) {
  if (!Number.isFinite(v)) throw new RangeError("not a finite number");
  if (Object.is(v, -0)) return "-0.0";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, exp] = v.toExponential().split("e");
    const sign = exp.startsWith("-") ? "-" : "+";
    return `${mantissa}e${sign}${exp.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}

// One CSV cell. Numbers and YYYY-MM-DD dates are written as-is (a leading "-" on a
// number is a sign, not a formula); any other text that a spreadsheet could read as a
// formula is prefixed with an apostrophe; quoting follows csv.QUOTE_MINIMAL.
const NUMERIC_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return pyFloat(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !NUMERIC_TEXT.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The full dataset as the desktop's write_to_csv writes it: the nineteen A:S headers,
// one row per month with YYYY-MM-DD dates, blank cells for every missing value,
// CRLF line endings, UTF-8 (ASCII) without a byte-order mark.
export function toCsv(dataset) {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const row of dataset.rows) lines.push([row.date, ...row.values].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export const csvFileName = dataset => `CPI_Downloader_${dataset.start}_to_${dataset.end}.csv`;

/* ---------------------------------------------------------------- pagination */

// Twelve months per page, newest first: page 1 holds the most recent twelve months,
// and only the last page (the oldest months) can hold fewer. Rows inside a page stay
// in date order, as in the CSV.
export const PAGE_SIZE = 12;
export function pageCount(months, size = PAGE_SIZE) { return Math.max(1, Math.ceil(months / size)); }
export function pageSlice(months, page, size = PAGE_SIZE) {
  const pages = pageCount(months, size);
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const end = months - (p - 1) * size; // exclusive
  return { page: p, pages, from: Math.max(0, end - size), to: end };
}
export function pageOfMonth(dataset, ym, size = PAGE_SIZE) {
  const index = dataset.rows.findIndex(r => r.date.startsWith(ym));
  if (index < 0) return null;
  return Math.floor((dataset.rows.length - 1 - index) / size) + 1;
}

/* ---------------------------------------------------------------- display */

export function formatValue(value, column) {
  if (value === null || value === undefined) return "";
  const d = column.decimals ?? 2;
  const fixed = value.toFixed(d);
  // Never hide precision the source published.
  const text = Number(fixed) === value ? fixed : String(value);
  const [int, frac] = text.split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac !== undefined ? `.${frac}` : ""}`;
}

export { COLUMNS, SERIES, HEADERS, MIN_MONTH, byId };
