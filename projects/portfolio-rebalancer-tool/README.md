# Portfolio Rebalancer

A simple desktop tool that tells you exactly what to **buy, sell, or hold** to bring
a portfolio back to its target weights. It runs in its own window — no spreadsheets,
no terminal commands — and supports two everyday workflows:

- **New Money** — you have cash to invest. The tool produces buy-only recommendations
  and never spends more than your budget.
- **Rebalance (Pure)** — no new cash. Sells fund the buys, so the plan never spends
  more than your sale proceeds raise.

The same logic also runs in the browser on the project page, so you can try it before
downloading anything: <https://elmatthe.github.io/projects/portfolio-rebalancer/>

---

## What it does

- Multi-row position entry: ticker, shares/units, local price, row currency, and
  target weight %.
- Per-row currency support (USD, CAD, JPN, EUR, GBP, CHY/CNH) with automatic FX
  conversion to a single reporting currency.
- **Ticker & currency checking** — as you type, each ticker is verified and you get a
  clear `Verified: VTI (USD)` confirmation, or a warning that explains the fix (e.g.
  "`ISF` not found in CNY. Found as `ISF.L` (GBP). Update row currency or ticker").
- Optional **live prices and FX rates** pulled from Yahoo Finance (internet required),
  with safe fallback to your manually entered prices if a lookup fails.
- Optional **Account Type** column (TFSA, RRSP, Margin, etc.) that warns when a plan
  would quietly require moving money between account types.
- Optional **CSV and Excel export** of the full trade plan.

---

## What's under the hood (the tools it uses)

| Piece | Tool | Why |
|-------|------|-----|
| Language | **Python 3.9+** | Runs the same on Windows and macOS |
| Window / GUI | **tkinter** | Built into Python — nothing extra to install |
| Spreadsheet export | **openpyxl** | Writes the `.xlsx` trade plan |
| Live prices & FX | **yfinance** | Optional Yahoo Finance lookups |
| Tests | **pytest** | Proves the buy/sell/hold math stays correct |

Everything except Python installs into a self-contained `.venv` folder inside this
project — nothing is installed system-wide, and you can move or delete the folder
freely.

---

## Download

**From the website (easiest):**
1. Go to <https://elmatthe.github.io/projects/portfolio-rebalancer/>
2. Click **Download portfolio-rebalancer.zip**.
3. Unzip it anywhere you like (Desktop, Documents — it doesn't matter).

**From GitHub:** download the folder as a ZIP from the public repository and unzip it.

After unzipping you'll have a `portfolio-rebalancer-tool` folder containing this
README, the two setup launchers, and the `scripts` / `md-instructions` folders.

---

## Setup & run

You only "set up" once. After that, the same file is your everyday launcher — and it
re-uses the environment it built, so day-to-day starts are quick.

### Windows
1. Double-click **`setup_and_run.bat`**.
2. Because the file was downloaded from the internet, Windows or your security software
   may flag it the first time. If you are unsure whether it is safe to run, or if this is
   a work computer, check with your IT department before continuing.
3. If Python isn't installed, it will ask before installing it. Everything else is
   set up automatically inside the folder.
4. The Portfolio Rebalancer window opens. To run it again later, just double-click
   **`setup_and_run.bat`** again.

### macOS
1. Double-click **`setup_and_run.command`**.
2. Because the file was downloaded from the internet, macOS or your security software may
   block it the first time. If you are unsure whether it is safe to run, or if this is a
   work computer, check with your IT department before continuing.
3. If Python isn't installed, it will ask before installing it (no admin password
   needed for the "just for me" option).
4. The Portfolio Rebalancer window opens. To run it again later, just double-click
   **`setup_and_run.command`** again.

> If the `.command` file won't run on a fresh download, open Terminal, type
> `chmod +x ` (with a trailing space), drag the file onto the window, and press Enter.

---

## How to use it

1. **Pick a mode** — New Money (you're adding cash) or Rebalance (no new cash).
2. **Fill the table** — ticker, shares, local price, row currency, and a target
   weight % for each holding. Weights are relative; the tool normalizes them.
3. **Set the reporting currency** (and a budget, in New Money mode).
4. *(Optional)* tick **Fetch live prices and FX rates**, show the **Account Type**
   column, or enable **CSV/Excel export**.
5. Click **Run Rebalance** and review the summary, the per-row trade plan, and any
   warnings.

A built-in **Load Sample** button fills the table with an example portfolio so you can
see a full run immediately.

---

## Folder layout

```
portfolio-rebalancer-tool/
  README.md                 <- this file
  setup_and_run.bat         <- Windows setup + everyday launcher
  setup_and_run.command     <- macOS setup + everyday launcher
  md-instructions/
    Briefing.md             <- project overview / context
    Changelog.md            <- version history
  scripts/
    main.py                 <- entry point (opens the window)
    requirements.txt        <- pinned dependencies
    portfolio_rebalancer/   <- the program, split into focused modules
      core.py               <- buy/sell/hold math + the three invariants
      fx.py                 <- currencies and FX conversion
      pricing.py            <- Yahoo Finance live price + FX lookup
      ticker_helper.py      <- ticker checking and helpful messages
      export.py             <- CSV / Excel export
      ui.py                 <- the tkinter window
    tests/
      test_core.py          <- tests proving the math stays correct
```

---

## Disclaimer

This tool is for illustrative and educational planning use only. It is not financial,
investment, or trading advice. Always verify prices at your broker before placing any
orders.
