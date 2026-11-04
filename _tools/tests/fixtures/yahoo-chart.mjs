// Synthetic Yahoo Finance chart responses for the market-data gateway tests.
//
// The SHAPE follows public examples of https://query1.finance.yahoo.com/v8/finance/chart/
// (chart.result[0].meta / timestamp / indicators.quote[0].close / indicators.adjclose);
// every VALUE is invented and deterministic. No response here was captured from Yahoo,
// and nothing in the test suites contacts Yahoo. The exchange codes are the gateway's
// own allowlist (unconfirmed against live data; see _services/market-data-gateway/README.md).
//
// `yahooChartResponse(url, { now, mode })` answers a gateway upstream URL exactly as the
// gateway builds it and returns { status, body }. Special symbols exercise failures:
//   ZZZ*        not found (HTTP 404 with chart.error)
//   NOPRICE     regularMarketPrice 0
//   NEGHIST     a negative close in the history
//   BADJSON     HTTP 200 with an HTML page (not JSON)
//   OTCX        listed on an OTC market (exchange PNK), not a US exchange
//   WRONGSYM    answers for a different symbol
//   BADCUR.DE   Xetra listing reported in USD
//   IDXETF      reported as an INDEX
//   NOADJ       history without adjusted closes
// `mode` (mutable): down (HTTP 503), downFor (array of symbols answered with HTTP 503),
// limited (HTTP 429), blocked (HTTP 403), redirect (HTTP 302), huge (a body over the
// gateway's size cap), staleDays (answers dated that many days in the past), calls
// (array: every URL).

const DAY = 86400000;

export const FIXTURE_LISTINGS = {
  AAPL: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "Apple Inc.", tz: "America/New_York" },
  SPCX: { exchangeName: "NMS", fullExchangeName: "NasdaqGM", currency: "USD", instrumentType: "EQUITY", longName: "Mock SPCX", tz: "America/New_York" },
  CBRS: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "Mock CBRS", tz: "America/New_York" },
  VST: { exchangeName: "NYQ", fullExchangeName: "NYSE", currency: "USD", instrumentType: "EQUITY", longName: "Vistra Corp.", tz: "America/New_York" },
  MSFT: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "Microsoft Corporation", tz: "America/New_York" },
  SPY: { exchangeName: "PCX", fullExchangeName: "NYSEArca", currency: "USD", instrumentType: "ETF", longName: "SPDR S&P 500 ETF Trust", tz: "America/New_York" },
  "BRK-B": { exchangeName: "NYQ", fullExchangeName: "NYSE", currency: "USD", instrumentType: "EQUITY", longName: "Berkshire Hathaway Inc.", tz: "America/New_York" },
  "VEQT.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "ETF", longName: "Vanguard All-Equity ETF Portfolio", tz: "America/Toronto" },
  "CNQ.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "EQUITY", longName: "Canadian Natural Resources Limited", tz: "America/Toronto" },
  "XQQ.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "ETF", longName: "Mock XQQ", tz: "America/Toronto" },
  "HEWB.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "ETF", longName: "Mock HEWB", tz: "America/Toronto" },
  "VFV.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "ETF", longName: "Mock VFV", tz: "America/Toronto" },
  "XIU.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "CAD", instrumentType: "ETF", longName: "iShares S&P/TSX 60 Index ETF", tz: "America/Toronto" },
  "DLR-U.TO": { exchangeName: "TOR", fullExchangeName: "Toronto", currency: "USD", instrumentType: "ETF", longName: "Mock DLR.U", tz: "America/Toronto" },
  "YNVD.NE": { exchangeName: "NEO", fullExchangeName: "Cboe CA", currency: "CAD", instrumentType: "ETF", longName: "Mock YNVD (Cboe Canada)", tz: "America/Toronto" },
  "7203.T": { exchangeName: "JPX", fullExchangeName: "Tokyo", currency: "JPY", instrumentType: "EQUITY", longName: "Toyota Motor Corporation", tz: "Asia/Tokyo" },
  "SAP.DE": { exchangeName: "GER", fullExchangeName: "XETRA", currency: "EUR", instrumentType: "EQUITY", longName: "SAP SE", tz: "Europe/Berlin" },
  "VOD.L": { exchangeName: "LSE", fullExchangeName: "LSE", currency: "GBp", instrumentType: "EQUITY", longName: "Vodafone Group Public Limited Company", tz: "Europe/London" },
  "600519.SS": { exchangeName: "SHH", fullExchangeName: "Shanghai", currency: "CNY", instrumentType: "EQUITY", longName: "Kweichow Moutai Co., Ltd.", tz: "Asia/Shanghai" },
  NOPRICE: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "No price", tz: "America/New_York" },
  NEGHIST: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "Negative history", tz: "America/New_York" },
  NOADJ: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "No adjusted closes", tz: "America/New_York" },
  OTCX: { exchangeName: "PNK", fullExchangeName: "Other OTC", currency: "USD", instrumentType: "EQUITY", longName: "OTC listing", tz: "America/New_York" },
  WRONGSYM: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "EQUITY", longName: "Wrong symbol", tz: "America/New_York", symbol: "OTHER" },
  "BADCUR.DE": { exchangeName: "GER", fullExchangeName: "XETRA", currency: "USD", instrumentType: "EQUITY", longName: "Wrong currency", tz: "Europe/Berlin" },
  IDXETF: { exchangeName: "NMS", fullExchangeName: "NasdaqGS", currency: "USD", instrumentType: "INDEX", longName: "An index", tz: "America/New_York" },
};

