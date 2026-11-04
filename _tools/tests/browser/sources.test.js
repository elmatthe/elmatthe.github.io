// Browser test: the ordered market-data source list in the Portfolio Rebalancer and the
// Stock Comparison web apps, end to end in Chromium.
//
// Pages are opened with ?mdgateway=https://md.gateway.test: harness.js answers it with
// the REAL gateway Worker code whose upstream is the synthetic Yahoo fixtures; Alpha
// Vantage, Marketstack and Finnhub are mocked. Nothing real is contacted.
//
// Covers: drag-and-drop, Move up/down and keyboard reordering (Home/End, focus kept);
// the order persisting across reloads and shared by both tools; keys added (switched on
// below Yahoo Finance) and removed (switched off, position kept, Yahoo Finance back on);
// first-source success without calling later sources; one failure then success; two
// consecutive failures then the third source; complete failure with every reason and no
// fabricated price; a rejected key and an exhausted quota shown, not hidden, and not
// retried; a wrong currency refused and the next source used; stale prices withheld
// until accepted; no key, share count or target sent to the gateway; latest-price-only
// sources never asked for history; one comparison never mixing daily and weekly prices,
// and a mixed-source comparison said plainly with per-series provenance in exports;
// phone-width layout and touch-size controls.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { SITE_URL, MD_GATEWAY, TEST_KEY, FH_KEY, MS_KEY, launch, mockMarketData, watchNetwork, checker } = require("./harness");

const Q = `?mdgateway=${encodeURIComponent(MD_GATEWAY)}`;
const RB = `${SITE_URL}/projects/portfolio-rebalancer/${Q}`;
const SD = `${SITE_URL}/projects/stock-data-dashboard-tool/${Q}`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "sources-test-"));

