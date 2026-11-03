# Appendix C — Stock Comparison & Analytics Tool (browser and desktop)

**Status.** Sub-audit by the Stock-tool workstream, 2026-11-03, HEAD `ada2ceb`.

**Lead-auditor code checks.** I confirmed D1, D2 and D3 by reading the code:
- D1 and D2: `analytics.py:24-37,114-122` builds one frame on the union of all dates, and `pct_change(fill_method=None)` leaves gaps; `plots.py:37` uses `fillna(0)` before `cumprod`.
- D3: `data_sources.py:283-289` keeps the current period with `resample("W-FRI"/"ME").last()`.
- B3 is the same defect as AV-01/AV-02 in the main report.

**Artefacts.** In the scratchpad at `audit/stock/`:
- `make_fixtures.py`, `run_browser.mjs`, `run_desktop.py`, `reference.py` → `compare.md`
- `desktop_extra.py`, `browser_extra.mjs`, `verify_export.py`, `sharpe_mc.py`
- `ui_audit.js` → `ui_report.json` and `screenshots/`

**Labels used below:**
- **Confirmed:** reproduced with numbers.
- **Risk:** proven from the code.
- **Modelling difference:** both choices are defensible.
- **UNVERIFIED**

## C.1 Test suites (exact counts)

| Suite | Result |
|---|---|
| Node unit | 79 / 79 |
| `test_analytics_reference.py` | 6 passed |
| `_tools/tests -m "not e2e"` | 56 passed, 6 deselected |
| Desktop `files/tests` | 45 passed |
| `stock.test.js` | 56 / 56 |
| `pages.test.js` | 139 / 139 |

None of these suites covers the defects below.

Versions: Node 22.23.4, pandas 3.0.3, numpy 2.4.6, scipy 1.17.1, openpyxl 3.1.5, yfinance 1.7.0.

## C.2 Formulas and conventions

Browser code is in `assets/js/stock-dashboard/analytics.js`; desktop code is in `scripts/analytics.py`.

| Item | Browser | Desktop | Note |
|---|---|---|---|
| Returns | Log returns per series between consecutive observations; prices ≤ 0 skipped (`:105-125`) | Simple returns by default, log optional, computed on a **union-of-dates frame** (`:26-37, 115-122`) | Log vs simple is a modelling difference; the union frame is **D1** |
| Periods per year | 252 / 52 / 12 | Same | — |
| Annualized return | `exp(mean×P)−1` (`:183`) | `(1+TR)^(P/n)−1` with n = non-NaN returns (`:134-137`) | Identical when n is the same; both count returns, not elapsed sessions (B8) |
| Volatility | Sample sd × √P | Same | — |
| Sharpe | `(mean_log×P − ln(1+rf))/vol` (`:192`) | `(mean − rf/P)/sd×√P` (arithmetic) | Modelling difference (SPYX 3M: 3.413 vs 3.492) |
| Max drawdown, total return | — | — | Exact match; both start at the first close on or after the window start (B7) |
| Correlation | Pearson over identical intervals; n ≥ 3; n shown (`:132-174`) | pandas `corr()` on the union frame with `min_periods=1` (`:182-183`) | D8 |
| Regression | OLS on excess log returns; p-value matches scipy to ≤ 1.2e-9 (`:262-291`) | OLS with SE, t, p (`:186-229`) | Benchmark choice: auto in the browser (`app.js:591`, falls back to the **last** ticker); typed in the desktop (default "SPY", falls back to the first ticker) |
| Unfinished periods | Excluded: today's daily bar, this ISO week on weekdays, this month (`:71-84`; `market-data/index.js:67-74`) | **Kept** by `W-FRI` / `ME` resampling (D3) | — |
| FX | BoC → ECB; latest fixing ≤ 7 days old, others dropped; unconvertible series excluded (`fx-align.js`) | Yahoo `=X`, `ffill().bfill()` with no limit; unconvertible series stay native (D6) | — |
| GBp | ×0.01 for GBX, GBp, ZAC, ZAc, ILA | Same on the Yahoo path; offline CSV converts only if every row is GBp/GBX (D13) | — |
| Price basis | Live daily = as-traded close (AV `TIME_SERIES_DAILY`; daily adjusted is premium); weekly = AV adjusted close | yfinance `auto_adjust=False` (Close and Adj Close) | — |

