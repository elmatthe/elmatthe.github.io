// Browser test: Stock Comparison & Analytics web app (visitor-key live data, CSV
// import, offline demo, official-rate FX normalization, exports, failure paths).
// The page is opened as if no data gateway were configured (?mdgateway=none), so
// Alpha Vantage with the visitor's key is the only history source; Yahoo Finance and
// the source order are covered by freesource.test.js and sources.test.js.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, TEST_KEY, launch, mockMarketData, watchNetwork, checker, disallowedRequests } = require("./harness");

const PAGE = `${SITE_URL}/projects/stock-data-dashboard-tool/?mdgateway=none`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "stock-test-"));
const DAY = 86400000;

// Synthetic one-year daily CSV in the desktop app's combined format.
function sampleCsv() {
  const lines = ["Date,Ticker,Close,Adj Close,Currency"];
  const tickers = [["AAA", 100, "USD"], ["BBB.TO", 40, "CAD"], ["CCC", 25, "USD"]];
  const end = Date.now() - 2 * DAY;
  for (const [ticker, start, currency] of tickers) {
    let price = start;
    for (let t = end - 400 * DAY, i = 0; t <= end; t += DAY, i += 1) {
      const wd = new Date(t).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      price *= Math.exp(0.0004 + 0.012 * Math.sin(i * (ticker.length + 1.3)));
      lines.push(`${new Date(t).toISOString().slice(0, 10)},${ticker},${price.toFixed(4)},${(price * 0.99).toFixed(4)},${currency}`);
    }
  }
  return lines.join("\n") + "\n";
}

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const mode = {};
  const calls = await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  const status = () => page.locator("#sddCompareStatus").innerText();
  const waitCompare = () => page.waitForFunction(() => !document.querySelector("#sddRunCompare").disabled && !/Loaded|Requesting|Reading|Generating|Normalizing/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 120000 });

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#sdd-app[data-ready="true"]');
  check(await page.evaluate(() => typeof window.Chart === "function"), "Chart.js loaded");
  check(await page.locator(".pj-localnav a").count() === 6, "sticky on-page navigation rendered");
  check(calls.av.length === 0 && calls.boc === 0, "no market-data request on page load");

  // Live without a key: explained, no request.
  await page.click("#sddRunCompare");
  await waitCompare();
  check(/No market-data source is available/.test(await page.locator("#sddCompareNotice").innerText()) && /Alpha Vantage: no key saved/.test(await page.locator("#sddCompareNotice").innerText()) && /Marketstack: latest prices only, not used for comparisons/.test(await page.locator("#sddCompareNotice").innerText()) && calls.av.length === 0, "a run without any usable source explains how to proceed, per source, and makes no request");

  // Invalid input never reaches the network.
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(2) input", "MS FT$");
  await page.click("#sddRunCompare");
  check(await page.locator(".sdd-row-error").count() === 1 && calls.av.length === 0, "invalid ticker shows a row error and makes no request");

  // Save a key in Settings.
  await page.click("#sddTab-settings");
  await page.fill("#sddKey", TEST_KEY);
  await page.click("#sddKeyForm button[type=submit]");
  check(/kept for this tab only/.test(await page.locator("#sddKeyStatus").innerText())
    && await page.evaluate(k => sessionStorage.getItem("md.key.v2.alphavantage") === k && !JSON.stringify(localStorage).includes(k), TEST_KEY), "key kept for this tab only by default");
  check(/kept for this tab only[\s\S]*Alpha Vantage is switched on at position 2 of 4, after Yahoo Finance/.test(await page.locator("#sddKeyStatus").innerText()), `saving the key switches Alpha Vantage on below Yahoo Finance (${await page.locator("#sddKeyStatus").innerText()})`);
  check(/Alpha Vantage/.test(await page.locator("#sddPipelineState").innerText()), "masthead names the source tried first (Alpha Vantage, as Yahoo Finance is unavailable here)");
  await page.click("#sddTab-compare");

  // 1Y live comparison: weekly adjusted closes, one unknown ticker, normalized to USD.
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(2) input", "msft");
  await page.click("#sddAddTicker");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(4) input", "XIU.TO");
  await page.click("#sddAddTicker");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(5) input", "ZZZNOPE");
  await page.selectOption("#sddNormalize", "USD");
  await page.fill("#sddRiskFree", "3");
  await page.click("#sddRunCompare");
  await waitCompare();
  check(/Comparison complete: 4 securities, 1Y, weekly prices/.test(await status()), `1Y live comparison completes with weekly prices (${await status()})`);
  check(await page.locator("#sddMetricsTable tbody tr").count() === 4, "four usable tickers compared (AAPL, MSFT, SPY, XIU.TO)");
  check(/ZZZNOPE: no data/.test(await page.locator("#sddTickerProgress").innerText()), "unknown ticker reported, others continue");
  check(calls.av.some(c => c === "TIME_SERIES_WEEKLY_ADJUSTED:XIU.TRT"), "TSX ticker requested as XIU.TRT weekly adjusted");
  const meta = await page.locator("#sddCompareMeta").innerText();
  check(/weekly prices \(52 periods per year\)/.test(meta) && /normalized to USD/.test(meta), `metadata states frequency and normalization (${meta.slice(0, 120)})`);
  check(/Adjusted close/.test(await page.locator("#sddMetricsTable tbody tr:first-child").innerText()), "price basis shown per ticker");
  const fxNote = await page.locator("#sddCompareWarnings").innerText();
  check(/CAD→USD from Bank of Canada daily rates/.test(fxNote), `FX normalization uses official rates (${fxNote.split("\n")[0]})`);
  check(calls.boc >= 1, "Bank of Canada history requested for normalization");
  check(await page.locator("#sddCorrelation td.sdd-corr-cell").count() === 16, "4x4 correlation heatmap");
  check(await page.locator("#sddRegression tbody tr").count() === 3, "regression rows");
  check(/alpha annualized × 52/.test(await page.locator("#sddRegression").innerText()), "regression annualizes weekly alpha by 52");
  check(/Alpha Vantage/.test(await page.locator("#sddCompareSources").innerText()), "sources list names the provider");

  // Re-run: served from this browser's cache.
  const avCount = calls.av.length;
  await page.click("#sddRunCompare");
  await waitCompare();
  check(calls.av.length === avCount, `re-run served from cache, including the remembered unknown ticker (new requests: ${calls.av.slice(avCount).join(", ") || "none"})`);
  check(/cached/.test(await page.locator("#sddTickerProgress").innerText()), "cached tickers labelled");

  // 1M: daily closes as traded; adjusted not available -> explicit fallback warning.
  await page.selectOption("#sddHorizon", "1M");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(5) input", "^GSPC");
  await page.click("#sddRunCompare");
  await waitCompare();
  check(/1M, daily prices/.test(await status()), `1M uses daily prices (${await status()})`);
  check(calls.av.some(c => c === "TIME_SERIES_DAILY:AAPL"), "daily series requested for a short window");
  check(/no adjusted closes; unadjusted closes/.test(await page.locator("#sddCompareWarnings").innerText()), "fallback from adjusted to plain closes is stated");
  check(/plain closes \(price return\); adjusted closes were requested but are not available/.test(await page.locator("#sddCompareMeta").innerText()),
    "metadata reports the price basis actually used, not the one requested");
  check(/windows up to about 4 months use daily closes as traded/.test(await page.locator("#sddCompareWarnings").innerText()),
    "live results explain that the window decides frequency and price basis");
  check(/\^GSPC: market indexes are not available from these sources/.test(await page.locator("#sddCompareNotice").innerText()), "index symbol explained as unavailable");
  check(!calls.av.some(c => /\^GSPC/.test(c)), "no request made for an index symbol");

  // Exports.
  await page.selectOption("#sddHorizon", "1Y");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(5) input", "");
  await page.click("#sddRunCompare");
  await waitCompare();
  await page.click("#sddTab-export");
  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.click("#sddExportXlsx")]);
  const xlsxPath = path.join(OUT, "export.xlsx");
  await xlsx.saveAs(xlsxPath);
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#sddExportMetrics")]);
  const csvPath = path.join(OUT, "metrics.csv");
  await csv.saveAs(csvPath);
  check(fs.readFileSync(csvPath, "utf8").startsWith("Ticker,Currency,Price basis,Frequency,Total return"), "metrics CSV downloaded with basis and frequency");
  try {
    const out = execFileSync(process.env.PYTHON || "python3", ["-c",
      "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);ws=wb['Read Me & Sources'];print('|'.join(wb.sheetnames));print(' '.join(str(c.value) for r in ws.iter_rows() for c in r if c.value))", xlsxPath]).toString().trim().split("\n");
    check(out[0] === "Read Me & Sources|Executive Summary|Model & Calculations|Portfolio Risk|Raw Data Ingestion", `XLSX opens cleanly with five sheets (${out[0]})`);
    check(/Alpha Vantage, fetched with the user's own API key/.test(out[1]) && /weekly log returns/.test(out[1]) && /52 periods per year/.test(out[1]), "workbook read-me states source, frequency and annualization");
    check(/Data note/.test(out[1]) && /windows up to about 4 months use daily closes as traded/.test(out[1]) && /Native currency/.test(out[1]) && /Converted from CAD/.test(out[1]), "workbook read-me states the live-data basis note and each ticker's currency conversion");
    check(/Source order \(first tried first\) 1\. Yahoo Finance; 2\. Alpha Vantage; 3\. Marketstack \(off\); 4\. Finnhub \(off\)/.test(out[1]) && /Sources tried first/.test(out[1]) && /Yahoo Finance: not available on this site yet/.test(out[1]), "workbook read-me records the source order and why Yahoo Finance was skipped");
    check(!out.join(" ").includes(TEST_KEY) && !fs.readFileSync(csvPath, "utf8").includes(TEST_KEY), "exports never contain the API key");
  } catch (error) {
    check(false, `XLSX validation via openpyxl: ${String(error.message).slice(0, 160)}`);
  }

  // Snapshot (Canadian ETF via the key).
  await page.click("#sddTab-snapshot");
  await page.fill("#sddSnapshotTicker", "xiu.to");
  await page.click("#sddSnapshotRun");
  await page.waitForSelector("#sddSnapshotResult:not([hidden])", { timeout: 60000 });
  const ident = await page.locator("#sddSnapshotIdentity").innerText();
  check(/XIU\.TO/.test(await page.locator("#sddSnapshotTitle").innerText()) && /CAD/.test(ident) && /Toronto/.test(ident), "snapshot for a .TO ticker shows CAD and the Toronto listing");
  check(/\d{4}-\d{2}-\d{2}/.test(await page.locator("#sddSnapshotMarket").innerText()), "snapshot shows the price date");

  // CSV import: no network at all without normalization.
  await page.click("#sddTab-compare");
  await page.check('input[name="source"][value="csv"]');
  await page.setInputFiles("#sddCsvFiles", { name: "my-prices.csv", mimeType: "text/csv", buffer: Buffer.from(sampleCsv()) });
  await page.waitForFunction(() => /Loaded 3 tickers/.test(document.querySelector("#sddCompareStatus").textContent));
  check(await page.locator("#sddTickerList input").count() === 3, "imported tickers listed");
  await page.selectOption("#sddNormalize", "off");
  const externalBeforeCsv = net.external.length;
  await page.click("#sddRunCompare");
  await waitCompare();
  check(/Comparison complete: 3 securities, 1Y, daily prices/.test(await status()), `CSV comparison completes (${await status()})`);
  check(net.external.length === externalBeforeCsv, "CSV comparison makes no network request");
  check(/Your CSV file/.test(await page.locator("#sddCompareMeta").innerText()) && /my-prices\.csv/.test(await page.locator("#sddCompareSources").innerText()), "CSV source and file name shown");
  check(/Mixed currencies \(CAD, USD\)/.test(await page.locator("#sddCompareWarnings").innerText()), "mixed-currency comparison warned when not normalized");
  // Normalization with the Bank of Canada down: the ECB fallback is used and named.
  mode.bocDown = true;
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("md.fx")).forEach(k => localStorage.removeItem(k)));
  await page.selectOption("#sddNormalize", "USD");
  await page.click("#sddRunCompare");
  await waitCompare();
  check(/CAD→USD from European Central Bank daily rates/.test(await page.locator("#sddCompareWarnings").innerText()), "FX falls back to the ECB when the Bank of Canada is down");
  mode.bocDown = false;
  // A currency neither central bank publishes is left in its own currency and the result says so.
  const ars = ["Date,Close,Adj Close,Currency", ...sampleCsv().split("\n").filter(l => l.includes(",CCC,")).map(l => { const [d, , c, a] = l.split(","); return `${d},${c},${a},ARS`; })].join("\n");
  await page.setInputFiles("#sddCsvFiles", [
    { name: "my-prices.csv", mimeType: "text/csv", buffer: Buffer.from(sampleCsv()) },
    { name: "DDD.BA.csv", mimeType: "text/csv", buffer: Buffer.from(ars) },
  ]);
  await page.waitForFunction(() => /Loaded 4 tickers/.test(document.querySelector("#sddCompareStatus").textContent));
  await page.click("#sddRunCompare");
  await waitCompare();
  const leftOutMeta = await page.locator("#sddCompareMeta").innerText();
  check(/normalized to USD \(left out, not convertible: DDD\.BA\)/.test(leftOutMeta) && /CAD→USD/.test(await page.locator("#sddCompareWarnings").innerText()),
    `an unconvertible currency is left out of the USD comparison and named (${leftOutMeta.slice(0, 160)})`);
  check(/DDD\.BA: no ARS→USD exchange rates/.test(await page.locator("#sddCompareNotice").innerText()) && /3 securities/.test(await status()),
    "the skipped ticker is explained; the other three are compared");
  check(!/DDD\.BA/.test(await page.locator("#sddMetricsTable").innerText()) && !/DDD\.BA/.test(await page.locator("#sddCorrelation").innerText()),
    "no metric, ranking or correlation is shown for the unconverted series");
  check(/USD \(from CAD\)/.test(await page.locator("#sddMetricsTable").innerText()), "converted series show their native currency");
  // A malformed file is rejected with its line number.
  await page.setInputFiles("#sddCsvFiles", { name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Ticker,Close\n2024-01-02,AAA,abc\n") });
  await page.waitForFunction(() => /Could not read the file/.test(document.querySelector("#sddCompareStatus").textContent));
  check(/line 2/.test(await status()), "malformed CSV rejected with a line number");

  // Rate limit, then the offline demo with no requests.
  await page.check('input[name="source"][value="market"]');
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("md.av.")).forEach(k => localStorage.removeItem(k)));
  Object.assign(mode, { avLimit: 2, avCalls: 0 });
  await page.click("#sddRunCompare");
  await waitCompare();
  const noticeText = await page.locator("#sddCompareNotice").innerText();
  check(/Alpha Vantage: daily limit reached/.test(noticeText), `quota exhaustion is shown, not hidden (${noticeText.slice(0, 200)})`);
  check(!/of 25/.test(await page.locator("#sdd-app, body").first().innerText()), "no 'N of 25 used' wording");
  check(await page.locator("#sddCompareResult").isHidden() && await page.locator("#sddExportXlsx").isDisabled(), "failed run hides the superseded result and disables exports");
  const avAfterLimit = calls.av.length;
  const externalBeforeDemo = net.external.length;
  await page.locator("#sddCompareNotice button", { hasText: "Use offline demo" }).click();
  await page.waitForFunction(() => /Comparison complete: 4 securities/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 30000 });
  check(net.external.length === externalBeforeDemo && calls.av.length === avAfterLimit, "offline demo makes no network request");
  check(/Synthetic demo/.test(await page.locator("#sddCompareMeta").innerText()), "demo results labelled synthetic");
  mode.avLimit = undefined;

  // Remove the key.
  await page.click("#sddTab-settings");
  await page.click("#sddKeyRemove");
  check(await page.evaluate(k => !JSON.stringify(localStorage).includes(k) && !JSON.stringify(sessionStorage).includes(k), TEST_KEY), "removing the key deletes it from both storages");
  check(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("md.av.") && !k.endsWith(".usage")).length === 0), "responses fetched with the removed key are deleted");
  check(await page.evaluate(() => [...document.querySelectorAll("script[src^='http']")].every(s => /^sha384-/.test(s.integrity) && s.crossOrigin === "anonymous")), "every third-party script is pinned with Subresource Integrity");

  // Split-affected unadjusted closes are left out; 1D is not annualized; layout matrix.
  await page.click("#sddTab-settings");
  await page.fill("#sddKey", TEST_KEY);
  await page.click("#sddKeyForm button[type=submit]");
  await page.click("#sddTab-compare");
  await page.check('input[name="source"][value="market"]');
  Object.assign(mode, { avLimit: undefined, avCalls: 0 });
  const rows = page.locator("#sddTickerList .sdd-ticker-row input");
  for (let i = 0; i < await rows.count(); i += 1) await rows.nth(i).fill(["SPLITX", "AAPL", "MSFT"][i] || "");
  await page.selectOption("#sddHorizon", "3M");
  check(/This run needs \d/.test(await page.locator("#sddEstimate").innerText()) && /free plan allows 25 per day/.test(await page.locator("#sddEstimate").innerText()), `request estimate shown before a live run (${await page.locator("#sddEstimate").innerText()})`);
  await page.click("#sddRunCompare");
  await waitCompare();
  const splitText = await page.locator("#sddCompareWarnings").innerText();
  check(/SPLITX was left out: its unadjusted closes move by a split-like ratio \(-33\.\d% on \d{4}-\d{2}-\d{2}, like a 3-for-2 split\)/.test(splitText), `a 3-for-2 split on as-traded closes excludes the ticker with the reason (${splitText.slice(0, 200)})`);
  check(!(await page.locator("#sddMetricsTable tbody").innerText()).includes("SPLITX"), "the excluded ticker has no metrics row");
  check(/≈/.test(await page.locator("#sddMetricsTable tbody").innerText()) && /less than six months/.test(splitText), "3M annualized figures are marked ≈ with a caveat");
  await page.selectOption("#sddHorizon", "1D");
  await page.click("#sddRunCompare");
  await waitCompare();
  const oneDay = await page.locator("#sddMetricsTable tbody tr").first().innerText();
  check(!/%[\s\S]*%[\s\S]*%[\s\S]*%[\s\S]*%/.test(oneDay.split("\n").slice(3, 5).join(" ")) || /—/.test(oneDay), `1D: no annualized return or Sharpe (${oneDay.replace(/\s+/g, " ").slice(0, 120)})`);
  for (const width of [360, 390, 768, 853, 911, 1093, 1280, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      inner: [...document.querySelectorAll("#sdd-app *")].filter(n => n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX) && n.offsetParent).map(n => n.id || n.className).slice(0, 3) }));
    check(m.scroll <= m.client && !m.inner.length, `${width}px: no horizontal scrolling (${m.scroll}/${m.client}${m.inner.length ? `; inner: ${m.inner.join(", ")}` : ""})`);
  }

  // Demo series carry a known currency: no false "did not confirm" warnings.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.check('input[name="source"][value="demo"]');
  await page.selectOption("#sddHorizon", "1Y");
  await page.click("#sddRunCompare");
  await waitCompare();
  check(!/did not confirm the listing currency/.test(await page.locator("#sddCompareWarnings").innerText()), "demo run has no false currency warnings");

  const disallowed = disallowedRequests(net.external);
  check(disallowed.length === 0 && calls.blocked.length === 0, `only the central banks and the chosen providers were contacted (no CDN)${disallowed.length ? ": " + disallowed.slice(0, 3).join(" ") : ""}`);
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
