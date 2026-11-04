# _tools — build and test tooling for the /projects/ tools

Jekyll ignores folders that start with `_`, so nothing here is published. It covers
the four tools on `/projects/`: Monte Carlo Retirement Simulator, CPI Web Scraper,
Portfolio Rebalancer, and Stock Comparison & Analytics Tool.

## Layout

| Path | Purpose |
|---|---|
| `bootstrap/` | Shared launcher/bootstrap templates and `projects.toml` (one small declarative block per Python desktop tool). |
| `bootstrap/render.py` | Renders `scripts/bootstrap.py`, `Setup_and_Run-<tool>.bat` (CRLF), `.command` (LF, executable) and `config.toml` into each tool folder. |
| `build_project_zips.py` | Builds the four user ZIPs in `projects/` deterministically, with an include list per tool and a secret scan. |
| `shared_py/market_data/` | Canonical Python mirror of `assets/js/market-data/` (stdlib only). `sync_shared_py.py` copies it into the Rebalancer and Stock desktop tools; `--check` fails on drift. |
| `cpi_public_workbook.py` | Scrubs and checks the public `CPI.xlsx` (no S&P 500 values, cached results or local metadata); `--write` / `--check`. |
| `tests/test_engine_parity.py` | Browser engines (`assets/js/monte-carlo`, `assets/js/portfolio-rebalancer`) vs the desktop `core.py` files. Uses Node through `tests/js_engines.mjs`. |
| `tests/test_financial_reference.py` | Hand-calculated rebalancer cases and closed-form Monte Carlo paths, checked in both browser and desktop engines. |
| `tests/test_analytics_reference.py` | Browser Stock analytics vs an independent numpy/scipy reference (returns, annualization, Sharpe, drawdown, correlation, OLS). |
| `tests/test_bootstrap.py` | Bootstrap contract tests (mocked) and opt-in end-to-end runs (`-m e2e`). |
| `tests/test_market_data_parity.py` | JS vs Python market-data layer: identity, the ordered source list (every function, including message text), gateway symbol/venue/error tables, catalog, notice classification, quote adapters, freshness, valuation, whole shares, sample portfolio, gateway address. Fixtures in `tests/fixtures/providers/`. |
| `tests/test_desktop_gateway.py`, `tests/gateway_server.mjs` | The desktop market-data package against the REAL gateway Worker code served on 127.0.0.1 (synthetic Yahoo upstream): zero keys, the 14-holding sample, history, order and fallback, exhausted and rejected keys, pauses across restarts, the circuit breaker, a switched-off source, persistence. |
| `tests/test_cpi_public_workbook.py` | The shipped CPI workbook stays clean and structurally intact. |
| `tests/test_cpi_parity.py` | CPI web app vs the desktop downloader: 19-column schema, gateway allowlist, month rules, daily end-of-month reduction, and byte-identical CSVs from `tests/fixtures/cpi/sources.json` (regenerate with `generate.py`). Uses Node through `tests/cpi_engines.mjs`. |
| `tests/unit/*.test.mjs` | Node unit tests for `assets/js/market-data/` (including per-key isolation and key storage, CSV calendar dates, the Yahoo Finance adapter, pauses and fallback in `keyless.test.mjs`, the ordered source list in `sources.test.mjs`), the Rebalancer sample, Stock analytics consistency and currency safeguards, the Monte Carlo engine, the CPI engine and clients, the CPI data gateway's security rules, and the market-data gateway Worker (`market-gateway.test.mjs`) (no network). |
| `tests/fixtures/yahoo-chart.mjs` | Synthetic Yahoo-shaped chart answers (invented values) used as the market-data gateway's upstream in every test; nothing contacts Yahoo. |
| `tests/browser/*.test.js` | Playwright tests against a locally served build, with every market-data host, Statistics Canada and the CPI data gateway mocked; `freesource.test.js` drives both market-data pages against the real market-data gateway code. |
| `tests/live_fx_matrix.mjs` | Optional live check of the official FX sources (two requests). |
| `MARKET_DATA.md` | Where prices and exchange rates come from, why, licensing, caching, testing and troubleshooting (section 0 = current design). |
| `PROVIDER_MATRIX.md` | Dated eligibility, plans, request accounting and licensing for the five provider candidates. |
| `INSTRUMENT_IDENTITY.md` | Ticker → listing identity, YNVD.NE / YNVD.TO, ambiguity policy, the 14-holding sample portfolio. |
| `CPI_DATA.md` | CPI web app: architecture (Statistics Canada direct, FRED through the data gateway), the 19-column contract, missing data, CSV, key handling, free-tier operations, licensing, adding a series. |
| `CALCULATION_METHODOLOGY.md` | Units, conventions, changed formulas and limitations of all four engines. |
| `BROWSER_DESKTOP_PARITY.md` | Capability matrix web vs desktop, with the test behind each equivalence. |
| `RELEASE_NOTES.md` | User-visible changes to the tools. |

