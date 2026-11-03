// Browser test: Portfolio Rebalancer web app. Every provider is mocked (harness.js);
// no real key or market data is used.
//
// Covers the 2026-11-03 incident and its fixes: the Alpha Vantage burst notice is
// retried, not read as the daily limit; a genuine daily limit is recorded once,
// grouped, and checked again on request; a ticker edit clears the old price and a
// late answer for it is ignored; no plan is shown while a holding lacks a verified
// price; the exact 14-holding sample (one list, international holdings included)
// loads with no prices and spends no request; one Get prices covers every holding;
// and the page never scrolls sideways.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, TEST_KEY, FH_KEY, MS_KEY, launch, mockMarketData, watchNetwork, checker, disallowedRequests } = require("./harness");

const PAGE = `${SITE_URL}/projects/portfolio-rebalancer/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "rebalancer-test-"));
const num = text => Number(String(text).replace(/[^0-9.\-]/g, ""));
const SAMPLE = [
  ["VEQT.TO", "305", "63"], ["CNQ.TO", "48", "9"], ["XQQ.TO", "27", "6.3"], ["HEWB.TO", "14", "4.5"], ["AAPL", "2", "1.8"],
  ["VFV.TO", "8", "0.9"], ["SPCX", "1", "0.9"], ["CBRS", "4", "0.9"], ["YNVD.NE", "4", "1.8"], ["VST", "1", "0.9"],
  ["7203.T", "1", "2.5"], ["SAP.DE", "1", "2.5"], ["VOD.L", "1", "2.5"], ["600519.SS", "1", "2.5"],
];
const TICKERS = SAMPLE.map(r => r[0]);
const WIDTHS = [360, 390, 768, 853, 911, 1093, 1280, 1366, 1440, 1920];

async function newPage(browser, mode, opts = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...opts });
  const calls = await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"][data-fx-ready="true"]');
  return { context, page, calls, net };
}
const idle = async page => {
  await page.waitForTimeout(50);
  await page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !document.querySelector('.rb-row[aria-busy="true"]') && !/fetching|getting prices/i.test(document.querySelector("#rbStatus").textContent), null, { timeout: 120000 });
};
async function saveKey(page, provider, key, remember = false) {
  if ((await page.locator("#rbKeysPanel").getAttribute("open")) === null) await page.click("#rbKeysPanel > summary");
  const card = page.locator(`#rbProviders section[aria-label="${provider}"]`);
  await card.locator('input[type="password"]').fill(key);
  if (remember) await card.locator('input[type="checkbox"]').check();
  await card.locator('button[type="submit"]').click();
}
const row = (page, i, list = "#rbRows") => page.locator(`${list} .rb-row`).nth(i);
const rowValues = (page, list = "#rbRows") => page.$$eval(`${list} .rb-row`, rows => rows.map(r => [r.querySelector(".rb-ticker").value, r.querySelector(".rb-shares").value, r.querySelector(".rb-weight").value]));
const lineOf = (page, i, list) => row(page, i, list).locator(".rb-line").innerText();
async function loadSample(page) {
  await page.click("#rbSample");
  await page.waitForFunction(() => document.querySelectorAll("#rbRows .rb-row .rb-identity:not([hidden])").length === 14);
}
async function manualPrice(page, i, price, list) {
  const r = row(page, i, list);
  await r.getByRole("button", { name: /Use my own price|Edit my price/ }).click();
  await r.locator(".rb-mprice").fill(String(price));
  await r.getByRole("button", { name: "Use this price" }).click();
}
async function download(page, id, name) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(id)]);
  const target = path.join(OUT, name);
  await file.saveAs(target);
  return target;
}

