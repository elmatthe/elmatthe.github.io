# Appendix E — Portfolio Rebalancer: calculation engines and desktop app

Status: a sub-audit by the engine/desktop workstream, 2026-11-03, HEAD `ada2ceb`.
- **Lead auditor's check:** RB-01 (the division by zero in `core.py:136-148` when `scale == 0`) was confirmed by reading the code and the reproduction log (`audit/rebalancer/edge_cases.log`, E1b).
- **Scope:**
  - Browser engine: `assets/js/portfolio-rebalancer/engine.js`.
  - Desktop engine: `projects/portfolio-rebalancer-tool/scripts/portfolio_rebalancer/core.py`.
  - Desktop app: `ui.py`, `fx.py`, `pricing.py`, `ticker_helper.py`, `export.py`.
- **ALL PRICES AND FX RATES IN THIS APPENDIX ARE HYPOTHETICAL ROUND NUMBERS, NOT MARKET DATA.**

## E.1 Summary of findings

| ID | Sev | Type | Finding |
|---|---|---|---|
| RB-01 | **High** | Confirmed, with numbers | **Desktop crashes in Rebalance mode** when every overweight row is inside the 0.01 % hold band but an underweight row is outside it. `core.py:93` sets `scale = 0`, and `_scale_buys` (`core.py:143`) then divides by `scale`. Reproduction: A 100 sh @ $100.02, B 100 sh @ $100.02, C 100 sh @ $99.96, equal weights, pool $30,000, band $3. **Run** shows "float division by zero". Live recalculation (`ui.py:563`) catches only `ValueError`, so the **previous plan stays on screen** with the error cleared. The browser does not crash but shows **"Buy" with $0.00** and "scaled down by 100.0 %". |
| RB-02 | Medium | Confirmed | **Browser treats blank Shares or Target as 0** (`engine.js:154,156`, `Number("") === 0`). A blank target gives "Sell 305 VEQT.TO (−C$12,200)". In Chromium, an invalid number input (e.g. `1e400`) is submitted as `""` with `badInput:true`, so it also becomes 0. The desktop rejects blanks. |
| RB-03 | Medium | Confirmed | **Desktop accepts `nan`, `inf`, `1e999`** in Shares, Price, Target and Budget (Python `float()`; `ui.py:240-247, 521-528, 615`). It shows `Total Current Value: C$nan`, every row Hold, and no error. The browser rejects these. |
| RB-04 | Medium | Proven from code and Tk source; not executed (no Tk in this environment) | **The New Money budget field cannot reappear after Rebalance → New Money.** `ui.py:282` calls `pack(before=<itself>)` on an unpacked frame, and Tk raises "isn't packed". It reappears only after Load Sample or a row change, and then appears below the output. |
| RB-05 | Medium | Confirmed | **Non-ISO currency labels "JPN" and "CHY/CNH"** in both apps. The desktop combo boxes show the raw keys `JPN` and `CHY_CNH` (`ui.py:121,343`), and exports write them as the "Reporting Currency" (`export.py:49,118`). **`.HK` is mapped to CNY** (`engine.js:34,39`; `ticker_helper.py:12,18`), but HKEX HKD counters trade in HKD. `normalizeQuoteCurrency` (`engine.js:140-146`) is dead code. **No saved portfolios exist in either app, so no data migration is needed.** |
| RB-06 | Medium | Risks (desktop live mode) | (a) A quote with no reported currency is used as if in the row currency (`ui.py:702-718`); pence would then be read as pounds (100×). The browser refuses this (`app.js:410-414`). (b) The fallback can switch a row to another listing and currency, e.g. `VOD.L`→US `VOD` (`ui.py:680-713`). (c) Yahoo is queried for every row's ticker on start-up and on every row add/remove/apply, even with live prices off (`ui.py:373-375, 437-503`). Concurrency is unbounded, and an unknown ticker can try about 16 symbols. |
| RB-07 | Medium | Code-confirmed; layout reasoned | **Desktop plan output is a `tk.Text` with no scrollbars** (`ui.py:207`). Lines are 170 characters, or 184 with the account column. The ticker column overflows (`600519.SSCHY/CNH`). The window is fixed at 1400×960 with a 1200×760 minimum (`ui.py:72-73`). There is no DPI handling: at 150 % on 1920×1080 (logical 1280×720), the minimum height is taller than the screen and plan lines are wider than it. |
| RB-08 | Medium | Confirmed | **Desktop exports lack provenance.** The Excel file has no warnings, FX rates, price sources or disclaimer (`export.py:84-178`). The CSV has no FX rates or sources. Both write internal currency keys. The desktop records no timestamps for prices or FX. |

