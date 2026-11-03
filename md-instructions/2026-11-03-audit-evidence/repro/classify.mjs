// Reproduces Alpha Vantage notice classification and its consequences (no network).
const repo = process.argv[2];
const AV = await import(`${repo}/assets/js/market-data/providers/alphavantage.js`);
const { createMarketData } = await import(`${repo}/assets/js/market-data/index.js`);
const { memoryStorage } = await import(`${repo}/assets/js/market-data/cache.js`);

const NOTICES = {
  // As in the repo's own unit-test fixture (first sentence only).
  burst_fixture: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second).",
  // Burst notice WITH the second sentence as reported for current free keys (UNVERIFIED wording).
  burst_full: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day) and instantly remove all daily rate limits.",
  daily: "We have detected your API key as XXXX and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.",
  premium: "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints",
  old_note_5pm: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day. Please visit https://www.alphavantage.co/premium/ if you would like to target a higher API call frequency.",
};
console.log("== parseAvBody classification ==");
for (const [name, text] of Object.entries(NOTICES)) {
  for (const field of ["Information", "Note"]) {
    try { AV.parseAvBody(JSON.stringify({ [field]: text })); console.log(name, field, "-> parsed as data"); }
    catch (e) { console.log(`${name.padEnd(14)} ${field.padEnd(11)} -> kind=${e.kind} definitive=${e.definitive} scope=${e.scope ?? "-"} msg="${e.message}"`); }
  }
}

// Client-level: 10 rebalancer tickers; the provider answers normally, except the
// Nth request gets the given notice. Count requests actually sent and outcomes.
const TICKERS = ["VEQT.TO", "CNQ.TO", "XQQ.TO", "HEWB.TO", "AAPL", "VFV.TO", "SPCX", "CBRS", "YNVD.TO", "VST"];
async function scenario(label, { noticeAt = null, notice = null, searchExact = true }) {
  const sent = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    const fn = u.searchParams.get("function");
    const sym = (u.searchParams.get("symbol") || u.searchParams.get("keywords")).toUpperCase();
    sent.push(`${fn}:${sym}`);
    let body;
    if (noticeAt !== null && sent.length >= noticeAt && (notice === "daily" || sent.length === noticeAt)) body = { Information: NOTICES[notice] };
    else if (fn === "SYMBOL_SEARCH") {
      const exact = sym.includes(".") ? (searchExact ? [sym] : []) : [sym, `${sym}.TRT`];
      body = { bestMatches: exact.map(s => ({ "1. symbol": s, "2. name": `Mock ${s}`, "3. type": "ETF", "4. region": s.endsWith(".TRT") ? "Toronto" : "United States", "7. timezone": "UTC-05", "8. currency": s.endsWith(".TRT") ? "CAD" : "USD" })) };
    } else body = { "Global Quote": { "01. symbol": sym, "05. price": "10.00", "07. latest trading day": "2026-11-02", "08. previous close": "10", "10. change percent": "0%" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  };
  const local = memoryStorage();
  let clock = Date.parse("2026-11-03T20:00:00Z");
  const md = createMarketData({ local, session: memoryStorage(), fetchImpl, now: () => clock, sleep: async ms => { clock += ms; }, minSpacingMs: 1200 });
  md.setApiKey("ABCDEFGH12345678", { remember: false });
  const results = await md.quotes(TICKERS.map(t => t));
  const outcome = {};
  for (const [sym, r] of results) outcome[sym] = r.quote ? "PRICE" : `${r.error.kind}${r.error.definitive ? "(definitive)" : ""}: ${r.error.message.slice(0, 70)}`;
  const usageKey = Object.keys(local.dump ? local.dump() : {}).find(k => k.endsWith(".usage"));
  let usageRecord = null;
  for (let i = 0; i < local.length; i++) { const k = local.key(i); if (k.endsWith(".usage")) usageRecord = local.getItem(k); }
  console.log(`\n== ${label} ==\nrequests sent: ${sent.length}  (${sent.join(", ")})\nusage counter shown: ${md.usage().count}/${md.usage().limit}\npersisted usage record: ${usageRecord}`);
  for (const [k, v] of Object.entries(outcome)) console.log(`  ${k.padEnd(8)} ${v}`);
  // A second run later the same UTC day (e.g. after reload): does it send anything?
  const md2 = createMarketData({ local, session: memoryStorage(), fetchImpl, now: () => clock + 3600e3, sleep: async ms => { clock += ms; } });
  md2.setApiKey("ABCDEFGH12345678", { remember: false });
  const before = sent.length;
  const r2 = await md2.quotes(["AAPL"]);
  console.log(`  re-run 1h later (new page, same key, same browser): requests sent=${sent.length - before}; AAPL -> ${r2.get("AAPL").quote ? "PRICE (cached)" : r2.get("AAPL").error.message.slice(0, 70)}`);
}
await scenario("A. clean run, SYMBOL_SEARCH finds suffixed symbols", {});
await scenario("B. clean run, SYMBOL_SEARCH misses suffixed symbols (stem retry)", { searchExact: false });
await scenario("C. full burst notice on request 3", { noticeAt: 3, notice: "burst_full" });
await scenario("D. fixture-style burst notice on request 3", { noticeAt: 3, notice: "burst_fixture" });
await scenario("E. genuine daily limit from request 1", { noticeAt: 1, notice: "daily" });
await scenario("F. premium notice on request 2", { noticeAt: 2, notice: "premium" });
