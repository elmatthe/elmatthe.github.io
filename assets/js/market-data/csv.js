// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF) with limits.
// Used for the ECB's CSV feed and for price files a visitor imports. It never
// evaluates content; cells are plain strings.

export const MAX_CSV_BYTES = 8 * 1024 * 1024;
export const MAX_CSV_ROWS = 200000;

export function parseCsv(text, { maxBytes = MAX_CSV_BYTES, maxRows = MAX_CSV_ROWS } = {}) {
  const source = String(text ?? "").replace(/^﻿/, "");
  if (source.length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`The file has more than ${maxRows.toLocaleString("en-US")} rows.`);
      continue;
    }
    field += ch;
  }
  if (quoted) throw new Error("The file has an unterminated quoted field.");
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

// Rows -> array of objects keyed by trimmed header names.
export function csvRecords(text, options) {
  const rows = parseCsv(text, options);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(cells => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])));
  return { headers, records };
}
