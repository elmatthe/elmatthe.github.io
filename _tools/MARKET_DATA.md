# Market data for the browser tools

Maintainer reference for how the Portfolio Rebalancer and the Stock Comparison &
Analytics web apps get prices and exchange rates, why they get them that way, and how
to test, operate and extend that path. Not published (Jekyll ignores `_tools/`).
Evidence in sections 1–13 was gathered on 2026-11-02. **Section 0 (2026-11-03) is the
current design; where an older section disagrees, section 0 wins.** Provider eligibility
and licensing: `PROVIDER_MATRIX.md`. Listing identity: `INSTRUMENT_IDENTITY.md`.

## 0. Current design (2026-11-03)

**Layers** (`assets/js/market-data/`; Python mirror `_tools/shared_py/market_data/`, copied
into the Rebalancer and Stock desktop apps by `_tools/sync_shared_py.py`, `--check` in CI):

| Module | Role |
|---|---|
| `instruments.js` + `assets/data/instruments.v1.json` | Ticker → `md.instrument.v1` identity (venue, currency, unit), no request. |
| `catalog.js` | The five provider candidates, their plans, coverage, symbol mapping, request cost, known gaps and status per platform; `ROUTES` for *Automatic (route by market)*. |
| `providers/alphavantage.js` | Alpha Vantage client and notice classifier. |
| `providers/quote-adapters.js` | Marketstack, Finnhub (and Massive, deferred) quote adapters with venue and currency checks. |
| `scheduler.js` | Per-provider, per-key request pacing shared across tabs. |
| `http.js` | `DataError` (`md.data-error.v1`) with `kind`, `quotaScope`, `retryable`, redacted provider notice and hint. |
| `index.js` | `createMarketData()`: keys, plans, routing, cache, `priceInstrument`, `estimate`, `crossCheck`, `checkAgain`, FX. |

**Providers.** Alpha Vantage, Marketstack, Finnhub: browser and desktop. Alpaca: desktop
only (its key secret is a trading credential). Massive: deferred (needs the owner's
written confirmation of its Market Data Terms). The user picks one source or *Automatic
(route by market)*: US → Finnhub, Alpaca, Alpha Vantage, Marketstack, Massive; TSX/TSX-V,
London, Xetra, Shanghai/Shenzhen → Alpha Vantage, Marketstack, Finnhub; Cboe Canada →
Marketstack, Finnhub; other venues → Marketstack, Finnhub. Only configured, available
providers are used; falling back to another provider after a failure happens only when the
user opted in. Free and paid plans are both described with their real allowances (no plan
is assumed unlimited); the request estimate is shown before *Get prices*.

**Alpha Vantage notices** (`classifyAvNotice`, fixtures in
`_tools/tests/fixtures/providers/alphavantage-notices.json`), checked in order:
1. *Burst* (spread out / per second / burst / call frequency / per minute) → retried after
   2, 5 and 10 s; **never persisted**, even when the text also mentions "25 requests per day".
2. *Daily*: only "…rate limit is N requests per day" or "…remove all daily rate limits" →
   recorded until 00:00 UTC with the provider's own wording; *Check again* sends one probe.
3. Premium endpoint → entitlement; demo key → authentication; anything else → provider notice.
The legacy persisted `exhausted` flag is ignored. Local counters are labelled as requests
*this browser* sent, not the provider's account-wide quota.

**Scheduler.** Start spacing, gap after each response, a per-minute cap and jitter, per
provider and key fingerprint, coordinated across tabs with Web Locks (timing in
`localStorage` `md.sched.v1.<provider>.<fp>`). Limits are re-checked inside each scheduled
task, so queued requests are not sent after a limit is reached.

**Quote contract `md.quote.v1`.** `canonicalId`, `provider`, `providerSymbol`,
`nativePriceMajorUnits`, `nativeCurrency`, `quoteUnit`, `rawPrice`, `rawCurrency`,
`priceType` (`latest_trading_day`, `eod_close`, `last_trade`, `previous_close`),
`tradingDate`, `asOf`, `retrievedAt`, `cacheStatus`, `entitlement`, `feed`,
`currencyVerified`, `currencyEvidence`, `notes`. Rows show provider, trading date,
currency, unit and price basis. A late answer for a row whose ticker or provider changed is
ignored (revision tokens), and a ticker edit clears its price immediately.

