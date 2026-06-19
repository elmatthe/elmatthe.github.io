# CPI Dashboard Downloader — Briefing

## What This Project Does
A single-script tool that fetches CPI and related economic data for Canada
(Statistics Canada) and the US (FRED) and writes it directly into a
`CPI_Downloader` sheet inside a target Excel workbook (`.xlsm` or `.xlsx`).
It supports a single-month or a date-range fetch, and can optionally export
the same data to a CSV file alongside the Excel write. A small tkinter GUI
lets the user pick the mode, date range, target workbook, optional CSV
path, and their FRED API key, then click one button to download and write.

## Tech Stack
- Language: Python 3.11+ (developed/tested on 3.14; winget installs 3.12 for
  end users who lack Python — all pins are wheel/pure-Python on both)
- GUI: tkinter (stdlib)
- Key Libraries: `requests==2.32.5` (HTTP calls to StatCan/FRED),
  `openpyxl==3.1.5` (reading/writing `.xlsm`/`.xlsx`, VBA-preserving),
  `python-dateutil==2.9.0.post0` (month-range math via `relativedelta`)
- Test tooling: `pytest==9.1.1` (pinned in `requirements.txt`)
- External binaries: none. The only shell-out is to `OneDrive.exe`, located
  via `%LOCALAPPDATA%` and skipped silently if absent — nothing is downloaded
  or added to PATH.

## Setup & Run
- Single self-contained launcher: `Setup_and_Run-cpi_automation.bat` (repo
  root). It detects Python via the `py` launcher (falling back to a
  non-WindowsApps `python`), and only offers a winget `--scope user` install
  if Python is genuinely missing — never prompting when it's already present.
  It then builds `.venv` in the repo, installs `scripts/requirements.txt` into
  it, and launches the entry point. The batch is fully self-contained with no
  dependency on any separate `.ps1` script. No admin rights, nothing
  system-wide except a missing Python.
- Reproducible from a copy without `.venv`: `.venv/`, `__pycache__/`, build
  artifacts, `files/config.json` (saved API key) and `files/fred_api_key.md`
  (personal key notes) are all gitignored.
- Verify gate: `.venv\Scripts\python.exe scripts\verify.py` checks every
  dependency is pinned and runs the `files/tests/` suite.

## Architecture
Single-script tool — `scripts/cpi_dashboard_downloader-v0.2.0.py`. No
launcher is needed at this version (one tool, one entry point). Layout
within the script:

- **Config** — StatCan vector IDs and FRED series IDs, target sheet name,
  and the fixed `OUTPUT_COLUMNS` order (A–Q).
- **API key persistence** — `load_api_key`/`save_api_key` read and write
  `files/config.json` (path resolved from `__file__`, not the working
  directory) so the FRED API key is remembered between sessions; missing
  or corrupted config is handled silently with no crash.
- **OneDrive pause/resume** — best-effort pause of `OneDrive.exe` syncing
  around the workbook write so a sync mid-save can't corrupt the file;
  silently no-ops if OneDrive isn't installed.
- **Date helpers** — `ym_to_date`, `month_range` for iterating "YYYY-MM"
  strings.
- **StatCan fetch** — `fetch_statcan_vector_range` / `fetch_all_statcan`
  call the StatCan WDS REST API (`getDataFromVectorByReferencePeriodRange`),
  chunking into 10-year (120-month) windows to stay under StatCan's
  per-request data-point cap, with retry/backoff.
- **FRED fetch** — `fetch_fred_monthly` for monthly series, and
  `fetch_fred_daily_eom` for daily series that are resolved to an
  end-of-month value (e.g. Fed Funds EOP, S&P 500, 10yr-2yr spread).
- **`build_rows`** — merges StatCan + FRED data into one row per month, in
  the fixed `OUTPUT_COLUMNS` order, with `None` for any data point a source
  doesn't have for that month.
- **Write to workbook** — `write_to_workbook` opens the target file with
  `keep_vba=True` when it's a `.xlsm`, clears the `CPI_Downloader` sheet,
  and writes header + data rows.
- **Write to CSV** — `write_to_csv`, optional, dates formatted `YYYY-MM-DD`.
- **GUI** — `main()` builds the tkinter window; `run_download()` is the
  button handler that validates input, calls `build_rows` +
  `write_to_workbook` (+ `write_to_csv` if enabled), and reports results via
  `messagebox`.

## Current Version
v0.2.2

## What Has Been Built
- Single-month and date-range fetch modes, selectable via radio buttons
- 5 StatCan vectors: Headline CPI (unadjusted/seasonally adjusted), Core CPI
  (unadjusted/seasonally adjusted), Alberta CPI (unadjusted)
- 8 FRED monthly series: Headline/Core CPI (US, unadjusted/SA), Unemployment
  Rate (SA), Effective Fed Funds Rate, PCE (SA), Core PCE (SA)
- 3 FRED daily series resolved to end-of-month: Fed Funds Rate (EOP),
  S&P 500 by month, 10yr vs 2yr Treasury spread
- Fixed 17-column output order (A–Q), written to the `CPI_Downloader` sheet
- Workbook write supports both `.xlsm` (VBA preserved via `keep_vba=True`)
  and `.xlsx`
- Optional simultaneous CSV export (`YYYY-MM-DD` date format)
- OneDrive pause/resume wrapped around the workbook save to avoid sync
  conflicts mid-write; no-ops gracefully if OneDrive isn't installed
- StatCan requests auto-chunked into 10-year windows to respect the API's
  data-point limit; both StatCan and FRED calls retry with exponential
  backoff on request failures
- GUI input validation: FRED API key required, valid year/month, end date
  not before start date, workbook path required and must be `.xlsm`/`.xlsx`,
  CSV path required if CSV export is checked
- GUI note near the date fields indicating data availability begins
  January 1913, with start dates earlier than that silently clamped before
  any API calls are made
- FRED API key is remembered between sessions via `files/config.json`:
  pre-filled on launch, saved automatically after each successful
  download, never crashes on a missing/corrupted config file
- `files/tests/test_cpi.py`: fast, no-network pytest suite covering the date
  helpers (`ym_to_date`, `month_range`, `last_day_of_month`), the 17-column
  output shape, and a CSV write round-trip. The module is loaded by path via
  importlib (its filename has a hyphen/dot), which also doubles as an
  import-resolution smoke test for all third-party deps
- `scripts/verify.py`: minimal verify gate — confirms every dependency in
  `requirements.txt` is pinned and runs the pytest suite

## Known Issues
None at this time.

## Next Steps
None defined yet.
