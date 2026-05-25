---
layout: page
title: Portfolio Dashboard
permalink: /software/portfolio-dashboard/
summary: Local-first multi-broker portfolio tracker with analytics, tax reporting, and rebalancing tools.
last_updated: 2026-05-25
---

<section class="hero-panel">
  <div class="eyebrow">Desktop Application</div>
  <h1>Portfolio Dashboard</h1>
  <p class="lede">Local-first multi-broker portfolio tracker — 11 brokers, 10 currencies.</p>
  <div class="btn-row" style="margin-top: 12px;">
    <span class="action-pill" style="background:#1c7550; color:#fff; padding:4px 12px; border-radius:8px; font-size:0.9em;">v0.5.3</span>
    <span class="action-pill" style="background:#8f5f12; color:#fff; padding:4px 12px; border-radius:8px; font-size:0.9em;">Early Release</span>
  </div>
</section>

## Overview

Portfolio Dashboard is a desktop application for tracking investments across multiple brokers and currencies. It runs entirely on your machine — outbound network calls go only to Yahoo Finance for prices and (optionally) the Bank of Canada Valet API for FX rates.

<img src="{{ '/assets/images/portfolio-dashboard-overview.svg' | relative_url }}" alt="Portfolio Dashboard workflow: Import → Track & Analyze → Report" style="width:100%; max-width:1200px; margin:24px 0;" />

## What It Does

- **Multi-broker import** — CSV, TSV, XLSX, and PDF trade files from 11 Canadian and international brokers, auto-detected by file content
- **10-currency support** — CAD, USD, GBP, EUR, JPY, AUD, CHF, HKD, SEK, NOK with trade-date FX rates for CRA compliance
- **CRA-compliant ACB engine** — per-security-per-account adjusted cost base with superficial-loss rules and commission folding
- **CAD-equivalent aggregation** — all values normalized to CAD for unified reporting
- **SHA-256 deduplication** — prevents duplicate row insertion on re-import
- **14 account types** — TFSA, RRSP, RESP, RRIF, FHSA, LIRA, Margin, Non-Registered, IRA, Roth IRA, Traditional IRA, Individual, Crypto, Other
- **Multi-profile** — each profile is its own SQLite database; switch without restarting

### Supported Brokers

Questrade, Wealthsimple, RBC Direct Investing, CIBC Investor's Edge, TD Direct Investing, BMO InvestorLine, Scotia iTRADE, Interactive Brokers, National Bank Direct Brokerage, Fidelity, HSBC InvestDirect.

## Reports & Exports

- **Excel Export** — portfolio summary, holdings, capital gains (native + CAD), transaction history, price history with conditional formatting
- **CRA Tax Report PDF** — Schedule 3-style realized-gains table with superficial loss adjustments and TFSA activity summary
- **Annual Portfolio Report PDF** — five-page report with charts, performance vs. SPY, contributors analysis, holdings detail, and dividend history
- **JSON Data Export** — full transaction and ticker-map backup

## Analytics

Time-period selector (1M, 3M, 6M, YTD, 1Y, 3Y, All) synchronized across all views:

- Per-account performance with distinct curves for multiple accounts at the same broker
- Lifetime ROI calculation
- Weekly portfolio value history with gain-vs-deposits overlay
- Performance attribution by holding contribution
- Pearson correlation matrix on weekly returns
- Annualized return, volatility, and Sharpe ratio
- Dividend tracker with monthly history, yield-on-cost, trailing-12-month totals, and projected payments

## Decision Tools

- **Rebalancing Advisor** — two modes (new money and pure rebalance) with three enforced invariants: budget cap, sell-proceeds ceiling, and cross-account funding flags
- **What-If Simulator** — buy/sell/lump-sum scenarios with capital-gains breakdown and tax estimates at your marginal rate
- **Price Alerts** — buy-below and sell-above thresholds evaluated on each refresh

## Canadian-Specific Features

- **TFSA contribution-room calculator** — CRA's 2009–2026 annual limit schedule with withdrawal-carryback accounting and over-contribution flagging
- **Schedule 3 PDF** — CRA-format capital gains reporting
- **Dividend classification** — eligible-Canadian vs. foreign-US split

## Privacy

All data stays on your machine. The only outbound calls are to Yahoo Finance for live prices and (opt-in) Bank of Canada Valet API for FX rates. No cloud accounts, no telemetry.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | FastAPI, SQLAlchemy, SQLite, pandas, openpyxl, pdfplumber, reportlab, matplotlib |
| Market Data | yfinance, Bank of Canada Valet API |
| Frontend | React 18, TypeScript, Vite, TanStack Query, Tailwind CSS, Recharts |
| Desktop | Electron 30 |
| Packaging | PyInstaller (backend), electron-builder NSIS (installer) |
| Tests | pytest — 113 tests covering parsers, FX, profiles, and registry integrity |

## Roadmap

| Version | Highlights |
|---------|------------|
| 0.6.0 | Currency-exposure widget and per-currency breakdown |
| 0.7.0 | Options support and broker-API integrations |
| 0.8.0 | Background daily price refresh, push-style alerts |
| 1.0.0 | Code-signed Mac/Windows installers, App Store and Microsoft Store distribution |

## Download & Install

<div class="btn-row">
  <a class="btn" href="https://github.com/elmatthe/portfolio-dashboard/releases/download/v0.5.3/Portfolio.Dashboard.Setup.0.5.3.exe">Download Installer (v0.5.3)</a>
  <a class="btn btn-secondary" href="https://github.com/elmatthe/portfolio-dashboard/releases/tag/v0.5.3">View Release Notes</a>
  <a class="btn btn-secondary" href="https://github.com/elmatthe/portfolio-dashboard">GitHub Repository</a>
</div>

**Installation:** download the `.exe`, double-click, and follow the prompts. Installs in seconds.

<section class="callout">
  <p><strong>SmartScreen notice:</strong> the installer is not yet code-signed. Windows may show a SmartScreen warning — click <strong>"More info"</strong> then <strong>"Run anyway"</strong> to proceed. Code-signing is planned for v1.0.0.</p>
</section>

## Disclaimer

This application is provided for **illustrative and educational purposes only** and does not constitute financial, tax, or investment advice. Tax calculations are estimates — consult a qualified professional before making financial decisions. Past performance does not guarantee future results.
