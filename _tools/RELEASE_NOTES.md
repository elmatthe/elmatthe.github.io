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

## 2026-11-02: independent-review remediation (R01–R06)

Findings from an independent review of the change above, and what was done. Each fix
has regression tests; see `_tools/MARKET_DATA.md` for the resulting behaviour.

- **R01 (High, confirmed): Alpha Vantage data was not isolated per API key.**
  - What happened:
    - After switching keys, the new key was shown the old key's request count and
      cached responses.
    - After removing the key, cached quotes were still served.
    - A request started with one key could be joined, and cached, after a switch.
  - Fix: everything fetched with a key (listings, quotes, history, misses, request
    count, in-flight requests) now lives under that key's own namespace.
    - Changing or removing the key aborts and discards the old key's work, and
      deletes its saved responses.
    - Re-saving the same key keeps everything.
    - The daily limit is remembered per key.
- **R02 (Medium, partly confirmed): reporting of frequency and price basis.** The
  arithmetic was already consistent. What changed:
  - The metadata and exports now state the price basis actually used, not the one
    requested.
  - Live results explain that the window decides daily-unadjusted vs weekly-adjusted
    data.
  - The workbook's regression column is named for the actual period ("Alpha (per
    week)").
  - Mixed bases make the "Best total return" ranking read "Not comparable".
  - Deterministic daily-vs-weekly tests document what must match exactly and what
    differs by convention (260 vs 252 periods).
- **R03 (Medium, confirmed): incomplete currency normalization.**
  - What happened: series that could not be converted stayed in their own currency
    inside a "normalized" comparison, with only a warning.
  - Fix: they are now left out and named with the reason. Currently left out:
    - unknown currency;
    - currencies neither central bank publishes;
    - series with too few prices covered by rates.
  - Prices more than 7 days after the latest rate are dropped, not converted with an
    old rate.
  - Each ticker's native currency, displayed currency and conversion source are in the
    table and every export.
  - In native mode, an unknown currency triggers the mixed-currency warning.
- **R04 (Medium/Low, confirmed): impossible CSV dates were accepted.** `2026-02-30` was
  silently read as 2 March. Imported and provider dates must now be real calendar
  days. Errors give the file name and line.
- **R05 (Low/Medium): key storage and transparency.**
  - A new key is kept for the current tab by default. "Remember on this device"
    keeps it until removed. A key saved by an earlier build is still used.
  - Both tools explain:
    - where the key is kept;
    - that it is sent only to Alpha Vantage in the request URL;
    - that scripts on the site can read browser storage;
    - how to remove it.
  - The only third-party script (Chart.js) is now pinned with Subresource Integrity.
- **R06 (Medium): no CI.** `.github/workflows/ci.yml` runs on pull requests to `main`.
  - It covers unit and reference tests, ZIP and launcher checks, a strict Jekyll build,
    the four browser suites with mocked providers, and the desktop tests on Linux.
  - It uses a read-only token, pinned actions and no secrets.
  - The CPI scraper's six Windows-only bootstrap tests are excluded on Linux by name.
