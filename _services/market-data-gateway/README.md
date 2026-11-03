# Market-data gateway (Cloudflare Worker, free tier)

One small Cloudflare Worker shared by the **Portfolio Rebalancer** and the **Stock
Comparison & Analytics** web apps on <https://elmatthe.github.io>. It provides the pages'
*free source*: ordinary market data (latest regular-session price, bounded daily history)
that a visitor can request **without an API key**, in one normalized JSON contract.
GitHub Pages still hosts the website; this Worker is a separate, optional service.
It is not the CPI gateway (`../cpi-data-gateway/`) and shares no code or settings with it.

**Status: written and tested with mocks only; not deployed; its data source is switched
off.** The only upstream it implements is Yahoo Finance chart data, and the rights needed
to relay that data to the public could not be established (next section). The Worker
therefore refuses every data request (`source_disabled`) until its operator records a
written authorization. The website points at no gateway (`_data/market_data.yml` is
empty), so both pages say the free source is not available and keep working with
personal keys, typed prices and CSV files.

## Licensing gate (why the source is off)

Checked 2026-11-03 against the sources linked; details and quotes in
`_tools/PROVIDER_MATRIX.md` §10.

- `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}` is an **unofficial,
  undocumented** Yahoo Finance endpoint. Yahoo publishes no API, documentation, licence
  or service level for it. It is **not** the Python `yfinance` library; yfinance is an
  independent client of the same endpoints whose own disclaimer says the API "is
  intended for personal use only" and refers users to Yahoo's terms.
- Yahoo's Terms of Service (legal.yahoo.com, version current on 2026-11-03) prohibit
  collecting data "using any automated means … robots, spiders, scrapers" (§2(d)(ix)),
  accessing the services "using a method other than the interface and the instructions
  that we provide" (§2(e)), and reproducing, distributing, transmitting or broadcasting
  "any portion or use of, or access to, the Services" (§2(h)). Much of Yahoo Finance's
  data is supplied by third-party data providers and exchanges.
- A Worker does **not** remove Yahoo's rate limits or its blocking of automated
  clients; Cloudflare's IP ranges are shared and are often blocked or rate-limited. It
  also does not change who is licensed: relaying one fetch to many visitors, and caching
  it, is redistribution, which is different from one person's own research use.
- Sending a browser-like User-Agent, obtaining cookies or "crumbs", or rotating
  addresses would only disguise automated access; it grants no right. This gateway sends
  an honest, identifying User-Agent and does none of those things.

**Activation gate.** The source runs only when both settings are present:

| Setting | Meaning |
|---|---|
| `KEYLESS_SOURCE = "yahoo-chart"` | which upstream adapter to use (the only one implemented) |
| `SOURCE_AUTHORIZATION = "<reference>"` | where the written permission is kept: who granted it, when, and what it covers. It must cover **automated retrieval and public redistribution (display to anonymous visitors, with caching)** of the data, including any exchange data Yahoo licenses from others. |

With either missing, `/v1/health` reports `"enabled": false` with the reason, every data
request answers `source_disabled`, and no request is sent upstream. The reference text is
never returned by the gateway.

If permission cannot be obtained, leave the source off. A licensed, display-permitted
feed can replace the Yahoo adapter behind the same contract (`src/yahoo-chart.js` is the
only upstream-specific file); no such provider is configured, and none is implied.

## Contract

All endpoints are `GET` (plus CORS preflight). Every answer is JSON with
`Cache-Control: no-store` for the browser; prices are always in **major units** of the
stated currency, with the provider's raw value and unit alongside.

