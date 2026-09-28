// Shared Playwright harness for the tool-page browser tests.
//
// Yahoo Finance and the public CORS proxies are replaced by deterministic mocks:
// every proxied request is decoded, checked to target finance.yahoo.com, and
// answered with a synthetic Yahoo-shaped chart payload. No real market data is
// stored in the repository.
//
// Environment:
//   SITE_URL       base URL of a served `jekyll build` output (default http://127.0.0.1:4000)
//   HTTPS_PROXY    optional upstream proxy for real CDN requests (Chart.js)
//   CHROMIUM_ARGS  optional extra Chromium flags (whitespace separated)
"use strict";
const { chromium } = require("playwright");

const SITE_URL = (process.env.SITE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const ACAO = { "access-control-allow-origin": "*", "content-type": "application/json" };
const DAY = 86400;

function hash(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function currencyFor(symbol) {
  if (symbol.endsWith("=X")) return symbol.slice(3, 6);
  if (/\.(TO|V)$/.test(symbol)) return "CAD";
  if (symbol.endsWith(".L")) return "GBp";
  if (symbol.endsWith(".T")) return "JPY";
  if (/\.(DE|AS|PA|MI|BR)$/.test(symbol)) return "EUR";
  if (/\.(SS|SZ|HK)$/.test(symbol)) return "CNY";
  return "USD";
}

const FX_LEVEL = { CADUSD: 0.73, USDCAD: 1.37, GBPUSD: 1.28, USDGBP: 0.78, EURUSD: 1.09, USDEUR: 0.92, JPYUSD: 0.0068, CNYUSD: 0.14, GBPCAD: 1.75, CADGBP: 0.57, EURCAD: 1.49, CADEUR: 0.67 };

// Synthetic Yahoo v8 chart payload. Unknown symbols (starting ZZZ) return Yahoo's 404 body.
function chartPayload(symbol, targetUrl, now = Date.now()) {
  if (/^ZZZ/.test(symbol)) {
    return { status: 404, body: { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } } };
  }
  const url = new URL(targetUrl);
  const end = Number(url.searchParams.get("period2")) || Math.floor(now / 1000);
  const range = url.searchParams.get("range");
  const start = Number(url.searchParams.get("period1")) || (end - (range === "5d" ? 8 : 370) * DAY);
  const seed = hash(symbol);
  const isFx = symbol.endsWith("=X");
  let price = isFx ? (FX_LEVEL[symbol.slice(0, 6)] || 1) : 20 + (seed % 400);
  const timestamps = [];
  const closes = [];
  let state = seed || 1;
  for (let t = Math.floor(start / DAY) * DAY; t < end; t += DAY) {
    const weekday = new Date(t * 1000).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const shock = ((state / 4294967296) - 0.5) * (isFx ? 0.01 : 0.03);
    price *= Math.exp(shock + (isFx ? 0 : 0.0003));
    timestamps.push(t + 14 * 3600 + 1800);
    closes.push(Number(price.toFixed(isFx ? 5 : 2)));
  }
  const currency = currencyFor(symbol);
  return {
    status: 200,
    body: {
      chart: {
        result: [{
          meta: {
            currency, symbol, exchangeName: "MOCK", fullExchangeName: "Mock Exchange", instrumentType: isFx ? "CURRENCY" : "EQUITY",
            regularMarketPrice: closes[closes.length - 1], regularMarketTime: end - 3600, gmtoffset: -14400,
            longName: `Mock ${symbol}`, fiftyTwoWeekHigh: Math.max(...closes), fiftyTwoWeekLow: Math.min(...closes),
            exchangeTimezoneName: "America/New_York",
          },
          timestamp: timestamps,
          indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] },
        }],
        error: null,
      },
    },
  };
}

function yahooTarget(requestUrl) {
  const u = new URL(requestUrl);
  const target = u.searchParams.get("url") || u.searchParams.get("quest") || decodeURIComponent(u.search.slice(1));
  return target && /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//.test(target) ? target : null;
}

// Routes all known public proxies. `mode.working` names the proxy ids that answer
// ("allorigins-json" by default); others fail like the real services do today.
async function mockProxies(context, mode = {}) {
  const calls = [];
  const targets = [];
  const working = () => new Set(mode.working || ["allorigins-json"]);
  const answer = (route, id, wrap) => {
    const target = yahooTarget(route.request().url());
    calls.push(id);
    if (!target) { targets.push(`NON-YAHOO:${route.request().url()}`); return route.fulfill({ status: 400, headers: ACAO, body: "bad target" }); }
    targets.push(target);
    if (mode.down || !working().has(id)) {
      if (id === "corsproxy") return route.fulfill({ status: 403, headers: ACAO, body: JSON.stringify({ error: "keyless_legacy_url" }) });
      if (id === "allorigins-raw") return route.fulfill({ status: 522, headers: { "access-control-allow-origin": "*" }, body: "error code: 522" });
      return route.abort("connectionrefused");
    }
    const symbol = decodeURIComponent(new URL(target).pathname.split("/").pop());
    const { status, body } = chartPayload(symbol, target);
    const text = JSON.stringify(body);
    return route.fulfill(wrap
      ? { status: 200, headers: ACAO, body: JSON.stringify({ contents: text, status: { http_code: status } }) }
      : { status, headers: ACAO, body: text });
  };
  await context.route(/corsproxy\.io/, r => answer(r, "corsproxy", false));
  await context.route(/api\.allorigins\.win\/raw/, r => answer(r, "allorigins-raw", false));
  await context.route(/api\.allorigins\.win\/get/, r => answer(r, "allorigins-json", true));
  await context.route(/api\.codetabs\.com/, r => answer(r, "codetabs", false));
  await context.route(/api\.cors\.lol/, r => answer(r, "corslol", false));
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
  return { calls, targets };
}

async function launch() {
  const args = (process.env.CHROMIUM_ARGS || "").split(/\s+/).filter(Boolean);
  const options = { args };
  if (process.env.HTTPS_PROXY) options.proxy = { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" };
  try { return await chromium.launch({ ...options, channel: "chromium" }); }
  catch (_) { return chromium.launch(options); }
}

// Records every request so tests can prove which external hosts a page contacted.
function watchNetwork(page) {
  const external = [];
  const errors = [];
  page.on("request", r => { const u = new URL(r.url()); if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && u.protocol.startsWith("http")) external.push(r.url()); });
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/^Failed to load resource|blocked by CORS policy/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("dialog", d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  return { external, errors };
}

function checker() {
  let failures = 0;
  const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) failures += 1; };
  const done = () => { console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED"); return failures; };
  return { check, done };
}

module.exports = { SITE_URL, launch, mockProxies, watchNetwork, checker, chartPayload, yahooTarget };
