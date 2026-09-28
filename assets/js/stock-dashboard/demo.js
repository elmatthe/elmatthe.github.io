// Deterministic synthetic demonstration data.
//
// Used by "Offline demo" mode and the demo Research record so the dashboard can be
// explored with no network access. Every value here is generated from a fixed seed:
// these are NOT real prices, NOT real TipRanks output and NOT real analysts.

const DAY_MS = 86400000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalGenerator(random) {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export const DEMO_SECURITIES = [
  { ticker: "DEMO-GROWTH", name: "Synthetic Growth Equity", currency: "USD", start: 120, drift: 0.14, beta: 1.25, idio: 0.18 },
  { ticker: "DEMO-VALUE", name: "Synthetic Value Equity", currency: "USD", start: 60, drift: 0.08, beta: 0.85, idio: 0.12 },
  { ticker: "DEMO-BONDS", name: "Synthetic Bond Fund", currency: "USD", start: 25, drift: 0.03, beta: -0.08, idio: 0.05 },
  { ticker: "DEMO-CANADA", name: "Synthetic Canadian Index ETF", currency: "CAD", start: 32, drift: 0.07, beta: 0.7, idio: 0.1 },
];

// Weekday sessions from ~5 years ago through yesterday (UTC).
function sessions(now) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
  const start = end - Math.round(5 * 365.25 + 14) * DAY_MS;
  const out = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(new Date(t));
  }
  return out;
}

let cache = null;

function build(now) {
  const dates = sessions(now);
  const normal = normalGenerator(mulberry32(20260928));
  const dt = 1 / 252;
  const marketVol = 0.16;
  const prices = Object.fromEntries(DEMO_SECURITIES.map(s => [s.ticker, s.start]));
  const series = Object.fromEntries(DEMO_SECURITIES.map(s => [s.ticker, []]));
  // USD value of one unit of each currency, as random walks.
  const usdPer = { USD: 1, CAD: 0.74, EUR: 1.08, GBP: 1.27 };
  const fx = Object.fromEntries(Object.keys(usdPer).map(c => [c, []]));
  for (const date of dates) {
    const market = normal() * marketVol * Math.sqrt(dt);
    for (const s of DEMO_SECURITIES) {
      const shock = s.beta * market + normal() * s.idio * Math.sqrt(dt);
      prices[s.ticker] *= Math.exp((s.drift - 0.5 * (s.beta ** 2 * marketVol ** 2 + s.idio ** 2)) * dt + shock);
      series[s.ticker].push({ date, price: Math.round(prices[s.ticker] * 100) / 100 });
    }
    for (const c of ["CAD", "EUR", "GBP"]) {
      usdPer[c] *= Math.exp(normal() * 0.07 * Math.sqrt(dt));
      fx[c].push({ date, price: usdPer[c] });
    }
    fx.USD.push({ date, price: 1 });
  }
  return { dates, series, fx };
}

function data(now = new Date()) {
  const key = new Date(now).toISOString().slice(0, 10);
  if (!cache || cache.key !== key) cache = { key, ...build(now) };
  return cache;
}

export function demoSeries(ticker, now) {
  const security = DEMO_SECURITIES.find(s => s.ticker === ticker);
  if (!security) return null;
  const { series } = data(now);
  const observations = series[ticker];
  return {
    ticker,
    currency: security.currency,
    observations,
    priceBasis: "synthetic",
    identity: { displayName: security.name, assetType: "SYNTHETIC", exchange: "Offline demo", currency: security.currency, providerSymbol: ticker },
    market: {
      price: observations[observations.length - 1].price,
      week52High: Math.max(...observations.slice(-252).map(o => o.price)),
      week52Low: Math.min(...observations.slice(-252).map(o => o.price)),
      marketTime: observations[observations.length - 1].date.toISOString(),
    },
  };
}

// Synthetic FX: native -> target rate points (target units per one native unit).
export function demoFxRates(native, target, now) {
  const { fx } = data(now);
  if (!fx[native] || !fx[target]) return null;
  return fx[native].map((point, i) => ({ date: point.date, price: point.price / fx[target][i].price }));
}

