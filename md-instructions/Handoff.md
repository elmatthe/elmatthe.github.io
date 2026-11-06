# Handoff - PR 46 R4 durable fail-closed persistence (2026-11-05)

Snapshot: Codex on HOME-PC, branch `claude/loving-brown-48hctl`, starting checkpoint
`2ccb62bf37f60cd8b5aa9e19debb352e24b86b8b`. **R4 READY FOR INDEPENDENT RE-REVIEW.**
This handoff accompanies the focused R4 implementation commit; resolve its SHA with Git.
Implementation-team verification is complete; independent acceptance is still required.

- Durable admission markers share the budget row before fetch. Every known outcome finalizes
  atomically; failed writes return unverified busy and cannot populate cache. Restarted/lost
  outcomes quarantine access until a fresh owner identifier explicitly resolves uncertainty.
  Live known outcomes may recover durably. Timeout, abort, expiry and unexpected processing
  exits cannot silently reclaim authorization. Existing stops and consumed IDs are preserved.
- Final verification: **312 unit tests** (coordinator 63, including 23 H1 cases), **37 real
  workerd/SQLite tests** including both dry-runs, and independent H1 before/after evidence.
  Original R3 admits unsafe HTTP200 after restart; R4 returns503 with no new upstream call.
  Python reference/parity: **134 pass, 6 deselected**, loopback-only guard proven.
- Private **Full / All PASS**, including final TMP/TEMP redirection into the repository:
  tracked browser 744, private browser flows, widgets 180 PASS + 1 existing Monte Carlo XFAIL,
  real input 10 PASS + 2 Excel cases deselected. Packaging, synchronization, workbook and strict
  site build checks pass; network ledger has no problems. Workerd was run separately.
- First Full FAIL retained under `files/r4/full-gate-first/`: mobile timing and date-sensitive
  stock assertion, obsolete timeout expectation, two widget ledger JSON-read errors. Mobile
  and widget cases passed unchanged on recheck. Owner authorized the precise stock assertion
  derived from intercepted synthetic prices; ticker exclusion is retained. Subsequent Full
  runs pass; private gate source and expected artifacts were not changed.
- Private report: `files/dev-work/pr46-verification-gate/reports/R4-IMPLEMENTATION-<SHA>.md`;
  evidence `files/r4/`. The report records publication and exact-SHA GitHub CI status.
  User-owned `.gitignore` remains byte-for-byte unchanged and must never be staged.
- M1 coordinator activation, M2 health protection, M3 production drain and Q1 response policy
  remain open. Separate CPI Excel preservation remains FAIL (canonical workbook unchanged).
  Existing Monte Carlo UX, accessibility, macOS/scaling and launcher gaps remain separate.
  Production 1.1.0 is untouched. No deployment, merge, activation, release or tag occurred.

Next action: fresh independent Codex review of the pushed R4 SHA, repeating the synthetic
SQLite stop-write failure, immediate object reset and persisted-runtime restart scenarios,
owner-ID rollback/replay and original B2/B3 tests. Check exact-SHA CI before acceptance.
Do not merge, mark the draft ready, deploy or activate retrieval under this checkpoint.

---

Historical R3 handoff follows; its readiness claims are superseded by the R3 H1 FAIL and R4
checkpoint above.

# Handoff — Yahoo Finance gateway activation and ordered source list (2026-11-04)

## Current state: B2 and B3 redone with one coordinator (R3); ready for independent re-review

Snapshot: 2026-11-04, Claude Code on HOME-PC (Windows 11), branch `claude/loving-brown-48hctl`, PR 46
(draft, not merged). **Next action: independent re-review of this branch.** Nothing was deployed.

A second independent review (Codex, of `de720dc`) returned FAIL: B1 and B4 passed, B2 and B3 failed.

| | What was wrong | Correction |
|---|---|---|
| B2 | `acquireSlot` admitted first and looked at the deadline after: a timer resuming at 20 s started a request despite the 15 s limit (HTTP 200) | The absolute deadline is checked on every wake, before admission. A late ticket is refused, never sent, and uses no budget |
| B3 | `startCooldown` compared only with its own isolate's memory, then overwrote the one shared Cache API entry: a 900 s refusal replaced a 3600 s one or a manual halt, and a new isolate contacted Yahoo at 901 s | One SQLite-backed Durable Object (`src/coordinator.js`) is now the only code that contacts Yahoo. Deadlines only move later; a halt dominates until a new `UPSTREAM_REACTIVATION_ID` |

