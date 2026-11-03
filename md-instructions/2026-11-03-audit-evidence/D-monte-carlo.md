# Appendix D — Monte Carlo Retirement Simulator (browser and desktop)

**Provenance.** Sub-audit by the Monte Carlo workstream, 2026-11-03, HEAD `ada2ceb`.

**Lead-auditor spot checks.**
- **F4:** `ui.py:181-182` samples spending (30,000–120,000) and pension (0–40,000) independently.
- **F5:** `core.py:116,142` call the unseeded global `np.random.normal`.
- **F1:** the web hint reads "First year of retirement, in that year's dollars." (`monte-carlo-simulator.html:54`).

**Artefacts** (scratchpad `audit/montecarlo/`):
- `mc_js_runner.mjs`, `mcaudit.py`
- `harness_parity.py` → `parity_results.json`
- `harness_largeN.py`, `closed_form_checks.py`, `sensitivity.py`
- `rng_checks.mjs`, `port_feasibility.py`, `ui_parse_parity.py`, `export_checks_desktop.py`
- `ui_audit.js` → `screenshots/`

## D.1 Summary

**The model and the arithmetic are sound.**
- **Shared draws:** given identical random draws, the browser and desktop engines agree to **2.2e-16** across 36 scenarios and 5.48 M draws. Failed-path counts are identical, and the number of draws consumed is identical.
- **Independent checks:** both engines agree with an independent numpy reference to 1.8e-13, and with closed-form results to 1.2e-15.
- **Own generators:** each run with its own generator at large N, the two are statistically indistinguishable (54 z-scores, maximum |z| = 2.12).
- **Robustness:** no arithmetic error, overflow, NaN leak or crash was found within the validated ranges.

| ID | Sev | Type | Finding |
|---|---|---|---|
| F1 | **High** | Design | **Spending and pension are entered in retirement-year (nominal) dollars.** The web hint (`html:54`) is not linked to the field by `aria-describedby`, and the desktop label (`ui.py:74`) has no hint. If a user enters today's dollars, the base case shows **95.1 % success, but the plan they intended has 66.1 %**. |
| F2 | Medium | Design | "Expected return" is the arithmetic mean of normal simple returns, and volatility drag is not explained. At 7 %/12 % the median CAGR is 6.34 %; at 7 %/20 % it is 5.11 %. |
| F3 | Medium | Design | Normal returns can fall below −100 %. Volatility up to 300 % is accepted (`engine.js:21,77`; `models.py:27`): 36 % of years then have r < −100 %, and 1.6 % do at σ = 50 %. The floor at zero makes results meaningless. |
| F4 | Medium | **Confirmed bug (desktop)** | **"Load Sample Scenario" can produce pension ≥ spending** (expected 2.31 %; 2.55 % observed over 20,000 samples), and Run then fails validation. The docstring at `ui.py:152-153` claims this cannot happen. |
| F5 | Medium | Requirement (desktop) | **Desktop runs are not reproducible**: there is no seed field, and none is written to Excel or CSV. The web app has a seed field and exports the seed. |
| F6 | Medium | Wrong doc claim | The page says both versions share the same "validation messages" (`html:120`), but 15 of 18 UI-level parsing probes differ. "No … network access is needed" (`html:31,130`) contradicts the Chart.js CDN. |
| F7 | Medium | Risk (offline) | Chart.js loads as a parser-blocking script from cdn.jsdelivr.net, ahead of the app module (`_layouts/project.html:76-82`). If the CDN stalls, the app still shows "Loading…" after 15 s. A saved `file://` copy never becomes ready. |
| F8 | Medium | Risk (desktop, reproduced) | Writing the report into an existing workbook **drops drawing shapes on the user's other sheets** (an openpyxl limitation). The guide says "other sheets in the workbook are left alone" (`monte-carlo-guide.html:38`). |
| F9 | Low | **Confirmed bug (web)** | Warnings are overwritten by "Done.": the −100 % inflation real-values warning (`app.js:167` → `195`) and "chart library did not load" (`app.js:233`). |
| F10 | Low | Design/doc | The desktop Excel labels net withdrawal ÷ median portfolio at retirement as "Safe Withdrawal Rate" (`export.py:90`). The web label, "Initial withdrawal rate", is correct. |
| F11 | Low | Design | Ruin is defined as value ≤ 0. A plan that exactly funds every withdrawal reports 0 % success. |
| F12 | Low | Design | Withdrawals are taken at year-end, which is slightly optimistic: 95.06 % success vs 94.29 % with start-of-year withdrawals. The page does not state this timing in words. |
| F13 | Low | Risk (RNG) | In mulberry32, seeds s and s + 2·0x6D2B79F5 replay the same normal stream offset by one draw. `Math.log` and `Math.cos` are implementation-approximated, so cross-browser bit-reproducibility is UNVERIFIED. |
| F14 | Low | Accessibility/UX | No `aria-describedby` on hints or errors; results are not announced; the checkpoint table is clipped inside a non-focusable scroll box at 1024 px (147 px hidden) and 390 px (335 px hidden); "0.07" typed for a 7 % return is not caught; stale results are not flagged. |
| F15 | Low | Requirement | No pension start age; the pension is implicitly indexed; no taxes or fees; at least 1 year to retirement is required, so retirees cannot model their situation. |
| F16 | Low | Exports | The browser CSV reproduces exactly but has no version, unit base or BOM. The desktop CSV is rounded to cents with no inputs. The desktop Excel has no seed, no model text and no real values. |

