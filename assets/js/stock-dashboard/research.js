// Analyst-consensus presentation for saved TipRanks Automation Tool research.
//
// TipRanks data needs an API key, which must never be shipped in browser code, so
// this public page never calls TipRanks. Instead it reads a Research result the
// desktop tool already saved (files/results/<id>/record.json) from the viewer's own
// disk. The file is parsed in this browser only and is never uploaded.
//
// Ported from scripts/services/deep_dive.py (implied move, target chart rules,
// rank-first analyst ordering) and scripts/services/result_store.py (schema
// validation, credential rejection, legacy unit presentation copies).

export const SCHEMA_VERSION = 3;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);
const LEGACY_ANALYST_PERCENTAGE_POINT_SCHEMAS = new Set([1, 2]);
export const UNIT_CONTRACT = {
  dividend_yield: "decimal_fraction",
  analyst_success_rate: "decimal_fraction",
  analyst_average_return: "decimal_fraction",
};
const LEGACY_ANALYST_WARNING = "Analyst average return was converted from legacy TipRanks percentage points to the " +
  "current decimal-fraction presentation contract; the saved historical file is unchanged.";
const LEGACY_DIVIDEND_WARNING = "Dividend yield is unavailable for this legacy saved result because its stored unit " +
  "cannot be proven. Other historical fields are unchanged.";
const REQUIRED = ["schema_version", "result_id", "ticker", "asset_type", "status", "retry_of", "requested_at",
  "completed_at", "planned_calls", "planned_call_count", "actual_metered_calls", "history_eligible", "result"];
const FORBIDDEN = /(TIPRANKS_API_KEY|api[_-]?key\s*=|Authorization\s*:|Bearer\s+[A-Za-z0-9]|mcp\.tipranks\.com\/mcp\/\?api)/i;
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export class RecordError extends Error {
  constructor(message) { super(message); this.name = "RecordError"; }
}

const isNumber = value => typeof value === "number" && Number.isFinite(value);
const clone = value => JSON.parse(JSON.stringify(value));

// Validates a parsed record.json and returns a presentation copy (never mutates input).
export function presentRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new RecordError("The file is not a saved Research record.");
  const missing = REQUIRED.filter(key => !(key in record));
  if (missing.length) throw new RecordError(`The file is not a saved Research record (missing ${missing.slice(0, 3).join(", ")}).`);
  const version = record.schema_version;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) throw new RecordError(`Unsupported record schema version ${String(version).slice(0, 10)}.`);
  if (!["completed", "partial"].includes(record.status) || record.history_eligible !== true) {
    throw new RecordError(`This record's status is "${String(record.status).slice(0, 20)}"; only completed or partial research can be displayed.`);
  }
  if (!record.result || typeof record.result !== "object") throw new RecordError("The record has no result section.");
  if (FORBIDDEN.test(JSON.stringify(record))) {
    throw new RecordError("The file appears to contain authentication material and was not displayed. Remove credentials before sharing research files.");
  }
  const view = clone(record);
  const result = view.result;
  result.warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (LEGACY_ANALYST_PERCENTAGE_POINT_SCHEMAS.has(version)) {
    for (const row of result.analyst_actions || []) {
      if (isNumber(row.average_return)) row.average_return /= 100;
    }
    if (!result.warnings.includes(LEGACY_ANALYST_WARNING)) result.warnings.push(LEGACY_ANALYST_WARNING);
  }
  if (version === 1) {
    if (result.generic_market && "dividend_yield" in result.generic_market) result.generic_market.dividend_yield = null;
    for (const comparison of result.source_comparison || []) {
      if (comparison.field === "dividend_yield") { comparison.values = []; comparison.different = false; }
    }
    if (!result.warnings.includes(LEGACY_DIVIDEND_WARNING)) result.warnings.push(LEGACY_DIVIDEND_WARNING);
  }
  result.unit_contract = { ...UNIT_CONTRACT };
  return view;
}

export function parseRecordText(text) {
  if (typeof text !== "string" || !text.trim()) throw new RecordError("The file is empty.");
  if (text.length > MAX_RECORD_BYTES) throw new RecordError("The file is larger than 2 MB and was not read.");
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw new RecordError("The file is not valid JSON."); }
  return presentRecord(parsed);
}

