# Monte Carlo Retirement Simulator — Briefing

## What This Project Does
A retirement-planning Monte Carlo simulator that runs many random market paths and reports
how often a plan survives, the spread of outcomes by year, and when failures tend to occur.
It runs two ways from the same model:

1. **Desktop program** — a tkinter window launched by `setup_and_run.bat` (Windows) or
   `setup_and_run.command` (macOS). This repo (`monte-carlo-retirement-simulator`) is what
   the user downloads as a ZIP and runs locally. It writes a formatted Excel report and an
   optional CSV.
2. **Interactive web tool** — a self-contained JavaScript + Chart.js implementation embedded
   in the project page (`projects/monte-carlo-simulator.md`). It mirrors the desktop model
   (success probability, percentile fan chart, nominal/real toggle).

## Tech Stack
- Language: Python 3.9+
- GUI: tkinter (standard library)
- Key Libraries: `numpy` (simulation + percentiles), `openpyxl` (Excel report),
  `matplotlib` (embedded fan chart), `pytest` (tests). All pinned in
  `scripts/requirements.txt`.
- Web tool: vanilla JavaScript with Chart.js (loaded from a CDN); Box–Muller normal draws.

## Architecture
Entry point is `scripts/main.py`, which imports `monte_carlo.ui.main`. The package is split
into focused modules so each concern lives in one file:

- `models.py` — `SimulationInputs` / `SimulationResult` dataclasses, `ValidationError`, and
  the branding/UI and numeric-safety constants. No third-party imports, always importable.
- `deps.py` — all optional third-party imports (numpy, openpyxl, matplotlib) guarded in one
  place, with `require_numpy()`, `require_export_deps()`, `require_all_dependencies()`.
- `core.py` — the GUI-free simulation engine (`run_monte_carlo`) and `validate_simulation_inputs`.
  Only needs numpy, so it is the module the tests target directly.
- `export.py` — the Excel report (summary, percentiles, embedded matplotlib chart) and CSV
  export.
- `ui.py` — the tkinter window; runs the simulation on a worker thread with a live status bar
  and writes the workbook when done.

The setup launchers create a local `.venv`, install pinned dependencies into it, then run
`scripts/main.py`. Python is the only thing that can ever be installed system-wide, and only
if it is missing.

## Current Version
v1.0.0

## What Has Been Built
- Modular desktop package (models, deps, core, export, ui) + `main.py`, refactored from the
  original single-file `monte_carlo_simulator.py`.
- Cross-platform setup/launcher files (`setup_and_run.bat`, `setup_and_run.command`) matching
  the Portfolio Rebalancer tool: install Python if needed, build a `.venv`, install deps, run.
- Pinned `requirements.txt` and a `pytest` suite covering the engine and validation.
- README written for non-technical users (download + setup + usage).
- Website download button serves `monte-carlo-retirement-simulator.zip` (a zip of this folder).

## Known Issues
- The engine requires numpy; the Excel/chart report additionally requires openpyxl and
  matplotlib. The desktop run flow checks for all three up front and shows a clear message if
  any are missing (the setup launcher installs them automatically).
- The browser version caps simulations at 2,000 for responsiveness; the desktop version
  allows up to 10,000.

## Next Steps
- Optional: add a test that writes a workbook to a temp path when openpyxl/matplotlib are
  available, to cover the export path end to end.