## C.3 Engine parity on deterministic fixtures

**Fixtures** (2025-10-01 to 2026-11-03; now = 2026-11-03T15:00Z; rf = 4 %):

| Ticker | Feature |
|---|---|
| SPYX | NYSE calendar, quarterly dividend |
| SPLITX | 3-for-2 split on 2026-09-14 |
| HYETF | 1 % monthly distribution |
| GAPPY | 6 missing days |
| FLAT | Constant price (10) |
| XIU.TO | TSX calendar, CAD |
| TSCO.L | LSE calendar, GBp |

FX pairs (CADUSD, GBPUSD) are on Bank of Canada days. The weekly and monthly files include the unfinished current period.

**Browser vs numpy/scipy reference.** Worst difference **1.24e-9** across six scenarios (1Y daily adjusted, 3M close, 3M adjusted, USD-normalized, weekly, monthly). This covers every metric, every correlation with its count, and OLS beta, alpha, R² and p.

**Desktop vs reference.** Weekly, monthly and single-calendar runs match exactly. Mixed-calendar daily runs do not (D1):

| Ticker | n (ref / desktop) | Annualized (ref → desktop) | Sharpe (ref → desktop) |
|---|---|---|---|
| SPYX | 249 / 242 | 16.95 % → 17.48 % | 0.801 → 0.353 |
| GAPPY | 243 / 230 | 7.02 % → 7.43 % | 0.235 → −0.307 |
| XIU.TO | 249 / 242 | 10.57 % → 10.89 % | 0.432 → 0.278 |
| TSCO.L | 251 / 246 | 28.20 % → 28.85 % | 1.146 → 0.733 |

- SPYX loses returns on the seven NYSE holidays when the TSX or LSE traded.
- "Data Completeness" shows 97.3 % for series that are complete.
- Adding XIU.TO changes the SPYX/HYETF correlation from 0.7331 to 0.7426.

**Correlation conventions:**

| Pair | Browser (exact intervals) | Desktop | Common-date textbook |
|---|---|---|---|
| SPYX / XIU.TO | 0.7451 (n 234) | 0.7522 (n 232) | 0.7098 (n 244) |

The browser drops about 4 % of returns across mismatched calendars (B9, modelling difference).

**Constant benchmark (FLAT, rf 4 %).** Both engines report a meaningless beta: browser −3.05 (alpha +49 %), desktop 8.13 or −16.25.
- Σ(x−x̄)² = 4.6e-38, not exactly 0, so `if(!sxx)` (`analytics.js:275`) and `x_var==0` (`analytics.py:206`) never trigger. scipy refuses the same input.
- With rf = 0 the desktop raises `ValueError` and **the whole analysis aborts** (`main.py:550-553`).
- These are **B2 / D4**.

## C.4 Desktop defects (beyond D1)

- **D2 (High, Confirmed).** The cumulative-return chart replaces gaps with 0 (`plots.py:37`). Chart end values are 8.3 %, −40.9 %, 7.3 % and 17.5 %, against table values of 16.7 %, −33.2 %, 10.4 % and 28.1 %.
- **D3 (Medium-High, Confirmed).** Weekly and monthly runs keep the unfinished current period, dated in the future: 2026-11-06 for weekly, 2026-11-30 for monthly.
  - SPYX monthly annualized: 18.90 % instead of 24.47 %.
  - The defaults are Monthly with end = today (`main.py:201-203`).
  - The offline-CSV end date is inclusive (`data_sources.py:344`) while yfinance's is exclusive.
