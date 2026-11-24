// Test-only: the callers of the gateway. Requests go through a service binding, so they reach
// the Worker with their real https URL and Origin (Miniflare's own entry point would refuse
// that Origin), and a caller can really go away: aborting here reaches the gateway's
// request.signal in the real runtime. (A closed TCP connection does not fire that signal
// under local workerd; Cloudflare's own edge cannot be exercised locally.)
const ORIGIN = "https://elmatthe.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const gateway = env[url.searchParams.get("isolate")];
    const headers = { Origin: ORIGIN, "CF-Connecting-IP": url.searchParams.get("ip") };
    const target = `https://gateway.test${url.searchParams.get("path")}`;
    if (url.pathname === "/ask") return gateway.fetch(target, { headers });
    // /leave: asks, then goes away after `after` ms.
    const controller = new AbortController();
    const answer = gateway.fetch(target, { headers, signal: controller.signal }).then(response => `status ${response.status}`, error => `rejected ${error.name}`);
    await new Promise(resolve => setTimeout(resolve, Number(url.searchParams.get("after"))));
    controller.abort();
    return new Response(await answer);
  },
};
