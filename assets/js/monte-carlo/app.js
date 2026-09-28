// Monte Carlo Retirement Simulator web app controller.
// Runs entirely in the browser: no network requests and no backend. The model is
// in ./engine.js and matches the desktop program (see _tools/tests/test_engine_parity.py).

import { validateInputs, runSimulation, LIMITS, ValidationError } from "./engine.js";
import { toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const root = document.getElementById("mc-app");
if (root) init();

function init() {
  const $ = id => document.getElementById(id);
  const FIELDS = ["currentPortfolio", "annualContribution", "contributionGrowth", "yearsToRetirement", "yearsInRetirement",
    "expectedReturn", "volatility", "inflation", "annualSpending", "pensionIncome", "simulations"];
  const input = field => $(`mc-${field}`);
  const state = { mode: "nominal", result: null, runtimeMs: 0, chart: null };
  const CHART = typeof window.Chart === "function";

  const money = v => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
  const count = v => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
  const pick = pair => (state.mode === "real" ? pair.real : pair.nominal);
  const unit = () => (state.mode === "real" ? "real $" : "nominal $");
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function setStatus(text, tone) {
    const node = $("mcStatus");
    node.textContent = text;
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
  }
  function clearInvalid() { FIELDS.forEach(f => input(f).removeAttribute("aria-invalid")); }

  // Randomized but plausible sample, same ranges as the desktop "Load Sample Scenario".
  function loadSample() {
    const step = (min, max, s) => Math.round((min + s * Math.round(Math.random() * Math.round((max - min) / s))) * 100) / 100;
    const values = {
      currentPortfolio: step(25000, 750000, 5000), annualContribution: step(0, 40000, 1000), contributionGrowth: step(0, 5, 0.5),
      yearsToRetirement: step(5, 40, 1), yearsInRetirement: step(15, 35, 1), expectedReturn: step(4, 9, 0.5),
      volatility: step(8, 20, 0.5), inflation: step(1.5, 3.5, 0.5), annualSpending: step(30000, 120000, 5000),
      simulations: [500, 1000, 2000][Math.floor(Math.random() * 3)],
    };
    values.pensionIncome = Math.min(step(0, 40000, 1000), values.annualSpending - 5000);
    Object.entries(values).forEach(([f, v]) => { input(f).value = String(v); });
    clearInvalid();
    setStatus("Random sample scenario loaded. Run the simulation to see results.", null);
  }

  function renderTiles(result) {
    const s = result.summary;
    const host = $("mcTiles");
    host.replaceChildren();
    const add = (label, value, cls) => { const t = el("div", null, "pj-tile"); t.append(el("span", label), el("strong", value, cls)); host.append(t); };
    add("Probability of success", `${s.successProbability.toFixed(1)}%`, s.successProbability >= 85 ? "good" : s.successProbability >= 70 ? "warn" : "bad");
    add(`Median at retirement (${unit()})`, money(pick(s.medianRetirement)));
    add(`Median final value (${unit()})`, money(pick(s.medianFinal)));
    add("Initial withdrawal rate", `${s.swr.toFixed(2)}%`);
    add("Failed simulations", `${count(s.failedRuns)} of ${count(s.totalRuns)}`);
    add("Median ruin year", s.medianRuinYear === null ? "None" : `Year ${s.medianRuinYear.toFixed(1)} of retirement`);
    add(`10th percentile final (${unit()})`, money(pick(s.finalP10)));
    add(`90th percentile final (${unit()})`, money(pick(s.finalP90)));
  }

  function checkpoints(result) {
    const years = new Set([0, result.retirementYear, result.totalYears]);
    for (let plus = 5; plus <= result.inputs.yearsInRetirement; plus += 5) years.add(result.retirementYear + plus);
    return [...years].filter(y => y >= 0 && y <= result.totalYears).sort((a, b) => a - b);
  }
  function renderTable(result) {
    const table = el("table", null, "pj-table");
    const caption = el("caption", `Portfolio value percentiles at checkpoints (${unit()})`, "muted");
    caption.style.cssText = "caption-side:top;text-align:left;padding:.5rem .75rem;";
    const head = el("thead");
    const hr = el("tr");
    ["Checkpoint", "P10", "P25", "Median", "P75", "P90"].forEach((h, i) => { const th = el("th", h, i ? "num" : ""); th.scope = "col"; hr.append(th); });
    head.append(hr);
    const body = el("tbody");
    checkpoints(result).forEach(year => {
      const row = result.percentilesByYear[year];
      const values = state.mode === "real" ? row.real : row.nominal;
      const tr = el("tr");
      const label = year === 0 ? "Today" : year === result.retirementYear ? `Retirement (year ${year})` : year > result.retirementYear ? `${year - result.retirementYear} yrs into retirement` : `Year ${year}`;
      const th = el("th", label);
      th.scope = "row";
      tr.append(th);
      ["p10", "p25", "p50", "p75", "p90"].forEach(k => tr.append(el("td", money(values[k]), "num")));
      if (year === result.retirementYear) tr.className = "mc-retirement-row";
      body.append(tr);
    });
    table.append(caption, head, body);
    $("mcTable").replaceChildren(table);
  }

  const retirementMarker = {
    id: "mcRetirementMarker",
    afterDatasetsDraw(chart, _args, options) {
      if (!options || typeof options.year !== "number") return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x.getPixelForValue(options.year);
      ctx.save();
      ctx.strokeStyle = "#9db2d2";
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#d9e3f4";
      ctx.font = "12px sans-serif";
      ctx.fillText("Retirement", Math.min(x + 6, chartArea.right - 70), chartArea.top + 14);
      ctx.restore();
    },
  };
  function renderChart(result) {
    if (!CHART) return;
    state.chart?.destroy();
    const rows = result.percentilesByYear.map(r => (state.mode === "real" ? r.real : r.nominal));
    const series = key => rows.map(r => r[key]);
    const band = "rgba(127, 177, 240, 0.16)";
    const inner = "rgba(127, 177, 240, 0.30)";
    state.chart = new window.Chart($("mcChart"), {
      type: "line",
      data: {
        labels: result.percentilesByYear.map(r => r.year),
        datasets: [
          { label: "P10", data: series("p10"), borderWidth: 0, pointRadius: 0, backgroundColor: band },
          { label: "P90", data: series("p90"), borderWidth: 0, pointRadius: 0, backgroundColor: band, fill: "-1" },
          { label: "P25", data: series("p25"), borderWidth: 0, pointRadius: 0, backgroundColor: inner },
          { label: "P75", data: series("p75"), borderWidth: 0, pointRadius: 0, backgroundColor: inner, fill: "-1" },
          { label: "Median", data: series("p50"), borderColor: "#7fb1f0", borderWidth: 2.5, pointRadius: 0, tension: 0.15 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { title: { display: true, text: "Year", color: "#9db2d2" }, ticks: { color: "#9db2d2" }, grid: { color: "rgba(127,177,240,0.08)" } },
          y: { title: { display: true, text: `Portfolio value (${unit()})`, color: "#9db2d2" }, ticks: { color: "#9db2d2", callback: v => money(v) }, grid: { color: "rgba(127,177,240,0.08)" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.datasetIndex === 4,
            callbacks: {
              title: items => `Year ${items[0].label}`,
              label: ctx => ["p10", "p25", "p50", "p75", "p90"].map(k => `${k.toUpperCase()}: ${money(rows[ctx.dataIndex][k])}`),
            },
          },
          mcRetirementMarker: { year: result.retirementYear },
        },
      },
      plugins: [retirementMarker],
    });
  }

  function renderAll() {
    const r = state.result;
    if (!r) return;
    $("mcResults").hidden = false;
    $("mcEmpty").hidden = true;
    $("mcMeta").textContent = `${count(r.summary.totalRuns)} simulations · ${r.inputs.yearsToRetirement} years saving · ${r.inputs.yearsInRetirement} years in retirement · first-year net withdrawal ${money(r.summary.netWithdrawal)} · ${state.runtimeMs.toFixed(0)} ms`;
    renderTiles(r);
    renderChart(r);
    renderTable(r);
    $("mcExportCsv").disabled = false;
  }

  function run() {
    clearInvalid();
    let inputs;
    try {
      inputs = validateInputs(Object.fromEntries(FIELDS.map(f => [f, input(f).value])));
    } catch (error) {
      if (error instanceof ValidationError && error.field) { input(error.field).setAttribute("aria-invalid", "true"); input(error.field).focus(); }
      setStatus(error.message, "error");
      return;
    }
    $("mcRun").disabled = true;
    setStatus(`Running ${count(inputs.simulations)} simulations…`, null);
    // Yield once so the status paints before the synchronous simulation runs.
    setTimeout(() => {
      try {
        const started = performance.now();
        state.result = runSimulation(inputs);
        state.runtimeMs = performance.now() - started;
        renderAll();
        setStatus(`Done. ${count(inputs.simulations)} simulations complete.`, "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        $("mcRun").disabled = false;
      }
    }, 20);
  }

  $("mcRun").addEventListener("click", run);
  $("mcForm").addEventListener("submit", event => { event.preventDefault(); run(); });
  $("mcSample").addEventListener("click", loadSample);
  root.querySelectorAll('input[name="mcMode"]').forEach(radio => radio.addEventListener("change", () => {
    state.mode = radio.value;
    renderAll();
  }));
  FIELDS.forEach(f => input(f).addEventListener("input", () => input(f).removeAttribute("aria-invalid")));
  $("mcExportCsv").addEventListener("click", () => {
    const r = state.result;
    if (!r) return;
    const rows = [
      ["Monte Carlo Retirement Simulator — browser export", new Date().toISOString()],
      ["Probability of success (%)", r.summary.successProbability],
      ["Failed simulations", r.summary.failedRuns, "of", r.summary.totalRuns],
      ["Initial withdrawal rate (%)", r.summary.swr],
      ["Inputs", ...FIELDS.map(f => `${f}=${r.inputs[f]}`)],
      [],
      ["Year", "P10 nominal", "P25 nominal", "Median nominal", "P75 nominal", "P90 nominal", "P10 real", "P25 real", "Median real", "P75 real", "P90 real"],
      ...r.percentilesByYear.map(row => [row.year, ...["p10", "p25", "p50", "p75", "p90"].map(k => row.nominal[k]), ...["p10", "p25", "p50", "p75", "p90"].map(k => row.real[k])]),
    ];
    const name = `monte-carlo-percentiles-${timestampSlug()}.csv`;
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });

  input("simulations").max = String(LIMITS.maxSimulations);
  if (!CHART) setStatus("The chart library did not load; results and tables still work.", "warn");
  else setStatus("Ready. Adjust the assumptions and run the simulation.", null);
  root.dataset.ready = "true";
}
