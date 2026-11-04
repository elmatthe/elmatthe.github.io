# Market-data provider matrix (qualification record)

**Checked:** 2026-11-03, from official documentation, pricing pages, OpenAPI specifications and terms. Each fact was quoted from its source on that date.
**Scope:** price providers for the Portfolio Rebalancer and the Stock Comparison tool, in the browser (GitHub Pages, static, the visitor's own key) and in the desktop apps (the user's own key, on their own computer).
**Rule:** at most five personal-key provider choices; a provider is offered only where its coverage, terms and browser compatibility have been checked. Yahoo Finance through the site's own data gateway (§10) needs no key and is an ordinary entry in the user's ordered source list (`MARKET_DATA.md` §0), position 1 by default; it is not one of the five personal-key providers. (Until 2026-11-03 the tools had an *Automatic (route by market)* mode; the user's list replaced it.)

No API key was used to prepare this record. CORS was probed keyless (HTTP 401 responses still carry CORS headers). Free-plan coverage of individual non-US symbols on Marketstack and Finnhub still needs the owner's bounded live smoke test (see "Open verification" below).

## 1. Verdicts

| Provider | Browser (web pages) | Desktop apps | Why |
|---|---|---|---|
| **Alpha Vantage** | **Enabled** | **Enabled** | Covers US, TSX, TSX-V, London, Xetra and Shanghai/Shenzhen on the free plan; CORS `*`; personal, non-commercial licence fits each visitor using their own key in their own browser. |
| **Marketstack** | **Enabled, with notices** | **Enabled** | CORS `*`; HTTPS on the free plan; end-of-day closes with `price_currency` and exchange MIC in every row. Free plan: 100 requests per month, each symbol counts as one request. Free use is described as "Non-Commercial Use" (pricing page) and "solely for Customer's own testing and evaluation purposes" (APILayer agreement §16(c)); the app says so. Non-US coverage on the free plan is not stated by Marketstack and must be confirmed by a live test. |
| **Finnhub** | **Enabled (US listings)** | **Enabled (US listings)** | CORS `*` for `?token=`; 60 calls per minute free; `/quote` is "real-time quote data for US stocks"; international data is not on the free plan. Personal-use licence. |
| **Alpaca** | **Not offered (security)** | **Enabled (US listings)** | The data API sends CORS headers that would allow a browser call, but authentication is an Alpaca account key ID **and secret**, the same credentials that can place trades. This site does not store trading credentials in web-page storage that any same-origin script can read. On the desktop the key stays in a local file of the user's own computer. Free (Basic) data is the IEX exchange only, not the consolidated US tape, and is labelled so. |
| **Massive** (formerly Polygon.io) | **Deferred (licensing)** | **Deferred (licensing)** | Technically compatible (CORS echoes the origin; Bearer header allowed). Its Market Data Terms §1 (updated 2025-08-28) state: "you may not use the Market Data to build an application intended for use by end users other than you." A public site and a public desktop download that offer a Massive integration conflict with a plain reading of that clause, and the owner would need Massive data to build and test it. The adapter is implemented and tested with mocked responses but is **not offered** until the owner obtains written confirmation from Massive. |

Owner decision needed for Massive: obtain written confirmation that a public open-source client, used by each person with their own personal key, is permitted. Then switch `status` to `enabled` in `assets/js/market-data/catalog.js` and `market_data/catalog.py`.

## 2. Request limits and how requests are counted

| Provider | Free plan | Entry paid plan (not unlimited unless stated) | Batching | Reset | Notes |
|---|---|---|---|---|---|
| Alpha Vantage | 25 requests/day ([support](https://www.alphavantage.co/support/)); per-second burst limit stated only in its notices ("1 request per second") | Premium from 75 requests/minute, $49.99/month, "No daily limits" ([premium](https://www.alphavantage.co/premium/)) | One ticker per request on free keys ("You can specify one ticker per API request"); bulk quotes are premium | Not published; the app uses 00:00 UTC for its own record | Limits arrive as HTTP-200 JSON notices. The 2025-12 and 2026 per-second notices also mention "(25 requests per day)"; see §5. |
| Marketstack | 100 requests/month ([pricing](https://marketstack.com/pricing)); "up to 5 requests per second" | Basic $9.99/month, 10,000 requests/month, overage "+ 0.003996 each" | "if a given API request contains 5 tickers (symbols), 5 API requests will be consumed" ([FAQ](https://marketstack.com/faq)) | Not stated | `/v2/stockprice` (latest intraday price) is Professional plan and above; the app uses `/v2/eod/latest`. |
| Finnhub | 60 calls/minute, plus a 30 calls/second cap on every plan | Market Data Basic $49.99/month, 150 calls/minute, US only; international from Market Data Professional | One symbol per `/quote` | Rolling minute | `/quote` has no currency or exchange field. |
| Alpaca (desktop) | Basic: 200 calls/minute, IEX exchange only | Algo Trader Plus $99/month, 10,000 calls/minute, all US exchanges (SIP) | Multi-symbol endpoints exist; the app sends one symbol per request | Rolling minute | Feed defaults to IEX without a SIP subscription. |
| Massive (deferred) | Stocks Basic: 5 calls/minute, end of day, 2 years of history, US only | Stocks Starter $29/month, "Unlimited API Calls", 15-minute delayed | One ticker per `/prev` | Rolling minute | Not offered (licensing). |

The apps count requests **sent from this browser or computer** per UTC day and per UTC month. That count is shown as exactly that, never as "N of 25 used": the provider counts every use of the key (other devices, other apps), and only the provider's answer is authoritative.

A paid plan is configured by the user as an **entitlement profile** (for example Alpha Vantage Premium 75/min, Marketstack Basic 10,000/month, Finnhub 150/min). The profile only changes pacing and the budget estimate; it never unlocks behaviour the provider has not confirmed, and the apps never assume unlimited use.

## 3. Coverage on the plans the apps use

Coverage is per exchange. A provider listing an exchange does not prove that a particular ETF is covered; each row reports the provider's actual answer.

| Market (MIC) | Alpha Vantage free | Marketstack free | Finnhub free | Alpaca Basic (desktop) | Massive (deferred) |
|---|---|---|---|---|---|
| US (XNYS, XNAS, ARCX, BATS) | ✔ bare symbol | ✔ bare symbol (class shares with a hyphen, `BRK-B`) | ✔ real-time | ✔ IEX trades only | ✔ previous close |
| Toronto (XTSE) | ✔ `VEQT.TRT` | listed in its ticker file (`VEQT.TO`); free-plan coverage not stated | ✘ (paid international) | ✘ | ✘ |
| TSX Venture (XTSX) | ✔ `.TRV` | not checked | ✘ | ✘ | ✘ |
| Cboe Canada (NEOE) | ✘ no suffix | exchange present (`.NE` rows), **YNVD not in its ticker file** | ✘ (paid; symbol `YNVD.NE`) | ✘ | ✘ |
| London (XLON, pence) | ✔ `VOD.LON`, prices in GBX | listed (`VOD.L`), returns `price_currency` | ✘ | ✘ | ✘ |
| Xetra (XETR) | ✔ `SAP.DEX` | listed (`SAP.DE`) | ✘ | ✘ | ✘ |
| Tokyo (XTKS) | ✘ no suffix documented | listed as XJPX (`7203.T`) | ✘ | ✘ | ✘ |
| Shanghai (XSHG) | ✔ `600519.SHH` | listed (`600519.SS`) | ✘ | ✘ | ✘ |
| Indexes | premium | not used | ✘ | ✘ | separate plan |

**The owner's sample (14 holdings):** with free keys, `YNVD.NE` (NVIDIA (NVDA) Yield Shares Purpose ETF on Cboe Canada; Questrade shows it as `YNVD.TO`, the same instrument) is not covered by any enabled provider, and `7203.T` (Tokyo) needs Marketstack. The app names them before any request, keeps the symbols as entered, and withholds the plan unless the user deliberately supplies a labelled price. It never prices YNVD as a TSX symbol (`YNVD.TRT` does not exist). With Alpha Vantage and Finnhub keys the sample needs 8 + 4 requests; with Marketstack alone, 13 of its 100 monthly requests.

## 4. Quote semantics as shown to the user

| Provider | Endpoint | Price shown | Date / time | Currency evidence |
|---|---|---|---|---|
| Alpha Vantage | `GLOBAL_QUOTE` | "Latest price for trading day D" (updated at the end of each trading day on free keys) | trading date only | curated reference, or `SYMBOL_SEARCH` currency for that exact symbol (1 extra request, cached 180 days) |
| Marketstack | `/v2/eod/latest` | End-of-day close for date D (unadjusted `close`) | ISO date | `price_currency` and `exchange` (MIC) in the response; both must match the instrument |
| Finnhub | `/quote` | Last price `c` at time `t` (real-time for US during market hours) | epoch seconds | Finnhub's free `/quote` serves US listings only, which trade in USD |
| Alpaca (desktop) | `/v2/stocks/{symbol}/trades/latest` | Last trade on IEX at time `t` (single exchange, not consolidated) | RFC 3339 time | US listings only (USD) |

Prices are never called "real time" in the apps. The price type, trading date, provider, currency, unit (pence converted) and retrieval time are shown for every holding and in every export.

## 5. Alpha Vantage notices (classification shared by the web and desktop apps)

Fixtures: `_tools/tests/fixtures/providers/alphavantage-notices.json` (verbatim wording from public reports). Order of rules:

1. **Burst:** "spreading out", "per second", "burst", "call frequency", "per minute". Retried after 2, 5 and 10 s; never stored.
2. **Daily:** "rate limit is N requests per day" or "remove all daily rate limits". Stops that key until 00:00 UTC, with the redacted notice and its time; "Check again" sends one request.
3. **Premium endpoint** → entitlement. 4. **Demo key** → authentication.
5. Anything else → shown as a provider notice, not a limit.

## 6. Authentication and browser security

| Provider | How the key is sent | Browser storage | Notes |
|---|---|---|---|
| Alpha Vantage | `apikey` query parameter (the only form) | session storage by default; local storage only if "Remember" | The key appears in the request URL, which developer tools and HAR files can show. Requests use `credentials: "omit"` and `referrerPolicy: "no-referrer"`. |
| Marketstack | `access_key` query parameter (the only form) | as above | Marketstack advises not to expose keys in client-side code; each visitor's key stays in their own browser and is sent only to Marketstack. |
| Finnhub | `token` query parameter (the `X-Finnhub-Token` header form is not allowed by Finnhub's CORS preflight) | as above | Desktop sends the header. |
| Alpaca | `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` headers | **not offered in the browser** | Desktop only: stored in the tool's local `files/runtime/keys.json`, never in the ZIP. |
| Massive | `Authorization: Bearer` header | not offered (deferred) | — |

No shared or owner key exists anywhere in the site or the ZIPs. There is no public proxy or relay; the only server in a price path is the site's own market-data gateway for Yahoo Finance (§10), which holds no key and never receives one. Keys never appear in exports, messages or logs (provider notices that echo a key are redacted).

## 7. Licensing summary (quoted)

- **Alpha Vantage** ToS: "for personal, non-commercial use"; commercial includes use "that allows individuals or entities other than User to access information". Each visitor is the User of their own key.
- **Marketstack:** Free plan "Non-Commercial Use"; APILayer SaaS agreement §16(c): free use "solely for Customer's own testing and evaluation purposes".
- **Finnhub** ToS: "strictly for personal use"; "not redistribute or share access to data … with anyone or any 3rd party without written approval".
- **Alpaca:** data "licensed only for your personal use"; "You cannot provide the data, or derivations of that data, to third parties" (Alpaca staff, community forum, 2026-09-03).
- **Massive** Market Data Terms §1: "you may not use the Market Data to build an application intended for use by end users other than you"; Individuals ToS: "solely for your own personal, non-commercial, and non-business purposes".

Interpretation (owner to confirm): every enabled integration fetches with the visitor's own key, displays the data only to that visitor, and never stores, republishes or shares it. That is the personal-use pattern each licence describes. Massive's §1 is the exception, so it is deferred.

## 8. Not offered (beyond the five)

EODHD and Tiingo send no CORS headers and restrict display; Twelve Data's free plan is "internal non-display"; FMP needs a display agreement for Canada. These are not provider choices. The `yfinance` library is not used anywhere: Yahoo Finance is reached only through the site's gateway (§10), on the web and on the desktop.

## 9. Open verification (owner, with real keys)

Use the redacted procedure in `MARKET_DATA.md` §"Live smoke test". At most one request per instrument per provider.

1. Alpha Vantage: `VEQT.TRT`, `XQQ.TRT`, `HEWB.TRT`, `VFV.TRT`, `CNQ.TRT` quotes on a free key (exchange documented; these ETFs not individually confirmed).
2. Marketstack free key: `VEQT.TO`, `VOD.L`, `SAP.DE`, `7203.T`, `600519.SS`, `YNVD.NE` — does the free plan return non-US end-of-day closes, and with which `exchange` and `price_currency`?
3. Finnhub free key: confirm `/quote?symbol=VEQT.TO` is refused on the free plan.
4. Alpaca (desktop): latest trade for `AAPL` on Basic shows feed IEX.
5. The exact wording of the Alpha Vantage notice the owner saw on 2026-11-03 (never captured).

## 10. Yahoo Finance through the site's data gateway (updated 2026-11-04)

**Authorization (owner's statement, 2026-11-04).** The site owner confirms that their
existing private written permission from Yahoo covers: displaying Yahoo Finance prices to
website visitors; automated retrieval from Yahoo's chart endpoint; retrieval through a
Cloudflare Worker; temporary caching and delivery to multiple visitors; and display of
exchange-supplied data distributed by Yahoo. The permission itself is private: it is not
reproduced, referenced or stored in this repository, the Worker or any answer, and no
grant number or document is recorded here. The 2026-11-03 version of this section
assessed Yahoo's general Terms of Service only, without that permission; it is
superseded by the owner's statement above and is not repeated.

**Activation remains explicit and fail-closed.** The Worker serves data only when its
operator sets `KEYLESS_SOURCE = "yahoo-chart"` and the non-sensitive owner-attestation
flag `OWNER_ATTESTATION = "owner-confirms-yahoo-permission"`. Fresh or forked deployments
(the top-level `wrangler.toml` settings) are switched off; only the owner's
`[env.production]` deployment carries the flag (`_services/market-data-gateway/README.md`,
"Activation"). Switching it off takes one variable change.

**Technical and operational safeguards** (README, "Protecting the data source"): fixed
upstream URL and allowlisted listings; every answer checked for symbol, exchange,
currency, unit and values, refused rather than repaired; honest User-Agent, no cookie,
crumb or address tricks; upstream requests spaced (1 s), queued (15 s max), budgeted (20
per minute per isolate, 40 per minute per location), coalesced and cached (10 min quotes,
12 h history, 30 min refusals); a circuit breaker that stops all upstream requests for
15 minutes after HTTP 429 and 30 minutes after 401/403; clients that send one request at
a time and pause after any slow-down answer. Requests carry only a symbol and a range —
never keys, holdings or account data.

**Display.** Quotes are labelled "latest regular-session price (may be delayed)", with
trading date, retrieval time and cache age, and the plain-language notice *"Quotes may
be delayed, incomplete, or differ from official exchange data. This information is for
research and planning, not financial advice."* Yahoo Finance is not presented as better
or worse than the personal-key providers; the tools emphasise source choice, coverage,
freshness and provenance.

**Cloudflare Workers Free limits** (developers.cloudflare.com, checked 2026-11-04; pages
dated 2026-10-29 and 2026-10-21): 100,000 requests/day (error 1027 above it, no billing),
10 ms CPU per request, 128 MB, 50 subrequests and 6 concurrent outgoing connections per
request; Cache API functional on custom domains; Rate Limiting binding approximate, per
location, period 10 or 60 s, Wrangler ≥ 4.36, plan availability not stated on its page.

**Coverage** (the gateway's fixed list; exchange codes confirmed by the live smoke test,
results in `md-instructions/Handoff.md`): US, Toronto (.TO incl. -U units), TSX Venture,
Cboe Canada (.NE, so YNVD.NE), London (GBp → GBP), Xetra, Euronext Paris and Amsterdam,
SIX, Tokyo, Shanghai, Shenzhen, Hong Kong, ASX. Not served: indexes, FX pairs, futures,
crypto, OTC lines, Bombay/NSE, CSE (.CN), Frankfurt floor (.F), Milan and other exchanges;
Canadian fund codes.

**Deferred providers stay deferred.** Massive's adapter exists but is not offered (§1).

## Sources

Yahoo Finance gateway (§10): https://help.yahoo.com/kb/SLN28256.html (adjusted close) · https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/runtime-apis/cache/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
Alpha Vantage: https://www.alphavantage.co/documentation/ · https://www.alphavantage.co/support/ · https://www.alphavantage.co/premium/ · https://www.alphavantage.co/terms_of_service/
Marketstack: https://marketstack.com/pricing · https://marketstack.com/faq · https://docs.apilayer.com/marketstack/docs/getting-started · https://api.swaggerhub.com/apis/apilayer-863/MarketstackAPIv2/2.0.0/swagger.json · https://marketstack.com/download/v2_eod_tickers_finnworlds_tiingo.xlsx
Finnhub: https://finnhub.io/docs/api/quote · https://finnhub.io/pricing · https://finnhub.io/terms-of-service
Alpaca: https://docs.alpaca.markets/docs/about-market-data-api · https://docs.alpaca.markets/us/docs/market-data-faq · https://docs.alpaca.markets/us/reference/stocklatesttradesingle-1
Massive: https://massive.com/pricing · https://massive.com/docs/rest/quickstart · https://massive.com/legal/individuals-terms-of-service