**Missing prices: both engines refuse to plan.**
- Browser: an offline run requires every price (`engine.js:161`). A live run lists the missing rows and stops (`app.js:474`). `attachFxValues` throws on a missing price (`engine.js:193`).
- Desktop: `ui.py:523, 699, 750-751` do the same.
- Neither has an "incomplete plan" state.
- A consequence: **a 0-share, 0 % watch-list row with no price blocks the whole run.** This conflicts with the 14-row sample requirement.
- The defect seen in the screenshots is different (report SS-04/SS-05): the browser *had* prices, carried over from other instruments, and used them.

## E.2 Tests (exact counts)

- **Desktop suite:** `PYTHONPATH=$SP/tkstub MPLBACKEND=Agg $SP/dv-portfolio-rebalancer-tool/bin/python -m pytest -q -p no:cacheprovider files/tests` → **7 passed**.
- **Parity and reference suites:** `test_engine_parity.py` and `test_financial_reference.py` → **26 passed**.
  - 6 are Rebalancer tests: browser vs desktop, browser vs legacy browser, FX direction and valuation, new-money exact fit and budget cap, rebalance self-funding and hold threshold, weight normalisation.
  - The other 20 are Monte Carlo tests.
- **Independent hand calculation:** all 12 engine × mode × row-set comparisons MATCH. The maximum difference is 1.8e-12.
- **Gaps in the existing tests:**
  - The parity test compares only the **number** of warnings (`test_engine_parity.py:195`).
  - No case reaches `scale == 0`.
  - Input validation is not tested for parity between the apps.
  - These desktop modules are untested: `fx.py`, `pricing.normalize_quote_currency`, `ticker_helper.py`, `export.py`.

## E.3 Engine specification (identical in both unless noted)

`engine.js:216-301` and `core.py:10-185` are line-for-line ports of each other.

**Inputs**
- Rows: ticker, shares (fractional, ≥ 0), price (> 0, in the row currency), currency key, target weight (≥ 0), optional account type (12 labels). Maximum 50 rows.
- Plan settings: reporting currency, mode, budget (New Money only).
- No cash input. The budget is the only cash and is not assigned to any account.

**FX**
- `fxToUsd[k]` is USD per unit of k; `fxToReporting = fxToUsd[row] / fxToUsd[rep]`; value = shares × price × fx.
- A missing key silently falls back to the built-in estimate dated 2026-10-30.

**Weights and hold band**
- Weights are normalised `w/Σw`. **Neither engine warns** when Σw ≠ 100 (E6: weights summing to 90 silently become VEQT 66.67 %). The browser's input total turns amber.
- Hold band: |delta| ≤ 0.01 % × pool → Hold with zero trade. The band scales with the pool ($100 on $1M).

**New Money**
- pool = total + budget; delta = w·pool − value.
- delta ≤ 0 → Hold. New Money **never sells**.
- If Σbuys > budget + 0.01, buys are scaled by budget/Σbuys. Allocation is therefore **proportional to each row's deficit**, not water-filling.
- Since the positive deltas sum to budget + Σ|overweights|, scaling happens whenever any row is overweight.

**Rebalance**
- pool = total. Sells are allowed.
- If Σbuys > Σsells + 0.01, buys are scaled to Σsells, so the plan is self-funding.
- Rows inside the hold band leave proceeds unallocated (C$1.95 in the sample). **This is unreported** in both apps.

**Accounts**
- Account types produce warnings only. Rebalance warns when buys in an account exceed sells in that account. Both modes warn when one ticker trades in several accounts; in New Money the wording wrongly mentions sells (`engine.js:292`, `core.py:182-185`).
- No TFSA/RRSP rules or contribution room.
- Scaling is global, not per account.

