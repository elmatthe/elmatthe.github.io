# Appendix F — CPI Web Scraper (desktop app and browser feasibility)

**Provenance.** This is a sub-audit by the CPI workstream, dated 2026-11-03, at HEAD `ada2ceb`.

**Lead-auditor spot checks** (run with openpyxl and unzip on `projects/CPI-Webscraper/files/CPI.xlsx`):
- CPI-01: `CPI_Downloader` column N ("SP by month US") holds **121 values**, from 2016-09 (2168.27) to 2026-09 (7619.98).
- CPI-05: `xl/workbook.xml` contains an `x15ac:absPath` with a local Windows path that includes the author's username (redacted here as `C:\Users\<username>\…`), and `xl/webextensions/*` parts are present.

**Evidence folder.** Raw evidence is in the scratchpad at `audit/cpi/`:
- `net/` — headers and bodies from StatCan, FRED and Bank of Canada; `browser_cors.js`.
- `xlsxlab/` — the round-trip experiments.
- `screens/`, `pytest-*.txt`.

**Labels used:**
- **CONFIRMED** — reproduced, or proven from code with a concrete example.
- **RISK** — backed by evidence but not proven.
- **DESIGN WEAKNESS**
- **CLAIM GAP** — the page or docs say something the evidence does not support.
- **EXTERNAL LIMITATION**
- **UNVERIFIED** — with the reason.

## F.1 Summary of findings

The desktop app is careful about data collection. It collects and validates everything before Excel is touched, cleans up COM safely, sanitizes error messages so the key never appears, and validates its configuration strictly. All 18 series IDs match their official metadata (F.3). The offline suite on Linux gives **98 passed, 1 skipped (the opt-in real-Excel test), 6 deselected (the Windows-only bootstrap tests)**.

| ID | Sev | Finding | Class |
|---|---|---|---|
| CPI-01 | **High** | The public ZIP and `files/CPI.xlsx` **redistribute 121 monthly S&P 500 closes** from FRED SP500 (`CPI_Downloader!N1246:N1366`). FRED's series notes say: "Reproduction of S&P 500 in any form is prohibited except with the prior written permission of S&P Dow Jones Indices LLC". The project's own docs call S&P rights an unresolved "production approval gate". | RISK (licensing; not a legal opinion). Lead spot check confirms the 121 values. |
| CPI-02 | **High** | **After every download the saved model sheets still hold results computed from the old data.** `EnableCalculation=False` is set on every sheet and nothing recalculates before `Save()` (`workbook_io.py:121-127`). The repo's own Excel regression test asserts that the cached values are *unchanged* (`test_workbook_regression.py:132-135`). README:36 says Excel "can recalculate normally" on open. | CONFIRMED (stale saved caches); UNVERIFIED whether Excel recalculates on reopen |
| CPI-03 | **High** | **Every run clears the whole A:S history**, then writes only the requested range. The GUI defaults to **"Single month"** (`cpi_webscraper.py:134`), so a routine update leaves the header plus one row (`workbook_io.py:106-127`). FRED's S&P window rolls forward, so cleared S&P months cannot be re-fetched: the shipped 2016-09 and 2016-10 values are already outside FRED's window, which starts at 2016-11-03. | CONFIRMED (code and test) / DESIGN WEAKNESS |
| CPI-04 | Medium | The "end-of-month" columns M/N/O (DFF, SP500, T10Y2Y) show **partial-month values for the current month, unflagged**. The shipped S&P value for 2026-09 is 7619.98, FRED's 2026-09-14 close; the 2026-09-30 close was 7651.54. | CONFIRMED |
| CPI-05 | Low | **Workbook metadata leak:** an absolute local path containing the author's Windows username (`x15ac:absPath`), an Office add-in web-extension reference with a file identifier, and the creator name in `docProps/core.xml`. | CONFIRMED (lead spot check) |
| CPI-07 | Medium | **No upper bound on the end date.** 1913-01 to 9998-12 means 4,045 sequential StatCan requests while the window is frozen; 9999-12 crashes ("year 10000 is out of range"). | CONFIRMED |
| CPI-08 | Medium | The download runs on the Tk UI thread: no progress, no cancel, and Windows shows "Not responding". A full run makes 60 StatCan and 13 FRED requests, each with a 60 s timeout and up to 3 attempts. | CONFIRMED (code) |
| CPI-09 | Low | `request_json` retries every 4xx (FRED 400 bad key, StatCan 409 lock window) and then shows one generic message. | CONFIRMED (code) |
| CPI-10 | Low | No StatCan Open Licence acknowledgment in the workbook, CSV or app output. | CONFIRMED |
| CPI-11/14/15/16/20 | Low | Page and guide claim gaps:<br>• the privacy bullet omits the opt-in Yahoo traffic and PyPI/winget;<br>• the SA-revision wording is incomplete;<br>• "would need a server" is too absolute;<br>• the guide points to a private repository for tests;<br>• the OneDrive `/pause` and `/resume` switches are undocumented;<br>• `.xlsm` with VBA is advertised but untested. | CLAIM GAP |
| CPI-12/13 | Low | `assets/images/cpi-workflow-overview.svg` still says "CPI DASHBOARD AUTOMATION" and has advisory marketing copy, with text about 4 px tall at 390 px. The data table clips a column and breaks dates mid-token at 390 px. | CONFIRMED |
| CPI-17 | Low | `test_rebuild_rollback` passes vacuously off Windows: the OS gate raises first. | CONFIRMED |
| CPI-18/19 | Low | The FRED key is saved in plain text automatically after a successful run, with no opt-out (`cpi_webscraper.py:74-77`; `config.toml` is gitignored). The API-key link is not clickable. | CONFIRMED |
| CPI-21 | Info | 60 chunked GETs could become one WDS bulk POST. | Proposal |

