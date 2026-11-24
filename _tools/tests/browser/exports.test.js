// Browser test: the files the four web apps' export buttons produce, read back and checked
// against independent calculations. Every provider is mocked (harness.js); nothing leaves
// this computer.
//
//   Stock Comparison   metrics, correlation and prices CSV, JSON and XLSX from a CSV import
//                      with different holiday calendars: every figure recomputed here from
//                      the input prices (log returns, identical-interval correlation), every
//                      exported price traced to an input row.
//   Portfolio Rebalancer  plan CSV and XLSX (New Money and Rebalance) and the holdings CSV:
//                      every trade recomputed from the holdings, the prices entered and the
//                      Bank of Canada rates the page received; the budget is never exceeded.
//   Monte Carlo        the percentile CSV re-run by the DESKTOP engine from the inputs and
//                      seed the CSV records: same success rate and percentiles.
//   CPI Web Scraper    the CSV: every value equals what Statistics Canada or the (mocked) FRED
//                      gateway sent for that month; months without data stay blank.
// Workbooks are opened with openpyxl (export_readback.py): ZIP CRCs, no formulas, numbers
// stored as numbers.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, CPI_KEY, CPI_GATEWAY, launch, mockMarketData, mockCpiSources, blockExternal, watchNetwork, checker, statcanBody, gatewayObservations } = require("./harness");

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "exports-test-"));
const PY = process.env.PYTHON || "python3";
const HELPER = path.join(__dirname, "export_readback.py");
const DAY = 86400000;
const close = (a, b, rel = 1e-9, abs = 1e-9) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
const py = (...args) => JSON.parse(execFileSync(PY, [HELPER, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

// RFC 4180 reader (quoted cells, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function download(page, selector, name) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  const target = path.join(OUT, name);
  await file.saveAs(target);
  return { target, text: fs.readFileSync(target, "utf8"), bytes: fs.readFileSync(target), suggested: file.suggestedFilename() };
}
const sheetRows = (book, name) => (book.sheets[name] || []).map(r => r.map(c => c.v));

/* ------------------------------------------------------------------ Stock Comparison */
// Three tickers on different calendars, all dates inside the 1Y window and completed.
function stockInput() {
  const days = [];
  for (let t = Date.now() - 290 * DAY; t <= Date.now() - 3 * DAY; t += DAY) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
  }
  const spec = { AAA: [100, "USD", i => i % 17 === 5], "BBB.TO": [40, "CAD", i => i % 23 === 7], CCC: [25, "USD", () => false] };
  const prices = {};
  const lines = ["Date,Ticker,Close,Adj Close,Currency"];
  for (const [ticker, [start, currency, holiday]] of Object.entries(spec)) {
    prices[ticker] = [];
    let p = start;
    days.forEach((day, i) => {
      p *= Math.exp(0.0003 + 0.011 * Math.sin(i * (ticker.length + 0.7)) + 0.004 * Math.cos(i / 3));
      if (holiday(i)) return;
      const price = Number(p.toFixed(4));
      prices[ticker].push([day, price]);
      lines.push(`${day},${ticker},${price},${price},${currency}`);
    });
  }
  return { csv: lines.join("\n") + "\n", prices, currency: { AAA: "USD", "BBB.TO": "CAD", CCC: "USD" } };
}

// Written from the definitions in the methodology, not from the page's code.
function stockReference(prices, rf) {
  const metrics = {};
  const intervals = {};
  for (const [ticker, rows] of Object.entries(prices)) {
    const r = [];
    intervals[ticker] = new Map();
    for (let i = 1; i < rows.length; i += 1) {
      const v = Math.log(rows[i][1] / rows[i - 1][1]);
      r.push(v);
      intervals[ticker].set(`${rows[i - 1][0]}|${rows[i][0]}`, v);
    }
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    let peak = -Infinity;
    let mdd = 0;
    for (const [, p] of rows) { peak = Math.max(peak, p); mdd = Math.min(mdd, p / peak - 1); }
    metrics[ticker] = {
      totalReturn: rows.at(-1)[1] / rows[0][1] - 1, annualizedReturn: Math.exp(mean * 252) - 1, annualizedVolatility: sd * Math.sqrt(252),
      sharpe: (mean * 252 - Math.log(1 + rf)) / (sd * Math.sqrt(252)), maxDrawdown: mdd, returnObservations: r.length, actualStart: rows[0][0], actualEnd: rows.at(-1)[0],
    };
  }
  const matrix = {};
  const counts = {};
  for (const a of Object.keys(prices)) {
    matrix[a] = {}; counts[a] = {};
    for (const b of Object.keys(prices)) {
      const keys = [...intervals[a].keys()].filter(k => intervals[b].has(k));
      const x = keys.map(k => intervals[a].get(k));
      const y = keys.map(k => intervals[b].get(k));
      const mx = x.reduce((s, v) => s + v, 0) / x.length;
      const my = y.reduce((s, v) => s + v, 0) / y.length;
      let sxy = 0; let sxx = 0; let syy = 0;
      x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; });
      counts[a][b] = keys.length;
      matrix[a][b] = sxy / Math.sqrt(sxx * syy);
    }
  }
  return { metrics, matrix, counts };
}

