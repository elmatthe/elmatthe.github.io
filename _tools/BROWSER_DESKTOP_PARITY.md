# Browser and desktop parity (2026-11-03)

What each version of the four tools does, where they differ, and why. "Equivalent" means
the same rules and results, checked by an automated test named in the last column.
Differences are deliberate and listed; none is hidden by a passing test count. Windows,
macOS and Excel behaviour is **not** verified by these Linux tests (see the last section).

## Providers (Rebalancer and Stock)

| Provider | Web | Desktop | Notes |
|---|---|---|---|
| Alpha Vantage | Quotes (Rebalancer), daily/weekly history (Stock) | Quotes and history | User's own key; burst vs daily notices classified (fixtures `alphavantage-notices.json`). |
| Marketstack | Quotes (Rebalancer) | Quotes and daily history (Stock) | User's own key; free plan 100 requests/month for testing and evaluation; YNVD (Cboe Canada) is a recorded coverage gap. The web Stock page does not offer Marketstack history yet. |
| Finnhub | Quotes (Rebalancer, US; international on paid plans) | Quotes | User's own key. |
| Alpaca | **Unsupported** | Quotes and history (US, IEX feed on Basic) | The key secret is a trading credential: never in a web page. |
| Massive | Deferred | Deferred | Needs the owner's written confirmation of Market Data Terms §1 (see `PROVIDER_MATRIX.md`). |
| Automatic (route by market) | Yes | Yes | A routing mode, not a provider; same `ROUTES` table (`catalog.js` / `catalog.py`, parity-tested). |

Never more than five providers; keys stay in the browser (session storage unless
"remember") or on the desktop (`keys.json` only when remembered, permissions 600). No
shared or owner key, no relay, no scraping. Quotes are end-of-day or latest-trading-day
values, never presented as real time.

## Portfolio Rebalancer

| Capability | Web | Desktop | Verdict / test |
|---|---|---|---|
| Engine (modes, invariants, hold band, weights) | ✔ | ✔ | Equivalent — `test_engine_parity.py`, `test_financial_reference.py` |
| Valuation readiness gate, freshness, user-supplied prices | ✔ | ✔ | Equivalent — `test_market_data_parity.py` (`valuation`, `freshness`) |
| Whole-share option, cash left | ✔ | ✔ | Equivalent — `test_market_data_parity.py` (`whole`) |
| Instrument identity and routing | ✔ | ✔ | Equivalent — `test_market_data_parity.py` (`resolve`, `route`, `catalog`) |
| Sample 10 + 4 rows, no prices | ✔ | ✔ | Identical — `test_sample_portfolio_identical` |
| Provider notice and error classification | ✔ | ✔ | Equivalent — shared fixtures `fixtures/providers/*.json` |
| Automatic price on ticker commit | ✔ (Enter/Tab/blur) | ✔ (Enter/Tab, or *Get prices*) | Equivalent behaviour |
| FX | BoC daily (ECB fallback), editable | BoC daily, editable | Equivalent rates; the web also falls back to ECB |
| CSV / Excel export with provenance | ✔ | ✔ | Equivalent columns (`rebalancer.test.js`, `test_model.py`) |
| CSV import of holdings | ✔ | — | Web only |

## Stock Comparison & Analytics

| Capability | Web | Desktop | Verdict |
|---|---|---|---|
| Return type | Log returns | Simple or log (setting) | Different by design; documented |
| Correlation | Exact shared intervals, ≥ 3, variance guard | Shared dates, ≥ 3, variance guard | Equivalent rule |
| Split-like moves on unadjusted closes | Excluded with reason | No detector: uses the provider's adjusted close where one exists (Marketstack, Alpaca, Alpha Vantage weekly); Alpha Vantage daily windows are as traded | Different; desktop limitation documented |
| Short-sample caveat (< 182 days), 1-day horizon | ≈ marks, no 1D annualization | — | Web only |
| Calendar alignment | Per-series returns | Per-series returns (fixed in 0.5.0) | Equivalent |
| FX normalization | BoC (ECB fallback) | BoC, ≤ 7-day-old fixing, no back-fill | Equivalent principle |
| Offline / demo | CSV import, synthetic demo | Offline CSV folder | Comparable |
| Exports | XLSX/CSV/JSON | Excel (Prices, Returns, Settings), CSV, PNG charts | Comparable |

## Monte Carlo Retirement Simulator

| Capability | Web | Desktop | Verdict / test |
|---|---|---|---|
| Model step and percentiles | ✔ | ✔ | Equivalent to ≤ 2.2e-16 with shared draws — `test_monte_carlo_browser_matches_desktop` |
| Seeded generator | mulberry32 + Box–Muller | Same (port in `rng.py`) | Same failed paths and draws; percentiles ≤ 1e-9 relative (observed ~1e-15) — `test_monte_carlo_same_seed_gives_same_results_in_both_apps` |
| Spending basis (retirement-year default / today's) | ✔ | ✔ | Bit-identical conversion — `test_monte_carlo_warnings_conversion_and_growth_match_desktop` |
| Parsing rules and messages | ✔ | ✔ | 18/18 probes identical — `test_monte_carlo_text_parsing_matches_desktop_on_all_18_probes` |
| Assumption warnings, kept after "Done" | ✔ | ✔ | Identical text (same test) |
| Real-dollar values | Switchable view and CSV | Excel percentiles and CSV | Equivalent values; desktop chart is nominal |
| Export metadata (seed, generator, engine version, model, warnings) | CSV | Excel and CSV (same CSV layout) | Equivalent |
| Writing into an existing workbook | n/a | Detects content openpyxl would drop and offers a new workbook | Desktop only |
| Speed (10,000 paths × 55 years) | ~0.2 s, main thread | ~0.4 s, worker thread | Comparable |

## CPI Web Scraper

Desktop only (needs desktop Excel on Windows). A browser could read the five Statistics
Canada series (CORS `*`, verified in the audit), but FRED blocks browser requests, browser
spreadsheet libraries cannot recalculate or preserve this model's charts and dynamic
arrays, and S&P 500 history may not be redistributed. A values-only browser data pack is
feasible (audit Appendix F.6) but **not built in this release**.

## Not verified here (owner acceptance)

- Windows and macOS desktop windows at 125% and 150% display scaling (DPI awareness is
  enabled; Linux Xvfb tests check layout at 1366×768 only).
- Desktop Excel: opening the scrubbed `CPI.xlsx` (recalculation on open, no repair
  prompt), the CPI COM write and merge on a real workbook, and the Monte Carlo/Rebalancer
  workbooks in Excel.
- Real provider responses with real keys (every automated test uses mocked responses).
- Browsers other than Chromium.
