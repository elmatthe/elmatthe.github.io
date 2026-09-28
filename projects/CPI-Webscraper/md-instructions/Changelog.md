# CPI-Webscraper — Changelog

## 0.3.0 final audit — approved checkpoint — 2026-09-15

- Independently verified the user's corrected recession indicators (1,364 published months, zero mismatches) and FRED-only canonical S&P data (121 months, exact equality).
- Audited the latest chart date controls/helper relocation and accepted AF/AG formatting; 6,078 helper dates/values matched the model independently.
- Corrected the regression's handling of empty array-interior XML markers and strengthened cached-value comparison; added tests that still reject real formula/value changes.
- Included the user-supplied optional Office Script; reviewed its API calls and passed four mocked execution scenarios.
- User explicitly approved retaining the annotation in US Data BC1358, superseding the earlier blank-cell requirement. Finalized the exact approved workbook regression hash and removed the obsolete manual correction report.
- Approved the final release-candidate audit and normal feature-to-main integration. No runtime feature changes, tag or GitHub Release in this audit.

## 0.3.0 follow-up — 2026-09-15 — Release candidate

- Adopted the user's corrected canonical workbook and final A–S schema: A–O unchanged, P/Q Treasury averages, R/S headline/core PCE. Audited model references; no workbook bytes were changed by implementation.
- Replaced positional source-definition zips with explicit stable-ID mappings and synchronized order-sensitive config/tests/verify/docs.
- Added strict, backward-compatible default-off `sp500_history.add_missing_data`; safely appended it to private root config without exposing/changing the key or existing settings.
- Added optional unofficial Yahoo ^GSPC raw daily-Close history through direct requests to chart JSON, exchange-timezone parsing, FRED-first precedence and bounded overlap validation. No yfinance/pandas, adjusted-close, CSV/crumb or additional credential/dependency.
- Live endpoint initially returned 429 without an identifying User-Agent; explicit period bounds plus CPI-Webscraper/0.3.0 returned daily history from 1927-12-30. All 120 completed overlap months agreed within 0.000234375 points; adopted a 0.005-point absolute tolerance. Implemented TRUE merge passed live at the moving FRED boundary.
- Added offline parser/config/merge/atomicity coverage and updated the canonical schema/hash regression without weakening model-preservation checks.
- Audited every populated US Data AD month against USREC: 38 manual corrections listed with exact cells; 1,326 other months agree. Workbook correction and visual acceptance remain manual gates.

## 0.3.0 — 2026-09-14 — Release candidate

- Established stable `scripts/cpi_webscraper.py` entry point and focused config, source, workbook and bootstrap modules; retained the simple tkinter workflow and added the FRED notice.
- Added private root TOML configuration, blank-key template, strict complete-ID validation, editable sheet/headers/order, safe legacy migration and comment-preserving key persistence.
- Replaced the previous Fed Funds target-bound source with DFF effective-rate EOP; appended GS10/GS2 monthly Treasury averages at R/S. Kept A–Q roles, first-of-month keys, all five StatCan vectors and exact S&P semantics.
- Fixed overlapping StatCan chunks; enforce bounded HTTP retries, sanitized errors, response/schema validation and complete collection before Excel access. Verified all 17 government/economic historical starts live; S&P was not requested because organizational permission is a manual gate.
- Replaced row deletion/openpyxl production writing with pywin32 Excel COM ClearContents and bulk assignment. Suppressed session recalculation after real regression exposed dynamic-array spill/format changes. The corrected disposable-copy regression passes and the canonical workbook remains unchanged.
- Rebuilt setup around runtime assessment, venv repair, exact dependency reconciliation, import proof and config validation. Healthy repeat launches avoid pip. Updated requests to 2.34.2 and added pywin32 312; retained other exact pins.
- Expanded offline config/source/COM/bootstrap tests and added opt-in canonical workbook and live-source checks. Strengthened offline verify for pins/imports, schema, secrets, obsolete names and shipped structure.
- Consolidated permanent docs and ignored local config, runtime/test scratch and developer clutter. No merge/tag/release; manual launcher/Excel/S&P/independent review gates remain.

## 0.2.2 — 2026-06-19

Moved tests beneath `files/tests`, updated verification discovery and ignored pytest cache. Six baseline tests passed in the original environment.

## 0.2.1 — 2026-06-19

Pinned dependencies and pytest, introduced six offline tests and a verification script, improved user-scope setup and ignored personal FRED credential notes.

## 0.2.0 / 0.1.7 — 2026-06-18

Verified and introduced FRED API-key persistence in ignored legacy `files/config.json`.

## 0.1.6 — 2026-06-18

Initial single-script downloader: StatCan/FRED, date modes, seventeen output columns, optional CSV, openpyxl writes and best-effort OneDrive handling. Dates before January 1913 were clamped.
