# Monte Carlo Retirement Simulator - Setup Guide

This guide is the starter companion for the Monte Carlo Retirement Simulator project. It follows the same practical format as the CPI and Portfolio Rebalancer project guides.

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

When the full Excel output version is used, make sure the target workbook is closed in Excel before running the script.

---

## 3) How to Run the Script

1. Save `monte_carlo_simulator.py` locally.
2. Double-click the script (or run `python monte_carlo_simulator.py` in terminal).
3. Enter your assumptions in the input form.
4. Click **Run Simulation**.

> Note: the current script is a starter scaffold. The full Excel-writing version is planned in the next build steps.

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
2. Run the simulation.
3. Review summary output:
   - probability of success
   - median retirement and final values
   - safe withdrawal rate estimate
4. Compare scenarios by adjusting one assumption at a time.

---

## 5) Understanding the Output

- **Probability of success:** percent of simulations where portfolio does not hit zero before the end of retirement.
- **Percentile bands:** show optimistic, median, and conservative path ranges.
- **Safe withdrawal rate (SWR):** net withdrawal divided by median portfolio at retirement.
- **Nominal vs real values:** nominal values are in future dollars; real values adjust for inflation.

---

## 6) Troubleshooting

| Issue | Likely cause | What to do |
|---|---|---|
| Script does not start | Python not installed or path issue | Install Python 3.10+ and re-run |
| Import error (openpyxl/matplotlib/numpy) | Dependencies missing | Run `pip install openpyxl matplotlib numpy` |
| Inputs rejected | Invalid value in one or more fields | Check that required fields are numeric and positive where required |
| Slow browser simulation | Too many simulation runs | Keep browser run count at or below 2,000 |

---

## 7) Assumptions and Limitations

- Returns are modeled with a normal distribution.
- Taxes are not modeled.
- Sequence-specific spending adjustments are not modeled.
- Output is designed for educational scenario analysis.

**Disclaimer:** This tool is for illustrative and educational purposes only and does not constitute financial advice.
