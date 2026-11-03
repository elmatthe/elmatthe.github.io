# Calculation methodology (all four tools)

Dated 2026-11-03. Units, conventions, what changed in this release and what was kept,
known limitations, and the tests that pin each rule. Where a change could alter
previously published results, the old behaviour is the default and the new one is an
explicit option (Monte Carlo spending basis), or the change only blanks/flags a value
that was wrong (CPI current-month end-of-month values). Nothing here is investment advice.

## 1. Portfolio Rebalancer (web `assets/js/portfolio-rebalancer/engine.js`, desktop `portfolio_rebalancer/core.py`)

**Units.** Prices are in the listing's major currency unit (London pence × 0.01). Values
are converted to the reporting currency with official Bank of Canada daily rates (CAD per
unit, ECB as fallback), or rates the user typed: `value = shares × price × fx`.

**Modes and invariants (unchanged).**
- *New Money*: buy-only; buys toward targets are scaled down to fit the budget.
- *Rebalance*: sells fund buys; buys are scaled to fit sell proceeds.
- *Cross-account funding*: warns when buys in one account type are not covered by sells
  in the same account type, or a ticker trades in several accounts.
- Trades within 0.01% of the pool are Hold. Targets are relative and divided by their
  sum (a warning states the divisor when they do not add up to 100%).
- *Rebalance with no sells* (every overweight holding inside the hold band): buys cannot
  be funded and are shown as Hold, with a warning that points to New Money (previously
  they were listed as buys funded by nothing).

**Valuation readiness (new gate, `md.valuation-readiness.v1`).** No actionable plan is
calculated unless every holding that matters (shares > 0 or target > 0) has either a
provider price whose listing currency was confirmed, or a price the user explicitly
supplied (labelled "user-supplied" in the plan and exports). Missing, mismatched,
unverified or too-old prices withhold the plan and the reasons are grouped by cause.
Freshness counts missed weekday sessions since the price's trading date, in the venue's
time zone: 0 = current; 1–3 = stale (the user must accept it); 4+ = too old. Exchange
holidays are not modelled, so a holiday can count as a missed session (conservative).
Zero-share, zero-target rows are "not valued" and never block.

**Whole shares (option, off by default).** Buys and sells are floored to whole shares;
while the floored buys exceed the available cash, the largest buy is reduced by one share;
leftover cash then buys one more share of the holding with the largest remaining
shortfall, repeatedly, while it fits. `cashLeft` is reported. Fractional shares remain the
default (unchanged results).

**Parity.** Same inputs give identical plans in both engines
(`test_engine_parity.py`, `test_financial_reference.py`, `test_market_data_parity.py`).
Python 3.12+ `sum()` uses compensated summation, so the desktop uses a plain left-to-right
sum to match JavaScript bit for bit.

## 2. Stock Comparison & Analytics

**Web (`assets/js/stock-dashboard/analytics.js`).**
- Log returns between consecutive observations, keyed by exact interval (date pair, ISO
  week pair or month pair); P = 252 / 52 / 12 periods per year.
- Annualized return `exp(mean × P) − 1`; volatility `stdev × √P` (sample); Sharpe
  `(mean × P − ln(1 + rf)) / volatility`; max drawdown from the running peak of the
  chosen price basis; OLS beta and alpha of excess log returns against a benchmark.
- Correlations only over identical intervals, at least 3 shared returns, and not defined
  when either series has a standard deviation below 1e-9 (constant series).
- **New:** on unadjusted closes, a one-period ratio within 2.5% of a common split ratio
  (5:4, 4:3, 3:2, 2, 2.5, 3, 4, 5, 8, 10, 20, or their reverses) excludes the series with
  the reason, by default (`excludeSplitLike`), instead of reporting a fictitious crash.
  No synthetic adjustment factors are applied.
- **New:** spans under 182 days mark annualized figures with ≈ and a caveat; a 1-day
  horizon shows no annualized return, volatility or Sharpe (a single return).
- In-progress bars (today, this week, this month) are excluded. Price basis (adjusted
  close = total return where the provider defines it; close = price return) is chosen and
  shown per series.

**Desktop (`Stock-Data-Dashboard-Tool/scripts/analytics.py`, v0.5.0).**
- Each ticker's returns are computed on its **own** price series, so another market's
  holiday no longer deletes its returns (previously the union of dates was used).
- The cumulative-return chart is built from prices, so its last point equals the total
  return in the metrics table.
- Weekly/monthly resampling keeps only **completed** periods, dated by the last trading
  day in the period.
