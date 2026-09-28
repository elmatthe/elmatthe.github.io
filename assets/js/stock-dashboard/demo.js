// Deterministic synthetic demonstration data.
//
// Used by "Offline demo" mode so the dashboard can be explored with no network
// access. Every value is generated in the browser from a fixed seed: these are NOT
// real prices or exchange rates, and no request is made.

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
