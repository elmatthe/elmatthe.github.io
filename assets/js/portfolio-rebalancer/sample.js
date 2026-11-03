// The sample portfolio: the owner's ten Questrade holdings exactly as the broker
// displays them (symbols, shares, targets and order), then four zero-share, zero-target
// rows that exercise JPY, EUR, GBP quoted in pence, and CNY. There are NO prices
// here: every price comes from a market-data provider when the user asks for it, or
// from a price the user deliberately enters.
//
// The same data is in the desktop app (portfolio_rebalancer/sample.py) and the two
// are checked against each other by _tools/tests/test_sample_portfolio.py.

export const SAMPLE_PORTFOLIO = Object.freeze({
  schema: "rb.sample-portfolio.v1",
  reportingCurrency: "CAD",
  mode: "new_money",
  budget: 3000,
  rows: Object.freeze([
    { ticker: "VEQT.TO", shares: 305, targetWeight: 70, accountType: "", group: "main" },
    { ticker: "CNQ.TO", shares: 48, targetWeight: 10, accountType: "", group: "main" },
    { ticker: "XQQ.TO", shares: 27, targetWeight: 7, accountType: "", group: "main" },
    { ticker: "HEWB.TO", shares: 14, targetWeight: 5, accountType: "", group: "main" },
    { ticker: "AAPL", shares: 2, targetWeight: 2, accountType: "", group: "main" },
    { ticker: "VFV.TO", shares: 8, targetWeight: 1, accountType: "", group: "main" },
    { ticker: "SPCX", shares: 1, targetWeight: 1, accountType: "", group: "main" },
    { ticker: "CBRS", shares: 4, targetWeight: 1, accountType: "", group: "main" },
    { ticker: "YNVD.TO", shares: 4, targetWeight: 2, accountType: "", group: "main" },
    { ticker: "VST", shares: 1, targetWeight: 1, accountType: "", group: "main" },
    { ticker: "7203.T", shares: 0, targetWeight: 0, accountType: "", group: "currency-tests" },
    { ticker: "SAP.DE", shares: 0, targetWeight: 0, accountType: "", group: "currency-tests" },
    { ticker: "VOD.L", shares: 0, targetWeight: 0, accountType: "", group: "currency-tests" },
    { ticker: "600519.SS", shares: 0, targetWeight: 0, accountType: "", group: "currency-tests" },
  ].map(Object.freeze)),
});

export const CURRENCY_TEST_GROUP = "currency-tests";
export const CURRENCY_TEST_LABEL = "International currency tests (0 shares, 0% target)";
