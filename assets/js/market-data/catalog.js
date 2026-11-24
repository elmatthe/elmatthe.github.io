// Provider catalog: the five market-data providers evaluated for this site, where
// each may be used, its plans (entitlement profiles), which exchanges it covers and
// how a resolved instrument's symbol is written for it. The order in which sources are
// tried is the visitor's own list (./sources.js), not a table here.
//
// Source of every fact: _tools/PROVIDER_MATRIX.md (checked 2026-11-03). The desktop
// apps carry the same table in market_data/catalog.py; _tools/tests/test_market_data_parity.py
// checks that the two agree.
//
// status per platform:
//   enabled     offered to the user
//   unsupported not offered on this platform (reason shown in documentation)
//   deferred    implemented and tested, not offered until a licensing question is settled

export const CATALOG_VERSION = "2026-11-04.1";

const US_FAMILY = ["US", "XNYS", "XNAS", "ARCX", "BATS", "XASE"];
export const isUsVenue = mic => US_FAMILY.includes(mic);

// Yahoo-style suffix per venue (the form most providers and brokers use).
const YAHOO_SUFFIX = { XTSE: ".TO", XTSX: ".V", NEOE: ".NE", XCNQ: ".CN", XLON: ".L", XETR: ".DE", XFRA: ".F", XPAR: ".PA", XAMS: ".AS", XMIL: ".MI", XSWX: ".SW", XTKS: ".T", XSHG: ".SS", XSHE: ".SZ", XHKG: ".HK", XASX: ".AX", XBOM: ".BO" };
// Exchange codes a provider may return for a venue (Marketstack lists Tokyo as XJPX).
export const VENUE_ALIASES = { XTSE: ["XTSE"], XTSX: ["XTSX", "XTNX"], NEOE: ["NEOE", "XNEO", "NEOC", "NEON"], XCNQ: ["XCNQ"], XLON: ["XLON"], XETR: ["XETR", "XETRA"], XFRA: ["XFRA"], XPAR: ["XPAR"], XAMS: ["XAMS"], XMIL: ["XMIL"], XSWX: ["XSWX"], XTKS: ["XTKS", "XJPX"], XSHG: ["XSHG"], XSHE: ["XSHE"], XHKG: ["XHKG"], XASX: ["XASX"], XBOM: ["XBOM"] };
const US_EXCHANGE_CODES = ["XNYS", "XNAS", "ARCX", "BATS", "XASE", "IEXG", "XNGS", "XNMS", "XNCM", "XCBO", "EDGX", "AMEX", "NYSE", "NASDAQ"];
export const venueMatches = (expectedMic, returned) => {
  const code = String(returned || "").toUpperCase();
  if (!code) return false;
  if (isUsVenue(expectedMic)) return US_EXCHANGE_CODES.includes(code);
  return (VENUE_ALIASES[expectedMic] || [expectedMic]).includes(code);
};

const AV_SUFFIX = { XTSE: ".TRT", XTSX: ".TRV", XLON: ".LON", XETR: ".DEX", XSHG: ".SHH", XSHE: ".SHZ", XBOM: ".BSE" };

