# Handoff — Yahoo Finance gateway activation and ordered source list (2026-11-04)

Repository `elmatthe/elmatthe.github.io`, branch `claude/loving-brown-48hctl`, PR
<https://github.com/elmatthe/elmatthe.github.io/pull/46> (draft, **not merged**). Base:
`main` at `153c4c936c31e0cc5ff384d70628baaa068a5847`. No release or tag created; no paid
service activated.

## Decisions applied

- Owner authorization (stated by the owner; private, not reproduced or referenced): the
  owner's written permission from Yahoo covers display to visitors, automated retrieval
  from the chart endpoint, retrieval through a Cloudflare Worker, temporary caching and
  delivery to multiple visitors, and exchange-supplied data distributed by Yahoo.
- Activation stays explicit and fail-closed: `KEYLESS_SOURCE = "yahoo-chart"` +
  non-sensitive flag `OWNER_ATTESTATION = "owner-confirms-yahoo-permission"`, only in
  `[env.production]` of `wrangler.toml`; top-level (fresh) settings are off.
- 6B: PR opened for `7ec7c6f`, updated with verified commits. 7B: desktop parity. 9B: tests
  and CI are the qualification gates; an independent Codex review follows.

## State by checkpoint

| Checkpoint | Result |
|---|---|
| 1. Gateway | Reused `_services/market-data-gateway/`. Owner attestation; upstream spacing 1 s with a 15 s queue, 2 in flight, 20/min per isolate + 40/min per location (binding), coalescing, caches 10 min / 12 h, refusals remembered 30 min, circuit breaker (429 → 15 min, 401/403 → 30 min, 3×5xx → 2 min, shared via Cache API), `Retry-After` exposed and in the error body, optional no-Origin clients (desktop). |
| 2. Source list | `assets/js/market-data/sources.js` + `sources-ui.js`; Python `market_data/sources.py` + `sources_tk.py`; parity-tested function by function. Yahoo Finance first by default; new keys join below it; removal keeps position; last usable source stays on; capability/coverage/availability-aware sequential fallback with per-source reasons; no retry loops; legacy routing migrated. Per-market `ROUTES` removed. |
| 3. Rebalancer web | List editor (drag, Move up/down, arrow keys, Home/End, live announcements), Yahoo Finance panel, *Remove international examples* removed (14 holdings unchanged), exports add *Sources tried first*, *Sources skipped*, *Source order*. |
| 4. Stock web | *Market data (your source list)* replaces Free/Live; history and snapshot follow the list; latest-price-only sources never asked for history; one frequency per run; mixed sources stated; provenance in CSV/JSON/XLSX. CSV and demo modes unchanged. |
| 5. Desktop | Rebalancer 1.4.0 and Stock 0.6.0 (candidates): `Sources…` editor, Yahoo Finance through the same gateway (`gateway.py`, no browser), list persisted per app, exports/logs carry provenance. ZIPs rebuilt. |
| 6. Copy | "Yahoo Finance — Free Market Data" panel on both pages and in the desktop editor; no licensing or infrastructure detail in user-facing text. |
| 7. Tests | See below. |
| 8. Deployment | **Pending the owner's Cloudflare login** (this container has no Cloudflare credential; see "Next action"). Wrangler 4.157.0 dry-run of `--env production` validates both rate-limit bindings; the Worker was run in local workerd with production settings for health/CORS/refusals only (no Yahoo request). |
| 9. Docs | Gateway README (activation, protection, deploy/verify/smoke/rollback), `PROVIDER_MATRIX.md` §10, `MARKET_DATA.md` §0, `BROWSER_DESKTOP_PARITY.md`, `INSTRUMENT_IDENTITY.md`, `_tools/README.md`, `RELEASE_NOTES.md`, root README, both desktop READMEs and guides, changelogs. |

Site setting `_data/market_data.yml` `gateway: ""` and desktop `DEFAULT_GATEWAY_URL = ""`
until the deployed Worker is verified (parity test keeps them equal).

## Verification (this container; every provider and Yahoo mocked)

| Check | Result |
|---|---|
| `node --test _tools/tests/unit/*.test.mjs` | 211/211 |
| `python -m pytest -q -m "not e2e"` in `_tools/tests` | 123 passed, 1 skipped (needs tkinter) — includes the new list parity tests and `test_desktop_gateway.py` (desktop package against the real Worker code) |
| Desktop tool tests (Python 3.12 + Xvfb) | Rebalancer 18, Stock 56, Monte Carlo 29 |
| Browser suites | pages 147, stock 74, rebalancer 132, montecarlo 40, cpi 112, freesource 132, sources 51 — no failures |
| `sync_shared_py.py --check`, `build_project_zips.py --check`, `render.py --check`, `cpi_public_workbook.py --check`, strict Jekyll build | pass |
| GitHub CI on `5f00608` | all 6 jobs passed (unit/packaging, site build + browser, 4 desktop) |

## Next action

1. **Owner (Cloudflare, on your own computer):** follow
   `_services/market-data-gateway/README.md` → "Deploy": `npx wrangler@4 login` (approve
   in your browser), then `npx wrangler@4 deploy --env production`, and send the printed
   `https://market-data-gateway.<subdomain>.workers.dev` address in the session.
2. **Claude, after that:** verify health/CORS/refusals/limits, run the capped live smoke
   (7 quotes + 1 history, ≥ 5 s apart, stop on any block), record results here, then set
   the address in `_data/market_data.yml` and `DEFAULT_GATEWAY_URL`, rebuild ZIPs, rerun
   the suites, push, and update the PR.
3. **Codex:** independent review of PR 46 (see the PR description).
