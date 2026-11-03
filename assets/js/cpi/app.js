// CPI Web Scraper web app controller (decisions 1A, 3A and 4A).
//
// Data flow: the five Canadian series come straight from Statistics Canada's Web Data
// Service (no key); the thirteen US series come from FRED through the owner's data
// gateway, only when the visitor enters their own FRED key and the gateway is
// configured for this site. The full dataset is kept in memory; the page renders only
// the twelve months and the group being viewed; the CSV always contains every
// requested month in the nineteen A:S columns of the desktop CPI_Downloader sheet.
//
// Privacy: the FRED key is held in memory (or, if the visitor ticks the box, in this
// tab's sessionStorage) and is sent only in the POST body to the gateway. Nothing about
// the request is stored except Statistics Canada answers, in this page's memory for
// 30 minutes.

import { COLUMNS, SERIES, GROUPS, FRED_SERIES, STATCAN_SERIES, byId } from "./schema.js";
import { addMonths, currentMonth, parseMonths } from "./dates.js";
import * as E from "./engine.js";
import { createStatcanClient } from "./statcan.js";
import { createFredClient, resolveGateway, validFredKey } from "./fred.js";
import { downloadBlob } from "../shared/export-files.js";

const KEY_SLOT = "cpi.fredKey.v1";
const SHORT = {
  no_key: "No FRED key", gateway_unavailable: "Gateway unavailable", gateway_not_configured: "No gateway yet",
  not_published: "Not published", before_start: "Before series", incomplete_month: "Month not over",
  source_unavailable: "Unavailable", restricted: "Restricted", provider_error: "Source error",
  key_rejected: "Key rejected", missing: "No value", cancelled: "Not fetched",
};
const LONG = {
  no_key: "The US columns (G–S) need your FRED key; none was entered for this fetch.",
  gateway_unavailable: "The data gateway that relays FRED requests could not be reached, or refused this page.",
  gateway_not_configured: "This site has no data gateway configured yet, so FRED cannot be reached from the browser. Use the desktop tool for the US columns.",
  not_published: "After the latest month the source has published (for example the current month's CPI before its release).",
  before_start: "Before the series begins, or (S&P 500) before the roughly ten years FRED publishes.",
  incomplete_month: "The current month is not over: end-of-month values (DFF, S&P 500, 10Y–2Y) are left blank so a mid-month value is never shown as month-end.",
  source_unavailable: "The source was temporarily unavailable after three attempts (for example Statistics Canada's overnight update, HTTP 409, or a rate limit). Try again later.",
  restricted: "Restricted: suppressed by Statistics Canada (x) or switched off by the gateway operator.",
  provider_error: "The source answered with something unexpected, so the values were not used.",
  key_rejected: "FRED rejected the key. Check it at fred.stlouisfed.org (API Keys).",
  missing: "The source has no observation for this month inside the series' history.",
  cancelled: "Not fetched (cancelled).",
};
const unitsShort = c => (c.units.startsWith("Index") ? "index" : c.units.startsWith("Percentage points") ? "pp" : "%");

const root = document.getElementById("cpi-app");
if (root) init();

