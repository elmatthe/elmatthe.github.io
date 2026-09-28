# Monte Carlo Retirement Simulator

A desktop tool that stress-tests a retirement plan against thousands of possible market
paths. Instead of a single "what if returns are exactly 7%?" projection, it runs many
random simulations and reports how often the plan survives, the range of likely outcomes,
and when failures tend to happen.

It runs in its own window — no spreadsheets to wire up, no terminal commands — and writes
a formatted Excel report (summary, year-by-year percentiles, and a fan chart) plus an
optional CSV. The same model also runs in the browser on the project page, so you can try
it before downloading anything:
<https://elmatthe.github.io/projects/monte-carlo-simulator/>

---

## What it does

- **Two-phase model:** an accumulation phase (saving before retirement) followed by a
  decumulation phase (spending in retirement), simulated year by year.
- **Random annual returns** drawn from a normal distribution using your expected return
  and volatility, so the order-of-returns risk shows up in the results.
- **Planner-focused outputs:** probability of success, median portfolio at retirement and
  at the end, 10th/25th/75th/90th percentile bands, median ruin year, and an implied safe
  withdrawal rate.
- **Excel report** with three sheets — `MC_Summary`, `MC_Percentiles`, and `MC_Chart`
  (an embedded fan chart) — written to a workbook you choose.
- **Optional CSV export** of the percentile table for your own charting.
- **Input validation and overflow checks** so unstable assumptions fail fast with a clear
  message instead of returning misleading numbers.

---

## What's under the hood (the tools it uses)

| Piece | Tool | Why |
|-------|------|-----|
| Language | **Python 3.11–3.14** | Runs the same on Windows and macOS; the launcher finds or installs it |
| Window / GUI | **tkinter** | Built into Python — nothing extra to install |
| Simulation math | **numpy** | Fast random draws and percentile calculations |
| Spreadsheet report | **openpyxl** | Writes the `.xlsx` summary, percentiles, and chart sheet |
| Fan chart | **matplotlib** | Renders the percentile chart embedded in the workbook |

Everything except Python installs into a self-contained `.venv` folder inside this
folder — nothing is installed system-wide, and you can move or delete the folder freely.

---

## Download

1. Go to <https://elmatthe.github.io/projects/monte-carlo-simulator/>.
2. Click **Download monte-carlo-retirement-simulator.zip**.
3. Extract it anywhere you can write to (Desktop, Documents). Don't run it from inside
   the ZIP preview.

You'll get a `monte-carlo-retirement-simulator` folder containing this README, the two setup launchers,
`config.toml` and the `scripts` folder.

---

## Setup & run

One launcher does everything: it checks the folder's private Python environment,
repairs or installs only what is missing, proves it works, then opens the program.
Healthy later launches skip straight to opening the program; no downloads happen.

### Windows
1. Double-click **`Setup_and_Run-monte-carlo-retirement-simulator.bat`**.
2. Because the file was downloaded from the internet, Windows SmartScreen or your
   security software may flag it the first time. If you are unsure whether it is safe to
   run, or if this is a work computer, check with your IT department before continuing.
3. If no suitable Python (3.11–3.14) is found, it asks (Y/N) before installing Python 3.13
   **for your user account only** with `winget`. No administrator rights are needed and
   your PATH is not changed. The Microsoft Store `python.exe` placeholder is never used.
4. The simulator window opens. To run it again later, double-click the same file.

### macOS
1. Double-click **`Setup_and_Run-monte-carlo-retirement-simulator.command`**.
2. The first time, macOS may say it "cannot be opened". Open **System Settings → Privacy &
   Security** and click **Open Anyway** (on a work computer, check with IT first).
3. If no suitable Python with tkinter is found, it offers a numbered menu: install with
   Homebrew (`python@3.13` + `python-tk@3.13`), or open the python.org download page.
4. The simulator window opens. To run it again later, double-click the same file.

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
  On Windows run e.g. `Setup_and_Run-monte-carlo-retirement-simulator.bat --venv-check`; on macOS
  `./Setup_and_Run-monte-carlo-retirement-simulator.command --venv-check`.

The full illustrated guide, including troubleshooting, is at <https://elmatthe.github.io/projects/monte-carlo-guide/>.

---

## How to use it

1. **Enter your assumptions** — current portfolio, annual contribution (and optional
   growth), years to and in retirement, expected return, volatility, inflation, annual
   spending, and any pension/CPP/OAS income.
2. **Set the number of simulations** (more = steadier estimates, slower runs).
3. **Choose a target `.xlsx` workbook** (and optionally a CSV path).
4. Click **Run Simulation**. The run happens on a background thread with a live status
   bar, then the workbook is written/updated with the summary, percentiles, and chart.

Open the workbook to review: probability of success, the percentile table, and the
fan chart with a retirement marker.

---

## Folder layout

```
monte-carlo-retirement-simulator/
  README.md                                   <- this file
  Setup_and_Run-monte-carlo-retirement-simulator.bat      <- Windows setup + launcher
  Setup_and_Run-monte-carlo-retirement-simulator.command  <- macOS setup + launcher
  config.toml                                 <- supported Python range + entry point
  scripts/
    bootstrap.py            <- assess / repair / prove / launch logic used by the launchers
    main.py                 <- entry point (opens the window)
    requirements.txt        <- pinned dependencies
    monte_carlo/            <- the program, split into focused modules
      models.py             <- input/result data models + constants
      deps.py               <- dependency import checks (numpy/openpyxl/matplotlib)
      core.py               <- the simulation engine + input validation
      export.py             <- Excel report + chart + CSV export
      ui.py                 <- the tkinter window
  files/                    <- created on first run: setup logs, temp files, state
```

The source repository also contains `files/tests/` (pytest suite) and `md-instructions/`
(briefing and changelog); they are not part of the user download.

---

## Disclaimer

This simulator is for illustrative and educational planning use only. It is not financial,
investment, or trading advice, and it is not a guarantee of any outcome. Returns are
modeled as simple normal draws with no taxes, fees, or dynamic spending rules.
