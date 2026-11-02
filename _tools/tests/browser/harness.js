// Shared Playwright harness for the tool-page browser tests.
//
// Every market-data host is replaced by a deterministic mock that returns synthetic
// data in the exact response shapes observed live on 2026-11-02:
//   www.bankofcanada.ca    Valet JSON (FX<CODE>CAD series)
//   data-api.ecb.europa.eu SDMX CSV (EXR.D.<CUR>.EUR.SP00.A)
//   www.alphavantage.co    SYMBOL_SEARCH, GLOBAL_QUOTE, TIME_SERIES_DAILY,
//                          TIME_SERIES_WEEKLY_ADJUSTED, plus its HTTP-200 error bodies
// Any other external request except the Chart.js CDN is aborted and recorded, so a
// test can prove which hosts a page contacted. No real market data is stored here.
//
// Environment:
//   SITE_URL       base URL of a served `jekyll build` output (default http://127.0.0.1:4000)
//   HTTPS_PROXY    optional upstream proxy for real CDN requests (Chart.js)
//   CHROMIUM_ARGS  optional extra Chromium flags (whitespace separated)
"use strict";
const { chromium } = require("playwright");

const SITE_URL = (process.env.SITE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const TEST_KEY = "TESTKEY12345";
const DAY = 86400000;
const CORS = { "access-control-allow-origin": "*" };
const JSON_HEADERS = { ...CORS, "content-type": "application/json" };

function hash(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const iso = ms => new Date(ms).toISOString().slice(0, 10);

// CAD per unit, gently varying by day.
const CAD_PER = { USD: 1.39, EUR: 1.56, JPY: 0.0089, GBP: 1.87, CNY: 0.21, CHF: 1.6, AUD: 0.98 };
function cadPer(code, ms) {
  const base = CAD_PER[code];
  if (!base) return null;
  const t = Math.floor(ms / DAY);
  return Number((base * (1 + 0.01 * Math.sin(t / 9 + hash(code) % 7))).toPrecision(5));
}
function businessDays(startMs, endMs) {
  const out = [];
  for (let t = Math.floor(startMs / DAY) * DAY; t <= endMs; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t);
  }
  return out;
}
// Business days strictly before today (a central bank publishes after the close).
function publishedDays(startMs, endMs) {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return businessDays(startMs, Math.min(endMs, today - DAY));
}

function bocBody(url) {
  const series = decodeURIComponent(url.pathname.split("/observations/")[1].split("/")[0]).split(",");
  const recent = Number(url.searchParams.get("recent")) || 0;
  const end = url.searchParams.get("end_date") ? Date.parse(`${url.searchParams.get("end_date")}T00:00:00Z`) : Date.now();
  const start = url.searchParams.get("start_date") ? Date.parse(`${url.searchParams.get("start_date")}T00:00:00Z`) : end - 15 * DAY;
  let days = publishedDays(start, end);
  if (recent) days = days.slice(-recent);
  return JSON.stringify({
    terms: { url: "https://www.bankofcanada.ca/terms/" },
    seriesDetail: Object.fromEntries(series.map(s => [s, { label: `${s.slice(2, 5)}/CAD`, description: "Daily average exchange rate (mock)" }])),
    observations: days.map(t => ({ d: iso(t), ...Object.fromEntries(series.filter(s => cadPer(s.slice(2, 5), t)).map(s => [s, { v: String(cadPer(s.slice(2, 5), t)) }])) })),
  });
}

function ecbBody(url) {
  const currencies = url.pathname.split("/D.")[1].split(".EUR")[0].split("+");
  const last = Number(url.searchParams.get("lastNObservations")) || 0;
  const end = url.searchParams.get("endPeriod") ? Date.parse(`${url.searchParams.get("endPeriod")}T00:00:00Z`) : Date.now();
  const start = url.searchParams.get("startPeriod") ? Date.parse(`${url.searchParams.get("startPeriod")}T00:00:00Z`) : end - 15 * DAY;
  let days = publishedDays(start, end);
  if (last) days = days.slice(-last);
  const header = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL";
  const rows = [];
  for (const cur of currencies) {
    for (const t of days) {
      const perEur = cur === "CAD" ? cadPer("EUR", t) : cadPer("EUR", t) / cadPer(cur, t);
      if (Number.isFinite(perEur)) rows.push(`EXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,${iso(t)},${perEur.toFixed(4)},A,"ECB reference exchange rate, ${cur}/Euro, 2.15 pm (C.E.T.)"`);
    }
  }
  return [header, ...rows].join("\r\n") + "\r\n";
}

const avCurrency = symbol => (/\.(TRT|TRV)$/.test(symbol) ? "CAD" : /\.LON$/.test(symbol) ? "GBX" : /\.DEX$/.test(symbol) ? "EUR" : "USD");
const avRegion = symbol => (/\.TRT$/.test(symbol) ? "Toronto" : /\.TRV$/.test(symbol) ? "Toronto Venture" : /\.LON$/.test(symbol) ? "United Kingdom" : "United States");
function avPrice(symbol, ms) {
  const seed = hash(symbol);
  const base = /\.LON$/.test(symbol) ? 300 + (seed % 900) : 20 + (seed % 400);
  const t = Math.floor(ms / DAY);
  return Number((base * Math.exp(0.0003 * (t - 20000) + 0.04 * Math.sin(t / 11 + (seed % 13)))).toFixed(4));
}
function avBody(url, mode) {
  const fn = url.searchParams.get("function");
  const symbol = (url.searchParams.get("symbol") || url.searchParams.get("keywords") || "").toUpperCase();
  if (url.searchParams.get("apikey") !== TEST_KEY) return JSON.stringify({ "Error Message": "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds." });
  mode.avCalls = (mode.avCalls || 0) + 1;
  if (mode.avLimit !== undefined && mode.avCalls > mode.avLimit) return JSON.stringify({ Information: "We have detected your API key as TESTKEY12345 and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits." });
  const unknown = /^ZZZ/.test(symbol);
  if (fn === "SYMBOL_SEARCH") {
    if (unknown) return JSON.stringify({ bestMatches: [] });
    const stem = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : symbol;
    const listed = symbol.includes(".") ? [] : [symbol, `${symbol}.TRT`];
    const matches = (symbol.includes(".") ? (mode.searchMissesSuffix ? [] : [symbol]) : listed).map(s => ({
      "1. symbol": s, "2. name": `Mock ${s}`, "3. type": "Equity", "4. region": avRegion(s), "5. marketOpen": "09:30", "6. marketClose": "16:00",
      "7. timezone": "UTC-05", "8. currency": avCurrency(s), "9. matchScore": s === symbol ? "1.0000" : "0.8000",
    }));
    return JSON.stringify({ bestMatches: stem === symbol || matches.length ? matches : [] });
  }
  if (unknown) return fn === "GLOBAL_QUOTE" ? JSON.stringify({ "Global Quote": {} }) : JSON.stringify({ "Error Message": `Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for ${fn}.` });
  const days = businessDays(Date.now() - 6 * 365 * DAY, Date.now() - DAY);
  if (fn === "GLOBAL_QUOTE") {
    const t = days[days.length - 1];
    const p = avPrice(symbol, t);
    return JSON.stringify({ "Global Quote": { "01. symbol": symbol, "02. open": String(p), "03. high": String(p * 1.01), "04. low": String(p * 0.99), "05. price": String(p), "06. volume": "1234567", "07. latest trading day": iso(t), "08. previous close": String(avPrice(symbol, t - DAY)), "09. change": "0.1", "10. change percent": "0.1000%" } });
  }
  if (fn === "TIME_SERIES_DAILY") {
    const recent = days.slice(-100);
    return JSON.stringify({ "Meta Data": { "1. Information": "Daily Prices (open, high, low, close) and Volumes", "2. Symbol": symbol, "3. Last Refreshed": iso(recent[recent.length - 1]), "4. Output Size": "Compact", "5. Time Zone": "US/Eastern" },
      "Time Series (Daily)": Object.fromEntries(recent.reverse().map(t => [iso(t), { "1. open": String(avPrice(symbol, t)), "2. high": String(avPrice(symbol, t)), "3. low": String(avPrice(symbol, t)), "4. close": String(avPrice(symbol, t)), "5. volume": "1000" }])) });
  }
  if (fn === "TIME_SERIES_WEEKLY_ADJUSTED") {
    const fridays = days.filter(t => new Date(t).getUTCDay() === 5);
    return JSON.stringify({ "Meta Data": { "1. Information": "Weekly Adjusted Prices and Volumes", "2. Symbol": symbol, "3. Last Refreshed": iso(fridays[fridays.length - 1]), "4. Time Zone": "US/Eastern" },
      "Weekly Adjusted Time Series": Object.fromEntries(fridays.reverse().map(t => [iso(t), { "1. open": "1", "2. high": "1", "3. low": "1", "4. close": String(avPrice(symbol, t)), "5. adjusted close": String(Number((avPrice(symbol, t) * 0.98).toFixed(4))), "6. volume": "5000", "7. dividend amount": "0.0000" }])) });
  }
  return JSON.stringify({ "Error Message": "Invalid API call." });
}

// Installs the mocks. `mode` flags (mutable during a test): bocDown, ecbDown, avDown,
// avLimit (requests before the daily limit), searchMissesSuffix.
async function mockMarketData(context, mode = {}) {
  const calls = { boc: 0, ecb: 0, av: [], blocked: [] };
  await context.route(/^https:\/\/www\.bankofcanada\.ca\/valet\//, route => {
    calls.boc += 1;
    if (mode.bocDown) return route.fulfill({ status: 503, headers: { "content-type": "text/html" }, body: "<html>Service unavailable</html>" });
    return route.fulfill({ status: 200, headers: JSON_HEADERS, body: bocBody(new URL(route.request().url())) });
  });
  await context.route(/^https:\/\/data-api\.ecb\.europa\.eu\//, route => {
    calls.ecb += 1;
    if (mode.ecbDown) return route.abort("connectionrefused");
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/csv" }, body: ecbBody(new URL(route.request().url())) });
  });
  await context.route(/^https:\/\/www\.alphavantage\.co\//, route => {
    const url = new URL(route.request().url());
    calls.av.push(`${url.searchParams.get("function")}:${url.searchParams.get("symbol") || url.searchParams.get("keywords")}`);
    if (mode.avDown) return route.abort("connectionrefused");
    return route.fulfill({ status: 200, headers: JSON_HEADERS, body: avBody(url, mode) });
  });
  await context.route(url => {
    const u = new URL(url);
    return u.protocol.startsWith("http") && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)
      && !/^(www\.bankofcanada\.ca|data-api\.ecb\.europa\.eu|www\.alphavantage\.co|cdn\.jsdelivr\.net)$/.test(u.hostname);
  }, route => { calls.blocked.push(route.request().url()); return route.abort("blockedbyclient"); });
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
  return calls;
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

const ALLOWED_HOSTS = /^(www\.bankofcanada\.ca|data-api\.ecb\.europa\.eu|www\.alphavantage\.co|cdn\.jsdelivr\.net)$/;
const disallowedRequests = urls => urls.filter(u => !ALLOWED_HOSTS.test(new URL(u).hostname));

function checker() {
  let failures = 0;
  const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) failures += 1; };
  const done = () => { console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED"); return failures; };
  return { check, done };
}

module.exports = { SITE_URL, TEST_KEY, launch, mockMarketData, watchNetwork, checker, disallowedRequests };
