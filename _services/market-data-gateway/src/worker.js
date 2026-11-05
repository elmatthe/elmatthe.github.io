// Cloudflare Workers entry point for the market-data gateway. All logic, limits and
// allowlists are in ./gateway.js, ./coordinator.js, ./venues.js and ./yahoo-chart.js.
// The Workers runtime treats every named export of the main module as an entry point: the
// only named export is the Durable Object class, which must be exported from here.
import { DurableObject } from "cloudflare:workers";
import { createGateway } from "./gateway.js";
import { UpstreamCoordinatorCore, sqlStorage } from "./coordinator.js";

const gateway = createGateway();

// One object worldwide (env.UPSTREAM_COORDINATOR.getByName("yahoo-chart")): the only code
// that contacts the data source. It reads UPSTREAM_REACTIVATION_ID from its own env; no
// caller can supply it.
export class UpstreamCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new UpstreamCoordinatorCore({ storage: sqlStorage(ctx.storage), env, now: () => this.clock() });
  }
  clock() { return Date.now(); }
  fetchChart(request) { return this.core.fetchChart(request); }
  cancel(client) { this.core.cancel(client); }
  status() { return this.core.status(); }
}

export default {
  fetch: (request, env, ctx) => gateway.handle(request, env, ctx),
};
