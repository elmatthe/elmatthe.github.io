// Cloudflare Workers entry point for the market-data gateway. All logic, limits and
// allowlists are in ./gateway.js, ./coordinator.js, ./venues.js and ./yahoo-chart.js.
// The Workers runtime treats every named export of the main module as an entry point: the
// only named export is the Durable Object class, which must be exported from here.
import { DurableObject } from "cloudflare:workers";
import { createGateway } from "./gateway.js";
import { UpstreamCoordinatorCore, sqlStorage } from "./coordinator.js";

const gateway = createGateway();

// One object worldwide (env.UPSTREAM_COORDINATOR.getByName("yahoo-chart")): the only code
// that contacts the data source. It reads UPSTREAM_INCIDENT_APPROVAL from its own env, once,
// when it starts; no caller can supply it.
export class UpstreamCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new UpstreamCoordinatorCore({ storage: sqlStorage(ctx.storage), env, now: () => this.clock() });
    // The object's start (M4): migrate, bind the incident and evaluate the owner's approval before
    // any request is delivered, including a Data Studio query while the source is off. It runs
    // once construction has finished. A failure leaves the instance unverified: every request is
    // refused and the next request tries again.
    ctx.blockConcurrencyWhile(async () => {
      await null;
      try { this.core.initialize(); } catch (_) { /* unverified; see ready() and status() */ }
    });
  }
  clock() { return Date.now(); }
  fetchChart(request) { return this.core.fetchChart(request); }
  cancel(client) { this.core.cancel(client); }
  status() { return this.core.status(); }
}

export default {
  fetch: (request, env, ctx) => gateway.handle(request, env, ctx),
};
