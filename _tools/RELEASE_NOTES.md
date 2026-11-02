# Release notes: web tools on /projects/

## 2026-11-02: market-data repair and audit

### Portfolio Rebalancer (web; desktop 1.1.1)
- **Exchange rates are official and visible.** Bank of Canada daily rates load when the page
  opens (ECB if it is unreachable). An exchange-rate table shows each rate's source and date,
  and you can type over any rate.
  - Previously, fixed approximations up to 7% off current rates were used without saying so.
  - If no official rate can be loaded, built-in rates dated 2026-10-30 are shown and the plan
    warns about them.
- **Every price shows where it came from:** entered by you, illustrative sample, fetched
  (with its trading date), cached, or a saved copy. Changing a fetched row's ticker or
  currency flags its price. The plan, CSV and Excel exports include the sources.
- **Live prices now use your own free Alpha Vantage key** (US and TSX/TSX-V). It is stored
  only in your browser. The public relays that fetched Yahoo Finance have been removed: they
  had stopped working and were not a permitted use of Yahoo's data.
- **A ticker whose listing currency the provider can't confirm keeps your typed price.**
  Rows without any price are listed by name; your inputs are never cleared.
- **The calculation engine is unchanged** (two modes, three invariants, 0.01% hold band). The
  plan now also reports duplicate holdings, the uninvested part of the budget, and that trade
  shares are fractional.

### Stock Comparison & Analytics (web; desktop 0.4.1)
- **New data sources:** your own CSV files (read in your browser; same format as the desktop
  app's offline mode), live prices with your own free Alpha Vantage key, or the offline demo.
- **Currency normalization uses official Bank of Canada rates** (ECB fallback) instead of
  Yahoo FX pairs.
- **Price basis is a visible choice:** adjusted close (total return) or close (price return),
  shown per ticker and in every export.
- **Weekly and monthly data are supported,** annualized with 52 or 12 periods. Live windows
  longer than about four months use weekly adjusted closes.
- **Data-quality warnings:**
  - unusually large one-period moves (possible unadjusted split);
  - mixed price bases;
  - mixed currencies;
  - prices dropped for lack of an exchange rate.
- **Not available live:** market indexes (^GSPC, ^GSPTSE) and Canadian fund codes. Use an ETF
  or import a CSV file.
- **Desktop 0.4.1:** London listings quoted in pence are now converted to pounds (they were
  100 times too large in levels and exports).

### Monte Carlo Retirement Simulator (web)
- **Runs are reproducible.** Each run shows its random seed, and entering the seed repeats the
  run exactly. The CSV export records the seed and the model conventions.
- **Inflation of −100%** no longer produces infinite "real dollar" values; they show as n/a.

### CPI Web Scraper
- No code changes. The project page now defines "core CPI" (all-items excluding food and
  energy), notes Statistics Canada's seasonal-adjustment revisions, and explains why there is
  no full web version (FRED requires a key and does not allow browser requests).
