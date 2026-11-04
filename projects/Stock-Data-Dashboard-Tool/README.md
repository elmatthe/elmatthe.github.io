# Stock Comparison & Analytics Tool

## What It Does
Stock Comparison & Analytics Tool v0.6.0 is a Python desktop app for comparing stocks,
ETFs and funds. It downloads historical prices from the provider you choose with **your own
key** (Alpha Vantage, Marketstack or Alpaca), or loads them from your CSV files, can convert
every security into one common currency with official Bank of Canada rates, computes
performance and risk metrics, builds a correlation matrix, runs regression analytics,
shows charts in the window, and exports data plus visuals.

A separate browser version runs on the project page with nothing to install:
<https://elmatthe.github.io/projects/stock-data-dashboard-tool/>

## Features
- Multi-ticker comparison (stocks, ETFs, indexes, funds)
- Price history from Alpha Vantage, Marketstack or Alpaca with your own key, or Offline CSV
- Currency normalization to USD/CAD/EUR/GBP with official Bank of Canada daily rates
- Dashboard metrics, correlation matrix and diversification summary
- Regression analytics (each vs benchmark, or pairwise)
- In-app chart viewer
- Exports to Excel/CSV with chart images

## Download
1. Go to <https://elmatthe.github.io/projects/stock-data-dashboard-tool/>.
2. Click **Download stock-data-dashboard-tool.zip**.
3. Extract it anywhere you can write to (Desktop, Documents). Don't run it from inside
   the ZIP preview.

You'll get a `Stock-Data-Dashboard-Tool` folder containing this README, the two setup
launchers, `config.toml`, `scripts/`, `test-files/` (offline sample data) and `files/`.

## Setup & run

One launcher does everything: it checks the folder's private Python environment,
repairs or installs only what is missing, proves it works, then opens the program.
Healthy later launches skip straight to opening the program; no downloads happen.

### Windows
1. Double-click **`Setup_and_Run-stock-data-dashboard-tool.bat`**.
2. Because the file was downloaded from the internet, Windows SmartScreen or your
   security software may flag it the first time. If you are unsure whether it is safe to
   run, or if this is a work computer, check with your IT department before continuing.
3. If no suitable Python (3.11–3.14) is found, it asks (Y/N) before installing Python 3.13
   **for your user account only** with `winget`. No administrator rights are needed and
   your PATH is not changed. The Microsoft Store `python.exe` placeholder is never used.
4. The Stock Comparison & Analytics Tool window opens. To run it again later, double-click the same file.

### macOS
1. Double-click **`Setup_and_Run-stock-data-dashboard-tool.command`**.
2. The first time, macOS may say it "cannot be opened". Open **System Settings → Privacy &
   Security** and click **Open Anyway** (on a work computer, check with IT first).
3. If no suitable Python with tkinter is found, it offers a numbered menu: install with
   Homebrew (`python@3.13` + `python-tk@3.13`), or open the python.org download page.
4. The Stock Comparison & Analytics Tool window opens. To run it again later, double-click the same file.

> If the `.command` file won't run, open Terminal, type `chmod +x ` (with a trailing
> space), drag the file onto the window, and press Enter.

### Repair, move and reset
- **Moved the folder or something broke?** Just run the launcher again. It detects a
  stale or damaged `.venv`, rebuilds it (keeping a backup until the rebuild works) and
  reinstalls only the packages that are missing or at the wrong version.
- **Start completely fresh:** delete the `.venv` folder and run the launcher.
- **Logs:** the last setup log is `files/test-logs/setup-and-run-latest.log`; scratch
  files and the package cache stay in `files/temp/`.
- **Advanced options** (run from a terminal in this folder):
  `--venv-check` (report health, change nothing), `--repair-venv` (force a rebuild),
  `--setup-only` (set up without launching), `--launch-only` (launch only if already healthy).
  On Windows run e.g. `Setup_and_Run-stock-data-dashboard-tool.bat --venv-check`; on macOS
  `./Setup_and_Run-stock-data-dashboard-tool.command --venv-check`.

The full guide, including troubleshooting, is at <https://elmatthe.github.io/projects/stock-data-dashboard-guide/>.

## Data Sources
**Online data needs your own key** (use **API keys…** in the window; keys are kept until
you close the program unless you tick *Remember*, which saves them in `files/runtime/keys.json`):

| Source | Coverage | Daily history | Free plan |
|---|---|---|---|
| Alpha Vantage | US, Toronto, TSX Venture, London, Xetra, Shanghai/Shenzhen | ~100 sessions as traded; longer windows use weekly adjusted closes | 25 requests per day |
| Marketstack | many exchanges (free-plan coverage outside the US is not stated by Marketstack) | close and adjusted close | 100 requests per month |
| Alpaca | US listings | raw and adjusted daily bars (IEX exchange on the free plan) | 200 calls per minute |

