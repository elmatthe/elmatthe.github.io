# CPI-Webscraper 0.4.0

Windows desktop GUI tool for downloading Canadian and US economic data into an existing Excel model, with optional CSV export. Version 0.4.0 (2026-11-03) merges downloads into the existing history, removes S&P 500 values and local metadata from the bundled workbook, and runs downloads in the background with progress and Cancel; see `md-instructions/Changelog.md`.

## Setup and use

1. Keep the project folder together and double-click `Setup_and_Run-cpi-webscraper.bat`.
2. Setup finds stable Python 3.11–3.14, or offers a user-scope Python installation if needed. It repairs the private `.venv`, reconciles exact dependencies, validates configuration, and launches the GUI. Healthy repeat launches do not run pip.
3. Use **desktop Microsoft Excel for Windows**. Close the target workbook before downloading. Both `.xlsx` and `.xlsm` are supported.
4. Choose a single month or a date range, choose your workbook, optionally select a `.csv` destination, and enter your [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html). Tick **Remember on this computer** to save the key in `config.toml` (plain text); untick it to remove a saved key.
5. Click **Download & Write to Excel**. All required data is collected and validated before Excel opens; progress is shown and **Cancel** stops before the next request. A source failure stops the write. A rejected FRED key (HTTP 400/401/403) is not retried and is reported as such; Statistics Canada's overnight update window (HTTP 409) and rate limits (429) are retried briefly, then explained.
6. **Recalculate in Excel:** open the workbook, press Ctrl+Alt+F9 and save. The tool does not recalculate the model sheets (see Workbook safety).

Full history starts at January 1913. Earlier starts are clamped; a single month before 1913 becomes January 1913. A range ending before January 1913 is rejected. Dates stay on the **first day of each month**, including series reduced to a last-valid daily observation. Current months may be incomplete or unreleased. An end after the current month is moved back to the current month (no requests for months that cannot exist yet). For the current, unfinished month the end-of-month columns M/N/O (DFF, SP500, T10Y2Y) are left blank until the month ends.

The supplied `files/CPI.xlsx` is the **public copy** of the reference model: S&P 500 values (column N), every saved formula/spill/chart result that could be derived from them, the local file path, the Office add-in reference, printer settings and author names were removed with `_tools/cpi_public_workbook.py` in the website repository; formulas, charts, styles and sheets are unchanged and Excel recalculates everything when the file is first opened. Use a disposable copy for development and acceptance testing.

## Configuration

The launcher creates root `config.toml` from `scripts/config-default.toml`. It holds:

- `[workbook]`: `sheet_name`, which must already exist in your workbook.
- `[fred]`: `api_key`, blank until entered or migrated.
- `[output]`: `columns`, an ordered list of `{ id, header }` entries.
- `[sp500_history]`: `add_missing_data`, a strict boolean; it must be `false` (the default; an absent section also means `false`). The earlier Yahoo Finance backfill is no longer offered and `true` stops with an explanation.

**Root config.toml contains your private key and is gitignored. Do not share it.** The committed default always has a blank key. On first creation, a usable legacy `files/config.json` key is migrated silently; the legacy file is retained. Existing root config always takes precedence. Invalid config is preserved and blocks downloads.

You may rename headers and reorder columns. Keep every supported ID exactly once. Headers must be non-empty literal labels, without a leading `=`, `+`, `-`, or `@`. Do not edit IDs or add undocumented settings. After a successful download, the GUI saves only the API-key setting and preserves your comments and schema. If a custom TOML layout prevents safe persistence, save the key manually in `[fred]`.

**The supplied model directly references fixed A–S columns on `CPI_Downloader`.** A–O retain their meanings; P/Q contain 10-year/2-year Treasury monthly averages; R/S contain headline/core PCE. A custom order or target sheet requires a workbook with matching downstream formulas. The application never renames sheets or adjusts formulas for you. Prepare any desired date/number formats yourself; the writer preserves existing formats.

## Workbook safety

Production writing uses a private Excel COM instance through pywin32. It checks for an existing, writable target sheet, replaces **contents only** within the owned A:S rectangle, assigns all headers/data in bulk, saves and closes. It never deletes/inserts rows, recreates sheets, or changes column widths, row heights, formulas, named ranges, VBA, charts or tables.