export const PROVIDERS = Object.freeze({
  alphavantage: {
    id: "alphavantage",
    name: "Alpha Vantage",
    status: { browser: "enabled", desktop: "enabled" },
    keyHelpUrl: "https://www.alphavantage.co/support/#api-key",
    termsUrl: "https://www.alphavantage.co/terms_of_service/",
    keyPattern: /^[A-Za-z0-9]{8,64}$/,
    keyAuth: "apikey query parameter (Alpha Vantage's only method)",
    licence: "Personal, non-commercial use of your own key.",
    plans: [
      { id: "free", label: "Free: 25 requests per day", limits: { perDay: 25 }, pacing: { minSpacingMs: 1200, minGapAfterMs: 1100, jitterMs: 300 } },
      { id: "premium", label: "Premium: requests per minute of your plan", limits: { perMinute: 75 }, editable: "perMinute", pacing: { minGapAfterMs: 0 } },
    ],
    priceType: "latest_trading_day",
    priceLabel: "latest price for the trading day shown (end of day on free keys)",
    coverage: () => [...US_FAMILY, ...Object.keys(AV_SUFFIX)],
    symbolFor(identity) {
      if (!identity?.localSymbol) return null;
      if (isUsVenue(identity.mic)) return identity.localSymbol;
      if (/\.U$/.test(identity.localSymbol)) return null; // TSX USD units: no documented form
      return AV_SUFFIX[identity.mic] ? identity.localSymbol + AV_SUFFIX[identity.mic] : null;
    },
    // A curated identity gives the currency; otherwise SYMBOL_SEARCH confirms it (one
    // search, or two when the suffixed search lists nothing and the stem is searched).
    requestCost: (identity, { listingCached = false } = {}) => (identity.currencyEvidence === "curated_reference" || listingCached ? 1 : 2),
    requestCostMax: (identity, { listingCached = false } = {}) => (identity.currencyEvidence === "curated_reference" || listingCached ? 1 : 3),
    gaps: {},
  },
  marketstack: {
    id: "marketstack",
    name: "Marketstack",
    status: { browser: "enabled", desktop: "enabled" },
    keyHelpUrl: "https://marketstack.com/signup/free",
    termsUrl: "https://marketstack.com/terms",
    keyPattern: /^[A-Za-z0-9]{16,64}$/,
    keyAuth: "access_key query parameter (Marketstack's only method)",
    licence: "Free plan: non-commercial testing and evaluation (APILayer agreement §16(c)); paid plans for ongoing use.",
    notice: "Marketstack counts every symbol as one request, and its free plan allows 100 requests per month. Marketstack advises keeping keys out of public code: your key stays in this browser and is sent only to Marketstack.",
    plans: [
      { id: "free", label: "Free: 100 requests per month", limits: { perMonth: 100 }, pacing: { minSpacingMs: 250 } },
      { id: "basic", label: "Basic: 10,000 requests per month", limits: { perMonth: 10000 }, pacing: { minSpacingMs: 250 } },
      { id: "custom", label: "Other paid plan: monthly requests of your plan", limits: { perMonth: 100000 }, editable: "perMonth", pacing: { minSpacingMs: 250 } },
    ],
    priceType: "eod_close",
    priceLabel: "end-of-day close (unadjusted)",
    coverage: () => [...US_FAMILY, ...Object.keys(YAHOO_SUFFIX)],
    symbolFor(identity) {
      if (!identity?.localSymbol) return null;
      if (isUsVenue(identity.mic)) return identity.localSymbol.replace(/\./g, "-"); // "BRK-B"
      if (/\.U$/.test(identity.localSymbol)) return null;
      return YAHOO_SUFFIX[identity.mic] ? identity.localSymbol + YAHOO_SUFFIX[identity.mic] : null;
    },
    requestCost: () => 1,
    // Known not to be in Marketstack's end-of-day ticker list (checked 2026-11-03).
    gaps: { "NEOE:YNVD": "not in Marketstack's end-of-day ticker list (checked 2026-11-03)" },
  },
  finnhub: {
    id: "finnhub",
    name: "Finnhub",
    status: { browser: "enabled", desktop: "enabled" },
    keyHelpUrl: "https://finnhub.io/register",
    termsUrl: "https://finnhub.io/terms-of-service",
    keyPattern: /^[A-Za-z0-9]{16,64}$/,
    keyAuth: "token query parameter in the browser (Finnhub's CORS does not allow its header form); X-Finnhub-Token header on the desktop",
    licence: "Strictly personal use of your own key; no sharing or redistribution.",
    plans: [
      { id: "free", label: "Free: 60 calls per minute, US listings", limits: { perMinute: 60 }, pacing: { perMinute: 55, minSpacingMs: 50 } },
      { id: "paid", label: "Paid: calls per minute of your plan", limits: { perMinute: 150 }, editable: "perMinute", pacing: { minSpacingMs: 50 }, international: "optional" },
    ],
    priceType: "last_trade",
    priceLabel: "last price (real-time for US listings during market hours)",
    coverage: plan => (plan?.international ? [...US_FAMILY, ...Object.keys(YAHOO_SUFFIX)] : [...US_FAMILY]),
    symbolFor(identity, plan) {
      if (!identity?.localSymbol) return null;
      if (isUsVenue(identity.mic)) return identity.localSymbol;
      // International quotes carry no currency: only curated identities qualify.
      if (!plan?.international || identity.currencyEvidence !== "curated_reference") return null;
      return YAHOO_SUFFIX[identity.mic] ? identity.localSymbol + YAHOO_SUFFIX[identity.mic] : null;
    },
    requestCost: () => 1,
    gaps: {},
  },
  alpaca: {
    id: "alpaca",
    name: "Alpaca",
    status: { browser: "unsupported", desktop: "enabled" },
    unsupportedReason: "Alpaca keys are brokerage-account credentials (key ID and secret) that can also place trades. This website does not keep trading credentials in browser storage; Alpaca is available in the desktop apps.",
    keyHelpUrl: "https://app.alpaca.markets/",
    termsUrl: "https://alpaca.markets/disclosures",
    keyAuth: "APCA-API-KEY-ID and APCA-API-SECRET-KEY headers",
    licence: "Personal use only; no redistribution.",
    plans: [
      { id: "basic", label: "Basic: 200 calls per minute, IEX exchange only", limits: { perMinute: 200 }, pacing: { perMinute: 190 }, feed: "iex" },
      { id: "algo-plus", label: "Algo Trader Plus: all US exchanges (SIP)", limits: { perMinute: 10000 }, pacing: { minSpacingMs: 10 }, feed: "sip" },
    ],
    priceType: "last_trade",
    priceLabel: "last trade (IEX only on the Basic plan; not the consolidated US price)",
    coverage: () => [...US_FAMILY],
    symbolFor: identity => (identity?.localSymbol && isUsVenue(identity.mic) ? identity.localSymbol : null),
    requestCost: () => 1,
    gaps: {},
  },
  massive: {
    id: "massive",
    name: "Massive",
    status: { browser: "deferred", desktop: "deferred" },
    unsupportedReason: "Massive's Market Data Terms (§1) say its data may not be used to build an application for end users other than the account holder. This integration stays off until the site owner has written confirmation from Massive.",
    keyHelpUrl: "https://massive.com/dashboard/keys",
    termsUrl: "https://massive.com/legal/market-data-terms",
    keyPattern: /^[A-Za-z0-9_-]{16,64}$/,
    keyAuth: "Authorization: Bearer header",
    licence: "Personal, non-business use; no application for other end users (Market Data Terms §1).",
    plans: [
      { id: "basic", label: "Stocks Basic: 5 calls per minute, end of day", limits: { perMinute: 5 }, pacing: { perMinute: 5, minSpacingMs: 250 } },
      { id: "starter", label: "Stocks Starter or higher", limits: { perMinute: 100 }, editable: "perMinute", pacing: { minSpacingMs: 100 } },
    ],
    priceType: "previous_close",
    priceLabel: "previous session close (unadjusted)",
    coverage: () => [...US_FAMILY],
    symbolFor: identity => (identity?.localSymbol && isUsVenue(identity.mic) ? identity.localSymbol : null),
    requestCost: () => 1,
    gaps: {},
  },
});

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const providerAvailable = (id, platform = "browser") => PROVIDERS[id]?.status[platform] === "enabled";
export const providersFor = (platform = "browser") => PROVIDER_IDS.filter(id => providerAvailable(id, platform));

