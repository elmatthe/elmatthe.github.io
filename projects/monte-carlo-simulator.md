---
layout: page
title: Monte Carlo Retirement Simulator
permalink: /projects/monte-carlo-simulator/
summary: Retirement planning Monte Carlo workflow with browser simulator, starter Python app, and setup guide.
last_updated: 2026-03-19
---

<section class="hero-panel">
  <div class="eyebrow">Retirement Planning Tool</div>
  <h1>Monte Carlo Retirement Simulator</h1>
  <p class="lede">This project introduces a retirement planning Monte Carlo workflow that combines a browser-based simulator with downloadable Python and setup resources, aligned to the same style as the existing project library.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/Monte_Carlo_Simulator/monte_carlo_simulator.py' | relative_url }}" download>Download Monte Carlo Simulator (.py)</a>
  <a class="btn" href="{{ '/projects/Monte_Carlo_Simulator/Monte_Carlo_Setup_Guide.md' | relative_url }}" download="Monte_Carlo_Setup_Guide.md">Download Setup Guide (.md)</a>
</div>

## Guides
<ul class="link-list">
  <li><a href="{{ '/projects/Monte_Carlo_Simulator/Monte_Carlo_Setup_Guide.md' | relative_url }}" download="Monte_Carlo_Setup_Guide.md">Download Monte Carlo Setup Guide (.md)</a></li>
  <li><a href="{{ '/projects/monte-carlo-guide/' | relative_url }}">Open Monte Carlo Setup Guide (Web Page)</a></li>
</ul>

## Workflow Snapshot
<figure class="project-visual">
  <img src="{{ '/assets/images/monte-carlo-workflow.svg' | relative_url }}" alt="Three-step workflow showing input assumptions, simulation runs, and Excel-style output review" />
  <figcaption class="muted">A three-step workflow from assumptions to simulation paths to retirement outcome review.</figcaption>
</figure>

## About This Tool
This simulator models portfolio outcomes across many random market paths so you can stress test retirement assumptions before making planning decisions.

It follows the same two-phase structure as the project plan: an accumulation phase before retirement, then a withdrawal phase during retirement.

Use the browser tool below for quick scenario checks, and use the downloadable resources as the project build-out continues.

## Interactive Simulator
<div class="tool-grid mc-theme">
  <section class="tool-card">
    <h3>Simulation Inputs</h3>
    <div class="mc-input-grid">
      <div class="field">
        <label for="mcCurrentPortfolio">Current Portfolio Value ($)</label>
        <input id="mcCurrentPortfolio" type="number" min="0" step="0.01" value="150000" />
      </div>
      <div class="field">
        <label for="mcAnnualContribution">Annual Contribution ($)</label>
        <input id="mcAnnualContribution" type="number" step="0.01" value="10000" />
      </div>
      <div class="field">
        <label for="mcContributionGrowth">Contribution Growth Rate (% / yr)</label>
        <input id="mcContributionGrowth" type="number" step="0.01" value="0" />
      </div>
      <div class="field">
        <label for="mcYearsToRetirement">Years to Retirement</label>
        <input id="mcYearsToRetirement" type="number" min="1" step="1" value="30" />
      </div>
      <div class="field">
        <label for="mcYearsInRetirement">Years in Retirement</label>
        <input id="mcYearsInRetirement" type="number" min="1" step="1" value="25" />
      </div>
      <div class="field">
        <label for="mcExpectedReturn">Expected Annual Return (%)</label>
        <input id="mcExpectedReturn" type="number" step="0.01" value="7" />
      </div>
      <div class="field">
        <label for="mcVolatility">Annual Volatility / Std Dev (%)</label>
        <input id="mcVolatility" type="number" min="0" step="0.01" value="12" />
      </div>
      <div class="field">
        <label for="mcInflation">Inflation Rate (%)</label>
        <input id="mcInflation" type="number" step="0.01" value="2.5" />
      </div>
      <div class="field">
        <label for="mcAnnualSpending">Annual Retirement Spending ($)</label>
        <input id="mcAnnualSpending" type="number" min="0" step="0.01" value="60000" />
      </div>
      <div class="field">
        <label for="mcPensionIncome">CPP / OAS / Pension Income ($ / yr)</label>
        <input id="mcPensionIncome" type="number" step="0.01" value="18000" />
      </div>
      <div class="field">
        <label for="mcSimulationCount">Number of Simulations (max 2000 in browser)</label>
        <input id="mcSimulationCount" type="number" min="1" max="2000" step="1" value="1000" />
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" id="mcRunBtn" type="button">Run Simulation</button>
      <button class="btn btn-secondary" id="mcSampleBtn" type="button">Load Sample Scenario</button>
    </div>
    <div id="mcValidationMessage" class="muted"></div>
  </section>

  <section class="tool-card">
    <h3>Simulation Output</h3>
    <div id="mcSummaryTiles" class="summary-grid">
      <div class="summary-item"><span>Probability of Success</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Median at Retirement</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Median Final Value</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Safe Withdrawal Rate</span><strong>Run simulation</strong></div>
    </div>
    <div class="mc-chart-wrap">
      <canvas id="mcChartCanvas" width="960" height="420" aria-label="Monte Carlo fan chart"></canvas>
    </div>
    <div id="mcTableWrap" class="result-box">Percentile table will appear here after you run simulation.</div>
    <p class="muted mc-disclaimer"><strong>Disclaimer:</strong> Illustrative and educational only. This tool is not financial advice.</p>
  </section>
