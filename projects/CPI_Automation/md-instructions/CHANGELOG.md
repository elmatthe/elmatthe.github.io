# CPI Dashboard Downloader — Changelog

## v0.2.2 — Fri 06/19/2026
Repo-root cleanup (no app-logic or test-logic changes).
- **Moved the test suite under `files/`.** `tests/test_cpi.py` is now
  `files/tests/test_cpi.py` to keep the repo root clean. The test's importlib
  module-loading path was deepened one level (`parent.parent.parent`) so it
  still resolves `scripts/cpi_dashboard_downloader-v0.2.0.py` from its new
  depth; the tests themselves are unchanged.
- **Pointed the verify gate at the new location.** `scripts/verify.py` now
  discovers tests at `files/tests/` (no `pytest.ini`/`pyproject.toml` exists,
  so the path is driven entirely by `verify.py`). Clean-`.venv` rebuild
  re-run: `verify` PASS, 6/6 tests found and passing from the new path.
- **Gitignored `.pytest_cache/`.** pytest regenerates this cache at the repo
  root on each run; it is now ignored so it never clutters the tracked repo.
- **Docs.** Updated `README.md` and `Briefing.md` to reference the
  `files/tests/` path.

## v0.2.1 — Fri 06/19/2026
Setup-and-run verification & repo hardening pass (no app-logic changes).
- **Dependency inventory verified.** Cross-checked every third-party import
  (`requests`, `python-dateutil`/`dateutil`, `openpyxl`) against
  `scripts/requirements.txt`: all present, all pinned, none unused, none
  missing. No external binaries are required (the only shell-out is to an
  optional `OneDrive.exe`, located via `%LOCALAPPDATA%` and skipped if absent).
- **Added pytest + tests.** Added `pytest==9.1.1` (pinned) to
  `requirements.txt` and a fast, no-network suite at `tests/test_cpi.py`
  covering the date helpers, the 17-column output shape, and a CSV
  round-trip. The suite loads the downloader by path via importlib, which
  also smoke-tests that every third-party import resolves in the venv.
- **Added a verify gate.** New `scripts/verify.py` checks all requirements are
  pinned and runs the pytest suite; exits non-zero on failure.
- **`setup_and_run.bat` confirmed self-contained.** Re-verified there is no
  dependency on any standalone `.ps1` script (inline only). Confirmed the
  Python-already-installed path proceeds straight to venv setup with no
  install prompt, and the missing-Python path uses a Y/N winget
  `--scope user` install. Entry point reference is correct.
- **Clean-venv rebuild tested.** Deleted `.venv` and rebuilt from scratch on
  Python 3.14 via the batch's exact steps (`py -m venv` → pip install from
  `requirements.txt`). All libraries installed, the module imported with no
  errors, and `verify` passed (6/6 tests).
- **Security: gitignored the personal FRED key file.** Added
  `files/fred_api_key.md` to `.gitignore` (it holds a real key in plaintext;
  `files/config.json` was already ignored).
- **Docs.** Rewrote `README.md` around the double-click `.bat` workflow
  (copy without `.venv` → run the batch → click through prompts), replacing
  the old manual "install Python / pip install / Open With Python" steps.
  Updated `Briefing.md` (tech stack, setup/run, tests/verify, version).
- **Skills library:** reviewed `claude-skills-main`; the nearest candidates
  (`dependency-auditor`, `setup`, `senior-qa`) are heavyweight,
  multi-language toolkits that don't fit a 3-dependency single-script repo —
  none were genuinely additive, so none were pulled in.

## v0.2.0 — Thu 06/18/2026
- Verified FRED API key persistence works as intended (loads and saves
  correctly across sessions).
- Script renamed from `cpi_dashboard_downloader-v0.1.6.py` to
  `cpi_dashboard_downloader-v0.2.0.py`. Updated `Setup_and_Run-CPI.bat`,
  `README.md`, and `Briefing.md` to reference the new filename.

## v0.1.7 — Thu 06/18/2026
- Added persistence for the FRED API key between sessions.
- New `load_api_key()` / `save_api_key()` helpers (stdlib `json` +
  `pathlib` only, no new dependencies) read/write `files/config.json`,
  resolved relative to the script's own location (`__file__`) so it works
  regardless of where the `.bat` launches from.
- On launch, `entry_apikey` is pre-filled from `files/config.json` if a
  valid `fred_api_key` is present.
- After a successful download (right before the "Done" messagebox), the
  API key just used is saved to `files/config.json`, overwriting any
  previous value.
- Missing or corrupted `files/config.json` is handled silently — the field
  is just left blank, never a crash.
- Added `files/config.json` to `.gitignore` so a personal API key is never
  committed.

## v0.1.6 — Thu 06/18/2026
- Initial structured commit. Script fully functional.
- Features: StatCan + FRED data fetch, single-month and date-range modes,
  Excel write (xlsm/xlsx), optional CSV export, OneDrive pause/resume.
- Restructured `requirements.txt` from the (empty) repo root into
  `scripts/requirements.txt`, pinned to exact installed versions:
  `requests==2.32.5`, `python-dateutil==2.9.0.post0`, `openpyxl==3.1.5`.
- Rewrote `Setup_and_Run-CPI.bat` to match the current repo layout: launches
  `scripts/cpi_dashboard_downloader-v0.1.6.py`, creates a self-contained
  `.venv` in the repo root, installs from `scripts/requirements.txt`, checks
  for Python and offers a `winget --scope user` install if missing. Dropped
  the old PowerShell-helper indirection (no `.ps1` dependency).
- GUI: added a small muted note below the start-date row — "Data
  availability begins January 1913. Earlier dates will be adjusted
  automatically."
- Start dates earlier than 1913-01 (the earliest month with data across all
  sources) are now silently clamped to 1913-01 before any API calls are
  made — no error or warning dialog.
- `build_rows()` now drops leading rows where every data column is `None`
  (months before the earliest real data point). Rows are kept unfiltered
  again as soon as the first row with real data appears, so the end-date
  row is still always included even if it has no data yet.