const RANGE_DAYS = { "5d": 7, "1mo": 31, "3mo": 92, "6mo": 184, "1y": 366, "2y": 731, "5y": 1827 };
// UTC hour of the daily bar's timestamp (session open) and of the quote (after the close),
// chosen so each falls on the same local calendar date.
const BAR_HOUR = { "America/New_York": 14.5, "America/Toronto": 14.5, "Europe/London": 8, "Europe/Berlin": 7, "Asia/Tokyo": 0, "Asia/Shanghai": 1.5 };
const CLOSE_HOUR = { "America/New_York": 21, "America/Toronto": 21, "Europe/London": 16.5, "Europe/Berlin": 16.5, "Asia/Tokyo": 6, "Asia/Shanghai": 7 };

function hash(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const localDay = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

// Synthetic price in the listing's quote unit (pence for VOD.L).
export function fixturePrice(symbol, dayMs) {
  const seed = hash(symbol);
  const base = symbol === "VOD.L" ? 72 : symbol === "7203.T" ? 2850 : symbol === "600519.SS" ? 1480 : 20 + (seed % 400);
  const t = Math.floor(dayMs / DAY);
  return Number((base * Math.exp(0.0002 * (t - 20000) + 0.03 * Math.sin(t / 11 + (seed % 13)))).toFixed(symbol === "7203.T" ? 1 : 4));
}

// Weekdays (UTC midnight of the local date) from `days` before now up to the last
// weekday strictly before today in the listing's time zone.
export function fixtureSessions(tz, now, days) {
  const today = Date.parse(`${localDay(now, tz)}T00:00:00Z`);
  const out = [];
  for (let t = today - days * DAY; t < today; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

function chartBody(symbol, listing, { range, now, quote }) {
  const tz = listing.tz;
  const sessions = fixtureSessions(tz, now, RANGE_DAYS[range] || 31);
  const last = sessions[sessions.length - 1];
  const timestamp = sessions.map(t => Math.round((t + BAR_HOUR[tz] * 3600000) / 1000));
  const close = sessions.map((t, i) => {
    if (symbol === "NEGHIST" && i === Math.floor(sessions.length / 2)) return -1.5;
    if (!quote && i > 0 && i % 37 === 0) return null; // a day with no trade: Yahoo reports null
    return fixturePrice(symbol, t);
  });
  // Adjusted closes: earlier dates scaled down a little (synthetic dividends).
  const adjclose = close.map((c, i) => (c === null ? null : Number((c * (1 - 0.00008 * (sessions.length - 1 - i))).toFixed(4))));
  const price = symbol === "NOPRICE" ? 0 : fixturePrice(symbol, last);
  const meta = {
    currency: listing.currency, symbol: listing.symbol || symbol, exchangeName: listing.exchangeName, fullExchangeName: listing.fullExchangeName,
    instrumentType: listing.instrumentType, firstTradeDate: 946684800, regularMarketTime: Math.round((last + CLOSE_HOUR[tz] * 3600000) / 1000),
    hasPrePostMarketData: false, gmtoffset: 0, timezone: "UTC", exchangeTimezoneName: tz, regularMarketPrice: price,
    fiftyTwoWeekHigh: price * 1.2, fiftyTwoWeekLow: price * 0.8, regularMarketDayHigh: price * 1.01, regularMarketDayLow: price * 0.99,
    regularMarketVolume: 123456, longName: listing.longName, shortName: listing.longName, chartPreviousClose: price * 0.97, priceHint: 2,
    dataGranularity: "1d", range, validRanges: ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"],
  };
  const indicators = { quote: [{ open: close, high: close, low: close, close, volume: close.map(c => (c === null ? null : 1000)) }] };
  if (!quote && symbol !== "NOADJ") indicators.adjclose = [{ adjclose }];
  const result = { meta, timestamp, indicators };
  if (!quote) result.events = { dividends: {} };
  return JSON.stringify({ chart: { result: [result], error: null } });
}

export function yahooChartResponse(url, { now = Date.now(), mode = {} } = {}) {
  const u = new URL(url);
  mode.calls?.push(url);
  if (u.origin !== "https://query1.finance.yahoo.com" || !u.pathname.startsWith("/v8/finance/chart/")) return { status: 404, body: "not the chart endpoint" };
  if (mode.down) return { status: 503, body: "<html>Service unavailable</html>" };
  if (mode.limited) return { status: 429, body: "Too Many Requests" };
  if (mode.blocked) return { status: 403, body: "<html>Forbidden</html>" };
  if (mode.redirect) return { status: 302, body: "", headers: { location: "https://consent.yahoo.com/" } };
  const symbol = decodeURIComponent(u.pathname.slice("/v8/finance/chart/".length));
  if (symbol === "BADJSON") return { status: 200, body: "<html><body>Please enable JavaScript</body></html>" };
  if (mode.huge) return { status: 200, body: JSON.stringify({ chart: { result: [{ meta: {}, pad: "x".repeat(2.5 * 1024 * 1024) }], error: null } }) };
  const listing = FIXTURE_LISTINGS[symbol];
  if (!listing) return { status: 404, body: JSON.stringify({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }) };
  if (mode.downFor?.includes(symbol)) return { status: 503, body: "<html>Service unavailable</html>" };
  const range = u.searchParams.get("range");
  // staleDays: the source answers as of that many days ago (an old price, never relabelled).
  const asOf = mode.staleDays ? now - mode.staleDays * DAY : now;
  return { status: 200, body: chartBody(symbol, listing, { range, now: asOf, quote: range === "5d" }) };
}

// A fetch() stand-in for the gateway's upstream. `hang: true` never answers until aborted.
export function yahooFetch({ now = () => Date.now(), mode = {} } = {}) {
  return async (url, init = {}) => {
    if (mode.hang) {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }
    if (mode.networkError) throw new TypeError("fetch failed");
    const { status, body, headers = {} } = yahooChartResponse(String(url), { now: now(), mode });
    return new Response(body, { status, headers: { "content-type": status === 200 && body.startsWith("{") ? "application/json" : "text/html", ...headers } });
  };
}
