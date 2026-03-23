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
    <div class="btn-row">
      <button class="btn" id="rebalanceBtn" type="button">Run Rebalance</button>
      <button class="btn btn-secondary" id="sampleBtn" type="button">Load Sample Portfolio</button>
    </div>
    <div class="field" style="margin-top: 8px;">
      <label style="display:flex; align-items:center; gap:8px;">
        <input id="fetchLiveDataInput" type="checkbox" />
        <span>Fetch live prices and FX rates from Yahoo Finance (browser network required)</span>
      </label>
    </div>
    <div id="runStatusMessage" class="muted">Ready.</div>
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
    var HOLD_THRESHOLD = 0.005;
    var STATUS_NEUTRAL = "#1f4f8a";
    var STATUS_WARN = "#8f5f12";
    var STATUS_SUCCESS = "#1c7550";
    var STATUS_ERROR = "#9b2f2f";

    var samplePortfolio = [
      { ticker: "VTI", shares: 120, price: 250, targetWeight: 10, currencyKey: "USD" },
      { ticker: "XIC", shares: 320, price: 36, targetWeight: 10, currencyKey: "CAD" },
      { ticker: "VEQT", shares: 410, price: 42, targetWeight: 20, currencyKey: "CAD" },
      { ticker: "EWJ", shares: 220, price: 64, targetWeight: 10, currencyKey: "USD" },
      { ticker: "VGK", shares: 115, price: 64, targetWeight: 10, currencyKey: "EUR" },
      { ticker: "ISF", shares: 260, price: 7.4, targetWeight: 10, currencyKey: "GBP" },
      { ticker: "AAPL", shares: 45, price: 180, targetWeight: 10, currencyKey: "USD" },
      { ticker: "BND", shares: 200, price: 72, targetWeight: 10, currencyKey: "USD" },
      { ticker: "MCHI", shares: 140, price: 40, targetWeight: 10, currencyKey: "USD" }
    ];

    var rowCountInput = document.getElementById("rowCountInput");
    var reportingCurrencySelect = document.getElementById("reportingCurrencySelect");
    var inputRowsNode = document.getElementById("inputRows");
    var netFlowInput = document.getElementById("netFlowInput");
    var fetchLiveDataInput = document.getElementById("fetchLiveDataInput");
    var validationNode = document.getElementById("validationMessage");
    var runStatusNode = document.getElementById("runStatusMessage");
    var resultsNode = document.getElementById("rebalanceResults");
    var applyRowCountBtn = document.getElementById("applyRowCountBtn");
    var addRowBtn = document.getElementById("addRowBtn");
    var removeRowBtn = document.getElementById("removeRowBtn");
    var rebalanceBtn = document.getElementById("rebalanceBtn");
    var sampleBtn = document.getElementById("sampleBtn");

    var hasCalculated = false;
    var isRunning = false;
    var liveFxToUsd = {};
    var liveFxKeys = {};
    var tickerValidateTimeouts = {};
    var tickerValidateTokens = {};
    var tickerValidationFeedback = {};

    var currencyOptions = {
      USD: { code: "USD", locale: "en-US", label: "USD", fxToUsd: 1.00 },
      CAD: { code: "CAD", locale: "en-CA", label: "CAD", fxToUsd: 0.74 },
      JPN: { code: "JPY", locale: "ja-JP", label: "JPN", fxToUsd: 0.0067 },
      EUR: { code: "EUR", locale: "de-DE", label: "EUR", fxToUsd: 1.09 },
      GBP: { code: "GBP", locale: "en-GB", label: "GBP", fxToUsd: 1.28 },
      CHY_CNH: { code: "CNY", locale: "zh-CN", label: "CHY/CNH", fxToUsd: 0.14 }
    };
    var currencyCodeToKey = {
      USD: "USD",
      CAD: "CAD",
      JPY: "JPN",
      EUR: "EUR",
      GBP: "GBP",
      CNY: "CHY_CNH"
    };
    var exchangeSuffixHints = {
      USD: [""],
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

    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function clampRowCount(value) {
      return Math.max(1, Math.min(50, Math.floor(Number(value) || 1)));
    }

    function getReportingCurrencyMeta() {
      return currencyOptions[reportingCurrencySelect.value] || currencyOptions.USD;
    }

    function getRowCurrencyMeta(currencyKey) {
      return currencyOptions[currencyKey] || currencyOptions.USD;
    }

    function fallbackFxToUsd(currencyKey) {
      return Number(getRowCurrencyMeta(currencyKey).fxToUsd);
    }

    function getFxToUsd(currencyKey) {
      if (hasOwn(liveFxToUsd, currencyKey)) {
        return Number(liveFxToUsd[currencyKey]);
      }
      return fallbackFxToUsd(currencyKey);
    }

    function getFxToReporting(currencyKey) {
      var rowToUsd = getFxToUsd(currencyKey);
      var reportingToUsd = getFxToUsd(reportingCurrencySelect.value);
      return rowToUsd / reportingToUsd;
    }

    function isLiveFxPair(rowCurrencyKey, reportingCurrencyKey) {
      return !!liveFxKeys[rowCurrencyKey] || !!liveFxKeys[reportingCurrencyKey];
    }

    function setRunStatus(message, color) {
      runStatusNode.textContent = message;
      runStatusNode.style.color = color || STATUS_NEUTRAL;
    }

    function setRunningState(running) {
      isRunning = !!running;
      applyRowCountBtn.disabled = running;
      addRowBtn.disabled = running;
      removeRowBtn.disabled = running;
      rebalanceBtn.disabled = running;
      sampleBtn.disabled = running;
      rowCountInput.disabled = running;
      reportingCurrencySelect.disabled = running;
      netFlowInput.disabled = running;
      fetchLiveDataInput.disabled = running;
      Array.prototype.forEach.call(inputRowsNode.querySelectorAll("input, select"), function (node) {
        node.disabled = running;
      });
    }

    function clearLiveSnapshot() {
      liveFxToUsd = {};
      liveFxKeys = {};
    }

    function clearTickerValidationState() {
      Object.keys(tickerValidateTimeouts).forEach(function (key) {
        clearTimeout(tickerValidateTimeouts[key]);
      });
      tickerValidateTimeouts = {};
      tickerValidateTokens = {};
      tickerValidationFeedback = {};
    }

    function formatFx(num, isLive) {
      var safe = Number.isFinite(num) ? num : 0;
      return (isLive ? "~" : "") + safe.toFixed(4);
    }

    function formatInputPrice(num) {
      var safe = Number(num);
      if (!Number.isFinite(safe)) {
        return "";
      }
      return safe.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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
      return Number(num).toFixed(2) + "%";
    }

    function formatShares(num) {
      return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4
      }).format(num);
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

      return "<tr data-row-idx='" + index + "'>" +
        "<td class='row-index'>" + (index + 1) + "</td>" +
        "<td>" +
        "<input class='sheet-input ticker-input' type='text' maxlength='18' placeholder='e.g. AAPL' value='" + escapeHtml(ticker) + "' />" +
        "<div class='ticker-hint muted' style='margin-top:4px; color:#8f5f12; font-size:0.85em;'></div>" +
        "</td>" +
        "<td><input class='sheet-input shares-input' type='number' min='0' step='0.0001' value='" + shares + "' /></td>" +
        "<td><input class='sheet-input price-input' type='number' step='0.0001' value='" + price + "' /></td>" +
        "<td><select class='sheet-input sheet-select row-currency-select'>" + currencyOptionsHtml(currencyKey) + "</select></td>" +
        "<td class='fx-rate-cell'>" + formatFx(fxToReporting, false) + "</td>" +
        "<td class='current-value-cell'>" + currentValueText + "</td>" +
        "<td><input class='sheet-input target-weight-input' type='number' min='0' step='0.01' value='" + targetWeight + "' /></td>" +
        "</tr>";
    }

    function appendUnique(items, value) {
      if (items.indexOf(value) === -1) {
        items.push(value);
      }
    }

    function buildTickerCandidates(ticker, currencyKey) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) {
        return [];
      }

      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        var preferredSuffix = prefixToSuffix[prefix];
        if (clean.indexOf(prefix) === 0) {
          var stripped = clean.slice(prefix.length).trim();
          if (!stripped) {
            return [];
          }
          var inferredKeyFromPrefix = suffixToCurrencyKey[preferredSuffix] || currencyKey;
          var suffixesForPrefix = exchangeSuffixHints[inferredKeyFromPrefix] || [""];
          var ordered = [preferredSuffix].concat(suffixesForPrefix.filter(function (s) {
            return s !== preferredSuffix;
          }));
          var prefixedCandidates = [];
          ordered.forEach(function (suffix) {
            appendUnique(prefixedCandidates, suffix ? (stripped + suffix) : stripped);
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
        if (stem && hasOwn(suffixToCurrencyKey, suffix)) {
          var candidates = [clean];
          var inferredKey = suffixToCurrencyKey[suffix] || currencyKey;
          [currencyKey, inferredKey].forEach(function (key) {
            (exchangeSuffixHints[key] || [""]).forEach(function (altSuffix) {
              appendUnique(candidates, altSuffix ? (stem + altSuffix) : stem);
            });
          });
          return candidates;
        }
        return [clean];
      }

      var baseCandidates = [];
      (exchangeSuffixHints[currencyKey] || [""]).forEach(function (suffix) {
        appendUnique(baseCandidates, suffix ? (clean + suffix) : clean);
      });
      return baseCandidates;
    }

    function buildTickerInputHint(tickerSymbol, currencyKey) {
      var cleaned = String(tickerSymbol || "").trim().toUpperCase();
      if (!cleaned) {
        return "";
      }

      var expectedKey = hasOwn(currencyOptions, currencyKey) ? currencyKey : "USD";
      var expectedCode = currencyOptions[expectedKey].code;
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        var suffix = prefixToSuffix[prefix];
        if (cleaned.indexOf(prefix) === 0) {
          var base = cleaned.slice(prefix.length).trim();
          if (!base) {
            return "";
          }
          var suggestion = base + suffix;
          var mappedKey = suffixToCurrencyKey[suffix] || expectedKey;
          var mappedCode = currencyOptions[mappedKey].code;
          if (mappedKey !== expectedKey) {
            return "'" + prefix + "' prefix not supported by Yahoo Finance. Try '" +
              suggestion + "' (" + mappedCode + ") or switch row currency.";
          }
          return "'" + prefix + "' prefix not supported. Try '" + suggestion + "'.";
        }
      }

      if (cleaned.indexOf(".") >= 0) {
        var dotSuffix = "." + cleaned.split(".").pop();
        var suffixMappedKey = suffixToCurrencyKey[dotSuffix];
        if (suffixMappedKey && suffixMappedKey !== expectedKey) {
          var suffixMappedCode = currencyOptions[suffixMappedKey].code;
          return "'" + dotSuffix + "' implies " + suffixMappedCode + " but row is " + expectedCode + " - check row currency.";
        }
        return "";
      }

      var candidates = buildTickerCandidates(cleaned, expectedKey);
      for (var c = 0; c < candidates.length; c += 1) {
        if (candidates[c] !== cleaned) {
          return "For " + expectedCode + " live quotes, try '" + candidates[c] + "'. Verify the exact symbol at finance.yahoo.com.";
        }
      }
      return "";
    }

    function getRowIndex(rowNode) {
      if (!rowNode) {
        return -1;
      }
      return Number(rowNode.getAttribute("data-row-idx"));
    }

    function getRowNodeByIndex(rowIndex) {
      return inputRowsNode.querySelector("tr[data-row-idx='" + rowIndex + "']");
    }

    function setRows(count, seedData) {
      var rowCount = clampRowCount(count);
      rowCountInput.value = String(rowCount);
      clearTickerValidationState();

      var rowsHtml = [];
      for (var i = 0; i < rowCount; i += 1) {
        rowsHtml.push(rowHtml(i, seedData && seedData[i] ? seedData[i] : null));
      }
      inputRowsNode.innerHTML = rowsHtml.join("");
      updateLiveTotals();
    }

    function safePositiveNumber(rawValue) {
      var value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }
      return value;
    }

    function readNumberInput(inputNode) {
      if (!inputNode) {
        return NaN;
      }
      var value = Number(inputNode.value);
      return Number.isFinite(value) ? value : NaN;
    }

    function updateTickerHintForRow(row, rowIdx) {
      var hintNode = row.querySelector(".ticker-hint");
      if (!hintNode) {
        return;
      }
      var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
      var currencyKey = row.querySelector(".row-currency-select").value;
      var feedback = tickerValidationFeedback[rowIdx];
      if (feedback && feedback.ticker === ticker) {
        hintNode.textContent = feedback.text;
        hintNode.style.color = feedback.color;
        return;
      }
      hintNode.textContent = buildTickerInputHint(ticker, currencyKey);
      hintNode.style.color = STATUS_WARN;
    }

    function updateLiveTotals() {
      var currentTotal = 0;
      var weightTotal = 0;
      var rows = inputRowsNode.querySelectorAll("tr");
      var reportKey = reportingCurrencySelect.value;

      rows.forEach(function (row) {
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var price = readNumberInput(row.querySelector(".price-input"));
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;
        var fxToReporting = getFxToReporting(currencyKey);
        var fxIsLive = isLiveFxPair(currencyKey, reportKey);

        var localValue = Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price > 0
          ? shares * price
          : 0;
        var reportingValue = localValue * fxToReporting;

        row.querySelector(".fx-rate-cell").textContent = formatFx(fxToReporting, fxIsLive);
        row.querySelector(".current-value-cell").textContent = formatCurrency(reportingValue);
        updateTickerHintForRow(row, getRowIndex(row));

        currentTotal += reportingValue;
        if (Number.isFinite(targetWeight) && targetWeight >= 0) {
          weightTotal += targetWeight;
        }
      });

      document.getElementById("liveCurrentTotal").textContent = "Current total: " + formatCurrency(currentTotal);
      document.getElementById("liveWeightTotal").textContent = "Target weight total: " + formatPct(weightTotal);
    }

    function parsePositionsFromTable(requirePrice) {
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      if (!rows.length) {
        throw new Error("Add at least one security row.");
      }

      var positions = rows.map(function (row, idx) {
        var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var parsedPrice = readNumberInput(row.querySelector(".price-input"));
        var manualPrice = Number.isFinite(parsedPrice) ? parsedPrice : null;
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;

        if (!ticker) {
          throw new Error("Row " + (idx + 1) + ": ticker is required.");
        }
        if (!Number.isFinite(shares) || shares < 0) {
          throw new Error("Row " + (idx + 1) + ": shares/units must be a non-negative number.");
        }
        if (requirePrice && (manualPrice === null || manualPrice <= 0)) {
          throw new Error("Row " + (idx + 1) + ": price must be greater than 0.");
        }
        if (!requirePrice && manualPrice !== null && manualPrice <= 0) {
          throw new Error("Row " + (idx + 1) + ": manual price must be greater than 0 when provided.");
        }
        if (!Number.isFinite(targetWeight) || targetWeight < 0) {
          throw new Error("Row " + (idx + 1) + ": target weight must be 0 or greater.");
        }
        if (!hasOwn(currencyOptions, currencyKey)) {
          throw new Error("Row " + (idx + 1) + ": row currency is invalid.");
        }

        return {
          rowIndex: idx,
          ticker: ticker,
          shares: shares,
          price: manualPrice,
          currencyKey: currencyKey,
          currencyLabel: getRowCurrencyMeta(currencyKey).label,
          targetWeight: targetWeight
        };
      });

      var hasPositiveWeight = positions.some(function (p) { return p.targetWeight > 0; });
      if (!hasPositiveWeight) {
        throw new Error("At least one target weight must be greater than 0.");
      }

      return positions;
    }

    function normalizeQuoteCurrency(rawCurrency) {
      if (typeof rawCurrency !== "string" || !rawCurrency.trim()) {
        return { quoteCurrency: null, unitScale: 1.0 };
      }
      var cleaned = rawCurrency.trim();
      if (cleaned === "GBp" || cleaned === "GBX") {
        return { quoteCurrency: "GBP", unitScale: 0.01 };
      }
      var upper = cleaned.toUpperCase();
      if (upper === "CNH") {
        return { quoteCurrency: "CNY", unitScale: 1.0 };
      }
      return { quoteCurrency: upper, unitScale: 1.0 };
    }

    function extractChartLastPrice(chartResult) {
      var meta = chartResult && chartResult.meta ? chartResult.meta : {};
      var fromMeta = ["regularMarketPrice", "previousClose", "chartPreviousClose"];
      for (var i = 0; i < fromMeta.length; i += 1) {
        var value = safePositiveNumber(meta[fromMeta[i]]);
        if (value !== null) {
          return value;
        }
      }

      var closes = (((chartResult || {}).indicators || {}).quote || [])[0];
      if (closes && Array.isArray(closes.close)) {
        for (var idx = closes.close.length - 1; idx >= 0; idx -= 1) {
          var closeValue = safePositiveNumber(closes.close[idx]);
          if (closeValue !== null) {
            return closeValue;
          }
        }
      }
      return null;
    }

    function extractChartQuoteCurrency(chartResult) {
      var meta = chartResult && chartResult.meta ? chartResult.meta : {};
      if (typeof meta.currency === "string" && meta.currency.trim()) {
        return meta.currency.trim();
      }
      return null;
    }

    function parseRjinaYahooPayload(rawText) {
      if (typeof rawText !== "string") {
        return null;
      }
      var marker = "Markdown Content:";
      var markerIdx = rawText.indexOf(marker);
      if (markerIdx === -1) {
        return null;
      }
      var jsonText = rawText.slice(markerIdx + marker.length).trim();
      if (!jsonText) {
        return null;
      }
      try {
        return JSON.parse(jsonText);
      } catch (_err) {
        return null;
      }
    }

    async function fetchYahooChartPayload(tickerSymbol) {
      var directUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(tickerSymbol) + "?range=5d&interval=1d";
      var proxyUrl = "https://r.jina.ai/http://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(tickerSymbol) + "?range=5d&interval=1d";

      // Try direct Yahoo fetch first. If CORS/network blocks this in browser context,
      // fall back to a read-only CORS-friendly proxy.
      try {
        var directResponse = await fetch(directUrl, { method: "GET" });
        if (directResponse.ok) {
          return await directResponse.json();
        }
        console.warn("[yf] Direct HTTP " + directResponse.status + " for " + tickerSymbol);
      } catch (errDirect) {
        console.warn("[yf] Direct fetch failed for " + tickerSymbol + ": " + (errDirect && errDirect.message ? errDirect.message : errDirect));
      }

      try {
        var proxyResponse = await fetch(proxyUrl, { method: "GET" });
        if (!proxyResponse.ok) {
          console.warn("[yf] Proxy HTTP " + proxyResponse.status + " for " + tickerSymbol);
          return null;
        }
        var proxyBody = await proxyResponse.text();
        return parseRjinaYahooPayload(proxyBody);
      } catch (errProxy) {
        console.warn("[yf] Proxy fetch failed for " + tickerSymbol + ": " + (errProxy && errProxy.message ? errProxy.message : errProxy));
        return null;
      }
    }

    async function fetchLiveQuoteDetails(tickerSymbol) {
      if (!tickerSymbol) {
        return null;
      }

      try {
        var payload = await fetchYahooChartPayload(tickerSymbol);
        if (!payload) {
          console.warn("[yf] No payload for " + tickerSymbol);
          return null;
        }
        var chart = payload && payload.chart ? payload.chart : null;
        if (!chart || chart.error || !Array.isArray(chart.result) || !chart.result.length) {
          console.warn("[yf] No chart result for " + tickerSymbol);
          return null;
        }

        var chartResult = chart.result[0];
        var rawPrice = extractChartLastPrice(chartResult);
        if (rawPrice === null) {
          console.warn("[yf] No price returned for " + tickerSymbol);
          return null;
        }

        var rawQuoteCurrency = extractChartQuoteCurrency(chartResult);
        var normalized = normalizeQuoteCurrency(rawQuoteCurrency);
        return {
          resolvedTicker: tickerSymbol,
          rawPrice: rawPrice,
          price: rawPrice * normalized.unitScale,
          rawQuoteCurrency: rawQuoteCurrency,
          quoteCurrency: normalized.quoteCurrency,
          unitScale: normalized.unitScale
        };
      } catch (err) {
        console.warn("[yf] Exception fetching " + tickerSymbol + ": " + (err && err.message ? err.message : err));
        return null;
      }
    }

    async function fetchLiveFxToUsd(currencyCode) {
      if (currencyCode === "USD") {
        return 1.0;
      }
      var quote = await fetchLiveQuoteDetails(currencyCode + "USD=X");
      if (!quote) {
        return null;
      }
      return safePositiveNumber(quote.price);
    }

    function scheduleTickerValidation(rowIdx) {
      if (hasOwn(tickerValidateTimeouts, rowIdx)) {
        clearTimeout(tickerValidateTimeouts[rowIdx]);
      }
      var nextToken = (tickerValidateTokens[rowIdx] || 0) + 1;
      tickerValidateTokens[rowIdx] = nextToken;
      tickerValidateTimeouts[rowIdx] = setTimeout(function () {
        validateTickerBackground(rowIdx, nextToken);
      }, 800);
    }

    function applyTickerValidationFeedback(rowIdx, token, expectedTicker, message, color) {
      if (tickerValidateTokens[rowIdx] !== token) {
        return;
      }
      var row = getRowNodeByIndex(rowIdx);
      if (!row) {
        return;
      }
      var liveTicker = row.querySelector(".ticker-input").value.trim().toUpperCase();
      if (liveTicker !== expectedTicker) {
        return;
      }
      tickerValidationFeedback[rowIdx] = {
        ticker: liveTicker,
        text: message,
        color: color
      };
      updateLiveTotals();
    }

    async function validateTickerBackground(rowIdx, token) {
      delete tickerValidateTimeouts[rowIdx];
      if (tickerValidateTokens[rowIdx] !== token) {
        return;
      }
      var row = getRowNodeByIndex(rowIdx);
      if (!row) {
        return;
      }
      var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
      var currencyKey = row.querySelector(".row-currency-select").value;
      if (!ticker) {
        delete tickerValidationFeedback[rowIdx];
        updateLiveTotals();
        return;
      }

      tickerValidationFeedback[rowIdx] = {
        ticker: ticker,
        text: "Checking " + ticker + "...",
        color: "#3f5066"
      };
      updateLiveTotals();

      try {
        var candidates = buildTickerCandidates(ticker, currencyKey);
        for (var i = 0; i < candidates.length; i += 1) {
          var candidate = candidates[i];
          var quote = await fetchLiveQuoteDetails(candidate);
          if (quote) {
            var okMsg = "Verified: " + quote.resolvedTicker + " (" + (quote.quoteCurrency || "?") + ")";
            applyTickerValidationFeedback(rowIdx, token, ticker, okMsg, STATUS_SUCCESS);
            return;
          }
        }
        var fallbackHint = buildTickerInputHint(ticker, currencyKey);
        var failMsg = "Not found on Yahoo Finance.";
        if (fallbackHint) {
          failMsg += " " + fallbackHint;
        }
        applyTickerValidationFeedback(rowIdx, token, ticker, failMsg, STATUS_ERROR);
      } catch (_err) {
        applyTickerValidationFeedback(rowIdx, token, ticker, "Ticker validation failed. Try again.", STATUS_ERROR);
      }
    }

    function getFxToUsdFromMap(fxToUsdMap, currencyKey) {
      if (hasOwn(fxToUsdMap, currencyKey)) {
        return Number(fxToUsdMap[currencyKey]);
      }
      return fallbackFxToUsd(currencyKey);
    }

    function attachFxValues(positions, fxToUsdMap) {
      var reportingKey = reportingCurrencySelect.value;
      var reportToUsd = getFxToUsdFromMap(fxToUsdMap, reportingKey);
      return positions.map(function (position) {
        var rowToUsd = getFxToUsdFromMap(fxToUsdMap, position.currencyKey);
        var fxToReporting = rowToUsd / reportToUsd;
        if (position.price === null || position.price <= 0) {
          throw new Error(position.ticker + ": price must be greater than 0.");
        }
        var currentValueLocal = position.shares * position.price;
        return {
          rowIndex: position.rowIndex,
          ticker: position.ticker,
          shares: position.shares,
          price: position.price,
          currencyKey: position.currencyKey,
          currencyLabel: getRowCurrencyMeta(position.currencyKey).label,
          targetWeight: position.targetWeight,
          fxToReporting: fxToReporting,
          currentValueLocal: currentValueLocal,
          currentValue: currentValueLocal * fxToReporting
        };
      });
    }

    function calculateRebalancePlan(enrichedPositions, netFlow) {
      var totalCurrent = enrichedPositions.reduce(function (sum, p) { return sum + p.currentValue; }, 0);
      var totalWeight = enrichedPositions.reduce(function (sum, p) { return sum + p.targetWeight; }, 0);
      var endingValue = totalCurrent + netFlow;

      if (endingValue <= 0) {
        throw new Error("Ending portfolio value must be greater than 0.");
      }
      if (totalWeight <= 0) {
        throw new Error("At least one target weight must be greater than 0.");
      }

      var totalBuys = 0;
      var totalSells = 0;
      var results = enrichedPositions.map(function (p) {
        var targetWeightNorm = p.targetWeight / totalWeight;
        var targetValue = targetWeightNorm * endingValue;
        var tradeValue = targetValue - p.currentValue;
        var tradeValueLocal = tradeValue / p.fxToReporting;
        var tradeShares = tradeValueLocal / p.price;
        var action = "Hold";

        if (tradeValue > HOLD_THRESHOLD) {
          action = "Buy";
          totalBuys += tradeValue;
        } else if (tradeValue < -HOLD_THRESHOLD) {
          action = "Sell";
          totalSells += Math.abs(tradeValue);
        }

        if (Math.abs(tradeValue) <= HOLD_THRESHOLD) {
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
          currentValue: p.currentValue,
          targetWeightNorm: targetWeightNorm,
          targetValue: targetValue,
          tradeValue: tradeValue,
          tradeValueLocal: tradeValueLocal,
          tradeShares: tradeShares,
          action: action,
          postTradeShares: p.shares + tradeShares
        };
      });

      return {
        summary: {
          totalCurrent: totalCurrent,
          netFlow: netFlow,
          endingValue: endingValue,
          totalBuys: totalBuys,
          totalSells: totalSells
        },
        results: results
      };
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

    function syncInputsFromPositions(positions) {
      positions.forEach(function (position) {
        var row = getRowNodeByIndex(position.rowIndex);
        if (!row) {
          return;
        }
        row.querySelector(".row-currency-select").value = position.currencyKey;
        row.querySelector(".price-input").value = formatInputPrice(position.price);
      });
    }

    function buildTickerCurrencyWarnings(positions) {
      var warnings = [];
      positions.forEach(function (position, idx) {
        var hint = buildTickerInputHint(position.ticker, position.currencyKey);
        if (hint) {
          warnings.push("Row " + (idx + 1) + " (" + position.ticker + "): " + hint);
        }
      });
      return warnings;
    }

    function recalculateFromInputs(showError) {
      validationNode.textContent = "";
      try {
        var positions = parsePositionsFromTable(true);
        var netFlow = Number(netFlowInput.value || "0");
        if (!Number.isFinite(netFlow)) {
          throw new Error("Net contribution / withdrawal must be a valid number.");
        }

        var fxToUsdMap = {};
        Object.keys(currencyOptions).forEach(function (key) {
          fxToUsdMap[key] = getFxToUsd(key);
        });
        var enriched = attachFxValues(positions, fxToUsdMap);
        var plan = calculateRebalancePlan(enriched, netFlow);
        resultsNode.innerHTML = summaryHtml(plan.summary) + buildResultTable(plan.results);
        hasCalculated = true;
      } catch (err) {
        resultsNode.textContent = "Output will appear here after you run rebalancing.";
        validationNode.textContent = err.message || String(err);
        hasCalculated = false;
        if (showError) {
          setRunStatus("Validation failed. Review your inputs.", STATUS_ERROR);
        }
      }
    }

    async function runRebalance() {
      if (isRunning) {
        return;
      }
      validationNode.textContent = "";
      var useLiveFetch = !!fetchLiveDataInput.checked;
      setRunningState(true);
      setRunStatus(useLiveFetch ? "Fetching live prices and FX rates..." : "Running rebalance...", STATUS_NEUTRAL);

      try {
        var positions = parsePositionsFromTable(!useLiveFetch);
        var netFlow = Number(netFlowInput.value || "0");
        if (!Number.isFinite(netFlow)) {
          throw new Error("Net contribution / withdrawal must be a valid number.");
        }

        var warnings = [];
        var fxToUsdMap = {};
        Object.keys(currencyOptions).forEach(function (key) {
          fxToUsdMap[key] = fallbackFxToUsd(key);
        });

        if (useLiveFetch) {
          var liveFxKeysLocal = {};
          for (var i = 0; i < positions.length; i += 1) {
            var position = positions[i];
            var ticker = position.ticker;
            var selectedCurrencyKey = position.currencyKey;
            var selectedCurrencyCode = currencyOptions[selectedCurrencyKey].code;
            var manualPrice = position.price;
            var attemptedCandidates = buildTickerCandidates(ticker, selectedCurrencyKey);
            var bestMatchingQuote = null;
            var firstFallbackQuote = null;

            for (var j = 0; j < attemptedCandidates.length; j += 1) {
              var candidate = attemptedCandidates[j];
              var quoteDetails = await fetchLiveQuoteDetails(candidate);
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
              var attemptedStr = attemptedCandidates.length ? attemptedCandidates.join(", ") : ticker;
              if (manualPrice === null) {
                throw new Error(
                  "Live price unavailable for " + ticker + " (tried: " + attemptedStr + "). " +
                  "Verify the symbol on finance.yahoo.com or enter a manual price."
                );
              }
              warnings.push(
                "Live price unavailable for " + ticker + " (tried: " + attemptedStr + "); " +
                "using manual entry " + manualPrice.toFixed(4) + "."
              );
              continue;
            }

            var resolvedTicker = String(chosenQuote.resolvedTicker);
            var chosenQuoteCode = chosenQuote.quoteCurrency;
            var quoteKey = chosenQuoteCode ? (currencyCodeToKey[chosenQuoteCode] || null) : null;
            var chosenPrice = Number(chosenQuote.price);

            if (chosenQuoteCode && chosenQuoteCode !== selectedCurrencyCode) {
              if (quoteKey !== null && manualPrice === null) {
                position.currencyKey = quoteKey;
                position.currencyLabel = getRowCurrencyMeta(quoteKey).label;
                position.price = chosenPrice;
                warnings.push(
                  ticker + ": live quote currency " + chosenQuoteCode + " does not match selected " +
                  selectedCurrencyCode + "; adjusted row currency to " + chosenQuoteCode + " for this run."
                );
                if (resolvedTicker !== ticker) {
                  warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
                }
                continue;
              }

              if (manualPrice !== null) {
                warnings.push(
                  ticker + ": live quote currency " + chosenQuoteCode + " does not match selected " +
                  selectedCurrencyCode + "; keeping manual entry " + manualPrice.toFixed(4) + "."
                );
                continue;
              }

              throw new Error(
                ticker + ": live quote returned unsupported quote currency " + chosenQuoteCode +
                " for selected " + selectedCurrencyCode + "; enter a manual price."
              );
            }

            position.price = chosenPrice;
            if (resolvedTicker !== ticker) {
              warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
            }
            if (chosenQuote.unitScale !== 1.0) {
              warnings.push(
                ticker + ": converted sub-unit quote currency " +
                chosenQuote.rawQuoteCurrency + " to " + chosenQuoteCode + " units."
              );
            }
          }

          setRunStatus("Fetching live FX rates...", STATUS_NEUTRAL);
          var currenciesInScope = {};
          currenciesInScope[reportingCurrencySelect.value] = true;
          positions.forEach(function (position) {
            currenciesInScope[position.currencyKey] = true;
          });
          var currencyKeys = Object.keys(currenciesInScope).sort();
          for (var fxIdx = 0; fxIdx < currencyKeys.length; fxIdx += 1) {
            var currencyKey = currencyKeys[fxIdx];
            var currencyCode = currencyOptions[currencyKey].code;
            var liveRate = await fetchLiveFxToUsd(currencyCode);
            if (liveRate !== null) {
              fxToUsdMap[currencyKey] = liveRate;
              liveFxKeysLocal[currencyKey] = true;
            } else {
              warnings.push(
                "Live FX unavailable for " + currencyKey + "; using fallback rate " +
                fallbackFxToUsd(currencyKey).toFixed(4) + "."
              );
            }
          }

          liveFxToUsd = fxToUsdMap;
          liveFxKeys = liveFxKeysLocal;
          syncInputsFromPositions(positions);
        } else {
          clearLiveSnapshot();
          warnings = warnings.concat(buildTickerCurrencyWarnings(positions));
        }

        var enrichedPositions = attachFxValues(positions, fxToUsdMap);
        var plan = calculateRebalancePlan(enrichedPositions, netFlow);
        resultsNode.innerHTML = summaryHtml(plan.summary) + buildResultTable(plan.results) + warningsHtml(warnings);
        hasCalculated = true;
        updateLiveTotals();

        if (warnings.length) {
          setRunStatus("Completed with " + warnings.length + " warning(s). Verify data before trading.", STATUS_WARN);
        } else {
          setRunStatus("Rebalance completed successfully.", STATUS_SUCCESS);
        }
      } catch (err) {
        resultsNode.textContent = "Output will appear here after you run rebalancing.";
        validationNode.textContent = err.message || String(err);
        hasCalculated = false;
        setRunStatus("Run failed. Review validation message.", STATUS_ERROR);
      } finally {
        setRunningState(false);
      }
    }

    applyRowCountBtn.addEventListener("click", function () {
      var targetRows = Number(rowCountInput.value);
      var existingData = getCurrentRowData();
      var seededRows = [];
      var rowLimit = clampRowCount(targetRows);
      for (var i = 0; i < rowLimit; i += 1) {
        seededRows.push(existingData[i] || null);
      }
      setRows(rowLimit, seededRows);
      if (hasCalculated) {
        recalculateFromInputs(false);
      }
    });

    addRowBtn.addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length >= 50) {
        validationNode.textContent = "Maximum row limit reached (50).";
        return;
      }
      currentData.push(null);
      setRows(currentData.length, currentData);
      if (hasCalculated) {
        recalculateFromInputs(false);
      }
    });

    removeRowBtn.addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length <= 1) {
        validationNode.textContent = "At least one row is required.";
        return;
      }
      currentData.pop();
      setRows(currentData.length, currentData);
      if (hasCalculated) {
        recalculateFromInputs(false);
      }
    });

    inputRowsNode.addEventListener("input", function (event) {
      validationNode.textContent = "";
      var row = event.target.closest("tr");
      if (row && event.target.classList.contains("ticker-input")) {
        var rowIdx = getRowIndex(row);
        delete tickerValidationFeedback[rowIdx];
        scheduleTickerValidation(rowIdx);
      }
      updateLiveTotals();
    });

    inputRowsNode.addEventListener("change", function (event) {
      validationNode.textContent = "";
      var row = event.target.closest("tr");
      if (row && (event.target.classList.contains("ticker-input") || event.target.classList.contains("row-currency-select"))) {
        var rowIdx = getRowIndex(row);
        delete tickerValidationFeedback[rowIdx];
        scheduleTickerValidation(rowIdx);
      }
      updateLiveTotals();
      if (hasCalculated && !isRunning) {
        recalculateFromInputs(false);
      }
    });

    reportingCurrencySelect.addEventListener("change", function () {
      validationNode.textContent = "";
      updateCurrencyUi();
      updateLiveTotals();
      if (hasCalculated && !isRunning) {
        recalculateFromInputs(false);
      }
    });

    netFlowInput.addEventListener("change", function () {
      validationNode.textContent = "";
      if (hasCalculated && !isRunning) {
        recalculateFromInputs(false);
      }
    });

    rebalanceBtn.addEventListener("click", function () {
      runRebalance();
    });

    sampleBtn.addEventListener("click", function () {
      clearLiveSnapshot();
      clearTickerValidationState();
      rowCountInput.value = String(samplePortfolio.length);
      setRows(samplePortfolio.length, samplePortfolio);
      netFlowInput.value = "0";
      validationNode.textContent = "";
      resultsNode.textContent = "Output will appear here after you run rebalancing.";
      hasCalculated = false;
      setRunStatus("Sample portfolio loaded.", STATUS_NEUTRAL);
    });

    updateCurrencyUi();
    setRows(samplePortfolio.length, samplePortfolio);
    setRunStatus("Ready.", STATUS_NEUTRAL);
  })();
</script>
