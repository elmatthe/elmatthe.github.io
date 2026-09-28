# Portfolio Rebalancer — Briefing

## What This Project Does
A portfolio rebalancing tool that recommends buy/sell/hold trades to move a portfolio
toward its target weights. It runs two ways from the same logic:

1. **Desktop program** — a tkinter window, launched by `Setup_and_Run-portfolio-rebalancer.bat` (Windows)
   or `.command` (macOS). This repo (`portfolio-rebalancer-tool`) is what the
   user downloads as a ZIP and runs locally.
2. **Interactive web tool** — a JavaScript implementation on the website project page
   (`projects/portfolio-rebalancer.html`, modules in `assets/js/portfolio-rebalancer/`). It
   mirrors the desktop algorithm (checked by the website's parity tests), including the live
   ticker/FX verification messages, and exports CSV/XLSX.

## Tech Stack
- Language: Python 3.11-3.14
- GUI: tkinter (standard library)
- Key Libraries: `openpyxl` (Excel/CSV export), `yfinance` (optional live prices + FX), pinned
  in `scripts/requirements.txt`. Tests (`files/tests/`) use `pytest` as a developer-only dependency.
- Web tool: vanilla JavaScript ES modules (no build step); fetches the Yahoo Finance chart
  endpoint through the site's shared transport pipeline (`assets/js/yahoo/`: several CORS
  relays with health tracking, retry and payload validation), and Yahoo `<FROM><TO>=X` FX.

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

The `Setup_and_Run-portfolio-rebalancer` launchers (Windows `.bat`, macOS `.command`) are
thin wrappers around `scripts/bootstrap.py`, rendered from `_tools/bootstrap/` in the
website repository. It follows ASSESS -> RECONCILE -> REPAIR/PROVISION -> PROVE -> LAUNCH ->
REPORT: a repo-root `.venv` is proven healthy (exact pins, real imports, `pip check`) before
every launch, rebuilt from an external Python 3.11-3.14 when stale or broken, and only
drifted packages are reinstalled. Python itself is installed only with consent and only
per user (winget user scope on Windows; Homebrew or python.org on macOS).

## Current Version
v1.1.0

## What Has Been Built
- Modular desktop package (core, fx, pricing, ticker_helper, export, ui) + `main.py`.
- Standard one-click bootstrap launchers (`Setup_and_Run-portfolio-rebalancer.bat` / `.command`)
  with self-repairing `.venv` and per-user Python provisioning.
- Pinned `requirements.txt` and a `pytest` suite (`files/tests/`) covering the three invariants.
- README written for non-technical users (download + setup + usage).
- Web tool on the project page with live ticker/currency verification messages.
- Website download button serves `portfolio-rebalancer.zip` (a zip of this folder).

## Known Issues
- Live prices/FX require internet. In the browser they go through public CORS proxies,
  which can be rate-limited; the tool falls back to manual prices and built-in FX rates
  with a warning when a lookup fails.

## Next Steps
- Optional: add tests for `ticker_helper` candidate generation and `fx` conversion.