## D.2 Test suites (exact counts)

| Suite | Result |
|---|---|
| JS `monte-carlo.test.mjs` | 7/7 |
| All unit `*.mjs` | 80/80 |
| pytest parity + reference | 26 passed (20 Monte Carlo) |
| `test_bootstrap.py -m "not e2e"` | 24 passed, 6 deselected |
| Desktop `files/tests` | 7 passed |
| `montecarlo.test.js` (port 4102) | 20/20; 10,000 simulations ran in 267 ms |

The shipped ZIP's `core.py`, `export.py`, `ui.py` and `requirements.txt` are byte-identical to HEAD.

**Coverage gaps in the existing parity test:**
- 8 scenarios with ≤ 400 paths each, and no extreme inputs.
- No assertion on the number of draws consumed.
- No desktop tests for exports, the sample scenario or input parsing.

## D.3 Model specification (identical in both engines)

**Returns, inflation and contributions**
- Returns: r ~ Normal(μ, σ), i.i.d. per year, as simple returns (`engine.js:154,164`; `core.py:116,142`). Single asset.
- Inflation is constant. It is applied to withdrawals and to the real-dollar deflator only.
- Contributions are paid at year-end and grow at g: C(1+g)^(k−1).

**Accumulation and withdrawals**
- Accumulation: V = max(0, V(1+r) + C), so the balance floors at zero and can recover.
- Withdrawals are fixed real. The first year's withdrawal is W₁ = spending − pension, indexed at (1+i) each year and taken at year-end.
- The pension is netted at retirement start and is therefore implicitly fully indexed.

**Ruin and success**
- Ruin: V ≤ 0 during retirement is absorbing; no further draws are taken on that path.
- Success = share of paths never ruined.

**Percentiles and reporting**
- Percentiles P10/25/50/75/90 are computed per year across paths (cross-sectional bands, not paths), with linear interpolation.
- Real values = nominal / (1+i)^t; null when i = −100 %.
- The desktop reports nominal values only.
- Chart, table, export and summary tiles all agree with the engine output (differences 0 to rounding).

## D.4 RNG and reproducibility

**Browser**
- mulberry32 (32-bit state), with Box–Muller (cosine branch) for normals.
- Seeded every run; the seed is shown and exported.

**Quality** (10 M draws)
- Mean 6.4e-7, variance 1.00011, skew 3.2e-4, excess kurtosis −5.8e-4, lag-1 autocorrelation −2.6e-5.
- Tail frequencies match the normal distribution; KS test p = 0.40.

**Desktop**
- The NumPy legacy global `RandomState` (MT19937), never seeded, drawing scalars inside a Python loop.
- NumPy documents `RandomState` as legacy and "effectively frozen" and recommends `Generator`.

