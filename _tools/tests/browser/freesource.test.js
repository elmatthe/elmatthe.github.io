// Browser test: Yahoo Finance through this site's data gateway (no key) in the Portfolio
// Rebalancer and the Stock Comparison web apps, end to end in Chromium.
//
// The pages are opened with ?mdgateway=https://md.gateway.test (honoured only on a page
// served from 127.0.0.1). harness.js answers that host with the REAL gateway code from
// _services/market-data-gateway running in this process; the gateway's upstream is the
// synthetic Yahoo fixtures (_tools/tests/fixtures/yahoo-chart.mjs). Yahoo Finance is
// never contacted, no real key is used, and every other host is mocked or blocked.
//
// Covers: a new browser profile with no keys (Yahoo Finance first and on by default),
// no gateway configured, a gateway whose source is switched off, an unreachable gateway,
// the fourteen-holding sample across seven markets and currencies (exact listing,
// GBp -> GBP), malformed, mismatched and missing data, rate limits (requests stop and
// pause, never loop), a timeout and an outage (the gateway's breaker pauses requests),
// gateway and browser caches, the order of Yahoo Finance and personal-key providers,
// privacy of the requests, exports without secrets, Stock Comparison history (1D..5Y,
// both price bases, FX normalization, exports), narrow layouts, console errors and
// basic accessibility structure. The fallback chain itself is in sources.test.js.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { SITE_URL, MD_GATEWAY, TEST_KEY, FH_KEY, launch, mockMarketData, watchNetwork, checker, disallowedRequests } = require("./harness");

const RB = `${SITE_URL}/projects/portfolio-rebalancer/`;
const SD = `${SITE_URL}/projects/stock-data-dashboard-tool/`;
const WITH_GATEWAY = `?mdgateway=${encodeURIComponent(MD_GATEWAY)}`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "freesource-test-"));
const num = text => Number(String(text).replace(/[^0-9.\-]/g, ""));
const SAMPLE = [
  ["VEQT.TO", "305", "63"], ["CNQ.TO", "48", "9"], ["XQQ.TO", "27", "6.3"], ["HEWB.TO", "14", "4.5"], ["AAPL", "2", "1.8"],
  ["VFV.TO", "8", "0.9"], ["SPCX", "1", "0.9"], ["CBRS", "4", "0.9"], ["YNVD.NE", "4", "1.8"], ["VST", "1", "0.9"],
  ["7203.T", "1", "2.5"], ["SAP.DE", "1", "2.5"], ["VOD.L", "1", "2.5"], ["600519.SS", "1", "2.5"],
];
const ATTESTATION_TEXT = "owner-confirms-yahoo-permission"; // the gateway's activation value: never echoed to a page

async function open(browser, url, mode, opts = {}) {
  const context = opts.context || await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...opts.contextOptions });
  const calls = opts.calls || await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(url, { waitUntil: "networkidle" });
  const root = url.includes("rebalancer") ? "#rb-app" : "#sdd-app";
  await page.waitForSelector(`${root}[data-ready="true"]`);
  await page.waitForFunction(r => { const s = document.querySelector(r).dataset.freeSource; return s && s !== "checking"; }, root);
  if (root === "#rb-app") await page.waitForSelector('#rb-app[data-fx-ready="true"]');
  return { context, page, calls, net };
}
const rbIdle = async page => {
  await page.waitForTimeout(50);
  await page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !document.querySelector('.rb-row[aria-busy="true"]') && !/fetching|getting prices/i.test(document.querySelector("#rbStatus").textContent), null, { timeout: 120000 });
};
const row = (page, i) => page.locator("#rbRows .rb-row").nth(i);
const lineOf = (page, i) => row(page, i).locator(".rb-line").innerText();
const rowValues = page => page.$$eval("#rbRows .rb-row", rows => rows.map(r => [r.querySelector(".rb-ticker").value, r.querySelector(".rb-shares").value, r.querySelector(".rb-weight").value]));
const quoteCalls = calls => calls.gateway.filter(c => /\/v1\/quote\?/.test(c.url));
const historyCalls = calls => calls.gateway.filter(c => /\/v1\/history\?/.test(c.url));
async function loadSample(page) {
  await page.click("#rbSample");
  await page.waitForFunction(() => document.querySelectorAll("#rbRows .rb-row .rb-identity:not([hidden])").length === 14);
}
async function importHoldings(page, name, lines) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, `ticker,shares,target_pct,account\r\n${lines.join("\r\n")}\r\n`);
  if ((await page.locator(".rb-csv").getAttribute("open")) === null) await page.locator(".rb-csv > summary").click();
  await page.setInputFiles("#rbImportHoldings", file);
  await page.waitForFunction(n => new RegExp(`Imported ${n} holdings`).test(document.querySelector("#rbStatus").textContent), lines.length);
  await page.waitForFunction(n => document.querySelectorAll("#rbRows .rb-row").length === n, lines.length);
}
async function saveKey(page, provider, key, remember = false) {
  if ((await page.locator("#rbKeysPanel").getAttribute("open")) === null) await page.click("#rbKeysPanel > summary");
  const card = page.locator(`#rbProviders section[aria-label="${provider}"]`);
  await card.locator('input[type="password"]').fill(key);
  if (remember) await card.locator('input[type="checkbox"]').check();
  await card.locator('button[type="submit"]').click();
}
async function download(page, selector, name) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  const target = path.join(OUT, name);
  await file.saveAs(target);
  return target;
}
// Every visible form control has an accessible name; ids are unique; live regions exist.
async function a11yProblems(page, rootSelector) {
  return page.evaluate(sel => {
    const root = document.querySelector(sel);
    const problems = [];
    const ids = [...document.querySelectorAll("[id]")].map(n => n.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) problems.push(`duplicate ids: ${[...new Set(dupes)].slice(0, 5).join(", ")}`);
    for (const n of root.querySelectorAll("input, select, textarea, button")) {
      if (n.type === "hidden" || n.closest("[hidden]") || n.offsetParent === null) continue;
      const labelled = n.getAttribute("aria-label") || n.getAttribute("aria-labelledby") || (n.id && document.querySelector(`label[for="${CSS.escape(n.id)}"]`)) || n.closest("label") || (n.tagName === "BUTTON" && n.textContent.trim());
      if (!labelled) problems.push(`unlabelled ${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}`);
    }
    if (!root.querySelector('[role="status"], [aria-live]')) problems.push("no live status region");
    return problems;
  }, rootSelector);
}
async function noHorizontalScroll(page, widths) {
  const out = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(120);
    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    out.push({ width, ok: m.scroll <= m.client, ...m });
  }
  return out;
}

