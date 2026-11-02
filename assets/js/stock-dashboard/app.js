// Stock Comparison & Analytics dashboard controller.
//
// Four sections: Comparison, Snapshot, Export, Settings. All analysis happens in
// this browser. Price data comes from one of three clearly labelled sources:
//   * Live: the visitor's own free Alpha Vantage key (optional; the key stays here);
//   * CSV: price files the visitor opens (read locally, never uploaded);
//   * Offline demo: synthetic prices generated in the browser.
// Currency normalization uses official central-bank rates (Bank of Canada, ECB
// fallback). See ../market-data/ for providers, validation and caching.

import { createMarketData, DataError, selectBasis, describeAge, FRESHNESS_LABEL, fxSupported, KEY_STORAGE_TEXT } from "../market-data/index.js";
import { normalizeSymbol, normalizeSymbolList, MAX_TICKERS, MIN_COMPARE_TICKERS, SymbolError } from "../market-data/symbols.js";
import { buildFxAligner, normalizeSeries } from "../market-data/fx-align.js";
import { parsePriceCsv } from "../market-data/price-import.js";
import * as A from "./analytics.js";
import { DEMO_SECURITIES, demoSeries, demoFxRates } from "./demo.js";
import { buildWorkbookSheets } from "./export.js";
import { buildXlsx, toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const app = document.getElementById("sdd-app");
if (app) init();

function init() {
  const $ = id => document.getElementById(id);
  const md = createMarketData();
  const state = {
    comparison: null,       // latest completed comparison (export snapshot)
    compareController: null,
    liveTickers: ["AAPL", "MSFT", "SPY"],
    imported: {},           // TICKER -> history from the visitor's CSV files
    importedFiles: [],
    snapshot: null,         // { series, provenance }
    snapshotController: null,
    charts: {},
  };
  const CHART_AVAILABLE = typeof window.Chart === "function";

  /* ================= helpers ================= */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const pct = (v, digits = 2) => (isNum(v) ? `${(v * 100).toFixed(digits)}%` : "—");
  const signedPct = (v, digits = 2) => (isNum(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}%` : "—");
  const num = (v, digits = 2) => (isNum(v) ? v.toFixed(digits) : "—");
  const money = (v, currency) => (isNum(v) ? `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}` : "Unavailable");
  const big = v => {
    if (!isNum(v)) return "Unavailable";
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    const unit = units.find(([size]) => Math.abs(v) >= size);
    return unit ? `${(v / unit[0]).toFixed(2)}${unit[1]}` : v.toLocaleString();
  };
  const localTime = iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso ?? "Unavailable") : date.toLocaleString();
  };
  function setStatus(node, text, tone) {
    node.textContent = text;
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
  }
  function fillDl(dl, entries) {
    dl.replaceChildren();
    entries.forEach(([label, value]) => { dl.append(el("dt", label), el("dd", value ?? "Unavailable")); });
  }
  function table(headers, rows, { numeric = [] } = {}) {
    const t = el("table");
    const head = el("thead");
    const hr = el("tr");
    headers.forEach((h, i) => { const th = el("th", h, numeric.includes(i) ? "num" : ""); th.scope = "col"; hr.append(th); });
    head.append(hr);
    const body = el("tbody");
    rows.forEach(cells => {
      const tr = el("tr");
      cells.forEach((cell, i) => {
        if (cell instanceof Node) { const td = el("td"); td.append(cell); tr.append(td); }
        else tr.append(el("td", cell ?? "—", numeric.includes(i) ? "num" : ""));
      });
      body.append(tr);
    });
    t.append(head, body);
    return t;
  }
  function showNotice(node, { tone = "error", title, items = [], actions = [] }) {
    node.hidden = false;
    node.className = `sdd-notice ${tone === "error" ? "error" : tone === "info" ? "info" : ""}`;
    node.replaceChildren();
    const p = el("p");
    p.append(el("strong", title));
    node.append(p);
    if (items.length) {
      const ul = el("ul");
      items.forEach(item => ul.append(el("li", item)));
      node.append(ul);
    }
    if (actions.length) {
      const row = el("div", null, "sdd-actions");
      actions.forEach(({ label, onClick, secondary = true }) => {
        const b = el("button", label, secondary ? "secondary" : "");
        b.type = "button";
        b.addEventListener("click", onClick);
        row.append(b);
      });
      node.append(row);
    }
  }
  const hideNotice = node => { node.hidden = true; node.replaceChildren(); };
  const describeError = error => (error instanceof DataError || error instanceof SymbolError || error?.kind)
    ? error.message : "Unexpected error. Please try again.";
  const BASIS_LABEL = { adjusted_close: "Adjusted close (dividends included)", close: "Close (price only)", synthetic: "Synthetic" };

  /* ================= theme ================= */
  const THEME_KEY = "sdd.theme";
  const themeSelect = $("sddTheme");
  function applyTheme(value) {
    const theme = ["dark", "light", "system"].includes(value) ? value : "dark";
    app.dataset.theme = theme;
    themeSelect.value = theme;
    Object.values(state.charts).forEach(chart => chart && restyleChart(chart));
    return theme;
  }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (_) { applyTheme("dark"); }
  themeSelect.addEventListener("change", () => {
    const theme = applyTheme(themeSelect.value);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* theme still applies for this visit */ }
  });

  /* ================= tabs ================= */
  const tabs = [...app.querySelectorAll('[role="tab"]')];
  function selectTab(tab, { focus = false, updateHash = true } = {}) {
    tabs.forEach(t => {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !selected;
    });
    if (focus) tab.focus();
    if (updateHash) {
      try { history.replaceState(null, "", `#${tab.id.replace("sddTab-", "")}`); } catch (_) { /* hash is cosmetic */ }
    }
    // Charts created while hidden need a resize once visible.
    Object.values(state.charts).forEach(chart => chart?.resize());
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      selectTab(tabs[(moves[event.key] + tabs.length) % tabs.length], { focus: true });
    });
  });
  const initialTab = tabs.find(t => `#${t.id.replace("sddTab-", "")}` === window.location.hash);
  if (initialTab) selectTab(initialTab, { updateHash: false });
  /* ================= data status widget ================= */
  function renderDataStatus() {
    const pill = $("sddPipelineState");
    const detail = $("sddPipelineDetail");
    if (md.liveAvailable()) {
      const usage = md.usage();
      pill.textContent = "Your key";
      pill.className = `sdd-pill ${usage.count >= usage.limit ? "warn" : "ok"}`;
      detail.textContent = `Alpha Vantage · about ${usage.count} of ${usage.limit} free requests used today in this browser.`;
    } else {
      pill.textContent = "Off";
      pill.className = "sdd-pill idle";
      detail.textContent = "Add your free Alpha Vantage key in Settings, or use your CSV files or the offline demo.";
    }
    const cached = md.cacheSize();
    $("sddCacheState").textContent = `Cache: ${cached} saved response${cached === 1 ? "" : "s"}`;
    $("sddCacheCount").textContent = `${cached} saved response${cached === 1 ? "" : "s"}`;
    const where = md.settings.persistence;
    $("sddKeyState").textContent = md.liveAvailable()
      ? `Your key is ${KEY_STORAGE_TEXT[where] || "saved in this browser"}. About ${md.usage().count} of ${md.usage().limit} free requests used today here.`
      : "No key saved. Live data is off.";
    if (md.liveAvailable()) $("sddKeyRemember").checked = where === "local";
    $("sddKeyRemove").disabled = !md.liveAvailable();
  }
  const openSettings = () => { selectTab($("sddTab-settings")); app.scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("sddOpenSettings").addEventListener("click", openSettings);

  /* ================= Compare: ticker rows ================= */
  const tickerList = $("sddTickerList");
  const compareForm = $("sddCompareForm");
  const sourceValue = () => compareForm.querySelector('input[name="source"]:checked').value;

  function tickerRow(value = "") {
    const row = el("div", null, "sdd-ticker-row");
    const input = el("input");
    input.className = "sdd-ticker-input";
    input.value = value;
    input.maxLength = 20;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Ticker symbol");
    input.placeholder = "Ticker";
    row.append(input);
    [["up", "↑", "Move ticker up"], ["down", "↓", "Move ticker down"], ["remove", "Remove", "Remove ticker"]].forEach(([action, text, label]) => {
      const b = el("button", text, "secondary");
      b.type = "button";
      b.dataset.action = action;
      b.setAttribute("aria-label", label);
      row.append(b);
    });
    return row;
  }
  function setTickers(values) {
    tickerList.replaceChildren(...values.map(tickerRow));
    syncTickerButtons();
  }
  function syncTickerButtons() {
    const rows = [...tickerList.children];
    const demo = sourceValue() === "demo";
    const csv = sourceValue() === "csv";
    rows.forEach((row, i) => {
      row.querySelector('[data-action="up"]').disabled = i === 0;
      row.querySelector('[data-action="down"]').disabled = i === rows.length - 1;
      row.querySelector('[data-action="remove"]').disabled = rows.length <= MIN_COMPARE_TICKERS;
      row.querySelector("input").readOnly = demo || csv;
    });
    $("sddAddTicker").disabled = demo || csv || rows.length >= MAX_TICKERS;
  }
  function clearRowErrors() {
    tickerList.querySelectorAll(".sdd-row-error").forEach(n => n.remove());
    tickerList.querySelectorAll("input").forEach(i => i.removeAttribute("aria-invalid"));
  }
  tickerList.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const row = button.closest(".sdd-ticker-row");
    if (button.dataset.action === "remove") { if (tickerList.children.length > MIN_COMPARE_TICKERS) row.remove(); }
    else if (button.dataset.action === "up" && row.previousElementSibling) tickerList.insertBefore(row, row.previousElementSibling);
    else if (button.dataset.action === "down" && row.nextElementSibling) tickerList.insertBefore(row.nextElementSibling, row);
    syncTickerButtons();
  });
  tickerList.addEventListener("input", event => {
    if (event.target.matches("input")) {
      event.target.removeAttribute("aria-invalid");
      event.target.parentElement.querySelector(".sdd-row-error")?.remove();
    }
  });
  $("sddAddTicker").addEventListener("click", () => {
    if (tickerList.children.length >= MAX_TICKERS) return;
    const row = tickerRow();
    tickerList.append(row);
    syncTickerButtons();
    row.querySelector("input").focus();
  });
  function syncSource() {
    clearRowErrors();
    const source = sourceValue();
    $("sddCsvField").hidden = source !== "csv";
    if (source === "demo") {
      setTickers(DEMO_SECURITIES.map(s => s.ticker));
      setStatus($("sddCompareStatus"), "Offline demo: synthetic prices generated in your browser. No network requests.", null);
    } else if (source === "csv") {
      const tickers = Object.keys(state.imported);
      setTickers(tickers.length >= MIN_COMPARE_TICKERS ? tickers.slice(0, MAX_TICKERS) : ["", ""]);
      setStatus($("sddCompareStatus"), tickers.length ? `${tickers.length} ticker${tickers.length === 1 ? "" : "s"} loaded from your file${state.importedFiles.length === 1 ? "" : "s"}. Remove any you don't want, then run.` : "Open one or more CSV price files.", null);
    } else {
      setTickers(state.liveTickers.length >= MIN_COMPARE_TICKERS ? state.liveTickers : ["AAPL", "MSFT", "SPY"]);
      setStatus($("sddCompareStatus"), md.liveAvailable() ? "Ready. Enter 2–10 tickers and run the comparison." : "Live data needs your own free Alpha Vantage key (Settings). Or choose CSV files or the offline demo.", md.liveAvailable() ? null : "warn");
    }
    syncTickerButtons();
  }
  let previousSource = sourceValue();
  compareForm.querySelectorAll('input[name="source"]').forEach(radio => radio.addEventListener("change", () => {
    if (previousSource === "live") state.liveTickers = [...tickerList.querySelectorAll("input")].map(i => i.value.trim()).filter(Boolean);
    previousSource = sourceValue();
    syncSource();
  }));
  $("sddCsvFiles").addEventListener("change", async event => {
    const files = [...event.target.files].slice(0, 20);
    const status = $("sddCompareStatus");
    const imported = {};
    const warnings = [];
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} is larger than 8 MB.`);
        const { histories, warnings: w } = parsePriceCsv(await file.text(), file.name);
        for (const [ticker, history] of Object.entries(histories)) {
          if (imported[ticker]) throw new Error(`${ticker} appears in more than one file.`);
          imported[ticker] = history;
        }
        warnings.push(...w);
      }
      state.imported = imported;
      state.importedFiles = files.map(f => f.name);
      syncSource();
      const count = Object.keys(imported).length;
      setStatus(status, `Loaded ${count} ticker${count === 1 ? "" : "s"} from ${files.length} file${files.length === 1 ? "" : "s"}${count > MAX_TICKERS ? ` (the first ${MAX_TICKERS} are listed)` : ""}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`, warnings.length ? "warn" : "ok");
    } catch (error) {
      state.imported = {};
      state.importedFiles = [];
      syncSource();
      setStatus(status, `Could not read the file: ${error.message}`, "error");
    }
  });
  setTickers(state.liveTickers);

  /* ================= Compare: run ================= */
  const progress = $("sddCompareProgress");
  const chips = $("sddTickerProgress");
  function chip(ticker, stateName, text) {
    let item = chips.querySelector(`[data-ticker="${CSS.escape(ticker)}"]`);
    if (!item) { item = el("li"); item.dataset.ticker = ticker; chips.append(item); }
    item.dataset.state = stateName;
    item.textContent = `${ticker}: ${text}`;
  }

  compareForm.addEventListener("submit", event => { event.preventDefault(); runComparison(); });
  $("sddCancelCompare").addEventListener("click", () => state.compareController?.abort());

  async function runComparison() {
    if (state.compareController) return;
    const status = $("sddCompareStatus");
    const notice = $("sddCompareNotice");
    const source = sourceValue();
    const demo = source === "demo";
    clearRowErrors();
    hideNotice(notice);
    const inputs = [...tickerList.querySelectorAll("input")];
    const { symbols, errors } = normalizeSymbolList(inputs.map(i => i.value), { min: MIN_COMPARE_TICKERS, max: MAX_TICKERS });
    errors.forEach(({ index, message }) => {
      if (index >= 0) {
        inputs[index].setAttribute("aria-invalid", "true");
        inputs[index].parentElement.append(el("p", message, "sdd-row-error"));
      }
    });
    if (errors.length) {
      setStatus(status, errors.map(e => e.message).join(" "), "error");
      (inputs[errors.find(e => e.index >= 0)?.index] || inputs[0])?.focus();
      return;
    }
    if (source === "live" && !md.liveAvailable()) {
      setStatus(status, "Live data needs your own free Alpha Vantage key.", "error");
      showNotice(notice, { tone: "info", title: "Live data is not set up in this browser.", items: ["Add your free Alpha Vantage key in Settings (it stays in this browser), open your own CSV price files, or use the offline demo."], actions: [{ label: "Open Settings", onClick: openSettings, secondary: false }, { label: "Use offline demo", onClick: useOfflineDemo }] });
      return;
    }
    const riskInput = $("sddRiskFree");
    const riskPct = Number(riskInput.value || 0);
    if (!Number.isFinite(riskPct) || riskPct < 0 || riskPct > 25) {
      riskInput.setAttribute("aria-invalid", "true");
      setStatus(status, "Risk-free rate must be between 0 and 25%.", "error");
      riskInput.focus();
      return;
    }
    riskInput.removeAttribute("aria-invalid");
    const riskFree = riskPct / 100;
    const horizon = $("sddHorizon").value;
    const basis = $("sddBasis").value;
    const target = $("sddNormalize").value === "off" ? null : $("sddNormalize").value;
    const now = new Date();
    const range = A.resolveHorizon(horizon, now);
    const controller = new AbortController();
    state.compareController = controller;
    $("sddRunCompare").disabled = true;
    $("sddCancelCompare").disabled = false;
    chips.replaceChildren();
    progress.value = 0;
    setStatus(status, demo ? "Generating synthetic demo prices…" : source === "csv" ? "Reading your imported prices…" : "Requesting prices with your Alpha Vantage key…", null);

    const seriesByTicker = {};
    const provenance = [];
    let failures = [];
    let done = 0;
    const aborted = () => controller.signal.aborted;
    try {
      // Live requests run one at a time (the provider allows about one per second).
      for (const symbol of symbols) {
        if (aborted()) break;
        chip(symbol, "busy", demo ? "generating" : "queued");
        try {
          let history;
          let prov;
          if (demo) {
            const series = demoSeries(symbol, now);
            if (!series) throw new SymbolError(`${symbol} is not part of the offline demo.`, symbol);
            seriesByTicker[symbol] = { ...series, frequency: "daily" };
            provenance.push({ ticker: symbol, source: "Synthetic demo", via: "generated in your browser", retrievedAt: now.toISOString(), cached: false, basis: "Synthetic" });
            chip(symbol, "ok", "synthetic");
            continue;
          }
          if (source === "csv") {
            history = state.imported[symbol];
            if (!history) throw new DataError(`${symbol} is not in your imported files.`, { kind: "not_found", definitive: true });
            prov = { source: "Your CSV file", via: history.fileName, retrievedAt: null, cached: false };
          } else {
            chip(symbol, "busy", "fetching");
            ({ history, provenance: prov } = await md.history(symbol, range, { signal: controller.signal }));
            prov = { source: prov.provider, via: prov.via, retrievedAt: prov.retrievedAt, cached: prov.cached, stale: prov.stale, ageMs: prov.ageMs };
          }
          const chosen = selectBasis(history, basis);
          seriesByTicker[symbol] = {
            ticker: symbol, currency: history.currency, observations: chosen.observations, priceBasis: chosen.priceBasis,
            frequency: history.frequency || "daily", basisWarning: chosen.warning,
            identity: { name: history.name, instrumentType: history.instrumentType, exchange: history.exchange, unitScale: history.unitScale, rawCurrency: history.rawCurrency },
            adjustmentNote: chosen.priceBasis === "adjusted_close" ? history.adjustment?.adjClose : history.adjustment?.close,
            currencyVerified: history.currencyVerified !== false,
          };
          provenance.push({ ticker: symbol, ...prov, basis: BASIS_LABEL[chosen.priceBasis], frequency: history.frequency });
          chip(symbol, prov.stale ? "error" : "ok", prov.stale ? "saved copy (refresh failed)" : prov.cached ? "cached" : source === "csv" ? "from file" : "fetched");
        } catch (error) {
          if (aborted()) break;
          if (error.kind === "key_changed") throw error; // one comparison never mixes two keys
          failures.push({ symbol, message: describeError(error), error });
          chip(symbol, "error", error.kind === "not_found" ? "no data" : error.kind === "rate_limited" ? "limit reached" : "failed");
        } finally {
          done += 1;
          progress.value = Math.round(done / symbols.length * (target ? 80 : 95));
          if (!aborted()) setStatus(status, `Loaded ${done} of ${symbols.length} tickers…`, null);
        }
      }
      if (aborted()) throw new DataError("Comparison cancelled.", { kind: "aborted" });

      // Horizon trimming and completed-period rule, per ticker.
      let histories = {};
      const warnings = [];
      for (const symbol of symbols) {
        const series = seriesByTicker[symbol];
        if (!series) continue;
        const prepared = A.prepareHistory(series, horizon, range, now);
        warnings.push(...prepared.warnings);
        if (series.basisWarning) warnings.push(series.basisWarning);
        if (series.identity?.unitScale && series.identity.unitScale !== 1) warnings.push(`${symbol}: prices quoted in ${series.identity.rawCurrency} (minor units) were converted to ${series.currency}.`);
        if (!series.currencyVerified) warnings.push(`${symbol}: the provider did not confirm the listing currency; it is treated as unknown.`);
        if (prepared.observations.length >= 2) histories[symbol] = prepared;
        else failures.push({ symbol, message: `${symbol}: fewer than two completed ${series.frequency === "weekly" ? "weeks" : series.frequency === "monthly" ? "months" : "sessions"} in the ${horizon} window.` });
      }
      const frequencies = [...new Set(Object.values(histories).map(h => h.frequency))];
      if (frequencies.length > 1) throw new DataError(`Your files mix ${frequencies.join(" and ")} prices; use one frequency per comparison.`, { kind: "invalid" });
      let normalizedTo = null;
      let notNormalized = [];
      const fxSources = {};
      if (target && Object.keys(histories).length) {
        setStatus(status, `Normalizing to ${target} with official exchange rates…`, null);
        const natives = [...new Set(Object.values(histories).map(h => String(h.currency || "").toUpperCase()).filter(c => c && c !== target))];
        const aligners = {};
        const official = natives.filter(fxSupported);
        if (demo) {
          for (const native of natives) {
            const points = demoFxRates(native, target, now);
            if (points) { aligners[native] = buildFxAligner(points.map(p => ({ date: p.date, rate: p.price }))); fxSources[native] = "Synthetic demo FX"; }
          }
        } else if (official.length) {
          // Currencies neither central bank publishes are left out of the request (and
          // reported below) so they cannot block the others.
          const start = new Date(range.start.getTime() - 14 * 86400000).toISOString().slice(0, 10);
          try {
            const fx = await md.fx.history([...official, target], start, A.isoDate(range.end), { signal: controller.signal });
            for (const native of official) {
              const points = md.fx.crossHistory(native, target, fx.series);
              if (points.length) {
                aligners[native] = buildFxAligner(points);
                fxSources[native] = `${fx.provider} daily rates${native !== "CAD" && target !== "CAD" ? " (derived via CAD)" : ""}${fx.stale ? ", saved copy" : ""}`;
              }
            }
          } catch (error) {
            if (aborted()) throw error;
            warnings.push(`Official exchange rates are unavailable (${error.message}); series stay in their own currencies.`);
          }
        }
        const normalized = normalizeSeries(histories, target, aligners);
        histories = normalized.series;
        warnings.push(...normalized.warnings);
        normalizedTo = target;
        notNormalized = Object.values(histories).filter(h => h.currency !== target).map(h => h.ticker);
      }
      if (aborted()) throw new DataError("Comparison cancelled.", { kind: "aborted" });

      const usable = symbols.filter(s => histories[s] && histories[s].observations.length >= 2);
      if (usable.length < MIN_COMPARE_TICKERS) {
        const allNetwork = failures.length && failures.every(f => f.error && !f.error.definitive && f.error.kind !== "not_configured");
        discardComparison();
        setStatus(status, usable.length ? "Only one ticker returned usable data; a comparison needs at least two." : "No usable price history was returned.", "error");
        showNotice(notice, {
          title: allNetwork ? "Prices could not be retrieved." : "The comparison could not be completed.",
          items: failures.map(f => f.message),
          actions: [
            { label: "Retry", onClick: () => runComparison(), secondary: false },
            { label: "Use offline demo", onClick: useOfflineDemo },
          ],
        });
        progress.value = 0;
        return;
      }
      const result = A.runComparison(Object.fromEntries(usable.map(s => [s, histories[s]])), { riskFreeAnnual: riskFree });
      const allWarnings = [...new Set([...result.warnings, ...warnings])];
      state.comparison = {
        tickers: usable, horizon, riskFree, normalizedTo, notNormalized: notNormalized.filter(t => usable.includes(t)), fxSources, basis, frequency: result.frequency, periodsPerYear: result.periodsPerYear,
        requestedStart: A.isoDate(range.start), requestedEnd: A.isoDate(range.end),
        completedAt: new Date().toISOString(), source: demo ? "Synthetic demo" : source === "csv" ? "Your CSV file" : "Alpha Vantage (your key)",
        series: usable.map(s => histories[s]), metrics: result.metrics, matrix: result.matrix, counts: result.counts,
        returns: result.returns, warnings: allWarnings, failures: failures.map(f => f.message),
        provenance: provenance.filter(p => usable.includes(p.ticker)), regression: null,
      };
      progress.value = 100;
      renderComparison();
      const partial = failures.length ? ` ${failures.length} ticker${failures.length === 1 ? "" : "s"} skipped.` : "";
      setStatus(status, `Comparison complete: ${usable.length} securities, ${horizon}, ${result.frequency} prices.${partial}`, failures.length ? "warn" : "ok");
      if (failures.length) {
        showNotice(notice, { tone: "warn", title: "Some tickers were skipped.", items: failures.map(f => f.message), actions: [{ label: "Retry", onClick: () => runComparison() }] });
      }
      updateExportState();
    } catch (error) {
      if (error.kind === "aborted" || aborted()) {
        setStatus(status, "Comparison cancelled. Completed requests stay cached.", "warn");
      } else {
        discardComparison();
        setStatus(status, describeError(error), "error");
        showNotice(notice, { title: "The comparison failed.", items: [describeError(error)], actions: [{ label: "Retry", onClick: () => runComparison(), secondary: false }, { label: "Use offline demo", onClick: useOfflineDemo }] });
      }
      progress.value = 0;
    } finally {
      state.compareController = null;
      $("sddRunCompare").disabled = false;
      $("sddCancelCompare").disabled = true;
      renderDataStatus();
    }
  }

  // A failed run supersedes the previous result: never leave it on screen (or in the
  // Export tab) looking like the answer to the request that just failed.
  function discardComparison() {
    if (!state.comparison) return;
    state.comparison = null;
    $("sddCompareResult").hidden = true;
    updateExportState();
  }
  function useOfflineDemo() {
    compareForm.querySelector('input[value="demo"]').click();
    runComparison();
  }

  /* ================= Compare: render ================= */
  function renderComparison() {
    const c = state.comparison;
    $("sddCompareResult").hidden = false;
    $("sddCompareMeta").textContent = `${c.horizon} · requested ${c.requestedStart} to ${c.requestedEnd} · ${c.source} · ${c.frequency} prices (${c.periodsPerYear} periods per year)` +
      ` · ${c.basis === "adjusted" ? "adjusted closes requested" : "plain closes (price return)"}` +
      `${c.normalizedTo ? (c.notNormalized.length ? ` · normalization to ${c.normalizedTo} INCOMPLETE (${c.notNormalized.join(", ")} still in native currency)` : ` · normalized to ${c.normalizedTo}`) : " · native currencies"} · completed ${localTime(c.completedAt)}`;
    const starts = c.metrics.map(m => m.actualStart).filter(Boolean).sort();
    const ends = c.metrics.map(m => m.actualEnd).filter(Boolean).sort();
    const best = c.metrics.filter(m => isNum(m.totalReturn)).sort((a, b) => b.totalReturn - a.totalReturn)[0];
    const calm = c.metrics.filter(m => isNum(m.annualizedVolatility)).sort((a, b) => a.annualizedVolatility - b.annualizedVolatility)[0];
    const tiles = $("sddTiles");
    tiles.replaceChildren();
    [["Securities compared", String(c.tickers.length)],
      ["Price range", starts.length ? `${starts[0]} → ${ends[ends.length - 1]}` : "—"],
      ["Return observations", String(Math.max(...c.metrics.map(m => m.returnObservations)))],
      ["Best total return", best ? `${best.ticker} ${pct(best.totalReturn)}` : "—"],
      ["Lowest volatility", calm ? `${calm.ticker} ${pct(calm.annualizedVolatility)}` : "—"],
    ].forEach(([label, value]) => {
      const tile = el("div", null, "sdd-tile");
      tile.append(el("span", label), el("strong", value));
      tiles.append(tile);
    });

    const body = $("sddMetricsTable").querySelector("tbody");
    body.replaceChildren();
    c.metrics.forEach(m => {
      const tr = el("tr");
      const th = el("th", m.ticker);
      th.scope = "row";
      tr.append(th, el("td", m.currency ?? "Unknown"), el("td", BASIS_LABEL[m.priceBasis] || "—"));
      [pct(m.totalReturn), pct(m.annualizedReturn), pct(m.annualizedVolatility), num(m.sharpe), pct(m.maxDrawdown), String(m.returnObservations)]
        .forEach(v => tr.append(el("td", v, "num")));
      tr.append(el("td", `${m.actualStart ?? "—"} → ${m.actualEnd ?? "—"}`));
      body.append(tr);
    });
    const warn = $("sddCompareWarnings");
    warn.replaceChildren();
    if (c.normalizedTo && Object.keys(c.fxSources).length) {
      warn.append(el("p", `FX normalization on: ${Object.entries(c.fxSources).map(([cur, src]) => `${cur}→${c.normalizedTo} from ${src}`).join("; ")}.`, "muted"));
    }
    c.warnings.forEach(w => warn.append(el("p", w, "sdd-different")));

    renderCorrelation(c);
    const benchmark = $("sddBenchmark");
    benchmark.replaceChildren(...c.tickers.map(t => { const o = el("option", t); o.value = t; return o; }));
    benchmark.value = ["SPY", "^GSPC", "VOO", "IVV", "XIU.TO", "^GSPTSE"].find(t => c.tickers.includes(t)) || c.tickers[c.tickers.length - 1];
    renderRegression();
    renderCompareCharts(c);
    const sources = $("sddCompareSources");
    sources.replaceChildren();
    c.provenance.forEach(p => sources.append(el("li", `${p.ticker} · ${p.source}${p.via ? ` (${p.via})` : ""} · ${p.basis || ""}${p.frequency ? `, ${p.frequency}` : ""}` +
      `${p.retrievedAt ? ` · retrieved ${localTime(p.retrievedAt)}` : ""}${p.stale ? ` · saved copy from ${describeAge(p.ageMs)} ago (refresh failed)` : p.cached ? ` · from this browser's cache (${describeAge(p.ageMs)})` : ""}`)));
    c.series.forEach(s => { if (s.adjustmentNote) sources.append(el("li", `${s.ticker}: ${s.adjustmentNote}`, "muted")); });
  }

  function correlationBackground(value) {
    if (!isNum(value)) return "";
    const share = Math.round(Math.min(1, Math.abs(value)) * 70);
    return `color-mix(in srgb, var(${value >= 0 ? "--sdd-pos" : "--sdd-neg"}) ${share}%, var(--sdd-surface))`;
  }
  function renderCorrelation(c) {
    const host = $("sddCorrelation");
    const t = el("table");
    const head = el("thead");
    const hr = el("tr");
    const corner = el("th", "Ticker");
    corner.scope = "col";
    hr.append(corner);
    c.tickers.forEach(tk => { const th = el("th", tk); th.scope = "col"; hr.append(th); });
    head.append(hr);
    const body = el("tbody");
    c.tickers.forEach(left => {
      const tr = el("tr");
      const th = el("th", left);
      th.scope = "row";
      tr.append(th);
      c.tickers.forEach(right => {
        const value = c.matrix[left][right];
        const count = c.counts[left][right];
        const td = el("td", isNum(value) ? value.toFixed(2) : "n/a", "sdd-corr-cell");
        td.append(el("small", `n=${count}`));
        td.style.background = correlationBackground(value);
        td.title = `${left} vs ${right}: ${isNum(value) ? value.toFixed(4) : "unavailable"} over ${count} shared returns`;
        tr.append(td);
      });
      body.append(tr);
    });
    t.append(head, body);
    host.replaceChildren(t);
    const flags = A.diversificationFlags(c.tickers, c.matrix);
    const div = $("sddDiversification");
    div.replaceChildren();
    if (flags.high.length) div.append(el("p", `Highly correlated (≥ 0.85): ${flags.high.map(f => `${f.left}/${f.right} (${f.value.toFixed(2)})`).join(", ")}`));
    if (flags.low.length) div.append(el("p", `Diversifying (≤ 0.30): ${flags.low.map(f => `${f.left}/${f.right} (${f.value.toFixed(2)})`).join(", ")}`));
    if (!flags.high.length && !flags.low.length) div.append(el("p", "No pairs cross the 0.85 / 0.30 diversification thresholds."));
  }

  function renderRegression() {
    const c = state.comparison;
    if (!c) return;
    const benchmark = $("sddBenchmark").value;
    const rows = c.tickers.filter(t => t !== benchmark).map(t => ({ ticker: t, ...A.regression(c.returns[t], c.returns[benchmark], c.riskFree, c.periodsPerYear) }));
    c.regression = { benchmark, rows };
    const stars = p => (isNum(p) ? (p < 0.01 ? " ***" : p < 0.05 ? " **" : p < 0.1 ? " *" : "") : "");
    const host = $("sddRegression");
    host.replaceChildren(table(
      [`Y vs ${benchmark}`, "Alpha (annualized)", "Beta", "R²", "p-value (beta)", "Shared returns"],
      rows.map(r => [r.ticker, pct(r.alphaAnnualized), `${num(r.beta, 3)}${stars(r.p)}`, num(r.r2, 3), num(r.p, 4), String(r.n)]),
      { numeric: [1, 2, 3, 4, 5] },
    ));
    host.append(el("p", `Excess ${c.frequency} log returns over identical intervals; alpha annualized × ${c.periodsPerYear}. Beta significance: * p<0.10, ** p<0.05, *** p<0.01.`, "muted"));
  }
  $("sddBenchmark").addEventListener("change", renderRegression);

  /* ================= charts ================= */
  const PALETTE = ["#5f9ae6", "#5ef0ab", "#f2c14e", "#ff8fa3", "#b98cff", "#4fd6d6", "#ff9f55", "#9db2d2", "#e6e65f", "#f07ad8"];
  function themeColors() {
    const style = getComputedStyle(app);
    return { text: style.getPropertyValue("--sdd-text").trim(), muted: style.getPropertyValue("--sdd-muted").trim(), grid: style.getPropertyValue("--sdd-grid").trim() };
  }
  function restyleChart(chart) {
    const colors = themeColors();
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = colors.text;
    Object.values(chart.options.scales || {}).forEach(scale => {
      if (scale.ticks) scale.ticks.color = colors.muted;
      if (scale.title) scale.title.color = colors.muted;
      if (scale.grid) scale.grid.color = colors.grid;
    });
    chart.update("none");
  }
  function makeChart(key, canvasId, config) {
    if (!CHART_AVAILABLE) return;
    state.charts[key]?.destroy();
    state.charts[key] = new window.Chart($(canvasId), config);
  }
  function lineConfig(labels, datasets, yTitle, percent) {
    const colors = themeColors();
    return {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: colors.text, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${percent ? pct(ctx.parsed.y) : num(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: colors.muted, maxTicksLimit: 7, autoSkip: true }, grid: { color: colors.grid } },
          y: { title: { display: true, text: yTitle, color: colors.muted }, ticks: { color: colors.muted, callback: v => (percent ? `${(v * 100).toFixed(0)}%` : v) }, grid: { color: colors.grid } },
        },
      },
    };
  }
  function datasetsFor(c, transform) {
    const labels = [...new Set(c.series.flatMap(s => s.observations.map(o => A.isoDate(o.date))))].sort();
    const datasets = c.series.map((s, i) => {
      const map = new Map(transform(s.observations).map(p => [p.date, p.value]));
      return { label: s.ticker, data: labels.map(d => (map.has(d) ? map.get(d) : null)), borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], spanGaps: true, pointRadius: 0, borderWidth: 2, tension: 0.1 };
    });
    return { labels, datasets };
  }
  function renderCompareCharts(c) {
    if (!CHART_AVAILABLE) {
      $("sddCompareWarnings").append(el("p", "Charts could not load (the Chart.js CDN is blocked or offline). Tables and metrics still work.", "sdd-different"));
      return;
    }
    const indexed = datasetsFor(c, A.indexedSeries);
    makeChart("indexed", "sddChartIndexed", lineConfig(indexed.labels, indexed.datasets, "Index (start = 100)", false));
    const drawdown = datasetsFor(c, A.drawdownSeries);
    makeChart("drawdown", "sddChartDrawdown", lineConfig(drawdown.labels, drawdown.datasets, "Drawdown", true));
    const cumulative = datasetsFor(c, obs => A.indexedSeries(obs).map(p => ({ date: p.date, value: p.value === null ? null : p.value / 100 - 1 })));
    makeChart("cumulative", "sddChartCumulative", lineConfig(cumulative.labels, cumulative.datasets, "Cumulative return", true));
    const colors = themeColors();
    const points = c.metrics.filter(m => isNum(m.annualizedVolatility) && isNum(m.annualizedReturn));
    makeChart("scatter", "sddChartScatter", {
      type: "scatter",
      data: { datasets: points.map(m => { const i = c.tickers.indexOf(m.ticker); return { label: m.ticker, data: [{ x: m.annualizedVolatility, y: m.annualizedReturn }], backgroundColor: PALETTE[i % PALETTE.length], pointRadius: 7, pointHoverRadius: 9 }; }) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { labels: { color: colors.text, boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: volatility ${pct(ctx.parsed.x, 1)}, return ${pct(ctx.parsed.y, 1)}` } } },
        scales: {
          x: { title: { display: true, text: "Annualized volatility", color: colors.muted }, ticks: { color: colors.muted, callback: v => `${(v * 100).toFixed(0)}%` }, grid: { color: colors.grid } },
          y: { title: { display: true, text: "Annualized return", color: colors.muted }, ticks: { color: colors.muted, callback: v => `${(v * 100).toFixed(0)}%` }, grid: { color: colors.grid } },
        },
      },
    });
  }

  /* ================= Snapshot: one ticker ================= */
  const snapshotForm = $("sddSnapshotForm");
  snapshotForm.addEventListener("submit", event => { event.preventDefault(); loadSnapshot($("sddSnapshotTicker").value); });

  async function loadSnapshot(rawTicker) {
    const status = $("sddSnapshotStatus");
    const notice = $("sddSnapshotNotice");
    const input = $("sddSnapshotTicker");
    hideNotice(notice);
    let symbol;
    try { symbol = normalizeSymbol(rawTicker); }
    catch (error) {
      input.setAttribute("aria-invalid", "true");
      setStatus(status, describeError(error), "error");
      input.focus();
      return null;
    }
    input.removeAttribute("aria-invalid");
    input.value = symbol;
    state.snapshotController?.abort();
    const controller = new AbortController();
    state.snapshotController = controller;
    $("sddSnapshotRun").disabled = true;
    setStatus(status, `Loading ${symbol}…`, null);
    const now = new Date();
    const range = A.resolveHorizon("1Y", now);
    try {
      let series;
      let source;
      const demo = demoSeries(symbol, now);
      if (demo) {
        series = { ...demo, frequency: "daily" };
        source = { source: "Synthetic demo", via: "generated in your browser", retrievedAt: now.toISOString(), cached: false };
      } else if (state.imported[symbol]) {
        const h = state.imported[symbol];
        const chosen = selectBasis(h, "adjusted");
        series = { ticker: symbol, currency: h.currency, observations: chosen.observations, priceBasis: chosen.priceBasis, frequency: h.frequency, identity: { displayName: null, assetType: null, exchange: null }, market: {} };
        source = { source: "Your CSV file", via: h.fileName, retrievedAt: null, cached: false };
      } else {
        if (!md.liveAvailable()) throw new DataError("Live data needs your own free Alpha Vantage key (Settings). Snapshot also works for tickers in your imported CSV files and for the demo tickers.", { kind: "not_configured" });
        const q = await md.quote(symbol, { signal: controller.signal });
        setStatus(status, `Loading ${symbol} history…`, null);
        const { history, provenance } = await md.history(symbol, range, { signal: controller.signal });
        const chosen = selectBasis(history, "adjusted");
        series = {
          ticker: symbol, currency: history.currency, observations: chosen.observations, priceBasis: chosen.priceBasis, frequency: history.frequency,
          identity: { displayName: history.name, assetType: history.instrumentType, exchange: history.exchange },
          market: { price: q.quote.price, sessionDate: q.quote.sessionDate, previousClose: q.quote.previousClose, dayHigh: q.quote.dayHigh, dayLow: q.quote.dayLow, volume: q.quote.volume, freshness: q.freshness, quoteCached: q.provenance.cached },
        };
        source = { source: provenance.provider, via: provenance.via, retrievedAt: provenance.retrievedAt, cached: provenance.cached && q.provenance.cached, stale: provenance.stale || q.provenance.stale };
      }
      state.snapshot = { series, provenance: source };
      renderSnapshot();
      setStatus(status, `${symbol} loaded${source.cached ? " from this browser's cache" : ""}.`, source.stale ? "warn" : "ok");
      return state.snapshot;
    } catch (error) {
      if (error.kind === "aborted") return null;
      state.snapshot = null;
      $("sddSnapshotResult").hidden = true;
      setStatus(status, describeError(error), "error");
      const configure = error.kind === "not_configured" || error.kind === "auth";
      showNotice(notice, {
        title: error.definitive ? "No data for this ticker." : configure ? "Live data is not set up." : "Prices could not be retrieved.",
        items: [describeError(error)],
        actions: configure ? [{ label: "Open Settings", onClick: openSettings, secondary: false }] : error.definitive ? [] : [{ label: "Retry", onClick: () => loadSnapshot(symbol), secondary: false }],
      });
      return null;
    } finally {
      if (state.snapshotController === controller) state.snapshotController = null;
      $("sddSnapshotRun").disabled = false;
      renderDataStatus();
    }
  }

  function renderSnapshot() {
    const { series, provenance } = state.snapshot;
    const id = series.identity || {};
    const m = series.market || {};
    $("sddSnapshotResult").hidden = false;
    $("sddSnapshotTitle").textContent = `${series.ticker}${id.displayName ? ` — ${id.displayName}` : ""}`;
    fillDl($("sddSnapshotIdentity"), [
      ["Name", id.displayName], ["Asset type", id.assetType], ["Exchange / region", id.exchange], ["Currency", series.currency],
      ["Price basis", BASIS_LABEL[series.priceBasis] || "Unavailable"], ["History", `${series.frequency || "daily"} prices`],
    ]);
    const now = new Date();
    const prepared = A.prepareHistory(series, "1Y", A.resolveHorizon("1Y", now), now);
    const [metrics] = prepared.observations.length >= 2 ? A.runComparison({ [series.ticker]: prepared }).metrics : [null];
    const last = series.observations[series.observations.length - 1];
    fillDl($("sddSnapshotMarket"), [
      ["Latest price", isNum(m.price) ? money(m.price, series.currency) : last ? `${money(last.price, series.currency)} (last ${series.frequency === "weekly" ? "weekly" : ""} close)` : "Unavailable"],
      ["Price date", m.sessionDate || (last ? A.isoDate(last.date) : "Unavailable")],
      ["Freshness", m.freshness ? `${FRESHNESS_LABEL[m.freshness.status]}${m.quoteCached ? " · cached" : ""}` : "—"],
      ["Day range", isNum(m.dayLow) && isNum(m.dayHigh) ? `${money(m.dayLow)} – ${money(m.dayHigh)}` : "Unavailable"],
      ["Previous close", isNum(m.previousClose) ? money(m.previousClose, series.currency) : "Unavailable"],
      ["Volume", isNum(m.volume) ? big(m.volume) : "Unavailable"],
      ["1Y total return", metrics ? pct(metrics.totalReturn) : "—"],
      ["1Y volatility", metrics ? pct(metrics.annualizedVolatility) : "—"],
      ["1Y max drawdown", metrics ? pct(metrics.maxDrawdown) : "—"],
    ]);
    $("sddSnapshotSource").textContent = `${provenance.source}${provenance.via ? ` (${provenance.via})` : ""}${provenance.retrievedAt ? ` · retrieved ${localTime(provenance.retrievedAt)}` : ""}${provenance.cached ? " (cached)" : ""}${provenance.stale ? " · saved copy; the latest refresh failed" : ""}.`;
    const points = series.observations;
    makeChart("snapshot", "sddChartSnapshot", lineConfig(points.map(p => A.isoDate(p.date)), [{
      label: series.ticker, data: points.map(p => p.price), borderColor: PALETTE[0], backgroundColor: PALETTE[0], pointRadius: 0, borderWidth: 2, tension: 0.1,
    }], `Price${series.currency ? ` (${series.currency})` : ""}`, false));
  }

  /* ================= Export ================= */
  function updateExportState() {
    const c = state.comparison;
    $("sddExportComparisonLabel").textContent = c
      ? `Latest comparison: ${c.tickers.join(", ")} · ${c.horizon}${c.source === "Synthetic demo" ? " (synthetic demo)" : ""}`
      : "No comparison yet. Run one on the Comparison tab.";
    ["sddExportXlsx", "sddExportMetrics", "sddExportCorrelation", "sddExportPrices", "sddExportJson"].forEach(id => { $(id).disabled = !c; });
    if (c) setStatus($("sddExportStatus"), "Ready to export.", null);
  }
  function exported(name) { setStatus($("sddExportStatus"), `Downloaded ${name}.`, "ok"); }
  $("sddExportXlsx").addEventListener("click", () => {
    if (!state.comparison) return;
    try {
      const name = `stock-comparison-${timestampSlug()}.xlsx`;
      downloadBlob(buildXlsx(buildWorkbookSheets({ comparison: state.comparison })), name);
      exported(name);
    } catch (_) {
      setStatus($("sddExportStatus"), "The workbook could not be generated. CSV exports are still available.", "error");
    }
  });
  function csvExport(kind) {
    const c = state.comparison;
    if (!c) return;
    let rows;
    if (kind === "metrics") {
      rows = [["Ticker", "Currency", "Price basis", "Frequency", "Total return", "Annualized return", "Annualized volatility", "Sharpe ratio", "Max drawdown", "Return observations", "Actual start", "Actual end", "Source"],
        ...c.metrics.map(m => [m.ticker, m.currency, BASIS_LABEL[m.priceBasis] || "", m.frequency, m.totalReturn, m.annualizedReturn, m.annualizedVolatility, m.sharpe, m.maxDrawdown, m.returnObservations, m.actualStart, m.actualEnd, c.source])];
    } else if (kind === "correlation") {
      rows = [["Ticker", ...c.tickers], ...c.tickers.map(l => [l, ...c.tickers.map(r => c.matrix[l][r])]), [], ["Shared returns", ...c.tickers], ...c.tickers.map(l => [l, ...c.tickers.map(r => c.counts[l][r])])];
    } else {
      rows = [["Date", "Ticker", "Price", "Price basis", "Currency", "Source"], ...c.series.flatMap(s => s.observations.map(o => [A.isoDate(o.date), s.ticker, o.price, BASIS_LABEL[s.priceBasis] || "", s.currency, c.source]))];
    }
    const name = `stock-comparison-${kind}-${timestampSlug()}.csv`;
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), name);
    exported(name);
  }
  $("sddExportMetrics").addEventListener("click", () => csvExport("metrics"));
  $("sddExportCorrelation").addEventListener("click", () => csvExport("correlation"));
  $("sddExportPrices").addEventListener("click", () => csvExport("prices"));
  $("sddExportJson").addEventListener("click", () => {
    const c = state.comparison;
    if (!c) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      disclaimer: "Informational analysis only; not investment advice.",
      comparison: {
        ...c, returns: undefined,
        series: c.series.map(s => ({ ticker: s.ticker, currency: s.currency, nativeCurrency: s.nativeCurrency || s.currency, priceBasis: s.priceBasis, frequency: s.frequency, observations: s.observations.map(o => [A.isoDate(o.date), o.price]) })),
      },
    };
    const name = `stock-comparison-${timestampSlug()}.json`;
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
    exported(name);
  });

  /* ================= Settings ================= */
  $("sddKeyForm").addEventListener("submit", event => {
    event.preventDefault();
    const input = $("sddKey");
    const out = $("sddKeyStatus");
    try {
      const { persistence } = md.setApiKey(input.value, { remember: $("sddKeyRemember").checked });
      input.value = "";
      input.removeAttribute("aria-invalid");
      setStatus(out, md.liveAvailable() ? `Key ${KEY_STORAGE_TEXT[persistence]}.` : "Key removed.", "ok");
    } catch (error) {
      input.setAttribute("aria-invalid", "true");
      setStatus(out, error.message, "error");
    }
    renderDataStatus();
    if (sourceValue() === "live") syncSource();
  });
  $("sddKeyRemove").addEventListener("click", () => {
    md.setApiKey("");
    setStatus($("sddKeyStatus"), "Key removed from this browser, with the responses fetched with it.", null);
    renderDataStatus();
    if (sourceValue() === "live") syncSource();
  });
  $("sddClearCache").addEventListener("click", () => {
    const removed = md.clearCache();
    renderDataStatus();
    $("sddCacheCount").textContent = `Cleared ${removed} saved response${removed === 1 ? "" : "s"}.`;
  });

  renderDataStatus();
  syncSource();
  updateExportState();
  if (!CHART_AVAILABLE) setStatus($("sddCompareStatus"), "Charts could not load (Chart.js CDN blocked or offline); tables and metrics still work.", "warn");
  app.dataset.ready = "true";
}
