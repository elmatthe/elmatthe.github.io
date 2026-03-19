# Monte Carlo Retirement Simulator - Detailed Setup and Methodology Guide

This guide explains **exactly how the tool works**, the logic and theory behind each output, and how to use the results for better retirement-planning decisions.

---

## 1) What this tool is designed to answer

A retirement plan is not a single path problem. Markets are uncertain, and the order of returns matters.

This simulator answers:

- "How often does my plan survive under many possible market paths?"
- "How wide is the range of potential outcomes?"
- "When failures happen, how early do they typically happen?"
- "How sensitive is success to my assumptions (return, volatility, spending, contribution)?"

Instead of one deterministic projection, the model runs many simulations and evaluates the full distribution of outcomes.

---

## 2) Core modeling framework

The model is a two-phase annual simulation:

1. **Accumulation phase** (before retirement)
2. **Decumulation phase** (during retirement)

Each simulation is one possible market path. Across all paths, the model computes percentile bands and success/failure statistics.

### 2.1 Annual return model

Each year return is sampled from a normal distribution:

```text
r_t ~ Normal(mu, sigma)
```

Where:

- `mu` = expected annual return input (converted from % to decimal)
- `sigma` = annual volatility input (converted from % to decimal)

This is a practical, widely used approximation for planning tools. It is useful for scenario analysis, but does not perfectly model all real-world tail behavior.

### 2.2 Accumulation dynamics

For each pre-retirement year:

```text
Portfolio_t = Portfolio_(t-1) * (1 + r_t) + Contribution_t
Contribution_t+1 = Contribution_t * (1 + contribution_growth_rate)
```

Interpretation:

- portfolio grows or shrinks with market return
- annual contribution is added
- contribution can grow over time (for example, with salary growth)

### 2.3 Decumulation dynamics

Net withdrawal is:

```text
Net Withdrawal = Annual Spending - Pension Income
```

For each retirement year:

```text
Portfolio_t = Portfolio_(t-1) * (1 + r_t) - Net Withdrawal
```

Ruin rule:

- if `Portfolio_t <= 0`, the path is marked failed
- portfolio is set to `0`
- all remaining years for that path stay at `0`

This gives a clear and consistent definition of failure.

### 2.4 Success and distribution statistics

After all simulations:

- **Probability of Success** = fraction of paths that never hit zero during retirement
- **Failed simulations** = paths that did hit zero at least once
- **Median Ruin Year** = median retirement year among failed paths
- **Percentile bands by year** = P10, P25, P50, P75, P90 across all paths

These yearly percentiles are what drive the fan chart and percentile tables.

---

## 3) Inputs: precise meaning and effect

### Current Portfolio Value ($)
Starting value at simulation year 0.

### Annual Contribution ($)
Amount added each accumulation year.

### Contribution Growth Rate (% / yr)
Annual growth applied to contribution amount each year before retirement.

### Years to Retirement
Number of accumulation years.

### Years in Retirement
Number of withdrawal years evaluated.

### Expected Annual Return (%)
Mean annual return for random sampling.

### Annual Volatility / Std Dev (%)
Standard deviation of annual returns. Higher values increase outcome dispersion and sequence risk.

### Inflation Rate (%)
Used for inflation-adjusted (real) views in web output and interpretation context.

### Annual Retirement Spending ($)
Target annual spending during retirement.

### CPP / OAS / Pension Income ($ / yr)
Income that offsets spending need. Higher value lowers net withdrawal and usually improves success odds.

### Number of Simulations
How many random paths to run.

- More simulations = more stable estimates
- Fewer simulations = faster runs but noisier estimates

---

## 4) Validation and numerical safety rules

The tool rejects invalid or unstable configurations before running:

- required fields must be numeric
- minimum/maximum bounds for years, rates, volatility, and simulation count
- monetary values must be finite and within safe magnitude limits
- overflow / non-finite math detection during simulation loops

Why this matters:

- prevents misleading outputs caused by numeric overflow (`inf`/`nan`)
- ensures the reported success rate is mathematically valid

If instability is detected, the tool fails fast with a clear error message instead of returning unreliable results.

---

