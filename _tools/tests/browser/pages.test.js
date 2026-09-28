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
const ALLOWED_ON_LOAD = /^https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@/;

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
        check(info.navTargets.length > 2 && info.missing.length === 0, `${tag} local nav anchors resolve${info.missing.length ? " (missing " + info.missing.join(",") + ")" : ""}`);
        check(info.zipLinks.length > 0 && info.zipLinks.every(h => h === tool.zip), `${tag} links only to ${tool.zip}`);
        check(!info.stale, `${tag} has no stale names`);
        check(net.errors.length === 0, `${tag} no JavaScript errors${net.errors.length ? ": " + net.errors.join(" | ") : ""}`);
        const unexpected = net.external.filter(u => !ALLOWED_ON_LOAD.test(u));
        check(unexpected.length === 0, `${tag} no data requests on load${unexpected.length ? ": " + unexpected.join(", ") : ""}`);
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