async function stockExports(browser, check) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await mockMarketData(context, {});
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(`${SITE_URL}/projects/stock-data-dashboard-tool/?mdgateway=none`, { waitUntil: "networkidle" });
  await page.waitForSelector('#sdd-app[data-ready="true"]');
  const input = stockInput();
  await page.check('input[name="source"][value="csv"]');
  await page.setInputFiles("#sddCsvFiles", { name: "holiday-calendars.csv", mimeType: "text/csv", buffer: Buffer.from(input.csv) });
  await page.waitForFunction(() => /Loaded 3 tickers/.test(document.querySelector("#sddCompareStatus").textContent));
  await page.selectOption("#sddHorizon", "1Y");
  await page.selectOption("#sddNormalize", "off");
  await page.fill("#sddRiskFree", "4");
  const before = net.external.length;
  await page.click("#sddRunCompare");
  await page.waitForFunction(() => /Comparison complete/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 60000 });
  check(net.external.length === before, "Stock: a CSV comparison makes no network request");
  await page.click("#sddTab-export");
  const ref = stockReference(input.prices, 0.04);
  const tickers = Object.keys(input.prices);

  // Metrics CSV.
  const metricsCsv = await download(page, "#sddExportMetrics", "stock-metrics.csv");
  const mrows = parseCsv(metricsCsv.text);
  const mh = mrows[0];
  check(mh.join(",") === "Ticker,Currency,Price basis,Frequency,Total return,Annualized return,Annualized volatility,Sharpe ratio,Max drawdown,Return observations,Actual start,Actual end,Source,Native currency", "Stock metrics CSV: expected header");
  const col = name => mh.indexOf(name);
  for (const t of tickers) {
    const row = mrows.find(r => r[0] === t);
    const m = ref.metrics[t];
    const ok = row && [["Total return", m.totalReturn], ["Annualized return", m.annualizedReturn], ["Annualized volatility", m.annualizedVolatility], ["Sharpe ratio", m.sharpe], ["Max drawdown", m.maxDrawdown]]
      .every(([name, v]) => close(Number(row[col(name)]), v, 1e-9, 1e-12)) && Number(row[col("Return observations")]) === m.returnObservations
      && row[col("Actual start")] === m.actualStart && row[col("Actual end")] === m.actualEnd && row[col("Currency")] === input.currency[t] && row[col("Frequency")] === "daily";
    check(ok, `Stock metrics CSV: ${t} total/annualized return, volatility, Sharpe (rf 4%, ln basis), drawdown, ${m.returnObservations} returns and dates match an independent calculation`);
  }
  check(mrows.filter(r => r[0] === "#provenance").length >= 4 && /holiday-calendars\.csv|Your CSV file/.test(metricsCsv.text), "Stock metrics CSV: provenance section names the user's file");

  // Correlation CSV: identical intervals.
  const corrRows = parseCsv((await download(page, "#sddExportCorrelation", "stock-correlation.csv")).text);
  const corrOk = tickers.every(a => tickers.every(b => close(Number(corrRows.find(r => r[0] === a)[1 + corrRows[0].indexOf(b) - 1]), ref.matrix[a][b], 1e-9, 1e-12)));
  const sharedStart = corrRows.findIndex(r => r[0] === "Shared returns");
  const countsOk = tickers.every(a => tickers.every(b => Number(corrRows.slice(sharedStart).find(r => r[0] === a)[corrRows[sharedStart].indexOf(b)]) === ref.counts[a][b]));
  check(corrOk && countsOk, `Stock correlation CSV: correlations and shared-interval counts equal the identical-interval reference (AAA/BBB.TO share ${ref.counts.AAA["BBB.TO"]} intervals)`);

  // Prices CSV: every row is an input price, every input price is there.
  const priceRows = parseCsv((await download(page, "#sddExportPrices", "stock-prices.csv")).text).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0]));
  const inputKeys = new Set(tickers.flatMap(t => input.prices[t].map(([d, p]) => `${d}|${t}|${p}`)));
  const exportedKeys = priceRows.map(r => `${r[0]}|${r[1]}|${Number(r[2])}`);
  check(exportedKeys.length === inputKeys.size && exportedKeys.every(k => inputKeys.has(k)), `Stock prices CSV: ${exportedKeys.length} rows, each one an input price on its own date (no filled or invented prices)`);

  // JSON.
  const json = JSON.parse((await download(page, "#sddExportJson", "stock.json")).text);
  const jc = json.comparison;
  const jsonPricesOk = jc.series.every(s => JSON.stringify(s.observations) === JSON.stringify(input.prices[s.ticker]));
  const jsonMetricsOk = jc.metrics.every(m => close(m.sharpe, ref.metrics[m.ticker].sharpe, 1e-9, 1e-12) && close(m.totalReturn, ref.metrics[m.ticker].totalReturn, 1e-9, 1e-12));
  check(jsonPricesOk && jsonMetricsOk && close(jc.matrix.AAA["BBB.TO"], ref.matrix.AAA["BBB.TO"]) && jc.counts.AAA["BBB.TO"] === ref.counts.AAA["BBB.TO"] && jc.riskFree === 0.04,
    "Stock JSON: series identical to the input, metrics and correlation equal the reference, risk-free rate recorded");

  // XLSX.
  const xlsx = await download(page, "#sddExportXlsx", "stock.xlsx");
  const book = py("xlsx", xlsx.target);
  check(book.crcError === null && book.formulas === 0 && book.sheetNames.join("|") === "Read Me & Sources|Executive Summary|Model & Calculations|Portfolio Risk|Raw Data Ingestion", `Stock XLSX: valid ZIP, no formulas, five sheets (${book.sheetNames.join("|")})`);
  const summary = sheetRows(book, "Executive Summary");
  const sh = summary[1];
  const xOk = tickers.every(t => {
    const r = summary.find(x => x[0] === t);
    return r && typeof r[sh.indexOf("Sharpe ratio")] === "number" && close(r[sh.indexOf("Sharpe ratio")], ref.metrics[t].sharpe, 1e-9, 1e-12) && close(r[sh.indexOf("Total return")], ref.metrics[t].totalReturn, 1e-9, 1e-12) && close(r[sh.indexOf("Max drawdown")], ref.metrics[t].maxDrawdown, 1e-9, 1e-12);
  });
  const risk = sheetRows(book, "Portfolio Risk");
  const riskOk = tickers.every(a => tickers.every(b => close(risk.find(r => r[0] === a)[1 + risk[0].indexOf(b) - 1], ref.matrix[a][b], 1e-9, 1e-12)));
  const raw = sheetRows(book, "Raw Data Ingestion").slice(1);
  const rawOk = raw.length === inputKeys.size && raw.every(r => inputKeys.has(`${r[0]}|${r[1]}|${r[2]}`) && typeof r[2] === "number");
  const readMe = sheetRows(book, "Read Me & Sources").flat().filter(v => v !== null).join(" ");
  check(xOk && riskOk && rawOk, "Stock XLSX: summary metrics and correlation are numbers equal to the reference; raw data is exactly the input");
  check(/Price files supplied by the user/.test(readMe) && /aligned on identical intervals \(same dates\)/.test(readMe) && /native currencies, mixed \(CAD, USD\)/.test(readMe), "Stock XLSX: read-me states the source, the identical-interval method and the mixed currencies");
  check(net.errors.length === 0, `Stock: no page errors (${net.errors.join("; ")})`);
  await context.close();
}

