# CPI Web Scraper: data, architecture, security and operations (web app)

Dated 2026-11-03. How the browser version of the CPI Web Scraper
(<https://elmatthe.github.io/projects/cpi-webscraper/#web-app>) gets its data, what its
CSV contains, how a visitor's FRED key is handled, and how the optional data gateway is
deployed and kept inside Cloudflare's free tier. The Windows desktop tool
(`projects/CPI-Webscraper/`, a copy of `elmatthe/CPI-Webscraper`) is unchanged and remains
the way to write into an existing Excel model.

Code: `assets/js/cpi/` (browser), `_services/cpi-data-gateway/` (gateway Worker; deployment
steps in its `README.md`). Tests: `_tools/tests/unit/cpi-engine.test.mjs`,
`_tools/tests/unit/gateway.test.mjs`, `_tools/tests/test_cpi_parity.py`,
`_tools/tests/browser/cpi.test.js`.

## 1. Owner decisions implemented

| Decision | Implementation |
|---|---|
| 1A Controlled free-tier serverless gateway for FRED; each visitor's own key; GitHub Pages stays the host | `_services/cpi-data-gateway` (Cloudflare Workers Free). **Not deployed**: `data_gateway` in `_data/tool_projects.yml` is empty until the owner deploys it. |
| 3A Twelve-month pages in four groups, no page-wide horizontal scrolling | Canada / US Inflation / Rates / Other tabs; newest page first; stacked month cards in narrow containers. |
| 4A CSV with the exact 19 CPI_Downloader columns; workbook writing stays desktop-only | `engine.toCsv`, byte-identical to the desktop's `write_to_csv` (parity test). |

## 2. Architecture

```
visitor's browser (https://elmatthe.github.io)
 ├── GET  https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorByReferencePeriodRange   (no key; CORS *)
 └── POST https://cpi-data-gateway.<subdomain>.workers.dev/v1/observations  {series_id, dates, api_key}
           └── GET https://api.stlouisfed.org/fred/series/observations?series_id=…&api_key=…   (fixed URL)
```

- **Statistics Canada, direct.** The Web Data Service answers GET requests with
  `Access-Control-Allow-Origin: *` and needs no key (probed on 2026-11-03 with the
  `https://elmatthe.github.io` origin). The five vectors share one request per chunk of at
  most 120 months (the desktop's chunk length; WDS documents limits on data points per
  request), so a full history from 1913 is 12 requests, sent one after another 250 ms apart
  (WDS allows 25 requests per second per IP). HTTP 409 (tables locked during the
  00:00–08:30 Eastern update), 429, 5xx and network failures get three attempts with
  backoff; a chunk that still fails marks only its own months "Unavailable". Answers are
  kept in the page's memory for 30 minutes (WDS's own `Cache-Control: max-age=1800`), and
  **Clear** empties that cache.
- **FRED, through the gateway.** FRED's API sends no CORS headers, so a browser cannot read
  it. The gateway forwards approved requests only (section 5). The browser sends one
  request per monthly series for the whole range and one per window of at most ten years
  for the three daily series (DFF, SP500, T10Y2Y), at most two at a time. A rejected key,
  a refused origin or an unreachable gateway stops every remaining request.
