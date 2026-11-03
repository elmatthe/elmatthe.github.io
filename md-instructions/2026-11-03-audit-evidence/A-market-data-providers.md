# Appendix A — Market-data provider research (browser and desktop)

**Provenance:** sub-audit by the provider-research workstream, 2026-11-03, HEAD `ada2ceb`.

**Lead-auditor spot check.** The 2026 burst-notice wording appears verbatim four times in the saved GitHub issue bodies (`audit/providers/raw/gh-search-av-notices*.txt`). The site's classifier output for every wording is in `raw/av-classification-at-ada2ceb.txt` and is reproduced in A.3.

**Evidence location:** scratchpad folder `audit/providers/`:
- `raw/` holds one file per HTTP probe (headers and body).
- `raw/pages/` holds saved docs, pricing and terms pages.
- `scripts/` holds `probe.sh` and `classify_av_notices.mjs`.

**Bounds.** No real keys or accounts were used: only keyless calls or documented demo keys, spaced 2–3 s apart. One host, the twelvedata.com docs, received about 18 static page fetches, above the ~10 guideline, because its docs are split into many small files.

## A.1 Key conclusions

1. **The incident's most probable cause is now confirmed against Alpha Vantage's published wording.**
   - The 2026 burst notice reads: "…spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans … to lift the free key rate limit **(25 requests per day)**, raise the per-second burst limit, and instantly unlock all premium endpoints".
   - The December 2025 version also contains "(25 requests per day)".
   - Both versions are classified by `alphavantage.js:81` as the **daily** limit (definitive) and persisted.
   - Whether the owner's browser received this notice or a genuine daily notice remains UNVERIFIED without the owner's evidence (report §4.5).
2. **Free + anonymous + automatic + international is not achievable** within the constraints: no paid APIs, no shared keys, no relays, no scraping, licences respected. The only free source that documents Canadian, European and Chinese listings *and* answers browsers is Alpha Vantage, with the visitor's own key, at 25 requests per day.
3. **Twelve Data's free plan is non-display, so it is excluded even with the visitor's own key.** Its pricing page says: "Internal non-display usage — Data may be used internally for testing, evaluation, or development purposes only. The data cannot be displayed to users, shared externally, or used in production systems." Its Basic plan is US-only (`/exchanges?show_plan=true`): TSX, TSXV, NEO, LSE and XETR are Grow; JPX, SSE and SZSE are Pro.
4. **Browser CORS observed** (each probe sent `Origin: https://elmatthe.github.io`):
   - Alpha Vantage, Twelve Data, FMP, Finnhub, Marketstack, StockData, Alpaca, Tradier, Intrinio and MarketData.app send `*`.
   - Massive echoes the origin.
   - **EODHD sends none, even on a 200.** Tiingo and OpenFIGI send none either.
   - Stooq reset the connection.
5. **The desktop apps use yfinance 1.7.0.** Yahoo's terms forbid automated collection "without our express, prior permission".
6. **Stooq now requires a CAPTCHA-issued key** (since about March 2026). **pandas-datareader 0.11** removed its Yahoo, Stooq, Tiingo, Alpha Vantage, IEX and Quandl readers.
7. **Scrapling 0.5** (BSD-3) is a stealth and anti-bot-evasion toolkit. It has no compliant role here.

## A.2 public-apis "Finance" section (saved `raw/public-apis-finance.md`)

A listing in this directory is not evidence that a service works, and the list's self-reported CORS column is unreliable: it says EODHD is "Yes" (observed: none) and Alpha Vantage "Unknown" (observed: `*`).

| Entry | Decision | Reason |
|---|---|---|
| Alpha Vantage | **Keep** | Only free international source that works in a browser |
| Finnhub | **Keep** | US real-time quotes |
| Polygon → Massive | **Keep** (optional) | US end-of-day |
| OpenFIGI | Identity only (desktop) | No CORS |
| EODHD | Desktop only | No CORS observed |
| Marketstack | Drop | 100 requests per month |
| Alpaca | Drop | Trading-account key and secret; US only |
| FMP | Drop | Canada only on Premium; display needs a licensing agreement |
| Intrinio | Drop | No free plan |
| StockData.org | Drop | US IEX data only; 3 symbols per request |
| Tradier | Drop | Brokerage account; Partner status needed for public apps |
| Twelve Data | Drop | Free plan is non-display |
| IEX Cloud | Drop | Shut down |