function init() {
  const $ = id => document.getElementById(id);
  const statcan = createStatcanClient();
  const fred = createFredClient({ gatewayUrl: resolveGateway(root.dataset.gateway, location) });
  const state = { dataset: null, stats: null, group: "canada", page: 1, controller: null, run: null, fredOutcome: null };
  const els = {
    year: $("cpiYear"), month: $("cpiMonth"), year2: $("cpiYear2"), month2: $("cpiMonth2"),
    key: $("cpiKey"), keep: $("cpiKeepKey"), status: $("cpiStatus"), results: $("cpiResults"),
    fetch: $("cpiFetch"), cancel: $("cpiCancel"), csv: $("cpiCsv"), panel: $("cpiPanel"), tabs: $("cpiTabs"),
  };

  /* ---------------- helpers ---------------- */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function setStatus(text, tone) {
    els.status.textContent = text;
    if (tone) els.status.dataset.tone = tone; else delete els.status.dataset.tone;
  }
  const mode = () => document.querySelector('input[name="cpiMode"]:checked').value;
  const count = n => n.toLocaleString("en-CA");
  const localTime = iso => (iso ? new Date(iso).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

  /* ---------------- months ---------------- */
  function syncMode() {
    const range = mode() === "range";
    document.querySelectorAll(".cpi-end").forEach(n => { n.hidden = !range; });
    $("cpiYearL").textContent = range ? "Start Year (YYYY)" : "Year (YYYY)";
    $("cpiMonthL").textContent = range ? "Start Month (1–12)" : "Month (1–12)";
    if (range && !els.year2.value && !els.month2.value) { els.year2.value = els.year.value; els.month2.value = els.month.value; }
  }
  function prefill() {
    const last = addMonths(currentMonth(), -1);
    els.year.value = last.slice(0, 4);
    els.month.value = String(Number(last.slice(5)));
    els.year2.value = "";
    els.month2.value = "";
  }
  document.querySelectorAll('input[name="cpiMode"]').forEach(r => r.addEventListener("change", syncMode));

  /* ---------------- key ---------------- */
  function storeKey() {
    try {
      if (els.keep.checked && validFredKey(els.key.value.trim())) sessionStorage.setItem(KEY_SLOT, els.key.value.trim());
      else sessionStorage.removeItem(KEY_SLOT);
    } catch (_) { /* storage unavailable: the key stays in memory only */ }
  }
  function renderFredSource() {
    const badge = $("cpiFredBadge");
    const text = $("cpiFredText");
    const key = els.key.value.trim();
    els.key.disabled = !fred.configured;
    els.keep.disabled = !fred.configured;
    let tone = "";
    let label;
    let detail;
    if (!fred.configured) {
      tone = "warn"; label = "Gateway not configured";
      detail = "Columns G–S need your FRED key and the data gateway, which this site has not configured yet. The Canadian columns work without them; the US columns stay blank, with the reason shown. The desktop tool fetches them with your key.";
    } else if (state.fredOutcome === "gateway_unavailable") {
      tone = "error"; label = "Gateway unavailable";
      detail = "The data gateway could not be reached on the last fetch. The Canadian columns were kept; try again later.";
    } else if (state.fredOutcome === "key_rejected") {
      tone = "error"; label = "Key rejected";
      detail = "FRED rejected the key on the last fetch. Check it at fred.stlouisfed.org (My Account → API Keys).";
    } else if (!key) {
      label = "Needs your FRED key";
      detail = `Optional: enter your own FRED key to fill columns G–S. Without it you get a Canadian-only dataset (all 19 columns in the CSV, the US ones blank). Requests go through the data gateway at ${new URL(fred.base).host}.`;
    } else if (!validFredKey(key)) {
      tone = "error"; label = "Not a FRED key";
      detail = "A FRED API key is 32 lower-case letters and digits.";
    } else {
      tone = "ok"; label = "Ready with your key";
      detail = `Columns G–S: thirteen US series, fetched with your key through the data gateway at ${new URL(fred.base).host}.`;
    }
    badge.textContent = label;
    if (tone) badge.dataset.tone = tone; else delete badge.dataset.tone;
    text.textContent = detail;
  }
  els.key.addEventListener("input", () => { $("cpiKeyError").textContent = ""; els.key.removeAttribute("aria-invalid"); state.fredOutcome = null; storeKey(); renderFredSource(); });
  els.keep.addEventListener("change", () => { storeKey(); });
  $("cpiForgetKey").addEventListener("click", () => {
    els.key.value = "";
    els.keep.checked = false;
    storeKey();
    state.fredOutcome = null;
    renderFredSource();
    setStatus("FRED key removed from this page.", null);
  });

  /* ---------------- fetch ---------------- */
  function busy(on) {
    root.setAttribute("aria-busy", String(on));
    els.fetch.disabled = on;
    els.cancel.disabled = !on;
    $("cpiProgress").hidden = !on;
  }
  function progress(parts) {
    const done = parts.reduce((s, p) => s + (p?.done || 0), 0);
    const total = parts.reduce((s, p) => s + (p?.total || 0), 0);
    $("cpiProgressBar").value = total ? Math.round((done / total) * 100) : 0;
    $("cpiProgressText").textContent = parts.filter(Boolean).map(p => `${p.name}: ${p.done} of ${p.total} requests`).join(" · ");
  }

  async function fetchData() {
    $("cpiDateError").textContent = "";
    $("cpiKeyError").textContent = "";
    [els.year, els.month, els.year2, els.month2, els.key].forEach(i => i.removeAttribute("aria-invalid"));
    let range;
    try {
      range = parseMonths(mode(), els.year.value, els.month.value, els.year2.value, els.month2.value);
    } catch (error) {
      $("cpiDateError").textContent = error.message;
      const which = /end month/.test(error.message) ? [els.year2, els.month2] : /start month|month as/.test(error.message) ? [els.year, els.month] : [els.year, els.month, els.year2, els.month2];
      which.forEach(i => i.setAttribute("aria-invalid", "true"));
      setStatus(`Not fetched: ${error.message}`, "error");
      return;
    }
    const key = els.key.value.trim();
    if (key && !validFredKey(key)) {
      $("cpiKeyError").textContent = "That is not a FRED API key: it should be 32 lower-case letters and digits. Fix it, or remove it to fetch the Canadian columns only.";
      els.key.setAttribute("aria-invalid", "true");
      setStatus("Not fetched: the FRED key is not valid.", "error");
      return;
    }
    const useFred = Boolean(key) && fred.configured;
    const fredReason = !fred.configured ? "gateway_not_configured" : !key ? "no_key" : null;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const signal = controller.signal;
    busy(true);
    const parts = [{ name: "Statistics Canada", done: 0, total: 1 }, useFred ? { name: "FRED", done: 0, total: 1 } : null];
    progress(parts);
    setStatus(`Fetching ${range.start === range.end ? range.start : `${range.start} to ${range.end}`}…`, null);
    try {
      const [sc, fr] = await Promise.all([
        statcan.fetchRange(range.start, range.end, { signal, onProgress: p => { Object.assign(parts[0], p); progress(parts); } }),
        useFred ? fred.fetchRange(range.start, range.end, key, { signal, onProgress: p => { Object.assign(parts[1], p); progress(parts); } }) : Promise.resolve(null),
      ]);
      if (signal.aborted) return;
      const seriesById = { ...sc.series };
      for (const c of FRED_SERIES) seriesById[c.id] = fr ? fr.series[c.id] : E.failedSeries(fredReason, LONG[fredReason]);
      for (const c of SERIES) seriesById[c.id] = E.flagEmptyHistory(seriesById[c.id], c, range.start, range.end);
      state.dataset = E.buildDataset({ start: range.start, end: range.end, seriesById, retrievedAt: sc.retrievedAt });
      state.stats = E.datasetStats(state.dataset);
      state.run = { range, sc, fr, fredReason, keyUsed: Boolean(fr) };
      state.fredOutcome = fr?.stopped?.reason || null;
      state.page = 1;
      renderResults();
      els.csv.disabled = false;
      const label = { canadian_only: "Canadian-only dataset", us_only: "US-only dataset", complete: "complete dataset", partial: "partially populated dataset", empty: "no data" }[E.coverageLabel(state.stats)];
      const tone = state.stats.populatedSeries.length === SERIES.length ? "ok" : "warn";
      setStatus(`Fetched ${count(state.stats.months)} month${state.stats.months === 1 ? "" : "s"} (${range.start === range.end ? range.start : `${range.start} to ${range.end}`}): ${state.stats.populatedSeries.length} of ${SERIES.length} series have data, ${label}. Download CSV saves every month.`, tone);
    } catch (error) {
      if (error?.kind === "aborted" || signal.aborted) {
        setStatus(`Cancelled. Nothing from this fetch was kept${state.dataset ? "; the results below are from the previous fetch" : ""}.`, "warn");
        return;
      }
      setStatus(`Fetch failed: ${error?.message || "unexpected error"}`, "error");
    } finally {
      if (state.controller === controller) { state.controller = null; busy(false); }
      renderFredSource();
    }
  }

  /* ---------------- results ---------------- */
  function renderResults() {
    const ds = state.dataset;
    const st = state.stats;
    els.results.hidden = false;
    const tiles = $("cpiTiles");
    tiles.replaceChildren();
    const tile = (label, value, cls) => { const t = el("div", null, "pj-tile"); const v = el("strong", value); if (cls) v.className = cls; t.append(el("span", label), v); tiles.append(t); };
    tile("Months retrieved", count(st.months));
    tile("Series with data", `${st.populatedSeries.length} of ${SERIES.length}`, st.populatedSeries.length === SERIES.length ? "good" : "warn");
    tile("Series unavailable", String(st.unavailableSeries.length), st.unavailableSeries.length ? "warn" : "good");
    tile("Dataset", { canadian_only: "Canadian only", us_only: "US only", complete: "Complete", partial: "Partially populated", empty: "Empty" }[E.coverageLabel(st)]);
    tile("Retrieved", localTime(ds.retrievedAt));
    renderSourceStatus();
    renderQuality();
    renderTabs();
    renderTable();
    renderLegends();
  }

  function renderSourceStatus() {
    const list = $("cpiSourceStatus");
    list.replaceChildren();
    const { sc, fr, fredReason } = state.run;
    const add = (text, tone) => { const li = el("li", text); li.dataset.tone = tone; list.append(li); };
    const scOk = STATCAN_SERIES.filter(c => state.dataset.series[c.id].status === "ok").length;
    const latest = STATCAN_SERIES.map(c => sc.series[c.id].source?.latestRelease).filter(Boolean).sort().at(-1);
    add(`Statistics Canada (Web Data Service, direct): ${scOk} of ${STATCAN_SERIES.length} series complete · ${sc.requests} request${sc.requests === 1 ? "" : "s"}${sc.cached ? ` and ${sc.cached} answer${sc.cached === 1 ? "" : "s"} reused from this page (under 30 minutes old)` : ""}${latest ? ` · latest release in range ${latest.replace("T", " ")} ET` : ""} · retrieved ${localTime(sc.retrievedAt)}.`, scOk === STATCAN_SERIES.length ? "ok" : "warn");
    for (const c of STATCAN_SERIES) {
      const s = state.dataset.series[c.id];
      if (s.status !== "ok" && s.message) add(`${c.col} ${c.header}: ${s.message}`, s.status === "partial" ? "warn" : "error");
    }
    if (!fr) {
      add(fredReason === "gateway_not_configured" ? "FRED: not fetched. This site has no data gateway configured yet, so columns G–S are blank." : "FRED: not fetched, no key entered. Columns G–S are blank; enter your FRED key and fetch again to fill them.", "warn");
      return;
    }
    if (fr.stopped) { add(`FRED: ${fr.stopped.message} Columns G–S are blank; the Canadian columns were kept.`, "error"); return; }
    const frOk = FRED_SERIES.filter(c => state.dataset.series[c.id].status === "ok").length;
    add(`FRED (through the data gateway, with your key): ${frOk} of ${FRED_SERIES.length} series complete · ${fr.requests} request${fr.requests === 1 ? "" : "s"} · retrieved ${localTime(fr.retrievedAt)}.`, frOk === FRED_SERIES.length ? "ok" : "warn");
    for (const c of FRED_SERIES) {
      const s = state.dataset.series[c.id];
      if (s.status !== "ok" && s.message) add(`${c.col} ${c.header}: ${s.message}`, s.status === "partial" ? "warn" : "error");
    }
  }

  function renderQuality() {
    const box = $("cpiQuality");
    box.replaceChildren();
    const items = [];
    const { range } = state.run;
    const cov = E.coverageLabel(state.stats);
    if (cov === "canadian_only") items.push(["warn", "Canadian-only / partially populated: columns G–S (US) are blank in the preview and the CSV. All nineteen headers are kept."]);
    for (const n of range.notes) items.push(["info", n]);
    for (const [flag, word] of [["revised", "revised"], ["preliminary", "preliminary"]]) {
      const cols = STATCAN_SERIES.filter(c => state.dataset.series[c.id].source?.[flag]);
      const n = cols.reduce((sum, c) => sum + state.dataset.series[c.id].source[flag], 0);
      if (n) items.push(["info", `Statistics Canada marks ${n} observation${n === 1 ? "" : "s"} in this range as ${word} (column${cols.length === 1 ? "" : "s"} ${cols.map(c => c.col).join(", ")}); the values shown are the ones published today.`]);
    }
    for (const c of SERIES) for (const n of state.dataset.series[c.id].notes || []) if (state.stats.perSeries[c.id] > 0) items.push(["info", `${c.col} ${c.header}: ${n}.`.replace(/\.\.$/, ".")]);
    if (state.stats.blankByReason.provider_error) items.push(["warn", "Some values were not used because a source answered with something unexpected; see the source status above."]);
    items.push(["info", "Statistics Canada revises the previous month's seasonally adjusted CPI every month and the last three years each January; FRED series such as PCE are revised too. Fetching again picks up the current published values. Nothing is interpolated, forward-filled or estimated."]);
    if (!items.length) return;
    const ul = el("ul", null, "pj-warnings");
    ul.setAttribute("aria-label", "Data quality notes");
    for (const [tone, text] of items) ul.append(el("li", text, tone === "info" ? "info" : ""));
    box.append(ul);
  }

  function renderTabs() {
    els.tabs.replaceChildren();
    for (const g of GROUPS) {
      const b = el("button", null);
      b.type = "button";
      b.id = `cpiTab-${g.id}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", "cpiPanel");
      const selected = g.id === state.group;
      b.setAttribute("aria-selected", String(selected));
      b.tabIndex = selected ? 0 : -1;
      const filled = g.ids.filter(id => state.stats.perSeries[id] > 0).length;
      b.append(g.label, " ", el("small", `${filled}/${g.ids.length}`));
      b.setAttribute("aria-label", `${g.label}: ${filled} of ${g.ids.length} series with data`);
      b.addEventListener("click", () => selectGroup(g.id, false));
      els.tabs.append(b);
    }
    els.panel.setAttribute("aria-labelledby", `cpiTab-${state.group}`);
  }
  function selectGroup(id, focus) {
    state.group = id;
    renderTabs();
    renderTable();
    if (focus) $(`cpiTab-${id}`).focus();
  }
  els.tabs.addEventListener("keydown", event => {
    const ids = GROUPS.map(g => g.id);
    const i = ids.indexOf(state.group);
    const next = { ArrowRight: (i + 1) % ids.length, ArrowLeft: (i - 1 + ids.length) % ids.length, Home: 0, End: ids.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectGroup(ids[next], true);
  });

  function renderTable() {
    const ds = state.dataset;
    const slice = E.pageSlice(ds.rows.length, state.page);
    state.page = slice.page;
    const rows = ds.rows.slice(slice.from, slice.to);
    const group = GROUPS.find(g => g.id === state.group);
    const cols = group.ids.map(id => byId[id]);
    const idx = cols.map(c => SERIES.indexOf(c));
    const table = el("table", null, "cpi-table");
    const first = rows[0].date.slice(0, 7);
    const last = rows.at(-1).date.slice(0, 7);
    table.append(el("caption", `${group.label}: ${first === last ? first : `${first} to ${last}`} (page ${slice.page} of ${slice.pages})`));
    const colgroup = el("colgroup");
    const dateCol = el("col");
    dateCol.className = "cpi-date-col";
    colgroup.append(dateCol, ...cols.map(() => el("col")));
    table.append(colgroup);
    const thead = el("thead");
    const hr = el("tr");
    const dateTh = el("th", "Date");
    dateTh.scope = "col";
    hr.append(dateTh);
    for (const c of cols) {
      const th = el("th");
      th.scope = "col";
      th.title = `${c.header} (${c.units})`;
      const short = el("span", c.label);
      short.setAttribute("aria-hidden", "true");
      const sub = el("span", `${c.col} · ${unitsShort(c)}`, "cpi-col");
      sub.setAttribute("aria-hidden", "true");
      th.append(short, sub, el("span", `${c.header}, column ${c.col}, ${c.units}`, "sr-only"));
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      const th = el("th", row.date);
      th.scope = "row";
      tr.append(th);
      cols.forEach((c, j) => {
        const v = row.values[idx[j]];
        const td = el("td");
        td.dataset.label = c.label;
        if (v === null) {
          const reason = row.reasons[idx[j]];
          td.dataset.reason = reason;
          td.title = E.REASONS[reason];
          td.append(el("span", SHORT[reason], "cpi-blank"));
        } else td.textContent = E.formatValue(v, c);
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    els.panel.replaceChildren(table);
    $("cpiPageText").textContent = `Page ${slice.page} of ${slice.pages} · ${first === last ? first : `${first} to ${last}`} · ${count(ds.rows.length)} month${ds.rows.length === 1 ? "" : "s"} in total`;
    $("cpiPrev").disabled = slice.page <= 1;
    $("cpiNext").disabled = slice.page >= slice.pages;
    $("cpiPager").hidden = slice.pages <= 1 && !ds.rows.length;
  }
  const goPage = page => { state.page = page; renderTable(); };
  $("cpiPrev").addEventListener("click", () => goPage(state.page - 1));
  $("cpiNext").addEventListener("click", () => goPage(state.page + 1));
  $("cpiJump").addEventListener("submit", event => {
    event.preventDefault();
    const input = $("cpiJumpTo");
    const ym = input.value.trim();
    const page = /^\d{4}-\d{2}$/.test(ym) && state.dataset ? E.pageOfMonth(state.dataset, ym) : null;
    if (!page) {
      input.setAttribute("aria-invalid", "true");
      setStatus(state.dataset ? `Enter a month (YYYY-MM) between ${state.dataset.start} and ${state.dataset.end}.` : "Fetch data first.", "warn");
      return;
    }
    input.removeAttribute("aria-invalid");
    goPage(page);
  });

  function renderLegends() {
    const cols = $("cpiColumns");
    cols.replaceChildren();
    const ul = el("ul", null, "cpi-columns");
    for (const c of COLUMNS) {
      const li = el("li");
      li.append(el("strong", `${c.col} · ${c.header}`));
      if (c.source === "date") li.append(el("span", ` — monthly key, the first day of each month (${c.units}).`));
      else {
        const n = state.stats.perSeries[c.id];
        const src = c.source === "statcan" ? `Statistics Canada vector ${c.sourceId}` : `FRED ${c.sourceId}`;
        const method = c.kind === "daily_eom" ? "latest valid daily observation in the month" : "monthly, as published";
        li.append(el("span", ` — ${src}; ${c.units}; ${method}; from ${c.firstMonth || "a rolling ~10-year window"}. This fetch: ${count(n)} value${n === 1 ? "" : "s"}.`));
      }
      ul.append(li);
    }
    cols.append(ul);
    const dl = $("cpiReasons");
    dl.replaceChildren();
    for (const [code, text] of Object.entries(LONG)) {
      const n = state.stats.blankByReason[code] || 0;
      if (!n && ["cancelled"].includes(code)) continue;
      dl.append(el("dt", `${SHORT[code]}${n ? ` (${count(n)} on all pages)` : ""}`), el("dd", text));
    }
    dl.append(el("dt", "Empty CSV cell"), el("dd", "Every blank above is an empty cell in the CSV. A missing value is never written as zero."));
  }

  /* ---------------- CSV, cancel, clear ---------------- */
  els.csv.addEventListener("click", () => {
    if (!state.dataset) return;
    const name = E.csvFileName(state.dataset);
    downloadBlob(new Blob([E.toCsv(state.dataset)], { type: "text/csv;charset=utf-8" }), name);
    setStatus(`Downloaded ${name}: ${count(state.dataset.rows.length)} month${state.dataset.rows.length === 1 ? "" : "s"}, 19 columns (A–S).`, "ok");
  });
  els.cancel.addEventListener("click", () => {
    if (!state.controller) return;
    state.controller.abort();
    state.controller = null;
    busy(false);
    setStatus(`Cancelled. Nothing from this fetch was kept${state.dataset ? "; the results below are from the previous fetch" : ""}.`, "warn");
  });
  $("cpiClear").addEventListener("click", () => {
    state.controller?.abort();
    state.controller = null;
    busy(false);
    state.dataset = null;
    state.stats = null;
    state.run = null;
    state.fredOutcome = null;
    state.group = "canada";
    els.results.hidden = true;
    els.csv.disabled = true;
    document.querySelector('input[name="cpiMode"][value="single"]').checked = true;
    prefill();
    syncMode();
    statcan.clearCache();
    [els.year, els.month, els.year2, els.month2].forEach(i => i.removeAttribute("aria-invalid"));
    $("cpiDateError").textContent = "";
    renderFredSource();
    setStatus(`Cleared.${els.key.value ? " Your FRED key is still entered; use Remove key to forget it." : ""}`, null);
  });
  els.fetch.addEventListener("click", fetchData);
  for (const input of [els.year, els.month, els.year2, els.month2]) input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fetchData(); } });

  /* ---------------- start ---------------- */
  try {
    const saved = sessionStorage.getItem(KEY_SLOT);
    if (saved && validFredKey(saved)) { els.key.value = saved; els.keep.checked = true; }
  } catch (_) { /* storage unavailable */ }
  prefill();
  syncMode();
  renderFredSource();
  setStatus(fred.configured ? "Ready. Choose the months, add your FRED key for the US columns if you have one, and fetch." : "Ready. Choose the months and fetch: the Canadian columns need no key. The US columns need the data gateway, which this site has not configured yet.", null);
  root.dataset.ready = "true";
}
