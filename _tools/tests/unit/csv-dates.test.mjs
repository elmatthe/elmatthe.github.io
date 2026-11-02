// Strict calendar-date validation for imported price files (R04).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePriceCsv } from "../../../assets/js/market-data/price-import.js";
import { parseIsoDay, isIsoDay } from "../../../assets/js/market-data/contract.js";
import { parseSeries } from "../../../assets/js/market-data/providers/alphavantage.js";
import * as F from "./fixtures.mjs";

const csv = rows => `Date,Ticker,Close,Currency\n${rows.map(([d, c]) => `${d},XIU.TO,${c},CAD`).join("\n")}\n`;
const VALID = [["2026-01-05", 30], ["2026-01-06", 30.5], ["2026-01-07", 31]];

test("parseIsoDay accepts real calendar days only", () => {
  for (const day of ["2024-02-29", "2000-02-29", "2026-12-31", "2026-01-01", "1999-04-30"]) {
    assert.equal(parseIsoDay(day)?.toISOString().slice(0, 10), day, day);
  }
  for (const day of ["2026-02-29", "1900-02-29", "2026-02-30", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-15", "2026-01-00", "2026-01-32",
    "not-a-date", "2026-1-05", "2026/01/05", "2026-01-05T00:00:00Z", " 2026-01-05", "", null, undefined, 20260105]) {
    assert.equal(parseIsoDay(day), null, String(day));
    assert.equal(isIsoDay(day), false, String(day));
  }
});

test("CSV import rejects impossible dates with the file name and line number", () => {
  const cases = [
    ["2026-02-30", /prices\.csv line 3: date "2026-02-30" is not a real calendar date/],
    ["2026-04-31", /prices\.csv line 3: date "2026-04-31" is not a real calendar date/],
    ["2026-13-01", /prices\.csv line 3: date "2026-13-01" is not a real calendar date/],
    ["2026-00-15", /prices\.csv line 3: date "2026-00-15" is not a real calendar date/],
    ["2026-02-29", /line 3: date "2026-02-29" is not a real calendar date/],
    ["not-a-date", /prices\.csv line 3: date "not-a-date" is not in YYYY-MM-DD format/],
    ["05/01/2026", /line 3: date "05\/01\/2026" is not in YYYY-MM-DD format/],
  ];
  for (const [bad, message] of cases) {
    const rows = [VALID[0], [bad, 30.2], VALID[2]];
    assert.throws(() => parsePriceCsv(csv(rows), "prices.csv"), message, bad);
  }
  // Per-ticker layout reports its own file name.
  assert.throws(() => parsePriceCsv("Date,Close\n2026-01-05,10\n2026-04-31,11\n", "RY.TO.csv"), /RY\.TO\.csv line 3: date "2026-04-31"/);
});

test("valid leap days and surrounding whitespace are accepted; nothing is shifted", () => {
  const { histories } = parsePriceCsv(csv([["2024-02-28", 10], [" 2024-02-29 ", 11], ["2024-03-01", 12]]), "leap.csv");
  assert.deepEqual(histories["XIU.TO"].observations.map(o => o.date.toISOString()), ["2024-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z", "2024-03-01T00:00:00.000Z"]);
});

test("rows in any order come out ascending by calendar day, with no time-zone shift", () => {
  const rows = [["2026-03-09", 3], ["2026-03-06", 2], ["2026-11-02", 5], ["2026-03-05", 1], ["2026-10-30", 4]]; // spans both DST changes
  const expected = ["2026-03-05", "2026-03-06", "2026-03-09", "2026-10-30", "2026-11-02"];
  const { histories } = parsePriceCsv(csv(rows), "unordered.csv");
  assert.deepEqual(histories["XIU.TO"].observations.map(o => o.date.toISOString().slice(0, 10)), expected);
  assert.deepEqual(histories["XIU.TO"].observations.map(o => o.close), [1, 2, 3, 4, 5]);
  // Same result whatever the machine's time zone is (the parser uses UTC days only).
  const moduleUrl = new URL("../../../assets/js/market-data/price-import.js", import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(m => { const h = m.parsePriceCsv(${JSON.stringify(csv(rows))}, "u.csv").histories["XIU.TO"]; console.log(JSON.stringify(h.observations.map(o => o.date.toISOString().slice(0, 10)))); });`;
  for (const tz of ["America/Toronto", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: tz }, cwd: fileURLToPath(new URL(".", import.meta.url)) }).toString().trim();
    assert.deepEqual(JSON.parse(out), expected, tz);
  }
});

test("a provider series with an impossible date drops that row instead of moving it", () => {
  const body = JSON.parse(F.avWeekly("AAPL", [["2026-10-16", 100, 99], ["2026-10-23", 101, 100], ["2026-10-30", 103, 102]]));
  body["Weekly Adjusted Time Series"]["2026-02-30"] = { "4. close": "50", "5. adjusted close": "50" };
  const h = parseSeries(body, "AAPL", { avSymbol: "AAPL", currency: "USD", unitScale: 1 }, "weekly");
  assert.deepEqual(h.observations.map(o => o.date.toISOString().slice(0, 10)), ["2026-10-16", "2026-10-23", "2026-10-30"]);
});
