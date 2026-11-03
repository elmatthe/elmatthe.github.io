// Statistics Canada Web Data Service client for the five Canadian CPI vectors.
//
// Called directly from the browser: WDS answers GET requests with
// Access-Control-Allow-Origin: * and needs no key (checked live on 2026-11-03 with the
// https://elmatthe.github.io origin). One request covers every vector that has
// history in a chunk of at most 120 months, like the desktop's chunking, so the full
// 1913-to-today history is 12 requests. Requests are sequential and spaced, far below
// WDS's documented 25 requests per second per IP address.
//
// Bounded retries (three attempts) for HTTP 409 (tables locked during the daily update,
// usually 00:00-08:30 Eastern), 429, 5xx and network failures; a failed chunk marks
// only its own months as unavailable, so the rest of the data is kept. Responses are
// validated (vector IDs, monthly reference periods, values, units scale) and cached in
// this page only for 30 minutes, the lifetime WDS itself sets with Cache-Control.

import { STATCAN_SERIES } from "./schema.js";
import { addMonths, monthsBetween } from "./dates.js";
import { normalizeStatcanResponse, seriesResult, DataShapeError } from "./engine.js";
import { DataError, fetchText, httpError, withRetry } from "../market-data/http.js";

export const STATCAN_WDS_BASE = "https://www150.statcan.gc.ca/t1/wds/rest";
export const CHUNK_MONTHS = 120;
const CACHE_MS = 30 * 60 * 1000;
const UPDATE_WINDOW = "Statistics Canada is updating its tables (HTTP 409; this usually happens between 00:00 and 08:30 Eastern time). Try again later.";

// Chunks of at most CHUNK_MONTHS, each listing only the vectors with history in it.
export function planStatcanRequests(start, end, series = STATCAN_SERIES) {
  const chunks = [];
  for (let from = start; from <= end; from = addMonths(from, CHUNK_MONTHS)) {
    const to = monthsBetween(from, end) > CHUNK_MONTHS ? addMonths(from, CHUNK_MONTHS - 1) : end;
    const columns = series.filter(c => !c.firstMonth || c.firstMonth <= to);
    if (columns.length) chunks.push({ start: from, end: to, columns, vectors: columns.map(c => c.sourceId) });
  }
  return chunks;
}

export const statcanUrl = (chunk, base = STATCAN_WDS_BASE) =>
  `${base}/getDataFromVectorByReferencePeriodRange?vectorIds=${chunk.vectors.join(",")}&startRefPeriod=${chunk.start}-01&endReferencePeriod=${chunk.end}-01`;

export function createStatcanClient({ fetchImpl = globalThis.fetch?.bind(globalThis), sleep, now = () => Date.now(), base = STATCAN_WDS_BASE, spacingMs = 250, retryBaseMs = 1000 } = {}) {
  const cache = new Map(); // url -> { at, body }

  async function getChunk(chunk, { signal, force }) {
    const url = statcanUrl(chunk, base);
    const hit = cache.get(url);
    if (!force && hit && now() - hit.at < CACHE_MS) return { body: hit.body, cached: true };
    const body = await withRetry(async () => {
      const res = await fetchText(url, { fetchImpl, signal, timeoutMs: 30000, maxBytes: 8 * 1024 * 1024, provider: "Statistics Canada" });
      if (res.status === 409) throw new DataError(UPDATE_WINDOW, { kind: "unavailable", status: 409, provider: "Statistics Canada" });
      if (!res.ok) throw httpError(res.status, { provider: "Statistics Canada", headers: res.headers, text: res.text });
      try { return JSON.parse(res.text); } catch (_) { throw new DataError("Statistics Canada returned a response that is not JSON.", { kind: "invalid", provider: "Statistics Canada" }); }
    }, { retries: 2, baseMs: retryBaseMs, maxDelayMs: 8000, signal, ...(sleep ? { sleep } : {}) });
    cache.set(url, { at: now(), body });
    return { body, cached: false };
  }

  // Fetches start..end for the five vectors. Never throws for a source failure: each
  // series comes back as a seriesResult whose failedRanges say which months could not
  // be retrieved and why. Throws only when cancelled.
  async function fetchRange(start, end, { signal, force = false, onProgress } = {}) {
    const chunks = planStatcanRequests(start, end);
    const acc = Object.fromEntries(STATCAN_SERIES.map(c => [c.id, { values: {}, flags: {}, failedRanges: [], revised: 0, preliminary: 0, latestRelease: null }]));
    let requests = 0;
    let cachedCount = 0;
    for (const [i, chunk] of chunks.entries()) {
      onProgress?.({ done: i, total: chunks.length, label: `Statistics Canada ${chunk.start} to ${chunk.end}` });
      let failure = null;
      try {
        const { body, cached } = await getChunk(chunk, { signal, force });
        if (cached) cachedCount += 1; else requests += 1;
        const parsed = normalizeStatcanResponse(body, chunk);
        for (const col of chunk.columns) {
          const part = parsed[col.sourceId];
          Object.assign(acc[col.id].values, part.values);
          Object.assign(acc[col.id].flags, part.flags);
          acc[col.id].revised += part.revised;
          acc[col.id].preliminary += part.preliminary;
          if (part.latestRelease && (!acc[col.id].latestRelease || part.latestRelease > acc[col.id].latestRelease)) acc[col.id].latestRelease = part.latestRelease;
        }
      } catch (error) {
        if (error?.kind === "aborted" || signal?.aborted) throw new DataError("Request cancelled.", { kind: "aborted" });
        requests += 1;
        failure = error instanceof DataShapeError
          ? { reason: "provider_error", message: `Statistics Canada returned an unexpected response (${error.message}).` }
          : error?.status === 409 || ["unavailable", "network", "timeout", "rate_limited"].includes(error?.kind)
            ? { reason: "source_unavailable", message: error.status === 409 ? UPDATE_WINDOW : `Statistics Canada could not be reached (${error.message}) after three attempts.` }
            : { reason: "provider_error", message: `Statistics Canada refused the request (${error?.message || "error"}).` };
      }
      if (failure) for (const col of chunk.columns) acc[col.id].failedRanges.push({ start: chunk.start, end: chunk.end, ...failure });
      if (i < chunks.length - 1 && !failure && spacingMs) await (sleep || (ms => new Promise(r => setTimeout(r, ms))))(spacingMs, signal);
    }
    onProgress?.({ done: chunks.length, total: chunks.length, label: "Statistics Canada" });
    const series = {};
    const retrievedAt = new Date(now()).toISOString();
    for (const col of STATCAN_SERIES) {
      const a = acc[col.id];
      const notes = [];
      const wholeRangeFailed = a.failedRanges.length && a.failedRanges.length === chunks.filter(c => c.columns.includes(col)).length;
      series[col.id] = seriesResult({
        status: wholeRangeFailed ? a.failedRanges[0].reason : a.failedRanges.length ? "partial" : "ok",
        message: a.failedRanges[0]?.message || null,
        values: a.values, flags: a.flags, failedRanges: wholeRangeFailed ? [] : a.failedRanges, notes,
        // revised / preliminary: observations Statistics Canada flags with symbol r / p.
        source: { provider: "Statistics Canada", id: col.sourceId, retrievedAt, latestRelease: a.latestRelease, revised: a.revised, preliminary: a.preliminary }, // release time in Eastern time
      });
    }
    return { series, requests, cached: cachedCount, chunks: chunks.length, retrievedAt };
  }

  return { fetchRange, clearCache: () => cache.clear(), get cacheSize() { return cache.size; } };
}
