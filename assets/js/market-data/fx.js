// Official exchange rates for the browser tools: Bank of Canada first, European
// Central Bank as the fallback. Both are keyless, CORS-enabled public sources.
//
// Rates are held as "CAD per one unit" fixings (CAD itself = 1) and every pair is
// derived from them: rate(from -> to) = cadPer[from] / cadPer[to]. Results carry
// the provider, the fixing date and how the pair was derived. Latest rates are
// cached for an hour (they change once per business day) and kept for a week as a
// labelled stale-if-error fallback; history is cached for 12 hours.

import { DataError } from "./http.js";
import { createCache } from "./cache.js";
import { BOC_PROVIDER, BOC_ATTRIBUTION, bocSupports, fetchLatestCadRates, fetchCadHistory, crossFromCad, crossHistory } from "./providers/boc.js";
import { ECB_PROVIDER, ECB_ATTRIBUTION, ecbSupports, fetchEcbLatestCadRates, fetchEcbCadHistory } from "./providers/ecb.js";

const HOUR = 3600000;
const SOURCES = [
  { name: BOC_PROVIDER, attribution: BOC_ATTRIBUTION, supports: bocSupports, latest: fetchLatestCadRates, history: fetchCadHistory },
  { name: ECB_PROVIDER, attribution: ECB_ATTRIBUTION, supports: ecbSupports, latest: fetchEcbLatestCadRates, history: fetchEcbCadHistory },
];

export const fxSupported = code => SOURCES.some(s => s.supports(code));

export function createFxService({ fetchImpl = (...a) => globalThis.fetch(...a), storage = null, now = () => Date.now(), sources = SOURCES } = {}) {
  const cache = createCache({ storage, prefix: "md.fx.v1:", maxEntries: 30, now });

  async function firstWorking(codes, call) {
    const failures = [];
    for (const source of sources) {
      if (!codes.every(source.supports)) { failures.push(`${source.name}: does not publish ${codes.filter(c => !source.supports(c)).join(", ")}`); continue; }
      try {
        return { data: await call(source), source, failures };
      } catch (error) {
        if (error?.kind === "aborted") throw error;
        failures.push(`${source.name}: ${error.message}`);
      }
    }
    throw new DataError(`Official exchange rates could not be retrieved (${failures.join("; ")}).`, { kind: "unavailable" });
  }

  return {
    // { cadPer, provider, attribution, retrievedAt, cached, stale, ageMs, failures }
    async latest(codes, { signal, useCache = true } = {}) {
      const wanted = [...new Set(codes.map(c => String(c).toUpperCase()))].sort();
      const key = `latest:${wanted.join(",")}`;
      const hit = cache.get(key, { freshMs: HOUR, staleMs: 7 * 24 * HOUR });
      if (useCache && hit?.fresh) return { ...hit.value, cached: true, stale: false, ageMs: hit.ageMs };
      try {
        const { data, source, failures } = await firstWorking(wanted, s => s.latest(wanted, { fetchImpl, signal }));
        const value = { cadPer: data, provider: source.name, attribution: source.attribution, retrievedAt: new Date(now()).toISOString(), failures };
        cache.set(key, value);
        return { ...value, cached: false, stale: false, ageMs: 0 };
      } catch (error) {
        if (error?.kind !== "aborted" && hit) return { ...hit.value, cached: true, stale: true, ageMs: hit.ageMs, failures: [error.message] };
        throw error;
      }
    },
    // Daily series per currency between start and end (YYYY-MM-DD).
    async history(codes, start, end, { signal } = {}) {
      const wanted = [...new Set(codes.map(c => String(c).toUpperCase()))].filter(c => c !== "CAD").sort();
      if (!wanted.length) return { series: {}, provider: null, attribution: null };
      const key = `history:${wanted.join(",")}:${start}:${end}`;
      const hit = cache.get(key, { freshMs: 12 * HOUR, staleMs: 7 * 24 * HOUR });
      if (hit?.fresh) return { ...hit.value, cached: true, stale: false };
      try {
        const { data, source } = await firstWorking(wanted, s => s.history(wanted, start, end, { fetchImpl, signal }));
        const value = { series: data, provider: source.name, attribution: source.attribution, retrievedAt: new Date(now()).toISOString() };
        cache.set(key, value);
        return { ...value, cached: false, stale: false };
      } catch (error) {
        if (error?.kind !== "aborted" && hit) return { ...hit.value, cached: true, stale: true };
        throw error;
      }
    },
    rate: (from, to, cadPer) => crossFromCad(from, to, cadPer),
    crossHistory: (from, to, series) => crossHistory(from, to, series),
    clear: () => cache.clear(),
  };
}
