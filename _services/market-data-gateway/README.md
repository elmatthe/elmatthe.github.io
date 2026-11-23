# Market-data gateway (Cloudflare Worker, Workers Free plan)

One small Cloudflare Worker shared by the **Portfolio Rebalancer** and the **Stock
Comparison & Analytics** tools, on the website (<https://elmatthe.github.io>) and in
both desktop apps. It retrieves **Yahoo Finance** chart data, checks it, caches it
briefly, and returns it in one normalized JSON contract, so a visitor needs no API key.
In each tool Yahoo Finance is one entry in the user's ordered source list (position 1
by default), next to providers the user adds with their own keys
(`_tools/MARKET_DATA.md` §0). GitHub Pages still hosts the website; this Worker is a
separate service. It shares no code or settings with `../cpi-data-gateway/`.

## Deployment status

**Deployed and active since 2026-11-04.** The owner deployed `[env.production]` from their
own computer (`npx wrangler@4 deploy --env production`, Workers Free; both rate-limit
bindings accepted):

| | |
|---|---|
| Address | <https://market-data-gateway.elmatthe.workers.dev> (`workers.dev` subdomain; no custom domain, DNS record or route) |
| Version | `76998e2b-205d-4645-8f85-7a6fdf0dbad7` (gateway code 1.1.0). **The code in this folder is 1.3.0 and is not deployed**: the coordinator and the rules below marked 1.3.0 take effect only when the owner deploys it, which also creates a Durable Object class and cannot be undone by `wrangler rollback` (see "Deploy" and "Roll back") |
| Health | `keyless.enabled: true`, `source: yahoo-chart`, `activation: owner_attestation`, `upstream.state: ok`; caches 600 s (quotes) / 43,200 s (history) |

The website reads the address from `_data/market_data.yml`; the desktop apps from
`DEFAULT_GATEWAY_URL` in `_tools/shared_py/market_data/gateway.py` (kept equal by
`_tools/tests/test_market_data_parity.py`). Both were set to this address on 2026-11-04,
after the verification below. Empty means "not set up": the tools then say Yahoo Finance
is not available and send it nothing.

### Live verification, 2026-11-04 (02:23–02:30 UTC)

Run from a cloud test container (Cloudflare location IAD), with curl, one request at a
time. Full record: `md-instructions/Handoff.md`.

- **Refused before any Yahoo request, as designed:** health with a query string (400),
  POST to health or quote (405), an unknown path (404), plain `http://` (403
  `https_required`); a foreign `Origin`, `Origin: null` (403 `origin_not_allowed`, no CORS
  headers); preflights from a foreign origin, asking for `POST` or for an `X-Api-Key`
  header (403); missing, extra (`apikey`, `shares`) or repeated parameters (400
  `invalid_request`); a URL or `;` in the symbol (400 `invalid_symbol`); `^GSPC`,
  `EURUSD=X`, `ABC.XX` (400 `unsupported_listing`); history ranges `10y` or interval `1wk`
  (400 `invalid_range`).
