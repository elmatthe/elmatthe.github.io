---
layout: page
title: Stock Comparison & Analytics Tool
permalink: /projects/stock-data-dashboard-tool/
summary: Stock comparison and analytics workflow with an in-browser research dashboard (live Yahoo Finance data, correlation and regression, saved-TipRanks analyst view, XLSX export), a downloadable cross-platform Python desktop app, and a setup guide.
last_updated: 2026-09-28
---

<section class="hero-panel">
  <div class="eyebrow">Market Analytics Project</div>
  <h1>Stock Comparison &amp; Analytics Tool</h1>
  <p class="lede">Compare stocks, ETFs, and indexes on returns, risk, correlation, and regression, and review analyst consensus next to live prices. Use the browser dashboard below (no install, nothing to sign in to), or download the desktop program to run the Python workflow locally.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/stock-data-dashboard-tool-v0.3.0.zip' | relative_url }}" download="stock-data-dashboard-tool-v0.3.0.zip">Download stock-data-dashboard-tool-v0.3.0.zip</a>
</div>

## Guides
<ul class="link-list">
  <li><a href="{{ '/projects/stock-data-dashboard-guide/' | relative_url }}">Open Stock Comparison &amp; Analytics Tool Setup Guide (Web Page)</a></li>
</ul>

## Workflow Snapshot
<figure class="project-visual">
  <img src="{{ '/assets/images/stock-data-dashboard-workflow.svg' | relative_url }}" alt="Three-step workflow showing security selection, data fetch and analysis, and review and export" />
  <figcaption class="muted">A three-step workflow from selecting securities to fetching and analyzing market data to reviewing metrics and exporting results.</figcaption>
</figure>

## About This Tool
The browser dashboard runs entirely in your browser; no server of mine is involved. It uses the comparison engine and page layout of my TipRanks Automation Tool, rewritten as browser JavaScript modules, and has four sections:

- **Multi-Stock Comparison**: 2–10 tickers over nine horizons (1D to 5Y). It shows total and annualized return, volatility, Sharpe ratio, and max drawdown, plus an exact-interval correlation heatmap, benchmark regression, and four charts. Optional **currency normalization** converts every security to USD, CAD, EUR, or GBP using European Central Bank reference rates before any metric is computed.
- **Security Research**: a live Yahoo Finance snapshot for one ticker, plus an **analyst consensus view** (Smart Score, price targets, implied move, ranked analysts, insider activity). The consensus view comes from a Research result saved by the desktop TipRanks Automation Tool and opened locally. The file is read in your browser and never uploaded.
- **Export**: an XLSX workbook with the same five sheets as the desktop tool, plus CSV and JSON downloads, all generated in the browser.
- **Settings**: data-proxy health, an optional personal proxy or corsproxy.io key, cache, and a light/dark theme.

The downloadable desktop app (v0.3.0) remains a separate Python program with its own Excel, CSV, and JPG exports and additional rolling-window charts.

## Interactive Web Dashboard
<link rel="stylesheet" href="{{ '/assets/css/stock-dashboard.css' | relative_url }}">
<!-- data-site-proxy: set to an https URL template containing {url} (for example a deployed
     copy of assets/js/stock-dashboard/proxy-worker.example.js) so every visitor tries it first. -->