`../_services/cpi-data-gateway/` (also unpublished) is the Cloudflare Worker that lets the
CPI web app reach FRED with each visitor's own key; deployment steps are in its README.
`../_services/market-data-gateway/` is the separate Worker that gives the Rebalancer and
the Stock tool (web and desktop) Yahoo Finance prices with no key; its README covers
activation (owner attestation), rate limiting, deployment, verification, the capped live
smoke test and rollback. The site setting that points at it is `_data/market_data.yml`
(the desktop apps: `DEFAULT_GATEWAY_URL` in `shared_py/market_data/gateway.py`).

CPI Web Scraper is not rendered from these templates. Its folder
`projects/CPI-Webscraper/` is a copy of `elmatthe/CPI-Webscraper` `main` without the
private root `config.toml`. The CPI launcher and bootstrap are that repository's own.

## Common tasks

```bash
# After editing a template or projects.toml
python3 _tools/bootstrap/render.py            # write
python3 _tools/bootstrap/render.py --check    # verify (no writes)

# After changing _tools/shared_py/market_data or assets/data/instruments.v1.json
python3 _tools/sync_shared_py.py              # copy into both desktop tools (--check verifies)

# After refreshing projects/CPI-Webscraper/files/CPI.xlsx from the canonical repository
python3 _tools/cpi_public_workbook.py --write # remove S&P values, caches and local metadata

# After changing any tool folder
python3 _tools/build_project_zips.py          # rebuild all four ZIPs
python3 _tools/build_project_zips.py --check  # verify the committed ZIPs are current

# Refresh the CPI copy from its canonical repository (never copy root config.toml)
git -C ../CPI-Webscraper archive main | tar -x -C projects/CPI-Webscraper
rm -f projects/CPI-Webscraper/config.toml
```

## Tests

Python tests need `pytest`, `numpy`, `scipy` and `openpyxl`, pinned in
`tests/requirements.txt` (`python3 -m pip install -r _tools/tests/requirements.txt`):

```bash
node --test _tools/tests/unit/*.test.mjs   # market data, key isolation, CSV dates, Rebalancer sample, analytics, Monte Carlo, CPI engine, both gateways, free source (seconds, no network)
cd _tools/tests
python3 -m pytest -q -m "not e2e"   # parity, financial/analytics references, mocked bootstrap (seconds)
python3 -m pytest -q -m e2e         # real venv builds and pip installs for each tool (minutes, needs network)
```

Browser tests need Node, Playwright with Chromium, and a local build:

```bash
bundle exec jekyll build -d /tmp/site
python3 -m http.server 4000 --bind 127.0.0.1 --directory /tmp/site &
cd _tools/tests/browser
node pages.test.js        # project pages, guides, /projects/, redirects, ZIP links, phone width
node stock.test.js        # Stock web app: visitor key, CSV import, demo, FX normalization, exports
node rebalancer.test.js   # Rebalancer web app: official FX, provenance, visitor key, failures, exports
node montecarlo.test.js   # Monte Carlo web app, seeded runs, no network, exports
node cpi.test.js          # CPI web app: Canadian-only, mocked gateway, failures, 12-month pages, CSV, layout
node freesource.test.js   # Yahoo Finance in the Rebalancer and Stock apps against the real gateway code (Yahoo mocked)
node sources.test.js      # the ordered source list: drag/keyboard reordering, persistence, keys, fallback chain, stale data, phone width
node live.test.js         # OPTIONAL: real Bank of Canada / ECB; Alpha Vantage only with ALPHAVANTAGE_KEY
```

The same deterministic checks run in CI on every pull request to `main`
(`.github/workflows/ci.yml`; read-only token, no secrets, providers mocked), together
with each desktop tool's tests on Linux. The CPI scraper's six Windows-only bootstrap
tests are excluded there by name; run them on Windows with
`python -m pytest -q files/tests/test_bootstrap.py`.

`SITE_URL` (default `http://127.0.0.1:4000`) points the browser tests at another
server. `CHROMIUM_ARGS` passes extra Chromium flags, split on whitespace.

The deterministic suites never contact a market-data provider. `harness.js` answers the
Bank of Canada, ECB, Alpha Vantage, Marketstack, Finnhub, Statistics Canada and a stand-in
CPI data gateway (`*.gateway.test`) with synthetic data in their exact response shapes,
runs the real market-data gateway Worker code for `md.gateway.test` (its upstream replaced
by `fixtures/yahoo-chart.mjs`), and blocks (and the suites fail on) any other host, including CDNs
(Chart.js is self-hosted). Desktop Tk smoke tests need a display: on Linux run them with
`xvfb-run -a -s "-screen 0 1366x768x24" python -m pytest files/tests`. `live.test.js` and
`live_fx_matrix.mjs` make a handful of real requests and are informational. Never
commit an API key; pass it through the environment.
