// Shared Playwright harness for the tool-page browser tests.
//
// Every market-data host is replaced by a deterministic mock that returns synthetic
// data in the exact response shapes observed live on 2026-11-02:
//   www.bankofcanada.ca    Valet JSON (FX<CODE>CAD series)
//   data-api.ecb.europa.eu SDMX CSV (EXR.D.<CUR>.EUR.SP00.A)
//   www.alphavantage.co    SYMBOL_SEARCH, GLOBAL_QUOTE, TIME_SERIES_DAILY,
//                          TIME_SERIES_WEEKLY_ADJUSTED, plus its HTTP-200 error bodies
//                          (daily limit, and the 2026 per-second burst wording)
//   api.marketstack.com    /v2/eod/latest (exchange MIC and price_currency per row)
//   finnhub.io             /api/v1/quote (US listings only, as on the free plan)
//   md.gateway.test        the REAL market-data gateway code (_services/market-data-gateway)
//                          running in this process, whose upstream is the synthetic Yahoo
//                          fixtures (../fixtures/yahoo-chart.mjs): Yahoo is never contacted.
//                          Pages use it when opened with ?mdgateway=https://md.gateway.test.
//                          The site's configured gateway (_data/market_data.yml), once set,
//                          is answered by the same mocked Worker, so a page opened without
//                          ?mdgateway behaves as in production without any live request;
//                          ?mdgateway=none opens a page as if no gateway were configured.
// Any other external request except the Chart.js CDN is aborted and recorded, so a
// test can prove which hosts a page contacted. No real market data is stored here.
//
// Environment:
//   SITE_URL       base URL of a served `jekyll build` output (default http://127.0.0.1:4000)
//   HTTPS_PROXY    optional upstream proxy for real CDN requests (Chart.js)
//   CHROMIUM_ARGS  optional extra Chromium flags (whitespace separated)
"use strict";
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const SITE_URL = (process.env.SITE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const TEST_KEY = "TESTKEY12345";
const MS_KEY = "MSTESTKEY1234567890AB";
const FH_KEY = "FHTESTKEY1234567890AB";
const AV_BURST = "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints";
const DAY = 86400000;
const CORS = { "access-control-allow-origin": "*" };
const JSON_HEADERS = { ...CORS, "content-type": "application/json" };
const MD_GATEWAY = "https://md.gateway.test";
const ROOT = path.resolve(__dirname, "../../..");
// The deployed gateway the site points at (empty until it is set): never contacted by a test.
const SITE_GATEWAY = (() => {
  try {
    const m = require("fs").readFileSync(path.join(ROOT, "_data/market_data.yml"), "utf8").match(/^gateway:\s*"([^"]*)"/m);
    return m && m[1] ? new URL(m[1]).origin : "";
  } catch (_) { return ""; }
})();
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GATEWAY_ROUTE = SITE_GATEWAY ? new RegExp(`^(https://md\\.gateway\\.test|${escapeRe(SITE_GATEWAY)})/`) : /^https:\/\/md\.gateway\.test\//;
// The gateway's activation values, as the owner's production deployment sets them.
const GATEWAY_ON = { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission" };
let gatewayModules = null;
const loadGateway = () => (gatewayModules ||= Promise.all([
  import(pathToFileURL(path.join(ROOT, "_services/market-data-gateway/src/gateway.js")).href),
  import(pathToFileURL(path.join(ROOT, "_tools/tests/fixtures/yahoo-chart.mjs")).href),
]));

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
// "SPLITX" has a 3-for-2 split 20 sessions ago: as-traded closes drop by a third,
// adjusted closes are continuous.
const SPLIT_AT = Date.now() - 28 * DAY;
function avPrice(symbol, ms, adjusted = false) {
  if (symbol === "SPLITX" && !adjusted && ms < SPLIT_AT) return Number((avPrice(symbol, ms, true) * 1.5).toFixed(4));
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
  if (mode.avBurstOn && mode.avBurstOn.includes(mode.avCalls)) return JSON.stringify({ Information: AV_BURST });
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
    // The latest session in the listing's own time zone (Europe and Asia can already be on the next calendar day).
    const t = VENUE_TZ.some(([re]) => re.test(symbol)) ? sessionFor(symbol) : days[days.length - 1];
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
      "Weekly Adjusted Time Series": Object.fromEntries(fridays.reverse().map(t => [iso(t), { "1. open": "1", "2. high": "1", "3. low": "1", "4. close": String(avPrice(symbol, t)), "5. adjusted close": String(Number((avPrice(symbol, t, true) * 0.98).toFixed(4))), "6. volume": "5000", "7. dividend amount": "0.0000" }])) });
  }
  return JSON.stringify({ "Error Message": "Invalid API call." });
}

