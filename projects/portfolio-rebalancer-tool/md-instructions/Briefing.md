# Portfolio Rebalancer — Briefing

## What This Project Does
A portfolio rebalancing tool that recommends buy/sell/hold trades to move a portfolio
toward its target weights. It runs two ways from the same logic:

1. **Desktop program** — a tkinter window, launched by `setup_and_run.bat` (Windows) or
   `setup_and_run.command` (macOS). This repo (`portfolio-rebalancer-tool`) is what the
   user downloads as a ZIP and runs locally.
2. **Interactive web tool** — a self-contained JavaScript implementation embedded in the
   project page on the website (`projects/portfolio-rebalancer.md`). It mirrors the
   desktop behaviour, including the live ticker/FX verification messages.

## Tech Stack
- Language: Python 3.9+
- GUI: tkinter (standard library)
- Key Libraries: `openpyxl` (Excel/CSV export), `yfinance` (optional live prices + FX),
  `pytest` (tests). All pinned in `scripts/requirements.txt`.
- Web tool: vanilla JavaScript (no build step); fetches Yahoo Finance via public CORS
  proxies with graceful fallback.

## Architecture
Entry point is `scripts/main.py`, which imports `portfolio_rebalancer.ui.main`. The
package is split into focused modules so each concern lives in one file:

- `core.py` — pure, GUI-free rebalancing math. Two modes (new_money, rebalance) and
  three invariants (budget cap, sell-funds-buys, cross-account funding warnings).
  This is the module the tests target directly.
- `fx.py` — currency table, FX conversion helpers, and number/price formatting.
- `pricing.py` — Yahoo Finance lookups via yfinance, with safe fallback when offline
  or when yfinance is not installed.
- `ticker_helper.py` — candidate-symbol generation and the verify/warning messaging
  (exchange suffix hints like `.TO`, `.L`, `.T`; cross-market resolution).
- `export.py` — CSV and styled Excel (`openpyxl`) output.
- `ui.py` — the tkinter window; runs live fetches on a worker thread so the UI stays
  responsive, and renders the verify/warning hints per row.

The setup launchers create a local `.venv`, install pinned dependencies into it, then
run `scripts/main.py`. Python is the only thing that can ever be installed system-wide,
and only if it is missing.

## Current Version
v1.0.0

## What Has Been Built
- Modular desktop package (core, fx, pricing, ticker_helper, export, ui) + `main.py`.
- Cross-platform setup/launcher files (`setup_and_run.bat`, `setup_and_run.command`)
  that install Python if needed, build a `.venv`, install deps, and run the tool.
- Pinned `requirements.txt` and a `pytest` suite covering the three invariants.
- README written for non-technical users (download + setup + usage).
- Web tool on the project page with live ticker/currency verification messages.
- Website download button serves `portfolio-rebalancer.zip` (a zip of this folder).

## Known Issues
- Live prices/FX require internet. In the browser they go through public CORS proxies,
  which can be rate-limited; the tool falls back to manual prices and built-in FX rates
  with a warning when a lookup fails.

## Next Steps
- Optional: add tests for `ticker_helper` candidate generation and `fx` conversion.
