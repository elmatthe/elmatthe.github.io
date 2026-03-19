# Monte Carlo Retirement Simulator - Setup Guide

This guide supports the full desktop Monte Carlo Retirement Simulator workflow. It follows the same practical format as the CPI and Portfolio Rebalancer project guides.

---

## 1) What Does This Tool Do?

The simulator runs many market return scenarios to estimate how likely a retirement plan is to sustain withdrawals over time.

The workflow has two phases:

1. **Accumulation:** your portfolio grows with market returns and annual contributions.
2. **Retirement drawdown:** your portfolio continues to evolve while annual spending is withdrawn (net of pension income).

Outputs focus on planning-friendly metrics such as probability of success, median outcomes, and percentile bands.

---

## 2) Before You Use It - One-Time Setup

### Step 1: Check Python installation

Open a terminal and run:

```bash
python --version
```

If Python is not installed, install Python 3.10+ first.

### Step 2: Install required libraries

```bash
pip install openpyxl matplotlib numpy
```

### Step 3: Download project files

From the project page, download:

- `monte_carlo_simulator.py`
- `Monte_Carlo_Setup_Guide.md`

### Step 4: Keep workbook closed while writing results

The simulator writes directly into your selected workbook and creates/overwrites:

- `MC_Summary`
- `MC_Percentiles`
- `MC_Chart`

Keep the target workbook closed in Excel while the script runs.

---

## 3) How to Run the Script

1. Save `monte_carlo_simulator.py` locally.
2. Double-click the script (or run `python monte_carlo_simulator.py` in terminal).
3. Enter your assumptions in the input form.
4. Choose a target `.xlsx` workbook.
5. (Optional) check **Also export to CSV** and select a `.csv` output path.
6. Click **Run Simulation**.

---

## 4) Using the Program - Step by Step

1. Enter core assumptions:
   - current portfolio
   - annual contribution and growth
   - years to retirement
   - years in retirement
   - expected return and volatility
   - inflation
   - annual spending
   - pension income
   - simulation count
2. Select the workbook destination.
3. Optional: enable CSV export and choose path.
4. Run the simulation.
5. Open the workbook and review:
   - `MC_Summary` for key assumptions and output stats
   - `MC_Percentiles` for year-by-year percentile bands
   - `MC_Chart` for embedded fan chart image
6. Compare scenarios by adjusting one assumption at a time.

---

## 5) Understanding the Output

- **Probability of success:** percent of simulations where portfolio does not hit zero before the end of retirement.
- **Percentile bands:** show optimistic, median, and conservative path ranges.
- **Safe withdrawal rate (SWR):** net withdrawal divided by median portfolio at retirement.
- **Nominal vs real values:** nominal values are in future dollars; real values adjust for inflation.
- **Ruin year metric:** when failures occur, median ruin year shows when depletion typically happens in retirement.

---

## 6) Troubleshooting

| Issue | Likely cause | What to do |
|---|---|---|
| Script does not start | Python not installed or path issue | Install Python 3.10+ and re-run |
| Import error (openpyxl/matplotlib/numpy) | Dependencies missing | Run `pip install openpyxl matplotlib numpy` |
| Inputs rejected | Invalid value in one or more fields | Check that required fields are numeric and positive where required |
| Workbook save fails | Workbook open in Excel | Close workbook in Excel and run again |
| Slow desktop simulation | Very high simulation count | Reduce run count (e.g. 1,000-5,000) for faster turnaround |

---

## 7) Assumptions and Limitations

- Returns are modeled with a normal distribution.
- Taxes are not modeled.
- Sequence-specific spending adjustments are not modeled.
- Output is designed for educational scenario analysis.

**Disclaimer:** This tool is for illustrative and educational purposes only and does not constitute financial advice.
