# Portfolio Rebalancer Project - Setup Guide

## What this project includes

The Portfolio Rebalancer project has two ways to run the same rebalancing workflow:

1. **Interactive web tool** on the project page.
2. **Desktop Python script** (`portfolio_rebalancer_desktop.py`) that opens its own window and performs the same calculations.

Both versions support:

- Multi-row position inputs
- Per-row currency selection with built-in FX conversion
- Reporting currency totals
- Net contribution/withdrawal input
- Buy/Sell/Hold trade instructions with post-trade share counts
- Optional live ticker price + FX snapshot fetch on run
- Optional CSV + Excel export

---

## Download files

From the Portfolio Rebalancer project page:

- Download **Portfolio Rebalancer (.py)** to run the desktop app.
- Download **Portfolio Rebalancer Setup Guide (.md)** for offline instructions.
- Open **Portfolio Rebalancer Setup Guide (Web Page)** for a rendered browser view.

---

## Run the desktop Python script

### 1) Prerequisites

- Python **3.9+** recommended
- `tkinter` available (included with most Python installs)

### Before You Use It - One-Time Setup

Install optional packages if you want live data and Excel export:

```bash
pip install openpyxl yfinance
pip install --upgrade yfinance
```

- `openpyxl` - required for Excel export
- `yfinance` - required for live ticker/FX fetch
- Upgrading `yfinance` is recommended to keep Yahoo Finance live quote support stable
  (especially for `fast_info` and non-US exchange symbols such as `.TO`)

If you only need manual inputs and on-screen output, no extra install is required.

### 2) Run command

Open terminal in the folder containing the downloaded script and run:

```bash
python3 portfolio_rebalancer_desktop.py
```

If `python3` is not available, try:

```bash
python portfolio_rebalancer_desktop.py
```

### 3) Desktop window behavior

When launched, the script opens a window with:

- Row controls: **Apply Rows**, **Add Row**, **Remove Last Row**
- Inputs per row: ticker, shares, price, row currency, target weight
- Live FX and current value columns
- **Run Rebalance** button for final trade output
- **Load Sample Portfolio** button for quick testing
- Run options:
  - **Fetch live prices and FX rates** (optional)
  - **Also export to CSV** with file picker
  - **Also export to Excel** with file picker

---

## How to use (web or desktop)

1. Set **Number of securities**.
2. Fill each row:
   - **Ticker** (example: `VTI`, `AAPL`)
   - **Shares / Units**
   - **Price (local)**
   - **Row Currency** (`USD`, `CAD`, `JPN`, `EUR`, `GBP`, `CHY/CNH`)
   - For `CHY/CNH` rows, CNY values display as `CN¥` in outputs
   - **Target Weight %**
3. Set **Reporting currency**.
4. Enter **Net contribution / withdrawal**:
   - Positive value = contribution
   - Negative value = withdrawal
5. Optional:
   - Enable **Fetch live prices and FX rates**
   - Enable **Also export to CSV** and choose output file
   - Enable **Also export to Excel** and choose output file
6. Click **Run Rebalance**.
7. Review summary totals, trade instructions, and warnings.

---

## Live Price and FX Fetch

When **Fetch live prices and FX rates** is checked:

- The app attempts to fetch current ticker prices from Yahoo Finance
- The app attempts to fetch FX rates for every currency used in the portfolio and reporting currency
- Fetched prices overwrite row **Price (local)** fields for visibility
- Fetched FX values are shown with a `~` prefix in the FX column (example: `~0.6971`)
- For non-USD rows, the app auto-tries exchange ticker suffixes (example: `.TO`, `.L`, `.T`) to find local-market quotes
- The app validates fetched quote currency against your selected row currency before using it

Fallback behavior:

- If a ticker live price fails, the app uses the manual row price and shows a warning
- If a currency live FX fetch fails, the app falls back to built-in FX constants and shows a warning
- If fetched quote currency mismatches the selected row currency:
  - the app keeps manual price when available, or
  - auto-adjusts to the fetched quote currency for that run and warns you
- If a ticker is not available in the selected row currency market, the app warns with a message like:
  - `ISF not found in CNY. Found as ISF.L (GBP). Update row currency or ticker symbol.`

Notes:

- Yahoo Finance free data is often delayed by ~15-20 minutes
- Always verify execution prices at your broker before placing orders

---

## Validation rules

- Ticker is required in every row.
- Shares/units must be numeric and non-negative.
- Price must be numeric and greater than 0.
- Target weight must be numeric and 0 or greater.
- At least one target weight must be greater than 0.
- Ending portfolio value must remain greater than 0.
- If live fetch is off, each row price must be valid manually.
- If live fetch is on and a ticker fetch fails, a manual row price is required for fallback.

---

## Exporting results

### CSV export

1. Check **Also export to CSV**
2. Click **Browse...** and choose a `.csv` file path
3. Run rebalance
4. CSV is written automatically with:
   - Summary block
   - Per-ticker trade table

### Excel export

1. Check **Also export to Excel**
2. Click **Browse...** and choose a `.xlsx` file path
3. Run rebalance
4. Workbook is written automatically with:
   - `RB_Summary` sheet
   - `RB_TradePlan` sheet

---

## Output fields

The results include:

- Total current portfolio value
- Net flow
- Target ending value
- Total buy value
- Total sell value
- Per-ticker trade plan:
  - Current value
  - Target value
  - Trade value (reporting currency)
  - Trade value (local row currency)
  - Trade shares/units
  - Action (Buy / Sell / Hold)
  - Post-trade shares/units

---

## Disclaimer

This tool is for illustrative and educational planning use only. It is not financial advice, investment advice, or a recommendation to take any specific action. Verify prices at your broker before placing any orders.
