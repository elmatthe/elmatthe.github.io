---
layout: page
title: Stock Comparison & Analytics Tool
permalink: /projects/stock-data-dashboard-tool/
summary: Stock comparison and analytics workflow with an interactive in-browser dashboard, downloadable cross-platform Python desktop app, and setup guide.
last_updated: 2026-06-19
---

<section class="hero-panel">
  <div class="eyebrow">Market Analytics Project</div>
  <h1>Stock Comparison &amp; Analytics Tool</h1>
  <p class="lede">A cross-platform Python GUI tool for comparing stocks, ETFs, and indexes using historical returns, risk metrics, correlation analysis, regression analytics, and exportable chart outputs. Use the interactive web dashboard below, or download the desktop program to run the same workflow locally.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/stock-data-dashboard-tool-v0.2.5.zip' | relative_url }}" download="stock-data-dashboard-tool-v0.2.5.zip">Download stock-data-dashboard-tool-v0.2.5.zip</a>
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
This project compares multiple securities side by side using historical price data. It computes per-security performance and risk metrics, a correlation matrix, regression analytics against a chosen benchmark, and a set of comparison charts.

The browser version below mirrors the desktop workflow for quick analysis directly on this site. It supports an **Offline Sample** mode (built-in `sample_prices.csv` demo data) and a **Yahoo Finance** mode that fetches live historical prices. The downloadable desktop app adds Excel, CSV, and JPG image exports plus additional charts.

## Interactive Web Dashboard
<div class="tool-grid sdd-theme">
  <section class="tool-card">
    <h3>Inputs</h3>
    <div class="field">
      <label for="sddTickers">Tickers (comma separated)</label>
      <input id="sddTickers" type="text" value="AAPL, MSFT, SPY" placeholder="e.g. AAPL, MSFT, SPY, QQQ" />
      <div class="muted">Stocks, ETFs, or indexes. For non-US listings use Yahoo suffixes (e.g. XIU.TO, ISF.L).</div>
    </div>
    <div class="sdd-input-grid">
      <div class="field">
        <label for="sddDataSource">Data source</label>
        <select id="sddDataSource" class="sheet-select">
          <option value="yahoo" selected>Yahoo Finance (live)</option>
          <option value="offline">Offline Sample CSV</option>
        </select>
      </div>
      <div class="field" id="sddRangeField">
        <label for="sddRange">History range</label>
        <select id="sddRange" class="sheet-select">
          <option value="6mo">6 months</option>
          <option value="1y" selected>1 year</option>
          <option value="2y">2 years</option>
          <option value="5y">5 years</option>
        </select>
      </div>
      <div class="field">
        <label for="sddRiskFree">Risk-free rate (% / yr)</label>
        <input id="sddRiskFree" type="number" step="0.01" value="0" min="0" />
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" id="sddRunBtn" type="button">Run Analysis</button>
      <button class="btn btn-secondary" id="sddSampleBtn" type="button">Load Offline Sample</button>
    </div>
    <div id="sddStatus" class="muted sdd-status-line">Ready. Choose a data source and run the analysis.</div>
    <p class="muted" id="sddSampleHint" style="display:none;">Offline Sample mode loads the built-in <code>test-files/sample_prices.csv</code> dataset (AAPL, MSFT, XIU.TO for 2024-01-02 to 2024-01-04). It is a small demo dataset; switch to Yahoo Finance for longer live history.</p>
  </section>

  <section class="tool-card">
    <h3>Dashboard Metrics</h3>
    <div class="summary-grid" id="sddSummaryTiles">
      <div class="summary-item"><span>Securities Compared</span><strong>Run analysis</strong></div>
      <div class="summary-item"><span>Date Range</span><strong>Run analysis</strong></div>
      <div class="summary-item"><span>Observations</span><strong>Run analysis</strong></div>
      <div class="summary-item"><span>Best Total Return</span><strong>Run analysis</strong></div>
    </div>
    <div class="table-wrap">
      <table class="sheet-table sdd-metrics-table" id="sddMetricsTable">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Total Return</th>
            <th>Annualized Return</th>
            <th>Annualized Volatility</th>
            <th>Sharpe Ratio</th>
            <th>Max Drawdown</th>
            <th>Observations</th>
            <th>Currency</th>
          </tr>
        </thead>
        <tbody id="sddMetricsBody">
          <tr><td colspan="8" class="muted">Metrics will appear here after you run the analysis.</td></tr>
        </tbody>
      </table>
    </div>
    <div id="sddCurrencyWarning" class="muted"></div>
  </section>
</div>

