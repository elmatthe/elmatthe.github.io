// Bank of Canada Valet API: official daily average exchange rates (keyless).
//
// Each FX<CODE>CAD series is "Canadian dollars per one unit of <CODE>", published
// once per Bank of Canada business day (normally by 16:30 ET). The API sends
// `Access-Control-Allow-Origin: *`, so browsers can call it directly; no proxy is
// involved. Rates between two non-CAD currencies are derived through CAD
// (e.g. EUR->USD = FXEURCAD / FXUSDCAD) and labelled as derived.
// Terms of use: https://www.bankofcanada.ca/terms/ (attribution "Bank of Canada").
//
// These are indicative daily averages, not executable market quotes; the UI says so.

import { DataError, fetchText, httpError, withRetry } from "../http.js";
import { validateFx } from "../contract.js";

export const BOC_PROVIDER = "Bank of Canada";
export const BOC_BASE = "https://www.bankofcanada.ca/valet";
export const BOC_ATTRIBUTION = "Source: Bank of Canada daily average exchange rates (indicative, published once per business day).";
// Series currently published in the FX_RATES_DAILY group (RUB and VND are discontinued).
export const BOC_CURRENCIES = ["AUD", "BRL", "CHF", "CNY", "EUR", "GBP", "HKD", "IDR", "INR", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PEN", "PLN", "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "USD", "ZAR"];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const bocSupports = code => code === "CAD" || BOC_CURRENCIES.includes(code);
const seriesId = code => `FX${code}CAD`;

export function observationsUrl(codes, { recent = null, start = null, end = null } = {}) {
  const series = [...new Set(codes)].filter(c => c !== "CAD").map(code => {
    if (!BOC_CURRENCIES.includes(code)) throw new DataError(`${code} is not published by the Bank of Canada.`, { kind: "not_found", definitive: true, provider: BOC_PROVIDER });
    return seriesId(code);
  });
  if (!series.length) return null;
  const params = new URLSearchParams();
  if (recent) params.set("recent", String(recent));
  if (start) params.set("start_date", start);
  if (end) params.set("end_date", end);
  return `${BOC_BASE}/observations/${series.join(",")}/json?${params}`;
}

// Parses a Valet observations body into { CODE: [{ date, cadPer }] } (ascending).
export function parseObservations(text, codes) {
  let payload;
  try { payload = JSON.parse(text); } catch (_) { throw new DataError("Bank of Canada response was not JSON", { kind: "invalid", provider: BOC_PROVIDER }); }
  if (!payload || !Array.isArray(payload.observations)) throw new DataError("Bank of Canada response had no observations", { kind: "invalid", provider: BOC_PROVIDER });
  const out = Object.fromEntries(codes.filter(c => c !== "CAD").map(c => [c, []]));
  for (const row of payload.observations) {
    if (!row || !ISO_DAY.test(row.d || "")) continue;
    for (const code of Object.keys(out)) {
      const cell = row[seriesId(code)];
      if (!cell || cell.v === undefined || cell.v === null || cell.v === "") continue;
      const value = Number(cell.v);
      if (!Number.isFinite(value) || value <= 0) throw new DataError(`Bank of Canada ${seriesId(code)} had an invalid value on ${row.d}`, { kind: "invalid", provider: BOC_PROVIDER });
      out[code].push({ date: row.d, cadPer: value });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

async function request(url, { fetchImpl, signal }) {
  return withRetry(async () => {
    const res = await fetchText(url, { fetchImpl, signal, provider: BOC_PROVIDER, timeoutMs: 12000 });
    if (!res.ok) throw httpError(res.status, { provider: BOC_PROVIDER, headers: res.headers, text: res.text });
    return res.text;
  }, { signal, retries: 2 });
}

// Latest published rate for each currency: { CODE: { date, cadPer } } plus CAD = 1.
export async function fetchLatestCadRates(codes, { fetchImpl, signal } = {}) {
  const wanted = [...new Set(codes)].filter(c => c !== "CAD");
  const result = { CAD: { date: null, cadPer: 1 } };
  if (!wanted.length) return result;
  const parsed = parseObservations(await request(observationsUrl(wanted, { recent: 5 }), { fetchImpl, signal }), wanted);
  for (const code of wanted) {
    const last = parsed[code][parsed[code].length - 1];
    if (!last) throw new DataError(`Bank of Canada returned no recent ${code}/CAD rate.`, { kind: "invalid", provider: BOC_PROVIDER });
    result[code] = last;
  }
  return result;
}

// Daily history { CODE: [{ date, cadPer }] } between start and end (YYYY-MM-DD).
export async function fetchCadHistory(codes, start, end, { fetchImpl, signal } = {}) {
  const wanted = [...new Set(codes)].filter(c => c !== "CAD");
  if (!wanted.length) return {};
  return parseObservations(await request(observationsUrl(wanted, { start, end }), { fetchImpl, signal }), wanted);
}

// Rate quoted as `to` units per one `from` unit from CAD-per-unit fixings.
export function crossFromCad(from, to, latest) {
  if (from === to) return { base: from, quote: to, rate: 1, date: latest[from]?.date || latest[to]?.date || null, method: "identity", series: [] };
  const a = latest[from];
  const b = latest[to];
  if (!a || !b) throw new DataError(`No Bank of Canada rate for ${from}/${to}.`, { kind: "not_found", definitive: true, provider: BOC_PROVIDER });
  const method = from === "CAD" ? "inverse" : to === "CAD" ? "direct" : "cross";
  const date = [a.date, b.date].filter(Boolean).sort()[0] || null;
  const rate = validateFx({ base: from, quote: to, rate: a.cadPer / b.cadPer, date, provider: BOC_PROVIDER, method, series: [from, to].filter(c => c !== "CAD").map(seriesId) }, BOC_PROVIDER);
  if (from !== "CAD" && to !== "CAD" && a.date !== b.date) rate.note = `${from} and ${to} fixings are from different dates (${a.date}, ${b.date}).`;
  return rate;
}

// Daily cross series for from->to on dates where both fixings exist: [{ date, rate }].
export function crossHistory(from, to, history) {
  if (from === to) return [];
  const toMap = to === "CAD" ? null : new Map((history[to] || []).map(p => [p.date, p.cadPer]));
  const fromList = from === "CAD" ? (history[to] || []).map(p => ({ date: p.date, cadPer: 1 })) : (history[from] || []);
  const out = [];
  for (const point of fromList) {
    const denominator = to === "CAD" ? 1 : toMap.get(point.date);
    if (!denominator) continue;
    out.push({ date: point.date, rate: point.cadPer / denominator });
  }
  return out;
}