- **Why not more of it in the browser?** FRED cannot be called from another site, and the
  terms forbid sharing one key among users ("All users of an application shall use their
  own API key"), so an owner key in a server is ruled out too.
- **Why writing into the workbook stays on the desktop.** The model's formulas, dynamic
  arrays and charts are recalculated and preserved only by desktop Excel; browser
  spreadsheet libraries would silently drop or freeze them. The desktop tool writes through
  a private Excel instance and merges months into the existing history.

## 3. Dataset contract (identical to the desktop)

`assets/js/cpi/schema.js` holds the 19 columns. `test_cpi_parity.py` fails if any id,
header, order, Statistics Canada vector, FRED series, aggregation or first month differs
from `projects/CPI-Webscraper/scripts/` (`config-default.toml`, `cpi_config.py`,
`data_sources.py`), or if the gateway allowlist differs.

| Col | Header | Source | Aggregation | First month | Units |
|---|---|---|---|---|---|
| A | Date | — | first day of the month | 1913-01 | YYYY-MM-DD |
| B | Headline CPI - Unadjusted CDN | StatCan 41690973 | monthly | 1914-01 | index 2002=100 |
| C | Headline CPI - Seasonally Adjusted CDN | StatCan 41690914 | monthly | 1992-01 | index 2002=100 |
| D | Core CPI - Unadjusted CDN | StatCan 41691233 | monthly | 1961-01 | index 2002=100 |
| E | Core CPI - Seasonally Adjusted CDN | StatCan 41690924 | monthly | 1992-01 | index 2002=100 |
| F | Alberta CPI - Unadjusted CDN | StatCan 41692327 | monthly | 1978-09 | index 2002=100 |
| G | Headline CPI - Unadjusted US | FRED CPIAUCNS | monthly as published | 1913-01 | index 1982-84=100 |
| H | Headline CPI - Seasonally Adjusted US | FRED CPIAUCSL | monthly | 1947-01 | index 1982-84=100 |
| I | Core CPI - Unadjusted US | FRED CPILFENS | monthly | 1957-01 | index 1982-84=100 |
| J | Core CPI - Seasonally Adjusted US | FRED CPILFESL | monthly | 1957-01 | index 1982-84=100 |
| K | Unemployment Rate - Seasonally Adjusted US | FRED UNRATE | monthly | 1948-01 | % |
| L | Monthly Effective Fed Fund Rate US | FRED FEDFUNDS | monthly average (as published) | 1954-07 | % |
| M | Monthly Fed Fund Rate - EOP US | FRED DFF | latest valid daily value in the month | 1954-07 | % |
| N | SP by month US | FRED SP500 | latest valid daily close in the month | rolling ~10 years | index |
| O | 10yr vs 2yr US | FRED T10Y2Y | latest valid daily value in the month | 1976-06 | percentage points |
| P | 10-Year Treasury Yield - Monthly Average US | FRED GS10 | monthly | 1953-04 | % |
| Q | 2-Year Treasury Yield - Monthly Average US | FRED GS2 | monthly | 1976-06 | % |
| R | PCE - Seasonally Adjusted US | FRED PCEPI | monthly | 1959-01 | index 2017=100 |
| S | Core PCE - Seasonally Adjusted US | FRED PCEPILFE | monthly | 1959-01 | index 2017=100 |

Month rules (`dates.js`, same as the desktop's `parse_months`/`normalize_range`): 4-digit
year and month 1–12; a start before January 1913 becomes 1913-01 (a single month too); a
range ending before 1913 is rejected; an end after the current month becomes the current
month; a start after it, and a reversed range, are rejected. The three end-of-month
columns (M, N, O) are blank for the current, unfinished month.

## 4. Missing and partial data

Nothing is interpolated, forward-filled, estimated or substituted, and a blank is never a
zero. Every blank cell in the preview says why; in the CSV it is an empty cell.

| Shown as | Meaning |
|---|---|
| No FRED key | US columns need the visitor's key; none was entered (Canadian-only mode). |
| No gateway yet | The site has no data gateway configured. |
| Gateway unavailable | The gateway could not be reached or refused the page. |
| Key rejected | FRED rejected the key (the remaining FRED requests are not sent). |
| Not published | After the latest month the source has published (release lag). |
| Before series | Before the series' first month (S&P 500: before FRED's ~10-year window). |
| Month not over | Current month, end-of-month columns M/N/O. |
| Unavailable | Temporarily unavailable after three attempts (e.g. Statistics Canada 409). |
| Restricted | Statistics Canada `x` (suppressed), or a series the gateway operator disabled. |
| Source error | The source answered with something invalid; the values were not used. |
| No value | A genuine missing observation inside the series' history (FRED `.`, StatCan `..`). |

**Canadian-only mode:** without a key (or without a gateway) the five Canadian series are
fetched, the thirteen US columns stay blank with their reason, the results and status say
"Canadian-only / partially populated", and the CSV still has all 19 headers. A US failure
never discards the Canadian data.

**One documented difference from the desktop:** when a series has no value for the only
requested month (for example Statistics Canada `..`), the desktop's `validate_sources` stops
the whole download (it must not half-write a workbook); the browser keeps every other
column and marks that cell "No value". `test_known_difference_single_month_with_a_published_gap`
pins this.

**Revisions:** every fetch gets the values published today (Statistics Canada revises the
previous month's seasonally adjusted CPI monthly and three years each January; FRED series
are revised too). Nothing from an earlier fetch is merged in. Observations Statistics
Canada flags as revised or preliminary are counted in the data-quality notes.

## 5. Credential flow and security

- **Getting a key:** free, from <https://fred.stlouisfed.org/docs/api/api_key.html> (create
  an account, then *My Account → API Keys*). A key is 32 lower-case letters and digits; the
  page refuses anything else before sending a request.
- **In the browser:** the key is held in memory; only if the visitor ticks *Keep for this
  browser tab* is it written to `sessionStorage` (cleared when the tab closes). It is never
  written to `localStorage`, put in a URL, written to the CSV, or shown in a message.
  *Remove key* clears both. Scripts on the same site could read session storage, so a key
  that can be replaced is the right kind to use (FRED keys can be revoked and re-issued).
- **On the wire:** HTTPS POST to the gateway with a JSON body; no cookies
  (`credentials: "omit"`), no referrer, `cache: "no-store"`.
