// Browser reproduction of the 2026-11-03 Rebalancer incident with mocked providers.
// Usage: SITE_URL=http://127.0.0.1:4000 node incident.js <repo>
const path = require("path");
const repo = process.argv[2];
const H = require(path.join(repo, "_tools/tests/browser/harness.js"));
const OUT = process.env.OUT_DIR || require("os").tmpdir(); // screenshots go here, never into the repository
const FULL_BURST = "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day) and instantly remove all daily rate limits.";
const ROWS = [
  ["VEQT.TO", 305, "CAD", 70], ["CNQ.TO", 48, "CAD", 10], ["XQQ.TO", 27, "CAD", 7], ["HEWB.TO", 14, "CAD", 5],
  ["AAPL", 2, "USD", 2], ["VFV.TO", 8, "CAD", 1], ["SPCX", 1, "USD", 1], ["CBRS", 4, "USD", 1], ["YNVD.TO", 4, "CAD", 2], ["VST", 1, "USD", 1],
];
async function enterOwnerPortfolio(page, { typeRow10Price = "136" } = {}) {
  // What the owner did: start from the page's sample, change rows to 10, overwrite
  // tickers/shares/currency/weights, leave the sample's prices in rows 1-9.
  await page.fill("#rbRowCount", "10");
  await page.click("#rbApplyRows");
  const trs = page.locator("#rbRows tr");
  for (let i = 0; i < ROWS.length; i++) {
    const [t, s, c, w] = ROWS[i];
    const tr = trs.nth(i);
    await tr.locator(".rb-ticker").fill(t);
    await tr.locator(".rb-shares").fill(String(s));
    await tr.locator(".rb-currency").selectOption(c);
    await tr.locator(".rb-weight").fill(String(w));
    if (i === 9 && typeRow10Price) await tr.locator(".rb-price").fill(typeRow10Price);
  }
  await page.selectOption("#rbReporting", "CAD");
  await page.selectOption("#rbMode", "new_money");
  await page.fill("#rbBudget", "3000");
}
async function scenario(browser, label, mode, routeOverride) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await H.mockMarketData(context, mode);
  let avSeen = [];
  if (routeOverride) await context.route(/^https:\/\/www\.alphavantage\.co\//, async route => routeOverride(route, avSeen));
  const page = await context.newPage();
  await page.goto(`${H.SITE_URL}/projects/portfolio-rebalancer/`);
  await page.waitForSelector("#rb-app[data-fx-ready=true]");
  const rowPricesBefore = await page.$$eval("#rbRows .rb-price", n => n.map(x => x.value));
  await enterOwnerPortfolio(page);
  const sourcesAfterEdit = await page.$$eval("#rbRows .rb-source", n => n.map(x => x.textContent));
  await page.fill("#rbKey", H.TEST_KEY);
  await page.click("#rbKeyForm button[type=submit]");
  const keyState = await page.locator("#rbKeyState").innerText();
  await page.click("#rbRun");
  await page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false", null, { timeout: 120000 });
  const status = await page.locator("#rbStatus").innerText();
  const error = await page.locator("#rbError").innerText();
  const warnings = await page.$$eval("#rbResults .pj-warnings li", n => n.map(x => x.textContent));
  const keyStateAfter = await page.locator("#rbKeyState").innerText();
  const plan = await page.$$eval("#rbResults table.rb-output tbody tr", trs => trs.map(tr => [...tr.children].map(td => td.textContent).join(" | ")));
  const tiles = await page.$$eval("#rbResults .pj-tile", n => n.map(x => x.innerText.replace(/\n/g, ": ")));
  const usage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.endsWith(".usage")).map(k => [k.replace(/k[0-9a-z]+/, "<fp>"), localStorage.getItem(k)])));
  await page.screenshot({ path: path.join(OUT, `incident-${label.replace(/\W+/g, "_")}.png`), fullPage: true });
  console.log(`\n===== ${label} =====`);
  console.log("sample prices before edit:", rowPricesBefore.join(", "));
  console.log("row source labels after editing tickers:", JSON.stringify(sourcesAfterEdit));
  console.log("key state before run:", keyState);
  console.log("status:", status, "| error:", error || "(none)");
  console.log("key state after run:", keyStateAfter);
  console.log("persisted usage:", JSON.stringify(usage));
  console.log("AV requests (mock count):", mode.avCalls ?? avSeen.length, avSeen.length ? avSeen.join(", ") : "");
  console.log("tiles:", tiles.join(" ; "));
  console.log(`warnings (${warnings.length}):`); warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
  console.log("plan rows:"); plan.forEach(r => console.log("  " + r));
  await context.close();
}
(async () => {
  const browser = await H.launch();
  // 1) Burst notice (full wording) on the 3rd request.
  await scenario(browser, "burst notice on request 3", {}, async (route, seen) => {
    const u = new URL(route.request().url());
    seen.push(`${u.searchParams.get("function")}:${u.searchParams.get("symbol") || u.searchParams.get("keywords")}`);
    if (seen.length === 3) return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ Information: FULL_BURST }) });
    return route.fallback();
  });
  // 2) Genuine daily limit already reached at the provider (account-wide), first request.
  await scenario(browser, "genuine daily limit at request 1", { avLimit: 0 });
  // 3) Normal provider, no limit: does the plan use fetched prices?
  await scenario(browser, "provider healthy", {});
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
