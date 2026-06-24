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
v0.2.5

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
- FX normalization is not implemented; multi-currency comparisons warn users.
- An interactive in-browser version is live on the GitHub Pages project page; the desktop app adds Excel/CSV/JPG exports and additional charts.
- The app is intentionally a one-time analysis/export utility and does not save comparison profiles.

## Next Steps
- Capture screenshots for the README and GitHub Pages project page.
- Add FX conversion support behind the existing config hooks.
- Build a static project page using generated assets from `files/website-assets/`.
