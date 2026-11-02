// Synthetic provider responses with the exact shapes observed live on 2026-11-02
// (Bank of Canada Valet JSON, ECB data-API CSV, Alpha Vantage JSON). Values are
// invented; no real market data is stored in the repository.

export const bocJson = (rows, series = ["FXUSDCAD"]) => JSON.stringify({
  terms: { url: "https://www.bankofcanada.ca/terms/" },
  seriesDetail: Object.fromEntries(series.map(s => [s, { label: `${s.slice(2, 5)}/CAD`, description: "Daily average exchange rate", dimension: { key: "d", name: "Date" } }])),
  observations: rows.map(({ d, ...values }) => ({ d, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { v: String(v) }])) })),
});

const ECB_HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT";
export const ecbCsv = rows => [ECB_HEADER, ...rows.map(([cur, day, value]) =>
  `EXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,${day},${value},A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,${cur}/Euro ECB reference exchange rate,"ECB reference exchange rate, ${cur}/Euro, 2.15 pm (C.E.T.)",${cur},0`)].join("\r\n") + "\r\n";

export const avGlobalQuote = (symbol, price, day, extra = {}) => JSON.stringify({ "Global Quote": {
  "01. symbol": symbol, "02. open": String(price), "03. high": String(price * 1.01), "04. low": String(price * 0.99), "05. price": String(price),
  "06. volume": "123456", "07. latest trading day": day, "08. previous close": String(price * 0.995), "09. change": "0.5", "10. change percent": "0.5025%", ...extra,
} });

export const avSearch = matches => JSON.stringify({ bestMatches: matches.map(([symbol, region, currency, name = `${symbol} Inc`, type = "Equity"]) => ({
  "1. symbol": symbol, "2. name": name, "3. type": type, "4. region": region, "5. marketOpen": "09:30", "6. marketClose": "16:00",
  "7. timezone": "UTC-05", "8. currency": currency, "9. matchScore": "1.0000",
})) });

export const avWeekly = (symbol, rows) => JSON.stringify({
  "Meta Data": { "1. Information": "Weekly Adjusted Prices and Volumes", "2. Symbol": symbol, "3. Last Refreshed": rows[rows.length - 1][0], "4. Time Zone": "US/Eastern" },
  "Weekly Adjusted Time Series": Object.fromEntries(rows.map(([day, close, adj]) => [day, {
    "1. open": String(close), "2. high": String(close), "3. low": String(close), "4. close": String(close), "5. adjusted close": String(adj), "6. volume": "1000", "7. dividend amount": "0.0000",
  }])),
});

export const avDaily = (symbol, rows) => JSON.stringify({
  "Meta Data": { "1. Information": "Daily Prices (open, high, low, close) and Volumes", "2. Symbol": symbol, "3. Last Refreshed": rows[rows.length - 1][0], "4. Output Size": "Compact", "5. Time Zone": "US/Eastern" },
  "Time Series (Daily)": Object.fromEntries(rows.map(([day, close]) => [day, { "1. open": String(close), "2. high": String(close), "3. low": String(close), "4. close": String(close), "5. volume": "1000" }])),
});

export const AV_RATE_LIMIT = JSON.stringify({ Information: "We have detected your API key as XXXX and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits." });
export const AV_BAD_KEY = JSON.stringify({ "Error Message": "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds." });
export const AV_BAD_SYMBOL = JSON.stringify({ "Error Message": "Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for TIME_SERIES_DAILY." });
export const AV_PREMIUM = JSON.stringify({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints" });

export function response(status, text, headers = {}) {
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

// fetch stub: handler(url) -> Response | Promise<Response> | throws. Records calls.
export function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push(String(url)); return handler(new URL(String(url)), init); };
  fn.calls = calls;
  return fn;
}

export function memory() {
  const map = new Map();
  return {
    get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); },
  };
}