// Marketstack /v2/eod/latest: Yahoo-style symbols; exchange MIC and price_currency
// as Marketstack reports them (London in GBX, Tokyo as XJPX). YNVD is not listed.
const MS_VENUE = [[/\.TO$/, "XTSE", "CAD"], [/\.V$/, "XTSX", "CAD"], [/\.NE$/, "NEOE", "CAD"], [/\.L$/, "XLON", "GBX"], [/\.DE$/, "XETR", "EUR"], [/\.T$/, "XJPX", "JPY"], [/\.SS$/, "XSHG", "CNY"], [/\.SZ$/, "XSHE", "CNY"]];
function lastSession() { const days = businessDays(Date.now() - 10 * DAY, Date.now() - DAY); return days[days.length - 1]; }
// The weekday before "today" in the listing's own time zone: always the latest or the
// previous session there, whatever the time of day the tests run (Shanghai and Tokyo
// are already on the next calendar day from 15:00/16:00 UTC).
const VENUE_TZ = [[/\.(SHH|SHZ|SS|SZ)$/, "Asia/Shanghai"], [/\.T$/, "Asia/Tokyo"], [/\.(LON|L)$/, "Europe/London"], [/\.(DEX|DE)$/, "Europe/Berlin"]];
function sessionFor(symbol) {
  const tz = (VENUE_TZ.find(([re]) => re.test(symbol)) || [null, null])[1];
  if (!tz) return lastSession();
  const today = Date.parse(`${new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}T00:00:00Z`);
  let t = today - DAY;
  while ([0, 6].includes(new Date(t).getUTCDay())) t -= DAY;
  return t;
}
function msBody(url, mode) {
  if (url.searchParams.get("access_key") !== MS_KEY) return { status: 401, body: JSON.stringify({ error: { code: "invalid_access_key", message: "You have not supplied a valid API Access Key." } }) };
  mode.msCalls = (mode.msCalls || 0) + 1;
  if (mode.msLimit !== undefined && mode.msCalls > mode.msLimit) return { status: 429, body: JSON.stringify({ error: { code: "usage_limit_reached", message: "Your monthly usage limit has been reached. Please upgrade your Subscription Plan." } }) };
  const symbols = String(url.searchParams.get("symbols") || "").split(",").filter(Boolean);
  const data = symbols.filter(sym => !/^(YNVD|ZZZ)/.test(sym)).map(sym => {
    const t = VENUE_TZ.some(([re]) => re.test(sym)) ? sessionFor(sym) : lastSession();
    const venue = MS_VENUE.find(([re]) => re.test(sym)) || [null, "XNAS", "USD"];
    const p = avPrice(venue[1] === "XLON" ? `${sym}LON` : sym, t);
    return { open: p, high: p, low: p, close: venue[1] === "XLON" ? Number((p * 1).toFixed(2)) : p, volume: 1000, adj_close: p, name: `Mock ${sym}`, exchange_code: venue[1], asset_type: "Stock", price_currency: venue[2], symbol: sym, exchange: venue[1], date: `${iso(t)}T00:00:00+0000` };
  });
  return { status: 200, body: JSON.stringify({ pagination: { limit: 100, offset: 0, count: data.length, total: data.length }, data }) };
}
// Finnhub /api/v1/quote: US listings only (international symbols are refused, as on the free plan).
function fhBody(url) {
  if (url.searchParams.get("token") !== FH_KEY) return { status: 401, body: JSON.stringify({ error: "Invalid API key." }) };
  const sym = String(url.searchParams.get("symbol") || "");
  if (/\.[A-Z]{1,3}$/.test(sym) && !/\.[A-B]$/.test(sym)) return { status: 403, body: JSON.stringify({ error: "You don't have access to this resource." }) };
  if (/^ZZZ/.test(sym)) return { status: 200, body: JSON.stringify({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }) };
  const t = lastSession();
  const p = avPrice(`FH:${sym}`, t);
  return { status: 200, body: JSON.stringify({ c: p, d: 0.5, dp: 0.2, h: p * 1.01, l: p * 0.99, o: p, pc: p * 0.998, t: Math.floor((t + 21 * 3600000) / 1000) }) };
}