<div class="tool-grid sdd-theme">
  <section class="tool-card">
    <h3>Indexed Price (Base 100)</h3>
    <div class="sdd-chart-wrap"><canvas id="sddIndexedChart" aria-label="Indexed price chart"></canvas></div>
  </section>
  <section class="tool-card">
    <h3>Cumulative Return</h3>
    <div class="sdd-chart-wrap"><canvas id="sddCumulativeChart" aria-label="Cumulative return chart"></canvas></div>
  </section>
</div>

<div class="tool-grid sdd-theme">
  <section class="tool-card">
    <h3>Risk / Return</h3>
    <div class="sdd-chart-wrap"><canvas id="sddScatterChart" aria-label="Risk versus return scatterplot"></canvas></div>
  </section>
  <section class="tool-card">
    <h3>Drawdown</h3>
    <div class="sdd-chart-wrap"><canvas id="sddDrawdownChart" aria-label="Drawdown chart"></canvas></div>
  </section>
</div>

<div class="tool-grid sdd-theme">
  <section class="tool-card">
    <h3>Correlation Matrix &amp; Heatmap</h3>
    <div id="sddCorrelation" class="result-box">Correlation matrix will appear here after you run the analysis.</div>
    <div id="sddDiversification" class="muted"></div>
  </section>
  <section class="tool-card">
    <h3>Regression Analytics</h3>
    <div class="field">
      <label for="sddBenchmark">Benchmark (X variable)</label>
      <select id="sddBenchmark" class="sheet-select" disabled>
        <option value="">Run analysis first</option>
      </select>
    </div>
    <div id="sddRegression" class="result-box">Regression table will appear here after you run the analysis.</div>
  </section>
</div>

<p class="muted sdd-disclaimer"><strong>Disclaimer:</strong> This dashboard is for education and analysis only. It is not investment advice. Live data is fetched best-effort through public proxies and may be delayed or unavailable.</p>

## What This Tool Includes
<div class="card-grid">
  <section class="card">
    <h3>Multi-Ticker Analytics</h3>
    <p class="muted">Multi-ticker Yahoo Finance analysis with an offline CSV mode and built-in sample data, dashboard metrics, and a diversification summary.</p>
  </section>
  <section class="card">
    <h3>Correlation &amp; Regression</h3>
    <p class="muted">Correlation matrix and heatmap, plus regression analytics (alpha, beta, R-squared, and significance) against a chosen benchmark.</p>
  </section>
  <section class="card">
    <h3>Comparison Charts</h3>
    <p class="muted">Risk/return, drawdown, indexed price, cumulative return, rolling volatility, and rolling correlation charts in the desktop app.</p>
  </section>
  <section class="card">
    <h3>Exports &amp; Launchers</h3>
    <p class="muted">Excel, CSV, and JPG image exports, with Windows and macOS one-click setup launchers in the downloadable desktop version.</p>
  </section>
</div>

## Key Features
<ul class="link-list">
  <li>Multi-ticker Yahoo Finance analysis</li>
  <li>Offline CSV mode with sample data</li>
  <li>Dashboard metrics</li>
  <li>Correlation matrix and heatmap</li>
  <li>Regression analytics</li>
  <li>Risk/return, drawdown, rolling volatility, and rolling correlation charts</li>
  <li>Excel, CSV, and JPG image exports</li>
  <li>Windows and macOS setup launchers</li>
