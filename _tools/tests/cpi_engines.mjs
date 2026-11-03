// Node bridge for _tools/tests/test_cpi_parity.py: runs the browser CPI code (schema,
// dates, engine, the Statistics Canada client, the FRED client AND the real data
// gateway module) against the deterministic source fixture, with no network.
//
// stdin:  { "op": "schema" | "gateway" | "dates" | "reduce" | "csv", ... }
// stdout: JSON
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = rel => import(pathToFileURL(path.join(root, rel)));
const S = await load("assets/js/cpi/schema.js");
const D = await load("assets/js/cpi/dates.js");
const E = await load("assets/js/cpi/engine.js");
const { createStatcanClient } = await load("assets/js/cpi/statcan.js");
const { createFredClient } = await load("assets/js/cpi/fred.js");
const G = await load("_services/cpi-data-gateway/src/gateway.js");

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const localDate = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const KEY = "parityparity0123456789parityxx01";

async function csvFor(fixture, start, end) {
  const today = localDate(fixture.today);
  const statcanFetch = async url => {
    const u = new URL(url);
    const vectors = u.searchParams.get("vectorIds").split(",");
    const from = u.searchParams.get("startRefPeriod").slice(0, 7);
    const to = u.searchParams.get("endReferencePeriod").slice(0, 7);
    const body = vectors.map(v => ({ status: "SUCCESS", object: { responseStatusCode: 0, vectorId: Number(v), vectorDataPoint: (fixture.statcan[v] || []).filter(p => p.refPer.slice(0, 7) >= from && p.refPer.slice(0, 7) <= to) } }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fredUpstream = async url => {
    const u = new URL(url);
    const series = u.searchParams.get("series_id");
    const from = u.searchParams.get("observation_start");
    const to = u.searchParams.get("observation_end");
    const obs = (fixture.fred[series] || []).filter(o => o.date >= from && o.date <= to);
    return new Response(JSON.stringify({ realtime_start: fixture.today, realtime_end: fixture.today, observation_start: from, observation_end: to, count: obs.length, offset: 0, limit: 100000, observations: obs }), { status: 200 });
  };
  const gateway = G.createGateway({ fetchImpl: fredUpstream, now: () => Date.parse(`${fixture.today}T15:00:00Z`), log: () => {} });
  const env = { ALLOWED_ORIGINS: "https://elmatthe.github.io" };
  const gatewayFetch = async (url, init = {}) => gateway.handle(new Request(url, { method: init.method || "GET", headers: { ...init.headers, Origin: "https://elmatthe.github.io", "CF-Connecting-IP": "203.0.113.10" }, body: init.body }), env);
  const sc = await createStatcanClient({ fetchImpl: statcanFetch, sleep: async () => {}, spacingMs: 0 }).fetchRange(start, end);
  const fr = await createFredClient({ gatewayUrl: "https://cpi-data-gateway.parity.workers.dev", fetchImpl: gatewayFetch, sleep: async () => {} }).fetchRange(start, end, KEY, { today });
  const seriesById = { ...sc.series, ...fr.series };
  for (const c of S.SERIES) seriesById[c.id] = E.flagEmptyHistory(seriesById[c.id], c, start, end, { today });
  const failed = S.SERIES.filter(c => !["ok", "partial"].includes(seriesById[c.id].status)).map(c => `${c.id}:${seriesById[c.id].status}:${seriesById[c.id].message}`);
  const ds = E.buildDataset({ start, end, seriesById, today });
  return { csv: E.toCsv(ds), failed, statcanRequests: sc.requests, gatewayRequests: fr.requests };
}

let out;
if (request.op === "schema") out = { columns: S.COLUMNS, groups: S.GROUPS, minMonth: S.MIN_MONTH };
else if (request.op === "gateway") out = { series: G.SERIES, limits: G.LIMITS, url: G.FRED_OBSERVATIONS_URL };
else if (request.op === "dates") {
  out = request.cases.map(c => {
    try { const r = D.parseMonths(c.mode, c.y, c.m, c.y2, c.m2, { today: localDate(request.today) }); return { start: r.start, end: r.end }; }
    catch (error) { return { error: error.message }; }
  });
} else if (request.op === "reduce") {
  out = request.cases.map(rows => { try { return E.reduceDailyEom(rows); } catch (error) { return { error: error.message }; } });
} else if (request.op === "csv") {
  const fixture = JSON.parse(fs.readFileSync(request.fixture, "utf8"));
  out = [];
  for (const c of request.cases) out.push(await csvFor(fixture, c.start, c.end));
} else throw new Error(`unknown op ${request.op}`);
process.stdout.write(JSON.stringify(out));