async function openRb(browser, mode, { context = null, calls = null, viewport = { width: 1280, height: 900 } } = {}) {
  context ||= await browser.newContext({ acceptDownloads: true, viewport });
  calls ||= await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(RB, { waitUntil: "networkidle" });
  await page.waitForSelector('#rb-app[data-ready="true"][data-fx-ready="true"]');
  await page.waitForFunction(() => document.querySelector("#rb-app").dataset.freeSource !== "checking");
  return { context, calls, page, net };
}
async function openSd(browser, mode, { context = null, calls = null } = {}) {
  context ||= await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  calls ||= await mockMarketData(context, mode);
  const page = await context.newPage();
  const net = watchNetwork(page);
  await page.goto(SD, { waitUntil: "networkidle" });
  await page.waitForSelector('#sdd-app[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector("#sdd-app").dataset.freeSource !== "checking");
  return { context, calls, page, net };
}
const order = (page, list = "#rbSources") => page.$$eval(`${list} .ms-item`, n => n.map(i => i.dataset.source).join(","));
const item = (page, id, list = "#rbSources") => page.locator(`${list} .ms-item[data-source="${id}"]`);
async function saveKey(page, provider, key) {
  if ((await page.locator("#rbKeysPanel").getAttribute("open")) === null) await page.click("#rbKeysPanel > summary");
  const card = page.locator(`#rbProviders section[aria-label="${provider}"]`);
  await card.locator('input[type="password"]').fill(key);
  await card.locator('input[type="checkbox"]').check(); // remembered: tests open new tabs
  await card.locator('button[type="submit"]').click();
}
async function removeKey(page, provider) {
  if ((await page.locator("#rbKeysPanel").getAttribute("open")) === null) await page.click("#rbKeysPanel > summary");
  await page.locator(`#rbProviders section[aria-label="${provider}"]`).getByRole("button", { name: "Remove key" }).click();
}
async function holdings(page, lines) {
  const file = path.join(OUT, `h${Date.now()}${Math.random().toString(36).slice(2, 6)}.csv`);
  fs.writeFileSync(file, `ticker,shares,target_pct,account\r\n${lines.join("\r\n")}\r\n`);
  if ((await page.locator(".rb-csv").getAttribute("open")) === null) await page.locator(".rb-csv > summary").click();
  await page.setInputFiles("#rbImportHoldings", file);
  await page.waitForFunction(n => document.querySelectorAll("#rbRows .rb-row").length === n, lines.length);
}
const idle = async page => {
  await page.waitForTimeout(50);
  await page.waitForFunction(() => document.querySelector("#rb-app").getAttribute("aria-busy") === "false" && !document.querySelector('.rb-row[aria-busy="true"]') && !/fetching|getting prices/i.test(document.querySelector("#rbStatus").textContent), null, { timeout: 120000 });
};
const line = (page, i) => page.locator("#rbRows .rb-row").nth(i).locator(".rb-line").innerText();
const quotes = calls => calls.gateway.filter(c => /\/v1\/quote\?/.test(c.url));

(async () => {
  const { check, done } = checker();
  const browser = await launch();

  /* ---------- 1. reordering: drag, Move buttons, keyboard; persistence; shared by both tools ---------- */
  {
    const { context, calls, page, net } = await openRb(browser, {});
    check(await order(page) === "yahoo,alphavantage,marketstack,finnhub", "fresh browser: Yahoo Finance first");
    // Both entries on screen (a drag that scrolls the page mid-way lands elsewhere).
    await page.locator("#rbSourcesH").evaluate(n => n.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.waitForTimeout(100);
    await item(page, "finnhub").dragTo(item(page, "yahoo"), { targetPosition: { x: 20, y: 4 } });
    check(await order(page) === "finnhub,yahoo,alphavantage,marketstack", `drag and drop moves Finnhub above Yahoo Finance (${await order(page)})`);
    check(/Finnhub moved to position 1 of 4/.test(await page.locator("#rbSrcLive").innerText()), "the drop is announced");
    await item(page, "finnhub").locator('[data-dir="down"]').click();
    check(await order(page) === "yahoo,finnhub,alphavantage,marketstack", "Move down");
    check(await page.evaluate(() => document.activeElement?.closest(".ms-item")?.dataset.source === "finnhub" && document.activeElement.dataset.dir === "down"), "focus stays on the moved entry's button");
    await item(page, "marketstack").locator(".ms-handle").focus();
    await page.keyboard.press("Home");
    check(await order(page) === "marketstack,yahoo,finnhub,alphavantage", "Home moves an entry to the top");
    await page.keyboard.press("End");
    check(await order(page) === "yahoo,finnhub,alphavantage,marketstack", "End moves it to the bottom");
    await page.keyboard.press("ArrowDown");
    check(/already at position 4 of 4/.test(await page.locator("#rbSrcLive").innerText()), "moving past the end is announced, nothing changes");
    check(await item(page, "yahoo").locator('[data-dir="up"]').isDisabled() && await item(page, "marketstack").locator('[data-dir="down"]').isDisabled(), "the first entry cannot move up, the last cannot move down");
    // Persistence across a reload, and the Stock page shows the same list.
    const again = await openRb(browser, {}, { context, calls });
    check(await order(again.page) === "yahoo,finnhub,alphavantage,marketstack", "the order survives a reload");
    const sd = await openSd(browser, {}, { context, calls });
    check(await order(sd.page, "#sddSources") === "yahoo,finnhub,alphavantage,marketstack", "the Stock page uses the same list");
    check(/1\. Yahoo Finance · 2\. Finnhub \(off\)/.test(await sd.page.locator("#sddSourceOrder").innerText()), "the Stock compare form shows that order");
    check(net.errors.length === 0, `no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 2. keys added and removed ---------- */
  {
    const { context, page } = await openRb(browser, {});
    await saveKey(page, "Marketstack", MS_KEY);
    check(await order(page) === "yahoo,alphavantage,marketstack,finnhub" && await item(page, "marketstack").getAttribute("data-status") === "on", "a new key switches its provider on in place, below Yahoo Finance");
    check(/Marketstack is switched on at position 3 of 4, after Yahoo Finance/.test(await page.locator("#rbStatus").innerText()), "the change is explained");
    await item(page, "yahoo").locator("input[role='switch']").uncheck();
    check(await item(page, "yahoo").getAttribute("data-status") === "off", "Yahoo Finance can be switched off while another source is on");
    await removeKey(page, "Marketstack");
    const status = await page.locator("#rbStatus").innerText();
    check(/Marketstack is switched off because its key was removed; it keeps position 3/.test(status) && /Yahoo Finance was switched back on because no other source in your list can be used/.test(status), `removing the last key keeps the order and switches Yahoo Finance back on (${status.slice(0, 220)})`);
    check(await order(page) === "yahoo,alphavantage,marketstack,finnhub" && await item(page, "yahoo").getAttribute("data-status") === "on", "deterministic order after the removal");
    await item(page, "yahoo").locator("input[role='switch']").click(); // refused: uncheck() would insist
    check(await item(page, "yahoo").locator("input[role='switch']").isChecked() && /Yahoo Finance stays on: it is the only source in your list that can be used/.test(await page.locator("#rbSrcLive").innerText()), "the last usable source cannot be switched off");
    await context.close();
  }

  /* ---------- 3. fallback: first success, one failure, two failures, complete failure ---------- */
  {
    const mode = { yahoo: { downFor: ["AAPL"] }, avLimit: 0 };
    const { context, calls, page, net } = await openRb(browser, mode);
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await saveKey(page, "Finnhub", FH_KEY);
    await holdings(page, ["MSFT,1,40,", "AAPL,1,30,", "VEQT.TO,1,30,"]);
    await page.click("#rbPriceAll");
    await idle(page);
    check(/Verified[\s\S]*Yahoo Finance · [\s\S]*/.test(await line(page, 0)) && !/used because/.test(await line(page, 0)), "MSFT: the first source succeeds");
    const aapl = await line(page, 1);
    check(/Verified[\s\S]*Finnhub · last price[\s\S]*used because Yahoo Finance: unavailable; Alpha Vantage: daily limit reached/.test(aapl), `AAPL: two consecutive failures, the third source answers, both reasons shown (${aapl})`);
    check(await page.locator("#rbRows .rb-row").nth(1).getAttribute("data-tone") === "warn", "a quota failure keeps the holding flagged");
    const veqt = await line(page, 2);
    check(/Verified[\s\S]*Yahoo Finance · /.test(veqt), `VEQT.TO priced by Yahoo Finance (${veqt})`);
    check(calls.av.length === 1, `Alpha Vantage was asked once; its daily limit then skips it (${calls.av.length})`);
    check(JSON.stringify(calls.fh) === JSON.stringify(["AAPL"]), `Finnhub was asked only for the holding the first two could not price (${calls.fh.join(",")})`);
    check(/1 priced by another source after the first one failed: AAPL \(Yahoo Finance: unavailable; Alpha Vantage: daily limit reached\)/.test(await page.locator("#rbStatus").innerText()), "the batch status names the fallback");
    // No key, holding or target was sent to the gateway.
    check(!calls.gateway.some(c => [TEST_KEY, FH_KEY].some(k => c.url.includes(k) || JSON.stringify(c.headers).includes(k))), "no personal key reaches the gateway");
    check(quotes(calls).every(c => [...new URL(c.url).searchParams.keys()].join() === "symbol") && !calls.gateway.some(c => /shares|target|account|TFSA/i.test(c.url)), "the gateway receives only symbols");
    // Complete failure: Finnhub's key is rejected too. Nothing is invented.
    await saveKey(page, "Finnhub", "WRONGFHKEY1234567890X");
    await page.locator("#rbRows .rb-row").nth(1).getByRole("button", { name: /Get price|Retry|Refresh price/ }).click();
    await idle(page);
    const failed = await line(page, 1);
    check(/No source in your list could give a usable price \(Yahoo Finance: unavailable; Finnhub: rejected the key; Alpha Vantage: daily limit reached\)|No source in your list could give a usable price \(Yahoo Finance: unavailable; Finnhub: rejected the key\)/.test(failed) && !/US\$\d/.test(failed), `complete failure: every reason, no price (${failed})`);
    check(await page.locator("#rbRows .rb-row").nth(1).getAttribute("data-tone") === "error", "the holding is marked as failed");
    await page.click("#rbRun");
    check(/Plan withheld[\s\S]*AAPL/.test(await page.locator("#rbResults").innerText()), "no plan with an unpriced holding");
    await page.locator("#rbRows .rb-row").nth(1).locator("details summary").click();
    const details = await page.locator("#rbRows .rb-row").nth(1).locator("details dl").innerText();
    check(/Sources tried[\s\S]*Yahoo Finance: Yahoo Finance is unavailable right now[\s\S]*Finnhub: [^\n]*(rejected|Invalid)/i.test(details), `the details keep each source's own answer (${details.replace(/\s+/g, " ").slice(0, 220)})`);
    const fhBefore = calls.fh.length;
    await page.locator("#rbRows .rb-row").nth(1).getByRole("button", { name: /Retry|Get price/ }).click();
    await idle(page);
    check(calls.fh.length === fhBefore, "a rejected key is not retried in a loop");
    check(net.errors.length === 0, `no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  /* ---------- 4. a wrong currency is refused and the next source is used ---------- */
  {
    const { context, page } = await openRb(browser, {});
    await saveKey(page, "Alpha Vantage", TEST_KEY);
    await holdings(page, ["BADCUR.DE,1,100,"]);
    await page.click("#rbPriceAll");
    await idle(page);
    const text = await line(page, 0);
    check(/Alpha Vantage[\s\S]*used because Yahoo Finance: could not confirm the currency/.test(text) && !/Yahoo Finance · /.test(text), `Yahoo Finance's wrong-currency answer is not used; Alpha Vantage prices it (${text})`);
    await context.close();
  }

  /* ---------- 5. stale data is never presented as current ---------- */
  {
    const { context, page } = await openRb(browser, { yahoo: { staleDays: 2 } });
    await holdings(page, ["AAPL,1,50,", "VEQT.TO,1,50,"]);
    await page.click("#rbPriceAll");
    await idle(page);
    check(/Check date|older than the latest session/.test(await line(page, 0)), `a two-day-old price is flagged (${await line(page, 0)})`);
    await page.click("#rbRun");
    check(/Plan withheld/.test(await page.locator("#rbResults").innerText()) && await page.locator("#rbAcceptStale").count() === 1, "the plan waits until older prices are accepted");
    await page.click("#rbAcceptStale"); // the banner is rebuilt with the plan, so check() could not confirm it
    check(/Plan uses older prices you accepted/.test(await page.locator("#rbResults").innerText()), "accepted older prices are labelled in the plan");
    await context.close();
  }

  /* ---------- 6. phone width: the list fits, controls are touch-sized ---------- */
  {
    const { context, page } = await openRb(browser, {}, { viewport: { width: 360, height: 800 } });
    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const list = document.querySelector("#rbSources");
      const over = [...list.querySelectorAll("*")].filter(n => n.getBoundingClientRect().right > doc.clientWidth + 1).length;
      const sizes = [...list.querySelectorAll(".ms-move, .ms-handle")].map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height));
      return { scroll: doc.scrollWidth, client: doc.clientWidth, over, minTouch: Math.min(...sizes) };
    });
    check(m.scroll <= m.client && m.over === 0, `360 px: no horizontal scroll in the source list (${m.scroll}/${m.client}, ${m.over} overflowing)`);
    check(m.minTouch >= 44, `touch targets at least 44 px (${m.minTouch})`);
    await context.close();
  }

  /* ---------- 7. Stock: history only from history sources; no silent mixing of frequencies ---------- */
  {
    const mode = {};
    const rb = await openRb(browser, mode);
    await saveKey(rb.page, "Alpha Vantage", TEST_KEY);
    await saveKey(rb.page, "Finnhub", FH_KEY);
    await item(rb.page, "alphavantage").locator(".ms-handle").focus();
    await rb.page.keyboard.press("Home"); // Alpha Vantage first
    const { context, calls, page, net } = await openSd(browser, mode, { context: rb.context, calls: rb.calls });
    check(/Alpha Vantage/.test(await page.locator("#sddPipelineState").innerText()), "the Stock page follows the shared order");
    check(/Not used on this page: Finnhub provides latest prices only, not price history/.test(await item(page, "finnhub", "#sddSources").innerText()), "Finnhub is shown as latest prices only");
    const set = async list => {
      while ((await page.locator("#sddTickerList .sdd-ticker-row").count()) < list.length) await page.click("#sddAddTicker");
      while ((await page.locator("#sddTickerList .sdd-ticker-row").count()) > list.length) await page.locator('#sddTickerList [data-action="remove"]').last().click();
      for (const [i, t] of list.entries()) await page.locator("#sddTickerList input").nth(i).fill(t);
    };
    const run = async () => {
      await page.click("#sddRunCompare");
      await page.waitForFunction(() => /Comparison complete|could not|failed|not available/i.test(document.querySelector("#sddCompareStatus").textContent) && !document.querySelector("#sddRunCompare").disabled, null, { timeout: 120000 });
      return page.locator("#sddCompareStatus").innerText();
    };
    // 1Y: Alpha Vantage gives weekly prices; Tokyo (not covered by it) is NOT filled in with Yahoo Finance's daily series.
    await set(["AAPL", "MSFT", "7203.T"]);
    await page.selectOption("#sddHorizon", "1Y");
    const weekly = await run();
    const notice = await page.locator("#sddCompareNotice").innerText();
    check(/Comparison complete: 2 securities, 1Y, weekly prices/.test(weekly) && /7203\.T: [\s\S]*Yahoo Finance: would give daily prices for this period, and this comparison uses weekly prices/.test(notice), `1Y with Alpha Vantage first: weekly only; Yahoo Finance's daily series is not mixed in (${notice.replace(/\s+/g, " ").slice(0, 200)})`);
    check(calls.fh.length === 0, "Finnhub is never asked for history");
    // 3M: both sources give daily prices; the mixed-source comparison is said plainly and recorded per series.
    await page.selectOption("#sddHorizon", "3M");
    const daily = await run();
    const warnings = await page.locator("#sddCompareWarnings").innerText();
    check(/Comparison complete: 3 securities, 3M, daily prices/.test(daily) && /This comparison combines sources: Alpha Vantage \(your key\) for AAPL, MSFT; Yahoo Finance \(no key\) for 7203\.T/.test(warnings), `3M: daily from both, mixing stated (${warnings.slice(0, 200)})`);
    check(/7203\.T: Yahoo Finance \(no key\) was used because|7203\.T · Yahoo Finance/.test(warnings + await page.locator("#sddCompareSources").innerText()), "the per-series source is shown");
    await page.click("#sddTab-export");
    const [file] = await Promise.all([page.waitForEvent("download"), page.click("#sddExportJson")]);
    const json = JSON.parse(fs.readFileSync(await file.path(), "utf8"));
    const prov = Object.fromEntries(json.comparison.provenance.map(p => [p.ticker, p]));
    check(prov.AAPL.sourceId === "alphavantage" && prov["7203.T"].sourceId === "yahoo" && prov["7203.T"].skipped.some(s => /Alpha Vantage: does not cover Tokyo/.test(s)), "JSON export: source and skipped sources per series");
    check(/^1\. Alpha Vantage; 2\. Yahoo Finance/.test(json.comparison.sourceOrder), "JSON export: the source order");
    check(/Several sources \(Alpha Vantage \(your key\), Yahoo Finance \(no key\)\)/.test(json.comparison.source), "the comparison's source says several sources");
    check(!JSON.stringify(json).includes(TEST_KEY) && !JSON.stringify(json).includes(FH_KEY), "no key in the export");
    check(net.errors.length === 0, `no page errors (${net.errors.join("; ")})`);
    await context.close();
  }

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
