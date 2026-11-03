# Appendix B — Ticker identity verification (14 sample instruments)

Status: a sub-audit by the ticker-verification workstream, 2026-11-03, HEAD `ada2ceb`.

- **Spot-checked by the lead auditor with independent searches:** YNVD trades on Cboe Canada, and SPCX is SpaceX Class A on Nasdaq (IPO priced at US$135, trading from 2026-06-12).
- **Evidence levels:** CONFIRMED = a primary or official source. SECONDARY = an aggregator, news or search snippet. UNVERIFIED gives a reason.
- **Prices:** the "typed" prices are the owner's placeholder inputs. They were carried over from the old sample (see report §4.3). They must never become defaults.
- **Reference prices** are quoted only as evidence that the placeholders were wrong. They come from delayed or issuer sources, as cited.

## B.1 Identity table

| Row | As typed | Resolved security | Issuer | Type | Venue (MIC) | Ccy / unit | Status | Flags |
|---|---|---|---|---|---|---|---|---|
| 1 | VEQT.TO | Vanguard All-Equity ETF Portfolio | Vanguard Canada | ETF | TSX (XTSE) | CAD | Active; inception 2019-01-29 | Twelve Data also lists a Cboe Canada (NEOE) trading line |
| 2 | CNQ.TO | Canadian Natural Resources Ltd. | issuer | Common stock | TSX (XTSE) | CAD | Active | Also NYSE `CNQ` in USD. Tiingo has only the NYSE line. |
| 3 | XQQ.TO | iShares NASDAQ 100 Index ETF (CAD-Hedged) | BlackRock Canada | ETF, hedged | XTSE | CAD | Active; 2011-05-03; 3-for-1 split 2024-08-09 (SECONDARY) | Unhedged sibling XQQU; `XQQU.U` USD units (SECONDARY) |
| 4 | HEWB.TO | Global X Equal Weight Canadian Banks Index Corporate Class ETF | Global X (formerly Horizons) | Corporate-class ETF shares using a total-return swap | XTSE | CAD | Active; 2019-01-22 | Swap ≈ 61.9 % of NAV (2026-06-30); no regular distributions |
| 5 | AAPL | Apple Inc. | issuer | Common stock | Nasdaq (XNAS) | USD | Active | TSX `AAPL` = Apple CDR (CAD-hedged) since 2025-02-05 |
| 6 | VFV.TO | Vanguard S&P 500 Index ETF | Vanguard Canada | ETF, unhedged | XTSE | CAD | Active; 2012-11-02 | — |
| 7 | SPCX | Space Exploration Technologies Corp. Class A | issuer | Common stock (2026 IPO) | Nasdaq Global Select (XNGS) and Nasdaq Texas | USD | Priced 2026-06-11 at US$135; trading from 2026-06-12 | **Reused ticker:** Tuttle's SPAC ETF used SPCX until 2026-04-06 (now SPCK). TSX `SPCX` = CIBC SpaceX CDR. Twelve Data tags XNMS. |
| 8 | CBRS | Cerebras Systems Inc. Class A | issuer | Common stock (2026 IPO) | Nasdaq Global Select (XNGS) | USD | Priced 2026-05-13 at US$185; trading from 2026-05-14 | TSX `CBRS` = Cerebras CDR (ratio 0.10164454). Xetra `CBRS` = First Trust Nasdaq Cybersecurity ETF. |
| 9 | YNVD.TO | NVIDIA (NVDA) Yield Shares Purpose ETF | Purpose Investments | ETF: covered calls, ≤ 25 % leverage, CAD-hedged | **Cboe Canada (NEOE)**, not the TSX | CAD | Active; listed 2024-01-18 | **`.TO` is the wrong venue.** Use `YNVD.NE` (Yahoo, FMP, Finnhub), `YNVD.NEO` (EODHD) or mic_code `NEOE` (Twelve Data). Alpha Vantage documents no Cboe Canada suffix. |
| 10 | VST | Vistra Corp. | issuer | Common stock | NYSE (XNYS) | USD | Active | None |
| C1 | 7203.T | Toyota Motor Corp. | issuer | Common stock | Tokyo SE (XTKS, under XJPX) | JPY | Active | NYSE ADR `TM` (1 ADS = 10 sh). Bare `7203` also exists on Tadawul and Bursa Malaysia. |
| C2 | SAP.DE | SAP SE | issuer | Common stock | Xetra (XETR) | EUR | Active | NYSE ADR `SAP` (1:1). **TSX `SAP` = Saputo.** CDR `SAPS`. JSE `SAP` = Sappi. |
| C3 | VOD.L | Vodafone Group plc | issuer | Common stock | LSE (XLON) | **GBp (pence)** | Active | Nasdaq ADR `VOD` (1 ADS = 10 sh). JSE `VOD` = Vodacom. German venues use `VODI`. |
| C4 | 600519.SS | Kweichow Moutai Co., Ltd. (A-share) | issuer | Common stock | Shanghai SE (XSHG) | **CNY** | Active | Not a CNH instrument |

