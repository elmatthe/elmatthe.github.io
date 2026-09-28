// Portfolio Rebalancer web app controller.
//
// Portfolio math lives in ./engine.js. Optional live prices and FX come only from
// Yahoo Finance through the shared, validated proxy pipeline in ../yahoo/.

import * as E from "./engine.js";
import { ProxyPipeline, FetchError } from "../yahoo/proxy.js";
import { fetchQuote } from "../yahoo/yahoo.js";
import { fetchFxRate } from "../yahoo/fx.js";
import { SymbolError } from "../yahoo/symbols.js";
import { buildXlsx, toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const root = document.getElementById("rb-app");
if (root) init();

function init() {
  const $ = id => document.getElementById(id);
  const pipeline = new ProxyPipeline({ siteTemplate: root.dataset.siteProxy || "" });
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
  ];
  const state = {
    liveFxToUsd: {},   // currencyKey -> USD per unit, from the last live run
    liveFxKeys: {},
    lastPlan: null,    // { plan, positions, reportingKey, mode, budget, warnings, notes, live, at }
    running: false,
    lookups: {},       // rowIndex -> { ticker, text, tone }
    lookupTimers: {},
    lookupTokens: {},
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
  const fxMap = () => Object.fromEntries(Object.keys(E.CURRENCY_OPTIONS).map(k => [k, k in state.liveFxToUsd ? state.liveFxToUsd[k] : E.fallbackFxToUsd(k)]));
  const moneyIn = key => value => {
    const meta = E.currencyMeta(key);
    return new Intl.NumberFormat(meta.locale, { style: "currency", currency: meta.code }).format(value);
  };
  const money = value => moneyIn(reportingKey())(value);
  const pct = value => `${Number(value).toFixed(2)}%`;
  const shares = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  const fxText = (value, live) => `${live ? "~" : ""}${(Number.isFinite(value) ? value : 0).toFixed(4)}`;
  const priceText = value => (Number.isFinite(value) ? Number(value.toFixed(4)).toString() : "");
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
    cell(input("rb-shares", "number", Number.isFinite(Number(data.shares)) ? data.shares : "", "Shares", { min: "0", step: "0.0001", inputmode: "decimal" }));
    cell(input("rb-price", "number", Number.isFinite(Number(data.price)) ? data.price : "", "Price", { min: "0", step: "0.0001", inputmode: "decimal" }));
    const cur = el("select");
    cur.className = "rb-currency";
    cur.setAttribute("aria-label", `Row currency, row ${index + 1}`);
    Object.entries(E.CURRENCY_OPTIONS).forEach(([k, m]) => cur.append(option(k, m.label, k === (data.currencyKey || "USD"))));
    cell(cur);
    cell().className = "rb-fx num";
    cell().className = "rb-value num";
    cell(input("rb-weight", "number", Number.isFinite(Number(data.targetWeight)) ? data.targetWeight : "", "Target weight percent", { min: "0", step: "0.01", inputmode: "decimal" }));
    const acct = el("select");
    acct.className = "rb-account";
    acct.setAttribute("aria-label", `Account type, row ${index + 1}`);
    E.ACCOUNT_TYPES.forEach(at => acct.append(option(at, at || "—", at === (data.accountType || ""))));
    const acctCell = cell(acct);
    acctCell.className = "rb-account-col";
    acctCell.hidden = !accountInput.checked;
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
    }));
  }
  function setRows(data) {
    Object.values(state.lookupTimers).forEach(clearTimeout);
    Object.assign(state, { lookups: {}, lookupTimers: {}, lookupTokens: {} });
    rowsNode.replaceChildren(...data.map((d, i) => makeRow(i, d || {})));
    $("rbRowCount").value = String(data.length);
    refreshTotals();
  }
  function refreshTotals() {
    const map = fxMap();
    const rep = reportingKey();
    let total = 0;
    let weight = 0;
    rowsNode.querySelectorAll("tr").forEach(tr => {
      const idx = Number(tr.dataset.row);
      const key = tr.querySelector(".rb-currency").value;
      const fx = E.fxToReporting(key, rep, map);
      const qty = Number(tr.querySelector(".rb-shares").value);
      const px = Number(tr.querySelector(".rb-price").value);
      const w = Number(tr.querySelector(".rb-weight").value);
      const value = qty >= 0 && px > 0 ? qty * px * fx : 0;
      tr.querySelector(".rb-fx").textContent = fxText(fx, state.liveFxKeys[key] || state.liveFxKeys[rep]);
      tr.querySelector(".rb-value").textContent = money(value);
      total += value;
      if (w >= 0) weight += w;
      const hint = tr.querySelector(".rb-hint");
      const ticker = tr.querySelector(".rb-ticker").value.trim().toUpperCase();
      const lookup = state.lookups[idx];
      if (lookup && lookup.ticker === ticker) { hint.textContent = lookup.text; hint.dataset.tone = lookup.tone; }
      else { hint.textContent = E.buildTickerInputHint(ticker, key); hint.dataset.tone = "warn"; }
    });
    $("rbTotal").textContent = `Current total: ${money(total)}`;
    const weightNode = $("rbWeightTotal");
    weightNode.textContent = `Target weight total: ${pct(weight)}`;
    weightNode.dataset.tone = Math.abs(weight - 100) < 0.005 ? "ok" : "warn";
    ["rbReportingLabel", "rbValueLabel"].forEach(id => { $(id).textContent = E.currencyMeta(rep).label; });
    $("rbBudgetLabel").textContent = `New money budget (${E.currencyMeta(rep).label})`;
  }

  /* ---------------- Yahoo lookups ---------------- */
  // Resolves a row's ticker to a Yahoo quote. Returns { quote, candidates } or
  // { quote: null } when no candidate exists; throws FetchError on transport failure.
  async function resolveQuote(ticker, currencyKey, { crossMarket = true } = {}) {
    const wanted = E.currencyMeta(currencyKey).code;
    const candidates = E.buildTickerCandidates(ticker, currencyKey);
    let fallback = null;
    const tryOne = async symbol => {
      try {
        const q = await fetchQuote(pipeline, symbol);
        const { quoteCurrency } = E.normalizeQuoteCurrency(q.currency === "CNH" ? "CNY" : q.currency);
        return { resolvedTicker: q.symbol, price: q.price, quoteCurrency, rawQuoteCurrency: q.rawCurrency, unitScale: q.unitScale, name: q.name, via: q.provenance.via };
      } catch (error) {
        if (error instanceof SymbolError || (error instanceof FetchError && error.definitive)) return null;
        throw error;
      }
    };
    for (const symbol of candidates) {
      const q = await tryOne(symbol);
      if (!q) continue;
      if (q.quoteCurrency === wanted) return { quote: q, candidates };
      fallback ||= q;
    }
    if (fallback || !crossMarket) return { quote: fallback, candidates };
    for (const symbol of E.buildCrossMarketCandidates(ticker, candidates)) {
      const q = await tryOne(symbol);
      if (q) return { quote: q, candidates, crossMarket: true };
    }
    return { quote: null, candidates };
  }

  function scheduleLookup(tr) {
    const idx = Number(tr.dataset.row);
    clearTimeout(state.lookupTimers[idx]);
    const token = (state.lookupTokens[idx] || 0) + 1;
    state.lookupTokens[idx] = token;
    delete state.lookups[idx];
    state.lookupTimers[idx] = setTimeout(() => lookupRow(tr, idx, token), 800);
  }
  async function lookupRow(tr, idx, token) {
    const ticker = tr.querySelector(".rb-ticker").value.trim().toUpperCase();
    const key = tr.querySelector(".rb-currency").value;
    if (!ticker || state.running) return;
    const apply = (text, tone) => {
      if (state.lookupTokens[idx] !== token || tr.querySelector(".rb-ticker").value.trim().toUpperCase() !== ticker) return;
      state.lookups[idx] = { ticker, text, tone };
      refreshTotals();
    };
    apply(`Checking ${ticker} on Yahoo Finance…`, "info");
    try {
      const { quote, crossMarket } = await resolveQuote(ticker, key);
      const code = E.currencyMeta(key).code;
      if (!quote) apply(`Not found on Yahoo Finance. ${E.buildTickerInputHint(ticker, key) || "Verify the symbol at finance.yahoo.com."}`, "error");
      else if (quote.quoteCurrency !== code) apply(`${crossMarket ? `${ticker} not found in ${code}. ` : ""}Found ${quote.resolvedTicker} quoted in ${quote.quoteCurrency}${quote.name ? ` (${quote.name})` : ""}. Check the row currency or symbol.`, "warn");
      else apply(`Verified ${quote.resolvedTicker}${quote.name ? ` · ${quote.name}` : ""} · ${moneyIn(key)(quote.price)}`, "ok");
    } catch (_) {
      apply(E.buildTickerInputHint(ticker, key) || "Live lookup unavailable right now; enter the price manually.", "warn");
    }
  }

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
    resultNode.append(tiles);
    const wrap = el("div", null, "rb-table-wrap");
    const table = el("table", null, "pj-table rb-output");
    const cap = el("caption", `Trade plan in ${E.currencyMeta(run.reportingKey).label}${run.live ? " using live Yahoo Finance prices" : ""}`);
    cap.className = "rb-caption";
    table.append(cap);
    const showAccount = accountInput.checked;
    const heads = ["Ticker", ...(showAccount ? ["Account"] : []), "Currency", "Shares", "Price (local)", "Current value", "Target weight", "Target value", "Trade value", "Trade (local)", "Trade shares", "Action", "Post-trade shares"];
    const thead = el("thead");
    const hr = el("tr");
    heads.forEach((h, i) => { const th = el("th", h, i > 1 && h !== "Currency" && h !== "Action" && h !== "Account" ? "num" : ""); th.scope = "col"; hr.append(th); });
    thead.append(hr);
    const tbody = el("tbody");
    plan.results.forEach(r => {
      const tr = el("tr");
      const th = el("th", r.ticker);
      th.scope = "row";
      tr.append(th);
      if (showAccount) tr.append(el("td", r.accountType || "—"));
      tr.append(el("td", r.currencyLabel));
      [shares(r.shares), moneyIn(r.currencyKey)(r.price), money(r.currentValue), pct(r.targetWeightNorm * 100), money(r.targetValue),
        money(r.tradeValue), moneyIn(r.currencyKey)(r.tradeValueLocal), shares(r.tradeShares)].forEach(v => tr.append(el("td", v, "num")));
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
    const meta = el("p", `${run.live ? "Live prices and FX from Yahoo Finance" : "Manual prices; offline fallback FX rates"} · calculated ${run.at.toLocaleString()}`, "muted");
    resultNode.append(meta);
    $("rbExportCsv").disabled = false;
    $("rbExportXlsx").disabled = false;
  }

  /* ---------------- run ---------------- */
  function setRunning(running) {
    state.running = running;
    root.querySelectorAll("input, select, button").forEach(node => {
      if (node.id === "rbExportCsv" || node.id === "rbExportXlsx") return;
      node.disabled = running;
    });
    root.setAttribute("aria-busy", String(running));
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function run() {
    if (state.running) return;
    errorNode.textContent = "";
    const live = liveInput.checked;
    const mode = modeSelect.value;
    const budget = Number(budgetInput.value || "0");
    const rep = reportingKey();
    let positions;
    try {
      positions = E.validatePositions(readRows(), { requirePrice: !live });
      if (mode === "new_money" && !(budget > 0)) throw new Error("New money budget must be greater than 0.");
    } catch (error) {
      errorNode.textContent = error.message;
      setStatus("Check the highlighted inputs.", "error");
      return;
    }
    setRunning(true);
    const warnings = [];
    const notes = [];
    const fxToUsd = Object.fromEntries(Object.keys(E.CURRENCY_OPTIONS).map(k => [k, E.fallbackFxToUsd(k)]));
    try {
      if (live) {
        const liveKeys = {};
        let transportFailures = 0;
        for (const [i, p] of positions.entries()) {
          setStatus(`Fetching ${p.ticker} from Yahoo Finance (${i + 1}/${positions.length})…`, null);
          if (i) await pause(200);
          let resolved;
          try {
            resolved = await resolveQuote(p.ticker, p.currencyKey);
          } catch (error) {
            transportFailures += 1;
            if (p.price === null) {
              throw new Error(`Live data could not be reached for ${p.ticker} (${error.message}). Enter a manual price, or retry in a minute.`);
            }
            warnings.push(`${p.ticker}: live data could not be reached; using your manual price ${p.price.toFixed(4)}.`);
            continue;
          }
          const q = resolved.quote;
          const wanted = E.currencyMeta(p.currencyKey).code;
          if (!q) {
            const tried = resolved.candidates.join(", ") || p.ticker;
            if (p.price === null) throw new Error(`No Yahoo Finance quote for ${p.ticker} (tried: ${tried}). Verify the symbol at finance.yahoo.com or enter a manual price.`);
            warnings.push(`${p.ticker}: no Yahoo Finance quote (tried: ${tried}); using your manual price ${p.price.toFixed(4)}.`);
            continue;
          }
          if (q.quoteCurrency !== wanted) {
            const qKey = E.CURRENCY_CODE_TO_KEY[q.quoteCurrency];
            if (qKey && p.price === null) {
              p.currencyKey = qKey;
              p.currencyLabel = E.currencyMeta(qKey).label;
              p.price = q.price;
              warnings.push(`${p.ticker}: not found in the selected ${wanted} market; using ${q.resolvedTicker} (${q.quoteCurrency}) and switched the row currency to ${q.quoteCurrency} for this run.`);
              continue;
            }
            if (p.price !== null) {
              warnings.push(`${p.ticker}: found ${q.resolvedTicker} quoted in ${q.quoteCurrency}, not ${wanted}; keeping your manual price ${p.price.toFixed(4)}. Check the row currency or symbol.`);
              continue;
            }
            throw new Error(`${p.ticker}: Yahoo Finance quotes ${q.resolvedTicker} in ${q.quoteCurrency}, which this tool does not support; enter a manual price.`);
          }
          p.price = q.price;
          if (q.resolvedTicker !== p.ticker) warnings.push(`${p.ticker}: used Yahoo Finance symbol ${q.resolvedTicker}.`);
          if (q.unitScale !== 1) notes.push(`${p.ticker}: Yahoo Finance quotes this listing in ${q.rawQuoteCurrency} (pence); converted to ${q.quoteCurrency} (÷100).`);
        }
        setStatus("Fetching live FX rates from Yahoo Finance…", null);
        const needed = [...new Set([rep, ...positions.map(p => p.currencyKey)])].sort();
        for (const key of needed) {
          const code = E.currencyMeta(key).code;
          if (code === "USD") { fxToUsd[key] = 1; liveKeys[key] = true; continue; }
          try {
            const { rate } = await fetchFxRate(pipeline, code, "USD");
            fxToUsd[key] = rate;
            liveKeys[key] = true;
          } catch (error) {
            warnings.push(`Live FX ${code}USD=X unavailable (${error.message}); using fallback rate ${E.fallbackFxToUsd(key).toFixed(4)}.`);
          }
        }
        if (transportFailures) warnings.push("Some live Yahoo Finance requests failed because the public relays this site uses are busy or offline. The affected rows use your entered prices and fallback FX; retry in a minute for live data.");
        state.liveFxToUsd = { ...fxToUsd };
        state.liveFxKeys = liveKeys;
        // Show the prices and currencies actually used in the input table.
        positions.forEach(p => {
          const tr = rowsNode.querySelector(`tr[data-row="${p.rowIndex}"]`);
          if (!tr) return;
          tr.querySelector(".rb-currency").value = p.currencyKey;
          tr.querySelector(".rb-price").value = priceText(p.price);
        });
      } else {
        state.liveFxToUsd = {};
        state.liveFxKeys = {};
        positions.forEach((p, i) => {
          const hint = E.buildTickerInputHint(p.ticker, p.currencyKey);
          if (hint) warnings.push(`Row ${i + 1} (${p.ticker}): ${hint}`);
        });
      }
      const enriched = E.attachFxValues(positions, fxToUsd, rep);
      const plan = E.calculateRebalancePlan(enriched, mode, budget, { money });
      state.lastPlan = { plan, positions, reportingKey: rep, mode, budget, warnings, notes, live, at: new Date(), fxToUsd };
      renderPlan(state.lastPlan);
      refreshTotals();
      const count = plan.warnings.length + warnings.length;
      setStatus(count ? `Completed with ${count} warning(s). Verify the data before trading.` : "Rebalance completed.", count ? "warn" : "ok");
    } catch (error) {
      errorNode.textContent = error.message || String(error);
      setStatus("Run failed. Review the message below.", "error");
    } finally {
      setRunning(false);
      $("rbExportCsv").disabled = !state.lastPlan;
      $("rbExportXlsx").disabled = !state.lastPlan;
    }
  }

  // Recalculate from the inputs after edits (no network).
  function recalc() {
    if (!state.lastPlan || state.running) return;
    try {
      const rep = reportingKey();
      const positions = E.validatePositions(readRows(), { requirePrice: true });
      const enriched = E.attachFxValues(positions, fxMap(), rep);
      const plan = E.calculateRebalancePlan(enriched, modeSelect.value, Number(budgetInput.value || "0"), { money });
      state.lastPlan = { ...state.lastPlan, plan, positions, reportingKey: rep, mode: modeSelect.value, budget: Number(budgetInput.value || "0"), warnings: [], notes: [], at: new Date() };
      errorNode.textContent = "";
      renderPlan(state.lastPlan);
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  /* ---------------- exports ---------------- */
  function exportRows() {
    const run = state.lastPlan;
    const rep = E.currencyMeta(run.reportingKey).label;
    return [
      ["Ticker", "Account type", "Row currency", "Shares", "Price (local)", `Current value (${rep})`, "Target weight", `Target value (${rep})`, `Trade value (${rep})`, "Trade value (local)", "Trade shares", "Action", "Post-trade shares"],
      ...run.plan.results.map(r => [r.ticker, r.accountType || "", r.currencyLabel, r.shares, r.price, r.currentValue, r.targetWeightNorm, r.targetValue, r.tradeValue, r.tradeValueLocal, r.tradeShares, r.action, r.postTradeShares]),
    ];
  }
  $("rbExportCsv").addEventListener("click", () => {
    if (!state.lastPlan) return;
    const name = `rebalance-plan-${timestampSlug()}.csv`;
    downloadBlob(new Blob([toCsv(exportRows())], { type: "text/csv;charset=utf-8" }), name);
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
      ["Prices", run.live ? "Live Yahoo Finance quotes where available" : "Manual prices"],
      ["Total current", run.plan.summary.totalCurrent], ["Target pool", run.plan.summary.pool],
      ["Total buys", run.plan.summary.totalBuys], ["Total sells", run.plan.summary.totalSells],
      ...(run.mode === "new_money" ? [["New money budget", run.plan.summary.budget]] : []),
      [],
      header(["Currency", "USD per unit used"]),
      ...Object.entries(run.fxToUsd).map(([k, v]) => [E.currencyMeta(k).code, v]),
      [],
      header(["Warnings and notes"]),
      ...[...run.notes, ...run.plan.warnings, ...run.warnings].map(w => [w]),
      [],
      ["Disclaimer", "Illustrative planning only; not financial, investment, or trading advice. Verify prices at your broker before trading."],
    ];
    const name = `rebalance-plan-${timestampSlug()}.xlsx`;
    downloadBlob(buildXlsx([{ name: "Trade Plan", rows: [header(exportRows()[0]), ...exportRows().slice(1)] }, { name: "Summary", rows: summary }]), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });

  /* ---------------- events ---------------- */
  $("rbRun").addEventListener("click", run);
  $("rbSample").addEventListener("click", () => {
    state.liveFxToUsd = {};
    state.liveFxKeys = {};
    state.lastPlan = null;
    setRows(SAMPLE);
    budgetInput.value = "10000";
    modeSelect.value = "new_money";
    syncMode();
    resultNode.replaceChildren(el("p", "Run the rebalance to see the trade plan.", "muted"));
    errorNode.textContent = "";
    setStatus("Sample portfolio loaded.", null);
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
    if (tr && event.target.classList.contains("rb-ticker")) scheduleLookup(tr);
    refreshTotals();
  });
  rowsNode.addEventListener("change", event => {
    const tr = event.target.closest("tr");
    if (tr && event.target.classList.contains("rb-currency")) scheduleLookup(tr);
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
  setStatus("Ready. Edit the sample or enter your own holdings, then run the rebalance.", null);
  root.dataset.ready = "true";
}
