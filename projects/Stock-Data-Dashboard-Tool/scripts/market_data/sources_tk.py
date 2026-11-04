"""The source-priority editor for both desktop apps (Tkinter, standard library only).

The desktop counterpart of assets/js/market-data/sources-ui.js: a numbered list of the
market-data sources in the order they are tried, with what each provides and its state.
Ways to reorder, all equivalent:
  * drag a row with the mouse;
  * the "Move up" / "Move down" buttons;
  * keyboard: select a row and press Alt+Up / Alt+Down (Ctrl+Up / Ctrl+Down also work;
    Home / End with Alt move it to the top / bottom); Space switches it on or off.
Every change is saved at once (files/runtime/market-data-settings.json) and announced
in the status line. `op` is the operation the program needs: "quote" (Rebalancer) or
"history" (Stock tool); a source without it is shown with the reason.

The window also explains Yahoo Finance in plain words. No browser, extension or local
web server is involved.
"""
from __future__ import annotations

from typing import Callable

try:
    import tkinter as tk
    from tkinter import ttk
except ImportError:  # pragma: no cover - the launcher installs a Python with Tk
    tk = ttk = None  # type: ignore[assignment]

YAHOO_TITLE = "Yahoo Finance — Free Market Data"
YAHOO_TEXT = ("Prices are retrieved automatically from Yahoo Finance through this site's data gateway and briefly cached for faster "
              "access. No account or key is needed. Quotes may be delayed, incomplete, or differ from official exchange data. This "
              "information is for research and planning, not financial advice.\n\nFor more sources, add your own provider API keys "
              "(API keys…) and choose the order in which sources are tried.")
OP_TEXT = {"quote": "latest prices", "history": "price history"}
STATUS_TEXT = {"on": "On", "off": "Off", "needs_key": "Needs your API key", "unavailable": "On, but unavailable"}


def status_text(s: dict) -> str:
    if s["status"] == "unavailable":
        return f"On, but unavailable: {s['state'].get('reason')}"
    if s["status"] == "on":
        return "On · your key" if s["needsKey"] else "On · no key needed"
    return STATUS_TEXT[s["status"]]


def yahoo_state_text(md) -> str:
    s = next((x for x in md.sources_list() if x["id"] == "yahoo"), None)
    st = md.gateway.status["state"]
    pause = md.gateway.pause_state()
    if st == "enabled" and pause["paused"]:
        return f"Paused: {pause['reason']}. Nothing is sent to it until then; the other sources in your list are used."
    if st == "enabled":
        return f"Available, and position {s['position']} in your list." if s and s["enabled"] else "Available, but switched off in your list."
    return {"checking": "Checking whether Yahoo Finance is available…",
            "disabled": "Not available right now: it is switched off on this site at the moment.",
            "unreachable": "Not available right now: this site's data gateway could not be reached.",
            "not_configured": "Not available yet. Add your own key (API keys…), or use your own prices."}.get(st, "Not available right now.")


def order_summary(md, op: str = "quote") -> str:
    """One line for the main window: "1. Yahoo Finance · 2. Alpha Vantage (off) · …"."""
    parts = []
    for s in md.sources_list():
        extra = "" if s["enabled"] else " (off)"
        if s["enabled"] and op not in s["ops"]:
            extra = f" ({OP_TEXT['quote'] if op == 'history' else OP_TEXT['history']} only)"
        elif s["enabled"] and not s["available"]:
            extra = " (unavailable)"
        parts.append(f"{s['position']}. {s['name']}{extra}")
    return "Sources, in the order tried: " + " · ".join(parts)


