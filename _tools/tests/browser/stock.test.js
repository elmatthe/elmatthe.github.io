// Browser test: Stock Comparison & Analytics web app (Yahoo-only data path).
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, launch, mockProxies, watchNetwork, checker } = require("./harness");

const PAGE = `${SITE_URL}/projects/stock-data-dashboard-tool/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "stock-test-"));

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const mode = { working: ["allorigins-json"] };
  const { calls, targets } = await mockProxies(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#sdd-app[data-ready="true"]');
  check(await page.evaluate(() => typeof window.Chart === "function"), "Chart.js loaded");
  check(await page.locator(".pj-localnav a").count() === 6, "sticky on-page navigation rendered");

  // Invalid input never reaches the network.
  const before = calls.length;
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(2) input", "MS FT$");
  await page.click("#sddRunCompare");
  check(await page.locator(".sdd-row-error").count() === 1, "invalid ticker shows a row error");
  check(calls.length === before, "invalid input makes no request");

  // Live comparison: US + Canadian tickers, one unknown, normalized to USD with Yahoo FX.
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(2) input", "msft");
  await page.click("#sddAddTicker");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(4) input", "XIU.TO");
  await page.click("#sddAddTicker");
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(5) input", "ZZZNOPE");
  await page.selectOption("#sddNormalize", "USD");
  await page.fill("#sddRiskFree", "3");
  await page.click("#sddRunCompare");
  await page.waitForFunction(() => /Comparison complete/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 90000 });
  check(await page.locator("#sddMetricsTable tbody tr").count() === 4, "four usable tickers compared (AAPL, MSFT, SPY, XIU.TO)");
  check(calls.slice(0, 3).join(",") === "corsproxy,allorigins-raw,allorigins-json", `proxy fallback order (${calls.slice(0, 3).join(",")})`);
  check(/ZZZNOPE: no data/.test(await page.locator("#sddTickerProgress").innerText()), "unknown ticker reported, others continue");
  const fxNote = await page.locator("#sddCompareWarnings").innerText();
  check(/CAD→USD from Yahoo Finance CADUSD=X/.test(fxNote), `Yahoo FX normalization (${fxNote.split("\n")[0]})`);
  check(targets.some(t => /chart\/CADUSD%3DX|chart\/CADUSD=X/.test(t)), "FX fetched as Yahoo CADUSD=X");
  check(await page.locator("#sddCorrelation td.sdd-corr-cell").count() === 16, "4x4 correlation heatmap");
  check(await page.locator("#sddRegression tbody tr").count() === 3, "regression rows");
  const n = calls.length;
  await page.click("#sddRunCompare");
  await page.waitForFunction(() => /Comparison complete/.test(document.querySelector("#sddCompareStatus").textContent));
  check(/cached/.test(await page.locator("#sddTickerProgress").innerText()), "re-run served from cache");
  check(calls.slice(n).every(c => c === "allorigins-json"), "re-run skips failed proxies");

  // Exports.
  await page.click("#sddTab-export");
  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.click("#sddExportXlsx")]);
  const xlsxPath = path.join(OUT, "export.xlsx");
  await xlsx.saveAs(xlsxPath);
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#sddExportMetrics")]);
  const csvPath = path.join(OUT, "metrics.csv");
  await csv.saveAs(csvPath);
  check(fs.readFileSync(csvPath, "utf8").startsWith("Ticker,Currency,Total return"), "metrics CSV downloaded");
  try {
    const out = execFileSync(process.env.PYTHON || "python3", ["-c",
      "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);print('|'.join(wb.sheetnames))", xlsxPath]).toString().trim();
    check(out === "Read Me & Sources|Executive Summary|Model & Calculations|Portfolio Risk|Raw Data Ingestion", `XLSX opens cleanly with five sheets (${out})`);
  } catch (error) {
    check(false, `XLSX validation via openpyxl: ${String(error.message).slice(0, 160)}`);
  }

  // Snapshot tab (Canadian ETF).
  await page.click("#sddTab-snapshot");
  await page.fill("#sddSnapshotTicker", "xiu.to");
  await page.click("#sddSnapshotRun");
  await page.waitForSelector("#sddSnapshotResult:not([hidden])", { timeout: 60000 });
  check(/XIU\.TO/.test(await page.locator("#sddSnapshotTitle").innerText()) && /CAD/.test(await page.locator("#sddSnapshotIdentity").innerText()), "snapshot for a .TO ticker shows CAD");

  // Total outage, then offline demo with no requests.
  mode.down = true;
  await page.click("#sddTab-settings");
  await page.click("#sddProxyReset");
  await page.click("#sddClearCache");
  await page.click("#sddTab-compare");
  await page.click("#sddRunCompare");
  await page.waitForFunction(() => !document.querySelector("#sddRunCompare").disabled && !/Loaded|Requesting|Retrying/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 90000 });
  check(/Live data could not be reached/.test(await page.locator("#sddCompareNotice").innerText()), "all-proxies-down notice");
  check(await page.locator("#sddCompareResult").isHidden(), "failed run hides the previous (superseded) comparison");
  check(await page.locator("#sddExportXlsx").isDisabled(), "exports disabled after a failed run (no stale export)");
  const outageText = await page.locator("#sddCompareNotice").innerText();
  check(/Retry/.test(outageText) && /Use offline demo/.test(outageText) && !/add your own proxy/i.test(outageText), "outage notice offers Retry + offline demo without requiring proxy setup");
  const externalBeforeDemo = net.external.length;
  await page.locator("#sddCompareNotice button", { hasText: "Use offline demo" }).click();
  await page.waitForFunction(() => /Comparison complete: 4 securities/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 30000 });
  check(net.external.length === externalBeforeDemo, "offline demo makes no network request");
  mode.down = false;

  // Settings.
  await page.click("#sddTab-settings");
  check(await page.locator("#sddProxyRows tr").count() === 7, "seven proxy rows listed");
  await page.fill("#sddCustomProxy", "http://evil.example/?u=");
  await page.click("#sddProxySettings button[type=submit]");
  check(/https URL containing \{url\}/.test(await page.locator("#sddProxySettingsStatus").innerText()), "invalid proxy template rejected");

  // Mobile layout.
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, "no horizontal scroll at 390px");

  // Provenance of every external request: Chart.js CDN, or a proxy relaying finance.yahoo.com.
  const disallowed = net.external.filter(url => {
    const host = new URL(url).hostname;
    if (host === "cdn.jsdelivr.net") return false;
    if (/corsproxy\.io|allorigins\.win|codetabs\.com|cors\.lol/.test(host)) return !/finance\.yahoo\.com/.test(decodeURIComponent(url));
    return true;
  });
  check(disallowed.length === 0, `only Yahoo Finance (via proxies) and the Chart.js CDN were contacted${disallowed.length ? ": " + disallowed.slice(0, 3).join(" ") : ""}`);
  check(!targets.some(t => t.startsWith("NON-YAHOO")), "every proxied target was a Yahoo chart URL");
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
