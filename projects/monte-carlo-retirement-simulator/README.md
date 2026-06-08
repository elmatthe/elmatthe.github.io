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
| Language | **Python 3.9+** | Runs the same on Windows and macOS |
| Window / GUI | **tkinter** | Built into Python — nothing extra to install |
| Simulation math | **numpy** | Fast random draws and percentile calculations |
| Spreadsheet report | **openpyxl** | Writes the `.xlsx` summary, percentiles, and chart sheet |
| Fan chart | **matplotlib** | Renders the percentile chart embedded in the workbook |
| Tests | **pytest** | Proves the simulation engine stays correct |

Everything except Python installs into a self-contained `.venv` folder inside this
project — nothing is installed system-wide, and you can move or delete the folder freely.

---

## Download

**From the website (easiest):**
1. Go to <https://elmatthe.github.io/projects/monte-carlo-simulator/>
2. Click **Download monte-carlo-retirement-simulator.zip**.
3. Unzip it anywhere you like (Desktop, Documents — it doesn't matter).

**From GitHub:** download the folder as a ZIP from the public repository and unzip it.

After unzipping you'll have a `monte-carlo-retirement-simulator` folder containing this
README, the two setup launchers, and the `scripts` / `md-instructions` folders.

---

## Setup & run

You only "set up" once. After that, the same file is your everyday launcher — and it
re-uses the environment it built, so day-to-day starts are quick.

### Windows
1. Double-click **`setup_and_run.bat`**.
2. The first time, if Windows shows *"Windows protected your PC"*, click
   **More info → Run anyway** (this only happens once because the file came from the
   internet).
3. If Python isn't installed, it will ask before installing it. Everything else is set up
   automatically inside the folder.
4. The simulator window opens. To run it again later, just double-click
   **`setup_and_run.bat`** again.

### macOS
1. Double-click **`setup_and_run.command`**.
2. The first time, if macOS blocks it, go to **System Settings → Privacy & Security**,
   scroll down, and click **Open Anyway** (this only happens once).
3. If Python isn't installed, it will ask before installing it (no admin password needed
   for the "just for me" option).
4. The simulator window opens. To run it again later, just double-click
   **`setup_and_run.command`** again.

> If the `.command` file won't run on a fresh download, open Terminal, type
> `chmod +x ` (with a trailing space), drag the file onto the window, and press Enter.

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
  README.md                 <- this file
  setup_and_run.bat         <- Windows setup + everyday launcher
  setup_and_run.command     <- macOS setup + everyday launcher
  md-instructions/
    Briefing.md             <- project overview / context
    Changelog.md            <- version history
  scripts/
    main.py                 <- entry point (opens the window)
    requirements.txt        <- pinned dependencies
    monte_carlo/            <- the program, split into focused modules
      models.py             <- input/result data models + constants
      deps.py               <- optional dependency imports (numpy/openpyxl/matplotlib)
      core.py               <- the simulation engine + input validation
      export.py             <- Excel report + chart + CSV export
      ui.py                 <- the tkinter window
    tests/
      test_core.py          <- tests proving the engine stays correct
```

---

## Disclaimer

This simulator is for illustrative and educational planning use only. It is not financial,
investment, or trading advice, and it is not a guarantee of any outcome. Returns are
modeled as simple normal draws with no taxes, fees, or dynamic spending rules.