## 5) Desktop workflow (Python app)

### 5.1 One-time setup

Install Python 3.10+ and dependencies:

```bash
pip install openpyxl matplotlib numpy
```

### 5.2 Running the app

1. Download `monte_carlo_simulator.py`
2. Run:
   ```bash
   python monte_carlo_simulator.py
   ```
3. Enter assumptions
4. Select target `.xlsx` workbook
5. Optional: enable CSV export and choose output path
6. Click **Run Simulation**

The app runs simulations in a background thread and shows progress/status updates.

---

## 6) Output structure and what each artifact means

### 6.1 `MC_Summary`

Contains:

- input assumptions used in the run
- probability of success
- median retirement portfolio
- median/final percentiles
- failed simulation count
- median ruin timing
- safe withdrawal rate

Use this sheet as an executive summary of plan feasibility under uncertainty.

### 6.2 `MC_Percentiles`

Year-by-year table for P10/P25/P50/P75/P90.

Use this sheet to inspect trajectory shape and downside/upside spread over time.

### 6.3 `MC_Chart`

Embedded fan chart:

- P10-P90 outer band
- P25-P75 inner band
- P50 median line
- retirement marker

Use this chart to communicate uncertainty visually and compare scenario runs.

### 6.4 Optional CSV export

Exports the percentile table with dates (year offsets from today). Useful for downstream analysis or custom charting.

---

## 7) How to interpret results correctly

### 7.1 Probability of success

This is not a guarantee. It is the share of simulated paths that survive under your assumptions.

- high value: plan appears robust under modeled uncertainty
- low value: plan is fragile to adverse return sequences

### 7.2 Percentile fan interpretation

- **P50**: central tendency, not "most likely exact path"
- **P10/P25**: downside bands (stress-side context)
- **P75/P90**: upside bands

Widening bands over time indicate compounding uncertainty.

### 7.3 Median ruin year

Shows *when* failures tend to occur, not just whether they occur.

- early ruin -> severe near-retirement vulnerability
- late ruin -> plan works for a long time but may fail at tail end

### 7.4 Safe Withdrawal Rate (SWR)

Computed as:

```text
SWR = Net Withdrawal / Median Portfolio at Retirement
```

SWR is scenario-dependent and should be treated as a planning signal, not a universal rule.

---

## 8) Insight types this tool can provide

You can use this model to quantify:

1. **Feasibility gap**
   - Is current contribution/spending balance enough?
2. **Sequence-of-returns sensitivity**
   - How much downside timing risk hurts drawdown years
3. **Volatility fragility**
   - How success changes when sigma rises
4. **Retirement timing impact**
   - How delaying retirement shifts success odds
5. **Spending discipline effect**
   - How spending reductions improve tail outcomes
6. **Pension bridge value**
   - How external income improves resilience

Best practice: run controlled scenario sets by changing one assumption at a time.

---

## 9) Recommended scenario analysis workflow

1. **Base case**
   - realistic assumptions for your current plan
2. **Conservative case**
   - lower return, higher volatility, higher spending
3. **Optimistic case**
   - higher return, lower volatility
4. **Policy levers**
   - raise contribution, reduce spending, delay retirement

Compare:

- success probability
- median ruin year (if failures exist)
- percentile spread at retirement and end horizon

---

## 10) Troubleshooting

| Issue | Meaning | Action |
|---|---|---|
| Workbook appears open | Excel lock prevents save | Close workbook and rerun |
| Non-finite/overflow error | Inputs too extreme for stable arithmetic | Reduce very large values and rerun |
| Dependency import error | Missing libraries | `pip install openpyxl matplotlib numpy` |
| Slow runtime | Large simulation count/horizon | Reduce runs or years for faster iteration |

---

## 11) Assumptions and limitations

- annual returns modeled as normal draws
- no taxes, fees, or dynamic spending rules
- no asset-class-level factor modeling
- no regime switching or fat-tail calibration

This is a **decision-support and education tool**, not a guarantee engine.

---

## 12) Important disclaimer

This simulator is for illustrative and educational planning use only.  
It is **not** financial advice, investment advice, or a recommendation to take any specific action.
