// Cloudflare Workers entry point for the market-data gateway. All logic, limits and
// allowlists are in ./gateway.js, ./venues.js and ./yahoo-chart.js. Only a default
// export here: the Workers runtime treats every named export of the main module as an
// entry point.
import { createGateway } from "./gateway.js";

const gateway = createGateway();

export default {
  fetch: (request, env, ctx) => gateway.handle(request, env, ctx),
};
