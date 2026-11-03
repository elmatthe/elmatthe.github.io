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

## 4. `YNVD.TO` (Questrade display symbol for a Cboe Canada ETF)

- **What it is:** NVIDIA (NVDA) Yield Shares Purpose ETF, listed on **Cboe Canada**
  (MIC `NEOE`), CAD. Evidence: the Purpose Investments fund page and the Cboe Canada
  security page (both `confirmed`).
- **Why `.TO`:** Questrade shows Cboe Canada listings with `.TO`. The user's holding is
  therefore **kept verbatim as `YNVD.TO`** (no forced rename to `.NE`), and the curated
  alias list `["YNVD.TO", "YNVD.NE", "YNVD.NEO"]` maps all three to `NEOE:YNVD`.
- **Never priced as a TSX listing.** Routing for `NEOE` is Marketstack → Finnhub (where
  plans cover it); Alpha Vantage is not used for NEOE. Marketstack's coverage of NEOE:YNVD
  is a recorded **known gap** (`catalog.gaps`), so on the free sources this row shows
  "not covered" and the plan is withheld until the user supplies a labelled price (*My
  price*). That is the intended, honest outcome; it is not a defect.

## 5. The sample portfolio (exact owner input; no prices)

`assets/js/portfolio-rebalancer/sample.js` and `portfolio_rebalancer/sample.py` (checked
identical by `test_market_data_parity.py::test_sample_portfolio_identical`): reporting
currency CAD, New Money mode, budget 3,000.

| # | Ticker (as entered) | Shares | Target % | Canonical ID | Currency | Evidence |
|---|---|---|---|---|---|---|
| 1 | VEQT.TO | 305 | 70 | XTSE:VEQT | CAD | audit |
| 2 | CNQ.TO | 48 | 10 | XTSE:CNQ | CAD | audit |
| 3 | XQQ.TO | 27 | 7 | XTSE:XQQ | CAD | audit |
| 4 | HEWB.TO | 14 | 5 | XTSE:HEWB | CAD | audit |
| 5 | AAPL | 2 | 2 | XNAS:AAPL | USD | audit |
| 6 | VFV.TO | 8 | 1 | XTSE:VFV | CAD | audit |
| 7 | SPCX | 1 | 1 | XNAS:SPCX (listed 2026-06-12) | USD | secondary — re-verify with SEC filings |
| 8 | CBRS | 4 | 1 | XNAS:CBRS (listed 2026-05-14) | USD | secondary — re-verify with SEC filings |
| 9 | YNVD.TO | 4 | 2 | NEOE:YNVD | CAD | confirmed |
| 10 | VST | 1 | 1 | XNYS:VST | USD | audit |
| T1 | 7203.T | 0 | 0 | XTKS:7203 | JPY | audit |
| T2 | SAP.DE | 0 | 0 | XETR:SAP | EUR | audit |
| T3 | VOD.L | 0 | 0 | XLON:VOD | GBP (pence) | audit |
| T4 | 600519.SS | 0 | 0 | XSHG:600519 | CNY | audit |

Rows T1–T4 form the `currency-tests` group: zero shares and zero target, so they never
block a plan and are not fetched by *Get prices* (inactive rows), and one action removes
them. No example market price is embedded anywhere in the sample.

## 6. Adding or correcting an instrument

Edit `assets/data/instruments.v1.json` (identity only; cite a source and an evidence level:
`confirmed` = issuer or exchange, `secondary` = filing summary or news, `audit` = checked
in the 2026-11-03 audit), then run `python _tools/sync_shared_py.py` and the parity tests.
Never add prices to this file.