(async () => {
  const { check, done } = checker();
  const browser = await launch();

  /* ================= Portfolio Rebalancer ================= */

  /* ---------- R1. new browser profile, no keys, gateway on: the free source prices all fourteen ---------- */
  {
    const mode = {};
    const { context, page, calls, net } = await open(browser, RB + WITH_GATEWAY, mode);
    check(await page.getAttribute("#rb-app", "data-free-source") === "enabled", "R1 new profile: the free source is available");
    const panel = await page.locator("#rbFreeSource").innerText();
    check(/Yahoo Finance — Free Market Data/.test(panel) && /briefly cached/.test(panel) && /Quotes may be delayed, incomplete, or differ from official exchange data/.test(panel) && /not financial advice/.test(panel) && /Available, and position 1 in your list/.test(panel), `R1 the Yahoo Finance panel explains the source, delay and caching (${panel.slice(0, 160)})`);
    check(!/Cloudflare|Worker|licen[cs]|authori[sz]ation|open.source|Python|yfinance/i.test(panel), "R1 the explanation has no technical or licensing detail");
    check(calls.gateway.length === 1 && /\/v1\/health$/.test(calls.gateway[0].url) && calls.yahoo.length === 0, `R1 page load: one gateway health check, no price request (${calls.gateway.map(c => c.url).join(", ")})`);
    const list = await page.$$eval("#rbSources .ms-item", n => n.map(i => `${i.querySelector(".ms-pos").textContent}:${i.dataset.source}:${i.dataset.status}`));
    check(JSON.stringify(list) === JSON.stringify(["1:yahoo:on", "2:alphavantage:needs_key", "3:marketstack:needs_key", "4:finnhub:needs_key"]), `R1 zero keys: Yahoo Finance on at position 1, the providers waiting for keys (${list.join(" ")})`);
    await loadSample(page);
    check(JSON.stringify(await rowValues(page)) === JSON.stringify(SAMPLE), "R1 sample: the fourteen holdings, exact shares and targets, YNVD.NE kept");
    check(/about 14 Yahoo Finance requests for 14 holdings/.test(await page.locator("#rbEstimate").innerText()) && /no key/.test(await page.locator("#rbEstimate").innerText()) && /one at a time/.test(await page.locator("#rbEstimate").innerText()), "R1 estimate: 14 Yahoo Finance requests, no key, one at a time");
    check(calls.gateway.length === 1, "R1 loading the sample sends nothing");
    await page.click("#rbPriceAll");
    await rbIdle(page);
    const quotes = quoteCalls(calls);
    const symbols = quotes.map(c => new URL(c.url).searchParams.get("symbol")).sort();
    check(JSON.stringify(symbols) === JSON.stringify(SAMPLE.map(r => r[0]).sort()), `R1 one quote request per holding, exact symbols (${symbols.join(",")})`);
    check(quotes.every(c => c.method === "GET" && [...new URL(c.url).searchParams.keys()].join() === "symbol" && !c.body), "R1 privacy: each request carries only the symbol");
    check(!calls.gateway.some(c => /305|shares|target|account|TFSA/i.test(c.url)) && quotes.every(c => !c.headers.cookie && !c.headers.authorization), "R1 privacy: no shares, targets, accounts, cookies or credentials sent");
    check(calls.av.length + calls.ms.length + calls.fh.length === 0, "R1 no personal-key provider is contacted");
    check(await page.locator("#rbRows .rb-row[data-tone='ok']").count() === 14, "R1 all fourteen holdings verified");
    check(/^Holdings: all 14 priced\.$/.test(await page.locator("#rbStatus").innerText()), "R1 status: all 14 priced");
    const lines = await Promise.all(SAMPLE.map((_, i) => lineOf(page, i)));
    check(/Verified[\s\S]*C\$[\d,.]+[\s\S]*Yahoo Finance · latest regular-session price \(may be delayed\) \d{4}-\d{2}-\d{2}/.test(lines[0]), `R1 VEQT.TO: source, price basis and trading date shown (${lines[0]})`);
    check(/US\$[\d,.]+/.test(lines[4]) && /€[\d,.]+/.test(lines[11]) && /£[\d,.]+/.test(lines[12]) && /CN¥[\d,.]+/.test(lines[13]) && /(JP)?¥[\d,.]+/.test(lines[10]) && /C\$[\d,.]+/.test(lines[8]), "R1 USD, EUR, GBP, CNY, JPY and CAD prices in their own currencies");
    check(!lines.some(l => /real-time/i.test(l)), "R1 nothing is labelled real-time");
    await row(page, 12).locator("details summary").click();
    const vod = (await row(page, 12).locator("details dl").innerText()).replace(/\s+/g, " ");
    check(/provider quoted [\d.]+ GBp/.test(vod) && /through this site's data gateway/.test(vod) && /may be delayed/i.test(vod) && /not labelled real-time/.test(vod), `R1 VOD.L: pence quote converted, source and delay stated (${vod.slice(0, 200)})`);
    const vodPrice = num(await row(page, 12).locator(".rb-price").innerText());
    check(vodPrice > 0.5 && vodPrice < 2, `R1 VOD.L valued in pounds, not pence (£${vodPrice})`);
    check(/NVIDIA \(NVDA\) Yield Shares Purpose ETF · Cboe Canada/.test(await row(page, 8).locator(".rb-identity").innerText()), "R1 YNVD.NE stays the Cboe Canada ETF");
    await page.click("#rbRun");
    const planText = await page.locator("#rbResults").innerText();
    check(/Plan ready/.test(planText) && await page.locator("#rbResults .rb-act").count() === 14 && /14 holdings valued/.test(planText), "R1 plan ready with all fourteen holdings");
    const tiles = await page.locator("#rbResults .pj-tile").allInnerTexts();
    check(/All verified/.test(tiles.join(" ")) && num(tiles.find(t => /Total buys/.test(t))) <= 3000.01 && await page.locator("#rbResults .rb-sell").count() === 0, "R1 New Money: within the budget, no sells, all prices verified");
    await page.locator("#rbResults .rb-warn-group.info summary").click();
    check(/Priced by Yahoo Finance through this site's data gateway \(no key; may be delayed; not official exchange data\): VEQT\.TO/.test(await page.locator("#rbResults").innerText()), "R1 the plan names the holdings priced by Yahoo Finance");
    const csvText = fs.readFileSync(await download(page, "#rbExportCsv", "free-plan.csv"), "utf8");
    check(/"Yahoo Finance \(no key, this site's data gateway\)",VEQT\.TO,latest regular-session price \(may be delayed\)/.test(csvText) && /^Yahoo Finance,Yahoo Finance data through this site's data gateway/m.test(csvText), "R1 CSV: source, symbol and price basis per holding, and Yahoo Finance in the summary");
    check(/^Source order \(first tried first\),1\. Yahoo Finance; 2\. Alpha Vantage \(off\); 3\. Marketstack \(off\); 4\. Finnhub \(off\)/m.test(csvText), "R1 CSV: the source order is recorded");
    check(/VOD\.L,XLON:VOD,Vodafone Group Plc,,GBP,/.test(csvText) && /through this site's data gateway/.test(csvText), "R1 CSV: VOD.L in GBP with its listing; source details column");
    check(!csvText.includes(ATTESTATION_TEXT) && !/OWNER_ATTESTATION|KEYLESS_SOURCE|SOURCE_AUTHORIZATION/.test(csvText), "R1 CSV: no gateway setting");
    try {
      const out = execFileSync(process.env.PYTHON || "python3", ["-c",
        "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);cells=[str(c.value) for ws in wb for r in ws.iter_rows() for c in r if c.value is not None];" +
        "print('|'.join(wb.sheetnames), wb['Trade Plan'].max_row, any(isinstance(c,str) and c.startswith('=') for c in cells), any(sys.argv[2] in c for c in cells), any('Yahoo Finance (no key, this site' in c for c in cells))",
        await download(page, "#rbExportXlsx", "free-plan.xlsx"), ATTESTATION_TEXT], { encoding: "utf8" }).trim();
      check(out === "Trade Plan|Summary 15 False False True", `R1 Excel: 14 holdings, no formulas, no secret, source tier stated (${out})`);
    } catch (error) { check(false, `R1 Excel export validation: ${String(error.message).slice(0, 160)}`); }
    const stored = await page.evaluate(() => Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
    check(stored.every(([k]) => k.startsWith("md.") || k === "sdd.theme"), "R1 storage: market data only (no holdings)");
    check(stored.filter(([k]) => k.startsWith("md.keyless.v1.")).every(([, v]) => !/shares|targetWeight|accountType/.test(v)), "R1 the free source's saved copies hold no portfolio fields");
    check(net.errors.length === 0, `R1 no console or page errors (${net.errors.join("; ")})`);
    check(!disallowedRequests(net.external).length && calls.blocked.length === 0, `R1 only allowed hosts contacted (${disallowedRequests(net.external).slice(0, 3).join(", ")})`);
    const a11y = await a11yProblems(page, "#rb-app");
    check(!a11y.length, `R1 accessibility structure: labelled controls, unique ids, live regions (${a11y.join("; ")})`);
    check(await page.getAttribute("#rbFreeState", "role") === "status" && await page.getAttribute("#rbSrcLive", "aria-live") === "polite", "R1 Yahoo Finance's state and source-list changes are announced (status regions)");
    await page.click("#rbFxPanel > summary");
    const layout = await noHorizontalScroll(page, [360, 390, 768, 1280]);
    check(layout.every(l => l.ok), `R1 no horizontal scroll at 360–1280 px with prices and plan (${layout.map(l => `${l.width}:${l.scroll}/${l.client}`).join(" ")})`);

    /* ---------- R2. caches: a second visitor gets the gateway's copy; this browser reuses its own ---------- */
    const yahooBefore = calls.yahoo.length;
    const second = await open(browser, RB + WITH_GATEWAY, mode); // same mode object: the same gateway instance
    await loadSample(second.page);
    await second.page.click("#rbPriceAll");
    await rbIdle(second.page);
    check(quoteCalls(second.calls).length === 14 && calls.yahoo.length === yahooBefore, `R2 another browser: 14 gateway requests, no new upstream request (${calls.yahoo.length - yahooBefore})`);
    check(/\(gateway copy, \d+ min old\)/.test(await lineOf(second.page, 0)) && await second.page.locator("#rbRows .rb-row[data-tone='ok']").count() === 14, "R2 gateway cache hits are labelled with their age");
    await second.page.locator("#rbRows .rb-row").first().locator("details summary").click();
    check(/the gateway's saved copy, \d+ min old/.test(await second.page.locator("#rbRows .rb-row").first().locator("details dl").innerText()), "R2 details give the retrieval time and the copy's age");
    await second.context.close();
    const before = quoteCalls(calls).length;
    const again = await open(browser, RB + WITH_GATEWAY, mode, { context, calls });
    await loadSample(again.page);
    check(/about 0 Yahoo Finance requests/.test(await again.page.locator("#rbEstimate").innerText()) || /needs no requests|about 0/.test(await again.page.locator("#rbEstimate").innerText()), `R2 estimate: copies saved in this browser cost nothing (${(await again.page.locator("#rbEstimate").innerText()).slice(0, 120)})`);
    await again.page.click("#rbPriceAll");
    await rbIdle(again.page);
    check(quoteCalls(calls).length === before && /\(saved copy, \d+ min old\)/.test(await lineOf(again.page, 0)), "R2 this browser's saved copy: no request, labelled");
    await context.close();
  }

  /* ---------- R3. production configuration: no gateway configured ---------- */
  {
    const { context, page, calls } = await open(browser, `${RB}?mdgateway=none`, {});
    check(await page.getAttribute("#rb-app", "data-free-source") === "not_configured" && calls.gateway.length === 0, "R3 no gateway configured: nothing is contacted");
    check(/Not available on this site yet/.test(await page.locator("#rbFreeSource").innerText()), "R3 the page says Yahoo Finance is not available yet");
    await context.close();
  }

  /* ---------- R4. gateway deployed, source switched off: user-supplied prices still work ---------- */
  {
    const mode = { gatewayOff: true };
    const { context, page, calls, net } = await open(browser, RB + WITH_GATEWAY, mode);
    check(await page.getAttribute("#rb-app", "data-free-source") === "disabled", "R4 switched-off source detected from the gateway's health");
    check(/Not available right now: it is switched off on this site at the moment/.test(await page.locator("#rbFreeSource").innerText()) && !/KEYLESS_SOURCE|OWNER_ATTESTATION/.test(await page.locator("#rb-app").innerText()), "R4 a plain reason is shown, no gateway setting names");
    check(/On, but unavailable: switched off on this site at the moment/.test(await page.locator("#rbSources .ms-item[data-source='yahoo'] .ms-state").innerText()), "R4 the source list says why Yahoo Finance is unavailable");
    check(await page.locator("#rbFreeSource button", { hasText: "Check again" }).count() === 1, "R4 Check again is offered");
    await loadSample(page);
    check(/Yahoo Finance is switched off on this site at the moment/.test(await page.locator("#rbEstimate").innerText()) && /add your own key/i.test(await page.locator("#rbEstimate").innerText()), "R4 estimate explains why nothing can be fetched");
    await page.click("#rbPriceAll");
    await rbIdle(page);
    check(quoteCalls(calls).length === 0 && calls.yahoo.length === 0, "R4 no price request to a switched-off source");
    check(/0 of 14 priced/.test(await page.locator("#rbStatus").innerText()) && /no source available/.test(await page.locator("#rbStatus").innerText()), `R4 every holding names the reason (${(await page.locator("#rbStatus").innerText()).slice(0, 160)})`);
    await page.click("#rbRun");
    check(/Plan withheld/.test(await page.locator("#rbResults").innerText()), "R4 plan withheld without prices");
    const pricesCsv = path.join(OUT, "own-prices.csv");
    fs.writeFileSync(pricesCsv, ["ticker,price,currency", ...SAMPLE.map(([t], i) => `${t},${t === "VOD.L" ? "72.5" : (10 + i).toFixed(2)},${{ "7203.T": "JPY", "SAP.DE": "EUR", "VOD.L": "GBp", "600519.SS": "CNY", AAPL: "USD", SPCX: "USD", CBRS: "USD", VST: "USD" }[t] || "CAD"}`)].join("\r\n"));
    if ((await page.locator(".rb-csv").getAttribute("open")) === null) await page.locator(".rb-csv > summary").click();
    await page.setInputFiles("#rbImportPrices", pricesCsv);
    await page.waitForFunction(() => /Plan includes 14 prices you supplied/.test(document.querySelector("#rbResults").textContent), null, { timeout: 30000 });
    check(/User-supplied/.test(await lineOf(page, 12)) && num(await row(page, 12).locator(".rb-price").innerText()) === 0.73, "R4 imported prices are used and labelled; GBp converted (72.5p = £0.73)");
    check(net.errors.length === 0, `R4 no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- R5. gateway unreachable, then reachable after Check again ---------- */
  {
    const mode = { gatewayDown: true };
    const { context, page, calls, net } = await open(browser, RB + WITH_GATEWAY, mode);
    check(await page.getAttribute("#rb-app", "data-free-source") === "unreachable" && /could not be reached/.test(await page.locator("#rbFreeSource").innerText()), "R5 an unreachable gateway is reported, not assumed");
    await row(page, 0).locator(".rb-ticker").fill("AAPL");
    await row(page, 0).locator(".rb-shares").fill("2");
    await row(page, 0).locator(".rb-weight").fill("100");
    await row(page, 0).locator(".rb-ticker").press("Enter");
    check(/could not be reached/.test(await lineOf(page, 0)), "R5 the holding says why it has no price");
    mode.gatewayDown = false;
    await page.locator("#rbFreeSource button", { hasText: "Check again" }).click();
    await page.waitForFunction(() => document.querySelector("#rb-app").dataset.freeSource === "enabled");
    await page.click("#rbPriceAll");
    await rbIdle(page);
    check(/Verified[\s\S]*Yahoo Finance · /.test(await lineOf(page, 0)) && quoteCalls(calls).length === 1, "R5 after Check again Yahoo Finance prices the holding");
    check(net.errors.length === 0, `R5 no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- R6. unsupported listings, malformed, mismatched and missing data ---------- */
  {
    const mode = {};
    const { context, page, calls } = await open(browser, RB + WITH_GATEWAY, mode);
    await importHoldings(page, "odd.csv", ["AAPL,1,20,", "OTCX,1,10,", "BADCUR.DE,1,10,", "ZZZQ,1,10,", "NOPRICE,1,10,", "^GSPC,1,10,", "RELIANCE.BO,1,10,", "BADJSON,1,10,", "WRONGSYM,1,10,"]);
    await page.click("#rbPriceAll");
    await rbIdle(page);
    const sent = quoteCalls(calls).map(c => new URL(c.url).searchParams.get("symbol")).sort();
    check(JSON.stringify(sent) === JSON.stringify(["AAPL", "BADCUR.DE", "BADJSON", "NOPRICE", "OTCX", "WRONGSYM", "ZZZQ"]), `R6 unsupported listings are not requested (${sent.join(",")})`);
    const texts = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => lineOf(page, i)));
    check(/Verified/.test(texts[0]), "R6 AAPL priced");
    check(/Yahoo Finance: answered for a different listing/.test(texts[1]), "R6 OTC listing for a US symbol refused");
    check(/Yahoo Finance: could not confirm the currency/.test(texts[2]), "R6 wrong currency refused");
    check(/Yahoo Finance: has no data for this listing/.test(texts[3]) && /Yahoo Finance: has no data for this listing/.test(texts[4]), "R6 unknown symbol and missing price explained");
    for (const [i, re, what] of [[1, /different listing or exchange; the answer was not used/, "OTC"], [2, /does not trade in; the answer was not used/, "currency"], [4, /no current price/, "no price"]]) {
      await row(page, i).locator("details summary").click();
      check(re.test(await row(page, i).locator("details dl").innerText()), `R6 the source's full answer is kept in the details (${what})`);
    }
    check(/Market indexes cannot be held/.test(texts[5]) && /Not covered[\s\S]*Yahoo Finance: does not cover/.test(texts[6]), "R6 index refused locally; Bombay listing not covered");
    check(/Yahoo Finance: returned data that failed its checks/.test(texts[7]) && /failed its checks|different listing/.test(texts[8]), "R6 malformed answer and a different symbol refused");
    check(texts.slice(1).every(t => !/C\$|US\$|€|£/.test(t)), "R6 no price is shown for any refused holding");
    await page.click("#rbRun");
    check(/Plan withheld/.test(await page.locator("#rbResults").innerText()) && await page.locator("#rbResults .rb-pill").count() === 0, "R6 plan withheld while holdings lack a reliable price");
    await context.close();
  }

  /* ---------- R7. rate limit, timeout and outage: requests stop, never loop ---------- */
  {
    const limited = { gatewayLimits: { perClientPerMinute: 5 } };
    const a = await open(browser, RB + WITH_GATEWAY, limited);
    await loadSample(a.page);
    await a.page.click("#rbPriceAll");
    await rbIdle(a.page);
    const okCount = await a.page.locator("#rbRows .rb-row[data-tone='ok']").count();
    check(okCount === 5 && /sources limited or paused/.test(await a.page.locator("#rbStatus").innerText()), `R7 rate limit: 5 priced, the rest say why (${okCount})`);
    check(quoteCalls(a.calls).length === 6, `R7 after the first "too many requests" answer nothing more is sent (${quoteCalls(a.calls).length} requests for 14 holdings)`);
    const paused = await a.page.$$eval("#rbRows .rb-line", ls => ls.filter(l => /Yahoo Finance: paused after a rate limit/.test(l.textContent)).length);
    check(paused === 8, `R7 the holdings not requested say Yahoo Finance is paused (${paused})`);
    check(/Paused: paused for about \d+ more minutes? after it asked this site to slow down/.test(await a.page.locator("#rbFreeState").innerText()) && await a.page.getAttribute("#rb-app", "data-free-source") === "paused", "R7 the Yahoo Finance panel shows the pause");
    check(/On, but unavailable: paused for about/.test(await a.page.locator("#rbSources .ms-item[data-source='yahoo'] .ms-state").innerText()), "R7 the source list shows the pause");
    // A reload keeps the pause: nothing is sent until it ends.
    const reload = await open(browser, RB + WITH_GATEWAY, limited, { context: a.context, calls: a.calls });
    await loadSample(reload.page);
    const sentBefore = quoteCalls(a.calls).length;
    await reload.page.click("#rbPriceAll");
    await rbIdle(reload.page);
    check(quoteCalls(a.calls).length === sentBefore, "R7 after a reload the pause is honoured without a request");
    await a.context.close();

    const slow = { yahoo: { hang: true }, gatewayLimits: { upstreamTimeoutMs: 200 } };
    const b = await open(browser, RB + WITH_GATEWAY, slow);
    await importHoldings(b.page, "one.csv", ["AAPL,1,100,"]);
    await b.page.click("#rbPriceAll");
    await rbIdle(b.page);
    check(/Yahoo Finance: did not answer in time/.test(await lineOf(b.page, 0)) && quoteCalls(b.calls).length === 1, "R7 timeout reported by the gateway: reported, not retried");
    await b.context.close();

    const down = { yahoo: { down: true } };
    const c = await open(browser, RB + WITH_GATEWAY, down);
    await importHoldings(c.page, "four.csv", ["AAPL,1,25,", "VEQT.TO,1,25,", "MSFT,1,25,", "SPY,1,25,"]);
    await c.page.click("#rbPriceAll");
    await rbIdle(c.page);
    const outage = await Promise.all([0, 1, 2, 3].map(i => lineOf(c.page, i)));
    check(/0 of 4 priced/.test(await c.page.locator("#rbStatus").innerText()) && outage.slice(0, 3).every(l => /Yahoo Finance: unavailable/.test(l)), `R7 provider outage: reported per holding, nothing priced (${outage[0]})`);
    check(quoteCalls(c.calls).length === 3 && /Yahoo Finance: paused after an outage/.test(outage[3]) && c.calls.yahoo.length === 3, `R7 after three failures the gateway's breaker opens and the page stops asking (${quoteCalls(c.calls).length} requests, ${c.calls.yahoo.length} upstream)`);
    await c.page.click("#rbRun");
    check(/Plan withheld/.test(await c.page.locator("#rbResults").innerText()), "R7 plan withheld during an outage");
    await c.context.close();
  }

  /* ---------- R8. personal keys: Yahoo Finance stays first until the visitor reorders ---------- */
  {
    const mode = { avLimit: 0 };
    const { context, page, calls } = await open(browser, RB + WITH_GATEWAY, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY, true); // remembered: the reload below opens a new tab
    await saveKey(page, "Finnhub", FH_KEY, true);
    const order = await page.$$eval("#rbSources .ms-item", n => n.map(i => `${i.dataset.source}:${i.dataset.status}`));
    check(JSON.stringify(order) === JSON.stringify(["yahoo:on", "alphavantage:on", "marketstack:needs_key", "finnhub:on"]), `R8 saving keys switches providers on without moving them above Yahoo Finance (${order.join(" ")})`);
    await importHoldings(page, "keys.csv", ["VEQT.TO,10,50,", "AAPL,2,30,", "7203.T,1,20,"]);
    await page.click("#rbPriceAll");
    await rbIdle(page);
    check(calls.av.length === 0 && calls.fh.length === 0 && quoteCalls(calls).length === 3, `R8 first source succeeds: later sources are not asked (${calls.av.length} AV, ${calls.fh.length} FH)`);
    const firstLines = await Promise.all([0, 1, 2].map(i => lineOf(page, i)));
    check(firstLines.every(l => /Verified[\s\S]*Yahoo Finance · /.test(l) && !/used because/.test(l)), `R8 all three priced by Yahoo Finance at position 1 (${firstLines[1]})`);
    // Move Yahoo Finance to the bottom with its Move down button; the order persists.
    for (let i = 0; i < 3; i += 1) await page.locator("#rbSources .ms-item[data-source='yahoo'] [data-dir='down']").click();
    check(await page.$$eval("#rbSources .ms-item", n => n.map(i => i.dataset.source).join()) === "alphavantage,marketstack,finnhub,yahoo", "R8 Move down puts Yahoo Finance at position 4");
    const again = await open(browser, RB + WITH_GATEWAY, mode, { context, calls });
    check(await again.page.$$eval("#rbSources .ms-item", n => n.map(i => i.dataset.source).join()) === "alphavantage,marketstack,finnhub,yahoo", "R8 the order survives a reload");
    await importHoldings(again.page, "keys2.csv", ["VEQT.TO,10,50,", "AAPL,2,30,", "7203.T,1,20,"]);
    const yahooBefore = quoteCalls(calls).length;
    await again.page.click("#rbPriceAll");
    await rbIdle(again.page);
    const veqt = await lineOf(again.page, 0);
    check(/Yahoo Finance · [\s\S]*used because Alpha Vantage: daily limit reached/.test(veqt) && await row(again.page, 0).getAttribute("data-tone") === "warn", `R8 first source fails (daily limit), Finnhub is skipped (no TSX), Yahoo Finance prices VEQT.TO and the limit stays visible (${veqt})`);
    check(calls.av.length === 1, `R8 an exhausted provider is not asked again (${calls.av.length} Alpha Vantage request)`);
    check(/Finnhub · last price/.test(await lineOf(again.page, 1)) && JSON.stringify(calls.fh) === JSON.stringify(["AAPL"]), "R8 AAPL: Alpha Vantage skipped (limit recorded), Finnhub answers");
    await row(again.page, 1).locator("details summary").click();
    check(/(Skipped|Tried first)[\s\S]*Alpha Vantage: [^\n]*daily limit/.test(await row(again.page, 1).locator("details dl").innerText()), "R8 the details say why Alpha Vantage was not used");
    check(/Yahoo Finance · /.test(await lineOf(again.page, 2)) && quoteCalls(calls).length - yahooBefore <= 2, "R8 7203.T: neither key covers Tokyo, Yahoo Finance answers (this browser's copy reused)");
    if ((await again.page.locator("#rbKeysPanel").getAttribute("open")) === null) await again.page.click("#rbKeysPanel > summary");
    check(/reported its daily limit/.test(await again.page.locator("#rbProviders").innerText()), "R8 the Alpha Vantage card shows its daily limit");
    await again.page.click("#rbRun");
    check(/Needs your attention[\s\S]*VEQT\.TO: priced by Yahoo Finance because Alpha Vantage \(daily limit reached\) could not/.test(await again.page.locator("#rbResults").innerText()), "R8 the plan lists the fallback under Needs your attention");
    // Switching Yahoo Finance off leaves only the key providers.
    await again.page.locator("#rbSources .ms-item[data-source='yahoo'] input[role='switch']").uncheck();
    check(/Prices it gave were cleared \(VEQT\.TO, 7203\.T\)/.test(await again.page.locator("#rbSrcNotes").innerText()), "R8 switching a source off clears the prices it gave, by name");
    const sent = quoteCalls(calls).length;
    await again.page.click("#rbPriceAll");
    await rbIdle(again.page);
    check(quoteCalls(calls).length === sent && /Not covered|No source/.test(await lineOf(again.page, 2)), "R8 Yahoo Finance off: it is not asked");
    await context.close();
  }

  /* ================= Stock Comparison & Analytics ================= */
  async function setTickers(page, list) {
    while ((await page.locator("#sddTickerList .sdd-ticker-row").count()) < list.length) await page.click("#sddAddTicker");
    while ((await page.locator("#sddTickerList .sdd-ticker-row").count()) > list.length) await page.locator('#sddTickerList [data-action="remove"]').last().click();
    for (const [i, t] of list.entries()) await page.locator("#sddTickerList input").nth(i).fill(t);
  }
  async function run(page) {
    await page.click("#sddRunCompare");
    await page.waitForFunction(() => /Comparison complete|could not|failed|not available/i.test(document.querySelector("#sddCompareStatus").textContent) && document.querySelector("#sddRunCompare").disabled === false, null, { timeout: 120000 });
    return page.locator("#sddCompareStatus").innerText();
  }
  const metricCells = (page, column) => page.$$eval("#sddMetricsTable tbody tr", (rows, c) => rows.map(r => r.children[c].textContent), column);

  /* ---------- S1. new profile: free source by default; seven markets; both bases; exports ---------- */
  {
    const mode = {};
    const { context, page, calls, net } = await open(browser, SD + WITH_GATEWAY, mode);
    check(await page.isChecked('input[name="source"][value="market"]') && await page.locator('input[name="source"][value="free"], input[name="source"][value="live"]').count() === 0, "S1 new profile: market data from the source list is selected by default");
    check(/Yahoo Finance/.test(await page.locator("#sddPipelineState").innerText()) && /no key needed/.test(await page.locator("#sddPipelineDetail").innerText()), "S1 the status widget names Yahoo Finance as tried first");
    check(/Yahoo Finance: available \(position 1 in your list\)/.test(await page.locator("#sddFreeSourceState").innerText()), "S1 Settings: available");
    check(/1\. Yahoo Finance · 2\. Alpha Vantage \(off\) · 3\. Marketstack \(off\) · 4\. Finnhub \(off\)/.test(await page.locator("#sddSourceOrder").innerText()), "S1 the compare form shows the source order");
    const marketstack = await page.locator("#sddSources .ms-item[data-source='marketstack'] .ms-why").innerText();
    check(/Not used on this page: Marketstack provides latest prices only, not price history/.test(marketstack), `S1 a latest-price-only source is never presented as a history source (${marketstack})`);
    check(calls.gateway.length === 1 && calls.yahoo.length === 0, "S1 page load: one health check only");
    const TICKERS = ["AAPL", "VEQT.TO", "SAP.DE", "VOD.L", "7203.T", "600519.SS"];
    await setTickers(page, TICKERS);
    await page.selectOption("#sddHorizon", "1Y");
    check(/at most 6 Yahoo Finance requests/.test(await page.locator("#sddEstimate").innerText()), "S1 request estimate shown");
    const status = await run(page);
    check(/Comparison complete: 6 securities, 1Y, daily prices\./.test(status), `S1 comparison: six securities, daily (${status})`);
    const meta = await page.locator("#sddCompareMeta").innerText();
    check(/Yahoo Finance \(no key\)/.test(meta) && /252 periods per year/.test(meta), "S1 meta: source and annualization");
    check(JSON.stringify(await metricCells(page, 1)) === JSON.stringify(["USD", "CAD", "EUR", "GBP", "JPY", "CNY"]), `S1 each series in its listing currency (${(await metricCells(page, 1)).join(",")})`);
    check((await metricCells(page, 2)).every(t => /Adjusted close/.test(t)), "S1 adjusted closes when requested and available");
    const hist = historyCalls(calls);
    check(hist.length === 6 && hist.every(c => { const p = new URL(c.url).searchParams; return [...p.keys()].sort().join() === "interval,range,symbol" && p.get("interval") === "1d" && ["1mo", "3mo", "6mo", "1y", "2y", "5y"].includes(p.get("range")); }), "S1 history requests: symbol, an allowlisted range and 1d only");
    check(JSON.stringify(hist.map(c => new URL(c.url).searchParams.get("symbol"))) === JSON.stringify(TICKERS), "S1 exact symbols requested");
    const sources = await page.locator("#sddCompareSources").innerText();
    check(TICKERS.every(t => new RegExp(`${t.replace(".", "\\.")} · Yahoo Finance \\(no key\\) \\(this site's data gateway\\)`).test(sources)) && /symbol VOD\.L/.test(sources) && /retrieved/.test(sources), `S1 provenance for every series (${sources.slice(0, 200)})`);
    check(/split/i.test(sources) && /dividend/i.test(sources), "S1 adjustment notes state what each basis means");
    const warnings = await page.locator("#sddCompareWarnings").innerText();
    check(/VOD\.L: prices quoted in GBp \(minor units\) were converted to GBP/.test(warnings) && /Yahoo Finance \(through this site's data gateway, no key\)/.test(warnings), "S1 pence conversion and the Yahoo Finance note shown");
    check(await page.locator("#sddCorrelation table").count() === 1 && await page.locator("#sddRegression table").count() === 1, "S1 correlation and regression computed");
    const adjustedReturns = await metricCells(page, 3);
    // Exports.
    await page.click("#sddTab-export");
    const metricsCsv = fs.readFileSync(await download(page, "#sddExportMetrics", "free-metrics.csv"), "utf8");
    check(TICKERS.every(t => new RegExp(`^${t.replace(".", "\\.")},[A-Z]{3},Adjusted close \\(dividends included\\),daily,[^\\n]*,Yahoo Finance \\(no key\\) \\(this site's data gateway\\),[A-Z]{3}\\r?$`, "m").test(metricsCsv)), "S1 metrics CSV: source per series");
    const pricesCsv = fs.readFileSync(await download(page, "#sddExportPrices", "free-prices.csv"), "utf8");
    check(/,VOD\.L,0\.\d+,Adjusted close \(dividends included\),GBP,Yahoo Finance \(no key\) \(this site's data gateway\),GBP/.test(pricesCsv), "S1 prices CSV: source per row, VOD.L in pounds");
    const json = JSON.parse(fs.readFileSync(await download(page, "#sddExportJson", "free.json"), "utf8"));
    check(json.comparison.provenance.length === 6 && json.comparison.provenance.every(p => p.sourceTier === "free" && p.sourceId === "yahoo" && p.source === "Yahoo Finance (no key)") && /1\. Yahoo Finance/.test(json.comparison.sourceOrder), "S1 JSON: provenance and source order for every series");
    try {
      const out = execFileSync(process.env.PYTHON || "python3", ["-c",
        "import sys,openpyxl,warnings;warnings.simplefilter('error');wb=openpyxl.load_workbook(sys.argv[1]);cells=[str(c.value) for ws in wb for r in ws.iter_rows() for c in r if c.value is not None];raw=wb['Raw Data Ingestion'];" +
        "print(len(wb.sheetnames), any(isinstance(c,str) and c.startswith('=') for c in cells), any(sys.argv[2] in c for c in cells), any('Yahoo Finance through this site' in c for c in cells), [c.value for c in raw[1]][-1])",
        await download(page, "#sddExportXlsx", "free.xlsx"), ATTESTATION_TEXT], { encoding: "utf8" }).trim();
      check(out === "5 False False True Source", `S1 workbook: five sheets, no formulas or secrets, data source and per-row source (${out})`);
    } catch (error) { check(false, `S1 workbook validation: ${String(error.message).slice(0, 160)}`); }
    await page.click("#sddTab-compare");

    // Price-return basis: closes, never relabelled; different from the adjusted result.
    await page.selectOption("#sddBasis", "close");
    await run(page);
    check((await metricCells(page, 2)).every(t => /^Close/.test(t)) && JSON.stringify(await metricCells(page, 3)) !== JSON.stringify(adjustedReturns), "S1 close basis: plain closes, results differ from adjusted");
    // A series without adjusted closes is not relabelled: mixed bases are flagged.
    await page.selectOption("#sddBasis", "adjusted");
    await setTickers(page, ["AAPL", "NOADJ"]);
    await page.selectOption("#sddHorizon", "3M");
    await run(page);
    check(JSON.stringify(await metricCells(page, 2)) === JSON.stringify(["Adjusted close (dividends included)", "Close (price only)"]) && /Not comparable \(mixed price bases\)/.test(await page.locator("#sddTiles").innerText()), "S1 no adjusted closes: plain closes used and flagged, never relabelled");
    check(/NOADJ: the provider returned no adjusted closes/.test(await page.locator("#sddCompareWarnings").innerText()), "S1 the basis fallback is stated");
    // FX normalization with official rates.
    await setTickers(page, ["VEQT.TO", "VOD.L", "SAP.DE"]);
    await page.selectOption("#sddHorizon", "6M");
    await page.selectOption("#sddNormalize", "CAD");
    await run(page);
    check((await metricCells(page, 1)).every(t => /^CAD/.test(t)) && /GBP→CAD from Bank of Canada/.test(await page.locator("#sddCompareWarnings").innerText()), "S1 normalized to CAD with Bank of Canada rates");
    await page.selectOption("#sddNormalize", "off");
    // Horizons 1D and 5Y.
    await setTickers(page, ["AAPL", "SPY"]);
    await page.selectOption("#sddHorizon", "1D");
    check(/Comparison complete: 2 securities, 1D/.test(await run(page)) && (await metricCells(page, 8)).every(n => n === "1"), "S1 1D: one return per series");
    await page.selectOption("#sddHorizon", "5Y");
    check(/Comparison complete: 2 securities, 5Y, daily/.test(await run(page)) && (await metricCells(page, 8)).every(n => Number(n) > 1000) && new URL(historyCalls(calls).at(-1).url).searchParams.get("range") === "5y", "S1 5Y: about five years of daily returns from the 5y range");
    // Unsupported and unknown tickers are skipped with reasons; no substitution.
    await setTickers(page, ["AAPL", "MSFT", "^GSPC", "ZZZQ"]);
    await page.selectOption("#sddHorizon", "1M");
    const partial = await run(page);
    const notice = await page.locator("#sddCompareNotice").innerText();
    check(/Comparison complete: 2 securities/.test(partial) && /2 tickers skipped/.test(partial) && /\^GSPC: market indexes are not available from these sources/.test(notice) && /ZZZQ: [\s\S]*Yahoo Finance: has no data for this listing/.test(notice), `S1 index and unknown ticker skipped with reasons (${notice.replace(/\s+/g, " ").slice(0, 200)})`);
    check(!historyCalls(calls).some(c => /GSPC/.test(c.url)), "S1 the index is never requested");
    // Snapshot through the free source.
    await page.click("#sddTab-snapshot");
    await page.fill("#sddSnapshotTicker", "vod.l");
    await page.click("#sddSnapshotRun");
    await page.waitForSelector("#sddSnapshotResult:not([hidden])", { timeout: 60000 });
    const market = await page.locator("#sddSnapshotMarket").innerText();
    check(/GBP/.test(await page.locator("#sddSnapshotIdentity").innerText()) && /0\.\d+ GBP/.test(market) && /may be delayed/.test(market) && /Last available price|Intraday/.test(market), `S1 snapshot: VOD.L in pounds, dated, delay stated (${market.replace(/\s+/g, " ").slice(0, 160)})`);
    check(/Yahoo Finance \(no key\)/.test(await page.locator("#sddSnapshotSource").innerText()) && /may be delayed/.test(await page.locator("#sddSnapshotSource").innerText()), "S1 snapshot names its source and that it may be delayed");
    // The demo still works and makes no request.
    await page.click("#sddTab-compare");
    const sent = calls.gateway.length;
    await page.check('input[name="source"][value="demo"]');
    check(/Comparison complete/.test(await run(page)) && calls.gateway.length === sent && /Synthetic demo/.test(await page.locator("#sddCompareMeta").innerText()), "S1 offline demo still available, no request");
    check(net.errors.length === 0, `S1 no console or page errors (${net.errors.join("; ")})`);
    check(!disallowedRequests(net.external).length && calls.blocked.length === 0, "S1 only allowed hosts contacted");
    const a11y = await a11yProblems(page, "#sdd-app");
    check(!a11y.length, `S1 accessibility structure (${a11y.join("; ")})`);
    const layout = await noHorizontalScroll(page, [360, 390, 768]);
    check(layout.every(l => l.ok), `S1 no horizontal page scroll at 360–768 px (${layout.map(l => `${l.width}:${l.scroll}/${l.client}`).join(" ")})`);
    await context.close();
  }

  /* ---------- S2. switched-off gateway; a saved Alpha Vantage key does not jump ahead of Yahoo Finance ---------- */
  {
    const { context, page, calls } = await open(browser, SD + WITH_GATEWAY, { gatewayOff: true });
    check(/\(no source available\)/.test(await page.locator("#sddFreeState").innerText()) && /Unavailable/.test(await page.locator("#sddPipelineState").innerText()), "S2 switched off: no history source available is stated");
    check(/switched off on this site at the moment/.test(await page.locator("#sddFreeSourceState").innerText()) && /switched off/.test(await page.locator("#sddPipelineDetail").innerText()), "S2 Settings and status say it is switched off");
    check(historyCalls(calls).length + quoteCalls(calls).length === 0, "S2 nothing requested from a switched-off source");
    await context.close();
    const mode = {};
    const first = await open(browser, SD + WITH_GATEWAY, mode);
    await first.page.click("#sddTab-settings");
    await first.page.fill("#sddKey", TEST_KEY);
    await first.page.check("#sddKeyRemember");
    await first.page.click('#sddKeyForm button[type="submit"]');
    const reload = await open(browser, SD + WITH_GATEWAY, mode, { context: first.context, calls: first.calls });
    check(/Yahoo Finance/.test(await reload.page.locator("#sddPipelineState").innerText()) && /Then: Alpha Vantage/.test(await reload.page.locator("#sddPipelineDetail").innerText()), "S2 with a saved Alpha Vantage key, Yahoo Finance stays first and Alpha Vantage follows");
    await first.context.close();
  }

  /* ---------- S3. a reused ticker: prices from before the listing date appear nowhere ---------- */
  {
    const LISTED = "2026-06-12"; // SPCX's listedFrom: an older security used the ticker before that
    const mode = {};
    const { context, page, net } = await open(browser, SD + WITH_GATEWAY, mode);
    await setTickers(page, ["SPCX", "AAPL"]);
    await page.selectOption("#sddHorizon", "1Y");
    const status = await run(page);
    check(/Comparison complete: 2 securities, 1Y, daily prices\./.test(status), `S3 comparison completes (${status})`);
    const ranges = await metricCells(page, 9);
    check(ranges[0].slice(0, 10) >= LISTED && ranges[1].slice(0, 10) < LISTED, `S3 metrics: SPCX starts at its listing, AAPL keeps its window (${ranges.join(" | ")})`);
    const warned = await page.locator("#sddCompareWarnings").innerText();
    check(/SPCX: listed only since 2026-06-12; earlier history under this symbol belongs to a different security and is not used\./.test(warned), "S3 the page says why the history is shorter");
    const chartFirst = await page.evaluate(() => {
      const chart = window.Chart.getChart("sddChartIndexed");
      const set = chart.data.datasets.find(d => d.label.startsWith("SPCX"));
      return chart.data.labels[set.data.findIndex(v => v !== null)];
    });
    check(chartFirst >= LISTED, `S3 chart: SPCX's first point is on or after the listing (${chartFirst})`);
    await page.click("#sddTab-export");
    const pricesCsv = fs.readFileSync(await download(page, "#sddExportPrices", "spcx-prices.csv"), "utf8");
    const spcxDays = pricesCsv.split(/\r?\n/).filter(l => /^\d{4}-\d{2}-\d{2},SPCX,/.test(l)).map(l => l.slice(0, 10));
    check(spcxDays.length > 50 && spcxDays.every(d => d >= LISTED), `S3 prices CSV: ${spcxDays.length} SPCX rows, first ${spcxDays[0]}`);
    const json = JSON.parse(fs.readFileSync(await download(page, "#sddExportJson", "spcx.json"), "utf8"));
    const series = json.comparison.series.find(s => s.ticker === "SPCX");
    check(series.observations.every(o => o[0] >= LISTED), "S3 JSON: no earlier SPCX price");
    check(json.comparison.warnings.some(w => /listed only since 2026-06-12/.test(w)), "S3 JSON: the reason is recorded");
    try {
      const out = execFileSync(process.env.PYTHON || "python3", ["-c",
        "import sys,openpyxl;wb=openpyxl.load_workbook(sys.argv[1]);raw=wb['Raw Data Ingestion'];days=[r[0].value for r in raw.iter_rows(min_row=2) if r[1].value=='SPCX'];print(len(days)>50, min(days)>=sys.argv[2])",
        await download(page, "#sddExportXlsx", "spcx.xlsx"), LISTED], { encoding: "utf8" }).trim();
      check(out === "True True", `S3 workbook: no earlier SPCX price (${out})`);
    } catch (error) { check(false, `S3 workbook validation: ${String(error.message).slice(0, 160)}`); }
    // Snapshot: chart and text.
    await page.click("#sddTab-snapshot");
    await page.fill("#sddSnapshotTicker", "SPCX");
    await page.click("#sddSnapshotRun");
    await page.waitForFunction(() => /SPCX loaded/.test(document.querySelector("#sddSnapshotStatus").textContent));
    const snapFirst = await page.evaluate(() => window.Chart.getChart("sddChartSnapshot").data.labels[0]);
    check(snapFirst >= LISTED, `S3 snapshot chart starts on or after the listing (${snapFirst})`);
    check(/listed only since 2026-06-12/.test(await page.locator("#sddSnapshotSource").innerText()), "S3 snapshot says why the history is shorter");
    check(net.errors.length === 0, `S3 no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
