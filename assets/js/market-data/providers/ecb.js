// European Central Bank data API: euro foreign exchange reference rates (keyless).
//
// Series EXR.D.<CUR>.EUR.SP00.A = <CUR> units per one euro, published around
// 16:00 CET on TARGET working days. The API sends `Access-Control-Allow-Origin: *`.
// Used as the fallback when the Bank of Canada cannot be reached. Rates are
// converted to "CAD per unit" form (CAD-per-EUR / CUR-per-EUR) so both official
// sources feed the same cross-rate code; the conversion is recorded as derived.
// Reuse terms: https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html
// (the ECB must be cited as the source; changes must be stated).

import { DataError, fetchText, httpError, withRetry } from "../http.js";
import { csvRecords } from "../csv.js";

export const ECB_PROVIDER = "European Central Bank";
export const ECB_BASE = "https://data-api.ecb.europa.eu/service/data/EXR";
export const ECB_ATTRIBUTION = "Source: European Central Bank euro reference rates (published around 16:00 CET on TARGET working days); non-euro crosses are derived.";
export const ECB_CURRENCIES = ["AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"];

export const ecbSupports = code => code === "EUR" || ECB_CURRENCIES.includes(code);

export function ecbUrl(codes, { last = null, start = null, end = null } = {}) {
  const list = [...new Set([...codes.filter(c => c !== "EUR"), "CAD"])];
  for (const code of list) {
    if (!ECB_CURRENCIES.includes(code)) throw new DataError(`${code} is not published by the ECB.`, { kind: "not_found", definitive: true, provider: ECB_PROVIDER });
  }
  const params = new URLSearchParams({ format: "csvdata" });
  if (last) params.set("lastNObservations", String(last));
  if (start) params.set("startPeriod", start);
  if (end) params.set("endPeriod", end);
  return `${ECB_BASE}/D.${list.sort().join("+")}.EUR.SP00.A?${params}`;
}

// CSV body -> { CUR: [{ date, perEur }] } ascending.
export function parseEcbCsv(text) {
  const { headers, records } = csvRecords(text);
  if (!headers.includes("CURRENCY") || !headers.includes("TIME_PERIOD") || !headers.includes("OBS_VALUE")) {
    throw new DataError("ECB response was not the expected CSV", { kind: "invalid", provider: ECB_PROVIDER });
  }
  const out = {};
  for (const r of records) {
    if (r.CURRENCY_DENOM && r.CURRENCY_DENOM !== "EUR") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.TIME_PERIOD) || r.OBS_VALUE === "" || r.OBS_VALUE === "NaN") continue;
    const value = Number(r.OBS_VALUE);
    if (!Number.isFinite(value) || value <= 0) throw new DataError(`ECB ${r.CURRENCY} had an invalid value on ${r.TIME_PERIOD}`, { kind: "invalid", provider: ECB_PROVIDER });
    (out[r.CURRENCY] ||= []).push({ date: r.TIME_PERIOD, perEur: value });
  }
  for (const list of Object.values(out)) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// { CUR: [{date, perEur}] } -> { CUR: [{date, cadPer}] } on dates where CAD exists.
export function toCadPer(perEurSeries) {
  const cad = new Map((perEurSeries.CAD || []).map(p => [p.date, p.perEur]));
  const out = { EUR: [...cad].map(([date, cadPerEur]) => ({ date, cadPer: cadPerEur })) };
  for (const [code, list] of Object.entries(perEurSeries)) {
    if (code === "CAD") continue;
    out[code] = list.filter(p => cad.has(p.date)).map(p => ({ date: p.date, cadPer: cad.get(p.date) / p.perEur }));
  }
  return out;
}

async function request(url, { fetchImpl, signal }) {
  return withRetry(async () => {
    const res = await fetchText(url, { fetchImpl, signal, provider: ECB_PROVIDER, timeoutMs: 12000, headers: { Accept: "text/csv" } });
    if (!res.ok) throw httpError(res.status, { provider: ECB_PROVIDER, headers: res.headers, text: res.text });
    return res.text;
  }, { signal, retries: 1 });
}

export async function fetchEcbLatestCadRates(codes, { fetchImpl, signal } = {}) {
  const wanted = [...new Set(codes)].filter(c => c !== "CAD");
  const series = toCadPer(parseEcbCsv(await request(ecbUrl(wanted, { last: 5 }), { fetchImpl, signal })));
  const result = { CAD: { date: null, cadPer: 1 } };
  for (const code of wanted) {
    const last = series[code]?.[series[code].length - 1];
    if (!last) throw new DataError(`ECB returned no recent ${code} rate.`, { kind: "invalid", provider: ECB_PROVIDER });
    result[code] = last;
  }
  return result;
}

export async function fetchEcbCadHistory(codes, start, end, { fetchImpl, signal } = {}) {
  const wanted = [...new Set(codes)].filter(c => c !== "CAD");
  if (!wanted.length) return {};
  const series = toCadPer(parseEcbCsv(await request(ecbUrl(wanted, { start, end }), { fetchImpl, signal })));
  return Object.fromEntries(wanted.map(code => [code, series[code] || []]));
}