## F.2 Desktop end-to-end flow (Windows only)

1. **Launcher.** `Setup_and_Run-cpi-webscraper.bat` uses PowerShell to find Python 3.11–3.14 with `tkinter` and `venv`, skipping the Microsoft Store stub. If none is found, it offers a winget install after a Y/N prompt. It then runs `scripts/bootstrap.py`.
2. **Bootstrap.**
   - Refuses to run unless the OS is Windows and Python is 3.11–3.14 (`bootstrap.py:75`).
   - Creates or validates `config.toml`.
   - Health-probes `.venv`, rebuilding it with rollback if broken.
   - Reconciles exact pins: `requests==2.34.2`, `python-dateutil==2.9.0.post0`, `openpyxl==3.1.5`, `pytest==9.1.1`, `pywin32==312`.
3. **GUI.** Inputs:
   - mode: Single month (the default) or Date range;
   - year and month;
   - target `.xlsx` or `.xlsm`;
   - optional CSV path;
   - FRED key.
   
   It then runs `build_rows`, then `write_to_workbook`, then the optional CSV. On success the key is saved to `config.toml`.
4. **Data collection** (`data_sources.py:303-312`):
   - clamps the start to 1913-01 (**no upper clamp**);
   - fetches 5 StatCan vectors;
   - fetches 10 FRED monthly series;
   - fetches DFF and T10Y2Y, reduced to the last valid daily observation each month;
   - fetches SP500 (plus Yahoo backfill only if enabled);
   - runs `validate_sources`;
   - builds one row per month, dated the first of the month.
5. **Excel write** (`workbook_io.py:76-146`), using a private Excel instance (`DispatchEx`):
   - refuses to run if a lock file exists;
   - sets macros to force-disabled, `UpdateLinks=0`, and checks for sheet protection, merged cells and formulas in the target area;
   - **sets `EnableCalculation=False` on every sheet**;
   - clears contents A1:S{max(new rows, last used row)};
   - writes with a bulk `Value2` assignment, with date serials adjusted for the 1900/1904 date system;
   - saves, closes and quits Excel;
   - wraps the whole operation in OneDrive `/pause` and `/resume` calls.
