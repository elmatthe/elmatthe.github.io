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

---

## How to use (web or desktop)

1. Set **Number of securities**.
2. Fill each row:
   - **Ticker** (example: `VTI`, `AAPL`)
   - **Shares / Units**
   - **Price (local)**
   - **Row Currency** (`USD`, `CAD`, `JPN`, `EUR`, `GBP`, `CHY/CNH`)
   - **Target Weight %**
3. Set **Reporting currency**.
4. Enter **Net contribution / withdrawal**:
   - Positive value = contribution
   - Negative value = withdrawal
5. Click **Run Rebalance**.
6. Review summary totals and trade instructions.

---

## Validation rules

- Ticker is required in every row.
- Shares/units must be numeric and non-negative.
- Price must be numeric and greater than 0.
- Target weight must be numeric and 0 or greater.
- At least one target weight must be greater than 0.
- Ending portfolio value must remain greater than 0.

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