**Duplicates, zero rows and invalid prices**
- Duplicate tickers are separate holdings. Only the browser warns when the same ticker appears twice in one account.
- Zero-share row with target > 0 → buy toward the target.
- A 0 % target with shares held → Hold in New Money, sell everything in Rebalance.
- A 0-share, 0 % row is Hold **but still needs a price > 0**.
- Prices that are missing or ≤ 0 are rejected by both. NaN and inf are rejected by the browser only (RB-03).

**Rounding and display**
- No rounding inside the engines; trades are **fractional shares**. No lot sizes or broker minimums.
- The browser adds a "round buys down" note (`app.js:358`).
- Display: money to 2 decimals, shares to 4. The desktop shows JPY with 2 decimals; ISO 4217 says 0.

**Timestamps**
- None in the engines.
- The browser app adds a provider and date per price and per rate, "Calculated <local time>", and a UTC export time.
- The desktop records only "Run Date", in local time with no time zone.

## E.4 Independent hand calculation (HYPOTHETICAL prices)

**Fixture**
- FX: USD/CAD 1.40.
- Prices: VEQT.TO 40, CNQ.TO 45, XQQ.TO 150, HEWB.TO 30, AAPL US$200, VFV.TO 150, SPCX US$25, CBRS US$50, YNVD.TO 20, VST US$150.
- The owner's shares and weights. Reporting CAD, budget C$3,000.
- `hand_calc.py` uses exact `Fraction` arithmetic and imports neither engine.

### New Money

- Total current: 12,200 + 2,160 + 4,050 + 420 + 560 + 1,200 + 35 + 280 + 80 + 210 = **C$21,195**.
- Pool: **C$24,195**. Band: C$2.4195.
- Raw buys: 4,736.50 + 259.50 + 789.75 + 206.95 + 403.90 + 31.95 = **C$6,428.55**.
- Scale: 3,000 / 6,428.55 = **0.4666682222**, which both engines report as "scaled down by 53.3 %".

| Ticker | Target C$ | Raw delta | Action | Trade C$ | Trade shares | Post shares |
|---|---:|---:|---|---:|---:|---:|
| VEQT.TO | 16,936.50 | 4,736.50 | Buy | 2,210.37 | 55.259351 | 360.259351 |
| CNQ.TO | 2,419.50 | 259.50 | Buy | 121.10 | 2.691120 | 50.691120 |
| XQQ.TO | 1,693.65 | −2,356.35 | Hold | 0 | 0 | 27 |
| HEWB.TO | 1,209.75 | 789.75 | Buy | 368.55 | 12.285041 | 26.285041 |
| AAPL | 483.90 | −76.10 | Hold | 0 | 0 | 2 |
| VFV.TO | 241.95 | −958.05 | Hold | 0 | 0 | 8 |
| SPCX | 241.95 | 206.95 | Buy | 96.58 (US$68.9836) | 2.759343 | 3.759343 |
| CBRS | 241.95 | −38.05 | Hold | 0 | 0 | 4 |
| YNVD.TO | 483.90 | 403.90 | Buy | 188.49 | 9.424365 | 13.424365 |
| VST | 241.95 | 31.95 | Buy | 14.91 (US$10.65) | 0.071000 | 1.071000 |

### Rebalance

- Pool: C$21,195. Band: C$2.1195.
- Buys: **3,797.10**. Sells: **3,799.05**. No scaling.
- VST's +1.95 is inside the band, so **C$1.95 stays unallocated and unreported**.

| Ticker | Target C$ | Action | Trade C$ | Trade shares | Post shares |
|---|---:|---|---:|---:|---:|
| VEQT.TO | 14,836.50 | Buy | 2,636.50 | 65.9125 | 370.9125 |
| CNQ.TO | 2,119.50 | Sell | −40.50 | −0.9 | 47.1 |
| XQQ.TO | 1,483.65 | Sell | −2,566.35 | −17.109 | 9.891 |
| HEWB.TO | 1,059.75 | Buy | 639.75 | 21.325 | 35.325 |
| AAPL | 423.90 | Sell | −136.10 (US$−97.2143) | −0.486071 | 1.513929 |
| VFV.TO | 211.95 | Sell | −988.05 | −6.587 | 1.413 |
| SPCX | 211.95 | Buy | 176.95 (US$126.3929) | 5.055714 | 6.055714 |
| CBRS | 211.95 | Sell | −68.05 (US$−48.6071) | −0.972143 | 3.027857 |
| YNVD.TO | 423.90 | Buy | 343.90 | 17.195 | 21.195 |
| VST | 211.95 | Hold | 0 | 0 | 1 |

