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
- `assets/js/stock-dashboard/`, `assets/js/portfolio-rebalancer/`, `assets/js/monte-carlo/` - Browser ES modules for the tool pages; `assets/js/yahoo/` is the shared Yahoo Finance transport (CORS relay pipeline, payload validation, Yahoo `=X` FX) and `assets/js/shared/` the shared export and page helpers. Styles in `assets/css/project-pages.css` (layout `_layouts/project.html`, data `_data/tool_projects.yml`)
- `_tools/` - Build and test tooling for the four tool projects (not published): ZIP builder, bootstrap/launcher templates, parity and browser tests; see `_tools/README.md`

## Featured Tool
- **Stock Comparison & Analytics Tool** — in-browser comparison tool plus the downloadable Windows/macOS Python desktop app (v0.4.0). Yahoo Finance is its only market-data source (prices and `=X` FX pairs). The browser version has Comparison (2–10 tickers, nine horizons, exact-interval correlation heatmap, regression, charts, currency normalization), Snapshot, Export (XLSX/CSV/JSON) and Settings (relay health, personal proxy, cache, theme) tabs, plus a clearly labelled synthetic offline demo. Browser requests go through a fallback chain of public CORS relays that act as transport only; the site owner can set `data-site-proxy` on the tool container to a deployed copy of `assets/js/yahoo/proxy-worker.example.js` for dependable access.
- **Monte Carlo Retirement Simulator** — browser simulator (no backend) and downloadable Windows/macOS desktop app (v1.1.0) with Excel reports, plus setup guide.
- **Portfolio Rebalancer** — browser tool and desktop program (v1.1.0) with two modes (New Money / Rebalance), three invariants (budget cap, sell-funds-buys, cross-account funding), optional live Yahoo Finance prices and FX, and CSV/Excel export.
- **CPI Web Scraper** — Windows desktop tool (v0.3.0) that writes Statistics Canada and FRED inflation, rates and PCE data into an existing Excel model; packaged from the canonical `elmatthe/CPI-Webscraper` repository.

The four desktop tools download as ZIPs from their project pages and start with one `Setup_and_Run-<tool>` launcher that finds or installs Python for the current user, repairs a private `.venv`, and launches the program.

## Featured Applications
- **Portfolio Dashboard** (v0.5.3, early release) — local-first multi-broker portfolio tracker with 11 brokers, 10 currencies, analytics, tax reporting, and rebalancing tools.
- **Audiobook Creation Tool** (v0.4.0) — cross-platform desktop app that turns ebooks, PDFs, and text into tagged audiobooks using cloud-based (Edge TTS) or local (Kokoro-82M) AI voices.

## Run Locally (optional)
If you use Jekyll locally:
1. Install Ruby and Bundler.
2. Install dependencies: `bundle install`
3. Start server: `bundle exec jekyll serve`
4. Visit: `http://127.0.0.1:4000`

## Publishing
Push this repository to your GitHub Pages repository and GitHub will build/deploy automatically.
