// Opt-in LIVE smoke test (no mocks): the web apps against the real official FX
// sources and, only when ALPHAVANTAGE_KEY is set, Alpha Vantage with that key.
// Small and polite: a handful of requests per run. Informational; not part of the
// deterministic suite. Never commit a key; pass it through the environment.
//
//   ALPHAVANTAGE_KEY=yourkey node live.test.js
"use strict";
const { SITE_URL, launch, watchNetwork, checker } = require("./harness");

const KEY = process.env.ALPHAVANTAGE_KEY || "";
const DAY = 86400000;

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));

  // 1. Rebalancer: official Bank of Canada rates load in a real browser (CORS).
  const rb = await context.newPage();
  const rbNet = watchNetwork(rb);
  await rb.goto(`${SITE_URL}/projects/portfolio-rebalancer/`, { waitUntil: "networkidle" });
  await rb.waitForSelector('#rb-app[data-fx-ready="true"]', { timeout: 60000 });
  const fxTable = await rb.locator("#rbFxRows").innerText();
  const cadRate = Number(await rb.locator('.rb-fx-input[data-key="CAD"]').inputValue());
  console.log(`  FX table: ${fxTable.replace(/\s+/g, " ")}`);
  check(/Bank of Canada, \d{4}-\d{2}-\d{2}/.test(fxTable), "live Bank of Canada rates loaded in the browser");
  check(cadRate > 0.5 && cadRate < 1, `USD per CAD is plausible (${cadRate})`);
  check(rbNet.errors.length === 0, "no JavaScript errors on the Rebalancer");

  // 1b. ECB fallback, live: the Bank of Canada is blocked in this browser only.
  const ecbContext = await browser.newContext();
  await ecbContext.route(/bankofcanada\.ca/, r => r.abort("connectionrefused"));
  const ecb = await ecbContext.newPage();
  await ecb.goto(`${SITE_URL}/projects/portfolio-rebalancer/`, { waitUntil: "networkidle" });
  await ecb.waitForSelector('#rb-app[data-fx-ready="true"]', { timeout: 60000 });
  const ecbTable = await ecb.locator("#rbFxRows").innerText();
  const ecbCad = Number(await ecb.locator('.rb-fx-input[data-key="CAD"]').inputValue());
  console.log(`  ECB fallback FX table: ${ecbTable.replace(/\s+/g, " ")}`);
  check(/European Central Bank, \d{4}-\d{2}-\d{2}/.test(ecbTable), "live ECB rates used when the Bank of Canada is unreachable");
  check(Math.abs(ecbCad / cadRate - 1) < 0.01, `ECB and Bank of Canada USD-per-CAD agree within 1% (${ecbCad} vs ${cadRate})`);
  await ecbContext.close();

  // 2. Stock tool: CSV import normalized to USD with live official FX history.
  const st = await context.newPage();
  const stNet = watchNetwork(st);
  await st.goto(`${SITE_URL}/projects/stock-data-dashboard-tool/`, { waitUntil: "networkidle" });
  await st.waitForSelector('#sdd-app[data-ready="true"]');
  await st.check('input[name="source"][value="csv"]');
  const lines = ["Date,Ticker,Close,Adj Close,Currency"];
  for (const [ticker, cur] of [["AAA", "USD"], ["BBB.TO", "CAD"]]) {
    let p = 50;
    for (let t = Date.now() - 400 * DAY, i = 0; t < Date.now() - DAY; t += DAY, i += 1) {
      if ([0, 6].includes(new Date(t).getUTCDay())) continue;
      p *= Math.exp(0.01 * Math.sin(i * (ticker.length + 0.7)));
      lines.push(`${new Date(t).toISOString().slice(0, 10)},${ticker},${p.toFixed(4)},${p.toFixed(4)},${cur}`);
    }
  }
  await st.setInputFiles("#sddCsvFiles", { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\n")) });
  await st.selectOption("#sddNormalize", "USD");
  await st.click("#sddRunCompare");
  await st.waitForFunction(() => /Comparison complete|failed|could not/.test(document.querySelector("#sddCompareStatus").textContent), null, { timeout: 120000 });
  const fxNote = await st.locator("#sddCompareWarnings").innerText();
  console.log(`  normalization: ${fxNote.split("\n")[0]}`);
  check(/CAD→USD from (Bank of Canada|European Central Bank) daily rates/.test(fxNote), "live official FX history used for normalization");

  // 3. Alpha Vantage with the tester's own key (skipped without one).
  if (!KEY) {
    console.log("SKIP Alpha Vantage live checks (set ALPHAVANTAGE_KEY to run them)");
  } else {
    await st.click("#sddTab-settings");
    await st.fill("#sddKey", KEY);
    await st.click("#sddKeyForm button[type=submit]");
    await st.click("#sddTab-snapshot");
    for (const ticker of ["AAPL", "XIU.TO"]) {
      await st.fill("#sddSnapshotTicker", ticker);
      await st.click("#sddSnapshotRun");
      await st.waitForFunction(() => !document.querySelector("#sddSnapshotRun").disabled, null, { timeout: 120000 });
      const market = await st.locator("#sddSnapshotMarket").innerText().catch(() => "");
      const ident = await st.locator("#sddSnapshotIdentity").innerText().catch(() => "");
      console.log(`  ${ticker}: ${market.replace(/\s+/g, " ").slice(0, 160)} | ${ident.replace(/\s+/g, " ").slice(0, 120)}`);
      check(/\d{4}-\d{2}-\d{2}/.test(market), `${ticker}: live price with a trading date`);
    }
    check(/CAD/.test(await st.locator("#sddSnapshotIdentity").innerText()), "XIU.TO reported in CAD by the provider");
    await st.click("#sddTab-settings");
    await st.click("#sddKeyRemove");
  }
  check(stNet.errors.length === 0, "no JavaScript errors on the Stock tool");
  const hosts = [...new Set([...rbNet.external, ...stNet.external].map(u => new URL(u).hostname))];
  console.log(`  hosts contacted: ${hosts.join(", ")}`);
  check(hosts.every(h => /^(www\.bankofcanada\.ca|data-api\.ecb\.europa\.eu|www\.alphavantage\.co|cdn\.jsdelivr\.net)$/.test(h)), "only official FX sources, Alpha Vantage and the Chart.js CDN were contacted");

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