## B.2 Typed placeholder prices vs reference prices (evidence only)

Reference prices are 2026-11-02 closes:
- VEQT and VFV: Vanguard Canada product pages.
- YNVD: Trackinsight, 2026-10-29.
- All others: stockanalysis.com, which publishes delayed prices.

| Symbol | Typed | Reference | 52-wk / since-IPO range | Typed ÷ ref | Verdict |
|---|---:|---:|---|---:|---|
| VEQT | 250 | 60.84 | 52.27–63.02 | 4.11 | Wildly off |
| CNQ | 36 | 75.12 | 41.68–78.60 | 0.48 | Wildly off |
| XQQ | 42 | 68.00 | 56.00–76.14 | 0.62 | Below range |
| HEWB | 64 | 74.04 | 50.42–76.20 | 0.86 | Plausible |
| AAPL | 64 | 338.32 | 243.42–351.73 | 0.19 | Wildly off |
| VFV | 7.4 | 187.16 | 156.67–197.56 | 0.04 | Wildly off |
| SPCX | 180 | 136.37 | 104.83–225.64 | 1.32 | In range, 32 % high |
| CBRS | 72 | 96.36 | 95.03–386.34 | 0.75 | Below every traded price |
| YNVD | 40 | 44.21 | — | 0.90 | Plausible |
| VST | 136 | 134.61 | 132.66–196.80 | 1.01 | Consistent |

**Effect on the plan.** At typed vs reference prices, using Bank of Canada USD/CAD 1.3978 for 2026-11-02, the trade direction **reverses for 5 of 10 rows**. Each line shows the target weight, then weight → action at typed prices, then weight → action at reference prices:
- VEQT: target 70 %; 93.85 % → SELL vs 64.95 % → **BUY**
- CNQ: target 10 %; 2.13 % → BUY vs 12.62 % → **SELL**
- AAPL: target 2 %; 0.22 % → BUY vs 3.31 % → **SELL**
- VFV: target 1 %; 0.07 % → BUY vs 5.24 % → **SELL**
- CBRS: target 1 %; 0.50 % → BUY vs 1.89 % → **SELL**

These directions are for Rebalance mode. In the owner's New Money run, the overweight rows become "Hold".

Portfolio value: C$81,250 at typed prices vs C$28,572 at reference prices.

The arithmetic is in `audit/tickers/typed_vs_ref.py` (scratchpad).

## B.3 Provider symbols

