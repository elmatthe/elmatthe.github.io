# Monte Carlo Retirement Simulator — Briefing

## What This Project Does
A retirement-planning Monte Carlo simulator that runs many random market paths and reports
how often a plan survives, the spread of outcomes by year, and when failures tend to occur.
It runs two ways from the same model:

1. **Desktop program** — a tkinter window launched by `Setup_and_Run-monte-carlo-retirement-simulator.bat`
   (Windows) or `.command` (macOS). This repo (`monte-carlo-retirement-simulator`) is what
   the user downloads as a ZIP and runs locally. It writes a formatted Excel report and an
   optional CSV.
2. **Interactive web tool** — a self-contained JavaScript + Chart.js implementation in the
   project page (`projects/monte-carlo-simulator.html`, modules in `assets/js/monte-carlo/`). It mirrors the desktop model
   (success probability, percentile fan chart, nominal/real toggle).

## Tech Stack
- Language: Python 3.11-3.14
- GUI: tkinter (standard library)
- Key Libraries: `numpy` (simulation + percentiles), `openpyxl` (Excel report),
  `matplotlib` (embedded fan chart), pinned in `scripts/requirements.txt`. Tests
  (`files/tests/`) use `pytest`, which is a developer dependency only.
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

The `Setup_and_Run-monte-carlo-retirement-simulator` launchers (Windows `.bat`, macOS `.command`) are thin
wrappers around `scripts/bootstrap.py`, rendered from `_tools/bootstrap/` in the website
repository. It follows ASSESS -> RECONCILE -> REPAIR/PROVISION -> PROVE -> LAUNCH -> REPORT:
a repo-root `.venv` is proven healthy (exact pins, real imports, `pip check`) before every
launch, rebuilt from an external Python 3.11-3.14 when stale or broken, and only drifted
packages are reinstalled. Python itself is installed only with consent and only per user
(winget user scope on Windows; Homebrew or python.org on macOS).

## Current Version
v1.1.0

## What Has Been Built
- Modular desktop package (models, deps, core, export, ui) + `main.py`, refactored from the
  original single-file `monte_carlo_simulator.py`.
- Standard one-click bootstrap launchers (`Setup_and_Run-monte-carlo-retirement-simulator.bat`
  / `.command`) with self-repairing `.venv` and per-user Python provisioning.
- Pinned `requirements.txt` and a `pytest` suite (`files/tests/`) covering the engine and validation.
- Browser engine parity with `core.py` is checked by the website's `_tools/tests/` suite.
- README written for non-technical users (download + setup + usage).
- Website download button serves `monte-carlo-retirement-simulator.zip` (a zip of this folder).

## Known Issues
- The engine requires numpy; the Excel/chart report additionally requires openpyxl and
  matplotlib. The desktop run flow checks for all three up front and shows a clear message if
  any are missing (the setup launcher installs them automatically).
- Both versions allow up to 10,000 simulations and apply the same validation rules.

## Next Steps
- Optional: add a test that writes a workbook to a temp path when openpyxl/matplotlib are
  available, to cover the export path end to end.
