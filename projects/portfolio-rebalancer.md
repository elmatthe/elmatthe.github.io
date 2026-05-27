---
layout: page
title: Portfolio Rebalancer Project
permalink: /projects/portfolio-rebalancer/
summary: Portfolio rebalancer workflow with interactive web tool, downloadable desktop program, and setup guide.
last_updated: 2026-05-25
---

<section class="hero-panel">
  <div class="eyebrow">Financial Tool Project</div>
  <h1>Portfolio Rebalancer</h1>
  <p class="lede">This project provides a practical portfolio rebalancing workflow for advisory prep and client review meetings. Use the interactive web tool or download the desktop program to run the same logic locally.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/Portfolio_Rebalancer/main.py' | relative_url }}" download>Download Portfolio Rebalancer (program folder)</a>
  <a class="btn" href="{{ '/projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md' | relative_url }}" download="Portfolio_Rebalancer_Setup_Guide.md">Download Setup &amp; Usage Guide (.md)</a>
</div>

## Guides
<ul class="link-list">
  <li><a href="{{ '/projects/portfolio-rebalancer-guide/' | relative_url }}">Open Portfolio Rebalancer Setup Guide (Web Page)</a></li>
</ul>

## Interactive Web Tool
Use the browser version below to run the rebalancing workflow directly on this site. Choose between **New Money** mode (buy-only with a budget cap) and **Rebalance** mode (sell overweight, buy underweight).

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
      <div class="field inline-field">
        <label for="modeSelect">Mode</label>
        <select id="modeSelect" class="sheet-select">
          <option value="new_money" selected>New Money</option>
          <option value="rebalance">Rebalance (Pure)</option>
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
            <th class="account-type-col" style="display:none;">Account Type</th>
          </tr>
        </thead>
        <tbody id="inputRows"></tbody>
      </table>
    </div>

    <div class="table-footnote">
      <span id="liveCurrentTotal">Current total: $0.00</span>
      <span id="liveWeightTotal">Target weight total: 0.00%</span>
    </div>

    <div class="field" id="budgetField">
      <label for="budgetInput" id="budgetLabel">New money budget (USD)</label>
      <input id="budgetInput" type="number" value="0" step="0.01" min="0" />
      <div class="muted">Amount of new cash to invest. Buy recommendations will not exceed this budget.</div>
    </div>

    <div class="btn-row">
      <button class="btn" id="rebalanceBtn" type="button">Run Rebalance</button>
      <button class="btn btn-secondary" id="sampleBtn" type="button">Load Sample Portfolio</button>
    </div>
    <div style="margin:8px 0 4px;">
      <label style="display:inline-flex !important; align-items:center; gap:8px; font-weight:400; cursor:pointer; width:auto;">
        <input id="fetchLiveDataInput" type="checkbox" style="width:auto !important; margin:0; flex-shrink:0;" />
        <span style="display:inline;">Fetch live prices and FX rates from Yahoo Finance (browser network required)</span>
      </label>
    </div>
    <div style="margin:4px 0;">
      <label style="display:inline-flex !important; align-items:center; gap:8px; font-weight:400; cursor:pointer; width:auto;">
        <input id="showAccountTypeInput" type="checkbox" style="width:auto !important; margin:0; flex-shrink:0;" />
        <span style="display:inline;">Show Account Type column (for cross-account funding checks)</span>
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
    <p class="muted">Enter each security, shares, local price, row currency, target weight, and optionally account type.</p>
  </section>
  <section class="card">
    <h3>2) Choose Mode</h3>
    <p class="muted"><strong>New Money:</strong> buy-only with a budget cap. <strong>Rebalance:</strong> sells fund buys, no new cash.</p>
  </section>
  <section class="card">
    <h3>3) Output</h3>
    <p class="muted">Review Buy/Sell/Hold actions, trade amounts, post-trade shares, and any invariant warnings.</p>
  </section>
</div>