Every series is checked for its symbol, exchange and currency; the price basis actually
used is reported. Earlier versions used Yahoo Finance through `yfinance`; it is no longer
used because Yahoo's terms do not permit automated collection. Offline CSV mode reads files
from a folder you choose and works without internet access.

Expected combined CSV format:

```csv
Date,Ticker,Close,Adj Close,Currency
2024-01-02,AAPL,185.64,184.91,USD
```

One-file-per-ticker CSVs are also supported when the filename is the ticker.

The included Offline CSV sample is `test-files/sample_prices.csv`. In the window, choose
the `test-files/` folder and use `2024-01-02` through `2024-01-04`. If the dates are set to
a range the sample doesn't cover, Offline CSV mode explains that the data does not overlap
the selected range; switch **Data source** to a provider with your own key for recent data.
CSV files must have one row per ticker and date and prices greater than 0.

## Visual Outputs
- Indexed price chart: normalizes each security to 100 at the first valid date.
- Cumulative return chart: shows compounded return over the selected period.
- Correlation heatmap: shows pairwise return correlations with numeric labels.
- Risk/return scatterplot: compares annualized return against annualized volatility.
- Drawdown chart: shows each security's decline from prior highs.
- Rolling volatility and rolling correlation charts.
- Regression scatterplot: shows selected Y-vs-X return regression with fitted line.

## Exporting Results
Use the **Export folder** field to choose where results are saved. The app creates the
folder if it does not exist and writes:

- An Excel workbook with data sheets (Dashboard Metrics, Correlation Matrix, Regression
  Results, Warnings) and a `Charts` sheet containing the chart images.
- A CSV folder with dashboard metrics, correlation matrix, regression results and warnings.
- An image folder with JPG copies of the charts.

Chart images are also generated in `files/plots/`, with copies of the main visuals in
`files/website-assets/`.

## Currency Notes
By default the analytics compute returns and correlations in each security's listing
currency, and the app warns when multiple listing currencies are detected.

Use **Normalize to currency** to convert every security into USD, CAD, EUR or GBP before
any metrics or charts are computed, so cross-currency comparisons reflect true performance
instead of FX drift. **Off (native listing currency)** is the default.

- FX rates are official Bank of Canada daily averages, derived through CAD. Each price uses
  the latest fixing on or before its date, at most 7 days old; nothing is back-filled (no
  look-ahead). Prices are converted first, then returns are derived.
- Securities already in the target currency are left unchanged.
- A security that cannot be converted (unknown currency, no fixing) is left out of the
  normalized comparison with a clear message; it is never mixed in unconverted.
- **Offline CSV mode** uses `test-files/fx_rates.csv` (columns `Date,Pair,Rate`, where
  `Pair` is `<FROM><TO>` and `Rate` is target units per native unit).

## Outputs
The dashboard shows total return, annualized return, annualized volatility, Sharpe ratio,
max drawdown, observations, completeness and currency. The app also produces a
correlation matrix, diversification summary, regression table, PNG plots and Excel/CSV
exports.

## Limitations
- Free provider plans have small request allowances (see above); the window shows how many
  requests this computer sent. Your provider counts every use of the key.
- Each ticker's returns are computed on its own price series, so exchange holidays elsewhere
  do not remove its returns; correlations use dates where both have returns (at least 3).
- Weekly and monthly bars are dated by their last trading day; the period still trading is
  left out.
- The browser version on the project page shares this tool's purpose and providers but not
  its code: it uses log returns with exact-interval correlation and an offline demo.
- The app does not save comparison profiles; export results when you want to keep them.

## Project Structure
```text
Stock-Data-Dashboard-Tool/
  README.md                                   <- this file
  Setup_and_Run-stock-data-dashboard-tool.bat      <- Windows setup + launcher
  Setup_and_Run-stock-data-dashboard-tool.command  <- macOS setup + launcher
  config.toml                                 <- supported Python range + entry point
  scripts/
    bootstrap.py       <- assess / repair / prove / launch logic used by the launchers
    main.py            <- the tkinter window
    data_sources.py    <- provider-key and Offline CSV sources, Bank of Canada FX
    analytics.py       <- metrics, correlation, regression
    plots.py           <- charts
    exports.py         <- Excel / CSV / image export
    config.py          <- defaults
    requirements.txt   <- pinned dependencies
  test-files/          <- offline sample prices and FX rates
  files/               <- exports, plots, and (after first run) setup logs and state
```

The source repository also contains `files/tests/` (pytest suite) and `md-instructions/`
(briefing, changelog and handoff notes); they are not part of the user download.

## Disclaimer
This tool is for education and analysis only. It is not investment advice.
