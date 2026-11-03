"""Tkinter window for the Portfolio Rebalancer (same workflow and rules as the web app).

Layout: settings and market data at the top; holdings on the left and the trade
plan on the right in a resizable pane (stacked on narrow screens). Holdings are a
scrollable list (ticker, shares, target %, optional account, status line); the plan
is a compact table (action, ticker, shares, amount, weight before -> after) with a
details panel for the selected holding. Network work runs on worker threads; every
answer is checked against the holding's current revision before it is shown.
"""
from __future__ import annotations

import csv
import io
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TK_AVAILABLE = True
try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:  # pragma: no cover
    TK_AVAILABLE = False
    tk = ttk = filedialog = messagebox = None  # type: ignore[assignment]

from market_data.catalog import PROVIDERS, providers_for
from market_data.errors import DataError
from market_data.freshness import freshness_of
from market_data.service import MarketData
from portfolio_rebalancer import core
from portfolio_rebalancer.export import write_csv_export, write_excel_export
from portfolio_rebalancer.model import (ACCOUNT_TYPES, REPORTING, Row, Settings, action_lines, build_plan, money, qty, quote_label,
                                         rows_from_sample)
from portfolio_rebalancer.sample import SAMPLE_PORTFOLIO, is_unchanged_international_example, target_total_basis_points

TOOL_ROOT = Path(__file__).resolve().parents[2]
RUNTIME = TOOL_ROOT / "files" / "runtime"
STARTUP_FX = ["USD", "EUR", "GBP", "JPY", "CNY", "HKD", "CHF", "AUD"]
COLORS = {"ok": "#1c7550", "warn": "#8f5f12", "error": "#9b2f2f", "busy": "#1f4f8a", "": "#3f5066"}
DESKTOP_PROVIDERS = providers_for("desktop")


