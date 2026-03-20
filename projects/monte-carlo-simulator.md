---
layout: page
title: Monte Carlo Retirement Simulator
permalink: /projects/monte-carlo-simulator/
summary: Retirement planning Monte Carlo workflow with browser simulator, desktop Python app, and setup guide.
last_updated: 2026-03-19
---

<section class="hero-panel">
  <div class="eyebrow">Retirement Planning Tool</div>
  <h1>Monte Carlo Retirement Simulator</h1>
  <p class="lede">This project introduces a retirement planning Monte Carlo workflow that combines a browser-based simulator with downloadable Python and setup resources, aligned to the same style as the existing project library.</p>
</section>

## Downloads
<div class="btn-row">
  <a class="btn" href="{{ '/projects/Monte_Carlo_Simulator/monte_carlo_simulator.py' | relative_url }}" download>Download Desktop Monte Carlo Simulator (.py)</a>
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

This web version is designed for quick scenario analysis in-browser while matching the same output framing as the desktop workflow (success rate, fan chart, and percentile checkpoints).

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
    <div id="mcValidationMessage" class="muted mc-status-line">Ready. Fill inputs and run the simulation.</div>
  </section>

  <section class="tool-card">
    <h3>Simulation Output</h3>
    <div class="mc-output-controls">
      <div class="mc-mode-toggle" role="radiogroup" aria-label="Value display mode">
        <label><input type="radio" name="mcValueMode" value="nominal" checked /> Nominal values</label>
        <label><input type="radio" name="mcValueMode" value="real" /> Real values (inflation-adjusted)</label>
      </div>
      <div id="mcRunMeta" class="muted">No simulation run yet.</div>
    </div>
    <div id="mcSummaryTiles" class="summary-grid">
      <div class="summary-item"><span>Probability of Success</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Median at Retirement</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Median Final Value</span><strong>Run simulation</strong></div>
      <div class="summary-item"><span>Safe Withdrawal Rate</span><strong>Run simulation</strong></div>
    </div>
    <div id="mcDetailStats" class="mc-detail-grid">
      <div class="mc-detail-item"><span>Detailed metrics will appear after simulation.</span></div>
    </div>
    <div class="mc-chart-wrap">
      <canvas id="mcChartCanvas" width="960" height="420" aria-label="Monte Carlo fan chart"></canvas>
    </div>
    <div class="mc-chart-legend muted">
      <span><i class="mc-legend-chip mc-legend-median"></i>Median</span>
      <span><i class="mc-legend-chip mc-legend-band-2575"></i>25th-75th percentile</span>
      <span><i class="mc-legend-chip mc-legend-band-1090"></i>10th-90th percentile</span>
    </div>
    <div id="mcTableWrap" class="result-box">Percentile table will appear here after you run simulation.</div>
    <p class="muted mc-disclaimer"><strong>Disclaimer:</strong> Illustrative and educational only. This tool is not financial advice.</p>
  </section>
</div>