// Installs the mocks. `mode` flags (mutable during a test): bocDown, ecbDown, avDown,
// avLimit (requests before the daily limit), avBurstOn (request numbers answered with
// the burst notice), searchMissesSuffix, msLimit, fhDown, hold ({ SYMBOL: Promise }
// delays the answer for that symbol until the promise resolves).
// Market-data gateway: gatewayOff (deployed, keyless source switched off), gatewayDown
// (connection refused), gatewayHold (Promise delaying every answer), gatewayLimits
// (overrides of its limits), yahoo ({ down, limited, blocked, hang, ... } for the
// Yahoo fixtures). Reusing one `mode` object in two contexts shares one gateway (and
// its cache), as two visitors would.
async function mockMarketData(context, mode = {}) {
  const calls = { boc: 0, ecb: 0, av: [], ms: [], fh: [], gateway: [], yahoo: [], blocked: [] };
  mode.yahoo ||= {};
  mode.yahoo.calls = calls.yahoo;
  await context.route(GATEWAY_ROUTE, async route => {
    const req = route.request();
    const [{ createGateway }, { yahooFetch }] = await loadGateway();
    // Upstream spacing (1 s per request) is tested in unit tests; here it is shortened
    // so a 14-holding run does not take 14 s, unless a test sets its own limits.
    mode.gatewayInstance ||= createGateway({ fetchImpl: yahooFetch({ mode: mode.yahoo }), log: () => {}, cache: null, limits: { upstreamMinSpacingMs: 50, ...(mode.gatewayLimits || {}) } });
    const sent = req.headers();
    calls.gateway.push({ url: req.url(), method: req.method(), headers: sent, body: req.postData() });
    if (mode.gatewayHold) await mode.gatewayHold;
    if (mode.gatewayDown) return route.abort("connectionrefused");
    const env = { ALLOWED_ORIGINS: SITE_URL, ...(mode.gatewayOff ? {} : GATEWAY_ON) };
    const headers = { "CF-Connecting-IP": "198.51.100.20" };
    if (sent.origin) headers.Origin = sent.origin;
    if (sent["access-control-request-method"]) headers["Access-Control-Request-Method"] = sent["access-control-request-method"];
    const res = await mode.gatewayInstance.handle(new Request(req.url(), { method: req.method(), headers }), env);
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: res.status === 204 ? "" : await res.text() });
  });
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
  const held = async symbol => { const gate = mode.hold?.[symbol]; if (gate) await gate; };
  await context.route(/^https:\/\/www\.alphavantage\.co\//, async route => {
    const url = new URL(route.request().url());
    const symbol = url.searchParams.get("symbol") || url.searchParams.get("keywords");
    calls.av.push(`${url.searchParams.get("function")}:${symbol}`);
    await held(symbol);
    if (mode.avDown) return route.abort("connectionrefused");
    return route.fulfill({ status: 200, headers: JSON_HEADERS, body: avBody(url, mode) });
  });
  await context.route(/^https:\/\/api\.marketstack\.com\//, async route => {
    const url = new URL(route.request().url());
    calls.ms.push(String(url.searchParams.get("symbols")));
    await held(url.searchParams.get("symbols"));
    const { status, body } = msBody(url, mode);
    return route.fulfill({ status, headers: JSON_HEADERS, body });
  });
  await context.route(/^https:\/\/finnhub\.io\//, async route => {
    const url = new URL(route.request().url());
    calls.fh.push(String(url.searchParams.get("symbol")));
    await held(url.searchParams.get("symbol"));
    if (mode.fhDown) return route.abort("connectionrefused");
    const { status, body } = fhBody(url);
    return route.fulfill({ status, headers: JSON_HEADERS, body });
  });
  await context.route(url => {
    const u = new URL(url);
    return u.protocol.startsWith("http") && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)
      && !/^(www\.bankofcanada\.ca|data-api\.ecb\.europa\.eu|www\.alphavantage\.co|api\.marketstack\.com|finnhub\.io|md\.gateway\.test)$/.test(u.hostname);
  }, route => { calls.blocked.push(route.request().url()); return route.abort("blockedbyclient"); });
  await context.route(/favicon\.ico/, r => r.fulfill({ status: 204 }));
  return calls;
}

