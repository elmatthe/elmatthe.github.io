// Month rules of the desktop CPI downloader (data_sources.normalize_range and
// cpi_webscraper.parse_months), mirrored exactly and checked by
// _tools/tests/test_cpi_parity.py:
//   * a month is entered as a 4-digit year and a month from 1 to 12;
//   * the earliest month is January 1913: an earlier start is moved to 1913-01 (with a
//     note), a single month before 1913 becomes 1913-01, a range ending before 1913 is
//     rejected;
//   * the latest month is the current calendar month: a later end is moved back to it
//     (no request for months that cannot exist yet), a start after it is rejected;
//   * a reversed range is rejected;
//   * every observation is keyed to the first day of its month (YYYY-MM-01).

import { MIN_MONTH } from "./schema.js";

export const INCOMPLETE_MONTH_NOTE = "End-of-month columns (DFF, S&P 500, 10Y-2Y) are left blank for the current month until it ends, so a mid-month value is never written as a month-end value.";

const YM = /^(\d{4})-(\d{2})$/;

export function isMonth(ym) {
  const m = YM.exec(String(ym || ""));
  return Boolean(m && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 12);
}

function assertMonth(ym) {
  if (!YM.test(String(ym || ""))) throw new RangeError("Use a valid YYYY-MM date.");
  if (!isMonth(ym)) throw new RangeError("Use a valid YYYY-MM date (month 01 to 12).");
}

// "YYYY-MM" of a local calendar date (the visitor's own today, as the desktop uses date.today()).
export function currentMonth(today = new Date()) {
  if (typeof today === "string") return today.slice(0, 7);
  return `${String(today.getFullYear()).padStart(4, "0")}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function monthsBetween(start, end) {
  const [y1, m1] = start.split("-").map(Number);
  const [y2, m2] = end.split("-").map(Number);
  return (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
}

// Every month from start to end inclusive.
export function monthRange(start, end) {
  assertMonth(start);
  assertMonth(end);
  if (start > end) throw new RangeError("End date must not precede start date.");
  const out = [];
  for (let ym = start; ym <= end; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

export const lastDayOfMonth = ym => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

// data_sources.normalize_range
export function normalizeRange(start, end, { single = false, today = new Date() } = {}) {
  assertMonth(start);
  assertMonth(end);
  if (end < start) throw new RangeError("End date must not precede start date.");
  start = start > MIN_MONTH ? start : MIN_MONTH;
  if (single) end = start;
  if (end < start) throw new RangeError("The range ends before January 1913.");
  const latest = currentMonth(today);
  if (start > latest) throw new RangeError(`The start month ${start} is in the future; the latest possible month is ${latest}.`);
  return [start, end < latest ? end : latest];
}

// cpi_webscraper.parse_months: form text -> { start, end, notes } after clamping.
export function parseMonths(mode, year, month, year2, month2, { today = new Date() } = {}) {
  const ym = (y, m, label) => {
    const yy = String(y ?? "").trim();
    const mm = String(m ?? "").trim();
    if (!(/^\d{4}$/.test(yy) && /^\d{1,2}$/.test(mm) && Number(mm) >= 1 && Number(mm) <= 12)) {
      throw new RangeError(`Enter the ${label} as a 4-digit year and a month from 1 to 12.`);
    }
    if (Number(yy) < 1) throw new RangeError(`Enter the ${label} with a year from 0001.`);
    return `${yy}-${mm.padStart(2, "0")}`;
  };
  let start;
  let end;
  if (mode === "single") start = end = ym(year, month, "month");
  else {
    start = ym(year, month, "start month");
    end = ym(year2, month2, "end month");
    if (end < start) throw new RangeError("End date must be after start date.");
  }
  const [s, e] = normalizeRange(start, end, { single: mode === "single", today });
  const notes = [];
  if (s !== start) notes.push("Data begins in January 1913; the start was moved to 1913-01.");
  if (e !== end && end > e) notes.push(`The end was moved to ${e}, the current month.`);
  if (e === currentMonth(today)) notes.push(INCOMPLETE_MONTH_NOTE);
  return { start: s, end: e, notes };
}