## What This Tool Includes
<div class="card-grid">
  <section class="card">
    <h3>Simulation Engine</h3>
    <p class="muted">A browser Monte Carlo model with accumulation and retirement withdrawal phases using normal annual return draws and full path tracking.</p>
  </section>
  <section class="card">
    <h3>Planner-Focused Outputs</h3>
    <p class="muted">Probability of success, ruin-year metrics, percentile fan chart, and checkpoint tables that mirror the project planning workflow.</p>
  </section>
  <section class="card">
    <h3>Downloadable Resources</h3>
    <p class="muted">Download the desktop Python simulator and setup guide to run threaded simulations, write Excel outputs, and export percentile CSV data locally.</p>
  </section>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
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

    var messageNode = document.getElementById("mcValidationMessage");
    var runMetaNode = document.getElementById("mcRunMeta");
    var summaryNode = document.getElementById("mcSummaryTiles");
    var detailNode = document.getElementById("mcDetailStats");
    var tableWrap = document.getElementById("mcTableWrap");
    var chartCanvas = document.getElementById("mcChartCanvas");
    var runBtn = document.getElementById("mcRunBtn");
    var sampleBtn = document.getElementById("mcSampleBtn");
    var modeRadioNodes = document.querySelectorAll("input[name='mcValueMode']");
    var chartUnavailable = typeof window.Chart === "undefined";
    var MAX_MONEY_INPUT = 1e15;
    var MAX_YEARS_INPUT = 120;
    var MAX_ABS_RATE_INPUT = 100;
    var MAX_VOLATILITY_INPUT = 300;

    var state = {
      valueMode: "nominal",
      chart: null,
      lastResult: null,
      lastRuntimeMs: 0
    };

    function getRawInput(id) {
      return document.getElementById(id).value.trim();
    }

    function formatCurrency(num) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      }).format(num);
    }

    function formatPercent(num) {
      return num.toFixed(1) + "%";
    }

    function formatSimulationCount(num) {
      return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0
      }).format(num);
    }

    function setStatus(text, kind) {
      messageNode.textContent = text;
      messageNode.classList.remove("mc-status-neutral", "mc-status-running", "mc-status-success", "mc-status-error");
      messageNode.classList.add(kind ? "mc-status-" + kind : "mc-status-neutral");
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
      setStatus("Sample scenario loaded. Click Run Simulation to calculate results.", "neutral");
    }

    function parseRequiredNumber(id, invalidMessage) {
      var raw = getRawInput(id);
      if (raw === "") {
        throw new Error(invalidMessage);
      }
      var value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(invalidMessage);
      }
      return value;
    }

    function parseRequiredInteger(id, invalidMessage) {
      var raw = getRawInput(id);
      if (raw === "") {
        throw new Error(invalidMessage);
      }
      var value = Number(raw);
      if (!Number.isInteger(value)) {
        throw new Error(invalidMessage);
      }
      return value;
    }

    function requireMaxAbs(value, maxAbs, message) {
      if (Math.abs(value) > maxAbs) {
        throw new Error(message);
      }
    }

    function validateInputs() {
      var data = {
        currentPortfolio: parseRequiredNumber("mcCurrentPortfolio", "Current portfolio value must be greater than 0."),
        annualContribution: parseRequiredNumber("mcAnnualContribution", "Enter annual contribution (0 is valid)."),
        contributionGrowth: parseRequiredNumber("mcContributionGrowth", "Contribution growth rate must be a number (0 is valid).") / 100,
        yearsToRetirement: parseRequiredInteger("mcYearsToRetirement", "Years to retirement must be a whole number of 1 or more."),
        yearsInRetirement: parseRequiredInteger("mcYearsInRetirement", "Years in retirement must be a whole number of 1 or more."),
        expectedReturn: parseRequiredNumber("mcExpectedReturn", "Expected annual return must be a number.") / 100,
        volatility: parseRequiredNumber("mcVolatility", "Volatility must be 0 or greater.") / 100,
        inflation: parseRequiredNumber("mcInflation", "Inflation rate must be a number (0 is valid).") / 100,
        annualSpending: parseRequiredNumber("mcAnnualSpending", "Annual retirement spending must be greater than 0."),
        pensionIncome: parseRequiredNumber("mcPensionIncome", "CPP/OAS/Pension income must be a number (0 is valid)."),
        simulationCount: parseRequiredInteger("mcSimulationCount", "Number of simulations must be a whole number between 1 and 2,000.")
      };

      if (data.currentPortfolio <= 0) {
        throw new Error("Current portfolio value must be greater than 0.");
      }
      if (data.annualContribution < 0) {
        throw new Error("Enter annual contribution (0 is valid).");
      }
      if (data.pensionIncome < 0) {
        throw new Error("CPP/OAS/Pension income must be 0 or greater.");
      }
      if (data.yearsToRetirement < 1) {
        throw new Error("Years to retirement must be a whole number of 1 or more.");
      }
      if (data.yearsInRetirement < 1) {
        throw new Error("Years in retirement must be a whole number of 1 or more.");
      }
      if (data.yearsToRetirement > MAX_YEARS_INPUT || data.yearsInRetirement > MAX_YEARS_INPUT) {
        throw new Error("Years to retirement and years in retirement must each be 120 or less.");
      }
      if (data.volatility < 0) {
        throw new Error("Volatility must be 0 or greater.");
      }
      if (data.volatility * 100 > MAX_VOLATILITY_INPUT) {
        throw new Error("Volatility must be 300% or less.");
      }
      if (data.annualSpending <= 0) {
        throw new Error("Annual retirement spending must be greater than 0.");
      }
      if (data.simulationCount < 1 || data.simulationCount > 2000) {
        throw new Error("Number of simulations must be a whole number between 1 and 2,000.");
      }

      requireMaxAbs(data.currentPortfolio, MAX_MONEY_INPUT, "Current portfolio value is too large for stable simulation.");
      requireMaxAbs(data.annualContribution, MAX_MONEY_INPUT, "Annual contribution is too large for stable simulation.");
      requireMaxAbs(data.annualSpending, MAX_MONEY_INPUT, "Annual retirement spending is too large for stable simulation.");
      requireMaxAbs(data.pensionIncome, MAX_MONEY_INPUT, "CPP/OAS/Pension income is too large for stable simulation.");
      requireMaxAbs(data.contributionGrowth * 100, MAX_ABS_RATE_INPUT, "Contribution growth rate must be between -100% and 100%.");
      requireMaxAbs(data.expectedReturn * 100, MAX_ABS_RATE_INPUT, "Expected annual return must be between -100% and 100%.");
      requireMaxAbs(data.inflation * 100, MAX_ABS_RATE_INPUT, "Inflation rate must be between -100% and 100%.");

      return data;
    }

    function boxMullerRandom(mean, stdDev) {
      var u1 = Math.random();
      var u2 = Math.random();
      var z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
      return mean + z * stdDev;
    }

    function percentileFromSorted(sortedValues, pct) {
      if (!sortedValues.length) {
        return 0;
      }
      var idx = (sortedValues.length - 1) * pct;
      var lower = Math.floor(idx);
      var upper = Math.ceil(idx);
      if (lower === upper) {
        return sortedValues[lower];
      }
      var weight = idx - lower;
      return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
    }

    function computePercentiles(values) {
      var sorted = values.slice().sort(function (a, b) {
        return a - b;
      });
      return {
        p10: percentileFromSorted(sorted, 0.10),
        p25: percentileFromSorted(sorted, 0.25),
        p50: percentileFromSorted(sorted, 0.50),
        p75: percentileFromSorted(sorted, 0.75),
        p90: percentileFromSorted(sorted, 0.90)
      };
    }

    function inflationFactor(rate, year) {
      return Math.pow(1 + rate, year);
    }

    function convertToReal(nominalValue, rate, year) {
      return nominalValue / inflationFactor(rate, year);
    }

    function simulateSinglePath(inputs, totalYears) {
      var path = new Array(totalYears + 1);
      var portfolio = inputs.currentPortfolio;
      var contribution = inputs.annualContribution;
      var failed = false;
      var ruinYear = null;
      var netWithdrawal = inputs.annualSpending - inputs.pensionIncome;
      var retirementWithdrawal = netWithdrawal;
      path[0] = portfolio;

      for (var yAcc = 1; yAcc <= inputs.yearsToRetirement; yAcc += 1) {
        var growthAcc = boxMullerRandom(inputs.expectedReturn, inputs.volatility);
        portfolio = portfolio * (1 + growthAcc) + contribution;
        if (!Number.isFinite(portfolio)) {
          throw new Error("Simulation overflow detected. Reduce large values and try again.");
        }
        if (portfolio < 0) {
          portfolio = 0;
        }
        path[yAcc] = portfolio;
        contribution = contribution * (1 + inputs.contributionGrowth);
        if (!Number.isFinite(contribution)) {
          throw new Error("Contribution growth overflow detected. Reduce growth rate or contribution value.");
        }
      }

      for (var yRet = 1; yRet <= inputs.yearsInRetirement; yRet += 1) {
        var idx = inputs.yearsToRetirement + yRet;
        if (failed) {
          path[idx] = 0;
          continue;
        }

        var growthRet = boxMullerRandom(inputs.expectedReturn, inputs.volatility);
        portfolio = portfolio * (1 + growthRet) - retirementWithdrawal;
        if (!Number.isFinite(portfolio)) {
          throw new Error("Simulation overflow detected during retirement. Reduce large values and try again.");
        }
        if (portfolio <= 0) {
          portfolio = 0;
          failed = true;
          ruinYear = yRet;
        }
        path[idx] = portfolio;
        retirementWithdrawal = retirementWithdrawal * (1 + inputs.inflation);
        if (!Number.isFinite(retirementWithdrawal)) {
          throw new Error("Inflation-adjusted withdrawal overflow detected. Reduce spending, pension, or inflation inputs.");
        }
      }

      return {
        path: path,
        failed: failed,
        ruinYear: ruinYear,
        retirementValue: path[inputs.yearsToRetirement],
        finalValue: path[totalYears]
      };
    }

    function runSimulation(inputs) {
      var totalYears = inputs.yearsToRetirement + inputs.yearsInRetirement;
      var yearlyValuesNominal = [];
      for (var y = 0; y <= totalYears; y += 1) {
        yearlyValuesNominal.push([]);
      }

      var finalValuesNominal = [];
      var finalValuesReal = [];
      var retirementValuesNominal = [];
      var retirementValuesReal = [];
      var failedRuns = 0;
      var ruinYears = [];
      var netWithdrawal = inputs.annualSpending - inputs.pensionIncome;

      for (var sim = 0; sim < inputs.simulationCount; sim += 1) {
        var run = simulateSinglePath(inputs, totalYears);

        for (var year = 0; year <= totalYears; year += 1) {
          yearlyValuesNominal[year].push(run.path[year]);
        }

        if (run.failed) {
          failedRuns += 1;
          ruinYears.push(run.ruinYear);
        }

        retirementValuesNominal.push(run.retirementValue);
        finalValuesNominal.push(run.finalValue);
        retirementValuesReal.push(convertToReal(run.retirementValue, inputs.inflation, inputs.yearsToRetirement));
        finalValuesReal.push(convertToReal(run.finalValue, inputs.inflation, totalYears));
      }

      var hasInvalidNominal = yearlyValuesNominal.some(function (yearValues) {
        return yearValues.some(function (value) {
          return !Number.isFinite(value);
        });
      });
      if (hasInvalidNominal) {
        throw new Error("Simulation produced non-finite values. Reduce large input magnitudes and try again.");
      }

      var percentilesByYear = yearlyValuesNominal.map(function (arr, year) {
        var nominalStats = computePercentiles(arr);
        return {
          year: year,
          nominal: nominalStats,
          real: {
            p10: convertToReal(nominalStats.p10, inputs.inflation, year),
            p25: convertToReal(nominalStats.p25, inputs.inflation, year),
            p50: convertToReal(nominalStats.p50, inputs.inflation, year),
            p75: convertToReal(nominalStats.p75, inputs.inflation, year),
            p90: convertToReal(nominalStats.p90, inputs.inflation, year)
          }
        };
      });

      var finalStatsNominal = computePercentiles(finalValuesNominal);
      var finalStatsReal = computePercentiles(finalValuesReal);
      var retirementStatsNominal = computePercentiles(retirementValuesNominal);
      var retirementStatsReal = computePercentiles(retirementValuesReal);
      var ruinStats = ruinYears.length ? computePercentiles(ruinYears) : null;
      var swr = retirementStatsNominal.p50 > 0 ? (netWithdrawal / retirementStatsNominal.p50) * 100 : 0;

      var scalarCheckValues = [
        finalStatsNominal.p50,
        finalStatsReal.p50,
        retirementStatsNominal.p50,
        retirementStatsReal.p50,
        swr
      ];
      if (!scalarCheckValues.every(function (value) { return Number.isFinite(value); })) {
        throw new Error("Simulation produced unstable numeric output. Reduce large values and try again.");
      }

      return {
        summary: {
          successProbability: ((inputs.simulationCount - failedRuns) / inputs.simulationCount) * 100,
          medianRetirement: { nominal: retirementStatsNominal.p50, real: retirementStatsReal.p50 },
          medianFinal: { nominal: finalStatsNominal.p50, real: finalStatsReal.p50 },
          finalP10: { nominal: finalStatsNominal.p10, real: finalStatsReal.p10 },
          finalP25: { nominal: finalStatsNominal.p25, real: finalStatsReal.p25 },
          finalP75: { nominal: finalStatsNominal.p75, real: finalStatsReal.p75 },
          finalP90: { nominal: finalStatsNominal.p90, real: finalStatsReal.p90 },
          swr: swr,
          failedRuns: failedRuns,
          totalRuns: inputs.simulationCount,
          medianRuinYear: ruinStats ? ruinStats.p50 : null,
          netWithdrawal: netWithdrawal
        },
        percentilesByYear: percentilesByYear,
        retirementYear: inputs.yearsToRetirement,
        totalYears: totalYears,
        inputs: inputs
      };
    }

    function successClass(probability) {
      if (probability >= 85) {
        return "mc-stat-good";
      }
      if (probability >= 70) {
        return "mc-stat-warn";
      }
      return "mc-stat-risk";
    }

    function valueByMode(valuePair) {
      return state.valueMode === "real" ? valuePair.real : valuePair.nominal;
    }

    function rowValuesByMode(row) {
      return state.valueMode === "real" ? row.real : row.nominal;
    }

    function modeText() {
      return state.valueMode === "real" ? "Real $" : "Nominal $";
    }

    function renderSummary(result) {
      var summary = result.summary;
      var medianRetirement = valueByMode(summary.medianRetirement);
      var medianFinal = valueByMode(summary.medianFinal);

      summaryNode.innerHTML = "" +
        "<div class='summary-item " + successClass(summary.successProbability) + "'><span>Probability of Success</span><strong>" + formatPercent(summary.successProbability) + "</strong></div>" +
        "<div class='summary-item'><span>Median at Retirement (" + modeText() + ")</span><strong>" + formatCurrency(medianRetirement) + "</strong></div>" +
        "<div class='summary-item'><span>Median Final Value (" + modeText() + ")</span><strong>" + formatCurrency(medianFinal) + "</strong></div>" +
        "<div class='summary-item'><span>Safe Withdrawal Rate</span><strong>" + summary.swr.toFixed(2) + "%</strong></div>";
    }

    function renderDetailStats(result) {
      var summary = result.summary;
      var finalP10 = valueByMode(summary.finalP10);
      var finalP25 = valueByMode(summary.finalP25);
      var finalP75 = valueByMode(summary.finalP75);
      var finalP90 = valueByMode(summary.finalP90);
      var ruinText = summary.medianRuinYear === null
        ? "N/A - no failures"
        : "Year " + summary.medianRuinYear.toFixed(1) + " of retirement";

      detailNode.innerHTML = "" +
        "<div class='mc-detail-item'><span>Simulations Run</span><strong>" + formatSimulationCount(summary.totalRuns) + "</strong></div>" +
        "<div class='mc-detail-item'><span>Net Annual Withdrawal (Year 1)</span><strong>" + formatCurrency(summary.netWithdrawal) + "</strong></div>" +
        "<div class='mc-detail-item'><span>Failed Simulations</span><strong>" + formatSimulationCount(summary.failedRuns) + " of " + formatSimulationCount(summary.totalRuns) + "</strong></div>" +
        "<div class='mc-detail-item'><span>Median Ruin Year</span><strong>" + ruinText + "</strong></div>" +
        "<div class='mc-detail-item'><span>10th Percentile Final (" + modeText() + ")</span><strong>" + formatCurrency(finalP10) + "</strong></div>" +
        "<div class='mc-detail-item'><span>25th Percentile Final (" + modeText() + ")</span><strong>" + formatCurrency(finalP25) + "</strong></div>" +
        "<div class='mc-detail-item'><span>75th Percentile Final (" + modeText() + ")</span><strong>" + formatCurrency(finalP75) + "</strong></div>" +
        "<div class='mc-detail-item'><span>90th Percentile Final (" + modeText() + ")</span><strong>" + formatCurrency(finalP90) + "</strong></div>";
    }

    function buildChartData(result) {
      var labels = result.percentilesByYear.map(function (row) { return row.year; });
      var p10 = [];
      var p25 = [];
      var p50 = [];
      var p75 = [];
      var p90 = [];

      result.percentilesByYear.forEach(function (row) {
        var values = rowValuesByMode(row);
        p10.push(values.p10);
        p25.push(values.p25);
        p50.push(values.p50);
        p75.push(values.p75);
        p90.push(values.p90);
      });

      return {
        labels: labels,
        datasets: [
          {
            label: "P10",
            data: p10,
            borderWidth: 0,
            pointRadius: 0,
            backgroundColor: "rgba(26, 46, 74, 0.18)"
          },
          {
            label: "P90",
            data: p90,
            borderWidth: 0,
            pointRadius: 0,
            backgroundColor: "rgba(26, 46, 74, 0.18)",
            fill: "-1"
          },
          {
            label: "P25",
            data: p25,
            borderWidth: 0,
            pointRadius: 0,
            backgroundColor: "rgba(26, 46, 74, 0.30)"
          },
          {
            label: "P75",
            data: p75,
            borderWidth: 0,
            pointRadius: 0,
            backgroundColor: "rgba(26, 46, 74, 0.30)",
            fill: "-1"
          },
          {
            label: "Median (P50)",
            data: p50,
            borderColor: "#1a2e4a",
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.15
          }
        ]
      };
    }

    function registerRetirementPlugin() {
      if (chartUnavailable || window.__mcRetirementPluginRegistered) {
        return;
      }

      window.Chart.register({
        id: "mcRetirementMarker",
        afterDatasetsDraw: function (chart, args, pluginOptions) {
          if (!pluginOptions || typeof pluginOptions.year !== "number") {
            return;
          }
          var xScale = chart.scales.x;
          var yScale = chart.scales.y;
          if (!xScale || !yScale) {
            return;
          }

          var ctx = chart.ctx;
          var x = xScale.getPixelForValue(pluginOptions.year);
          var top = yScale.top;
          var bottom = yScale.bottom;

          ctx.save();
          ctx.strokeStyle = "#3d5f8e";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#2c476d";
          ctx.font = "12px sans-serif";
          ctx.fillText("Retirement", Math.min(x + 7, chart.chartArea.right - 65), top + 14);
          ctx.restore();
        }
      });

      window.__mcRetirementPluginRegistered = true;
    }

    function renderChart(result) {
      if (chartUnavailable) {
        chartCanvas.style.display = "none";
        return;
      }

      registerRetirementPlugin();
      var chartData = buildChartData(result);

      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }

      state.chart = new window.Chart(chartCanvas.getContext("2d"), {
        type: "line",
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: "index",
            intersect: false
          },
          elements: {
            line: {
              cubicInterpolationMode: "monotone"
            }
          },
          scales: {
            x: {
              title: {
                display: true,
                text: "Year"
              },
              grid: {
                color: "rgba(44, 77, 119, 0.10)"
              }
            },
            y: {
              title: {
                display: true,
                text: "Portfolio Value ($)"
              },
              ticks: {
                callback: function (value) {
                  return formatCurrency(value);
                }
              },
              grid: {
                color: "rgba(44, 77, 119, 0.10)"
              }
            }
          },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              filter: function (item) {
                return item.datasetIndex === 4;
              },
              callbacks: {
                title: function (items) {
                  return "Year " + items[0].label;
                },
                label: function (context) {
                  var row = result.percentilesByYear[context.dataIndex];
                  var values = rowValuesByMode(row);
                  return [
                    "P10: " + formatCurrency(values.p10),
                    "P25: " + formatCurrency(values.p25),
                    "P50: " + formatCurrency(values.p50),
                    "P75: " + formatCurrency(values.p75),
                    "P90: " + formatCurrency(values.p90)
                  ];
                }
              }
            },
            mcRetirementMarker: {
              year: result.retirementYear
            }
          }
        }
      });
    }

    function buildCheckpointYears(result) {
      var checkpoints = [0, result.retirementYear];
      var endYear = result.totalYears;

      for (var plus = 5; plus <= result.inputs.yearsInRetirement; plus += 5) {
        checkpoints.push(result.retirementYear + plus);
      }

      if (checkpoints[checkpoints.length - 1] !== endYear) {
        checkpoints.push(endYear);
      }

      checkpoints = checkpoints.filter(function (year, idx, arr) {
        return year >= 0 && year <= endYear && arr.indexOf(year) === idx;
      });

      checkpoints.sort(function (a, b) {
        return a - b;
      });
      return checkpoints;
    }

    function checkpointLabel(year, retirementYear) {
      if (year === 0) {
        return "Year 0";
      }
      if (year === retirementYear) {
        return "Retirement (Year " + retirementYear + ")";
      }
      if (year > retirementYear) {
        return "+" + (year - retirementYear) + "yr";
      }
      return "Year " + year;
    }

    function renderTable(result) {
      var checkpoints = buildCheckpointYears(result);
      var headingSuffix = state.valueMode === "real" ? "Real $" : "Nominal $";
      var rows = checkpoints.map(function (year) {
        var row = result.percentilesByYear[year];
        var values = rowValuesByMode(row);
        var retirementClass = year === result.retirementYear ? " class='mc-retirement-row'" : "";
        return "<tr" + retirementClass + ">" +
          "<td>" + checkpointLabel(year, result.retirementYear) + "</td>" +
          "<td>" + formatCurrency(values.p10) + "</td>" +
          "<td>" + formatCurrency(values.p25) + "</td>" +
          "<td>" + formatCurrency(values.p50) + "</td>" +
          "<td>" + formatCurrency(values.p75) + "</td>" +
          "<td>" + formatCurrency(values.p90) + "</td>" +
          "</tr>";
      }).join("");

      tableWrap.innerHTML = "" +
        "<table class='sheet-table output-sheet mc-table'><thead><tr>" +
        "<th>Checkpoint</th><th>P10 (" + headingSuffix + ")</th><th>P25 (" + headingSuffix + ")</th><th>P50 (" + headingSuffix + ")</th><th>P75 (" + headingSuffix + ")</th><th>P90 (" + headingSuffix + ")</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table>";
    }

    function renderRunMeta(result, runtimeMs) {
      var summary = result.summary;
      var withdrawText = summary.netWithdrawal >= 0 ? "Year 1 net withdrawal" : "Year 1 net contribution";
      runMetaNode.textContent =
        formatSimulationCount(summary.totalRuns) + " simulations | " +
        "Accumulation: " + result.inputs.yearsToRetirement + " yrs | " +
        "Retirement: " + result.inputs.yearsInRetirement + " yrs | " +
        withdrawText + ": " + formatCurrency(Math.abs(summary.netWithdrawal)) + " | " +
        "Runtime: " + runtimeMs.toFixed(0) + " ms";
    }

    function renderAll(result, runtimeMs) {
      renderSummary(result);
      renderDetailStats(result);
      renderChart(result);
      renderTable(result);
      renderRunMeta(result, runtimeMs || 0);
    }

    function clearOutput() {
      state.lastResult = null;
      state.lastRuntimeMs = 0;

      summaryNode.innerHTML = "" +
        "<div class='summary-item'><span>Probability of Success</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Median at Retirement</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Median Final Value</span><strong>Run simulation</strong></div>" +
        "<div class='summary-item'><span>Safe Withdrawal Rate</span><strong>Run simulation</strong></div>";
      detailNode.innerHTML = "<div class='mc-detail-item'><span>Detailed metrics will appear after simulation.</span></div>";
      tableWrap.textContent = "Percentile table will appear here after you run simulation.";
      runMetaNode.textContent = "No simulation run yet.";

      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      } else {
        var ctx = chartCanvas.getContext("2d");
        ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
      }
    }

    function runSimulationFlow() {
      runBtn.disabled = true;
      runBtn.textContent = "Running simulations...";
      setStatus("Running " + getRawInput("mcSimulationCount") + " simulations... please wait.", "running");

      try {
        var inputs = validateInputs();
        var startedAt = window.performance ? window.performance.now() : Date.now();
        var result = runSimulation(inputs);
        var finishedAt = window.performance ? window.performance.now() : Date.now();
        var runtimeMs = Math.max(0, finishedAt - startedAt);
        state.lastResult = result;
        state.lastRuntimeMs = runtimeMs;
        renderAll(result, runtimeMs);
        setStatus("Done. " + formatSimulationCount(result.summary.totalRuns) + " simulations complete.", "success");
      } catch (err) {
        clearOutput();
        setStatus("Error: " + err.message, "error");
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run Simulation";
      }
    }

    function onModeChange(modeValue) {
      state.valueMode = modeValue;
      if (state.lastResult) {
        renderAll(state.lastResult, state.lastRuntimeMs);
      }
    }

    sampleBtn.addEventListener("click", setSampleInputs);
    runBtn.addEventListener("click", runSimulationFlow);

    [
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
    ].forEach(function (id) {
      document.getElementById(id).addEventListener("input", function () {
        if (messageNode.classList.contains("mc-status-error")) {
          setStatus("Inputs updated. Ready to run simulation again.", "neutral");
        }
      });
    });

    for (var i = 0; i < modeRadioNodes.length; i += 1) {
      modeRadioNodes[i].addEventListener("change", function (event) {
        onModeChange(event.target.value);
      });
    }

    if (chartUnavailable) {
      setStatus("Charting library did not load. Summary and table output remain available.", "error");
    } else {
      setStatus("Ready. Fill inputs and run the simulation.", "neutral");
    }

    clearOutput();
  })();
</script>
