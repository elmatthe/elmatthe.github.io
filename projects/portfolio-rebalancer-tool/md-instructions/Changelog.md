# Portfolio Rebalancer — Changelog

## v1.0.0 — Mon 06/08/2026
- Restructured the program into a clean, downloadable repo (`portfolio-rebalancer-tool`)
  with a minimal root: `README.md`, `setup_and_run.bat`, `setup_and_run.command`, plus
  `md-instructions/` and `scripts/` folders.
- Split the program into focused modules under `scripts/portfolio_rebalancer/`
  (`core`, `fx`, `pricing`, `ticker_helper`, `export`, `ui`), with `scripts/main.py`
  as the entry point.
- Added cross-platform setup launchers: install Python only if missing, build a local
  `.venv`, install pinned dependencies, and run the tool. The same file re-launches the
  tool on later runs.
- Pinned all dependencies in `scripts/requirements.txt` (`openpyxl==3.1.5`,
  `yfinance==0.2.51`, `pytest==8.3.4`).
- Wrote a non-technical README covering the tools used, download from the website/GitHub,
  setup, and usage.
- Carried over the live ticker/currency verification messaging (Verified / warning hints)
  in both the desktop tool and the web tool.
- Website: the project-page download button now serves `portfolio-rebalancer.zip`
  (a zip of this folder) instead of a single `.py` file.

### Inherited from the previous Portfolio_Rebalancer build
- Two modes (New Money / Rebalance) and three invariants (budget cap, sell-funds-buys,
  cross-account funding warnings).
- Per-row currency selection and FX conversion to a reporting currency.
- Optional live prices/FX from Yahoo Finance with graceful fallback.
- Optional Account Type column and CSV/Excel export.
