# CPI-Webscraper — Handoff

## Approved v0.3.0 checkpoint — 2026-09-15

The independent release audit is approved. The user explicitly authorizes a normal merge of `feature/0.3.0-cpi-webscraper-redesign` into `main`, pushing both branches and preserving the feature branch. No force-push, tag, GitHub Release or further feature work is authorized. Git branch tips and the normal merge commit identify the final integration SHAs; this document is part of the approved feature checkpoint. Starting feature HEAD was `6c0132380ae3b017ecff8d6455c167c5f8e88d8d`; pre-merge main was `d39d426abd6bd5c3b7198d1fb5c9c935b2a8c583`.

## Accepted canonical workbook

- SHA256: `7df41a06452c854b3a4f5536b7b648b64d936513a999a3c2eaa12cddc250f8c1`.
- **US Data BC1358 is deliberately retained exactly as saved.** Explicit final user approval supersedes the earlier blank-cell requirement; it is not a defect or pending gate.
- All 38 recession corrections are resolved. A fresh USREC comparison covered every populated AD month with published data: **1,364 agree, zero mismatches**. September 2026 is provisionally 0 and is not yet published.
- Canonical raw N exactly matches **121 FRED SP500 monthly EOP observations, 2016-09 through 2026-09**. All earlier months are blank. No optional Yahoo history is pre-populated. Every raw value matches the previous FRED-only canonical data.
- Final schema: A–O unchanged; P/Q 10-year/2-year Treasury monthly averages; R/S headline/core PCE. US AI/AJ/AK and PCE blocks correctly reference O/P/Q/R/S. US/CDN formula text is unchanged; CDN data and visible styles are unchanged.
- Accepted AF/AG percentage/index formats and raw fill colors were compared by actual visible properties. The AF positive-return conditional format is consistent with the accepted formatting.
- The user's latest save adds chart date controls and relocates helpers to CQ:DR. All five chart definitions point to the new ranges. **6,078 independently checked helper dates/values match the model**. No cached model errors exist; chart `#N/A` values are intentional gaps. Names, sheets, merges and tables remain intact.
- Audit code never wrote to the canonical workbook. All Excel automation proofs used disposable repository-contained copies. The obsolete manual recession report was deleted by the user and its stale references removed.

## Configuration and source modes

Root `config.toml` remains ignored/untracked with its existing key/settings preserved. Root and committed default both use `[sp500_history] add_missing_data = false`; the default key is blank. Missing section means false, and only TOML booleans are accepted. Stable IDs define identity independently of physical order/header labels.

FALSE uses FRED SP500 only and makes zero Yahoo requests. TRUE is optional unofficial Yahoo ^GSPC raw daily Close history, reduced to monthly last-trading-day Close in America/New_York. FRED is fetched first and always wins overlap; boundaries are dynamic. No interpolation, forward-fill, proxy, adjusted-close, crumb, extra key or extra dependency is used. Up to six completed overlap months are checked, at least three required, with absolute tolerance 0.005 points. Source/validation failures abort before Excel with sanitized errors and no silent fallback.

Prior authorized read-only live Yahoo validation reached 1927-12-30 using explicit period bounds, interval=1d and an identifying User-Agent. All 120 completed overlap months agreed within 0.000234375 points (relative 5.33245e-8); implemented TRUE merge passed. Detailed evidence is in Decisions #005. This optional historical/predecessor index data does not confer professional data usage rights; source availability may change.

## Independent verification

- Full offline suite: **104 passed, 1 skipped**; all `scripts/verify.py` gates PASS. Normal verification makes no live source calls.
- Final named workbook/Excel regression: **4 passed in 16.16 seconds**, using the exact approved hash. Real anchor formulas, actual values, all cached model values, formatting, chart/model structure, raw output and canonical hash preserved.
- A first transient Excel operation failed; subsequent isolated execution succeeded. The latest save's 6,377 empty array-interior XML formula markers caused a false comparison failure. Decisions #006 records the correction: normalize only known array-interior markers and retain every actual value/formula/format assertion. Added cached-value comparison strengthens the check; new offline tests still reject real formula/value changes and invalid empty formulas outside arrays.
- Actual batch launcher `--check-only` PASS with healthy environment and no repair/install. Bootstrap repair/rollback/import/config/containment paths are covered in the full suite; prior real isolated provisioning proofs remain in commit history.
- Source collection, FALSE/TRUE merge/failure paths, strict config/migration/key persistence, CSV failure reporting, COM cleanup and raw-only writing reviewed and mechanically covered.
- Credential checks PASS, including decompressed workbook contents. Root configuration remains private, template credentials blank. Branding, entry points, dependency pins, shipped structure and `git diff --check` PASS.

## Optional Office Script

`files/office-scripts/Copy-Paste-Refresh.ts` is user-supplied and included in the approved checkpoint. It copies the configured worksheet's used range onto itself and performs a full calculation rebuild; default target is CPI_Downloader. Reviewed API calls and direct TypeScript stripping/mocked execution passed normal, missing-sheet, blank-sheet and zero-sheet paths. It is not invoked by Python. Native Office Scripts/button integration is an optional host-specific manual check on a disposable copy.

## Remaining notes and exact next action

No unresolved acceptance decision remains. Complete the authorized push/normal merge and verify local main equals origin/main, clean working tree and preserved feature branch; then stop. After integration, the next user action is to use the approved main checkpoint and retain the following production/platform notes; no additional development is authorized.

Confirm S&P usage rights before professional production use. September 2026 USREC awaits publication. Other supported Python minors, fresh winget provisioning and VBA-bearing workbooks remain platform limits beyond the tested Windows/Python 3.14.2/.xlsx environment. The user exercised FALSE mode and reported successful TRUE testing; optional Office Scripts host integration remains separate from downloader acceptance. Ignored files/run-temp and files/temp are recreated by tests/bootstrap as needed.