| Request | Answer |
|---|---|
| `GET /v1/health` | `md-gateway.health.v1`: `status`, `version`, `keyless {enabled, source, reason, provider, attribution, official:false}`, `venues`, `history {ranges, intervals}`, `cacheTtlSeconds`, `limits`. No secrets. Works without an `Origin`. |
| `GET /v1/quote?symbol=VEQT.TO` | `md-gateway.quote.v1`: `source`, `listing {symbol, mic, venueName, exchangeCode, exchangeName, instrumentType, name, timeZone}`, `currency`, `rawCurrency`, `quoteUnit`, `unitScale`, `price`, `rawPrice`, `priceBasis: "regular_market_price"`, `adjusted:false`, `tradingDate` (in the venue's time zone), `sourceTime`, `delay {realTime:false, note}`, `dayHigh`, `dayLow`, `volume`, `previousClose` (each `null` when absent, and listed in `missing`), `retrievedAt`, `cache {status, ageSeconds, ttlSeconds}` |
| `GET /v1/history?symbol=SAP.DE&range=1y&interval=1d` | `md-gateway.history.v1`: same identity fields, `range`, `interval`, `frequency:"daily"`, `adjustment {close, adjClose, adjCloseAvailable}`, `observations: [[date, close, adjClose], …]` (ascending, one per trading date, `null` where the source gave none), `count`, `firstDate`, `lastDate`, `lastBarMayBeIncomplete`, `missing {rowsWithoutPrices, closes, adjCloses, duplicateDates}`, `retrievedAt`, `cache` |
| `OPTIONS` on the two data paths | 204 for an allowed origin asking for `GET`; 403 otherwise |
| anything else, or any refusal | `md-gateway.error.v1`: `{error: {code, message, retryable, definitive}}` with a fixed message |

Error codes: `invalid_request`, `invalid_symbol`, `unsupported_listing`, `invalid_range`,
`origin_not_allowed`, `https_required`, `not_found`, `method_not_allowed`,
`source_disabled`, `rate_limited` (this client), `throttled` (the shared upstream budget),
`busy`, `symbol_not_found`, `no_price`, `no_history`, `listing_mismatch`,
`currency_mismatch`, `currency_unknown`, `unsupported_instrument`,
`upstream_rate_limited`, `upstream_blocked`, `upstream_unavailable`, `upstream_timeout`,
`upstream_invalid`, `upstream_rejected`. Retryable codes carry `Retry-After`.

Price semantics. `close` in history is Yahoo's close, adjusted for splits but not for
dividends (price return); `adjClose` is Yahoo's adjusted close, also adjusted for dividend
and capital-gain distributions (total return). They are returned separately and never
substituted for each other; when `adjClose` is absent the pages say so and use closes,
labelled as such. The quote is the latest regular-session price, possibly delayed by an
amount Yahoo does not state; it is never labelled real-time.

## Validation (fail closed)

Request: HTTPS; URL at most 256 characters; exactly the listed query parameters, each
once (anything else, including `shares`, `target` or `account`, is `invalid_request`);
symbol: upper-case letters and digits with optional hyphens, at most 20 characters, and
an exchange suffix from the fixed list in `src/venues.js` (US with no suffix, `.TO`,
`.V`, `.NE`, `.L`, `.DE`, `.PA`, `.AS`, `.SW`, `.T`, `.SS`, `.SZ`, `.HK`, `.AX`).
Indexes (`^`), currency pairs and futures (`=`), other exchanges and free text are refused
before any upstream request. History: `range` one of `1mo 3mo 6mo 1y 2y 5y`, `interval`
`1d`.

Upstream answer: HTTP 200 JSON of at most 2 MB, one `chart.result`, `meta.symbol` equal
to the requested symbol, `meta.instrumentType` EQUITY, ETF or MUTUALFUND,
`meta.exchangeName` one of the venue's exchange codes, `meta.currency` one of the venue's
currencies (`GBp` is converted from pence to GBP), a finite positive price, a plausible
price time; history timestamps strictly ascending, at most 2,000, arrays of equal length,
every value `null` or a finite positive number. Zero, negative or non-numeric values,
another symbol, another exchange (for example an OTC line for a US symbol), another
currency, a redirect or a non-JSON page make the whole answer invalid: it is refused,
never repaired or replaced by another listing, and dates are never filled in.

The exchange codes (`NMS`, `NYQ`, `PCX`, `TOR`, `VAN`, `NEO`, `LSE`, `GER`, `JPX`, `SHH`, …)
come from public examples of Yahoo's response and have **not** been checked against live
answers from this gateway. A wrong code only causes a refusal (`listing_mismatch`); confirm
them in the approved live smoke test before activation.

## Security and privacy

- No credentials, keys or secrets exist in this Worker, its requests or its answers.
- Fixed upstream origin and path; the only client input copied into the upstream URL is an
  allowlisted symbol and range; no client header (cookies, authorization, forwarding
  headers) is forwarded; redirects are not followed; 8-second upstream timeout.
- The contract has no field for holdings, quantities, targets or accounts, and the pages
  send none: only a symbol (and a range for history).
- CORS: `ALLOWED_ORIGINS` (default `https://elmatthe.github.io`); data requests without an
  allowed `Origin` are refused. **CORS is not authentication** — any script can send any
  `Origin` — so abuse is bounded by the rest: allowlists, per-client and shared upstream
  rate limits, the cache, and Cloudflare's free daily cap.
- Rate limits (all fail closed): 30 requests per minute per client (SHA-256 of the client
  IP, truncated; the IP is not stored or logged) in each isolate and through the
  `RATE_LIMITER` binding; at most 3 requests in flight per client; at most 20 upstream
  requests per minute per isolate and 60 per minute per Cloudflare location through the
  `UPSTREAM_LIMITER` binding; at most 4 upstream requests in flight per isolate. A binding
  error answers `busy` rather than letting the request through. Cloudflare documents the
  Rate Limiting binding as approximate and per location, and advises against IP keys
  because many people can share one IP; with no user accounts there is no better key,
  so the limits are deliberately modest and the shared upstream limit uses one key.
- Logs: event name, code, venue, upstream status. Never an IP address, URL or header.
- Headers: `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, HSTS.

## Caching

- Quotes are reused for **5 minutes**, history for **6 hours** (per symbol and range).
- `retrievedAt` is always the time of the upstream request; a cached answer reports
  `cache.status: "hit"` with its age, and the pages label it ("gateway copy, N min old").
  Expired entries are not served. There is no stale-if-error: an upstream failure is an
  error, not an old price.
- Two layers: a small in-memory cache in each isolate (always works, per isolate), and the
  Cache API (`caches.default`, per Cloudflare data center). Cloudflare documents that
  Workers on a **custom domain** have functional Cache API operations; on a `workers.dev`
  address, Cloudflare staff have said the Cache API has no effect (the documentation is not
  explicit). The gateway works either way; to share the cache across isolates, add a
  custom domain route.
- Browsers keep their own copy (10 minutes for quotes, 6 hours for history) in local
  storage, labelled "saved copy" with its age.

## Workers Free plan (Cloudflare documentation, checked 2026-11-03)

From <https://developers.cloudflare.com/workers/platform/limits/> (page dated 2026-10-29):
100,000 requests per day (reset at 00:00 UTC; above it Cloudflare returns error 1027 and
does not bill), 10 ms CPU time per request, 128 MB memory, 50 subrequests and 6
simultaneous outgoing connections per request, Cache API objects up to 512 MB and 50 cache
operations per request. The Rate Limiting binding takes a period of 10 or 60 seconds
(<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>, dated
2026-10-21); its page does not state plan availability, so if `wrangler deploy` rejects it,
remove the two `[[ratelimits]]` blocks (the in-memory limits still apply).

Each request makes at most one upstream subrequest and one JSON parse (a 5-year daily
history is roughly 150–250 KB from the upstream). The Rebalancer's 14-holding sample costs
14 gateway requests (none when cached in the browser); a Stock comparison costs one per
ticker. 100,000 requests a day is about 7,000 sample portfolios. Uses no KV, D1, R2,
Durable Objects, Queues or paid feature. **Do not upgrade the account for this.**

## Deploy on a free Cloudflare account (owner; only after approval)

Not done by any automated session. Needs a Cloudflare account (free), Node.js 20 or later
and this repository. Deploying with the source switched off is safe: it serves only
health and refusals.

1. Sign up or sign in at <https://dash.cloudflare.com/sign-up>; choose the **Free** plan (no
   payment method needed for Workers Free).
2. From this folder:

   ```bash
   cd _services/market-data-gateway
   ```

   ```bash
   npx wrangler@4 login
   ```

3. Deploy (Wrangler prints `https://market-data-gateway.<your-subdomain>.workers.dev`):

   ```bash
   npx wrangler@4 deploy
   ```

   If Wrangler says the `ratelimits` binding is unavailable, delete both `[[ratelimits]]`
   blocks from `wrangler.toml` and deploy again. If namespace ids 21011 or 21012 are used
   in the account already, choose other integers. Optional: in the dashboard (Workers &
   Pages → market-data-gateway → Settings → Domains & Routes) add a custom domain so the
   Cache API is shared.
4. Verify (next section). With the source off, `/v1/health` says `"enabled": false`.
5. Point the website at it: in `_data/market_data.yml` set

   ```yaml
   gateway: "https://market-data-gateway.<your-subdomain>.workers.dev"
   ```

   (https, no trailing slash), commit on a branch, review and merge. Both pages then show
   "switched off" (while the source is off) instead of "not set up". This is the **only**
   website setting; there is no other URL to change.
6. **Activation (only with written permission):** set the two gate values, either in
   `wrangler.toml` `[vars]` and redeploy, or in the dashboard (Settings → Variables):
   `KEYLESS_SOURCE = "yahoo-chart"` and `SOURCE_AUTHORIZATION = "<who, when, document
   reference>"`. Then run the approved live smoke test (below) before announcing it.

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
curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/quote?symbol=AAPL"
```

Expected: health `{"status":"ok", …, "keyless": {"enabled": false, …}}` with the reason
while the gate is closed; preflight `204` with `Access-Control-Allow-Origin:
https://elmatthe.github.io`; the foreign origin `origin_not_allowed`; the extra parameter
`invalid_request`; the allowed quote `source_disabled` (HTTP 503), with nothing sent
upstream. The gate is checked before the symbol, so while it is closed every well-formed
data request answers `source_disabled`. After activation, `symbol=%5EGSPC` answers
`unsupported_listing` without an upstream request.

These exact requests were run on 2026-11-03 against this Worker in Cloudflare's local
runtime (`wrangler dev`, workerd, Wrangler 4.157.0, no account, `KEYLESS_SOURCE` set and
`SOURCE_AUTHORIZATION` empty) with the results above; both Rate Limiting bindings were
accepted in local mode. No request reached Yahoo.

**Live smoke test (after activation, separately approved, capped).** At most seven quote
requests and one history request, one per listing, spaced at least five seconds apart,
from a normal connection, with no retry loop, no browser-imitating headers and no
circumvention of any refusal:

```bash
for s in AAPL VEQT.TO YNVD.NE 7203.T SAP.DE VOD.L 600519.SS; do curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/quote?symbol=$s"; echo; sleep 5; done
```

```bash
curl -sS -H "Origin: https://elmatthe.github.io" "$GATEWAY/v1/history?symbol=VEQT.TO&range=1mo&interval=1d"
```

Record for each: HTTP status, `listing.exchangeCode`, `currency`/`rawCurrency`,
`tradingDate`. Compare two or three prices with your broker. If an answer is
`listing_mismatch` for a correct listing, the exchange code in `src/venues.js` needs
correcting (from the recorded answer) before use. If Yahoo answers `upstream_blocked` or
`upstream_rate_limited`, stop: do not try to work around it.

## Roll back or stop

- Close the gate: remove `KEYLESS_SOURCE` or `SOURCE_AUTHORIZATION` (dashboard → Variables)
  and redeploy. Pages immediately show "switched off" and send no price requests.
- Remove the site's pointer: set `gateway: ""` in `_data/market_data.yml` and merge. Pages
  show "not set up" and contact no gateway.
- Previous version: Workers & Pages → market-data-gateway → Deployments → roll back, or
  `npx wrangler@4 rollback`.
- Delete the service: `npx wrangler@4 delete` in this folder.
- Usage: dashboard → Workers & Pages → market-data-gateway → Metrics.

## Local development

```bash
npx wrangler@4 dev --port 8788 --var ALLOW_HTTP:true --var "ALLOWED_ORIGINS:https://elmatthe.github.io,http://127.0.0.1:4000"
```

Then open `http://127.0.0.1:4000/projects/portfolio-rebalancer/?mdgateway=http://127.0.0.1:8788`
(or the Stock page) on a locally served build. The pages honour `mdgateway` only when they
are themselves served from `127.0.0.1` or `localhost`, so a link cannot point production
visitors at another server. Leave the gate closed locally unless a live request is
intended and approved.

## Tests

From the repository root (no network; Yahoo replaced by `_tools/tests/fixtures/yahoo-chart.mjs`):

```bash
node --test _tools/tests/unit/market-gateway.test.mjs
```

```bash
node --test _tools/tests/unit/keyless.test.mjs
```

The first runs this Worker module in Node: activation gate, fixed upstream URL and
headers, venue list equal to the browser adapter's, seven listings (AAPL, VEQT.TO,
YNVD.NE, 7203.T, SAP.DE, VOD.L in pence, 600519.SS) and DLR-U.TO, history bases and missing
values, refused symbols and parameters, mismatched/malformed/invalid answers, HTTP 429,
403, 503, redirects, oversize bodies, timeouts and network errors, CORS and methods, rate
limits and fail-closed bindings, in-memory and Cache API caching with expiry, and logs. The
second runs the browser adapter against this Worker in the same process.
`_tools/tests/browser/freesource.test.js` drives both web apps in Chromium against this
Worker code (see `_tools/README.md`). Mocked tests are not proof that Yahoo answers, that
the exchange codes are right, or that the use is permitted: the activation gate and the
live smoke test are.
