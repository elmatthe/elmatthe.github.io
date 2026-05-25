# Portfolio Rebalancer Project - Setup Guide

## What this project includes

The Portfolio Rebalancer project has two ways to run the same rebalancing workflow:

1. **Interactive web tool** on the project page.
2. **Desktop program** (Python package with batch-file launcher) that opens its own window and performs the same calculations.

Both versions support:

- **Two rebalancing modes:** New Money (buy-only with budget cap) and Rebalance (pure sell-funds-buys)
- **Three invariants:** budget cap, sell-proceeds ceiling, cross-account funding warnings
- Multi-row position inputs with per-row currency selection and FX conversion
- Optional Account Type column for cross-account funding checks
- Optional live ticker price and FX snapshot fetch via Yahoo Finance
- Ticker-helper messaging for exchange symbol disambiguation
- Optional CSV and Excel export

---

## Quick Start (Windows)

1. **Download** the Portfolio Rebalancer program folder.
2. **Double-click `setup.bat`** once — this checks Python, creates a virtual environment, and installs dependencies.
3. **Double-click `run.bat`** to start the program.

If the virtual environment is missing, `run.bat` will call `setup.bat` automatically.

---

## Prerequisites

- **Python 3.9+** with `tkinter` (included with most Python installs)
- **Windows** for the batch-file launcher (the Python code also runs on macOS/Linux via `python main.py`)

### What the batch files do

- **`setup.bat`** — checks Python is installed, creates a `.venv` virtual environment, upgrades pip, and installs `openpyxl` and `yfinance` from `requirements.txt`.
- **`run.bat`** — activates the venv and launches `main.py`. If `.venv` is missing, calls `setup.bat` first.

Both use relative paths and do not require admin rights.

---

## Program folder structure

```
Portfolio_Rebalancer/
  portfolio_rebalancer/      # Python package
    __init__.py
    core.py                  # Pure rebalancing logic (two modes + three invariants)
    fx.py                    # Currency options and FX conversion
    pricing.py               # Yahoo Finance live price and FX lookup
    ticker_helper.py         # Ticker disambiguation and messaging
    ui.py                    # Tkinter GUI
    export.py                # CSV and Excel export
  tests/
    test_core.py             # Unit tests for the invariants
  main.py                    # Entry point
  requirements.txt           # openpyxl, yfinance
  setup.bat                  # First-time setup (Windows)
  run.bat                    # Everyday launcher (Windows)
```

---

## How to use (web or desktop)

### 1. Choose a mode

- **New Money** — you are adding cash. Only buy recommendations are produced. Total buys will not exceed your budget.
- **Rebalance (Pure)** — no new cash. Sells fund buys. Total buy cost will not exceed total sell proceeds.

### 2. Fill the input table

- **Ticker** (e.g. `VTI`, `XIC.TO`, `ISF.L`)
- **Shares / Units** (0 is allowed for new positions)
- **Price (local)** — leave blank when using live fetch for new positions
- **Row Currency** (USD, CAD, JPN, EUR, GBP, CHY/CNH)
- **Target Weight %** — relative weights; the tool normalizes them

### 3. Set reporting currency and budget

- **Reporting currency** — all values are converted to this currency
- **New money budget** (New Money mode only) — the cash you are adding

### 4. Optional settings

- **Account Type column** — enable to track account types (TFSA, RRSP, Margin, etc.) for cross-account funding warnings
- **Fetch live prices and FX rates** — pulls current data from Yahoo Finance
- **Export to CSV / Excel** — saves results to a file

### 5. Run and review

Click **Run Rebalance** and review:
- Summary totals (mode, pool, total buys/sells)
- Per-row trade plan (action, trade value, trade shares, post-trade shares)
- Warnings (budget scaling, cross-account funding, ticker resolution)

---

## The Three Invariants

1. **New-Money Budget Cap** — In New Money mode, if the raw buy recommendations exceed the budget, all buys are scaled down proportionally and a warning is shown.
2. **Rebalance Self-Funding** — In Rebalance mode, if total buys exceed total sell proceeds, buys are scaled down proportionally.
3. **Cross-Account Funding** — When Account Type is enabled, the tool flags when buys in one account type (e.g. Margin) would require funds from another (e.g. TFSA).

---

## Live Price and FX Fetch

When **Fetch live prices and FX rates** is checked:

- The app fetches current ticker prices from Yahoo Finance
- Auto-tries exchange ticker suffixes (`.TO`, `.L`, `.T`, etc.) to find local-market quotes
- Validates fetched quote currency against your selected row currency
- Fetches FX rates for all currencies in scope

Fallback behavior:
- If a ticker fetch fails, the manual price is used (with a warning)
- If FX fetch fails, built-in fallback rates are used (with a warning)
- If a ticker is found in a different market, the app warns with guidance like:
  `ISF not found in CNY. Found as ISF.L (GBP). Update row currency or ticker symbol.`

---

## Validation rules

- Ticker is required in every row
- Shares must be numeric and non-negative (0 allowed for new positions)
- Price must be > 0 (or provided via live fetch)
- Target weight must be >= 0, with at least one > 0
- In New Money mode, budget must be > 0
- Portfolio value must be > 0

---

## Exporting results

### CSV export
Check **Export CSV**, choose a file path, and run. The CSV includes summary, trade plan, warnings, and notes.

### Excel export
Check **Export Excel**, choose a file path, and run. The workbook includes `RB_Summary` and `RB_TradePlan` sheets with formatting.

---

## Disclaimer

This tool is for illustrative and educational planning use only. It is not financial advice, investment advice, or a recommendation to take any specific action. Verify prices at your broker before placing any orders.