- **CORS:** the site's preflight answers 204 with `Access-Control-Allow-Origin:
  https://elmatthe.github.io` (never `*`), `GET`, `Accept`, `Access-Control-Expose-Headers:
  Retry-After`; answers to requests without `Origin` (the desktop path) carry no CORS
  headers. An empty `Origin:` header was handled like no `Origin` (the desktop path); it
  gets no CORS headers either, and browsers never send one.
- **Per-client limit:** over one connection, requests 1–30 within a minute were answered
  normally and requests 31–40 got 429 `rate_limited` with `Retry-After: 60` and
  `retryAfterSeconds: 60` in the body (CORS headers present, so pages can read the wait).
  The limit is per caller address: 40 requests spread over this container's rotating
  outbound addresses were not limited, as each address has its own budget. Upstream
  protection does not depend on callers (it is per isolate and per location).
- **Capped smoke** (7 quotes + 1 history, 6 s apart, no retries): all HTTP 200, no
  `Retry-After`, `upstream.state` still `ok` afterwards.

| Request | Listing (Yahoo code, name) | Price | Currency | Trading date · source time (UTC) |
|---|---|---|---|---|
| AAPL (no `Origin`) | US · NMS · NasdaqGS · equity | 331.90 | USD | 2026-11-03 · 21:00:01 |
| VEQT.TO | XTSE · TOR · Toronto · ETF | 60.78 | CAD | 2026-11-03 · 20:59:58 |
| YNVD.NE | NEOE · NEO · Cboe CA · ETF | 42.30 | CAD | 2026-11-03 · 20:59:54 |
| 7203.T | XTKS · JPX · Tokyo · equity | 2,996.5 | JPY | 2026-11-04 · 02:10:06 (session open) |
| SAP.DE | XETR · GER · XETRA · equity | 206.65 | EUR | 2026-11-03 · 16:40:00 |
| VOD.L | XLON · LSE · LSE · equity | 1.172 (Yahoo: 117.2 GBp, scale 0.01) | GBP | 2026-11-03 · 16:56:16 |
| 600519.SS | XSHG · SHH · Shanghai · equity | 1,457.47 | CNY | 2026-11-04 · 02:10:24 (session open) |

  Every quote: `priceBasis: regular_market_price`, `adjusted: false`, `realTime: false`,
  nothing missing, cache `miss` (first request). Markets closed at retrieval returned their
  last regular-session price; Tokyo and Shanghai were trading and their prices were about
  15 minutes old. No exchange code in `src/venues.js` needed correcting.
  **History** `VEQT.TO`, `1y`, `1d` (no `Origin`): 252 daily rows, 2025-11-03 to
  2026-11-03, no missing values or duplicate dates; close and adjusted close both present
  and kept apart (adjusted ÷ close = 0.98611 up to 2025-12-29, 1 from 2025-12-30: one
  distribution); `lastBarMayBeIncomplete: true` because the last date was still "today" in
  Toronto when retrieved (after the close; the flag is deliberately cautious). Values pass
  through unrounded as Yahoo sends them (for example a previous close of
  338.32000732421875). The prices were not compared with a broker.
- **Not exercised live** (it would take many Yahoo requests): upstream spacing, the
  upstream budgets and the circuit breaker. They are covered by `market-gateway.test.mjs`,
  `upstream-coordinator.test.mjs`, `gateway-runtime.test.cjs`, `test_desktop_gateway.py` and
  `freesource.test.js` against this same Worker code.

## Activation (fail closed)

The data source is used only when **both** settings are present, exactly:

| Setting | Value | Meaning |
|---|---|---|
| `KEYLESS_SOURCE` | `yahoo-chart` | which upstream adapter to use (the only one implemented) |
| `OWNER_ATTESTATION` | `owner-confirms-yahoo-permission` | the site owner confirms that their own written permission from Yahoo covers automated retrieval through this Worker, temporary caching and display to visitors, including exchange data Yahoo distributes |

The attestation is a plain, non-sensitive flag. No document, reference, correspondence
or secret is stored in the Worker, the repository or its answers, and none is needed.
With either value missing or different, `/v1/health` reports `"enabled": false` with the
reason, every data request answers `source_disabled`, and nothing is sent to Yahoo.

`wrangler.toml` has two configurations:

- the **top-level settings** (what `npx wrangler@4 deploy` uses): both values empty, so a
  fresh or forked deployment is always switched off;
- **`[env.production]`** (what `npx wrangler@4 deploy --env production` uses): the owner's
  approved deployment, with both values set, `ALLOWED_ORIGINS =
  "https://elmatthe.github.io"` and `ALLOW_NO_ORIGIN = "true"` (the desktop apps send no
  `Origin`). Wrangler does not inherit `vars` or rate-limit bindings into an environment,
  so they are repeated there; `name` is the same, so both deploy the one Worker.

The previous `SOURCE_AUTHORIZATION` setting is no longer read (it would not switch
anything on).

## Protecting the data source (slow is better than blocked)

Every limit fails closed: when in doubt, nothing is sent to Yahoo.

**Since 1.3.0 one coordinator decides everything, worldwide, and is the only code that
contacts Yahoo:** a SQLite-backed Durable Object (`src/coordinator.js`, class
`UpstreamCoordinator`, one object addressed as `yahoo-chart`). The Worker's isolates have no
upstream code at all; they ask the coordinator and normalize what it returns.

| Layer | Rule |
|---|---|
| Spacing | at least **1 s** between the actual starts of two upstream requests, worldwide, first come first served, as decided at the coordinator. A request waits at most **15 s**; a request whose turn comes later than that, including one whose timer resumed late, is refused and never sent (`throttled`, `Retry-After`) and uses no budget |
| Concurrency | at most **2** upstream requests in flight, worldwide (others wait in the same queue). A place held by a request that never finishes is **not** reclaimed: at its 8-second timeout its outcome becomes unresolved, its durable marker stays, and no upstream request starts until the owner reconciles and approves that incident (see "Incidents and the owner's approval" below) |
| Budget | at most **20** actual starts in **any** 60 seconds, worldwide. A request counts when it starts: one refused or cancelled while waiting does not count, and one cancelled after it started does |
| Coalescing | identical concurrent requests, from any isolate, share **one** upstream request and report one retrieval time |
| Cancellation | a client that disconnects stops waiting at once and the coordinator is told; work nobody is waiting for leaves the queue or is aborted, and is not held against Yahoo. Shared work continues while any client remains. Needs the `enable_request_signal` compatibility flag (in `wrangler.toml`) |
| Caching | quotes reused **10 min**, history **12 h** (per symbol and range); definitive refusals (unknown symbol, other listing or currency) remembered **30 min**. For speed only: **no safety decision depends on a cache** |
| Circuit breaker | after Yahoo answers **429**, no upstream request for **15 min**; after **401/403**, **30 min**; after **3** 5xx/timeouts/network errors with no successful answer in between, **2 min** (a timeout, a network error before any HTTP status, or an HTTP 200 whose body does not finish also leaves its outcome unresolved; see below). Cached answers are still served. Reported in `/v1/health` (`upstream.state: "cooling_down"`) |
| Yahoo's own wait | a valid `Retry-After` (delta seconds or an HTTP date) on **any** answer other than a success is honoured when it is longer than the minimum above, as an absolute deadline; the `Retry-After` sent to clients is the time really left. Malformed, negative, past or shorter values never shorten the minimum. A **single** 5xx, redirect or other refusal that names a wait is honoured for that wait |
| Other refusals | a redirect, a 400 or a 451 that names **no** wait is reported and starts no cooldown; the next request can go out within the spacing and budget, up to 20 a minute. It does not end a run of failures either |
| A deadline never gets shorter | whichever refusal is recorded first, the later deadline stands; a success does not end a stop |
| Longer than 24 h | a wait above `MAX_COOLDOWN_SECONDS` (**24 h**) halts Yahoo requests until the owner approves that incident ("Incidents and the owner's approval" below), however much time passes; it is never turned into an early retry, and an ordinary cooldown cannot overwrite it. `/v1/health` shows `upstream.state: "halted"`, refusals carry `manualReactivationRequired: true` and `Retry-After: 86400` |
| Fail closed | a coordinator that is missing, failing or silent, state that cannot be read or is not well formed, or a write that fails means **no upstream request**: clients get `busy` (503, `Retry-After: 60`), `/v1/health` shows `status: "degraded"` and `upstream.state: "unverified"` with a `reason`. A failed call is never repeated, because it may already have started the request |
| Per client | **30** requests per minute and **2** in flight per client (hashed IP) per isolate, plus the `RATE_LIMITER` binding (30/min per location). This protects the Worker from one client; Yahoo's protection does not depend on it |
| No retries | the gateway never retries Yahoo; the pages and desktop apps retry only a network error reaching the gateway, once |

The clients add their own restraint (`assets/js/market-data/keyless.js`,
`_tools/shared_py/market_data/gateway.py`): one request at a time, at least 0.35 s apart
(across all tabs of the site in a browser), copies reused (10 min quotes, 12 h history),
and after any "slow down" answer — or an outage while the breaker is open — **nothing
more is sent until `Retry-After` has passed**, a pause remembered across page loads and
program restarts. The next source in the user's list is used meanwhile. Clients keep a
pause of at most 24 hours; a longer wait is cut to that, never ignored, and the gateway
stays halted either way.

**Why this cannot race.** One object handles all of it, one piece of JavaScript at a time.
State is read, changed and written with no `await` in between, so two refusals cannot lose
each other's update, and the deadline is the maximum of the two in either order. A request is
admitted and started in one uninterrupted step: every check, the write of the start, and the
`fetch()` call happen together, so no stop can be recorded between the decision and the
start. The coordinator makes the request itself because a permission granted to a Worker could
be used late. The runtime also holds an outgoing `fetch()` until earlier writes are confirmed,
and discards it if a write fails (Cloudflare, [output-gate documentation](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).

**Durable outcome lifecycle (R4).** Each admission appends a unique unresolved marker
(`id`, `startedAt`) to the same SQLite state row as its rolling-budget start. This single
statement is atomic and precedes `fetch()` without an intervening `await`; output gates
remain enabled. At most two markers exist. Every observed outcome writes the row again,
removing only its own marker together with the resulting failure counter, cooldown and halt.
This includes HTTP 200 when the counter is already zero, 404, redirects and other refusals
that cause no protective-state change. No response is trusted or cached before finalization.

If finalization throws, the current caller gets HTTP 503 `busy`, `Retry-After: 60`, and health
is `degraded` / `upstream.state: "unverified"`. Public responses and logs contain no SQL error
details. The live instance keeps the observed outcome in memory and retries its merged state
write on subsequent use; only a successful durable write permits further admission. A second
completion includes the first completion's protective state and preserves every other marker.
There is no polling or upstream retry for recovery.

On object initialization, every persisted marker represents a lost outcome and quarantines
upstream access. Successful writes, health checks, elapsed budgets, expired deadlines and
leases, eviction and full runtime restart cannot remove it. The current instance distinguishes
its own active markers from inherited ones, so two healthy requests can still run concurrently.
An admitted cancellation, timeout or unknown abort retains its marker; queued cancellation
continues to use no budget. Receiving an HTTP status does **not** by itself finalize an
outcome; only a complete answer does:

- A network error before any status (a connection lost before headers, which can hide a
  429) retains its marker: the caller gets `busy`, the breaker counter still counts it, and
  the source stays quarantined until the owner acts, at the same availability cost as a timeout.
- An HTTP **200** whose body does not finish, whether interrupted, timed out or cancelled,
  also retains its marker (owner decision, R6): the status alone does not establish that the
  upstream work completed. The caller gets `busy` (`cancelled` callers have already gone);
  an interruption or timeout counts toward the breaker, a cancellation does not.
- A **refusal** status (429, 401/403, 5xx, a redirect, 404 and other refusals) is the outcome
  itself: its stop and any `Retry-After` are committed when the status arrives, before the
  body is read or cancelled, so a lost refusal body changes nothing.
- An HTTP 200 body larger than 2 MiB is a complete answer the gateway refuses by its own
  limit: reading stops, the outcome finalizes, and the client gets `upstream_invalid`. The
  rest of the body is cancelled without waiting: a cancellation that never settles, rejects
  or throws cannot delay the answer or quarantine the source (R7). This does not prove the
  source finished sending; the 2 MiB already read is the complete answer the policy needs.

**Operational consequence.** A genuinely incomplete response (a connection that drops
mid-body, a body slower than the timeout) quarantines all uncached retrieval until the owner
reconciles it and approves exactly that incident (`UPSTREAM_INCIDENT_APPROVAL`, below).
Cached answers are still served. This is deliberate: availability is never bought by
assuming an unfinished upstream request has ended. A subsequently observed complete response
may finalize its actual outcome, including a late refusal; cancellation cannot recall provider
work already sent.

Migration adds `unresolved` to the existing row without renaming the class or namespace or
changing earlier history. Existing R3 starts cannot establish completed outcomes: a
nonempty legacy start list migrates to one conservative unresolved marker and requires owner
review. Empty/new state migrates cleanly. Malformed JSON, duplicate markers, more than two
markers or markers inconsistent with recorded starts fail closed; an approval cannot repair
malformed state. History without its state row is also rejected as inconsistent.
Never downgrade to R3 code that ignores unresolved markers.

### Incidents and the owner's approval (M4)

An **incident** is a halt (a wait above 24 h) or an unresolved outcome. It is never an
ordinary cooldown, which ends by itself. The coordinator gives each incident an identity,
stored with it in the same SQLite write that records the halt or the unknown outcome:

- a **generation** (1, 2, 3, …; never reused) and a **nonce** (128 random bits), and
- its **scope**: the halt, and the unresolved requests it covers.

Any change of scope (another unknown outcome, a halt, a further halt-level direction from
Yahoo, a restart that finds requests in flight, or a row written by other code) gives the
incident a **new generation and nonce** in the same write. If other code (an older version after
a rollback, a manual edit) removed the halt or an unresolved request of an open incident, that
is not a recovery: the source stays halted under the new incident. Clearing it needs the approval of
that exact incident:

```
UPSTREAM_INCIDENT_APPROVAL = g<generation>-<nonce>     for example g3-mfrggzdfmztwq2lknnwg23tpob
```

The coordinator evaluates this secret **only when it starts** (a deployment, including a
secret change, restarts it), once per start: never on a request, a health check or a status read,
not even when a failed start is retried by one. It accepts
the value only if all of these hold, and otherwise records why not (`approval_result`):

| Check | Refused as |
|---|---|
| `g<number>-<26 characters a–z 2–7>` exactly | `malformed` |
| this generation was not approved before | `consumed` |
| an incident is open | `no_incident` |
| it names the current generation | `stale_generation` / `unknown_generation` |
| it carries that generation's nonce | `mismatch` |
| **the source is switched off** in this deployment (`KEYLESS_SOURCE` or `OWNER_ATTESTATION` not set) | `source_on` |
| the newest request of the incident started at least 60 s ago (an old instance's request may still finish) | `work_may_be_running` |

An accepted approval, its record (`incident_approvals`) and the clearing of the halt and of
the incident's unresolved requests are **one transaction**: if it fails, nothing changes and
the same approval applies at the next start. Cooldowns are never shortened: an ordinary
cooldown, including the 15-minute minimum recorded with a halt, still runs to its deadline.
A value written before an incident cannot contain its nonce, so it can never clear it; a value
left in place after use does nothing (`consumed`); a later incident has a new generation.
The approval is logged as `incident_resolved` only once SQLite has committed it. The value
itself is never logged.

`UPSTREAM_REACTIVATION_ID`, the mechanism before M4, is **no longer read**: a value left in
place does nothing. Delete it from the deployed Worker before or with the first deployment of
this version (Settings → Variables and Secrets, or `npx wrangler@4 secret delete` /
remove the variable): an older version would still honour it after a rollback.

#### Owner recovery procedure (Data Studio, read-only)

The owner reads the coordinator's state in the Cloudflare dashboard, without any public
endpoint: **Workers & Pages → Durable Objects → the `UpstreamCoordinator` namespace → Data
Studio**, object name **`yahoo-chart`**. Data Studio can also write: run **only the `SELECT`
statements below**. A manual change to the state row is detected and gives the incident a new
generation, but do not rely on that. Every query starts the object first, so it also shows the
result of any approval the current deployment carries.

1. **Switch the source off** (dashboard: delete or empty `OWNER_ATTESTATION` and save; or
   `npx wrangler@4 deploy` with the top-level settings). Data requests now answer
   `source_disabled`; nothing reaches Yahoo.
2. **Read the incident:**

   ```sql
   SELECT 'g' || incident_generation || '-' || incident_nonce AS approval,
          halt_code, cooldown_until, cooldown_code, unresolved, incident_scope,
          incident_opened_at, approval_result
   FROM coordinator_state WHERE id = 1;
   ```

   `approval` is empty when there is no open incident. `unresolved` lists each unknown request
   with its start time (ms since 1970, UTC); `incident_scope` is what the approval covers.
3. **Investigate and reconcile** Yahoo's directions and your permission. Automatic
   reconciliation is not proved safe: a provider request may still have run after the
   coordinator stopped. Honour every known provider wait or permission requirement; if that
   cannot be established, leave the source off. Do not delete state or tables, edit rows, or
   treat storage recovery as reconciliation.
4. **Approve that incident only**, with the source still off:

   ```bash
   npx wrangler@4 secret put UPSTREAM_INCIDENT_APPROVAL --env production
   ```

   and paste the `approval` value. (`secret put` deploys a new version; keep the source off in
   that deployment. Never put the value in `wrangler.toml`.)
5. **Verify** with the query of step 2. Expected: `approval` empty, `halt_code` empty,
   `unresolved` `[]`. Otherwise `approval_result` says why (`work_may_be_running`: run the
   query again after a minute and redeploy the secret if needed; `stale_generation` or
   `mismatch`: the incident changed, start again at step 2). History of approvals:

   ```sql
   SELECT generation, approved_at, scope FROM incident_approvals ORDER BY generation;
   ```

6. **Switch the source on** again (restore `OWNER_ATTESTATION`). The approval may stay in place
   (it is now `consumed`) or be removed (`npx wrangler@4 secret delete UPSTREAM_INCIDENT_APPROVAL`).

**What this cannot guarantee.**

- A request that has already started cannot be recalled: at most 2 can be in flight when a
  stop is recorded. Their answers can only lengthen the stop. A request admitted a moment
  before a stop can also reach the network just after it, while its write is being confirmed
  (milliseconds).
- Persisted unresolved markers prevent fresh upstream requests after a reset. They do not
  prove that older remote work has stopped; explicit owner recovery must account for that.
  A known outcome held only in the terminated process is lost, so the replacement stays
  quarantined even after storage writes recover.
- Spacing is measured at the coordinator's decision; on the wire two starts can be a few
  milliseconds closer. Deadlines rely on Cloudflare's clock.
- While a deployment of 1.3.0 replaces 1.1.0, old isolates still contact Yahoo by their own rules
  until they finish. The guarantees above hold once the old version has gone.
- The activation settings are checked by the Worker, not the coordinator. For as long as two
  versions overlap after the source is switched off, an isolate on the old settings can still reach
  the coordinator, within all its limits.
- A lost cancellation message costs at most one request for nobody, within all the limits.
- Identical requests at different times each use budget if the cache misses; on a `workers.dev`
  address the Cache API may be per isolate.
- A state row that is not well formed stops the source until it is repaired, by design: there is
  no automatic repair. Repair requires a separately reviewed owner procedure preserving all stops and consumed IDs; deleting state is not a recovery mechanism.

Expected volume: the Rebalancer's 14-holding sample costs at most 14 requests (about 14 s
with the 1 s spacing when nothing is cached); a Stock comparison one per ticker. The free
daily allowance of 100,000 Worker requests is far above that.

Honest identity: the coordinator sends `User-Agent: market-data-gateway/1.3.0
(+https://elmatthe.github.io/projects/portfolio-rebalancer/)`. It never imitates a
browser, obtains cookies or "crumbs", rotates addresses or otherwise works around a
refusal. If Yahoo refuses with a 429, 401 or 403, or names a wait, the gateway reports it and stops
(circuit breaker).

## Contract

All endpoints are `GET` (plus CORS preflight). Every answer is JSON with
`Cache-Control: no-store`; prices are in **major units** of the stated currency, with
Yahoo's raw value and unit alongside.

| Request | Answer |
|---|---|
| `GET /v1/health` | `md-gateway.health.v1`: `status` (`ok`, or `degraded` when the upstream state could not be verified), `version`, `keyless {enabled, source, reason, activation, provider, attribution, official:false}`, `upstream {state, code, retryAfterSeconds, manualReactivationRequired?, reason?}` (`state` is `ok`, `cooling_down`, `halted` or `unverified`), `venues`, `history {ranges, intervals}`, `cacheTtlSeconds`, `limits`. No secrets; the attestation value is never echoed. |
| `GET /v1/quote?symbol=VEQT.TO` | `md-gateway.quote.v1`: `source`, `listing {symbol, mic, venueName, exchangeCode, exchangeName, instrumentType, name, timeZone}`, `currency`, `rawCurrency`, `quoteUnit`, `unitScale`, `price`, `rawPrice`, `priceBasis: "regular_market_price"`, `adjusted:false`, `tradingDate` (venue time zone), `sourceTime`, `delay {realTime:false, note}`, `dayHigh`, `dayLow`, `volume`, `previousClose` (each `null` when absent, listed in `missing`), `retrievedAt`, `cache {status, ageSeconds, ttlSeconds}` |
| `GET /v1/history?symbol=SAP.DE&range=1y&interval=1d` | `md-gateway.history.v1`: same identity fields, `range`, `interval`, `frequency:"daily"`, `adjustment {close, adjClose, adjCloseAvailable}`, `observations: [[date, close, adjClose], …]` (ascending, one per trading date, `null` where Yahoo gave none), `count`, `firstDate`, `lastDate`, `lastBarMayBeIncomplete`, `missing {…}`, `retrievedAt`, `cache` |
| `OPTIONS` on the data paths | 204 for an allowed origin asking for `GET` (exposes `Retry-After`); 403 otherwise |
| any refusal | `md-gateway.error.v1`: `{error: {code, message, retryable, definitive, retryAfterSeconds?, manualReactivationRequired?}}` with a fixed message; `Retry-After` header when retryable. A client that disconnected gets `cancelled` (499) |

Error codes: `invalid_request`, `invalid_symbol`, `unsupported_listing`, `invalid_range`,
`origin_not_allowed`, `https_required`, `not_found`, `method_not_allowed`,
`source_disabled`, `rate_limited` (this client), `throttled` (the shared budget or queue),
`busy` (also: the coordinator could not be used), `symbol_not_found`, `no_price`, `no_history`, `listing_mismatch`,
`currency_mismatch`, `currency_unknown`, `unsupported_instrument`,
`upstream_rate_limited`, `upstream_blocked`, `upstream_unavailable`, `upstream_timeout`,
`upstream_invalid`, `upstream_rejected`.

Price semantics. History `close` is Yahoo's close, adjusted for splits but not for
dividends (price return); `adjClose` is Yahoo's adjusted close, also adjusted for
dividends and capital-gain distributions (total return). They are never substituted for
each other; when `adjClose` is absent the tools say so and use closes, labelled as such.
The quote is the latest regular-session price, possibly delayed; never labelled
real-time. London listings quoted in pence (`GBp`) are converted to pounds (`unitScale`
0.01) and both values are returned.

## Validation (fail closed)

Request: HTTPS; URL at most 256 characters; exactly the listed query parameters, each
once (anything else — `shares`, `target`, `account`, `apikey`, `token` — is
`invalid_request`); symbol: upper-case letters and digits with optional hyphens, at most
20 characters, and an exchange suffix from the fixed list in `src/venues.js` (US with no
suffix, `.TO`, `.V`, `.NE`, `.L`, `.DE`, `.PA`, `.AS`, `.SW`, `.T`, `.SS`, `.SZ`, `.HK`,
`.AX`). Indexes (`^`), currency pairs and futures (`=`), other exchanges and free text are
refused before any upstream request. History: `range` one of `1mo 3mo 6mo 1y 2y 5y`,
`interval` `1d`.

Upstream answer: HTTP 200 JSON of at most 2 MB, one `chart.result`, `meta.symbol` equal
to the requested symbol, `meta.instrumentType` EQUITY, ETF or MUTUALFUND,
`meta.exchangeName` one of the venue's exchange codes, `meta.currency` one of the venue's
currencies, a finite positive price, a plausible price time; history timestamps strictly
ascending, at most 2,000, equal-length arrays, every value `null` or finite positive.
Anything else — another symbol, another exchange (an OTC line for a US symbol), another
currency, a redirect, a non-JSON page — is refused, never repaired or replaced by
another listing; dates are never filled in. YNVD.NE is asked for on Cboe Canada (`NEO`);
Questrade's `YNVD.TO` resolves to the same listing in the tools and is never sent as a
Toronto symbol.

The exchange codes (`NMS`, `NYQ`, `PCX`, `TOR`, `VAN`, `NEO`, `LSE`, `GER`, `JPX`, `SHH`, …)
are confirmed by the live smoke test below (results in the Handoff). A wrong code only
causes a refusal (`listing_mismatch`).

## Security and privacy

- No credentials, keys or secrets exist in this Worker, its requests or its answers. The
  tools never send a provider key to the gateway (tested in `keyless.test.mjs`,
  `sources.test.js`, `test_desktop_gateway.py`).
- Fixed upstream origin and path, built by the coordinator, which takes a symbol and range and
  never a URL; the only client input copied into the upstream URL is an allowlisted symbol and
  range; no client header is forwarded; redirects are never
  followed; 8-second upstream timeout.
- The contract has no field for holdings, quantities, targets or accounts, and the tools
  send none: only a symbol (and a range for history).
- CORS: `ALLOWED_ORIGINS`; a browser request from another origin is refused. Requests
  with **no** `Origin` (the desktop apps) are accepted only when `ALLOW_NO_ORIGIN =
  "true"`; on the deployed Worker an empty `Origin:` header is handled the same way and
  gets no CORS headers. CORS is not authentication; abuse is bounded by the allowlists,
  the limits above (the per-client limit counts per caller address), the cache and
  Cloudflare's free daily cap.
- The coordinator cannot be reached from the internet: only this Worker's binding can call it.
- Logs: event name, code, venue, upstream status, cooldown length. Never an IP address,
  URL or header. Workers Logs are disabled (`[observability] enabled = false`).
  `cooldown_started` (and `incident_opened` / `incident_rotated` / `incident_resolved`, which carry the generation, never the nonce) is logged only once SQLite has **committed**
  the write, as confirmed by `storage.sync()`: a statement that returns is not yet a commit,
  and a commit can still fail (R7). Nothing waits for that confirmation, so admission and
  answers are unchanged; each stop is logged once, in the order it was recorded. When the
  statement itself fails, the log says `coordinator_write_failed` and `cooldown_not_persisted`
  (the stop holds in memory, and nothing is sent, but it is not on disk); `cooldown_started`
  follows when a later write is committed. When the commit fails, the runtime resets the
  object: the stop is never logged as started, the caller gets `busy`, and the admission
  marker still on disk quarantines the source until the owner approves the incident. In real workerd
  the reset comes before anything else is logged, so such a failure shows only as `busy` and
  an `unverified` health; an instance that does see its commit refused logs
  `coordinator_write_failed` with `stage: "commit"` and refuses everything until it is
  replaced. A missing `cooldown_started` therefore never means "no stop": health is the
  authority on the current state.
- Headers: `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, HSTS.

## Workers Free plan (checked 2026-11-04)

From <https://developers.cloudflare.com/workers/platform/limits/> (updated 2026-10-29):
100,000 requests per day, reset at 00:00 UTC (above it Cloudflare answers error 1027; the
Free plan does not bill), 10 ms CPU per request, 128 MB memory, 50 subrequests and 6
simultaneous outgoing connections per request, Cache API objects up to 512 MB and 50
cache operations per request. The Rate Limiting binding
(<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>, updated
2026-10-21) needs Wrangler 4.36.0 or later, takes a period of 10 or 60 s, is approximate
and per location; its page does not state plan availability. Wrangler 4.157.0 (current
on 2026-11-04) validates this configuration (`deploy --dry-run --env production` lists
the bindings). Each health or uncached data request makes one coordinator call, one more if the
client disconnects, plus at most a few Cache API operations. No KV, D1, R2, Queues or paid feature is used. **Do not upgrade the
account for this.**

The Cache API is functional on a custom domain; on a `workers.dev` address Cloudflare does
not document it, so the shared answer cache may be per isolate only there. No safety decision
depends on it.

**The coordinator on Workers Free** (<https://developers.cloudflare.com/durable-objects/platform/pricing/>,
updated 2026-10-18; <https://developers.cloudflare.com/durable-objects/platform/limits/>, updated
2026-10-29; checked 2026-11-04). Workers Free can create and use SQLite-backed Durable Objects
only; that is the kind used here. **This is from Cloudflare's documentation and
`wrangler deploy --dry-run`. It has not been accepted by the live account yet.**

| Free daily allowance | The most this gateway can use | Why |
|---|---|---|
| 100,000 requests | one for each health request and each uncached data request; two if the client disconnects | None for cached answers or preflights. Health has no per-client limit, so anyone can spend this allowance, as with the Worker's own 100,000; when it is gone the source fails closed until 00:00 UTC and no request reaches Yahoo |
| 13,000 GB-s of duration | 10,800 GB-s | One object at 128 MB cannot be active more than 86,400 s a day |
| 100,000 rows written | approximately 57,600 nominal/day | 20 starts/minute times 1,440 minutes times two row writes: admission and mandatory outcome finalization. Markers add no rows or normal-path writes. Migration, recovery retries, owner-ID transactions and other account users are additional |
| 5,000,000 rows read | a few per wake-up | State is read once per instance and then kept in memory |
| 5 GB stored | one small state payload with at most two unresolved markers, plus one row per approved incident (and any pre-M4 reactivation history) | Actual SQLite allocation exceeds payload size; consumed owner history is retained |

Above an allowance, "further operations of that type will fail with an error", and nothing is
billed on Workers Free. Each of those failures fails closed here: a call that fails, or a write
that fails, means no upstream request, and clients get `busy` while state cannot be durably verified. Quarantine after a lost outcome needs explicit owner recovery even after the allowance resets. The object itself
has a soft limit of about 1,000 requests per second and answers "overloaded" above it, also
failing closed.

## Deploy (owner, on the owner's own computer)

Needs a free Cloudflare account, Node.js 22 or later (Wrangler 4.157.0 requires it) and a clone of this repository on
the `claude/loving-brown-48hctl` branch (or `main` after merge). No payment method is
needed for Workers Free.

```bash
cd _services/market-data-gateway
```

```bash
npx wrangler@4 login
```

`login` opens Cloudflare in your browser; approve it there (no password or token is
typed into a terminal or chat).

**Before the first deployment of 1.3.0:**

1. Read `/v1/health` on the live Worker. If `upstream.state` is not `ok`, wait until it is: the
   old version's stops live in its isolates and are not carried over.
2. Read "Roll back" below. After this deployment `wrangler rollback` cannot return to any version
   from before it.
3. Delete any `UPSTREAM_REACTIVATION_ID` variable from the live Worker (Settings → Variables and
   Secrets). This version ignores it (M4), but an older version would honour it after a rollback.

```bash
npx wrangler@4 deploy --env production
```

Wrangler 4.157.0 validated this configuration. The first deployment creates the class from
`[exports.UpstreamCoordinator]` in `wrangler.toml`: there is no migration tag, no data to move and
nothing to set up. Use `deploy`, not `versions upload` or a gradual rollout, which Cloudflare does
not support with `exports`.

If Cloudflare refuses the class on your plan, the deployment fails as a whole and the live Worker
keeps running unchanged. **Do not upgrade the account**; report it. After deploying, `/v1/health`
must show `version` 1.3.0, `status: "ok"`, `upstream.state: "ok"`. Anything else, especially
`unverified`: switch the source off (below) and report it.

Wrangler prints the address, `https://market-data-gateway.<your-subdomain>.workers.dev`.
If it says the `ratelimits` binding is unavailable on your plan, delete the two
`[[ratelimits]]` / `[[env.production.ratelimits]]` blocks and deploy again (the in-memory
limit still applies). If namespace id 21011 is already used in your account, choose another
integer.

Then verify (next section), run the capped live smoke test, and only then put the address
in `_data/market_data.yml` (`gateway: "https://…workers.dev"`, https, no trailing slash)
and in `DEFAULT_GATEWAY_URL` of `_tools/shared_py/market_data/gateway.py`, run
`python _tools/sync_shared_py.py` and `python _tools/build_project_zips.py`, commit,
review and merge.

## Verify

```bash
GATEWAY=https://market-data-gateway.<your-subdomain>.workers.dev
```

```bash
curl -sS "$GATEWAY/v1/health"
```

```bash
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: https://elmatthe.github.io" -H "Access-Control-Request-Method: GET" "$GATEWAY/v1/quote"
```

```bash
curl -sS -H "Origin: https://evil.example" "$GATEWAY/v1/quote?symbol=AAPL"
```

```bash
curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/quote?symbol=AAPL&shares=305"
```

```bash
curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/quote?symbol=%5EGSPC"
```

Expected: health `"enabled": true`, `"activation": "owner_attestation"`, `"upstream":
{"state": "ok", …}`; preflight `204` with `Access-Control-Allow-Origin:
https://elmatthe.github.io`; the foreign origin `origin_not_allowed`; the extra parameter
`invalid_request`; the index `unsupported_listing`. None of these reaches Yahoo.

**Live smoke test (capped).** At most seven quote requests and one history request, one
per listing, spaced at least five seconds apart, from a normal connection, no retries,
no browser-imitating headers. Stop at the first `upstream_rate_limited` or
`upstream_blocked` answer; do not work around it.

```bash
for s in AAPL VEQT.TO YNVD.NE 7203.T SAP.DE VOD.L 600519.SS; do curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/quote?symbol=$s"; echo; sleep 5; done
```

```bash
curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/history?symbol=VEQT.TO&range=1mo&interval=1d"
```

Record for each: HTTP status, `listing.exchangeCode`, `currency`/`rawCurrency`,
`unitScale`, `price`, `tradingDate`, `sourceTime`. Compare two or three prices with a
broker. A `listing_mismatch` for a correct listing means the exchange code in
`src/venues.js` needs correcting from the recorded answer.

## Roll back, disable or remove

- **Switch the data source off (fastest, keeps the Worker):** in the dashboard (Workers &
  Pages → market-data-gateway → Settings → Variables and Secrets) delete
  `OWNER_ATTESTATION` (or set it to empty) and save, or deploy the top-level settings with
  `npx wrangler@4 deploy` (both values empty). Every data request then answers
  `source_disabled`; the tools say Yahoo Finance is switched off and use the user's other
  sources.
- **Previous version:** use only an R4-compatible source-off version that preserves and
  enforces unresolved markers, stops and consumed identifiers. Code rollback does not roll
  back SQLite state. R3 ignores the new marker column and is not a safe serving rollback.
- **Back to a version before 1.3.0: not possible with `wrangler rollback`.** Cloudflare refuses a
  rollback across a Durable Object lifecycle change, and the older versions have known defects
  (no durable stop). Switch the source off instead (above), which needs no new code.
- **Stop the tools from using it:** set `gateway: ""` in `_data/market_data.yml` and
  `DEFAULT_GATEWAY_URL = ""`, sync, rebuild the ZIPs and merge. The tools then contact no
  gateway.
- **Destructive cleanup:** deleting a class, namespace or Worker can permanently erase
  unresolved outcomes, provider stops and consumed identifiers. It is not a recovery or
  recovery procedure. Do not recreate state to reopen access. Any separately authorized
  retirement requires retrieval off and owner reconciliation; a manual halt or lost outcome
  has no deadline that proves it is safe to resume. This path has not been exercised.
- **Usage:** dashboard → Workers & Pages → market-data-gateway → Metrics, and Durable Objects for the coordinator.

## Local development

```bash
npx wrangler@4 dev --port 8788 --var ALLOW_HTTP:true --var "ALLOWED_ORIGINS:https://elmatthe.github.io,http://127.0.0.1:4000"
```

This runs the top-level settings (source switched off), so nothing reaches Yahoo. Wrangler keeps
the coordinator's local state in `.wrangler/` (Git-ignored). Open
`http://127.0.0.1:4000/projects/portfolio-rebalancer/?mdgateway=http://127.0.0.1:8788` on a
locally served build; the pages honour `mdgateway` (a URL, or `none`) only when they are
served from `127.0.0.1` or `localhost`. Use `--env production` locally only for requests
that cannot reach Yahoo (health, CORS, refusals), as done on 2026-11-04 in workerd.

## Tests

From the repository root (no network; Yahoo replaced by
`_tools/tests/fixtures/yahoo-chart.mjs`):

```bash
node --test _tools/tests/unit/market-gateway.test.mjs _tools/tests/unit/upstream-coordinator.test.mjs _tools/tests/unit/keyless.test.mjs _tools/tests/unit/sources.test.mjs
```

```bash
cd _tools/tests && python3 -m pytest -q test_desktop_gateway.py
```

The real Workers runtime (workerd, real SQLite, real restarts from disk, separate isolates) needs
the pinned Wrangler, which brings workerd and Miniflare. It is a test tool only, and it needs no
Cloudflare account:

```bash
npm install --no-save --no-package-lock --prefix /tmp/wrangler wrangler@4.157.0
NODE_PATH=/tmp/wrangler/node_modules node --expose-gc _tools/tests/worker-runtime/gateway-runtime.test.cjs
```

`_tools/tests/r3_reproduction.mjs` runs the review's counterexamples against any checkout: it exits 1
on `de720dc` and 0 here (usage at the top of the file).

`upstream-coordinator.test.mjs` covers several isolates sharing one coordinator on a clock the test
controls, with timers that fire late or never: overdue admission, deadlines recorded in either
order, halts, restart and recovery, the exact incident approval rules (M4), unreadable, unwritable and
malformed state, a stop while requests are queued, clients leaving, and a missing or failing
coordinator. At every simulated start it checks that the start is already on disk and no stop is.
The R4 regressions include actual SQLite triggers rejecting outcome updates while allowing
admission, both 3600-second cooldown and 172800-second halt losses, object resets and full
persisted-runtime disposal, live recovery versus lost-outcome quarantine, failed admission,
mandatory finalization with unchanged counters, competing success/refusal completions,
transactional owner-ID rollback, replay, malformed markers, migration, timeout and abort.
They assert the unsafe second upstream call never occurs. The unit clock tests retain the
20-second late wake and exact 15,000/15,001 ms deadline boundaries with eligible capacity.
The R5/R6 regressions cover a connection lost before headers, and an HTTP 200 whose body is
interrupted, times out (also with a transport that ignores the abort) or is cancelled, each
quarantined across restarts, with a complete streamed HTTP 200 as the control; and they check
that `cooldown_started` is never logged before its write succeeds. The R7 regressions hold each
commit until the test commits or rolls it back: a stop or halt whose statement returned but
whose commit failed (never logged as started, marker kept, quarantined across a restart, no
second request), a confirmation that never settles, concurrent stops confirmed out of order
(logged once each, in order, halt kept), failed-write recovery and a rolled-back approval;
and an oversize HTTP 200 whose cancellation never settles, rejects or throws, at exactly
2 MiB and one byte over. The M4 regressions check that an approval written before an incident,
an earlier incident's approval, a replayed or malformed value, an approval while the source is on
or within 60 s of the incident's newest request, and the pre-M4 identifier clear nothing; that a
scope change (a second unknown outcome, a halt, a repeated halt-level direction, a restart, a row
written by an older version) rotates the generation and nonce; that the exact approval clears the
incident once, atomically with its record, without shortening a cooldown; that a failed approval
transaction or commit changes nothing and applies at the next start; that legacy R3/R7 rows are
bound to a new incident; and that health reads never write. Each counts the synthetic upstream
requests.

`gateway-runtime.test.cjs` runs these scenarios in the real runtime (the HTTP 200 body faults
over a real socket, the logs read from workerd, and a real SQLite commit failing at a deferred
foreign key, for a stop, a halt and an approval, across a full persisted restart; the M4 approval
cycle across source-off and source-on deployments, using the README's Data Studio query), and `wrangler deploy
--dry-run` for both configurations. Not covered locally: output gates under slow storage (local
writes finish at once), idle eviction, Cloudflare's edge, including whether a
real client disconnect reaches `request.signal` (the tests reach it through a service binding; a
closed TCP connection does not fire it under local workerd), and the live account.

`market-gateway.test.mjs` covers the activation settings (including `wrangler.toml`),
the fixed upstream URL and headers, the seven smoke listings and DLR-U.TO, history bases,
refused symbols and parameters, mismatched/malformed answers, HTTP 429/403/503,
redirects, oversize bodies, timeouts, CORS, per-client and shared limits, actual-start
spacing, the in-flight limit and the hard 15 s wait on a virtual clock, cancellation, the
source's `Retry-After` (seconds, HTTP date, invalid values, longest deadline, the stop above
24 h and its approval), coalescing, remembered refusals, the circuit breaker, no-Origin
clients, caching and logs. `keyless.test.mjs` runs the browser
adapter against this Worker (pauses, fallback, order). `test_desktop_gateway.py` runs the
desktop package against this Worker served on 127.0.0.1 by `gateway_server.mjs`.
`_tools/tests/browser/freesource.test.js` and `sources.test.js` drive both web apps
against it in Chromium. Mocked tests are not proof that Yahoo answers or that the
exchange codes are right: the live smoke test is.
