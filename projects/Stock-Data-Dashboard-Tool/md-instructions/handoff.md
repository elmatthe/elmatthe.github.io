# Handoff — FX Normalization (v0.3.0)

Living work log for the FX Normalization feature drop. Dated, signed entries.
This file is a temporary instruction-companion log; the permanent docs are
`Briefing.md` and `CHANGELOG.md`.

---

## Files to edit (located 2026-06-29)

### Web / live version (Jekyll, GitHub Pages)
- `projects/stock-data-dashboard-tool.md` — the in-browser dashboard. Analytics is
  inline JavaScript inside a `{% raw %}<script>…</script>{% endraw %}` block
  (lines ~180–833). No separate JS asset file; no JS test harness exists.
- `projects/stock-data-dashboard-tool-v0.2.5.zip` → replaced by
  `projects/stock-data-dashboard-tool-v0.3.0.zip` (download artifact).

### Desktop version (Python GUI)
- `projects/Stock-Data-Dashboard-Tool/scripts/config.py` — normalization options/helpers.
- `projects/Stock-Data-Dashboard-Tool/scripts/analytics.py` — pure FX conversion functions.
- `projects/Stock-Data-Dashboard-Tool/scripts/data_sources.py` — Yahoo FX fetch + offline FX loader.
- `projects/Stock-Data-Dashboard-Tool/scripts/main.py` — UI control + wiring + note.
- `projects/Stock-Data-Dashboard-Tool/test-files/fx_rates.csv` — bundled offline FX sample (new).
- `projects/Stock-Data-Dashboard-Tool/tests/test_fx_normalization.py` — regression tests (new).

### Docs
- `projects/Stock-Data-Dashboard-Tool/md-instructions/Briefing.md`
- `projects/Stock-Data-Dashboard-Tool/md-instructions/CHANGELOG.md`
- `projects/Stock-Data-Dashboard-Tool/README.md`
- root `README.md` (site-level) — note FX normalization on the tool.

### Structure note
This project does NOT use a `Briefing.md`/`CHANGELOG.md`/`handoff.md` trio yet — it has
`Briefing.md` + `CHANGELOG.md` only, and tests live in `tests/` with fixtures in
`test-files/` (not `files/tests/` + `files/test-files/`). Per the instruction drop I have
NOT restructured this; I followed the project's existing layout and created this `handoff.md`
in the existing `md-instructions/` folder. Ask if you want the folder layout reorganized.

---

## Session Sync Log

### 2026-06-29 — Claude (claude/vigilant-bardeen-wb3zgl)
- Phase 1: Session kickoff. Read CLAUDE.md, AI-WORKSPACE.md, Briefing.md, CHANGELOG.md.
  Confirmed current version v0.2.5 (live download is `stock-data-dashboard-tool-v0.2.5.zip`).
  Located both implementations (paths above). Confirmed currency metadata source:
  Yahoo `meta.currency` (web) / `fast_info`/`get_info` currency + suffix map (desktop);
  offline CSV `Currency` column.
- Phase 2: Desktop FX normalization. Added `NORMALIZE_CURRENCY_OPTIONS` +
  `parse_normalization_choice` (config.py); pure `align_fx_rate`, `convert_price_frame`,
  `normalize_price_frames_to_currency` (analytics.py); `fetch_fx_rate` on Base/Yahoo/Offline
  sources + `load_offline_fx_rates`/`get_offline_fx_rate` and price-CSV glob now skips FX files
  (data_sources.py); UI selector + wiring + active-mode note (main.py, APP_VERSION→v0.3.0).
  Added `test-files/fx_rates.csv` and `tests/test_fx_normalization.py` (8 tests).
- Phase 3: Web FX normalization in `projects/stock-data-dashboard-tool.md`. Added "Normalize to
  currency" selector; `SAMPLE_FX`; `parseNormalize`/`buildFxAligner`/`sampleFxPoints`/
  `normalizeSeries`; FX fetched via existing proxy+Yahoo chart path as `<native><target>=X`;
  Offline uses embedded SAMPLE_FX; currency note switches to FX-ON mode. JS `node --check`
  passes; node math check matches the Python regression (XIU.TO CAD→USD = [22.5, 22.936,
  22.65725], inverse 1/0.75=1.3333). Behavior/labels/default(Off)/currency set identical to
  desktop.
