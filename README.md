# Elijah Matthew | Wealth Management Portfolio Site

Professional GitHub Pages portfolio for wealth management projects, software applications, and practical finance tools.

## Site Structure
- `index.md` - Homepage with advisory focus and quick navigation
- `projects.md` - Project landing page
- `projects/` - Individual project pages (Monte Carlo, CPI, Portfolio Rebalancer)
- `software.md` - Software and applications landing page
- `software/` - Individual application pages (Portfolio Dashboard, Audiobook Creation Tool)
- `about.md` - Professional profile
- `assets/main.scss` - Global visual styling

## Featured Tool
- **Stock Comparison & Analytics Tool** (v0.3.0) — browser dashboard and downloadable cross-platform Python desktop app for comparing stocks/ETFs/indexes with performance and risk metrics, correlation, and regression. v0.3.0 **adds FX (currency) normalization** — convert every security to one common currency (USD/CAD/EUR/GBP) before metrics so cross-currency comparisons reflect true performance instead of FX drift — and fixes/flags bugs found during a focused review (see the tool's CHANGELOG and handoff log).
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
