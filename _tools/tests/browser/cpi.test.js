// Browser test: CPI Web Scraper web app. Statistics Canada and the data gateway are
// mocked (harness.js mockCpiSources); no real key, gateway or market data is used.
//
// Covers: initialization (no request on load, gateway-not-configured state),
// single month and date range inputs, invalid input, Canadian-only retrieval, FRED
// through a mocked gateway (key only in the POST body), partial and full FRED
// failure, Statistics Canada's 409 update window, cancel, the grouped twelve-month
// preview (tabs, keyboard, pagination, jump), the full nineteen-column CSV, a 1913-to-
// today range (DOM stays at twelve rows), console errors, and no horizontal scrolling.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { SITE_URL, CPI_KEY, CPI_GATEWAY, launch, mockCpiSources, watchNetwork, checker } = require("./harness");

const PAGE = `${SITE_URL}/projects/cpi-webscraper/`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-test-"));
const HEADERS = "Date,Headline CPI - Unadjusted CDN,Headline CPI - Seasonally Adjusted CDN,Core CPI - Unadjusted CDN,Core CPI - Seasonally Adjusted CDN,Alberta CPI - Unadjusted CDN,Headline CPI - Unadjusted US,Headline CPI - Seasonally Adjusted US,Core CPI - Unadjusted US,Core CPI - Seasonally Adjusted US,Unemployment Rate - Seasonally Adjusted US,Monthly Effective Fed Fund Rate US,Monthly Fed Fund Rate - EOP US,SP by month US,10yr vs 2yr US,10-Year Treasury Yield - Monthly Average US,2-Year Treasury Yield - Monthly Average US,PCE - Seasonally Adjusted US,Core PCE - Seasonally Adjusted US";
const WIDTHS = [320, 360, 390, 768, 853, 911, 1093, 1280, 1366, 1440, 1920];
const now = new Date();
const CURRENT = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const monthsFrom = (y, m) => (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m) + 1;

async function open(browser, mode = {}, { gateway = false, width = 1280 } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 900 } });
  const calls = await mockCpiSources(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(gateway ? `${PAGE}?gateway=${encodeURIComponent(CPI_GATEWAY)}` : PAGE, { waitUntil: "networkidle" });
  await page.waitForSelector('#cpi-app[data-ready="true"]');
  return { context, page, calls, net };
}
const idle = page => page.waitForFunction(() => document.querySelector("#cpi-app").getAttribute("aria-busy") === "false" && !/^Fetching/.test(document.querySelector("#cpiStatus").textContent), null, { timeout: 60000 });
async function range(page, y, m, y2, m2) {
  await page.check('input[name="cpiMode"][value="range"]');
  await page.fill("#cpiYear", String(y));
  await page.fill("#cpiMonth", String(m));
  await page.fill("#cpiYear2", String(y2));
  await page.fill("#cpiMonth2", String(m2));
}
async function fetchNow(page) { await page.click("#cpiFetch"); await idle(page); }
async function csvOf(page, name) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click("#cpiCsv")]);
  const target = path.join(OUT, name);
  await file.saveAs(target);
  return { text: fs.readFileSync(target, "utf8"), bytes: fs.readFileSync(target), suggested: file.suggestedFilename() };
}
const tableRows = page => page.$$eval("#cpiPanel tbody tr", rows => rows.map(r => [...r.children].map(c => c.textContent.trim())));
const headerTexts = page => page.$$eval("#cpiPanel thead th", ths => ths.map(t => t.querySelector(".sr-only")?.textContent || t.textContent.trim()));