**Keys and storage.** `md.key.v2.<provider>` in `sessionStorage` (cleared with the tab)
unless the user ticks *Remember*, then `localStorage`; *Forget all keys* removes every key
and cache. The old `md.settings.v1` key is migrated once. Caches are namespaced by
provider and key fingerprint (`md.av.v2.<fp>.`, `md.<id>.v2.<fp>.`). Desktop: keys in
memory unless remembered (`files/runtime/keys.json`, mode 600).

**Price comparison** (`compareQuotes`): Consistent ≤ 0.10%, Minor ≤ 1%, otherwise
Investigate with likely causes (different session, venue, currency or adjustment).

**Chart.js** is self-hosted (`assets/vendor/chart.js/4.4.2/`, SRI-pinned, `defer`); no page
contacts a CDN. The browser test harness mocks the Bank of Canada, ECB, Alpha Vantage,
Marketstack and Finnhub, and fails on any other host.

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
  - Falling back from adjusted to plain closes is always stated, and the result's
    metadata and exports report the basis actually used, not the one requested.
  - Every live result carries a note that the window decides frequency and basis,
    so a 3M (daily, unadjusted) and a 6M (weekly, adjusted) result are not
    like-for-like.
  - Several series with different bases are flagged, and "Best total return" reads
    "Not comparable".
  - One-period moves above +80% / −44% are flagged as a possible unadjusted split.
- **Frequency.** 252, 52 or 12 periods per year. Weekly returns are aligned by ISO
  week. The period that may still be trading is excluded. One comparison never mixes
  frequencies.
  - Daily and weekly samples of the same window give the same total return.
  - Their annualized returns differ by exactly 260/252 in log terms, because 52 weeks
    × 5 sessions is 260 sessions but daily data is annualized with 252. This is a
    convention, not an error.
  - Volatility agrees within sampling error.
  - Weekly drawdowns can be shallower, because weekly closes miss troughs inside a
    week.
  - `_tools/tests/unit/analytics-consistency.test.mjs` checks each of these points.
- **FX.**
  - The Bank of Canada publishes CAD per unit once per business day (by 16:30 ET).
  - Pairs not involving CAD are derived as `cadPer[from] / cadPer[to]`, and that is
    labelled.
  - The ECB fallback converts EUR-based rates to the same CAD-per-unit form.
  - Price dates use the latest fixing on or before that date. Prices before the first
    fixing, or more than 7 days after the latest one (stale or missing rates), are
    dropped and reported, never converted with an unrelated rate.
  - With "Normalize to …", a comparison holds only series fully in that currency. A
    series is left out, and named with the reason, when:
    - its currency is unknown (for example a CSV without a Currency column);
    - neither central bank publishes it;
    - fewer than two of its prices have a usable rate.
    It can still be compared in "Native currencies" mode or viewed in Snapshot.
  - In native mode an unknown currency counts as a different currency. With mixed
    currencies, the rankings, chart legends and the regression note say each series
    is in its own currency.
  - Each ticker's native currency, the currency its values are shown in, and the
    conversion source are shown in the metrics table and in every export.
- **Dates.** Imported and provider dates must be real calendar days (`2026-02-30` and
  `2026-04-31` are refused with the file and line; leap days are accepted). They are
  stored as UTC midnight, so the time zone never shifts a date.
- **Freshness.** Alpha Vantage gives a trading day, not a time. A price whose day ended
  within the last 4 days is "last available price"; older is "stale", which is
  flagged. Cached and saved-copy (stale-if-error) values are labelled with their age.

## 7. Caching, quotas and resilience

| Data | Storage | Fresh | Used if refresh fails |
|---|---|---|---|
| Alpha Vantage listing (name/region/currency) | localStorage, per key | 30 days | – (misses kept 1 day) |
| Alpha Vantage quote | localStorage, per key | 15 min | up to 24 h, labelled |
| Alpha Vantage "no data" answer | localStorage, per key | 1 h | – |
| Alpha Vantage history | localStorage, per key, 6 years kept | 12 h | up to 7 days, labelled |
| Alpha Vantage request count (and "limit reached") | localStorage, per key | until the UTC day ends | – |
| Official FX latest | localStorage | 1 h | up to 7 days, labelled |
| Official FX history | localStorage | 12 h | up to 7 days, labelled |

