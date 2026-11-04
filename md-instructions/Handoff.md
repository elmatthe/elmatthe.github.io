# Handoff — Yahoo Finance gateway activation and ordered source list (2026-11-04)

Repository `elmatthe/elmatthe.github.io`, branch `claude/loving-brown-48hctl`, PR
<https://github.com/elmatthe/elmatthe.github.io/pull/46> (draft, **not merged**). Base:
`main` at `153c4c936c31e0cc5ff384d70628baaa068a5847`. No release or tag created; no paid
service activated; no Cloudflare DNS record, route, tunnel or custom domain created or
changed (the Worker uses its `workers.dev` address only).

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
| 2. Source list | `assets/js/market-data/sources.js` + `sources-ui.js`; Python `market_data/sources.py` + `sources_tk.py`; parity-tested function by function. Yahoo Finance first by default; new keys join below it; removal keeps position; last usable source stays on; capability/coverage/availability-aware sequential fallback with per-source reasons; no retry loops; legacy routing migrated. |
| 3. Rebalancer web | List editor (drag, Move up/down, arrow keys, Home/End, live announcements), Yahoo Finance panel, *Remove international examples* removed (14 holdings unchanged), exports add *Sources tried first*, *Sources skipped*, *Source order*. |
| 4. Stock web | *Market data (your source list)*; history and snapshot follow the list; latest-price-only sources never asked for history; one frequency per run; provenance in CSV/JSON/XLSX. CSV and demo modes unchanged. |
| 5. Desktop | Rebalancer 1.4.0 and Stock 0.6.0 (candidates): `Sources…` editor, Yahoo Finance through the same gateway (`gateway.py`, no browser), list persisted per app, exports/logs carry provenance. ZIPs rebuilt with the gateway address. |
| 6. Copy | "Yahoo Finance — Free Market Data" panel on both pages and in the desktop editor; no licensing or infrastructure detail in user-facing text. |
| 7. Tests | See "Verification". |
| 8. Deployment | **Deployed by the owner, 2026-11-04**: <https://market-data-gateway.elmatthe.workers.dev>, version `76998e2b-205d-4645-8f85-7a6fdf0dbad7`, Workers Free, both rate-limit bindings accepted. Verified live (below). `_data/market_data.yml` `gateway` and desktop `DEFAULT_GATEWAY_URL` now point at it (parity test keeps them equal). |
| 9. Docs | Gateway README ("Deployment status" with the live record), `PROVIDER_MATRIX.md` §10, `MARKET_DATA.md` §0/§0.1, `BROWSER_DESKTOP_PARITY.md`, `INSTRUMENT_IDENTITY.md`, `_tools/README.md`, `RELEASE_NOTES.md`, root README, desktop READMEs, guides and changelogs. |

## Live verification (2026-11-04, 02:23–02:30 UTC)

Full table and details: `_services/market-data-gateway/README.md` → "Deployment status".
Raw answers were kept in the session's scratch space only (not committed).

- **Health:** `status ok`, version 1.1.0, `keyless.enabled true`, `source yahoo-chart`,
  `activation owner_attestation`, `upstream.state ok`, limits 30/min per client, 20/min
  upstream per isolate, 1,000 ms spacing, cooldowns 900/1,800/120 s.
- **CORS and refusals (25 checks, none reaching Yahoo):** health `HEAD` 200; the site's
  preflight 204 with its origin and `Retry-After` exposed; refused as designed: methods,
  unknown path, `http://`, foreign and `null` origins, preflights (foreign origin, `POST`,
  `X-Api-Key`), missing/extra/repeated parameters (`apikey`, `shares`), URL-like and
  malformed symbols, `^GSPC`, `EURUSD=X`, `ABC.XX`, `range=10y`, `interval=1wk`. One
  observation: an empty `Origin:` header is handled like no `Origin` (desktop path), with
  no CORS headers.