</ul>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
{% raw %}
<script>
  (function () {
    "use strict";

    var SAMPLE_CSV = [
      "Date,Ticker,Close,Adj Close,Currency",
      "2024-01-02,AAPL,100,100,USD",
      "2024-01-03,AAPL,102,102,USD",
      "2024-01-04,AAPL,101,101,USD",
      "2024-01-02,MSFT,200,200,USD",
      "2024-01-03,MSFT,204,204,USD",
      "2024-01-04,MSFT,208,208,USD",
      "2024-01-02,XIU.TO,30,30,CAD",
      "2024-01-03,XIU.TO,30.5,30.5,CAD",
      "2024-01-04,XIU.TO,30.25,30.25,CAD"
    ].join("\n");

    var PALETTE = ["#5f9ae6", "#5ef0ab", "#f2c14e", "#ff8fa3", "#b98cff", "#4fd6d6", "#ff9f55", "#9db2d2"];

    var tickersInput = document.getElementById("sddTickers");
    var dataSourceSelect = document.getElementById("sddDataSource");
    var rangeSelect = document.getElementById("sddRange");
    var rangeField = document.getElementById("sddRangeField");
    var riskFreeInput = document.getElementById("sddRiskFree");
    var runBtn = document.getElementById("sddRunBtn");
    var sampleBtn = document.getElementById("sddSampleBtn");
    var statusNode = document.getElementById("sddStatus");
    var sampleHint = document.getElementById("sddSampleHint");
    var summaryTiles = document.getElementById("sddSummaryTiles");
    var metricsBody = document.getElementById("sddMetricsBody");
    var currencyWarning = document.getElementById("sddCurrencyWarning");
    var correlationNode = document.getElementById("sddCorrelation");
    var diversificationNode = document.getElementById("sddDiversification");
    var benchmarkSelect = document.getElementById("sddBenchmark");
    var regressionNode = document.getElementById("sddRegression");

    var charts = { indexed: null, cumulative: null, scatter: null, drawdown: null };
    var lastRun = null;
    var isRunning = false;
    var workingProxyIdx = -1;

    var CORS_PROXIES = [
      function (url) { return "https://corsproxy.io/?" + encodeURIComponent(url); },
      function (url) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(url); },
      function (url) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url); }
    ];
    var YAHOO_BASES = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
    var chartUnavailable = typeof window.Chart === "undefined";

    /* ---------- small helpers ---------- */
    function setStatus(msg, color) {
      statusNode.textContent = msg;
      statusNode.style.color = color || "#9db2d2";
    }
    function esc(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function fmtPct(num, digits) {
      if (num === null || num === undefined || !isFinite(num)) return "—";
      return (num * 100).toFixed(digits === undefined ? 2 : digits) + "%";
    }
    function fmtNum(num, digits) {
      if (num === null || num === undefined || !isFinite(num)) return "—";
      return Number(num).toFixed(digits === undefined ? 3 : digits);
    }
    function parseTickers(raw) {
      var seen = {};
      var out = [];
      String(raw || "").split(/[,\s]+/).forEach(function (t) {
        var clean = t.trim().toUpperCase();
        if (clean && !seen[clean]) { seen[clean] = true; out.push(clean); }
      });
      return out;
    }
    function mean(arr) {
      if (!arr.length) return NaN;
      var s = 0;
      for (var i = 0; i < arr.length; i++) s += arr[i];
      return s / arr.length;
    }
    function sampleStd(arr) {
      if (arr.length < 2) return NaN;
      var m = mean(arr), s = 0;
      for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
      return Math.sqrt(s / (arr.length - 1));
    }

    /* ---------- Student-t two-tailed p-value (regularized incomplete beta) ---------- */
    function betacf(a, b, x) {
      var fpmin = 1e-30, qab = a + b, qap = a + 1, qam = a - 1;
      var c = 1, d = 1 - qab * x / qap;
      if (Math.abs(d) < fpmin) d = fpmin;
      d = 1 / d;
      var h = d;
      for (var m = 1; m <= 200; m++) {
        var m2 = 2 * m;
        var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
        c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
        c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
        d = 1 / d;
        var del = d * c; h *= del;
        if (Math.abs(del - 1) < 3e-7) break;
      }
      return h;
    }
    function gammaln(x) {
      var cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
      var y = x, tmp = x + 5.5;
      tmp -= (x + 0.5) * Math.log(tmp);
      var ser = 1.000000000190015;
      for (var j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
      return -tmp + Math.log(2.5066282746310005 * ser / x);
    }
    function betai(a, b, x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
      if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
      return 1 - bt * betacf(b, a, 1 - x) / b;
    }
    function tTwoTailedP(t, df) {
      if (!isFinite(t) || df <= 0) return NaN;
      return betai(df / 2, 0.5, df / (df + t * t));
    }

    /* ---------- periods per year from spacing ---------- */
    function periodsPerYear(dates) {
      if (dates.length < 2) return 252;
      var gaps = [];
      for (var i = 1; i < dates.length; i++) {
        gaps.push((dates[i] - dates[i - 1]) / 86400000);
      }
      gaps.sort(function (a, b) { return a - b; });
      var med = gaps[Math.floor(gaps.length / 2)];
      if (med <= 4) return 252;
      if (med <= 10) return 52;
      if (med <= 45) return 12;
      return 4;
    }

    /* ---------- offline sample parsing ---------- */
    function loadOfflineSeries() {
      var lines = SAMPLE_CSV.split("\n");
      var header = lines[0].split(",");
      var idx = {};
      header.forEach(function (h, i) { idx[h.trim().toLowerCase()] = i; });
      var priceCol = idx["adj close"] !== undefined ? idx["adj close"] : idx["close"];
      var series = {};
      for (var r = 1; r < lines.length; r++) {
        var cells = lines[r].split(",");
        if (cells.length < 3) continue;
        var ticker = cells[idx["ticker"]].trim().toUpperCase();
        var date = new Date(cells[idx["date"]].trim() + "T00:00:00Z");
        var price = parseFloat(cells[priceCol]);
        var currency = idx["currency"] !== undefined ? (cells[idx["currency"]] || "").trim() : "";
        if (!ticker || isNaN(date.getTime()) || !isFinite(price)) continue;
        if (!series[ticker]) series[ticker] = { points: [], currency: currency };
        series[ticker].points.push({ date: date, price: price });
      }
      Object.keys(series).forEach(function (t) {
        series[t].points.sort(function (a, b) { return a.date - b.date; });
      });
      return series;
    }

    /* ---------- Yahoo fetch ---------- */
    function fetchWithTimeout(url, ms) {
      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, ms || 13000);
      return fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
        .then(function (res) { clearTimeout(tid); return res; })
        .catch(function (e) { clearTimeout(tid); throw e; });
    }
    function proxyFetch(url, idx) { return fetchWithTimeout(CORS_PROXIES[idx](url), 13000); }
    function findWorkingProxy() {
      if (workingProxyIdx >= 0) return Promise.resolve(workingProxyIdx);
      var testUrl = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d";
      var i = 0;
      function tryNext() {
        if (i >= CORS_PROXIES.length) return Promise.resolve(-1);
        var cur = i++;
        return proxyFetch(testUrl, cur).then(function (res) {
          if (!res.ok) return tryNext();
          return res.text().then(function (text) {
            if (text && text.indexOf("\"chart\"") > -1) { workingProxyIdx = cur; return cur; }
            return tryNext();
          });
        }).catch(function () { return tryNext(); });
      }
      return tryNext();
    }
    function fetchYahooSeries(ticker, range, proxyIdx) {
      var encoded = encodeURIComponent(ticker);
      var url = YAHOO_BASES[0] + "/v8/finance/chart/" + encoded +
        "?interval=1d&range=" + encodeURIComponent(range) + "&includePrePost=false";
      return proxyFetch(url, proxyIdx).then(function (res) {
        if (!res.ok) return null;
        return res.text();
      }).then(function (text) {
        if (!text || text.charAt(0) !== "{") return null;
        var data = JSON.parse(text);
        var result = data && data.chart && Array.isArray(data.chart.result) ? data.chart.result[0] : null;
        if (!result || !result.timestamp) return null;
        var ts = result.timestamp;
        var quote = result.indicators && result.indicators.quote ? result.indicators.quote[0] : null;
        var adj = result.indicators && result.indicators.adjclose ? result.indicators.adjclose[0].adjclose : null;
        var closes = quote ? quote.close : null;
        var currency = (result.meta && result.meta.currency) || "";
        var points = [];
        for (var i = 0; i < ts.length; i++) {
          var px = adj && adj[i] != null ? adj[i] : (closes && closes[i] != null ? closes[i] : null);
          if (px == null || !isFinite(px)) continue;
          points.push({ date: new Date(ts[i] * 1000), price: Number(px) });
        }
        if (points.length < 2) return null;
        return { points: points, currency: currency };
      }).catch(function () { return null; });
    }
    function fetchAllYahoo(tickers, range) {
      return findWorkingProxy().then(function (proxyIdx) {
        if (proxyIdx < 0) {
          throw new Error("Live data is unavailable right now (no reachable data proxy). Try Offline Sample mode.");
        }
        var series = {};
        var failed = [];
        var chain = Promise.resolve();
        tickers.forEach(function (t) {
          chain = chain.then(function () {
            setStatus("Fetching " + t + " from Yahoo Finance…");
            return fetchYahooSeries(t, range, proxyIdx).then(function (res) {
              if (res) series[t] = res; else failed.push(t);
            });
          });
        });
        return chain.then(function () { return { series: series, failed: failed }; });
      });
    }

    /* ---------- analytics ---------- */
    function buildReturns(points) {
      var rets = [];
      for (var i = 1; i < points.length; i++) {
        var prev = points[i - 1].price, cur = points[i].price;
        if (prev > 0 && isFinite(prev) && isFinite(cur)) {
          rets.push({ date: points[i].date, ret: cur / prev - 1 });
        }
      }
      return rets;
    }
    function maxDrawdown(points) {
      if (points.length < 2) return NaN;
      var peak = points[0].price, mdd = 0;
      for (var i = 0; i < points.length; i++) {
        if (points[i].price > peak) peak = points[i].price;
        if (peak > 0) {
          var dd = points[i].price / peak - 1;
          if (dd < mdd) mdd = dd;
        }
      }
      return mdd;
    }
    function computeMetrics(ticker, data, ppy, rfAnnual) {
      var points = data.points;
      var rets = buildReturns(points).map(function (r) { return r.ret; });
      var obs = rets.length;
      var totalReturn = (points.length >= 2 && points[0].price !== 0)
        ? points[points.length - 1].price / points[0].price - 1 : NaN;
      var annReturn = (obs > 0 && isFinite(totalReturn) && totalReturn > -1)
        ? Math.pow(1 + totalReturn, ppy / obs) - 1 : NaN;
      var sd = sampleStd(rets);
      var vol = obs > 1 ? sd * Math.sqrt(ppy) : NaN;
      var rfPer = ppy ? rfAnnual / ppy : 0;
      var sharpe = (obs > 1 && sd !== 0 && isFinite(sd))
        ? (mean(rets) - rfPer) / sd * Math.sqrt(ppy) : NaN;
      return {
        ticker: ticker,
        totalReturn: totalReturn,
        annReturn: annReturn,
        volatility: vol,
        sharpe: sharpe,
        maxDrawdown: maxDrawdown(points),
        observations: obs,
        currency: data.currency || ""
      };
    }
    function returnsMap(points) {
      var map = {};
      var rets = buildReturns(points);
      rets.forEach(function (r) { map[r.date.toISOString().slice(0, 10)] = r.ret; });
      return map;
    }
    function pearson(mapA, mapB) {
      var xs = [], ys = [];
      Object.keys(mapA).forEach(function (d) {
        if (mapB.hasOwnProperty(d)) { xs.push(mapA[d]); ys.push(mapB[d]); }
      });
      if (xs.length < 2) return NaN;
      var mx = mean(xs), my = mean(ys), num = 0, dx = 0, dy = 0;
      for (var i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) * (xs[i] - mx);
        dy += (ys[i] - my) * (ys[i] - my);
      }
      if (dx === 0 || dy === 0) return NaN;
      return num / Math.sqrt(dx * dy);
    }
    function regression(mapY, mapX, rfPer) {
      var ys = [], xs = [];
      Object.keys(mapY).forEach(function (d) {
        if (mapX.hasOwnProperty(d)) { ys.push(mapY[d] - rfPer); xs.push(mapX[d] - rfPer); }
      });
      var n = xs.length;
      if (n < 3) return { alpha: NaN, beta: NaN, r2: NaN, t: NaN, p: NaN, n: n };
      var mx = mean(xs), my = mean(ys), xvar = 0, cov = 0;
      for (var i = 0; i < n; i++) { xvar += (xs[i] - mx) * (xs[i] - mx); cov += (xs[i] - mx) * (ys[i] - my); }
      if (xvar === 0) return { alpha: NaN, beta: NaN, r2: NaN, t: NaN, p: NaN, n: n };
      var beta = cov / xvar;
      var alpha = my - beta * mx;
      var ssRes = 0, ssTot = 0;
      for (var j = 0; j < n; j++) {
        var yhat = alpha + beta * xs[j];
        ssRes += (ys[j] - yhat) * (ys[j] - yhat);
        ssTot += (ys[j] - my) * (ys[j] - my);
      }
      var r2 = ssTot ? 1 - ssRes / ssTot : NaN;
      var resVar = ssRes / (n - 2);
      var betaSe = Math.sqrt(resVar / xvar);
      var t = betaSe ? beta / betaSe : NaN;
      var p = isFinite(t) ? tTwoTailedP(t, n - 2) : NaN;
      return { alpha: alpha, beta: beta, r2: r2, t: t, p: p, n: n };
    }

    /* ---------- rendering ---------- */
    function heatColor(v) {
      if (v === null || v === undefined || !isFinite(v)) return "#16273f";
      // -1 (teal) -> 0 (slate) -> +1 (red/orange)
      var t = (v + 1) / 2;
      var cold = [79, 214, 214], mid = [22, 39, 63], hot = [242, 140, 78];
      var c;
      if (t < 0.5) {
        var k = t / 0.5;
        c = cold.map(function (a, i) { return Math.round(a + (mid[i] - a) * k); });
      } else {
        var k2 = (t - 0.5) / 0.5;
        c = mid.map(function (a, i) { return Math.round(a + (hot[i] - a) * k2); });
      }
      return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
    }
    function renderMetrics(metrics, dateLabel, obs) {
      var best = null;
      metrics.forEach(function (m) {
        if (isFinite(m.totalReturn) && (best === null || m.totalReturn > best.totalReturn)) best = m;
      });
      summaryTiles.innerHTML =
        tile("Securities Compared", String(metrics.length)) +
        tile("Date Range", dateLabel) +
        tile("Observations", String(obs)) +
        tile("Best Total Return", best ? (best.ticker + " " + fmtPct(best.totalReturn)) : "—");

      metricsBody.innerHTML = metrics.map(function (m) {
        return "<tr>" +
          "<td><strong>" + esc(m.ticker) + "</strong></td>" +
          "<td>" + fmtPct(m.totalReturn) + "</td>" +
          "<td>" + fmtPct(m.annReturn) + "</td>" +
          "<td>" + fmtPct(m.volatility) + "</td>" +
          "<td>" + fmtNum(m.sharpe, 2) + "</td>" +
          "<td>" + fmtPct(m.maxDrawdown) + "</td>" +
          "<td>" + m.observations + "</td>" +
          "<td>" + esc(m.currency || "—") + "</td>" +
          "</tr>";
      }).join("");
    }
    function tile(label, value) {
      return "<div class='summary-item'><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
    }
    function renderCurrencyWarning(metrics) {
      var currencies = {};
      metrics.forEach(function (m) { if (m.currency) currencies[m.currency] = true; });
      var keys = Object.keys(currencies);
      if (keys.length > 1) {
        currencyWarning.innerHTML = "<strong style='color:#f2c14e;'>Currency note:</strong> Multiple listing currencies detected (" +
          esc(keys.join(", ")) + "). Cross-currency comparisons may be distorted without FX normalization.";
      } else {
        currencyWarning.innerHTML = "";
      }
    }
    function renderCorrelation(tickers, retMaps) {
      if (tickers.length < 2) {
        correlationNode.innerHTML = "<span class='muted'>Add at least two securities to compute correlations.</span>";
        diversificationNode.innerHTML = "";
        return;
      }
      var html = "<table class='sheet-table sdd-corr-table' style='min-width:0;'><thead><tr><th></th>";
      tickers.forEach(function (t) { html += "<th>" + esc(t) + "</th>"; });
      html += "</tr></thead><tbody>";
      var high = [], low = [];
      for (var i = 0; i < tickers.length; i++) {
        html += "<tr><th>" + esc(tickers[i]) + "</th>";
        for (var j = 0; j < tickers.length; j++) {
          var v = i === j ? 1 : pearson(retMaps[tickers[i]], retMaps[tickers[j]]);
          var txt = isFinite(v) ? v.toFixed(2) : "—";
          var fg = (isFinite(v) && Math.abs(v) > 0.55) ? "#0f1d31" : "#dce7f7";
          html += "<td style='background:" + heatColor(v) + ";color:" + fg + ";text-align:center;font-variant-numeric:tabular-nums;'>" + txt + "</td>";
          if (i < j && isFinite(v)) {
            if (v >= 0.85) high.push(tickers[i] + "/" + tickers[j] + " (" + v.toFixed(2) + ")");
            else if (v <= 0.30) low.push(tickers[i] + "/" + tickers[j] + " (" + v.toFixed(2) + ")");
          }
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      correlationNode.innerHTML = html;

      var parts = [];
      if (high.length) parts.push("<strong style='color:#ff8fa3;'>High correlation (&ge;0.85):</strong> " + esc(high.join(", ")));
      if (low.length) parts.push("<strong style='color:#5ef0ab;'>Diversifying (&le;0.30):</strong> " + esc(low.join(", ")));
      diversificationNode.innerHTML = parts.length ? parts.join("<br>") : "No strong diversification flags detected at the 0.85 / 0.30 thresholds.";
    }
    function renderRegression(benchmark, tickers, retMaps, rfPer) {
      var others = tickers.filter(function (t) { return t !== benchmark; });
      if (!benchmark || !others.length) {
        regressionNode.innerHTML = "<span class='muted'>Need at least two securities for regression.</span>";
        return;
      }
      var rows = others.map(function (t) {
        var reg = regression(retMaps[t], retMaps[benchmark], rfPer);
        var sig = isFinite(reg.p) ? (reg.p < 0.01 ? " ***" : reg.p < 0.05 ? " **" : reg.p < 0.1 ? " *" : "") : "";
        return "<tr>" +
          "<td><strong>" + esc(t) + "</strong></td>" +
          "<td>" + fmtPct(reg.alpha, 3) + "</td>" +
          "<td>" + fmtNum(reg.beta, 3) + sig + "</td>" +
          "<td>" + fmtNum(reg.r2, 3) + "</td>" +
          "<td>" + fmtNum(reg.p, 4) + "</td>" +
          "<td>" + reg.n + "</td>" +
          "</tr>";
      }).join("");
      regressionNode.innerHTML =
        "<table class='sheet-table' style='min-width:0;'><thead><tr>" +
        "<th>Y vs " + esc(benchmark) + "</th><th>Alpha (per period)</th><th>Beta</th><th>R&sup2;</th><th>p-value</th><th>Obs</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table>" +
        "<div class='muted' style='margin-top:0.5rem;'>Beta significance: * p&lt;0.10, ** p&lt;0.05, *** p&lt;0.01. Alpha shown per return period.</div>";
    }

    function destroyChart(key) {
      if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    }
    function commonLineOptions(yLabel, yIsPct) {
      return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: "#cfe0f7" } } },
        scales: {
          x: { ticks: { color: "#9db2d2", maxTicksLimit: 8 }, grid: { color: "rgba(127,177,240,0.08)" } },
          y: {
            title: { display: true, text: yLabel, color: "#9db2d2" },
            ticks: {
              color: "#9db2d2",
              callback: function (v) { return yIsPct ? (v * 100).toFixed(0) + "%" : v; }
            },
            grid: { color: "rgba(127,177,240,0.08)" }
          }
        }
      };
    }
    function renderCharts(tickers, seriesByTicker) {
      if (chartUnavailable) return;
      var labelSet = {};
      tickers.forEach(function (t) {
        seriesByTicker[t].points.forEach(function (p) { labelSet[p.date.toISOString().slice(0, 10)] = true; });
      });
      var labels = Object.keys(labelSet).sort();

      function alignedSeries(t, transform) {
        var byDate = {};
        var pts = seriesByTicker[t].points;
        var base = pts.length ? pts[0].price : 1;
        var peak = pts.length ? pts[0].price : 1;
        pts.forEach(function (p) {
          if (p.price > peak) peak = p.price;
          byDate[p.date.toISOString().slice(0, 10)] = transform(p.price, base, peak);
        });
        return labels.map(function (d) { return byDate.hasOwnProperty(d) ? byDate[d] : null; });
      }

      var indexedSets = tickers.map(function (t, i) {
        return { label: t, data: alignedSeries(t, function (px, base) { return base ? px / base * 100 : null; }),
          borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], spanGaps: true, tension: 0.15, pointRadius: 0, borderWidth: 2 };
      });
      var cumulativeSets = tickers.map(function (t, i) {
        return { label: t, data: alignedSeries(t, function (px, base) { return base ? px / base - 1 : null; }),
          borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], spanGaps: true, tension: 0.15, pointRadius: 0, borderWidth: 2 };
      });
      var drawdownSets = tickers.map(function (t, i) {
        return { label: t, data: alignedSeries(t, function (px, base, peak) { return peak ? px / peak - 1 : null; }),
          borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], spanGaps: true, tension: 0.15, pointRadius: 0, borderWidth: 2 };
      });

      destroyChart("indexed");
      charts.indexed = new Chart(document.getElementById("sddIndexedChart"), {
        type: "line", data: { labels: labels, datasets: indexedSets }, options: commonLineOptions("Index (start = 100)", false)
      });
      destroyChart("cumulative");
      charts.cumulative = new Chart(document.getElementById("sddCumulativeChart"), {
        type: "line", data: { labels: labels, datasets: cumulativeSets }, options: commonLineOptions("Cumulative return", true)
      });
      destroyChart("drawdown");
      charts.drawdown = new Chart(document.getElementById("sddDrawdownChart"), {
        type: "line", data: { labels: labels, datasets: drawdownSets }, options: commonLineOptions("Drawdown", true)
      });
    }
    function renderScatter(metrics) {
      if (chartUnavailable) return;
      var pts = metrics.filter(function (m) { return isFinite(m.volatility) && isFinite(m.annReturn); })
        .map(function (m, i) { return { x: m.volatility, y: m.annReturn, label: m.ticker, color: PALETTE[i % PALETTE.length] }; });
      destroyChart("scatter");
      charts.scatter = new Chart(document.getElementById("sddScatterChart"), {
        type: "scatter",
        data: { datasets: pts.map(function (p) {
          return { label: p.label, data: [{ x: p.x, y: p.y }], backgroundColor: p.color, pointRadius: 7, pointHoverRadius: 9 };
        }) },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: "#cfe0f7" } },
            tooltip: { callbacks: { label: function (c) {
              return c.dataset.label + ": vol " + (c.parsed.x * 100).toFixed(1) + "%, ret " + (c.parsed.y * 100).toFixed(1) + "%";
            } } }
          },
          scales: {
            x: { title: { display: true, text: "Annualized volatility", color: "#9db2d2" },
              ticks: { color: "#9db2d2", callback: function (v) { return (v * 100).toFixed(0) + "%"; } }, grid: { color: "rgba(127,177,240,0.08)" } },
            y: { title: { display: true, text: "Annualized return", color: "#9db2d2" },
              ticks: { color: "#9db2d2", callback: function (v) { return (v * 100).toFixed(0) + "%"; } }, grid: { color: "rgba(127,177,240,0.08)" } }
          }
        }
      });
    }

    function populateBenchmark(tickers) {
      benchmarkSelect.innerHTML = tickers.map(function (t, i) {
        return "<option value='" + esc(t) + "'" + (i === tickers.length - 1 ? " selected" : "") + ">" + esc(t) + "</option>";
      }).join("");
      benchmarkSelect.disabled = tickers.length < 2;
    }

    /* ---------- run ---------- */
    function setRunning(running) {
      isRunning = running;
      runBtn.disabled = running;
      sampleBtn.disabled = running;
    }
    function processSeries(seriesByTicker, requested) {
      var tickers = requested.filter(function (t) { return seriesByTicker[t] && seriesByTicker[t].points.length >= 2; });
      if (!tickers.length) {
        setStatus("No usable price history was returned for those tickers.", "#ff8fa3");
        return;
      }
      var allDates = [];
      tickers.forEach(function (t) { seriesByTicker[t].points.forEach(function (p) { allDates.push(p.date); }); });
      allDates.sort(function (a, b) { return a - b; });
      var ppy = periodsPerYear(seriesByTicker[tickers[0]].points.map(function (p) { return p.date; }));
      var rfAnnual = Math.max(0, parseFloat(riskFreeInput.value) || 0) / 100;
      var rfPer = ppy ? rfAnnual / ppy : 0;

      var metrics = tickers.map(function (t) { return computeMetrics(t, seriesByTicker[t], ppy, rfAnnual); });
      var retMaps = {};
      tickers.forEach(function (t) { retMaps[t] = returnsMap(seriesByTicker[t].points); });

      var dateLabel = allDates.length
        ? allDates[0].toISOString().slice(0, 10) + " → " + allDates[allDates.length - 1].toISOString().slice(0, 10) : "—";
      var maxObs = metrics.reduce(function (a, m) { return Math.max(a, m.observations); }, 0);

      renderMetrics(metrics, dateLabel, maxObs);
      renderCurrencyWarning(metrics);
      renderCorrelation(tickers, retMaps);
      populateBenchmark(tickers);
      renderRegression(benchmarkSelect.value || tickers[tickers.length - 1], tickers, retMaps, rfPer);
      renderCharts(tickers, seriesByTicker);
      renderScatter(metrics);

      lastRun = { tickers: tickers, retMaps: retMaps, rfPer: rfPer };
      setStatus("Analysis complete — " + tickers.length + " securities, " + maxObs + " return observations (assumed " + ppy + " periods/yr).", "#5ef0ab");
    }

    function run() {
      if (isRunning) return;
      var source = dataSourceSelect.value;
      if (source === "offline") {
        var offline = loadOfflineSeries();
        var requested = Object.keys(offline);
        setRunning(true);
        setStatus("Loading offline sample data…");
        try { processSeries(offline, requested); }
        catch (e) { setStatus("Could not process sample data: " + e.message, "#ff8fa3"); }
        setRunning(false);
        return;
      }
      var tickers = parseTickers(tickersInput.value);
      if (!tickers.length) { setStatus("Enter at least one ticker.", "#ff8fa3"); return; }
      if (tickers.length > 10) { tickers = tickers.slice(0, 10); }
      setRunning(true);
      setStatus("Connecting to Yahoo Finance…");
      fetchAllYahoo(tickers, rangeSelect.value).then(function (res) {
        if (res.failed.length) {
          setStatus("Could not load: " + res.failed.join(", ") + ". Continuing with the rest…", "#f2c14e");
        }
        var ok = tickers.filter(function (t) { return res.series[t]; });
        if (!ok.length) {
          setStatus("No tickers could be loaded. Check symbols or try Offline Sample mode.", "#ff8fa3");
          setRunning(false);
          return;
        }
        processSeries(res.series, ok);
        setRunning(false);
      }).catch(function (e) {
        setStatus(e.message || "Live data fetch failed. Try Offline Sample mode.", "#ff8fa3");
        setRunning(false);
      });
    }

    /* ---------- events ---------- */
    function syncSourceUI() {
      var offline = dataSourceSelect.value === "offline";
      rangeField.style.opacity = offline ? "0.5" : "1";
      rangeSelect.disabled = offline;
      sampleHint.style.display = offline ? "block" : "none";
    }
    dataSourceSelect.addEventListener("change", syncSourceUI);
    runBtn.addEventListener("click", run);
    sampleBtn.addEventListener("click", function () {
      dataSourceSelect.value = "offline";
      syncSourceUI();
      run();
    });
    benchmarkSelect.addEventListener("change", function () {
      if (lastRun) renderRegression(benchmarkSelect.value, lastRun.tickers, lastRun.retMaps, lastRun.rfPer);
    });
    tickersInput.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });

    if (chartUnavailable) {
      setStatus("Charts could not load (offline or blocked CDN). Tables and metrics still work.", "#f2c14e");
    }
    syncSourceUI();
  })();
</script>
{% endraw %}
