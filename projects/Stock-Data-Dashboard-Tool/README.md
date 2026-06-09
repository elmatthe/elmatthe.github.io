# Stock Comparison & Analytics Tool

## What It Does
Stock Comparison & Analytics Tool v0.2.5 is a small Python desktop app for comparing stocks, ETFs, indexes, and funds. It fetches or loads historical prices, computes performance and risk metrics, builds a correlation matrix, runs regression analytics, displays charts in the GUI, and exports data plus visuals.

## Why I Built It
This is a finance and analytics portfolio project designed to show practical market-data handling, statistical analysis, export workflows, and a simple GUI that a non-technical user can launch.

## Features
- Multi-ticker comparison
- Yahoo Finance data
- Offline CSV mode
- Dashboard metrics
- Correlation matrix
- Diversification summary
- Regression analytics
- In-app chart viewer
- Exports to Excel/CSV with chart images

## Quick Start

### Windows
Double-click `setup_and_run.bat`.

### macOS
Double-click `setup_and_run.command`.

If macOS blocks the file, open System Settings > Privacy & Security > Open Anyway.

## Data Sources
Yahoo Finance mode uses `yfinance` to download historical market data. Offline CSV mode reads files from a selected folder and is useful for demos, testing, and working without internet access. Alpha Vantage and Twelve Data are included as future provider stubs that look for API keys through config or environment variables.

Expected combined CSV format:

```csv
Date,Ticker,Close,Adj Close,Currency
2024-01-02,AAPL,185.64,184.91,USD
```

One-file-per-ticker CSVs are also supported when the filename is the ticker.

The included Offline CSV sample is located at `test-files/sample_prices.csv`. In the GUI, choose the `test-files/` folder and use `2024-01-02` through `2024-01-04` when testing the sample data. If the GUI is set to a live-market range such as 2025-2026, Offline CSV mode now explains that the sample data exists but does not overlap the selected date range; switch Data Source to Yahoo Finance for live 2025-2026 market data.

## Visual Outputs
- Indexed price chart: normalizes each security to 100 at the first valid date.
- Cumulative return chart: shows compounded return over the selected period.
- Correlation heatmap: shows pairwise return correlations with numeric labels.
- Risk/return scatterplot: compares annualized return against annualized volatility.
- Drawdown chart: shows each security's decline from prior highs.
- Rolling volatility chart: shows annualized rolling volatility.
- Regression scatterplot: shows selected Y-vs-X return regression with fitted line.

## Exporting Results
Use the Export folder field to choose where results are saved. The app creates the folder if it does not exist and writes:

- Excel workbook with data sheets and a `Charts` sheet containing generated chart images.
- CSV folder with dashboard metrics, correlation matrix, regression results, and warnings.
- Image folder with JPG copies of the generated visualizations for sharing or portfolio use.

## Website / Portfolio Assets
After running an analysis, chart images are generated in `files/plots/`. A copy of the main portfolio-friendly visuals is also saved in `files/website-assets/`. These generated PNGs are ignored by default, while the folder remains in the repo through `.gitkeep`.

## Currency Notes
The v0.2.5 analytics compute returns and correlations in each security's listing currency. If multiple listing currencies are detected, the app warns that cross-currency comparisons may be distorted without FX normalization. If the user-selected currency differs from the data-source currency, the app shows a non-blocking mismatch warning.

## Outputs
The dashboard shows total return, annualized return, annualized volatility, Sharpe ratio, max drawdown, observations, completeness, and currency. The app also produces a correlation matrix, diversification summary, regression table, PNG plots, website asset copies, and Excel/CSV exports.

## Limitations
- FX normalization is not implemented yet.
- Alpha Vantage and Twelve Data are still stubs.
- A browser-based website version is future work.

## Saving Work
This tool is designed as a one-time analysis utility. It does not save comparison profiles; users can export results to a manually selected folder when they want to keep outputs.

## Minimal ZIP Release Contents
For a clean user download, include the setup launchers, README, workspace instruction files, `scripts/`, `md-instructions/`, the required `files/` placeholders/config example, and `test-files/sample_prices.csv`.

Exclude `.venv/`, `.python_runtime/`, `__pycache__/`, `.pytest_cache/`, `.run-temp/`, `screenshots/`, generated exports, generated plots, generated website assets, test logs, and temporary planning files.

## Screenshots
Screenshots can be added here after portfolio capture.

## Project Structure
```text
StockComparisonAnalyticsTool/
  README.md
  CLAUDE.md
  CODEX.md
  CURSOR.md
  AI-WORKSPACE.md
  setup_and_run.bat
  setup_and_run.command
  scripts/
  md-instructions/
  files/
  test-files/
  tests/
```

## Disclaimer
This tool is for education and analysis only. It is not investment advice.