// CPI Web Scraper sources: Statistics Canada's Web Data Service and the data gateway
// (any https://*.gateway.test origin, passed to the page as ?gateway=). Synthetic,
// deterministic data in the exact response shapes; every other external host is
// aborted and recorded. `mode` flags (mutable): statcan409 (always HTTP 409),
// statcanHold (Promise delaying every answer), gatewayDown, keyRejected,
// fredFail ([FRED ids] answered 502), fredDisabled ([FRED ids]), gatewayHold.
const CPI_KEY = "cpitestkey0123456789cpitestkey01";
const CPI_GATEWAY = "https://cpi-data-gateway.gateway.test";
const STATCAN_FIRST = { 41690973: "1914-01", 41690914: "1992-01", 41691233: "1961-01", 41690924: "1992-01", 41692327: "1978-09" };
const FRED_FIRST = { CPIAUCNS: "1913-01", CPIAUCSL: "1947-01", CPILFENS: "1957-01", CPILFESL: "1957-01", UNRATE: "1948-01", FEDFUNDS: "1954-07", DFF: "1954-07", SP500: null, T10Y2Y: "1976-06", GS10: "1953-04", GS2: "1976-06", PCEPI: "1959-01", PCEPILFE: "1959-01" };
const FRED_DAILY = new Set(["DFF", "SP500", "T10Y2Y"]);
const ymOf = ms => new Date(ms).toISOString().slice(0, 7);
const ymAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + m - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
function monthsIn(from, to) { const out = []; for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) out.push(ym); return out; }
const cpiValue = (seed, ym, scale, decimals) => Number((scale * (1 + 0.002 * monthsIn("1913-01", ym).length + 0.01 * Math.sin(hash(seed + ym) % 100))).toFixed(decimals));

function statcanBody(url) {
  const vectors = url.searchParams.get("vectorIds").split(",");
  const from = url.searchParams.get("startRefPeriod").slice(0, 7);
  const to = url.searchParams.get("endReferencePeriod").slice(0, 7);
  const published = ymAdd(ymOf(Date.now()), -2); // CPI for month M is released in M+1
  return JSON.stringify(vectors.map(v => ({
    status: "SUCCESS",
    object: { responseStatusCode: 0, productId: 18100004, coordinate: "2.2.0.0.0.0.0.0.0.0", vectorId: Number(v),
      vectorDataPoint: monthsIn(from, to).filter(ym => ym >= STATCAN_FIRST[v] && ym <= published).map(ym => ({
        refPer: `${ym}-01`, refPer2: "", refPerRaw: `${ym}-01`, refPerRaw2: "", value: cpiValue(v, ym, 20, 1), decimals: 1, scalarFactorCode: 0,
        symbolCode: ym === published ? 3 : 0, statusCode: 0, securityLevelCode: 0, releaseTime: `${ymAdd(ym, 1)}-18T08:30`, frequencyCode: 6,
      })) },
  })));
}