- **D5 (Medium, Confirmed).** Exports contain no prices, returns, dates or settings.
  - An offline-CSV Currency cell `=HYPERLINK(...)` is written by openpyxl as a **formula**.
  - Warnings starting with `=` are also written as formulas, and raw into CSV.
- **D6 (Medium, Confirmed).** FX is `ffill().bfill()` with no limit.
  - This creates look-ahead: 2025-12-29 and 12-30 prices get the 2026-01-05 rate.
  - An 83-day-old rate was used without warning.
  - Unconvertible series (ARS, unknown) stay native, but the note still says "all series converted to USD" (`main.py:531`).
- **D7 (Medium, Confirmed).** CSV import accepts duplicate dates (a fake +81.8 % return) and prices ≤ 0 (giving a −145 % drawdown).
- **D8 (Low-Medium).** `min_periods=1`: two shared returns give a correlation of ±1.00, which then triggers a diversification flag.
- **D9 (Low-Medium).** The risk-free field is unitless and unbounded, so "4" means 400 % (`main.py:443`).
- **D11 / D12 (Low).** The desktop README "Limitations" section and `md-instructions/Briefing.md` describe the web tool as using Yahoo FX and CORS proxies, which is stale. The default benchmark "SPY" is not a default ticker.
- **D13 (Low).** In offline CSV, mixed GBp and GBP rows end up labelled "GBP".

## C.5 Browser defects and risks

- **B1 (High, Confirmed).** Live windows up to 135 days use **as-traded daily closes**. 1D, 1M and 3M are daily; 6M and longer, including YTD after 16 May, are weekly adjusted (`index.js:79, 114-116`).
  - The large-move flag fires only for |log return| > ln 1.8 (`analytics.js:26, 128-130`), so 3-for-2 (−33 %) and 5-for-4 (−20 %) splits are not flagged.
  - SPLITX over 3M shows total return −33.29 %, annualized −80.2 %, volatility 91 % and max drawdown −46.2 % with **no warning**. The true figures are +0.06 %, +0.24 %, 29.9 % and −19.3 %.
  - Distributions are also lost. HYETF over 3M: total return 9.77 %, annualized 45.2 %, Sharpe 2.27 on closes, against 13.13 %, 63.8 % and 3.49 adjusted.
  - The same ticker therefore changes basis and frequency between the 3M and 1Y horizons, even though each result is labelled correctly.
- **B2 (Medium).** Constant-benchmark regression; see C.3.
- **B3 (Medium, Confirmed).** The Alpha Vantage burst notice is classified as daily, and the block is persisted.
  - Here the status pill stays green, reading "about 7 of 25 used" (`app.js:164`).
  - The block survives a reload, "Clear cached responses" and re-entering the same key.
  - This is the same defect as AV-01/AV-02.
- **B4 (Medium).** Very short spans are annualized: a 1D −2.2 % shows as −99.6 % annualized, and +1 % as +1,127 %.
- **B5 (Medium).** The demo shows four false "provider did not confirm the listing currency" warnings. Demo series lack `currencyVerified` (`app.js:381`), and the warning checks for it (`:428`).
- **B6 (Medium).** Request budget:
  - US ticker: 2 requests. `.TO`: 2–3. Unknown ticker: 2, repeated every hour.
  - Ten new tickers at 1Y: 21. Then switching to 3M: +10, so 31 in total.
  - Worst case for one comparison: 30 (> 25).
  - The page copy says "two requests" per ticker, and there is no pre-run estimate.
- **B7 (Low-Medium).** The window starts at the first close on or after the start date, instead of the last close on or before it.
- **B8 / B13 (Low).** Annualization counts returns, not elapsed sessions. GAPPY would show 6.85 %.
- **B9 (Low, modelling).** Exact-interval correlation drops about 4 % of returns across calendars. Offer a common-date mode.
- **B10 (Low).** Export gaps:
  - Only normalized prices are exported, with no native price, FX rate or fixing date.
  - Dropped rows are counted but not listed.
  - Dates are stored as text.
  - The sanitizer misses LF and the full-width `＝＋－＠`.
  - The XLSX apostrophe shows as a visible character.