<script>
  (function () {
    var HOLD_THRESHOLD_PCT = 0.0001;
    var STATUS_NEUTRAL = "#1f4f8a";
    var STATUS_WARN = "#8f5f12";
    var STATUS_SUCCESS = "#1c7550";
    var STATUS_ERROR = "#9b2f2f";

    var ACCOUNT_TYPES = ["", "TFSA", "RRSP", "RESP", "RRIF", "FHSA", "LIRA", "Margin", "Non-Registered", "Individual", "Crypto", "Other"];

    var samplePortfolio = [
      { ticker: "VTI", shares: 120, price: 250, targetWeight: 10, currencyKey: "USD" },
      { ticker: "XIC.TO", shares: 320, price: 36, targetWeight: 10, currencyKey: "CAD" },
      { ticker: "VEQT.TO", shares: 410, price: 42, targetWeight: 20, currencyKey: "CAD" },
      { ticker: "EWJ", shares: 220, price: 64, targetWeight: 10, currencyKey: "USD" },
      { ticker: "VGK", shares: 115, price: 64, targetWeight: 10, currencyKey: "USD" },
      { ticker: "ISF.L", shares: 260, price: 7.4, targetWeight: 10, currencyKey: "GBP" },
      { ticker: "AAPL", shares: 45, price: 180, targetWeight: 10, currencyKey: "USD" },
      { ticker: "BND", shares: 200, price: 72, targetWeight: 10, currencyKey: "USD" },
      { ticker: "MCHI", shares: 140, price: 40, targetWeight: 10, currencyKey: "USD" }
    ];

    var rowCountInput = document.getElementById("rowCountInput");
    var reportingCurrencySelect = document.getElementById("reportingCurrencySelect");
    var modeSelect = document.getElementById("modeSelect");
    var inputRowsNode = document.getElementById("inputRows");
    var budgetInput = document.getElementById("budgetInput");
    var budgetField = document.getElementById("budgetField");
    var fetchLiveDataInput = document.getElementById("fetchLiveDataInput");
    var showAccountTypeInput = document.getElementById("showAccountTypeInput");
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
      CHY_CNH: { code: "CNY", locale: "en-US", label: "CHY/CNH", fxToUsd: 0.14 }
    };
    var currencyCodeToKey = { USD: "USD", CAD: "CAD", JPY: "JPN", EUR: "EUR", GBP: "GBP", CNY: "CHY_CNH" };
    var exchangeSuffixHints = {
      USD: [""], CAD: [".TO", ".V", ""], JPN: [".T", ""],
      EUR: [".DE", ".AS", ".PA", ".MI", ".BR", ""], GBP: [".L", ""],
      CHY_CNH: [".SS", ".SZ", ".HK", ""]
    };
    var suffixToCurrencyKey = {
      ".TO": "CAD", ".V": "CAD", ".T": "JPN", ".DE": "EUR", ".AS": "EUR",
      ".PA": "EUR", ".MI": "EUR", ".BR": "EUR", ".L": "GBP",
      ".SS": "CHY_CNH", ".SZ": "CHY_CNH", ".HK": "CHY_CNH"
    };
    var prefixToSuffix = { "TSE:": ".TO", "TSX:": ".TO", "LSE:": ".L", "JPX:": ".T" };
    var crossMarketSuffixes = [".TO", ".V", ".L", ".T", ".DE", ".AS", ".PA", ".MI", ".BR", ".SS", ".SZ", ".HK", ""];
    var CORS_PROXIES = [
      function (url) { return "https://corsproxy.io/?" + encodeURIComponent(url); },
      function (url) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(url); },
      function (url) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url); }
    ];
    var yahooBaseUrls = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

    function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
    function clampRowCount(value) { return Math.max(1, Math.min(50, Math.floor(Number(value) || 1))); }
    function getReportingCurrencyMeta() { return currencyOptions[reportingCurrencySelect.value] || currencyOptions.USD; }
    function getRowCurrencyMeta(currencyKey) { return currencyOptions[currencyKey] || currencyOptions.USD; }
    function fallbackFxToUsd(currencyKey) { return Number(getRowCurrencyMeta(currencyKey).fxToUsd); }

    function getFxToUsd(currencyKey) {
      if (hasOwn(liveFxToUsd, currencyKey)) return Number(liveFxToUsd[currencyKey]);
      return fallbackFxToUsd(currencyKey);
    }

    function getFxToReporting(currencyKey) {
      return getFxToUsd(currencyKey) / getFxToUsd(reportingCurrencySelect.value);
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
      [applyRowCountBtn, addRowBtn, removeRowBtn, rebalanceBtn, sampleBtn,
       rowCountInput, reportingCurrencySelect, modeSelect, budgetInput,
       fetchLiveDataInput, showAccountTypeInput].forEach(function (el) { el.disabled = running; });
      Array.prototype.forEach.call(inputRowsNode.querySelectorAll("input, select"), function (node) {
        node.disabled = running;
      });
    }

    function clearLiveSnapshot() { liveFxToUsd = {}; liveFxKeys = {}; }

    function clearTickerValidationState() {
      Object.keys(tickerValidateTimeouts).forEach(function (key) { clearTimeout(tickerValidateTimeouts[key]); });
      tickerValidateTimeouts = {};
      tickerValidateTokens = {};
      tickerValidationFeedback = {};
    }

    function formatFx(num, isLive) { var s = Number.isFinite(num) ? num : 0; return (isLive ? "~" : "") + s.toFixed(4); }
    function formatInputPrice(num) {
      var s = Number(num); if (!Number.isFinite(s)) return "";
      return s.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    }
    function formatCurrencyByKey(num, currencyKey) {
      var meta = getRowCurrencyMeta(currencyKey);
      return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(num);
    }
    function formatCurrency(num) {
      var meta = getReportingCurrencyMeta();
      return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(num);
    }
    function formatPct(num) { return Number(num).toFixed(2) + "%"; }
    function formatShares(num) { return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(num); }

    function escapeHtml(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function currencyOptionsHtml(selectedKey) {
      return Object.keys(currencyOptions).map(function (key) {
        return "<option value='" + key + "'" + (key === selectedKey ? " selected" : "") + ">" + currencyOptions[key].label + "</option>";
      }).join("");
    }

    function accountTypeOptionsHtml(selected) {
      return ACCOUNT_TYPES.map(function (at) {
        var label = at || "—";
        return "<option value='" + escapeHtml(at) + "'" + (at === selected ? " selected" : "") + ">" + escapeHtml(label) + "</option>";
      }).join("");
    }

    function isAccountTypeVisible() { return showAccountTypeInput.checked; }

    function rowHtml(index, data) {
      var rowData = data || {};
      var shares = Number.isFinite(Number(rowData.shares)) ? Number(rowData.shares) : "";
      var price = Number.isFinite(Number(rowData.price)) ? Number(rowData.price) : "";
      var targetWeight = Number.isFinite(Number(rowData.targetWeight)) ? Number(rowData.targetWeight) : "";
      var ticker = rowData.ticker ? String(rowData.ticker).toUpperCase() : "";
      var currencyKey = rowData.currencyKey && currencyOptions[rowData.currencyKey] ? rowData.currencyKey : "USD";
      var accountType = rowData.accountType || "";
      var localValue = Number(shares) * Number(price);
      var fxToReporting = getFxToReporting(currencyKey);
      var reportingValue = localValue * fxToReporting;
      var currentValueText = Number.isFinite(reportingValue) && reportingValue >= 0 ? formatCurrency(reportingValue) : formatCurrency(0);
      var atDisplay = isAccountTypeVisible() ? "" : "display:none;";

      return "<tr data-row-idx='" + index + "'>" +
        "<td class='row-index'>" + (index + 1) + "</td>" +
        "<td><input class='sheet-input ticker-input' type='text' maxlength='18' placeholder='e.g. AAPL' value='" + escapeHtml(ticker) + "' />" +
        "<div class='ticker-hint muted' style='margin-top:4px; color:#8f5f12; font-size:0.85em;'></div></td>" +
        "<td><input class='sheet-input shares-input' type='number' min='0' step='0.0001' value='" + shares + "' /></td>" +
        "<td><input class='sheet-input price-input' type='number' step='0.0001' value='" + price + "' /></td>" +
        "<td><select class='sheet-input sheet-select row-currency-select'>" + currencyOptionsHtml(currencyKey) + "</select></td>" +
        "<td class='fx-rate-cell'>" + formatFx(fxToReporting, false) + "</td>" +
        "<td class='current-value-cell'>" + currentValueText + "</td>" +
        "<td><input class='sheet-input target-weight-input' type='number' min='0' step='0.01' value='" + targetWeight + "' /></td>" +
        "<td class='account-type-col' style='" + atDisplay + "'><select class='sheet-input sheet-select account-type-select'>" + accountTypeOptionsHtml(accountType) + "</select></td>" +
        "</tr>";
    }

    function appendUnique(items, value) { if (items.indexOf(value) === -1) items.push(value); }

    function buildTickerCandidates(ticker, currencyKey) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) return [];
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        var preferredSuffix = prefixToSuffix[prefix];
        if (clean.indexOf(prefix) === 0) {
          var stripped = clean.slice(prefix.length).trim();
          if (!stripped) return [];
          var inferredKeyFromPrefix = suffixToCurrencyKey[preferredSuffix] || currencyKey;
          var suffixesForPrefix = exchangeSuffixHints[inferredKeyFromPrefix] || [""];
          var ordered = [preferredSuffix].concat(suffixesForPrefix.filter(function (s) { return s !== preferredSuffix; }));
          var prefixedCandidates = [];
          ordered.forEach(function (suffix) { appendUnique(prefixedCandidates, suffix ? (stripped + suffix) : stripped); });
          return prefixedCandidates;
        }
      }
      if (clean.indexOf("=") >= 0) return [clean];
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
      if (!cleaned) return "";
      var expectedKey = hasOwn(currencyOptions, currencyKey) ? currencyKey : "USD";
      var expectedCode = currencyOptions[expectedKey].code;
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        var prefix = prefixKeys[i];
        var suffix = prefixToSuffix[prefix];
        if (cleaned.indexOf(prefix) === 0) {
          var base = cleaned.slice(prefix.length).trim();
          if (!base) return "";
          var suggestion = base + suffix;
          var mappedKey = suffixToCurrencyKey[suffix] || expectedKey;
          var mappedCode = currencyOptions[mappedKey].code;
          if (mappedKey !== expectedKey) {
            return "'" + prefix + "' prefix not supported by Yahoo Finance. Try '" + suggestion + "' (" + mappedCode + ") or switch row currency.";
          }
          return "'" + prefix + "' prefix not supported. Try '" + suggestion + "'.";
        }
      }
      if (cleaned.indexOf(".") >= 0) {
        var dotSuffix = "." + cleaned.split(".").pop();
        var suffixMappedKey = suffixToCurrencyKey[dotSuffix];
        if (suffixMappedKey && suffixMappedKey !== expectedKey) {
          return "'" + dotSuffix + "' implies " + currencyOptions[suffixMappedKey].code + " but row is " + expectedCode + " - check row currency.";
        }
        return "";
      }
      var candidates = buildTickerCandidates(cleaned, expectedKey);
      for (var c = 0; c < candidates.length; c += 1) {
        if (candidates[c] !== cleaned) {
          if (expectedKey === "CHY_CNH") return "For CNY live quotes, use .SS/.SZ/.HK only for securities listed on Shanghai/Shenzhen/HK exchanges. Verify the exact symbol at finance.yahoo.com.";
          return "For " + expectedCode + " live quotes, try '" + candidates[c] + "'. Verify the exact symbol at finance.yahoo.com.";
        }
      }
      return "";
    }

    function extractBareTicker(tickerSymbol) {
      var base = String(tickerSymbol || "").trim().toUpperCase();
      if (!base) return "";
      var prefixKeys = Object.keys(prefixToSuffix);
      for (var i = 0; i < prefixKeys.length; i += 1) {
        if (base.indexOf(prefixKeys[i]) === 0) { base = base.slice(prefixKeys[i].length).trim(); break; }
      }
      if (base.indexOf(".") >= 0) { var stem = base.slice(0, base.lastIndexOf(".")); if (stem) return stem; }
      return base;
    }

    function buildCrossMarketCandidates(tickerSymbol, attemptedCandidates) {
      var bareTicker = extractBareTicker(tickerSymbol);
      if (!bareTicker) return [];
      var attemptedSet = {};
      (attemptedCandidates || []).forEach(function (c) { attemptedSet[String(c).trim().toUpperCase()] = true; });
      var crossCandidates = [];
      crossMarketSuffixes.forEach(function (suffix) {
        var candidate = suffix ? (bareTicker + suffix) : bareTicker;
        if (!attemptedSet[candidate] && crossCandidates.indexOf(candidate) === -1) crossCandidates.push(candidate);
      });
      return crossCandidates;
    }

    async function findCrossMarketQuote(tickerSymbol, attemptedCandidates) {
      var crossCandidates = buildCrossMarketCandidates(tickerSymbol, attemptedCandidates);
      for (var i = 0; i < crossCandidates.length; i += 1) {
        var quote = await fetchLiveQuoteDetails(crossCandidates[i]);
        if (quote) return quote;
      }
      return null;
    }

    function getRowIndex(rowNode) { return rowNode ? Number(rowNode.getAttribute("data-row-idx")) : -1; }
    function getRowNodeByIndex(rowIndex) { return inputRowsNode.querySelector("tr[data-row-idx='" + rowIndex + "']"); }

    function setRows(count, seedData) {
      var rowCount = clampRowCount(count);
      rowCountInput.value = String(rowCount);
      clearTickerValidationState();
      var rowsHtml = [];
      for (var i = 0; i < rowCount; i += 1) rowsHtml.push(rowHtml(i, seedData && seedData[i] ? seedData[i] : null));
      inputRowsNode.innerHTML = rowsHtml.join("");
      updateLiveTotals();
      var rows = inputRowsNode.querySelectorAll("tr");
      rows.forEach(function (row, idx) {
        var tickerInput = row.querySelector(".ticker-input");
        if (tickerInput && tickerInput.value.trim()) scheduleTickerValidation(idx);
      });
    }

    function safePositiveNumber(rawValue) {
      var value = Number(rawValue);
      return (!Number.isFinite(value) || value <= 0) ? null : value;
    }

    function readNumberInput(inputNode) {
      if (!inputNode) return NaN;
      var value = Number(inputNode.value);
      return Number.isFinite(value) ? value : NaN;
    }

    function updateTickerHintForRow(row, rowIdx) {
      var hintNode = row.querySelector(".ticker-hint");
      if (!hintNode) return;
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
        var localValue = Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price > 0 ? shares * price : 0;
        var reportingValue = localValue * fxToReporting;
        row.querySelector(".fx-rate-cell").textContent = formatFx(fxToReporting, fxIsLive);
        row.querySelector(".current-value-cell").textContent = formatCurrency(reportingValue);
        updateTickerHintForRow(row, getRowIndex(row));
        currentTotal += reportingValue;
        if (Number.isFinite(targetWeight) && targetWeight >= 0) weightTotal += targetWeight;
      });
      document.getElementById("liveCurrentTotal").textContent = "Current total: " + formatCurrency(currentTotal);
      document.getElementById("liveWeightTotal").textContent = "Target weight total: " + formatPct(weightTotal);
    }

    function parsePositionsFromTable(requirePrice) {
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      if (!rows.length) throw new Error("Add at least one security row.");
      var positions = rows.map(function (row, idx) {
        var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var parsedPrice = readNumberInput(row.querySelector(".price-input"));
        var manualPrice = Number.isFinite(parsedPrice) ? parsedPrice : null;
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;
        var accountTypeSelect = row.querySelector(".account-type-select");
        var accountType = accountTypeSelect ? accountTypeSelect.value : "";
        if (!ticker) throw new Error("Row " + (idx + 1) + ": ticker is required.");
        if (!Number.isFinite(shares) || shares < 0) throw new Error("Row " + (idx + 1) + ": shares/units must be a non-negative number.");
        if (requirePrice && (manualPrice === null || manualPrice <= 0)) throw new Error("Row " + (idx + 1) + ": price must be greater than 0.");
        if (!requirePrice && manualPrice !== null && manualPrice <= 0) throw new Error("Row " + (idx + 1) + ": manual price must be greater than 0 when provided.");
        if (!Number.isFinite(targetWeight) || targetWeight < 0) throw new Error("Row " + (idx + 1) + ": target weight must be 0 or greater.");
        if (!hasOwn(currencyOptions, currencyKey)) throw new Error("Row " + (idx + 1) + ": row currency is invalid.");
        return {
          rowIndex: idx, ticker: ticker, shares: shares, price: manualPrice,
          currencyKey: currencyKey, currencyLabel: getRowCurrencyMeta(currencyKey).label,
          targetWeight: targetWeight, accountType: accountType
        };
      });
      if (!positions.some(function (p) { return p.targetWeight > 0; })) throw new Error("At least one target weight must be greater than 0.");
      return positions;
    }

    function normalizeQuoteCurrency(rawCurrency) {
      if (typeof rawCurrency !== "string" || !rawCurrency.trim()) return { quoteCurrency: null, unitScale: 1.0 };
      var cleaned = rawCurrency.trim();
      if (cleaned === "GBp" || cleaned === "GBX") return { quoteCurrency: "GBP", unitScale: 0.01 };
      var upper = cleaned.toUpperCase();
      if (upper === "CNH") return { quoteCurrency: "CNY", unitScale: 1.0 };
      return { quoteCurrency: upper, unitScale: 1.0 };
    }

    function extractChartLastPrice(chartResult) {
      var meta = chartResult && chartResult.meta ? chartResult.meta : {};
      var fromMeta = ["regularMarketPrice", "previousClose", "chartPreviousClose"];
      for (var i = 0; i < fromMeta.length; i += 1) {
        var value = safePositiveNumber(meta[fromMeta[i]]);
        if (value !== null) return value;
      }
      var closes = (((chartResult || {}).indicators || {}).quote || [])[0];
      if (closes && Array.isArray(closes.close)) {
        for (var idx = closes.close.length - 1; idx >= 0; idx -= 1) {
          var closeValue = safePositiveNumber(closes.close[idx]);
          if (closeValue !== null) return closeValue;
        }
      }
      return null;
    }

    function extractChartQuoteCurrency(chartResult) {
      var meta = chartResult && chartResult.meta ? chartResult.meta : {};
      if (typeof meta.currency === "string" && meta.currency.trim()) return meta.currency.trim();
      return null;
    }

    var _workingProxyIdx = -1; // -1 = not yet determined, 0+ = index into CORS_PROXIES
    var _yahooCrumb = null;

    async function _fetchWithTimeout(url, opts, ms) {
      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, ms || 12000);
      try {
        var merged = Object.assign({}, opts || {}, { signal: controller.signal });
        var res = await fetch(url, merged);
        clearTimeout(tid);
        return res;
      } catch (e) {
        clearTimeout(tid);
        throw e;
      }
    }

    async function _proxyFetch(url, proxyIdx) {
      var proxied = CORS_PROXIES[proxyIdx](url);
      return _fetchWithTimeout(proxied, { headers: { Accept: "application/json" } }, 12000);
    }

    async function _findWorkingProxy() {
      if (_workingProxyIdx >= 0) return _workingProxyIdx;
      var testUrl = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d";
      for (var i = 0; i < CORS_PROXIES.length; i++) {
        try {
          var res = await _proxyFetch(testUrl, i);
          if (res.ok) {
            var text = await res.text();
            if (text && text.indexOf('"chart"') > -1) {
              _workingProxyIdx = i;
              return i;
            }
          }
        } catch (e) { /* try next */ }
      }
      return -1;
    }

    async function _ensureCrumb(proxyIdx) {
      if (_yahooCrumb) return _yahooCrumb;
      try {
        var crumbUrl = "https://query1.finance.yahoo.com/v1/test/getcrumb";
        var res = await _proxyFetch(crumbUrl, proxyIdx);
        if (res.ok) {
          var crumb = await res.text();
          if (crumb && crumb.length < 40 && crumb.indexOf("<") === -1) {
            _yahooCrumb = crumb.trim();
            return _yahooCrumb;
          }
        }
      } catch (e) { /* crumb not available, proceed without */ }
      return null;
    }

    async function fetchYahooChartPayload(tickerSymbol) {
      var encoded = encodeURIComponent(tickerSymbol);
      var proxyIdx = await _findWorkingProxy();
      if (proxyIdx < 0) return null;

      var crumb = await _ensureCrumb(proxyIdx);
      var crumbParam = crumb ? "&crumb=" + encodeURIComponent(crumb) : "";

      for (var baseIdx = 0; baseIdx < yahooBaseUrls.length; baseIdx++) {
        var url = yahooBaseUrls[baseIdx] + "/v8/finance/chart/" + encoded +
          "?interval=1d&range=5d&includePrePost=false" + crumbParam;
        try {
          var res = await _proxyFetch(url, proxyIdx);
          if (!res.ok) continue;
          var text = await res.text();
          if (!text || text.charAt(0) !== "{") continue;
          var data = JSON.parse(text);
          var result = data && data.chart && Array.isArray(data.chart.result) ? data.chart.result[0] : null;
          if (result) return data;
          if (data && data.chart && data.chart.error) {
            var errDesc = (data.chart.error.description || "").toLowerCase();
            if (errDesc.indexOf("no data found") > -1 || errDesc.indexOf("not found") > -1) return null;
          }
        } catch (e) { continue; }
      }
      return null;
    }

    async function fetchLiveQuoteDetails(tickerSymbol) {
      if (!tickerSymbol) return null;
      try {
        var payload = await fetchYahooChartPayload(tickerSymbol);
        if (!payload) return null;
        var chart = payload.chart || null;
        if (!chart || chart.error || !Array.isArray(chart.result) || !chart.result.length) return null;
        var chartResult = chart.result[0];
        var rawPrice = extractChartLastPrice(chartResult);
        if (rawPrice === null) return null;
        var rawQuoteCurrency = extractChartQuoteCurrency(chartResult);
        var normalized = normalizeQuoteCurrency(rawQuoteCurrency);
        return { resolvedTicker: tickerSymbol, rawPrice: rawPrice, price: rawPrice * normalized.unitScale,
          rawQuoteCurrency: rawQuoteCurrency, quoteCurrency: normalized.quoteCurrency, unitScale: normalized.unitScale };
      } catch (err) { return null; }
    }

    async function fetchLiveFxToUsd(currencyCode) {
      if (currencyCode === "USD") return 1.0;
      var quote = await fetchLiveQuoteDetails(currencyCode + "USD=X");
      return quote ? safePositiveNumber(quote.price) : null;
    }

    function scheduleTickerValidation(rowIdx) {
      if (hasOwn(tickerValidateTimeouts, rowIdx)) clearTimeout(tickerValidateTimeouts[rowIdx]);
      var nextToken = (tickerValidateTokens[rowIdx] || 0) + 1;
      tickerValidateTokens[rowIdx] = nextToken;
      tickerValidateTimeouts[rowIdx] = setTimeout(function () { validateTickerBackground(rowIdx, nextToken); }, 800);
    }

    function applyTickerValidationFeedback(rowIdx, token, expectedTicker, message, color) {
      if (tickerValidateTokens[rowIdx] !== token) return;
      var row = getRowNodeByIndex(rowIdx);
      if (!row) return;
      var liveTicker = row.querySelector(".ticker-input").value.trim().toUpperCase();
      if (liveTicker !== expectedTicker) return;
      tickerValidationFeedback[rowIdx] = { ticker: liveTicker, text: message, color: color };
      updateLiveTotals();
    }

    async function validateTickerBackground(rowIdx, token) {
      delete tickerValidateTimeouts[rowIdx];
      if (tickerValidateTokens[rowIdx] !== token) return;
      var row = getRowNodeByIndex(rowIdx);
      if (!row) return;
      var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
      var currencyKey = row.querySelector(".row-currency-select").value;
      if (!ticker) { delete tickerValidationFeedback[rowIdx]; updateLiveTotals(); return; }

      // Show the static hint immediately while we check
      var staticHint = buildTickerInputHint(ticker, currencyKey);
      if (staticHint) {
        tickerValidationFeedback[rowIdx] = { ticker: ticker, text: staticHint, color: STATUS_WARN };
        updateLiveTotals();
      }

      // Check if proxy is reachable before attempting full validation
      var proxyIdx = await _findWorkingProxy();
      if (proxyIdx < 0) {
        // No proxy available — just show the static hint, no "Not found" error
        if (!staticHint) {
          delete tickerValidationFeedback[rowIdx];
          updateLiveTotals();
        }
        return;
      }

      tickerValidationFeedback[rowIdx] = { ticker: ticker, text: "Checking " + ticker + "...", color: "#3f5066" };
      updateLiveTotals();

      try {
        var candidates = buildTickerCandidates(ticker, currencyKey);
        var selectedCode = (currencyOptions[currencyKey] || currencyOptions.USD).code;
        var firstCurrencyMismatch = null;
        for (var i = 0; i < candidates.length; i += 1) {
          var quote = await fetchLiveQuoteDetails(candidates[i]);
          if (quote) {
            if (quote.quoteCurrency && quote.quoteCurrency !== selectedCode) {
              if (!firstCurrencyMismatch) firstCurrencyMismatch = quote;
              continue;
            }
            applyTickerValidationFeedback(rowIdx, token, ticker, "Verified: " + quote.resolvedTicker + " (" + (quote.quoteCurrency || "?") + ")", STATUS_SUCCESS);
            return;
          }
        }
        var crossMarket = await findCrossMarketQuote(ticker, candidates);
        if (crossMarket) {
          applyTickerValidationFeedback(rowIdx, token, ticker,
            ticker + " not found in " + selectedCode + ". Found as " + crossMarket.resolvedTicker + " (" + (crossMarket.quoteCurrency || "?") + "). Update row currency or ticker symbol.", STATUS_WARN);
          return;
        }
        if (firstCurrencyMismatch) {
          applyTickerValidationFeedback(rowIdx, token, ticker,
            "Found " + firstCurrencyMismatch.resolvedTicker + " but quotes in " + (firstCurrencyMismatch.quoteCurrency || "?") + ", not " + selectedCode + ". Check row currency.", STATUS_WARN);
          return;
        }
        var fallbackHint = buildTickerInputHint(ticker, currencyKey);
        var failMsg = "Not found on Yahoo Finance. Verify the symbol at finance.yahoo.com.";
        if (fallbackHint) failMsg += " " + fallbackHint;
        applyTickerValidationFeedback(rowIdx, token, ticker, failMsg, STATUS_ERROR);
      } catch (_err) {
        // On error, fall back to static hint rather than showing scary error
        if (staticHint) {
          applyTickerValidationFeedback(rowIdx, token, ticker, staticHint, STATUS_WARN);
        } else {
          delete tickerValidationFeedback[rowIdx];
          updateLiveTotals();
        }
      }
    }

    function getFxToUsdFromMap(fxToUsdMap, currencyKey) {
      return hasOwn(fxToUsdMap, currencyKey) ? Number(fxToUsdMap[currencyKey]) : fallbackFxToUsd(currencyKey);
    }

    function attachFxValues(positions, fxToUsdMap) {
      var reportingKey = reportingCurrencySelect.value;
      var reportToUsd = getFxToUsdFromMap(fxToUsdMap, reportingKey);
      return positions.map(function (position) {
        var rowToUsd = getFxToUsdFromMap(fxToUsdMap, position.currencyKey);
        var fxToReporting = rowToUsd / reportToUsd;
        if (position.price === null || position.price <= 0) throw new Error(position.ticker + ": price must be greater than 0.");
        var currentValueLocal = position.shares * position.price;
        return {
          rowIndex: position.rowIndex, ticker: position.ticker, shares: position.shares,
          price: position.price, currencyKey: position.currencyKey,
          currencyLabel: getRowCurrencyMeta(position.currencyKey).label,
          targetWeight: position.targetWeight, accountType: position.accountType || "",
          fxToReporting: fxToReporting, currentValueLocal: currentValueLocal,
          currentValue: currentValueLocal * fxToReporting
        };
      });
    }

    function calculateRebalancePlan(enrichedPositions, mode, budget) {
      var totalCurrent = enrichedPositions.reduce(function (sum, p) { return sum + p.currentValue; }, 0);
      var totalWeight = enrichedPositions.reduce(function (sum, p) { return sum + p.targetWeight; }, 0);
      var pool;
      if (mode === "new_money") {
        if (budget <= 0) throw new Error("New money budget must be greater than 0.");
        pool = totalCurrent + budget;
      } else {
        pool = totalCurrent;
      }
      if (pool <= 0) throw new Error("Portfolio value must be greater than 0.");
      if (totalWeight <= 0) throw new Error("At least one target weight must be greater than 0.");
      var relativeThreshold = pool * HOLD_THRESHOLD_PCT;
      var warnings = [];

      var results = enrichedPositions.map(function (p) {
        var targetWeightNorm = p.targetWeight / totalWeight;
        var targetValue = targetWeightNorm * pool;
        var tradeValue = targetValue - p.currentValue;
        var tradeValueLocal = tradeValue / p.fxToReporting;
        var tradeShares = tradeValueLocal / p.price;
        var action = "Hold";

        if (mode === "new_money" && tradeValue <= 0) {
          return {
            ticker: p.ticker, currencyKey: p.currencyKey, currencyLabel: p.currencyLabel,
            shares: p.shares, price: p.price, currentValue: p.currentValue,
            targetWeightNorm: targetWeightNorm, targetValue: targetValue,
            tradeValue: 0, tradeValueLocal: 0, tradeShares: 0,
            action: "Hold", postTradeShares: p.shares, accountType: p.accountType
          };
        }

        if (tradeValue > relativeThreshold) { action = "Buy"; }
        else if (tradeValue < -relativeThreshold) { action = "Sell"; }

        if (Math.abs(tradeValue) <= relativeThreshold) {
          tradeValue = 0; tradeValueLocal = 0; tradeShares = 0;
        }

        return {
          ticker: p.ticker, currencyKey: p.currencyKey, currencyLabel: p.currencyLabel,
          shares: p.shares, price: p.price, currentValue: p.currentValue,
          targetWeightNorm: targetWeightNorm, targetValue: targetValue,
          tradeValue: tradeValue, tradeValueLocal: tradeValueLocal, tradeShares: tradeShares,
          action: action, postTradeShares: p.shares + tradeShares, accountType: p.accountType
        };
      });

      var totalBuys = results.reduce(function (s, r) { return s + (r.action === "Buy" ? r.tradeValue : 0); }, 0);
      var totalSells = results.reduce(function (s, r) { return s + (r.action === "Sell" ? Math.abs(r.tradeValue) : 0); }, 0);

      if (mode === "new_money" && totalBuys > budget + 0.01 && totalBuys > 0) {
        var scale = budget / totalBuys;
        results.forEach(function (r) {
          if (r.action === "Buy") {
            r.tradeValue *= scale;
            r.tradeValueLocal = r.tradeValue / (r.currentValue > 0 ? r.currentValue / (r.shares * r.price) : getFxToReporting(r.currencyKey));
            r.tradeValueLocal = r.tradeValue / getFxToReporting(r.currencyKey);
            r.tradeShares = r.tradeValueLocal / r.price;
            r.postTradeShares = r.shares + r.tradeShares;
          }
        });
        var scaledBuys = results.reduce(function (s, r) { return s + (r.action === "Buy" ? r.tradeValue : 0); }, 0);
        warnings.push("Buy recommendations scaled down by " + ((1 - scale) * 100).toFixed(1) +
          "% to stay within the new-money budget of " + formatCurrency(budget) +
          " (raw need was " + formatCurrency(totalBuys) + "; scaled to " + formatCurrency(scaledBuys) + ").");
        totalBuys = scaledBuys;
      }

      if (mode === "rebalance" && totalBuys > totalSells + 0.01 && totalBuys > 0) {
        var sellScale = totalSells / totalBuys;
        results.forEach(function (r) {
          if (r.action === "Buy") {
            r.tradeValue *= sellScale;
            r.tradeValueLocal = r.tradeValue / getFxToReporting(r.currencyKey);
            r.tradeShares = r.tradeValueLocal / r.price;
            r.postTradeShares = r.shares + r.tradeShares;
          }
        });
        var adjustedBuys = results.reduce(function (s, r) { return s + (r.action === "Buy" ? r.tradeValue : 0); }, 0);
        warnings.push("Buy recommendations scaled down by " + ((1 - sellScale) * 100).toFixed(1) +
          "% to stay within sell proceeds of " + formatCurrency(totalSells) +
          " (raw need was " + formatCurrency(totalBuys) + "; scaled to " + formatCurrency(adjustedBuys) + ").");
        totalBuys = adjustedBuys;
      }

      var hasAccountTypes = results.some(function (r) { return r.accountType && r.accountType.length > 0; });
      if (hasAccountTypes) {
        if (mode === "rebalance") {
          var sellsByType = {};
          var buysByType = {};
          results.forEach(function (r) {
            var at = r.accountType || "Unspecified";
            if (r.action === "Sell") sellsByType[at] = (sellsByType[at] || 0) + Math.abs(r.tradeValue);
            if (r.action === "Buy") buysByType[at] = (buysByType[at] || 0) + r.tradeValue;
          });
          Object.keys(buysByType).forEach(function (at) {
            var buyAmt = buysByType[at];
            var sellAmt = sellsByType[at] || 0;
            if (buyAmt > sellAmt + 0.01) {
              warnings.push(at + ": recommended buys total " + formatCurrency(buyAmt) +
                " but same-account sells only total " + formatCurrency(sellAmt) +
                ". The gap of " + formatCurrency(buyAmt - sellAmt) +
                " must come from existing cash or new contributions — proceeds from other account types cannot be transferred without triggering a withdrawal/contribution event.");
            }
          });
        }
        var tickerAccounts = {};
        results.forEach(function (r) {
          if (r.action !== "Hold" && r.accountType) {
            if (!tickerAccounts[r.ticker]) tickerAccounts[r.ticker] = {};
            tickerAccounts[r.ticker][r.accountType] = true;
          }
        });
        Object.keys(tickerAccounts).forEach(function (ticker) {
          var accts = Object.keys(tickerAccounts[ticker]);
          if (accts.length > 1) {
            warnings.push(ticker + " appears in multiple account types (" + accts.join(", ") +
              ") — sells from one account can’t fund buys in another.");
          }
        });
      }

      return {
        summary: {
          totalCurrent: totalCurrent, pool: pool, totalBuys: totalBuys, totalSells: totalSells,
          mode: mode, budget: mode === "new_money" ? budget : 0
        },
        results: results,
        warnings: warnings
      };
    }

    function buildResultTable(rows, showAccountType) {
      var atHeader = showAccountType ? "<th>Account Type</th>" : "";
      var tableHead = "<table class='sheet-table output-sheet'><thead><tr>" +
        "<th>Ticker</th>" + atHeader + "<th>Row Currency</th><th>Shares</th><th>Price (local)</th>" +
        "<th>Current Value</th><th>Target Weight</th><th>Target Value</th>" +
        "<th>Trade Value</th><th>Trade Value (local)</th><th>Trade Shares</th>" +
        "<th>Action</th><th>Post-Trade Shares</th></tr></thead><tbody>";
      var tableBody = rows.map(function (r) {
        var actionClass = r.action.toLowerCase();
        var atCell = showAccountType ? "<td>" + escapeHtml(r.accountType || "—") + "</td>" : "";
        return "<tr>" +
          "<td>" + escapeHtml(r.ticker) + "</td>" + atCell +
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
          "<td>" + formatShares(r.postTradeShares) + "</td></tr>";
      }).join("");
      return tableHead + tableBody + "</tbody></table>";
    }

    function summaryHtml(data) {
      var modeLabel = data.mode === "new_money" ? "New Money" : "Rebalance (Pure)";
      var budgetLine = data.mode === "new_money"
        ? "<div class='summary-item'><span>New Money Budget</span><strong>" + formatCurrency(data.budget) + "</strong></div>" : "";
      return "<div class='summary-grid'>" +
        "<div class='summary-item'><span>Mode</span><strong>" + modeLabel + "</strong></div>" +
        "<div class='summary-item'><span>Total Current</span><strong>" + formatCurrency(data.totalCurrent) + "</strong></div>" +
        budgetLine +
        "<div class='summary-item'><span>Target Pool</span><strong>" + formatCurrency(data.pool) + "</strong></div>" +
        "<div class='summary-item'><span>Total Buy Value</span><strong>" + formatCurrency(data.totalBuys) + "</strong></div>" +
        "<div class='summary-item'><span>Total Sell Value</span><strong>" + formatCurrency(data.totalSells) + "</strong></div>" +
        "</div>";
    }

    function warningsHtml(warnings) {
      if (!warnings.length) return "";
      return "<div class='muted' style='margin-top:12px;'><strong>Warnings</strong><br />" +
        warnings.map(function (w) { return "• " + escapeHtml(w); }).join("<br />") + "</div>";
    }

    function notesHtml(notes) {
      if (!notes.length) return "";
      return "<div class='muted' style='margin-top:12px;'><strong>Notes</strong><br />" +
        notes.map(function (n) { return "• " + escapeHtml(n); }).join("<br />") + "</div>";
    }

    function updateCurrencyUi() {
      var meta = getReportingCurrencyMeta();
      document.getElementById("reportingCurrencyLabel").textContent = meta.label;
      document.getElementById("currentValueCurrencyLabel").textContent = meta.label;
      budgetField.querySelector("label").textContent = "New money budget (" + meta.label + ")";
    }

    function updateModeUi() {
      var mode = modeSelect.value;
      budgetField.style.display = mode === "new_money" ? "" : "none";
    }

    function updateAccountTypeVisibility() {
      var show = isAccountTypeVisible();
      var displayValue = show ? "" : "none";
      document.querySelectorAll(".account-type-col").forEach(function (el) { el.style.display = displayValue; });
    }

    function getCurrentRowData() {
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      return rows.map(function (row) {
        var accountTypeSelect = row.querySelector(".account-type-select");
        return {
          ticker: row.querySelector(".ticker-input").value.trim().toUpperCase(),
          shares: row.querySelector(".shares-input").value,
          price: row.querySelector(".price-input").value,
          currencyKey: row.querySelector(".row-currency-select").value,
          targetWeight: row.querySelector(".target-weight-input").value,
          accountType: accountTypeSelect ? accountTypeSelect.value : ""
        };
      });
    }

    function syncInputsFromPositions(positions) {
      positions.forEach(function (position) {
        var row = getRowNodeByIndex(position.rowIndex);
        if (!row) return;
        row.querySelector(".row-currency-select").value = position.currencyKey;
        row.querySelector(".price-input").value = formatInputPrice(position.price);
      });
    }

    function buildTickerCurrencyWarnings(positions) {
      var warnings = [];
      positions.forEach(function (position, idx) {
        var hint = buildTickerInputHint(position.ticker, position.currencyKey);
        if (hint) warnings.push("Row " + (idx + 1) + " (" + position.ticker + "): " + hint);
      });
      return warnings;
    }

    function recalculateFromInputs(showError) {
      validationNode.textContent = "";
      try {
        var positions = parsePositionsFromTable(true);
        var mode = modeSelect.value;
        var budget = Number(budgetInput.value || "0");
        var fxToUsdMap = {};
        Object.keys(currencyOptions).forEach(function (key) { fxToUsdMap[key] = getFxToUsd(key); });
        var enriched = attachFxValues(positions, fxToUsdMap);
        var plan = calculateRebalancePlan(enriched, mode, budget);
        var showAccountType = isAccountTypeVisible();
        resultsNode.innerHTML = summaryHtml(plan.summary) + buildResultTable(plan.results, showAccountType) + warningsHtml(plan.warnings);
        hasCalculated = true;
      } catch (err) {
        resultsNode.textContent = "Output will appear here after you run rebalancing.";
        validationNode.textContent = err.message || String(err);
        hasCalculated = false;
        if (showError) setRunStatus("Validation failed. Review your inputs.", STATUS_ERROR);
      }
    }

    async function runRebalance() {
      if (isRunning) return;
      validationNode.textContent = "";
      var useLiveFetch = !!fetchLiveDataInput.checked;
      var mode = modeSelect.value;
      var budget = Number(budgetInput.value || "0");
      setRunningState(true);
      setRunStatus(useLiveFetch ? "Fetching live prices and FX rates..." : "Running rebalance...", STATUS_NEUTRAL);

      try {
        var positions = parsePositionsFromTable(!useLiveFetch);
        if (mode === "new_money" && budget <= 0) throw new Error("New money budget must be greater than 0.");

        var warnings = [];
        var notes = [];
        var fxToUsdMap = {};
        Object.keys(currencyOptions).forEach(function (key) { fxToUsdMap[key] = fallbackFxToUsd(key); });

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
              var quoteDetails = await fetchLiveQuoteDetails(attemptedCandidates[j]);
              if (!quoteDetails) continue;
              if (quoteDetails.quoteCurrency === selectedCurrencyCode) { bestMatchingQuote = quoteDetails; break; }
              if (!firstFallbackQuote) firstFallbackQuote = quoteDetails;
            }

            var chosenQuote = bestMatchingQuote || firstFallbackQuote;
            if (!chosenQuote) {
              var crossMarketQuote = await findCrossMarketQuote(ticker, attemptedCandidates);
              chosenQuote = crossMarketQuote;
            }
            if (!chosenQuote) {
              var attemptedStr = attemptedCandidates.length ? attemptedCandidates.join(", ") : ticker;
              if (manualPrice === null) {
                throw new Error("Live price unavailable for " + ticker + " (tried: " + attemptedStr + "). " +
                  "Could not find a " + selectedCurrencyCode + "-quoted price on Yahoo Finance. " +
                  "Verify the exact symbol at finance.yahoo.com, or confirm the row currency. Enter a manual price to continue.");
              }
              warnings.push("Live price unavailable for " + ticker + " (tried: " + attemptedStr + "). Using manual entry " + manualPrice.toFixed(4) + " for this run.");
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
                warnings.push(ticker + ": not found in selected " + selectedCurrencyCode + " market; using " +
                  resolvedTicker + " (" + chosenQuoteCode + ") and adjusted row currency to " + chosenQuoteCode + " for this run.");
                if (resolvedTicker !== ticker) warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
                continue;
              }
              if (manualPrice !== null) {
                warnings.push(ticker + ": not available in selected " + selectedCurrencyCode + " market; found " +
                  resolvedTicker + " (" + chosenQuoteCode + "). Keeping manual entry " + manualPrice.toFixed(4) + ". Verify row currency or ticker.");
                continue;
              }
              throw new Error(ticker + ": live quote returned unsupported quote currency " + chosenQuoteCode +
                " for selected " + selectedCurrencyCode + "; enter a manual price.");
            }

            position.price = chosenPrice;
            if (resolvedTicker !== ticker) warnings.push(ticker + ": used exchange symbol " + resolvedTicker + " for live quote.");
            if (chosenQuote.unitScale !== 1.0) {
              notes.push(ticker + ": Yahoo Finance quotes in sub-units (" + chosenQuote.rawQuoteCurrency +
                "); automatically converted to " + chosenQuoteCode + " (÷100). No action needed.");
            }
          }

          setRunStatus("Fetching live FX rates...", STATUS_NEUTRAL);
          var currenciesInScope = {};
          currenciesInScope[reportingCurrencySelect.value] = true;
          positions.forEach(function (p) { currenciesInScope[p.currencyKey] = true; });
          var currencyKeys = Object.keys(currenciesInScope).sort();
          for (var fxIdx = 0; fxIdx < currencyKeys.length; fxIdx += 1) {
            var currencyKey = currencyKeys[fxIdx];
            var currencyCode = currencyOptions[currencyKey].code;
            var liveRate = await fetchLiveFxToUsd(currencyCode);
            if (liveRate !== null) { fxToUsdMap[currencyKey] = liveRate; liveFxKeysLocal[currencyKey] = true; }
            else { warnings.push("Live FX unavailable for " + currencyKey + "; using fallback rate " + fallbackFxToUsd(currencyKey).toFixed(4) + "."); }
          }

          liveFxToUsd = fxToUsdMap;
          liveFxKeys = liveFxKeysLocal;
          syncInputsFromPositions(positions);
        } else {
          clearLiveSnapshot();
          warnings = warnings.concat(buildTickerCurrencyWarnings(positions));
        }

        var enrichedPositions = attachFxValues(positions, fxToUsdMap);
        var plan = calculateRebalancePlan(enrichedPositions, mode, budget);
        var allWarnings = plan.warnings.concat(warnings);
        var showAccountType = isAccountTypeVisible();
        resultsNode.innerHTML = summaryHtml(plan.summary) + buildResultTable(plan.results, showAccountType) +
          notesHtml(notes) + warningsHtml(allWarnings);
        hasCalculated = true;
        updateLiveTotals();

        if (allWarnings.length) {
          setRunStatus("Completed with " + allWarnings.length + " warning(s). Verify data before trading.", STATUS_WARN);
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
      var existingData = getCurrentRowData();
      var rowLimit = clampRowCount(Number(rowCountInput.value));
      var seededRows = [];
      for (var i = 0; i < rowLimit; i += 1) seededRows.push(existingData[i] || null);
      setRows(rowLimit, seededRows);
      if (hasCalculated) recalculateFromInputs(false);
    });

    addRowBtn.addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length >= 50) { validationNode.textContent = "Maximum row limit reached (50)."; return; }
      currentData.push(null);
      setRows(currentData.length, currentData);
      if (hasCalculated) recalculateFromInputs(false);
    });

    removeRowBtn.addEventListener("click", function () {
      var currentData = getCurrentRowData();
      if (currentData.length <= 1) { validationNode.textContent = "At least one row is required."; return; }
      currentData.pop();
      setRows(currentData.length, currentData);
      if (hasCalculated) recalculateFromInputs(false);
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
      if (hasCalculated && !isRunning) recalculateFromInputs(false);
    });

    reportingCurrencySelect.addEventListener("change", function () {
      validationNode.textContent = "";
      updateCurrencyUi();
      updateLiveTotals();
      if (hasCalculated && !isRunning) recalculateFromInputs(false);
    });

    modeSelect.addEventListener("change", function () {
      validationNode.textContent = "";
      updateModeUi();
      if (hasCalculated && !isRunning) recalculateFromInputs(false);
    });

    budgetInput.addEventListener("change", function () {
      validationNode.textContent = "";
      if (hasCalculated && !isRunning) recalculateFromInputs(false);
    });

    showAccountTypeInput.addEventListener("change", function () {
      updateAccountTypeVisibility();
      if (hasCalculated && !isRunning) recalculateFromInputs(false);
    });

    rebalanceBtn.addEventListener("click", function () { runRebalance(); });

    sampleBtn.addEventListener("click", function () {
      clearLiveSnapshot();
      clearTickerValidationState();
      rowCountInput.value = String(samplePortfolio.length);
      setRows(samplePortfolio.length, samplePortfolio);
      budgetInput.value = "0";
      modeSelect.value = "new_money";
      updateModeUi();
      validationNode.textContent = "";
      resultsNode.textContent = "Output will appear here after you run rebalancing.";
      hasCalculated = false;
      setRunStatus("Sample portfolio loaded.", STATUS_NEUTRAL);
    });

    updateCurrencyUi();
    updateModeUi();
    updateAccountTypeVisibility();
    setRows(samplePortfolio.length, samplePortfolio);
    setRunStatus("Ready.", STATUS_NEUTRAL);
  })();
</script>
