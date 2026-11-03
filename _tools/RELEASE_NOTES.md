# Release notes: web tools on /projects/

## 2026-11-03 (latest): free market-data source prepared, switched off

Nothing below is investment advice. No calculation, sample or desktop app changed.

### Portfolio Rebalancer and Stock Comparison (web)
- **A free source that needs no key is built in, but not switched on.** Both pages can use
  Yahoo Finance chart data through this site's own small Cloudflare Worker
  (`_services/market-data-gateway`). It stays off until written permission for automated
  retrieval and public redistribution of that data is on record: Yahoo's endpoint is
  unofficial and its terms restrict both. The live site points at no gateway, so both pages
  now say "Free source (no key): not available. This site's market-data gateway has not been
  set up" and everything else works as before.
- When it is switched on: with no key saved it is the default (Rebalancer *Automatic*, Stock
  *Free source*); saved keys keep precedence; *Free source only* can be chosen; falling back
  to it after a key fails stays opt-in and the key's error (for example a daily limit)
  remains visible on the row, in the status, in the plan and in exports. Prices are labelled
  "Yahoo Finance (free source)", "latest regular-session price (may be delayed)", with the
  trading date, retrieval time and the age of any saved copy; never real-time. London
  prices in pence are converted to pounds; every answer must match the listing and
  currency asked for, or it is not used.
- Stock Comparison: the free source gives daily prices for every horizon, with *Close*
  (split-adjusted, dividends excluded) and *Adjusted close* (also distributions) kept
  apart; the CSV exports and the workbook now show the source of every series.
- Only ticker symbols (and a period for history) would be sent; never holdings, quantities,
  targets or accounts.

## 2026-11-03 (later): unified Rebalancer sample, CPI web app

Owner decisions 1A–4A. Nothing below is investment advice.

### Portfolio Rebalancer (web; desktop 1.3.0)
- **One list for every market.** The sample is fourteen ordinary holdings with targets
  totalling exactly 100%: the ten Questrade holdings with their targets scaled to 90%
  (63 / 9 / 6.3 / 4.5 / 1.8 / 0.9 / 0.9 / 0.9 / 1.8 / 0.9), then one share each of 7203.T
  (JPY), SAP.DE (EUR), VOD.L (quoted in pence, converted to pounds) and 600519.SS (CNY) at
  2.5% each. The separate "International currency tests" group and its *Price test rows*
  button are gone: every holding uses the same row, *Get prices*, quota checks, valuation
  gate, plan and exports.
- The sample uses **YNVD.NE**; YNVD.TO (as Questrade shows it) is still accepted and is the
  same Cboe Canada instrument. Neither is ever priced as a TSX listing.
- *Get prices* identifies typed tickers first, estimates requests per provider with the
  allowance they use, names listings outside Canada and the US and the holdings no saved
  source covers before any request, shows progress, and afterwards names each holding
  still without a usable price and why. The plan stays withheld until each has a verified
  price or one you supply.
- Optional *Remove international examples* removes the four sample rows only while they
  are exactly as loaded; edited rows and the same securities you added stay.
- A user-supplied price refuses minor-unit codes such as GBX (choose GBP and "pence");
  a price in a currency not loaded yet loads its official rate.

### CPI Web Scraper (new web app; desktop 0.4.0 unchanged)
- The project page now has a **working browser app**: single month or date range back to
  1913, the five Statistics Canada series fetched directly (no key), the thirteen FRED
  series with your own FRED key through a small data gateway, results twelve months per
  page in four groups (Canada, US Inflation, Rates, Other) with no sideways scrolling, and
  **Download CSV** with the exact nineteen A–S columns of the CPI_Downloader sheet for
  every requested month — byte-identical to the desktop tool's CSV for the same data.
- Without a key the page fetches the Canadian data and leaves the US columns blank, saying
  why; every blank cell has a reason (not published, before the series, month not over,
  unavailable, restricted, …); nothing is ever filled in or set to zero.
