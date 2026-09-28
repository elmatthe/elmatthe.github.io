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
- `assets/js/stock-dashboard/` - Browser ES modules for the Stock Comparison & Analytics dashboard (proxy pipeline, Yahoo Finance adapter, analytics, research view, exports); page styles in `assets/css/stock-dashboard.css`

## Featured Tool
- **Stock Comparison & Analytics Tool** — in-browser research dashboard plus the downloadable cross-platform Python desktop app (v0.3.0). The browser dashboard uses the TipRanks Automation Tool comparison engine and layout, rewritten as client-side modules. It has four tabs: Multi-Stock Comparison (2–10 tickers, nine horizons, exact-interval correlation heatmap, regression, charts, ECB-rate currency normalization), Security Research (live Yahoo snapshot, plus analyst consensus from a locally opened TipRanks research file), Export (five-sheet XLSX/CSV/JSON), and Settings (proxy health, personal proxy, cache, theme). Live Yahoo Finance data goes through a fallback chain of public CORS proxies; the site owner can set `data-site-proxy` on the page to a deployed copy of `assets/js/stock-dashboard/proxy-worker.example.js` for dependable access.
- **Monte Carlo Retirement Simulator** — browser scenario tool, downloadable desktop app, and setup guide.
- **Portfolio Rebalancer** — browser tool and desktop program with two modes (New Money / Rebalance), three invariants (budget cap, sell-funds-buys, cross-account funding), optional live Yahoo Finance data, and CSV/Excel export. Desktop program uses a Python package structure with `setup.bat` / `run.bat` for one-click Windows setup.
- **CPI Webscraper** — automated CPI data pipeline with dashboard and setup guide.

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