- **Per-key isolation.** Everything fetched with a key lives under
  `md.av.v2.<fingerprint>.<kind>:`.
  - The fingerprint is 32 bits of a string hash of the key. It names the namespace
    and cannot identify or recover the key; the raw key is never part of a storage
    name.
  - Each key has its own client, caches, request count and in-flight requests.
  - Changing or removing the key retires the old key's session. Its requests are
    aborted, and any answer that arrives later is discarded with a `key_changed`
    error. Nothing more is cached for it, and responses saved with any other key are
    deleted.
  - Re-saving the same key keeps everything.
  - A batch (`quotes()` or a Stock comparison) stops on a key change instead of
    mixing two keys.
  - Data from other keys is also removed on page load.
  - Request counts are kept until their UTC day ends, so returning to a key the same
    day does not under-count. Exchange rates need no key and are shared.
- **Quota.** The free key allows 25 requests a day. A new ticker costs about 2 (search
  + data), then 1. Requests are serialized ~1.2 s apart and de-duplicated. The first
  rate-limit, invalid-key or demo-key answer stops the rest of the batch. Reaching the
  daily limit is remembered for that key until the UTC day ends, so reloading does not
  spend another request. A per-key daily counter is shown (it can't see other devices
  using the same key).
- **Network.** 10–15 s timeouts and a 4 MB response cap. Bounded exponential backoff
  with full jitter (≤ 2 retries; Retry-After honoured up to 5 s) for network, timeout,
  429 and 5xx errors only.
- **Storage.** Only market data, per-key request counts and the visitor's key are
  stored. Portfolio holdings and analysis inputs are never stored or sent.
  - If browser storage is unavailable or throws, caches and counts live in memory for
    the page view.
  - Corrupted entries are treated as missing.

## 8. Security notes

- **The key: where it is kept.** The visitor chooses.
  - By default a new key is kept for the current tab only (`sessionStorage`; the
    browser forgets it when the tab closes).
  - "Remember on this device" keeps it in `localStorage` until it is removed.
  - Only one copy is kept: saving one way deletes the other.
  - A key saved in `localStorage` by an earlier build is still loaded.
  - If the chosen storage refuses the write, the key is held in memory for the page
    only; it is never silently written to the other storage.
- **The key: where it goes.** It is sent only to `www.alphavantage.co` over HTTPS, as
  the `apikey` query parameter Alpha Vantage requires. Requests use
  `referrerPolicy: no-referrer` and `credentials: omit`.
  - It is redacted from every message, so it can't reach exports.
  - The settings getter doesn't return it.
  - Tests check that it appears in no other request, result, error, export, storage
    name or storage value.
- **Removing the key.** "Remove key" deletes both copies and every response fetched
  with the key.
- **Same-origin scripts.** Any script running on `elmatthe.github.io` can read both
  storages; the pages say so.
  - The Rebalancer loads no third-party script.
  - The Stock and Monte Carlo pages load only Chart.js 4.4.2 from jsDelivr. It is
    pinned with Subresource Integrity (`sha384-zuFoHkJ6…`, checked against the npm
    tarball), so a modified file is refused. The layout requires `{src, integrity}`
    for every `vendor_js` entry.
  - `chart.umd.js` is the package's own minified build. jsDelivr generates `.min.js`
    on the fly, so that file's hash is not guaranteed.
- **No Content-Security-Policy.** GitHub Pages cannot send CSP headers. A `<meta>`
  CSP would need `'unsafe-inline'` for the site-wide inline script, and could not
  protect other pages on the same origin, which can read the same storage. SRI on the
  only third-party script, no third-party scripts on the Rebalancer, and
  session-only storage by default are the controls used instead.
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
  settings, Cloudflare account or DNS changes. Merging to `main` publishes it as
  before.
- **CI.** `.github/workflows/ci.yml` runs on pull requests to `main` (and on demand),
  with a read-only token and no secrets. Every market-data provider is mocked. It
  runs:
  - unit and reference tests;
  - ZIP and launcher checks;
  - a strict Jekyll build and the four Chromium browser suites;
  - each desktop tool's tests on Linux. The CPI scraper's six Windows-only bootstrap
    tests are excluded there by name.
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
  weekly returns, not ~252 daily ones. Adjusted daily prices are not invented. Live
  results for short and long windows therefore differ in frequency and basis, and
  every live result says so.
- Alpha Vantage's free quote is the latest trading day's price, without an intraday
  timestamp.
- Bank of Canada and ECB rates are indicative daily rates, not executable broker
  rates.
- The desktop apps still use Yahoo Finance through `yfinance` on the user's own
  computer. That is personal use, but Yahoo's terms also restrict automated access;
  desktop users can choose offline CSV mode.