- FX: Bank of Canada daily rates, applied as the latest fixing on or before each price
  date, at most 7 days old (`merge_asof`, backward); no back-fill, so no look-ahead. A
  series that cannot be converted is left out with a warning (previously it was kept in
  its native currency inside a "normalized" comparison).
- Correlation needs at least 3 shared observations and non-zero variance; regression
  against a constant benchmark returns a note instead of a fictitious beta.
- CSV input: duplicate (ticker, date) rows and prices ≤ 0 are rejected. Exports
  neutralise formula injection and include Prices, Returns and Settings.

## 3. Monte Carlo Retirement Simulator (engine 2.0.0, web and desktop)

- Annual simple return r ~ Normal(μ, σ), independent each year. **μ is the arithmetic
  mean**; the typical (median) compound growth is shown as
  `exp(ln(1 + μ) − σ²/(2(1 + μ)²)) − 1` (≈ 6.33% for 7% / 12%).
- Saving years: `V = max(0, V(1 + r) + C)`, contributions at year-end growing by g.
- Retirement years: `V = V(1 + r) − W`, year-end withdrawals; `W` grows with inflation
  each year (so the pension is effectively indexed). Ruin when `V ≤ 0` (a plan ending at
  exactly $0 fails); the path then stays at 0.
- **Spending basis (new, opt-in):** *Retirement-year dollars* (default, unchanged): the
  first-year net withdrawal is `spending − pension`. *Today's dollars*:
  `(spending − pension) × (1 + i)^n`, n = years to retirement, computed by repeated
  multiplication (bit-identical in both engines). Base case: $42,000 today →
  **$88,097.84** in year 1 (the audit's figure of 88,094.70 was an arithmetic slip:
  42,000 × 1.025³⁰ = 88,097.838…).
- Percentiles P10–P90 per year with linear interpolation; real = nominal / (1 + i)^year
  (undefined at −100% inflation). Initial withdrawal rate = first-year net withdrawal ÷
  median portfolio at retirement (the desktop's "Safe Withdrawal Rate" label was wrong).
- **Warnings (new, non-blocking, identical text):** volatility > 30%; P(r < −100%) ≥
  0.01% (Numerical Recipes erfc approximation, error < 1.2e-7), explaining that such a
  year is treated as a total loss; 0 < |μ| < 1 or 0 < σ < 1 (likely 0.07 typed for 7%);
  −100% inflation. Inputs are never capped.
- **Random numbers:** mulberry32 + Box–Muller (cosine branch), seeded; the desktop uses a
  vectorised port (`monte_carlo/rng.py`). Same seed and inputs give the same failed-path
  count, draw count and percentiles to ~1e-15 (libm differences in log/cos); tested on
  Node.js (V8) and CPython on Linux. Seeds s and s + 2·0x6D2B79F5 give overlapping
  streams (documented, not changed: hashing seeds would change published results).
- One number grammar for both apps (ASCII decimal with optional exponent; no hex, NaN,
  Infinity, underscores or non-ASCII digits); the audit's 18 parsing probes match.

## 4. CPI Web Scraper (desktop, v0.4.0)

- Monthly rows dated the first of each month from 1913-01; no interpolation or
  forward-fill. Daily FRED series (DFF, SP500, T10Y2Y) → last valid observation of the
  month; **the current, unfinished month is left blank** for these three columns (it was
  a mid-month value labelled month-end).
- The end month is clamped to the current month (no requests for future months).
- Writes **merge** into the raw sheet: downloaded months replace those months, others are
  kept (a single-month update used to clear the whole history). "Replace all rows" is an
  explicit, confirmed option.
- The tool does not recalculate the model (Decision 004: recalculating in the automation
  session changed dynamic-array spills); the user recalculates in Excel (Ctrl+Alt+F9).
  The public `CPI.xlsx` ships without cached results and recalculates on open.
- Series identities (5 StatCan vectors, 13 FRED IDs) were verified against official
  metadata in the audit (Appendix F.3).

## 5. Known limitations

- Exchange holidays are not modelled in price freshness (Rebalancer).
- Stock: the web app always uses log returns; the desktop offers simple or log returns
  (a setting). Their figures are comparable only on the same return type; each is pinned
  by its own reference tests.
- Monte Carlo: single asset, constant inflation, no taxes or fees, no pension start age.
- CPI: Excel recalculation and COM behaviour are verified only by mocks on Linux; the
  real-Excel regression is opt-in and Windows-only.
