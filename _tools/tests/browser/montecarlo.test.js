// Browser test: Monte Carlo Retirement Simulator web app (local-only, no data requests).
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { SITE_URL, launch, watchNetwork, checker } = require("./harness");

const PAGE = `${SITE_URL}/projects/monte-carlo-simulator/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "mc-test-"));

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const net = watchNetwork(page);
  const status = () => page.locator("#mcStatus").innerText();
  const runAndWait = async () => {
    await page.click("#mcRun");
    await page.waitForFunction(() => !document.querySelector("#mcRun").disabled && !/Running/.test(document.querySelector("#mcStatus").textContent), null, { timeout: 60000 });
  };

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#mc-app[data-ready="true"]');
  check(await page.evaluate(() => typeof window.Chart === "function"), "Chart.js loaded");

  await runAndWait();
  check(/Done\. 1,000 simulations complete/.test(await status()), "default run completes");
  const tiles = await page.locator("#mcTiles .pj-tile").allInnerTexts();
  check(tiles.length === 8 && /Probability of success\s*\n?\s*\d+\.\d%/.test(tiles[0]), `summary tiles rendered (${tiles[0].replace(/\s+/g, " ")})`);
  check(await page.locator("#mcTable tbody tr").count() >= 7, "checkpoint table rendered");
  check(await page.evaluate(() => { const c = document.querySelector("#mcChart"); return c.width > 100 && c.height > 100; }), "fan chart canvas drawn");
  const nominalMedian = await page.locator("#mcTiles .pj-tile:nth-child(3) strong").innerText();
  await page.check('input[name="mcMode"][value="real"]');
  const realMedian = await page.locator("#mcTiles .pj-tile:nth-child(3) strong").innerText();
  check(/real \$/.test(await page.locator("#mcTiles .pj-tile:nth-child(3) span").innerText()) && realMedian !== nominalMedian, `real-dollar view (${nominalMedian} nominal vs ${realMedian} real)`);
  await page.check('input[name="mcMode"][value="nominal"]');

  // Validation parity with the desktop app.
  await page.fill("#mc-pensionIncome", "60000");
  await runAndWait();
  check(/Pension income must be less than annual retirement spending/.test(await status()), "pension >= spending rejected (desktop rule)");
  check(await page.getAttribute("#mc-pensionIncome", "aria-invalid") === "true", "invalid field is marked");
  await page.fill("#mc-pensionIncome", "18000");
  await page.fill("#mc-simulations", "10001");
  await runAndWait();
  check(/between 1 and 10,000/.test(await status()), "simulation limit enforced");
  await page.fill("#mc-yearsToRetirement", "2.5");
  await page.fill("#mc-simulations", "100");
  await runAndWait();
  check(/Years to retirement must be between 1 and 120/.test(await status()), "fractional years rejected");
  await page.fill("#mc-yearsToRetirement", "30");

  // Maximum run size stays responsive.
  await page.fill("#mc-simulations", "10000");
  const started = Date.now();
  await runAndWait();
  const elapsed = Date.now() - started;
  check(/10,000 simulations complete/.test(await status()) && elapsed < 15000, `10,000 simulations in ${elapsed} ms`);

  // Sample scenario and CSV export.
  await page.click("#mcSample");
  await runAndWait();
  check(/simulations complete/.test(await status()), "sample scenario runs");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#mcExportCsv")]);
  const csvPath = path.join(OUT, "mc.csv");
  await csv.saveAs(csvPath);
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const years = Number(await page.inputValue("#mc-yearsToRetirement")) + Number(await page.inputValue("#mc-yearsInRetirement"));
  check(lines.length === 7 + years + 1, `CSV has one row per year (${lines.length} lines for ${years} years)`);

  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, "no horizontal scroll at 390px");

  const nonCdn = net.external.filter(url => new URL(url).hostname !== "cdn.jsdelivr.net");
  check(nonCdn.length === 0, `no network requests besides the Chart.js CDN${nonCdn.length ? ": " + nonCdn.join(" ") : ""}`);
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