Fractional sells such as 0.9 CNQ.TO or 0.486 AAPL cannot be executed at whole-share brokers.

### Currency-test rows

Hypothetical inputs: 7203.T ¥3,000, SAP.DE €200, VOD.L £0.70, 600519.SS CN¥1,500, each 0 shares and 0 %.
- Totals and trades are unchanged, and each row is Hold 0, in both engines and both modes.
- Both engines still require a price for these rows.
- **Pence vs pounds:** with 100 VOD.L shares, typing `0.70` values the row at C$127.40 → Buy 4,738.07 shares; typing `70` values it at C$12,740 → Sell 2.12 shares. **No warning either way** (E5).

### Design note (not a defect)

Proportional scaling (current) vs water-filling (buy max(0, w·K − v)):
- Lowest post-trade weight ÷ target: 0.544 (SPCX) with proportional, 0.834 with water-filling.
- Sum of squared deviations: 224.0 pp² with proportional, 248.0 pp² with water-filling.

This is a product choice (RB-45).

## E.5 Currency labels and compatibility

**Where the labels are defined and shown**
- `engine.js:21-28`: keys `JPN` / `CHY_CNH`, ISO codes JPY / CNY, labels "JPN" / "CHY/CNH".
- `engine.js:29`: CNH maps to CHY_CNH.
- `engine.js:31-40`: `.HK` maps to CHY_CNH, which is wrong.
- `portfolio-rebalancer.html:46`: the reporting select reads "JPN (JPY)" and "CHY/CNH (CNY)", unlike the row selects (labels only, `app.js:108`).
- Browser text that uses the labels: `app.js:172-173` ("FX to JPN", "New money budget (CHY/CNH)"); `322`, `339` and `540-543` (caption, column, export headers). The FX table and warnings use ISO codes correctly (`app.js:190, 199, 384-386, 400, 507, 564`).
- Desktop: `fx.py:9-16` (same keys and labels), `fx.py:22-29` (Excel number formats keyed by internal key), `ui.py:121, 343` (combo boxes show the raw keys), `ui.py:290-291, 593, 735`, `export.py:49, 118` (the key is written to files), `ticker_helper.py:6-19, 104-108`, `README.md:21`.
- Tests hard-code the keys: `test_engine_parity.py:157`, `test_financial_reference.py:36`.

**Why they are wrong**
- ISO 4217 has JPY (0 minor units) and CNY (2), and no JPN, CHY or CNH.
- JPN is the ISO 3166 country code for Japan.
- CNH is the offshore-renminbi market convention.
- Both apps actually fetch the CNY rate: Bank of Canada `FXCNYCAD` and Yahoo `CNYUSD=X`.

**Compatibility**
- **No saved portfolios exist.** The browser stores only the API key and FX/price caches (keyed by ISO code). The desktop has no save/load, and exports are write-only.
- **Recommendation:**
  - Keep the internal keys, show ISO labels, and make the desktop combo boxes use labels.
  - Write ISO codes in exports.
  - Add an alias map for future imports: `JPN|JPY → JPN`; `CHY_CNH|CHY/CNH|CHY|CNY|CNH|RMB → CHY_CNH`.
  - Add HKD and map `.HK` to HKD.

## E.6 Desktop app details

**Prices**
- Typed prices are used offline.
- Live mode uses yfinance 1.7.0, trying in order: `fast_info.last_price` → `regular_market_price` → `previous_close` → `get_info` → the 5-day history close (`pricing.py:20-53`). **No timestamp is kept.**
- Candidate order: the row-currency listings first, then any other-currency quote, then a 13-suffix cross-market search (`ui.py:680-695`).

**Quote currency**
- Taken from `fast_info.currency` / `get_info`. GBp and GBX map to GBP ×0.01; CNH maps to CNY (`pricing.py:56-92`).
- No currency reported → the price is accepted in the row currency (RB-06a).
- Different currency and no typed price → the row currency is switched, with a warning (RB-06b).

