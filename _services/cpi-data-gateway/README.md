# CPI data gateway (Cloudflare Worker, free tier)

A very small Cloudflare Worker that lets the CPI Web Scraper page on
<https://elmatthe.github.io/projects/cpi-webscraper/> read the thirteen US series of the
CPI_Downloader dataset from FRED, **with each visitor's own FRED API key**. GitHub Pages
still hosts the website; this Worker is the only server-side piece.

**Status: written and tested, not deployed.** Deploying needs the site owner's own
Cloudflare account (steps below). Until a gateway URL is configured, the CPI page works in
Canadian-only mode and says so; nothing on the site claims that live FRED retrieval
works.

## Why a gateway is needed

- Statistics Canada's Web Data Service allows browser requests (`Access-Control-Allow-Origin: *`),
  so the five Canadian series are fetched **directly** from the visitor's browser.
- FRED's API sends no CORS headers (checked 2026-11-03), so a browser page on another site
  cannot read its answers. A server has to make the request. The gateway does exactly one
  thing: it forwards an approved request, with the visitor's key, to FRED's fixed
  `series/observations` endpoint and returns validated observations.
- There is **no owner key**. FRED's terms say "All users of an application shall use their
  own API key"; the gateway refuses requests without one.

## What it accepts

| Request | Result |
|---|---|
| `POST /v1/observations` with JSON `{"series_id", "observation_start", "observation_end", "api_key"}` | `{"schema": "cpi-data-gateway.observations.v1", "series_id", "observation_start", "observation_end", "count", "observations": [{"date": "YYYY-MM-DD", "value": "1.23" or null}], ...}` |
| `OPTIONS /v1/observations` from an allowed origin | CORS preflight (POST, `Content-Type` only, no credentials) |
| `GET /v1/health` | Status, version, approved series, limits. No secrets. |
| anything else | a JSON error with a fixed message (`not_found`, `method_not_allowed`, …) |

Validation, in order: HTTPS; no query string; exact path; allowed `Origin`;
`Content-Type: application/json`; body of at most 1 KB with exactly those four fields;
`series_id` one of `CPIAUCNS CPIAUCSL CPILFENS CPILFESL UNRATE FEDFUNDS DFF SP500 T10Y2Y GS10 GS2 PCEPI PCEPILFE`
and not switched off in `DISABLED_SERIES`; real calendar dates from `1913-01-01` to the
end of the current month, start before end, monthly series starting on the 1st, daily
series (`DFF`, `SP500`, `T10Y2Y`) at most 3,700 days per request; `api_key` 32 lower-case
letters and digits; per-caller rate limits and concurrency.

FRED's answer must be HTTP 200 JSON of at most 3 MB with `count` equal to the number of
observations, every date inside the window (first of the month for monthly series), no
duplicates, and every value a decimal number or `"."` (no value). Anything else is
refused with `upstream_invalid`; redirects are never followed.

## Security and privacy

- **Keys:** sent by the browser in the POST body over HTTPS (never in a URL), forwarded to
  FRED in the `api_key` query parameter as FRED's API requires, and never logged, stored,
  cached or returned. Error messages are fixed texts, never FRED's or the runtime's own
  wording (which can contain the upstream URL). Logs record only an event name, the
  series, a status code and an error *name*.
- **No general proxy:** fixed upstream host and path, parameters set one by one, no client
  header forwarded, no redirect followed, nothing read from the query string.
- **Origins:** `ALLOWED_ORIGINS` (default `https://elmatthe.github.io`). Origin checks stop
  other websites from using visitors' browsers against the gateway; they are **not
  authentication** (a script can send any `Origin`). The protection against abuse is the
  rest: only thirteen series, bounded dates and sizes, per-caller rate limits, and every
  request needs its own valid FRED key, which FRED itself rate-limits.
- **Rate limits:** 60 requests per minute per caller (hashed client IP; the IP itself is not
  stored or passed on) in each Worker isolate, the same limit across isolates through
  Cloudflare's Rate Limiting binding, at most 3 requests in flight per caller and 6 per
  isolate. Failures of the binding fail closed (HTTP 503).
- **No shared data:** `Cache-Control: no-store`, no cookies, no storage of any kind, so one
  visitor's answer is never served to another, and nothing (in particular no S&P 500
  history) is cached or republished by the gateway.
- **Headers:** `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, HSTS; CORS headers only for allowed origins.

## Free-tier limits (Cloudflare documentation, checked 2026-11-03)

Workers Free: 100,000 requests per day, 10 ms CPU time per request, 128 MB memory,
50 subrequests and 6 simultaneous outgoing connections per request
(<https://developers.cloudflare.com/workers/platform/limits/>). The Rate Limiting binding
needs Wrangler 4.36.0 or later and a period of 10 or 60 seconds
(<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>).

How the gateway stays inside them:

| Page action | Gateway requests (= FRED requests) |
|---|---|
| One month, or any range up to ten years | 13 (one per series) |
| 2015-01 to today | 16 |
| Full history 1913-01 to today | 26 (10 monthly series; DFF 8, T10Y2Y 6 and SP500 2 ten-year windows) |

Each request makes one subrequest and parses at most about 330 KB of JSON (ten years of
daily observations), well inside 10 ms of CPU. 100,000 requests a day is roughly 3,800
full-history downloads. Above the daily allowance Cloudflare returns errors (the page
then shows "Data gateway unavailable" and keeps the Canadian data); on the Free plan
nothing is billed. **Do not upgrade the account to Workers Paid for this.**

## Owner setup (one time, about ten minutes)

Needs: a Cloudflare account (free), Node.js 20 or later, and this repository.

1. Sign in or sign up at <https://dash.cloudflare.com/sign-up>. Choose the **Free** plan; no
   payment method is needed for Workers Free.
2. In a terminal, from this folder:

   ```bash
   cd _services/cpi-data-gateway
   ```

   ```bash
   npx wrangler@4 login
   ```

3. Deploy (Wrangler prints the address, `https://cpi-data-gateway.<your-subdomain>.workers.dev`):

   ```bash
   npx wrangler@4 deploy
   ```

   If Wrangler reports that the `ratelimits` binding is unavailable for the account,
   delete the `[[ratelimits]]` block from `wrangler.toml` and deploy again; the in-memory
   limiter still applies. If `namespace_id` 21001 is already used in the account, choose
   another integer.
   The Worker name must not contain "fred": FRED's terms forbid "FRED" in an
   application's hostname, and the workers.dev hostname is the Worker name.
