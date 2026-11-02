# Market data for the browser tools

Maintainer reference for how the Portfolio Rebalancer and the Stock Comparison &
Analytics web apps get prices and exchange rates, why they get them that way, and how
to test, operate and extend that path. Not published (Jekyll ignores `_tools/`).
Evidence in this file was gathered on 2026-11-02.

## 1. Summary

| Need | Source | Key | Browser access | Licence position |
|---|---|---|---|---|
| Exchange rates (both tools) | Bank of Canada Valet daily average rates | none | `Access-Control-Allow-Origin: *` | Free reuse with attribution ([terms](https://www.bankofcanada.ca/terms/)) |
| Exchange rates, fallback | ECB data API euro reference rates | none | `Access-Control-Allow-Origin: *` | Reuse with source citation ([terms](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)) |
| Prices, live (optional) | Alpha Vantage with **the visitor's own** free key | visitor's | `Access-Control-Allow-Origin: *` | Free tier is personal, non-commercial use; the visitor is the licensee ([terms](https://www.alphavantage.co/terms_of_service/)) |
| Prices, no account | Prices the visitor types (Rebalancer) or CSV files they open (Stock tool) | none | local only | the visitor's own data |
| Demo | Synthetic prices from a fixed seed (Stock tool) | none | local only | not market data, labelled |

There is no server, no proxy, no relay and no secret anywhere in the site. The code
is in `assets/js/market-data/`.

## 2. Why the previous design failed (root cause)

The tools read Yahoo Finance's keyless v8 chart endpoint through public CORS relays.
Yahoo sends no CORS headers, so a browser on `elmatthe.github.io` cannot read it
directly. Each relay failed in a different way on 2026-11-02:

| Relay | Observed | Effect in the browser |
|---|---|---|
| corsproxy.io | HTTP 401 "A valid API key is required" | rejected |
| api.allorigins.win (raw / get) | Cloudflare 520 / nginx 500 after ~12 s | timeout or HTTP error |
| api.codetabs.com | Cloudflare 522 after ~20 s | timeout |
| api.cors.lol | one 200, then HTTP 429 **without** a CORS header | "Failed to fetch" (looks like a network error) |
| query1/query2.finance.yahoo.com directly | HTTP 429 "Edge: Too Many Requests" to this cloud IP, even with an identifying User-Agent | CORS refusal |

Beyond reliability: a relay can alter what it forwards (the old code checked the
payload shape, not the numbers), and Yahoo's terms prohibit automated collection
("using any automated means … without our express, prior permission") and
redistribution. A server of our own in front of Yahoo would fix CORS, not the terms.

## 3. Options evaluated

**A. Browser calls sources that allow it (chosen).** Official FX (Bank of Canada,
ECB) and Alpha Vantage all send `Access-Control-Allow-Origin: *`. No infrastructure,
nothing to deploy, nothing to keep secret. Limitation: live prices need each visitor's
own key.

**B. Owner-deployed gateway (e.g. Cloudflare Worker), rejected for now.** It would
solve CORS and could hold an API key server-side. But it would then show one
licensee's data to every visitor. Every free tier checked forbids that (table in §4),
and Yahoo forbids automated collection outright. Worth revisiting only if the owner
buys a plan that explicitly permits display to the public. The requirements are listed
in §9.

**C. Scheduled GitHub Actions snapshots served as static JSON, rejected for prices.**
This is redistribution of provider data, with the same licence problem as B. Official
FX doesn't need it, because the central banks are already keyless and CORS-enabled.

**Scrapling (D4Vinci/Scrapling v0.5, BSD-3) was evaluated and is not used.** It is
Python, so it can't run in GitHub Pages or a Worker. Its HTTP fetcher needs the
`[fetchers]` extra (curl_cffi, playwright, patchright; ~112 MB), and by default
impersonates a Chrome TLS fingerprint with a fake Google referer. Its distinctive
features (stealth browser, Cloudflare/Turnstile solving, fingerprint spoofing, proxy
rotation) are bot-protection evasion, which is out of bounds here. For JSON/CSV APIs
it adds nothing over `requests` or `fetch`: its retry fires only on transport errors,
not on 429/5xx.

## 4. Free provider comparison (2026-11-02)

CORS was checked with `curl -H "Origin: https://elmatthe.github.io"`. For keyed
providers, only unauthenticated error responses could be seen. Licence quotes are
from each provider's own terms or pricing pages.

| Provider | Key | Free quota | CORS seen | TSX (free) | Mutual funds | Adjusted history | Public display / redistribution |
|---|---|---|---|---|---|---|---|
| Yahoo v8 chart (unofficial) | no | undocumented; 429 here | none | yes | US | yes | Prohibited: automated collection and redistribution |
| Stooq | captcha-issued key since ~2026 | daily cap | not observable | old format | no | unverified | terms not found |
| Twelve Data | yes | 8/min, 800/day | `*` | no (paid plan) | paid | US | Basic = internal non-display use |
| **Alpha Vantage** | yes | **25/day** | `*` | **yes** (`.TRT`, `.TRV`) | US funds | weekly/monthly adjusted free; daily adjusted premium | personal, non-commercial |
| Financial Modeling Prep | yes | 250/day | `*` | no | unverified | 5 y | personal use; display needs a licence |
| Tiingo | yes | 1,000/day | none | no | US | yes | internal use only |
| Finnhub | yes | 60/min | `*` | no | premium | premium | personal use; no redistribution |
| EODHD | yes | 20/day | missing on 401 | yes | unverified | 1 y | no redistribution or display |
| Massive (ex-Polygon) | yes | 5/min | echoes origin | no | no | 2 y | display = redistribution |
| Marketstack | yes | 100/month | `*` | unverified | no | 1 y | non-commercial |
| **Bank of Canada Valet** | no | not published | `*` | – | – | FX from 2017 | free reuse with attribution |
| **ECB data API** | no | not published | `*` | – | – | FX from 1999 | reuse citing the ECB |
| Frankfurter | no | fair use | `*` | – | – | ECB-based | third-party wrapper, not used |
| FRED | yes | not published | none | – | – | – | attribution; some series third-party |
| Statistics Canada WDS | no | 25 req/s per IP | `*` | – | – | – | Open Licence (CPI tool; desktop) |

Conclusion: no free equity source permits showing prices to anonymous visitors.
Alpha Vantage is the only free tier with TSX/TSX-V coverage, so it is the
bring-your-own-key provider.

## 5. Coverage

| Instrument | Live (visitor key) | CSV import | Notes |
|---|---|---|---|
| US stocks/ETFs (AAPL, MSFT, NVDA, SPY, VTI) | yes | yes | |
| TSX/TSX-V (RY.TO, TD.TO, VEQT.TO, XEQT.TO, VFV.TO, XIU.TO, GPV.V) | yes, mapped to `.TRT` / `.TRV` | yes | Currency taken only from Alpha Vantage's symbol search |
| Class shares (BRK-B, BRK.B, BBD-B.TO) | passed through | yes | provider symbol forms vary |
| London (`.L` → `.LON`), Xetra (`.DE` → `.DEX`), Bombay, Shanghai/Shenzhen | yes | yes | pence (GBX) → GBP ÷100 |
| US mutual funds (e.g. VFIAX) | provider states support; unverified without a key | yes | |
| Canadian fund codes (TDB902, RBF556) | **no** (no free source documents them) | yes | enter or import prices |
| Indexes (^GSPC, ^GSPTSE) | **no** (Alpha Vantage index data is premium; S&P index data is licensed by S&P DJI) | yes | use an ETF (SPY, XIU.TO) as an explicit choice |
| Other exchanges (Tokyo `.T`, Paris `.PA`, Sydney `.AX`, Hong Kong `.HK`) | no | yes | refused with a message, no request |
| FX for 24 currencies + EUR | Bank of Canada; ECB fallback | n/a | crosses derived through CAD |

## 6. Conventions

- **Prices.** A price must be finite and > 0. A zero or missing price is never treated
  as a $0 security: the Rebalancer stops and asks for that price, and the Stock tool
  skips the observation.
- **Currency.** The quote's currency comes from the provider's listing (Alpha Vantage
  `SYMBOL_SEARCH`), never inferred from the suffix. If the listing isn't confirmed,
  the Rebalancer keeps the typed price. Minor units (GBX/GBp, ZAc, ILA) are divided
  by 100 and the conversion is reported.
- **Adjusted vs unadjusted.** Each series uses one basis; adjusted and unadjusted
  values are never mixed. The Stock tool lets you choose "Adjusted close (total
  return)" or "Close (price return)", and shows the basis per ticker, in exports and
  in the workbook.
  - Live data uses Alpha Vantage daily closes (as traded, not adjusted for splits or
    dividends) for windows of up to 135 days, and weekly adjusted closes (splits and
    dividends) for longer windows.
  - Falling back from adjusted to plain closes is always stated.
  - One-period moves above +80% / −44% are flagged as a possible unadjusted split.
- **Frequency.** 252, 52 or 12 periods per year. Weekly returns are aligned by ISO
  week. The period that may still be trading is excluded.
- **FX.**
  - The Bank of Canada publishes CAD per unit once per business day (by 16:30 ET).
  - Pairs not involving CAD are derived as `cadPer[from] / cadPer[to]`, and that is
    labelled.
  - The ECB fallback converts EUR-based rates to the same CAD-per-unit form.
  - Price dates use the latest fixing on or before that date. Prices before the first
    fixing are dropped and reported, never left unconverted.
- **Freshness.** Alpha Vantage gives a trading day, not a time. A price whose day ended
  within the last 4 days is "last available price"; older is "stale", which is
  flagged. Cached and saved-copy (stale-if-error) values are labelled with their age.

## 7. Caching, quotas and resilience

| Data | Storage | Fresh | Used if refresh fails |
|---|---|---|---|
| Alpha Vantage listing (name/region/currency) | localStorage | 30 days | – (misses kept 1 day) |
| Alpha Vantage quote | localStorage | 15 min | up to 24 h, labelled |
| Alpha Vantage "no data" answer | localStorage | 1 h | – |
| Alpha Vantage history | localStorage, 6 years kept | 12 h | up to 7 days, labelled |
| Official FX latest | localStorage | 1 h | up to 7 days, labelled |
| Official FX history | localStorage | 12 h | up to 7 days, labelled |

- **Quota.** The free key allows 25 requests a day. A new ticker costs about 2 (search
  + data), then 1. Requests are serialized ~1.2 s apart and de-duplicated. The first
  rate-limit, invalid-key or demo-key answer stops the rest of the batch. A per-browser
  daily counter is shown (it can't see other devices using the same key).
- **Network.** 10–15 s timeouts and a 4 MB response cap. Bounded exponential backoff
  with full jitter (≤ 2 retries; Retry-After honoured up to 5 s) for network, timeout,
  429 and 5xx errors only.
- **Storage.** Only market data and the visitor's key are stored. Portfolio holdings
  and analysis inputs are never stored or sent.

## 8. Security notes

- **The key.** It is entered by the visitor, kept in their own localStorage (removable
  in Settings), and sent only to `www.alphavantage.co` over HTTPS. It is redacted from
  every message, so it can't reach exports.
- **Request URLs.** Built with `URLSearchParams` from validated symbols (pattern-checked;
  path, query and whitespace characters rejected). FX series codes come from fixed
  allow-lists. No user-supplied URLs are fetched.
- **Rendering.** All DOM output uses `textContent`, with no `innerHTML`, `eval` or
  `new Function` in the browser modules.
- **CSV import and exports.** Imported CSVs are read locally, limited to 8 MB and
  200,000 rows, and parsed as text. Exports neutralize spreadsheet formulas (a leading
  `= + - @` tab or CR is prefixed with `'`).
- **Hosts.** The pages contact only `www.bankofcanada.ca`, `data-api.ecb.europa.eu`,
  `www.alphavantage.co` (with a key) and `cdn.jsdelivr.net` (Chart.js). The browser
  tests block and fail on any other host.

## 9. Deployment, configuration and operations

- **GitHub Pages.** Nothing to configure. The site needs no secrets, repository
  settings, Actions workflows, Cloudflare account or DNS changes. Merging to `main`
  publishes it as before.
- **Visitors.** Live prices are optional. A visitor who wants them gets a free key at
  https://www.alphavantage.co/support/#api-key and pastes it into the Rebalancer's
  "Live prices" panel or the Stock tool's Settings tab.
- **Outages.**
  - Bank of Canada down: the ECB is used automatically.
  - Both down: the last saved rates (≤ 7 days, labelled) are used. In the Rebalancer,
    built-in rates dated 2026-10-30 are flagged in the plan and can be overwritten.
  - Alpha Vantage down or out of quota: typed prices, CSV files and the demo keep
    working. Saved copies are labelled.
- **Refreshing the built-in FX estimates.** These are used only before official rates
  load. Update `DEFAULT_FX_AS_OF` and `fxToUsd` in
  `assets/js/portfolio-rebalancer/engine.js` and the matching values in
  `projects/portfolio-rebalancer-tool/scripts/portfolio_rebalancer/fx.py` (USD per
  unit = `FX<CODE>CAD / FXUSDCAD` from Valet). Then run the parity tests.
- **If the owner ever licenses a display-permitted feed (option B).**
  - Deploy a Worker that builds upstream URLs itself; never accept a URL from a client.
  - Allow-list the origin `https://elmatthe.github.io`.
  - Validate symbols and date ranges.
  - Cap symbols per request and response size.
  - Cache (quotes ~1 min, history ~12 h) with stale-if-error.
  - Rate-limit per IP.
  - Keep the provider key as a Worker secret.
  - On the free plan, the 100,000 requests/day limit means no charges are possible.
  - Then add a provider adapter (below) ahead of Alpha Vantage.

## 10. Adding a provider

1. Add `assets/js/market-data/providers/<name>.js`. Export pure parsers (body →
   contract objects, using `validateQuote` / `validateHistory`) and a client that
   uses `fetchText`, `httpError` and `withRetry`. Map every provider error, including
   HTTP-200 error bodies, to a `DataError` kind.
2. Get the listing currency from the provider itself.
3. Wire the provider into `createMarketData()` in `index.js` (caching, de-duplication
   and quota handling live there).
4. Add fixtures with the provider's exact response shapes (synthetic values) to
   `_tools/tests/unit/fixtures.mjs`, unit tests, and a mock route in
   `_tools/tests/browser/harness.js`. Add the host to `ALLOWED_HOSTS` there.
5. Record the provider's licence for public display in §4 before enabling it.

## 11. Testing

```bash
node --test _tools/tests/unit/*.test.mjs                 # market-data, FX, CSV, Monte Carlo engine (no network)
cd _tools/tests && python3 -m pytest -q -m "not e2e"     # parity + numpy/scipy references + bootstrap
# browser suites: see _tools/README.md (all market-data hosts are mocked)
NODE_USE_ENV_PROXY=1 node _tools/tests/live_fx_matrix.mjs           # OPTIONAL live: BoC vs ECB, 2 requests
cd _tools/tests/browser && node live.test.js                       # OPTIONAL live: real FX in Chromium
ALPHAVANTAGE_KEY=yourkey node live.test.js                         # OPTIONAL: also Alpha Vantage (≈6 requests)
```

Live checks are opt-in and small. Never commit a key.

## 12. Troubleshooting CORS

- "Failed to fetch" or a network error in the browser while curl works almost always
  means the response lacked `Access-Control-Allow-Origin`. Rate-limit and error pages
  from CDNs often omit it. Check with
  `curl -sD - -o /dev/null -H "Origin: https://elmatthe.github.io" <url>`.
- A terminal request succeeding does not prove a browser can read the response. The
  browser enforces CORS; Python and curl don't.
- Don't add public CORS relays back. They fail unpredictably, can alter data, and
  don't change a provider's terms.

## 13. Known limitations

- Live equity prices need each visitor's own free key (25 requests a day). Without
  one, the tools use typed prices, CSV files or the demo.
- No free source is available for market indexes or Canadian mutual-fund codes.
- Free Alpha Vantage daily data is as traded (unadjusted) and limited to ~100
  sessions. Longer windows use weekly adjusted data, so a 1Y live comparison has ~52
  weekly returns, not ~252 daily ones.
- Alpha Vantage's free quote is the latest trading day's price, without an intraday
  timestamp.
- Bank of Canada and ECB rates are indicative daily rates, not executable broker
  rates.
- The desktop apps still use Yahoo Finance through `yfinance` on the user's own
  computer. That is personal use, but Yahoo's terms also restrict automated access;
  desktop users can choose offline CSV mode.
