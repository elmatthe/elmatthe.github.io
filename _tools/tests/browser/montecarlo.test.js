// Browser test: Monte Carlo Retirement Simulator web app (local-only, no data requests).
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { SITE_URL, launch, watchNetwork, checker, blockExternal } = require("./harness");

const PAGE = `${SITE_URL}/projects/monte-carlo-simulator/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "mc-test-"));

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await blockExternal(context);
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
  check(await page.evaluate(() => typeof window.Chart === "function"), "Chart.js loaded (self-hosted)");
  check(/^Ready\./.test(await status()), "ready without any third-party host");
  check(/First-year net withdrawal: \$42,000 in first-retirement-year dollars/.test(await page.locator("#mc-spendingNote").innerText()), "default spending basis is retirement-year dollars (unchanged)");
  check(/arithmetic mean; with this volatility, typical \(median\) compound growth is about 6\.33% a year/.test(await page.locator("#mc-growthNote").innerText()), "typical compound growth shown next to the arithmetic mean");

  await runAndWait();
  check(/Done\. 1,000 simulations complete\.$/.test(await status()), "default run completes with no warnings");
  check(await page.locator("#mcWarnings").isHidden(), "no warning list for ordinary assumptions");
  const tiles = await page.locator("#mcTiles .pj-tile").allInnerTexts();
  check(tiles.length === 8 && /Probability of success\s*\n?\s*\d+\.\d%/.test(tiles[0]), `summary tiles rendered (${tiles[0].replace(/\s+/g, " ")})`);
  check(await page.locator("#mcTable tbody tr").count() >= 7, "checkpoint table rendered");
  check(await page.evaluate(() => { const c = document.querySelector("#mcChart"); return c.width > 100 && c.height > 100; }), "fan chart canvas drawn");
  const nominalMedian = await page.locator("#mcTiles .pj-tile:nth-child(3) strong").innerText();
  await page.check('input[name="mcMode"][value="real"]');
  const realMedian = await page.locator("#mcTiles .pj-tile:nth-child(3) strong").innerText();
  check(/real \$/.test(await page.locator("#mcTiles .pj-tile:nth-child(3) span").innerText()) && realMedian !== nominalMedian, `real-dollar view (${nominalMedian} nominal vs ${realMedian} real)`);
  await page.check('input[name="mcMode"][value="nominal"]');

  // Reproducibility: every run shows its seed; the same seed reproduces the run.
  const shownSeed = (await page.locator("#mcMeta").innerText()).match(/seed (\d+)/)?.[1];
  check(Boolean(shownSeed), `random run reports its seed (${shownSeed})`);
  const firstTiles = await page.locator("#mcTiles").innerText();
  await page.fill("#mc-seed", shownSeed);
  await runAndWait();
  check(await page.locator("#mcTiles").innerText() === firstTiles, "re-running with the shown seed reproduces the results exactly");
  await page.fill("#mc-seed", String(Number(shownSeed) + 1));
  await runAndWait();
  check(await page.locator("#mcTiles").innerText() !== firstTiles, "a different seed gives a different run");
  await page.fill("#mc-seed", "12.5");
  await runAndWait();
  check(/Seed must be a whole number/.test(await status()) && await page.getAttribute("#mc-seed", "aria-invalid") === "true", "invalid seed rejected");
  await page.fill("#mc-seed", "");

  // Spending basis: today's dollars are converted with inflation; same seed, lower success.
  await page.fill("#mc-seed", "42");
  await runAndWait();
  const legacySuccess = parseFloat(await page.locator("#mcTiles .pj-tile:nth-child(1) strong").innerText());
  await page.selectOption("#mc-spendingBasis", "today");
  check(/\$42,000 in today's dollars = \$88,098 in the first year of retirement/.test(await page.locator("#mc-spendingNote").innerText()), "today's-dollar conversion shown before running");
  check(await page.locator("#mcStale").isVisible(), "results marked stale after an input changes");
  await runAndWait();
  const todaySuccess = parseFloat(await page.locator("#mcTiles .pj-tile:nth-child(1) strong").innerText());
  check(todaySuccess < legacySuccess && /\(\$42,000 in today's dollars\)/.test(await page.locator("#mcMeta").innerText()) && await page.locator("#mcStale").isHidden(),
    `today's dollars lower success (${legacySuccess}% -> ${todaySuccess}%) and the run records the basis`);
  await page.selectOption("#mc-spendingBasis", "retirement");

  // Warnings stay visible after "Done".
  await page.fill("#mc-volatility", "50");
  await runAndWait();
  const warnText = await page.locator("#mcWarnings").innerText();
  check(/2 warnings below\./.test(await status()) && /Volatility above 30%/.test(warnText) && /about 1\.6% of simulated years/.test(warnText), "extreme-volatility warnings stay listed after Done");
  await page.fill("#mc-volatility", "0.12");
  await runAndWait();
  check(/Volatility is entered in percent/.test(await page.locator("#mcWarnings").innerText()), "0.12 volatility flagged as a likely percent mix-up");
  await page.fill("#mc-volatility", "12");
  await page.fill("#mc-seed", "");

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
  const raw = fs.readFileSync(csvPath);
  check(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, "CSV starts with a UTF-8 byte-order mark");
  check(lines.length === 14 + years + 1 && ["Random seed,", "Random generator,", "Engine version,", "Spending basis,", "Warnings,"].every(p => lines.some(l => l.replace(/^\uFEFF/, "").startsWith(p))),
    `CSV has the seed, generator, engine version, basis, warnings, model and one row per year (${lines.length} lines for ${years} years)`);

  // No sideways scrolling anywhere, including the checkpoint table (stacked when narrow).
  for (const width of [360, 390, 768, 853, 911, 1024, 1093, 1280, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const box = document.querySelector("#mcTable");
      return { page: document.documentElement.scrollWidth - window.innerWidth, table: box.scrollWidth - box.clientWidth, tableEl: document.querySelector("#mcTable table").getBoundingClientRect().width - box.clientWidth };
    });
    check(overflow.page <= 1 && overflow.table <= 1 && overflow.tableEl <= 1, `no horizontal scroll or clipped table at ${width}px (${JSON.stringify(overflow)})`);
  }

  check(net.external.length === 0, `no requests to any other host${net.external.length ? ": " + net.external.join(" ") : ""}`);
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
