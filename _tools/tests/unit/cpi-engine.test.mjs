// CPI browser engine: dates, schema, aggregation, missing-data reasons, CSV,
// pagination, and the Statistics Canada and FRED-gateway clients with mocked
// responses (no network).
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../../../assets/js/cpi/schema.js";
import * as D from "../../../assets/js/cpi/dates.js";
import * as E from "../../../assets/js/cpi/engine.js";
import { createStatcanClient, planStatcanRequests, statcanUrl } from "../../../assets/js/cpi/statcan.js";
import { createFredClient, planFredRequests, validFredKey } from "../../../assets/js/cpi/fred.js";

const TODAY = new Date(2026, 10, 3); // 2026-11-03, local time
const KEY = "abcdefghij0123456789abcdefghij01";
const noSleep = async () => {};
const res = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const EXPECTED_HEADERS = ["Date", "Headline CPI - Unadjusted CDN", "Headline CPI - Seasonally Adjusted CDN", "Core CPI - Unadjusted CDN", "Core CPI - Seasonally Adjusted CDN", "Alberta CPI - Unadjusted CDN",
  "Headline CPI - Unadjusted US", "Headline CPI - Seasonally Adjusted US", "Core CPI - Unadjusted US", "Core CPI - Seasonally Adjusted US", "Unemployment Rate - Seasonally Adjusted US",
  "Monthly Effective Fed Fund Rate US", "Monthly Fed Fund Rate - EOP US", "SP by month US", "10yr vs 2yr US", "10-Year Treasury Yield - Monthly Average US",
  "2-Year Treasury Yield - Monthly Average US", "PCE - Seasonally Adjusted US", "Core PCE - Seasonally Adjusted US"];

test("schema: nineteen exact A:S headers, sources and groups", () => {
  assert.deepEqual(S.HEADERS, EXPECTED_HEADERS);
  assert.deepEqual(S.COLUMNS.map(c => c.col).join(""), "ABCDEFGHIJKLMNOPQRS");
  assert.deepEqual(S.STATCAN_SERIES.map(c => c.sourceId), ["41690973", "41690914", "41691233", "41690924", "41692327"]);
  assert.deepEqual(S.FRED_SERIES.map(c => c.sourceId), ["CPIAUCNS", "CPIAUCSL", "CPILFENS", "CPILFESL", "UNRATE", "FEDFUNDS", "DFF", "SP500", "T10Y2Y", "GS10", "GS2", "PCEPI", "PCEPILFE"]);
  assert.deepEqual(S.SERIES.filter(c => c.kind === "daily_eom").map(c => c.sourceId), ["DFF", "SP500", "T10Y2Y"]);
  assert.deepEqual(S.GROUPS.map(g => g.label), ["Canada", "US Inflation", "Rates", "Other"]);
  const grouped = S.GROUPS.flatMap(g => g.ids);
  assert.equal(grouped.length, 18);
  assert.deepEqual([...grouped].sort(), S.SERIES.map(c => c.id).sort(), "every series in exactly one group");
  assert.deepEqual(S.GROUPS.find(g => g.id === "other").ids.map(id => S.byId[id].header), ["Unemployment Rate - Seasonally Adjusted US", "SP by month US"]);
});