// A saved-Research-shaped record (schema v3) built from synthetic values.
export function demoResearchRecord(now = new Date()) {
  const series = demoSeries("DEMO-GROWTH", now);
  const current = series.market.price;
  const stamp = new Date(now).toISOString();
  const random = mulberry32(7);
  const firms = ["Example Securities", "Sample Capital Markets", "Placeholder & Co.", "Illustrative Research", "Demo Partners"];
  const ratings = ["Buy", "Buy", "Hold", "Buy", "Sell", "Hold", "Buy", "Buy"];
  const analysts = ratings.map((rating, i) => {
    const target = Math.round(current * (rating === "Sell" ? 0.85 : rating === "Hold" ? 1.02 : 1.08 + random() * 0.25) * 100) / 100;
    const daysAgo = Math.floor(random() * 80) + 2;
    return {
      analyst: `Synthetic Analyst ${String.fromCharCode(65 + i)}`,
      firm: firms[i % firms.length],
      rating,
      action: i % 3 === 0 ? "Reiterated" : i % 3 === 1 ? "Upgraded" : "Assigned",
      target,
      date: new Date(new Date(now).getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10),
      rank: i === 6 ? null : Math.floor(random() * 4000) + 50,
      ranked_experts: 9800,
      stars: Math.round((2 + random() * 3) * 10) / 10,
      success_rate: Math.round((0.45 + random() * 0.3) * 1000) / 1000,
      average_return: Math.round((-0.02 + random() * 0.25) * 1000) / 1000,
    };
  });
  const targetsList = analysts.map(a => a.target);
  const average = Math.round(targetsList.reduce((s, v) => s + v, 0) / targetsList.length * 100) / 100;
  const targets = { low: Math.min(...targetsList), average, high: Math.max(...targetsList) };
  return {
    synthetic_demo: true,
    schema_version: 3,
    result_id: "synthetic-demo",
    ticker: "DEMO-GROWTH",
    asset_type: "EQUITY",
    status: "completed",
    retry_of: null,
    requested_at: stamp,
    completed_at: stamp,
    planned_calls: [],
    planned_call_count: 0,
    actual_metered_calls: 0,
    history_eligible: true,
    result: {
      identity: { display_name: series.identity.displayName, asset_type: "EQUITY", exchange: "Offline demo", currency: "USD" },
      identity_source_labels: { display_name: "Synthetic demo", asset_type: "Synthetic demo", exchange: "Synthetic demo", currency: "Synthetic demo" },
      generic_market: { price: current, market_cap: null, pe_ratio: 24.6, dividend_yield: 0.006, beta: 1.25, week_52_low: series.market.week52Low, week_52_high: series.market.week52High },
      smart_score: 8,
      analyst_consensus: "Moderate Buy",
      targets,
      current_price: current,
      current_price_source: "Synthetic demo",
      target_distribution: { available: true, observations: targetsList },
      analyst_actions: analysts,
      insider_activity: [
        { insider: "Synthetic Insider 1", role: "Director", action: "Sold", side: "Sell", shares: 1200, price: current * 0.97, value: 1200 * current * 0.97, date: analysts[0].date, stars: 3.5 },
        { insider: "Synthetic Insider 2", role: "Officer", action: "Bought", side: "Buy", shares: 500, price: current * 0.93, value: 500 * current * 0.93, date: analysts[3].date, stars: 4.1 },
      ],
      news: [
        { title: "Synthetic headline: demo company reports illustrative quarter", source: "Demo Newswire", sentiment: "Positive", published_at: analysts[1].date, url: null },
        { title: "Synthetic headline: sample sector update", source: "Placeholder Journal", sentiment: "Neutral", published_at: analysts[2].date, url: null },
      ],
      source_comparison: [{ field: "price", values: [{ source: "Synthetic demo", value: current, retrieved_at: stamp }], different: false }],
      coverage: [
        { section: "Core research data", status: "available", source: "Synthetic demo", message: null },
        { section: "Analyst ratings", status: "available", source: "Synthetic demo", message: null },
        { section: "Insider activity", status: "available", source: "Synthetic demo", message: null },
        { section: "News and sentiment", status: "available", source: "Synthetic demo", message: null },
      ],
      provenance: [{ source: "Synthetic demo", dataset: "generated in browser", retrieved_at: stamp, as_of: null }],
      warnings: ["Synthetic demonstration data generated in your browser — not real TipRanks output, prices, or analysts."],
      errors: [],
      partial: false,
      unit_contract: { dividend_yield: "decimal_fraction", analyst_success_rate: "decimal_fraction", analyst_average_return: "decimal_fraction" },
    },
  };
}