// (average target - current price) / current price x 100
export function impliedMove(current, target) {
  if (!isNumber(current) || current <= 0 || !isNumber(target)) return null;
  return (target - current) / current * 100;
}

export function targetChart(current, targets = {}) {
  const { low, average, high } = targets;
  const ordered = [low, average, high].every(isNumber) && low <= average && average <= high;
  const available = Boolean(ordered && isNumber(current) && current > 0);
  return {
    available, current, low, average, high,
    message: available ? null : "Valid ordered low/average/high targets and current price are required.",
  };
}

function rank(row) {
  const value = row?.rank;
  return isNumber(value) && value > 0 ? value : Infinity;
}

// Presentation order: best (lowest) TipRanks rank first, then newest, then name/firm.
export function sortAnalystActions(rows) {
  return [...(rows || [])].sort((a, b) => (rank(a) - rank(b)) ||
    String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
    String(a.analyst ?? "").localeCompare(String(b.analyst ?? "")) ||
    String(a.firm ?? "").localeCompare(String(b.firm ?? "")));
}

export function topAnalystInsights(rows, limit = 5) {
  return sortAnalystActions(rows).filter(row => rank(row) !== Infinity).slice(0, limit);
}

export function analystRankLabel(row) {
  if (rank(row) === Infinity) return "Unavailable";
  return isNumber(row.ranked_experts) ? `#${row.rank} of ${row.ranked_experts.toLocaleString()}` : `#${row.rank}`;
}

export function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch (_) {
    return null;
  }
}

// Builds the view model the Research tab renders: the saved TipRanks snapshot plus an
// optional live Yahoo Finance quote for the same ticker.
export function buildResearchView(record, live) {
  const result = record.result;
  const targets = result.targets || {};
  const savedCurrent = isNumber(result.current_price) ? result.current_price : null;
  const livePrice = live && isNumber(live.market?.price) ? live.market.price : null;
  const current = livePrice ?? savedCurrent;
  const comparisons = (result.source_comparison || []).map(item => ({ ...item, values: [...(item.values || [])] }));
  if (livePrice !== null) {
    let priceRow = comparisons.find(item => item.field === "price");
    if (!priceRow) { priceRow = { field: "price", values: [], different: false }; comparisons.unshift(priceRow); }
    priceRow.values.push({ source: "Yahoo Finance (live)", value: livePrice, retrieved_at: live.retrievedAt });
    const numeric = priceRow.values.map(v => v.value).filter(isNumber);
    priceRow.different = numeric.length > 1 && numeric.some(v => Math.abs(v - numeric[0]) > Math.abs(numeric[0]) * 1e-6);
  }
  return {
    ticker: record.ticker,
    assetType: record.asset_type,
    status: record.status,
    completedAt: record.completed_at,
    meteredCalls: record.actual_metered_calls,
    synthetic: Boolean(record.synthetic_demo),
    identity: result.identity || {},
    identitySources: result.identity_source_labels || {},
    market: result.generic_market || {},
    smartScore: result.smart_score ?? null,
    consensus: result.analyst_consensus ?? null,
    targets,
    savedCurrent,
    savedCurrentSource: result.current_price_source || "Unavailable",
    livePrice,
    current,
    currentSource: livePrice !== null ? "Yahoo Finance (live)" : `${result.current_price_source || "Saved"} (saved)`,
    savedImpliedMove: isNumber(result.implied_move_percent) ? result.implied_move_percent : impliedMove(savedCurrent, targets.average),
    liveImpliedMove: livePrice !== null ? impliedMove(livePrice, targets.average) : null,
    chart: targetChart(current, targets),
    distribution: (result.target_distribution?.observations || []).filter(isNumber),
    analysts: sortAnalystActions(result.analyst_actions),
    topAnalysts: topAnalystInsights(result.analyst_actions),
    insiders: result.insider_activity || [],
    news: result.news || [],
    comparisons,
    coverage: result.coverage || [],
    provenance: result.provenance || [],
    warnings: [...(result.warnings || [])],
    errors: result.errors || [],
    partial: Boolean(result.partial),
  };
}