6. **CSV.** Same columns, ISO dates, UTF-8.

**Sources and request counts** (full history, 1913-01 to 2026-11):

| Source | Endpoint | Key | Requests |
|---|---|---|---|
| Statistics Canada WDS | `getDataFromVectorByReferencePeriodRange` (GET), in 120-month chunks | none | 12 chunks × 5 vectors = **60** |
| FRED API | `fred/series/observations` (`api_key` in the query) | **required, user's own** | 13, plus 1 extra SP500 fetch in some modes |
| Yahoo `query1…/v8/finance/chart/%5EGSPC` | optional (`[sp500_history] add_missing_data = true`; off by default) | none | 1 |
| PyPI / winget | setup and repair only | — | — |

The StatCan WDS guide limits each IP to 25 requests per second and warns that some methods return 409 between 00:00 and 08:30 ET. The app's 60 sequential GETs are within these limits.

## F.3 Series definitions (all verified against official metadata)

**StatCan** — `getSeriesInfoFromVector` and `getCubeMetadata`; base 2002=100 per table 18-10-0004 footnote 3:

| Col | Vector | Table | Title | SA |
|---|---|---|---|---|
| B | 41690973 | 18-10-0004 | Canada; All-items | NSA |
| C | 41690914 | 18-10-0006 | Canada; All-items | SA |
| D | 41691233 | 18-10-0004 | Canada; All-items excluding food and energy | NSA |
| E | 41690924 | 18-10-0006 | Canada; All-items excluding food and energy | SA |
| F | 41692327 | 18-10-0004 | Alberta; All-items | NSA |

**FRED** — metadata as of 2026-11-03:

| Col | ID | Title | Frequency | SA |
|---|---|---|---|---|
| G | CPIAUCNS | CPI-U All Items, 1982-84=100 | Monthly | NSA |
| H | CPIAUCSL | CPI-U All Items | Monthly | SA |
| I | CPILFENS | CPI-U All Items Less Food and Energy | Monthly | NSA |
| J | CPILFESL | CPI-U All Items Less Food and Energy | Monthly | SA |
| K | UNRATE | Unemployment Rate | Monthly | SA |
| L | FEDFUNDS | Effective federal funds rate | Monthly | NSA |
| M | DFF | Effective federal funds rate | Daily, 7-day | NSA |
| N | SP500 | S&P 500, close | Daily | NSA; source S&P DJI; **first observation 2016-11-03 (rolling 10-year window)** |
| O | T10Y2Y | 10-year minus 2-year Treasury spread | Daily | NSA |
| P | GS10 | 10-year Treasury constant maturity | Monthly | NSA |
| Q | GS2 | 2-year Treasury constant maturity | Monthly | NSA |
| R | PCEPI | PCE price index, 2017=100 | Monthly | SA |
| S | PCEPILFE | PCE price index excluding food and energy | Monthly | SA |

First observations match the app's `EXPECTED_STARTS`. CPIAUCNS 1913-01 and PCEPILFE 1959-01 were not re-fetched within the request budget.

**Revisions.** Comparing the shipped workbook (saved 2026-09-15) with current FRED data, the only changes are **PCEPI, 67 months (2021-01 to 2026-07)**; for example, 2026-07 moved from 131.659 to 131.187. StatCan SA 2026-08 moved from 169.3 to 169.4. This matches table 18-10-0006 footnote 7: the previous month is revised every month, and three years are revised each January. The page's "typically each January" is incomplete.

**Alignment.**
- Every row is keyed to the first of the month. There is no interpolation or forward-fill; nulls stay blank.
- Daily series are reduced to the last valid observation in each month.
- The latest rows are ragged because sources publish with different lags.

## F.4 Browser feasibility (real Chromium, Origin `https://elmatthe.github.io`)