**FX**
- yfinance `{CODE}USD=X`, falling back to built-in estimates. No manual FX entry.
- "~" marks *live* rates, the opposite of the browser's "≈" for estimates (RB-18).
- No Yahoo requests were made during this audit, so these pairs are UNVERIFIED.

**Errors**
- A missing price is an error, so no plan is built from incomplete valuations.
- Exceptions to that:
  - RB-01 (crash or stale plan) and RB-03 (NaN plan).
  - The live total silently counts unpriced rows as 0 (`ui.py:400, 414`).
  - "Live data used: Yes" is shown even when every quote failed (`ui.py:576`).

**Exports** (RB-08)
- CSV: Run Date with no time zone, the raw mode `new_money`, the internal currency key, and 13 columns written as text strings.
- Excel: `RB_Summary` and `RB_TradePlan` sheets with formats. It preserves other sheets of an existing workbook. **No warnings, FX rates, sources or disclaimer.**

**Layout and DPI**
- No Treeview: the inputs are Entry/Combobox widgets in a Canvas with only a vertical scrollbar; `ui.py:158` clips columns when the window is narrow.
- Output: Courier New 10 pt, about 1,360 px for a 170-character line (1,472 px with accounts). No horizontal scrollbar.
- No `SetProcessDpiAwareness` and no `tk scaling` call. CPython's manifest declares only `longPathAware`. Whether Tk itself is DPI-aware is UNVERIFIED.

**Accessibility**
- Contrast is 4.83–7.24 : 1 on #F0F0F0, but the colours are hard-coded (no High Contrast or dark mode).
- No keyboard shortcuts.
- The plan is a text block, not a navigable table.

**Threading**
- **Run** uses a worker thread, a queue polled every 80 ms, a progress bar and disabled controls.
- Ticker checks start one thread per row per edit (800 ms debounce), with no limit on how many run at once.

## E.7 Parity matrix (Rebalancer)

| Item | Verdict | Reason |
|---|---|---|
| Row fields, 50 rows | Equivalent | Same fields and limits |
| Ticker syntax validation | Browser superior | `engine.js:158`; none on desktop |
| Blank / NaN / Inf handling | Needs remediation | RB-02, RB-03 |
| Cash per account | Missing | Neither app models it |
| Pence unit for typed prices | Missing | E5 |
| Unpriced watch-list rows | Needs remediation | E4 blocks the 14-row sample |
| New Money math | Equivalent | Matches the hand calculation to 1e-12 |
| Rebalance math | Needs remediation | The `scale == 0` case (RB-01) |
| Hold band | Equivalent | Same constant and logic |
| Whole shares / lot sizes | Missing | Browser has an advisory note only |
| Uninvested remainder | Browser superior | "Budget not invested" tile; neither app reports rebalance leftovers |
| Account warnings | Equivalent (engine) | Desktop hard-codes "$" |
| Hidden account types | Needs remediation | Browser still uses hidden values (`app.js:130`); desktop ignores them (`ui.py:518`) |
| Duplicate-row warning | Browser superior | `engine.js:176-185` |
| Registered-account rules | Missing | — |
| FX source | Browser superior | Official Bank of Canada/ECB rates with dates vs undated yfinance |
| Manual FX entry | Browser superior | — |
| Estimate marker | Needs remediation | RB-18 |
| Currency set and labels | Needs remediation | RB-05; HKD missing |
| Live price coverage | Desktop superior | yfinance covers .L, .T, .DE, .SS (unofficial source) |
| Live price access | Technically restricted (browser) | Needs the visitor's own key; no CORS relays |
| Quote-currency verification | Browser superior | RB-06a |
| Cross-market fallback safety | Browser superior | RB-06b |
| Ticker check while typing | Desktop superior / Needs remediation | Convenient but unbounded (RB-06c) |
| Provenance and timestamps | Browser superior | — |
| Plan view | Browser superior | Desktop: no scrollbars, overflow (RB-07) |
| CSV export | Browser superior | — |
| Excel export | Mixed | Browser has richer content; desktop can merge into an existing workbook |
| Save/load portfolio | Missing | Neither app |
| Weights ≠ 100 % | Browser superior (visual cue only) | Neither app warns in the plan |
| Missing price | Equivalent | Both refuse to plan |
| Accessibility, DPI | Browser superior | — |
| Offline use | Equivalent | — |