/* ------------------------------------------------------------------ Portfolio Rebalancer */
const HOLDINGS = [["VFV.TO", 10, 60, 100, "CAD"], ["AAPL", 5, 30, 200, "USD"], ["SAP.DE", 2, 10, 150, "EUR"]];

// The plan from first principles: value = shares x price x CAD per unit; targets split the
// pool by weight; New Money never sells and never spends more than the budget; Rebalance buys
// only with sell proceeds; trades within 0.01% of the pool are holds.
function planReference(mode, budget, cadPer) {
  const rows = HOLDINGS.map(([t, shares, w, price, cur]) => ({ t, w, value: shares * price * cadPer[cur] }));
  const total = rows.reduce((s, r) => s + r.value, 0);
  const pool = mode === "new_money" ? total + budget : total;
  const weights = rows.reduce((s, r) => s + r.w, 0);
  rows.forEach(r => {
    r.target = r.w / weights * pool;
    r.trade = r.target - r.value;
    if (mode === "new_money" && r.trade <= 0) r.trade = 0;
    if (Math.abs(r.trade) <= pool * 0.0001) r.trade = 0;
  });
  const buys = rows.reduce((s, r) => s + Math.max(0, r.trade), 0);
  const sells = rows.reduce((s, r) => s + Math.max(0, -r.trade), 0);
  const cap = mode === "new_money" ? budget : sells;
  if (buys > cap) rows.forEach(r => { if (r.trade > 0) r.trade *= cap / buys; });
  return { rows, total, pool };
}