- **B11 (Medium, UX).** Inner horizontal scroll of the metrics table:

  | Viewport | Table / box |
  |---|---|
  | 1366 | 1142 px in 1104 px |
  | 1280 | 1142 px in 1104 px |
  | 1024 | 887 px |
  | 853 | 726 px |
  | 768 | 646 px |
  | 390 | 299 px box; only 3 of 10 columns visible |

  Also at 390 px:
  - The correlation table, regression table and tab strip scroll; the Export and Settings tabs are off-screen.
  - With 7 tickers, the legend is 98 px tall and the plot area only 78 px.
  - The `n=` labels are 11.5 px.
- **B12 (Low).** Tickers that cover only part of the window are still ranked.

**Browser export reproducibility (good).** Every figure in the browser workbook can be recomputed from its raw sheet, with the stated rf and P, to ≤ 9.1e-15 (`verify_export.py`).

**Request handling mid-run.** A limit reached mid-run still serves cached tickers. Uncached tickers fail without making a request, and a partial result is shown if at least 2 tickers succeed. The skipped-ticker messages do not name the ticker.

**UI positives.**
- Loading states work: "Loaded 1 of 3…", per-ticker chips, progress, Cancel.
- Controls are labelled and live regions exist.
- The focus outline is 3 px and contrast is ≥ 6.3:1.

**UI gaps.**
- Charts have no text alternative.
- Headings jump from h2 to h4.
- Tab panels are not focusable.

## C.6 Sampling noise (why short-horizon Sharpe ratios mislead)

Simulation with i.i.d. returns, true Sharpe 1, true volatility 20 %. The annualized Sharpe's 5–95 % range:

| Window | Range |
|---|---|
| 1M | [−4.8, 7.3] |
| 3M | [−2.2, 4.5] |
| 1Y | [−0.5, 2.8] |
| 3Y | [0.15, 2.07] |

Volatility from 51 weekly returns has about 10 % relative error, against about 4.5 % from 252 daily returns.

Recommendation: show a sample-size caveat, and suppress annualized figures below 6 months (R10).

## C.7 Parity matrix

| Area | Rating | Reason |
|---|---|---|
| Inputs and validation | Browser superior | Strict validation; desktop allows 20 tickers |
| Date window | Equivalent | Desktop takes free dates; browser shows the actual window |
| Data source | Technically restricted | Browser: visitor's own Alpha Vantage key, CSV or demo. Desktop: yfinance (unofficial) |
| Frequency choice | Desktop superior | Browser frequency is dictated by the free tier |
| Price basis | Desktop superior; browser needs remediation | B1 |
| Return metrics | Desktop needs remediation | D1 |
| Unfinished periods | Desktop needs remediation | D3 |
| Correlation | Browser superior | Exact intervals with n shown |
| Regression | Desktop superior on features | Pairwise mode; both need the zero-variance fix |
| Charts | Desktop superior | Rolling and scatter charts; but the cumulative chart is wrong (D2) |
| Exports | Browser superior on data; desktop on images | D5 |
| CSV import | Browser superior | D7 |
| Currency handling | Browser superior | D6 |
| GBp | Equivalent | Desktop offline-CSV gap |
| Indexes and international | Technically restricted (browser) | Indexes are premium on Alpha Vantage; 7 suffixes only |
| Snapshot | Missing in desktop | — |
| Rolling charts, pairwise regression | Missing in browser | — |
| Offline mode | Equivalent | — |
| Caching | Browser superior | — |
| Error handling | Browser superior | B3 needs remediation |
| Risk-free input | Browser superior | D9 |
| Methodology text | Browser superior | D12 |

## C.8 Remediation items