| Target | Status | ACAO | Verdict |
|---|---|---|---|
| StatCan WDS `getDataFromVectorByReferencePeriodRange` (GET) | 200 | `*` | **Readable** |
| StatCan WDS `getDataFromVectorsAndLatestNPeriods` (POST JSON, preflighted) | 200 / OPTIONS 204 | `*` | **Readable** |
| StatCan full-table CSV ZIP | 200 | none | **Blocked** |
| FRED API (no key) | 400 | none | **Blocked** (preflight also 400 with no ACAO) |
| FRED API with a key | — | — | UNVERIFIED (no key may be used); blocking strongly implied |
| FRED graph CSV `fredgraph.csv` | 200 | none (Akamai bot-manager cookies set) | **Blocked** |
| Bank of Canada Valet (V41690973, V41690914, V39079) | 200 | `*` | **Readable**; mirrors 2 of the 5 CPI vectors |

**Conclusions:**
- All 5 StatCan series can be fetched keyless by a static page.
- **No FRED data can be fetched by a browser**, because CORS blocks it whoever owns the key. FRED's terms also make a key personal, so the owner must never embed one.
- The page's "a complete web version would need a server" is too absolute: users can download FRED files themselves and import them.
- The proxy caveat: all traffic went through the session's egress proxy. StatCan and Bank of Canada headers were preserved.

## F.5 Processing workbooks in the browser (proven by experiment)

**Libraries tested:**
- **SheetJS CE 0.20.3** (Apache-2.0), installed from cdn.sheetjs.com. **npm's `latest` tag is the stale 0.18.5, which has two high-severity advisories.**
- **ExcelJS 4.4.0** (MIT; npm audit reports 9 moderate transitive advisories).

**Experiment.** Each library read the real `CPI.xlsx` and synthetic `.xlsx` and `.xlsm` files, one raw input was changed, a sheet was added, the file was written, and the output was inspected with openpyxl and the raw XML.

| Feature | SheetJS CE | ExcelJS |
|---|---|---|
| Reads an openpyxl-written package | ✔ | ✘ **crash** (`anchors`, `comments`) |
| Formula text | Default strips `_xlfn.` from 89 dynamic-array formulas; ✔ with `xlfn:true` | ✔ |
| Dynamic arrays (`cm` + `metadata.xml`) | ✔ 89/89 | ✘ **89 → 0**; rewritten as legacy CSE arrays |
| **Recalculation** | ✘ **none** (`=B2*2` stays 204 after B2 = 1000; CPI `US Data!B1368` stays 0.034 when it should be about +200 %) | ✘ **none** |
| Styles (fonts, fills, borders) | ✘ lost on 15,430 + 99,844 cells | ✔ |
| Freeze panes, conditional formatting, validation, tables | ✘ | ✔ |
| **Charts (5 in CPI.xlsx)** | ✘ **5 → 0** | ✘ **5 → 0** |
| **Pivot tables** | ✘ | ✘ |
| Defined names | ✔ | ~ sheet scope lost |
| **VBA (.xlsm)** | ✔ byte-identical | ✘ **dropped; content type changed to non-macro** |

**Verdict.** Local processing without upload is technically possible, but **neither library preserves the canonical model and neither recalculates**. A browser feature that "updates your workbook" would silently produce a degraded model with stale results. Do not offer it as equivalent to the desktop app.

## F.6 Closest viable browser version: "CPI data pack builder"

No server, no key, no upload.

1. **StatCan live.** Fetch the 5 vectors from WDS, keeping the 120-month chunking until the maximum size of a bulk POST has been tested. Bank of Canada Valet is a fallback for 2 of the vectors. Apply the desktop validation rules.
2. **FRED by user import.** The page generates `fredgraph.xlsx?id=…` links, split into two because one URL returned only 12 of 13 IDs. The user downloads the files in their own tab and drops them onto the page, which parses them locally and applies the same reduction of daily series to month-end values. Never ask for a FRED key.
3. **S&P 500.** Excluded by default.
4. **Output a NEW values-only workbook and CSV.** It has an A–S `CPI_Downloader` sheet and a `Sources` sheet carrying:
   - the StatCan Open Licence notice;
   - the FRED notice;
   - retrieval timestamps;
   - flags for provisional or partial months.
   
   The user pastes the data into their model in desktop Excel, which recalculates on paste. Use SheetJS 0.20.3 from the CDN, pinned with SRI.
