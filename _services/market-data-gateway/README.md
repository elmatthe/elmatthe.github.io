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

See `md-instructions/Handoff.md` for the current state (deployed URL, activation, live
smoke results). The website reads the gateway address from `_data/market_data.yml`; the
desktop apps from `DEFAULT_GATEWAY_URL` in `_tools/shared_py/market_data/gateway.py`
(the two are kept equal by `_tools/tests/test_market_data_parity.py`). Empty means "not
set up": the tools then say Yahoo Finance is not available yet and send it nothing.

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

| Layer | Rule |
|---|---|
| Spacing | at most one upstream request start per **1 s** in each isolate; requests queue for their turn, and a request that would wait more than **15 s** is refused (`throttled`, `Retry-After`) |
| Concurrency | at most **2** upstream requests in flight per isolate (others wait in the same queue) |
| Budget | **20** upstream requests per minute per isolate, and **40** per minute per Cloudflare location through the `UPSTREAM_LIMITER` binding (one shared key) |
| Coalescing | identical concurrent requests in an isolate share **one** upstream request |
| Caching | quotes reused **10 min**, history **12 h** (per symbol and range); definitive refusals (unknown symbol, other listing or currency) remembered **30 min** |
| Circuit breaker | after Yahoo answers **429**, no upstream request for **15 min**; after **401/403**, **30 min**; after **3 consecutive** 5xx/timeouts/network errors, **2 min**. Cached answers are still served. The cooldown is shared with other isolates of the data center through the Cache API (best effort; a corrupted entry is ignored) and reported in `/v1/health` (`upstream.state: "cooling_down"`) |
| Per client | **30** requests per minute and **2** in flight per client (hashed IP) per isolate, plus the `RATE_LIMITER` binding (30/min per location) |
| No retries | the Worker never retries Yahoo; the pages and desktop apps retry only a network error reaching the gateway, once |

The clients add their own restraint (`assets/js/market-data/keyless.js`,
`_tools/shared_py/market_data/gateway.py`): one request at a time, at least 0.35 s apart
(across all tabs of the site in a browser), copies reused (10 min quotes, 12 h history),
and after any "slow down" answer — or an outage while the breaker is open — **nothing
more is sent until `Retry-After` has passed**, a pause remembered across page loads and
program restarts. The next source in the user's list is used meanwhile.

Expected volume: the Rebalancer's 14-holding sample costs at most 14 requests (about 14 s
with the 1 s spacing when nothing is cached); a Stock comparison one per ticker. The free
daily allowance of 100,000 Worker requests is far above that.

Honest identity: the Worker sends `User-Agent: market-data-gateway/1.1.0
(+https://elmatthe.github.io/projects/portfolio-rebalancer/)`. It never imitates a
browser, obtains cookies or "crumbs", rotates addresses or otherwise works around a
refusal. If Yahoo refuses, the gateway reports it and stops (circuit breaker).

## Contract

All endpoints are `GET` (plus CORS preflight). Every answer is JSON with
`Cache-Control: no-store`; prices are in **major units** of the stated currency, with
Yahoo's raw value and unit alongside.

| Request | Answer |
|---|---|
| `GET /v1/health` | `md-gateway.health.v1`: `status`, `version`, `keyless {enabled, source, reason, activation, provider, attribution, official:false}`, `upstream {state, code, retryAfterSeconds}`, `venues`, `history {ranges, intervals}`, `cacheTtlSeconds`, `limits`. No secrets; the attestation value is never echoed. |
| `GET /v1/quote?symbol=VEQT.TO` | `md-gateway.quote.v1`: `source`, `listing {symbol, mic, venueName, exchangeCode, exchangeName, instrumentType, name, timeZone}`, `currency`, `rawCurrency`, `quoteUnit`, `unitScale`, `price`, `rawPrice`, `priceBasis: "regular_market_price"`, `adjusted:false`, `tradingDate` (venue time zone), `sourceTime`, `delay {realTime:false, note}`, `dayHigh`, `dayLow`, `volume`, `previousClose` (each `null` when absent, listed in `missing`), `retrievedAt`, `cache {status, ageSeconds, ttlSeconds}` |
| `GET /v1/history?symbol=SAP.DE&range=1y&interval=1d` | `md-gateway.history.v1`: same identity fields, `range`, `interval`, `frequency:"daily"`, `adjustment {close, adjClose, adjCloseAvailable}`, `observations: [[date, close, adjClose], …]` (ascending, one per trading date, `null` where Yahoo gave none), `count`, `firstDate`, `lastDate`, `lastBarMayBeIncomplete`, `missing {…}`, `retrievedAt`, `cache` |
| `OPTIONS` on the data paths | 204 for an allowed origin asking for `GET` (exposes `Retry-After`); 403 otherwise |
| any refusal | `md-gateway.error.v1`: `{error: {code, message, retryable, definitive, retryAfterSeconds?}}` with a fixed message; `Retry-After` header when retryable |