4. Verify without exposing a key (see the next section).
5. Configure the website: in `_data/tool_projects.yml`, under `cpi:`, set
   `data_gateway: https://cpi-data-gateway.<your-subdomain>.workers.dev` (no trailing
   slash), commit, and let GitHub Pages rebuild. The CPI page then offers the FRED key
   field and fetches the US columns through the gateway.
6. On the live page, enter your own FRED key, fetch a short range and a full history, and
   compare a few values with fred.stlouisfed.org.

Configuration values: `ALLOWED_ORIGINS` (default `https://elmatthe.github.io`),
`DISABLED_SERIES` (default empty; `SP500` switches off column N if S&P 500 retrieval
through the gateway is not permitted for your use), the `RATE_LIMITER` binding. No secret
is configured: the gateway has none.

To stop the service at any time: `npx wrangler@4 delete` in this folder, or set
`DISABLED_SERIES` and redeploy. Usage is visible in the Cloudflare dashboard under
Workers & Pages → cpi-data-gateway → Metrics.

## Verify the live endpoint without exposing a key

```bash
GATEWAY=https://cpi-data-gateway.<your-subdomain>.workers.dev
```

```bash
curl -sS "$GATEWAY/v1/health"
```

```bash
curl -sS -o /dev/null -D - -X OPTIONS -H "Origin: https://elmatthe.github.io" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" "$GATEWAY/v1/observations"
```

```bash
curl -sS -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{"series_id":"GS10","observation_start":"2024-01-01","observation_end":"2024-03-31","api_key":"abcdefghij0123456789abcdefghij01"}' "$GATEWAY/v1/observations"
```

Expected: health `{"status":"ok",...}`; preflight `204` with
`Access-Control-Allow-Origin: https://elmatthe.github.io`; the foreign origin
`origin_not_allowed`. Then one real request with your own key, typed at a hidden prompt
so it is not stored in the shell history or shown on screen:

```bash
read -rs -p "FRED key: " FRED_KEY; echo; printf '{"series_id":"GS10","observation_start":"2024-01-01","observation_end":"2024-03-31","api_key":"%s"}' "$FRED_KEY" | curl -sS -X POST -H "Origin: https://elmatthe.github.io" -H "Content-Type: application/json" --data-binary @- "$GATEWAY/v1/observations"; unset FRED_KEY
```

Expected: three monthly GS10 observations. A made-up but well-formed key gives
`key_rejected` (checked locally against the real FRED API on 2026-11-03).

## Local development

```bash
npx wrangler@4 dev --port 8787 --var ALLOW_HTTP:true --var "ALLOWED_ORIGINS:https://elmatthe.github.io,http://127.0.0.1:4000"
```

Then open the locally served site at
`http://127.0.0.1:4000/projects/cpi-webscraper/?gateway=http://127.0.0.1:8787`. The page
accepts a `gateway` override only when it is itself served from `127.0.0.1` or
`localhost`, so a link cannot point production visitors at another server.

## Tests

`node --test _tools/tests/unit/gateway.test.mjs` (from the repository root) runs the
Worker module in Node with FRED mocked: allowed and refused endpoints, series, dates,
bodies, keys and origins; preflight; rate limits and concurrency; timeouts and outages;
response validation; no key in any response or log; no shared cache between visitors;
the `DISABLED_SERIES` switch. `_tools/tests/test_cpi_parity.py` checks that the allowlist
equals the browser schema and the desktop downloader. On 2026-11-03 the Worker was also
started in Cloudflare's local runtime (`wrangler dev`, workerd, Wrangler 4.157.0): health,
preflight, origin refusal, unknown series and a real FRED round trip with a made-up key
(`key_rejected`, key absent from the log) behaved as above. A mocked test is not proof
that a deployed gateway or a real key works: steps 4 and 6 above are.

## Data rights

- "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve
  Bank of St. Louis." FRED series may be owned by third parties
  (<https://fred.stlouisfed.org/docs/api/terms_of_use.html>).
- SP500 (column N): © S&P Dow Jones Indices LLC; reproduction requires its prior written
  permission (<https://fred.stlouisfed.org/series/SP500>). The gateway relays each
  visitor's own key-authenticated request and stores nothing; it never builds, caches or
  publishes an S&P 500 history, and the repository contains none. Whether a visitor may
  keep or share an export that contains column N is for that visitor (and the owner, for
  professional use) to confirm. `DISABLED_SERIES = "SP500"` turns the column off.