**Not security-price APIs (dropped):** banking, payments and tax APIs; filings and fundamentals; macro data (FRED etc.); prediction markets; signals and news; metals; brokers. A Yahoo-reselling API ("yahoofinanceapi.com") was dropped as well, because Yahoo's terms prohibit reselling its data.

**Also evaluated:** Tiingo, MarketData.app, Stooq, yfinance, pandas-datareader, J-Quants.

## A.3 Alpha Vantage specifics

**Notice texts, verbatim** (sources are public GitHub issue reports that quote the response JSON):

| Notice | Field | Text | Source |
|---|---|---|---|
| Burst (2026) | Information | "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints" | GeneBO98/tradetally#202 (2026-02-05); williamkray/maubot-financebot#2 (2026-03-12) |
| Burst (Dec 2025) | Information | "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day) and instantly unlock all premium endpoints" | beancount/beanprice#124 (2025-12-13) |
| Daily | Information | "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits." | home-assistant/core#109153 (2024-01-30); finance-quote#361 (2024-03-12) |
| Daily (variant) | Information | "We have detected your API key as {token} and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits." | few-letter/few-be#989 (2026-06-27) |
| Premium endpoint | Information | "Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints" | tradetally#202 |
| Demo key | Information | "The **demo** API key is for demo purposes only. Please claim your free API key at (https://www.alphavantage.co/support/#api-key) to explore our full API offerings. It takes fewer than 20 seconds." | Live probe `av-3`, 2026-11-03 |
| Missing/invalid key | Error Message | "the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds." | Live probe `av-4`; AlphaVantage.jl#44 |
| Invalid symbol | Error Message | "Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for TIME_SERIES_DAILY." | nisba-rates#2 (2026-10-24); RomelTorres/alpha_vantage#386 (2026-04-30) |
| Legacy (before 2024) | Note | "…Our standard API call frequency is 5 calls per minute and 500 calls per day…" | — |

**What the site's classifier does with each wording** (HEAD `ada2ceb`):
- Both burst versions become `rate_limited`, definitive, with the daily message. **Wrong.**
- Every other wording is handled correctly: daily, daily variant, premium, demo, missing key, invalid symbol and legacy Note.

**Proposed classifier:** check burst wording **first**, then daily-specific wording.

```js
const BURST = /spreading out|per[- ]second|burst|call frequency/i;
const DAILY = /rate limit is \d+ requests per day|remove all daily rate limits/i;
```

- On a burst notice, back off for at least 2 s, then 10–20 s, and **never** persist the exhausted state.
- Use all nine wordings above as unit fixtures.
- Show the user Alpha Vantage's original text. Its support page asks wrapper libraries to preserve it.

**Limits:**

| Limit | Value | Status |
|---|---|---|
| Daily | 25 requests | Support FAQ and premium page |
| Per second | 1 request | Notice text only |
| Per minute | Third parties say 5 | UNVERIFIED |
| Per key vs per IP | Not published | UNVERIFIED |
| Reset time | Not published | UNVERIFIED |
| Premium plans | 75–1,200 requests/min, no daily limit, from $49.99/month | Premium page |

**Spacing and reset proposals:**
- Space requests from the end of the previous response, or at least 2 s start-to-start.
- Share that spacing across tabs and both tools with a per-key lock, for example the Web Locks API or a BroadcastChannel.
- Store the timestamp at which the limit was hit. Allow a user-initiated retry, plus one automatic probe after 00:00 UTC.

**"Unlimited requests for verified open-source or educational projects."** The support page mentions it, but publishes no criteria or process.
- ToS §3 makes the licence "non-sublicensable, non-transferable".
- ToS §2(iii) counts as commercial any use that provides information so that "individuals or entities other than User" can access it.
- **Embedding such a key in public JavaScript is not permitted without Alpha Vantage's written agreement.** The owner may ask support@alphavantage.co for written permission naming the site, the client-side exposure and display to anonymous visitors.