class SourceListDialog:
    """A window listing the sources; reorder, switch on/off; calls on_change(message) after each change."""

    def __init__(self, parent, md, op: str = "quote", on_change: Callable[[str], None] | None = None, title: str = "Market data sources") -> None:
        self.md, self.op, self.on_change = md, op, on_change or (lambda message: None)
        self.top = top = tk.Toplevel(parent)
        top.title(title)
        top.transient(parent)
        frame = ttk.Frame(top, padding=10)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text=YAHOO_TITLE, font=("TkDefaultFont", 11, "bold")).pack(anchor="w")
        ttk.Label(frame, text=YAHOO_TEXT, wraplength=620, justify="left").pack(anchor="w", pady=(2, 4))
        self.yahoo_state = ttk.Label(frame, text="", wraplength=620, justify="left")
        self.yahoo_state.pack(anchor="w", pady=(0, 8))
        ttk.Label(frame, text="Your sources, in the order they are tried", font=("TkDefaultFont", 10, "bold")).pack(anchor="w")
        ttk.Label(frame, wraplength=620, justify="left", text=(
            f"For each holding the first source that can give its {OP_TEXT[op]} is used; the next is tried only if it cannot (it does not cover "
            "the exchange, has no data, cannot confirm the listing or currency, or is limited or unavailable).")).pack(anchor="w", pady=(0, 4))
        body = ttk.Frame(frame)
        body.pack(fill="both", expand=True)
        cols = ("pos", "name", "state", "ops")
        self.tree = ttk.Treeview(body, columns=cols, show="headings", height=6, selectmode="browse")
        for col, text, width in (("pos", "#", 34), ("name", "Source", 120), ("state", "Status", 250), ("ops", "Provides here", 300)):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor="w", stretch=col != "pos")
        self.tree.pack(side="left", fill="both", expand=True)
        buttons = ttk.Frame(body, padding=(8, 0, 0, 0))
        buttons.pack(side="left", fill="y")
        self.up = ttk.Button(buttons, text="Move up", command=lambda: self._move(-1))
        self.down = ttk.Button(buttons, text="Move down", command=lambda: self._move(1))
        self.toggle = ttk.Button(buttons, text="Switch off", command=self._toggle)
        for b in (self.up, self.down, self.toggle):
            b.pack(fill="x", pady=2)
        ttk.Label(frame, wraplength=620, justify="left", foreground="#3f5066",
                  text="Drag a row, use Move up and Move down, or select a row and press Alt+Up / Alt+Down. Space switches the selected source on or off.").pack(anchor="w", pady=(6, 0))
        self.why = ttk.Label(frame, text="", wraplength=620, justify="left")
        self.why.pack(anchor="w", pady=(4, 0))
        self.live = ttk.Label(frame, text="", wraplength=620, justify="left", foreground="#1f4f8a")
        self.live.pack(anchor="w", pady=(4, 0))
        ttk.Button(frame, text="Close", command=top.destroy).pack(anchor="e", pady=(8, 0))
        for seq, delta in (("<Alt-Up>", -1), ("<Alt-Down>", 1), ("<Control-Up>", -1), ("<Control-Down>", 1), ("<Alt-Home>", "top"), ("<Alt-End>", "bottom")):
            self.tree.bind(seq, lambda e, d=delta: (self._move(d), "break")[1])
        self.tree.bind("<space>", lambda e: (self._toggle(), "break")[1])
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._sync_buttons())
        self.tree.bind("<ButtonPress-1>", self._drag_start)
        self.tree.bind("<B1-Motion>", self._drag_motion)
        self.tree.bind("<ButtonRelease-1>", self._drag_end)
        self._drag: str | None = None
        self.render()
        rows = self.tree.get_children()
        if rows:
            self.tree.selection_set(rows[0])
            self.tree.focus(rows[0])
        self.tree.focus_set()

    # ------------------------------------------------------------------ view
    def render(self, select: str | None = None) -> None:
        current = select or (self.tree.selection() or [None])[0]
        self.tree.delete(*self.tree.get_children())
        for s in self.md.sources_list():
            provides = ", ".join(s["labels"].get(o, OP_TEXT[o]) for o in s["ops"]) or "nothing here"
            if self.op not in s["ops"]:
                provides = f"{provides} — not used here ({OP_TEXT[self.op]} not available)"
            self.tree.insert("", "end", iid=s["id"], values=(s["position"], s["name"], status_text(s), provides))
        if current and self.tree.exists(current):
            self.tree.selection_set(current)
            self.tree.focus(current)
            self.tree.see(current)
        self.yahoo_state.configure(text=f"Status: {yahoo_state_text(self.md)}")
        self._sync_buttons()

    def selected(self) -> dict | None:
        sel = self.tree.selection()
        return next((s for s in self.md.sources_list() if sel and s["id"] == sel[0]), None)

    def _sync_buttons(self) -> None:
        s = self.selected()
        count = len(self.md.sources_list())
        self.up.configure(state="normal" if s and s["position"] > 1 else "disabled")
        self.down.configure(state="normal" if s and s["position"] < count else "disabled")
        if not s:
            self.toggle.configure(state="disabled")
            self.why.configure(text="")
            return
        self.toggle.configure(text="Switch off" if s["enabled"] else "Switch on", state="disabled" if s["status"] == "needs_key" else "normal")
        why = s["summary"]
        if s["status"] == "needs_key":
            why = f"Add your {s['name']} key under API keys…; it is then switched on here."
        elif self.op not in s["ops"]:
            why = f"Not used here: {s['name']} {'provides latest prices only, not price history' if self.op == 'history' else 'provides no latest prices here'}."
        self.why.configure(text=f"{s['name']}: {why}")

    def announce(self, text: str) -> None:
        self.live.configure(text=text)
        self.on_change(text)

    # ------------------------------------------------------------------ actions
    def _move(self, delta) -> None:
        s = self.selected()
        if not s:
            return
        count = len(self.md.sources_list())
        index = s["position"] - 1
        target = 0 if delta == "top" else count - 1 if delta == "bottom" else index + delta
        if target < 0 or target >= count or target == index:
            self.live.configure(text=f"{s['name']} is already at position {s['position']} of {count}.")
            return
        r = self.md.move_source(s["id"], target)
        self.render(select=s["id"])
        self.announce(r["message"])

    def _toggle(self) -> None:
        s = self.selected()
        if not s:
            return
        r = self.md.set_source_enabled(s["id"], not s["enabled"])
        self.render(select=s["id"])
        self.announce(r["message"])

    def _drag_start(self, event) -> None:
        row = self.tree.identify_row(event.y)
        self._drag = row or None

    def _drag_motion(self, event) -> None:
        if not self._drag:
            return
        over = self.tree.identify_row(event.y)
        if over and over != self._drag:
            self.tree.configure(cursor="sb_v_double_arrow")

    def _drag_end(self, event) -> None:
        dragged, self._drag = self._drag, None
        self.tree.configure(cursor="")
        if not dragged:
            return
        over = self.tree.identify_row(event.y)
        if not over or over == dragged:
            return
        order = [s["id"] for s in self.md.sources_list()]
        r = self.md.move_source(dragged, order.index(over))
        self.render(select=dragged)
        self.announce(r["message"])