- **The data gateway is not deployed yet** (it needs the owner's Cloudflare account), so the
  live page currently works in Canadian-only mode and says so. Writing into an existing
  Excel workbook remains a desktop feature.

## 2026-11-03: four-tool financial suite (implementation of the independent-review plan)

Gate-by-gate evidence is in the pull request. Nothing below is investment advice.

### Portfolio Rebalancer (web; desktop 1.2.0)
- **A plan is never calculated from a missing, invented, mismatched or unaccepted stale
  price.** Until every holding that matters has a verified price (or one you supplied and
  that is labelled as yours), the plan is withheld and the reasons are grouped by cause.
- **Prices come automatically**: you enter ticker, shares, target % and (optionally) the
  account; the listing is identified with no request, and the price is fetched when you
  leave the ticker field. Changing a ticker clears its price at once; a late answer for the
  old ticker is ignored.
- **Choose your source** (Alpha Vantage, Marketstack, Finnhub; Alpaca on the desktop) or
  *Automatic (route by market)*, with your own free or paid key. The request estimate and
  each provider's allowance are shown; paid plans are not assumed unlimited.
- **Fixed:** an Alpha Vantage "please spread out your requests" notice was taken for the
  daily limit and blocked the key until midnight. Burst notices are now retried after a
  few seconds; only the provider's daily-limit wording is recorded, with *Check again*.
- Every price shows provider, trading date, currency, unit and price basis; stale prices
  (1–3 missed sessions) must be accepted; older ones are refused.
- **Sample portfolio** = the exact ten Questrade holdings (shares and targets), New Money,
  CAD, budget 3,000, with **no prices**, plus four 0/0 currency test rows (7203.T, SAP.DE,
  VOD.L, 600519.SS) removable in one click. `YNVD.TO` stays as Questrade shows it and is
  identified as the Cboe Canada ETF; free sources do not cover it, so it needs *My price*.
- Whole-share option with cash left; Rebalance with no sells no longer shows unfunded buys.
- New layout: no sideways scrolling from 360 to 1920 px and at 125%/150% zoom; values at
  least 14 px.

### Stock Comparison & Analytics (web; desktop 0.5.0)
- Web: split-like jumps in unadjusted prices exclude the series with an explanation
  instead of showing a false crash; short samples (< 6 months) are marked ≈ and the 1-day
  horizon has no annualized figures; constant series give "not available" instead of
  fictitious correlations; the request estimate is shown; responsive tables.
- Desktop: Yahoo Finance (`yfinance`) removed; history from Alpha Vantage, Marketstack or
  Alpaca with your own key, or CSV. Per-ticker returns (holidays elsewhere no longer drop
  returns), cumulative chart equals total return, only completed weekly/monthly bars, Bank
  of Canada FX without look-ahead, unconvertible series left out with a warning,
  duplicate/≤ 0 CSV prices rejected, exports with Prices, Returns and Settings.

### Monte Carlo Retirement Simulator (web; desktop 1.2.0)
- **New option: spending in today's dollars** (converted with inflation to the first year
  of retirement, amount shown). Retirement-year dollars remain the default, so earlier
  results are unchanged.
- Expected return labelled as an arithmetic mean, with the typical compound growth shown.
  Warnings for extreme volatility, returns below −100%, and 0.07 typed for 7%; they stay
  visible after the run. Editing an input marks results as stale.
- Desktop: seed field and the same random-number generator as the web, so a seed
  reproduces a web run; seed, generator, engine version, model and warnings in Excel and
  CSV; today's-dollar percentiles; "Initial withdrawal rate" (was "Safe Withdrawal Rate");
  safe handling of existing workbooks with pictures or charts; sample scenario fixed.
- Chart.js is now served by this site: the page works without any third-party host.

### CPI Web Scraper (desktop 0.4.0)
- The bundled workbook no longer contains S&P 500 values or saved results derived from
  them, nor local paths, add-in references, printer settings or author names.
- Downloads merge into the existing history (a single-month update no longer erases it);
  *Replace all rows* is an explicit, confirmed option.
- End month limited to the current month; the unfinished month's end-of-month values are
  left blank; clearer errors (rejected key, Statistics Canada maintenance window, rate
  limits); progress and Cancel; the FRED key is saved only if you tick *Remember*; the
  optional Yahoo backfill is no longer offered. After a download, recalculate in Excel
  (Ctrl+Alt+F9).

### Known limitations
- Provider integrations are tested against recorded and synthetic responses only; live
  checks with real keys are part of the owner's acceptance.
- Windows/macOS desktop windows, display scaling and Excel behaviour are not verified by
  the Linux CI.
- Massive is not offered (licence confirmation pending); Alpaca is desktop only.

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
