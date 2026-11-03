# Elijah Matthew | Wealth Management Portfolio Site

Professional GitHub Pages portfolio for wealth management projects, software applications, and practical finance tools.

## Site Structure
- `index.md` - Homepage with advisory focus and quick navigation
- `projects.md` - Project landing page
- `projects/` - Individual project pages (Monte Carlo, CPI, Portfolio Rebalancer, Stock Comparison & Analytics)
- `software.md` - Software and applications landing page
- `software/` - Individual application pages (Portfolio Dashboard, Audiobook Creation Tool)
- `about.md` - Professional profile
- `assets/main.scss` - Global visual styling
- `assets/js/stock-dashboard/`, `assets/js/portfolio-rebalancer/`, `assets/js/monte-carlo/` - Browser ES modules for the tool pages; `assets/js/market-data/` is the shared market-data layer (official Bank of Canada / ECB exchange rates, optional Alpha Vantage prices with the visitor's own key, CSV import, validation, caching; see `_tools/MARKET_DATA.md`) and `assets/js/shared/` the shared export and page helpers. Styles in `assets/css/project-pages.css` (layout `_layouts/project.html`, data `_data/tool_projects.yml`)
- `_tools/` - Build and test tooling for the four tool projects (not published): ZIP builder, bootstrap/launcher templates, parity and browser tests; see `_tools/README.md`

## Featured Tool
- **Stock Comparison & Analytics Tool** — in-browser comparison tool plus the downloadable Windows/macOS Python desktop app (v0.5.0). The browser version reads prices from the visitor's own CSV files (no account), from Alpha Vantage with the visitor's own free key (US and TSX/TSX-V; daily or weekly adjusted), or a labelled synthetic demo; currency normalization uses official Bank of Canada rates (ECB fallback). Tabs: Comparison (2–10 tickers, nine horizons, price-basis choice, exact-interval correlation heatmap, regression, charts), Snapshot, Export (XLSX/CSV/JSON) and Settings (key, cache, theme). The desktop app uses Alpha Vantage, Marketstack or Alpaca with the user's own key, or offline CSV files; it no longer uses Yahoo Finance.
- **Monte Carlo Retirement Simulator** — browser simulator (no backend, no third-party host) and downloadable Windows/macOS desktop app (v1.2.0) with Excel reports. Both use the same seeded generator, parsing rules and warnings; spending can be entered in retirement-year (default) or today's dollars.
- **Portfolio Rebalancer** — browser tool and desktop program (v1.2.0). Holdings are ticker, shares and target %; each ticker is identified (exchange, currency) and priced from the provider the visitor chooses with their own key (Alpha Vantage, Marketstack, Finnhub; Alpaca on the desktop). No plan is shown until every holding has a verified price or one the user supplied. Two modes (New Money / Rebalance), three invariants, whole-share option, official Bank of Canada exchange rates, per-price provenance, CSV/Excel export. Provider eligibility: `_tools/PROVIDER_MATRIX.md`.
- **CPI Web Scraper** — Windows desktop tool (v0.3.0) that writes Statistics Canada and FRED inflation, rates and PCE data into an existing Excel model; packaged from the canonical `elmatthe/CPI-Webscraper` repository.

The four desktop tools download as ZIPs from their project pages and start with one `Setup_and_Run-<tool>` launcher that finds or installs Python for the current user, repairs a private `.venv`, and launches the program.

## Featured Applications
- **Portfolio Dashboard** (v0.5.3, early release) — local-first multi-broker portfolio tracker with 11 brokers, 10 currencies, analytics, tax reporting, and rebalancing tools.
- **Audiobook Creation Tool** (v0.6.6) — Windows and macOS desktop app that turns PDF and TXT books into narrated MP3s with Edge TTS or optional local Kokoro and Chatterbox voices, with six tools for building, converting and tagging audiobook files.

## Run Locally (optional)
If you use Jekyll locally:
1. Install Ruby and Bundler.
2. Install dependencies: `bundle install`
3. Start server: `bundle exec jekyll serve`
4. Visit: `http://127.0.0.1:4000`

## Publishing
Push this repository to your GitHub Pages repository and GitHub will build/deploy automatically.