test("dates: single month, range, January 1913, current month, invalid input", () => {
  assert.deepEqual(D.parseMonths("single", "2024", "3", "", "", { today: TODAY }), { start: "2024-03", end: "2024-03", notes: [] });
  const r = D.parseMonths("range", "2023", "11", "2024", "02", { today: TODAY });
  assert.deepEqual([r.start, r.end], ["2023-11", "2024-02"]);
  assert.deepEqual(D.monthRange(r.start, r.end), ["2023-11", "2023-12", "2024-01", "2024-02"]);
  const early = D.parseMonths("range", "1900", "1", "1913", "6", { today: TODAY });
  assert.equal(early.start, "1913-01");
  assert.match(early.notes[0], /January 1913/);
  assert.deepEqual([D.parseMonths("single", "1850", "7", "", "", { today: TODAY }).start, D.parseMonths("single", "1850", "7", "", "", { today: TODAY }).end], ["1913-01", "1913-01"]);
  assert.throws(() => D.parseMonths("range", "1900", "1", "1910", "1", { today: TODAY }), /ends before January 1913/);
  const late = D.parseMonths("range", "2026", "1", "9999", "12", { today: TODAY });
  assert.equal(late.end, "2026-11");
  assert.ok(late.notes.some(n => /moved to 2026-11, the current month/.test(n)) && late.notes.some(n => /left blank for the current month/.test(n)));
  assert.throws(() => D.parseMonths("single", "2027", "1", "", "", { today: TODAY }), /in the future/);
  assert.throws(() => D.parseMonths("range", "2024", "5", "2024", "4", { today: TODAY }), /End date must be after start date/);
  for (const [y, m] of [["24", "1"], ["2024", "13"], ["2024", "0"], ["abcd", "1"], ["2024", "1.5"], ["2024", ""], ["20245", "1"], ["0000", "1"]]) {
    assert.throws(() => D.parseMonths("single", y, m, "", "", { today: TODAY }), RangeError, `${y}-${m}`);
  }
  assert.equal(D.lastDayOfMonth("2024-02"), "2024-02-29");
  assert.equal(D.lastDayOfMonth("2023-02"), "2023-02-28");
});

test("daily series: the latest valid observation of each month, whatever the order; duplicates are errors", () => {
  assert.deepEqual(E.reduceDailyEom([["2024-01-31", null], ["2024-01-30", 3], ["2024-01-02", 2], ["2024-02-29", 5.5]]), { "2024-01": 3, "2024-02": 5.5 });
  assert.throws(() => E.reduceDailyEom([["2024-01-02", 1], ["2024-01-02", 2]]), /duplicate/);
  assert.throws(() => E.reduceDailyEom([["2024-02-30", 1]]), /Invalid/);
  const daily = E.normalizeFredObservations([{ date: "2024-01-31", value: "." }, { date: "2024-01-30", value: "5.33" }, { date: "2024-01-02", value: "5.31" }], { kind: "daily_eom", start: "2024-01-01", end: "2024-01-31" });
  assert.deepEqual(daily.values, { "2024-01": 5.33 });
  const monthly = E.normalizeFredObservations([{ date: "2024-01-01", value: "12.5" }, { date: "2024-02-01", value: "." }], { kind: "monthly", start: "2024-01-01", end: "2024-02-29" });
  assert.deepEqual(monthly, { values: { "2024-01": 12.5 }, flags: { "2024-02": "missing" } });
  for (const bad of [[{ date: "2024-01-15", value: "1" }], [{ date: "2023-12-01", value: "1" }], [{ date: "2024-01-01", value: "abc" }], [{ date: "2024-01-01", value: "NaN" }], [{ date: "2024-01-01", value: true }]]) {
    assert.throws(() => E.normalizeFredObservations(bad, { kind: "monthly", start: "2024-01-01", end: "2024-01-31" }), E.DataShapeError, JSON.stringify(bad));
  }
});

const statcanBody = (vectors, start, end, fill = () => 100) => vectors.map(v => ({ status: "SUCCESS", object: { responseStatusCode: 0, vectorId: Number(v), vectorDataPoint: D.monthRange(start, end).map(ym => ({ refPer: `${ym}-01`, value: fill(v, ym), decimals: 1, scalarFactorCode: 0, symbolCode: 0, statusCode: 0, securityLevelCode: 0, frequencyCode: 6 })) } }));