**Endpoints:**

| Endpoint | Status |
|---|---|
| `GLOBAL_QUOTE` | **Free**, 1 symbol per call, "updated at the end of each trading day" by default; returns a trading date with no time. Realtime/delayed entitlements are premium. |
| `SYMBOL_SEARCH` | **Free**; returns region, timezone and currency. The timezone field showed summer offsets in November, so don't rely on it. |
| `TIME_SERIES_DAILY` (compact, 100 points) | **Free** ("full" output is premium) |
| `TIME_SERIES_DAILY_ADJUSTED` | **Premium**, even though the demo key returns data |
| Weekly, monthly and their adjusted variants | **Free** (no premium label) |
| `REALTIME_BULK_QUOTES` | **Premium** |
| `INDEX_DATA` | **Premium** |

**Suffixes:**
- Documented: `.LON`, `.TRT`, `.TRV`, `.DEX`, `.BSE`, `.SHH`, `.SHZ`.
- Observed in search results: `.FRK` (Frankfurt).
- Tokyo: no documentation or evidence.
- Cboe Canada (NEO): no documentation.

**Terms of Service (PDF, saved):**
- §2: personal, non-commercial use only. Use is commercial if it: (i) goes beyond private and individual activity; (ii) is on behalf of an entity; (iii) lets others access the information; or (iv) involves an affiliation with a financial firm.
- §3: the licence is non-exclusive, non-sublicensable, non-transferable and revocable.
- The terms say nothing about caching, attribution or display.
- **Implication:** a visitor using their own key in their own browser fits these terms. The site must never serve one visitor's data to anyone else.

## A.4 Provider matrix (29 fields; condensed)

Legend: CORS = observed `Access-Control-Allow-Origin` for `Origin: https://elmatthe.github.io`.