| ID | Severity | Fixes | Files | Fix | Acceptance |
|---|---|---|---|---|---|
| R1 | High | D1, D2 | `analytics.py:26-37,115-122`, `plots.py:37` | Per-ticker returns on each ticker's own non-NaN series, with Observations and Completeness computed from it. Cumulative chart built from prices. | SPYX n = 249 and 16.95 %, unchanged when XIU.TO is added; the chart ends at the table's total return. New `test_calendar_alignment.py`. |
| R2 | High | B1 | `index.js`, `analytics.js:26`, `app.js` | Adjust short-window daily closes (corporate-action data, free-tier availability UNVERIFIED, or the weekly adjClose/close factor). Fallback: detect split-like ratios (1.25, 1.5, 2, 3, 4, 5, 10 and their inverses) and exclude the ticker with a message. Add a "price return" badge. | SPLITX 3M ≈ 0 % or excluded with a message |
| R3 | Medium-High | D3 | `data_sources.py:283-289,344` | Drop incomplete bins; label bins by the last trading date; exclusive end date | SPYX monthly 24.47 % |
| R4 | Medium | B2, D4 | `analytics.js:262-291`, `analytics.py:186-229`, `main.py:550-553` | Relative-tolerance variance check reporting "benchmark has no variance"; never abort the run; skip zero-variance series as auto-benchmark | — |
| R5 | Medium | B3 | (main report SS-01 / AV-01) | Burst-first classification; exhausted state shown in the pill with its reset time; retry; ticker names in messages | — |
| R6 | Medium | D5 | `exports.py` | Prices, Returns and Settings sheets; neutralize `= + - @ \t \r \n` and full-width forms | — |
| R7 | Medium | D6 | `analytics.py:40-112` | No back-fill; forward-fill at most 7 days with warnings; exclude unconvertible series; honest note | — |
| R8 | Medium | D7, D13 | `data_sources.py` | Reject prices ≤ 0 and duplicate (ticker, date) rows, with file and line; handle ZAc and ILA | — |
| R9 | Medium | B5 | `app.js:381` | Demo series carry `currencyVerified: true` | — |
| R10 | Medium | B4 | `analytics.js`, `app.js` | Suppress or caveat annualized figures, Sharpe and alpha under 6 months; always for 1D | — |
| R11 | Medium | B6 | `app.js`, `index.js`, page copy | Request estimate before a run; correct the "two requests" copy | — |
| R12 | Low-Medium | B7 | `analytics.js:43-54,94` | Use the last close on or before the window start | — |
| R13 | Low-Medium | D8 | `analytics.py` | `corr(min_periods=3)` and show counts | — |
| R14 | Low-Medium | D9 | `main.py` | Label the risk-free field "% per year" and validate it | — |
| R15 | Medium | B11 | `stock-dashboard.css:74,151,172-188` | No inner horizontal scroll at 1024–1366 px; cards below 760 px; legend toggle above 4 series; `n=` labels ≥ 12 px | — |
| R16 | Low | B10 | `export.js`, `export-files.js` | Export native price, FX rate and fixing date; add a dropped-rows sheet; stronger sanitizer; real Excel dates | — |
| R17 | Low | B8, B13 | — | Annualize by elapsed sessions | — |
| R18 | Low | D11, D12 | Docs | Docs and default benchmark | — |
| R19 | Low | B9 | — | Optional common-date correlation mode | — |
| R20 | Low | B12 | — | Rank only tickers with full coverage | — |

## C.9 Unverified

- Alpha Vantage burst wording, SYMBOL_SEARCH behaviour for suffixed symbols, whether LSE returns GBX or GBp, mutual-fund coverage, free-tier corporate-action endpoints, and the daily reset time.
- Whether Yahoo "Close" is split-adjusted.
- Live yfinance runs (no Yahoo requests were made).
- The desktop GUI itself (`main.py` was replayed without Tk).

**Fixture caveats.** Holiday calendars are approximate. Zoom levels were approximated by viewport width.

**Sources (accessed 2026-11-03):**
- https://www.alphavantage.co/documentation/
- https://www.alphavantage.co/support/
- https://owasp.org/www-community/attacks/CSV_Injection
- https://help.yahoo.com/kb/SLN28256.html