export function planOf(id, planId, overrides = {}) {
  const provider = PROVIDERS[id];
  const plan = provider.plans.find(p => p.id === planId) || provider.plans[0];
  const limits = { ...plan.limits };
  if (plan.editable && Number.isFinite(Number(overrides.limit)) && Number(overrides.limit) > 0) limits[plan.editable] = Math.floor(Number(overrides.limit));
  const pacing = { ...plan.pacing };
  if (plan.editable === "perMinute") { pacing.perMinute = Math.max(1, Math.floor(limits.perMinute * 0.95)); pacing.minSpacingMs = Math.max(pacing.minSpacingMs || 0, Math.ceil(60000 / limits.perMinute)); }
  return { ...plan, limits, pacing, international: plan.international === "optional" ? Boolean(overrides.international) : Boolean(plan.international) };
}

// Why a provider cannot price an instrument, or null if it can try.
export function coverageGap(id, identity, plan) {
  const provider = PROVIDERS[id];
  if (!identity || identity.status !== "resolved") return "the ticker is not resolved";
  if (provider.gaps[identity.canonicalId]) return provider.gaps[identity.canonicalId];
  if (!provider.coverage(plan).includes(identity.mic)) return `${provider.name} does not cover ${identity.venueName || identity.mic}${plan?.id === "free" || !plan ? " on the free plan" : ""}`;
  if (!provider.symbolFor(identity, plan)) return `${provider.name} has no documented symbol for this listing`;
  return null;
}