- **Per-client limit:** over one connection, 30 requests answered, requests 31–40 → 429
  `rate_limited`, `Retry-After: 60`, `retryAfterSeconds: 60`, CORS headers present. It is
  per caller address (this container's rotating outbound addresses each had their own
  budget).
- **Capped smoke (7 quotes + 1 history, 6 s apart, no retries, no block):**
  AAPL 331.90 USD (NMS); VEQT.TO 60.78 CAD (TOR); YNVD.NE 42.30 CAD (NEO, Cboe Canada);
  7203.T 2,996.5 JPY (JPX, session open, ~15 min old); SAP.DE 206.65 EUR (GER);
  VOD.L 117.2 GBp → 1.172 GBP (LSE); 600519.SS 1,457.47 CNY (SHH, session open, ~15 min
  old). History VEQT.TO 1y daily: 252 rows 2025-11-03 → 2026-11-03, nothing missing,
  close and adjusted close kept apart (one distribution step on 2025-12-30). Every listing
  matched its expected exchange and currency; `src/venues.js` needed no change.
- **Not exercised live:** upstream spacing, budgets and the circuit breaker (would need
  many Yahoo requests); covered by tests against the same Worker code. Prices were not
  compared with a broker.

## Tests never reach the live gateway

- Browser suites route the configured gateway host to the in-process Worker (harness) or
  load pages with `?mdgateway=none`; `pages.test.js` (which mocks nothing else) now aborts
  gateway requests and allows exactly one `GET /v1/health` on the two market-data pages,
  and no price request on load. The opt-in `live.test.js` loads pages with
  `?mdgateway=none`.
- Stock desktop UI smoke test sets `MD_GATEWAY_URL=""` (the window checks the gateway at
  start-up; without this, the test would contact the live gateway — confirmed with a
  socket guard).
- All Python suites (`_tools/tests`, four desktop tools) were rerun under a socket guard
  that refuses any non-loopback connection: **0 blocked connections**.

## Verification (this container; every provider and Yahoo mocked)

| Check | Result |
|---|---|
| `node --test _tools/tests/unit/*.test.mjs` | 211/211 |
| `python -m pytest -q -m "not e2e"` in `_tools/tests` | 123 passed, 1 skipped (needs tkinter) |
| Desktop tool tests (Python 3.12 + Xvfb, socket guard) | Rebalancer 18, Stock 56, Monte Carlo 29, CPI 118 passed + 1 skipped (CI's Linux selection; 4 Windows-only bootstrap tests deselected, as in CI) |
| Browser suites (site rebuilt with the gateway address) | pages 151, stock 74, rebalancer 132, montecarlo 40, cpi 112, freesource 132, sources 51 — no failures |
| `sync_shared_py.py --check`, `build_project_zips.py --check`, `render.py --check`, `cpi_public_workbook.py --check`, strict Jekyll build | pass |
| GitHub CI | see PR 46 (all 6 jobs green on `eb2bb6b`; the final head is reported in the PR) |

Earlier CI fixes on this branch: stale ZIPs after a README edit (`a40cdec`); a timing race
in the CPI gateway's timeout test that also exists on `main` (`eb2bb6b`, test only,
assertions unchanged).

## Known limits

- Workers Free: 100,000 requests per day; each visit to the Rebalancer or Stock page makes
  one health request, and each uncached quote/history one more.
- The per-client limit counts per caller address; Yahoo's protection does not depend on it.
- `lastBarMayBeIncomplete` is cautious: true whenever the last date is "today" at the
  venue, even after the close.
- Desktop apps were tested on Linux with Xvfb, not on Windows or macOS hardware.

## Next action

1. **Codex:** independent review of PR 46 at its final head (see the PR description).
2. **Owner, after the review:** decide whether to merge PR 46. Until it is merged the live
   site keeps the previous version. Optional: compare two or three of the recorded prices
   with a broker; watch Workers & Pages → market-data-gateway → Metrics.
3. **Switch off, if ever needed:** delete `OWNER_ATTESTATION` in the Worker's settings (or
   `npx wrangler@4 rollback`); see the gateway README, "Roll back, disable or remove".