(async () => {
  const { check, done } = checker();
  const browser = await launch();

  /* ---------- 1. initialization, inputs, invalid input ---------- */
  {
    const { context, page, calls, net } = await open(browser);
    check(calls.statcan.length === 0 && calls.gateway.length === 0 && calls.blocked.length === 0, "page load sends no data request");
    check(/Gateway not configured/.test(await page.locator("#cpiFredBadge").innerText()), "production build: the data gateway is not configured, and the page says so");
    check(await page.locator("#cpiKey").isDisabled(), "the FRED key field is disabled while no gateway is configured");
    check(/Canadian columns need no key/.test(await page.locator("#cpiStatus").innerText()), "status explains Canadian-only operation");
    check(await page.locator("#cpiYear2").isHidden() && await page.locator("#cpiMonth2").isHidden() && /^Year \(YYYY\)$/.test(await page.locator("#cpiYearL").innerText()), "single month: only Year and Month are shown");
    await page.check('input[name="cpiMode"][value="range"]');
    check(await page.locator("#cpiYear2").isVisible() && /^Start Year \(YYYY\)$/.test(await page.locator("#cpiYearL").innerText()) && await page.locator('label[for="cpiMonth2"]').innerText() === "End Month (1–12)", "date range: Start and End inputs with the desktop labels");
    check(await page.locator("#cpiCsv").isDisabled(), "no CSV before a fetch");
    for (const [y, m, y2, m2, why] of [["2024", "13", "2024", "12", /start month/], ["24", "1", "2024", "2", /start month/], ["2024", "5", "2024", "4", /End date must be after start date/], ["2024", "1", "2024", "", /end month/], ["1900", "1", "1910", "1", /ends before January 1913/], [String(now.getFullYear() + 1), "1", String(now.getFullYear() + 1), "2", /in the future/]]) {
      await range(page, y, m, y2, m2);
      await page.click("#cpiFetch");
      check(why.test(await page.locator("#cpiDateError").innerText()) && calls.statcan.length === 0, `invalid input refused before any request: ${y}-${m} to ${y2}-${m2}`);
    }
    check(await page.locator("#cpiYear").getAttribute("aria-invalid") === "true" || await page.locator("#cpiYear2").getAttribute("aria-invalid") === "true", "invalid fields are marked for assistive technology");
    check(net.errors.length === 0, `no console errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 2. Canadian-only retrieval, single month and range, CSV ---------- */
  {
    const { context, page, calls, net } = await open(browser);
    await page.fill("#cpiYear", "2024");
    await page.fill("#cpiMonth", "3");
    await page.locator("#cpiMonth").press("Enter");
    await idle(page);
    check(calls.statcan.length === 1 && /vectorIds=41690973,41690914,41691233,41690924,41692327&startRefPeriod=2024-03-01&endReferencePeriod=2024-03-01$/.test(calls.statcan[0]), `single month: one Statistics Canada request for one month (${calls.statcan[0]})`);
    check(calls.gateway.length === 0 && calls.blocked.length === 0, "no FRED or other request without a key and a gateway");
    check(/Fetched 1 month \(2024-03\): 5 of 18 series have data, Canadian-only dataset/.test(await page.locator("#cpiStatus").innerText()), "status: Canadian-only dataset");
    const rows1 = await tableRows(page);
    check(rows1.length === 1 && rows1[0][0] === "2024-03-01" && rows1[0].slice(1).every(v => /^\d+\.\d$/.test(v)), `single month: one row, five Canadian values (${rows1[0]})`);
    await range(page, 2023, 1, 2026, CURRENT.slice(5) === "01" ? 1 : 1);
    await range(page, 2023, 1, now.getFullYear(), now.getMonth() + 1);
    await fetchNow(page);
    const months = monthsFrom(2023, 1);
    check(new RegExp(`Fetched ${months} months`).test(await page.locator("#cpiStatus").innerText()), `range: ${months} months fetched`);
    check(/Canadian only/.test(await page.locator("#cpiTiles").innerText()) && /5 of 18/.test(await page.locator("#cpiTiles").innerText()), "tiles: Canadian only, 5 of 18 series");
    check(/FRED: not fetched\. This site has no data gateway configured yet/.test(await page.locator("#cpiSourceStatus").innerText()), "source status explains the blank US columns");
    check(/Canadian-only \/ partially populated/.test(await page.locator("#cpiQuality").innerText()), "the dataset is labelled Canadian-only / partially populated");
    await page.click("#cpiTab-us_inflation");
    const us = await tableRows(page);
    check(us.every(r => r.slice(1).every(v => v === "No gateway yet")), "US Inflation: every cell blank with its reason (no zeros)");
    const csv = await csvOf(page, "canadian.csv");
    const lines = csv.text.split("\r\n");
    check(lines[0] === HEADERS, "CSV: the nineteen exact A:S headers, in order");
    check(lines.length === months + 2 && lines.at(-1) === "", `CSV: every requested month (${lines.length - 2} rows), CRLF line endings`);
    check(lines.slice(1, -1).every(l => l.split(",").length === 19 && /^\d{4}-\d{2}-01,/.test(l)), "CSV: 19 cells per row, YYYY-MM-01 dates");
    check(lines.slice(1, -1).every(l => l.split(",").slice(6).every(v => v === "")), "CSV: US columns empty, never zero");
    check(csv.bytes[0] !== 0xef && /^CPI_Downloader_2023-01_to_\d{4}-\d{2}\.csv$/.test(csv.suggested), `CSV: UTF-8 without BOM, named by range (${csv.suggested})`);
    check(net.errors.length === 0, `no console errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 3. FRED through the gateway (mocked), pagination, groups, keyboard ---------- */
  {
    const { context, page, calls, net } = await open(browser, {}, { gateway: true });
    check(/Needs your FRED key/.test(await page.locator("#cpiFredBadge").innerText()) && await page.locator("#cpiKey").isEnabled(), "with a gateway: the key field is offered");
    await page.fill("#cpiKey", "NOT-A-KEY");
    await range(page, 2023, 1, now.getFullYear(), now.getMonth() + 1);
    await page.click("#cpiFetch");
    check(/not a FRED API key/.test(await page.locator("#cpiKeyError").innerText()) && calls.statcan.length + calls.gateway.length === 0, "a malformed key is refused before any request");
    await page.fill("#cpiKey", CPI_KEY);
    check(/Ready with your key/.test(await page.locator("#cpiFredBadge").innerText()), "a well-formed key: ready");
    await fetchNow(page);
    const obsCalls = calls.gateway.filter(c => c.path === "/v1/observations");
    check(obsCalls.length === 13, `one gateway request per series for a range under ten years (${obsCalls.length})`);
    check(obsCalls.every(c => c.body.api_key === CPI_KEY && !c.url.includes(CPI_KEY) && c.headers["content-type"] === "application/json"), "the key travels only in the JSON POST body, never in the URL");
    check(obsCalls.every(c => !c.headers.cookie), "no cookies are sent to the gateway");
    const status = await page.locator("#cpiStatus").innerText();
    check(/18 of 18 series have data, complete dataset/.test(status), `all eighteen series with a key (${status})`);
    const months = monthsFrom(2023, 1);
    const pages = Math.ceil(months / 12);
    check(new RegExp(`Page 1 of ${pages} · `).test(await page.locator("#cpiPageText").innerText()), `pagination: page 1 of ${pages}`);
    let rows = await tableRows(page);
    check(rows.length === 12 && rows.at(-1)[0] === `${CURRENT}-01`, "page 1 shows the most recent twelve months, in date order");
    check(await page.locator("#cpiPrev").isDisabled() && await page.locator("#cpiNext").isEnabled(), "Previous is disabled on page 1");
    for (let p = 2; p <= pages; p += 1) await page.click("#cpiNext");
    rows = await tableRows(page);
    check(rows.length === months - 12 * (pages - 1) && rows[0][0] === "2023-01-01" && await page.locator("#cpiNext").isDisabled(), `the last page holds the oldest ${rows.length} months`);
    await page.fill("#cpiJumpTo", "2024-06");
    await page.locator("#cpiJumpTo").press("Enter");
    check((await tableRows(page)).some(r => r[0] === "2024-06-01"), "Go to month jumps to the page with that month");
    await page.click("#cpiTab-canada");
    check((await headerTexts(page)).length === 6, "Canada: Date + five columns");
    await page.focus("#cpiTab-canada");
    await page.keyboard.press("ArrowRight");
    check(await page.locator("#cpiTab-us_inflation").getAttribute("aria-selected") === "true" && await page.evaluate(() => document.activeElement.id) === "cpiTab-us_inflation", "ArrowRight moves to US Inflation and focuses it");
    check(JSON.stringify((await headerTexts(page)).slice(1).map(h => h.split(",")[0])) === JSON.stringify(["Headline CPI - Unadjusted US", "Headline CPI - Seasonally Adjusted US", "Core CPI - Unadjusted US", "Core CPI - Seasonally Adjusted US", "PCE - Seasonally Adjusted US", "Core PCE - Seasonally Adjusted US"]), "US Inflation: the six series, with full headers for screen readers");
    await page.keyboard.press("End");
    check(await page.locator("#cpiTab-other").getAttribute("aria-selected") === "true", "End selects the last group (Other)");
    check(JSON.stringify((await headerTexts(page)).slice(1).map(h => h.split(",")[0])) === JSON.stringify(["Unemployment Rate - Seasonally Adjusted US", "SP by month US"]), "Other: unemployment and the S&P 500");
    await page.keyboard.press("ArrowLeft");
    check(await page.locator("#cpiTab-rates").getAttribute("aria-selected") === "true" && (await headerTexts(page)).length === 6, "ArrowLeft selects Rates (five series)");
    // The current month: end-of-month columns blank with their reason.
    await page.click("#cpiPrev").catch(() => {});
    while (await page.locator("#cpiPrev").isEnabled()) await page.click("#cpiPrev");
    rows = await tableRows(page);
    const last = rows.at(-1);
    check(last[0] === `${CURRENT}-01` && last[2] === "Month not over" && last[3] === "Month not over", `current month: Fed funds EOP and 10y-2y blank as "Month not over" (${last.slice(1).join(" | ")})`);
    const align = await page.$eval("#cpiPanel tbody td", td => getComputedStyle(td).textAlign);
    check(align === "right", "numbers are right-aligned");
    const csv = await csvOf(page, "complete.csv");
    const lines = csv.text.split("\r\n").slice(1, -1);
    check(lines.length === months && lines.some(l => l.split(",").slice(6).filter(Boolean).length >= 12), "CSV: all months, US columns filled");
    check(!csv.text.includes(CPI_KEY), "CSV contains no key");
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    check(!storage.includes(CPI_KEY), "the key is not stored unless the visitor asks");
    await page.check("#cpiKeepKey");
    check(await page.evaluate(() => sessionStorage.getItem("cpi.fredKey.v1")) === CPI_KEY && await page.evaluate(() => Object.keys(localStorage).length) === 0, "Keep for this tab: sessionStorage only, never localStorage");
    await page.click("#cpiForgetKey");
    check(await page.evaluate(() => sessionStorage.getItem("cpi.fredKey.v1")) === null && await page.inputValue("#cpiKey") === "", "Remove key clears it");
    check(net.errors.length === 0, `no console errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 4. partial FRED failure, full failure, rejected key ---------- */
  {
    const { context, page, net } = await open(browser, { fredFail: ["GS10"], fredDisabled: ["SP500"] }, { gateway: true });
    await page.fill("#cpiKey", CPI_KEY);
    await range(page, 2024, 1, 2024, 6);
    await fetchNow(page);
    check(/16 of 18 series have data/.test(await page.locator("#cpiStatus").innerText()), "partial failure: the other series are kept");
    await page.click("#cpiTab-rates");
    let rows = await tableRows(page);
    check(rows.every(r => r[4] === "Unavailable"), "GS10 (10-year avg): every cell 'Unavailable' after three attempts");
    await page.click("#cpiTab-other");
    rows = await tableRows(page);
    check(rows.every(r => r[2] === "Restricted") && rows.every(r => /^\d/.test(r[1])), "SP500 switched off by the operator: 'Restricted'; unemployment kept");
    check(/GS10[\s\S]*temporarily unavailable/.test(await page.locator("#cpiSourceStatus").innerText()), "source status names the failed series");
    check(net.errors.length === 0, `no console errors (${net.errors.join("; ")})`);
    await context.close();
  }
  {
    const { context, page, calls } = await open(browser, { gatewayDown: true }, { gateway: true });
    await page.fill("#cpiKey", CPI_KEY);
    await range(page, 2024, 1, 2024, 6);
    await fetchNow(page);
    check(/5 of 18 series have data/.test(await page.locator("#cpiStatus").innerText()) && calls.statcan.length === 1, "gateway down: the Canadian data is kept");
    await page.click("#cpiTab-us_inflation");
    check((await tableRows(page)).every(r => r.slice(1).every(v => v === "Gateway unavailable")), "gateway down: US cells say 'Gateway unavailable'");
    check(/Gateway unavailable/.test(await page.locator("#cpiFredBadge").innerText()), "the FRED badge reports the unreachable gateway");
    await context.close();
  }
  {
    const { context, page, calls } = await open(browser, { keyRejected: true }, { gateway: true });
    await page.fill("#cpiKey", CPI_KEY);
    await range(page, 2024, 1, 2024, 6);
    await fetchNow(page);
    check(calls.gateway.length <= 2, `a rejected key stops the remaining FRED requests (${calls.gateway.length} sent)`);
    await page.click("#cpiTab-rates");
    check((await tableRows(page)).every(r => r.slice(1).every(v => v === "Key rejected")) && /Key rejected/.test(await page.locator("#cpiFredBadge").innerText()), "rejected key: 'Key rejected', with advice");
    await context.close();
  }

  /* ---------- 5. Statistics Canada update window (HTTP 409), cancel ---------- */
  {
    const { context, page, calls } = await open(browser, { statcan409: true });
    await range(page, 2024, 1, 2024, 6);
    await fetchNow(page);
    check(calls.statcan.length === 3, `HTTP 409: three attempts (${calls.statcan.length})`);
    check(/updating its tables \(HTTP 409/.test(await page.locator("#cpiSourceStatus").innerText()), "the update window is explained");
    check((await tableRows(page)).every(r => r.slice(1).every(v => v === "Unavailable")), "Canadian cells 'Unavailable', not zero");
    await context.close();
  }
  {
    let release;
    const { context, page } = await open(browser, { statcanHold: new Promise(r => { release = r; }) });
    await range(page, 2024, 1, 2024, 6);
    await page.click("#cpiFetch");
    await page.waitForFunction(() => document.querySelector("#cpi-app").getAttribute("aria-busy") === "true");
    check(await page.locator("#cpiCancel").isEnabled() && await page.locator("#cpiFetch").isDisabled() && await page.locator("#cpiProgress").isVisible(), "while fetching: progress, Cancel enabled, Fetch disabled");
    await page.click("#cpiCancel");
    release();
    await page.waitForTimeout(300);
    check(/Cancelled/.test(await page.locator("#cpiStatus").innerText()) && await page.locator("#cpiResults").isHidden(), "Cancel stops the fetch and keeps nothing");
    await page.click("#cpiClear");
    check(/Cleared/.test(await page.locator("#cpiStatus").innerText()) && await page.locator("#cpiYear2").isHidden(), "Clear resets to a single month");
    await context.close();
  }

  /* ---------- 6. 1913 to today: responsive, twelve rows in the DOM ---------- */
  {
    const { context, page, calls, net } = await open(browser, {}, { gateway: true });
    await page.fill("#cpiKey", CPI_KEY);
    await range(page, 1913, 1, now.getFullYear(), now.getMonth() + 1);
    const t0 = Date.now();
    await fetchNow(page);
    const seconds = (Date.now() - t0) / 1000;
    const months = monthsFrom(1913, 1);
    check(new RegExp(`Fetched ${months.toLocaleString("en-CA")} months`).test(await page.locator("#cpiStatus").innerText()), `full history: ${months} months`);
    check(calls.statcan.length === 12, `Statistics Canada: 12 chunked requests (${calls.statcan.length})`);
    check(calls.gateway.length === 26, `gateway: 26 requests (${calls.gateway.length})`);
    check(seconds < 30, `fetched and rendered in ${seconds.toFixed(1)} s with mocked sources`);
    check(await page.locator("#cpiPanel tbody tr").count() === 12 && await page.locator("#cpi-app tr").count() <= 14, "only the visible twelve months are in the DOM");
    const t1 = Date.now();
    for (let i = 0; i < 20; i += 1) await page.click("#cpiNext");
    check(Date.now() - t1 < 5000, `20 page turns in ${Date.now() - t1} ms`);
    await page.fill("#cpiJumpTo", "1913-01");
    await page.locator("#cpiJumpTo").press("Enter");
    const oldest = await tableRows(page);
    check(oldest[0][0] === "1913-01-01" && oldest.length === (months % 12 || 12), `the last page starts at 1913-01 and holds the remaining ${months % 12 || 12} months (${oldest[0][0]}, ${oldest.length} rows)`);
    check(oldest[0].slice(1).every(v => v === "Before series"), "1913-01, Canada: 'Before series' (Statistics Canada starts in 1914)");
    const csv = await csvOf(page, "full.csv");
    check(csv.text.split("\r\n").length === months + 2, "the CSV holds the full history, not just the visible page");
    // Layout at every width: no page-wide horizontal scrolling, readable values, stacked cards on phones.
    await page.click("#cpiTab-us_inflation");
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const app = document.querySelector("#cpi-app");
        const offenders = [...app.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > doc.clientWidth + 1).map(n => n.id || n.className || n.tagName).slice(0, 4);
        const values = [...document.querySelectorAll("#cpiPanel td, #cpiPanel tbody th, #cpiTiles strong")].filter(n => n.offsetParent && /\d/.test(n.textContent)).map(n => parseFloat(getComputedStyle(n).fontSize));
        const stacked = getComputedStyle(document.querySelector("#cpiPanel thead")).position === "absolute";
        return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders, minFont: Math.min(...values), stacked };
      });
      check(m.scroll <= m.client && !m.offenders.length, `${width}px: no horizontal scroll (${m.scroll}/${m.client}${m.offenders.length ? `; ${m.offenders.join(", ")}` : ""})`);
      check(m.minFont >= 14, `${width}px: values at least 14px (min ${m.minFont}px)`);
      if (width <= 390) check(m.stacked, `${width}px: months shown as stacked cards`);
      if (width >= 1093) check(!m.stacked, `${width}px: table layout`);
    }
    check(net.errors.length === 0, `no console errors (${net.errors.join("; ")})`);
    await context.close();
  }

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
