---
layout: page
title: Portfolio Rebalancer Project
permalink: /projects/portfolio-rebalancer/
summary: Portfolio rebalancer workflow with interactive web tool, downloadable desktop script, and setup guide.
last_updated: 2026-03-19
---

<section class="hero-panel">
  <div class="eyebrow">Financial Tool Project</div>
  <h1>Portfolio Rebalancer</h1>
  <p class="lede">This project provides a practical portfolio rebalancing workflow for advisory prep and client review meetings. Use the interactive web tool or download the desktop Python script to run the same logic locally.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/Portfolio_Rebalancer/portfolio_rebalancer_desktop.py' | relative_url }}" download>Download Portfolio Rebalancer (.py)</a>
  <a class="btn" href="{{ '/projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md' | relative_url }}" download="Portfolio_Rebalancer_Setup_Guide.md">Download Setup &amp; Usage Guide (.md)</a>
</div>

## Guides
<ul class="link-list">
  <li><a href="{{ '/projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md' | relative_url }}" download="Portfolio_Rebalancer_Setup_Guide.md">Download Portfolio Rebalancer Setup Guide (.md)</a></li>
  <li><a href="{{ '/projects/portfolio-rebalancer-guide/' | relative_url }}">Open Portfolio Rebalancer Setup Guide (Web Page)</a></li>
</ul>

## Interactive Web Tool
Use the browser version below to run the same rebalancing workflow directly on this site.

<div class="tool-grid rebalancer-theme">
  <section class="tool-card rebalancer-input-card">
    <h3>Portfolio Inputs</h3>
    <div class="input-controls">
      <div class="field inline-field">
        <label for="rowCountInput">Number of securities</label>
        <input id="rowCountInput" type="number" min="1" max="50" step="1" value="9" />
      </div>
      <div class="field inline-field">
        <label for="reportingCurrencySelect">Reporting currency</label>
        <select id="reportingCurrencySelect" class="sheet-select">
          <option value="USD" selected>USD</option>
          <option value="CAD">CAD</option>
          <option value="JPN">JPN</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
          <option value="CHY_CNH">CHY/CNH</option>
        </select>
      </div>
      <div class="btn-row compact">
        <button class="btn btn-secondary" id="applyRowCountBtn" type="button">Apply Rows</button>
        <button class="btn btn-secondary" id="addRowBtn" type="button">Add Row</button>
        <button class="btn btn-secondary" id="removeRowBtn" type="button">Remove Last Row</button>
      </div>
    </div>
    <div class="muted">
      Ticker format help for live fetch: TSX/TSXV use .TO/.V (XIC.TO), LSE use .L (ISF.L), Tokyo use .T (7203.T).
    </div>

    <div class="table-wrap">
      <table class="sheet-table input-sheet" id="inputSheet">
        <thead>
          <tr>
            <th>#</th>
            <th>Ticker</th>
            <th>Shares / Units</th>
            <th>Price (local)</th>
            <th>Row Currency</th>
            <th>FX to <span id="reportingCurrencyLabel">USD</span></th>
            <th>Current Value (<span id="currentValueCurrencyLabel">USD</span>)</th>
            <th>Target Weight %</th>
          </tr>
        </thead>
        <tbody id="inputRows"></tbody>
      </table>
    </div>

    <div class="table-footnote">
      <span id="liveCurrentTotal">Current total: $0.00</span>
      <span id="liveWeightTotal">Target weight total: 0.00%</span>
    </div>

    <div class="field">
      <label for="netFlowInput" id="netFlowLabel">Net contribution / withdrawal (USD)</label>
      <input id="netFlowInput" type="number" value="0" step="0.01" />
      <div class="muted">Each row can use a different currency. Values are converted to your reporting currency with built-in FX estimates.</div>
      <div class="muted">Use a positive value for contribution and negative for withdrawal.</div>
    </div>
    <div class="field">
      <label for="fetchLiveInput">
        <input id="fetchLiveInput" type="checkbox" />
        Fetch live prices and FX rates (requires internet)
      </label>
      <div class="muted">Live Yahoo data may be delayed by ~15-20 minutes.</div>
    </div>
    <div class="btn-row">
      <button class="btn" id="rebalanceBtn" type="button">Run Rebalance</button>
      <button class="btn btn-secondary" id="sampleBtn" type="button">Load Sample Portfolio</button>
    </div>
    <div id="validationMessage" class="muted"></div>
  </section>

  <section class="tool-card rebalancer-output-card">
    <h3>Rebalance Output</h3>
    <div id="rebalanceResults" class="result-box">Output will appear here after you run rebalancing.</div>
  </section>
</div>

## Workflow Snapshot
<div class="card-grid">
  <section class="card">
    <h3>1) Input</h3>
    <p class="muted">Enter each security, shares, local price, row currency, and target weight.</p>
  </section>
  <section class="card">
    <h3>2) Rebalancing Logic</h3>
    <p class="muted">The tool converts values to your reporting currency, normalizes target weights, and computes trade values/shares.</p>
  </section>
  <section class="card">
    <h3>3) Output</h3>
    <p class="muted">Review Buy/Sell/Hold actions, trade amounts, and post-trade shares for each position.</p>
  </section>
</div>

