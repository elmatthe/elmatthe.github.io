// Runs the browser engines under Node for the Python parity tests.
// stdin: {"tool": "monte-carlo" | "rebalancer" | "rebalancer-legacy", "cases": [...]}
// stdout: JSON array of results (or {"error": message} per case).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..", "..");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const out = [];

if (request.tool === "monte-carlo") {
  const E = await import(pathToFileURL(path.join(site, "assets/js/monte-carlo/engine.js")));
  for (const c of request.cases) {
    try {
      const inputs = E.validateInputs(c.raw);
      let i = 0;
      const z = c.z || [];
      const result = E.runSimulation(inputs, { normal: () => { if (i >= z.length) throw new Error("z sequence exhausted"); return z[i++]; } });
      out.push({ summary: result.summary, bands: result.percentilesByYear.map(r => r.nominal), used: i });
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else if (request.tool === "rebalancer") {
  const E = await import(pathToFileURL(path.join(site, "assets/js/portfolio-rebalancer/engine.js")));
  for (const c of request.cases) {
    try {
      const enriched = E.attachFxValues(c.positions, c.fxToUsd, c.reportingKey);
      out.push(E.calculateRebalancePlan(enriched, c.mode, c.budget));
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else if (request.tool === "rebalancer-legacy") {
  // The pre-refactor inline browser implementation, extracted from git history.
  const source = request.source;
  const start = source.indexOf("    function calculateRebalancePlan(");
  const end = source.indexOf("    function buildResultTable(");
  const body = source.slice(start, end);
  for (const c of request.cases) {
    try {
      const fx = key => c.fxToUsd[key] / c.fxToUsd[c.reportingKey];
      const factory = new Function("HOLD_THRESHOLD_PCT", "getFxToReporting", "formatCurrency", `${body}\nreturn calculateRebalancePlan;`);
      const calc = factory(0.0001, fx, v => `$${v.toFixed(2)}`);
      const enriched = c.positions.map(p => ({
        ...p, fxToReporting: fx(p.currencyKey), currentValueLocal: p.shares * p.price,
        currentValue: p.shares * p.price * fx(p.currencyKey), currencyLabel: p.currencyKey,
      }));
      out.push(calc(enriched, c.mode, c.budget));
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else {
  throw new Error(`unknown tool ${request.tool}`);
}
process.stdout.write(JSON.stringify(out));
