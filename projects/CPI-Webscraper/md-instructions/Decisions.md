# CPI-Webscraper — Decisions

## 006 — Compare actual array results across Excel serialization — 2026-09-15 — Release audit

The final canonical workbook is the user's explicitly approved save, SHA256 `7df41a06452c854b3a4f5536b7b648b64d936513a999a3c2eaa12cddc250f8c1`. Retain BC1358 exactly; the final instruction supersedes the earlier requirement that it be blank. Canonical raw data is FRED-only, while Yahoo remains opt-in at runtime. User-approved chart/date controls and formatting are part of the preservation baseline.

The latest user workbook stores empty `<f ca="1"/>` markers inside dynamic-array result ranges. openpyxl exposes them as `=`; desktop Excel removes the markers when saving. All 6,377 affected cells retained identical cached values and formats in the disposable-copy audit. This is a serialization difference, not a change to the anchor formula or its result.

The regression now resolves an empty marker to its cached value only inside a declared array range and outside its anchor; an empty formula elsewhere fails. Real anchor formulas and all formatting/structure remain compared. Added comparison of all cached model values strengthens preservation coverage. Offline fixtures prove real value/formula mutations still fail equivalence. No production writer behavior changed.

## 005 — Final schema and optional Yahoo history — 2026-09-15 — User / Codex

**Status:** Accepted; supersedes the default ordering in #002 and the blanket supplemental-source exclusion in #003. FRED's business-use permission gate remains. The user replaced the blocked Stooq requirement with direct Yahoo ^GSPC chart JSON; no Stooq implementation or further Stooq probing was performed.

**Schema:** A–O unchanged, P/Q Treasury monthly averages, R/S headline/core PCE. Economic series definitions now map explicit stable IDs to source IDs; physical positions and header text never determine identity. Adopt the user's manually corrected reference without editing its formulas, formatting or data. USREC recession mismatches are documented manual corrections, never runtime writes to model sheets.

**Optional source:** false is normal FRED-only behavior with zero Yahoo calls. true fetches FRED first, obtains Yahoo raw daily Close in America/New_York trading dates, and fills only missing observations; FRED always wins. Missing config section defaults false. Use existing requests/python-dateutil plus stdlib; UTC epoch arithmetic avoids Windows pre-1970 fromtimestamp errors. No adjusted-close, yfinance, pandas, authentication crumb, other index or new key.

**Request evidence:** explicit period1/period2, interval=1d, User-Agent=CPI-Webscraper/0.3.0 and Accept=application/json worked; unidentified requests returned 429. Earliest valid Yahoo observation was 1927-12-30; dates before that remain blank. This is optional unofficial Yahoo historical/predecessor-index data, not professionally licensed FRED history, and its availability may change.

**Validation rule:** up to six earliest completed months from the actual returned FRED reference window, at least three required. Short/history-only requests get additional FRED reference history solely to establish overlap. Exclude the current incomplete month from overlap checks. Absolute tolerance is 0.005 index points, half the 0.01 published precision of FRED SP500, with no relative tolerance. Validate before merge/write and fail on unavailable or inconsistent Yahoo data. Never silently fall back in true mode.

**Live evidence (2026-09-15):** 120 completed months from 2016-09 through 2026-08; maximum absolute difference 0.000234375000218 points, maximum relative difference 5.33244905235e-8. The observed FRED boundary was 2016-09; it is never hardcoded. Implemented merge transitioned from Yahoo 2016-08 = 2170.949951171875 to FRED 2016-09 = 2168.27. Earlier data begins in 1927-12; the 1913 monthly grid is unchanged.

| Month | FRED EOP | Yahoo raw Close EOP | Absolute difference |
|---|---:|---:|---:|
| 2016-09 | 2168.27 | 2168.27001953125 | 0.000019531250 |
| 2016-10 | 2126.15 | 2126.14990234375 | 0.000097656250 |
| 2016-11 | 2198.81 | 2198.81005859375 | 0.000058593750 |
| 2016-12 | 2238.83 | 2238.830078125 | 0.000078125000 |
| 2017-01 | 2278.87 | 2278.8701171875 | 0.000117187500 |
| 2017-02 | 2363.64 | 2363.639892578125 | 0.000107421875 |
| 2026-06 | 7499.36 | 7499.35986328125 | 0.000136718750 |
| 2026-07 | 7489.72 | 7489.72021484375 | 0.000214843750 |
| 2026-08 | 7686.14 | 7686.14013671875 | 0.000136718750 |

Sources: [Yahoo chart endpoint](https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC), [FRED SP500](https://fred.stlouisfed.org/series/SP500), [FRED USREC convention](https://fred.stlouisfed.org/series/USREC).

## 004 — Preserve dynamic-array spills during COM writes — 2026-09-14 — Codex

**Status:** Accepted. The first real COM regression preserved formulas but Excel recalculation changed spill values and visualization formatting. Disable worksheet calculations for the private automation session before clearing/writing, retaining workbook calculation mode. The saved model cells and formatting now match the original in regression; normal user opening can recalculate later. No XML patching, formula rewrite or format repair is used. See [Excel EnableCalculation](https://learn.microsoft.com/en-us/office/vba/api/excel.worksheet.enablecalculation) and [ClearContents](https://learn.microsoft.com/en-us/office/vba/api/excel.range.clearcontents).

## 003 — Retain exact S&P semantics with a production permission gate — 2026-09-14 — User plan / Codex

**Status:** Accepted. Column N stays S&P 500 price index EOP from FRED SP500. The [source notice](https://fred.stlouisfed.org/series/SP500) restricts history to about ten years and identifies third-party permission requirements. Organizational rights must be confirmed before production approval; S&P was excluded from live implementation checks. No provider/licensing project, Yahoo/yfinance endpoint, benchmark substitution or fabricated historical data is in scope. Deep S&P history remains unsolved.

## 002 — Stable IDs and a minimal private TOML — 2026-09-14 — User plan / Codex

**Status:** Accepted. All nineteen IDs are required exactly once; headers/order are presentation settings. Preserve default A–Q roles and append R/S. Root config contains the API key and is ignored, with a blank committed default. Safe key persistence preserves comments/schema; invalid existing configuration is never replaced. Literal headers prevent Excel formula injection; unconventional TOML key/table layout may require manual key editing. Custom order/sheet does not authorize downstream formula changes.

## 001 — Small Windows desktop architecture and Git recovery — 2026-09-14 — Codex

**Status:** Accepted. Use Python 3.11–3.14, focused modules and desktop Excel COM. Keep openpyxl for read-only regression inspection, not production writes. [pywin32 312](https://pypi.org/project/pywin32/312/) and other current exact pins were verified from PyPI; no global post-install or admin tooling. Native monthly Treasury series avoid unnecessary daily aggregation. StatCan uses its [supported WDS API](https://www.statcan.gc.ca/en/developers/wds/user-guide); FRED uses [documented observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).

The supplied local folder had no Git metadata. Authenticated remote metadata confirmed private `elmatthe/CPI-Webscraper`; its main HEAD was `d39d426abd6bd5c3b7198d1fb5c9c935b2a8c583` with only README tracked. Initialized the requested feature branch, fetched origin and attached it to that baseline with a mixed reset, preserving every local working file. Existing local project contents are intentionally included in this feature branch. Main is untouched.
