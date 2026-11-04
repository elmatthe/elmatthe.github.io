// Runs the browser engines under Node for the Python parity tests.
// stdin: {"tool": "monte-carlo" | "rebalancer" | "rebalancer-legacy" | "stock-analytics", "cases": [...]}
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
      if (c.validateOnly) { out.push({ ok: true, inputs, warnings: E.assumptionWarnings(inputs), first: E.firstYearWithdrawal(inputs), growth: E.typicalGrowth(inputs.expectedReturn, inputs.volatility) }); continue; }
      let i = 0;
      const z = c.z || [];
      // c.seed: the apps' own seeded generator instead of injected draws.
      const normal = c.seed !== undefined ? E.boxMuller(E.mulberry32(c.seed))
        : () => { if (i >= z.length) throw new Error("z sequence exhausted"); return z[i++]; };
      const result = E.runSimulation(inputs, { normal });
      out.push({ summary: result.summary, bands: result.percentilesByYear.map(r => r.nominal), real: result.percentilesByYear.map(r => r.real), used: c.seed !== undefined ? result.summary.draws : i, warnings: result.warnings, engineVersion: result.engineVersion, model: result.model });
    } catch (error) {
      out.push({ error: error.message, field: error.field ?? null });
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
} else if (request.tool === "stock-analytics") {
  // cases: [{ series: { TICKER: { frequency, prices: [[YYYY-MM-DD, price], ...] } }, riskFree, benchmark }]
  const A = await import(pathToFileURL(path.join(site, "assets/js/stock-dashboard/analytics.js")));
  for (const c of request.cases) {
    try {
      const histories = Object.fromEntries(Object.entries(c.series).map(([t, s]) => [t, {
        ticker: t, frequency: s.frequency || "daily", currency: "USD", priceBasis: "adjusted_close",
        observations: s.prices.map(([d, p]) => ({ date: new Date(`${d}T00:00:00Z`), price: p })),
      }]));
      const result = A.runComparison(histories, { riskFreeAnnual: c.riskFree || 0 });
      const regression = Object.keys(histories).filter(t => t !== c.benchmark)
        .map(t => ({ ticker: t, ...A.regression(result.returns[t], result.returns[c.benchmark], c.riskFree || 0, result.periodsPerYear) }));
      out.push({ metrics: result.metrics, matrix: result.matrix, counts: result.counts, regression, periodsPerYear: result.periodsPerYear, warnings: result.warnings });
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else if (request.tool === "market-data") {
  // Shared market-data behaviour, for the JS/Python parity tests (no network).
  const I = await import(pathToFileURL(path.join(site, "assets/js/market-data/instruments.js")));
  const C = await import(pathToFileURL(path.join(site, "assets/js/market-data/catalog.js")));
  const AV = await import(pathToFileURL(path.join(site, "assets/js/market-data/providers/alphavantage.js")));
  const MD = await import(pathToFileURL(path.join(site, "assets/js/market-data/index.js")));
  const R = await import(pathToFileURL(path.join(site, "assets/js/portfolio-rebalancer/rows.js")));
  const S = await import(pathToFileURL(path.join(site, "assets/js/portfolio-rebalancer/sample.js")));
  const reference = JSON.parse(fs.readFileSync(path.join(site, "assets/data/instruments.v1.json"), "utf8"));
  const resolver = I.createInstrumentResolver(reference);
  const catalog = Object.fromEntries(Object.entries(C.PROVIDERS).map(([id, p]) => [id, { name: p.name, status: p.status, plans: p.plans.map(pl => ({ id: pl.id, label: pl.label, limits: pl.limits, editable: pl.editable || null })), gaps: p.gaps }]));
  for (const c of request.cases) {
    try {
      if (c.op === "resolve") out.push(resolver.resolve(c.ticker));
      else if (c.op === "sources") {
        // The ordered source list: one pure function per case, same arguments as the Python mirror.
        const SRC = await import(pathToFileURL(path.join(site, "assets/js/market-data/sources.js")));
        const a = c.args || {};
        if (c.fn === "plan") out.push(SRC.planSources(a.ticker === null ? null : resolver.resolve(a.ticker), a.op, { priority: a.priority, platform: a.platform, state: a.state || {}, plans: Object.fromEntries(Object.keys(C.PROVIDERS).map(id => [id, C.planOf(id)])) }));
        else if (c.fn === "normalize") out.push(SRC.normalizePriority(a.saved, { platform: a.platform, configured: a.configured }));
        else if (c.fn === "migrate") out.push(SRC.migrateLegacy(a.prefs, { platform: a.platform, configured: a.configured }));
        else if (c.fn === "move") out.push(SRC.moveSource(a.priority, a.id, a.to));
        else if (c.fn === "enable") out.push(SRC.setSourceEnabled(a.priority, a.id, a.on, { configured: a.configured }));
        else if (c.fn === "key") out.push(SRC.keyChanged(a.priority, a.id, { hasKey: a.hasKey, isNew: a.isNew, configured: a.configured }));
        else if (c.fn === "short") out.push(SRC.shortFailure(a));
        else if (c.fn === "describe") out.push(SRC.describeSkipped(a.skipped, { includeOff: a.includeOff, short: a.short }));
        else if (c.fn === "info") {
          const K = await import(pathToFileURL(path.join(site, "assets/js/market-data/keyless.js")));
          out.push({ info: SRC.SOURCE_INFO, defaultOrder: SRC.DEFAULT_ORDER, offered: { browser: SRC.offeredSources("browser"), desktop: SRC.offeredSources("desktop") }, version: SRC.SOURCES_VERSION, venues: K.KEYLESS_VENUES, errors: K.GATEWAY_ERRORS, symbols: (a.tickers || []).map(t => K.keylessSymbol(resolver.resolve(t))) });
        } else throw new Error(`unknown sources fn ${c.fn}`);
      }
      else if (c.op === "catalog") out.push({ catalog, version: C.CATALOG_VERSION });
      else if (c.op === "plan") out.push(C.planOf(c.id, c.planId, c.overrides || {}));
      else if (c.op === "notice") out.push(AV.classifyAvNotice(c.text));
      else if (c.op === "compare") out.push(MD.compareQuotes(c.a, c.b));
      else if (c.op === "freshness") out.push(R.freshnessOf(c.date, c.now, c.tz));
      else if (c.op === "sample") out.push(S.SAMPLE_PORTFOLIO);
      else throw new Error(`unknown op ${c.op}`);
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else if (request.tool === "rebalancer-extras") {
  const E = await import(pathToFileURL(path.join(site, "assets/js/portfolio-rebalancer/engine.js")));
  for (const c of request.cases) {
    try {
      if (c.op === "parse") out.push(c.values.map(v => E.parseNumber(v)));
      else if (c.op === "valuation") out.push(E.assessValuation(c.rows, { acceptStale: Boolean(c.acceptStale) }));
      else if (c.op === "whole") {
        const plan = E.calculateRebalancePlan(E.attachFxValues(c.positions, c.fxToUsd, c.reportingKey), c.mode, c.budget);
        out.push({ plan, whole: E.applyWholeShares(plan) });
      } else if (c.op === "weights") out.push(E.weightWarnings(c.positions));
      else throw new Error(`unknown op ${c.op}`);
    } catch (error) {
      out.push({ error: error.message });
    }
  }
} else {
  throw new Error(`unknown tool ${request.tool}`);
}
process.stdout.write(JSON.stringify(out));