5. **If an "update my file" option is ever offered:** show the F.5 loss table first; refuse files that contain charts, pivots, dynamic arrays or VBA; and name the output differently from the input.

**Desktop-only, and why:**
- In-place model update: only desktop Excel preserves the file.
- Live FRED: blocked by CORS.
- S&P history: licence restriction plus CORS.
- Recalculation: no browser library evaluates Excel formulas.
- OneDrive and lock-file handling: these are OS-level.

## F.7 Page UI

| Width | Page overflow | Data table | Guide config table |
|---|---|---|---|
| 1366 / 1024 / 853 | 0 | fits | fits |
| 390 | 0 | **365/386, internal scroll; dates break as `1913-`/`01`** | **365/469** |

- Four text blocks are under 14 px (12.5 px captions and the disclaimer).
- The local nav scrolls sideways at 390 px with no visual cue.
- The SVG has a stale product name and marketing copy (CPI-12). The stale-name test checks only `innerText` (`pages.test.js:44`), so it misses the SVG.

## F.8 Parity matrix (proposed browser data pack vs desktop)

| Capability | Rating | Reason |
|---|---|---|
| StatCan, 5 vectors, live | Equivalent | WDS sends CORS `*` (proven) |
| FRED, 13 series, live | Technically restricted | No CORS; browser can import user downloads only |
| FRED key handling | Browser superior | Import path needs no key; desktop stores it in plain text |
| S&P 500 | Technically restricted | Licence and CORS |
| Yahoo backfill | Technically restricted | Desktop-only by design; terms UNVERIFIED |
| Bank of Canada data | Browser superior (optional) | Valet sends CORS `*` |
| In-place model update | Desktop superior | Excel COM preserves the file (F.5) |
| Charts, dynamic arrays, VBA, styles | Desktop superior | Proven library losses |
| Model recalculation after update | Needs remediation (both) | CPI-02; libraries don't calculate |
| New standalone workbook or CSV | Browser superior | No Python, Excel or Windows needed |
| CSV export | Equivalent | — |
| Platform reach | Browser superior | Desktop needs Windows, Excel, Python and pywin32 |
| Validate before output | Equivalent | Same rules portable to JS |
| Revision pickup | Equivalent | Both re-fetch |
| Partial-month flag | Needs remediation (both) | CPI-04 |
| History-preserving update | Needs remediation (desktop) | CPI-03 |
| Source attribution | Needs remediation (both) | CPI-10 |
| Progress and cancel | Needs remediation (desktop) | CPI-08 |
| Range sanity | Needs remediation (desktop) | CPI-07 |
| Automated tests | Missing (browser) | Desktop has 105 offline tests |
| OneDrive and lock-file handling | Desktop superior (partly UNVERIFIED) | — |

## F.9 Remediation items (not implemented)

