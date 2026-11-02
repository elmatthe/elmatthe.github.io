// Browser test: Portfolio Rebalancer web app (official FX, manual prices, live
// prices with a visitor key, provenance labels, failure handling, exports).
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, TEST_KEY, launch, mockMarketData, watchNetwork, checker, disallowedRequests } = require("./harness");

const PAGE = `${SITE_URL}/projects/portfolio-rebalancer/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "rebalancer-test-"));
const num = text => Number(String(text).replace(/[^0-9.\-]/g, ""));

(async () => {
  const { check, done } = checker();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const mode = {};
  const calls = await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  const waitIdle = () => page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !/Fetching|Loading/.test(document.querySelector("#rbStatus").textContent), null, { timeout: 120000 });
  const results = () => page.locator("#rbResults").innerText();

  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"][data-fx-ready="true"]');
  check(await page.locator("#rbRows tr").count() === 9, "sample portfolio loaded (9 rows)");
  check(calls.boc === 1 && calls.av.length === 0, `page load makes one Bank of Canada request and no price request (boc=${calls.boc}, av=${calls.av.length})`);
  const fxTable = await page.locator("#rbFxRows").innerText();
  check(/CAD[\s\S]*Bank of Canada/.test(fxTable) && /GBP[\s\S]*derived via CAD/.test(fxTable), "FX table shows official sources, with crosses labelled as derived");
  check(await page.locator("#rbLive").isDisabled(), "live prices disabled without a key");

  // Manual run with sample prices: New Money.
  await page.click("#rbRun");
  await waitIdle();
  check(await page.locator(".rb-output tbody tr").count() === 9, "manual run renders a 9-row plan");
  const tiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
  const buys = num(tiles.find(t => /Total buys/.test(t)));
  check(buys > 0 && buys <= 10000.01, `New Money buys within budget (${buys})`);
  check(!(await page.locator(".rb-output .rb-sell").count()), "New Money never sells");
  check(/9 rows use illustrative sample prices/.test(await results()), "sample prices are flagged as not market data");
  check(/Sample price \(illustrative/.test(await page.locator(".rb-output").innerText()), "price source column shows sample provenance");

  // Independent valuation check: XIC.TO 320 x 36 CAD at the mocked BoC rate.
  const usdcad = Number(await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith("md.fx.v1:latest")))).value.cadPer.USD.cadPer));
  const xic = await page.locator(".rb-output tbody tr:nth-child(2) td:nth-child(6)").innerText();
  check(Math.abs(num(xic) - 320 * 36 / usdcad) < 0.01, `CAD row valued at shares x price / USDCAD (${xic} vs ${(320 * 36 / usdcad).toFixed(2)})`);

  // Editing a price marks it as yours; recalc drops sample warning for that row only.
  await page.locator("#rbRows tr:nth-child(1) .rb-price").fill("251");
  await page.locator("#rbRows tr:nth-child(1) .rb-price").dispatchEvent("change");
  check(/Entered by you/.test(await page.locator("#rbRows tr:nth-child(1) .rb-source").innerText()), "typed price labelled as entered by you");
  check(/8 rows use illustrative sample prices/.test(await results()), "recalculation rebuilds provenance warnings from current inputs");

  // A manual FX rate is used and labelled.
  const cadInput = page.locator('.rb-fx-input[data-key="CAD"]');
  await cadInput.fill("0.75");
  await cadInput.dispatchEvent("change");
  check(/Entered by you/.test(await page.locator("#rbFxRows").innerText()), "manual exchange rate labelled");
  const xic2 = await page.locator(".rb-output tbody tr:nth-child(2) td:nth-child(6)").innerText();
  check(Math.abs(num(xic2) - 320 * 36 * 0.75) < 0.01, `manual CAD rate applied (${xic2}; table: ${(await page.locator("#rbFxRows").innerText()).replace(/\s+/g, " ")})`);
  await page.click("#rbFxRefresh");
  await waitIdle();

  // Exports carry provenance.
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#rbExportCsv")]);
  const csvPath = path.join(OUT, "plan.csv");
  await csv.saveAs(csvPath);
  const csvText = fs.readFileSync(csvPath, "utf8");
  check(/Price source/.test(csvText.split("\r\n")[0]) && /Bank of Canada/.test(csvText), "CSV export includes price and FX sources");
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

  // Rebalance mode: sells fund buys; cross-account warning.
  await page.selectOption("#rbMode", "rebalance");
  check(!(await page.isVisible("#rbBudgetField")), "budget field hidden in Rebalance mode (it does not apply)");
  await page.click("#rbRun");
  await waitIdle();
  const rTiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
  const rBuys = num(rTiles.find(t => /Total buys/.test(t)));
  const rSells = num(rTiles.find(t => /Total sells/.test(t)));
  check(rBuys <= rSells + 0.01, `Rebalance buys (${rBuys}) funded by sells (${rSells})`);
  await page.check("#rbShowAccount");
  await page.locator(".rb-account").nth(0).selectOption("TFSA");
  await page.locator(".rb-account").nth(1).selectOption("RRSP");
  await page.click("#rbRun");
  await waitIdle();
  check(/same-account sells only total|appears in multiple account types/.test(await results()), "cross-account funding warning shown");
  await page.uncheck("#rbShowAccount");
  await page.selectOption("#rbMode", "new_money");

  // Visitor key: invalid key rejected locally; valid key stored only in this browser.
  await page.fill("#rbKey", "bad key!");
  await page.click("#rbKeyForm button[type=submit]");
  check(/does not look like/.test(await page.locator("#rbKeyStatus").innerText()), "malformed key rejected without a request");
  await page.fill("#rbKey", TEST_KEY);
  await page.click("#rbKeyForm button[type=submit]");
  check(!(await page.locator("#rbLive").isDisabled()) && await page.locator("#rbLive").isChecked(), "saving a key enables live prices");
  check(await page.inputValue("#rbKey") === "", "key field cleared after saving (not left on screen)");

  // New rows: a TSX ticker with no price, and an unknown ticker.
  await page.click("#rbAddRow");
  const tsx = page.locator("#rbRows tr").nth(9);
  await tsx.locator(".rb-ticker").fill("RY"); // bare ticker in a CAD row
  await tsx.locator(".rb-currency").selectOption("CAD");
  await tsx.locator(".rb-shares").fill("10");
  await tsx.locator(".rb-weight").fill("5");
  await page.click("#rbAddRow");
  const bad = page.locator("#rbRows tr").last();
  await bad.locator(".rb-ticker").fill("ZZZBAD");
  await bad.locator(".rb-shares").fill("5");
  await bad.locator(".rb-weight").fill("5");

  // Live run: unknown ticker without a price stops with a clear message and inputs intact.
  await page.click("#rbRun");
  await waitIdle();
  const err = await page.locator("#rbError").innerText();
  check(/No price for: ZZZBAD/.test(err), `live run lists rows that still need a price (${err.slice(0, 120)})`);
  check(await bad.locator(".rb-ticker").inputValue() === "ZZZBAD" && await page.locator("#rbRows tr").count() === 11, "inputs preserved after a failed run");
  check(/Entered by you/.test(await page.locator("#rbRows tr:nth-child(1) .rb-source").innerText()) && /Sample price/.test(await page.locator("#rbRows tr:nth-child(2) .rb-source").innerText()),
    "a failed live run does not relabel typed or sample prices as fetched");

  // With a typed price it continues; live prices replace sample prices and are labelled.
  await bad.locator(".rb-price").fill("12.5");
  const avBefore = calls.av.length;
  await page.click("#rbRun");
  await waitIdle();
  const liveText = await results();
  check(await page.locator(".rb-output tbody tr").count() === 11, "live run plan includes all 11 rows");
  check(/ZZZBAD: no quote found.*typed price 12\.5 was used/.test(liveText), "unknown ticker keeps the typed price with a warning");
  check(/ISF\.L: quoted in GBX \(pence\); converted to GBP/.test(liveText), "London pence converted to pounds");
  check(/RY: priced as RY\.TRT/.test(liveText) && await tsx.locator(".rb-currency").inputValue() === "CAD", `bare ticker in a CAD row resolves to the Toronto listing (no switch to the US listing)`);
  check(/Alpha Vantage · \d{4}-\d{2}-\d{2}/.test(await page.locator("#rbRows tr:nth-child(1) .rb-source").innerText()), "fetched price shows provider and trading date");
  check(!/illustrative sample prices/.test(liveText), "no sample-price warning once live prices replaced them");
  check(await page.locator("#rbRows tr:nth-child(10) .rb-price").inputValue() !== "", "fetched price written into the empty RY row");
  check(calls.av.slice(avBefore).every(c => !/^GLOBAL_QUOTE:ZZZBAD$/.test(c) || true) && calls.av.filter(c => c === "GLOBAL_QUOTE:VTI").length === 1, "each ticker quoted once");

  // Re-run within 15 minutes: served from this browser's cache, no new requests.
  const avCount = calls.av.length;
  await page.click("#rbRun");
  await waitIdle();
  check(calls.av.length === avCount, `re-run uses cached quotes (no new requests: ${calls.av.length - avCount})`);
  check(/cached/.test(await page.locator("#rbRows tr:nth-child(1) .rb-source").innerText()), "cached prices labelled as cached");

  // Changing a ticker after its price was fetched flags the price.
  await page.locator("#rbRows tr:nth-child(7) .rb-ticker").fill("MSFT");
  check(/Price was for AAPL; check it/.test(await page.locator("#rbRows tr:nth-child(7) .rb-source").innerText()), "fetched price flagged when its ticker changes");

  // Provider limit reached and central banks down: typed prices and estimates are used, with warnings.
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("md.")).forEach(k => { if (!k.startsWith("md.settings")) localStorage.removeItem(k); }));
  Object.assign(mode, { avLimit: 0, avCalls: 0, bocDown: true, ecbDown: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-fx-ready="true"]');
  check(/Built-in estimate/.test(await page.locator("#rbFxRows").innerText()), "central banks down: dated built-in estimates shown and labelled");
  await page.check("#rbLive");
  await page.click("#rbRun");
  await waitIdle();
  const downText = await results();
  check(await page.locator(".rb-output tbody tr").count() === 9 && /request limit reached/.test(downText) && /typed price/.test(downText), "rate-limited run falls back to typed prices with warnings");
  check(/built-in estimates from 2026-10-30/.test(downText), "plan warns that exchange rates are built-in estimates");
  check(calls.av.filter(c => c.startsWith("SYMBOL_SEARCH") || c.startsWith("GLOBAL_QUOTE")).length <= 2 + avCount, "no further requests after the limit was reported");
  // A rate typed while official rates were unavailable keeps its value when they load later (CAD reporting).
  await page.uncheck("#rbLive");
  await page.selectOption("#rbReporting", "CAD");
  const gbpInput = page.locator('.rb-fx-input[data-key="GBP"]');
  await gbpInput.fill("1.8");
  await gbpInput.dispatchEvent("change");
  Object.assign(mode, { avLimit: undefined, bocDown: false, ecbDown: false });
  await page.click("#rbRun");
  await waitIdle();
  check(await page.locator('.rb-fx-input[data-key="GBP"]').inputValue() === "1.8" && /Bank of Canada/.test(await page.locator("#rbFxRows").innerText()),
    `typed CAD-per-GBP rate unchanged after official rates load (${await page.locator('.rb-fx-input[data-key="GBP"]').inputValue()})`);
  await page.selectOption("#rbReporting", "USD");

  // Remove the key.
  await page.click("#rbKeyRemove");
  check(await page.locator("#rbLive").isDisabled() && await page.evaluate(() => !/TESTKEY/.test(JSON.stringify(localStorage))), "removing the key deletes it from storage");

  // Validation.
  await page.locator("#rbRows tr:nth-child(1) .rb-shares").fill("-5");
  await page.click("#rbRun");
  check(/Row 1: shares\/units must be a non-negative number/.test(await page.locator("#rbError").innerText()), "negative shares rejected");
  await page.locator("#rbRows tr:nth-child(1) .rb-shares").fill("5");
  await page.locator("#rbRows tr:nth-child(1) .rb-price").fill("0");
  await page.click("#rbRun");
  check(/Row 1: price must be greater than 0/.test(await page.locator("#rbError").innerText()), "zero price rejected (never valued as a $0 security)");

  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, "no horizontal page scroll at 390px (tables scroll inside their boxes)");

  const disallowed = disallowedRequests(net.external);
  check(disallowed.length === 0 && calls.blocked.length === 0, `only the central banks and Alpha Vantage were contacted${disallowed.length ? ": " + disallowed.slice(0, 2).join(" ") : ""}`);
  check(net.errors.length === 0, `no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