function planTable(rows) {
  const start = rows.findIndex(r => r[0] === "Ticker (as entered)");
  const header = rows[start];
  const body = [];
  for (let i = start + 1; i < rows.length && rows[i].length > 1; i += 1) body.push(rows[i]);
  return { header, body, meta: Object.fromEntries(rows.slice(0, start).filter(r => r.length >= 2).map(r => [r[0], r[1]])) };
}

async function rebalancerExports(browser, check) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await mockMarketData(context, {});
  const page = await context.newPage();
  const net = watchNetwork(page);
  const boc = [];
  const reading = [];
  page.on("response", r => { if (/bankofcanada\.ca/.test(r.url())) reading.push(r.json().catch(() => null).then(body => boc.push(body))); });
  await page.goto(`${SITE_URL}/projects/portfolio-rebalancer/?mdgateway=none`, { waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"][data-fx-ready="true"]');
  const holdingsCsv = `ticker,shares,target_pct,account\r\n${HOLDINGS.map(h => `${h[0]},${h[1]},${h[2]},`).join("\r\n")}\r\n`;
  fs.writeFileSync(path.join(OUT, "holdings-in.csv"), holdingsCsv);
  await page.setInputFiles("#rbImportHoldings", path.join(OUT, "holdings-in.csv"));
  await page.waitForFunction(() => /Imported 3 holdings/.test(document.querySelector("#rbStatus").textContent));
  await page.waitForFunction(() => document.querySelectorAll("#rbRows .rb-row .rb-identity:not([hidden])").length === 3);
  for (const [i, h] of HOLDINGS.entries()) {
    const r = page.locator("#rbRows .rb-row").nth(i);
    await r.getByRole("button", { name: /Use my own price|Edit my price/ }).click();
    await r.locator(".rb-mprice").fill(String(h[3]));
    await r.getByRole("button", { name: "Use this price" }).click();
  }
  await page.selectOption("#rbReporting", "CAD");
  await page.selectOption("#rbMode", "new_money");
  await page.fill("#rbBudget", "1000");
  await page.click("#rbRun");
  await page.waitForFunction(() => /Plan includes|Plan ready/.test(document.querySelector("#rbResults").textContent));

  // What the page received from the (mocked) Bank of Canada: the latest fixing per currency.
  await Promise.all(reading);
  const latest = {};
  for (const body of boc.filter(Boolean)) for (const o of body.observations || []) for (const [k, v] of Object.entries(o)) if (/^FX[A-Z]{3}CAD$/.test(k) && v?.v) latest[k.slice(2, 5)] = Number(v.v);
  const cadPer = { CAD: 1, USD: latest.USD, EUR: latest.EUR };

  for (const mode of ["new_money", "rebalance"]) {
    if (mode === "rebalance") {
      await page.selectOption("#rbMode", "rebalance");
      await page.waitForFunction(() => /Plan includes|Plan ready/.test(document.querySelector("#rbResults").textContent));
    }
    const ref = planReference(mode, 1000, cadPer);
    const csv = await download(page, "#rbExportCsv", `plan-${mode}.csv`);
    const rows = parseCsv(csv.text);
    const { header, body, meta } = planTable(rows);
    const c = name => header.indexOf(name);
    const fxStart = rows.findIndex(r => r[0] === "Currency" && r[1] === "CAD per unit");
    const fx = Object.fromEntries(rows.slice(fxStart + 1).filter(r => /^[A-Z]{3}$/.test(r[0])).map(r => [r[0], [Number(r[1]), r[2]]]));
    check(close(fx.USD?.[0], cadPer.USD, 1e-12) && close(fx.EUR?.[0], cadPer.EUR, 1e-12) && /Bank of Canada/.test(fx.USD?.[1] || "") && /Bank of Canada/.test(fx.EUR?.[1] || ""),
      `Rebalancer ${mode} CSV: FX section holds exactly the Bank of Canada rates the page received (USD ${cadPer.USD}, EUR ${cadPer.EUR})`);
    const tradesOk = ref.rows.every(r => {
      const row = body.find(b => b[0] === r.t);
      const h = HOLDINGS.find(x => x[0] === r.t);
      return row && close(Number(row[c("Current value (CAD)")]), r.value, 1e-12) && close(Number(row[c("Target value (CAD)")]), r.target, 1e-12) && close(Number(row[c("Trade value (CAD)")]), r.trade, 1e-9, 1e-9)
        && close(Number(row[c("FX to CAD")]), cadPer[h[4]], 1e-12) && Number(row[c("Price (local)")]) === h[3] && Number(row[c("Shares")]) === h[1]
        && close(Number(row[c("Trade shares")]), r.trade / cadPer[h[4]] / h[3], 1e-9, 1e-12) && /user-supplied/i.test(`${row[c("Price type")]} ${row[c("Price source details")]}`);
    });
    check(tradesOk, `Rebalancer ${mode} CSV: current values, targets, trades and trade shares equal an independent calculation; prices labelled user-supplied`);
    const buys = Number(meta["Total buys"]);
    const sells = Number(meta["Total sells"]);
    const capOk = mode === "new_money" ? buys <= 1000 + 1e-9 && close(buys, 1000, 1e-12) && sells === 0 : buys <= sells + 1e-9 && sells > 0;
    check(capOk && close(Number(meta["Total current"]), ref.total, 1e-12) && close(Number(meta["Target pool"]), ref.pool, 1e-12) && /Includes 3 user-supplied price/.test(meta.Prices || ""),
      `Rebalancer ${mode} CSV: totals (current ${Number(meta["Total current"]).toFixed(2)}, buys ${buys}, sells ${sells}) are consistent and within the ${mode === "new_money" ? "budget" : "sell proceeds"}`);
    const xlsx = await download(page, "#rbExportXlsx", `plan-${mode}.xlsx`);
    const book = py("xlsx", xlsx.target);
    const sheet = sheetRows(book, "Trade Plan");
    const xh = sheet[0];
    const sameAsCsv = sheet.slice(1).every(r => {
      const csvRow = body.find(b => b[0] === r[0]);
      return csvRow && ["Current value (CAD)", "Target value (CAD)", "Trade value (CAD)", "FX to CAD", "Trade shares"].every(n => typeof r[xh.indexOf(n)] === "number" && close(r[xh.indexOf(n)], Number(csvRow[c(n)]), 1e-15, 1e-12));
    });
    check(book.crcError === null && book.formulas === 0 && sheet.length === HOLDINGS.length + 1 && sameAsCsv, `Rebalancer ${mode} XLSX: valid, no formulas, the same numbers as the CSV, stored as numbers`);
  }
  check(!/TESTKEY|MSTESTKEY|FHTESTKEY/.test(fs.readdirSync(OUT).filter(f => f.startsWith("plan-")).map(f => fs.readFileSync(path.join(OUT, f), "latin1")).join("")), "Rebalancer exports contain no key");
  await page.locator(".rb-csv > summary").click();
  const holdings = await download(page, "#rbExportHoldings", "holdings-out.csv");
  check(holdings.text === holdingsCsv, "Rebalancer holdings CSV: exactly the holdings imported (round trip)");
  check(net.errors.length === 0, `Rebalancer: no page errors (${net.errors.join("; ")})`);
  await context.close();
}

/* ------------------------------------------------------------------ Monte Carlo */
async function monteCarloExports(browser, check) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await blockExternal(context);
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(`${SITE_URL}/projects/monte-carlo-simulator/`, { waitUntil: "networkidle" });
  await page.waitForSelector('#mc-app[data-ready="true"]');
  for (const [basis, seed, sims] of [["retirement", "20261123", "1500"], ["today", "7", "800"]]) {
    await page.selectOption("#mc-spendingBasis", basis);
    await page.fill("#mc-seed", seed);
    await page.fill("#mc-simulations", sims);
    await page.click("#mcRun");
    // This run's own seed in the run line: the previous run's "complete" status never counts.
    await page.waitForFunction(s => !document.querySelector("#mcRun").disabled && /simulations complete/.test(document.querySelector("#mcStatus").textContent)
      && new RegExp(`seed ${s}\\b`).test(document.querySelector("#mcMeta").textContent), seed, { timeout: 60000 });
    const csv = await download(page, "#mcExportCsv", `mc-${basis}.csv`);
    const rows = parseCsv(csv.text);
    const desktop = py("mc", csv.target);
    const success = Number(rows.find(r => r[0] === "Probability of success (%)")[1]);
    const failed = Number(rows.find(r => r[0] === "Failed simulations")[1]);
    const head = rows.findIndex(r => r[0] === "Year");
    const years = rows.slice(head + 1).filter(r => /^\d+$/.test(r[0]));
    const keys = ["p10", "p25", "p50", "p75", "p90"];
    const bandsOk = years.length === desktop.nominal.p50.length && years.every(r => {
      const y = Number(r[0]);
      return keys.every((k, i) => close(Number(r[1 + i]), desktop.nominal[k][y], 1e-9, 1e-6) && close(Number(r[6 + i]), desktop.real[k][y], 1e-9, 1e-6));
    });
    check(csv.bytes[0] === 0xEF && desktop.seed === Number(seed) && close(success, desktop.successProbability, 1e-12) && failed === desktop.failed,
      `Monte Carlo CSV (${basis} basis, seed ${seed}): the desktop engine re-run from the CSV's recorded inputs and seed gives the same success rate (${success}%) and failures (${failed})`);
    check(bandsOk, `Monte Carlo CSV (${basis} basis): every year's P10-P90, nominal and real, equals the desktop engine's (${years.length} years)`);
  }
  check(net.external.length === 0 && net.errors.length === 0, `Monte Carlo: no external request, no page errors (${net.errors.join("; ")})`);
  await context.close();
}