| ID | Sev | Fix | Acceptance / tests |
|---|---|---|---|
| R-01 (CPI-01) | High | Remove S&P values from the shipped workbook (blank column N, then re-save in Excel so derived caches and charts no longer contain S&P-derived values), or document written S&P DJI permission. Rebuild the ZIP and update `CANONICAL_SHA256`. | An openpyxl test asserts `CPI_Downloader` column N is empty; the ZIP matches the repo |
| R-02 (CPI-02) | High | First measure, on Windows Excel, whether reopening recalculates. Then either (a) re-enable calculation and run `CalculateFull()` before `Save` (re-check Decisions #004 on spills), or (b) show a mandatory post-run instruction ("press Ctrl+Alt+F9 / run Copy-Paste-Refresh") in the GUI and on the page. | Extend the COM regression so model cached values **change** for an edited month |
| R-03 (CPI-03) | High | Default to Date range 1913-01 to current. Ask for confirmation with row counts before replacing. Optionally add a merge mode that replaces only the requested months. | COM-mock test: 1,368 rows + a 1-month run either keeps 1,368 rows (merge) or triggers the confirmation |
| R-04 (CPI-04) | Medium | Drop or flag the current incomplete month for M/N/O | Unit test with `date.today()` monkeypatched |
| R-05 (CPI-07) | Medium | Clamp the end date to the current month; give a friendly error for 9999-12 | Parametrized tests |
| R-06 (CPI-08) | Medium | Worker thread with progress ("StatCan 3/60") and Cancel; results returned via `root.after` | Mocked slow `build_rows` test |
| R-07 (CPI-05) | Low | Run Excel Document Inspector: remove `absPath`, the web-extension parts and personal properties; re-baseline the hash | Zip scan for `absPath`, `webextension`, `C:\Users` |
| R-08 (CPI-10) | Low | Add StatCan Open Licence and FRED notices to the README, page and outputs | Text assertions |
| R-09 (CPI-09) | Low | Don't retry 4xx other than 409/429. Distinct messages: "FRED rejected the API key", "Statistics Canada is updating tables (00:00–08:30 ET)" | Mocked 400 / 409 / 429 tests |
| R-10 (claim gaps) | Low | Correct the privacy, revision, `.xlsm`, "server", OneDrive and repository claims | `pages.test.js` assertions |
| R-11 (CPI-12/13) | Low | Replace the SVG; make the 390 px table wrap safely | SVG text check; 390 px `scrollWidth == clientWidth` |
| R-12 (CPI-16) | Low | Remove the undocumented OneDrive switches and the 2 s sleep | Adjust `test_onedrive_absent_or_fails` |
| R-13 (CPI-17) | Low | Make the bootstrap tests run on Linux via monkeypatching, or skip them explicitly; make the rollback test assert that the rollback actually ran | 0 failures on Linux with no manual deselection |
| R-14 (CPI-18/19) | Low | "Remember key" checkbox (or Windows Credential Manager via `keyring`); clickable link | Tk-stub unit test |
| R-15 (browser) | Proposal | Build the F.6 data pack builder | Playwright with mocked WDS and a FRED fixture; output equals the desktop CSV for the same inputs |
| R-16 (CPI-21) | Info | Replace the 60 GETs with one WDS bulk POST after testing its limits | Update `test_statcan_chunks` |

## F.10 Unverified

1. Whether desktop Excel recalculates on reopen after a COM write (needs Windows and Excel).
2. CORS headers on a keyed FRED response.
3. Yahoo CORS and terms, and the README's Yahoo evidence.
4. How Excel treats the library outputs (`#NAME?`, legacy arrays, rejected `.xlsm`).
5. The OneDrive `/pause` and `/resume` switches.
6. Whether the `elmatthe/CPI-Webscraper` repository is public. `Decisions.md:55` says private, and the proxy returned 403.
7. Some series start dates that were not re-fetched.
8. The WDS bulk-request size limit.
9. The GS10/GS2 aggregation wording.

**Sources (accessed 2026-11-03):**
- StatCan WDS user guide: https://www.statcan.gc.ca/en/developers/wds/user-guide
- StatCan Open Licence: https://www.statcan.gc.ca/en/terms-conditions/open-licence
- FRED API terms of use: https://fred.stlouisfed.org/docs/api/terms_of_use.html
- FRED SP500 series notes: https://fred.stlouisfed.org/series/SP500
- Bank of Canada Valet: https://www.bankofcanada.ca/valet/docs
- SheetJS CDN index: https://cdn.sheetjs.com/
- ExcelJS README (4.4.0)
- ECMA-376 `CT_SheetPr`
