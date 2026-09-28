// Opt-in LIVE check (no mocks): the Stock and Rebalancer web apps against the real
// public CORS relays and Yahoo Finance. Results depend on third-party availability, so
// this is informational and is not part of the deterministic suite. It reports which
// relay served the data and fails only when no Yahoo data could be obtained.
"use strict";
const { SITE_URL, launch, watchNetwork, checker } = require("./harness");

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));

  // Stock: US + Canadian ticker, normalized to USD with Yahoo FX.
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(`${SITE_URL}/projects/stock-data-dashboard-tool/`, { waitUntil: "networkidle" });
  await page.waitForSelector('#sdd-app[data-ready="true"]');
  await page.fill("#sddTickerList .sdd-ticker-row:nth-child(2) input", "XIU.TO");
  await page.selectOption("#sddNormalize", "USD");
  const started = Date.now();
  await page.click("#sddRunCompare");
  await page.waitForFunction(() => !document.querySelector("#sddRunCompare").disabled && !/Loaded|Requesting|Retrying/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 180000 });
  const status = await page.locator("#sddCompareStatus").innerText();
  const rows = await page.locator("#sddMetricsTable tbody tr").count();
  const fxNote = await page.locator("#sddCompareWarnings").innerText().catch(() => "");
  console.log(`  stock status: ${status} (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(`  stock progress: ${(await page.locator("#sddTickerProgress").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  check(/Comparison complete/.test(status) && rows >= 2, `live comparison returned Yahoo data for ${rows} tickers`);
  check(/CADUSD=X/.test(fxNote), "live FX normalization used Yahoo CADUSD=X");
  const hosts = [...new Set(net.external.map(u => new URL(u).hostname))];
  console.log(`  stock hosts contacted: ${hosts.join(", ")}`);
  check(hosts.every(h => /cdn\.jsdelivr\.net|corsproxy\.io|allorigins\.win|codetabs\.com|cors\.lol/.test(h)), "only the Chart.js CDN and Yahoo relays were contacted");

  // Rebalancer: sample portfolio with live prices and FX.
  const rb = await context.newPage();
  await rb.goto(`${SITE_URL}/projects/portfolio-rebalancer/`, { waitUntil: "networkidle" });
  await rb.waitForSelector('#rb-app[data-ready="true"]');
  await rb.check("#rbLive");
  await rb.click("#rbRun");
  await rb.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !/Fetching/.test(document.querySelector("#rbStatus").textContent), null, { timeout: 240000 });
  const rbText = await rb.locator("#rbResults").innerText();
  const fallbacks = (rbText.match(/live data could not be reached/g) || []).length;
  console.log(`  rebalancer status: ${await rb.locator("#rbStatus").innerText()}; rows on manual fallback: ${fallbacks}`);
  check(await rb.locator(".rb-output tbody tr").count() === 9, "rebalancer produced a plan");
  check(fallbacks < 9, "at least one live Yahoo price applied");

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