## E.8 Remediation items (engine and desktop)

Not implemented. IDs are referenced from the main backlog (§12 of the report).

**Engine and app defects**
- **RB-01 (High).**
  - Fix: when `scale == 0`, turn would-be buys into Hold 0 with one clear warning. Store `fxToReporting` in desktop results instead of dividing by `scale`. Catch all exceptions in `_recalculate` and clear any stale plan.
  - Accept: E1/E1b give identical results in both engines; no exception; no "Buy" with a zero trade.
- **RB-02 / RB-03 (Medium).** Validate inputs identically: blank or whitespace is a required-field error; reject `badInput` and non-finite values in both apps.
  - Test: a validation-parity test covering `"", " ", "nan", "inf", "1e999"`.
- **RB-04 (Medium).** A single `_update_mode_ui` that places the budget field `before=btn_row`. Verify manually on Windows and macOS with screenshots.
- **RB-05 (Low).** Hard-coded "$" in desktop warnings: pass the currency formatter into `core`.

**Desktop data and output**
- **RB-06a/b/c (Medium).**
  - Treat a missing quote currency as unverified.
  - Never fall back from an explicit suffix to another market, and never auto-switch the row currency.
  - Run ticker checks only when live data is enabled, with a cache and one bounded worker.
- **RB-07 (Medium).** A Treeview with scrollbars, or the information model from report §9.5. Size the window to the screen, with a minimum of about 900×600. Make the app DPI-aware.
- **RB-08 (Medium).** Exports carry ISO codes, FX rates, price sources and timestamps, warnings and the disclaimer. Test with golden files.
- **RB-18 / RB-19 / RB-20 (Low).**
  - Invert the "~" estimate marker.
  - Label rows excluded from the live total.
  - Record timestamps, and add a time zone to Run Date.

**Product design**
- **RB-30.** ISO labels plus an alias map.
- **RB-31.** Add HKD.
- **RB-40.** Warn in the plan when Σweights ≠ 100.
- **RB-41.** Whole-share mode with greedy top-up, and leftover cash reported in both modes.
- **RB-42.** Allow 0-share, 0 % rows without a price ("not valued").
- **RB-43.** Pence unit hint.
- **RB-44.** Per-account cash.
- **RB-45.** Optional water-filling allocation.
- **RB-46.** Versioned JSON save/load.
- **RB-47.** Fix the New Money wording of the multi-account warning.

**Tests and docs**
- **RB-48.** Compare warning text, not counts. Add deterministic edge cases, validation-parity tests, and desktop module tests.
- **RB-49.** `projects/portfolio-rebalancer-tool/md-instructions/Briefing.md:20-22, 61` still describes Yahoo via CORS relays.
- **RB-50.** Remove the dead code at `engine.js:140-146`.

**For the browser workstream** (folded into the main report):
- `app.js:130` uses hidden account types.
- `badInput` is not handled.
- In Chromium (en-US), `1,5` becomes 15.
- `app.js:431` labels every minor unit "(pence)", including ZAc and ILA.

## E.9 Artefacts (scratchpad `audit/rebalancer/`)

- `fixture.py`
- `hand_calc.py` → `hand_calc.md`, `expected.json`
- `run_js_engine.mjs`
- `compare_engines.py` → `compare_engines.log`, plus desktop export samples
- `edge_cases.py` → `edge_cases.log`
- `pence_zero_rows.py` → `pence_zero_rows.log`
- `numinput.cjs`
- `desktop-tests.log`, `tools-tests.log`

## E.10 Sources (accessed 2026-11-03)

- ISO 4217 list one (SIX, 2026-09-17)
- BOFIT paper on offshore RMB
- Deutsche Börse A-share glossary
- HKEX dual-counter FAQ
- LSE GBX quote pages
- Tk `tkPack.c` (core-8-6-branch)
- Python tkinter threading documentation
- Microsoft High-DPI desktop application guide
- CPython `PC/python.manifest`
