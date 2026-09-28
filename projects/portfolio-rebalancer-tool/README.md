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
| Language | **Python 3.11–3.14** | Runs the same on Windows and macOS; the launcher finds or installs it |
| Window / GUI | **tkinter** | Built into Python — nothing extra to install |
| Spreadsheet export | **openpyxl** | Writes the `.xlsx` trade plan |
| Live prices & FX | **yfinance** | Optional Yahoo Finance lookups |

Everything except Python installs into a self-contained `.venv` folder inside this
folder — nothing is installed system-wide, and you can move or delete the folder
freely.

---

## Download

1. Go to <https://elmatthe.github.io/projects/portfolio-rebalancer/>.
2. Click **Download portfolio-rebalancer.zip**.
3. Extract it anywhere you can write to (Desktop, Documents). Don't run it from inside
   the ZIP preview.

You'll get a `portfolio-rebalancer-tool` folder containing this README, the two setup launchers,
`config.toml` and the `scripts` folder.

---

## Setup & run

One launcher does everything: it checks the folder's private Python environment,
repairs or installs only what is missing, proves it works, then opens the program.
Healthy later launches skip straight to opening the program; no downloads happen.

### Windows
1. Double-click **`Setup_and_Run-portfolio-rebalancer.bat`**.
2. Because the file was downloaded from the internet, Windows SmartScreen or your
   security software may flag it the first time. If you are unsure whether it is safe to
   run, or if this is a work computer, check with your IT department before continuing.
3. If no suitable Python (3.11–3.14) is found, it asks (Y/N) before installing Python 3.13
   **for your user account only** with `winget`. No administrator rights are needed and
   your PATH is not changed. The Microsoft Store `python.exe` placeholder is never used.
4. The Portfolio Rebalancer window opens. To run it again later, double-click the same file.

### macOS
1. Double-click **`Setup_and_Run-portfolio-rebalancer.command`**.
2. The first time, macOS may say it "cannot be opened". Open **System Settings → Privacy &
   Security** and click **Open Anyway** (on a work computer, check with IT first).
3. If no suitable Python with tkinter is found, it offers a numbered menu: install with
   Homebrew (`python@3.13` + `python-tk@3.13`), or open the python.org download page.
4. The Portfolio Rebalancer window opens. To run it again later, double-click the same file.

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
  On Windows run e.g. `Setup_and_Run-portfolio-rebalancer.bat --venv-check`; on macOS
  `./Setup_and_Run-portfolio-rebalancer.command --venv-check`.

The full illustrated guide, including troubleshooting, is at <https://elmatthe.github.io/projects/portfolio-rebalancer-guide/>.

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
  README.md                                <- this file
  Setup_and_Run-portfolio-rebalancer.bat      <- Windows setup + launcher
  Setup_and_Run-portfolio-rebalancer.command  <- macOS setup + launcher
  config.toml                              <- supported Python range + entry point
  scripts/
    bootstrap.py            <- assess / repair / prove / launch logic used by the launchers
    main.py                 <- entry point (opens the window)
    requirements.txt        <- pinned dependencies
    portfolio_rebalancer/   <- the program, split into focused modules
      core.py               <- buy/sell/hold math + the three invariants
      fx.py                 <- currencies and FX conversion
      pricing.py            <- Yahoo Finance live price + FX lookup
      ticker_helper.py      <- ticker checking and helpful messages
      export.py             <- CSV / Excel export
      ui.py                 <- the tkinter window
  files/                    <- created on first run: setup logs, temp files, state
```

The source repository also contains `files/tests/` (pytest suite) and `md-instructions/`
(briefing and changelog); they are not part of the user download.

---

## Disclaimer

This tool is for illustrative and educational planning use only. It is not financial,
investment, or trading advice. Always verify prices at your broker before placing any
orders.
