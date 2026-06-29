# Stock Comparison & Analytics Tool

## What It Does
Stock Comparison & Analytics Tool v0.3.0 is a small Python desktop app for comparing stocks, ETFs, indexes, and funds. It fetches or loads historical prices, optionally normalizes every security into one common currency, computes performance and risk metrics, builds a correlation matrix, runs regression analytics, displays charts in the GUI, and exports data plus visuals.

## Why I Built It
This is a finance and analytics portfolio project designed to show practical market-data handling, statistical analysis, export workflows, and a simple GUI that a non-technical user can launch.

## Features
- Multi-ticker comparison
- Yahoo Finance data
- Offline CSV mode
- Currency normalization (convert all securities to USD/CAD/EUR/GBP before metrics)
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
By default the analytics compute returns and correlations in each security's listing currency, and the app warns when multiple listing currencies are detected.

### Currency Normalization (v0.3.0)
Use the **Normalize to currency** selector in the Inputs panel to convert every security into one common currency (USD, CAD, EUR, or GBP) before any metrics or charts are computed, so cross-currency comparisons reflect true performance instead of FX drift. Choose **Off (native listing currency)** to keep the original behavior (the default).

- FX rates are pulled from the same Yahoo Finance path as prices (`<native><target>=X`, e.g. `CADUSD=X`), forward-filled and aligned to each security's price dates. Prices are converted first, then returns are derived.
- Securities already in the target currency are left unchanged.
- If FX rates for a pair are unavailable, that security stays in its native currency and a clear message is shown — the app never crashes.
- **Offline CSV mode** demonstrates normalization using the bundled `test-files/fx_rates.csv` (columns `Date,Pair,Rate`, where `Pair` is `<FROM><TO>` and `Rate` is target-per-native). If no FX file is present in the selected folder, conversion fails soft and shows native currency.

If the user-selected currency differs from the data-source currency, the app still shows a non-blocking mismatch warning.

## Outputs
The dashboard shows total return, annualized return, annualized volatility, Sharpe ratio, max drawdown, observations, completeness, and currency. The app also produces a correlation matrix, diversification summary, regression table, PNG plots, website asset copies, and Excel/CSV exports.

## Limitations
- FX normalization is Off by default; when Off, returns and correlations are computed in each security's listing currency.
- Alpha Vantage and Twelve Data are still provider stubs; Yahoo Finance and Offline CSV are the supported data sources.
- An interactive in-browser version of this tool is available on the project page at <https://elmatthe.github.io/projects/stock-data-dashboard-tool/>.

## Saving Work
This tool is designed as a one-time analysis utility. It does not save comparison profiles; users can export results to a manually selected folder when they want to keep outputs.

## Minimal ZIP Release Contents
For a clean user download, include the setup launchers, README, workspace instruction files, `scripts/`, `md-instructions/`, the required `files/` placeholders/config example, and `test-files/sample_prices.csv`.

Exclude `.venv/`, `.python_runtime/`, `__pycache__/`, `.pytest_cache/`, `.run-temp/`, `screenshots/`, generated exports, generated plots, generated website assets, test logs, and temporary planning files.

## Project Structure
```text
Stock-Data-Dashboard-Tool/
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