<script>
  (function () {
    var samplePortfolio = [
      { ticker: "VTI", shares: 120, price: 250, targetWeight: 10, currencyKey: "USD" },
      { ticker: "XIC", shares: 320, price: 36, targetWeight: 10, currencyKey: "CAD" },
      { ticker: "VEQT", shares: 410, price: 42, targetWeight: 20, currencyKey: "CAD" },
      { ticker: "EWJ", shares: 220, price: 2480, targetWeight: 10, currencyKey: "JPN" },
      { ticker: "VGK", shares: 115, price: 64, targetWeight: 10, currencyKey: "EUR" },
      { ticker: "ISF", shares: 260, price: 7.4, targetWeight: 10, currencyKey: "GBP" },
      { ticker: "AAPL", shares: 45, price: 180, targetWeight: 10, currencyKey: "USD" },
      { ticker: "BND", shares: 200, price: 72, targetWeight: 10, currencyKey: "USD" },
      { ticker: "MCHI", shares: 140, price: 40, targetWeight: 10, currencyKey: "USD" }
    ];

    var rowCountInput = document.getElementById("rowCountInput");
    var reportingCurrencySelect = document.getElementById("reportingCurrencySelect");
    var inputRowsNode = document.getElementById("inputRows");
    var validationNode = document.getElementById("validationMessage");
    var resultsNode = document.getElementById("rebalanceResults");
    var hasCalculated = false;
    var isRunning = false;
    var rebalanceBtn = document.getElementById("rebalanceBtn");
    var fetchLiveInput = document.getElementById("fetchLiveInput");
    var currencyOptions = {
      USD: { code: "USD", locale: "en-US", label: "USD", fxToUsd: 1.00 },
      CAD: { code: "CAD", locale: "en-CA", label: "CAD", fxToUsd: 0.74 },
      JPN: { code: "JPY", locale: "ja-JP", label: "JPN", fxToUsd: 0.0067 },
      EUR: { code: "EUR", locale: "de-DE", label: "EUR", fxToUsd: 1.09 },
      GBP: { code: "GBP", locale: "en-GB", label: "GBP", fxToUsd: 1.28 },
      CHY_CNH: { code: "CNY", locale: "zh-CN", label: "CHY/CNH", fxToUsd: 0.14 }
    };
    var exchangeSuffixHints = {
      USD: ["", ".US"],
      CAD: [".TO", ".V", ""],
      JPN: [".T", ""],
      EUR: [".DE", ".AS", ".PA", ".MI", ".BR", ""],
      GBP: [".L", ""],
      CHY_CNH: [".SS", ".SZ", ".HK", ""]
    };
    var suffixToCurrencyKey = {
      ".TO": "CAD",
      ".V": "CAD",
      ".T": "JPN",
      ".DE": "EUR",
      ".AS": "EUR",
      ".PA": "EUR",
      ".MI": "EUR",
      ".BR": "EUR",
      ".L": "GBP",
      ".SS": "CHY_CNH",
      ".SZ": "CHY_CNH",
      ".HK": "CHY_CNH"
    };
    var prefixToSuffix = {
      "TSE:": ".TO",
      "TSX:": ".TO",
      "LSE:": ".L",
      "JPX:": ".T"
    };
    var liveFxToUsd = {};
    var liveFxKeys = new Set();

    function getReportingCurrencyMeta() {
      return currencyOptions[reportingCurrencySelect.value] || currencyOptions.USD;
    }

    function getRowCurrencyMeta(currencyKey) {
      return currencyOptions[currencyKey] || currencyOptions.USD;
    }

    function getFxToReporting(currencyKey) {
      var rowMeta = getRowCurrencyMeta(currencyKey);
      var reportingMeta = getReportingCurrencyMeta();
      var rowToUsd = Object.prototype.hasOwnProperty.call(liveFxToUsd, currencyKey)
        ? Number(liveFxToUsd[currencyKey])
        : Number(rowMeta.fxToUsd);
      var reportingKey = reportingCurrencySelect.value;
      var reportToUsd = Object.prototype.hasOwnProperty.call(liveFxToUsd, reportingKey)
        ? Number(liveFxToUsd[reportingKey])
        : Number(reportingMeta.fxToUsd);
      return rowToUsd / reportToUsd;
    }

    function clearLiveSnapshot() {
      liveFxToUsd = {};
      liveFxKeys = new Set();
    }

    function getFallbackFxToUsd(currencyKey) {
      return Number(getRowCurrencyMeta(currencyKey).fxToUsd);
    }

    function isLiveFxPair(rowCurrencyKey, reportCurrencyKey) {
      return liveFxKeys.has(rowCurrencyKey) || liveFxKeys.has(reportCurrencyKey);
    }

    function buildTickerCandidates(ticker, currencyKey) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) {
        return [];
      }
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        if (clean.indexOf(prefix) === 0) {
          var stripped = clean.slice(prefix.length).trim();
          if (!stripped) {
            return [];
          }
          var preferredSuffix = prefixToSuffix[prefix];
          var inferredKey = suffixToCurrencyKey[preferredSuffix] || currencyKey;
          var suffixes = exchangeSuffixHints[inferredKey] || [""];
          var orderedSuffixes = [preferredSuffix].concat(suffixes.filter(function (s) { return s !== preferredSuffix; }));
          var prefixedCandidates = [];
          orderedSuffixes.forEach(function (suffix) {
            var candidate = suffix ? (stripped + suffix) : stripped;
            if (prefixedCandidates.indexOf(candidate) === -1) {
              prefixedCandidates.push(candidate);
            }
          });
          return prefixedCandidates;
        }
      }
      if (clean.indexOf("=") >= 0) {
        return [clean];
      }
      if (clean.indexOf(".") >= 0) {
        var dotIdx = clean.lastIndexOf(".");
        var stem = clean.slice(0, dotIdx);
        var suffix = clean.slice(dotIdx);
        if (stem && suffixToCurrencyKey[suffix]) {
          var dottedCandidates = [clean];
          var inferredKey = suffixToCurrencyKey[suffix] || currencyKey;
          [currencyKey, inferredKey].forEach(function (key) {
            var suffixesForKey = exchangeSuffixHints[key] || [""];
            suffixesForKey.forEach(function (altSuffix) {
              var candidate = altSuffix ? (stem + altSuffix) : stem;
              if (dottedCandidates.indexOf(candidate) === -1) {
                dottedCandidates.push(candidate);
              }
            });
          });
          return dottedCandidates;
        }
        return [clean];
      }
      var suffixes = exchangeSuffixHints[currencyKey] || [""];
      var candidates = [];
      suffixes.forEach(function (suffix) {
        var candidate = suffix ? (clean + suffix) : clean;
        if (candidates.indexOf(candidate) === -1) {
          candidates.push(candidate);
        }
      });
      return candidates;
    }

    function buildTickerInputHint(ticker, currencyKey) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) {
        return "";
      }

      var expectedKey = currencyOptions[currencyKey] ? currencyKey : "USD";
      var expectedCode = getRowCurrencyMeta(expectedKey).code;
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        if (clean.indexOf(prefix) === 0) {
          var base = clean.slice(prefix.length).trim();
          if (!base) {
            return "";
          }
          var suggestionSuffix = prefixToSuffix[prefix];
          var suggestion = base + suggestionSuffix;
          var mappedKey = suffixToCurrencyKey[suggestionSuffix] || expectedKey;
          var mappedCode = getRowCurrencyMeta(mappedKey).code;
          if (mappedKey !== expectedKey) {
            return prefix + " format may fail. Try " + suggestion + " (" + mappedCode + ") or switch row currency.";
          }
          return prefix + " format may fail. Try " + suggestion + ".";
        }
      }

      if (clean.indexOf(".") >= 0) {
        var dotIdx = clean.lastIndexOf(".");
        var suffix = clean.slice(dotIdx);
        var mappedCurrencyKey = suffixToCurrencyKey[suffix];
        if (mappedCurrencyKey && mappedCurrencyKey !== expectedKey) {
          var mappedCurrencyCode = getRowCurrencyMeta(mappedCurrencyKey).code;
          return suffix + " implies " + mappedCurrencyCode + "; row is " + expectedCode + ".";
        }
        return "";
      }

      if (expectedKey !== "USD") {
        var candidates = buildTickerCandidates(clean, expectedKey);
        for (var j = 0; j < candidates.length; j += 1) {
          if (candidates[j] !== clean) {
            return "Try " + candidates[j] + " for " + expectedCode + " quotes.";
          }
        }
      }

      return "";
    }

    function inferCurrencyFromTickerSuffix(ticker) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) {
        return null;
      }
      var dotIdx = clean.lastIndexOf(".");
      if (dotIdx < 0) {
        return null;
      }
      var suffix = clean.slice(dotIdx);
      return suffixToCurrencyKey[suffix] || null;
    }

    function buildTickerCurrencyWarnings(positions) {
      var warnings = [];
      positions.forEach(function (position, idx) {
        var inferredCurrencyKey = inferCurrencyFromTickerSuffix(position.ticker);
        var expectedCode = getRowCurrencyMeta(position.currencyKey).code;
        if (inferredCurrencyKey && inferredCurrencyKey !== position.currencyKey) {
          warnings.push(
            "Row " + (idx + 1) + " (" + position.ticker + "): ticker suffix implies " +
            getRowCurrencyMeta(inferredCurrencyKey).code + " but row currency is " + expectedCode + "."
          );
        }

        if (position.currencyKey !== "USD" && !inferredCurrencyKey) {
          var candidates = buildTickerCandidates(position.ticker, position.currencyKey);
          if (candidates.length > 1) {
            warnings.push(
              "Row " + (idx + 1) + " (" + position.ticker + "): desktop live fetch will auto-try exchange symbols " +
              candidates.join(", ") + " for " + expectedCode + " quotes."
            );
          }
        }
      });
      return warnings;
    }

    function formatFx(num, isLive) {
      var rendered = Number(num).toFixed(4);
      return isLive ? ("~" + rendered) : rendered;
    }

    function formatCurrencyByKey(num, currencyKey) {
      var meta = getRowCurrencyMeta(currencyKey);
      return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(num);
    }

    function formatCurrency(num) {
      var meta = getReportingCurrencyMeta();
      return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(num);
    }

    function formatPct(num) {
      return num.toFixed(2) + "%";
    }

    function formatShares(num) {
      return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4
      }).format(num);
    }

    function formatInputPrice(num) {
      return Number(num).toFixed(4).replace(/\.?0+$/, "");
    }

    function safePositiveNumber(raw) {
      var parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function normalizeQuoteCurrency(rawCurrency) {
      if (typeof rawCurrency !== "string") {
        return { quoteCurrency: null, unitScale: 1.0, rawQuoteCurrency: rawCurrency || null };
      }
      var trimmed = rawCurrency.trim();
      if (!trimmed) {
        return { quoteCurrency: null, unitScale: 1.0, rawQuoteCurrency: rawCurrency };
      }
      if (trimmed === "GBp" || trimmed === "GBX") {
        return { quoteCurrency: "GBP", unitScale: 0.01, rawQuoteCurrency: rawCurrency };
      }
      var upper = trimmed.toUpperCase();
      if (upper === "CNH") {
        return { quoteCurrency: "CNY", unitScale: 1.0, rawQuoteCurrency: rawCurrency };
      }
      return { quoteCurrency: upper, unitScale: 1.0, rawQuoteCurrency: rawCurrency };
    }

    function extractPriceFromQuoteRecord(quoteRecord) {
      if (!quoteRecord || typeof quoteRecord !== "object") {
        return null;
      }
      var priceFields = [
        "regularMarketPrice",
        "postMarketPrice",
        "preMarketPrice",
        "bid",
        "ask",
        "previousClose"
      ];
      for (var i = 0; i < priceFields.length; i += 1) {
        var value = safePositiveNumber(quoteRecord[priceFields[i]]);
        if (value !== null) {
          return value;
        }
      }
      return null;
    }

    function chunkList(items, chunkSize) {
      var chunks = [];
      for (var i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }
      return chunks;
    }

    async function fetchYahooQuoteRecords(symbols) {
      var deduped = [];
      symbols.forEach(function (symbol) {
        var clean = String(symbol || "").trim().toUpperCase();
        if (clean && deduped.indexOf(clean) === -1) {
          deduped.push(clean);
        }
      });

      var recordsBySymbol = {};
      if (!deduped.length) {
        return recordsBySymbol;
      }

      var chunks = chunkList(deduped, 40);
      for (var i = 0; i < chunks.length; i += 1) {
        var symbolsParam = encodeURIComponent(chunks[i].join(","));
        var url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbolsParam;
        var response;
        try {
          response = await fetch(url);
        } catch (err) {
          throw new Error("Yahoo quote request failed. Check internet/CORS availability.");
        }
        if (!response.ok) {
          throw new Error("Yahoo quote request failed with status " + response.status + ".");
        }
        var payload = await response.json();
        var results = (((payload || {}).quoteResponse || {}).result || []);
        results.forEach(function (record) {
          var symbol = String(record && record.symbol || "").trim().toUpperCase();
          if (symbol) {
            recordsBySymbol[symbol] = record;
          }
        });
      }

      return recordsBySymbol;
    }

    async function fetchYahooChartDetails(symbol) {
      var encoded = encodeURIComponent(String(symbol || "").trim().toUpperCase());
      var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encoded + "?range=5d&interval=1d";
      var response;
      try {
        response = await fetch(url);
      } catch (err) {
        return null;
      }
      if (!response.ok) {
        return null;
      }
      var payload = await response.json();
      var result = ((((payload || {}).chart || {}).result || [])[0]) || null;
      if (!result) {
        return null;
      }
      var closeSeries = (((result.indicators || {}).quote || [])[0] || {}).close || [];
      var latestClose = null;
      for (var i = closeSeries.length - 1; i >= 0; i -= 1) {
        var closeValue = safePositiveNumber(closeSeries[i]);
        if (closeValue !== null) {
          latestClose = closeValue;
          break;
        }
      }
      if (latestClose === null) {
        return null;
      }
      var normalizedCurrency = normalizeQuoteCurrency((result.meta || {}).currency || null);
      return {
        resolvedTicker: String(symbol || "").trim().toUpperCase(),
        rawPrice: latestClose,
        price: latestClose * normalizedCurrency.unitScale,
        rawQuoteCurrency: normalizedCurrency.rawQuoteCurrency,
        quoteCurrency: normalizedCurrency.quoteCurrency,
        unitScale: normalizedCurrency.unitScale
      };
    }

    async function fetchLiveQuoteDetails(symbol, quoteRecordsBySymbol) {
      var clean = String(symbol || "").trim().toUpperCase();
      if (!clean) {
        return null;
      }
      var quoteRecord = quoteRecordsBySymbol[clean] || null;
      var quotePrice = extractPriceFromQuoteRecord(quoteRecord);
      if (quotePrice !== null) {
        var normalizedCurrency = normalizeQuoteCurrency(
          quoteRecord.currency || quoteRecord.financialCurrency || quoteRecord.currencyCode || null
        );
        return {
          resolvedTicker: String(quoteRecord.symbol || clean).trim().toUpperCase(),
          rawPrice: quotePrice,
          price: quotePrice * normalizedCurrency.unitScale,
          rawQuoteCurrency: normalizedCurrency.rawQuoteCurrency,
          quoteCurrency: normalizedCurrency.quoteCurrency,
          unitScale: normalizedCurrency.unitScale
        };
      }
      try {
        return await fetchYahooChartDetails(clean);
      } catch (err) {
        return null;
      }
    }

    async function fetchLiveFxToUsdMap(currencyKeys, warnings) {
      var fxMap = {};
      var fetchedFxKeys = new Set();
      fxMap.USD = 1.0;

      var fxRequests = [];
      currencyKeys.forEach(function (currencyKey) {
        if (currencyKey === "USD") {
          return;
        }
        var code = getRowCurrencyMeta(currencyKey).code;
        fxRequests.push({ currencyKey: currencyKey, symbol: code + "USD=X" });
      });

      if (!fxRequests.length) {
        return { fxMap: fxMap, fetchedFxKeys: fetchedFxKeys };
      }

      var quoteRecords;
      try {
        quoteRecords = await fetchYahooQuoteRecords(
          fxRequests.map(function (request) { return request.symbol; })
        );
      } catch (err) {
        warnings.push(
          "Live FX request failed; using fallback FX rates. (" + String(err && err.message || err) + ")"
        );
        return { fxMap: fxMap, fetchedFxKeys: fetchedFxKeys };
      }

      fxRequests.forEach(function (request) {
        var record = quoteRecords[String(request.symbol).toUpperCase()];
        var liveRate = extractPriceFromQuoteRecord(record);
        if (liveRate !== null) {
          fxMap[request.currencyKey] = liveRate;
          fetchedFxKeys.add(request.currencyKey);
        } else {
          var fallback = getFallbackFxToUsd(request.currencyKey);
          warnings.push(
            "Live FX unavailable for " + request.currencyKey + "; using fallback rate " + fallback.toFixed(4) + "."
          );
        }
      });

      return { fxMap: fxMap, fetchedFxKeys: fetchedFxKeys };
    }

    function setRunningState(running, statusMessage) {
      isRunning = running;
      rebalanceBtn.disabled = running;
      if (running && statusMessage) {
        validationNode.textContent = statusMessage;
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function currencyOptionsHtml(selectedKey) {
      return Object.keys(currencyOptions).map(function (key) {
        var selected = key === selectedKey ? " selected" : "";
        return "<option value='" + key + "'" + selected + ">" + currencyOptions[key].label + "</option>";
      }).join("");
    }

    function rowHtml(index, data) {
      var rowData = data || {};
      var shares = Number.isFinite(Number(rowData.shares)) ? Number(rowData.shares) : "";
      var price = Number.isFinite(Number(rowData.price)) ? Number(rowData.price) : "";
      var targetWeight = Number.isFinite(Number(rowData.targetWeight)) ? Number(rowData.targetWeight) : "";
      var ticker = rowData.ticker ? String(rowData.ticker).toUpperCase() : "";
      var currencyKey = rowData.currencyKey && currencyOptions[rowData.currencyKey] ? rowData.currencyKey : "USD";
      var localValue = Number(shares) * Number(price);
      var fxToReporting = getFxToReporting(currencyKey);
      var reportingValue = localValue * fxToReporting;
      var currentValueText = Number.isFinite(reportingValue) && reportingValue >= 0 ? formatCurrency(reportingValue) : formatCurrency(0);

      return "<tr>" +
        "<td class='row-index'>" + (index + 1) + "</td>" +
        "<td><input class='sheet-input ticker-input' type='text' maxlength='12' placeholder='e.g. AAPL' value='" + escapeHtml(ticker) + "' /><div class='ticker-hint' style='margin-top:2px;font-size:0.78rem;color:#8f5f12;'></div></td>" +
        "<td><input class='sheet-input shares-input' type='number' min='0' step='0.0001' value='" + shares + "' /></td>" +
        "<td><input class='sheet-input price-input' type='number' min='0.0001' step='0.0001' value='" + price + "' /></td>" +
        "<td><select class='sheet-input sheet-select row-currency-select'>" + currencyOptionsHtml(currencyKey) + "</select></td>" +
        "<td class='fx-rate-cell'>" + formatFx(fxToReporting) + "</td>" +
        "<td class='current-value-cell'>" + currentValueText + "</td>" +
        "<td><input class='sheet-input target-weight-input' type='number' min='0' step='0.01' value='" + targetWeight + "' /></td>" +
        "</tr>";
    }

    function setRows(count, seedData) {
      var rowCount = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
      rowCountInput.value = String(rowCount);

      var rowsHtml = [];
      for (var i = 0; i < rowCount; i += 1) {
        rowsHtml.push(rowHtml(i, seedData && seedData[i] ? seedData[i] : null));
      }
      inputRowsNode.innerHTML = rowsHtml.join("");
      updateLiveTotals();
    }

    function readNumberInput(inputNode) {
      var value = Number(inputNode.value);
      return Number.isFinite(value) ? value : NaN;
    }

    function updateLiveTotals() {
      var currentTotal = 0;
      var weightTotal = 0;
      var rows = inputRowsNode.querySelectorAll("tr");

      rows.forEach(function (row) {
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var price = readNumberInput(row.querySelector(".price-input"));
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;
        var fxToReporting = getFxToReporting(currencyKey);
        var fxLive = isLiveFxPair(currencyKey, reportingCurrencySelect.value);

        var localValue = Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price > 0
          ? shares * price
          : 0;
        var reportingValue = localValue * fxToReporting;
        var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
        var tickerHint = buildTickerInputHint(ticker, currencyKey);

        row.querySelector(".fx-rate-cell").textContent = formatFx(fxToReporting, fxLive);
        row.querySelector(".current-value-cell").textContent = formatCurrency(reportingValue);
        row.querySelector(".ticker-hint").textContent = tickerHint;
        currentTotal += reportingValue;
        if (Number.isFinite(targetWeight) && targetWeight >= 0) {
          weightTotal += targetWeight;
        }
      });

      document.getElementById("liveCurrentTotal").textContent = "Current total: " + formatCurrency(currentTotal);
      document.getElementById("liveWeightTotal").textContent = "Target weight total: " + formatPct(weightTotal);
    }

    function parsePositionsFromTable(requirePrice) {
      var needsPrice = requirePrice !== false;
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      if (!rows.length) {
        throw new Error("Add at least one security row.");
      }

      var positions = rows.map(function (row, idx) {
        var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var price = readNumberInput(row.querySelector(".price-input"));
        var priceValue = Number.isFinite(price) ? price : null;
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;
        var fxToReporting = getFxToReporting(currencyKey);

        if (!ticker) {
          throw new Error("Row " + (idx + 1) + ": ticker is required.");
        }
        if (!Number.isFinite(shares) || shares < 0) {
          throw new Error("Row " + (idx + 1) + ": shares/units must be a non-negative number.");
        }
        if (needsPrice && (!Number.isFinite(price) || price <= 0)) {
          throw new Error("Row " + (idx + 1) + ": price must be greater than 0.");
        }
        if (!needsPrice && priceValue !== null && priceValue <= 0) {
          throw new Error("Row " + (idx + 1) + ": manual price must be greater than 0 when provided.");
        }
        if (!Number.isFinite(targetWeight) || targetWeight < 0) {
          throw new Error("Row " + (idx + 1) + ": target weight must be 0 or greater.");
        }

        return {
          rowIndex: idx,
          ticker: ticker,
          shares: shares,
          price: priceValue,
          currencyKey: currencyKey,
          currencyLabel: getRowCurrencyMeta(currencyKey).label,
          fxToReporting: fxToReporting,
          currentValueLocal: shares * (priceValue || 0),
          currentValue: shares * (priceValue || 0) * fxToReporting,
          targetWeight: targetWeight
        };
      });

      var hasPositiveWeight = positions.some(function (p) { return p.targetWeight > 0; });
      if (!hasPositiveWeight) {
        throw new Error("At least one target weight must be greater than 0.");
      }

      return positions;
    }

    function buildResultTable(rows) {
      var tableHead = "<table class='sheet-table output-sheet'><thead><tr>" +
        "<th>Ticker</th><th>Row Currency</th><th>Shares</th><th>Price (local)</th><th>Current Value</th><th>Target Weight</th>" +
        "<th>Target Value</th><th>Trade Value</th><th>Trade Value (local)</th><th>Trade Shares</th><th>Action</th><th>Post-Trade Shares</th>" +
        "</tr></thead><tbody>";

      var tableBody = rows.map(function (r) {
        var actionClass = r.action.toLowerCase();
        return "<tr>" +
          "<td>" + escapeHtml(r.ticker) + "</td>" +
          "<td>" + r.currencyLabel + "</td>" +
          "<td>" + formatShares(r.shares) + "</td>" +
          "<td>" + formatCurrencyByKey(r.price, r.currencyKey) + "</td>" +
          "<td>" + formatCurrency(r.currentValue) + "</td>" +
          "<td>" + formatPct(r.targetWeightNorm * 100) + "</td>" +
          "<td>" + formatCurrency(r.targetValue) + "</td>" +
          "<td>" + formatCurrency(r.tradeValue) + "</td>" +
          "<td>" + formatCurrencyByKey(r.tradeValueLocal, r.currencyKey) + "</td>" +
          "<td>" + formatShares(r.tradeShares) + "</td>" +
          "<td><span class='action-pill action-" + actionClass + "'>" + r.action + "</span></td>" +
          "<td>" + formatShares(r.postTradeShares) + "</td>" +
          "</tr>";
      }).join("");

      return tableHead + tableBody + "</tbody></table>";
    }

    function summaryHtml(data) {
      return "<div class='summary-grid'>" +
        "<div class='summary-item'><span>Live Data Used</span><strong>" + (data.liveDataUsed ? "Yes" : "No") + "</strong></div>" +
        "<div class='summary-item'><span>Total Current</span><strong>" + formatCurrency(data.totalCurrent) + "</strong></div>" +
        "<div class='summary-item'><span>Net Flow</span><strong>" + formatCurrency(data.netFlow) + "</strong></div>" +
        "<div class='summary-item'><span>Target Ending Value</span><strong>" + formatCurrency(data.endingValue) + "</strong></div>" +
        "<div class='summary-item'><span>Total Buy Value</span><strong>" + formatCurrency(data.totalBuys) + "</strong></div>" +
        "<div class='summary-item'><span>Total Sell Value</span><strong>" + formatCurrency(data.totalSells) + "</strong></div>" +
        "</div>";
    }

    function warningsHtml(warnings) {
      if (!warnings.length) {
        return "";
      }
      return "<div class='muted' style='margin-top:12px;'>" +
        "<strong>Warnings</strong><br />" +
        warnings.map(function (w) { return "• " + escapeHtml(w); }).join("<br />") +
        "</div>";
    }

    function updateCurrencyUi() {
      var meta = getReportingCurrencyMeta();
      document.getElementById("netFlowLabel").textContent = "Net contribution / withdrawal (" + meta.label + ")";
      document.getElementById("reportingCurrencyLabel").textContent = meta.label;
      document.getElementById("currentValueCurrencyLabel").textContent = meta.label;
    }

    async function applyLiveFetchToPositions(positions, warnings) {
      var allCandidates = [];
      positions.forEach(function (position) {
        buildTickerCandidates(position.ticker, position.currencyKey).forEach(function (candidate) {
          if (allCandidates.indexOf(candidate) === -1) {
            allCandidates.push(candidate);
          }
        });
      });

      var quoteRecordsBySymbol = {};
      try {
        quoteRecordsBySymbol = await fetchYahooQuoteRecords(allCandidates);
      } catch (err) {
        warnings.push(
          "Live quote request failed; using manual prices where available. (" + String(err && err.message || err) + ")"
        );
      }

      for (var i = 0; i < positions.length; i += 1) {
        var position = positions[i];
        var ticker = position.ticker;
        var selectedCurrencyCode = getRowCurrencyMeta(position.currencyKey).code;
        var manualPrice = position.price;
        var bestMatchingQuote = null;
        var firstFallbackQuote = null;
        var candidates = buildTickerCandidates(ticker, position.currencyKey);

        for (var c = 0; c < candidates.length; c += 1) {
          var candidate = candidates[c];
          var quoteDetails = await fetchLiveQuoteDetails(candidate, quoteRecordsBySymbol);
          if (!quoteDetails) {
            continue;
          }
          var quoteCode = quoteDetails.quoteCurrency;
          if (quoteCode === selectedCurrencyCode) {
            bestMatchingQuote = quoteDetails;
            break;
          }
          if (!firstFallbackQuote) {
            firstFallbackQuote = quoteDetails;
          }
        }

        var chosenQuote = bestMatchingQuote || firstFallbackQuote;
        if (!chosenQuote) {
          if (manualPrice === null) {
            throw new Error(
              "Live price unavailable for " + ticker + " and no manual price is provided."
            );
          }
          warnings.push(
            "Live price unavailable for " + ticker + "; using manual entry " + manualPrice.toFixed(4) + "."
          );
          continue;
        }

        var resolvedTicker = String(chosenQuote.resolvedTicker || ticker).toUpperCase();
        var quoteCurrencyCode = chosenQuote.quoteCurrency;
        var quoteCurrencyKey = quoteCurrencyCode ? (
          Object.keys(currencyOptions).find(function (key) {
            return getRowCurrencyMeta(key).code === quoteCurrencyCode;
          }) || null
        ) : null;
        var chosenPrice = Number(chosenQuote.price);

        if (quoteCurrencyCode && quoteCurrencyCode !== selectedCurrencyCode) {
          if (quoteCurrencyKey && manualPrice === null) {
            position.currencyKey = quoteCurrencyKey;
            position.currencyLabel = getRowCurrencyMeta(quoteCurrencyKey).label;
            position.price = chosenPrice;
            warnings.push(
              ticker + ": live quote currency " + quoteCurrencyCode + " does not match selected " +
              selectedCurrencyCode + "; adjusted row currency to " + quoteCurrencyCode + " for this run."
            );
            if (resolvedTicker !== ticker) {
              warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
            }
            continue;
          }

          if (manualPrice !== null) {
            warnings.push(
              ticker + ": live quote currency " + quoteCurrencyCode + " does not match selected " +
              selectedCurrencyCode + "; keeping manual entry " + manualPrice.toFixed(4) + "."
            );
            continue;
          }

          throw new Error(
            ticker + ": live quote returned unsupported quote currency " + quoteCurrencyCode +
            " for selected " + selectedCurrencyCode + "; enter a manual price."
          );
        }

        position.price = chosenPrice;
        if (resolvedTicker !== ticker) {
          warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
        }
        if (Number(chosenQuote.unitScale) !== 1.0) {
          warnings.push(
            ticker + ": converted sub-unit quote currency " +
            String(chosenQuote.rawQuoteCurrency || "") + " to " + String(quoteCurrencyCode || "") + " units."
          );
        }
      }
    }

    function syncPositionsToTable(positions) {
      positions.forEach(function (position) {
        var row = inputRowsNode.querySelectorAll("tr")[position.rowIndex];
        if (!row) {
          return;
        }
        var priceInput = row.querySelector(".price-input");
        var currencySelect = row.querySelector(".row-currency-select");
        if (position.price !== null && Number.isFinite(position.price)) {
          priceInput.value = formatInputPrice(position.price);
        }
        if (position.currencyKey && currencyOptions[position.currencyKey]) {
          currencySelect.value = position.currencyKey;
        }
      });
    }

    function buildFxToReportingMap(positions, fxToUsdMap) {
      var reportingKey = reportingCurrencySelect.value;
      var reportToUsd = fxToUsdMap[reportingKey] || getFallbackFxToUsd(reportingKey);
      var fxToReportingByRow = {};
      positions.forEach(function (position) {
        var rowToUsd = fxToUsdMap[position.currencyKey] || getFallbackFxToUsd(position.currencyKey);
        fxToReportingByRow[position.rowIndex] = rowToUsd / reportToUsd;
      });
      return fxToReportingByRow;
    }

    async function calculateRebalance() {
      if (isRunning) {
        return;
      }
      validationNode.textContent = "";

      try {
        var wantsLiveFetch = Boolean(fetchLiveInput.checked);
        var positions = parsePositionsFromTable(!wantsLiveFetch);
        var warnings = [];
        var liveDataUsed = false;
        var fxToUsdMap = {};
        Object.keys(currencyOptions).forEach(function (key) {
          fxToUsdMap[key] = getFallbackFxToUsd(key);
        });

        clearLiveSnapshot();
        if (wantsLiveFetch) {
          setRunningState(true, "Fetching live prices and FX rates...");
          await applyLiveFetchToPositions(positions, warnings);
          syncPositionsToTable(positions);

          var currenciesInScope = new Set([reportingCurrencySelect.value]);
          positions.forEach(function (position) {
            currenciesInScope.add(position.currencyKey);
          });
          var fxResult = await fetchLiveFxToUsdMap(currenciesInScope, warnings);
          Object.keys(fxResult.fxMap).forEach(function (currencyKey) {
            fxToUsdMap[currencyKey] = Number(fxResult.fxMap[currencyKey]);
          });
          liveFxToUsd = fxToUsdMap;
          liveFxKeys = fxResult.fetchedFxKeys;
          liveDataUsed = true;
        } else {
          clearLiveSnapshot();
        }

        var tickerWarnings = buildTickerCurrencyWarnings(positions);
        warnings = warnings.concat(tickerWarnings);
        var netFlow = Number(document.getElementById("netFlowInput").value || "0");
        if (!Number.isFinite(netFlow)) {
          throw new Error("Net contribution / withdrawal must be a valid number.");
        }

        var fxToReportingByRow = buildFxToReportingMap(positions, fxToUsdMap);
        var totalCurrent = positions.reduce(function (sum, p) {
          var fxToReporting = fxToReportingByRow[p.rowIndex];
          return sum + (p.shares * p.price * fxToReporting);
        }, 0);
        var totalWeight = positions.reduce(function (sum, p) { return sum + p.targetWeight; }, 0);
        if (totalCurrent + netFlow <= 0) {
          throw new Error("Ending portfolio value must be greater than 0.");
        }

        var endingPortfolioValue = totalCurrent + netFlow;
        var totalBuys = 0;
        var totalSells = 0;

        var results = positions.map(function (p) {
          var fxToReporting = fxToReportingByRow[p.rowIndex];
          var currentValue = p.shares * p.price * fxToReporting;
          var targetWeightNorm = p.targetWeight / totalWeight;
          var targetValue = targetWeightNorm * endingPortfolioValue;
          var tradeValue = targetValue - currentValue;
          var tradeValueLocal = tradeValue / fxToReporting;
          var tradeShares = tradeValueLocal / p.price;
          var action = "Hold";

          if (tradeValue > 0.005) {
            action = "Buy";
            totalBuys += tradeValue;
          } else if (tradeValue < -0.005) {
            action = "Sell";
            totalSells += Math.abs(tradeValue);
          }

          if (Math.abs(tradeValue) <= 0.005) {
            tradeValue = 0;
            tradeValueLocal = 0;
            tradeShares = 0;
          }

          return {
            ticker: p.ticker,
            currencyKey: p.currencyKey,
            currencyLabel: p.currencyLabel,
            shares: p.shares,
            price: p.price,
            currentValue: currentValue,
            targetWeightNorm: targetWeightNorm,
            targetValue: targetValue,
            tradeValue: tradeValue,
            tradeValueLocal: tradeValueLocal,
            tradeShares: tradeShares,
            action: action,
            postTradeShares: p.shares + tradeShares
          };
        });

        var summaryData = {
          liveDataUsed: liveDataUsed,
          totalCurrent: totalCurrent,
          netFlow: netFlow,
          endingValue: endingPortfolioValue,
          totalBuys: totalBuys,
          totalSells: totalSells
        };

        updateLiveTotals();
        resultsNode.innerHTML = summaryHtml(summaryData) + buildResultTable(results) + warningsHtml(warnings);
        hasCalculated = true;
      } catch (err) {
        clearLiveSnapshot();
        updateLiveTotals();
        resultsNode.textContent = "Output will appear here after you run rebalancing.";
        validationNode.textContent = String(err && err.message || err);
        hasCalculated = false;
      } finally {
        setRunningState(false);
      }
    }

    function getCurrentRowData() {
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      return rows.map(function (row) {
        return {
          ticker: row.querySelector(".ticker-input").value.trim().toUpperCase(),
          shares: row.querySelector(".shares-input").value,
          price: row.querySelector(".price-input").value,
          currencyKey: row.querySelector(".row-currency-select").value,
          targetWeight: row.querySelector(".target-weight-input").value
        };
      });
    }

    document.getElementById("applyRowCountBtn").addEventListener("click", function () {
      var targetRows = Number(rowCountInput.value);
      var existingData = getCurrentRowData();
      var seededRows = [];
      var rowLimit = Math.max(1, Math.min(50, Math.floor(targetRows) || 1));

      for (var i = 0; i < rowLimit; i += 1) {
        seededRows.push(existingData[i] || null);
      }

      setRows(rowLimit, seededRows);
    });

    document.getElementById("addRowBtn").addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length >= 50) {
        validationNode.textContent = "Maximum row limit reached (50).";
        return;
      }
      currentData.push(null);
      setRows(currentData.length, currentData);
    });

    document.getElementById("removeRowBtn").addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length <= 1) {
        validationNode.textContent = "At least one row is required.";
        return;
      }
      currentData.pop();
      setRows(currentData.length, currentData);
    });

    inputRowsNode.addEventListener("input", function () {
      validationNode.textContent = "";
      updateLiveTotals();
    });

    inputRowsNode.addEventListener("change", function () {
      validationNode.textContent = "";
      updateLiveTotals();
      if (hasCalculated) {
        calculateRebalance();
      }
    });

    reportingCurrencySelect.addEventListener("change", function () {
      validationNode.textContent = "";
      updateCurrencyUi();
      updateLiveTotals();
      if (hasCalculated) {
        calculateRebalance();
      }
    });

    rebalanceBtn.addEventListener("click", calculateRebalance);
    document.getElementById("sampleBtn").addEventListener("click", function () {
      rowCountInput.value = String(samplePortfolio.length);
      setRows(samplePortfolio.length, samplePortfolio);
      document.getElementById("netFlowInput").value = "0";
      validationNode.textContent = "";
      resultsNode.textContent = "Output will appear here after you run rebalancing.";
      hasCalculated = false;
    });

    updateCurrencyUi();
    setRows(samplePortfolio.length, samplePortfolio);
  })();
</script>