**Matching seeds across platforms is impossible today, but feasible.**
- A bit-exact Python port of mulberry32 + Box–Muller matches V8 on 939,737 of 1,000,000 draws. The rest differ by ≤ 8.9e-16 because of libm.
- Over 10 seeds × 10,000 paths, this produced zero differences in failed-path counts and band differences ≤ 1.5e-15.

## D.5 Modelling parity evidence

**Shared shock matrix** (`harness_parity.py`): PCG64 draws were injected into both engines in their own draw order and compared with an independent vectorised reference.

36 scenarios were covered:
- base and frequent-ruin cases at N = 10,000;
- σ = 0, 50 and 300;
- negative growth and negative inflation;
- μ = −100 % and inflation −100 %;
- 120 + 120 years × 10,000 paths;
- inputs of 1e15;
- N = 1;
- 20 random scenarios.

**Results**
- Browser vs desktop: maximum relative difference **2.22e-16**.
- Either engine vs the reference: ≤ 1.80e-13.
- Failed-path counts and draws consumed were identical in all 36 scenarios.

**Closed forms** (σ = 0): every case matches to ≤ 1.2e-15, including:
- deterministic future value;
- zero return;
- zero inflation;
- inflation −100 %;
- contributions only;
- withdrawals only;
- return −100 %.

0 years to retirement is rejected by both engines.

## D.6 Sensitivity (N = 100,000, common random numbers, base inputs)

**Success rate under alternative assumptions**

| Assumption | Success |
|---|---|
| As coded | **95.06 %** |
| Start-of-year withdrawals | 94.29 % |
| Lognormal returns (same mean and SD) | 95.62 % |
| **Spending and pension meant in today's dollars** | **66.08 %** |
| At σ = 20 %: as coded / lognormal / start-of-year | 71.0 % / 73.3 % / 69.7 % |

**Spending units.** $60,000 entered in retirement-year dollars is $28,605 in today's dollars. Funding $60,000 of today's spending needs $125,854 nominal.

**Probability of r < −100 % in a year, by volatility**

| σ | 12 % | 20 % | 30 % | 50 % | 100 % | 300 % |
|---|---|---|---|---|---|---|
| P(r < −100 %) | 2.4e-19 | 4.4e-8 | 1.8e-4 | 1.6 % | 14.2 % | 36.1 % |

## D.7 Validation, performance, exports

**Validation**
- Validation in the engine cores is identical.
- UI parsing differs on 15 of 18 probes. Examples:
  - "abc" → the desktop says "must be greater than 0";
  - "1_000" and Arabic-Indic digits → accepted by the desktop only;
  - "1e3", "30.0" → accepted by the web only.
- On the web, 0.07 entered as the return runs silently and gives 1.1 % success.

**Performance (10,000 paths)**
- Web engine: 89 ms for 30 + 25 years; 407 ms for 120 + 120 years, all on the main thread (longest task 427 ms).
- Desktop: 1.00 s and 4.28 s on a worker thread.

**Exports**
- Browser CSV: all inputs, the seed, model note and every year's P10–P90 in nominal and real terms, at full precision. **Reproduced exactly from its own inputs and seed.** Formula-injection safe.
- Desktop Excel: summary (with the "Safe Withdrawal Rate" label), percentiles and a chart PNG.
- Desktop CSV: percentiles rounded to cents, with no inputs or seed.
- Writing into an existing workbook drops text-box shapes (reproduced; openpyxl documents this).

## D.8 UI and claims

- Page horizontal scroll is 0 at every width.
- The checkpoint table scroll box hides 20 px at 1366, 147 px at 1024 and 335 px at 390.
- Minimum font size is 12.8 px; contrast is 6.3–14.1:1.
- Keyboard order and focus rings are good.
- The desktop is a fixed 480×580 non-resizable Tk window; its accessibility is UNVERIFIED.

**Page and doc claims checked**

| Claim | Verdict |
|---|---|
| Same model and limits | ✔ |
| Same validation messages | Only at the core level |
| No network access needed | ✘ (Chart.js CDN) |
| Seed reproducibility | ✔ within one JS engine |
| Disclaimer | ✔ |
| "Safe withdrawal rate" | Misleading |
| Sample scenario always valid | ✘ |
| "Other sheets left alone" | ✘ shapes are dropped |
| Works without the CDN | ✔ only if the request fails fast; ✘ when it stalls |

