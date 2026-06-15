# Monte Carlo Retirement Simulator — Changelog

## v1.0.1 — Mon 06/15/2026
- Fixed the Windows launcher: `setup_and_run.bat` failed at `Checking for Python...`
  with `: was unexpected at this time.` Literal parentheses inside parenthesized
  `if (...)` blocks were parsed by cmd as command groups; replaced/removed them so the
  block parses correctly. Also replaced security-prompt-bypass wording with neutral
  guidance in the launchers and README.
- Fixed dependency install on current Python versions: bumped `numpy` `2.1.3` -> `2.4.6`
  and `matplotlib` `3.9.2` -> `3.10.9`. The older pins had no prebuilt wheels for newer
  Python, so pip tried to compile numpy from source and failed (no C compiler / Visual
  Studio). The new versions ship wheels (same stack the Stock Data Dashboard uses).
- Added a "Load Sample Scenario" button to the desktop app, matching the web simulator.
  Both now fill the inputs with randomized-but-plausible values on each click instead of
  one fixed scenario.

## v1.0.0 — Mon 06/08/2026
- Restructured the simulator into a clean, downloadable repo
  (`monte-carlo-retirement-simulator`) matching the Portfolio Rebalancer tool, with a minimal
  root: `README.md`, `setup_and_run.bat`, `setup_and_run.command`, plus `md-instructions/`
  and `scripts/` folders.
- Split the original single-file `monte_carlo_simulator.py` into focused modules under
  `scripts/monte_carlo/`:
  - `models.py` — data models, `ValidationError`, and shared constants
  - `deps.py` — guarded optional imports (numpy/openpyxl/matplotlib) + dependency checks
  - `core.py` — the simulation engine and input validation (numpy only; testable in isolation)
  - `export.py` — Excel report (summary/percentiles/chart) and CSV export
  - `ui.py` — the tkinter window
  - `main.py` — entry point
- Added cross-platform setup launchers: install Python only if missing, build a local
  `.venv`, install pinned dependencies, and run the tool. The same file re-launches the tool
  on later runs.
- Pinned all dependencies in `scripts/requirements.txt` (`numpy==2.1.3`, `openpyxl==3.1.5`,
  `matplotlib==3.9.2`, `pytest==8.3.4`).
- Added a `pytest` suite covering result shape, percentile ordering, success-probability
  bounds, seeded determinism, and the validation rules.
- Wrote a non-technical README covering the tools used, download from the website/GitHub,
  setup, and usage.
- Website: the project-page download button now serves
  `monte-carlo-retirement-simulator.zip` (a zip of this folder) instead of a single `.py`
  file.

### Inherited from the previous Monte_Carlo_Simulator build
- Two-phase (accumulation + decumulation) annual Monte Carlo model with normal return draws.
- Probability of success, percentile bands, median ruin year, and safe withdrawal rate.
- Formatted Excel report with summary, percentiles, and an embedded fan chart, plus optional
  CSV export.
- Threaded execution with a live status bar and full input validation / overflow safety.