| Provider | Free plan, quota and reset | Key | Free quotes | Free history | US | TSX / TSX ETFs / TSX-V | Europe (Xetra) | Japan | London | China | Mutual funds | Indexes | Delay / timestamp | Currency in quote | Adjustments | CORS | Python | Public-site use with visitor key | Restrictions | Cost for 10 / 14 symbols | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Alpha Vantage** | 25/day; 1/s burst; reset time not published | yes | `GLOBAL_QUOTE` | daily compact (as traded), weekly/monthly adjusted | ✔ | ✔ `.TRT` / ETFs searchable (specific ETFs UNVERIFIED) / ✔ `.TRV` | ✔ `.DEX` | ✘ | ✔ `.LON` (GBX ÷ 100) | ✔ `.SHH` / `.SHZ` | US via search; no Fundserv | premium | end of day; trading date only | no (`SYMBOL_SEARCH` has it) | weekly/monthly adjusted; daily adjusted is premium | `*` | ✔ | ✔ (visitor is the licensee) | personal, non-commercial; non-transferable | first run 20–30 / 28–42; refresh 10 / 14 | **Keep (primary)** |
| **Finnhub** | 30/s cap; free per-minute quota UNVERIFIED | yes (`token=` query parameter in browsers) | `/quote` US only | candles premium | ✔ real-time | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | real-time; epoch `t` | no (`/stock/profile2` has it) | — | `*` (errors observed) | ✔ | ✔ | "strictly for personal use"; no sharing | 10 / 14 (US rows only) | **Keep (US)** |
| **Massive** (formerly Polygon) | Stocks Basic $0: 5/min, 2 years end of day; Indices Basic "limited tickers" | yes | previous close / end of day | 2 years | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | limited | end of day | — | — | echoes origin | ✔ | ✔ | personal, non-business; no key sharing | 14 at 5/min ≈ 3 min (US only) | **Keep (US, optional)** |
| **Twelve Data** | 8/min, 800/day | yes | `/quote` (currency, MIC, datetime) | `/time_series` | ✔ | Grow (paid) | Grow | Pro | Grow (GBp) | Pro | Grow (Morningstar IDs) | UNVERIFIED | real-time US | **yes** | `adjust=splits` default | `*` | ✔ | **no — Basic is non-display** | ToS §2.3(l) no commercial use; §2.2(e) display needs authorisation; §2.3(g) caching limits | 14 credits ≈ 2 min | **Exclude (licence)** |
| **FMP** | 250/day, 500 MB per 30 days | yes | Basic end of day (scope unclear) | 5 years end of day | ✔ | Premium ($69) | Ultimate | Ultimate | Premium | Ultimate | UNVERIFIED | UNVERIFIED | end of day | — | — | `*` (errors) | ✔ | display needs a licence agreement | — | — | **Exclude** |
| **EODHD** | 20/day + one-time 500; 20/min; resets midnight GMT | yes | live (15-min delayed) | 1 year end of day | ✔ | claimed | claimed | not listed | claimed | claimed | UNVERIFIED | claimed | 15-min delay | no | `adjusted_close` | **none** | ✔ | n/a (browser) | non-professional users may not display or grant access to others | 14 of 20 | **Desktop only** |
| **Tiingo** | 50/hour, 1,000/day, 500 unique symbols/month | yes | IEX (US) | end of day | ✔ | ✘ | ✘ | ✘ | ✘ (ADR only) | ✔ SHG/SHE | ✔ US (27,029) | ✘ | end of day | in keyless symbol list | ✔ | **none** | ✔ | n/a | "Internal Use Only… may not display or share" | 14 | **Desktop only** |
| **Marketstack** | **100 per month** | yes | end of day | 1 year | ✔ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | `.INDX` | end of day | — | — | `*` | ✔ | non-commercial | — | exhausted in a week | **Exclude** |
| **StockData.org** | 100/day; 3 symbols per request | yes | US (IEX) | 1 month | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — | — | — | `*` | ✔ | personal | — | — | **Exclude** |
| **Alpaca** | IEX feed, 200/min | key + secret | US | US | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — | — | — | `*` | ✔ | secret would sit in the browser | trading account | — | **Exclude** |
| **Tradier** | sandbox, 15-min delayed | brokerage token | US | US | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — | — | — | `*` | ✔ | Partner status needed | — | — | **Exclude** |
| **Intrinio** | trial only | yes | — | — | ✔ | — | — | — | — | — | — | — | — | — | — | `*` | ✔ | "No redistribution or display" | — | — | **Exclude** |
| **MarketData.app** | 100 credits/day; **24-hour delayed** | yes (keyless AAPL demo) | US | US | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ | US funds | — | 24 h delay | — | — | `*` | ✔ | "own personal non-professional use" | — | 14 | **Alternate only** |
| **OpenFIGI** | 25 requests/min, 10 lookups each, no key | optional | identity only | — | ✔ | ✔ (GPV TSX-V: no match) | ✔ | ✔ | ✔ | ✔ | — | — | — | **no currency** | — | **none** | ✔ | n/a | FIGIs public domain | 1–2 requests | **Identity only (desktop)** |

**Keyless coverage checks.**
- **Twelve Data reference data** (plan shown by `show_plan=true`):

  | Symbol | Venue(s) | Plan |
  |---|---|---|
  | VEQT, XQQ, VFV | TSX and NEO | Grow |
  | HEWB | TSX | Grow |
  | YNVD | **NEO only** | Grow |
  | 7203 | JPX | marked Basic, but the JPX exchange is Pro, so it is a trial symbol, not free Japan coverage |
  | SAP | XETR | Grow |
  | VOD | LSE | Grow, currency `GBp` |
  | 600519 | SSE | Pro |

  Twelve Data's name for HEWB on TSX is wrong, so use FIGI/ISIN for identity, not provider names.
- **Tiingo `supported_tickers.zip`:** US, 27,029 US mutual funds, SHG/SHE; no TSX, Xetra, LSE or Tokyo.
- **OpenFIGI:** mapped all 9 non-US test listings; GPV on TSX-V had no match.

## A.5 Desktop-specific assessment