def enable_dpi_awareness() -> None:
    """Sharp text at 125% and 150% Windows display scaling (before the window exists)."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001 - older Windows: fall back to system scaling
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:  # noqa: BLE001
                pass


class RebalancerApp:
    def __init__(self, root: "tk.Tk", market: MarketData | None = None) -> None:
        self.root = root
        self.md = market or MarketData(RUNTIME)
        self.rows: list[Row] = [Row()]
        self.fx: dict[str, dict] = {"CAD": {"cadPer": 1.0, "kind": "official", "label": "base"}}
        self.fx_note = ""
        self.run: dict | None = None
        self.plan_requested = False
        self.events: queue.Queue = queue.Queue()
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.row_widgets: dict[str, dict] = {}
        self.closing = False
        self.batch: dict | None = None  # the last Get prices, until every holding in it has an answer
        root.title("Portfolio Rebalancer")
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{min(1360, int(sw * 0.92))}x{min(900, int(sh * 0.88))}")
        root.minsize(min(900, sw), min(600, sh))
        self._build()
        self._render_rows()
        self._poll()
        self.pool.submit(self._load_fx, STARTUP_FX, "CAD")
        self._status("Ready. Enter your holdings, or load the sample portfolio.")

    # ------------------------------------------------------------------ layout
    def _build(self) -> None:
        r = self.root
        style = ttk.Style(r)
        style.configure("Status.TLabel", foreground=COLORS[""])
        top = ttk.Frame(r, padding=(10, 8, 10, 4))
        top.pack(fill="x")
        ttk.Label(top, text="Portfolio Rebalancer", font=("TkDefaultFont", 15, "bold")).grid(row=0, column=0, columnspan=8, sticky="w")
        self.reporting = tk.StringVar(value="CAD")
        self.mode = tk.StringVar(value="New Money (buy only)")
        self.budget = tk.StringVar(value="3000")
        self.rounding = tk.StringVar(value="Fractional shares")
        self.show_accounts = tk.BooleanVar(value=False)
        self.source = tk.StringVar(value="Automatic (route by market)")
        self.fallback = tk.BooleanVar(value=self.md.prefs["fallback"])
        fields = [("Reporting currency", ttk.Combobox(top, textvariable=self.reporting, values=REPORTING, width=8, state="readonly")),
                  ("Mode", ttk.Combobox(top, textvariable=self.mode, values=["New Money (buy only)", "Rebalance (sells fund buys)"], width=24, state="readonly")),
                  ("New money budget", ttk.Entry(top, textvariable=self.budget, width=12)),
                  ("Share quantities", ttk.Combobox(top, textvariable=self.rounding, values=["Fractional shares", "Whole shares"], width=16, state="readonly")),
                  ("Price source", ttk.Combobox(top, textvariable=self.source, values=self._source_names(), width=26, state="readonly"))]
        for i, (label, widget) in enumerate(fields):
            ttk.Label(top, text=label).grid(row=1, column=i, sticky="w", padx=(0, 10))
            widget.grid(row=2, column=i, sticky="we", padx=(0, 10))
        self.budget_label, self.budget_entry = top.grid_slaves(row=1, column=2)[0], fields[2][1]
        for var in (self.mode, self.rounding):
            var.trace_add("write", lambda *_: self._after_change())
        self.reporting.trace_add("write", lambda *_: (self.pool.submit(self._load_fx, [], self.reporting.get()), self._after_change()))
        self.budget.trace_add("write", lambda *_: self._after_change())
        self.source.trace_add("write", lambda *_: self._on_source())
        bar = ttk.Frame(top)
        bar.grid(row=3, column=0, columnspan=8, sticky="w", pady=(6, 0))
        ttk.Checkbutton(bar, text="Show account types", variable=self.show_accounts, command=self._render_rows).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(bar, text="If the chosen source cannot price a holding, try my other saved sources", variable=self.fallback,
                        command=lambda: self.md.set_routing(fallback=self.fallback.get())).pack(side="left", padx=(0, 12))
        ttk.Button(bar, text="API keys…", command=self._keys_dialog).pack(side="left", padx=(0, 6))
        ttk.Button(bar, text="Exchange rates…", command=self._fx_dialog).pack(side="left")

        self.panes = ttk.PanedWindow(r, orient="horizontal" if r.winfo_screenwidth() >= 1100 else "vertical")
        self.panes.pack(fill="both", expand=True, padx=10, pady=(4, 4))
        left = ttk.LabelFrame(self.panes, text="Holdings", padding=6)
        right = ttk.LabelFrame(self.panes, text="Trade plan", padding=6)
        self.panes.add(left, weight=1)
        self.panes.add(right, weight=1)

        tools = ttk.Frame(left)
        tools.pack(fill="x")
        # Two rows of buttons so nothing is cut off on a 1366-pixel screen at 125% scaling.
        for i, (text, cmd) in enumerate((("Add holding", self._add_row), ("Load sample", self._load_sample), ("Get prices", self._price_all),
                                         ("Clear", self._clear), ("Remove international examples", self._remove_international),
                                         ("Import CSV…", self._import_holdings), ("Export CSV…", self._export_holdings))):
            ttk.Button(tools, text=text, command=cmd).grid(row=i // 4, column=i % 4, padx=(0, 4), pady=(0, 4), sticky="we")
        self.estimate = ttk.Label(left, text="", wraplength=560, justify="left", foreground=COLORS[""])
        self.estimate.pack(fill="x")
        self.summary = ttk.Label(left, text="", font=("TkDefaultFont", 10, "bold"), wraplength=560, justify="left")
        self.summary.pack(fill="x", pady=(2, 4))
        holder = ttk.Frame(left)
        holder.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(holder, highlightthickness=0)
        scroll = ttk.Scrollbar(holder, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.rows_frame = ttk.Frame(self.canvas)
        self.rows_window = self.canvas.create_window((0, 0), window=self.rows_frame, anchor="nw")
        self.rows_frame.bind("<Configure>", lambda _: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(int(-e.delta / 120), "units"))

        actions = ttk.Frame(right)
        actions.pack(fill="x")
        ttk.Button(actions, text="Calculate plan", command=self._calculate).pack(side="left", padx=(0, 4))
        self.csv_button = ttk.Button(actions, text="Export CSV…", command=lambda: self._export("csv"), state="disabled")
        self.csv_button.pack(side="left", padx=(0, 4))
        self.xlsx_button = ttk.Button(actions, text="Export Excel…", command=lambda: self._export("xlsx"), state="disabled")
        self.xlsx_button.pack(side="left")
        self.status = ttk.Label(right, text="", wraplength=520, justify="left", style="Status.TLabel")
        self.status.pack(fill="x", pady=(4, 4))
        self.headline = ttk.Label(right, text="", wraplength=520, justify="left", font=("TkDefaultFont", 10, "bold"))
        self.headline.pack(fill="x")
        tree_holder = ttk.Frame(right)
        tree_holder.pack(fill="both", expand=True, pady=(4, 4))
        cols = ("action", "ticker", "shares", "amount", "weights")
        self.tree = ttk.Treeview(tree_holder, columns=cols, show="headings", height=12, selectmode="browse")
        for col, text, width, anchor in (("action", "Action", 56, "w"), ("ticker", "Ticker", 80, "w"), ("shares", "Shares", 74, "e"),
                                         ("amount", "Amount", 96, "e"), ("weights", "Weight now → after (target)", 210, "w")):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor=anchor, stretch=True, minwidth=50)
        tree_scroll = ttk.Scrollbar(tree_holder, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=tree_scroll.set)
        tree_scroll.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", lambda _: self._show_details())
        self.details = tk.Text(right, height=10, wrap="word", relief="flat", background=r.cget("background"))
        self.details.pack(fill="both", expand=False)
        self.details.configure(state="disabled")
        ttk.Label(r, text="Illustrative planning only; not financial, investment or trading advice. Prices are the latest available from your chosen "
                          "provider, not real-time unless the source says so. Verify prices at your broker before trading.",
                  wraplength=1200, foreground=COLORS[""]).pack(fill="x", padx=10, pady=(0, 6))
        r.bind("<Configure>", self._on_window_resize)
        r.protocol("WM_DELETE_WINDOW", self._close)

    def _source_names(self) -> list[str]:
        return ["Automatic (route by market)"] + [PROVIDERS[p]["name"] for p in DESKTOP_PROVIDERS]

    def _source_id(self) -> str:
        name = self.source.get()
        return next((p for p in DESKTOP_PROVIDERS if PROVIDERS[p]["name"] == name), "auto")

    def _on_canvas_resize(self, event) -> None:
        self.canvas.itemconfigure(self.rows_window, width=event.width)
        for w in self.row_widgets.values():
            w["status"].configure(wraplength=max(240, event.width - 40))
        for label in (self.estimate, self.summary):
            label.configure(wraplength=max(240, event.width))

    def _on_window_resize(self, event) -> None:
        if event.widget is self.root:
            width = max(300, event.width // 2 - 60)
            for label in (self.status, self.headline):
                label.configure(wraplength=width)

    def _status(self, text: str, tone: str = "") -> None:
        self.status.configure(text=text, foreground=COLORS.get(tone, COLORS[""]))

    # ------------------------------------------------------------------ holdings
    def _render_rows(self) -> None:
        for child in self.rows_frame.winfo_children():
            child.destroy()
        self.row_widgets.clear()
        show_acct = self.show_accounts.get()
        # One list: every holding uses the same card and the same rules, whatever its market.
        line = 0
        for row in self.rows:
            line = self._build_row(row, line, show_acct)
        self._after_change()

    def _build_row(self, row: Row, line: int, show_acct: bool) -> int:
        f = self.rows_frame
        ticker, shares, target = tk.StringVar(value=row.ticker), tk.StringVar(value=row.shares), tk.StringVar(value=row.target)
        account = tk.StringVar(value=row.account or "Unassigned")
        grid = ttk.Frame(f)
        grid.grid(row=line, column=0, sticky="we", pady=(4, 0))
        f.columnconfigure(0, weight=1)
        ttk.Label(grid, text="Ticker").grid(row=0, column=0, sticky="w")
        ttk.Label(grid, text="Shares").grid(row=0, column=1, sticky="w")
        ttk.Label(grid, text="Target %").grid(row=0, column=2, sticky="w")
        e_ticker = ttk.Entry(grid, textvariable=ticker, width=12)
        e_shares = ttk.Entry(grid, textvariable=shares, width=9)
        e_target = ttk.Entry(grid, textvariable=target, width=6)
        e_ticker.grid(row=1, column=0, padx=(0, 6), sticky="w")
        e_shares.grid(row=1, column=1, padx=(0, 6), sticky="w")
        e_target.grid(row=1, column=2, padx=(0, 6), sticky="w")
        col = 3
        if show_acct:
            ttk.Label(grid, text="Account").grid(row=0, column=col, sticky="w")
            box = ttk.Combobox(grid, textvariable=account, values=["Unassigned"] + ACCOUNT_TYPES[1:], width=14, state="readonly")
            box.grid(row=1, column=col, padx=(0, 6), sticky="w")
            account.trace_add("write", lambda *_: self._edit(row, "account", "" if account.get() == "Unassigned" else account.get()))
            col += 1
        ttk.Button(grid, text="Price", width=6, command=lambda: self._price(row, force=True)).grid(row=1, column=col, padx=(0, 3))
        ttk.Button(grid, text="My price", width=9, command=lambda: self._manual_dialog(row)).grid(row=1, column=col + 1, padx=(0, 3))
        ttk.Button(grid, text="✕", width=2, command=lambda: self._remove_row(row)).grid(row=1, column=col + 2)
        status = ttk.Label(f, text="", wraplength=600, justify="left")
        status.grid(row=line + 1, column=0, sticky="we", padx=(2, 0))
        ttk.Separator(f, orient="horizontal").grid(row=line + 2, column=0, sticky="we", pady=(4, 0))
        ticker.trace_add("write", lambda *_: self._ticker_edited(row, ticker.get()))
        shares.trace_add("write", lambda *_: self._edit(row, "shares", shares.get()))
        target.trace_add("write", lambda *_: self._edit(row, "target", target.get()))
        e_ticker.bind("<Return>", lambda _: self._commit(row))
        e_ticker.bind("<FocusOut>", lambda _: self._commit(row))
        self.row_widgets[row.id] = {"status": status, "ticker": ticker}
        self._paint_row(row)
        return line + 3

    def _paint_row(self, row: Row) -> None:
        w = self.row_widgets.get(row.id)
        if not w:
            return
        text, tone = self._describe(row)
        w["status"].configure(text=text, foreground=COLORS.get(tone, COLORS[""]))

    def _describe(self, row: Row) -> tuple[str, str]:
        ident = row.identity
        if not row.ticker:
            return "Enter the ticker as your broker shows it.", ""
        if row.status == "draft":
            return "Press Enter or leave the field to look up this ticker.", ""
        if ident and ident["status"] != "resolved":
            return ident.get("reason") or "This ticker is not supported.", "error"
        head = ""
        if ident:
            unit = " (quoted in pence)" if ident.get("quoteUnit") == "minor" else ""
            head = f"{ident.get('name') or ident['localSymbol']} · {ident['venueName']} · {ident.get('currency') or '?'}{unit}\n"
        if row.status == "pricing":
            return head + "Fetching the latest price…", "busy"
        eff = row.effective()
        if eff:
            value = (core.parse_number(row.shares) or 0) * eff["price"]
            if eff["source"]["kind"] == "provider":
                state, missed = freshness_of(eff["source"]["tradingDate"], self.md.now(), ident.get("timeZone") if ident else None)
                note = {"stale": f" · older than the latest session ({missed} missed)", "too_old": " · too old to use", "unknown": " · date unknown"}.get(state, "")
                cached = " (saved copy)" if row.quote.get("cacheStatus") == "cached" else ""
                return head + f"Verified {money(eff['price'], eff['currency'])} · {quote_label(row.quote)}{cached}{note} · value {money(value, eff['currency'])}", "ok" if state == "current" else "warn"
            return head + f"User-supplied {money(eff['price'], eff['currency'])} · {eff['source']['label']} · value {money(value, eff['currency'])}", "warn"
        if row.error:
            covered = row.error.get("kind") in ("not_covered", "not_configured", "budget_withheld")
            return head + ("Not covered: " if covered else "Price unavailable: ") + row.error.get("message", ""), "warn" if covered else "error"
        if not row.active:
            return head + "Not priced: 0 shares and a 0% target (not part of the plan).", ""
        if not self.md.configured():
            return head + "No price source yet: add your own key under API keys…, or use My price.", ""
        r = self.md.route(ident) if ident else None
        if r is not None and not r["candidates"]:
            reasons = "; ".join(f"{PROVIDERS[x['id']]['name']}: {x['reason']}" for x in r["skipped"])
            return head + f"Not covered: {reasons}. Use My price, or add a source that covers it.", "warn"
        return head + "Not priced yet.", ""

    def _ticker_edited(self, row: Row, text: str) -> None:
        if row.edit_ticker(text):
            self._paint_row(row)
            self._after_change()

    def _edit(self, row: Row, field_name: str, value: str) -> None:
        setattr(row, field_name, value)
        self._paint_row(row)
        self._after_change()

    def _commit(self, row: Row) -> None:
        if not row.ticker or (row.identity and row.committed == row.ticker):
            return
        row.apply_identity(self.md.resolve(row.ticker))
        self._paint_row(row)
        self._after_change()
        if row.status == "resolved" and row.active and self.md.configured():
            self._price(row)

    def _price(self, row: Row, force: bool = False) -> None:
        if row.ticker and (not row.identity or row.committed != row.ticker):
            row.apply_identity(self.md.resolve(row.ticker))
        if not row.identity or row.identity["status"] != "resolved":
            self._paint_row(row)
            return
        token = row.token()
        route = self.md.route(row.identity)
        if not route["candidates"]:
            reasons = "; ".join(f"{PROVIDERS[x['id']]['name']}: {x['reason']}" for x in route["skipped"])
            kind = "not_covered" if self.md.configured() else "not_configured"
            row.apply_error(token, {"kind": kind, "message": f"Not covered by your saved sources ({reasons})." if self.md.configured() else "No price source is set up yet."})
            self._paint_row(row)
            self._after_change()
            return
        row.status = "pricing"
        self._paint_row(row)
        identity = row.identity
        currency = identity.get("currency")
        reporting = self.reporting.get()  # Tk variables are read on the main thread only

        def work() -> None:
            try:
                if currency and currency not in self.fx:
                    self._load_fx([currency], reporting)
                quote = self.md.price_instrument(identity, use_cache=not force, cancelled=lambda: self.closing)
                self.events.put(("quote", row, token, quote))
            except DataError as error:
                self.events.put(("error", row, token, {**error.to_contract(), "kind": error.kind, "provider": error.provider}))
            except Exception as error:  # noqa: BLE001 - shown to the user, never silently ignored
                self.events.put(("error", row, token, {"kind": "failed", "message": f"{type(error).__name__}: {error}"}))
        self.pool.submit(work)

    def _price_many(self, rows: list[Row], label: str) -> None:
        targets = sorted([r for r in rows if r.ticker and not r.manual], key=lambda r: -(core.parse_number(r.target) or 0))
        for r in targets:
            if not r.identity or r.committed != r.ticker:
                r.apply_identity(self.md.resolve(r.ticker))
        self.batch = {"label": label, "rows": [r for r in targets if not r.effective()]}
        remaining = {}
        for pid in self.md.configured():
            b = self.md.budget(pid)
            if b["remaining"] is not None:
                remaining[pid] = b["remaining"]
        count = 0
        for r in targets:
            if r.identity["status"] != "resolved" or r.effective():
                continue
            first = (self.md.route(r.identity)["candidates"] or [None])[0]
            if first and first["id"] in remaining:
                cost = PROVIDERS[first["id"]]["requestCost"](r.identity)
                if cost > remaining[first["id"]]:
                    r.apply_error(r.token(), {"kind": "budget_withheld", "message": f"Not requested: by this computer's count your {PROVIDERS[first['id']]['name']} allowance is used up. Use another source, wait for the reset, or use My price."})
                    self._paint_row(r)
                    continue
                remaining[first["id"]] -= cost
            self._price(r)
            count += 1
        self._status(f"{label}: fetching {count} price{'s' if count != 1 else ''}…", "busy")
        self._batch_report()

    def _price_all(self) -> None:
        self._price_many([r for r in self.rows if r.active], "Holdings")

    @staticmethod
    def _short_problem(r: Row) -> str:
        if not r.identity:
            return "ticker not looked up yet"
        if r.identity["status"] != "resolved":
            return r.identity.get("reason") or "ticker not recognised"
        kind = (r.error or {}).get("kind")
        return {"not_covered": "not covered by your saved sources", "not_configured": "no price source set up",
                "budget_withheld": "not requested: allowance used up", "rate_limited": "provider limit reached"}.get(
            kind, "price unavailable" if r.error else "no price yet")

    def _batch_report(self) -> None:
        """Once every holding of the last Get prices has an answer, name the ones still without a usable price."""
        batch = self.batch
        if not batch or any(r.status == "pricing" for r in batch["rows"] if r in self.rows):
            return
        self.batch = None
        rows = [r for r in self.rows if r in batch["rows"]]  # in the order of the holdings list
        missing = [r for r in rows if not r.effective()]
        if not rows:
            return
        if missing:
            names = ", ".join(f"{r.ticker} ({self._short_problem(r)})" for r in missing)
            self._status(f"{batch['label']}: {len(rows) - len(missing)} of {len(rows)} priced. Without a usable price: {names}. "
                         "The plan stays withheld until each has a verified price or one you supply.", "warn")
        else:
            self._status(f"{batch['label']}: all {len(rows)} priced.", "ok")

    def _poll(self) -> None:
        try:
            while True:
                kind, *payload = self.events.get_nowait()
                if kind == "quote":
                    row, token, quote = payload
                    if row in self.rows and row.apply_quote(token, quote):
                        self._paint_row(row)
                elif kind == "error":
                    row, token, error = payload
                    if row in self.rows and row.apply_error(token, error):
                        self._paint_row(row)
                elif kind == "fx":
                    self._paint_all()
                elif kind == "status":
                    self._status(*payload)
                self._after_change()
                self._batch_report()
        except queue.Empty:
            pass
        if not self.closing:
            self.root.after(80, self._poll)

    def _paint_all(self) -> None:
        for r in self.rows:
            self._paint_row(r)

    def _after_change(self) -> None:
        main = [r for r in self.rows if r.ticker]
        priced = sum(1 for r in main if r.effective())
        active = sum(1 for r in main if r.active)
        rep = self.reporting.get()
        total, complete = 0.0, True
        for r in main:
            eff = r.effective()
            if not r.active:
                continue
            if not eff or eff["currency"] not in self.fx or rep not in self.fx:
                complete = False
                continue
            total += (core.parse_number(r.shares) or 0) * eff["price"] * self.fx[eff["currency"]]["cadPer"] / self.fx[rep]["cadPer"]
        parts = [f"{len(main)} holdings", f"{priced} priced"]
        if active - priced > 0:
            parts.append(f"{active - priced} without a usable price")
        if main:
            parts.append(f"value {money(total, rep)}{'' if complete else ' (incomplete)'}")
            bp = target_total_basis_points([{"targetWeight": core.parse_number(r.target) or 0} for r in main if r.active])
            parts.append(f"targets {bp / 100:.2f}%{' (the plan scales them to 100%)' if bp not in (0, 10000) else ''}")
        self.summary.configure(text=" · ".join(parts) if main else "")
        pending = [r.identity for r in self.rows if r.active and r.identity and r.identity["status"] == "resolved" and not r.effective()]
        if not self.md.configured():
            self.estimate.configure(text="To get prices automatically, add your own key for at least one source under API keys…. You can also use My price on each holding.")
        elif pending:
            est = self.md.estimate(pending)
            parts = [f"about {e['requests']} {PROVIDERS[p]['name']} request{'s' if e['requests'] != 1 else ''} for {e['rows']} holding{'s' if e['rows'] != 1 else ''}"
                     f" (this computer sent {e['sentToday']} today{', ' + str(e['sentMonth']) + ' this month' if e['period'] == 'month' else ''})" for p, e in est["perProvider"].items()]
            unc = ", ".join(u["displayTicker"] for u in est["uncovered"])
            abroad = ", ".join(f"{i['displayTicker']} ({i['venueName']}, {i['currency']})" for i in pending if i.get("currency") not in ("CAD", "USD"))
            self.estimate.configure(text=f"Get prices: {'; '.join(parts) or 'no requests'}."
                                         f"{' Listings outside Canada and the US: ' + abroad + '; they count against the same allowances.' if abroad else ''}"
                                         f"{' Not covered by your saved sources: ' + unc + '.' if unc else ''}")
        else:
            self.estimate.configure(text="")
        mode_new = self.mode.get().startswith("New")
        self.budget_entry.configure(state="normal" if mode_new else "disabled")
        if self.plan_requested:
            self._calculate(quiet=True)

    def _add_row(self) -> None:
        if len(self.rows) >= 50:
            self._status("At most 50 holdings.", "warn")
            return
        self.rows.append(Row())
        self._render_rows()

    def _remove_row(self, row: Row) -> None:
        self.rows = [r for r in self.rows if r is not row] or [Row()]
        self._render_rows()

    def _remove_international(self) -> None:
        """Removes the four sample international examples only while they are exactly as loaded."""
        removed = [r for r in self.rows if is_unchanged_international_example(r)]
        if not removed:
            self._status("No unchanged international examples to remove (edited rows and holdings you added are kept).")
            return
        self.rows = [r for r in self.rows if not is_unchanged_international_example(r)] or [Row()]
        self._render_rows()
        self._status(f"Removed {', '.join(r.ticker for r in removed)}. The remaining targets are scaled to 100% in the plan.")

    def _clear(self) -> None:
        self.rows = [Row()]
        self.plan_requested = False
        self._render_rows()
        self._clear_plan("Cleared.")

    def _load_sample(self) -> None:
        self.reporting.set(SAMPLE_PORTFOLIO["reportingCurrency"])
        self.mode.set("New Money (buy only)")
        self.budget.set(str(SAMPLE_PORTFOLIO["budget"]))
        self.plan_requested = False
        self.rows = rows_from_sample(SAMPLE_PORTFOLIO)
        for r in self.rows:
            r.apply_identity(self.md.resolve(r.ticker))
        self._render_rows()
        total = target_total_basis_points(SAMPLE_PORTFOLIO["rows"]) / 100
        self._clear_plan(f"Sample portfolio loaded: {len(self.rows)} holdings (targets total {total:.1f}%), with no prices. Press Get prices; nothing is fetched until you do.")

    def _on_source(self) -> None:
        self.md.set_routing(mode=self._source_id())
        self._sources_changed("Price source changed.")

    def _sources_changed(self, message: str) -> None:
        for r in self.rows:
            r.reset_quote()
        self._paint_all()
        self._after_change()
        self._status(f"{message} Fetched prices were cleared; press Get prices to fetch them again.")

    # ------------------------------------------------------------------ exchange rates
    def _load_fx(self, codes: list[str], reporting: str) -> None:
        """Runs on a worker thread: must not touch Tk widgets or variables."""
        wanted = sorted({c for c in codes + [reporting] if c and c != "CAD" and c not in self.fx})
        if not wanted:
            return
        try:
            fx = self.md.latest_fx(wanted)
            for code in wanted:
                point = fx["cadPer"].get(code)
                if point and self.fx.get(code, {}).get("kind") != "manual":
                    self.fx[code] = {"cadPer": point["cadPer"], "kind": "official", "label": f"{fx['provider']}, {point['date']}", "date": point["date"]}
            self.fx_note = fx["attribution"]
        except DataError as error:
            self.fx_note = f"Official exchange rates are unavailable right now ({error.message})."
        self.events.put(("fx",))

    def _fx_dialog(self) -> None:
        top = tk.Toplevel(self.root)
        top.title("Exchange rates")
        rep = self.reporting.get()
        codes = sorted({(r.effective() or {}).get("currency") or (r.identity or {}).get("currency") for r in self.rows} - {None, rep})
        ttk.Label(top, text=f"{rep} per 1 unit. Official daily averages (Bank of Canada; ECB fallback). Type a rate to use your own.", wraplength=460).pack(padx=10, pady=8, anchor="w")
        entries = {}
        for code in codes:
            frame = ttk.Frame(top)
            frame.pack(fill="x", padx=10, pady=2)
            ttk.Label(frame, text=code, width=6).pack(side="left")
            var = tk.StringVar(value=f"{self.fx[code]['cadPer'] / self.fx[rep]['cadPer']:.6g}" if code in self.fx and rep in self.fx else "")
            ttk.Entry(frame, textvariable=var, width=14).pack(side="left", padx=6)
            ttk.Label(frame, text=self.fx.get(code, {}).get("label", "not loaded")).pack(side="left")
            entries[code] = var
        ttk.Label(top, text=self.fx_note, wraplength=460, foreground=COLORS[""]).pack(padx=10, pady=6, anchor="w")

        def apply() -> None:
            for code, var in entries.items():
                value = core.parse_number(var.get())
                current = self.fx[code]["cadPer"] / self.fx[rep]["cadPer"] if code in self.fx and rep in self.fx else None
                if value and value > 0 and rep in self.fx and (current is None or abs(value - current) > 1e-12 * max(1, value)):
                    self.fx[code] = {"cadPer": value * self.fx[rep]["cadPer"], "kind": "manual", "label": "Entered by you"}
            top.destroy()
            self._paint_all()
            self._after_change()
        buttons = ttk.Frame(top)
        buttons.pack(fill="x", padx=10, pady=8)
        ttk.Button(buttons, text="Use these rates", command=apply).pack(side="left")
        ttk.Button(buttons, text="Reload official rates", command=lambda: (self.fx.clear(), self.fx.update({"CAD": {"cadPer": 1.0, "kind": "official", "label": "base"}}),
                                                                          self.pool.submit(self._load_fx, STARTUP_FX + codes, rep), top.destroy())).pack(side="left", padx=6)

    # ------------------------------------------------------------------ manual price and keys
    def _manual_dialog(self, row: Row) -> None:
        if not row.ticker:
            return
        top = tk.Toplevel(self.root)
        top.title(f"My price for {row.ticker}")
        ttk.Label(top, text="Your own price is used instead of a fetched one and is labelled as user-supplied in the plan and exports.", wraplength=380).pack(padx=10, pady=8)
        price = tk.StringVar(value=str(row.manual["enteredPrice"]) if row.manual else "")
        cur = tk.StringVar(value=(row.manual or {}).get("currency") or (row.identity or {}).get("currency") or self.reporting.get())
        unit = tk.StringVar(value="pence / cents (÷100)" if (row.identity or {}).get("quoteUnit") == "minor" else "units of the currency")
        frame = ttk.Frame(top)
        frame.pack(padx=10, pady=4)
        ttk.Entry(frame, textvariable=price, width=12).grid(row=0, column=0, padx=4)
        ttk.Combobox(frame, textvariable=cur, values=sorted(set(REPORTING + [cur.get()])), width=6, state="readonly").grid(row=0, column=1, padx=4)
        ttk.Combobox(frame, textvariable=unit, values=["units of the currency", "pence / cents (÷100)"], width=20, state="readonly").grid(row=0, column=2, padx=4)
        error = ttk.Label(top, text="", foreground=COLORS["error"])
        error.pack()

        def apply() -> None:
            try:
                row.set_manual(price.get(), cur.get(), 0.01 if unit.get().startswith("pence") else 1.0)
            except ValueError as e:
                error.configure(text=str(e))
                return
            top.destroy()
            # A price in a currency not loaded yet needs its official rate before it can be valued.
            self.pool.submit(self._load_fx, [row.manual["currency"]], self.reporting.get())
            self._paint_row(row)
            self._after_change()

        def remove() -> None:
            row.manual = None
            top.destroy()
            self._paint_row(row)
            self._after_change()
        buttons = ttk.Frame(top)
        buttons.pack(pady=8)
        ttk.Button(buttons, text="Use this price", command=apply).pack(side="left", padx=4)
        if row.manual:
            ttk.Button(buttons, text="Remove my price", command=remove).pack(side="left", padx=4)

    def _keys_dialog(self) -> None:
        top = tk.Toplevel(self.root)
        top.title("API keys")
        ttk.Label(top, wraplength=560, justify="left", text=(
            "Each key is yours: it stays on this computer and is sent only to its own provider. A key is kept until you close the "
            "program unless you tick Remember (then it is saved in files/runtime/keys.json in this folder, never in exports). "
            "Free plans are for personal, non-commercial use.")).pack(padx=10, pady=8, anchor="w")
        for pid in DESKTOP_PROVIDERS:
            self._key_frame(top, pid)
        off = [p for p in PROVIDERS if p not in DESKTOP_PROVIDERS]
        for pid in off:
            ttk.Label(top, text=f"{PROVIDERS[pid]['name']} (not offered): {PROVIDERS[pid].get('unsupportedReason', '')}", wraplength=560,
                      foreground=COLORS[""]).pack(padx=10, pady=(4, 0), anchor="w")
        ttk.Button(top, text="Forget all keys", command=lambda: (self.md.forget_all_keys(), top.destroy(), self._sources_changed("All keys were removed."))).pack(pady=8)

    def _key_frame(self, top, pid: str) -> None:
        p = PROVIDERS[pid]
        st = self.md.status(pid)
        box = ttk.LabelFrame(top, text=f"{p['name']} — {'key saved' if st['configured'] else 'no key saved'}", padding=6)
        box.pack(fill="x", padx=10, pady=4)
        ttk.Label(box, text=f"{p['priceLabel'][0].upper()}{p['priceLabel'][1:]}. {p['licence']}", wraplength=540).grid(row=0, column=0, columnspan=6, sticky="w")
        key, secret, remember = tk.StringVar(), tk.StringVar(), tk.BooleanVar(value=st["persistence"] == "local")
        ttk.Label(box, text="Key ID" if pid == "alpaca" else "API key").grid(row=1, column=0, sticky="w")
        ttk.Entry(box, textvariable=key, show="•", width=30).grid(row=1, column=1, sticky="w", padx=4)
        if pid == "alpaca":
            ttk.Label(box, text="Secret").grid(row=1, column=2, sticky="w")
            ttk.Entry(box, textvariable=secret, show="•", width=30).grid(row=1, column=3, sticky="w", padx=4)
        ttk.Checkbutton(box, text="Remember on this computer", variable=remember).grid(row=2, column=0, columnspan=2, sticky="w")
        message = ttk.Label(box, text="", wraplength=540)
        message.grid(row=5, column=0, columnspan=6, sticky="w")

        def save() -> None:
            try:
                self.md.set_key(pid, key.get(), secret.get() or None, remember.get())
                key.set("")
                secret.set("")
                message.configure(text=f"{p['name']} key saved{' on this computer' if remember.get() else ' for this session'}.")
                self._sources_changed(f"{p['name']} key saved.")
            except ValueError as e:
                message.configure(text=str(e))
        ttk.Button(box, text="Save key", command=save).grid(row=2, column=2, padx=4)
        ttk.Button(box, text="Remove key", command=lambda: (self.md.set_key(pid, ""), message.configure(text="Key removed."), self._sources_changed(f"{p['name']} key removed."))).grid(row=2, column=3, padx=4)
        plan = tk.StringVar(value=st["plan"]["label"])
        labels = {pl["label"]: pl["id"] for pl in p["plans"]}
        ttk.Label(box, text="Your plan").grid(row=3, column=0, sticky="w")
        combo = ttk.Combobox(box, textvariable=plan, values=list(labels), width=46, state="readonly")
        combo.grid(row=3, column=1, columnspan=3, sticky="w", padx=4)
        limit = tk.StringVar(value=str(st["plan"]["limits"].get(st["plan"].get("editable") or "", "")))
        ttk.Entry(box, textvariable=limit, width=8).grid(row=3, column=4, sticky="w")
        combo.bind("<<ComboboxSelected>>", lambda _: (self.md.set_plan(pid, labels[plan.get()], core.parse_number(limit.get())), self._after_change()))
        usage = f"Requests sent from this computer: {st.get('sentToday', 0)} today (UTC), {st.get('sentMonth', 0)} this month. Your provider counts every use of the key."
        rec = st.get("limitRecord")
        if rec:
            usage += f"\n{p['name']} reported its {rec['scope']} limit; no more requests are sent until the {'month' if rec['scope'] == 'monthly' else 'day'} ends (UTC)."
            if rec.get("notice"):
                usage += f"\nProvider said: “{rec['notice']}”"
        ttk.Label(box, text=usage, wraplength=540, foreground=COLORS["warn" if rec else ""]).grid(row=4, column=0, columnspan=5, sticky="w")
        if st["configured"]:
            ttk.Button(box, text="Check again (1 request)", command=lambda: self.pool.submit(lambda: self.events.put(("status", self.md.check_again(pid)["message"], "")))).grid(row=4, column=5)

    # ------------------------------------------------------------------ plan
    def _settings(self) -> Settings:
        return Settings(reporting=self.reporting.get(), mode="new_money" if self.mode.get().startswith("New") else "rebalance",
                        budget=self.budget.get(), whole_shares=self.rounding.get() == "Whole shares", show_accounts=self.show_accounts.get(),
                        accept_stale=getattr(self, "accept_stale", False))

    def _clear_plan(self, message: str = "") -> None:
        self.run = None
        self.tree.delete(*self.tree.get_children())
        self.headline.configure(text="")
        self._set_details("")
        self.csv_button.configure(state="disabled")
        self.xlsx_button.configure(state="disabled")
        if message:
            self._status(message)

    def _calculate(self, quiet: bool = False) -> None:
        self.plan_requested = True
        run = build_plan(self.rows, self._settings(), self.fx, now=self.md.now())  # the clock the quotes were dated with
        self._clear_plan()
        v = run["valuation"]
        if not run["plan"]:
            reasons: dict[str, list[str]] = {}
            for u in v["unpriced"]:
                reasons.setdefault(u["reason"], []).append(u["ticker"])
            lines = [f"{', '.join(t)}: {why}" for why, t in reasons.items()]
            if v["stale"] and not v["unpriced"]:
                lines.append("Older prices: " + ", ".join(f"{s['ticker']} ({s.get('tradingDate')})" for s in v["stale"]))
                if not quiet and messagebox.askyesno("Older prices", "Some prices are older than the latest trading session. Use them for this plan (they are labelled)?"):
                    self.accept_stale = True
                    self._calculate()
                    return
            self.headline.configure(text="Plan withheld", foreground=COLORS["error"])
            self._set_details("\n".join(lines) + "\n\nNothing is estimated or filled in for you. Get prices, choose another source, or use My price on those holdings.")
            self._status(f"Plan withheld: {run['error'] or v['blockedReason']}", "error")
            return
        self.run = run
        s = run["plan"]["summary"]
        whole = run["whole"]
        rep = run["settings"].reporting
        manual = len(v["manualOverrides"])
        buys = whole["totalBuys"] if whole else s["totalBuys"]
        sells = whole["totalSells"] if whole else s["totalSells"]
        cash = whole["cashLeft"] if whole else s["cashLeft"]
        self.headline.configure(foreground=COLORS["warn" if manual else "ok"], text=(
            f"{'Plan includes ' + str(manual) + ' user-supplied price(s)' if manual else 'Plan ready'} · {'New Money' if s['mode'] == 'new_money' else 'Rebalance'} · "
            f"value {money(s['totalCurrent'], rep)} · buys {money(buys, rep)} · sells {money(sells, rep)} · cash left {money(cash, rep)} · "
            f"{'whole' if whole else 'fractional'} shares"))
        for i, line in enumerate(action_lines(run)):
            r = line["result"]
            self.tree.insert("", "end", iid=str(i), values=(line["action"].upper(), r["ticker"], "—" if line["action"] == "Hold" else qty(abs(line["shares"])),
                                                           "—" if line["action"] == "Hold" else money(abs(line["value"]), rep),
                                                           f"{line['before'] * 100:.1f}% → {line['after'] * 100:.1f}% ({r['targetWeightNorm'] * 100:.1f}%)"))
        self._lines = action_lines(run)
        notes = run["notes"]
        text = []
        if run["notValued"]:
            text.append("Not in the plan (0 shares, 0% target): " + ", ".join(r.ticker for r in run["notValued"]))
        if notes["attention"]:
            text.append("Needs your attention:\n• " + "\n• ".join(notes["attention"]))
        if notes["info"]:
            text.append("Information:\n• " + "\n• ".join(notes["info"]))
        self._notes_text = "\n\n".join(text)
        self._set_details(self._notes_text)
        counts = {a: sum(1 for x in self._lines if x["action"] == a) for a in ("Buy", "Sell", "Hold")}
        self._status(f"Plan ready: {counts['Buy']} buys, {counts['Sell']} sells, {counts['Hold']} holds{'; includes ' + str(manual) + ' user-supplied price(s)' if manual else ''}.", "warn" if manual else "ok")
        self.csv_button.configure(state="normal")
        self.xlsx_button.configure(state="normal")

    def _show_details(self) -> None:
        sel = self.tree.selection()
        if not sel or not self.run:
            return
        line = self._lines[int(sel[0])]
        r, row = line["result"], line["row"]
        rep = self.run["settings"].reporting
        eff = row.effective()
        parts = [f"{r['ticker']} — {(row.identity or {}).get('name') or ''} ({(row.identity or {}).get('venueName', '')}, {r['currencyKey']})",
                 f"Price: {money(r['price'], r['currencyKey'])} · {eff['source']['label']}"]
        if row.quote and not row.manual:
            q = row.quote
            parts.append(f"Provider symbol {q['providerSymbol']} · retrieved {q['retrievedAt']} · currency evidence: {q['currencyEvidence']}")
        if r["currencyKey"] != rep:
            parts.append(f"Exchange rate: 1 {r['currencyKey']} = {r['fxToReporting']:.6g} {rep} · {self.run['fx'][r['currencyKey']].get('label', '')}")
        parts += [f"Shares held: {qty(r['shares'])} · current value {money(r['currentValue'], rep)} · target value {money(r['targetValue'], rep)}",
                  f"Trade: {line['action']} {qty(abs(line['shares']))} shares · {money(line['value'], rep)} ({money(line['local'], r['currencyKey'])}) · shares after {qty(line['post'])}"]
        if self.run["settings"].show_accounts:
            parts.append(f"Account: {r.get('accountType') or 'Unassigned'}")
        self._set_details("\n".join(parts) + "\n\n" + getattr(self, "_notes_text", ""))

    def _set_details(self, text: str) -> None:
        self.details.configure(state="normal")
        self.details.delete("1.0", "end")
        self.details.insert("1.0", text)
        self.details.configure(state="disabled")

    def _export(self, kind: str) -> None:
        if not self.run:
            return
        path = filedialog.asksaveasfilename(defaultextension=f".{kind}", filetypes=[("CSV", "*.csv")] if kind == "csv" else [("Excel workbook", "*.xlsx")],
                                            initialfile=f"rebalance-plan.{kind}")
        if not path:
            return
        try:
            (write_csv_export if kind == "csv" else write_excel_export)(Path(path), self.run)
            self._status(f"Saved {Path(path).name}.", "ok")
        except Exception as error:  # noqa: BLE001 - shown to the user
            self._status(f"Could not save: {error}", "error")

    # ------------------------------------------------------------------ holdings CSV
    def _import_holdings(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("CSV", "*.csv")])
        if not path:
            return
        try:
            rows = list(csv.DictReader(io.StringIO(Path(path).read_text(encoding="utf-8-sig"))))
            pick = lambda rec, names: next((rec[k] for k in rec if k and k.strip().lower() in names), "")  # noqa: E731
            data = [Row(pick(r, {"ticker", "symbol"}), pick(r, {"shares", "quantity", "units"}), pick(r, {"target_pct", "target", "weight"}),
                        pick(r, {"account", "account_type"}) if pick(r, {"account", "account_type"}) in ACCOUNT_TYPES else "") for r in rows if pick(r, {"ticker", "symbol"})][:50]
            if not data:
                raise ValueError("No holdings found (columns: ticker, shares, target_pct, account).")
            self.rows = data
            for r in self.rows:
                r.apply_identity(self.md.resolve(r.ticker))
            self._render_rows()
            self._status(f"Imported {len(data)} holdings. No prices were imported; press Get prices.", "ok")
        except Exception as error:  # noqa: BLE001
            self._status(f"Import failed: {error}", "error")

    def _export_holdings(self) -> None:
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile="holdings.csv", filetypes=[("CSV", "*.csv")])
        if not path:
            return
        with Path(path).open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "shares", "target_pct", "account"])
            for r in self.rows:
                if r.ticker:
                    w.writerow([r.ticker, r.shares, r.target, r.account])
        self._status(f"Saved {Path(path).name}.", "ok")

    def _close(self) -> None:
        self.closing = True
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()


def main() -> None:
    if not TK_AVAILABLE:
        print("tkinter is not available in this Python. Run the setup launcher again.", file=sys.stderr)
        sys.exit(1)
    enable_dpi_awareness()
    root = tk.Tk()
    RebalancerApp(root)
    root.mainloop()
