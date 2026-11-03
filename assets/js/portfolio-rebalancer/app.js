// Portfolio Rebalancer web app controller.
//
// Portfolio math lives in ./engine.js (identical to the desktop program), the holding
// state machine in ./rows.js and the sample in ./sample.js.
//
// The normal workflow needs only a ticker, shares, a target weight and (optionally)
// an account type per holding:
//   * when a ticker is committed (Enter or leaving the field) it is resolved locally
//     to one listing and currency (no request), then priced from the chosen source
//     with the visitor's own key; nothing is fetched on each keystroke;
//   * editing a ticker clears that holding's price at once, and a late answer for the
//     previous ticker is ignored;
//   * a plan is shown only when every holding with shares or a target has a verified
//     price in a confirmed currency, or a price the visitor deliberately supplied
//     (labelled as such on screen and in every export).
// Holdings are never sent anywhere or stored: only ticker symbols go to the price
// provider, and only currency codes go to the central banks.

import * as E from "./engine.js";
import * as R from "./rows.js";
import { SAMPLE_PORTFOLIO, CURRENCY_TEST_GROUP } from "./sample.js";
import { createMarketData, KEY_STORAGE_TEXT, PROVIDERS, providerAvailable } from "../market-data/index.js";
import { csvRecords } from "../market-data/csv.js";
import { buildXlsx, toCsv, downloadBlob, timestampSlug } from "../shared/export-files.js";

const REPORTING = ["CAD", "USD", "EUR", "GBP", "JPY", "CNY", "HKD", "CHF", "AUD"];
const STARTUP_FX = ["USD", "EUR", "GBP", "JPY", "CNY", "HKD", "CHF", "AUD"];
const PRICE_TYPE = {
  latest_trading_day: "latest price for trading day",
  eod_close: "close",
  previous_close: "previous close",
  last_trade: "last price",
};
const BROWSER_PROVIDERS = Object.keys(PROVIDERS).filter(id => providerAvailable(id, "browser"));
const DISCLAIMER = "Illustrative planning only; not financial, investment, or trading advice. Verify prices and holdings at your broker before trading.";

const root = document.getElementById("rb-app");
if (root) init();