- **yfinance 1.7.0** (Apache-2.0). Its README says Yahoo's API "is intended for personal use only". Yahoo's terms forbid automated collection and redistribution without permission.
  - **Not compliant under the brief's constraints.**
  - Options: migrate the desktop apps to visitor-key providers plus CSV, or keep yfinance only as an explicit opt-in labelled "unofficial source". This is the owner's decision (DEC-05 in the main report).
- **Stooq:** needs a CAPTCHA-issued key and browser verification. Automating around them would be anti-bot evasion, so **exclude it**. A user may import a manually downloaded CSV.
- **Scrapling 0.5:** stealth browsers, Cloudflare Turnstile handling, proxy rotation. **No compliant role.**
- **pandas-datareader 0.11:** equity readers were removed; macro readers only.
- **Official sources:**
  - **TMX:** no free price API.
  - **ETF issuer NAV files:** **NAV is not a market price.** ETFs trade at a premium or discount to NAV, at a different time. Use NAV only if it is labelled as such.
  - **Canadian mutual funds:** NAVPS *is* the transaction price, so issuer NAV is correct, but no free API covers Fundserv codes. Use CSV or a labelled manual entry.
  - **J-Quants (Japan):** the free plan is delayed 12 weeks.

## A.6 Recommendation (no more than five; not padded)

**Browser: 3 providers, all keyed to the visitor**

| # | Provider | Role | Limits |
|---|---|---|---|
| 1 | **Alpha Vantage** | Primary; US, TSX, TSX-V, LSE, Xetra, SSE/SZSE | 25 per day, 1 per second; end-of-day quotes. **Fix the classifier first.** |
| 2 | **Finnhub** | US real-time quotes; cross-check source for US listings | US only; no currency field; per-minute quota UNVERIFIED |
| 3 | **Massive** | US end-of-day, 2 years of history; optional second US cross-check | 5 per minute |

**Desktop: 4 price providers plus 1 identity service**

| # | Provider | Notes |
|---|---|---|
| 1 | Alpha Vantage | — |
| 2 | **EODHD** | Global end-of-day coverage claimed (UNVERIFIED on a free key). 20 per day covers one 14-symbol refresh. |
| 3 | **Tiingo** | 1,000 per day; US including mutual funds, plus China |
| 4 | Finnhub | — |
| + | **OpenFIGI** | Identity only |

### A.6.1 Coverage by market on free keys

| Market | Alpha Vantage | Finnhub | Massive | EODHD (desktop) | Tiingo (desktop) |
|---|---|---|---|---|---|
| US stocks and ETFs | ✔ documented | ✔ real-time | ✔ end of day | ✔ observed | ✔ |
| TSX ETFs (VEQT, XQQ, VFV, HEWB) | exchange ✔; ETFs UNVERIFIED | ✘ | ✘ | claimed | ✘ |
| YNVD (Cboe Canada) | ✘ (no suffix; site refuses `.NE`) | ✘ | ✘ | UNVERIFIED | ✘ |
| TSX-V | ✔ `.TRV` | ✘ | ✘ | claimed | ✘ |
| Xetra | ✔ `.DEX` | ✘ | ✘ | claimed | ✘ |
| Tokyo | ✘ no evidence | ✘ | ✘ | not listed | ✘ |
| London | ✔ `.LON` | ✘ | ✘ | claimed | ✘ |
| Shanghai | ✔ `.SHH` | ✘ | ✘ | claimed | ✔ |
| Canadian mutual funds | ✘ | ✘ | ✘ | UNVERIFIED | ✘ |
| Indexes | ✘ premium | ✘ | limited | claimed | ✘ |

### A.6.2 Daily budget for the 14-symbol portfolio

| Provider | Budget |
|---|---|
| Alpha Vantage | First run 28–42 requests (cannot finish on day 1); refresh 14, leaving 11 spare per day |
| Finnhub | 14 per refresh (US rows only) |
| Massive | 14 at 5 per minute ≈ 3 min (US only) |
| EODHD | 14 of 20 per day |
| Tiingo | 14 per refresh; currency comes free from the keyless list |

Cross-provider comparison: at most once per day, bounded by Alpha Vantage.

**Ways to stretch Alpha Vantage:**
- Cache the listing currency for about 180 days.
- Skip the stem-search fallback unless the user asks for it.
- Accept a currency already confirmed in an earlier run or in the visitor's CSV, instead of calling `SYMBOL_SEARCH` again.