<div id="sdd-app" class="sdd-app" data-theme="dark" data-site-proxy="" data-worker-example="{{ '/assets/js/stock-dashboard/proxy-worker.example.js' | relative_url }}">
  <div class="sdd-shell">
    <header class="sdd-masthead">
      <div class="sdd-brand">
        <h2>Stock Comparison &amp; Analytics</h2>
        <p>Browser research dashboard · Yahoo Finance market data · saved TipRanks research</p>
      </div>
      <aside class="sdd-status-widget" aria-label="Live data status">
        <strong>Live data <span id="sddPipelineState" class="sdd-pill idle">Not tested</span></strong>
        <span id="sddPipelineDetail">No live request yet.</span>
        <small id="sddCacheState">Cache: 0 responses</small>
        <button id="sddTestConnection" type="button" class="secondary">Test connection</button>
        <small id="sddTestState" role="status" aria-live="polite"></small>
      </aside>
    </header>
  </div>
  <nav class="sdd-tabs" role="tablist" aria-label="Dashboard sections">
    <button type="button" role="tab" id="sddTab-compare" aria-controls="sddPanel-compare" aria-selected="true">Multi-Stock Comparison</button>
    <button type="button" role="tab" id="sddTab-research" aria-controls="sddPanel-research" aria-selected="false" tabindex="-1">Security Research</button>
    <button type="button" role="tab" id="sddTab-export" aria-controls="sddPanel-export" aria-selected="false" tabindex="-1">Export</button>
    <button type="button" role="tab" id="sddTab-settings" aria-controls="sddPanel-settings" aria-selected="false" tabindex="-1">Settings</button>
  </nav>
  <div class="sdd-body">
    <noscript><div class="sdd-notice error"><p>This dashboard needs JavaScript enabled.</p></div></noscript>
    <!-- ================= Compare ================= -->
    <section id="sddPanel-compare" role="tabpanel" aria-labelledby="sddTab-compare">
      <div class="sdd-panel">
        <form id="sddCompareForm" class="sdd-form" novalidate>
          <fieldset class="sdd-fieldset">
            <legend>Data source</legend>
            <label class="sdd-choice"><input type="radio" name="source" value="live" checked> Live · Yahoo Finance</label>
            <label class="sdd-choice"><input type="radio" name="source" value="demo"> Offline demo · synthetic prices</label>
          </fieldset>
          <fieldset class="sdd-fieldset">
            <legend>Tickers (2–10)</legend>
            <div id="sddTickerList" class="sdd-ticker-list"></div>
            <div class="sdd-actions">
              <button id="sddAddTicker" type="button" class="secondary">Add ticker</button>
              <small class="muted">Stocks, ETFs, or indexes. Non-US listings use Yahoo suffixes (XIU.TO, ISF.L); indexes use ^ (^GSPC).</small>
            </div>
          </fieldset>
          <div class="sdd-field">
            <label for="sddHorizon">Horizon</label>
            <select id="sddHorizon" name="horizon">
              <option value="1D">1D</option><option value="1M">1M</option><option value="3M">3M</option><option value="6M">6M</option><option value="9M">9M</option><option value="YTD">YTD</option><option value="1Y" selected>1Y</option><option value="3Y">3Y</option><option value="5Y">5Y</option>
            </select>
          </div>
          <div class="sdd-field">
            <label for="sddRiskFree">Risk-free rate (% / yr)</label>
            <input id="sddRiskFree" name="riskFree" type="number" step="0.01" min="0" max="25" value="0" inputmode="decimal">
          </div>
          <div class="sdd-field">
            <label for="sddNormalize">Normalize to currency</label>
            <select id="sddNormalize" name="normalize">
              <option value="off" selected>Off (native listing currency)</option><option value="USD">USD</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
            </select>
          </div>
          <div class="sdd-actions">
            <button id="sddRunCompare" type="submit">Run comparison</button>
            <button id="sddCancelCompare" type="button" class="secondary" disabled>Cancel</button>
          </div>
        </form>
        <p id="sddCompareStatus" class="sdd-status" role="status" aria-live="polite">Ready. Enter 2–10 tickers and run the comparison.</p>
        <progress id="sddCompareProgress" max="100" value="0" aria-label="Comparison progress"></progress>
        <ul id="sddTickerProgress" class="sdd-progress-list" aria-label="Per-ticker fetch status"></ul>
      </div>
      <div id="sddCompareNotice" class="sdd-notice" role="alert" hidden></div>
      <div id="sddCompareResult" hidden>
        <p id="sddCompareMeta" class="muted"></p>
        <div id="sddTiles" class="sdd-tiles"></div>
        <div class="sdd-card wide">
          <h4>Performance &amp; risk</h4>
          <div class="sdd-table-scroll">
            <table id="sddMetricsTable">
              <thead><tr><th scope="col">Ticker</th><th scope="col">Currency</th><th scope="col" class="num">Total return</th><th scope="col" class="num">Annualized return</th><th scope="col" class="num">Annualized volatility</th><th scope="col" class="num">Sharpe</th><th scope="col" class="num">Max drawdown</th><th scope="col" class="num">Return obs.</th><th scope="col">Actual price range</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <p class="muted">Annualized figures extrapolate the available daily log returns to 252 trading periods, so they overstate what short horizons (1D–3M) can tell you.</p>
          <div id="sddCompareWarnings"></div>
        </div>
        <div class="sdd-grid">
          <div class="sdd-card"><h4>Indexed price (start = 100)</h4><div class="sdd-chart"><canvas id="sddChartIndexed" aria-label="Indexed price chart" role="img"></canvas></div></div>
          <div class="sdd-card"><h4>Drawdown from running peak</h4><div class="sdd-chart"><canvas id="sddChartDrawdown" aria-label="Drawdown chart" role="img"></canvas></div></div>
          <div class="sdd-card"><h4>Risk / return</h4><div class="sdd-chart"><canvas id="sddChartScatter" aria-label="Annualized volatility versus annualized return" role="img"></canvas></div></div>
          <div class="sdd-card"><h4>Cumulative return</h4><div class="sdd-chart"><canvas id="sddChartCumulative" aria-label="Cumulative return chart" role="img"></canvas></div></div>
          <div class="sdd-card wide">
            <h4>Correlation heatmap</h4>
            <p class="muted">Daily adjusted-close log returns over identical intervals. Each cell shows the correlation and, underneath, the number of shared returns; "n/a" means fewer than three shared returns or zero variance.</p>
            <div class="sdd-legend"><span>−1</span><span class="sdd-legend-bar"></span><span>+1</span></div>
            <div id="sddCorrelation" class="sdd-table-scroll sdd-corr"></div>
            <div id="sddDiversification" class="muted"></div>
          </div>
          <div class="sdd-card wide">
            <h4>Regression vs benchmark</h4>
            <div class="sdd-form">
              <div class="sdd-field"><label for="sddBenchmark">Benchmark (X variable)</label><select id="sddBenchmark"></select></div>
            </div>
            <div id="sddRegression" class="sdd-table-scroll"></div>
          </div>
          <div class="sdd-card wide"><h4>Sources and timestamps</h4><ul id="sddCompareSources" class="sdd-list"></ul></div>
        </div>
      </div>
    </section>
    <!-- ================= Research ================= -->
    <section id="sddPanel-research" role="tabpanel" aria-labelledby="sddTab-research" hidden>
      <div class="sdd-panel">
        <h3>Live market snapshot</h3>
        <form id="sddSnapshotForm" class="sdd-form" novalidate>
          <div class="sdd-field">
            <label for="sddSnapshotTicker">Ticker</label>
            <input id="sddSnapshotTicker" name="ticker" maxlength="20" autocomplete="off" spellcheck="false" placeholder="AAPL, TD.TO, or XIU.TO" value="AAPL">
          </div>
          <div class="sdd-actions"><button id="sddSnapshotRun" type="submit">Load snapshot</button></div>
        </form>
        <p id="sddSnapshotStatus" class="sdd-status" role="status" aria-live="polite">Loads one year of Yahoo Finance history for a single ticker.</p>
        <div id="sddSnapshotNotice" class="sdd-notice" role="alert" hidden></div>
        <div id="sddSnapshotResult" class="sdd-grid" hidden>
          <div class="sdd-card"><h4 id="sddSnapshotTitle">Snapshot</h4><dl id="sddSnapshotIdentity"></dl></div>
          <div class="sdd-card"><h4>Market data</h4><dl id="sddSnapshotMarket"></dl></div>
          <div class="sdd-card wide"><h4>One-year adjusted price</h4><div class="sdd-chart"><canvas id="sddChartSnapshot" aria-label="One-year price chart" role="img"></canvas></div><p id="sddSnapshotSource" class="muted"></p></div>
        </div>
      </div>
      <div class="sdd-panel">
        <h3>Analyst consensus <span class="muted">(TipRanks Automation Tool research)</span></h3>
        <p class="muted">TipRanks data requires a private API key, which must never be placed in a public web page, so this page does not call TipRanks. Open a <code>record.json</code> Research result saved by the desktop TipRanks Automation Tool (from <code>files/results/&lt;id&gt;/</code>). The file is read in this browser and is never uploaded. You can also load a synthetic demo.</p>
        <div class="sdd-form">
          <div class="sdd-field"><label for="sddRecordFile">Saved research file (record.json)</label><input id="sddRecordFile" type="file" accept=".json,application/json"></div>
          <div class="sdd-actions">
            <button id="sddRecordDemo" type="button" class="secondary">Load synthetic demo</button>
            <button id="sddRecordLive" type="button" class="secondary" disabled>Compare with live Yahoo price</button>
            <button id="sddRecordClear" type="button" class="secondary" disabled>Clear</button>
          </div>
        </div>
        <p id="sddRecordStatus" class="sdd-status" role="status" aria-live="polite">No research loaded.</p>
        <div id="sddResearchResult" hidden>
          <h3 id="sddResearchTitle"></h3>
          <p id="sddResearchMeta" class="muted"></p>
          <div id="sddResearchWarnings"></div>
          <div class="sdd-grid">
            <div class="sdd-card"><h4>Identity and saved market data</h4><dl id="sddResearchIdentity"></dl><div class="sdd-metric"><span>Smart Score</span><strong id="sddSmartScore">Unavailable</strong><small class="muted">Source: TipRanks</small></div></div>
            <div class="sdd-card"><h4>Consensus and price targets</h4><dl id="sddResearchTargets"></dl><p class="muted">Implied move = (average target − current price) ÷ current price × 100.</p></div>
            <div class="sdd-card wide"><h4>Target range</h4><div id="sddTargetTrack"></div><p id="sddTargetText" class="muted"></p></div>
            <div class="sdd-card"><h4>Analyst-target distribution</h4><div id="sddTargetDistribution"></div></div>
            <div class="sdd-card"><h4>Top analyst insights</h4><div id="sddTopAnalysts" class="sdd-insights"></div></div>
            <div class="sdd-card wide"><h4>Recent analyst actions</h4><div id="sddAnalystActions" class="sdd-table-scroll"></div></div>
            <div class="sdd-card wide"><h4>Insider activity</h4><div id="sddInsiders" class="sdd-table-scroll"></div></div>
            <div class="sdd-card"><h4>News and sentiment</h4><ul id="sddNews" class="sdd-list"></ul></div>
            <div class="sdd-card"><h4>Research coverage</h4><ul id="sddCoverage" class="sdd-list"></ul></div>
            <div class="sdd-card wide"><h4>Source comparison</h4><div id="sddSourceComparison" class="sdd-table-scroll"></div></div>
            <div class="sdd-card wide"><h4>Sources and timestamps</h4><ul id="sddResearchSources" class="sdd-list"></ul></div>
          </div>
        </div>
      </div>
    </section>
    <!-- ================= Export ================= -->
    <section id="sddPanel-export" role="tabpanel" aria-labelledby="sddTab-export" hidden>
      <div class="sdd-panel">
        <h3>Export</h3>
        <p>Files are generated in your browser from the latest completed comparison and the loaded research; nothing is re-fetched. The XLSX workbook uses the desktop tool's five sheets: Read Me &amp; Sources, Executive Summary, Model &amp; Calculations, Portfolio Risk, and Raw Data Ingestion. It contains values only (no macros or formulas), and text cells are protected against spreadsheet formula injection.</p>
        <fieldset class="sdd-fieldset">
          <legend>Include</legend>
          <label class="sdd-choice"><input id="sddExportComparison" type="checkbox" checked> <span id="sddExportComparisonLabel">Latest comparison (none yet)</span></label>
          <label class="sdd-choice"><input id="sddExportResearch" type="checkbox" checked> <span id="sddExportResearchLabel">Loaded research (none yet)</span></label>
        </fieldset>
        <div class="sdd-actions" style="margin-top:.8rem;">
          <button id="sddExportXlsx" type="button" disabled>Download XLSX workbook</button>
          <button id="sddExportMetrics" type="button" class="secondary" disabled>Metrics CSV</button>
          <button id="sddExportCorrelation" type="button" class="secondary" disabled>Correlation CSV</button>
          <button id="sddExportPrices" type="button" class="secondary" disabled>Prices CSV</button>
          <button id="sddExportJson" type="button" class="secondary" disabled>JSON snapshot</button>
        </div>
        <p id="sddExportStatus" class="sdd-status" role="status" aria-live="polite">Run a comparison or load research to enable exports.</p>
      </div>
    </section>
    <!-- ================= Settings ================= -->
    <section id="sddPanel-settings" role="tabpanel" aria-labelledby="sddTab-settings" hidden>
      <div class="sdd-panel">
        <h3>Appearance</h3>
        <div class="sdd-form">
          <div class="sdd-field"><label for="sddTheme">Theme</label><select id="sddTheme"><option value="dark">Dark (site default)</option><option value="light">Light</option><option value="system">Match system</option></select></div>
        </div>
      </div>
      <div class="sdd-panel">
        <h3>Live data proxies</h3>
        <p class="muted">Yahoo Finance does not allow direct browser requests from other websites (CORS), so live requests go through public proxies. They are tried in order, and each response is checked before it is used. A proxy that fails is skipped for a cooldown period, and the last one that worked is tried first. Only the ticker and date range are sent.</p>
        <div class="sdd-table-scroll">
          <table class="sdd-proxy-table">
            <thead><tr><th scope="col">Use</th><th scope="col">Proxy</th><th scope="col">Status</th><th scope="col">Last result</th></tr></thead>
            <tbody id="sddProxyRows"></tbody>
          </table>
        </div>
        <div class="sdd-actions" style="margin-top:.6rem;">
          <button id="sddProxyTest" type="button">Test all proxies</button>
          <button id="sddProxyReset" type="button" class="secondary">Reset proxy health</button>
        </div>
        <p id="sddProxyStatus" class="sdd-status" role="status" aria-live="polite"></p>
      </div>
      <div class="sdd-panel">
        <h3>Your own proxy (optional)</h3>
        <p class="muted">Both settings below are saved only in this browser's local storage.</p>
        <form id="sddProxySettings" class="sdd-form" novalidate>
          <div class="sdd-field">
            <label for="sddCorsproxyKey">corsproxy.io API key</label>
            <input id="sddCorsproxyKey" type="password" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Paste a key from console.corsproxy.io">
            <small>corsproxy.io requires a key for requests from websites. Its free plan is limited.</small>
          </div>
          <div class="sdd-field">
            <label for="sddCustomProxy">Custom proxy URL template</label>
            <input id="sddCustomProxy" type="url" autocomplete="off" spellcheck="false" placeholder="https://your-worker.example.workers.dev/?url={url}">
            <small>Must be https and contain <code>{url}</code>. <a id="sddWorkerLink" href="#">Example Cloudflare Worker</a>.</small>
          </div>
          <div class="sdd-actions">
            <button type="submit">Save proxy settings</button>
            <button id="sddProxyClear" type="button" class="secondary">Clear</button>
          </div>
        </form>
        <p id="sddProxySettingsStatus" class="sdd-status" role="status" aria-live="polite"></p>
      </div>
      <div class="sdd-panel">
        <h3>Cache</h3>
        <p class="muted">Successful Yahoo Finance responses are cached for 15 minutes in this tab's session storage, which reduces rate limiting when you re-run a comparison.</p>
        <div class="sdd-actions"><button id="sddClearCache" type="button" class="secondary">Clear cached responses</button><span id="sddCacheCount" class="muted"></span></div>
      </div>
    </section>
  </div>
  <p class="sdd-footer-note"><strong>Disclaimer:</strong> for education and analysis only; not investment, financial, legal, or tax advice. Live prices are fetched best-effort through third-party proxies and may be delayed, adjusted, or unavailable. Analyst data is shown only from files you open yourself.</p>
