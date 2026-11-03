# Handoff — shared keyless market-data gateway (2026-11-03)

Repository `elmatthe/elmatthe.github.io`, branch `claude/loving-brown-48hctl`, restarted
from `main` at the PR 45 merge `153c4c936c31e0cc5ff384d70628baaa068a5847` (the branch's
earlier work was already merged). Not merged; no deployment; no live provider request.

## State

| Checkpoint | Result |
|---|---|
| A. Source and licensing | **Blocked for production.** Yahoo's `v8/finance/chart` endpoint is unofficial; Yahoo's ToS §2(d)(ix), §2(e), §2(h) prohibit automated collection and redistribution. No permitted keyless equity source was found. Recorded in `_tools/PROVIDER_MATRIX.md` §10. |
| B. Worker | `_services/market-data-gateway/` (venues, Yahoo adapter, gateway, entry, `wrangler.toml`, README with deployment guide). Source gated off (`KEYLESS_SOURCE` + `SOURCE_AUTHORIZATION`). Checked in Node (unit tests) and in local workerd with the gate closed. |
| C. Rebalancer | Free source as a separate tier in `assets/js/market-data/keyless.js` + `index.js`; Automatic = keys first, then free source; *Free source only* mode; opt-in fallback keeps key errors visible; labels, plan notes, exports. Engine, sample and catalog untouched. |
| D. Stock | *Free source* option (default when available and no AV key), daily history for 1D–5Y with both bases kept apart, snapshot, per-series source in CSV/JSON/XLSX. |
| E. Docs | Gateway README, `PROVIDER_MATRIX.md` §10, `MARKET_DATA.md` §0.1, `_tools/README.md`, `BROWSER_DESKTOP_PARITY.md`, `RELEASE_NOTES.md`, root `README.md`, page copy. |
| F. Tests | `unit/market-gateway.test.mjs`, `unit/keyless.test.mjs`, `browser/freesource.test.js`, fixtures `fixtures/yahoo-chart.mjs`; harness runs the real gateway for `md.gateway.test`; CI step added. |

Site setting: `_data/market_data.yml` `gateway: ""` (empty: pages say "not set up").

## Verification (2026-11-03, this container; all providers and Yahoo mocked)

| Check | Result |
|---|---|
| `node --test _tools/tests/unit/*.test.mjs` | 192/192 (was 167; +16 gateway, +9 adapter) |
| `python -m pytest -q -m "not e2e"` in `_tools/tests` | 111 passed, 1 skipped (needs tkinter, as before) |
| `sync_shared_py.py --check`, `cpi_public_workbook.py --check`, `build_project_zips.py --check`, `bootstrap/render.py --check`, strict Jekyll build | all pass |
| Browser: pages / stock / rebalancer / montecarlo / cpi / freesource | 147 / 72 / 121 / 40 / 112 / 115, no failures |
| Desktop tool tests (Python 3.12 + Xvfb; CI uses 3.13) | 16 / 29 / 55 / 118 (+1 skipped, Windows-only excluded) |
| Gateway in local workerd (`wrangler dev` 4.157.0, gate closed, no account) | health, `source_disabled`, CORS, preflight, `invalid_request` as documented |

Harness change: Alpha Vantage and Marketstack mocks now date European quotes by the
venue's own calendar (the Rebalancer suite failed after 23:00 UTC before; pre-existing).
Not available here: axe-core (accessibility checked structurally instead), real
Cloudflare deployment, any live Yahoo or provider request.

## Manual / authorization gates (owner)

1. Decide whether to seek written permission from Yahoo (and any exchange licensors) for
   automated retrieval and public redistribution with caching. Without it, keep the gate
   closed; the feature stays unavailable in production.
2. Approve deployment, then follow `_services/market-data-gateway/README.md` (deploy,
   verify, set `_data/market_data.yml`, rollback).
3. After activation only: the capped live smoke test in that README (7 quotes + 1 history),
   which also confirms the Yahoo exchange codes in `src/venues.js`.

## Exact next action

Owner review of this branch (PR if wanted), and the licensing decision in gate 1.