## A.7 Changes since `_tools/MARKET_DATA.md` (2026-11-02)

**Confirmed unchanged:**
- **Alpha Vantage:** 25 per day, CORS `*`, weekly adjusted free, daily adjusted premium.
- **FMP:** 250 per day, no free Canada.
- **Finnhub:** CORS `*`.
- **Massive:** echoes the origin; 5 per minute; 2 years.
- **Marketstack:** 100 per month.
- **Tiingo:** 1,000 per day, no CORS.
- **Stooq:** CAPTCHA key required.

**New or corrected:**
- **EODHD** sends no CORS header even on success. It has a one-time bonus of 500 calls, 15-minute delayed live data, and a midnight-GMT reset.
- **Twelve Data Basic** is proven US-only and non-display.
- **Tiingo** limits 50 per hour and 500 unique symbols per month, and covers China and US funds.
- **Massive** has a free indices plan.
- **MarketData.app** has a keyless demo with CORS `*`.
- **pandas-datareader** removed its equity readers.
- **Alpha Vantage** changed its burst-notice wording in December 2025 and again in 2026.

## A.8 UNVERIFIED

| Provider | Open question |
|---|---|
| Alpha Vantage | Per-minute cap; per-key vs per-IP counting; reset time zone; open-source tier criteria; free-key coverage of VEQT, XQQ, VFV, HEWB, YNVD and Tokyo (the demo key can't test them) |
| Finnhub | Free per-minute quota |
| EODHD | Free coverage outside the US |
| EODHD, Tiingo | CORS on successful keyed responses |
| FMP | Per-endpoint access on Basic |
| Marketstack | Exchange coverage |
| Massive | Grouped-daily endpoint on Basic; which index tickers are free |
| Twelve Data | Reset time zone; indexes |
| Stooq | Licence |
| J-Quants | Plan details |

## A.9 Main sources (accessed 2026-11-03)

**Alpha Vantage:**
- https://www.alphavantage.co/documentation/
- https://www.alphavantage.co/support/
- https://www.alphavantage.co/premium/
- https://www.alphavantage.co/terms_of_service/

**Alpha Vantage notice reports (GitHub issues):**
- beancount/beanprice#124
- GeneBO98/tradetally#202
- williamkray/maubot-financebot#2
- home-assistant/core#109153
- finance-quote/finance-quote#361
- few-letter/few-be#989
- nisbacode/nisba-rates#2
- RomelTorres/alpha_vantage#386
- ellisvalentiner/AlphaVantage.jl#44

**Other providers:**
- **Twelve Data:** https://twelvedata.com/pricing, https://twelvedata.com/terms, https://twelvedata.com/docs/llms.txt
- **FMP:** https://site.financialmodelingprep.com/pricing-plans
- **Finnhub:** https://finnhub.io/docs/api, https://finnhub.io/terms-of-service
- **EODHD:** https://eodhd.com/pricing, https://eodhd.com/financial-apis/terms-conditions
- **Marketstack:** https://marketstack.com/pricing
- **Tiingo:** https://www.tiingo.com/about/pricing
- **Massive:** https://massive.com/pricing?product=stocks, https://massive.com/legal/individuals-terms-of-service
- **StockData.org:** https://www.stockdata.org/pricing, https://www.stockdata.org/tos
- **Alpaca:** https://docs.alpaca.markets/docs/about-market-data-api
- **Tradier:** https://docs.tradier.com/docs/getting-started
- **Intrinio:** https://intrinio.com/pricing
- **MarketData.app:** https://www.marketdata.app/pricing/, https://www.marketdata.app/terms/
- **OpenFIGI:** https://www.openfigi.com/api/documentation, https://www.openfigi.com/docs/terms-of-service

**Desktop tooling and directory:**
- **Yahoo terms:** https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html
- **pandas-datareader:** pydata/pandas-datareader#1012 and its what's-new page
- **Scrapling:** github.com/D4Vinci/Scrapling
- **public-apis:** github.com/public-apis/public-apis#finance