</div>

## What This Tool Includes
<div class="card-grid">
  <section class="card">
    <h3>Multi-Ticker Comparison</h3>
    <p class="muted">2–10 securities over nine horizons, with total and annualized return, volatility, Sharpe ratio, and max drawdown, calculated with the same method as the desktop TipRanks Automation Tool.</p>
  </section>
  <section class="card">
    <h3>Correlation &amp; Regression</h3>
    <p class="muted">A correlation heatmap over identical return intervals with shared-observation counts, diversification flags, and alpha/beta/R²/p-value regression against any chosen benchmark.</p>
  </section>
  <section class="card">
    <h3>Analyst Research View</h3>
    <p class="muted">Consensus, Smart Score, price-target range, implied move against the live price, rank-ordered analyst insights, and insider activity from saved TipRanks research files.</p>
  </section>
  <section class="card">
    <h3>Exports &amp; Desktop App</h3>
    <p class="muted">Five-sheet XLSX, CSV, and JSON downloads in the browser. The desktop app adds Excel/CSV/JPG exports, rolling charts, and Windows/macOS launchers.</p>
  </section>
</div>

## Key Features
<ul class="link-list">
  <li>Live Yahoo Finance history through several public proxies, with fallback, response checks, and a 15-minute cache</li>
  <li>Offline demo mode with deterministic synthetic prices (no network needed)</li>
  <li>Currency normalization (USD/CAD/EUR/GBP) using ECB reference rates, with Yahoo FX as a fallback</li>
  <li>Correlation heatmap, diversification flags, and benchmark regression</li>
  <li>Indexed-price, drawdown, cumulative-return, and risk/return charts</li>
  <li>Analyst consensus and price targets from locally opened TipRanks Automation Tool research</li>
  <li>XLSX, CSV, and JSON exports built in the browser</li>
  <li>Desktop app: Excel, CSV, and JPG exports, rolling-window charts, and Windows/macOS setup launchers</li>
</ul>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
<script type="module" src="{{ '/assets/js/stock-dashboard/app.js' | relative_url }}"></script>
