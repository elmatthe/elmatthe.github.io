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

    function getReportingCurrencyMeta() {
      return currencyOptions[reportingCurrencySelect.value] || currencyOptions.USD;
    }

    function getRowCurrencyMeta(currencyKey) {
      return currencyOptions[currencyKey] || currencyOptions.USD;
    }

    function getFxToReporting(currencyKey) {
      var rowMeta = getRowCurrencyMeta(currencyKey);
      var reportingMeta = getReportingCurrencyMeta();
      return rowMeta.fxToUsd / reportingMeta.fxToUsd;
    }

    function buildTickerCandidates(ticker, currencyKey) {
      var clean = String(ticker || "").trim().toUpperCase();
      if (!clean) {
        return [];
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

    function formatFx(num) {
      return num.toFixed(4);
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
        "<td><input class='sheet-input ticker-input' type='text' maxlength='12' placeholder='e.g. AAPL' value='" + escapeHtml(ticker) + "' /></td>" +
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

        var localValue = Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price > 0
          ? shares * price
          : 0;
        var reportingValue = localValue * fxToReporting;

        row.querySelector(".fx-rate-cell").textContent = formatFx(fxToReporting);
        row.querySelector(".current-value-cell").textContent = formatCurrency(reportingValue);
        currentTotal += reportingValue;
        if (Number.isFinite(targetWeight) && targetWeight >= 0) {
          weightTotal += targetWeight;
        }
      });

      document.getElementById("liveCurrentTotal").textContent = "Current total: " + formatCurrency(currentTotal);
      document.getElementById("liveWeightTotal").textContent = "Target weight total: " + formatPct(weightTotal);
    }

    function parsePositionsFromTable() {
      var rows = Array.prototype.slice.call(inputRowsNode.querySelectorAll("tr"));
      if (!rows.length) {
        throw new Error("Add at least one security row.");
      }

      var positions = rows.map(function (row, idx) {
        var ticker = row.querySelector(".ticker-input").value.trim().toUpperCase();
        var shares = readNumberInput(row.querySelector(".shares-input"));
        var price = readNumberInput(row.querySelector(".price-input"));
        var targetWeight = readNumberInput(row.querySelector(".target-weight-input"));
        var currencyKey = row.querySelector(".row-currency-select").value;
        var fxToReporting = getFxToReporting(currencyKey);

        if (!ticker) {
          throw new Error("Row " + (idx + 1) + ": ticker is required.");
        }
        if (!Number.isFinite(shares) || shares < 0) {
          throw new Error("Row " + (idx + 1) + ": shares/units must be a non-negative number.");
        }
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error("Row " + (idx + 1) + ": price must be greater than 0.");
        }
        if (!Number.isFinite(targetWeight) || targetWeight < 0) {
          throw new Error("Row " + (idx + 1) + ": target weight must be 0 or greater.");
        }

        return {
          ticker: ticker,
          shares: shares,
          price: price,
          currencyKey: currencyKey,
          currencyLabel: getRowCurrencyMeta(currencyKey).label,
          fxToReporting: fxToReporting,
          currentValueLocal: shares * price,
          currentValue: shares * price * fxToReporting,
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
        "<strong>Ticker/Currency Checks</strong><br />" +
        warnings.map(function (w) { return "• " + escapeHtml(w); }).join("<br />") +
        "</div>";
    }

    function updateCurrencyUi() {
      var meta = getReportingCurrencyMeta();
      document.getElementById("netFlowLabel").textContent = "Net contribution / withdrawal (" + meta.label + ")";
      document.getElementById("reportingCurrencyLabel").textContent = meta.label;
      document.getElementById("currentValueCurrencyLabel").textContent = meta.label;
    }

    function calculateRebalance() {
      validationNode.textContent = "";

      try {
        var positions = parsePositionsFromTable();
        var tickerWarnings = buildTickerCurrencyWarnings(positions);
        var netFlow = Number(document.getElementById("netFlowInput").value || "0");
        if (!Number.isFinite(netFlow)) {
          throw new Error("Net contribution / withdrawal must be a valid number.");
        }

        var totalCurrent = positions.reduce(function (sum, p) { return sum + p.currentValue; }, 0);
        var totalWeight = positions.reduce(function (sum, p) { return sum + p.targetWeight; }, 0);
        if (totalCurrent + netFlow <= 0) {
          throw new Error("Ending portfolio value must be greater than 0.");
        }

        var endingPortfolioValue = totalCurrent + netFlow;
        var totalBuys = 0;
        var totalSells = 0;

        var results = positions.map(function (p) {
          var targetWeightNorm = p.targetWeight / totalWeight;
          var targetValue = targetWeightNorm * endingPortfolioValue;
          var tradeValue = targetValue - p.currentValue;
          var tradeValueLocal = tradeValue / p.fxToReporting;
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

        var summaryData = {
          totalCurrent: totalCurrent,
          netFlow: netFlow,
          endingValue: endingPortfolioValue,
          totalBuys: totalBuys,
          totalSells: totalSells
        };

        resultsNode.innerHTML = summaryHtml(summaryData) + buildResultTable(results) + warningsHtml(tickerWarnings);
        hasCalculated = true;
      } catch (err) {
        resultsNode.textContent = "Output will appear here after you run rebalancing.";
        validationNode.textContent = err.message;
        hasCalculated = false;
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

    document.getElementById("rebalanceBtn").addEventListener("click", calculateRebalance);
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