Spacing, the in-flight limit, the budget (now any 60 s, not per minute) and coalescing moved into the
coordinator too, so they are worldwide and survive restarts. If its state cannot be verified, nothing
is sent; clients get the existing `busy` code. Why each choice: `Decisions.md`. Semantics, Workers Free
limits, what it cannot guarantee, deployment and rollback: `_services/market-data-gateway/README.md`.

**The gateway corrections take effect only when the owner deploys.** The code is 1.3.0; the live Worker
is still 1.1.0 and was not touched. **The first deployment creates a Durable Object class: `wrangler
rollback` cannot go back across it** (read "Deploy" and "Roll back" first). Workers Free compatibility
is from Cloudflare's documentation and `wrangler deploy --dry-run`; the live account has not accepted it.

### Verification (HOME-PC, Windows 11, Node 24, Python 3.13; Yahoo synthetic throughout)

The brief assumed Claude Code Cloud; this ran on HOME-PC. Linux results are in the PR's CI.

| Check | Result |
|---|---|
| `r3_reproduction.mjs` | **3 of 3 fail on `de720dc`, 3 of 3 pass now** |
| Mutation check (scratch, not in CI) | **50 of 50** deliberately broken safety properties caught by named tests |
| Randomized checker (scratch, from the independent reader) | 500 seeds x 300 steps, no invariant violated |
| `node --test _tools/tests/unit/*.test.mjs` | 289/289 |
| `gateway-runtime.test.cjs` in real workerd, including both `wrangler deploy --dry-run` | 21/21 |
| Python reference and parity tests, socket guard | 134 passed; 0 non-loopback connections |
| Desktop, CI's selection, socket guard | Rebalancer 18, Stock 57, Monte Carlo 29, CPI 117 + 2 skipped; 0 non-loopback connections |
| Browser, strict Jekyll build, resolver lock proven | pages 154, stock 74, rebalancer 132, montecarlo 40, cpi 112, freesource 143, sources 89; no failures |
| `sync_shared_py`, `build_project_zips`, `render`, `cpi_public_workbook` `--check` | all pass |

An independent read found no Critical defect and could not make the coordinator send a request it should
not. Its 5 Minor findings are fixed with regressions; its suggestions are documented, below.

Not run: the private Windows GUI gate (real mouse and keyboard; it does not replace, and is not replaced
by, any of the above). Not testable locally: Cloudflare's edge, a real client disconnect (exercised through
a service binding), output gates under slow storage, idle eviction, the live account.

### Open, for the owner

Decisions from this work:

- A redirect, 400 or 451 that names **no** wait starts no cooldown today (up to 20 a minute can reach Yahoo).
  Should it count toward the breaker? It would be a small change; left as is because it is a policy choice.
- Should the coordinator also refuse when the source is switched off? Today only the Worker checks, which
  matters only while two versions overlap. And a few seconds of per-isolate caching on `/v1/health` would
  stop anyone spending the coordinator's daily allowance through it.
- Deploying 1.3.0 is the owner's decision, as is merging.

Found by the independent review, outside this remediation and **not changed here**:

- CPI Web Scraper: the write through real Excel passed in Codex's run, but the canonical workbook-preservation
  regression failed. (An earlier local run failed with a raw COM error instead; the cause is not isolated.)
  The canonical workbook was not modified.
- Monte Carlo desktop: an unreadable output path (a folder, an exclusive lock) makes Run Simulation fail silently.
- Stock launcher: fails in a long folder path.
- Accessibility issues on both the base and this branch (axe-core: link-in-text-block, color-contrast).
- Incomplete coverage: Windows display scaling, macOS, bootstrap end to end.
- The project-wide private verification gate needs its own tracked migration.

---

The sections below describe the earlier state of this branch and remain accurate except where the table
above says otherwise.

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

1. **Codex:** independent re-review of PR 46 at its final head (see the PR description).
2. **Owner, after the review:** decide whether to merge PR 46, and separately whether to deploy
   gateway 1.3.0, after reading the gateway README's "Deploy" and "Roll back". Until it is merged
   the live site keeps the previous version. Optional: compare two or three of the recorded
   prices with a broker; watch Workers & Pages → market-data-gateway → Metrics.
3. **Switch off, if ever needed:** delete `OWNER_ATTESTATION` in the Worker's settings. After 1.3.0
   is deployed, `wrangler rollback` cannot return to an earlier version; see the gateway README,
   "Roll back, disable or remove".
