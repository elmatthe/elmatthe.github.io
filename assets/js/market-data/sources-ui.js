// The source-priority editor shared by the Portfolio Rebalancer and the Stock
// Comparison pages: a numbered list of market-data sources in the order they are tried.
//
// Ways to reorder, all equivalent:
//   * drag an entry by its handle (mouse or pen);
//   * the "Move up" / "Move down" buttons on each entry (touch screens, switch access);
//   * keyboard: focus an entry's handle and press Arrow Up / Arrow Down (Home / End move
//     it to the top / bottom); focus stays on the moved entry.
// Each change is announced in a polite live region ("Alpha Vantage moved to position 1
// of 4") and saved at once (md.sources, local storage), so it survives a reload.
//
// `op` is the operation this page needs ("quote" for the Rebalancer, "history" for the
// Stock tool): a source without it is shown with the reason and is never asked for it.

import { sourceName } from "./sources.js";

const OP_TEXT = { quote: "latest prices", history: "price history" };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

export function createSourceList(container, md, { op = "quote", idPrefix = "ms", onChange = () => {}, describeKey = null } = {}) {
  const wrap = el("div", null, "ms-sources");
  const list = el("ol", null, "ms-list");
  list.id = `${idPrefix}List`;
  list.setAttribute("aria-label", "Market data sources, in the order they are tried");
  const help = el("p", "Drag an entry, use its Move up and Move down buttons, or focus its handle and press the arrow keys.", "ms-help");
  help.id = `${idPrefix}Help`;
  const live = el("p", "", "ms-live");
  live.id = `${idPrefix}Live`;
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  const notes = el("p", "", "ms-notes");
  notes.id = `${idPrefix}Notes`;
  wrap.append(list, help, live, notes);
  container.replaceChildren(wrap);

  let dragId = null;
  const announce = text => { live.textContent = ""; live.textContent = text; };

  function statusText(s) {
    if (s.status === "needs_key") return "Needs your API key";
    if (s.status === "off") return "Off";
    if (s.status === "unavailable") return `On, but unavailable: ${s.state.reason}`;
    return s.needsKey ? "On · your key" : "On · no key needed";
  }

  function move(id, toIndex, { focus = null } = {}) {
    const r = md.sources.move(id, toIndex);
    render();
    if (r.moved) announce(r.message);
    onChange({ type: "move", id, message: r.message });
    if (focus) list.querySelector(`[data-source="${id}"] ${focus}`)?.focus();
    return r;
  }

  function item(s, count) {
    const li = el("li", null, "ms-item");
    li.dataset.source = s.id;
    li.dataset.status = s.status;
    li.draggable = true;
    const handle = el("button", "", "ms-handle");
    handle.type = "button";
    handle.setAttribute("aria-label", `${s.name}: position ${s.position} of ${count}. Press Arrow Up or Arrow Down to move it.`);
    handle.setAttribute("aria-describedby", help.id);
    handle.title = "Drag to reorder, or press the arrow keys";
    handle.append(el("span", String(s.position), "ms-pos"), el("span", "⠿", "ms-grip"));
    handle.querySelector(".ms-grip").setAttribute("aria-hidden", "true");

    const body = el("div", null, "ms-body");
    const head = el("p", null, "ms-head");
    head.append(el("strong", s.name, "ms-name"), el("span", statusText(s), "ms-state"));
    body.append(head);
    const ops = el("ul", null, "ms-ops");
    ops.setAttribute("aria-label", `What ${s.name} provides here`);
    for (const o of s.ops) ops.append(el("li", s.labels[o] || OP_TEXT[o]));
    if (!s.ops.length) ops.append(el("li", "Nothing on this platform"));
    body.append(ops);
    if (!s.ops.includes(op)) body.append(el("p", `Not used on this page: ${sourceName(s.id)} ${op === "history" ? "provides latest prices only, not price history" : "provides no latest prices here"}.`, "ms-why"));
    else if (s.status === "needs_key") body.append(el("p", describeKey ? describeKey(s.id) : `Add your ${s.name} key to switch it on.`, "ms-why"));
    else if (s.summary) body.append(el("p", s.summary, "ms-why"));

    const controls = el("div", null, "ms-controls");
    const toggleLabel = el("label", null, "ms-toggle");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.checked = s.enabled;
    toggle.disabled = s.status === "needs_key";
    toggle.id = `${idPrefix}On-${s.id}`;
    toggle.setAttribute("aria-label", `Use ${s.name}`);
    toggleLabel.append(toggle, el("span", "Use"));
    toggle.addEventListener("change", () => {
      const r = md.sources.setEnabled(s.id, toggle.checked);
      render();
      announce(r.message);
      onChange({ type: "enabled", id: s.id, message: r.message });
      list.querySelector(`#${CSS.escape(toggle.id)}`)?.focus();
    });
    const up = el("button", "↑", "ms-move");
    up.type = "button";
    up.dataset.dir = "up";
    up.setAttribute("aria-label", `Move ${s.name} up`);
    up.disabled = s.position === 1;
    up.addEventListener("click", () => move(s.id, s.position - 2, { focus: s.position - 2 === 0 ? '[data-dir="down"]' : '[data-dir="up"]' }));
    const down = el("button", "↓", "ms-move");
    down.type = "button";
    down.dataset.dir = "down";
    down.setAttribute("aria-label", `Move ${s.name} down`);
    down.disabled = s.position === count;
    down.addEventListener("click", () => move(s.id, s.position, { focus: s.position + 1 === count ? '[data-dir="up"]' : '[data-dir="down"]' }));
    controls.append(toggleLabel, up, down);
    li.append(handle, body, controls);

    handle.addEventListener("keydown", event => {
      const index = s.position - 1;
      const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: count - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      if (target < 0 || target >= count || target === index) { announce(`${s.name} is already at position ${s.position} of ${count}.`); return; }
      move(s.id, target, { focus: ".ms-handle" });
    });

    // Drag and drop (HTML5). Touch screens use the Move buttons.
    li.addEventListener("dragstart", event => {
      dragId = s.id;
      li.classList.add("ms-dragging");
      try { event.dataTransfer.setData("text/plain", s.id); event.dataTransfer.effectAllowed = "move"; } catch (_) { /* older browsers */ }
    });
    li.addEventListener("dragend", () => { dragId = null; li.classList.remove("ms-dragging"); list.querySelectorAll(".ms-drop-before,.ms-drop-after").forEach(n => n.classList.remove("ms-drop-before", "ms-drop-after")); });
    li.addEventListener("dragover", event => {
      if (!dragId || dragId === s.id) return;
      event.preventDefault();
      const box = li.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      li.classList.toggle("ms-drop-after", after);
      li.classList.toggle("ms-drop-before", !after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("ms-drop-before", "ms-drop-after"));
    li.addEventListener("drop", event => {
      event.preventDefault();
      const id = dragId || event.dataTransfer?.getData("text/plain");
      li.classList.remove("ms-drop-before", "ms-drop-after");
      if (!id || id === s.id) return;
      const order = md.sources.order().filter(x => x !== id);
      const box = li.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      const at = order.indexOf(s.id) + (after ? 1 : 0);
      move(id, at, { focus: ".ms-handle" });
    });
    return li;
  }

  function render() {
    const sources = md.sources.list();
    list.replaceChildren(...sources.map(s => item(s, sources.length)));
    const pending = md.sources.notes();
    if (pending.length) notes.textContent = pending.join(" ");
    const usable = sources.filter(s => s.enabled && s.ops.includes(op) && s.available);
    wrap.dataset.usable = String(usable.length);
  }

  render();
  return {
    render,
    announce,
    note: text => { notes.textContent = text || ""; },
  };
}
