// Serves the REAL market-data gateway code (_services/market-data-gateway) on
// http://127.0.0.1:<port>, with its upstream replaced by the synthetic Yahoo fixtures
// (fixtures/yahoo-chart.mjs), for the desktop apps' tests. Nothing leaves this computer.
//
//   node gateway_server.mjs            prints "PORT <n>" once listening
//
// The gateway runs with the owner's production settings (source on by attestation,
// clients without an Origin header allowed) plus ALLOW_HTTP for loopback. A test can
// change the fixtures' behaviour with GET /__mode?<flag>=1 (down, limited, blocked,
// hang, staleDays=<n>, downFor=<SYM,SYM>, retryAfter=<header value>, off=1 for a switched-off
// source, reset=1),
// and read the upstream request count with GET /__calls. These two paths exist only
// in this test server.
import http from "node:http";
import { testGateway } from "./fixtures/local-coordinator.mjs";
import { yahooFetch } from "./fixtures/yahoo-chart.mjs";

let mode = {};
let calls = [];
let gateway = null;
const fresh = () => {
  mode = { calls };
  gateway = testGateway({ fetchImpl: yahooFetch({ mode: new Proxy({}, { get: (_, k) => mode[k], has: (_, k) => k in mode }) }), limits: { upstreamMinSpacingMs: 0, upstreamTimeoutMs: 300 } });
};
fresh();
let off = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__mode") {
    if (url.searchParams.get("reset")) { calls = []; fresh(); off = false; }
    for (const [k, v] of url.searchParams) {
      if (k === "reset") continue;
      if (k === "off") off = v === "1";
      else if (k === "downFor") mode.downFor = v.split(",").filter(Boolean);
      else if (k === "staleDays") mode.staleDays = Number(v);
      else if (k === "retryAfter") mode.retryAfter = v;
      else mode[k] = v === "1";
    }
    mode.calls = calls;
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/__calls") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(calls.length)); return; }
  const headers = { "CF-Connecting-IP": "203.0.113.50" };
  if (req.headers.origin) headers.Origin = req.headers.origin;
  const env = { ALLOWED_ORIGINS: "https://elmatthe.github.io", ALLOW_HTTP: "true", ALLOW_NO_ORIGIN: "true", ...(off ? {} : { KEYLESS_SOURCE: "yahoo-chart", OWNER_ATTESTATION: "owner-confirms-yahoo-permission" }) };
  const answer = await gateway.handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }), env);
  res.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`PORT ${server.address().port}\n`); });