test("Statistics Canada: chunks of 120 months, vectors with history only, validated responses", async () => {
  const chunks = planStatcanRequests("1913-01", "2026-11");
  assert.equal(chunks.length, 12);
  assert.deepEqual([chunks[0].start, chunks[0].end, chunks[0].vectors], ["1913-01", "1922-12", ["41690973"]]);
  assert.equal(chunks.at(-1).end, "2026-11");
  assert.match(statcanUrl(chunks.at(-1)), /^https:\/\/www150\.statcan\.gc\.ca\/t1\/wds\/rest\/getDataFromVectorByReferencePeriodRange\?vectorIds=41690973,41690914,41691233,41690924,41692327&startRefPeriod=2023-01-01&endReferencePeriod=2026-11-01$/);
  const parsed = E.normalizeStatcanResponse(statcanBody(["41690973", "41692327"], "2024-01", "2024-02"), { vectors: ["41690973", "41692327"], start: "2024-01", end: "2024-02" });
  assert.deepEqual(parsed["41690973"].values, { "2024-01": 100, "2024-02": 100 });
  const restricted = statcanBody(["41690973"], "2024-01", "2024-02");
  restricted[0].object.vectorDataPoint[1] = { ...restricted[0].object.vectorDataPoint[1], value: null, securityLevelCode: 1 };
  restricted[0].object.vectorDataPoint[0] = { ...restricted[0].object.vectorDataPoint[0], value: null, statusCode: 1 };
  assert.deepEqual(E.normalizeStatcanResponse(restricted, { vectors: ["41690973"], start: "2024-01", end: "2024-02" })["41690973"].flags, { "2024-01": "missing", "2024-02": "restricted" });
  const shapes = [[], [{ status: "FAILED" }], statcanBody(["41690914"], "2024-01", "2024-01"), (() => { const b = statcanBody(["41690973"], "2024-01", "2024-01"); b[0].object.vectorDataPoint[0].refPer = "2024-01-15"; return b; })(),
    (() => { const b = statcanBody(["41690973"], "2024-01", "2024-01"); b[0].object.vectorDataPoint[0].scalarFactorCode = 3; return b; })(), (() => { const b = statcanBody(["41690973"], "2024-01", "2024-01"); b[0].object.vectorDataPoint[0].value = "abc"; return b; })(),
    (() => { const b = statcanBody(["41690973"], "2024-01", "2024-01"); b[0].object.vectorDataPoint[0].value = true; return b; })()];
  for (const body of shapes) assert.throws(() => E.normalizeStatcanResponse(body, { vectors: ["41690973"], start: "2024-01", end: "2024-01" }), E.DataShapeError);
});

