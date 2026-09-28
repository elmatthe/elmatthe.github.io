# CPI-Webscraper — Briefing

## Project and release scope

Version 0.3.0 is a Windows Python Desktop release candidate. It downloads five Statistics Canada CPI vectors and thirteen FRED series to an existing raw-data sheet through Microsoft Excel COM, with matching optional CSV. Stable entry point: `scripts/cpi_webscraper.py`. Python 3.11–3.14 and desktop Excel are required; current implementation validation used Python 3.14.2 and pywin32 312.

The thin batch launcher delegates environment reconciliation to `bootstrap.py`. Healthy launches check runtime, exact package versions and imports without pip; missing/broken venvs are rebuilt safely, stale dependencies reconciled, and damaged imports repaired. Config creation/migration/validation occurs before application launch. No admin installation or pywin32 post-install script is used.

Root `config.toml` contains the FRED key and is ignored; the committed blank-key template specifies sheet name and all nineteen stable IDs/headers in order. Legacy JSON is migration-only. Invalid existing config is preserved. Custom headers/order are supported, but custom sheet/order requires matching model formulas; the application never rewrites those formulas.

## Source map and verified depth

| Column / ID | Default header | Source | First month |
|---|---|---|---|
| A / `date` | Date | Monthly row key | 1913-01 |
| B / `ca_cpi_headline_nsa` | Headline CPI - Unadjusted CDN | StatCan 41690973 | 1914-01 |
| C / `ca_cpi_headline_sa` | Headline CPI - Seasonally Adjusted CDN | StatCan 41690914 | 1992-01 |
| D / `ca_cpi_core_nsa` | Core CPI - Unadjusted CDN | StatCan 41691233 | 1961-01 |
| E / `ca_cpi_core_sa` | Core CPI - Seasonally Adjusted CDN | StatCan 41690924 | 1992-01 |
| F / `ca_cpi_alberta_nsa` | Alberta CPI - Unadjusted CDN | StatCan 41692327 | 1978-09 |
| G / `us_cpi_headline_nsa` | Headline CPI - Unadjusted US | FRED CPIAUCNS | 1913-01 |
| H / `us_cpi_headline_sa` | Headline CPI - Seasonally Adjusted US | FRED CPIAUCSL | 1947-01 |
| I / `us_cpi_core_nsa` | Core CPI - Unadjusted US | FRED CPILFENS | 1957-01 |
| J / `us_cpi_core_sa` | Core CPI - Seasonally Adjusted US | FRED CPILFESL | 1957-01 |
| K / `us_unemployment_sa` | Unemployment Rate - Seasonally Adjusted US | FRED UNRATE | 1948-01 |
| L / `us_fed_funds_avg` | Monthly Effective Fed Fund Rate US | FRED FEDFUNDS | 1954-07 |
| M / `us_fed_funds_eom` | Monthly Fed Fund Rate - EOP US | FRED DFF | 1954-07 |
| N / `us_sp500_eom` | SP by month US | FRED SP500 | Rolling ~10 years; permission required |
| O / `us_10y2y_eom` | 10yr vs 2yr US | FRED T10Y2Y | 1976-06 |
| P / `us_treasury_10y_avg` | 10-Year Treasury Yield - Monthly Average US | FRED GS10 | 1953-04 |
| Q / `us_treasury_2y_avg` | 2-Year Treasury Yield - Monthly Average US | FRED GS2 | 1976-06 |
| R / `us_pce_sa` | PCE - Seasonally Adjusted US | FRED PCEPI | 1959-01 |
| S / `us_core_pce_sa` | Core PCE - Seasonally Adjusted US | FRED PCEPILFE | 1959-01 |

On 2026-09-14, bounded live checks over the full requested 1913-to-current interval verified the expected first month for all 17 authorized government/economic series. StatCan, CPI, unemployment, FEDFUNDS and Treasury averages reached 2026-08; PCE series reached 2026-07; DFF and T10Y2Y reached the partial month 2026-09. DFF EOP reaches 1954-07. Native GS10/GS2 monthly averages begin 1953-04/1976-06. No series is interpolated or replaced by a proxy. Monthly keys remain first-of-month.

## Workbook ownership

The writer owns cell contents only within configured raw-sheet A:S. It uses bulk Value2 assignment and ClearContents, disables events/macros/link updates, suppresses session worksheet calculations to preserve spilled cells, saves, closes and quits its private Excel instance. No other workbook cells/formulas/styles/structure are modified. Default A–O meanings are retained; P/Q contain Treasury averages and R/S headline/core PCE, matching the manually corrected model. `.xlsm` is handled by Excel without converting the format or replacing VBA. OneDrive is optional and best effort.

`files/CPI.xlsx` is read-only during implementation. Its approved SHA256 is `7df41a06452c854b3a4f5536b7b648b64d936513a999a3c2eaa12cddc250f8c1`. The user explicitly approved retaining the annotation in US Data BC1358. Disposable-copy regression covers the manually edited workbook’s modern array formulas across US Data, CDN Data and Data Visualizations, plus all cached model values, formatting, dimensions, charts, tables and named ranges.

## Licensing/manual gates

Column N remains FRED SP500: S&P 500 price index, last valid trading-day close. Its rolling ~ten-year history and third-party permission requirement remain unresolved for business use. Organizational usage-rights confirmation is a production approval gate. The initial release checks excluded S&P. The explicitly authorized 2026-09-15 follow-up verified optional Yahoo history against FRED; this provides unofficial historical coverage, not professionally licensed history. No yfinance or substitute benchmark is introduced.

This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis. Canadian data is attributed to Statistics Canada. See README for source notices, authoritative links, exact configuration semantics and verification commands; see Handoff for current Git/test state and remaining release gates.

## Optional Yahoo follow-up — 2026-09-15

`[sp500_history] add_missing_data = false` is the default, including when the section is missing. FALSE makes no supplemental requests and preserves FRED-only history. TRUE adds unofficial Yahoo Finance ^GSPC history using requests directly and raw daily Close, reduced to last valid trading-day values in America/New_York. FRED always wins overlap; no interpolation, forward-fill, proxy or manufactured pre-source history is used. Yahoo needs no key or extra dependency. Source failures/mismatch abort before Excel; no silent fallback.

The working daily request uses explicit period1/period2 and an identifying User-Agent. Actual earliest usable date: 1927-12-30; 1913–1927-11 stays blank. This is optional historical/predecessor index data for unofficial analysis, not licensed/professional FRED observations. History and availability can change. Live validation of 120 completed overlap months found maximum absolute difference 0.000234375 points (relative 5.33245e-8). Runtime checks up to six completed months with at least three required and an absolute 0.005-point tolerance, derived from FRED’s published cent precision. Boundaries are obtained dynamically from FRED responses.

The latest manually edited workbook resolves the 38 recession-boundary errors: all 1,364 published AD months now agree with USREC. September 2026 is provisionally 0 and is not yet published. Canonical raw S&P data exactly matches 121 FRED monthly EOP observations (2016-09 through 2026-09); no Yahoo history is pre-populated. US AI/AJ/AK and PCE references remain O/P/Q/R/S; CDN content/formulas remain unchanged. The application never updates AD or any model sheet. See Handoff for final audit evidence and integration state.

The latest user save adds chart date controls and relocates chart helpers. Independent comparison of 6,078 helper dates/values with the model sheets passed. User-supplied `files/office-scripts/Copy-Paste-Refresh.ts` is an optional manual Office Script, separate from Python runtime; mocked execution passed normal/missing/blank/zero-sheet cases. Native Office Scripts button integration remains a host-specific manual check.
