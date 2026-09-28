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
| `tests/test_engine_parity.py` | Browser engines (`assets/js/monte-carlo`, `assets/js/portfolio-rebalancer`) vs the desktop `core.py` files. Uses Node through `tests/js_engines.mjs`. |
| `tests/test_bootstrap.py` | Bootstrap contract tests (mocked) and opt-in end-to-end runs (`-m e2e`). |
| `tests/browser/*.test.js` | Playwright tests against a locally served build. |

CPI Web Scraper is not rendered from these templates. Its folder
`projects/CPI-Webscraper/` is a copy of `elmatthe/CPI-Webscraper` `main` without the
private root `config.toml`. The CPI launcher and bootstrap are that repository's own.

## Common tasks

```bash
# After editing a template or projects.toml
python3 _tools/bootstrap/render.py            # write
python3 _tools/bootstrap/render.py --check    # verify (no writes)

# After changing any tool folder
python3 _tools/build_project_zips.py          # rebuild all four ZIPs
python3 _tools/build_project_zips.py --check  # verify the committed ZIPs are current

# Refresh the CPI copy from its canonical repository (never copy root config.toml)
git -C ../CPI-Webscraper archive main | tar -x -C projects/CPI-Webscraper
rm -f projects/CPI-Webscraper/config.toml
```

## Tests

Python tests need `pytest` and `numpy` (for the Monte Carlo parity reference):

```bash
cd _tools/tests
python3 -m pytest -q -m "not e2e"   # parity + mocked bootstrap (seconds)
python3 -m pytest -q -m e2e         # real venv builds and pip installs for each tool (minutes, needs network)
```

Browser tests need Node, Playwright with Chromium, and a local build:

```bash
bundle exec jekyll build -d /tmp/site
python3 -m http.server 4000 --bind 127.0.0.1 --directory /tmp/site &
cd _tools/tests/browser
node pages.test.js        # project pages, guides, /projects/, redirects, ZIP links, phone width
node stock.test.js        # Stock web app with mocked relays and synthetic Yahoo payloads
node rebalancer.test.js   # Rebalancer web app, live mode mocked, fallbacks, exports
node montecarlo.test.js   # Monte Carlo web app, no network, exports
node live.test.js         # OPTIONAL: real relays and Yahoo; informational only
```

`SITE_URL` (default `http://127.0.0.1:4000`) points the browser tests at another
server. `CHROMIUM_ARGS` passes extra Chromium flags, split on whitespace.

The deterministic suites never contact Yahoo Finance. Relay responses are generated
by `harness.js`. `live.test.js` depends on third-party availability: public CORS
relays change terms, rate-limit or go down, and Yahoo rate-limits some networks.