function init() {
  const $ = id => document.getElementById(id);
  const md = createMarketData();
  const state = {
    rows: [],
    fx: { CAD: { cadPer: 1, kind: "official", label: "Reporting base", date: null } },
    fxNote: "",
    plan: null,
    planRequested: false,
    acceptStale: false,
    notice: "",
  };
  const nodes = new Map(); // row id -> card element
  const els = {
    rows: $("rbRows"), testRows: $("rbTestRows"), testGroup: $("rbTestGroup"),
    reporting: $("rbReporting"), mode: $("rbMode"), budget: $("rbBudget"), rounding: $("rbRounding"),
    showAccount: $("rbShowAccount"), source: $("rbSource"), fallback: $("rbFallback"),
    status: $("rbStatus"), results: $("rbResults"), estimate: $("rbEstimate"), summary: $("rbSummary"),
  };

  /* ---------------- formatting ---------------- */
  const rep = () => els.reporting.value;
  // One locale for every amount so each currency has a distinct symbol (C$, US$, €,
  // £, ¥ ...): a plan mixes currencies, and "$" alone would be ambiguous.
  const formatters = new Map();
  const moneyIn = code => value => {
    const iso = E.currencyMeta(code).code;
    try {
      if (!formatters.has(iso)) formatters.set(iso, new Intl.NumberFormat("en-CA", { style: "currency", currency: iso }));
      const text = formatters.get(iso).format(value);
      return iso === "CAD" ? text.replace("$", "C$") : text;
    } catch (_) { return `${iso} ${Number(value).toFixed(2)}`; }
  };
  const money = value => moneyIn(rep())(value);
  const pct = value => `${(Number(value) * 100).toFixed(2)}%`;
  const qty = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  const localTime = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function button(label, onClick, className = "pj-btn") {
    const b = el("button", label, className);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function setStatus(text, tone) {
    els.status.textContent = text;
    if (tone) els.status.dataset.tone = tone; else delete els.status.dataset.tone;
  }

  /* ---------------- rows ---------------- */
  const getRow = id => state.rows.find(r => r.id === id);
  const putRow = row => { const i = state.rows.findIndex(r => r.id === row.id); if (i >= 0) state.rows[i] = row; };
  const mainRows = () => state.rows.filter(r => r.group !== CURRENCY_TEST_GROUP);
  const testRows = () => state.rows.filter(r => r.group === CURRENCY_TEST_GROUP);
  const resolveIdentity = text => { try { return md.resolve(text); } catch (_) { return null; } };

  function commitTicker(id) {
    let row = getRow(id);
    if (!row || !row.ticker) return;
    if (row.identity && row.committedTicker === row.ticker) return;
    const identity = resolveIdentity(row.ticker);
    if (!identity) return; // reference still loading: resolved when it arrives
    row = R.applyIdentity(row, identity);
    putRow(row);
    renderRow(row);
    afterChange();
    if (identity.status === "resolved" && R.isActive(row) && md.configuredProviders().length) priceRow(id);
  }

  // Fetches one holding's price. Every answer is checked against the request token,
  // so it lands only on the same row, revision and instrument it was asked for.
  async function priceRow(id, { force = false } = {}) {
    let row = getRow(id);
    if (!row?.identity || row.identity.status !== "resolved") return;
    const token = R.requestToken(row, null);
    const route = md.route(row.identity);
    if (!route.candidates.length) {
      const why = route.skipped.map(s => `${PROVIDERS[s.id].name}: ${s.reason}`).join("; ");
      ({ row } = R.applyError(row, token, { kind: md.configuredProviders().length ? "not_covered" : "not_configured", message: md.configuredProviders().length ? `Not covered by your saved sources${why ? ` (${why})` : ""}.` : "No price source is set up yet: add your own key under Market data, or use your own price.", retryable: false }));
      putRow(row);
      renderRow(row);
      afterChange();
      return;
    }
    putRow(R.markPricing(row, token));
    renderRow(getRow(id));
    try {
      await ensureFx([row.identity.currency].filter(Boolean));
      const quote = await md.priceInstrument(row.identity, { useCache: !force });
      quote.label = `${quote.provider} · ${PRICE_TYPE[quote.priceType] || quote.priceType} ${quote.tradingDate}`;
      const result = R.applyQuote(getRow(id), token, quote);
      if (result.applied) { putRow(result.row); await ensureFx([quote.nativeCurrency]); }
    } catch (error) {
      if (error?.kind === "aborted") return;
      const contract = typeof error?.toContract === "function" ? error.toContract() : { kind: "failed", message: String(error?.message || error) };
      const result = R.applyError(getRow(id), token, { ...contract, kind: error?.kind || contract.kind, quotaScope: error?.quotaScope || null, provider: error?.provider || null });
      if (result.applied) putRow(result.row);
    }
    const current = getRow(id);
    if (current) renderRow(current);
    renderProviders();
    afterChange();
  }

  // Prices several holdings. Each provider's requests are paced by its scheduler;
  // holdings that would exceed the provider's remaining quota (by this browser's own
  // count) are not requested and say so.
  async function priceMany(rows, label) {
    const targets = rows.filter(r => r.identity?.status === "resolved" && !(r.useManual && r.manual))
      .sort((a, b) => (E.parseNumber(b.targetWeight) || 0) - (E.parseNumber(a.targetWeight) || 0));
    if (!targets.length) { setStatus("Nothing to price: commit a ticker first.", "warn"); return; }
    root.setAttribute("aria-busy", "true");
    setStatus(`${label}: getting prices…`, null);
    await ensureFx([...new Set(targets.map(r => r.identity.currency).filter(Boolean))]);
    const remaining = {};
    for (const id of md.configuredProviders()) {
      const b = md.providerStatus(id);
      if (b.remaining !== null && b.remaining !== undefined) remaining[id] = b.remaining;
    }
    const jobs = [];
    for (const row of targets) {
      const route = md.route(row.identity);
      const first = route.candidates[0];
      if (first && remaining[first.id] !== undefined) {
        const cost = PROVIDERS[first.id].requestCost(row.identity);
        if (cost > remaining[first.id]) {
          const token = R.requestToken(row, null);
          const name = PROVIDERS[first.id].name;
          const { row: next } = R.applyError(row, token, { kind: "budget_withheld", message: `Not requested: by this browser's count your ${name} allowance for this ${md.providerStatus(first.id).period} is used up. Use another saved source, wait for the reset, or use your own price.`, retryable: true });
          putRow(next);
          renderRow(next);
          continue;
        }
        remaining[first.id] -= cost;
      }
      jobs.push(priceRow(row.id));
    }
    setStatus(`${label}: fetching ${jobs.length} price${jobs.length === 1 ? "" : "s"}…`, null);
    await Promise.allSettled(jobs);
    root.setAttribute("aria-busy", "false");
    const failed = targets.filter(r => !R.effectivePrice(getRow(r.id) || r)).length;
    setStatus(failed ? `${label}: ${targets.length - failed} of ${targets.length} priced; see the holdings marked in red or amber.` : `${label}: all ${targets.length} priced.`, failed ? "warn" : "ok");
    renderProviders();
    afterChange();
  }

  /* ---------------- row cards ---------------- */
  function field(labelText, input, className = "") {
    const wrap = el("div", null, `pj-field ${className}`.trim());
    const label = el("label", labelText);
    label.htmlFor = input.id;
    wrap.append(label, input);
    return wrap;
  }
  function textInput(id, cls, value, attrs = {}) {
    const input = el("input");
    input.type = "text";
    input.id = id;
    input.className = cls;
    input.value = value ?? "";
    input.autocomplete = "off";
    Object.entries(attrs).forEach(([k, v]) => input.setAttribute(k, v));
    return input;
  }

  function buildRowNode(row) {
    const li = el("li", null, "rb-row");
    li.dataset.rowId = row.id;
    const main = el("div", null, "rb-row-main");
    const ticker = textInput(`${row.id}-ticker`, "rb-ticker", row.ticker, { maxlength: "24", spellcheck: "false", placeholder: "e.g. VEQT.TO", autocapitalize: "characters", "aria-describedby": `${row.id}-line` });
    const shares = textInput(`${row.id}-shares`, "rb-shares", row.shares, { inputmode: "decimal", placeholder: "0" });
    const target = textInput(`${row.id}-weight`, "rb-weight", row.targetWeight, { inputmode: "decimal", placeholder: "0" });
    const account = el("select");
    account.id = `${row.id}-account`;
    account.className = "rb-account";
    E.ACCOUNT_TYPES.forEach(at => { const o = el("option", at || "Unassigned"); o.value = at; o.selected = at === row.accountType; account.append(o); });
    const remove = button("✕", () => removeRow(row.id), "rb-icon-btn rb-remove");
    main.append(field("Ticker", ticker, "rb-f-ticker"), field("Shares", shares), field("Target %", target), field("Account", account, "rb-f-acct"), remove);
    const fieldError = el("p", "", "rb-field-error");
    fieldError.id = `${row.id}-err`;
    const identity = el("p", "", "rb-identity");
    const line = el("p", "", "rb-line");
    line.id = `${row.id}-line`;
    const tools = el("div", null, "rb-row-tools");
    const manual = el("div", null, "rb-manual");
    manual.hidden = true;
    const details = el("details");
    details.append(el("summary", "Source details"), el("dl"));
    li.append(main, fieldError, identity, line, tools, manual, details);

    ticker.addEventListener("input", () => {
      const before = getRow(row.id);
      const next = R.editTicker(before, ticker.value);
      if (next !== before) { putRow(next); renderRow(next); afterChange(); }
    });
    ticker.addEventListener("change", () => commitTicker(row.id));
    ticker.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commitTicker(row.id); } });
    for (const [input, name] of [[shares, "shares"], [target, "targetWeight"]]) {
      input.addEventListener("input", () => { putRow(R.editField(getRow(row.id), name, input.value)); renderRow(getRow(row.id)); afterChange(); });
    }
    account.addEventListener("change", () => { putRow(R.editField(getRow(row.id), "accountType", account.value)); afterChange(); });
    nodes.set(row.id, li);
    renderRow(row);
    return li;
  }

  function validationMessage(row) {
    const problems = [];
    const shares = E.parseNumber(row.shares);
    const target = E.parseNumber(row.targetWeight);
    if (row.shares.trim() !== "" && (shares === null || shares < 0)) problems.push("Shares must be a number of 0 or more (use a dot for decimals).");
    if (row.targetWeight.trim() !== "" && (target === null || target < 0)) problems.push("Target % must be a number of 0 or more.");
    return problems.join(" ");
  }

  function describeRow(row) {
    const eff = R.effectivePrice(row);
    const id = row.identity;
    if (!row.ticker) return { tone: "", text: "Enter the ticker as your broker shows it." };
    if (row.status === "draft") return { tone: "", text: "Press Enter or leave the field to look up this ticker." };
    if (id && id.status !== "resolved") return { tone: "error", text: id.reason || "This ticker is not supported." };
    if (row.status === "pricing") return { tone: "busy", text: "Fetching the latest price…" };
    if (eff) {
      const value = (E.parseNumber(row.shares) || 0) * eff.price;
      const fresh = eff.source.kind === "provider" ? R.freshnessOf(eff.source.tradingDate, Date.now(), id?.timeZone || "America/New_York") : { freshness: "current" };
      const freshText = fresh.freshness === "stale" ? `older than the latest session (${fresh.missed} missed)` : fresh.freshness === "too_old" ? "too old to use" : fresh.freshness === "unknown" ? "date unknown" : "";
      const tone = eff.source.kind !== "provider" || fresh.freshness !== "current" ? (fresh.freshness === "too_old" ? "error" : "warn") : "ok";
      return {
        tone,
        price: `${moneyIn(eff.currency)(eff.price)}`,
        text: eff.source.kind === "provider"
          ? `${row.quote.label}${row.quote.cacheStatus === "cached" ? " (saved copy)" : ""}${freshText ? ` · ${freshText}` : ""} · value ${moneyIn(eff.currency)(value)}`
          : `${eff.source.label} · value ${moneyIn(eff.currency)(value)}`,
        state: eff.source.kind === "provider" ? (fresh.freshness === "current" ? "Verified" : "Check date") : "User-supplied",
      };
    }
    if (row.error) {
      const covered = row.error.kind === "not_covered" || row.error.kind === "not_configured";
      return { tone: covered || row.error.kind === "budget_withheld" ? "warn" : "error", state: covered ? "Not covered" : "Price unavailable", text: row.error.message };
    }
    if (!R.isActive(row)) return { tone: "", text: "Not priced: 0 shares and a 0% target (not part of the plan)." };
    if (!md.configuredProviders().length) return { tone: "", text: "No price source yet: add your own key under Market data, or use your own price." };
    const route = id?.status === "resolved" ? md.route(id) : null;
    if (route && !route.candidates.length) {
      return { tone: "warn", state: "Not covered", text: `${route.skipped.map(x => `${PROVIDERS[x.id].name}: ${x.reason}`).join("; ")}. Use your own price, or add a source that covers ${id.venueName}.` };
    }
    return { tone: "", text: route ? `Not priced yet (source: ${PROVIDERS[route.candidates[0].id].name}).` : "Not priced yet." };
  }

  function renderRow(row) {
    const li = nodes.get(row.id);
    if (!li) return;
    const showAccount = els.showAccount.checked;
    li.querySelector(".rb-row-main").classList.toggle("rb-with-account", showAccount);
    li.querySelector(".rb-f-acct").hidden = !showAccount;
    const sync = (cls, value) => { const input = li.querySelector(cls); if (document.activeElement !== input && input.value !== value) input.value = value; };
    sync(".rb-ticker", row.ticker);
    sync(".rb-shares", row.shares);
    sync(".rb-weight", row.targetWeight);
    li.querySelector(".rb-remove").setAttribute("aria-label", `Remove ${row.ticker || "this holding"}`);
    const err = validationMessage(row);
    li.querySelector(".rb-field-error").textContent = err;
    li.querySelector(".rb-shares").setAttribute("aria-invalid", String(/Shares/.test(err)));
    li.querySelector(".rb-weight").setAttribute("aria-invalid", String(/Target/.test(err)));

    const id = row.identity;
    const identityNode = li.querySelector(".rb-identity");
    identityNode.replaceChildren();
    if (id?.status === "resolved") {
      const name = el("strong", id.name || (id.source === "suffix" ? `${id.localSymbol} on ${id.venueName}` : id.localSymbol));
      const unit = id.quoteUnit === "minor" ? ` (quoted in pence, shown in ${id.currency})` : "";
      identityNode.append(name, ` · ${id.venueName} · ${id.currency || "currency to be confirmed"}${unit}`);
      if (id.currencyEvidence === "venue_default_unconfirmed") identityNode.append(el("span", " · currency to be confirmed by the provider", "muted"));
    }
    identityNode.hidden = !identityNode.childNodes.length;

    const d = describeRow(row);
    const line = li.querySelector(".rb-line");
    line.replaceChildren(el("span", "", "rb-dot"));
    if (d.state) line.append(el("span", d.state, "rb-state"));
    if (d.price) line.append(el("span", d.price, "rb-price"));
    line.append(el("span", d.text));
    line.dataset.tone = d.tone || "";
    li.dataset.tone = d.tone || "";
    li.setAttribute("aria-busy", String(row.status === "pricing"));

    // Tools: refresh, own price, source details.
    const tools = li.querySelector(".rb-row-tools");
    tools.replaceChildren();
    if (id?.status === "resolved") {
      const routed = md.route(id).candidates.length > 0;
      if (routed) tools.append(button(row.quote ? "Refresh price" : row.error ? "Retry" : "Get price", () => priceRow(row.id, { force: Boolean(row.quote) || Boolean(row.error) })));
      tools.append(button(row.manual ? "Edit my price" : "Use my own price", () => toggleManual(row.id)));
      if (row.error?.kind === "rate_limited" && row.error.quotaScope === "daily") tools.append(button("Check again (1 request)", () => checkAgain(row.error.provider)));
    }
    renderManual(row);
    renderDetails(row);
  }

  function renderDetails(row) {
    const li = nodes.get(row.id);
    const details = li.querySelector("details");
    const dl = details.querySelector("dl");
    dl.replaceChildren();
    const add = (k, v) => { if (v === null || v === undefined || v === "") return; dl.append(el("dt", k), el("dd", v)); };
    const id = row.identity;
    if (id) {
      add("As entered", id.displayTicker);
      add("Listing", id.canonicalId ? `${id.venueName}${id.mic && id.mic !== "US" ? ` (${id.mic})` : ""}, symbol ${id.localSymbol}` : null);
      add("Identity source", id.source === "curated" ? `Curated reference (checked ${id.verifiedAt}); ${id.evidence.map(e => e.source).join("; ")}` : id.source === "suffix" ? "From the exchange suffix; the provider confirms the currency" : null);
      (id.notes || []).forEach((n, i) => add(i ? "" : "Notes", n));
    }
    const q = row.quote;
    if (q) {
      add("Provider", `${q.provider} (symbol ${q.providerSymbol})${q.fallbackFrom ? `; used because ${q.fallbackFrom.map(f => `${f.provider} failed: ${f.message}`).join("; ")}` : ""}`);
      add("Price", `${moneyIn(q.nativeCurrency)(q.nativePriceMajorUnits)}${q.quoteUnit === "minor" ? ` (provider quoted ${q.rawPrice} ${q.rawCurrency || "pence"})` : ""}`);
      add("Price type", `${PRICE_TYPE[q.priceType] || q.priceType}${q.feed ? `, ${q.feed.toUpperCase()} feed` : ""}; not adjusted`);
      add("Trading date", q.tradingDate);
      add("Price time", q.asOf ? new Date(q.asOf).toLocaleString() : "not given by the provider");
      add("Currency evidence", { curated_reference: "curated reference", provider_quote: "stated in the provider's quote", provider_listing: "provider's listing search", provider_market: "provider serves only US listings (USD)" }[q.currencyEvidence] || q.currencyEvidence);
      add("Retrieved", `${new Date(q.retrievedAt).toLocaleString()}${q.cacheStatus === "cached" ? " (saved copy in this browser)" : ""}`);
      (q.notes || []).forEach(n => add("Note", n));
    }
    if (row.error) {
      add("Problem", row.error.message);
      add("Provider said", row.error.redactedNotice);
      add("What you can do", row.error.resolutionHint);
    }
    if (row.manual) add("Your price", `${row.manual.label}, ${moneyIn(row.manual.currency)(row.manual.price)}, entered ${new Date(row.manual.at).toLocaleString()}`);
    details.hidden = !dl.childNodes.length;
  }

  function toggleManual(id) {
    const li = nodes.get(id);
    const box = li.querySelector(".rb-manual");
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector("input")?.focus();
  }

  function renderManual(row) {
    const box = nodes.get(row.id).querySelector(".rb-manual");
    if (box.contains(document.activeElement)) return;
    const wasHidden = box.hidden;
    box.replaceChildren();
    const currency = row.manual?.currency || row.identity?.currency || rep();
    const minor = row.identity?.quoteUnit === "minor";
    box.append(el("p", "Your own price is used instead of a fetched one and is labelled as user-supplied in the plan and exports. Use the price in the listing's currency.", "rb-note"));
    const fields = el("div", null, "rb-manual-fields");
    const price = textInput(`${row.id}-mp`, "rb-mprice", row.manual ? String(row.manual.enteredPrice) : "", { inputmode: "decimal" });
    const cur = el("select");
    cur.id = `${row.id}-mc`;
    [...new Set([currency, ...REPORTING])].forEach(c => { const o = el("option", c); o.value = c; o.selected = c === currency; cur.append(o); });
    const unit = el("select");
    unit.id = `${row.id}-mu`;
    [["1", "units of the currency"], ["0.01", "pence / cents (÷100)"]].forEach(([v, t]) => { const o = el("option", t); o.value = v; o.selected = row.manual ? String(row.manual.unitScale) === v : v === (minor ? "0.01" : "1"); unit.append(o); });
    fields.append(field("Price", price), field("Currency", cur), field("Quoted in", unit));
    const msg = el("p", "", "rb-field-error");
    const actions = el("div", null, "rb-row-tools");
    actions.append(button("Use this price", () => {
      try {
        putRow(R.setManualPrice(getRow(row.id), { price: E.parseNumber(price.value), currency: cur.value, unitScale: Number(unit.value) }));
        box.hidden = true;
        renderRow(getRow(row.id));
        afterChange();
      } catch (error) { msg.textContent = error.message; }
    }));
    if (row.manual) actions.append(button("Remove my price", () => { putRow(R.clearManualPrice(getRow(row.id))); renderRow(getRow(row.id)); afterChange(); }));
    box.append(fields, msg, actions);
    box.hidden = wasHidden;
  }

  function rebuildRows() {
    nodes.clear();
    els.rows.replaceChildren(...mainRows().map(buildRowNode));
    els.testRows.replaceChildren(...testRows().map(buildRowNode));
    els.testGroup.hidden = !testRows().length;
    afterChange();
  }

  function setRows(data) {
    state.rows = data.map(d => R.createRow(d));
    state.plan = null;
    state.acceptStale = false;
    rebuildRows();
  }

  function removeRow(id) {
    state.rows = state.rows.filter(r => r.id !== id);
    if (!state.rows.length) state.rows.push(R.createRow());
    rebuildRows();
  }

  function resolveAll() {
    for (const row of state.rows) {
      if (!row.ticker || (row.identity && row.committedTicker === row.ticker)) continue;
      const identity = resolveIdentity(row.ticker);
      if (identity) putRow(R.applyIdentity(row, identity));
    }
    state.rows.forEach(renderRow);
  }

  /* ---------------- summary, estimate ---------------- */
  function renderSummary() {
    const main = mainRows().filter(r => r.ticker);
    const priced = main.filter(r => R.effectivePrice(r)).length;
    const active = main.filter(R.isActive).length;
    const tests = testRows().length;
    let total = 0;
    let complete = true;
    for (const r of main) {
      const eff = R.effectivePrice(r);
      if (!R.isActive(r)) continue;
      if (!eff || !fxAvailable(eff.currency)) { complete = false; continue; }
      total += (E.parseNumber(r.shares) || 0) * eff.price * fxRate(eff.currency);
    }
    const parts = [`${main.length} holding${main.length === 1 ? "" : "s"}`, `${priced} priced`];
    if (active - priced > 0) parts.push(`${active - priced} without a usable price`);
    if (tests) parts.push(`${tests} currency-test row${tests === 1 ? "" : "s"}`);
    if (main.length) parts.push(`value ${money(total)}${complete ? "" : " (incomplete)"}`);
    const weights = main.filter(R.isActive).reduce((s, r) => s + (E.parseNumber(r.targetWeight) || 0), 0);
    if (main.length) parts.push(`targets ${weights.toFixed(2)}%`);
    els.summary.textContent = main.length ? parts.join(" · ") : "";
  }

  function renderEstimate() {
    const pending = mainRows().filter(r => r.identity?.status === "resolved" && R.isActive(r) && !R.effectivePrice(r));
    const btn = $("rbPriceAll");
    if (!md.configuredProviders().length) {
      els.estimate.textContent = mainRows().some(r => r.ticker) ? "To get prices automatically, add your own key for at least one source under Market data → Your API keys. Without a key you can still enter your own prices." : "";
      btn.textContent = "Get prices";
      btn.disabled = !pending.length;
      return;
    }
    const est = md.estimate(pending.map(r => r.identity));
    const parts = Object.entries(est.perProvider).map(([id, e]) => {
      const limit = e.period === "day" ? `${PROVIDERS[id].name} allows ${md.providerStatus(id).plan.limits.perDay} per day on your plan; this browser sent ${e.sentToday} today`
        : e.period === "month" ? `${PROVIDERS[id].name} allows ${md.providerStatus(id).plan.limits.perMonth.toLocaleString("en-US")} per month on your plan; this browser sent ${e.sentMonth} this month`
          : `${PROVIDERS[id].name} allows ${e.perMinute} per minute`;
      return `about ${e.requests} ${PROVIDERS[id].name} request${e.requests === 1 ? "" : "s"} for ${e.rows} holding${e.rows === 1 ? "" : "s"} (${limit})`;
    });
    const uncovered = est.uncovered.map(u => u.displayTicker);
    els.estimate.textContent = pending.length
      ? `Getting ${pending.length} price${pending.length === 1 ? "" : "s"} needs ${parts.join("; ") || "no requests"}.${uncovered.length ? ` Not covered by your saved sources: ${uncovered.join(", ")} (use your own price, or add a source that covers it).` : ""}`
      : "";
    btn.textContent = pending.length ? `Get prices (about ${est.total} request${est.total === 1 ? "" : "s"})` : "Get prices";
    btn.disabled = !pending.length || est.total === 0 && !uncovered.length && !pending.length;
  }

  // Runs after every change: totals, estimate and, once a plan was requested, the plan.
  function afterChange() {
    renderSummary();
    renderEstimate();
    renderFxList();
    if (state.planRequested) computePlan({ quiet: true });
  }

  /* ---------------- exchange rates ---------------- */
  const fxAvailable = code => Boolean(code && state.fx[code] && state.fx[rep()]);
  const fxRate = code => state.fx[code].cadPer / state.fx[rep()].cadPer; // reporting units per 1 unit of `code`

  async function ensureFx(codes, { force = false } = {}) {
    const wanted = [...new Set([...codes, rep()])].filter(c => c && c !== "CAD" && (force || !state.fx[c]));
    if (!wanted.length) return;
    try {
      const fx = await md.fx.latest(wanted, { useCache: !force });
      for (const code of wanted) {
        if (!force && state.fx[code]?.kind === "manual") continue;
        const point = fx.cadPer[code];
        if (!point) continue;
        state.fx[code] = { cadPer: point.cadPer, kind: "official", label: `${fx.provider}, ${point.date}${fx.stale ? " (saved copy; refresh failed)" : ""}`, date: point.date, stale: fx.stale, provider: fx.provider };
      }
      state.fxNote = fx.attribution;
    } catch (error) {
      state.fxNote = `Official exchange rates are unavailable right now (${error.message}). Holdings in other currencies cannot be valued until rates load or you enter them.`;
    }
    renderFxList();
  }

  function renderFxList() {
    const list = $("rbFxRows");
    const reporting = rep();
    const codes = [...new Set(state.rows.map(r => R.effectivePrice(r)?.currency || r.identity?.currency).filter(Boolean))].filter(c => c !== reporting).sort();
    const signature = `${reporting}|${codes.join(",")}`;
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const code of codes) {
        const li = el("li");
        const label = el("label", `${reporting} per 1 ${code}`);
        const input = textInput(`rbFx-${code}`, "rb-fx-input", "", { inputmode: "decimal" });
        label.htmlFor = input.id;
        input.dataset.code = code;
        input.addEventListener("change", () => {
          const value = E.parseNumber(input.value);
          if (!(value > 0) || !state.fx[reporting]) { renderFxList(); return; }
          state.fx[code] = { cadPer: value * state.fx[reporting].cadPer, kind: "manual", label: "Entered by you", date: null };
          afterChange();
        });
        li.append(label, input, el("span", "", "rb-fx-src"));
        list.append(li);
      }
      if (!codes.length) list.append(el("li", "No conversion needed yet: every priced holding is in the reporting currency.", "rb-note"));
    }
    for (const li of list.querySelectorAll("li")) {
      const input = li.querySelector("input");
      if (!input) continue;
      const code = input.dataset.code;
      const src = li.querySelector(".rb-fx-src");
      if (fxAvailable(code)) {
        if (document.activeElement !== input) input.value = String(Number(fxRate(code).toPrecision(6)));
        src.textContent = state.fx[code].kind === "manual" ? "Entered by you" : state.fx[code].label;
        src.dataset.kind = state.fx[code].kind;
      } else {
        if (document.activeElement !== input) input.value = "";
        src.textContent = "Not loaded yet";
        src.dataset.kind = "missing";
      }
    }
    $("rbFxNote").textContent = state.fxNote;
    const manual = codes.filter(c => state.fx[c]?.kind === "manual").length;
    $("rbFxTag").textContent = codes.length ? `(${codes.length} in use${manual ? `, ${manual} entered by you` : ""})` : "";
  }
  $("rbFxRefresh").addEventListener("click", async () => {
    const codes = Object.keys(state.fx).filter(c => c !== "CAD");
    await ensureFx([...codes, ...STARTUP_FX], { force: true });
    afterChange();
  });

  /* ---------------- providers and keys ---------------- */
  function renderSourceSelect() {
    const current = md.routing.mode;
    els.source.replaceChildren();
    const auto = el("option", "Automatic (route by market)");
    auto.value = "auto";
    els.source.append(auto);
    for (const id of BROWSER_PROVIDERS) {
      const o = el("option", `${PROVIDERS[id].name}${md.providerStatus(id).configured ? "" : " (no key saved)"}`);
      o.value = id;
      els.source.append(o);
    }
    els.source.value = current;
    els.fallback.checked = md.routing.fallback;
    const configured = md.configuredProviders().map(id => PROVIDERS[id].name);
    $("rbSourceNote").textContent = current === "auto"
      ? `Automatic: US listings use Finnhub, then Alpha Vantage, then Marketstack; Toronto, TSX Venture, London, Xetra and Shanghai/Shenzhen use Alpha Vantage, then Marketstack; other exchanges use Marketstack. Only sources with a saved key are used${configured.length ? ` (saved: ${configured.join(", ")})` : " (none saved yet)"}.`
      : `${PROVIDERS[current].name} only. Holdings it does not cover are marked "Not covered".`;
    $("rbKeysTag").textContent = configured.length ? `(${configured.join(", ")})` : "(none saved)";
  }

  function renderProviders({ force = false } = {}) {
    const box = $("rbProviders");
    // Never rebuild a key form the visitor is typing in.
    if (!force && box.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") { renderSourceSelect(); return; }
    box.replaceChildren();
    for (const id of BROWSER_PROVIDERS) {
      const p = PROVIDERS[id];
      const s = md.providerStatus(id);
      const card = el("section", null, "rb-provider");
      card.setAttribute("aria-label", p.name);
      const h = el("h4", p.name);
      h.append(el("small", s.configured ? { local: "key saved on this device", session: "key kept for this tab", memory: "key kept for this page" }[s.persistence] || "key saved" : "no key saved"));
      card.append(h);
      card.append(el("p", `${p.priceLabel[0].toUpperCase()}${p.priceLabel.slice(1)}. ${p.licence}`, "rb-note"));
      if (p.notice) card.append(el("p", p.notice, "rb-note"));
      const form = el("form", null, "rb-keyrow");
      form.noValidate = true;
      const keyInput = el("input");
      keyInput.type = "password";
      keyInput.id = `rbKey-${id}`;
      keyInput.autocomplete = "off";
      keyInput.spellcheck = false;
      keyInput.maxLength = 64;
      keyInput.placeholder = s.configured ? "Saved (enter a new key to replace)" : "Paste your key";
      const keyField = el("div", null, "pj-field");
      const kl = el("label", "API key");
      kl.htmlFor = keyInput.id;
      keyField.append(kl, keyInput);
      const remember = el("label", null, "rb-check rb-check-field");
      const rememberBox = el("input");
      rememberBox.type = "checkbox";
      rememberBox.checked = s.persistence === "local";
      remember.append(rememberBox, el("span", "Remember on this device"));
      const save = el("button", "Save key", "pj-btn");
      save.type = "submit";
      form.append(keyField, remember, save);
      if (s.configured) form.append(button("Remove key", () => { md.setKey(id, ""); onKeysChanged(id, `${p.name} key removed from this browser, with everything fetched with it.`); }));
      const out = el("p", "", "rb-note");
      out.setAttribute("role", "status");
      form.addEventListener("submit", event => {
        event.preventDefault();
        try {
          const { persistence } = md.setKey(id, keyInput.value, { remember: rememberBox.checked });
          keyInput.value = "";
          onKeysChanged(id, persistence ? `${p.name} key ${KEY_STORAGE_TEXT[persistence]}.` : `${p.name} key removed.`);
        } catch (error) { out.textContent = error.message; }
      });
      card.append(form, out);
      // Plan (entitlement profile): changes pacing and the request estimate only.
      const planRow = el("div", null, "rb-planrow");
      const planSelect = el("select");
      planSelect.id = `rbPlan-${id}`;
      p.plans.forEach(pl => { const o = el("option", pl.label); o.value = pl.id; o.selected = pl.id === s.plan.id; planSelect.append(o); });
      planRow.append(field("Your plan", planSelect));
      const editable = s.plan.editable;
      let limitInput = null;
      if (editable) {
        limitInput = textInput(`rbLimit-${id}`, "", String(s.plan.limits[editable]), { inputmode: "numeric" });
        planRow.append(field(editable === "perMinute" ? "Requests per minute" : "Requests per month", limitInput));
      }
      let intl = null;
      if (s.plan.international !== undefined && p.plans.find(pl => pl.id === s.plan.id)?.international === "optional") {
        intl = el("label", null, "rb-check rb-check-field");
        const box2 = el("input");
        box2.type = "checkbox";
        box2.checked = s.plan.international;
        intl.append(box2, el("span", "My plan includes international markets"));
        planRow.append(intl);
      }
      const applyPlan = () => {
        md.setPlan(id, planSelect.value, { limit: limitInput ? E.parseNumber(limitInput.value) : null, international: intl ? intl.querySelector("input").checked : false });
        renderProviders({ force: true });
        afterChange();
      };
      planSelect.addEventListener("change", applyPlan);
      limitInput?.addEventListener("change", applyPlan);
      intl?.querySelector("input").addEventListener("change", applyPlan);
      card.append(planRow);
      card.append(el("p", "The plan only sets pacing and the request estimate. Your provider's own limits and terms apply; nothing here is unlimited.", "rb-note"));
      if (s.configured) {
        card.append(el("p", `Requests sent from this browser: ${s.sentToday} today (UTC), ${s.sentMonth} this month. Your provider counts every use of the key, including other devices and apps.`, "rb-note"));
        const rec = s.limitRecord;
        if (rec) {
          const box3 = el("div", null, "rb-limit");
          const until = rec.scope === "monthly" ? "the end of this month (UTC) or your plan's renewal" : `00:00 UTC (${localTime(Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z") + 86400000)} your time)`;
          box3.append(el("p", `${p.name} reported its ${rec.scope} limit at ${localTime(rec.at)} your time. This browser sends no more ${p.name} requests until ${until}, unless you check again.`));
          if (rec.notice) { const q = el("blockquote", rec.notice); box3.append(el("span", "Provider said:"), q); }
          box3.append(button("Check again (1 request)", () => checkAgain(p.name)));
          card.append(box3);
        }
      }
      const links = el("p", null, "rb-note");
      const a1 = el("a", "Get a key");
      a1.href = p.keyHelpUrl;
      a1.rel = "noopener noreferrer";
      const a2 = el("a", "Terms");
      a2.href = p.termsUrl;
      a2.rel = "noopener noreferrer";
      links.append(a1, " · ", a2);
      card.append(links);
      box.append(card);
    }
    const off = Object.keys(PROVIDERS).filter(id => !providerAvailable(id, "browser"));
    $("rbNotOffered").textContent = off.length ? `Not offered on this website: ${off.map(id => `${PROVIDERS[id].name} (${PROVIDERS[id].status.browser === "deferred" ? "deferred" : "desktop app only"}): ${PROVIDERS[id].unsupportedReason}`).join(" ")}` : "";
    renderSourceSelect();
  }

  // A key or source change retires prices from the previous source: every provider
  // quote is cleared (late answers are then ignored), user-supplied prices stay.
  function onKeysChanged(id, message) {
    state.rows = state.rows.map(r => (r.quote || r.error || r.status === "pricing" ? R.resetQuote(r) : r));
    state.rows.forEach(renderRow);
    renderProviders({ force: true });
    afterChange();
    setStatus(`${message} Fetched prices were cleared; press Get prices to fetch them again (saved copies are reused without a request).`, null);
  }

  async function checkAgain(providerName) {
    const id = Object.keys(PROVIDERS).find(k => PROVIDERS[k].name === providerName || k === providerName);
    if (!id) return;
    setStatus(`Checking ${PROVIDERS[id].name} with one request…`, null);
    const result = await md.checkAgain(id);
    setStatus(result.ok ? `${result.message} Press Get prices to retry the remaining holdings.` : `${PROVIDERS[id].name}: ${result.message}`, result.ok ? "ok" : "warn");
    renderProviders({ force: true });
    afterChange();
  }

  els.source.addEventListener("change", () => { md.setRouting({ mode: els.source.value }); onKeysChanged(null, "Price source changed."); });
  els.fallback.addEventListener("change", () => { md.setRouting({ fallback: els.fallback.checked }); renderSourceSelect(); });
  $("rbForgetKeys").addEventListener("click", () => { md.forgetAllKeys(); onKeysChanged(null, "All keys were removed from this browser, with everything fetched with them."); });

  /* ---------------- plan ---------------- */
  function budgetValue() { return E.parseNumber(els.budget.value); }

  function computePlan({ quiet = false } = {}) {
    state.planRequested = true;
    const now = Date.now();
    const valuation = E.assessValuation(state.rows.map(r => R.valuationRow(r, { now, fxAvailable })), { acceptStale: state.acceptStale });
    state.plan = null;
    $("rbExportCsv").disabled = true;
    $("rbExportXlsx").disabled = true;
    const mode = els.mode.value;
    if (!valuation.ready) { renderWithheld(valuation); return; }
    const budget = budgetValue();
    if (mode === "new_money" && !(budget > 0)) { renderWithheld(valuation, "Enter a New Money budget greater than 0."); return; }
    const showAccount = els.showAccount.checked;
    const active = state.rows.filter(r => !valuation.notValued.some(n => n.rowId === r.id));
    const positions = active.map((r, i) => {
      const eff = R.effectivePrice(r);
      return { rowIndex: i, rowId: r.id, ticker: r.ticker, shares: E.parseNumber(r.shares), price: eff.price, currencyKey: eff.currency, targetWeight: E.parseNumber(r.targetWeight), accountType: showAccount ? r.accountType : "" };
    });
    const cadPer = Object.fromEntries(Object.entries(state.fx).map(([k, v]) => [k, v.cadPer]));
    let plan;
    try {
      plan = E.calculateRebalancePlan(E.attachFxValues(positions, cadPer, rep()), mode, budget || 0, { money });
    } catch (error) { renderWithheld(valuation, error.message); return; }
    const whole = els.rounding.value === "whole" ? E.applyWholeShares(plan) : null;
    const snapshot = active.map(r => ({ ...r }));
    state.plan = { plan, whole, valuation, positions, rows: snapshot, notValued: state.rows.filter(r => valuation.notValued.some(n => n.rowId === r.id)).map(r => ({ ...r })), reporting: rep(), mode, budget: budget || 0, at: new Date(now), fx: Object.fromEntries(Object.entries(state.fx).map(([k, v]) => [k, { ...v }])), showAccount };
    renderPlan(quiet);
    $("rbExportCsv").disabled = false;
    $("rbExportXlsx").disabled = false;
  }

  function renderWithheld(valuation, extra = null) {
    els.results.replaceChildren();
    const banner = el("div", null, "rb-banner");
    banner.setAttribute("role", "alert");
    banner.append(el("h4", "Plan withheld"));
    banner.append(el("p", extra || valuation.blockedReason || "The plan cannot be calculated yet."));
    if (valuation.unpriced.length) {
      // One line per cause, listing the holdings it affects (not one warning per row).
      const byReason = new Map();
      for (const u of valuation.unpriced) byReason.set(u.reason, [...(byReason.get(u.reason) || []), u.ticker]);
      const ul = el("ul");
      for (const [reason, tickers] of byReason) ul.append(el("li", `${tickers.join(", ")}: ${reason}`));
      banner.append(ul);
      banner.append(el("p", "Nothing is estimated or filled in for you. Get prices, choose another source, or use your own price on those holdings.", "rb-note"));
    }
    if (!extra && valuation.stale.length && !valuation.unpriced.length) {
      const ul = el("ul");
      valuation.stale.forEach(s => ul.append(el("li", `${s.ticker}: price from ${s.tradingDate || "an unknown date"}`)));
      banner.append(ul);
      const accept = el("label", null, "rb-check");
      const box = el("input");
      box.type = "checkbox";
      box.id = "rbAcceptStale";
      box.addEventListener("change", () => { state.acceptStale = box.checked; computePlan(); });
      accept.append(box, el("span", "Use these older prices for this plan (they will be labelled as such)"));
      banner.append(accept);
    }
    els.results.append(banner);
    setStatus(`Plan withheld: ${extra || valuation.blockedReason}`, "error");
  }

  function renderPlan(quiet) {
    const run = state.plan;
    const { plan, whole } = run;
    const rows = whole ? whole.results : plan.results;
    const pick = (r, key) => (whole ? r[`whole${key[0].toUpperCase()}${key.slice(1)}`] : r[key]);
    els.results.replaceChildren();
    const s = plan.summary;
    const totalBuys = whole ? whole.totalBuys : s.totalBuys;
    const totalSells = whole ? whole.totalSells : s.totalSells;
    const cashLeft = whole ? whole.cashLeft : s.cashLeft;
    const manual = run.valuation.manualOverrides.length;
    const tiles = el("div", null, "pj-tiles");
    const tile = (label, value, cls) => { const t = el("div", null, "pj-tile"); const v = el("strong", value); if (cls) v.className = cls; t.append(el("span", label), v); tiles.append(t); };
    tile("Mode", s.mode === "new_money" ? "New Money" : "Rebalance");
    tile("Current value", money(s.totalCurrent));
    if (s.mode === "new_money") tile("New money", money(s.budget));
    tile("Total buys", money(totalBuys));
    tile("Total sells", money(totalSells));
    tile(s.mode === "new_money" ? "Budget not invested" : "Proceeds not reinvested", money(cashLeft));
    tile("Prices", manual ? `${manual} user-supplied` : "All verified", manual ? "warn" : "good");
    els.results.append(tiles);

    const banner = el("div", null, `rb-banner ${manual || run.valuation.stale.length ? "warn" : "ok"}`);
    banner.append(el("h4", manual ? `Plan includes ${manual} price${manual === 1 ? "" : "s"} you supplied` : run.valuation.stale.length ? "Plan uses older prices you accepted" : "Plan ready"));
    banner.append(el("p", `${run.valuation.priced.length} holding${run.valuation.priced.length === 1 ? "" : "s"} valued${run.notValued.length ? `; ${run.notValued.length} not in the plan (0 shares, 0% target)` : ""}. ${whole ? "Whole shares." : "Fractional shares."} Calculated ${run.at.toLocaleString()}.`));
    els.results.append(banner);

    const groups = [["Buy", "Buys"], ["Sell", "Sells"], ["Hold", "Holds"]];
    const actionOf = r => (whole ? r.wholeAction : r.action);
    for (const [action, heading] of groups) {
      const items = rows.filter(r => actionOf(r) === action).sort((a, b) => Math.abs(pick(b, "tradeValue")) - Math.abs(pick(a, "tradeValue")));
      if (!items.length) continue;
      els.results.append(el("h4", `${heading} (${items.length})`, "rb-plan-group"));
      const ul = el("ul", null, "rb-plan");
      for (const r of items) ul.append(actionItem(r, run));
      els.results.append(ul);
    }
    if (run.notValued.length) {
      els.results.append(el("h4", `Not in the plan (${run.notValued.length})`, "rb-plan-group"));
      els.results.append(el("p", `${run.notValued.map(r => r.ticker).join(", ")}: 0 shares and a 0% target.`, "rb-note"));
    }
    renderWarnings(run);
    const counts = Object.fromEntries(groups.map(([a]) => [a, rows.filter(r => actionOf(r) === a).length]));
    const text = `Plan ready: ${counts.Buy} buy${counts.Buy === 1 ? "" : "s"}, ${counts.Sell} sell${counts.Sell === 1 ? "" : "s"}, ${counts.Hold} hold${counts.Hold === 1 ? "" : "s"}${manual ? `; includes ${manual} user-supplied price${manual === 1 ? "" : "s"}` : ""}.`;
    if (!quiet || els.status.textContent !== text) setStatus(text, manual ? "warn" : "ok");
  }

  function actionItem(r, run) {
    const li = el("li", null, "rb-act");
    const row = run.rows[r.rowIndex];
    const action = run.whole ? r.wholeAction : r.action;
    const tradeShares = run.whole ? r.wholeShares : r.tradeShares;
    const tradeValue = run.whole ? r.wholeTradeValue : r.tradeValue;
    const tradeLocal = run.whole ? r.wholeTradeValueLocal : r.tradeValueLocal;
    const post = run.whole ? r.wholePostTradeShares : r.postTradeShares;
    // Weights after the trades are shares of the holdings' value after trading (cash
    // left over is not a holding).
    const s = run.plan.summary;
    const postTotal = s.totalCurrent + (run.whole ? run.whole.totalBuys - run.whole.totalSells : s.totalBuys - s.totalSells);
    const before = s.totalCurrent ? r.currentValue / s.totalCurrent : 0;
    const after = postTotal ? (r.currentValue + tradeValue) / postTotal : 0;
    const line = el("div", null, "rb-act-line");
    const pill = el("span", `${action === "Buy" ? "▲" : action === "Sell" ? "▼" : "■"} ${action.toUpperCase()}`, `rb-pill rb-${action.toLowerCase()}`);
    line.append(pill, el("span", r.ticker, "rb-act-ticker"));
    line.append(el("span", action === "Hold" ? "no trade" : `${qty(Math.abs(tradeShares))} sh`, "rb-act-shares"));
    line.append(el("span", action === "Hold" ? "—" : `≈ ${money(Math.abs(tradeValue))}`, "rb-act-amount"));
    line.append(el("span", `weight ${pct(before)} → ${pct(after)} (target ${pct(r.targetWeightNorm)})`, "rb-act-weights"));
    li.append(line);
    const details = el("details");
    details.append(el("summary", "Details"));
    const dl = el("dl");
    const add = (k, v) => dl.append(el("dt", k), el("dd", v));
    const eff = R.effectivePrice(row);
    add("Price", `${moneyIn(r.currencyKey)(r.price)} · ${eff.source.kind === "provider" ? row.quote.label : eff.source.label}`);
    if (r.currencyKey !== run.reporting) add("Exchange rate", `1 ${r.currencyKey} = ${Number(r.fxToReporting.toPrecision(6))} ${run.reporting} · ${run.fx[r.currencyKey]?.label || ""}`);
    add("Listing", row.identity ? `${row.identity.venueName} · ${row.identity.currency}` : "—");
    add("Shares held", qty(r.shares));
    add("Current value", money(r.currentValue));
    add("Target value", money(r.targetValue));
    add(`Trade (${run.reporting})`, money(tradeValue));
    add(`Trade (${r.currencyKey})`, moneyIn(r.currencyKey)(tradeLocal));
    add("Trade shares", qty(tradeShares));
    if (!run.whole) add("Whole-share view", "Choose Whole shares under Portfolio settings to round.");
    add("Shares after", qty(post));
    if (run.showAccount) add("Account", r.accountType || "Unassigned");
    details.append(dl);
    li.append(details);
    return li;
  }

  function planNotes(run) {
    const attention = [];
    const info = [];
    const manualRows = run.rows.filter(r => R.effectivePrice(r)?.source.kind !== "provider");
    if (manualRows.length) attention.push(`User-supplied prices (not verified by a provider): ${manualRows.map(r => r.ticker).join(", ")}.`);
    if (run.valuation.stale.length) attention.push(`Older prices accepted: ${run.valuation.stale.map(s => `${s.ticker} (${s.tradingDate || "date unknown"})`).join(", ")}.`);
    const manualFx = [...new Set(run.plan.results.map(r => r.currencyKey))].filter(c => run.fx[c]?.kind === "manual" && c !== run.reporting);
    if (manualFx.length) attention.push(`Exchange rates you entered: ${manualFx.join(", ")}.`);
    for (const w of run.plan.warnings) (/scaled down|No sells are needed/.test(w) ? info : attention).push(w);
    info.push(...E.weightWarnings(run.positions), ...E.duplicateWarnings(run.positions));
    const fallbacks = run.rows.filter(r => r.quote?.fallbackFrom).map(r => `${r.ticker}: priced by ${r.quote.provider} because ${r.quote.fallbackFrom.map(f => f.provider).join(", ")} could not`);
    info.push(...fallbacks);
    const pence = run.rows.filter(r => r.quote?.quoteUnit === "minor").map(r => r.ticker);
    if (pence.length) info.push(`${pence.join(", ")}: quoted in pence and converted to pounds (÷100).`);
    const cash = run.whole ? run.whole.cashLeft : run.plan.summary.cashLeft;
    if (cash > 0.005) info.push(`${money(cash)} ${run.mode === "new_money" ? "of the budget is not invested" : "of sell proceeds is not reinvested"}${run.whole ? " after rounding to whole shares" : ""}.`);
    if (!run.whole) info.push("Trade shares are fractional. If your broker trades whole shares only, choose Whole shares under Portfolio settings.");
    return { attention, info };
  }

  function renderWarnings(run) {
    const { attention, info } = planNotes(run);
    const group = (title, items, cls, collapsed) => {
      if (!items.length) return;
      const box = el("div", null, `rb-warn-group ${cls}`);
      const list = el("ul", null, "pj-warnings");
      items.forEach(t => list.append(el("li", t, cls === "info" ? "info" : "")));
      if (collapsed) {
        const d = el("details");
        d.append(el("summary", `${title} (${items.length})`), list);
        box.append(d);
      } else box.append(el("h4", `${title} (${items.length})`), list);
      els.results.append(box);
    };
    group("Needs your attention", attention, "attention", false);
    group("Information", info, "info", true);
  }

  /* ---------------- exports ---------------- */
  function exportTable() {
    const run = state.plan;
    const rows = run.whole ? run.whole.results : run.plan.results;
    const rc = run.reporting;
    const header = ["Ticker (as entered)", "Listing", "Instrument", "Account type", "Currency", "Shares", "Price (local)", "Price source", "Provider symbol", "Price type", "Trading date", "Retrieved at (UTC)", "Currency evidence", `FX to ${rc}`, "FX source", `Current value (${rc})`, "Target weight", `Target value (${rc})`, "Action", `Trade value (${rc})`, "Trade value (local)", "Trade shares", "Post-trade shares"];
    const body = rows.map(r => {
      const row = run.rows[r.rowIndex];
      const q = row.useManual && row.manual ? null : row.quote;
      const src = q ? `${q.provider} (provider)` : row.manual?.label || "";
      const w = run.whole;
      return [r.ticker, row.identity?.canonicalId || "", row.identity?.name || "", r.accountType || "", r.currencyKey, r.shares, r.price, src, q?.providerSymbol || "", q ? PRICE_TYPE[q.priceType] || q.priceType : "user-supplied", q?.tradingDate || "", q?.retrievedAt || (row.manual ? new Date(row.manual.at).toISOString() : ""), q?.currencyEvidence || "user", r.fxToReporting, r.currencyKey === rc ? "reporting currency" : run.fx[r.currencyKey]?.label || "",
        r.currentValue, r.targetWeightNorm, r.targetValue, w ? r.wholeAction : r.action, w ? r.wholeTradeValue : r.tradeValue, w ? r.wholeTradeValueLocal : r.tradeValueLocal, w ? r.wholeShares : r.tradeShares, w ? r.wholePostTradeShares : r.postTradeShares];
    });
    return [header, ...body];
  }
  function exportMeta() {
    const run = state.plan;
    const s = run.plan.summary;
    const manual = run.valuation.manualOverrides.length;
    return [
      ["Portfolio Rebalancer — browser export"],
      ["Generated at (UTC)", new Date().toISOString()],
      ["Plan calculated at (UTC)", run.at.toISOString()],
      ["Mode", run.mode === "new_money" ? "New Money" : "Rebalance"],
      ["Reporting currency", run.reporting],
      ["Share quantities", run.whole ? "Whole shares" : "Fractional shares"],
      ["Prices", manual ? `Includes ${manual} user-supplied price(s); the rest verified by providers` : "All verified by providers"],
      ["Total current", s.totalCurrent], ["Target pool", s.pool],
      ["Total buys", run.whole ? run.whole.totalBuys : s.totalBuys], ["Total sells", run.whole ? run.whole.totalSells : s.totalSells],
      ...(run.mode === "new_money" ? [["New money budget", s.budget]] : []),
      ["Cash not invested", run.whole ? run.whole.cashLeft : s.cashLeft],
    ];
  }
  function exportExtras() {
    const run = state.plan;
    const codes = [...new Set(run.plan.results.map(r => r.currencyKey))].filter(c => c !== run.reporting);
    const fx = [["Currency", `${run.reporting} per unit`, "Source"], ...codes.map(c => [c, run.fx[c].cadPer / run.fx[run.reporting].cadPer, run.fx[c].kind === "manual" ? "Entered by you" : run.fx[c].label])];
    const { attention, info } = planNotes(run);
    const notValued = run.notValued.map(r => [r.ticker, "not in the plan (0 shares, 0% target)"]);
    return { fx, notes: [...attention, ...info], notValued };
  }
  $("rbExportCsv").addEventListener("click", () => {
    if (!state.plan) return;
    const extra = exportExtras();
    const rows = [...exportMeta(), [], ...exportTable(), [], ["Not in the plan"], ...extra.notValued, [], ...extra.fx, [], ["Notes and warnings"], ...extra.notes.map(n => [n]), [], ["Disclaimer", DISCLAIMER]];
    const name = `rebalance-plan-${timestampSlug()}.csv`;
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });
  $("rbExportXlsx").addEventListener("click", () => {
    if (!state.plan) return;
    const header = cells => ({ header: true, cells });
    const extra = exportExtras();
    const meta = exportMeta();
    const table = exportTable();
    const summary = [header(meta[0]), ...meta.slice(1), [], header(extra.fx[0]), ...extra.fx.slice(1), [], header(["Not in the plan"]), ...extra.notValued, [], header(["Notes and warnings"]), ...extra.notes.map(n => [n]), [], ["Disclaimer", DISCLAIMER]];
    const name = `rebalance-plan-${timestampSlug()}.xlsx`;
    downloadBlob(buildXlsx([{ name: "Trade Plan", rows: [header(table[0]), ...table.slice(1)] }, { name: "Summary", rows: summary }]), name);
    setStatus(`Downloaded ${name}.`, "ok");
  });

  /* ---------------- CSV holdings and prices ---------------- */
  async function readFile(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return null;
    if (file.size > 1024 * 1024) throw new Error("The file is larger than 1 MB.");
    return { name: file.name, text: await file.text() };
  }
  const pickColumn = (headers, names) => headers.find(h => names.includes(h.toLowerCase().replace(/[^a-z_%]/g, "")));
  $("rbImportHoldings").addEventListener("change", async event => {
    try {
      const file = await readFile(event.target);
      if (!file) return;
      const { headers, records } = csvRecords(file.text);
      const t = pickColumn(headers, ["ticker", "symbol"]);
      const sh = pickColumn(headers, ["shares", "quantity", "units", "qty"]);
      const tw = pickColumn(headers, ["target_pct", "target", "target%", "targetweight", "target_weight", "weight"]);
      const ac = pickColumn(headers, ["account", "account_type", "accounttype"]);
      if (!t || !sh || !tw) throw new Error("The file needs ticker, shares and target_pct columns.");
      const data = records.filter(r => r[t]).slice(0, E.MAX_ROWS).map(r => ({ ticker: r[t], shares: r[sh], targetWeight: r[tw], accountType: E.ACCOUNT_TYPES.includes(r[ac]) ? r[ac] : "" }));
      if (!data.length) throw new Error("No holdings found in the file.");
      setRows(data);
      resolveAll();
      afterChange();
      setStatus(`Imported ${data.length} holdings from ${file.name}. No prices were imported; press Get prices.`, "ok");
    } catch (error) { setStatus(`Import failed: ${error.message}`, "error"); }
  });
  $("rbExportHoldings").addEventListener("click", () => {
    const rows = [["ticker", "shares", "target_pct", "account"], ...state.rows.filter(r => r.ticker).map(r => [r.ticker, r.shares, r.targetWeight, r.accountType])];
    downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), `holdings-${timestampSlug()}.csv`);
  });
  $("rbImportPrices").addEventListener("change", async event => {
    try {
      const file = await readFile(event.target);
      if (!file) return;
      const { headers, records } = csvRecords(file.text);
      const t = pickColumn(headers, ["ticker", "symbol"]);
      const p = pickColumn(headers, ["price", "close", "last"]);
      const c = pickColumn(headers, ["currency", "ccy"]);
      if (!t || !p || !c) throw new Error("The file needs ticker, price and currency columns.");
      let applied = 0;
      const skipped = [];
      for (const rec of records) {
        const ticker = String(rec[t] || "").trim().toUpperCase();
        const matches = state.rows.filter(r => r.ticker === ticker);
        if (!matches.length) { if (ticker) skipped.push(ticker); continue; }
        for (const row of matches) {
          if (row.quote) continue; // a fetched price is kept; imported prices fill gaps only
          try {
            const cur = String(rec[c]).trim();
            const minor = /^(GBX|GBp)$/.test(cur);
            putRow(R.setManualPrice(row, { price: E.parseNumber(rec[p]), currency: minor ? "GBP" : cur.toUpperCase(), unitScale: minor ? 0.01 : 1, kind: "csv", label: `Imported from ${file.name}${rec.date ? ` (dated ${rec.date})` : ""} (user-supplied)` }));
            applied += 1;
          } catch (error) { skipped.push(`${ticker} (${error.message})`); }
        }
      }
      state.rows.forEach(renderRow);
      afterChange();
      setStatus(`Applied ${applied} user-supplied price${applied === 1 ? "" : "s"} from ${file.name}.${skipped.length ? ` Not applied: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""}.` : ""}`, applied ? "warn" : "error");
    } catch (error) { setStatus(`Import failed: ${error.message}`, "error"); }
  });

  /* ---------------- events ---------------- */
  $("rbRun").addEventListener("click", () => computePlan());
  $("rbAddRow").addEventListener("click", () => {
    if (state.rows.length >= E.MAX_ROWS) { setStatus(`At most ${E.MAX_ROWS} holdings.`, "warn"); return; }
    const row = R.createRow();
    const firstTest = state.rows.findIndex(r => r.group === CURRENCY_TEST_GROUP);
    if (firstTest >= 0) state.rows.splice(firstTest, 0, row); else state.rows.push(row);
    rebuildRows();
    nodes.get(row.id)?.querySelector(".rb-ticker").focus();
  });
  $("rbClear").addEventListener("click", () => { setRows([{}]); state.planRequested = false; els.results.replaceChildren(el("p", "Enter holdings and get their prices, then calculate the plan.", "muted")); setStatus("Cleared.", null); });
  $("rbSample").addEventListener("click", async () => {
    els.reporting.value = SAMPLE_PORTFOLIO.reportingCurrency;
    els.mode.value = SAMPLE_PORTFOLIO.mode;
    els.budget.value = String(SAMPLE_PORTFOLIO.budget);
    syncMode();
    state.planRequested = false;
    setRows(SAMPLE_PORTFOLIO.rows);
    await md.ready();
    resolveAll();
    els.results.replaceChildren(el("p", "Get the prices, then calculate the plan.", "muted"));
    afterChange();
    setStatus("Sample portfolio loaded: 10 holdings and 4 international currency-test rows, with no prices. Press Get prices; nothing is fetched until you do.", null);
  });
  $("rbPriceAll").addEventListener("click", () => priceMany(mainRows().filter(r => R.isActive(r) && !R.effectivePrice(r)), "Holdings"));
  $("rbPriceTests").addEventListener("click", () => priceMany(testRows(), "Currency-test rows"));
  $("rbRemoveTests").addEventListener("click", () => { state.rows = state.rows.filter(r => r.group !== CURRENCY_TEST_GROUP); rebuildRows(); setStatus("Currency-test rows removed.", null); });
  function syncMode() { $("rbBudgetField").hidden = els.mode.value !== "new_money"; $("rbBudgetLabel").textContent = `New money budget (${rep()})`; }
  els.mode.addEventListener("change", () => { syncMode(); afterChange(); });
  els.reporting.addEventListener("change", async () => { syncMode(); await ensureFx([]); state.rows.forEach(renderRow); afterChange(); });
  els.budget.addEventListener("input", afterChange);
  els.rounding.addEventListener("change", afterChange);
  els.showAccount.addEventListener("change", () => { state.rows.forEach(renderRow); afterChange(); });

  /* ---------------- start ---------------- */
  REPORTING.forEach(code => { const o = el("option", code); o.value = code; els.reporting.append(o); });
  els.reporting.value = "CAD";
  syncMode();
  setRows([{}]);
  renderProviders();
  setStatus("Ready. Enter your holdings, or load the sample portfolio.", null);
  root.dataset.ready = "true";
  md.ready().then(() => { resolveAll(); afterChange(); });
  ensureFx(STARTUP_FX).then(() => { root.dataset.fxReady = "true"; afterChange(); });
}