test("Statistics Canada client: HTTP 409 is retried, then only that chunk's months are unavailable; cache", async () => {
  const calls = [];
  let failFirstChunk = 3;
  const fetchImpl = async url => {
    calls.push(String(url));
    const u = new URL(url);
    const vectors = u.searchParams.get("vectorIds").split(",");
    const start = u.searchParams.get("startRefPeriod").slice(0, 7);
    const end = u.searchParams.get("endReferencePeriod").slice(0, 7);
    if (start === "2003-01" && failFirstChunk-- > 0) return res(409, "<html>locked</html>");
    return res(200, statcanBody(vectors, start, end, (v, ym) => (ym >= "1992-01" || v === "41690973" ? 100 : null)));
  };
  const client = createStatcanClient({ fetchImpl, sleep: noSleep, spacingMs: 0 });
  const out = await client.fetchRange("2001-01", "2014-12");
  assert.equal(calls.filter(u => /startRefPeriod=2003-01-01/.test(u)).length, 0, "chunks start at the requested month");
  assert.equal(out.chunks, 2);
  const h = out.series.ca_cpi_headline_nsa;
  assert.equal(h.status, "ok");
  assert.equal(Object.keys(h.values).length, 168);
  // A chunk locked by the update window: three attempts, then its months only.
  failFirstChunk = 3;
  calls.length = 0;
  const locked = await createStatcanClient({ fetchImpl, sleep: noSleep, spacingMs: 0 }).fetchRange("2003-01", "2012-12");
  assert.equal(calls.length, 3, "three attempts for the locked chunk (the whole range is one chunk)");
  assert.equal(locked.series.ca_cpi_headline_nsa.status, "source_unavailable");
  assert.match(locked.series.ca_cpi_headline_nsa.message, /updating its tables \(HTTP 409/);
  failFirstChunk = 3;
  const partial = await createStatcanClient({ fetchImpl, sleep: noSleep, spacingMs: 0 }).fetchRange("1993-01", "2014-12");
  assert.equal(partial.series.ca_cpi_headline_nsa.status, "partial");
  const ds = E.buildDataset({ start: "1993-01", end: "2014-12", seriesById: partial.series, today: TODAY });
  const at = ym => ds.rows.find(r => r.date === `${ym}-01`);
  assert.equal(at("2002-12").values[0], 100, "months outside the failed chunk keep their values");
  assert.equal(at("2003-01").values[0], null);
  assert.equal(at("2003-01").reasons[0], "source_unavailable");
  // Cache: the same request within 30 minutes is not sent again.
  calls.length = 0;
  await client.fetchRange("2001-01", "2014-12");
  assert.equal(calls.length, 0);
  await client.fetchRange("2001-01", "2014-12", { force: true });
  assert.equal(calls.length, 2);
});

function seriesSet(extra = {}) {
  const ok = values => E.seriesResult({ values });
  return { ...Object.fromEntries(S.SERIES.map(c => [c.id, ok({})])), ...extra };
}

test("dataset: every month kept, blank reasons, current month incomplete for end-of-month series", () => {
  const ds = E.buildDataset({
    start: "1913-01", end: "2026-11", today: TODAY,
    seriesById: seriesSet({
      ca_cpi_headline_nsa: E.seriesResult({ values: { "1914-01": 6, "2026-09": 170 } }),
      us_cpi_headline_nsa: E.seriesResult({ values: { "1913-01": 9.8, "2026-09": 324.1 }, flags: { "1913-02": "missing" } }),
      us_fed_funds_eom: E.seriesResult({ values: { "2026-10": 3.88, "2026-11": 3.87 } }),
      us_sp500_eom: E.seriesResult({ values: { "2016-12": 2238.83, "2026-10": 6800 } }),
      us_unemployment_sa: E.failedSeries("no_key", "FRED key not entered"),
    }),
  });
  assert.equal(ds.rows.length, 1367, "1913-01 to 2026-11 inclusive");
  assert.equal(ds.rows[0].date, "1913-01-01");
  const idx = id => S.SERIES.findIndex(c => c.id === id);
  const row = ym => ds.rows.find(r => r.date === `${ym}-01`);
  assert.equal(row("1913-01").reasons[idx("ca_cpi_headline_nsa")], "before_start");
  assert.equal(row("1913-01").values[idx("us_cpi_headline_nsa")], 9.8);
  assert.equal(row("1913-02").reasons[idx("us_cpi_headline_nsa")], "missing");
  assert.equal(row("1950-01").reasons[idx("ca_cpi_headline_nsa")], "missing", "a gap inside the history is missing, not zero");
  assert.equal(row("2026-10").reasons[idx("ca_cpi_headline_nsa")], "not_published");
  assert.equal(row("2026-11").values[idx("us_fed_funds_eom")], null);
  assert.equal(row("2026-11").reasons[idx("us_fed_funds_eom")], "incomplete_month", "a mid-month DFF value is never shown as month-end");
  assert.equal(row("2026-10").values[idx("us_fed_funds_eom")], 3.88);
  assert.equal(row("2000-01").reasons[idx("us_sp500_eom")], "before_start", "SP500 before FRED's window");
  assert.equal(row("2026-11").reasons[idx("us_sp500_eom")], "incomplete_month");
  assert.equal(row("1990-05").reasons[idx("us_unemployment_sa")], "no_key");
  const stats = E.datasetStats(ds);
  assert.equal(stats.months, 1367);
  assert.ok(stats.populatedSeries.includes("us_sp500_eom") && stats.unavailableSeries.includes("us_unemployment_sa"));
  assert.ok(!ds.rows.some(r => r.values.some(v => v === 0)), "nothing filled with zero");
});

test("Canadian-only mode: FRED columns blank with their reason, Canadian values kept, all 19 headers in the CSV", () => {
  const series = seriesSet(Object.fromEntries(S.FRED_SERIES.map(c => [c.id, E.failedSeries("no_key", "FRED key not entered")])));
  series.ca_cpi_headline_nsa = E.seriesResult({ values: { "2024-01": 158.3, "2024-02": 158.8 } });
  const ds = E.buildDataset({ start: "2024-01", end: "2024-02", seriesById: series, today: TODAY });
  const stats = E.datasetStats(ds);
  assert.equal(E.coverageLabel(stats), "canadian_only");
  assert.equal(stats.blankByReason.no_key, 26);
  const csv = E.toCsv(ds);
  assert.equal(csv.split("\r\n")[0], EXPECTED_HEADERS.join(","));
  assert.equal(csv, `${EXPECTED_HEADERS.join(",")}\r\n2024-01-01,158.3,,,,,,,,,,,,,,,,,\r\n2024-02-01,158.8,,,,,,,,,,,,,,,,,\r\n`);
  assert.ok(!csv.includes(KEY));
});

test("CSV: Python float formatting, blank cells, quoting and formula-injection guard", () => {
  assert.deepEqual([100, 4, 0, -0, 0.1, 5.3, -0.01, 307.051, 1e-5, 0.0001, 1e16, 12345678901234567, 2238.83].map(E.pyFloat),
    ["100.0", "4.0", "0.0", "-0.0", "0.1", "5.3", "-0.01", "307.051", "1e-05", "0.0001", "1e+16", "1.2345678901234568e+16", "2238.83"]);
  assert.equal(E.csvCell(-0.5), "-0.5", "a negative number is not a formula");
  assert.equal(E.csvCell("-0.5"), "-0.5");
  assert.equal(E.csvCell("2024-01-01"), "2024-01-01");
  assert.equal(E.csvCell(null), "");
  assert.equal(E.csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  for (const bad of ["+1+1", "@SUM(A1)", "-1+2", "\t=1", "=1"]) assert.ok(E.csvCell(bad).replace(/^"/, "").startsWith("'"), bad);
  assert.equal(E.csvCell("a,b"), "\"a,b\"");
  assert.equal(E.csvCell("line\nbreak"), "\"line\nbreak\"");
});

test("pagination: twelve months per page, newest first, only the oldest page shorter", () => {
  assert.equal(E.pageCount(1367), 114);
  assert.deepEqual(E.pageSlice(1367, 1), { page: 1, pages: 114, from: 1355, to: 1367 });
  assert.deepEqual(E.pageSlice(1367, 114), { page: 114, pages: 114, from: 0, to: 11 });
  assert.equal(E.pageSlice(1367, 999).page, 114);
  assert.deepEqual(E.pageSlice(1, 1), { page: 1, pages: 1, from: 0, to: 1 });
  for (let p = 1; p < 114; p += 1) { const s = E.pageSlice(1367, p); assert.equal(s.to - s.from, 12, `page ${p}`); }
  const ds = E.buildDataset({ start: "1913-01", end: "2026-11", seriesById: seriesSet(), today: TODAY });
  assert.equal(E.pageOfMonth(ds, "2026-11"), 1);
  assert.equal(E.pageOfMonth(ds, "2025-12"), 1);
  assert.equal(E.pageOfMonth(ds, "2025-11"), 2);
  assert.equal(E.pageOfMonth(ds, "1913-01"), 114);
  assert.equal(E.pageOfMonth(ds, "1800-01"), null);
});

test("large ranges: 1913 to today builds and exports quickly", () => {
  const values = Object.fromEntries(D.monthRange("1913-01", "2026-10").map((ym, i) => [ym, 10 + i / 10]));
  const t0 = performance.now();
  const ds = E.buildDataset({ start: "1913-01", end: "2026-11", seriesById: seriesSet(Object.fromEntries(S.SERIES.map(c => [c.id, E.seriesResult({ values })]))), today: TODAY });
  const csv = E.toCsv(ds);
  const ms = performance.now() - t0;
  assert.equal(csv.split("\r\n").length, 1367 + 2);
  assert.ok(ms < 1500, `built and exported in ${ms.toFixed(0)} ms`);
});

test("revisions: a new fetch replaces earlier values (nothing merged from an old copy)", () => {
  const first = E.buildDataset({ start: "2024-01", end: "2024-01", seriesById: seriesSet({ us_pce_sa: E.seriesResult({ values: { "2024-01": 122.1 } }) }), today: TODAY });
  const revised = E.buildDataset({ start: "2024-01", end: "2024-01", seriesById: seriesSet({ us_pce_sa: E.seriesResult({ values: { "2024-01": 122.3 } }) }), today: TODAY });
  const i = S.SERIES.findIndex(c => c.id === "us_pce_sa");
  assert.equal(first.rows[0].values[i], 122.1);
  assert.equal(revised.rows[0].values[i], 122.3);
});

test("empty history in an established period is a provider error, not a quiet gap", () => {
  const col = S.byId.ca_cpi_core_nsa;
  assert.equal(E.flagEmptyHistory(E.seriesResult({}), col, "2000-01", "2000-12", { today: TODAY }).status, "provider_error");
  assert.equal(E.flagEmptyHistory(E.seriesResult({}), col, "2026-10", "2026-11", { today: TODAY }).status, "ok", "recent months may be unpublished");
  assert.equal(E.flagEmptyHistory(E.seriesResult({}), col, "1950-01", "1950-12", { today: TODAY }).status, "ok", "before the series began");
});

test("display: decimals per series, thousands separators, no precision hidden", () => {
  assert.equal(E.formatValue(2238.83, S.byId.us_sp500_eom), "2,238.83");
  assert.equal(E.formatValue(158.3, S.byId.ca_cpi_headline_nsa), "158.3");
  assert.equal(E.formatValue(307.051, S.byId.us_cpi_headline_nsa), "307.051");
  assert.equal(E.formatValue(-0.5, S.byId.us_10y2y_eom), "-0.50");
  assert.equal(E.formatValue(158.35, S.byId.ca_cpi_headline_nsa), "158.35", "an unexpected extra decimal is shown, not rounded away");
});

/* ---------------- FRED gateway client ---------------- */
function gatewayFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method || "GET", body, credentials: init.credentials, headers: init.headers });
    return handler(new URL(url), body);
  };
  return { calls, fetchImpl };
}
const obs = (body, kind) => {
  const daily = kind === "daily";
  const out = [];
  for (let t = Date.parse(`${body.observation_start}T00:00:00Z`); t <= Date.parse(`${body.observation_end}T00:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (daily || d.endsWith("-01")) out.push({ date: d, value: daily && new Date(t).getUTCDay() % 6 === 0 ? "." : "1.25" });
  }
  return { schema: "cpi-data-gateway.observations.v1", series_id: body.series_id, observation_start: body.observation_start, observation_end: body.observation_end, count: out.length, observations: out };
};
const DAILY = new Set(["DFF", "SP500", "T10Y2Y"]);

test("FRED plan: one request per monthly series, ten-year windows for daily series, SP500 window", () => {
  const plan = planFredRequests("1913-01", "2026-11", { today: TODAY });
  const by = id => plan.filter(p => p.column.sourceId === id);
  assert.equal(by("CPIAUCNS").length, 1);
  assert.deepEqual([by("CPIAUCSL")[0].start, by("CPIAUCSL")[0].end], ["1947-01-01", "2026-11-30"], "starts at the first published month");
  assert.equal(by("DFF").length, 8);
  assert.equal(by("T10Y2Y").length, 6);
  assert.equal(by("SP500")[0].start, "2014-11-01", "SP500: FRED's rolling window, with a margin");
  assert.equal(by("SP500").length, 2);
  assert.ok(plan.every(p => p.column.kind === "monthly" || (Date.parse(p.end) - Date.parse(p.start)) / 86400000 <= 3660));
  assert.equal(plan.length, 10 + 8 + 6 + 2);
  assert.equal(planFredRequests("2024-03", "2024-03", { today: TODAY }).length, 13, "a single month: one request per series");
});

test("FRED client: key only in the POST body; values, missing '.', daily end-of-month", async () => {
  const { calls, fetchImpl } = gatewayFetch((url, body) => res(200, obs(body, DAILY.has(body.series_id) ? "daily" : "monthly")));
  const client = createFredClient({ gatewayUrl: "https://gw.example.workers.dev", fetchImpl, sleep: noSleep });
  const out = await client.fetchRange("2024-01", "2024-03", KEY, { today: TODAY });
  assert.equal(out.requests, 13);
  assert.ok(calls.every(c => c.method === "POST" && c.url === "https://gw.example.workers.dev/v1/observations" && !c.url.includes(KEY) && c.credentials === "omit"));
  assert.ok(calls.every(c => c.body.api_key === KEY && Object.keys(c.body).sort().join() === "api_key,observation_end,observation_start,series_id"));
  assert.equal(out.series.us_cpi_headline_nsa.status, "ok");
  assert.deepEqual(out.series.us_cpi_headline_nsa.values, { "2024-01": 1.25, "2024-02": 1.25, "2024-03": 1.25 });
  assert.deepEqual(Object.keys(out.series.us_fed_funds_eom.values), ["2024-01", "2024-02", "2024-03"]);
  assert.ok(!JSON.stringify(out).includes(KEY), "the key is in no result");
});

test("FRED client: invalid key format is refused before any request; a rejected key stops every request", async () => {
  const { calls, fetchImpl } = gatewayFetch(() => res(401, { error: { code: "key_rejected", message: "FRED rejected the key." } }));
  const client = createFredClient({ gatewayUrl: "https://gw.example.workers.dev", fetchImpl, sleep: noSleep, concurrency: 1 });
  for (const bad of ["", "ABCDEFGHIJ0123456789ABCDEFGHIJ01", "short", `${KEY}x`, "abcdefghij0123456789abcdefghij0!"]) {
    assert.equal(validFredKey(bad), false, bad);
    await assert.rejects(client.fetchRange("2024-01", "2024-01", bad, { today: TODAY }), /not a FRED API key/);
  }
  assert.equal(calls.length, 0);
  const out = await client.fetchRange("2024-01", "2024-01", KEY, { today: TODAY });
  assert.equal(calls.length, 1, "stopped after the first rejection");
  assert.equal(out.stopped.reason, "key_rejected");
  assert.ok(S.FRED_SERIES.every(c => out.series[c.id].status === "key_rejected"));
});

test("FRED client: partial failure keeps the other series; transient errors are retried; disabled series are restricted", async () => {
  const attempts = {};
  const { fetchImpl } = gatewayFetch((url, body) => {
    attempts[body.series_id] = (attempts[body.series_id] || 0) + 1;
    if (body.series_id === "GS10") return res(503, { error: { code: "upstream_unavailable", message: "FRED is temporarily unavailable." } });
    if (body.series_id === "UNRATE" && attempts.UNRATE === 1) return res(429, { error: { code: "upstream_rate_limited" } }, { "retry-after": "1" });
    if (body.series_id === "SP500") return res(403, { error: { code: "series_disabled" } });
    if (body.series_id === "PCEPI") return res(200, { ...obs(body, "monthly"), series_id: "PCEPILFE" });
    return res(200, obs(body, DAILY.has(body.series_id) ? "daily" : "monthly"));
  });
  const out = await createFredClient({ gatewayUrl: "https://gw.example.workers.dev", fetchImpl, sleep: noSleep }).fetchRange("2024-01", "2024-02", KEY, { today: TODAY });
  assert.equal(attempts.GS10, 3, "three attempts for a transient upstream failure");
  assert.equal(out.series.us_treasury_10y_avg.status, "source_unavailable");
  assert.equal(attempts.UNRATE, 2);
  assert.equal(out.series.us_unemployment_sa.status, "ok");
  assert.equal(out.series.us_sp500_eom.status, "restricted");
  assert.equal(out.series.us_pce_sa.status, "provider_error", "an answer for another series is not used");
  assert.equal(out.series.us_cpi_headline_sa.status, "ok");
});

test("FRED client: unreachable gateway stops early; not configured is reported without a request", async () => {
  const { calls, fetchImpl } = gatewayFetch(() => { throw new TypeError("Failed to fetch"); });
  const out = await createFredClient({ gatewayUrl: "https://gw.example.workers.dev", fetchImpl, sleep: noSleep, concurrency: 1 }).fetchRange("2024-01", "2024-01", KEY, { today: TODAY });
  assert.equal(out.stopped.reason, "gateway_unavailable");
  assert.equal(calls.length, 3, "one request retried twice, then everything stops");
  assert.ok(S.FRED_SERIES.every(c => out.series[c.id].status === "gateway_unavailable"));
  const none = createFredClient({ gatewayUrl: "", fetchImpl });
  assert.equal(none.configured, false);
  assert.deepEqual(await none.health(), { ok: false, reason: "gateway_not_configured" });
  assert.equal(createFredClient({ gatewayUrl: "http://evil.example", fetchImpl }).configured, false, "plain http is refused (loopback excepted)");
  assert.equal(createFredClient({ gatewayUrl: "https://gw.example/?x=1", fetchImpl }).configured, false);
});