/* ------------------------------------------------------------------ CPI */
const STATCAN_COLUMNS = [41690973, 41690914, 41691233, 41690924, 41692327];
const FRED_COLUMNS = { "Headline CPI - Unadjusted US": "CPIAUCNS", "Headline CPI - Seasonally Adjusted US": "CPIAUCSL", "Core CPI - Unadjusted US": "CPILFENS", "Core CPI - Seasonally Adjusted US": "CPILFESL",
  "Unemployment Rate - Seasonally Adjusted US": "UNRATE", "Monthly Effective Fed Fund Rate US": "FEDFUNDS", "10-Year Treasury Yield - Monthly Average US": "GS10", "2-Year Treasury Yield - Monthly Average US": "GS2",
  "PCE - Seasonally Adjusted US": "PCEPI", "Core PCE - Seasonally Adjusted US": "PCEPILFE" };

async function cpiExports(browser, check) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const calls = await mockCpiSources(context, {});
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(`${SITE_URL}/projects/cpi-webscraper/?gateway=${encodeURIComponent(CPI_GATEWAY)}`, { waitUntil: "networkidle" });
  await page.waitForSelector('#cpi-app[data-ready="true"]');
  await page.fill("#cpiKey", CPI_KEY);
  await page.check('input[name="cpiMode"][value="range"]');
  const now = new Date();
  for (const [id, v] of [["#cpiYear", "2021"], ["#cpiMonth", "7"], ["#cpiYear2", String(now.getFullYear())], ["#cpiMonth2", String(now.getMonth() + 1)]]) await page.fill(id, v);
  await page.click("#cpiFetch");
  await page.waitForFunction(() => document.querySelector("#cpi-app").getAttribute("aria-busy") === "false" && !/^Fetching/.test(document.querySelector("#cpiStatus").textContent), null, { timeout: 60000 });
  const csv = await download(page, "#cpiCsv", "cpi.csv");
  // What each source sent: the fixture answer to every request the page actually made.
  const statcan = {};
  const fred = {};
  for (const search of calls.statcan) {
    for (const v of JSON.parse(statcanBody(new URL(`https://www150.statcan.gc.ca/x${search}`)))) {
      for (const p of v.object.vectorDataPoint) (statcan[v.object.vectorId] ||= {})[p.refPer.slice(0, 7)] = p.value;
    }
  }
  for (const c of calls.gateway.filter(x => x.path === "/v1/observations")) {
    const body = gatewayObservations(c.body);
    for (const o of body.observations) if (o.value !== ".") (fred[body.series_id] ||= {})[o.date.slice(0, 7)] = Number(o.value);
  }
  const rows = parseCsv(csv.text);
  const header = rows[0];
  const data = rows.slice(1).filter(r => r.length > 1);
  let compared = 0;
  let mismatches = [];
  for (const r of data) {
    const ym = r[0].slice(0, 7);
    STATCAN_COLUMNS.forEach((vector, i) => {
      const expected = statcan[vector]?.[ym];
      const cell = r[1 + i];
      if (expected === undefined ? cell !== "" : Number(cell) !== expected) mismatches.push(`${ym} ${header[1 + i]}: ${cell} vs ${expected}`);
      else if (cell !== "") compared += 1;
    });
    for (const [name, id] of Object.entries(FRED_COLUMNS)) {
      const expected = fred[id]?.[ym];
      const cell = r[header.indexOf(name)];
      if (expected === undefined ? cell !== "" : Number(cell) !== expected) mismatches.push(`${ym} ${name}: ${cell} vs ${expected}`);
      else if (cell !== "") compared += 1;
    }
  }
  check(header.length === 19 && data.length > 60 && mismatches.length === 0 && compared > 500,
    `CPI CSV: ${compared} Statistics Canada and FRED monthly values equal what the sources sent; months without data stay blank${mismatches.length ? ` (mismatches: ${mismatches.slice(0, 4).join("; ")}; FRED series captured: ${Object.keys(fred).join(",")})` : ""}`);
  check(!csv.text.includes(CPI_KEY) && csv.text.endsWith("\r\n") && csv.bytes[0] !== 0xEF, "CPI CSV: no key, CRLF rows, UTF-8 without BOM");
  check(net.errors.length === 0, `CPI: no page errors (${net.errors.join("; ")})`);
  await context.close();
}

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  for (const [name, run] of [["Stock", stockExports], ["Rebalancer", rebalancerExports], ["Monte Carlo", monteCarloExports], ["CPI", cpiExports]]) {
    try { await run(browser, check); } catch (error) { check(false, `${name} export readback crashed: ${String(error.stack || error).slice(0, 400)}`); }
  }
  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