</div>

## What This Tool Includes
<div class="card-grid">
  <section class="card">
    <h3>Simulation Engine</h3>
    <p class="muted">A browser Monte Carlo model with accumulation and retirement withdrawal phases using normal annual return draws.</p>
  </section>
  <section class="card">
    <h3>Downloadable Desktop Starter</h3>
    <p class="muted">A starter Python desktop scaffold to support the full project build into workbook export and chart embedding.</p>
  </section>
  <section class="card">
    <h3>Setup Guide</h3>
    <p class="muted">A structured setup and usage guide in both downloadable markdown and web-rendered formats.</p>
  </section>
</div>

<script>
  (function () {
    var sampleScenario = {
      currentPortfolio: 150000,
      annualContribution: 10000,
      contributionGrowth: 0,
      yearsToRetirement: 30,
      yearsInRetirement: 25,
      expectedReturn: 7,
      volatility: 12,
      inflation: 2.5,
      annualSpending: 60000,
      pensionIncome: 18000,
      simulationCount: 1000
    };

    var fieldIds = [
      "mcCurrentPortfolio",
      "mcAnnualContribution",
      "mcContributionGrowth",
      "mcYearsToRetirement",
      "mcYearsInRetirement",
      "mcExpectedReturn",
      "mcVolatility",
      "mcInflation",
      "mcAnnualSpending",
      "mcPensionIncome",
      "mcSimulationCount"
    ];

    var messageNode = document.getElementById("mcValidationMessage");
    var summaryNode = document.getElementById("mcSummaryTiles");
    var tableWrap = document.getElementById("mcTableWrap");
    var chartCanvas = document.getElementById("mcChartCanvas");
    var runBtn = document.getElementById("mcRunBtn");
    var sampleBtn = document.getElementById("mcSampleBtn");
    var lastResult = null;

    function toNumber(id) {
      return Number(document.getElementById(id).value);
    }

    function formatCurrency(num) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
    }

    function formatPercent(num) {
      return num.toFixed(1) + "%";
    }

    function setSampleInputs() {
      document.getElementById("mcCurrentPortfolio").value = String(sampleScenario.currentPortfolio);
      document.getElementById("mcAnnualContribution").value = String(sampleScenario.annualContribution);
      document.getElementById("mcContributionGrowth").value = String(sampleScenario.contributionGrowth);
      document.getElementById("mcYearsToRetirement").value = String(sampleScenario.yearsToRetirement);
      document.getElementById("mcYearsInRetirement").value = String(sampleScenario.yearsInRetirement);
      document.getElementById("mcExpectedReturn").value = String(sampleScenario.expectedReturn);
      document.getElementById("mcVolatility").value = String(sampleScenario.volatility);
      document.getElementById("mcInflation").value = String(sampleScenario.inflation);
      document.getElementById("mcAnnualSpending").value = String(sampleScenario.annualSpending);
      document.getElementById("mcPensionIncome").value = String(sampleScenario.pensionIncome);
      document.getElementById("mcSimulationCount").value = String(sampleScenario.simulationCount);
      messageNode.textContent = "Sample scenario loaded.";
    }

    function validateInputs() {
      var data = {
        currentPortfolio: toNumber("mcCurrentPortfolio"),
        annualContribution: toNumber("mcAnnualContribution"),
        contributionGrowth: toNumber("mcContributionGrowth") / 100,
        yearsToRetirement: Math.floor(toNumber("mcYearsToRetirement")),
        yearsInRetirement: Math.floor(toNumber("mcYearsInRetirement")),
        expectedReturn: toNumber("mcExpectedReturn") / 100,
        volatility: toNumber("mcVolatility") / 100,
        inflation: toNumber("mcInflation") / 100,
        annualSpending: toNumber("mcAnnualSpending"),
        pensionIncome: toNumber("mcPensionIncome"),
        simulationCount: Math.floor(toNumber("mcSimulationCount"))
      };

      if (!Number.isFinite(data.currentPortfolio) || data.currentPortfolio <= 0) {
        throw new Error("Current portfolio value must be greater than 0.");
      }
      if (!Number.isFinite(data.annualContribution) || data.annualContribution < 0) {
        throw new Error("Annual contribution must be 0 or greater.");
      }
      if (!Number.isFinite(data.contributionGrowth)) {
        throw new Error("Contribution growth rate must be numeric.");
      }
      if (!Number.isInteger(data.yearsToRetirement) || data.yearsToRetirement < 1) {
        throw new Error("Years to retirement must be a whole number of 1 or more.");
      }
      if (!Number.isInteger(data.yearsInRetirement) || data.yearsInRetirement < 1) {
        throw new Error("Years in retirement must be a whole number of 1 or more.");
      }
      if (!Number.isFinite(data.expectedReturn)) {
        throw new Error("Expected return must be numeric.");
      }
      if (!Number.isFinite(data.volatility) || data.volatility < 0) {
        throw new Error("Volatility must be 0 or greater.");
      }
      if (!Number.isFinite(data.inflation)) {
        throw new Error("Inflation rate must be numeric.");
      }
      if (!Number.isFinite(data.annualSpending) || data.annualSpending <= 0) {
        throw new Error("Annual retirement spending must be greater than 0.");
      }
      if (!Number.isFinite(data.pensionIncome)) {
        throw new Error("CPP/OAS/Pension income must be numeric.");
      }
      if (!Number.isInteger(data.simulationCount) || data.simulationCount < 1 || data.simulationCount > 2000) {
        throw new Error("Simulation count must be a whole number between 1 and 2,000.");
      }

      return data;
    }

    function boxMullerRandom(mean, stdDev) {
      var u1 = Math.random();
      var u2 = Math.random();
      var z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
      return mean + z * stdDev;
    }

    function percentile(sortedValues, pct) {
      if (!sortedValues.length) return 0;
      var idx = (sortedValues.length - 1) * pct;
      var lower = Math.floor(idx);
      var upper = Math.ceil(idx);
      if (lower === upper) return sortedValues[lower];
      var weight = idx - lower;
      return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
    }

    function runSimulation(inputs) {
      var totalYears = inputs.yearsToRetirement + inputs.yearsInRetirement;
      var yearlyValues = [];
      for (var y = 0; y <= totalYears; y += 1) {
        yearlyValues.push([]);
      }

      var finalValues = [];
      var retirementValues = [];
      var failedRuns = 0;

      for (var s = 0; s < inputs.simulationCount; s += 1) {
        var portfolio = inputs.currentPortfolio;
        var contribution = inputs.annualContribution;
        var failed = false;
        yearlyValues[0].push(portfolio);

        for (var yAcc = 1; yAcc <= inputs.yearsToRetirement; yAcc += 1) {
          var growthAcc = boxMullerRandom(inputs.expectedReturn, inputs.volatility);
          portfolio = portfolio * (1 + growthAcc) + contribution;
          if (portfolio < 0) {
            portfolio = 0;
          }
          yearlyValues[yAcc].push(portfolio);
          contribution = contribution * (1 + inputs.contributionGrowth);
        }

        var netWithdrawal = Math.max(0, inputs.annualSpending - inputs.pensionIncome);
        for (var yRet = 1; yRet <= inputs.yearsInRetirement; yRet += 1) {
          var growthRet = boxMullerRandom(inputs.expectedReturn, inputs.volatility);
          portfolio = portfolio * (1 + growthRet) - netWithdrawal;
          if (portfolio <= 0) {
            portfolio = 0;
            failed = true;
          }
          yearlyValues[inputs.yearsToRetirement + yRet].push(portfolio);
        }

        if (failed) {
          failedRuns += 1;
        }

        retirementValues.push(yearlyValues[inputs.yearsToRetirement][s]);
        finalValues.push(portfolio);
      }

      var percentilesByYear = yearlyValues.map(function (arr, year) {
        var sorted = arr.slice().sort(function (a, b) { return a - b; });
        var inflationFactor = Math.pow(1 + inputs.inflation, year);
        return {
          year: year,
          p10: percentile(sorted, 0.10),
          p25: percentile(sorted, 0.25),
          p50: percentile(sorted, 0.50),
          p75: percentile(sorted, 0.75),
          p90: percentile(sorted, 0.90),
          p50Real: percentile(sorted, 0.50) / inflationFactor
        };
      });

      var sortedFinal = finalValues.slice().sort(function (a, b) { return a - b; });
      var sortedRetirement = retirementValues.slice().sort(function (a, b) { return a - b; });
      var medianRetirement = percentile(sortedRetirement, 0.50);
      var netWithdrawal = Math.max(0, inputs.annualSpending - inputs.pensionIncome);
      var swr = medianRetirement > 0 ? (netWithdrawal / medianRetirement) * 100 : 0;

      return {
        successProbability: ((inputs.simulationCount - failedRuns) / inputs.simulationCount) * 100,
        medianRetirement: medianRetirement,
        medianFinal: percentile(sortedFinal, 0.50),
        swr: swr,
        failedRuns: failedRuns,
        totalRuns: inputs.simulationCount,
        percentilesByYear: percentilesByYear,
        retirementYear: inputs.yearsToRetirement
      };
    }

    function successClass(probability) {
      if (probability >= 85) return "mc-stat-good";
      if (probability >= 70) return "mc-stat-warn";
      return "mc-stat-risk";
    }

    function renderSummary(result) {
      summaryNode.innerHTML = "" +
        "<div class='summary-item " + successClass(result.successProbability) + "'><span>Probability of Success</span><strong>" + formatPercent(result.successProbability) + "</strong></div>" +
        "<div class='summary-item'><span>Median at Retirement</span><strong>" + formatCurrency(result.medianRetirement) + "</strong></div>" +
        "<div class='summary-item'><span>Median Final Value</span><strong>" + formatCurrency(result.medianFinal) + "</strong></div>" +
        "<div class='summary-item'><span>Safe Withdrawal Rate</span><strong>" + result.swr.toFixed(2) + "%</strong></div>";
    }

    function drawChart(result) {
      var dpr = window.devicePixelRatio || 1;
      var cssWidth = chartCanvas.clientWidth || 960;
      var cssHeight = 420;
      chartCanvas.style.height = cssHeight + "px";
      chartCanvas.width = Math.floor(cssWidth * dpr);
      chartCanvas.height = Math.floor(cssHeight * dpr);

      var ctx = chartCanvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      var padding = { left: 58, right: 18, top: 20, bottom: 42 };
      var plotWidth = cssWidth - padding.left - padding.right;
      var plotHeight = cssHeight - padding.top - padding.bottom;
      var maxYear = result.percentilesByYear[result.percentilesByYear.length - 1].year;
      var maxValue = result.percentilesByYear.reduce(function (m, row) {
        return Math.max(m, row.p90);
      }, 0);
      var yMax = maxValue > 0 ? maxValue * 1.05 : 1;

      function x(year) {
        return padding.left + (year / Math.max(maxYear, 1)) * plotWidth;
      }
      function y(value) {
        return padding.top + (1 - value / yMax) * plotHeight;
      }

      ctx.strokeStyle = "#d2dceb";
      ctx.lineWidth = 1;
      for (var i = 0; i <= 4; i += 1) {
        var yLine = padding.top + (i / 4) * plotHeight;
        ctx.beginPath();
        ctx.moveTo(padding.left, yLine);
        ctx.lineTo(padding.left + plotWidth, yLine);
        ctx.stroke();
      }

      function fillBand(lowerKey, upperKey, color) {
        ctx.beginPath();
        result.percentilesByYear.forEach(function (row, idx) {
          var xp = x(row.year);
          var yp = y(row[upperKey]);
          if (idx === 0) ctx.moveTo(xp, yp); else ctx.lineTo(xp, yp);
        });
        for (var j = result.percentilesByYear.length - 1; j >= 0; j -= 1) {
          var rowBack = result.percentilesByYear[j];
          ctx.lineTo(x(rowBack.year), y(rowBack[lowerKey]));
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }

      fillBand("p10", "p90", "rgba(26, 46, 74, 0.18)");
      fillBand("p25", "p75", "rgba(26, 46, 74, 0.30)");

      ctx.beginPath();
      result.percentilesByYear.forEach(function (row, idx) {
        var xp = x(row.year);
        var yp = y(row.p50);
        if (idx === 0) ctx.moveTo(xp, yp); else ctx.lineTo(xp, yp);
      });
      ctx.strokeStyle = "#1a2e4a";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      var retireX = x(result.retirementYear);
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.moveTo(retireX, padding.top);
      ctx.lineTo(retireX, padding.top + plotHeight);
      ctx.strokeStyle = "#3d5f8e";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#2c476d";
      ctx.font = "12px sans-serif";
      ctx.fillText("Retirement", Math.min(retireX + 6, padding.left + plotWidth - 70), padding.top + 14);

      ctx.strokeStyle = "#6f86a8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, padding.top);
      ctx.lineTo(padding.left, padding.top + plotHeight);
      ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
      ctx.stroke();

      ctx.fillStyle = "#415d83";
      ctx.font = "11px sans-serif";
      for (var t = 0; t <= 4; t += 1) {
        var labelValue = yMax * (1 - t / 4);
        var labelY = padding.top + (t / 4) * plotHeight + 4;
        ctx.fillText(formatCurrency(labelValue), 4, labelY);
      }
      for (var xTick = 0; xTick <= 5; xTick += 1) {
        var tickYear = Math.round((maxYear * xTick) / 5);
        var tickX = x(tickYear);
        ctx.fillText(String(tickYear), tickX - 7, padding.top + plotHeight + 18);
      }
      ctx.fillText("Year", padding.left + plotWidth - 24, padding.top + plotHeight + 33);
    }

    function buildCheckpointYears(maxYear, retirementYear) {
      var years = [0, retirementYear];
      for (var y = retirementYear + 5; y <= maxYear; y += 5) {
        years.push(y);
      }
      if (years[years.length - 1] !== maxYear) {
        years.push(maxYear);
      }
      return Array.from(new Set(years));
    }

    function renderTable(result) {
      var maxYear = result.percentilesByYear[result.percentilesByYear.length - 1].year;
      var checkpoints = buildCheckpointYears(maxYear, result.retirementYear);

      var rows = checkpoints.map(function (year) {
        var row = result.percentilesByYear[year];
        return "<tr>" +
          "<td>" + year + "</td>" +
          "<td>" + formatCurrency(row.p10) + "</td>" +
          "<td>" + formatCurrency(row.p25) + "</td>" +
          "<td>" + formatCurrency(row.p50) + "</td>" +
          "<td>" + formatCurrency(row.p75) + "</td>" +
          "<td>" + formatCurrency(row.p90) + "</td>" +
          "<td>" + formatCurrency(row.p50Real) + "</td>" +
          "</tr>";
      }).join("");

      tableWrap.innerHTML = "" +
        "<div class='muted'>Failed simulations: " + result.failedRuns + " of " + result.totalRuns + "</div>" +
        "<table class='sheet-table output-sheet mc-table'><thead><tr>" +
        "<th>Year</th><th>P10</th><th>P25</th><th>P50</th><th>P75</th><th>P90</th><th>P50 (Real $)</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table>";
    }

    function clearOutput() {
      lastResult = null;
      summaryNode.innerHTML = "" +
        "<div class='summary-item'><span>Probability of Success</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Median at Retirement</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Median Final Value</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Safe Withdrawal Rate</span><strong>Run simulation</strong></div>";
      tableWrap.textContent = "Percentile table will appear here after you run simulation.";
      var ctx = chartCanvas.getContext("2d");
      ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
    }

    function run() {
      messageNode.textContent = "";
      runBtn.disabled = true;
      runBtn.textContent = "Running...";

      try {
        var inputs = validateInputs();
        var result = runSimulation(inputs);
        lastResult = result;
        renderSummary(result);
        drawChart(result);
        renderTable(result);
        messageNode.textContent = "Simulation complete.";
      } catch (err) {
        clearOutput();
        messageNode.textContent = err.message;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run Simulation";
      }
    }

    sampleBtn.addEventListener("click", setSampleInputs);
    runBtn.addEventListener("click", run);

    fieldIds.forEach(function (id) {
      document.getElementById(id).addEventListener("input", function () {
        if (messageNode.textContent) {
          messageNode.textContent = "";
        }
      });
    });

    window.addEventListener("resize", function () {
      if (lastResult) {
        drawChart(lastResult);
      }
    });

    clearOutput();
  })();
</script>
