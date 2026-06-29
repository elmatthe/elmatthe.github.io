# Stock Comparison & Analytics Tool - Changelog

## v0.3.0 - 2026-06-29
- Added user-selectable **Currency Normalization** ("Normalize to currency": Off / USD / CAD / EUR / GBP) in both the desktop app and the in-browser web dashboard, with identical behavior, labels, and an Off default.
- Prices are now converted into one common currency **before** any returns, total/annualized return, volatility, Sharpe, drawdown, indexed price, cumulative return, correlation, or regression are computed, so cross-currency comparisons reflect true performance instead of USD/CAD FX drift.
- FX rates are pulled from the existing Yahoo Finance path as `<native><target>=X` pairs (e.g. `CADUSD=X`), forward-filled and aligned to each security's price dates. Conversion fails soft: an unavailable pair leaves that security in its native currency with a clear message instead of crashing.
- When normalization is active, the currency note changes to confirm the active mode (e.g. "FX normalization ON - all series converted to USD using daily Yahoo Finance FX rates"); when Off, the existing multi-currency warning is kept.
- Offline Sample mode demonstrates normalization using a small bundled FX rate file (`test-files/fx_rates.csv`; the web dashboard embeds the same rates), so the feature works offline without a network call.
- Reused the existing data layer for FX; no new third-party dependency was added (Yahoo via `yfinance` desktop, public proxy on web).
- Added pytest regression tests for FX conversion (`tests/test_fx_normalization.py`): known prices + known FX rate assert converted metrics, forward/back-fill alignment, no-op when already in target currency, fail-soft on missing rates, and the bundled offline FX loader/inverse derivation.
- Bug pass: investigated the INTC USD vs INTC.TO/INTC.NE divergence and the implausible short-window annualized figures. Findings recorded in `handoff.md`; the cross-currency portion is resolved by normalization, and the common-window/short-window annualization items are flagged there for review rather than silently changed.

## v0.2.5 - 2026-06-09
- Fixed Regression Analysis dropdown so selected regression details and scatterplot update correctly.
- Improved rolling volatility and rolling correlation chart calculations for cleaner visuals.
- Added exported JPG visualization folder alongside Excel and CSV exports.
- Corrected fresh-launch default frequency to Monthly.
- Hid Offline CSV sample-date helper text unless Offline CSV mode is selected.
- Added minimal ZIP release guidance.

## v0.2.4 - 2026-06-09
- Improved Offline CSV date-range mismatch messaging.
- Added clearer guidance when sample CSV data exists but does not overlap the selected date range.
- Reduced confusion from generic not-enough-data popups in Offline CSV mode.
- Added guidance to use the sample CSV date range or switch to Yahoo Finance for live market data.
- Kept FX conversion, Alpha Vantage, and Twelve Data as future enhancements.

## v0.2.3 - 2026-06-09
- Added user-selected currency mismatch warnings when a ticker's selected currency differs from the detected data-source currency.
- Added Offline CSV currency detection from CSV Currency columns.
- Kept analysis non-blocking when currency mismatches are detected.

## v0.2.1 - 2026-06-09
- Removed saved comparison profile functionality because the app is intended as a one-time analysis/export tool.
- Removed Save Profile and Load Profile buttons from the GUI.
- Removed profile folder/config/test references.
- Improved Offline CSV loading for combined CSV and one-file-per-ticker formats.
- Added clearer Offline CSV warnings for missing tickers, invalid folders, missing columns, missing price columns, and date ranges with no overlap.
- Reduced repetitive ticker failure popups in Offline CSV mode.
- Updated documentation to explain Offline CSV testing and expected CSV formats.

## v0.2.0 - 2026-06-09
- Added user-selectable export folder.
- Added GUI chart viewing instead of plot paths only.
- Added risk/return scatterplot.
- Added drawdown chart.
- Added rolling volatility chart.
- Added chart insertion into Excel exports.
- Added website asset output folder for future GitHub Pages visuals.
- Added diversification summary.
- Improved regression selection display and scatterplot selection support.
- Added tests for new plot/export/config behaviour.

## v0.1.0 - 2026-06-09
- Initial project scaffold created.
- Added cross-platform setup launchers.
- Added Tkinter GUI for ticker entry, analysis controls, results tabs, exports, and warnings.
- Added analytics, data source, plotting, export, and config module structure.
- Implemented dashboard metrics, return calculations, correlation matrix, regression analytics, and diversification flags.
- Implemented Offline CSV mode and Yahoo Finance mode.
- Added Matplotlib plot generation and Excel/CSV exports.
- Added pinned dependencies and pytest coverage for analytics, offline CSV, and exports.
