// The sample portfolio: fourteen ordinary holdings in one list. The first ten are the
// owner's Questrade holdings (symbols, shares and order), with their earlier targets
// scaled from 100% to 90%; the last four are international listings (Tokyo in JPY,
// Xetra in EUR, London quoted in pence, Shanghai in CNY) with one share and a 2.5%
// target each, so they are priced, valued and planned exactly like the others.
// Targets total exactly 100.0%.
//
// There are NO prices here: every price comes from a market-data provider when the
// user asks for it, or from a price the user deliberately enters.
//
// `sampleTag` marks the four international examples so the optional "Remove
// international examples" button can remove them while they are still exactly as
// loaded. It is provenance only: it changes no pricing, valuation or plan rule.
//
// The same data is in the desktop app (portfolio_rebalancer/sample.py) and the two
// are checked against each other by _tools/tests/test_market_data_parity.py
// (test_sample_portfolio_identical).

export const INTERNATIONAL_EXAMPLE_TAG = "international-example";

export const SAMPLE_PORTFOLIO = Object.freeze({
  schema: "rb.sample-portfolio.v2",
  reportingCurrency: "CAD",
  mode: "new_money",
  budget: 3000,
  rows: Object.freeze([
    { ticker: "VEQT.TO", shares: 305, targetWeight: 63, accountType: "" },
    { ticker: "CNQ.TO", shares: 48, targetWeight: 9, accountType: "" },
    { ticker: "XQQ.TO", shares: 27, targetWeight: 6.3, accountType: "" },
    { ticker: "HEWB.TO", shares: 14, targetWeight: 4.5, accountType: "" },
    { ticker: "AAPL", shares: 2, targetWeight: 1.8, accountType: "" },
    { ticker: "VFV.TO", shares: 8, targetWeight: 0.9, accountType: "" },
    { ticker: "SPCX", shares: 1, targetWeight: 0.9, accountType: "" },
    { ticker: "CBRS", shares: 4, targetWeight: 0.9, accountType: "" },
    { ticker: "YNVD.NE", shares: 4, targetWeight: 1.8, accountType: "" },
    { ticker: "VST", shares: 1, targetWeight: 0.9, accountType: "" },
    { ticker: "7203.T", shares: 1, targetWeight: 2.5, accountType: "", sampleTag: INTERNATIONAL_EXAMPLE_TAG },
    { ticker: "SAP.DE", shares: 1, targetWeight: 2.5, accountType: "", sampleTag: INTERNATIONAL_EXAMPLE_TAG },
    { ticker: "VOD.L", shares: 1, targetWeight: 2.5, accountType: "", sampleTag: INTERNATIONAL_EXAMPLE_TAG },
    { ticker: "600519.SS", shares: 1, targetWeight: 2.5, accountType: "", sampleTag: INTERNATIONAL_EXAMPLE_TAG },
  ].map(Object.freeze)),
});

// Target weights are summed in basis points (hundredths of a percent) so the total is
// exact: 63 + 9 + 6.3 + ... in binary floating point is not exactly 100.
export const targetTotalBasisPoints = rows => rows.reduce((sum, r) => sum + Math.round(Number(r.targetWeight) * 100), 0);

// A row still counts as a loaded international example only while the user has not
// changed it: same ticker, shares, target and account as loaded, and no price the
// user supplied. A matching security the user added themselves has no sampleTag.
export function isUnchangedInternationalExample(row) {
  if (row?.sampleTag !== INTERNATIONAL_EXAMPLE_TAG) return false;
  const original = SAMPLE_PORTFOLIO.rows.find(r => r.sampleTag === INTERNATIONAL_EXAMPLE_TAG && r.ticker === row.sampleTicker);
  if (!original) return false;
  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
  return same(row.ticker, original.ticker) && same(row.shares, original.shares) && same(row.targetWeight, original.targetWeight)
    && same(row.accountType, original.accountType) && !row.manual;
}
