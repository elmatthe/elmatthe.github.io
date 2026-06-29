# Stock Comparison & Analytics Tool - Briefing

## What This Project Does
This project is a Python desktop GUI for comparing multiple stocks, ETFs, indexes, and funds. It can fetch Yahoo Finance data or load offline CSV price data, compute performance and risk metrics, generate correlations and regressions, display charts in the GUI, save website-ready visuals, and export results to Excel or CSV.

## Tech Stack
- Language: Python 3.11+
- GUI: tkinter / ttk
- Key Libraries: pandas, numpy, scipy, matplotlib, yfinance, openpyxl, Pillow, pytest

## Architecture
- `scripts/main.py` is the Tkinter entry point.
- `scripts/data_sources.py` contains pluggable data providers for Yahoo Finance, Offline CSV, and future API-key sources.
- `scripts/analytics.py` contains pure analytics functions for alignment, returns, metrics, correlations, regressions, and diversification flags.
- `scripts/plots.py` writes Matplotlib PNG outputs into `files/plots/`.
- `scripts/exports.py` writes Excel and CSV outputs and inserts plot PNGs into the Excel `Charts` sheet.
- `scripts/config.py` centralizes paths, supported currencies, defaults, directory validation, and config loading.

## Current Version
v0.3.0

## FX Normalization (v0.3.0)
A user-selectable "Normalize to currency" control (Off / USD / CAD / EUR / GBP, default Off)
converts every security's price series into one common currency **before** any returns,
metrics, or charts are computed, so cross-currency comparisons reflect true performance
instead of FX drift. FX rates come from the existing data path as Yahoo `<native><target>=X`
pairs (e.g. `CADUSD=X`, quoting target units per one native unit), forward-filled and aligned
to each security's price dates; conversion is `price_native * rate`. Conversion fails soft:
an unavailable pair leaves that security in its native currency with a clear message. The
currency note switches to confirm the active mode when on, and keeps the existing
multi-currency warning when off. Pure conversion logic lives in `analytics.py`
(`align_fx_rate`, `convert_price_frame`, `normalize_price_frames_to_currency`) and is unit
tested; FX fetching lives in `data_sources.py` (`YahooFinanceSource.fetch_fx_rate`, offline
`load_offline_fx_rates`/`get_offline_fx_rate`).

- **Web:** browser dashboard in `projects/stock-data-dashboard-tool.md`; FX fetched through the
  same CORS proxy + Yahoo chart path as prices. Offline Sample mode uses an embedded `SAMPLE_FX`
  table mirroring the desktop bundled rates.
- **Desktop:** Offline mode demonstrates normalization from a small bundled FX file
  (`test-files/fx_rates.csv`, columns Date,Pair,Rate where Pair is `<FROM><TO>`); the price-CSV
  loader skips this file. If no FX file is present offline, conversion fails soft.

## What Has Been Built
- Cross-platform project scaffold and setup launchers.
- Offline CSV data source with combined-file and one-file-per-ticker support.
- Yahoo Finance data source using `yfinance`.
- Analytics engine for returns, dashboard metrics, correlation, regression, and diversification flags.
- Tkinter GUI with input panel, export folder selector, output tabs, embedded chart viewer, warnings, and no saved profile workflow.
- Offline CSV mode supports combined CSV files and one-file-per-ticker folders, with clearer messages for bad folders, no CSVs, missing tickers, missing columns, missing price fields, and date ranges with no overlap.
- Offline CSV date-range mismatch popups explain that sample CSV data exists, show the selected and available date ranges, recommend the 2024-01-02 to 2024-01-04 sample range, and point live 2025-2026 testing to Yahoo Finance.
- User-selected currency values are compared with data-source currency values from Yahoo Finance metadata or Offline CSV `Currency` columns; mismatches produce non-blocking warnings.
- Plot generation for indexed prices, cumulative returns, correlation heatmaps, risk/return, drawdowns, cleaner rolling volatility, cleaner rolling correlation, and regression scatterplots.
- Regression dropdown selection updates selected regression details, highlights the selected table row, and switches the regression scatterplot.
- Excel and CSV export helpers, including Excel chart image insertion.
- Export workflow writes Excel, CSV, and a separate JPG visualization folder.
- Website asset output folder at `files/website-assets/`.
- Minimal ZIP release guidance is documented in `README.md` and `md-instructions/RELEASE_CHECKLIST.md`.
- Pytest coverage for analytics, Offline CSV loading, plots, exports, and config path helpers.

## Known Issues
- Alpha Vantage and Twelve Data are provider stubs only.
- An interactive in-browser version is live on the GitHub Pages project page; the desktop app adds Excel/CSV/JPG exports and additional charts.
- The app is intentionally a one-time analysis/export utility and does not save comparison profiles.
- Flagged for review (see `handoff.md`): dashboard total/annualized/volatility metrics are computed over each security's own available date window rather than the common overlapping window, so comparisons across securities with different histories (e.g. 251 vs 128 observations) mix time periods; and geometric annualization of short, high-return windows can produce extreme figures (correct compounding, but potentially misleading). Neither was changed in v0.3.0 to avoid silently altering existing metric behavior.

## Next Steps
- Capture screenshots for the README and GitHub Pages project page (now including an FX-normalized comparison).
- Decide on the flagged common-window / short-window annualization items in `handoff.md`.
- Build a static project page using generated assets from `files/website-assets/`.
