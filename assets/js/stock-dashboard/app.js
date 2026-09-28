// Stock Comparison & Analytics dashboard controller.
//
// Four sections: Comparison, Snapshot, Export, Settings. All analysis happens in
// this browser. Yahoo Finance is the only market-data source; see ../yahoo/ for
// how it is reached from a static page and how responses are validated.

import { ProxyPipeline, PROXIES, FetchError, validateTemplate } from "../yahoo/proxy.js";
import { fetchHistory, parseChart, quoteUrls, clearCache, cacheSize } from "../yahoo/yahoo.js";
import { normalizeSymbol, normalizeSymbolList, MAX_TICKERS, MIN_COMPARE_TICKERS, SymbolError } from "../yahoo/symbols.js";
import { resolveAligners, normalizeSeries } from "../yahoo/fx.js";
import * as A from "./analytics.js";
import { DEMO_SECURITIES, demoSeries, demoFxRates } from "./demo.js";
import { buildWorkbookSheets } from "./export.js";
import { buildXlsx, toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const app = document.getElementById("sdd-app");
if (app) init();

function init() {
  const $ = id => document.getElementById(id);
  const pipeline = new ProxyPipeline({ siteTemplate: app.dataset.siteProxy || "" });
  const state = {
    comparison: null,       // latest completed comparison (export snapshot)
    compareController: null,
    liveTickers: ["AAPL", "MSFT", "SPY"],
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
  const describeError = error => (error instanceof FetchError || error instanceof SymbolError)
    ? error.message : "Unexpected error. Please try again.";

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
  const openSettings = () => { selectTab($("sddTab-settings")); app.scrollIntoView({ behavior: "smooth", block: "start" }); };

  /* ================= live data status widget ================= */
  function renderPipelineStatus(snapshot = pipeline.snapshot()) {
    const pill = $("sddPipelineState");
    const detail = $("sddPipelineDetail");
    const enabled = snapshot.filter(p => p.enabled);
    const ok = snapshot.find(p => p.preferred) || snapshot.find(p => p.state === "ok");
    let label = "Not tested";
    let tone = "idle";
    if (!enabled.length) { label = "Disabled"; tone = "error"; detail.textContent = "Every proxy is disabled in Settings."; }
    else if (ok) {
      const failing = enabled.filter(p => p.state !== "ok" && p.state !== "untested").length;
      label = failing ? "Online (degraded)" : "Online";
      tone = failing ? "warn" : "ok";
      detail.textContent = `Last success via ${ok.label}${isNum(ok.lastLatencyMs) ? ` · ${Math.round(ok.lastLatencyMs)} ms` : ""}`;
    } else if (enabled.every(p => p.state !== "untested")) {
      label = "Unavailable"; tone = "error";
      detail.textContent = "No proxy is responding right now. Offline demo mode still works.";
    } else if (enabled.some(p => p.state !== "untested")) {
      label = "Degraded"; tone = "warn";
      detail.textContent = "Some proxies failed; others have not been tried yet.";
    } else {
      detail.textContent = "No live request yet.";
    }
    pill.textContent = label;
    pill.className = `sdd-pill ${tone}`;
    const cached = cacheSize();
    $("sddCacheState").textContent = `Cache: ${cached} response${cached === 1 ? "" : "s"}`;
    $("sddCacheCount").textContent = `${cached} cached response${cached === 1 ? "" : "s"}`;
    renderProxyRows(snapshot);
  }
  pipeline.onChange(renderPipelineStatus);

  async function probe(only) {
    const urls = quoteUrls("AAPL");
    return pipeline.fetchValidated(urls, text => parseChart(text, "AAPL"), { only });
  }
  $("sddTestConnection").addEventListener("click", async event => {
    const button = event.currentTarget;
    const out = $("sddTestState");
    button.disabled = true;
    out.textContent = "Testing…";
    try {
      const { proxy } = await probe();
      out.textContent = `Connected via ${proxy.label}.`;
    } catch (error) {
      out.textContent = error.kind === "unavailable" ? "No proxy responded. See Settings." : describeError(error);
    } finally {
      button.disabled = false;
      renderPipelineStatus();
    }
  });

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
    rows.forEach((row, i) => {
      row.querySelector('[data-action="up"]').disabled = i === 0;
      row.querySelector('[data-action="down"]').disabled = i === rows.length - 1;
      row.querySelector('[data-action="remove"]').disabled = rows.length <= MIN_COMPARE_TICKERS;
      row.querySelector("input").readOnly = demo;
    });
    $("sddAddTicker").disabled = demo || rows.length >= MAX_TICKERS;
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
  compareForm.querySelectorAll('input[name="source"]').forEach(radio => radio.addEventListener("change", () => {
    clearRowErrors();
    if (sourceValue() === "demo") {
      state.liveTickers = [...tickerList.querySelectorAll("input")].map(i => i.value.trim()).filter(Boolean);
      setTickers(DEMO_SECURITIES.map(s => s.ticker));
      setStatus($("sddCompareStatus"), "Offline demo: synthetic prices generated in your browser. No network requests.", null);
    } else {
      setTickers(state.liveTickers.length >= MIN_COMPARE_TICKERS ? state.liveTickers : ["AAPL", "MSFT", "SPY"]);
      setStatus($("sddCompareStatus"), "Ready. Enter 2–10 tickers and run the comparison.", null);
    }
  }));
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

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  compareForm.addEventListener("submit", event => { event.preventDefault(); runComparison(); });
  $("sddCancelCompare").addEventListener("click", () => state.compareController?.abort());

  async function runComparison() {
    if (state.compareController) return;
    const status = $("sddCompareStatus");
    const notice = $("sddCompareNotice");
    const demo = sourceValue() === "demo";
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
    const target = $("sddNormalize").value === "off" ? null : $("sddNormalize").value;
    const now = new Date();
    const range = A.resolveHorizon(horizon, now);
    const controller = new AbortController();
    state.compareController = controller;
    $("sddRunCompare").disabled = true;
    $("sddCancelCompare").disabled = false;
    chips.replaceChildren();
    progress.value = 0;
    setStatus(status, demo ? "Generating synthetic demo prices…" : "Requesting Yahoo Finance history…", null);

    const seriesByTicker = {};
    const provenance = [];
    let failures = [];
    let done = 0;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      // Live requests go one at a time with a short gap: public proxies throttle bursts.
      await mapLimit(symbols, demo ? symbols.length : 1, async (symbol, index) => {
        if (!demo && index > 0) await pause(250);
        if (controller.signal.aborted) return;
        chip(symbol, "busy", demo ? "generating" : "queued");
        try {
          if (demo) {
            const series = demoSeries(symbol, now);
            if (!series) throw new SymbolError(`${symbol} is not part of the offline demo.`, symbol);
            seriesByTicker[symbol] = series;
            provenance.push({ ticker: symbol, source: "Synthetic demo", via: "generated in browser", retrievedAt: now.toISOString(), cached: false });
            chip(symbol, "ok", "synthetic");
          } else {
            const { series, provenance: source } = await fetchHistory(pipeline, symbol, range, {
              signal: controller.signal,
              onAttempt: proxy => chip(symbol, "busy", `trying ${proxy.label}`),
            });
            seriesByTicker[symbol] = series;
            provenance.push({ ticker: symbol, ...source });
            chip(symbol, "ok", source.cached ? "cached" : `via ${source.via}`);
          }
        } catch (error) {
          if (error.kind === "aborted" || controller.signal.aborted) return;
          failures.push({ symbol, message: describeError(error), error });
          chip(symbol, "error", error.kind === "not_found" ? "no data" : "failed");
        } finally {
          done += 1;
          progress.value = Math.round(done / symbols.length * (target ? 80 : 95));
          if (!controller.signal.aborted) setStatus(status, `Loaded ${done} of ${symbols.length} tickers…`, null);
        }
      });
      if (controller.signal.aborted) throw new FetchError("Comparison cancelled.", { kind: "aborted" });

      // One retry pass for transient failures, through proxies that worked moments ago.
      const retryable = failures.filter(f => f.error && !f.error.definitive && !(f.error instanceof SymbolError));
      if (!demo && retryable.length && pipeline.snapshot().some(p => p.state === "ok" || p.successes > 0)) {
        setStatus(status, `Retrying ${retryable.map(f => f.symbol).join(", ")} after a short pause…`, null);
        await pause(3000);
        for (const failure of retryable) {
          if (controller.signal.aborted) break;
          chip(failure.symbol, "busy", "retrying");
          try {
            const { series, provenance: source } = await fetchHistory(pipeline, failure.symbol, range, {
              signal: controller.signal, retry: true,
              onAttempt: proxy => chip(failure.symbol, "busy", `retrying via ${proxy.label}`),
            });
            seriesByTicker[failure.symbol] = series;
            provenance.push({ ticker: failure.symbol, ...source });
            failures = failures.filter(f => f !== failure);
            chip(failure.symbol, "ok", `via ${source.via} (retry)`);
          } catch (error) {
            if (error.kind === "aborted" || controller.signal.aborted) break;
            failure.message = describeError(error);
            failure.error = error;
            chip(failure.symbol, "error", error.kind === "not_found" ? "no data" : "failed");
          }
          await pause(400);
        }
      }
      if (controller.signal.aborted) throw new FetchError("Comparison cancelled.", { kind: "aborted" });

      // Horizon trimming and completed-session rule, per ticker.
      let histories = {};
      const warnings = [];
      for (const symbol of symbols) {
        const series = seriesByTicker[symbol];
        if (!series) continue;
        const prepared = A.prepareHistory(series, horizon, range, now);
        warnings.push(...prepared.warnings);
        if (series.minorUnitConverted) warnings.push(`${symbol}: prices quoted in minor units (e.g. pence) were converted to ${series.currency}.`);
        if (series.priceBasis === "close") warnings.push(`${symbol}: adjusted closes were unavailable; unadjusted closes are used.`);
        if (prepared.observations.length >= 2) histories[symbol] = prepared;
        else failures.push({ symbol, message: `${symbol}: fewer than two completed sessions in the ${horizon} window.` });
      }
      let normalizedTo = null;
      const fxSources = {};
      if (target && Object.keys(histories).length) {
        setStatus(status, `Normalizing to ${target}…`, null);
        const { aligners, sources, warnings: fxWarnings } = await resolveAligners(histories, target, range, {
          pipeline, signal: controller.signal, offlineRates: demo ? (from, to) => demoFxRates(from, to, now) : null,
          onStatus: text => setStatus(status, text, null),
        });
        const normalized = normalizeSeries(histories, target, aligners);
        histories = normalized.series;
        warnings.push(...fxWarnings, ...normalized.warnings);
        Object.assign(fxSources, sources);
        normalizedTo = target;
      }
      if (controller.signal.aborted) throw new FetchError("Comparison cancelled.", { kind: "aborted" });

      const usable = symbols.filter(s => histories[s]);
      if (usable.length < MIN_COMPARE_TICKERS) {
        const allNetwork = failures.length && failures.every(f => f.error && !f.error.definitive);
        setStatus(status, usable.length ? "Only one ticker returned usable data; a comparison needs at least two." : "No usable price history was returned.", "error");
        showNotice(notice, {
          title: allNetwork ? "Live data could not be reached." : "The comparison could not be completed.",
          items: [
            ...failures.map(f => f.message),
            ...(allNetwork ? ["Public proxies are rate-limited or down. Wait a minute and retry, add your own proxy in Settings, or use the offline demo."] : []),
          ],
          actions: [
            { label: "Retry", onClick: () => runComparison(), secondary: false },
            { label: "Use offline demo", onClick: () => { compareForm.querySelector('input[value="demo"]').click(); runComparison(); } },
            { label: "Proxy settings", onClick: openSettings },
          ],
        });
        progress.value = 0;
        return;
      }
      const result = A.runComparison(Object.fromEntries(usable.map(s => [s, histories[s]])), { riskFreeAnnual: riskFree });
      const allWarnings = [...new Set([...result.warnings, ...warnings])];
      state.comparison = {
        tickers: usable, horizon, riskFree, normalizedTo, fxSources,
        requestedStart: A.isoDate(range.start), requestedEnd: A.isoDate(range.end),
        completedAt: new Date().toISOString(), source: demo ? "Synthetic demo" : "Yahoo Finance",
        series: usable.map(s => histories[s]), metrics: result.metrics, matrix: result.matrix, counts: result.counts,
        returns: result.returns, warnings: allWarnings, failures: failures.map(f => f.message),
        provenance: provenance.filter(p => usable.includes(p.ticker)), regression: null,
      };
      progress.value = 100;
      renderComparison();
      const partial = failures.length ? ` ${failures.length} ticker${failures.length === 1 ? "" : "s"} skipped.` : "";
      setStatus(status, `Comparison complete: ${usable.length} securities, ${horizon}.${partial}`, failures.length ? "warn" : "ok");
      if (failures.length) {
        showNotice(notice, { tone: "warn", title: "Some tickers were skipped.", items: failures.map(f => f.message), actions: [{ label: "Retry", onClick: () => runComparison() }] });
      }
      updateExportState();
    } catch (error) {
      if (error.kind === "aborted" || controller.signal.aborted) {
        setStatus(status, "Comparison cancelled. Completed requests stay cached for 15 minutes.", "warn");
      } else {
        setStatus(status, describeError(error), "error");
        showNotice(notice, { title: "The comparison failed.", items: [describeError(error)], actions: [{ label: "Retry", onClick: () => runComparison(), secondary: false }, { label: "Proxy settings", onClick: openSettings }] });
      }
      progress.value = 0;
    } finally {
      state.compareController = null;
      $("sddRunCompare").disabled = false;
      $("sddCancelCompare").disabled = true;
      renderPipelineStatus();
    }
  }

  /* ================= Compare: render ================= */
  function renderComparison() {
    const c = state.comparison;
    $("sddCompareResult").hidden = false;
    $("sddCompareMeta").textContent = `${c.horizon} · requested ${c.requestedStart} to ${c.requestedEnd} · ${c.source}` +
      `${c.normalizedTo ? ` · normalized to ${c.normalizedTo}` : " · native currencies"} · completed ${localTime(c.completedAt)}`;
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
      tr.append(th, el("td", m.currency ?? "Unknown"));
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
    c.provenance.forEach(p => sources.append(el("li", `${p.ticker} · ${p.source}${p.via ? ` via ${p.via}` : ""} · retrieved ${localTime(p.retrievedAt)}${p.cached ? " (from 15-minute cache)" : ""}`)));
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
    const rows = c.tickers.filter(t => t !== benchmark).map(t => ({ ticker: t, ...A.regression(c.returns[t], c.returns[benchmark], c.riskFree) }));
    c.regression = { benchmark, rows };
    const stars = p => (isNum(p) ? (p < 0.01 ? " ***" : p < 0.05 ? " **" : p < 0.1 ? " *" : "") : "");
    const host = $("sddRegression");
    host.replaceChildren(table(
      [`Y vs ${benchmark}`, "Alpha (annualized)", "Beta", "R²", "p-value (beta)", "Shared returns"],
      rows.map(r => [r.ticker, pct(r.alphaAnnualized), `${num(r.beta, 3)}${stars(r.p)}`, num(r.r2, 3), num(r.p, 4), String(r.n)]),
      { numeric: [1, 2, 3, 4, 5] },
    ));
    host.append(el("p", "Excess daily log returns over identical intervals. Beta significance: * p<0.10, ** p<0.05, *** p<0.01.", "muted"));
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
        series = demo;
        source = { source: "Synthetic demo", via: "generated in browser", retrievedAt: now.toISOString(), cached: false };
      } else {
        ({ series, provenance: source } = await fetchHistory(pipeline, symbol, range, {
          signal: controller.signal, onAttempt: proxy => setStatus(status, `Loading ${symbol} via ${proxy.label}…`, null),
        }));
      }
      state.snapshot = { series, provenance: source };
      renderSnapshot();
      setStatus(status, `${symbol} loaded${source.cached ? " from cache" : ""}.`, "ok");
      return state.snapshot;
    } catch (error) {
      if (error.kind === "aborted") return null;
      setStatus(status, describeError(error), "error");
      showNotice(notice, {
        title: error.definitive ? "Ticker not found." : "Live data could not be reached.",
        items: [describeError(error), ...(error.definitive ? ["Check the symbol; non-US listings need a Yahoo suffix such as .TO or .L."] : [])],
        actions: error.definitive ? [] : [{ label: "Retry", onClick: () => loadSnapshot(symbol), secondary: false }, { label: "Proxy settings", onClick: openSettings }],
      });
      return null;
    } finally {
      if (state.snapshotController === controller) state.snapshotController = null;
      $("sddSnapshotRun").disabled = false;
      renderPipelineStatus();
    }
  }

  function renderSnapshot() {
    const { series, provenance } = state.snapshot;
    const id = series.identity;
    const m = series.market;
    $("sddSnapshotResult").hidden = false;
    $("sddSnapshotTitle").textContent = `${series.ticker}${id.displayName ? ` — ${id.displayName}` : ""}`;
    fillDl($("sddSnapshotIdentity"), [
      ["Name", id.displayName], ["Asset type", id.assetType], ["Exchange", id.exchange], ["Currency", series.currency],
      ["Price basis", series.priceBasis === "adjusted_close" ? "Adjusted close" : series.priceBasis === "synthetic" ? "Synthetic" : "Close (unadjusted)"],
    ]);
    const now = new Date();
    const prepared = A.prepareHistory(series, "1Y", A.resolveHorizon("1Y", now), now);
    const [metrics] = prepared.observations.length >= 2 ? A.runComparison({ [series.ticker]: prepared }).metrics : [null];
    fillDl($("sddSnapshotMarket"), [
      ["Last price", money(m.price, series.currency)],
      ["Market time", m.marketTime ? localTime(m.marketTime) : "Unavailable"],
      ["Day range", isNum(m.dayLow) && isNum(m.dayHigh) ? `${money(m.dayLow)} – ${money(m.dayHigh)}` : "Unavailable"],
      ["52-week range", isNum(m.week52Low) && isNum(m.week52High) ? `${money(m.week52Low)} – ${money(m.week52High)}` : "Unavailable"],
      ["Volume", isNum(m.volume) ? big(m.volume) : "Unavailable"],
      ["1Y total return", metrics ? pct(metrics.totalReturn) : "—"],
      ["1Y volatility", metrics ? pct(metrics.annualizedVolatility) : "—"],
      ["1Y max drawdown", metrics ? pct(metrics.maxDrawdown) : "—"],
    ]);
    $("sddSnapshotSource").textContent = `${provenance.source}${provenance.via ? ` via ${provenance.via}` : ""} · retrieved ${localTime(provenance.retrievedAt)}${provenance.cached ? " (cached)" : ""}. Market price fields come from Yahoo's chart metadata and may be delayed.`;
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
      rows = [["Ticker", "Currency", "Total return", "Annualized return", "Annualized volatility", "Sharpe ratio", "Max drawdown", "Return observations", "Actual start", "Actual end"],
        ...c.metrics.map(m => [m.ticker, m.currency, m.totalReturn, m.annualizedReturn, m.annualizedVolatility, m.sharpe, m.maxDrawdown, m.returnObservations, m.actualStart, m.actualEnd])];
    } else if (kind === "correlation") {
      rows = [["Ticker", ...c.tickers], ...c.tickers.map(l => [l, ...c.tickers.map(r => c.matrix[l][r])]), [], ["Shared returns", ...c.tickers], ...c.tickers.map(l => [l, ...c.tickers.map(r => c.counts[l][r])])];
    } else {
      rows = [["Date", "Ticker", "Adjusted close", "Currency"], ...c.series.flatMap(s => s.observations.map(o => [A.isoDate(o.date), s.ticker, o.price, s.currency]))];
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
        series: c.series.map(s => ({ ticker: s.ticker, currency: s.currency, observations: s.observations.map(o => [A.isoDate(o.date), o.price]) })),
      },
    };
    const name = `stock-comparison-${timestampSlug()}.json`;
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
    exported(name);
  });

  /* ================= Settings ================= */
  function renderProxyRows(snapshot = pipeline.snapshot()) {
    const body = $("sddProxyRows");
    body.replaceChildren();
    snapshot.forEach(p => {
      const tr = el("tr");
      const use = el("td");
      const box = el("input");
      box.type = "checkbox";
      box.checked = !pipeline.settings.disabled.includes(p.id);
      box.disabled = !p.configured;
      box.setAttribute("aria-label", `Use ${p.label}`);
      box.addEventListener("change", () => {
        const disabled = new Set(pipeline.settings.disabled);
        if (box.checked) disabled.delete(p.id); else disabled.add(p.id);
        pipeline.updateSettings({ disabled: [...disabled] });
      });
      use.append(box);
      const name = el("td");
      name.append(el("strong", p.label));
      if (p.note) name.append(el("div", p.note, "muted"));
      const labels = { untested: "Not tried", ok: "Working", failing: "Failing", "rate-limited": "Rate-limited", "needs-key": "Needs API key" };
      const statusText = !p.configured ? "Not configured" : `${labels[p.state] || p.state}${p.coolingDownFor ? ` · retry in ${Math.ceil(p.coolingDownFor / 1000)}s` : ""}${p.preferred ? " · preferred" : ""}`;
      const statusCell = el("td", statusText);
      const last = el("td", p.lastError ? p.lastError : isNum(p.lastLatencyMs) ? `${Math.round(p.lastLatencyMs)} ms` : "—");
      tr.append(use, name, statusCell, last);
      body.append(tr);
    });
  }
  $("sddProxyTest").addEventListener("click", async event => {
    const button = event.currentTarget;
    const out = $("sddProxyStatus");
    button.disabled = true;
    const candidates = PROXIES.filter(p => pipeline.isEnabled(p));
    let working = 0;
    for (const proxy of candidates) {
      setStatus(out, `Testing ${proxy.label}…`, null);
      try { await probe(proxy.id); working += 1; } catch (_) { /* recorded in proxy health */ }
    }
    setStatus(out, `${working} of ${candidates.length} proxies returned valid Yahoo Finance data.`, working ? "ok" : "error");
    button.disabled = false;
  });
  $("sddProxyReset").addEventListener("click", () => { pipeline.resetHealth(); setStatus($("sddProxyStatus"), "Proxy health reset; every proxy will be tried again.", null); });

  const keyInput = $("sddCorsproxyKey");
  const templateInput = $("sddCustomProxy");
  keyInput.value = pipeline.settings.corsproxyKey;
  templateInput.value = pipeline.settings.customTemplate;
  $("sddProxySettings").addEventListener("submit", event => {
    event.preventDefault();
    const out = $("sddProxySettingsStatus");
    const template = templateInput.value.trim();
    if (!validateTemplate(template)) {
      templateInput.setAttribute("aria-invalid", "true");
      setStatus(out, "The custom proxy must be an https URL containing {url} exactly once.", "error");
      templateInput.focus();
      return;
    }
    templateInput.removeAttribute("aria-invalid");
    const key = keyInput.value.trim();
    if (key && !/^[\w.-]{8,200}$/.test(key)) {
      keyInput.setAttribute("aria-invalid", "true");
      setStatus(out, "That does not look like a corsproxy.io API key.", "error");
      return;
    }
    keyInput.removeAttribute("aria-invalid");
    pipeline.updateSettings({ customTemplate: template, corsproxyKey: key });
    setStatus(out, "Saved in this browser only.", "ok");
  });
  $("sddProxyClear").addEventListener("click", () => {
    keyInput.value = "";
    templateInput.value = "";
    pipeline.updateSettings({ customTemplate: "", corsproxyKey: "" });
    setStatus($("sddProxySettingsStatus"), "Proxy settings cleared.", null);
  });
  const workerLink = $("sddWorkerLink");
  workerLink.href = app.dataset.workerExample || "#";
  $("sddClearCache").addEventListener("click", () => {
    const removed = clearCache();
    renderPipelineStatus();
    $("sddCacheCount").textContent = `Cleared ${removed} cached response${removed === 1 ? "" : "s"}.`;
  });

  renderPipelineStatus();
  updateExportState();
  if (!CHART_AVAILABLE) setStatus($("sddCompareStatus"), "Charts could not load (Chart.js CDN blocked or offline); tables and metrics still work.", "warn");
  app.dataset.ready = "true";
}