**Downloads are merged by default:** the downloaded months replace those months in the raw sheet and every other month already there is kept, so a single-month update no longer clears the history (FRED's S&P 500 window rolls forward, so cleared months could not be downloaded again). Rows with values but no valid date in column A, or a repeated month, stop the write with a message. **Replace all rows** (with a confirmation) makes the sheet hold exactly the downloaded months, as before 0.4.0. The undocumented OneDrive `/pause` and `/resume` calls were removed.

Worksheet calculation is temporarily suppressed in the private Excel session so dynamic-array spills cannot modify model cells or formatting during the save (Decision 004). Workbook calculation mode is preserved. **As a result the saved model sheets still show results computed from the previous data until Excel recalculates:** press Ctrl+Alt+F9 in desktop Excel and save after a download. Whether Excel recalculates by itself on reopening has not been verified (it needs Windows and Excel). Macros, events and external-link updates are disabled during automation. Read-only/locked/protected targets, raw-area formulas and merged cells fail clearly.

CSV uses the very same configured columns and dataset, with `YYYY-MM-DD` dates. CSV failure is reported separately from an already completed Excel write; source collection is transactional, but Excel and CSV are separate files.

## Exact data mapping

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

FRED monthly series are used as published. DFF, SP500 and T10Y2Y use the latest valid daily observation in each calendar month. **Column M is the effective federal funds rate at EOP**, not a target-range bound. No interpolation, invented history or proxy substitution is used. Optional Yahoo backfill is described below. Pre-series history remains blank.

## S&P 500 history

Column N is FRED SP500, downloaded with your own key; FRED publishes only about the last ten years, and S&P Dow Jones Indices restricts reproduction of the data, so the bundled workbook contains none. The optional Yahoo Finance `^GSPC` backfill of earlier versions is no longer available in the app: Yahoo does not permit automated collection, and S&P 500 history may not be redistributed without permission. Its isolated, tested code remains in `data_sources.py` pending an owner decision.

## Sources and usage rights

**This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.** See [FRED API documentation](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).

Canadian series are sourced from Statistics Canada through its supported [Web Data Service](https://www.statcan.gc.ca/en/developers/wds/user-guide); Statistics Canada is the source of the original data. This application does not imply Statistics Canada endorsement. Statistics Canada data is used under the [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence).

Column N retains the exact **S&P 500 price index, last trading-day close** meaning, using FRED SP500. It has only approximately ten years of history and third-party restrictions. [FRED's SP500 series notice](https://fred.stlouisfed.org/series/SP500) identifies permission requirements. **Confirm organizational rights before production business use.** FRED remains authoritative. Optional Yahoo history extends coverage for unofficial analysis only; it does not confer professional historical-data usage rights. No yfinance, adjusted-close substitution, CSV/crumb authentication or alternate benchmark is used.

## Developer verification

Stable entry point: `scripts/cpi_webscraper.py`. Focused modules: `bootstrap.py`, `cpi_config.py`, `data_sources.py`, and `workbook_io.py`.

```powershell
.venv\Scripts\python.exe scripts\verify.py
cmd /c Setup_and_Run-cpi-webscraper.bat --check-only
$env:CPI_EXCEL_REGRESSION = '1'
.venv\Scripts\python.exe -m pytest files/tests/test_workbook_regression.py -q -p no:cacheprovider -p no:faulthandler
Remove-Item Env:CPI_EXCEL_REGRESSION
```

Normal tests are offline and do not launch Excel. The opt-in COM regression only writes a repository-contained copy, compares array formula definitions and model structure/formatting, and verifies the canonical hash. Optional live economic-source verification: `.venv\Scripts\python.exe files\tests\live_sources.py`; it deliberately excludes S&P. Optional real bootstrap provisioning/repair proof: `py -3.14 files/tests/bootstrap_proof.py` (downloads packages into a disposable fixture). Runtime/test scratch stays under `files/` and is ignored.

## Audit and usage notes

The revised canonical workbook resolves all 38 recession-boundary corrections. The 2026-09-15 audit compared all 1,364 published AD months with USREC with no mismatches; September 2026 is provisionally 0 pending publication. The canonical raw S&P column matches FRED-only data exactly. The annotation in US Data BC1358 is intentionally retained with explicit user approval. See Handoff for verification and integration details.

The release audit includes the offline suite, actual launcher health check, live FRED comparison and disposable-copy Excel preservation. The user exercised FALSE mode and reported successful TRUE-mode testing. Confirm S&P usage rights before professional production use. Other supported Python minors, fresh winget provisioning and VBA-bearing workbooks remain platform checks beyond the tested Windows/Python 3.14.2/.xlsx setup. No tag or GitHub Release was created as part of this checkpoint.

If setup fails, check its specific message, `config.toml` syntax against the template, network access and file permissions. For workbook failures, close the target workbook, ensure the configured sheet exists and is unprotected, and retry on a copy.

## Optional Office Script

`files/office-scripts/Copy-Paste-Refresh.ts` is a user-invoked Excel Office Script. It copies the configured worksheet's used range over itself and rebuilds workbook calculations; the default target is `CPI_Downloader`. Import it into Excel's Automate editor to use it. It is separate from the downloader and is not run by the Python launcher. Validate button integration on a disposable workbook in the Office Scripts host before using it there.
