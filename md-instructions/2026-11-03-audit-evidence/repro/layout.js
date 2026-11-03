// Measures horizontal overflow of the Rebalancer's input and plan tables at common widths.
const path = require("path");
const repo = process.argv[2];
const H = require(path.join(repo, "_tools/tests/browser/harness.js"));
const ROWS = [["VEQT.TO",305,"CAD",70],["CNQ.TO",48,"CAD",10],["XQQ.TO",27,"CAD",7],["HEWB.TO",14,"CAD",5],["AAPL",2,"USD",2],["VFV.TO",8,"CAD",1],["SPCX",1,"USD",1],["CBRS",4,"USD",1],["YNVD.TO",4,"CAD",2],["VST",1,"USD",1]];
// CSS-pixel widths: 1920/1440/1366/1280 at 100%; 1366 at 125% (1093) and 150% (911); 1280 at 150% (853); tablet 768; phone 390.
const WIDTHS = [[1920,"1920 @100%"],[1440,"1440 @100%"],[1366,"1366 @100%"],[1280,"1280 @100%"],[1093,"1366 @125%"],[911,"1366 @150%"],[853,"1280 @150%"],[768,"tablet 768"],[390,"phone 390"]];
(async () => {
  const browser = await H.launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await H.mockMarketData(context, {});
  const page = await context.newPage();
  await page.goto(`${H.SITE_URL}/projects/portfolio-rebalancer/`);
  await page.waitForSelector("#rb-app[data-fx-ready=true]");
  await page.fill("#rbRowCount", "10"); await page.click("#rbApplyRows");
  for (let i = 0; i < ROWS.length; i++) { const tr = page.locator("#rbRows tr").nth(i); const [t,s,c,w] = ROWS[i];
    await tr.locator(".rb-ticker").fill(t); await tr.locator(".rb-shares").fill(String(s)); await tr.locator(".rb-currency").selectOption(c); await tr.locator(".rb-weight").fill(String(w)); }
  await page.selectOption("#rbReporting", "CAD"); await page.fill("#rbBudget", "3000");
  await page.fill("#rbKey", H.TEST_KEY); await page.click("#rbKeyForm button[type=submit]");
  await page.check("#rbShowAccount");
  await page.click("#rbRun");
  await page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false", null, { timeout: 120000 });
  console.log("width        | page overflow | input table: wrap / table (hidden px) | plan table: wrap / table (hidden px) | plan cols | min font px (plan) | price-source col px");
  for (const [w, label] of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const wraps = [...document.querySelectorAll(".rb-table-wrap")];
      const inWrap = wraps.find(x => x.querySelector("table.rb-input"));
      const outWrap = wraps.find(x => x.querySelector("table.rb-output"));
      const fs = [...document.querySelectorAll("table.rb-output td, table.rb-output th")].map(n => parseFloat(getComputedStyle(n).fontSize));
      const srcCells = [...document.querySelectorAll("table.rb-output td.rb-src-cell")].map(n => n.getBoundingClientRect());
      return {
        page: doc.scrollWidth - doc.clientWidth,
        inW: inWrap.clientWidth, inT: inWrap.scrollWidth, outW: outWrap?.clientWidth, outT: outWrap?.scrollWidth,
        cols: document.querySelectorAll("table.rb-output thead th").length,
        minFont: Math.min(...fs), srcW: srcCells.length ? Math.round(srcCells[0].width) : null, srcH: srcCells.length ? Math.round(Math.max(...srcCells.map(r => r.height))) : null,
      };
    });
    console.log(`${label.padEnd(12)} | ${String(m.page).padStart(4)} px      | ${m.inW} / ${m.inT} (${m.inT - m.inW})`.padEnd(70) + ` | ${m.outW} / ${m.outT} (${m.outT - m.outW})`.padEnd(30) + ` | ${m.cols} | ${m.minFont} | w=${m.srcW} h<=${m.srcH}`);
    if ([1366, 1093, 390].includes(w)) await page.screenshot({ path: path.join(process.env.OUT_DIR || require("os").tmpdir(), `layout-${w}.png`), fullPage: true });
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