function gatewayObservations(body) {
  const { series_id: id, observation_start: start, observation_end: end } = body;
  const published = ymAdd(ymOf(Date.now()), -1);
  const first = FRED_FIRST[id] || ymAdd(ymOf(Date.now()), -120);
  const obs = [];
  if (FRED_DAILY.has(id)) {
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Math.min(Date.parse(`${end}T00:00:00Z`), Date.now() - DAY); t += DAY) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      if (date.slice(0, 7) < first || ([0, 6].includes(d.getUTCDay()) && id !== "DFF")) continue;
      obs.push({ date, value: date.endsWith("-25") ? "." : (id === "SP500" ? 4000 + (t / DAY % 900) : id === "T10Y2Y" ? -0.4 + (t / DAY % 9) / 10 : 4 + (t / DAY % 7) / 10).toFixed(2) });
    }
  } else {
    // FRED's own precision: three decimals for CPI and PCE indexes, one for UNRATE, two for rates.
    const decimals = /^(CPI|PCE)/.test(id) ? 3 : id === "UNRATE" ? 1 : 2;
    for (const ym of monthsIn(start.slice(0, 7), end.slice(0, 7))) if (ym >= first && ym <= published) obs.push({ date: `${ym}-01`, value: cpiValue(id, ym, /^CPI/.test(id) ? 30 : /^PCE/.test(id) ? 12 : 0.4, decimals).toFixed(decimals) });
  }
  return { schema: "cpi-data-gateway.observations.v1", series_id: id, observation_start: start, observation_end: end, count: obs.length, observations: obs, source: "FRED, Federal Reserve Bank of St. Louis (mock)", retrieved_at: new Date().toISOString() };
}

async function mockCpiSources(context, mode = {}) {
  const calls = { statcan: [], gateway: [], blocked: [] };
  await context.route(/^https:\/\/www150\.statcan\.gc\.ca\//, async route => {
    const url = new URL(route.request().url());
    calls.statcan.push(url.search);
    if (mode.statcanHold) await mode.statcanHold;
    if (mode.statcan409) return route.fulfill({ status: 409, headers: CORS, body: "Conflict" });
    return route.fulfill({ status: 200, headers: JSON_HEADERS, body: statcanBody(url) });
  });
  await context.route(/^https:\/\/[a-z0-9-]+\.gateway\.test\//, async route => {
    const req = route.request();
    const cors = { "access-control-allow-origin": SITE_URL, vary: "Origin", "cache-control": "no-store" };
    if (mode.gatewayDown) return route.abort("connectionrefused");
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "Content-Type" } });
    const url = new URL(req.url());
    const body = req.postDataJSON();
    calls.gateway.push({ path: url.pathname, url: req.url(), body, headers: req.headers() });
    if (mode.gatewayHold) await mode.gatewayHold;
    const json = (status, payload) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (url.pathname === "/v1/health") return json(200, { status: "ok", service: "cpi-data-gateway", version: "test" });
    if (body?.api_key !== CPI_KEY || mode.keyRejected) return json(401, { error: { code: "key_rejected", message: "FRED rejected the key.", retryable: false } });
    if (mode.fredFail?.includes(body.series_id)) return json(502, { error: { code: "upstream_unavailable", message: "FRED is temporarily unavailable.", retryable: true } });
    if (mode.fredDisabled?.includes(body.series_id)) return json(403, { error: { code: "series_disabled", message: "This series is disabled by the gateway operator.", retryable: false } });
    return json(200, gatewayObservations(body));
  });
  await context.route(url => {
    const u = new URL(url);
    return u.protocol.startsWith("http") && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && !/^www150\.statcan\.gc\.ca$/.test(u.hostname) && !/\.gateway\.test$/.test(u.hostname);
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

const ALLOWED_HOSTS = /^(www\.bankofcanada\.ca|data-api\.ecb\.europa\.eu|www\.alphavantage\.co|api\.marketstack\.com|finnhub\.io|md\.gateway\.test)$/;
const disallowedRequests = urls => urls.filter(u => !ALLOWED_HOSTS.test(new URL(u).hostname));

function checker() {
  let failures = 0;
  const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) failures += 1; };
  const done = () => { console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED"); return failures; };
  return { check, done };
}

module.exports = { SITE_URL, TEST_KEY, MS_KEY, FH_KEY, CPI_KEY, CPI_GATEWAY, MD_GATEWAY, launch, mockMarketData, mockCpiSources, watchNetwork, checker, disallowedRequests };
