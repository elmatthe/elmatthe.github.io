// Browser test: Portfolio Rebalancer web app (manual and live Yahoo modes).
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, launch, mockProxies, watchNetwork, checker } = require("./harness");

const PAGE = `${SITE_URL}/projects/portfolio-rebalancer/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "rebalancer-test-"));
const num = text => Number(String(text).replace(/[^0-9.\-]/g, ""));

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const mode = { working: ["allorigins-json"] };
  const { calls, targets } = await mockProxies(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  const status = () => page.locator("#rbStatus").innerText();
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !/Fetching/.test(document.querySelector("#rbStatus").textContent), null, { timeout: 120000 });

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"]');
  check(await page.locator("#rbRows tr").count() === 9, "sample portfolio loaded (9 rows)");
  check(net.external.length === 0, "no network requests on page load");

  // Manual prices, New Money mode.
  await page.click("#rbRun");
  await waitIdle();
  check(await page.locator(".rb-output tbody tr").count() === 9, "manual run renders a 9-row plan");
  const tiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
  const buys = num(tiles.find(t => /Total buys/.test(t)));
  check(buys > 0 && buys <= 10000.01, `New Money buys within budget (${buys})`);
  check(!(await page.locator(".rb-output .rb-sell").count()), "New Money never sells");

  // Exports.
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#rbExportCsv")]);
  const csvPath = path.join(OUT, "plan.csv");
  await csv.saveAs(csvPath);
  check(fs.readFileSync(csvPath, "utf8").split("\r\n").length >= 10, "CSV trade plan downloaded");
  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.click("#rbExportXlsx")]);
  const xlsxPath = path.join(OUT, "plan.xlsx");
  await xlsx.saveAs(xlsxPath);
  try {
    const out = execFileSync(process.env.PYTHON || "python3", ["-c",
      "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);ws=wb['Trade Plan'];print('|'.join(wb.sheetnames), ws.max_row)", xlsxPath]).toString().trim();
    check(out === "Trade Plan|Summary 10", `Excel export opens cleanly (${out})`);
  } catch (error) {
    check(false, `Excel export validation: ${String(error.message).slice(0, 160)}`);
  }

  // Rebalance mode: sells fund buys.
  await page.selectOption("#rbMode", "rebalance");
  await page.click("#rbRun");
  await waitIdle();
  const rTiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
  const rBuys = num(rTiles.find(t => /Total buys/.test(t)));
  const rSells = num(rTiles.find(t => /Total sells/.test(t)));
  check(rBuys <= rSells + 0.01, `Rebalance buys (${rBuys}) funded by sells (${rSells})`);

  // Cross-account warning.
  await page.check("#rbShowAccount");
  const accounts = page.locator(".rb-account");
  await accounts.nth(0).selectOption("TFSA");
  await accounts.nth(1).selectOption("RRSP");
  await page.click("#rbRun");
  await waitIdle();
  check(/same-account sells only total|appears in multiple account types/.test(await page.locator("#rbResults").innerText()), "cross-account funding warning shown");
  await page.uncheck("#rbShowAccount");
  await page.selectOption("#rbMode", "new_money");

  // New-position lookup (US and Canadian), then an invalid ticker.
  await page.click("#rbAddRow");
  const last = page.locator("#rbRows tr").last();
  await last.locator(".rb-ticker").fill("MSFT");
  await page.waitForFunction(() => /Verified MSFT/.test(document.querySelector("#rbRows tr:last-child .rb-hint").textContent), null, { timeout: 60000 });
  check(true, "new US ticker verified from Yahoo while typing");
  await last.locator(".rb-currency").selectOption("CAD");
  await last.locator(".rb-ticker").fill("XIU");
  await page.waitForFunction(() => /Verified XIU\.TO/.test(document.querySelector("#rbRows tr:last-child .rb-hint").textContent), null, { timeout: 60000 });
  check(true, "CAD row resolves XIU to XIU.TO");
  await last.locator(".rb-currency").selectOption("USD");
  await last.locator(".rb-ticker").fill("ZZZBAD");
  await page.waitForFunction(() => /Not found on Yahoo Finance/.test(document.querySelector("#rbRows tr:last-child .rb-hint").textContent), null, { timeout: 60000 });
  check(true, "invalid ticker reported as not found");
  await last.locator(".rb-shares").fill("10");
  await last.locator(".rb-weight").fill("5");

  // Live run: invalid ticker without a manual price stops with a clear message.
  await page.check("#rbLive");
  await page.click("#rbRun");
  await waitIdle();
  check(/No Yahoo Finance quote for ZZZBAD/.test(await page.locator("#rbError").innerText()), "live run explains an unknown ticker without a price");
  // With a manual price it continues with a warning; live prices and FX are applied.
  await last.locator(".rb-price").fill("12.5");
  await page.click("#rbRun");
  await waitIdle();
  const liveText = await page.locator("#rbResults").innerText();
  check(await page.locator(".rb-output tbody tr").count() === 10, "live run plan includes all 10 rows");
  check(/ZZZBAD: no Yahoo Finance quote.*manual price 12\.5000/.test(liveText), "unknown ticker keeps manual price with a warning");
  check(/ISF\.L: Yahoo Finance quotes this listing in GBp/.test(liveText), "GBp pence converted for ISF.L");
  check(/live Yahoo Finance prices/.test(liveText), "results labelled as live Yahoo data");
  const fxCell = await page.locator("#rbRows tr:nth-child(2) .rb-fx").innerText();
  check(fxCell.startsWith("~"), `live FX marked in the table (${fxCell})`);
  check(targets.some(t => /CADUSD%3DX|CADUSD=X/.test(t)) && targets.some(t => /GBPUSD%3DX|GBPUSD=X/.test(t)), "FX fetched as Yahoo CADUSD=X and GBPUSD=X");
  const priceAfter = await page.locator("#rbRows tr:nth-child(1) .rb-price").inputValue();
  check(priceAfter !== "250", `live price written back to the input table (VTI ${priceAfter})`);
  check(calls.includes("corsproxy") && calls.includes("allorigins-json"), "partial proxy outage handled by fallback");

  // Total outage: rows keep manual prices, FX falls back, run still completes.
  mode.down = true;
  await page.evaluate(() => { sessionStorage.clear(); localStorage.removeItem("yahoo.proxy.health.v1"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"]');
  await page.check("#rbLive");
  await page.click("#rbRun");
  await waitIdle();
  const downText = await page.locator("#rbResults").innerText();
  check(await page.locator(".rb-output tbody tr").count() === 9 && /live data could not be reached; using your manual price/.test(downText), "total outage falls back to manual prices");
  check(/Live FX CADUSD=X unavailable/.test(downText), "total outage falls back to offline FX with a warning");
  mode.down = false;

  // Validation.
  await page.uncheck("#rbLive");
  await page.locator("#rbRows tr:nth-child(1) .rb-shares").fill("-5");
  await page.click("#rbRun");
  check(/Row 1: shares\/units must be a non-negative number/.test(await page.locator("#rbError").innerText()), "negative shares rejected");

  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, "no horizontal page scroll at 390px (table scrolls inside its box)");

  const disallowed = net.external.filter(url => !/corsproxy\.io|allorigins\.win|codetabs\.com|cors\.lol/.test(new URL(url).hostname) || !/finance\.yahoo\.com/.test(decodeURIComponent(url)));
  check(disallowed.length === 0, `only proxied Yahoo Finance requests were made${disallowed.length ? ": " + disallowed.slice(0, 2).join(" ") : ""}`);
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
