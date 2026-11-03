// Feeds verbatim Alpha Vantage notices (sources in REPORT.md §3) to the site's parseAvBody
// at HEAD ada2ceb and prints the resulting DataError classification. Read-only.
import { pathToFileURL } from "node:url";
const repo = process.argv[2];
const { parseAvBody } = await import(pathToFileURL(`${repo}/assets/js/market-data/providers/alphavantage.js`).href);
const notices = {
  "burst-2026 (tradetally#202 2026-02-05; maubot-financebot#2 2026-03-12)": { Information: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints" },
  "burst-2025-12 (beanprice#124 2025-12-13)": { Information: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day) and instantly unlock all premium endpoints" },
  "daily-2024 (home-assistant#109153 2024-01-30; finance-quote#361)": { Information: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits." },
  "daily-2026 (few-be#989 2026-06-27)": { Information: "We have detected your API key as XXXXXXXX and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits." },
  "premium (tradetally#202 2026-02-05)": { Information: "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints" },
  "demo (live probe av-3, 2026-11-03)": { Information: "The **demo** API key is for demo purposes only. Please claim your free API key at (https://www.alphavantage.co/support/#api-key) to explore our full API offerings. It takes fewer than 20 seconds." },
  "missing/invalid key (live probe av-4, 2026-11-03)": { "Error Message": "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds." },
  "invalid symbol (nisba-rates#2 2026-10-24)": { "Error Message": "Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for TIME_SERIES_DAILY." },
  "legacy Note 5/min (pre-2024)": { Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day. Please visit https://www.alphavantage.co/premium/ if you would like to target a higher API call frequency." },
};
for (const [name, body] of Object.entries(notices)) {
  try { parseAvBody(JSON.stringify(body), { symbol: "TEST" }); console.log(`${name}\n  -> NOT AN ERROR (parsed as data)`); }
  catch (e) { console.log(`${name}\n  -> kind=${e.kind} definitive=${Boolean(e.definitive)} scope=${e.scope ?? "-"} msg="${e.message}"`); }
}
