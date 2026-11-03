# Four-Tool Market-Data and UX Audit — Remediation Plan

| | |
|---|---|
| **Date** | 2026-11-03 |
| **Repository** | `elmatthe/elmatthe.github.io` |
| **Audited revision** | `ada2cebde413bd8ca67d33a50a7ad61376884b75` (merge of PR elmatthe/elmatthe.github.io#43) |
| **Live site** | https://elmatthe.github.io/projects/ (deployed JS verified byte-identical to `ada2ceb`) |
| **Audit branch** | `claude/loving-brown-48hctl`. This document and its appendices are the only changes. **Do not merge.** |
| **Scope** | Portfolio Rebalancer, Stock Comparison & Analytics, Monte Carlo Retirement Simulator, CPI Web Scraper: browser and desktop versions |
| **Phase** | Audit and planning only. No application code, UI, settings or data was changed. |

**Evidence appendices** (same folder, `2026-11-03-audit-evidence/`):

| Appendix | Subject |
|---|---|
| A | Market-data providers |
| B | Ticker identity (14 instruments) |
| C | Stock Comparison tool |
| D | Monte Carlo simulator |
| E | Rebalancer engines and desktop app |
| F | CPI Web Scraper |

The appendices give details, sources and reproduction steps behind every summarised finding.

> **Public visibility.** Files under `md-instructions/` are served by GitHub Pages if merged to `main` (`/md-instructions/WEBSITE_REBUILD_PLAN.md` returns HTTP 200 today). This audit is on an unmerged branch. If it is ever merged, exclude the folder in `_config.yml` first.

**Status labels used throughout**

| Label | Meaning |
|---|---|
| **Confirmed** | Reproduced, or proven from code with a concrete numeric example |
| **Risk** | Evidence-backed but not reproduced end to end |
| **Design** | Design weakness |
| **Requirement** | New product requirement from the brief |
| **Proposal** | Recommended change |
| **External** | Provider or platform limitation |
| **UNVERIFIED** | Could not be checked here; the reason is stated |

---

## 1. Executive summary

### 1.1 The live incident (Rebalancer, 2026-11-03)

The owner's run is reproduced exactly in Chromium with mocked providers: the same 20 warnings, including "XQQ.TO: live price unavailable (…daily request limit…); your typed price 42 was used", and the same row-1 price of 250. The root cause is a chain of confirmed defects:

1. **Misread notice (AV-01, Critical, Confirmed).** The site classifies Alpha Vantage's *per-second* "burst" notice as the *daily* limit. Alpha Vantage's 2026 wording ("…more sparingly (1 request per second)… to lift the free key rate limit **(25 requests per day)**…", verbatim from public reports) matches the site's daily rule (`alphavantage.js:81`) before its burst rule (`:82`). The repository's test fixture used a truncated one-sentence wording, which is why every suite passed.
2. **Persisted lock (AV-02, High, Confirmed).** The misread limit is saved in `localStorage` for the rest of the UTC day (until 18:00 in the owner's UTC-6 time zone). Reload, "Remove key", re-entering the key and the Stock tool all honour the block, and no "retry" exists.
3. **Every holding fails (AV-03).** After the first limit response, every remaining holding fails locally with the same message, without any request. That explains "≈2 of 25 used" next to "daily limit reached" on all 10 rows.
4. **Carried-over sample prices (SS-05, Critical, Confirmed).** The "typed prices" were the **previous sample portfolio's illustrative prices**: 250, 36, 42, 64, 64, 7.4, 180, 72, 40 are exactly the old sample rows 1–9. Changing a ticker keeps the old instrument's price, labelled "Price was for the previous ticker; check it", and the plan still uses it.
5. **Plan marked complete on wrong prices (SS-04, Critical, Confirmed).** With 0 of 10 verified prices, the app produced Buy actions and said "Completed with 20 warning(s)". Against 2026-11-02 reference closes, those placeholder prices **reverse the trade direction for 5 of 10 holdings** (Appendix B.2). VEQT was valued at 250 instead of about C$60.84.

**Still UNVERIFIED (no valid key in this environment):** whether the owner's browser received the burst notice (most probable) or a genuine daily notice. §4.5 gives a redacted procedure that costs at most 3 requests.

### 1.2 Feasibility of the requested workflow

1. **Not every requirement can be met at once.** "Free + no visitor account + automatic prices + international coverage" is impossible under the brief's constraints: no paid APIs, no shared or hidden keys, no relays, no scraping, licences respected (Appendix A, §14).
2. **Alpha Vantage is the only fully free browser source for non-US listings.** Using the visitor's own key, it documents TSX, TSX-V, LSE, Xetra and Shanghai/Shenzhen coverage and answers browsers. It allows 25 requests per day.
   - The current design spends 2–3 requests per new holding. A 10-holding first run costs 20–26; the 14-row sample costs 26–39.
   - With caching, a curated identity file and market routing (§6), the 10-row sample costs **about 5–10 Alpha Vantage requests plus about 8 Finnhub requests** on day 1 (§10.3).
3. **No free browser-usable provider found:**
   - **YNVD**, which trades on **Cboe Canada**, not the TSX. The owner's `YNVD.TO` points to a listing that does not exist.
   - **Tokyo** listings (`7203.T`).
   - **Canadian mutual-fund codes.**
   - **Indexes.**

   These need CSV import or an explicit, labelled user-supplied price (decision DEC-03).
4. **Recommended browser providers: three, not five.** Alpha Vantage (primary), Finnhub (US real-time and cross-check) and Massive (US end-of-day, optional). Padding to five would add providers whose free plans forbid display (Twelve Data), lack browser access (EODHD, Tiingo) or allow 100 requests a month (Marketstack).

### 1.3 Most significant other findings

- **Rebalancer UX:**
  - The trade plan always needs horizontal scrolling: 331 px is hidden even at 1920 px, and **the Action column is off-screen at 1366 px**. The holdings table overflows at 150 % zoom.
  - The price-source cells are 74 px wide and wrap into 100 px-tall blocks.
- **Rebalancer engines:**
  - The browser and desktop engines match an independent hand calculation to 1e-12.
  - The desktop crashes (`ZeroDivisionError`, `core.py:143`) on a nearly balanced Rebalance; the browser shows "Buy $0.00" instead (RB-01).
  - The browser treats a blank target as 0, producing "sell all" (RB-02).
  - The desktop accepts NaN and inf (RB-03).
- **Stock tool:**
  - The browser engine matches numpy/scipy to 1e-9.
  - Short live windows use **unadjusted** daily closes. A 3-for-2 split goes unflagged: −33 % instead of +0.06 % (SD-B1).
  - The desktop aligns tickers on the union of dates, which changes Sharpe ratios materially (SPYX 0.801 → 0.353). Its cumulative chart understates returns by about half (SD-D1, D2).
- **Monte Carlo:**
  - The engines are exactly equivalent (2.2e-16 on shared draws).
  - Spending is entered in *retirement-year* dollars. A user who means today's dollars sees 95 % success instead of 66 % (MC-F1).
  - Desktop runs are not reproducible (no seed).
  - The page claims "no network needed", but it loads Chart.js from a CDN.
- **CPI scraper:**
  - **The public ZIP redistributes 121 S&P 500 values whose FRED notes prohibit reproduction** (CPI-01).
  - After each download, saved model sheets keep results calculated from the old data (CPI-02).
  - "Single month" mode erases the history (CPI-03).
  - The workbook carries the author's local Windows path and username.
  - A browser version can fetch Statistics Canada live, but not FRED (CORS). In-browser workbook editing cannot preserve the model; both SheetJS and ExcelJS lose charts and do not recalculate.
- **Tests:** every existing suite passes (§2.3). None of them covers the defects above, so a passing CI result is not evidence of correctness for these behaviours.

### 1.4 Verdict

**READY FOR IMPLEMENTATION PLANNING REVIEW.** The plan in §12–§13 is dependency-ordered and executable. It requires the owner and reviewer to settle the decisions in §14.2 (DEC-01…DEC-12). The live-key root-cause confirmation (§4.5) is the only diagnostic still open. Every fix in §12 is needed whichever way it resolves.

---

## 2. Repository evidence

### 2.1 Revision and branch

- `main` HEAD = `ada2cebde413bd8ca67d33a50a7ad61376884b75`, the merge of PR #43 on 2026-11-02 14:58 −06:00.
- The audit branch `claude/loving-brown-48hctl` was fast-forwarded to that commit. The only change on it is this document set.
- PR #43 commits (oldest → newest):

  | Commit | Change |
  |---|---|
  | `f515345` | Browser-direct market-data layer |
  | `2589c07` | Rebalancer: official FX, provenance, own-key prices |
  | `e4f2b4c` | Stock: CSV import, own-key live data, price basis |
  | `d99b8de` | Stock desktop: pence |
  | `ec5eba2` | Monte Carlo: seeded runs |
  | `2b9a71f` | Desktop patch releases, ZIPs |
  | `9c0559b` | Key handling, row-currency resolution |
  | `bbb049b` | MARKET_DATA.md |
  | `2e8311b` | Respect `[hidden]` |
  | `469bb1e` | Review fixes |
  | `3d3627b` | Strict dates (R04) |
  | `860a508` | Per-key isolation, session keys, SRI (R01, R05) |
  | `5919140` | Currency/basis honesty (R02, R03) |
  | `02e8467` | CI |
  | `8cca7b1` | Docs |
  | `7349241` | CI parity |

- **Deployed site = repository.** These four files served by GitHub Pages hash identically (SHA-256) to `ada2ceb`: `market-data/providers/alphavantage.js`, `market-data/index.js`, `portfolio-rebalancer/app.js`, `portfolio-rebalancer/engine.js`. The Rebalancer page reports `Last-Modified: Mon, 02 Nov 2026 20:58:44 GMT`.

### 2.2 Files inspected (primary)

- **Shared market data:** `assets/js/market-data/{index,http,cache,contract,symbols,fx,fx-align,csv,price-import}.js`, `providers/{alphavantage,boc,ecb}.js`, `assets/js/shared/{export-files,project-page}.js`.
- **Rebalancer:**
  - browser: `assets/js/portfolio-rebalancer/{app,engine}.js`, `projects/portfolio-rebalancer.html`, `assets/css/portfolio-rebalancer.css`;
  - desktop: `projects/portfolio-rebalancer-tool/scripts/portfolio_rebalancer/{core,ui,fx,pricing,ticker_helper,export}.py`.
- **Stock tool:**
  - browser: `assets/js/stock-dashboard/{app,analytics,export,demo}.js`;
  - desktop: `projects/Stock-Data-Dashboard-Tool/scripts/{analytics,data_sources,exports,main,plots,config}.py`.
- **Monte Carlo:**
  - browser: `assets/js/monte-carlo/{engine,app}.js`;
  - desktop: `projects/monte-carlo-retirement-simulator/scripts/monte_carlo/{core,models,export,ui}.py`.
- **CPI:** `projects/cpi-webscraper.html`, the guide, `projects/CPI-Webscraper/scripts/{cpi_webscraper,data_sources,workbook_io,bootstrap,cpi_config,verify}.py`, `files/CPI.xlsx`, `files/tests/*`.
- **Site and docs:** `_layouts/project.html`, `assets/css/*`, `_config.yml`, `_tools/MARKET_DATA.md`, `_tools/RELEASE_NOTES.md`, `.github/workflows/ci.yml`, and all test suites under `_tools/tests/`.

### 2.3 Existing test status at `ada2ceb` (executed in this audit)

| Suite | Result |
|---|---|
| `node --test _tools/tests/unit/*.test.mjs` | **79 / 79 pass** |
| `pytest -m "not e2e"` in `_tools/tests` | **56 passed, 6 deselected** (e2e) |
| Browser `pages.test.js` / `stock.test.js` / `rebalancer.test.js` / `montecarlo.test.js` | **139 / 56 / 52 / 20 PASS, 0 FAIL** |
| Desktop Rebalancer / Monte Carlo / Stock | **7 / 7 / 45 passed** |
| Desktop CPI | **98 passed, 1 skipped (opt-in Excel), 6 deselected** (Windows-only bootstrap) |

**Coverage gaps that let the incident through:**
- The Alpha Vantage burst fixture is truncated (`market-data.test.mjs:507`).
- No test edits a sample row's ticker and checks the price.
- No test asserts that a plan is withheld when valuations are incomplete.
- The parity tests compare warning *counts*, not their text.
- There are no layout overflow tests.
- There are no extreme-value parity cases.

### 2.4 Environment limitations

- **No Alpha Vantage key** (nor any other provider key) was available or used. Live provider checks used keyless endpoints or documented demo keys, with bounded request counts (Appendix A.8).
- **No Windows or Excel**, so these were not run:
  - CPI COM writes;
  - CPI and desktop bootstrap tests;
  - Tk GUIs (tests used a Tk stub);
  - DPI behaviour (reasoned from code).
- **Only Chromium is available**, so Firefox and Safari behaviour is not verified.
- **All traffic passed through the session's egress proxy.** CORS headers from StatCan, the Bank of Canada and Alpha Vantage were preserved through it.
- **Zoom levels** were approximated by CSS viewport width: 1366 px at 125 % = 1093 px, at 150 % = 911 px.

---

## 3. Screenshot-derived defect register

Severity scale:
- **Critical:** a wrong or unverifiable financial output is presented as usable.
- **High:** a core workflow is broken, or a material risk.
- **Medium:** misleading or degraded, but recoverable.
- **Low:** polish.

Status labels: **Confirmed** = reproduced, or proven from code with a concrete example. **Risk** = backed by evidence but not reproduced. **Requirement** = a new product requirement.

Every reproduction below uses `repro/incident.js` or `repro/layout.js` (in `2026-11-03-audit-evidence/`): Chromium against a local `jekyll build` of `ada2ceb`, with the Bank of Canada, ECB and Alpha Vantage mocked by `_tools/tests/browser/harness.js`.

### SS-01. Every holding reports "Alpha Vantage daily request limit reached". Critical, Confirmed.

- **Reproduce:** see §4.3 (a limit notice on request 1 or 2).
- **User-visible effect:** no live prices; the same limit message for all 10 rows.
- **Root cause:** AV-01 (notice classification), AV-02 (persisted block), AV-03 (batch short-circuit). Whether the provider sent a genuine daily notice or a burst notice is UNVERIFIED.
- **Code:** `alphavantage.js:81, 190-210, 250`; `index.js:230-245`.
- **Fix:** classify notices with an explicit, ordered table:
  1. "1 request per second" / "spreading out" → burst: back off and retry up to 3 times (2 s, 5 s, 10 s). **Never persisted.**
  2. Then the daily wording ("standard API rate limit is … per day").
  3. Then premium.
  4. Unknown `Information` text → `unavailable` (not definitive).

  Persist a daily block only for the daily wording. Store a redacted provider-notice snippet and when it was received. Show "Provider says: …" in a details element. Add "Check again" (costs 1 request) and show when the local block expires.
- **Tests:**
  - Fixtures with the full live wordings (burst, daily, premium, invalid key, invalid call, unknown notice).
  - A burst notice must never set `exhausted`.
  - Classification must not depend on rule order: a property test over notices containing both phrases.
  - A browser test for the "Check again" flow.

### SS-02. "About 2 of 25 requests used" next to "daily limit reached". High, Confirmed.

- **Reproduce:** §4.3, scenario 1. The counter shows 1–3.
- **Effect:** the screen contradicts itself; the user cannot tell whose limit was hit.
- **Cause:** AV-04. The counter is per browser, per key, since 00:00 UTC, and shared by both tools.
- **Code:** `alphavantage.js:235-252`; `app.js:281`.
- **Fix:** rename it to "Requests sent from this browser today (UTC): N". Never say "of 25 used". When the provider reports a limit the counter cannot explain, add "Alpha Vantage counts all use of this key (and may limit by network); this browser has sent N."
- **Tests:** unit tests for the counter text; a browser assertion of the contradiction message.

### SS-03. The same provider message repeated for every row. Medium, Confirmed.

- **Effect:** 10 near-identical warnings bury everything else.
- **Cause:** one warning per row (`app.js:472`).
- **Fix:** group warnings by cause: "Alpha Vantage: daily limit (provider message) — not priced: VEQT.TO, CNQ.TO, … (10)".
- **Tests:** a browser test counting warning groups.

### SS-04. A plan is produced and marked "Completed" with 0 of 10 verified prices. Critical, Confirmed.

- **Reproduce:** §4.3, scenario 1. Status: "Completed with 20 warning(s)", with Buy actions for 9 rows.
- **Effect:** actionable trades computed from prices that belong to other instruments.
- **Cause:**
  - Falling back to the typed price (`app.js:470-472`).
  - No completeness gate in `run()` or `finishPlan()` (`app.js:445, 503-513`).
  - `recalc()` re-plans from whatever prices are present (`app.js:518-523`).
- **Fix:** add a *valuation completeness gate*:
  - Every row with shares > 0 or target > 0 needs a price from an approved source, inside the freshness policy, with a confirmed currency.
  - Otherwise there is **no plan**. Show "Plan not generated — 10 of 10 holdings lack a verified price", list each row's reason, and offer Retry or another provider.
  - Rows with 0 shares and 0 % target (the currency-test rows) never block.
  - User-supplied prices are an explicit, opt-in path; see decision **DEC-03** in §14.
- **Tests:**
  - Engine-level `assessValuation()` unit tests.
  - A browser test showing no plan and no Buy/Sell pills when any required row is unpriced.

### SS-05. The old instrument's price is kept after the ticker changes. Critical, Confirmed.

- **Reproduce:** load the sample, overwrite VTI → VEQT.TO and leave the price. The row shows "Price was for the previous ticker; check it", and the run and every recalculation use 250 as VEQT.TO's price.
- **Effect:** the owner's "typed prices" were the sample's illustrative prices. The plan valued VEQT.TO at 250 and VFV.TO at 7.4, etc.
- **Cause:** the ticker `input` handler only relabels the price (`app.js:614-623`); `run` and `recalc` accept it (`app.js:445, 523`).
- **Fix:**
  - Editing a ticker immediately clears its price, source, currency evidence and resolution state, and cancels or ignores in-flight work for the old ticker. A per-row `revision` counter is checked before applying any response.
  - Changing the row's listing has the same effect.
  - There is no "check it" state that is still used.
- **Tests:**
  - Unit tests on the row state machine.
  - Browser: edit the ticker → price cleared → no plan until resolved.
  - A late-response test: delay the mock for the old ticker, change the ticker, release the response → never applied.

### SS-06. 20 warnings for one run. Medium, Confirmed.

- **Composition (reproduced exactly):** 10 provider failures, 9 "Price was for the previous ticker; check it", 1 budget-scaling notice.
- **Fix:** SS-03 grouping, plus SS-05 (removes the 9 stale-price warnings), plus a severity hierarchy (see §9).

### SS-07. Prices are not filled in when a ticker is entered. High, Requirement and Confirmed.

- **Cause:** prices are fetched only inside `run()` (`app.js:455-480`). There is no lookup on blur or after loading the sample, and no per-row loading state.
- **Fix:** the automatic resolution and quote pipeline in §6:
  - lookup on blur or Enter, never on every keystroke unless the provider's search is free;
  - per-row states;
  - request budgeting.
- **Tests:** see §6.6.

### SS-08. Horizontal scrolling is needed to read the plan, and the input table at zoom. High, Confirmed.

**Measured overflow (CSS px; output of `repro/layout.js`):**

| Width (CSS px) | Input table hidden | Plan table hidden |
|---|---|---|
| 1920 / 1440 / 1366 / 1280 (100 %) | 0 | **331** |
| 1366 at 125 % (1093) | 0 | 484 |
| 1366 at 150 % (911) | 146 | 655 |
| 1280 at 150 % (853) | 201 | 710 |
| Tablet 768 | 280 | 789 |
| Phone 390 | 623 | 1132 |

- At 1366 px the **Action**, **Trade shares**, **Trade (local)** and **Post-trade shares** columns are off-screen (the screenshot `layout-1366.png` that `repro/layout.js` writes to `$OUT_DIR`).
- **Cause:**
  - `.rb-input { min-width: 60rem }` and `.rb-output { min-width: 62rem }` (`portfolio-rebalancer.css:8,17`).
  - 13–14 plan columns (`app.js:326`).
  - The page content box is capped at 1138 px.
- **Fix:** the no-horizontal-scroll redesign in §9.
- **Tests:** a Playwright layout test at 1920, 1440, 1366, 1280, 1093, 911, 853, 768, 390 and 360 px asserting:
  - `scrollWidth <= clientWidth` for the document and every container in the app;
  - every plan field visible or reachable by vertical expansion;
  - a minimum font size of 14 px for financial values.

### SS-09. Narrow price-source cells wrap into tall blocks. Medium, Confirmed.

- **Measured:** the source column is 74 px wide and each cell up to 100 px tall ("Alpha Vantage · 2026-11-02" over four lines).
- **Code:** `.rb-src-cell` (`portfolio-rebalancer.css:39`), squeezed by table layout.
- **Fix:** §9. The source becomes a status line under each holding: "Alpha Vantage · close 2026-11-02 · CAD ✓".

### SS-10. Small, dense type. Medium, Confirmed.

- **Measured:** the minimum computed font size in the plan is 12.8 px (source and caption); the input table is 0.9 rem.
- **Fix:** at least 14 px for values and 13 px for metadata; use spacing instead of shrinking.

### SS-11. Status hierarchy is unclear. Medium, Confirmed.

- Information notes ("VEQT.TO: priced as VEQT.TRT (Toronto)") are shown in the same list as warnings (`app.js:356-357`).
- The status line counts only warnings: "Completed with 1 warning(s)" above a list of 7 items.
- `#rbResults` is an `aria-live` region (`portfolio-rebalancer.html:118`), so screen readers re-announce the entire plan on every recalculation.
- **Fix:**
  - Three tiers: blocking (red, plan withheld), needs attention (amber), information (collapsed).
  - A single completeness summary at the top.
  - `aria-live` only on a short status sentence.

### SS-12. The sample portfolio misleads. High, Confirmed.

- On page load the app pre-fills 9 generic rows with illustrative prices (`app.js:23-33, 645`).
- Defaults are USD reporting and a 10,000 budget (`portfolio-rebalancer.html:46, 57`).
- Editing those rows silently carries the prices over (SS-05).
- **Fix:** start empty. "Load sample portfolio" loads the owner's 14-row specification (§10) with **no prices**, CAD reporting and a CAD 3,000 New Money budget, then resolves and prices within the request budget (§10.3).

### SS-13. Currency labels "JPN" and "CHY/CNH". Medium, Confirmed.

- Internal keys `JPN` and `CHY_CNH` are shown as labels "JPN" and "CHY/CNH" (`engine.js:21-29`; reporting select `portfolio-rebalancer.html:46`). JPN is a country code, not a currency; CHY is not an ISO code; CNH is offshore yuan and is not the trading currency of SSE/SZSE A-shares.
- **Fix:** display ISO codes (JPY, CNY) everywhere. Keep the internal keys as a compatibility layer (see the engine/desktop findings in §7.1).

### SS-14. The row currency dropdown is a required manual input. High, Requirement.

- Today the user picks the row currency. The live path uses it to choose the listing (`buildTickerCandidates`) and can switch it only when the row has no price (`app.js:414-424`).
- **Fix:** currency becomes *resolved metadata* (§6), shown read-only with its evidence. A manual override appears only for unresolved instruments, and is labelled as such.

### SS-15. Blank account type shows "—" and has no explanation. Low, Confirmed.

- **Fix:** when no row has an account type, hide the account column and its funding warnings. When some rows do, show "Unassigned" and explain the cross-account rule in context.

### SS-16. Sticky page navigation scrolls sideways on narrow screens. Low, Confirmed.

- `.pj-localnav ul { overflow-x: auto }` (`project-pages.css:76`).
- Heading anchors already use `scroll-margin-top` (`project-pages.css:36, 82`).
- Overlap was not reproduced at the measured widths.
- **Fix:** wrap the navigation, or collapse it into a menu below 600 px. Check that focus moves to errors and results are not hidden under it (`scroll-padding-top` on `html`).

### SS-17. The window-resize behaviour was a symptom of SS-08.

There is no separate defect: once the minimum-width tables are gone, resizing reflows.

---

## 4. Alpha Vantage root-cause findings

### 4.1 What the deployed code does (verified)

The deployed JavaScript is byte-identical to `ada2ceb`. On 2026-11-03 I fetched four files from `https://elmatthe.github.io/assets/js/...` (`market-data/providers/alphavantage.js`, `market-data/index.js`, `portfolio-rebalancer/app.js`, `portfolio-rebalancer/engine.js`) and compared their SHA-256 hashes with the repository: all four match. The page's `Last-Modified` is 2026-11-02 20:58:44 GMT, the merge time.

**Request sequence for one Rebalancer run with live prices on** (`app.js:435-480` → `index.js:230-245` → `index.js:195-221` → `alphavantage.js:193-221`):

1. `run()` validates rows with `requirePrice: !live`, so rows may have no price (`app.js:445`).
2. Each row gets one query symbol: `buildTickerCandidates(ticker, rowCurrency)[0]` (`app.js:462`). For `VEQT.TO` in a CAD row that is `VEQT.TO`, which `toAvSymbol` maps to `VEQT.TRT` (`alphavantage.js:32,41-56`). A `.T` (Tokyo) symbol is rejected locally with no request.
3. `md.quotes()` walks the unique symbols one at a time (`index.js:230-245`). For each uncached symbol, `quote()` runs:
   - `listing()`: `SYMBOL_SEARCH keywords=<avSymbol>` (`index.js:183`).
   - If no exact match comes back and the symbol has a suffix, a second `SYMBOL_SEARCH keywords=<stem>` (`index.js:186`).
   - `GLOBAL_QUOTE symbol=<avSymbol>` (`index.js:207`).
   - Listing hits are cached for 30 days, misses for 1 day. Quotes are fresh for 15 minutes and usable as a stale copy for 1 day (`index.js:180, 202`).
4. The client serializes every call. It spaces request **starts** at least `minSpacingMs = 1200` ms apart and increments the local counter **before** sending (`alphavantage.js:195-201, 217-221`).
5. Every response body goes through `parseAvBody` (`alphavantage.js:72-93`). Alpha Vantage reports errors and limits as HTTP 200 JSON bodies with an `Information`, `Note` or `Error Message` field.

**Requests per ticker:** 2 (search + quote) when the search echoes the suffixed symbol, 3 when the stem search is needed, 0 when cached or rejected locally. Measured with a mocked provider (`repro/classify.mjs`):

| Portfolio | First run of the day | Same day, after listings cached (quotes older than 15 min) |
|---|---|---|
| Owner's 10 holdings | **20** (search hits) to **26** (search misses) | 10 |
| 14 holdings (10 + four currency tests; `7203.T` rejected locally) | **26 to 39**, which exceeds 25/day | 13 |

So, even with no defect, **a free Alpha Vantage key cannot price the 14-row sample on the first day, and allows about one full repricing of the 10-row portfolio per day.**

### 4.2 Confirmed defects

**AV-01. Notice classification depends on order and can turn a transient throttle into "daily limit reached".** Critical. **Confirmed** against Alpha Vantage's current, publicly reported wording; whether this exact notice reached the owner is UNVERIFIED.

`alphavantage.js:81` classifies *any* `Information`/`Note` text that matches `/per day|daily/` **and** `/rate limit|requests/` as the definitive daily limit. The burst rule (`/per second|spreading out|burst…/`, line 82) is only checked afterwards.

**Alpha Vantage's burst notice matches line 81.** Two versions of its wording are publicly reported:
- **2026** (GeneBO98/tradetally#202, 2026-02-05; williamkray/maubot-financebot#2, 2026-03-12): "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints".
- **December 2025** (beancount/beanprice#124) has the same "(25 requests per day)" phrase.

Both match line 81 and are classified as **daily**.

**Reproduction:**
- `repro/classify.mjs` (scenario C).
- `repro/classify_av_notices.mjs` over all nine verbatim wordings (Appendix A.3): both burst versions → `rate_limited`, `definitive=true`, "daily request limit reached". Every other wording is classified correctly.

**Why the tests pass:** the repository's own burst test (`_tools/tests/unit/market-data.test.mjs:507`) uses a truncated, one-sentence fixture. No test uses the real wording.

**AV-02. The daily-limit state is persisted with no recovery path.** High. Confirmed.

On any definitive `rate_limited` error, `markExhausted()` writes `{exhausted:true}` into `localStorage["md.av.v2.<fingerprint>.usage"]` (`alphavantage.js:209-210, 250`). From then on, every call fails locally before any request is sent (`alphavantage.js:190, 194`), until 00:00 UTC.

- 00:00 UTC is 18:00 in the owner's UTC-6 time zone, judging by the merge commit's timestamp.
- The record survives a page reload, closing the tab, "Remove key" and re-entering the same key, because `purgeKeyData` deliberately keeps `.usage` entries (`index.js:136-137`).
- It is shared by the Rebalancer and the Stock tool (same origin, same namespace).
- There is no "retry", no "check again" and no display of when the block ends.
- Reproduced: in `repro/classify.mjs` scenarios C and E, a new page with the same key later the same day sends **0 requests** and reports the limit again.

**AV-03. One limit response turns every remaining holding into the same failure.** High. Confirmed.

`quotes()` keeps looping, but each later call throws `limitError()` from the local flag without contacting the provider. The UI then prints one warning per holding (`app.js:472`). This is the "daily-limit message repeated against every holding" in the screenshots.

**AV-04. The request counter is a local estimate presented as quota usage.** Medium. Confirmed.

`createUsageCounter` (`alphavantage.js:235-252`) counts requests that **this browser** sent with **this key**, from both tools, since **00:00 UTC**. The panel says "About N of 25 free requests used today here" (`app.js:281`).

- It cannot see requests from other devices or apps, or any IP-level accounting.
- It does not use Alpha Vantage's own reset time, which is not documented on the support page (see §5).
- When the provider says the limit is reached while the counter shows 1 or 2, the UI does not point out the contradiction.

**AV-05. The provider's own message is discarded.** Medium. Confirmed.

The user only ever sees the mapped sentence. The raw notice is not kept (a redacted copy would be safe to show), so neither the user nor the owner can tell a burst limit from a daily limit, an IP-level limit or a premium-endpoint answer. This is why the incident cannot be fully diagnosed from the screenshots.

**AV-06. Spacing is measured start-to-start, per page.** Medium. Evidence-backed risk.

Spacing is 1.2 s start-to-start, with one burst retry after 1.5 s (`alphavantage.js:196-208`). Two consequences:
- **Fast follow-ups after slow requests.** A slow request (TLS setup, a slow `SYMBOL_SEARCH`) can be followed by a fast one, so Alpha Vantage may receive two requests less than 1 s apart. The 2026 burst notice polices exactly that.
- **No shared spacing between tools.** Each page builds its own client (`index.js:161`), so the two tools share a key but not the spacing.

There is also no per-minute budget. Third-party sources still mention 5 requests per minute; this is UNVERIFIED against Alpha Vantage's own pages, which state only 25 per day (Appendix A.3).

**AV-07. The quote's price type is unknown.** Low. Design weakness.

`GLOBAL_QUOTE` returns a trading day without a time. The app labels the value "latest trading day" (`alphavantage.js:140-142`) but cannot say whether it is the official close or a last trade, or how delayed it is. The cross-provider comparison in §6 needs this distinction.

### 4.3 Reproduction of the owner's screenshots (Chromium, mocked providers, `repro/incident.js`)

Steps, mirroring what the owner did:
1. Open the page; it loads the 9-row generic sample with its illustrative prices.
2. Set Rows to 10 and overwrite ticker, shares, currency and weight. Leave the price fields as they are and type 136 for VST.
3. Set CAD reporting, New Money, budget 3000.
4. Save a key and run.

| Scenario | Requests | Counter after | Status | Warnings |
|---|---|---|---|---|
| Daily-limit notice on the first Alpha Vantage response | 1 | "About 1 of 25" | **Completed with 20 warning(s)** | 10 × "live price unavailable (… daily request limit …); your typed price X was used", 9 × "Price was for the previous ticker; check it", 1 × budget scaling |
| Burst notice (full wording) on request 3 | 3 | "About 3 of 25" | Completed with 18 warnings, as counted by the app's status line (19 list items, 1 of them an info note) | Same pattern, but VEQT.TO priced |
| Healthy provider | 20 | "About 20 of 25" | Completed with 1 warning (7 list items: 6 are info notes) | – |

The first scenario reproduces the screenshots exactly:
- the same warning text, including "XQQ.TO: live price unavailable (…); your typed price 42 was used";
- the same total of 20 warnings;
- the same row-1 price of 250.

The owner's "≈2 of 25" fits a limit notice on the **second** request: `SYMBOL_SEARCH VEQT.TRT` succeeded, then the notice arrived on `GLOBAL_QUOTE`. The warning composition is the same, since VEQT.TO is then also unpriced.

**Key evidence:** the owner's "typed prices" 250, 36, 42, 64, 64, 7.4, 180, 72 and 40 are exactly the illustrative prices of the old sample's rows 1–9 (VTI 250, XIC 36, VEQT 42, EWJ 64, VGK 64, ISF.L 7.4, AAPL 180, BND 72, MCHI 40; `app.js:23-33`). They were never typed for these instruments: they were carried over when the tickers were overwritten.

### 4.4 Disposition of the 20 hypotheses in the brief

| # | Hypothesis | Finding |
|---|---|---|
| 1 | Invalid or unactivated key | **Unlikely.** An invalid key returns `Error Message … apikey`, which maps to "Alpha Vantage rejected the API key" (`alphavantage.js:89`), not the daily-limit text. Format check: `^[A-Za-z0-9]{8,64}$`. |
| 2 | Account-wide limit not reflected by the counter | **Possible; cannot be excluded** (AV-04). It produces the same UI as #5. |
| 3 | Provider-side rate limiting (burst) | **Leading candidate.** Combined with AV-01 it yields exactly the observed UI. |
| 4 | Restricted free endpoints | **Not the cause.** `SYMBOL_SEARCH` and `GLOBAL_QUOTE` are free (see §5); a premium answer would read "premium feature". |
| 5 | Misclassification | **Confirmed defect** (AV-01). |
| 6 | Premium answer read as the daily limit | **No.** The premium notice maps to `not_found` "premium feature" (scenario F), unless the live wording contains "per day"; see §5. |
| 7 | Invalid symbol formatting | **Not this symptom.** A bad symbol gives "no quote found" or "no data". Separate symbol issues are in §10. |
| 8 | SYMBOL_SEARCH | **Contributes.** It is the first request for every uncached ticker and costs 1–2 of the 25 (AV-04 cost table). |
| 9 | GLOBAL_QUOTE availability | Free; not the cause. |
| 10 | Exchange coverage | TSX via `.TRT` is supported by the adapter. Tokyo `.T` is rejected locally. Not the cause of this symptom. |
| 11 | TSX mapping | `.TO`→`.TRT` and `.V`→`.TRV` match Alpha Vantage's documented suffixes. Not the cause. |
| 12 | Requests too fast | **Possible trigger** (AV-06). |
| 13 | Counter implementation | **Confirmed misleading** (AV-04). |
| 14 | Persisted exhausted state | **Confirmed** (AV-02); it blocks every retry until 00:00 UTC. |
| 15 | Session or localStorage state | Contributes. The usage record is in localStorage even when the key is session-only (`index.js:121, 155`). |
| 16 | HTTP-200 error payloads | Handled, but by fragile text matching (AV-01). |
| 17 | Use from another device or app | **Possible.** Invisible to the counter (AV-04). |
| 18 | CORS | **Not the cause.** A CORS failure surfaces as "network or CORS error" (`http.js:91`), not the limit text. |
| 19 | Caching | The quote and listing caches are not the cause; the cached exhausted flag is (AV-02). |
| 20 | Cross-application key state | **Confirmed shared.** The Stock tool and the Rebalancer share the key, counter and exhausted flag on the same origin. Earlier Stock-tool use counts toward, and can set, the Rebalancer's block. |

**Conclusion.** The symptom is fully explained by one chain: the first or second Alpha Vantage response was classified as the daily limit, that state was persisted, and it was applied to every holding. The app then fell back to prices carried over from the sample.

**The most probable trigger is AV-01:** Alpha Vantage's 1-request-per-second notice, which contains "(25 requests per day)", read as the daily limit.
- It fits "≈2 requests counted".
- It fits a freshly created key.
- It fits back-to-back `SYMBOL_SEARCH` → `GLOBAL_QUOTE` calls whose start times can arrive less than 1 s apart after a slow first request (AV-06).

**A genuine daily limit remains possible** (#2, #17, or IP-level accounting) and is **UNVERIFIED**, because no valid key is available in this environment. Either way:
- defects AV-01 to AV-06 and the request-cost limit in §4.1 are real and must be fixed;
- Alpha Vantage alone cannot meet the 14-security automatic-pricing requirement.

### 4.5 Redacted evidence-collection procedure for the owner

These steps cost at most three of the key's daily requests. **Never paste the key, the `md.settings.v1` storage value, or any URL containing `apikey=` into a ticket, chat or screenshot.**

1. **Record the local state.** In the browser where the failure happened, open DevTools → Console on `https://elmatthe.github.io/projects/portfolio-rebalancer/`. Run this; it prints only the usage records, which contain no key:
   ```js
   Object.keys(localStorage).filter(k => k.startsWith("md.av.v2.") && k.endsWith(".usage")).map(k => [k.replace(/k[0-9a-z]+/, "<fp>"), localStorage.getItem(k)])
   ```
   Note whether `"exhausted":true` is present, and your local time and the UTC time.
2. **Capture the provider's raw notice from a terminal**, keeping the key out of shell history:
   ```bash
   read -rs AVKEY && curl -sS "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=$AVKEY" | sed -E 's/(API key as )[A-Za-z0-9]+/\1[REDACTED]/'; unset AVKEY
   ```
   Copy the JSON. If it is a `Global Quote`, the key currently works. If it is an `Information` or `Note` text, copy it verbatim (the key is redacted by `sed`).
3. **Test the browser path.** Only if step 2 returned a quote: clear the local block for this one test with
   ```js
   Object.keys(localStorage).filter(k => k.startsWith("md.av.v2.") && k.endsWith(".usage")).forEach(k => localStorage.removeItem(k))
   ```
   This resets the page's own counter; it does not affect Alpha Vantage. Then, with DevTools → Network → "Preserve log", filter `alphavantage`. Run the Rebalancer with a **single** row (`AAPL`, USD). Open each request's **Response** tab only; do not copy the request URL. That costs 2 requests.
4. **Answer three questions.**
   - Was the key used anywhere else that day: the Stock tool, another device, a script, a phone?
   - Is the browser behind a VPN, iCloud Private Relay, or a corporate or campus network?
   - At what local time did the failure happen?
5. **Interpret the notice.**

   | Notice text contains | Meaning |
   |---|---|
   | "standard API rate limit is 25 requests per day" | Genuine daily limit (hypothesis #2 or #17) |
   | "spreading out … 1 request per second" | Burst throttle, misclassified (AV-01) |
   | "premium endpoint" | Entitlement restriction |
   | `Error Message … apikey` | Invalid key |

**Status:** real-key diagnosis UNVERIFIED pending this evidence.

---

## 5. Market-data provider comparison

Appendix A has the full 29-field matrix, verbatim terms, probe evidence and sources. This section summarises the decision.

### 5.1 Matrix (condensed)

**Column meanings:**
- **Free quota:** the free-plan request limit.
- **CORS:** the `Access-Control-Allow-Origin` header observed for `Origin: https://elmatthe.github.io`. Without it, a browser page cannot read the response.
- **Display:** whether showing the data to the visitor who owns the key is allowed.

| Provider | Free quota | Free coverage relevant here | CORS | Display to key owner | Verdict |
|---|---|---|---|---|---|
| **Alpha Vantage** | 25/day; 1 per second (from its notice text) | US; TSX `.TRT`; TSX-V `.TRV`; LSE `.LON` (GBX); Xetra `.DEX`; SSE `.SHH` and SZSE `.SHZ`. No Tokyo, no Cboe Canada. Indexes are premium. | `*` | Personal, non-commercial | **Keep: primary** |
| **Finnhub** | Per-minute quota UNVERIFIED (30/s cap) | US quotes, real-time. International is Enterprise-only. Candles are premium. | `*` | "Strictly for personal use" | **Keep: US** |
| **Massive** (ex-Polygon) | 5/min; 2 years end-of-day | US | Echoes origin | Personal, non-business | **Keep: US, optional** |
| Twelve Data | 8/min, 800/day | US only on Basic. TSX, LSE and Xetra are on Grow; JPX and SSE on Pro. | `*` | **Non-display** on Basic | Exclude |
| FMP | 250/day | Canada and UK on Premium only | `*` | Display needs a licensing agreement | Exclude |
| EODHD | 20/day plus 500 once | Global end-of-day claimed | **none** | No display to others | Desktop only |
| Tiingo | 1,000/day | US, US mutual funds, China | **none** | Internal use only | Desktop only |
| Marketstack | 100/**month** | — | `*` | Non-commercial | Exclude |
| StockData.org, Alpaca, Tradier, Intrinio | — | US only, and/or an account secret, Partner status or no free plan | various | — | Exclude |
| MarketData.app | 100/day, 24-hour delay | US | `*` | Personal | Alternate only |
| OpenFIGI | 25 requests/min | Identity only; no currency field | **none** | Public domain | Desktop identity |
| yfinance (Yahoo) | — | Global | n/a | Yahoo terms forbid automated collection | Desktop opt-in only (DEC-05) |
| Stooq | — | — | n/a | CAPTCHA-issued key | Exclude |
| Scrapling | — | Stealth and anti-bot toolkit | n/a | — | No compliant role |

### 5.2 Recommended shortlist (at most five; not padded)

**Browser, three providers. Each uses the visitor's own key, which never leaves the visitor's browser except to that provider.**

| # | Provider | Use | Limits |
|---|---|---|---|
| 1 | **Alpha Vantage** | Every supported non-US listing; US fallback | 25/day |
| 2 | **Finnhub** | US listings (default router for US); cross-check source | US only |
| 3 | **Massive** | Optional US end-of-day cross-check and history | 5/min |

**Baseline (no key), always available:**
- CSV price import, local only;
- explicitly labelled synthetic demo;
- official FX from the Bank of Canada and the ECB.

**Desktop, four price providers plus one identity source:**

| # | Provider | Notes |
|---|---|---|
| 1 | Alpha Vantage | — |
| 2 | **EODHD** | Global end-of-day coverage claimed; free coverage UNVERIFIED |
| 3 | **Tiingo** | US, US funds, China |
| 4 | Finnhub | — |
| + | **OpenFIGI** | Identity only |
| opt-in | yfinance | Labelled "unofficial source", if the owner keeps it (DEC-05) |

**Market coverage on free keys:**

| Market | Browser | Desktop |
|---|---|---|
| US | AV, Finnhub, Massive | All four |
| TSX / TSX-V | AV | AV, EODHD (claimed) |
| Cboe Canada (YNVD) | **none** | EODHD (UNVERIFIED) |
| LSE, Xetra, SSE | AV | AV, EODHD (claimed); Tiingo (SSE) |
| Tokyo | **none** | EODHD does not list Tokyo; **none verified** |
| Canadian mutual funds | **none** | **none**; issuer NAV via CSV |
| Indexes | **none** free | — |

### 5.3 Provider UX (requested features), assessed

- **Choosing a provider, and entering keys per provider.**
  - Use one settings panel with one key slot per provider.
  - Each slot keeps the existing session-or-local storage choice, redaction and removal behaviour.
  - Each slot shows that provider's markets (from the tables above) and its quota.
- **Automatic routing** (US → Finnhub; other markets → Alpha Vantage).
  - It is allowed **only when visible**: each row shows the provider that priced it.
  - A setting labelled "Route by market (recommended)" makes the routing an explicit choice rather than a silent switch.
- **Optional cross-check** (§6.7).
  - Free coverage limits it to US listings in the browser.
  - On the desktop it also covers Canadian ETFs (Alpha Vantage vs EODHD; EODHD free coverage UNVERIFIED).
- **"Why can't this be priced"** messages come from the coverage tables, for example: "YNVD trades on Cboe Canada; none of your configured providers cover Cboe Canada on a free plan."

---

## 6. Automatic pricing and currency architecture

This section is a design proposal only. Nothing in it is implemented.

### 6.1 Principles

1. **Resolve first, then price.** A price is only ever attached to a *resolved instrument* (exchange + provider symbol + quote currency + quote unit). It is never attached to the text in a ticker box.
2. **Evidence over inference.** Currency comes from the provider's metadata for that exact listing. An exchange default (e.g. XTSE → CAD) is a *hint* that needs confirmation, because TSX also lists USD-traded units (`.U`). A ticker suffix is only an input to resolution.
3. **No price, no plan.** Valuation completeness gates the plan (SS-04).
4. **Quota-aware by construction.**
   - Every network action has a known cost.
   - The cost is shown before batch work.
   - Metadata is cached far longer than prices.
5. **One contract for every provider.** Each adapter maps its provider to the shared schemas below. Both tools use the same adapters. The desktop app mirrors the contract in Python, sharing the JSON-schema fixtures (§7, §12).
6. **Never switch provider silently.** Automatic mode may try a second provider only if the user enabled it. The row always says which provider supplied the price, and why a fallback was used.

### 6.2 Response contracts (shared JS/Python; JSON-schema fixtures under `_tools/tests/fixtures/contracts/`)

```text
InstrumentQuery   { input: "VEQT.TO", hintCurrency?: "CAD", hintExchange?: "XTSE" }

ResolvedInstrument {
  id: "XTSE:VEQT",                 // canonical = MIC + local symbol
  input: "VEQT.TO",
  symbol: "VEQT", mic: "XTSE", exchangeName: "Toronto Stock Exchange", country: "CA",
  name: "Vanguard All-Equity ETF Portfolio", assetType: "etf" | "equity" | "adr" | "fund" | "index" | "unknown",
  quoteCurrency: "CAD", quoteUnit: "major" | "minor", unitScale: 1 | 0.01,   // GBX/GBp -> GBP, 0.01
  currencyEvidence: "provider_listing" | "provider_quote" | "exchange_default_unconfirmed" | "user_override",
  providerSymbols: { alphavantage: "VEQT.TRT", twelvedata: "VEQT:XTSE", ... },
  resolution: { status: "resolved" | "ambiguous" | "unresolved" | "unsupported",
                confidence: "exact" | "high" | "low", provider, resolvedAt,
                candidates?: [{ id, name, mic, currency, assetType }] }   // for "ambiguous"
}

Quote {
  instrumentId: "XTSE:VEQT", provider, providerSymbol,
  price, currency, unitScale,                       // price already in major units
  priceType: "close" | "last" | "delayed_last" | "previous_close" | "nav" | "unknown",
  tradingDate: "2026-11-02", asOf?: ISO-8601 with offset,   // when the provider gives a time
  delayMinutes?: number, adjusted: false,
  retrievedAt, cache: "none" | "fresh" | "stale", requestCost: number
}

PriceError {
  instrumentId?, provider, kind:
    "quota_daily" | "quota_burst" | "quota_monthly" | "auth" | "entitlement" | "not_covered" |
    "not_found" | "ambiguous" | "currency_unconfirmed" | "network" | "cors" | "provider_down" |
    "budget_withheld" | "cancelled" | "superseded",
  retryable: boolean, retryAfter?: ISO, providerMessage?: string (redacted, ≤ 300 chars)
}
```

### 6.3 Per-row state model (both tools)

```text
empty ──type ticker──▶ draft ──blur/Enter──▶ resolving ──▶ resolved ──▶ pricing ──▶ priced
                                    │                ├──▶ ambiguous (user picks a listing) ──▶ resolved
                                    │                ├──▶ unresolved / unsupported (reason + "try provider X")
                                    │                                            pricing ──▶ unavailable (PriceError)
                                    └── edit ticker at any time ──▶ draft (revision += 1, price & evidence cleared)
priced ──age > policy──▶ stale (shown, plan blocked or warned per policy)
```

- **Row revision.** Each row has a `revision`. Every request carries `(rowId, revision, instrumentId)`, and a response is applied only if all three still match. A late answer for an old ticker is dropped; its row state becomes `superseded`. This fixes SS-05 and satisfies "late response for the previous ticker must never populate the new ticker".
- **Cancellation.** Each row has its own AbortController. A row may share an in-flight request with another row holding the same instrument (deduplicated by `instrumentId`). Aborting detaches only that caller; the shared request is aborted only when no row still wants it (the existing `forCaller`/deduper pattern, `index.js:55-63`).
- **Provider switch while busy.** The current provider session is retired, exactly as on a key change today (`index.js:301-308`). Every row returns to `resolved` (metadata kept only if it came from a provider-independent source, see §6.4), and pricing restarts under the new provider.
- **Shares and targets never change** during resolution or refresh (they are not part of the row's market state).

### 6.4 Resolution pipeline and request budget

1. **Normalize the input locally** (no network):
   - map Yahoo-style suffixes to a MIC: `.TO`→XTSE, `.V`→XTSX, `.NE`→NEO/Cboe Canada, `.L`→XLON, `.DE`→XETR, `.T`→XTKS, `.SS`→XSHG, `.SZ`→XSHE;
   - accept the `TSX:` and `LSE:` prefixes (`engine.js:41`);
   - a bare US-style ticker → "US listing expected".
2. **Look in the metadata cache** (listings: 180 days; IndexedDB or localStorage, per provider and key). A hit costs 0 requests.
3. **Use the curated instrument reference.** This is a small, versioned JSON shipped with the site, e.g. `assets/data/instruments.json`. It holds identity facts only: symbol, MIC, name, asset type, quote currency, quote unit, a source URL and a verified date. **It holds no prices.** It covers the sample instruments and common Canadian ETFs.
   - Listing facts such as "VEQT trades on the TSX in CAD" are not licensed market data.
   - Each entry cites an issuer or exchange page (see Appendix B).
   - A match gives `currencyEvidence: "curated_reference"` at a cost of 0 requests. The provider's own metadata, when fetched, still wins.
4. **Ask the provider**, choosing the cheapest call that returns currency for that exact listing:
   - **Alpha Vantage:** `SYMBOL_SEARCH` (1 request). The stem-search fallback runs only when the user asks for it (it is 1 more request), then `GLOBAL_QUOTE` (1).
   - **Finnhub (US):** `/stock/profile2` (currency, exchange), then `/quote`.
   - Twelve Data's `/quote` returns currency and exchange in one call, but its free plan is non-display (Appendix A.1). It is excluded unless the owner obtains a display licence.
5. **Handle ambiguity.** When several listings match and neither the suffix nor a hint narrows them, the row becomes `ambiguous`.
   - Show the candidates with name, exchange and currency.
   - **Never pick a US listing for a `.TO` input**, or vice versa.
   - Known traps (Appendix B.5):
     - `YNVD.TO` exists only as Cboe Canada `YNVD.NE`;
     - `SAP` on the TSX is Saputo, not SAP SE;
     - `CBRS` and `SPCX` on the TSX are CIBC depositary receipts (CDRs), not the US shares.
6. **Run a budget planner before any batch** (sample load, "Refresh all", first run).
   - Compute the cost per provider: rows needing resolution × resolution cost, plus rows needing a price × quote cost.
   - Compare it with the provider's documented quota and the local estimate, then show something like:
     > "Pricing 10 holdings: about 6 Finnhub requests for 4 US listings, and about 10 of your 25 daily Alpha Vantage requests for 5 TSX listings. YNVD.TO is not covered by these providers (see details)."
   - Rows with **0 shares and 0 % target** (the currency-test rows) are skipped by default ("Price test rows" button).
   - When the budget cannot cover everything, price rows by plan impact: target weight, then current value. Withhold the rest with `budget_withheld` and a clear message. The plan stays blocked until they are priced.
7. **Pace** each provider by its documented limits (per second, per minute, per day). Burst notices back off and retry. Daily notices stop that provider only, and are shown verbatim (redacted).

### 6.5 Freshness policy (displayed, configurable per tool)

| Quote age (from tradingDate in the listing's exchange time zone) | Label | Plan |
|---|---|---|
| Same or previous trading session | "Close 2026-11-02" / "Delayed 15 min, 10:42 ET" | Allowed |
| 2–4 sessions old (holiday weekends) | "Stale: 3 sessions old" | Allowed, with warning |
| > 4 sessions old | "Too old" | Blocked |

Exchange holiday calendars are not available from free sources, so session age is approximated by business days. This is documented as a limitation.

### 6.6 Tests required

- Contract fixtures validated in JS (`node --test`) and Python (pytest), shared JSON files.
- An adapter test per provider, using recorded, redacted, real response shapes: success, every error wording, unknown symbol, ambiguous search, a GBp listing, a USD-traded TSX unit.
- Row state-machine unit tests: revision and late-response drop, abort, shared dedupe, provider switch.
- Budget planner unit tests: the 10-row and 14-row samples under each provider's quota; withholding order.
- Browser:
  - automatic lookup on blur;
  - loading indicator;
  - per-row error with retry;
  - no plan while incomplete;
  - sample load prices only the 10 main rows by default;
  - a ticker change during an in-flight request;
  - a provider change during an in-flight batch.
- An optional live smoke test (owner-run, key from `read -rs`), at most 1 request per instrument per provider.

### 6.7 Optional cross-provider price comparison

This feature is off by default and is triggered per row ("Cross-check") or per batch. Before it runs, the user sees its cost.

1. **Comparable only.** Two quotes are compared only if they refer to the **same instrument** (same MIC and symbol, or the same FIGI or ISIN) in the **same currency and quote unit**. Different listings, such as an ADR against the local share or a CDR against the US share, are never compared as if identical. They may be shown side by side, labelled "different instruments".
2. **Show for each source:** provider, price, currency and unit, price type (close, last, delayed), trading date, `asOf` time if any, and adjusted or unadjusted.
3. **Classify the result:**

   | Condition | Classification |
   |---|---|
   | Same trading date, both closes | Diff % = (a − b)/b |
   | Different trading dates | "Not comparable: different sessions"; show both, no %. |
   | Close vs intraday/last | "Not comparable: different price types" |
   | Adjusted vs unadjusted | Not compared (quotes are unadjusted) |

4. **Thresholds** (closes, same session, same currency):

   | Diff | Label |
   |---|---|
   | ≤ 0.10 % | "Consistent" (rounding, odd-lot or closing-auction differences) |
   | 0.10 %–1 % | "Minor difference" (venue or feed differences) |
   | > 1 % | "Investigate" |

   For "Investigate", show likely causes, in this order:
   - a corporate action on that date;
   - a stale feed;
   - pence vs pounds (a factor of 100);
   - a wrong listing.

   An exact factor of 100 or 0.01 means a unit problem; a factor near 1.25, 1.5, 2, 3, 4, 5 or 10 points to a split.
5. **Never average two prices automatically.** The plan always uses the price from the row's chosen provider. The comparison is advisory and is recorded in the exports.
6. **Free-tier coverage.** On free tiers the cross-check is only possible for **US listings** in the browser (Alpha Vantage vs Finnhub vs Massive). On the desktop it can also cover Canadian ETFs (Alpha Vantage vs EODHD; EODHD free coverage UNVERIFIED). The UI says so, rather than offering a button that can never work.

---

## 7. Four-tool assessment

Detailed findings, numeric reproductions and file:line references are in the appendices. IDs below match the appendices and the backlog in §12.

### 7.1 Portfolio Rebalancer

**Browser** (§3 defect register; my reproduction):

| Severity | Findings |
|---|---|
| Critical | SS-01, SS-04, SS-05 (see §1.1) |
| High | SS-02 (contradictory counter), SS-07 (no automatic prices), SS-08 (horizontal scroll), SS-12 (misleading sample), SS-14 (manual row currency) |
| Medium | SS-03, SS-06, SS-09, SS-10, SS-11, SS-13 |
| Low | SS-15, SS-16 |

Additional browser items from the engine audit (Appendix E):
- **RB-02:** blank Shares or Target becomes 0, so a blank target gives "sell all".
- **Chromium number inputs:** `badInput` values become `""`; `1,5` becomes 15.
- **Hidden account types** still affect the plan (`app.js:130`).
- **Pence label:** "(pence)" is shown for every minor unit, including ZAc and ILA (`app.js:431`).
- **RB-01 (browser side):** "Buy $0.00" is shown when every sell is inside the hold band.

**Engines.**
- `engine.js` and `core.py` are line-for-line equivalent. Both match an exact Fraction-based hand calculation of the owner's 10 holdings, in both modes, with every difference under 1.8e-12 (Appendix E.4).
- Neither engine plans with a *missing* price.
- Neither has a "not valued" state. As a result, the four 0-share, 0 % currency-test rows **block the run** unless they have a price (RB-42).

**Desktop** (Appendix E):

| ID | Severity | Finding |
|---|---|---|
| RB-01 | High | `ZeroDivisionError`; a stale plan is left on screen during live recalculation |
| RB-03 | Medium | Accepts NaN and inf |
| RB-04 | Medium | The budget field cannot be re-shown after switching modes |
| RB-05 | Medium | Raw currency keys (`JPN`, `CHY_CNH`) appear in the UI and exports; `.HK` is mapped to CNY |
| RB-06 | Medium | yfinance quote with no currency is accepted; cross-market fallback switches the listing; Yahoo is called on start-up with live data off |
| RB-07 | Medium | Plan output has no scrollbars; fixed geometry; no DPI handling |
| RB-08 | Medium | Exports lack FX rates, sources, warnings and timestamps |

### 7.2 Stock Comparison & Analytics (Appendix C)

**Browser.**
- **Accuracy:** matches numpy/scipy to ≤ 1.24e-9. Its workbook reproduces every figure from its own raw sheet to ≤ 1e-14.

| ID | Severity | Finding |
|---|---|---|
| B1 | High | Unadjusted short-window data; 3-for-2 and 5-for-4 splits are not flagged |
| B2 | Medium | Zero-variance benchmark gives a meaningless beta |
| B3 | Medium | Same as AV-01/02; here the pill stays green |
| B4 | Medium | 1D results are annualised (+1,127 %) |
| B5 | Medium | False currency warnings in demo mode |
| B6 | Medium | 21–31 requests per comparison against a 25/day limit; the page says "two requests" per ticker |
| B11 | Medium | The metrics table scrolls horizontally at every width |
| B7–B10, B12 | Low | — |

**Desktop.**

| ID | Severity | Finding |
|---|---|---|
| D1 | High | Union-of-dates alignment. SPYX: n 249 → 242, Sharpe 0.801 → 0.353 |
| D2 | High | The cumulative chart fills gaps with 0: +8.3 % shown vs +16.7 % in the table |
| D3 | Medium-High | Unfinished weekly and monthly bars are kept |
| D4 | Medium | Zero-variance benchmark; with rf = 0 the whole run aborts |
| D5 | Medium | Exports contain no data, and a `=HYPERLINK()` value is written as a live formula |
| D6 | Medium | Unbounded FX fill, with look-ahead |
| D7 | Medium | CSV import accepts duplicate dates and prices ≤ 0 |
| D8, D9, D11–D13 | Low | — |

**Mixed frequency and basis across horizons.** The live-data rule (daily as-traded data for windows up to 135 days, weekly adjusted beyond) remains **misleading even with correct labels**. The same ETF shows 45 % annualised on 3M price-return data vs 19.9 % on 1Y total-return data (HYETF fixture). Remediation: adjust short windows, or detect splits and exclude the ticker; add a basis badge; suppress annualised figures under 6 months (R2, R10).

### 7.3 Monte Carlo Retirement Simulator (Appendix D)

**Shared (both engines).**
- Identical model: 2.2e-16 on shared draws; closed forms to 1e-15.
- **MC-F1 (High):** the units for spending (retirement-year dollars) are easily misread.
- **F2:** "expected return" is not labelled as an arithmetic mean.
- **F3:** volatility up to 300 % is accepted, with no guard against returns below −100 %.
- **F11:** a path that ends at exactly $0 counts as ruin.
- **F12:** withdrawals at year-end are not stated.

**Browser.**

| ID | Severity | Finding |
|---|---|---|
| F6 | Medium | Claims of "no network" and "same validation messages" are false |
| F7 | Medium | A stalled Chart.js CDN request blocks the app |
| F9 | Low | Warnings are overwritten by "Done." |
| F13 | Low | Seed-overlap quirk |
| F14 | Low | Accessibility gaps; table scrolls at 1024 and 390 px |
| F16 | Low | Export metadata |

**Desktop.**

| ID | Severity | Finding |
|---|---|---|
| F4 | Medium, Confirmed | The sample scenario fails about 2.5 % of the time |
| F5 | Medium | No seed, so runs are not reproducible |
| F8 | Medium | Writing into an existing workbook drops drawing shapes |
| F10 | Low | "Safe Withdrawal Rate" mislabel |
| — | — | Nominal values only; 15 of 18 input-parsing differences from the web |

**Offline.** The desktop runs offline after setup. The web needs the page load and the CDN; self-hosting Chart.js fixes this (D R6).

### 7.4 CPI Web Scraper (Appendix F)

**Desktop.**

| ID | Severity | Finding |
|---|---|---|
| CPI-01 | High | S&P 500 data redistributed in the public ZIP |
| CPI-02 | High | Stale saved model results |
| CPI-03 | High | "Single month" wipes the history |
| CPI-04 | Medium | Partial-month values are not flagged |
| CPI-07 | Medium | No upper bound on the end date |
| CPI-08 | Medium | The UI thread freezes during downloads |
| CPI-05 | Low | Personal path, username and add-in metadata in the workbook |
| — | Low | Error-message mapping; attribution; claim gaps; vacuous test |

All 18 series IDs are verified against official metadata. The pre-write validation is good.

**Browser** (today: a project page only, no app).
- **Feasible:**
  - Statistics Canada WDS JSON (GET and POST), and Bank of Canada Valet, with CORS `*` proven in Chromium.
  - FRED data through user-downloaded files.
  - A new values-only workbook or CSV with a Sources sheet.
- **Not feasible:**
  - Live FRED access (no CORS, even with a key).
  - S&P history (licence).
  - Faithful in-place workbook update: SheetJS CE 0.20.3 and ExcelJS 4.4.0 lose charts and pivots, neither recalculates, and each corrupts something else.
- **Proposed:** a "CPI data pack builder" (F.6).

---

## 8. Browser versus desktop parity matrix

**Legend:**
- **Eq**: equivalent.
- **B+**: browser superior.
- **D+**: desktop superior.
- **Miss**: missing on one or both sides.
- **Restr**: technically restricted.
- **Fix**: needs remediation.

The per-tool matrices with a reason for every row are in Appendices C.7, D.9, E.7 and F.8. The consolidated view:

| Capability | Rebalancer | Stock | Monte Carlo | CPI |
|---|---|---|---|---|
| Core calculation engine | Eq (match to 1e-12); **Fix** RB-01 | **Fix** D1/D2/D3 (desktop); browser matches reference | Eq (2.2e-16) | n/a (data tool) |
| Input validation | **Fix** (RB-02 browser, RB-03 desktop) | B+ | **Fix** (15/18 parsing differences) | D+ (strict config); browser not built |
| Automatic market data | **Restr** browser (own key; AV + US providers); D+ coverage via yfinance (DEC-05) | Same | n/a (offline by design) | Browser: StatCan live, FRED import (**Restr**) |
| Instrument and currency resolution | B+ (verified currency); **Fix** both (identity layer, `.NE`, HKD, ISO labels) | B+ | n/a | n/a |
| FX | B+ (official, dated, editable) | B+ (D6 desktop) | n/a | n/a |
| Provenance and timestamps | B+ | B+ | B+ (seed) | **Fix** both (attribution) |
| Reproducibility | B+ | B+ | B+ (desktop has no seed) | Eq (re-fetch) |
| Real vs nominal | n/a | n/a | B+ | n/a |
| Charts | n/a | D+ (rolling, scatter); **Fix** D2 | Eq | D+ (Excel model) |
| Exports | B+ CSV / mixed XLSX; **Fix** RB-08 desktop | B+ data; D5 desktop | B+ CSV; D+ XLSX | D+ in-place; browser: new file only |
| Write into an existing workbook | Mixed (desktop merges) | n/a | **Fix** shape loss | D+ (COM); **Restr** browser (proven losses) |
| Layout without horizontal scroll | **Fix** (browser and desktop) | **Fix** (B11) | **Fix** (small) | Minor (390 px) |
| Accessibility | B+ (gaps) | B+ (gaps) | B+ (gaps) | B+ (page) |
| Offline | Eq (manual or CSV) | Eq | **Fix** web (CDN) | D+ |
| Platform reach | B+ | B+ | B+ | B+ (desktop needs Windows and Excel) |

**Parity recommendation.**
1. **Shared engines.** Make the engine contracts identical by construction, with shared JSON fixtures run by both `node --test` and pytest. Include validation messages and warning text, not only numbers.
2. **Same providers.** Give both platforms the *same* provider adapters, configured by the user with the same key.
3. **One documented capability gap.** The desktop may additionally offer providers without CORS (EODHD, Tiingo, OpenFIGI). That is a technical restriction of browsers, not added value for desktop users.
4. **Seed-matched Monte Carlo.** Port the web generator (mulberry32 + Box–Muller) to the desktop. This is proven feasible to about 1e-15.
5. **CPI.** Keep CPI desktop-first. Offer the browser data-pack builder as the cross-platform version, and state its limits plainly.

---

## 9. UI redesign proposal (Rebalancer; no horizontal scrolling)

### 9.1 Layout goals

Every financial value must be reachable by vertical scrolling only, from 360 px to 1920 px wide and at 100/125/150 % zoom:
- no element wider than its container;
- values in text of at least 14 px;
- metadata at least 13 px.

The comparison between holdings (what to buy or sell, how much) must be visible without clicking.

### 9.2 Holdings editor (replaces the 9-column input table)

A list of **holding rows built with CSS grid**, not a `<table>` with a minimum width.

**At 1100 px and wider, each holding is two lines:**

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ VEQT.TO  Vanguard All-Equity ETF Portfolio · TSX · CAD   Shares [ 305  ]  Target [ 70 ]% Acct [—] ✕ │
│ ● C$<price> close <date> · <provider> · value C$<value> (<weight> %)         ↻ Refresh  ⋯ Source │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Below 700 px the same holding is a card**, with the same fields stacked as label/value pairs.

**Price status** is a coloured dot plus text, not colour alone:
- Verified
- Stale (n sessions)
- Fetching… (spinner, `aria-busy` on the row)
- Unavailable: reason with a Retry link
- Needs choice (ambiguous)
- Unsupported by this provider: "try X"

**The currency is read-only metadata.** An override control appears only for an unresolved instrument, labelled "Set currency manually (unverified)".

**Above the list:**
- a summary bar: "10 holdings · 8 priced · 2 unavailable · Total C$xx,xxx (incomplete)";
- the Reporting currency, Mode, Budget and Provider controls;
- buttons: "Load sample", "Price test rows", "Refresh all (≈ N requests)".

### 9.3 Trade plan (replaces the 14-column output table)

1. **Plan header tiles:** Mode · Total value · Budget · Total buys · Total sells · Uninvested cash · Valuation status (Complete or Incomplete; when incomplete, the rest of the plan is not shown).
2. **Action list.** This is the primary view, and fits the comparison onto one line per holding at all widths of 700 px and up:

   ```text
   BUY   CNQ.TO   <n> sh  ≈ C$<amount>   weight <now> % → <post> %   [details ▾]
   HOLD  VEQT.TO  —                     weight <now> % → <post> %  [details ▾]
   ```

   - Sorted by absolute trade value, with Buy, Sell and Hold grouped.
   - The pill shows the action as text plus an icon.
   - Weights are shown **current → post-trade** (the most useful comparison is missing today).
3. **Details disclosure** (`<details>`, so it expands vertically) per holding, as a two-column definition list:
   - price (local) and source / date / price type;
   - FX rate and source;
   - current value;
   - target value;
   - trade value (reporting currency);
   - trade value (local currency);
   - trade shares (fractional);
   - whole-share alternative (see the engine findings in §7.1);
   - post-trade shares;
   - account.
4. **Warnings:** grouped by cause, with severity tiers (SS-03, SS-11). The plan-level budget scaling notice reads as information, not a warning.
5. **"Full table" export view:** the 14-column table remains available **only** in the CSV/XLSX downloads, and in an optional print view that uses `table-layout: fixed` with wrapped headers at A4 landscape.

### 9.4 Accessibility and behaviour

- Use a real `<ul>`/`<li>` list and `<dl>` for details. Use `aria-live="polite"` only on the one-sentence status; per-row status goes in `aria-describedby`.
- Per-row "Fetching…" uses `aria-busy`. Errors are linked to their inputs with `aria-describedby`.
- Keyboard:
  - Enter in a ticker triggers resolution;
  - Esc cancels the row's lookup;
  - the focus order follows the visual order.
- Contrast: check the green and amber status colours against both themes (WCAG AA 4.5:1 for text).
- Respect `prefers-reduced-motion` for spinners.
- The sticky local navigation wraps or collapses below 600 px (SS-16). Add `scroll-padding-top` on `html` so focused errors are not hidden under it.

### 9.5 Desktop (Tkinter)

The desktop app must follow the same information model: holdings list, action list, details. The engine/desktop findings (§7.1) give the current Treeview layout, its horizontal-scroll behaviour and the DPI scaling findings.

Proposed changes:
- a two-pane window: holdings on the left, plan on the right; it stacks below 1100 logical px;
- a Treeview with a compact column set (Ticker, Action, Trade, Shares, Weight now→target), plus a details pane for the selected row;
- `tk scaling` honoured for 125 % and 150 %;
- no fixed pixel column widths;
- network calls on a worker thread, with per-row status.

---

## 10. Sample portfolio specification

Identity sources and per-provider symbol formats are in Appendix B.

**Prices are deliberately absent.** The placeholder prices from the screenshots (250, 36, 42, 64, 64, 7.4, 180, 72, 40, 136) are illustrative values carried over from the old sample, not market data (§4.3). They must never be embedded.

**Defaults:** CAD reporting currency, New Money mode, CAD 3,000 budget. Rebalance mode must also work on the same rows.

### 10.1 Original ten holdings (order, shares and targets preserved exactly; targets sum to 100 %)

| Row | Ticker as entered | Shares | Target | Verified identity (Appendix B) | Listing (MIC) | Currency | Alpha Vantage symbol | Proposed browser route | Status / notes |
|---|---|---:|---:|---|---|---|---|---|---|
| 1 | VEQT.TO | 305 | 70 % | Vanguard All-Equity ETF Portfolio | TSX (XTSE) | CAD | VEQT.TRT | Alpha Vantage | OK. Alpha Vantage coverage of this ETF UNVERIFIED (exchange is documented). |
| 2 | CNQ.TO | 48 | 10 % | Canadian Natural Resources Ltd. | XTSE | CAD | CNQ.TRT | Alpha Vantage | OK. The NYSE `CNQ` line trades in USD; never substitute it. |
| 3 | XQQ.TO | 27 | 7 % | iShares NASDAQ 100 Index ETF (CAD-Hedged) | XTSE | CAD | XQQ.TRT | Alpha Vantage | OK. Hedged fund; 3-for-1 split in 2024 (SECONDARY). |
| 4 | HEWB.TO | 14 | 5 % | Global X Equal Weight Canadian Banks Index Corporate Class ETF | XTSE | CAD | HEWB.TRT | Alpha Vantage | OK. Total-return-swap structure. |
| 5 | AAPL | 2 | 2 % | Apple Inc. | Nasdaq (XNAS) | USD | AAPL | Finnhub, with Alpha Vantage as fallback | OK. The TSX `AAPL` is a CAD-hedged depositary receipt (CDR) and must not be substituted. |
| 6 | VFV.TO | 8 | 1 % | Vanguard S&P 500 Index ETF | XTSE | CAD | VFV.TRT | Alpha Vantage | OK |
| 7 | SPCX | 1 | 1 % | Space Exploration Technologies Corp. Class A | Nasdaq Global Select | USD | SPCX | Finnhub | **Ticker reused.** SpaceX has traded under it since 2026-06-12. Tuttle's SPAC ETF used it until 2026-04-06. The TSX `SPCX` is a CIBC CDR. Older history belongs to a different security, and provider coverage of the new listing is UNVERIFIED. |
| 8 | CBRS | 4 | 1 % | Cerebras Systems Inc. Class A | XNGS | USD | CBRS | Finnhub | **Recent IPO** (2026-05-14). The TSX `CBRS` is a CDR; Xetra `CBRS` is a different security (a First Trust ETF). |
| 9 | YNVD.TO | 4 | 2 % | NVIDIA (NVDA) Yield Shares Purpose ETF | **Cboe Canada (NEOE)**, not the TSX | CAD | **none** | **none on free browser providers** | **Suspicious symbol.** `YNVD.TO` maps to `YNVD.TRT`, a TSX listing that does not exist; the correct Yahoo-style form is `YNVD.NE`. Report it, do not silently replace it (DEC-04). |
| 10 | VST | 1 | 1 % | Vistra Corp. | NYSE (XNYS) | USD | VST | Finnhub | OK |

Account type is blank for every row.

### 10.2 Four currency-test holdings (0 shares, 0 %, grouped under "International currency tests")

| Row | Candidate | Verified identity | Listing | Currency and unit | Alpha Vantage | Free browser coverage | Recommendation |
|---|---|---|---|---|---|---|---|
| 11 | 7203.T | Toyota Motor Corp. | Tokyo SE (XTKS) | JPY | none (no Tokyo suffix; site rejects `.T`) | **none** | Keep as the **"no free provider covers this market"** test. No JPY substitute is free in the browser. The NYSE ADR `TM` is USD, so it is not a JPY test. |
| 12 | SAP.DE | SAP SE | Xetra (XETR) | EUR | SAP.DEX | Alpha Vantage (documented exchange) | Keep. Fallback if Alpha Vantage fails: MBG.DEX (Alpha Vantage's own documented example). |
| 13 | VOD.L | Vodafone Group plc | LSE (XLON) | **GBp (pence)** → GBP × 0.01 | VOD.LON | Alpha Vantage | Keep; it exercises pence conversion. Fallback: TSCO.LON (documented; a live demo search on 2026-11-02 returned `GBX`). |
| 14 | 600519.SS | Kweichow Moutai Co., Ltd. (A-share) | Shanghai SE (XSHG) | **CNY** (not CNH) | 600519.SHH | Alpha Vantage | Keep; convert with Bank of Canada `FXCNYCAD`. Fallback: 600104.SHH (documented). |

These four rows must not change totals or trades, and must not block the plan. That needs the "not valued" state for 0-share, 0 % rows (backlog RB-42). Without it, both engines refuse to plan when these rows have no price (Appendix E.1).

### 10.3 "Load sample portfolio" flow and request budget

1. **Load the rows.** Load all 14 rows: the original 10 in order, then a labelled group "International currency tests (0 shares, 0 %)" with a one-click "Remove test rows" button. Set reporting currency CAD, mode New Money and budget CAD 3,000. **Leave every price field empty.**
2. **Resolve identities with no network calls,** using the curated instrument reference (§6.4 step 3, backlog MD-06).
   - Name, listing and currency appear immediately, labelled "Listing data: curated reference (source …)".
   - YNVD.TO is flagged: "YNVD trades on Cboe Canada (YNVD.NE), not the TSX."
   - 7203.T is flagged: "No configured free provider covers the Tokyo Stock Exchange."
3. **Show the request estimate,** then price only the rows that affect the plan (shares > 0 or target > 0), which here is rows 1–10. The test rows are priced on demand with "Price test rows (≈ 3–6 requests)".

**Request budget:**

| Configuration | Day 1 (first visit) | Later the same day / next day (identity cached) |
|---|---|---|
| Current code (Alpha Vantage only; search + stem fallback) | 20–26 (10 rows), 26–39 (14) | 10 / 13 |
| Alpha Vantage only + curated identity (no `SYMBOL_SEARCH`) | 9 quotes (rows 1–8, 10) + 3 test rows = **12** | 9–12 |
| Alpha Vantage only + provider-confirmed currency (search kept) | 18 + 6 = **24**, which fits 25 only if nothing else runs that day | 9–12 |
| Routed: US → Finnhub (4 rows), other markets → Alpha Vantage (5 TSX rows + 3 test rows) | Finnhub 4–8 (`/quote` ± `/profile2`); Alpha Vantage **5–10** + 3–6 | Finnhub 4; Alpha Vantage 5 + 3 |

**When a provider allows fewer than 28 requests a day (14 symbols × search + quote):**
1. Take the currency from the curated reference or the cache (0 requests). Use the provider search only for unknown instruments.
2. Price rows in order of plan impact.
3. Defer 0/0 rows.
4. Cache end-of-day quotes until the next session close. Alpha Vantage's `GLOBAL_QUOTE` updates "at the end of each trading day", per its documentation.
5. Show the rows that were not priced as `budget_withheld`, with the reset time and a choice: wait, use another configured provider, or import a CSV.
6. **Keep the plan blocked** until every row with shares > 0 or target > 0 has an approved price. Rows can never fall back to zero or sample prices.

**Consequence of the owner's sample as it stands.** With free browser providers, **row 9 (YNVD) can never be priced automatically**, so the plan for the exact sample stays blocked until DEC-03 or DEC-04 is decided:
- **(a)** accept a CSV-imported or explicitly user-supplied, labelled price; or
- **(b)** the owner changes the sample's YNVD row themselves.

The plan must not silently drop row 9: it holds a 2 % target.

---

## 11. Security and licensing review

### 11.1 Visitor API keys (browser)

**Current state (ada2ceb, verified in code and tests):**
- **Where the key lives:**
  - The key is kept in `sessionStorage` by default, or in `localStorage` if the visitor ticks "Remember" (`index.js:288-311`).
  - Only one copy exists at a time. "Remove key" deletes both copies and everything fetched with the key.
  - Each key has its own storage namespace, named by a 32-bit fingerprint (`index.js:39-51`).
- **Where it is sent:**
  - Only to `www.alphavantage.co`, inside the query string, as Alpha Vantage requires.
  - Requests use `credentials: "omit"` and `referrerPolicy: "no-referrer"` (`http.js:86`).
- **Exports and messages:** the key never appears in exports or messages. Provider notices that echo the key are redacted (`alphavantage.js:65-69`).

**Remaining risks:**
1. **Any script on the same origin can read either storage.** The page says so. The only third-party script, Chart.js, is loaded with a Subresource Integrity (SRI) hash. GitHub Pages cannot send a `Content-Security-Policy` header. A `<meta>` CSP is possible for `script-src` and `connect-src`, but it needs every inline script and style audited; this is backlog item **SEC-02**.
2. **A key in a URL can leak** into DevTools logs, HAR files, and any proxy or extension that logs URLs. Alpha Vantage's server logs are inherent. **Mitigation:** the evidence procedure in §4.5 never asks the owner for URLs.
3. **The usage and exhausted records sit in `localStorage` even for a session-only key** (`index.js:121, 155`). They hold no market data and no key, but they outlive the tab. Proposal: keep them in the same storage as the key.
4. **More providers mean more keys to handle.** Use one settings object per provider, with the same session/local choice and redaction rules. Never log a key, and never put one in an export or error message. Add a "Forget all keys" button.

### 11.2 Licensing posture (summary; details in §5)

Free tiers generally allow **personal, non-commercial** use with the user's own key. They generally forbid **redistribution or display to third parties**. That is why every viable browser design keeps fetching and display inside the visitor's own browser, using the visitor's own key.

What is ruled out, and why:
- **A shared owner key** embedded in public JavaScript or behind a public relay would expose that key, would redistribute the data, and would breach the "never expose keys" constraint.
- **Scheduled snapshots of prices committed to the repository** would republish licensed data to the public.
- **Public CORS relays and scraping of Yahoo, TMX or others** breach the providers' terms and the brief's constraints.

What is acceptable:
- **Official central-bank FX** (Bank of Canada, ECB) may be used with attribution; their terms are cited in `_tools/MARKET_DATA.md`.
- **The desktop apps** run on the user's own machine, so a user-chosen provider with the user's key is the same personal-use pattern. `yfinance` is a separate matter: Yahoo's terms prohibit automated access, so it should become an opt-in "unofficial source" with a disclosure, or be replaced (§5, §7).

### 11.3 Exports

- **Formula injection:** browser CSV and XLSX text cells starting with `= + - @ TAB CR` get an apostrophe prefix (`export-files.js:7-14`). Desktop exports: see §7.
- **Workbooks are values only:** no macros and no formulas. This is good for safety. Note the cost: recipients cannot audit the calculation from the workbook unless the inputs and formulas are documented (see §7.2 on reproducibility).

### 11.4 Supply chain and CI

- **Pinned actions:** CI pins every third-party action to a commit SHA and uses a read-only token.
- **Python requirements:** pinned per tool.
- **No dependency audit runs today.** Add `pip-audit` for the four `requirements.txt` files and `_tools/tests/requirements.txt`. The site has no npm runtime dependencies; Chart.js is pinned with SRI.
- **No Windows CI job.** The CPI scraper's six bootstrap tests are Windows-only by design and never run in CI (SEC/CI backlog item **CI-02**). GitHub-hosted `windows-latest` runners are free for public repositories.

---

## 12. Complete remediation backlog

**Columns:**
- **Cx** — complexity: S < 1 day, M 1–3 days, L > 3 days.
- **Risk** — regression risk.
- **Deps** — dependencies.

**Source for each row:**
- "Acceptance" and "Tests" are summaries. The full criteria are in the cited section or appendix.
- Items prefixed SS-, AV-, RB-, B/D (Stock), F (Monte Carlo) and CPI- map to the defect IDs in §3, §4 and Appendices C–F.

### 12.1 Market-data layer (shared by the Rebalancer and the Stock tool)

| ID | Sev | Projects | Deps | Solution | Cx | Risk | Acceptance | Tests |
|---|---|---|---|---|---|---|---|---|
| MD-01 (AV-01, SD-B3) | **Critical** | RB, SD | — | Explicit, ordered notice classifier: burst first, then daily-specific wording, then premium, demo, key, symbol. Unknown `Information` → `unavailable`, not definitive. | S | Low | All 9 verbatim wordings (Appendix A.3) classified correctly; a burst notice never sets `exhausted` | Unit fixtures (verbatim); property test for notices containing both phrases; browser test with a burst on request 2 |
| MD-02 (AV-02) | High | RB, SD | MD-01 | Persist only the daily state, with timestamp and redacted notice. Show the expiry time. "Check again" (1 request) clears the state on success. Usage record stored in the same storage as the key. | S–M | Low | After a burst, the next run sends requests; after a daily notice, the UI shows its time and offers "Check again" | Unit; browser |
| MD-03 (AV-04, SS-02) | Medium | RB, SD | — | Counter text "Requests sent from this browser today (UTC): N", never "of 25 used". Explain contradictions. | S | Low | No "N of 25" text anywhere; a contradiction message appears when a limit is hit with N < 25 | Browser text assertions |
| MD-04 (AV-05) | Medium | RB, SD | MD-01 | Show the redacted provider notice inside "details" | S | Low | Notice visible; the key never appears | Redaction unit test |
| MD-05 (AV-06) | Medium | RB, SD | — | Spacing ≥ 1.1 s from the previous **response**; one per-key queue shared across tabs and tools (Web Locks API, falling back to BroadcastChannel) | M | Medium | Two tools open at once never send < 1 s apart | Unit with fake clock; two-page Playwright test |
| MD-06 (AV cost) | High | RB, SD | MD-07 | Listing cache 180 days; stem search only on request; **curated instrument reference** JSON (identity only, cited sources, verified date); quote cache until next session close | M | Low–Med | First run of the 10-row sample uses ≤ 10 Alpha Vantage requests | Budget unit tests on the §10 samples |
| MD-07 | High | RB, SD (+ desktop mirror) | — | `ResolvedInstrument` / `Quote` / `PriceError` contracts (§6.2) as shared JSON-schema fixtures for JS and Python. Ambiguity handling. Cboe Canada recognised (`.NE` → NEOE, "not covered"). `.FRK` mapping. HKD support. | M–L | Med | Contract fixtures validate in both languages; YNVD.TO yields "Cboe Canada, not covered" | Node and pytest fixture runners |
| MD-08 | High | RB, SD | MD-07 | Provider adapter interface plus Finnhub and Massive adapters. Per-provider key settings with the same storage, redaction and removal rules. Visible market routing. Coverage tables in the UI. | L | Med | Each row shows its provider; switching provider retires in-flight work; keys are isolated per provider | Mocked adapters in `harness.js`; key-isolation tests extended |
| MD-09 (SD-B6) | Medium | RB, SD | MD-06, MD-08 | Budget planner: estimate before a batch, impact ordering, `budget_withheld` state | M | Low | §10.3 table reproduced by unit tests; the UI shows the estimate before Run | Unit; browser |
| MD-10 | Medium | RB, SD | MD-08 | Optional cross-check (§6.7): same-instrument rules, thresholds, never averaged | M | Low | Different sessions or price types → "not comparable"; > 1 % → "Investigate" with causes | Unit table of cases |
| MD-11 | Medium | RB, SD | MD-07 | Freshness policy by trading sessions (§6.5) | S–M | Low | Labels and plan gating as in the table | Unit |
| MD-12 | Low | docs | — | Update `_tools/MARKET_DATA.md` with Appendix A.7: Twelve Data non-display; EODHD has no CORS; new Alpha Vantage wordings | S | — | Docs match Appendix A | Review |

### 12.2 Portfolio Rebalancer

| ID | Sev | Projects | Deps | Solution | Cx | Risk | Acceptance | Tests |
|---|---|---|---|---|---|---|---|---|
| RB-B01 (SS-05) | **Critical** | Browser | — | A ticker or listing edit clears price, source and currency evidence immediately. Per-row `revision` is checked before applying any response. | S–M | Med | Editing a ticker never leaves a price from the old instrument; late responses are dropped | Unit (state machine); browser late-response test |
| RB-B02 (SS-04) | **Critical** | Browser (+ desktop) | RB-42 | Valuation completeness gate: no plan while any required row lacks an approved price; "Plan not generated" with reasons | M | Med | No Buy/Sell pill or export when incomplete; 0/0 rows never block | Unit (`assessValuation`); browser |
| RB-42 | High | Both engines | — | "Not valued" state for 0-share, 0 % rows: excluded from totals and trades, listed as "not valued" | S–M | Med (engine change) | The 14-row sample with 4 unpriced test rows plans exactly like the 10-row sample | Parity fixtures; hand-calculation fixtures (Appendix E.4) |
| RB-B03 (SS-07, SS-14) | High | Browser | MD-06…09, RB-B01 | Automatic resolution and pricing on blur/Enter (§6.3–6.4). Per-row states. Currency becomes read-only metadata. Manual currency only for unresolved rows, labelled. | L | Med–High | Typing VEQT.TO and pressing Tab shows name, listing, currency, price, source and date without a Run click | Browser with mocks; budget assertions |
| RB-B04 (SS-12) | High | Browser (+ desktop) | RB-42, MD-06 | New sample (§10). Page starts empty. "Remove test rows". | S | Low | 14 rows in the specified order, no prices, CAD 3,000 New Money | Browser |
| RB-B05 (SS-08…11, 15, 16) | High | Browser | RB-B02 | No-horizontal-scroll redesign (§9). Warning grouping and severity tiers. `aria-live` only on the status line. | L | Med | `scrollWidth ≤ clientWidth` at 360–1920 px and 100/125/150 % zoom; financial values ≥ 14 px | Playwright layout matrix; axe-core optional |
| RB-B06 (SS-13, RB-05, RB-30, RB-31) | Medium | Both | — | ISO labels (JPY, CNY), alias map for future imports, desktop combo boxes show labels, exports use ISO codes, HKD added, `.HK` → HKD | S–M | Low–Med | No "JPN", "CHY" or "CNH" visible or exported; `.HK` suggests HKD | Unit; desktop export golden files |
| RB-01 | High | Both engines | — | When scale is 0, would-be buys become Hold with one warning; store the FX rate rather than dividing by scale; desktop catches all exceptions and clears stale plans | S | Low | Appendix E E1/E1b identical in both engines, with no exception | Reference and parity tests |
| RB-02 / RB-03 | Medium | Both | — | Identical validation for blank, whitespace, `badInput`, NaN, inf, 1e999 | S | Low | Same error for each probe in both apps | Validation-parity test |
| RB-04 | Medium | Desktop | — | Budget-field re-pack fix | S | Low | Field reappears in place after any number of mode toggles | Manual on Windows and macOS (screenshots) |
| RB-06 | Medium | Desktop | DEC-05, MD-07 mirror | No currency means unverified; no automatic cross-market switch; no lookups while live data is off; bounded worker | M | Med | Start-up with live data off makes 0 network calls | Stubbed yfinance tests |
| RB-07 | Medium | Desktop | RB-B05 design | Information model from §9.5; window sized to screen; DPI awareness | M–L | Med | Every column reachable at 100/125/150 % on 1366×768 and 1920×1080 | Manual on Windows (screenshots); geometry unit tests |
| RB-08 | Medium | Desktop | RB-B06 | Exports carry ISO codes, FX rates, sources, timestamps, warnings, disclaimer | S–M | Low | Golden-file match | Golden files |
| RB-40, 41, 43–47 | Low–Med | Both | DEC-08 | Weights ≠ 100 % warning; whole-share mode with leftover cash; pence hint; per-account cash; optional water-filling; JSON save/load; New Money wording | var. | Med | Per Appendix E.8 | Per Appendix E.8 |
| RB-48 / 49 / 50 | Low | Tests, docs | — | Compare warning text, not counts; add desktop module tests; fix the stale Briefing; delete dead code `engine.js:140-146` | S–M | Low | — | — |

### 12.3 Stock Comparison & Analytics

| ID | Sev | Side | Deps | Solution | Cx | Risk | Acceptance | Tests |
|---|---|---|---|---|---|---|---|---|
| SD-B1 | High | Browser | DEC-09 | Adjust short-window daily closes using the weekly adjClose/close factor, or detect split-like ratios and exclude the ticker with a message. Add a basis badge. | M | Med | SPLITX 3M ≈ 0 % or excluded with an explanation | Unit split table; browser 3-for-2 mock |
| SD-B2 / D4 | Medium | Both | — | Relative-tolerance variance guard: "benchmark has no variance"; never abort the run | S | Low | FLAT benchmark gives a message, no beta | Fixture F in both engines |
| SD-B4 (R10) | Medium | Both | DEC-09 | Suppress or caveat annualised figures under 6 months; always for 1D | S | Med (output change) | 1D shows no annualised return or Sharpe | Unit |
| SD-B5 | Medium | Browser | — | Demo series `currencyVerified: true` | S | Low | No false currency warning in the demo | Browser |
| SD-B6 | Medium | Browser | MD-09 | Pre-run request estimate; correct the "two requests" copy | S | Low | Estimate shown | Browser |
| SD-B11 | Medium | Browser | — | Metrics table without inner scroll at 1024–1366 px; cards below 760 px; legend toggle above 4 series; labels ≥ 12 px | M | Low | Layout matrix passes | Playwright |
| SD-D1 / D2 | High | Desktop | — | Per-ticker returns on each ticker's own series; cumulative chart built from prices | M | Med | SPYX n = 249 and 16.95 %, unchanged when XIU.TO is added; chart end equals the table | New `test_calendar_alignment.py` |
| SD-D3 | Med–High | Desktop | — | Drop incomplete weekly/monthly bins; label bins by last trading date; exclusive end date | S | Med | SPYX monthly 24.47 % on the fixture | Unit |
| SD-D5 | Medium | Desktop | — | Prices, Returns and Settings sheets; sanitizer covers `= + - @ \t \r \n` and full-width forms | M | Low | Export recomputes as `verify_export.py` does; injected cell stored as text | Unit |
| SD-D6 / D7 / D13 | Medium | Desktop | — | Bounded FX forward-fill (≤ 7 days) with warnings, no back-fill; reject duplicate dates and prices ≤ 0; ZAc/ILA support | S–M | Med | Per Appendix C.8 | Unit |
| SD low (B7–B10, B12, D8, D9, D11, D12) | Low | Both | — | Per Appendix C.8: R12–R20 | S each | Low | — | — |

### 12.4 Monte Carlo

| ID | Sev | Side | Deps | Solution | Cx | Risk | Acceptance | Tests |
|---|---|---|---|---|---|---|---|---|
| MC-01 (F1) | High | Both | DEC-07 | Spending-basis choice (today's / retirement-year dollars), with the converted amount shown and exported | M | Med (semantics) | Base case in today's dollars: W₁ = 88,094.70 in both engines | Engine unit, parity, closed form, browser |
| MC-02 / 03 (F2, F3) | Medium | Both | DEC-07 | Label the arithmetic mean and show a "median ≈ μ − σ²/2" helper; volatility guardrail (cap or warning) | S | Low–Med | Identical messages in both apps | Parity `INVALID` list |
| MC-04 (F4) | Medium | Desktop | — | Clamp pension in the sample scenario | S | Low | 100,000 samples, 0 failures | Unit |
| MC-05 (F5) | Medium | Desktop | — | Seed field; port of mulberry32 + Box–Muller; seed, RNG and version exported | M | Med | Seeds 1–10 match the web: identical failed counts, bands ≤ 1e-12 | Cross-language parity |
| MC-06 (F7) | Medium | Web (MC, SD) | — | Self-host Chart.js under `/assets/vendor` with SRI and `defer`, or lazy-load it | S | Low | App ready in < 2 s with external hosts blocked or stalled | Playwright with blocked and stalled CDN |
| MC-07 (F6, F10) | Medium | Docs | MC-06 | Correct the claims (network, validation messages, "safe withdrawal rate", sample) | S | Low | Every claim in Appendix D.8 is true | Text assertions |
| MC-08 (F8) | Medium | Desktop | — | Warn and back up, or write a new file, when the target workbook exists | S | Low | Existing shapes are preserved or the user is warned first | Desktop test |
| MC-09 | Medium | Both | — | One parsing rule set and one message catalogue | M | Low | 18/18 probes identical | Port of `ui_parse_parity.py` |
| MC-10 (F9, F11–F14, F16, Worker) | Low | Both | — | Per Appendix D.10, R10–R19 | S–M | Low | — | — |

### 12.5 CPI Web Scraper

| ID | Sev | Side | Deps | Solution | Cx | Risk | Acceptance | Tests |
|---|---|---|---|---|---|---|---|---|
| CPI-R01 (CPI-01) | High | Desktop, ZIP | DEC-06 | Remove S&P values, and the caches and charts derived from them, from the shipped workbook (re-save in Excel), or document written permission. Rebuild the ZIP. | S–M (needs Excel) | Low | Column N empty; ZIP rebuilt; S&P data policy documented | openpyxl assertion; ZIP check |
| CPI-R02 (CPI-02) | High | Desktop | Windows measurement | Recalculate before save (`CalculateFull`), or a mandatory post-run instruction | M | Med | Model values reflect new data after reopen, or the user is told explicitly | Opt-in COM regression (assert values **change**) |
| CPI-R03 (CPI-03) | High | Desktop | — | Default to Date range; confirm with row counts; optional merge mode | M | Med | Single-month run keeps history (merge) or confirms first | COM-mock test |
| CPI-R04…R14, R16 | Med–Low | Desktop, docs | — | Partial-month flag; end-date clamp; worker thread with progress and cancel; metadata scrub (path, username, add-in); StatCan Open Licence notice; 4xx mapping; claim fixes; SVG; OneDrive switches; bootstrap tests; key opt-out; bulk POST | S–M | Low–Med | Per Appendix F.9 | Per Appendix F.9 |
| CPI-R15 | Proposal | Browser | DEC-10 | "CPI data pack builder" (F.6): StatCan live, FRED by import, new values-only XLSX/CSV with a Sources sheet; SheetJS 0.20.3 from CDN with SRI | L | Low | A–S output identical to the desktop CSV for the same inputs | Playwright with mocked WDS and FRED fixture |

### 12.6 Cross-cutting

| ID | Sev | Solution | Cx | Acceptance |
|---|---|---|---|---|
| X-01 CI | High | Add to CI: layout-overflow matrix; verbatim provider fixtures; extreme parity cases and draw-count asserts; a `windows-latest` job for CPI bootstrap and desktop tests (free for public repos); `pip-audit` on all requirement files | M | CI runs them; failures block the PR |
| X-02 Security | Medium | Per-provider key slots; "Forget all keys"; usage records stored with the key; evaluate a `<meta>` CSP (SEC-02) | M | Keys never in exports, logs or URLs shown to the user; CSP decision documented |
| X-03 Presentation | Medium | Per tool: "What it demonstrates", methodology, validation evidence (reference tests), limitations, data sources and licences, accurate claims | M | Every page claim checked against code (the appendices' claim tables) |
| X-04 Publication | Low | If any `md-instructions/` audit file is merged, exclude the folder in `_config.yml` | S | URL returns 404 |

---

## 13. Implementation sequence

The order follows the brief's priorities, adjusted only where a dependency or a licensing risk requires it. Each checkpoint is a separate, reviewable commit series with green CI. Each also needs the owner's manual acceptance where the checkpoint names it.

| Phase | Content | Checkpoint (exit criteria) |
|---|---|---|
| **0. Decisions and evidence** | Owner answers DEC-01…DEC-12 (§14.2). Owner runs the §4.5 evidence procedure (≤ 3 requests). | Decisions recorded in the implementation prompt. Raw notice captured (redacted), or explicitly waived. |
| **1. Market-data reliability** | MD-01, MD-02, MD-03, MD-04, MD-05. **In parallel (independent, licensing):** CPI-R01 (S&P removal) and the CPI-05 metadata scrub. | Verbatim-notice unit fixtures pass. A browser test with a burst on request 2 prices all 10 rows. Owner live smoke test: 1 holding, ≤ 2 requests. Public ZIP no longer contains S&P values. |
| **2. Quote and currency accuracy** | MD-07 (contracts, Cboe Canada, `.FRK`, HKD), MD-06 (curated reference, caching), RB-B01 (ticker-change invalidation), RB-B06 (ISO labels), MD-11 (freshness). | Contract fixtures pass in JS and Python. Ticker edit clears the price. YNVD.TO yields "Cboe Canada, not covered". No non-ISO currency label anywhere. |
| **3. Safe financial calculations** | RB-42, RB-B02 (completeness gate), RB-01, RB-02/03. SD-D1/D2/D3, SD-B2/D4, SD-B1 (per DEC-09), SD-B4. MC-01/02/03 (per DEC-07), MC-04. CPI-R02/R03/R04. | Hand-calculation and parity fixtures extended (Appendix E.4 values, Stock fixtures, Monte Carlo extremes). No plan from an incomplete valuation. Every changed output is listed in release notes as an approved semantic change. |
| **4. Provider abstraction** | MD-08 (Finnhub, Massive adapters; per-provider keys; visible routing), MD-09 (budget planner), MD-12 docs | Mocked adapters for 3 providers. Key-isolation tests per provider. §10.3 budget table reproduced by tests. |
| **5. Automatic fetching** | RB-B03 (lookup on blur, row states, cancellation, late-response drop), RB-B04 (new sample), MD-10 (cross-check), SD-B6. | Browser tests for: typing → price; ticker change during an in-flight request; provider switch mid-batch; sample load prices only rows 1–10 within budget; YNVD and 7203.T show clear "not covered" states. |
| **6. Responsive UX** | RB-B05 (§9), SD-B11, Monte Carlo and CPI table fixes, accessibility items, MC-06 (self-host Chart.js). | Layout matrix (360–1920 px; 125/150 % zoom) passes for all four pages. Financial values ≥ 14 px. Offline/CDN-stall test passes. |
| **7. Browser–desktop parity** | Desktop provider migration or opt-in yfinance (DEC-05), RB-06/07/08, RB-04, SD-D5/D6/D7, MC-05 (seed port), MC-08, MC-09, CPI-R05…R14. CPI-R15 browser data-pack builder (if DEC-10 = yes). | Parity matrices (§8) have no "Fix" cells left. Desktop ZIPs rebuilt deterministically (`build_project_zips.py --check`). |
| **8. Professional presentation** | X-03 page content, MC-07 claims, CPI SVG, methodology and validation pages, release notes | Claim tables in the appendices all marked true. Owner review of page copy. |
| **9. Full verification and deployment** | X-01 CI additions, X-02, full suite run, owner live acceptance with real keys (redacted procedure), post-deploy checks on GitHub Pages | All suites green, including the Windows job. Owner confirms live pricing for the 10-row sample. Deployed JS hashes match the merge commit. |

**Why CPI-R01 is in Phase 1 rather than Phase 3.** It is a licensing exposure in a file already being redistributed. It is independent of the market-data work and small, so the brief's priority order allows it to start immediately.

---

## 14. Feasibility and blockers

### 14.1 Requirements that cannot be fully met under current constraints

| Requirement | Why not | Closest compliant alternative |
|---|---|---|
| Automatic prices **without any visitor account** | Every free provider that answers browsers needs a key tied to the user. Shared or embedded keys and relays are prohibited, and display to third parties is forbidden by the terms (Appendix A). | The visitor's own free key (Alpha Vantage; Finnhub/Massive for US). A no-account baseline via CSV import. A paid display licence behind an owner-run gateway would need explicit owner approval and a budget (not recommended now). |
| Automatic prices for **all 14 sample instruments** | No free browser provider covers **Cboe Canada (YNVD)** or **Tokyo (7203.T)**. Free coverage of the specific TSX ETFs on Alpha Vantage is documented by exchange but UNVERIFIED per symbol. | Clear "not covered" states. CSV import or an explicit, labelled user-supplied price (DEC-03). On the desktop, EODHD may cover Cboe Canada (UNVERIFIED). |
| Pricing **14 symbols within one day** on Alpha Vantage alone (current design) | 26–39 requests needed against 25 per day. | Curated identity (0 requests), caching, routing US to Finnhub, deferring 0/0 rows (§10.3): about 5–10 Alpha Vantage requests. |
| **Index** and **Canadian mutual-fund** prices | Indexes are premium on Alpha Vantage. No free API carries Fundserv NAVs. | CSV or issuer NAV, labelled "NAV" (not a market price for ETFs). |
| Cross-provider comparison for **Canadian listings** in the browser | Only one free browser provider covers TSX. | US-only in the browser. Desktop: Alpha Vantage vs EODHD (UNVERIFIED). |
| CPI **live FRED** and **in-place workbook update** in the browser | FRED sends no CORS headers. The JS libraries lose charts and pivots and do not recalculate (proven). | FRED by user download and import. A new values-only workbook. In-place updates stay desktop-only. |
| Exact **Monte Carlo seed match across all browsers** | `Math.log` and `Math.cos` are implementation-approximated. | Seed match within an engine; across engines about 1e-15, with identical failure counts in tests. |
| Real-key **root-cause confirmation** | No key may be used here. | Owner procedure (§4.5). |

### 14.2 Decisions required before implementation (DEC)

| ID | Decision | Recommendation |
|---|---|---|
| DEC-01 | Browser provider set (at most 5) | **Alpha Vantage + Finnhub + Massive** (3), with visible "route by market" |
| DEC-02 | Desktop provider set | Alpha Vantage, EODHD, Tiingo, Finnhub, plus OpenFIGI for identity |
| DEC-03 | Policy for instruments no approved provider can price (YNVD, Tokyo, funds) | Plan withheld by default. Opt-in "use my own price" per row, labelled "user-supplied, unverified" in the UI and exports. Plan banner "includes N user-supplied prices". CSV import counts as user-supplied unless the file carries a source. |
| DEC-04 | Sample row 9 `YNVD.TO` | Keep as entered (the brief says do not replace silently). The resolver explains "Cboe Canada: YNVD.NE". The owner may choose to change the sample text. |
| DEC-05 | Desktop yfinance | Replace it as the default with keyed providers. Keep yfinance only as an explicit opt-in "unofficial source" with a terms disclosure, or remove it. |
| DEC-06 | CPI S&P data in the public ZIP | Remove it, unless written S&P DJI permission exists |
| DEC-07 | Monte Carlo spending basis default, and volatility guardrail | Default to today's dollars with a visible toggle; cap or warn above 30 % volatility. **This changes outputs, so it needs explicit approval.** |
| DEC-08 | Rebalancer enhancements (whole-share mode, water-filling, per-account cash, save/load) | Whole-share mode and leftover reporting: yes. Water-filling: optional mode. Per-account cash and save/load: later phase. |
| DEC-09 | Stock short-window basis | Adjust with weekly factors where available; otherwise exclude split-affected tickers with a message; suppress annualisation under 6 months. **This changes outputs.** |
| DEC-10 | CPI browser version | Build the values-only "data pack builder"; no in-place editing |
| DEC-11 | Alpha Vantage "open-source/educational unlimited" programme | Optional. Ask Alpha Vantage in writing. **Never embed a key in public JS without written permission.** |
| DEC-12 | Chart.js hosting | Self-host under `/assets/vendor` with SRI |

### 14.3 Blockers

There are **no hard blockers to planning**. Two items stay open:
- the real-key diagnosis (owner action); and
- Windows/Excel verification for CPI-R02 and the desktop layout (needs a Windows machine, or the `windows-latest` CI runner for the automatable parts).

---

## 15. Final implementation readiness

**Verdict: READY FOR IMPLEMENTATION PLANNING REVIEW**

**Basis:**
- Every requested investigation area was covered: incident, providers, identity, four tools on both platforms, parity, UX, security and licensing.
- Confirmed defects carry reproductions and code references.
- Infeasible parts of the requirement are stated with compliant alternatives.
- The backlog is dependency-ordered, with acceptance criteria and tests.

**Conditions for the implementation prompt:**
1. The owner and reviewer record decisions DEC-01…DEC-12.
2. Ideally, the owner provides the redacted Alpha Vantage notice from §4.5. MD-01…MD-05 are required whichever wording it shows.
3. The implementation keeps the brief's guardrails:
   - no shared keys, relays or scraping;
   - no fabricated or zero prices;
   - no silent formula changes (every output-changing item is listed as such);
   - no force-push;
   - nothing merged without review.

This verdict concerns readiness for **planning review**. No code-implementation readiness is claimed or implied.

---

## Appendix index (`md-instructions/2026-11-03-audit-evidence/`)

| File | Content |
|---|---|
| `A-market-data-providers.md` | public-apis triage; 29-field matrix; verbatim Alpha Vantage notices; terms; CORS probes; shortlist |
| `B-ticker-identity.md` | 14 instruments: identity, listing, currency, provider symbols, placeholder-price evidence, edge cases |
| `C-stock-dashboard.md` | Formulas, fixtures vs numpy/scipy, desktop defects, live basis switch, exports, UI, parity |
| `D-monte-carlo.md` | Model specification, RNG, shared-draw parity, closed forms, sensitivity, exports, UI, parity |
| `E-rebalancer-engine-desktop.md` | Engine specification, hand calculation, edge cases, currency labels, desktop app, parity |
| `F-cpi-webscraper.md` | Desktop flow, series verification, CORS feasibility, workbook-library experiment, browser proposal, parity |
| `repro/` | Reproduction scripts for §3–§4 (see below) |

**Committed reproduction scripts** (`2026-11-03-audit-evidence/repro/`). These are read-only and change nothing in the repository; see `repro/README.md`.
- `classify_av_notices.mjs`: feeds the nine verbatim Alpha Vantage notices to `parseAvBody`.
- `classify.mjs`: Alpha Vantage classification plus run-level effects (request counts, persisted lock) with a mocked provider.
- `incident.js`: Chromium replay of the owner's Rebalancer run (3 scenarios).
- `layout.js`: horizontal-overflow measurement at 9 widths.

The other workstreams' scripts (fixtures, numpy/scipy references, parity harnesses, workbook round-trips) were run from the session scratchpad and are not committed. Their method and inputs are described in Appendices A–F, so the implementer can re-create them.