- **In the gateway:** the key is sent to FRED in the `api_key` query parameter (the only
  form FRED's API accepts) on one fixed URL; it is never logged, stored, cached or
  returned; logs carry an event name, series, status code and error *name* only (the
  runtime's error text can contain the upstream URL). Responses are `no-store`, without
  cookies, so one visitor's answer is never served to another.
- **Gateway restrictions:** HTTPS only; exact paths; `ALLOWED_ORIGINS`; JSON body ≤ 1 KB
  with exactly four fields; the 13 series; real dates 1913-01-01 to the end of the current
  month; ≤ 3,700 days per daily request; key format; 60 requests per minute per caller
  (hashed IP, in-memory per isolate plus Cloudflare's Rate Limiting binding); ≤ 3 in flight
  per caller and 6 per isolate; 15 s upstream timeout; upstream answers ≤ 3 MB and fully
  validated; redirects never followed. **CORS is not authentication**: the allowlists,
  limits and the need for a valid personal FRED key are the protection.
- **Gateway override for development:** `?gateway=` is honoured only when the page itself
  is served from `127.0.0.1` or `localhost`, so a crafted link cannot send production
  visitors' keys to another server.
- **Naming:** the Worker is `cpi-data-gateway`. FRED's terms forbid "FRED" in an
  application's hostname, and the workers.dev hostname is the Worker name.

## 6. Free-tier operations

Workers Free (Cloudflare documentation, 2026-11-03): 100,000 requests per day, 10 ms CPU
per request, 128 MB memory, 50 subrequests and 6 simultaneous outgoing connections per
request. The gateway uses one subrequest per request and parses at most about 330 KB of
JSON. A single month, or any range up to ten years, is 13 gateway requests; 2015 to today
16; the full history 26 (about 3,800 full histories a day). Above the allowance Cloudflare
refuses requests (the page shows "Gateway unavailable" and keeps the Canadian data); the
Free plan does not bill. No KV, D1, R2, Durable Objects or other paid or stored feature is
used. Deployment, configuration values (`ALLOWED_ORIGINS`, `DISABLED_SERIES`, the rate-limit
binding), verification without exposing a key, and how to stop the service:
`_services/cpi-data-gateway/README.md`.

## 7. CSV

Exactly the desktop's `write_to_csv` output for the same data (checked byte for byte):

- the nineteen A:S headers, in order, then one row per requested month (the whole range,
  not the page on screen), dates `YYYY-MM-DD` (first of the month);
- numbers as Python writes floats (shortest round-trip digits, `100.0` for whole numbers);
- empty cells for every unavailable value; no zero, no placeholder text;
- comma-separated, `\r\n` line endings, UTF-8 (the content is ASCII; no byte-order mark,
  like the desktop file), quoting only where needed; text that a spreadsheet could read as
  a formula is prefixed with `'` (numbers such as `-0.5` are not touched);
- no key, session identifier, file path or other personal data; metadata and notices stay
  on the page, so the 19-column layout is unchanged.

File name: `CPI_Downloader_<start>_to_<end>.csv`.

## 8. Data licensing and attribution

- "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve
  Bank of St. Louis" is shown on the page (required by the FRED API terms). FRED series
  may be owned by third parties.
- Statistics Canada data: Statistics Canada Open Licence; Statistics Canada is the source
  of the data and the product does not imply its endorsement.
- **S&P 500 (column N):** © S&P Dow Jones Indices LLC; reproduction requires its prior
  written permission. The site and repository contain no S&P 500 history, the gateway
  stores and caches nothing, and the series is fetched only with the visitor's own key for
  their own use (as the desktop tool does). Whether an export containing column N may be
  kept or shared is for the visitor to confirm; the operator can switch the column off
  with `DISABLED_SERIES = "SP500"` (the cells then say "Restricted"). No other source is
  substituted.

## 9. Adding or changing a series safely

1. Change the desktop downloader first, in its canonical repository
   (`elmatthe/CPI-Webscraper`: `config-default.toml`, `cpi_config.SUPPORTED_IDS`,
   `data_sources.py`), and refresh `projects/CPI-Webscraper/` from it.
2. Mirror the column in `assets/js/cpi/schema.js` (id, header, source id, kind, first
   month, units, group) and, for FRED, in `SERIES` in `_services/cpi-data-gateway/src/gateway.js`;
   redeploy the gateway.
3. Run `node --test _tools/tests/unit/*.test.mjs` and
   `python -m pytest _tools/tests/test_cpi_parity.py`; the parity test fails on any
   mismatch. Regenerate `fixtures/cpi/sources.json` with `generate.py` if the fixture needs
   the new series.
4. The 19-column CSV contract (decision 4A) changes only with an owner decision: the model
   workbook's formulas reference columns A–S directly.

## 10. Verification status

- Mocked and deterministic: unit, gateway security, parity and browser suites (CI).
- Live, 2026-11-03: the page fetched real Statistics Canada data in Chromium (35 months,
  5 series, CSV with 19 headers); the gateway ran in Cloudflare's local runtime (workerd,
  Wrangler 4.157.0) and a real FRED request with a made-up key returned `key_rejected`.
- **Not verified:** a deployed gateway, a real FRED key, and the GitHub Pages origin
  against a deployed gateway. They need the owner's Cloudflare account and key
  (`_services/cpi-data-gateway/README.md`, steps 4–6). Until then the live page works in
  Canadian-only mode and says so.