- Phase 4: Bug pass (see Bug Pass Findings below).
- Phase 5: Docs — Briefing.md (FX section + flagged items), CHANGELOG.md (v0.3.0), desktop
  README.md, RELEASE_CHECKLIST.md (+fx_rates.csv), web project page + guide page (download link
  →v0.3.0, last_updated, feature text), root README.md (FX tag).
- Phase 6: Verify — 37 non-GUI tests pass; deps all pinned; CHANGELOG/Briefing/APP_VERSION all
  v0.3.0. End-to-end desktop offline normalization confirmed. Built
  `projects/stock-data-dashboard-tool-v0.3.0.zip` (mirrors the actual v0.2.5 artifact contents +
  `test-files/fx_rates.csv`); removed the old v0.2.5 zip.
  NOTE: `tests/test_currency_warnings.py` imports `main` (→tkinter), which is unavailable for
  Python 3.11 in this headless container, so it was not executed here. Its tested functions were
  not modified; run the full suite on a normal desktop machine to confirm.

## Bug Pass Findings

| # | Severity | Where | Finding | Action |
|---|----------|-------|---------|--------|
| 1 | (root cause) | both | Cross-currency divergence between INTC (USD) and INTC.TO/INTC.NE (CAD): indexed price, returns, vol diverge from USD/CAD FX drift, not real performance. | FIXED by the new FX normalization feature. |
| 2 | Minor (flagged) | both | Dashboard total/annualized/volatility/observations use each security's own available date window, not the common overlapping window. Securities with different histories (251 vs 128 vs 247 obs) are compared over different time periods, so "Best Total Return" can mislead. Correlation/regression already align on overlapping/pairwise-complete observations. | FLAGGED for your review — not changed (would silently alter every displayed metric). Recommend adding an "align metrics to common window" option. |
| 3 | Suggestion (flagged) | both | Geometric annualization `(1+total)^(ppy/obs)-1` on short, high-return windows yields extreme figures (e.g. 247.95% over 128 daily obs → 1064.44%). This is mathematically correct compounding, not a formula bug; the implausibility comes from #1 (FX) + #2 (window) feeding a large short-window total return. | FLAGGED — not changed. Optionally label/caps annualized return when obs < ~1yr. |
| 4 | Minor (flagged) | desktop `data_sources.py` | `history.rename(columns={"Adj Close": "Adj Close"})` is a no-op. | FLAGGED — cosmetic, left as-is to stay in scope. |

No Critical (crash-class) bugs were found in the v0.2.5 code. Dependencies in
`scripts/requirements.txt` resolved/installed cleanly in this environment (pandas/numpy/scipy/
matplotlib/yfinance/openpyxl/Pillow/pytest), so no dependency-pin breakage observed.

## Files added/changed this session (staged + committed together)
- A `projects/Stock-Data-Dashboard-Tool/test-files/fx_rates.csv`
- A `projects/Stock-Data-Dashboard-Tool/tests/test_fx_normalization.py`
- A `projects/Stock-Data-Dashboard-Tool/md-instructions/handoff.md`
- A `projects/stock-data-dashboard-tool-v0.3.0.zip`
- M `projects/Stock-Data-Dashboard-Tool/scripts/{config,analytics,data_sources,main}.py`
- M `projects/Stock-Data-Dashboard-Tool/README.md`
- M `projects/Stock-Data-Dashboard-Tool/md-instructions/{Briefing,CHANGELOG,RELEASE_CHECKLIST}.md`
- M `projects/stock-data-dashboard-tool.md` (web dashboard)
- M `projects/stock-data-dashboard-guide.md`
- M `README.md` (site root)
- D `projects/stock-data-dashboard-tool-v0.2.5.zip`

## Manual steps only you can do
- The v0.3.0 zip was rebuilt here from source; re-verify/re-zip on your own machine if you prefer.
- The download link on the project + guide pages now points to v0.3.0 (done in repo).
- After the GitHub Pages build deploys, test the live dashboard on elmatthe.github.io
  (run a Yahoo comparison of QQQ + QQC-F.TO + QQC.TO with Normalize → USD).
- Pull this branch on each machine and run the full pytest suite (incl. the tkinter test) per
  the Session Sync Log.