## D.9 Parity matrix

| Capability | Verdict | Reason |
|---|---|---|
| Model step | Equivalent | ≤ 2.2e-16 over 5.48 M draws |
| Core validation | Equivalent | Same constants and messages |
| UI parsing and messages | Needs remediation | 15 of 18 differ |
| Percentile method | Equivalent | Same per-year interpolation |
| Statistics with own generators | Equivalent | max \|z\| 2.12 |
| Seeded, reproducible runs | Browser superior | Desktop has no seed |
| Cross-platform seed match | Missing | Feasible to ~1e-15 with a port |
| Real-dollar view | Browser superior | Desktop is nominal only |
| Summary statistics | Browser superior | Desktop label wrong |
| Fan chart | Equivalent | Same data |
| Year table | Equivalent | — |
| Excel export | Desktop superior | Web has none |
| CSV export | Browser superior | — |
| Reproduce from export | Browser superior | Desktop cannot |
| Write into an existing workbook | Restricted (web) / needs remediation (desktop) | Shapes dropped |
| Sample scenario | Browser superior | F4 |
| Speed | Browser superior | 0.3–0.4 s vs 4.3 s |
| Responsiveness during a run | Desktop superior | Worker thread |
| Accessibility | Browser superior (with gaps) | — |
| Offline capability | Desktop superior | — |
| Network dependencies | Needs remediation | Chart.js CDN |

## D.10 Remediation items (not implemented)

- **R1 (High):** add a "today's / retirement-year dollars" choice, defaulting to today's, with W₁ = (S − P)(1+i)ⁿ. Show the converted amount and record the basis in exports.
  - *Acceptance:* for the base case in today's dollars, the first-year net withdrawal is **88,094.70** in both engines, with parity ≤ 1e-12.
- **R2:** label the return input as an arithmetic mean and show a "median ≈ μ − σ²/2" helper.
- **R3:** cap volatility (e.g. 60 %) or warn above 30 %, or switch to lognormal returns or truncate at −100 %, and document the choice. Both engines must give identical messages.
- **R4:** fix the desktop sample scenario by clamping the pension, as `app.js:45` does.
  - *Acceptance:* 100,000 samples with 0 failures.
- **R5:** add a desktop seed, using a port of mulberry32 + Box–Muller (seed-matched to the web to ~1e-15) or `Generator(PCG64)`. Export the seed, RNG name and engine version.
- **R6:** self-host Chart.js under `/assets/vendor` with SRI and `defer`, or lazy-load it.
  - *Acceptance:* with external hosts blocked or stalled, the app is ready in < 2 s.
- **R7:** correct the claims in D.8.
- **R8:** one parsing rule set and one message catalogue for both apps.
  - *Acceptance:* 18/18 probes give identical results.
- **R9:** warn, back up, or write a new file when the target workbook already exists.
- **R10:** keep warnings visible after "Done."; hide the chart box when Chart.js is missing.
- **R11:** rename "Safe Withdrawal Rate" to "Initial withdrawal rate".
- **R12:** use `< 0` for ruin, or document it.
- **R13:** document year-end timing.
- **R14:** hash the seed (splitmix32) and add `engineVersion`.
- **R15:** accessibility fixes from F14.
- **R16:** add a 0.07-vs-7 % guard and a stale-results flag.
- **R17:** export metadata.
- **R18:** run the simulation in a Web Worker.
- **R19:** add extreme cases and a draw-count assertion to CI.
- **R20:** product ideas: pension start age, taxes and fees, already-retired users, stochastic inflation.

## D.11 Unverified

- Cross-browser bit-reproducibility (only Chromium was tested).
- Tk layout and screen-reader behaviour.
- Excel's handling of the BOM-less CSV.
- Native form submission while the CDN stalls (inferred).
- **Assumption:** the 66 % figure assumes the user meant today's dollars. It is a consequence, not a measured frequency.
