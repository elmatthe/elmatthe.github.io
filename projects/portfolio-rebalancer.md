---
layout: page
title: Portfolio Rebalancer Tool
permalink: /projects/portfolio-rebalancer/
summary: Interactive tool to rebalance holdings back to a target strategic allocation.
last_updated: 2026-03-13
---

# Portfolio Rebalancer Tool

Use this calculator to rebalance a portfolio back to its intended strategic weights.

<section class="callout">
  <p><strong>Input format:</strong> one position per line using <code>Asset, Current Value, Target Weight %</code>.</p>
  <p>Example: <code>US Equity,45000,50</code></p>
  <p><a href="{{ '/projects/portfolio-rebalancer-guide/' | relative_url }}">Open Setup Guide (Web Page)</a> | <a href="{{ '/projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md' | relative_url }}" download>Download Setup Guide (.md)</a></p>
</section>

## Project Files
- [Portfolio Rebalancer Setup Guide (.md)](/projects/Portfolio_Rebalancer/Portfolio_Rebalancer_Setup_Guide.md)

<div class="tool-grid">
  <section class="tool-card">
    <h3>Portfolio Inputs</h3>
    <div class="field">
      <label for="holdingsInput">Positions</label>
      <textarea id="holdingsInput">US Equity,45000,50
International Equity,25000,25
Fixed Income,15000,20
Cash,5000,5</textarea>
    </div>
    <div class="field">
      <label for="netFlowInput">Net contribution / withdrawal</label>
      <input id="netFlowInput" type="number" value="0" step="0.01" />
      <div class="muted">Use a positive value for contribution and negative for withdrawal.</div>
    </div>
    <div class="btn-row">
      <button class="btn" id="rebalanceBtn" type="button">Calculate Rebalance</button>
      <button class="btn btn-secondary" id="sampleBtn" type="button">Reset Sample Data</button>
    </div>
    <div id="validationMessage" class="muted"></div>
  </section>

  <section class="tool-card">
    <h3>Rebalance Output</h3>
    <div id="rebalanceResults" class="result-box">Results will appear here after calculation.</div>
  </section>
</div>

<script>
  (function () {
    function parseInputRows(rawText) {
      return rawText
        .split(/\r?\n/)
        .map(function (line) { return line.trim(); })
        .filter(function (line) { return line.length > 0; });
    }

    function parsePositions(rows) {
      return rows.map(function (row, idx) {
        var parts = row.split(",").map(function (p) { return p.trim(); });
        if (parts.length !== 3) {
          throw new Error("Line " + (idx + 1) + " must have 3 comma-separated values.");
        }

        var name = parts[0];
        var currentValue = Number(parts[1]);
        var targetWeight = Number(parts[2]);

        if (!name) {
          throw new Error("Line " + (idx + 1) + ": asset name is required.");
        }
        if (!Number.isFinite(currentValue) || currentValue < 0) {
          throw new Error("Line " + (idx + 1) + ": current value must be a non-negative number.");
        }
        if (!Number.isFinite(targetWeight) || targetWeight <= 0) {
          throw new Error("Line " + (idx + 1) + ": target weight must be greater than 0.");
        }

        return {
          name: name,
          currentValue: currentValue,
          targetWeight: targetWeight
        };
      });
    }

    function formatCurrency(num) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
    }

    function formatPct(num) {
      return (num * 100).toFixed(2) + "%";
    }

    function buildTable(rows) {
      var tableHead = "<table class='rebalance-table'><thead><tr>" +
        "<th>Asset</th><th>Current</th><th>Target Weight</th><th>Target Value</th>" +
        "<th>Trade</th><th>Post-Trade Value</th></tr></thead><tbody>";
      var tableBody = rows.map(function (r) {
        var actionText = r.trade >= 0 ? "Buy " + formatCurrency(r.trade) : "Sell " + formatCurrency(Math.abs(r.trade));
        return "<tr><td>" + r.name + "</td><td>" + formatCurrency(r.currentValue) + "</td><td>" +
          formatPct(r.targetWeightNorm) + "</td><td>" + formatCurrency(r.targetValue) + "</td><td>" +
          actionText + "</td><td>" + formatCurrency(r.postTradeValue) + "</td></tr>";
      }).join("");
      return tableHead + tableBody + "</tbody></table>";
    }

    function calculateRebalance() {
      var msg = document.getElementById("validationMessage");
      var resultsNode = document.getElementById("rebalanceResults");
      msg.textContent = "";

      try {
        var raw = document.getElementById("holdingsInput").value;
        var rows = parseInputRows(raw);
        if (!rows.length) {
          throw new Error("Enter at least one position.");
        }

        var positions = parsePositions(rows);
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
        var buys = 0;
        var sells = 0;

        var results = positions.map(function (p) {
          var targetWeightNorm = p.targetWeight / totalWeight;
          var targetValue = targetWeightNorm * endingPortfolioValue;
          var trade = targetValue - p.currentValue;
          if (trade >= 0) {
            buys += trade;
          } else {
            sells += Math.abs(trade);
          }
          return {
            name: p.name,
            currentValue: p.currentValue,
            targetWeightNorm: targetWeightNorm,
            targetValue: targetValue,
            trade: trade,
            postTradeValue: p.currentValue + trade
          };
        });

        var summary = "<p><strong>Total current value:</strong> " + formatCurrency(totalCurrent) + "<br/>" +
          "<strong>Net flow:</strong> " + formatCurrency(netFlow) + "<br/>" +
          "<strong>Target ending value:</strong> " + formatCurrency(endingPortfolioValue) + "<br/>" +
          "<strong>Total buys:</strong> " + formatCurrency(buys) + " | <strong>Total sells:</strong> " + formatCurrency(sells) + "</p>";

        resultsNode.innerHTML = summary + buildTable(results);
      } catch (err) {
        resultsNode.textContent = "Results will appear here after calculation.";
        msg.textContent = err.message;
      }
    }

    document.getElementById("rebalanceBtn").addEventListener("click", calculateRebalance);
    document.getElementById("sampleBtn").addEventListener("click", function () {
      document.getElementById("holdingsInput").value = "US Equity,45000,50\nInternational Equity,25000,25\nFixed Income,15000,20\nCash,5000,5";
      document.getElementById("netFlowInput").value = "0";
      document.getElementById("validationMessage").textContent = "";
      document.getElementById("rebalanceResults").textContent = "Results will appear here after calculation.";
    });
  })();
</script>