(async () => {
  const { check, done } = checker();
  const browser = await launch();

  /* ---------- 1. load, sample, no key ---------- */
  {
    const mode = {};
    const { context, page, calls, net } = await newPage(browser, mode);
    check(calls.boc === 1 && calls.av.length + calls.ms.length + calls.fh.length === 0, `page load: one Bank of Canada request, no price request (boc=${calls.boc})`);
    check(await page.locator("#rbRows .rb-row").count() === 1 && (await page.locator("#rbRows .rb-ticker").inputValue()) === "", "page starts with one empty holding, no sample prices");
    const sources = await page.locator("#rbSource option").allInnerTexts();
    check(sources.length === 4 && /Automatic \(route by market\)/.test(sources[0]) && sources.some(s => /Alpha Vantage/.test(s)) && sources.some(s => /Marketstack/.test(s)) && sources.some(s => /Finnhub/.test(s)), `source selector: Automatic + three providers (${sources.join(" | ")})`);
    check(!sources.some(s => /Alpaca|Massive/.test(s)), "Alpaca and Massive are not offered in the browser");
    check(/Alpaca \(desktop app only\)[\s\S]*Massive \(deferred\)/.test(await page.locator("#rbNotOffered").textContent()), "the reasons Alpaca and Massive are not offered are stated");

    await loadSample(page);
    check(JSON.stringify(await rowValues(page)) === JSON.stringify(SAMPLE), "sample: fourteen holdings in order, with exact shares and targets");
    check(await page.locator("#rbTestRows, #rbTestGroup, #rbPriceTests").count() === 0, "no separate international container and no separate price button");
    check(await page.locator("#rbRows .rb-row").count() === 14 && await page.locator(".rb-rows").count() === 1, "all fourteen holdings are cards in the one holdings list");
    check(/14 holdings · 0 priced · 14 without a usable price/.test(await page.locator("#rbSummary").innerText()) && /targets 100\.00%/.test(await page.locator("#rbSummary").innerText()), `summary: 14 holdings, targets 100.00% (${await page.locator("#rbSummary").innerText()})`);
    check(/14 holdings \(targets total 100\.0%\)/.test(await page.locator("#rbStatus").innerText()), "status: 14 holdings, targets total 100.0%");
    check(await page.locator("#rbReporting").inputValue() === "CAD" && await page.locator("#rbMode").inputValue() === "new_money" && await page.locator("#rbBudget").inputValue() === "3000", "sample: CAD reporting, New Money, budget 3000");
    check(calls.av.length + calls.ms.length + calls.fh.length === 0, "loading the sample sends no price request");
    check(!/\b(250|7\.4|42\.00)\b/.test(await page.locator("#rbRows").innerText()) && !/C\$\d/.test(await page.locator("#rbRows").innerText()), "no price appears before any is fetched");
    check(/NVIDIA \(NVDA\) Yield Shares Purpose ETF · Cboe Canada[^·]* · CAD/.test(await row(page, 8).locator(".rb-identity").innerText()), "YNVD.NE is identified as the Cboe Canada ETF in CAD");
    check((await row(page, 8).locator(".rb-ticker").inputValue()) === "YNVD.NE", "the sample shows YNVD.NE");
    check(/Toyota[\s\S]*JPY/.test(await row(page, 10).locator(".rb-identity").innerText()) && /SAP SE[\s\S]*EUR/.test(await row(page, 11).locator(".rb-identity").innerText()) && /Moutai[\s\S]*CNY/.test(await row(page, 13).locator(".rb-identity").innerText()), "international holdings show their listing currency");
    check(/GBP \(quoted in pence/.test(await row(page, 12).locator(".rb-identity").innerText()), "VOD.L is identified as quoted in pence");
    check(await row(page, 12).locator(".rb-ticker").isEditable() && await row(page, 12).locator(".rb-weight").isEditable() && await row(page, 12).locator(".rb-remove").count() === 1, "international holdings are editable and removable like any other");
    check(/add your own key/i.test(await page.locator("#rbEstimate").innerText()), "without a key, the page explains how to get prices");
    await page.click("#rbRun");
    check(/Plan withheld/.test(await page.locator("#rbResults").innerText()) && await page.locator("#rbResults .rb-pill").count() === 0, "0 of 14 prices: no plan, no Buy/Sell pills");
    check(/14 of 14 holdings have no usable price/.test(await page.locator("#rbStatus").innerText()), "status says why the plan is withheld (not 'Completed')");
    check(await page.locator("#rbExportCsv").isDisabled() && await page.locator("#rbExportXlsx").isDisabled(), "no export without a plan");
    // Remove international examples: only the four unchanged sample rows go.
    check(await page.locator("#rbRemoveIntl").isVisible(), "Remove international examples is offered while the examples are unchanged");
    await row(page, 10).locator(".rb-shares").fill("2");
    await page.click("#rbAddRow");
    await row(page, 14).locator(".rb-ticker").fill("SAP.DE");
    await row(page, 14).locator(".rb-ticker").press("Enter");
    await row(page, 14).locator(".rb-shares").fill("1");
    await row(page, 14).locator(".rb-weight").fill("2.5");
    await page.click("#rbRemoveIntl");
    const left = (await rowValues(page)).map(r => r.join(" "));
    check(left.length === 12 && left.includes("7203.T 2 2.5") && left.filter(t => /^SAP\.DE /.test(t)).length === 1 && !left.some(t => /^(VOD\.L|600519\.SS) /.test(t)), `removes only unchanged examples; an edited example and a user-added SAP.DE stay (${left.slice(9).join(" | ")})`);
    check(await page.locator("#rbRemoveIntl").isHidden(), "the button disappears once no unchanged example is left");
    check(/the plan scales them to 100%/.test(await page.locator("#rbSummary").innerText()), "targets no longer total 100%: the summary says they are scaled");
    check(net.errors.length === 0, `no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 2. automatic pricing, routing, user-supplied price, exports ---------- */
  {
    const mode = {};
    const { context, page, calls, net } = await newPage(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await saveKey(page, "Finnhub", FH_KEY);
    await loadSample(page);
    const estimate = await page.locator("#rbEstimate").innerText();
    check(/about 8 Alpha Vantage requests/.test(estimate) && /about 4 Finnhub requests/.test(estimate), `estimate before fetching covers all fourteen: 8 Alpha Vantage, 4 Finnhub (${estimate.slice(0, 200)})`);
    check(/uses 8 of the 25 left/.test(estimate), "the estimate says how much of the daily allowance it uses");
    check(/Listings outside Canada and the US: 7203\.T \(Tokyo Stock Exchange, JPY\), SAP\.DE \(Xetra[^)]*\), EUR\), VOD\.L \(London Stock Exchange, GBP\), 600519\.SS \(Shanghai Stock Exchange, CNY\)/.test(estimate), "international listings are named before any request");
    check(/Not covered by your saved sources: YNVD\.NE, 7203\.T/.test(estimate), "YNVD.NE and 7203.T are named as not covered before any request");
    check(!/of 25 used/.test(await page.locator("#rb-app").innerText()), "no 'N of 25 used' wording anywhere");
    check(calls.av.length + calls.fh.length === 0, "still no request before Get prices");
    check(/about 12 requests/.test(await page.locator("#rbPriceAll").innerText()), `one Get prices button for every holding (${await page.locator("#rbPriceAll").innerText()})`);
    await page.click("#rbPriceAll");
    await idle(page);
    check(JSON.stringify(calls.av.slice(0, 4)) === JSON.stringify(["GLOBAL_QUOTE:VEQT.TRT", "GLOBAL_QUOTE:CNQ.TRT", "GLOBAL_QUOTE:XQQ.TRT", "GLOBAL_QUOTE:HEWB.TRT"]), `largest targets first (${calls.av.slice(0, 4).join(",")})`);
    check(JSON.stringify(calls.av.slice().sort()) === JSON.stringify(["GLOBAL_QUOTE:600519.SHH", "GLOBAL_QUOTE:CNQ.TRT", "GLOBAL_QUOTE:HEWB.TRT", "GLOBAL_QUOTE:SAP.DEX", "GLOBAL_QUOTE:VEQT.TRT", "GLOBAL_QUOTE:VFV.TRT", "GLOBAL_QUOTE:VOD.LON", "GLOBAL_QUOTE:XQQ.TRT"]), `TSX and international holdings: one Alpha Vantage quote each, no symbol search (${calls.av.join(",")})`);
    check(JSON.stringify(calls.fh.slice().sort()) === JSON.stringify(["AAPL", "CBRS", "SPCX", "VST"]), `US holdings: Finnhub (${calls.fh.join(",")})`);
    check(!calls.av.concat(calls.fh).some(c => /YNVD|7203/.test(c)), "no request for the holdings no saved source covers");
    const status = await page.locator("#rbStatus").innerText();
    check(/12 of 14 priced\. Without a usable price: YNVD\.NE \(not covered by your saved sources\), 7203\.T \(not covered by your saved sources\)\. The plan stays withheld/.test(status), `Get prices names the incomplete holdings (${status})`);
    check(/Verified[\s\S]*Alpha Vantage · latest price for trading day \d{4}-\d{2}-\d{2}/.test(await lineOf(page, 0)), "VEQT.TO shows provider, price type and trading date");
    check(/Verified[\s\S]*US\$[\d,.]+[\s\S]*Finnhub · last price/.test(await lineOf(page, 4)), "AAPL priced in US dollars by Finnhub");
    check(/Verified[\s\S]*€[\d,.]+/.test(await lineOf(page, 11)) && /Verified[\s\S]*£[\d,.]+/.test(await lineOf(page, 12)) && /Verified[\s\S]*CN¥[\d,.]+/.test(await lineOf(page, 13)), "SAP.DE in euros, VOD.L in pounds, 600519.SS in yuan");
    const vodDetail = await row(page, 12).locator("details dl").textContent();
    check(/provider quoted [\d.]+ (GBX|pence)/.test(vodDetail), `VOD.L: the pence quote is shown and converted (${vodDetail.replace(/\s+/g, " ").slice(0, 120)})`);
    check(/Not covered/.test(await lineOf(page, 8)) && /Cboe Canada/.test(await lineOf(page, 8)), "YNVD.NE: not covered, with the reason");
    check(/Not covered/.test(await lineOf(page, 10)), "7203.T: not covered by the saved sources");
    await page.click("#rbRun");
    const withheld = await page.locator("#rbResults").innerText();
    check(/Plan withheld/.test(withheld) && /YNVD\.NE/.test(withheld) && /7203\.T/.test(withheld) && await page.locator("#rbResults .rb-pill").count() === 0, "12 of 14 priced: plan withheld, naming YNVD.NE and 7203.T");

    // The owner deliberately supplies the two missing prices: the plan appears, labelled.
    await manualPrice(page, 8, "44.21");
    check(/User-supplied[\s\S]*C\$44\.21[\s\S]*user-supplied/.test(await lineOf(page, 8)), "user-supplied price shown as such");
    check(/Plan withheld[\s\S]*7203\.T/.test(await page.locator("#rbResults").innerText()), "still withheld while 7203.T has no price");
    await manualPrice(page, 10, "2850");
    await page.waitForFunction(() => /Plan includes/.test(document.querySelector("#rbResults").textContent));
    const planText = await page.locator("#rbResults").innerText();
    check(/Plan includes 2 prices you supplied/.test(planText) && /User-supplied prices \(not verified by a provider\): YNVD\.NE, 7203\.T/.test(planText), "plan banner and attention list name both user-supplied prices");
    const planned = await page.$$eval("#rbResults .rb-act-ticker", n => n.map(x => x.textContent));
    check(planned.length === 14 && TICKERS.every(t => planned.includes(t)), `all fourteen holdings are in the plan (${planned.length})`);
    check(!/Not in the plan/.test(planText), "no holding is left out of the plan");
    check(/14 holdings valued/.test(planText), "the banner counts fourteen valued holdings");
    check(await page.locator("#rbResults .rb-sell").count() === 0, "New Money never sells");
    const tiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
    const buys = num(tiles.find(t => /Total buys/.test(t)));
    check(buys > 0 && buys <= 3000.01, `buys within the CAD 3,000 budget (${buys})`);
    await page.locator("#rbResults .rb-warn-group.info summary").click();
    check(/VOD\.L: quoted in pence and converted to pounds \(÷100\)/.test(await page.locator("#rbResults").innerText()), "the plan says VOD.L was converted from pence");

    // Exports: provenance, user-supplied label, display tickers kept, no keys.
    const csvText = fs.readFileSync(await download(page, "#rbExportCsv", "plan.csv"), "utf8");
    check(/Includes 2 user-supplied price/.test(csvText) && /YNVD\.NE,NEOE:YNVD/.test(csvText) && /Entered by you \(user-supplied\)/.test(csvText), "CSV: user-supplied label, YNVD.NE and its listing");
    check(/Alpha Vantage \(provider\),VEQT\.TRT,latest price for trading day/.test(csvText) && /Finnhub \(provider\),AAPL,last price/.test(csvText), "CSV: provider, provider symbol and price type per holding");
    check(/VOD\.L,XLON:VOD,Vodafone Group Plc,,GBP,/.test(csvText) && /SAP\.DE,XETR:SAP,SAP SE,,EUR,/.test(csvText) && /600519\.SS,XSHG:600519,[^\n]*,CNY,/.test(csvText) && /7203\.T,XTKS:7203,Toyota Motor Corporation,,JPY,/.test(csvText), "CSV: every international holding with its listing and currency");
    check(/Bank of Canada/.test(csvText) && /^JPY,/m.test(csvText) && /^GBP,/m.test(csvText) && /^EUR,/m.test(csvText) && /^CNY,/m.test(csvText), "CSV: exchange-rate source for every currency");
    check(!csvText.includes(TEST_KEY) && !csvText.includes(FH_KEY), "CSV contains no key");
    const xlsxPath = await download(page, "#rbExportXlsx", "plan.xlsx");
    try {
      const out = execFileSync(process.env.PYTHON || "python3", ["-c",
        "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);ws=wb['Trade Plan'];h=[c.value for c in ws[1]];print('|'.join(wb.sheetnames), ws.max_row, h[0], ws.cell(10,1).value, ws.cell(15,1).value, any(isinstance(c.value,str) and c.value.startswith('=') for r in ws.iter_rows() for c in r))", xlsxPath]).toString().trim();
      check(out === "Trade Plan|Summary 15 Ticker (as entered) YNVD.NE 600519.SS False", `Excel export: two sheets, 14 holdings, tickers as entered, no formulas (${out})`);
    } catch (error) {
      check(false, `Excel export validation: ${String(error.message).slice(0, 160)}`);
    }

    // Removing a holding updates the portfolio and the plan at once.
    await row(page, 9).locator(".rb-remove").click();
    check(await page.locator("#rbRows .rb-row").count() === 13 && !(await rowValues(page)).some(r => r[0] === "VST"), "VST removed on its own");
    check(/13 holdings/.test(await page.locator("#rbSummary").innerText()) && (await page.$$eval("#rbResults .rb-act-ticker", n => n.length)) === 13, "the summary and plan update to 13 holdings");

    // A ticker edit clears that holding's price at once; the plan is withheld again.
    await row(page, 0).locator(".rb-ticker").fill("XIU.TO");
    check(!/C\$/.test(await lineOf(page, 0)) && /Press Enter/.test(await lineOf(page, 0)), "editing VEQT.TO clears its price immediately");
    check(/Plan withheld/.test(await page.locator("#rbResults").innerText()), "the plan is withheld until the new ticker is priced");
    await row(page, 0).locator(".rb-ticker").press("Enter");
    await idle(page);
    check(calls.av.at(-2) === "SYMBOL_SEARCH:XIU.TRT" || calls.av.includes("SYMBOL_SEARCH:XIU.TRT"), "an uncurated ticker confirms its currency with a symbol search");
    check(/Verified/.test(await lineOf(page, 0)), "the new ticker is priced on commit, without pressing Run");

    // Whole shares: integer trades within the budget.
    await page.selectOption("#rbRounding", "whole");
    const whole = await page.$$eval("#rbResults .rb-act-shares", nodes => nodes.map(n => n.textContent));
    check(whole.filter(t => /sh$/.test(t)).every(t => Number.isInteger(Number(t.replace(/[^0-9.]/g, "")))), `whole-share mode trades whole shares (${whole.join(", ")})`);
    check(num((await page.locator("#rbResults .pj-tile").allInnerTexts()).find(t => /Total buys/.test(t))) <= 3000.01, "whole-share buys stay within the budget");
    await page.selectOption("#rbRounding", "fractional");
    await page.selectOption("#rbMode", "rebalance");
    check(/Plan includes|Plan ready/.test(await page.locator("#rbResults").innerText()) && await page.locator("#rbResults .rb-sell").count() > 0, "Rebalance mode recalculates with sells");
    const sells = num((await page.locator("#rbResults .pj-tile").allInnerTexts()).find(t => /Total sells/.test(t)));
    const buys2 = num((await page.locator("#rbResults .pj-tile").allInnerTexts()).find(t => /Total buys/.test(t)));
    check(buys2 <= sells + 0.01, `Rebalance buys funded by sells (${buys2} <= ${sells})`);

    // Holdings CSV round trip keeps YNVD.NE exactly; a legacy YNVD.TO import is the same fund.
    await page.locator(".rb-csv > summary").click();
    const holdings = fs.readFileSync(await download(page, "#rbExportHoldings", "holdings.csv"), "utf8");
    check(/^ticker,shares,target_pct,account\r\n/.test(holdings) && /YNVD\.NE,4,1\.8,/.test(holdings) && /VOD\.L,1,2\.5,/.test(holdings), "holdings export keeps YNVD.NE and the international holdings");
    await page.click("#rbClear");
    await page.setInputFiles("#rbImportHoldings", path.join(OUT, "holdings.csv"));
    await page.waitForFunction(() => /Imported/.test(document.querySelector("#rbStatus").textContent));
    check((await rowValues(page)).some(v => v[0] === "YNVD.NE" && v[1] === "4" && v[2] === "1.8"), "holdings import restores YNVD.NE unchanged");
    fs.writeFileSync(path.join(OUT, "legacy.csv"), "ticker,shares,target_pct,account\r\nYNVD.TO,4,2,\r\n");
    await page.setInputFiles("#rbImportHoldings", path.join(OUT, "legacy.csv"));
    await page.waitForFunction(() => /Imported 1 holdings/.test(document.querySelector("#rbStatus").textContent));
    await page.waitForFunction(() => !document.querySelector("#rbRows .rb-identity").hidden);
    check((await row(page, 0).locator(".rb-ticker").inputValue()) === "YNVD.TO" && /NVIDIA \(NVDA\) Yield Shares Purpose ETF · Cboe Canada/.test(await row(page, 0).locator(".rb-identity").innerText()), "a legacy YNVD.TO holding is kept as typed and identified as the same Cboe Canada ETF");
    await row(page, 0).locator("details summary").click();
    check(/NEOE/.test(await row(page, 0).locator("details dl").textContent()) && !/XTSE/.test(await row(page, 0).locator("details dl").textContent()), "YNVD.TO is never a Toronto Stock Exchange listing");
    check(net.errors.length === 0, `no page errors (${net.errors.join("; ")})`);
    check(!disallowedRequests(net.external).length, `only allowed hosts contacted (${disallowedRequests(net.external).slice(0, 3).join(", ")})`);
    const stored = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(k => !k.startsWith("md.key.v2.")).map(k => k + "=" + (localStorage.getItem(k) || sessionStorage.getItem(k))).join("\n"));
    check(!stored.includes(TEST_KEY) && !stored.includes(FH_KEY), "no key in any storage entry other than its own key slot");
    check(!/rb\.|VEQT|305/.test(await page.evaluate(() => Object.keys(localStorage).filter(k => !k.startsWith("md.")).join(","))), "holdings are not stored");
    await context.close();
  }

  /* ---------- 3. incident regressions: burst on request 2, then a genuine daily limit ---------- */
  {
    const mode = { avBurstOn: [2] };
    const { context, page, calls } = await newPage(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY, true);
    await loadSample(page);
    await page.click("#rbPriceAll");
    await idle(page);
    const priced = await page.locator("#rbRows .rb-row[data-tone='ok']").count();
    check(priced === 12, `burst notice on request 2 (full 2026 wording): all 12 coverable holdings priced after a retry (${priced})`);
    check(calls.av.length === 13, `the burst was retried once (${calls.av.length} Alpha Vantage requests for 12 holdings)`);
    check(!/daily limit/i.test(await page.locator("#rb-app").innerText()), "a burst notice never says 'daily limit'");
    const usage = await page.evaluate(() => Object.keys(localStorage).filter(k => k.endsWith(".usage")).map(k => localStorage.getItem(k)));
    check(usage.length === 1 && !/limit":\{/.test(usage[0]), `no limit recorded after a burst (${usage[0]})`);
    await context.close();
  }
  {
    const mode = { avLimit: 2 };
    const { context, page, calls } = await newPage(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY, true);
    await loadSample(page);
    await page.click("#rbPriceAll");
    await idle(page);
    check(calls.av.length === 3, `daily limit on request 3: no further Alpha Vantage request from this browser (${calls.av.length})`);
    await page.click("#rbRun");
    const withheld = await page.locator("#rbResults").innerText();
    const lines = withheld.split("\n").filter(l => /daily limit/.test(l));
    check(lines.length === 1 && /CBRS|AAPL/.test(lines[0]) && /,/.test(lines[0]), `the limit is reported once, listing the affected holdings (${lines.length} line(s))`);
    check(await page.locator("#rbRows .rb-row button", { hasText: "Check again" }).count() > 0, "affected holdings offer Check again");
    const providerText = await page.locator("#rbProviders").innerText();
    check(/reported its daily limit/.test(providerText) && /standard API rate limit is 25 requests per day/.test(providerText), "the provider's own wording is shown (redacted)");
    check(!providerText.includes(TEST_KEY), "the notice that echoed the key is redacted");
    // A reload keeps the record: no request is spent rediscovering it.
    const page2 = await context.newPage();
    await page2.goto(PAGE, { waitUntil: "networkidle" });
    await page2.waitForSelector('#rb-app[data-ready="true"]');
    await page2.click("#rbSample");
    await page2.waitForFunction(() => document.querySelectorAll("#rbRows .rb-row .rb-identity:not([hidden])").length === 14);
    const sent = calls.av.length;
    await page2.click("#rbPriceAll");
    await page2.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false");
    await page2.waitForTimeout(300);
    check(calls.av.length === sent, `after a reload the recorded limit is honoured without a request (${calls.av.length - sent} sent)`);
    // Check again: one request; the mock still answers with the limit.
    if ((await page2.locator("#rbKeysPanel").getAttribute("open")) === null) await page2.click("#rbKeysPanel > summary");
    await page2.locator("#rbProviders").getByRole("button", { name: /Check again/ }).click();
    await page2.waitForFunction(() => /Alpha Vantage/.test(document.querySelector("#rbStatus").textContent) && !/Checking/.test(document.querySelector("#rbStatus").textContent));
    check(calls.av.length === sent + 1, "Check again sends exactly one request");
    await context.close();
  }

  /* ---------- 4. late answers: ticker change and source change mid-request ---------- */
  {
    let release;
    const mode = { hold: { "VEQT.TRT": new Promise(r => { release = r; }) } };
    const { context, page, calls } = await newPage(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await row(page, 0).locator(".rb-ticker").fill("VEQT.TO");
    await row(page, 0).locator(".rb-shares").fill("305");
    await row(page, 0).locator(".rb-weight").fill("100");
    await row(page, 0).locator(".rb-ticker").press("Enter");
    await page.waitForFunction(() => /Fetching/.test(document.querySelector("#rbRows .rb-line").textContent));
    check(calls.av.includes("GLOBAL_QUOTE:VEQT.TRT"), "VEQT.TO request in flight");
    await row(page, 0).locator(".rb-ticker").fill("VFV.TO");
    await row(page, 0).locator(".rb-ticker").press("Enter");
    release();
    await idle(page);
    await page.waitForTimeout(300);
    const detail = await row(page, 0).locator("details dl").textContent().catch(() => "");
    check((await row(page, 0).locator(".rb-ticker").inputValue()) === "VFV.TO" && !/VEQT/.test(detail + (await lineOf(page, 0))), "the late VEQT.TO answer never fills in VFV.TO");
    check(/VFV\.TRT/.test(detail), `the row shows the VFV.TO quote (${detail.replace(/\s+/g, " ").slice(0, 80)})`);
    await context.close();
  }
  {
    let release;
    const mode = { hold: { AAPL: new Promise(r => { release = r; }) } };
    const { context, page } = await newPage(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await saveKey(page, "Finnhub", FH_KEY);
    await row(page, 0).locator(".rb-ticker").fill("AAPL");
    await row(page, 0).locator(".rb-shares").fill("2");
    await row(page, 0).locator(".rb-weight").fill("100");
    await row(page, 0).locator(".rb-ticker").press("Enter");
    await page.waitForFunction(() => /Fetching/.test(document.querySelector("#rbRows .rb-line").textContent));
    await page.selectOption("#rbSource", "alphavantage");
    release();
    await page.waitForTimeout(500);
    check(!/Finnhub/.test(await lineOf(page, 0)), "a source change mid-request discards the old source's late answer");
    await context.close();
  }

  /* ---------- 5. Marketstack: monthly limit recorded; YNVD not requested ---------- */
  {
    const mode = { msLimit: 1 };
    const { context, page, calls } = await newPage(browser, mode);
    await saveKey(page, "Marketstack", MS_KEY);
    await page.selectOption("#rbSource", "marketstack");
    await loadSample(page);
    const msEstimate = await page.locator("#rbEstimate").innerText();
    check(/about 13 Marketstack requests/.test(msEstimate) && /uses 13 of the 100 left/.test(msEstimate) && /YNVD\.NE/.test(msEstimate), `Marketstack estimate: 13 requests of 100, YNVD.NE not covered (${msEstimate.slice(0, 160)})`);
    await page.click("#rbPriceAll");
    await idle(page);
    check(calls.ms.length === 2 && !calls.ms.some(s => /YNVD/.test(s)), `Marketstack: one success, then the monthly limit stops further requests (${calls.ms.join(",")})`);
    check(/monthly limit/.test(await page.locator("#rbProviders").innerText()), "Marketstack's monthly limit is recorded and shown");
    await context.close();
  }

  /* ---------- 6. layout: no horizontal scrolling, readable financial values ---------- */
  {
    const { context, page } = await newPage(browser, {});
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await saveKey(page, "Finnhub", FH_KEY);
    await page.check("#rbShowAccount");
    await loadSample(page);
    await page.click("#rbPriceAll");
    await idle(page);
    await manualPrice(page, 8, "44.21");
    await manualPrice(page, 10, "2850");
    await page.click("#rbRun");
    check(await page.locator("#rbResults .rb-act").count() === 14, "layout check runs with a fourteen-holding plan");
    if ((await page.locator("#rbKeysPanel").getAttribute("open")) === null) await page.click("#rbKeysPanel > summary");
    await page.click("#rbFxPanel > summary");
    await page.locator("#rbResults details").first().locator("summary").click();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const app = document.querySelector("#rb-app");
        const offenders = [...app.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > doc.clientWidth + 1 || (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX))).map(n => n.className || n.tagName).slice(0, 4);
        const sizes = [...document.querySelectorAll("#rbResults .rb-act-line span, #rbRows .rb-price, #rbResults .pj-tile strong, #rbRows input")].map(n => parseFloat(getComputedStyle(n).fontSize));
        return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders, minFont: Math.min(...sizes) };
      });
      check(m.scroll <= m.client && !m.offenders.length, `${width}px: no horizontal scroll (${m.scroll}/${m.client}${m.offenders.length ? `; ${m.offenders.join(", ")}` : ""})`);
      check(m.minFont >= 14, `${width}px: financial values at least 14px (min ${m.minFont}px)`);
    }
    await context.close();
  }

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
