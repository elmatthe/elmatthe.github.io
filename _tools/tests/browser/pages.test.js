// Browser test: the four project pages, their guides, /projects/ and the legacy redirects.
// Checks rendering at desktop and phone widths, JavaScript errors, local-nav anchors, ZIP
// links, and that the guides and non-app pages make no data requests on load.
"use strict";
const { SITE_URL, launch, watchNetwork, checker } = require("./harness");

const TOOLS = [
  { page: "/projects/monte-carlo-simulator/", guide: "/projects/monte-carlo-guide/", zip: "/projects/monte-carlo-retirement-simulator.zip" },
  { page: "/projects/cpi-webscraper/", guide: "/projects/cpi-downloader-user-guide/", zip: "/projects/cpi-web-scraper.zip" },
  { page: "/projects/portfolio-rebalancer/", guide: "/projects/portfolio-rebalancer-guide/", zip: "/projects/portfolio-rebalancer.zip" },
  { page: "/projects/stock-data-dashboard-tool/", guide: "/projects/stock-data-dashboard-guide/", zip: "/projects/stock-data-dashboard-tool.zip" },
];
const REDIRECTS = {
  "/projects/cpi-dashboard-automation/": "/projects/cpi-webscraper/",
  "/projects/CPI_Automation/": "/projects/cpi-downloader-user-guide/",
  "/projects/monte-carlo-retirement-simulator/": "/projects/monte-carlo-guide/",
  "/projects/portfolio-rebalancer-tool/": "/projects/portfolio-rebalancer-guide/",
  "/projects/Stock-Data-Dashboard-Tool/": "/projects/stock-data-dashboard-guide/",
};
// Every script, style and chart library is served by this site: no third-party host on load.
const ALLOWED_ON_LOAD = /^$/;
// The Rebalancer loads official exchange rates once on load (one keyless request).
const BOC_FX = /^https:\/\/www\.bankofcanada\.ca\/valet\/observations\/[A-Z,]+\/json\?recent=5$/;

(async () => {
  const { check, done } = checker();
  const browser = await launch();

  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
    for (const tool of TOOLS) {
      for (const url of [tool.page, tool.guide]) {
        const page = await context.newPage();
        const net = watchNetwork(page);
        const response = await page.goto(SITE_URL + url, { waitUntil: "networkidle" });
        const tag = `${url} @${width}px`;
        check(response && response.status() === 200, `${tag} loads`);
        const info = await page.evaluate(() => ({
          h1: document.querySelector(".pj-hero h1")?.textContent.trim() || "",
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navTargets: [...document.querySelectorAll(".pj-localnav a[href^='#']")].map(a => a.getAttribute("href")),
          missing: [...document.querySelectorAll(".pj-localnav a[href^='#']")].map(a => a.getAttribute("href")).filter(h => !document.getElementById(h.slice(1))),
          zipLinks: [...document.querySelectorAll("a[href$='.zip']")].map(a => a.getAttribute("href")),
          stale: /CPI Webscraper|TipRanks|Frankfurter|setup_and_run\./i.test(document.body.innerText),
          h1Count: document.querySelectorAll("h1").length,
        }));
        check(info.h1.length > 0 && info.h1Count === 1, `${tag} has one hero heading`);
        check(info.overflow <= 1, `${tag} no horizontal scroll (${info.overflow}px)`);
        if (width === 1280) {
          // Every page at the plan's widths; 1093/911 and 1024/853 are 1366 and 1280 px at 125%/150% browser zoom.
          const wide = [];
          for (const w of [360, 390, 768, 853, 911, 1093, 1366, 1440, 1920]) {
            await page.setViewportSize({ width: w, height: 900 });
            await page.waitForTimeout(60);
            const over = await page.evaluate(() => ({
              page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              small: [...document.querySelectorAll(".pj-body td, .pj-body .pj-tile strong")].filter(n => n.offsetParent && /\d/.test(n.textContent) && parseFloat(getComputedStyle(n).fontSize) < 13).length,
            }));
            if (over.page > 1 || over.small) wide.push(`${w}px: ${over.page}px overflow, ${over.small} values under 13px`);
          }
          await page.setViewportSize({ width, height: 900 });
          check(wide.length === 0, `${url} no horizontal scroll or tiny figures at 360–1920px and 125%/150% zoom${wide.length ? ": " + wide.join("; ") : ""}`);
        }
        check(info.navTargets.length > 2 && info.missing.length === 0, `${tag} local nav anchors resolve${info.missing.length ? " (missing " + info.missing.join(",") + ")" : ""}`);
        check(info.zipLinks.length > 0 && info.zipLinks.every(h => h === tool.zip), `${tag} links only to ${tool.zip}`);
        check(!info.stale, `${tag} has no stale names`);
        check(net.errors.length === 0, `${tag} no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
        const fxOnLoad = url === "/projects/portfolio-rebalancer/" ? net.external.filter(u => BOC_FX.test(u)) : [];
        const unexpected = net.external.filter(u => !ALLOWED_ON_LOAD.test(u) && !fxOnLoad.includes(u));
        check(unexpected.length === 0 && fxOnLoad.length <= 1, `${tag} no data requests on load${fxOnLoad.length ? " (one official FX request)" : ""}${unexpected.length ? ": " + unexpected.join(", ") : ""}`);
        await page.close();
      }
    }
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  for (const tool of TOOLS) {
    const response = await page.request.get(SITE_URL + tool.zip);
    const body = await response.body();
    check(response.status() === 200 && body.subarray(0, 2).toString() === "PK", `${tool.zip} is served as a ZIP (${body.length} bytes)`);
  }
  for (const [from, to] of Object.entries(REDIRECTS)) {
    await page.goto(SITE_URL + from);
    await page.waitForURL(u => u.pathname === to, { timeout: 10000 }).catch(() => {});
    check(new URL(page.url()).pathname === to, `${from} redirects to ${to}`);
  }
  await page.goto(`${SITE_URL}/projects/`, { waitUntil: "networkidle" });
  const entries = await page.locator(".project-list > li > a").allInnerTexts();
  check(["Monte Carlo Retirement Simulator", "CPI Web Scraper", "Portfolio Rebalancer", "Stock Comparison & Analytics Tool"].every(n => entries.includes(n)), `/projects/ lists the four tools (${entries.join(", ")})`);
  check(!/TipRanks|CPI Webscraper/.test(await page.locator(".project-list").innerText()), "/projects/ entries have no stale names");

  await browser.close();
  process.exit(done() ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
