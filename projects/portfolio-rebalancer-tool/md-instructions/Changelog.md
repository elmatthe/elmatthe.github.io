# Portfolio Rebalancer — Changelog

## v1.3.0 — 2026-11-03
- Sample portfolio: fourteen ordinary holdings (targets total exactly 100%): the ten
  Questrade holdings with targets scaled to 90%, then 7203.T, SAP.DE, VOD.L and 600519.SS
  with one share and 2.5% each. YNVD.NE in the sample; YNVD.TO remains a supported alias of
  the same Cboe Canada ETF.
- Removed the separate "International currency tests" group and its "Price test rows" /
  "Remove test rows" buttons. "Get prices" covers every active holding and, when it
  finishes, names each holding still without a usable price. "Remove international
  examples" removes the four sample rows only while they are unchanged.
- The estimate names listings outside Canada and the US before any request.
- "My price" refuses minor-unit codes (GBX) and loads the official rate for a new currency.
- Plan freshness uses the market-data clock (identical in production; testable).

## v1.1.1 — 2026-11-02
- Built-in fallback exchange rates (used only when live FX is off or unavailable) were stale
  approximations (CAD 0.74, JPY 0.0067, CNY 0.14 USD per unit; up to 7% off). They are now the
  Bank of Canada daily average rates for 2026-10-30, and a warning names that date whenever a
  multi-currency plan uses them without live FX.
- Web tool (same release): exchange rates come from the Bank of Canada (ECB fallback) and are
  editable; live prices use the visitor's own free Alpha Vantage key; every price and rate shows
  its source. The public Yahoo CORS relays were removed (unreliable; Yahoo's terms do not permit
  that use). The calculation engine is unchanged and still matches `core.py`.

## v1.1.0 — 2026-09-28
- Replaced `setup_and_run.bat/.command` with the standard one-click launchers
  `Setup_and_Run-portfolio-rebalancer.bat/.command` and `scripts/bootstrap.py`: a repo-root `.venv` is
  proven (exact pins, imports, `pip check`) before each launch and repaired only when needed;
  healthy launches no longer reinstall packages. Python 3.11-3.14 is found first (never the
  Microsoft Store alias) and installed per user only with consent (no all-users option).
- Bumped `yfinance` 1.3.0 -> 1.7.0 (verified live for US, `.TO`, `.L` pence and `=X` FX).
- Web tool: moved to the shared Yahoo transport (multiple CORS relays with health tracking,
  retry and payload validation) after the single keyless proxy stopped working; ticker checks
  no longer run on page load; added CSV/XLSX export. Algorithm parity with `core.py` is tested.
- Moved tests to `files/tests/`; `pytest` is no longer installed into the user environment.

## v1.0.1 — Mon 06/15/2026
- Fixed the Windows launcher: `setup_and_run.bat` failed at `Checking for Python...`
  with `: was unexpected at this time.` Literal parentheses inside parenthesized
  `if (...)` blocks (`(Y/N):`, `(all users)`, `(winget)`) were parsed by cmd as command
  groups; replaced/removed them so the block parses correctly.
- Fixed Yahoo Finance data fetching: bumped `yfinance` from `0.2.51` to `1.3.0` (the same
  version the Stock Data Dashboard fetches with successfully). The old version no longer
  performs Yahoo's required crumb/cookie handshake, so every request returned
  `429 Too Many Requests` / `Expecting value: line 1 column 1 (char 0)`. Pinned
  `pandas==3.0.3` and `numpy==2.4.6` to match the Dashboard's validated stack.
- Replaced security-prompt-bypass wording in the launchers and README with neutral
  guidance to consult IT if unsure.

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