| Symbol | Alpha Vantage | Twelve Data (plan from its `access` field) | FMP | Finnhub | EODHD | Marketstack | Tiingo |
|---|---|---|---|---|---|---|---|
| VEQT.TO | VEQT.TRT | VEQT / XTSE (Grow) | VEQT.TO | VEQT.TO | VEQT.TO | VEQT.XTSE ❓ | no |
| CNQ.TO | CNQ.TRT | CNQ / XTSE (Grow) | CNQ.TO | CNQ.TO | CNQ.TO | ❓ | NYSE USD line only |
| XQQ.TO | XQQ.TRT | XQQ / XTSE (Grow) | XQQ.TO | XQQ.TO | XQQ.TO | ❓ | no |
| HEWB.TO | HEWB.TRT | HEWB / XTSE (Grow) | HEWB.TO | HEWB.TO | HEWB.TO | ❓ | no |
| AAPL | AAPL | AAPL (Basic) | AAPL | AAPL | AAPL.US | AAPL | AAPL |
| VFV.TO | VFV.TRT | VFV / XTSE (Grow) | VFV.TO | VFV.TO | VFV.TO | ❓ | no |
| SPCX | SPCX | SPCX / Nasdaq (Basic); avoid the XTSE/NEOE CDR lines | SPCX | SPCX | SPCX.US | SPCX | SPCX (from 2026-06-12) |
| CBRS | CBRS | CBRS / XNGS (Basic) | CBRS | CBRS | CBRS.US | CBRS | CBRS (from 2026-05-14) |
| YNVD | **none documented** | YNVD / NEOE (Grow) | YNVD.NE | YNVD.NE | YNVD.NEO | ❓ | no |
| VST | VST | VST | VST | VST | VST.US | VST | VST |
| 7203.T | **none**; the site rejects `.T` | 7203 / XJPX (Basic per `access` field) | 7203.T | 7203.T | Tokyo not listed | ❓ | no (`TM` only) |
| SAP.DE | SAP.DEX | SAP / XETR (Grow) | SAP.DE | SAP.DE | SAP.XETRA | ❓ | NYSE ADR only |
| VOD.L | VOD.LON | VOD / XLON (Grow, currency GBp) | VOD.L | VOD.L | VOD.LSE | VOD.XLON ❓ | Nasdaq ADR only |
| 600519.SS | 600519.SHH | 600519 / XSHG (Pro) | 600519.SS | 600519.SS | 600519.SHG | ❓ | 600519 (SHG, CNY) ✅ |

**Notes:**
- **Twelve Data:** "Basic" is the free plan ($0, 8 credits/min, 800/day). The exchange goes in separate `exchange` / `mic_code` / `country` parameters.
- **Finnhub:** symbols use `TICKER.CODE`. Its `/quote` covers US stocks; international quotes are Enterprise-only.
- **FMP:** suffixes are SECONDARY (from an FMP-powered table). The FMP documentation returned HTTP 403 to automated fetches. The free plan is US-only (SECONDARY).
- **EODHD:** exchange codes come from its official exchange list. Tokyo is absent. The demo key returned 403.
- **Marketstack:** the documentation shows only `.INDX` and the `exchange=MIC` parameter, so every `TICKER.MIC` in the table is ❓.
- **Tiingo:** the official `supported_tickers.zip` (109,188 rows) has US and SHG/SHE, plus 11 dead LSE rows. It has no TSX, NEO, Xetra or Tokyo.
- **Alpha Vantage:**
  - Documented suffixes are `.TRT .TRV .LON .DEX .BSE .SHH .SHZ`. The documentation has no Tokyo suffix.
  - `MARKET_STATUS` (demo key) lists "Japan | Tokyo" and "Canada | Toronto, Toronto Ventures", but not Cboe Canada.
  - Coverage of individual symbols could not be tested: the demo key works only for documented examples. UNVERIFIED.

## B.4 Currency-test candidates

- **7203.T:**
  - Alpha Vantage: no Tokyo suffix is documented, and the site rejects `.T` (`alphavantage.js:52-53`).
  - Twelve Data's free plan appears to cover it (`access` field).
  - No Alpha Vantage-documented JPY listing exists. Keep 7203.T as a "provider cannot price this" test, or price it through a provider that covers Tokyo.
- **SAP.DE:** expected via `.DEX`. Fallback: MBG.DEX (Mercedes-Benz Group, Xetra, EUR), which is Alpha Vantage's documented example.
- **VOD.L:** expected via `.LON`, quoted in GBX. This exercises the pence conversion (`alphavantage.js:34, 95-99`). Fallback: TSCO.LON (Tesco), which is documented. On 2026-11-02, a demo-key SYMBOL_SEARCH for "tesco" returned `TSCO.LON | United Kingdom | GBX`.
- **600519.SS:** expected via `.SHH`; Tiingo also covers it. Fallback: 600104.SHH (SAIC Motor), which is documented. Convert using the CNY rate (Bank of Canada `FXCNYCAD`), never a CNH rate.

## B.5 Edge cases the instrument layer must handle

1. **A suffix is not proof of currency.**
   - TSX lines can trade in USD: Global X "US$ Shares", `XQQU.U`, and Yahoo-style `-U.TO`.
   - The site passes through 2-character suffixes whose letter is not T, V or L (`alphavantage.js:52`).
   - CDRs are CAD-hedged, and their ratios drift.
   - ADR ratios: SAP 1:1, VOD 1:10, TM 1:10.
