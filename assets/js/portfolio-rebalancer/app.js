// Portfolio Rebalancer web app controller.
//
// Portfolio math lives in ./engine.js (kept identical to the desktop program).
// Data:
//   * exchange rates: official Bank of Canada rates (ECB fallback), loaded on page
//     load and editable; built-in dated estimates are used only until then;
//   * prices: typed by the user, or fetched with the visitor's own free Alpha
//     Vantage key (optional). Every price and rate carries its source, which is
//     shown in the table, the plan and the exports.
// Holdings are never sent anywhere or stored: only ticker symbols go to Alpha
// Vantage, and only currency codes go to the central banks.

import * as E from "./engine.js";
import { createMarketData, DataError, describeAge, FRESHNESS_LABEL } from "../market-data/index.js";
import { buildXlsx, toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const root = document.getElementById("rb-app");
if (root) init();

function init() {
  const $ = id => document.getElementById(id);
  const md = createMarketData();
  const SAMPLE = [
    { ticker: "VTI", shares: 120, price: 250, targetWeight: 10, currencyKey: "USD" },
    { ticker: "XIC.TO", shares: 320, price: 36, targetWeight: 10, currencyKey: "CAD" },
    { ticker: "VEQT.TO", shares: 410, price: 42, targetWeight: 20, currencyKey: "CAD" },
    { ticker: "EWJ", shares: 220, price: 64, targetWeight: 10, currencyKey: "USD" },
    { ticker: "VGK", shares: 115, price: 64, targetWeight: 10, currencyKey: "USD" },
    { ticker: "ISF.L", shares: 260, price: 7.4, targetWeight: 10, currencyKey: "GBP" },
    { ticker: "AAPL", shares: 45, price: 180, targetWeight: 10, currencyKey: "USD" },
    { ticker: "BND", shares: 200, price: 72, targetWeight: 10, currencyKey: "USD" },
    { ticker: "MCHI", shares: 140, price: 40, targetWeight: 10, currencyKey: "USD" },
  ].map(row => ({ ...row, source: { kind: "sample", label: "Sample price (illustrative, not market data)" } }));

  const state = {
    // USD per one unit of each currency key, with where each rate came from.
    fx: Object.fromEntries(Object.keys(E.CURRENCY_OPTIONS).map(k => [k, { usd: E.fallbackFxToUsd(k), kind: "default", label: `Built-in estimate (${E.DEFAULT_FX_AS_OF})`, date: E.DEFAULT_FX_AS_OF }])),
    fxNote: "",
    lastPlan: null,
    running: false,
    sources: new WeakMap(), // <tr> -> price source
  };
  const rowsNode = $("rbRows");
  const reportingSelect = $("rbReporting");
  const modeSelect = $("rbMode");
  const budgetInput = $("rbBudget");
  const liveInput = $("rbLive");
  const accountInput = $("rbShowAccount");
  const statusNode = $("rbStatus");
  const errorNode = $("rbError");
  const resultNode = $("rbResults");

  /* ---------------- helpers ---------------- */
  const reportingKey = () => reportingSelect.value;
  const fxToUsd = () => Object.fromEntries(Object.entries(state.fx).map(([k, v]) => [k, v.usd]));
  const moneyIn = key => value => {
    const meta = E.currencyMeta(key);
    return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(value);
  };
  const money = value => moneyIn(reportingKey())(value);
  const pct = value => `${Number(value).toFixed(2)}%`;
  const shares = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  const priceText = value => (Number.isFinite(value) ? Number(value.toFixed(6)).toString() : "");
  const rateText = value => (Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : "");
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function setStatus(text, tone) {
    statusNode.textContent = text;
    if (tone) statusNode.dataset.tone = tone; else delete statusNode.dataset.tone;
  }
  function option(value, label, selected) {
    const o = el("option", label);
    o.value = value;
    o.selected = selected;
    return o;
  }
  const MANUAL = { kind: "manual", label: "Entered by you" };

  /* ---------------- input rows ---------------- */
  function makeRow(index, data = {}) {
    const tr = el("tr");
    tr.dataset.row = String(index);
    const cell = child => { const td = el("td"); if (child) td.append(child); tr.append(td); return td; };
    const input = (cls, type, value, label, attrs = {}) => {
      const i = el("input");
      i.className = cls;
      i.type = type;
      i.value = value ?? "";
      i.setAttribute("aria-label", `${label}, row ${index + 1}`);
      Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
      return i;
    };
    const th = el("th", index + 1);
    th.scope = "row";
    tr.append(th);
    const tickerCell = cell(input("rb-ticker", "text", data.ticker ? String(data.ticker).toUpperCase() : "", "Ticker", { maxlength: "20", autocomplete: "off", spellcheck: "false", placeholder: "e.g. AAPL" }));
    tickerCell.append(el("div", "", "rb-hint"));
    cell(input("rb-shares", "number", Number.isFinite(Number(data.shares)) ? data.shares : "", "Shares", { min: "0", step: "any", inputmode: "decimal" }));
    const priceCell = cell(input("rb-price", "number", data.price !== null && data.price !== undefined && Number.isFinite(Number(data.price)) ? data.price : "", "Price", { min: "0", step: "any", inputmode: "decimal" }));
    priceCell.append(el("div", "", "rb-source"));
    const cur = el("select");
    cur.className = "rb-currency";
    cur.setAttribute("aria-label", `Row currency, row ${index + 1}`);
    Object.entries(E.CURRENCY_OPTIONS).forEach(([k, m]) => cur.append(option(k, m.label, k === (data.currencyKey || "USD"))));
    cell(cur);
    cell().className = "rb-fx num";
    cell().className = "rb-value num";
    cell(input("rb-weight", "number", Number.isFinite(Number(data.targetWeight)) ? data.targetWeight : "", "Target weight percent", { min: "0", step: "any", inputmode: "decimal" }));
    const acct = el("select");
    acct.className = "rb-account";
    acct.setAttribute("aria-label", `Account type, row ${index + 1}`);
    E.ACCOUNT_TYPES.forEach(at => acct.append(option(at, at || "—", at === (data.accountType || ""))));
    const acctCell = cell(acct);
    acctCell.className = "rb-account-col";
    acctCell.hidden = !accountInput.checked;
    state.sources.set(tr, data.source || MANUAL);
    return tr;
  }
  function readRows() {
    return [...rowsNode.querySelectorAll("tr")].map(tr => ({
      ticker: tr.querySelector(".rb-ticker").value.trim().toUpperCase(),
      shares: tr.querySelector(".rb-shares").value,
      price: tr.querySelector(".rb-price").value,
      currencyKey: tr.querySelector(".rb-currency").value,
      targetWeight: tr.querySelector(".rb-weight").value,
      accountType: tr.querySelector(".rb-account").value,
      source: state.sources.get(tr) || MANUAL,
    }));
  }
  function setRows(data) {
    rowsNode.replaceChildren(...data.map((d, i) => makeRow(i, d || {})));
    $("rbRowCount").value = String(data.length);
    refreshTotals();
  }
  const usedCurrencies = () => [...new Set([reportingKey(), ...[...rowsNode.querySelectorAll(".rb-currency")].map(s => s.value)])];

  function refreshTotals() {
    const map = fxToUsd();
    const rep = reportingKey();
    let total = 0;
    let weight = 0;
    let missing = 0;
    rowsNode.querySelectorAll("tr").forEach(tr => {
      const key = tr.querySelector(".rb-currency").value;
      const fx = E.fxToReporting(key, rep, map);
      const qty = Number(tr.querySelector(".rb-shares").value);
      const pxText = tr.querySelector(".rb-price").value;
      const px = Number(pxText);
      const w = Number(tr.querySelector(".rb-weight").value);
      const priced = pxText !== "" && px > 0 && qty >= 0;
      tr.querySelector(".rb-fx").textContent = `${state.fx[key].kind === "default" || state.fx[rep].kind === "default" ? "≈" : ""}${fx.toFixed(4)}`;
      tr.querySelector(".rb-value").textContent = priced ? money(qty * px * fx) : "—";
      if (priced) total += qty * px * fx; else if (tr.querySelector(".rb-ticker").value.trim()) missing += 1;
      if (w >= 0) weight += w;
      const ticker = tr.querySelector(".rb-ticker").value.trim().toUpperCase();
      const hint = tr.querySelector(".rb-hint");
      hint.textContent = E.buildTickerInputHint(ticker, key);
      hint.dataset.tone = "warn";
      const src = state.sources.get(tr) || MANUAL;
      const srcNode = tr.querySelector(".rb-source");
      srcNode.textContent = pxText === "" ? "No price yet" : src.label;
      srcNode.dataset.kind = pxText === "" ? "missing" : src.kind;
    });
    $("rbTotal").textContent = `Current total: ${money(total)}${missing ? ` (excludes ${missing} row${missing === 1 ? "" : "s"} without a price)` : ""}`;
    const weightNode = $("rbWeightTotal");
    weightNode.textContent = `Target weight total: ${pct(weight)}`;
    weightNode.dataset.tone = Math.abs(weight - 100) < 0.005 ? "ok" : "warn";
    ["rbReportingLabel", "rbValueLabel"].forEach(id => { $(id).textContent = E.currencyMeta(rep).label; });
    $("rbBudgetLabel").textContent = `New money budget (${E.currencyMeta(rep).label})`;
    renderFxTable();
  }

  /* ---------------- exchange rates ---------------- */
  // Rebuilds the rate rows only when the set of currencies changes; otherwise values
  // and sources are updated in place, never overwriting an input being edited.
  function renderFxTable() {
    const rep = reportingKey();
    const body = $("rbFxRows");
    const keys = usedCurrencies().filter(k => k !== rep).sort();
    const signature = `${rep}|${keys.join(",")}`;
    if (body.dataset.signature !== signature) {
      body.dataset.signature = signature;
      body.replaceChildren();
      keys.forEach(key => {
        const tr = el("tr");
        const th = el("th", E.currencyMeta(key).code);
        th.scope = "row";
        const input = el("input");
        input.type = "number";
        input.min = "0";
        input.step = "any";
        input.inputMode = "decimal";
        input.className = "rb-fx-input";
        input.dataset.key = key;
        input.setAttribute("aria-label", `${E.currencyMeta(rep).code} per 1 ${E.currencyMeta(key).code}`);
        const inputCell = el("td");
        inputCell.append(input);
        tr.append(th, inputCell, el("td", "", "rb-fx-source"));
        body.append(tr);
      });
      if (!keys.length) {
        const tr = el("tr");
        const td = el("td", "All rows are in the reporting currency; no conversion needed.", "muted");
        td.colSpan = 3;
        tr.append(td);
        body.append(tr);
      }
    }
    body.querySelectorAll("tr").forEach(tr => {
      const input = tr.querySelector(".rb-fx-input");
      if (!input) return;
      const key = input.dataset.key;
      if (document.activeElement !== input) input.value = rateText(state.fx[key].usd / state.fx[rep].usd);
      const src = tr.querySelector(".rb-fx-source");
      src.textContent = sourceLabel(key, rep);
      src.className = `rb-fx-source rb-fx-${state.fx[key].kind === "default" || state.fx[rep].kind === "default" ? "default" : state.fx[key].kind}`;
    });
    $("rbFxReportingCode").textContent = E.currencyMeta(rep).code;
    $("rbFxNote").textContent = state.fxNote;
  }
  function sourceLabel(key, rep) {
    const a = state.fx[key];
    const b = state.fx[rep];
    const worst = [a, b].find(x => x.kind === "default") || [a, b].find(x => x.kind === "manual") || [a, b].find(x => x.stale) || a;
    if (worst.kind === "default") return `Built-in estimate from ${E.DEFAULT_FX_AS_OF}: update before trading`;
    if (worst.kind === "manual") return "Entered by you";
    return `${a.label}${worst.stale ? " (cached; refresh failed)" : ""}`;
  }
  $("rbFxRows").addEventListener("change", event => {
    const input = event.target.closest(".rb-fx-input");
    if (!input) return;
    const value = Number(input.value);
    if (!(value > 0) || !Number.isFinite(value)) { errorNode.textContent = "Exchange rates must be positive numbers."; renderFxTable(); return; }
    const rep = reportingKey();
    state.fx[input.dataset.key] = { usd: value * state.fx[rep].usd, kind: "manual", label: "Entered by you", date: null };
    errorNode.textContent = "";
    refreshTotals();
    recalc();
  });

  // Loads official rates for every currency the tool supports (one request).
  async function loadOfficialFx({ force = false, quiet = false } = {}) {
    const codes = Object.values(E.CURRENCY_OPTIONS).map(m => m.code);
    if (!quiet) setStatus("Loading official exchange rates…", null);
    try {
      const fx = await md.fx.latest(codes, { useCache: !force });
      for (const [key, meta] of Object.entries(E.CURRENCY_OPTIONS)) {
        if (!force && state.fx[key].kind === "manual") continue; // keep the user's own rates
        const r = md.fx.rate(meta.code, "USD", fx.cadPer);
        state.fx[key] = { usd: r.rate, kind: "official", label: `${fx.provider}, ${r.date || "latest"}${r.method === "cross" ? " (derived via CAD)" : ""}`, date: r.date, stale: fx.stale, provider: fx.provider };
      }
      state.fxNote = `${fx.attribution}${fx.stale ? ` Showing the copy saved ${describeAge(fx.ageMs)}; the latest refresh failed.` : ""}`;
      if (!quiet) setStatus(`Exchange rates loaded from the ${fx.provider}.`, fx.stale ? "warn" : "ok");
      return fx;
    } catch (error) {
      state.fxNote = `Official exchange rates are unavailable right now (${error.message}). Built-in estimates from ${E.DEFAULT_FX_AS_OF} are shown; enter current rates or retry.`;
      if (!quiet) setStatus("Official exchange rates could not be loaded; see the exchange-rate table.", "warn");
      return null;
    } finally {
      refreshTotals();
    }
  }
  $("rbFxRefresh").addEventListener("click", async () => { await loadOfficialFx({ force: true }); recalc(); });

  /* ---------------- live prices (visitor's own key) ---------------- */
  function renderLivePanel() {
    const available = md.liveAvailable();
    const usage = md.usage();
    $("rbKeyState").textContent = available
      ? `Key saved in this browser. About ${usage.count} of ${usage.limit} free requests used today here.`
      : "No key saved. Live prices are off; prices you type are used.";
    $("rbKeyRemove").disabled = !available;
    liveInput.disabled = !available;
    if (!available) liveInput.checked = false;
    $("rbLiveLabel").textContent = available
      ? "Fetch latest prices with my Alpha Vantage key (rows keep a typed price if a quote is unavailable)."
      : "Fetch latest prices (add your free Alpha Vantage key below first).";
  }
  $("rbKeyForm").addEventListener("submit", event => {
    event.preventDefault();
    const input = $("rbKey");
    try {
      md.setApiKey(input.value);
      input.value = "";
      $("rbKeyStatus").textContent = md.liveAvailable() ? "Saved in this browser only." : "Key removed.";
      if (md.liveAvailable()) liveInput.checked = true;
    } catch (error) {
      $("rbKeyStatus").textContent = error.message;
    }
    renderLivePanel();
  });
  $("rbKeyRemove").addEventListener("click", () => { md.setApiKey(""); $("rbKeyStatus").textContent = "Key removed from this browser."; renderLivePanel(); });

  /* ---------------- rendering ---------------- */
  function renderPlan(run) {
    const { plan } = run;
    resultNode.replaceChildren();
    const tiles = el("div", null, "pj-tiles");
    const tile = (label, value) => { const t = el("div", null, "pj-tile"); t.append(el("span", label), el("strong", value)); tiles.append(t); };
    tile("Mode", plan.summary.mode === "new_money" ? "New Money" : "Rebalance (Pure)");
    tile("Total current", money(plan.summary.totalCurrent));
    if (plan.summary.mode === "new_money") tile("New money budget", money(plan.summary.budget));
    tile("Target pool", money(plan.summary.pool));
    tile("Total buys", money(plan.summary.totalBuys));
    tile("Total sells", money(plan.summary.totalSells));
    if (plan.summary.mode === "new_money") tile("Budget not invested", money(Math.max(0, plan.summary.budget - plan.summary.totalBuys)));
    resultNode.append(tiles);
    const wrap = el("div", null, "rb-table-wrap");
    const table = el("table", null, "pj-table rb-output");
    const cap = el("caption", `Trade plan in ${E.currencyMeta(run.reportingKey).label} · prices: ${run.priceSummary}`);
    cap.className = "rb-caption";
    table.append(cap);
    const showAccount = accountInput.checked;
    const heads = ["Ticker", ...(showAccount ? ["Account"] : []), "Currency", "Shares", "Price (local)", "Price source", "Current value", "Target weight", "Target value", "Trade value", "Trade (local)", "Trade shares", "Action", "Post-trade shares"];
    const thead = el("thead");
    const hr = el("tr");
    const textCols = new Set(["Ticker", "Account", "Currency", "Action", "Price source"]);
    heads.forEach(h => { const th = el("th", h, textCols.has(h) ? "" : "num"); th.scope = "col"; hr.append(th); });
    thead.append(hr);
    const tbody = el("tbody");
    plan.results.forEach((r, i) => {
      const tr = el("tr");
      const th = el("th", r.ticker);
      th.scope = "row";
      tr.append(th);
      if (showAccount) tr.append(el("td", r.accountType || "—"));
      tr.append(el("td", r.currencyLabel));
      tr.append(el("td", shares(r.shares), "num"), el("td", moneyIn(r.currencyKey)(r.price), "num"), el("td", run.positions[i].source.label, "rb-src-cell"));
      [money(r.currentValue), pct(r.targetWeightNorm * 100), money(r.targetValue), money(r.tradeValue), moneyIn(r.currencyKey)(r.tradeValueLocal), shares(r.tradeShares)].forEach(v => tr.append(el("td", v, "num")));
      const act = el("td");
      act.append(el("span", r.action, `rb-pill rb-${r.action.toLowerCase()}`));
      tr.append(act, el("td", shares(r.postTradeShares), "num"));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    resultNode.append(wrap);
    const list = (items, cls) => {
      if (!items.length) return;
      const ul = el("ul", null, "pj-warnings");
      items.forEach(t => ul.append(el("li", t, cls)));
      resultNode.append(ul);
    };
    list(run.notes, "info");
    list([...plan.warnings, ...run.warnings]);
    resultNode.append(el("p", `Trade shares are fractional. If your broker trades whole shares only, round buys down so totals stay within the budget or sell proceeds. Exchange rates: ${run.fxSummary}. Calculated ${run.at.toLocaleString()}.`, "muted"));
    $("rbExportCsv").disabled = false;
    $("rbExportXlsx").disabled = false;
  }

  /* ---------------- run ---------------- */
  function setRunning(running) {
    state.running = running;
    root.querySelectorAll("input, select, button").forEach(node => {
      if (node.id === "rbExportCsv" || node.id === "rbExportXlsx") return;
      if (running) { node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else { node.disabled = node.dataset.wasDisabled === "true"; delete node.dataset.wasDisabled; }
    });
    root.setAttribute("aria-busy", String(running));
    if (!running) renderLivePanel();
  }

  // Warnings that follow from the inputs as they stand (recomputed on every recalc,
  // so they can never describe an earlier run).
  function provenanceWarnings(positions, rep) {
    const warnings = [];
    const sample = positions.filter(p => p.source.kind === "sample").length;
    if (sample) warnings.push(`${sample} row${sample === 1 ? " uses an illustrative sample price" : "s use illustrative sample prices"}, not market data. Enter real prices or fetch them before relying on this plan.`);
    positions.filter(p => p.source.stale).forEach(p => warnings.push(`${p.ticker}: ${p.source.label}.`));
    const keys = [...new Set([rep, ...positions.map(p => p.currencyKey)])];
    if (keys.length > 1) {
      const defaults = keys.filter(k => state.fx[k].kind === "default").map(k => E.currencyMeta(k).code);
      if (defaults.length) warnings.push(`Exchange rates for ${defaults.join(", ")} are built-in estimates from ${E.DEFAULT_FX_AS_OF}, not current rates. Load official rates or enter your own before trading.`);
      const stale = keys.filter(k => state.fx[k].stale).map(k => E.currencyMeta(k).code);
      if (stale.length) warnings.push(`Exchange rates for ${stale.join(", ")} come from a saved copy because the latest refresh failed.`);
    }
    return [...E.duplicateWarnings(positions), ...warnings];
  }
  const summarizePrices = positions => {
    const counts = {};
    positions.forEach(p => { counts[p.source.kind] = (counts[p.source.kind] || 0) + 1; });
    const names = { live: "fetched", manual: "entered by you", sample: "illustrative sample" };
    return Object.entries(counts).map(([k, n]) => `${n} ${names[k] || k}`).join(", ");
  };
  const summarizeFx = (positions, rep) => {
    const keys = [...new Set([rep, ...positions.map(p => p.currencyKey)])].filter(k => k !== rep);
    if (!keys.length) return "none needed (single currency)";
    return keys.map(k => `${E.currencyMeta(k).code}: ${sourceLabel(k, rep)}`).join("; ");
  };

  function applyQuote(p, tr, result, warnings, notes) {
    const q = result.quote;
    const wanted = E.currencyMeta(p.currencyKey).code;
    const fresh = result.freshness;
    const label = `${q.provider} · ${q.sessionDate || "date unknown"}${result.provenance.cached ? ` · cached ${describeAge(result.provenance.ageMs)}` : ""}`;
    if (!q.currencyVerified || !q.currency) {
      if (p.price === null) throw new Error(`${p.ticker}: the provider did not confirm which currency ${q.symbol} trades in, so its price was not used. Enter the price manually.`);
      warnings.push(`${p.ticker}: the provider did not confirm the listing currency for ${q.symbol}; your typed price was kept.`);
      return;
    }
    if (q.currency !== wanted) {
      const qKey = E.CURRENCY_CODE_TO_KEY[q.currency];
      if (qKey && p.price === null) {
        p.currencyKey = qKey;
        p.currencyLabel = E.currencyMeta(qKey).label;
        warnings.push(`${p.ticker}: ${q.symbol} trades in ${q.currency}, not ${wanted}; the row currency was switched to ${q.currency}.`);
      } else {
        if (p.price === null) throw new Error(`${p.ticker}: ${q.symbol} trades in ${q.currency}, which this tool does not support; enter a manual price.`);
        warnings.push(`${p.ticker}: ${q.symbol} trades in ${q.currency}, not the row's ${wanted}; your typed price was kept. Check the row currency or symbol.`);
        return;
      }
    }
    p.price = q.price;
    p.source = { kind: "live", label, symbol: p.ticker, stale: result.provenance.stale || fresh.status === "stale" };
    if (result.provenance.stale) p.source.label = `${label} · saved copy, refresh failed`;
    else if (fresh.status === "stale") p.source.label = `${label} · ${FRESHNESS_LABEL.stale}`;
    if (q.unitScale !== 1) notes.push(`${p.ticker}: quoted in ${q.rawCurrency} (pence); converted to ${q.currency} (÷100).`);
    if (q.symbol !== p.ticker) notes.push(`${p.ticker}: priced as ${q.symbol}${q.exchange ? ` (${q.exchange})` : ""}.`);
    state.sources.set(tr, p.source);
  }

  async function run() {
    if (state.running) return;
    errorNode.textContent = "";
    const live = liveInput.checked && md.liveAvailable();
    const mode = modeSelect.value;
    const budget = Number(budgetInput.value || "0");
    const rep = reportingKey();
    let positions;
    const rows = readRows();
    try {
      positions = E.validatePositions(rows, { requirePrice: !live }).map((p, i) => ({ ...p, source: rows[i].price === "" ? MANUAL : rows[i].source }));
      if (mode === "new_money" && !(budget > 0)) throw new Error("New money budget must be greater than 0.");
    } catch (error) {
      errorNode.textContent = error.message;
      setStatus("Check the highlighted inputs.", "error");
      return;
    }
    setRunning(true);
    const warnings = [];
    const notes = [];
    try {
      const needed = [...new Set([rep, ...positions.map(p => p.currencyKey)])];
      if (needed.some(k => state.fx[k].kind === "default")) await loadOfficialFx({ quiet: true });
      if (live) {
        const trs = [...rowsNode.querySelectorAll("tr")];
        // Query the listing that matches the row currency first (RY in a CAD row -> RY.TO,
        // TSX:RY -> RY.TO): one request per ticker, no guessing across markets.
        const querySymbol = p => E.buildTickerCandidates(p.ticker, p.currencyKey)[0] || p.ticker;
        const results = await md.quotes(positions.map(querySymbol), {
          onProgress: (symbol, i, n) => setStatus(`Fetching ${symbol} (${i + 1}/${n}) with your Alpha Vantage key…`, null),
        });
        const missing = [];
        for (const p of positions) {
          const result = results.get(querySymbol(p));
          const tr = trs[p.rowIndex];
          if (result?.quote) { applyQuote(p, tr, result, warnings, notes); continue; }
          const error = result?.error || new DataError("no result");
          if (p.price === null) { missing.push(`${p.ticker} (${error.message})`); continue; }
          warnings.push(`${p.ticker}: ${error.kind === "not_found" ? "no quote found" : "live price unavailable"} (${error.message}); your typed price ${priceText(p.price)} was used.`);
        }
        if (missing.length) throw new Error(`No price for: ${missing.join("; ")}. Enter these prices manually and run again.`);
        // Show the prices and currencies actually used in the input table.
        positions.forEach(p => {
          const tr = trs[p.rowIndex];
          tr.querySelector(".rb-currency").value = p.currencyKey;
          tr.querySelector(".rb-price").value = priceText(p.price);
        });
      } else {
        positions.forEach((p, i) => {
          const hint = E.buildTickerInputHint(p.ticker, p.currencyKey);
          if (hint) notes.push(`Row ${i + 1} (${p.ticker}): ${hint}`);
        });
      }
      const enriched = E.attachFxValues(positions, fxToUsd(), rep);
      const plan = E.calculateRebalancePlan(enriched, mode, budget, { money });
      state.lastPlan = { plan, positions, reportingKey: rep, mode, budget, runWarnings: warnings, notes, at: new Date() };
      finishPlan();
    } catch (error) {
      errorNode.textContent = error.message || String(error);
      setStatus("Run failed. Your inputs are unchanged; review the message below.", "error");
    } finally {
      setRunning(false);
      refreshTotals();
      $("rbExportCsv").disabled = !state.lastPlan;
      $("rbExportXlsx").disabled = !state.lastPlan;
    }
  }

  function finishPlan() {
    const run = state.lastPlan;
    run.warnings = [...run.runWarnings, ...provenanceWarnings(run.positions, run.reportingKey)];
    run.priceSummary = summarizePrices(run.positions);
    run.fxSummary = summarizeFx(run.positions, run.reportingKey);
    renderPlan(run);
    const count = run.plan.warnings.length + run.warnings.length;
    setStatus(count ? `Completed with ${count} warning(s). Verify the data before trading.` : "Rebalance completed.", count ? "warn" : "ok");
  }

  // Recalculate from the inputs after edits (no network). Run-specific warnings
  // are dropped; provenance warnings are rebuilt from the current inputs.
  function recalc() {
    if (!state.lastPlan || state.running) return;
    try {
      const rep = reportingKey();
      const rows = readRows();
      const positions = E.validatePositions(rows, { requirePrice: true }).map((p, i) => ({ ...p, source: rows[i].source }));
      const enriched = E.attachFxValues(positions, fxToUsd(), rep);
      const plan = E.calculateRebalancePlan(enriched, modeSelect.value, Number(budgetInput.value || "0"), { money });
      state.lastPlan = { plan, positions, reportingKey: rep, mode: modeSelect.value, budget: Number(budgetInput.value || "0"), runWarnings: [], notes: [], at: new Date() };
      errorNode.textContent = "";
      finishPlan();
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  /* ---------------- exports ---------------- */
  function exportRows() {
    const run = state.lastPlan;
    const rep = E.currencyMeta(run.reportingKey).label;
    return [
      ["Ticker", "Account type", "Row currency", "Shares", "Price (local)", "Price source", `Current value (${rep})`, "Target weight", `Target value (${rep})`, `Trade value (${rep})`, "Trade value (local)", "Trade shares", "Action", "Post-trade shares"],
      ...run.plan.results.map((r, i) => [r.ticker, r.accountType || "", r.currencyLabel, r.shares, r.price, run.positions[i].source.label, r.currentValue, r.targetWeightNorm, r.targetValue, r.tradeValue, r.tradeValueLocal, r.tradeShares, r.action, r.postTradeShares]),
    ];
  }
  const fxRows = run => [...new Set([run.reportingKey, ...run.positions.map(p => p.currencyKey)])].map(k => [E.currencyMeta(k).code, state.fx[k].usd, E.fxToReporting(k, run.reportingKey, fxToUsd()), state.fx[k].kind === "default" ? `Built-in estimate (${E.DEFAULT_FX_AS_OF})` : state.fx[k].label]);
  $("rbExportCsv").addEventListener("click", () => {
    if (!state.lastPlan) return;
    const run = state.lastPlan;
    const rows = [...exportRows(), [], ["Currency", "USD per unit", `${E.currencyMeta(run.reportingKey).code} per unit`, "Rate source"], ...fxRows(run), [], ["Warnings and notes"], ...[...run.notes, ...run.plan.warnings, ...run.warnings].map(w => [w]),
      [], ["Disclaimer", "Illustrative planning only; not financial, investment, or trading advice. Verify prices at your broker before trading."]];
    const name = `rebalance-plan-${timestampSlug()}.csv`;
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });
  $("rbExportXlsx").addEventListener("click", () => {
    const run = state.lastPlan;
    if (!run) return;
    const header = cells => ({ header: true, cells });
    const summary = [
      header(["Portfolio Rebalancer — browser export"]),
      ["Generated at (UTC)", new Date().toISOString()],
      ["Mode", run.mode === "new_money" ? "New Money" : "Rebalance (Pure)"],
      ["Reporting currency", E.currencyMeta(run.reportingKey).code],
      ["Prices", run.priceSummary],
      ["Total current", run.plan.summary.totalCurrent], ["Target pool", run.plan.summary.pool],
      ["Total buys", run.plan.summary.totalBuys], ["Total sells", run.plan.summary.totalSells],
      ...(run.mode === "new_money" ? [["New money budget", run.plan.summary.budget], ["Budget not invested", Math.max(0, run.plan.summary.budget - run.plan.summary.totalBuys)]] : []),
      [],
      header(["Currency", "USD per unit", `${E.currencyMeta(run.reportingKey).code} per unit`, "Rate source"]),
      ...fxRows(run),
      [],
      header(["Warnings and notes"]),
      ...[...run.notes, ...run.plan.warnings, ...run.warnings].map(w => [w]),
      [],
      ["Disclaimer", "Illustrative planning only; not financial, investment, or trading advice. Verify prices at your broker before trading."],
    ];
    const name = `rebalance-plan-${timestampSlug()}.xlsx`;
    const rows = exportRows();
    downloadBlob(buildXlsx([{ name: "Trade Plan", rows: [header(rows[0]), ...rows.slice(1)] }, { name: "Summary", rows: summary }]), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });

  /* ---------------- events ---------------- */
  $("rbRun").addEventListener("click", run);
  $("rbSample").addEventListener("click", () => {
    state.lastPlan = null;
    setRows(SAMPLE);
    budgetInput.value = "10000";
    modeSelect.value = "new_money";
    syncMode();
    resultNode.replaceChildren(el("p", "Run the rebalance to see the trade plan.", "muted"));
    errorNode.textContent = "";
    setStatus("Sample portfolio loaded. Its prices are illustrative, not market data.", null);
  });
  $("rbApplyRows").addEventListener("click", () => {
    const count = Math.max(1, Math.min(E.MAX_ROWS, Math.floor(Number($("rbRowCount").value) || 1)));
    const data = readRows();
    setRows(Array.from({ length: count }, (_, i) => data[i] || null));
    recalc();
  });
  $("rbAddRow").addEventListener("click", () => {
    const data = readRows();
    if (data.length >= E.MAX_ROWS) { errorNode.textContent = `Maximum of ${E.MAX_ROWS} rows.`; return; }
    setRows([...data, null]);
    rowsNode.querySelector("tr:last-child .rb-ticker").focus();
  });
  $("rbRemoveRow").addEventListener("click", () => {
    const data = readRows();
    if (data.length <= 1) { errorNode.textContent = "At least one row is required."; return; }
    setRows(data.slice(0, -1));
    recalc();
  });
  rowsNode.addEventListener("input", event => {
    errorNode.textContent = "";
    const tr = event.target.closest("tr");
    if (!tr) return;
    const src = state.sources.get(tr) || MANUAL;
    // A typed price, or a fetched price whose ticker was then changed, is the user's own.
    if (event.target.classList.contains("rb-price")) state.sources.set(tr, MANUAL);
    if (event.target.classList.contains("rb-ticker") && src.kind !== "manual") {
      state.sources.set(tr, { kind: "manual", label: `Price was for ${src.symbol || "the previous ticker"}; check it`, stale: true });
    }
    refreshTotals();
  });
  rowsNode.addEventListener("change", event => {
    const tr = event.target.closest("tr");
    if (tr && event.target.classList.contains("rb-currency")) {
      const src = state.sources.get(tr) || MANUAL;
      if (src.kind === "live") state.sources.set(tr, { kind: "manual", label: "Currency changed after the price was fetched; check it", stale: true });
    }
    refreshTotals();
    recalc();
  });
  function syncMode() { $("rbBudgetField").hidden = modeSelect.value !== "new_money"; }
  modeSelect.addEventListener("change", () => { syncMode(); recalc(); });
  reportingSelect.addEventListener("change", () => { refreshTotals(); recalc(); });
  budgetInput.addEventListener("change", recalc);
  accountInput.addEventListener("change", () => {
    root.querySelectorAll(".rb-account-col").forEach(n => { n.hidden = !accountInput.checked; });
    recalc();
  });

  setRows(SAMPLE);
  syncMode();
  renderLivePanel();
  setStatus("Ready. Edit the sample or enter your own holdings, then run the rebalance.", null);
  root.dataset.ready = "true";
  loadOfficialFx({ quiet: true }).then(fx => {
    if (!state.running) setStatus(fx ? `Ready. Exchange rates: ${fx.provider}${fx.stale ? " (saved copy)" : ""}. Enter your holdings, then run the rebalance.` : "Ready. Official exchange rates are unavailable; check the exchange-rate table before running.", fx ? null : "warn");
    root.dataset.fxReady = "true";
  });
}
