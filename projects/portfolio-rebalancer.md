---
layout: page
title: Portfolio Rebalancer Tool
permalink: /projects/portfolio-rebalancer/
summary: Interactive tool to rebalance holdings back to a target strategic allocation.
last_updated: 2026-03-13
---

# Portfolio Rebalancer Tool

Use this calculator to rebalance holdings back to strategic target weights with a spreadsheet-style input table.

<section class="callout">
  <p><strong>How it works:</strong> choose how many securities you hold, then fill in <strong>ticker</strong>, <strong>shares</strong>, <strong>price</strong>, and <strong>target weight</strong> for each row.</p>
  <p>The tool calculates each current value, target value, and the buy/sell strategy required to rebalance.</p>
  <p><a href="{{ '/projects/portfolio-rebalancer-guide/' | relative_url }}">Open Setup Guide (Web Page)</a></p>
</section>

<div class="tool-grid rebalancer-theme">
  <section class="tool-card rebalancer-input-card">
    <h3>Portfolio Inputs</h3>
    <div class="input-controls">
      <div class="field inline-field">
        <label for="rowCountInput">Number of securities</label>
        <input id="rowCountInput" type="number" min="1" max="50" step="1" value="4" />
      </div>
      <div class="field inline-field">
        <label for="currencySelect">Display currency</label>
        <select id="currencySelect" class="sheet-select">
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
            <th>Price (<span id="priceCurrencyLabel">USD</span>)</th>
            <th>Current Value (auto)</th>
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

<script>
  (function () {
    var samplePortfolio = [
      { ticker: "VTI", shares: 120, price: 250, targetWeight: 45 },
      { ticker: "VXUS", shares: 95, price: 58, targetWeight: 25 },
      { ticker: "BND", shares: 180, price: 72, targetWeight: 20 },
      { ticker: "VNQ", shares: 40, price: 84, targetWeight: 10 }
    ];

    var rowCountInput = document.getElementById("rowCountInput");
    var currencySelect = document.getElementById("currencySelect");
    var inputRowsNode = document.getElementById("inputRows");
    var validationNode = document.getElementById("validationMessage");
    var resultsNode = document.getElementById("rebalanceResults");
    var hasCalculated = false;
    var currencyOptions = {
      USD: { code: "USD", locale: "en-US", label: "USD" },
      CAD: { code: "CAD", locale: "en-CA", label: "CAD" },
      JPN: { code: "JPY", locale: "ja-JP", label: "JPN" },
      EUR: { code: "EUR", locale: "de-DE", label: "EUR" },
      GBP: { code: "GBP", locale: "en-GB", label: "GBP" },
      CHY_CNH: { code: "CNY", locale: "zh-CN", label: "CHY/CNH" }
    };

    function getCurrencyMeta() {
      return currencyOptions[currencySelect.value] || currencyOptions.USD;
    }

    function formatCurrency(num) {
      var meta = getCurrencyMeta();
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

    function rowHtml(index, data) {
      var rowData = data || {};
      var shares = Number.isFinite(Number(rowData.shares)) ? Number(rowData.shares) : "";
      var price = Number.isFinite(Number(rowData.price)) ? Number(rowData.price) : "";
      var targetWeight = Number.isFinite(Number(rowData.targetWeight)) ? Number(rowData.targetWeight) : "";
      var ticker = rowData.ticker ? String(rowData.ticker).toUpperCase() : "";
      var currentValue = Number(shares) * Number(price);
      var currentValueText = Number.isFinite(currentValue) && currentValue >= 0 ? formatCurrency(currentValue) : formatCurrency(0);

      return "<tr>" +
        "<td class='row-index'>" + (index + 1) + "</td>" +
        "<td><input class='sheet-input ticker-input' type='text' maxlength='12' placeholder='e.g. AAPL' value='" + escapeHtml(ticker) + "' /></td>" +
        "<td><input class='sheet-input shares-input' type='number' min='0' step='0.0001' value='" + shares + "' /></td>" +
        "<td><input class='sheet-input price-input' type='number' min='0.0001' step='0.0001' value='" + price + "' /></td>" +
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

        var currentValue = Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price > 0
          ? shares * price
          : 0;

        row.querySelector(".current-value-cell").textContent = formatCurrency(currentValue);
        currentTotal += currentValue;
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
          currentValue: shares * price,
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
      var priceHeader = "Price (" + getCurrencyMeta().label + ")";
      var tableHead = "<table class='sheet-table output-sheet'><thead><tr>" +
        "<th>Ticker</th><th>Shares</th><th>" + priceHeader + "</th><th>Current Value</th><th>Target Weight</th>" +
        "<th>Target Value</th><th>Trade Value</th><th>Trade Shares</th><th>Action</th><th>Post-Trade Shares</th>" +
        "</tr></thead><tbody>";

      var tableBody = rows.map(function (r) {
        var actionClass = r.action.toLowerCase();
        return "<tr>" +
          "<td>" + escapeHtml(r.ticker) + "</td>" +
          "<td>" + formatShares(r.shares) + "</td>" +
          "<td>" + formatCurrency(r.price) + "</td>" +
          "<td>" + formatCurrency(r.currentValue) + "</td>" +
          "<td>" + formatPct(r.targetWeightNorm * 100) + "</td>" +
          "<td>" + formatCurrency(r.targetValue) + "</td>" +
          "<td>" + formatCurrency(r.tradeValue) + "</td>" +
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

    function updateCurrencyUi() {
      var meta = getCurrencyMeta();
      document.getElementById("priceCurrencyLabel").textContent = meta.label;
      document.getElementById("netFlowLabel").textContent = "Net contribution / withdrawal (" + meta.label + ")";
    }

    function calculateRebalance() {
      validationNode.textContent = "";

      try {
        var positions = parsePositionsFromTable();
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
          var tradeShares = tradeValue / p.price;
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
            tradeShares = 0;
          }

          return {
            ticker: p.ticker,
            shares: p.shares,
            price: p.price,
            currentValue: p.currentValue,
            targetWeightNorm: targetWeightNorm,
            targetValue: targetValue,
            tradeValue: tradeValue,
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

        resultsNode.innerHTML = summaryHtml(summaryData) + buildResultTable(results);
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

    currencySelect.addEventListener("change", function () {
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