Error codes: `invalid_request`, `invalid_symbol`, `unsupported_listing`, `invalid_range`,
`origin_not_allowed`, `https_required`, `not_found`, `method_not_allowed`,
`source_disabled`, `rate_limited` (this client), `throttled` (the shared budget or queue),
`busy`, `symbol_not_found`, `no_price`, `no_history`, `listing_mismatch`,
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
- Fixed upstream origin and path; the only client input copied into the upstream URL is
  an allowlisted symbol and range; no client header is forwarded; redirects are never
  followed; 8-second upstream timeout.
- The contract has no field for holdings, quantities, targets or accounts, and the tools
  send none: only a symbol (and a range for history).
- CORS: `ALLOWED_ORIGINS`; a browser request from another origin is refused. Requests
  with **no** `Origin` (the desktop apps) are accepted only when `ALLOW_NO_ORIGIN =
  "true"`. CORS is not authentication; abuse is bounded by the allowlists, the limits
  above, the cache and Cloudflare's free daily cap.
- Logs: event name, code, venue, upstream status, cooldown length. Never an IP address,
  URL or header. Workers Logs are disabled (`[observability] enabled = false`).
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
both bindings). Each request makes at most one upstream subrequest plus at most a few
Cache API operations. No KV, D1, R2, Durable Objects, Queues or paid feature is used.
**Do not upgrade the account for this.**

The Cache API is functional on a custom domain; on a `workers.dev` address Cloudflare does
not document it, so the shared cache and shared cooldown may be per isolate only there.
The in-memory cache, cooldown and limits work either way.

## Deploy (owner, on the owner's own computer)

Needs a free Cloudflare account, Node.js 20 or later and a clone of this repository on
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

```bash
npx wrangler@4 deploy --env production
```

Wrangler prints the address, `https://market-data-gateway.<your-subdomain>.workers.dev`.
If it says the `ratelimits` binding is unavailable on your plan, delete the four
`[[ratelimits]]` / `[[env.production.ratelimits]]` blocks and deploy again (the in-memory
limits still apply). If namespace ids 21011 or 21012 are already used in your account,
choose other integers.

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
- **Previous version:** dashboard → Deployments → Rollback, or `npx wrangler@4 rollback`.
- **Stop the tools from using it:** set `gateway: ""` in `_data/market_data.yml` and
  `DEFAULT_GATEWAY_URL = ""`, sync, rebuild the ZIPs and merge. The tools then contact no
  gateway.
- **Delete the Worker:** `npx wrangler@4 delete --env production` in this folder.
- **Usage:** dashboard → Workers & Pages → market-data-gateway → Metrics.

## Local development

```bash
npx wrangler@4 dev --port 8788 --var ALLOW_HTTP:true --var "ALLOWED_ORIGINS:https://elmatthe.github.io,http://127.0.0.1:4000"
```

This runs the top-level settings (source switched off), so nothing reaches Yahoo. Open
`http://127.0.0.1:4000/projects/portfolio-rebalancer/?mdgateway=http://127.0.0.1:8788` on a
locally served build; the pages honour `mdgateway` (a URL, or `none`) only when they are
served from `127.0.0.1` or `localhost`. Use `--env production` locally only for requests
that cannot reach Yahoo (health, CORS, refusals), as done on 2026-11-04 in workerd.

## Tests

From the repository root (no network; Yahoo replaced by
`_tools/tests/fixtures/yahoo-chart.mjs`):

```bash
node --test _tools/tests/unit/market-gateway.test.mjs _tools/tests/unit/keyless.test.mjs _tools/tests/unit/sources.test.mjs
```

```bash
cd _tools/tests && python3 -m pytest -q test_desktop_gateway.py
```

`market-gateway.test.mjs` covers the activation settings (including `wrangler.toml`),
the fixed upstream URL and headers, the seven smoke listings and DLR-U.TO, history bases,
refused symbols and parameters, mismatched/malformed answers, HTTP 429/403/503,
redirects, oversize bodies, timeouts, CORS, per-client and shared limits, spacing and the
15 s queue, coalescing, remembered refusals, the circuit breaker (and its Cache API
sharing), no-Origin clients, caching and logs. `keyless.test.mjs` runs the browser
adapter against this Worker (pauses, fallback, order). `test_desktop_gateway.py` runs the
desktop package against this Worker served on 127.0.0.1 by `gateway_server.mjs`.
`_tools/tests/browser/freesource.test.js` and `sources.test.js` drive both web apps
against it in Chromium. Mocked tests are not proof that Yahoo answers or that the
exchange codes are right: the live smoke test is.