2. **One ticker, several securities:** SAP (Saputo vs SAP SE), VOD, CBRS, 7203, TSCO.
3. **A reused ticker leaves stale history:** SPCX was the Tuttle ETF, then became SpaceX.
4. **Cboe Canada naming varies:** NEO, Aequitas NEO, NEO Exchange, MIC NEOE. The site has no `.NE` mapping. `YNVD.TO` is silently mapped to a non-existent TSX listing (`YNVD.TRT`).
5. **GBp/GBX and CNH are not ISO 4217 codes.** Take the unit scale from the instrument's currency, not the exchange's.
6. **CNY vs CNH:** A-shares quote in CNY. CNH is the offshore market convention.
7. **Multiple listings:** key each instrument on (ticker, MIC, currency, type, ratio), never on ticker alone.
8. **Mutual-fund codes** (e.g. TD `TDB902` in C$, `TDB952` in US$) are priced at NAV once a day through dealers. Exchange APIs do not price them, so classify them as "NAV — manual/CSV".
9. **Splits and ratios:** XQQ split 3-for-1 in 2024, Toyota split in 2021, and CDR ratios change.
10. **Numeric codes need a MIC.** Match on operating MICs: XNAS vs the segments XNGS/XNMS.

## B.6 Sources (accessed 2026-11-03)

**Issuers and products**
- Vanguard Canada product pages for VEQT (9692) and VFV (9563) — vanguard.ca
- BlackRock XQQ ETF Facts (2026-06-19) and the 2024 split press release (SECONDARY)
- Global X HEWB:
  - product sheet as at 2026-10-30 — assets.globalx.ca/product_sheet/en/hewb.pdf
  - interim MRFP to 2026-06-30 — globalx.ca …/HEWB-EN-IR2026.pdf
- Purpose YNVD:
  - Cboe Canada launch news — etfmarket.cboe.com/canada/en/news/…
  - Trackinsight — trackinsight.com/en/fund/YNVD
  - Globe and Mail profile `YNVD-NE`
- TD Fund Facts TDB902 (2026-07-23)

**Issuers, IPOs and CDRs**
- SpaceX:
  - pricing release — irei.com/news/space-exploration-technologies-corp-announces-pricing-of-initial-public-offering/
  - debut — iposcoop.com
  - Tuttle 497 filing (SEC, SECONDARY)
- CIBC CDRs:
  - TSX new-listing bulletin 2426 and CIBC media release 2026-06-10
  - CIBC CDR directory — cdr.cibc.com/en/cdr-directory
- Apple CDR — TSX new-listing bulletin 1899
- Cerebras pricing — storagenewsletter.com 2026-05-18
- ADR ratios: Toyota 20-F FY2026, SAP 20-F, and the Vodafone ADR filing (SEC; SECONDARY)

**Provider documentation**
- Alpha Vantage documentation
- Twelve Data symbol search and pricing pages, and the twelvedata-python repository
- Finnhub swagger
- EODHD list of stock markets and supported exchanges
- Marketstack v1 endpoints
- Tiingo end-of-day documentation and `supported_tickers.zip`
- Wisesheets available-exchanges table (for FMP suffixes)

**Standards and rates**
- ISO 4217 list one (SIX, published 2026-09-17)
- ISO 10383 MIC list (iso20022.org)
- Bank of Canada Valet `FXUSDCAD` 1.3978 and `FXCNYCAD` 0.2102 (2026-11-02)

**Request log:** every request was bounded and used either no key or a documented demo key.
- Twelve Data: 8 `symbol_search` calls with `demo`.
- Alpha Vantage: 2 requests plus 1 documentation fetch.
- EODHD: demo key returned 403.
- FMP: 403 three times.
- SEC: rate-limited once; not retried.
- Bank of Canada: 1.
- ISO lists: 2.
- stockanalysis.com: 8 page fetches.
- Issuer pages: mostly 200. Global X HTML returned 403, Purpose 429, and the Cboe fund page 500.

**UNVERIFIED:**
- Alpha Vantage coverage of individual symbols.
- FMP and EODHD symbol coverage.
- Marketstack non-US format.
- Cerebras CDR listing date.
- `XQQU.U` ticker spelling.
- YNVD 52-week range.
- Tokyo market segment and lot size.
