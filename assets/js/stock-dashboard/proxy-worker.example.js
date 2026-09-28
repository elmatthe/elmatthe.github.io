// Optional: a personal CORS proxy for the Stock Comparison dashboard.
//
// Public CORS proxies are rate-limited and change their terms without notice. For
// reliable live data, deploy this as a Cloudflare Worker (free plan is enough),
// then paste  https://<your-worker>.workers.dev/?url={url}  into the dashboard's
// Settings -> "Custom proxy URL template".
//
// It only forwards GET requests for Yahoo Finance chart data, only for the
// origins listed below, so it cannot be used as an open proxy.

const ALLOWED_ORIGINS = ["https://elmatthe.github.io", "http://127.0.0.1:4000", "http://localhost:4000"];
const ALLOWED_TARGET = /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/[^/?#]{1,30}\?/;

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = { "Access-Control-Allow-Origin": allowOrigin, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" || !ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Forbidden", { status: 403, headers: cors });
    }
    const target = new URL(request.url).searchParams.get("url") || "";
    if (!ALLOWED_TARGET.test(target)) return new Response("Target not allowed", { status: 400, headers: cors });
    const upstream = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-dashboard-proxy)", Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  },
};
