# Instrument identity (Portfolio Rebalancer and Stock Comparison, web and desktop)

Dated 2026-11-03. How a ticker the user types becomes one specific listing (exchange,
currency, quote unit) before any price is requested, and why a price is never matched by
ticker text alone. Code: `assets/js/market-data/instruments.js` (web) and
`_tools/shared_py/market_data/instruments.py` (desktop; copied into both desktop tools by
`_tools/sync_shared_py.py`). Reference data: `assets/data/instruments.v1.json` (identity
only, **no prices**), copied verbatim into the Python package.

## 1. Contract: `md.instrument.v1`

| Field | Meaning |
|---|---|
| `canonicalId` | `MIC:SYMBOL`, e.g. `XTSE:VEQT`, `NEOE:YNVD`, `XNAS:AAPL`. The key for caches, routing and parity tests. |
| `displayTicker` | Exactly what the user typed (trimmed, upper-cased). Kept in the row, exports and plan. |
| `mic`, `venueName`, `timeZone` | Listing venue (ISO 10383 MIC, or `US` when only "a US exchange" is known) and its IANA time zone (used for trading-date freshness). |
| `currency`, `quoteUnit`, `unitScale` | Listing currency; `minor` units (London pence) are converted with `unitScale` 0.01 so every price is in major units. |
| `currencyEvidence` | `curated_reference` (from the reference file) or `venue_default_unconfirmed` (from the suffix's venue default; providers must confirm it, see below). |
| `assetType`, `name`, `listedFrom`, `evidence` | Descriptive; `listedFrom` stops a provider's older, unrelated history from being used for a recent listing. |
| `status` | `resolved`, `unresolved` (unknown suffix or form) or `unsupported` (indexes `^…`, FX `…=X`, futures `…=F`). |

## 2. Resolution order (no network request)

1. **Curated reference**: exact symbol or alias match in `instruments.v1.json`.
2. **Exchange prefixes**: `TSX:`, `TSE:` → `.TO`; `TSXV:`, `CVE:` → `.V`; `NEO:` → `.NE`;
   `LSE:`, `LON:` → `.L`; `JPX:`, `TYO:` → `.T`; `ETR:` → `.DE`; `SHA:` → `.SS`;
   `SHE:` → `.SZ`; `HKG:` → `.HK`.
3. **Suffix → venue** (Yahoo-style suffixes, as most Canadian brokers display them):

   | Suffix | Venue (MIC) | Currency | Unit |
   |---|---|---|---|
   | (none) | US exchange (`US`) | USD | major |
   | `.TO` | Toronto Stock Exchange (XTSE) | CAD | major |
   | `.V` | TSX Venture (XTSX) | CAD | major |
   | `.NE`, `.NEO` | Cboe Canada (NEOE) | CAD | major |
   | `.CN` | Canadian Securities Exchange (XCNQ) | CAD | major |
   | `.L` | London Stock Exchange (XLON) | GBP | **minor (pence)** |
   | `.DE` / `.F` | Xetra (XETR) / Frankfurt (XFRA) | EUR | major |
   | `.PA` `.AS` `.MI` | Euronext Paris / Amsterdam, Borsa Italiana | EUR | major |
   | `.SW` | SIX Swiss Exchange (XSWX) | CHF | major |
   | `.T` | Tokyo Stock Exchange (XTKS) | JPY | major |
   | `.SS` / `.SZ` | Shanghai (XSHG) / Shenzhen (XSHE) | CNY | major |
   | `.HK` `.AX` `.BO` | Hong Kong, ASX, BSE | HKD, AUD, INR | major |

   A TSX `-U` unit class (`XUS-U.TO`) is the USD-traded unit. Class shares keep their dot or
   dash form (`BRK.B`, `RCI-B.TO`).
4. **Anything else** is `unresolved` with a message; it is never guessed.

A suffix-derived currency is `venue_default_unconfirmed`. A provider quote for such a row
is accepted only when the provider reports the same currency (and, where it reports one,
the same exchange); a contradiction is `currency_mismatch` or `ambiguous`, and the row
shows no price. Curated rows still reject a provider that reports a different currency or
venue.

## 3. Ambiguity policy

- **The same ticker text on two exchanges is two instruments.** Bare `CNQ` resolves to a
  US listing (`US:CNQ`, USD, currency to be confirmed by the provider) and `CNQ.TO` to
  `XTSE:CNQ` (CAD); `AAPL` (Nasdaq) and any Canadian depositary receipt; `SPCX` and
  `CBRS` (recent US listings) are routed and checked by `canonicalId`, never by ticker text.
- A provider symbol is produced per provider by the catalog (`symbolFor(identity, plan)`),
  e.g. Alpha Vantage `VEQT.TRT` / `VOD.LON`, Marketstack `VEQT.TO` / `YNVD.NE` / `VOD.L`;
  Finnhub and Alpaca cover US listings (Finnhub international symbols only on a paid
  international plan, for curated identities). A provider that cannot express a venue
  returns no symbol and is `not_covered` for it (for example every provider for TSX `-U`
  units on the free plans).
- A response whose symbol, exchange or currency differs from the request is not used.
- Recent listings carry `listedFrom`; history before it is discarded.

## 4. `YNVD.NE` and `YNVD.TO` (one Cboe Canada ETF, two spellings)

- **What it is:** NVIDIA (NVDA) Yield Shares Purpose ETF, listed on **Cboe Canada**
  (MIC `NEOE`), CAD. Evidence: the Purpose Investments fund page and the Cboe Canada
  security page (both `confirmed`). The venue comes from these issuer and exchange
  records, not from the suffix: `.NE` is never read as a TSX listing.
- **Spellings:** the sample uses `YNVD.NE` (owner's choice, 2026-11-03). Questrade shows
  the same fund as `YNVD.TO`; a holding imported or typed that way is **kept verbatim**
  (no forced rename). The curated alias list `["YNVD.TO", "YNVD.NE", "YNVD.NEO"]` maps all
  three to `NEOE:YNVD`, so they share one identity, one cache key and one route: they
  are never two different instruments.
- **Never priced as a TSX listing,** nor from NVIDIA common shares or another ETF.
  Routing for `NEOE` is Marketstack → Finnhub (where plans cover it); Alpha Vantage is
  not used for NEOE. Marketstack's coverage of NEOE:YNVD is a recorded **known gap**
  (`catalog.gaps`), so on the free sources this row shows "Not covered" and the plan is
  withheld until the user supplies a labelled price (*My price* / *Use my own price*).
  That is the intended, honest outcome; it is not a defect.

## 5. The sample portfolio (fourteen ordinary holdings; no prices)

`assets/js/portfolio-rebalancer/sample.js` and `portfolio_rebalancer/sample.py` (checked
identical by `test_market_data_parity.py::test_sample_portfolio_identical`; schema
`rb.sample-portfolio.v3`): reporting currency CAD, New Money mode, budget 3,000, account
type blank. The ten Questrade targets of v1 (70/10/7/5/2/1/1/1/2/1) are scaled to 90%;
the four international holdings have one share and 2.5% each. Targets total exactly
10,000 basis points (100.0%).

| # | Ticker (as entered) | Shares | Target % | Canonical ID | Currency | Evidence |
|---|---|---|---|---|---|---|
| 1 | VEQT.TO | 305 | 63.0 | XTSE:VEQT | CAD | audit |
| 2 | CNQ.TO | 48 | 9.0 | XTSE:CNQ | CAD | audit |
| 3 | XQQ.TO | 27 | 6.3 | XTSE:XQQ | CAD | audit |
| 4 | HEWB.TO | 14 | 4.5 | XTSE:HEWB | CAD | audit |
| 5 | AAPL | 2 | 1.8 | XNAS:AAPL | USD | audit |
| 6 | VFV.TO | 8 | 0.9 | XTSE:VFV | CAD | audit |
| 7 | SPCX | 1 | 0.9 | XNAS:SPCX (listed 2026-06-12) | USD | secondary — re-verify with SEC filings |
| 8 | CBRS | 4 | 0.9 | XNAS:CBRS (listed 2026-05-14) | USD | secondary — re-verify with SEC filings |
| 9 | YNVD.NE | 4 | 1.8 | NEOE:YNVD | CAD | confirmed |
| 10 | VST | 1 | 0.9 | XNYS:VST | USD | audit |
| 11 | 7203.T | 1 | 2.5 | XTKS:7203 | JPY | audit |
| 12 | SAP.DE | 1 | 2.5 | XETR:SAP | EUR | audit |
| 13 | VOD.L | 1 | 2.5 | XLON:VOD | GBP (quoted in pence, ÷100) | audit |
| 14 | 600519.SS | 1 | 2.5 | XSHG:600519 | CNY | audit |

All fourteen are ordinary holdings: the same row, the same **Get prices** action (one
estimate and one batch for all, largest targets first, each provider's remaining quota
checked before a request), the same valuation gate and the same plan. There is no
separate group, button, tag or rule for the international rows (the earlier *Remove
international examples* control and its `sampleTag` were removed on 2026-11-04; the
securities stay). No example market price is embedded anywhere in the sample.

With no key, every one of the fourteen is asked of Yahoo Finance through the site's
gateway (first in the default source list), which covers all fourteen exchanges, YNVD.NE
included (asked as `YNVD.NE` on Cboe Canada in CAD; Questrade's `YNVD.TO` resolves to the
same listing).

With only Alpha Vantage and Finnhub keys switched on, Finnhub placed above Alpha Vantage
(Yahoo Finance unavailable or off): 8 Alpha Vantage quotes (five
TSX, Xetra, London, Shanghai; all curated, so no symbol search) and 4 Finnhub quotes;
YNVD.NE and 7203.T are named as not covered before any request (Tokyo needs
Marketstack). With Marketstack only: 13 requests of the free 100 per month.

## 6. Adding or correcting an instrument

Edit `assets/data/instruments.v1.json` (identity only; cite a source and an evidence level:
`confirmed` = issuer or exchange, `secondary` = filing summary or news, `audit` = checked
in the 2026-11-03 audit), then run `python _tools/sync_shared_py.py` and the parity tests.
Never add prices to this file.
