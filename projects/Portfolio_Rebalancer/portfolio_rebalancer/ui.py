"""Tkinter GUI for the Portfolio Rebalancer."""
from __future__ import annotations

import datetime as dt
import queue
import threading
from pathlib import Path

TK_AVAILABLE = True
try:
    import tkinter as tk
    from tkinter import filedialog, ttk
except ImportError:
    TK_AVAILABLE = False
    tk = None  # type: ignore[assignment]
    filedialog = None  # type: ignore[assignment]
    ttk = None  # type: ignore[assignment]

from portfolio_rebalancer.core import calculate_rebalance_plan
from portfolio_rebalancer.export import write_csv_export, write_excel_export
from portfolio_rebalancer.fx import (
    ACCOUNT_TYPES,
    CURRENCY_CODE_TO_KEY,
    CURRENCY_OPTIONS,
    fallback_fx_to_usd,
    format_currency,
    format_fx,
    format_input_price,
    format_pct,
    format_shares,
    get_fx_to_reporting,
    get_fx_to_usd,
    get_meta,
)
from portfolio_rebalancer.pricing import (
    fetch_live_fx_to_usd,
    fetch_live_quote_details,
    find_cross_market_quote,
)
from portfolio_rebalancer.ticker_helper import (
    build_ticker_candidates,
    build_ticker_input_hint,
)

STATUS_NEUTRAL = "#1f4f8a"
STATUS_ERROR = "#9b2f2f"
STATUS_SUCCESS = "#1c7550"
STATUS_WARN = "#8f5f12"

SAMPLE_PORTFOLIO = [
    {"ticker": "VTI", "shares": 120, "price": 250, "targetWeight": 10, "currencyKey": "USD"},
    {"ticker": "XIC.TO", "shares": 320, "price": 36, "targetWeight": 10, "currencyKey": "CAD"},
    {"ticker": "VEQT.TO", "shares": 410, "price": 42, "targetWeight": 20, "currencyKey": "CAD"},
    {"ticker": "EWJ", "shares": 220, "price": 64, "targetWeight": 10, "currencyKey": "USD"},
    {"ticker": "VGK", "shares": 115, "price": 64, "targetWeight": 10, "currencyKey": "USD"},
    {"ticker": "ISF.L", "shares": 260, "price": 7.4, "targetWeight": 10, "currencyKey": "GBP"},
    {"ticker": "AAPL", "shares": 45, "price": 180, "targetWeight": 10, "currencyKey": "USD"},
    {"ticker": "BND", "shares": 200, "price": 72, "targetWeight": 10, "currencyKey": "USD"},
    {"ticker": "MCHI", "shares": 140, "price": 40, "targetWeight": 10, "currencyKey": "USD"},
]


def clamp_row_count(value: int) -> int:
    return max(1, min(50, int(value)))


class PortfolioRebalancerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Portfolio Rebalancer Desktop Tool")
        self.root.geometry("1400x960")
        self.root.minsize(1200, 760)

        self.rows: list[dict] = []
        self.has_calculated = False
        self.is_running = False
        self.worker_thread: threading.Thread | None = None
        self.worker_events: queue.Queue[tuple[str, object]] = queue.Queue()

        self.row_count_var = tk.StringVar(value=str(len(SAMPLE_PORTFOLIO)))
        self.reporting_currency_var = tk.StringVar(value="USD")
        self.mode_var = tk.StringVar(value="new_money")
        self.budget_var = tk.StringVar(value="0")
        self.validation_var = tk.StringVar(value="")
        self.live_current_total_var = tk.StringVar(value="Current total: $0.00")
        self.live_weight_total_var = tk.StringVar(value="Target weight total: 0.00%")
        self.budget_label_var = tk.StringVar(value="New money budget (USD)")
        self.fetch_live_var = tk.BooleanVar(value=False)
        self.show_account_type_var = tk.BooleanVar(value=False)
        self.export_csv_var = tk.BooleanVar(value=False)
        self.export_excel_var = tk.BooleanVar(value=False)
        self.csv_path_var = tk.StringVar(value="")
        self.excel_path_var = tk.StringVar(value="")
        self.status_var = tk.StringVar(value="Ready.")

        self.live_fx_to_usd: dict[str, float] = {}
        self.live_fx_keys: set[str] = set()
        self._ticker_validate_after_ids: dict[int, str] = {}
        self._ticker_validation_tokens: dict[int, int] = {}
        self._ticker_validation_feedback: dict[int, dict[str, str]] = {}

        self._build_ui()
        self.set_rows(len(SAMPLE_PORTFOLIO), SAMPLE_PORTFOLIO)

    def _build_ui(self) -> None:
        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True, padx=10, pady=8)

        ttk.Label(main, text="Portfolio Rebalancer Project", font=("TkDefaultFont", 16, "bold")).pack(anchor="w")
        ttk.Label(main, text="Desktop rebalancer with two modes (New Money / Rebalance), optional live fetch, and CSV/Excel export.", foreground="#3f5066").pack(anchor="w", pady=(0, 8))

        controls = ttk.Frame(main)
        controls.pack(fill="x", pady=(0, 6))

        ttk.Label(controls, text="Securities").grid(row=0, column=0, sticky="w")
        self.row_count_spin = tk.Spinbox(controls, from_=1, to=50, width=6, textvariable=self.row_count_var, justify="right")
        self.row_count_spin.grid(row=1, column=0, sticky="w", padx=(0, 10))

        ttk.Label(controls, text="Reporting currency").grid(row=0, column=1, sticky="w")
        self.reporting_combo = ttk.Combobox(controls, width=10, values=list(CURRENCY_OPTIONS.keys()), textvariable=self.reporting_currency_var, state="readonly")
        self.reporting_combo.grid(row=1, column=1, sticky="w", padx=(0, 10))
        self.reporting_combo.bind("<<ComboboxSelected>>", lambda _: self._on_reporting_change())

        ttk.Label(controls, text="Mode").grid(row=0, column=2, sticky="w")
        self.mode_combo = ttk.Combobox(controls, width=16, values=["new_money", "rebalance"], textvariable=self.mode_var, state="readonly")
        self.mode_combo.grid(row=1, column=2, sticky="w", padx=(0, 10))
        self.mode_combo.bind("<<ComboboxSelected>>", lambda _: self._on_mode_change())

        ttk.Button(controls, text="Apply Rows", command=self._on_apply_rows).grid(row=1, column=3, padx=(0, 6))
        ttk.Button(controls, text="Add Row", command=self._on_add_row).grid(row=1, column=4, padx=(0, 6))
        ttk.Button(controls, text="Remove Last", command=self._on_remove_row).grid(row=1, column=5)

        table_section = ttk.LabelFrame(main, text="Portfolio Inputs")
        table_section.pack(fill="both", expand=False, pady=(6, 6))

        header = ttk.Frame(table_section)
        header.pack(fill="x", padx=6, pady=(6, 2))
        header_labels = [("#", 4), ("Ticker", 14), ("Shares", 12), ("Price", 12), ("Currency", 10),
                         ("FX", 10), ("Current Value", 16), ("Target %", 10), ("Account Type", 14)]
        self.header_labels_widgets: list[ttk.Label] = []
        for col, (label, width) in enumerate(header_labels):
            w = ttk.Label(header, text=label, width=width, anchor="w")
            w.grid(row=0, column=col, padx=2, sticky="w")
            self.header_labels_widgets.append(w)
        self.header_labels_widgets[-1].grid_remove()

        canvas_holder = ttk.Frame(table_section)
        canvas_holder.pack(fill="both", expand=True, padx=6, pady=(0, 4))
        self.table_canvas = tk.Canvas(canvas_holder, height=280, highlightthickness=0)
        self.table_canvas.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(canvas_holder, orient="vertical", command=self.table_canvas.yview)
        scrollbar.pack(side="right", fill="y")
        self.table_canvas.configure(yscrollcommand=scrollbar.set)
        self.rows_frame = ttk.Frame(self.table_canvas)
        self.rows_window_id = self.table_canvas.create_window((0, 0), window=self.rows_frame, anchor="nw")
        self.rows_frame.bind("<Configure>", lambda _: self.table_canvas.configure(scrollregion=self.table_canvas.bbox("all")))
        self.table_canvas.bind("<Configure>", lambda e: self.table_canvas.itemconfigure(self.rows_window_id, width=e.width))

        totals = ttk.Frame(table_section)
        totals.pack(fill="x", padx=6, pady=(2, 8))
        ttk.Label(totals, textvariable=self.live_current_total_var).pack(side="left")
        ttk.Label(totals, textvariable=self.live_weight_total_var).pack(side="right")

        self.budget_frame = ttk.Frame(main)
        self.budget_frame.pack(fill="x", pady=(0, 4))
        ttk.Label(self.budget_frame, textvariable=self.budget_label_var).pack(anchor="w")
        self.budget_entry = ttk.Entry(self.budget_frame, textvariable=self.budget_var, width=24)
        self.budget_entry.pack(anchor="w", pady=(2, 0))
        self.budget_entry.bind("<KeyRelease>", lambda _: self._handle_input_change())
        ttk.Label(self.budget_frame, text="Amount of new cash to invest. Buys will not exceed this budget.", foreground="#5c6a7c").pack(anchor="w")

        btn_row = ttk.Frame(main)
        btn_row.pack(fill="x", pady=(6, 4))
        self.run_button = ttk.Button(btn_row, text="Run Rebalance", command=self._on_run)
        self.run_button.pack(side="left", padx=(0, 6))
        ttk.Button(btn_row, text="Load Sample", command=self._load_sample).pack(side="left")

        options = ttk.LabelFrame(main, text="Run Options")
        options.pack(fill="x", pady=(4, 6))
        options.columnconfigure(1, weight=1)
        self.fetch_live_check = ttk.Checkbutton(options, text="Fetch live prices and FX rates (requires internet)", variable=self.fetch_live_var)
        self.fetch_live_check.grid(row=0, column=0, columnspan=3, sticky="w", padx=6, pady=(6, 3))
        self.acct_type_check = ttk.Checkbutton(options, text="Show Account Type column (cross-account funding checks)", variable=self.show_account_type_var, command=self._toggle_account_type)
        self.acct_type_check.grid(row=1, column=0, columnspan=3, sticky="w", padx=6, pady=(0, 3))
        self.csv_check = ttk.Checkbutton(options, text="Export CSV", variable=self.export_csv_var, command=self._toggle_exports)
        self.csv_check.grid(row=2, column=0, sticky="w", padx=6, pady=2)
        self.csv_entry = ttk.Entry(options, textvariable=self.csv_path_var, state="disabled")
        self.csv_entry.grid(row=2, column=1, sticky="ew", padx=4, pady=2)
        self.csv_button = ttk.Button(options, text="Browse...", command=self._browse_csv, state="disabled")
        self.csv_button.grid(row=2, column=2, padx=6, pady=2)
        self.excel_check = ttk.Checkbutton(options, text="Export Excel", variable=self.export_excel_var, command=self._toggle_exports)
        self.excel_check.grid(row=3, column=0, sticky="w", padx=6, pady=(2, 6))
        self.excel_entry = ttk.Entry(options, textvariable=self.excel_path_var, state="disabled")
        self.excel_entry.grid(row=3, column=1, sticky="ew", padx=4, pady=(2, 6))
        self.excel_button = ttk.Button(options, text="Browse...", command=self._browse_excel, state="disabled")
        self.excel_button.grid(row=3, column=2, padx=6, pady=(2, 6))

        self.progress = ttk.Progressbar(main, mode="indeterminate")
        self.progress.pack(fill="x", pady=(0, 6))
        self.status_label = tk.Label(main, textvariable=self.status_var, anchor="w", fg=STATUS_NEUTRAL, bg=self.root.cget("bg"))
        self.status_label.pack(fill="x", pady=(0, 2))
        ttk.Label(main, textvariable=self.validation_var, foreground="#B12828").pack(anchor="w", pady=(0, 4))

        output = ttk.LabelFrame(main, text="Rebalance Output")
        output.pack(fill="both", expand=True)
        self.output_text = tk.Text(output, wrap="none", height=14, font=("Courier New", 10))
        self.output_text.pack(fill="both", expand=True, padx=6, pady=6)
        self.output_text.insert("1.0", "Output will appear here after you run rebalancing.")
        self.output_text.configure(state="disabled")

    # ── helpers ──

    def _set_status(self, msg: str, color: str = STATUS_NEUTRAL) -> None:
        self.status_var.set(msg)
        self.status_label.config(fg=color)

    def _set_running(self, running: bool) -> None:
        self.is_running = running
        st = "disabled" if running else "normal"
        for w in (self.run_button, self.row_count_spin, self.reporting_combo, self.mode_combo,
                  self.fetch_live_check, self.acct_type_check, self.csv_check, self.excel_check):
            w.config(state=st)
        if running:
            self.progress.start(12)
        else:
            self.progress.stop()
            self._toggle_exports()

    def _render_output(self, text: str) -> None:
        self.output_text.configure(state="normal")
        self.output_text.delete("1.0", "end")
        self.output_text.insert("1.0", text)
        self.output_text.configure(state="disabled")

    def _get_fx_to_reporting(self, currency_key: str) -> float:
        return get_fx_to_reporting(currency_key, self.reporting_currency_var.get(), self.live_fx_to_usd or None)

    @staticmethod
    def _parse_float(raw: str) -> float | None:
        raw = str(raw).strip()
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    def _toggle_exports(self) -> None:
        csv_on = bool(self.export_csv_var.get()) and not self.is_running
        excel_on = bool(self.export_excel_var.get()) and not self.is_running
        self.csv_entry.config(state="normal" if csv_on else "disabled")
        self.csv_button.config(state="normal" if csv_on else "disabled")
        self.excel_entry.config(state="normal" if excel_on else "disabled")
        self.excel_button.config(state="normal" if excel_on else "disabled")

    def _browse_csv(self) -> None:
        p = filedialog.asksaveasfilename(title="Select CSV output", defaultextension=".csv", filetypes=[("CSV file", "*.csv")])
        if p:
            self.csv_path_var.set(p)

    def _browse_excel(self) -> None:
        p = filedialog.asksaveasfilename(title="Select Excel output", defaultextension=".xlsx", filetypes=[("Excel workbook", "*.xlsx")])
        if p:
            self.excel_path_var.set(p)

    def _toggle_account_type(self) -> None:
        show = self.show_account_type_var.get()
        if show:
            self.header_labels_widgets[-1].grid()
        else:
            self.header_labels_widgets[-1].grid_remove()
        for row in self.rows:
            if show:
                row["acct_combo"].grid()
            else:
                row["acct_combo"].grid_remove()

    def _on_mode_change(self) -> None:
        mode = self.mode_var.get()
        if mode == "new_money":
            self.budget_frame.pack(fill="x", pady=(0, 4), before=self.budget_frame.master.winfo_children()[
                list(self.budget_frame.master.winfo_children()).index(self.budget_frame)])
        else:
            pass
        self.budget_frame.pack_forget() if mode != "new_money" else self.budget_frame.pack(fill="x", pady=(0, 4))
        self._handle_input_change()

    def _on_reporting_change(self) -> None:
        label = get_meta(self.reporting_currency_var.get())["label"]
        self.budget_label_var.set(f"New money budget ({label})")
        self._update_live_totals()
        if self.has_calculated and not self.is_running:
            self._recalculate(show_error=False)

    # ── row management ──

    def set_rows(self, count: int, seed_data: list[dict] | None = None) -> None:
        count = clamp_row_count(count)
        self.row_count_var.set(str(count))
        for aid in self._ticker_validate_after_ids.values():
            try:
                self.root.after_cancel(aid)
            except Exception:
                pass
        self._ticker_validate_after_ids.clear()
        self._ticker_validation_tokens.clear()
        self._ticker_validation_feedback.clear()
        for r in self.rows:
            r["frame"].destroy()
        self.rows.clear()

        show_acct = self.show_account_type_var.get()
        for idx in range(count):
            d = seed_data[idx] if seed_data and idx < len(seed_data) else {}
            ticker = str(d.get("ticker", "")).upper()
            shares = str(d.get("shares", ""))
            price = str(d.get("price", ""))
            target = str(d.get("targetWeight", ""))
            ckey = d.get("currencyKey", "USD")
            if ckey not in CURRENCY_OPTIONS:
                ckey = "USD"
            acct = d.get("accountType", "")

            frame = ttk.Frame(self.rows_frame)
            frame.grid(row=idx, column=0, sticky="ew", pady=1)
            frame.columnconfigure(9, weight=1)

            tv = tk.StringVar(value=ticker)
            sv = tk.StringVar(value=shares)
            pv = tk.StringVar(value=price)
            wv = tk.StringVar(value=target)
            cv = tk.StringVar(value=ckey)
            av = tk.StringVar(value=acct)

            ttk.Label(frame, text=str(idx + 1), width=4).grid(row=0, column=0, padx=2)
            te = ttk.Entry(frame, textvariable=tv, width=14)
            te.grid(row=0, column=1, padx=2)
            se = ttk.Entry(frame, textvariable=sv, width=12)
            se.grid(row=0, column=2, padx=2)
            pe = ttk.Entry(frame, textvariable=pv, width=12)
            pe.grid(row=0, column=3, padx=2)
            cc = ttk.Combobox(frame, textvariable=cv, values=list(CURRENCY_OPTIONS.keys()), state="readonly", width=10)
            cc.grid(row=0, column=4, padx=2)
            fl = ttk.Label(frame, text=format_fx(self._get_fx_to_reporting(ckey)), width=10)
            fl.grid(row=0, column=5, padx=2)
            vl = ttk.Label(frame, text=format_currency(0), width=16)
            vl.grid(row=0, column=6, padx=2)
            we = ttk.Entry(frame, textvariable=wv, width=10)
            we.grid(row=0, column=7, padx=2)
            ac = ttk.Combobox(frame, textvariable=av, values=ACCOUNT_TYPES, state="readonly", width=14)
            ac.grid(row=0, column=8, padx=2)
            if not show_acct:
                ac.grid_remove()
            hl = ttk.Label(frame, text="", foreground=STATUS_WARN)
            hl.grid(row=1, column=1, columnspan=8, padx=2, sticky="w")

            te.bind("<KeyRelease>", lambda _, i=idx: self._on_ticker_change(i))
            te.bind("<FocusOut>", lambda _, i=idx: self._on_ticker_change(i))
            cc.bind("<<ComboboxSelected>>", lambda _, i=idx: self._on_ticker_change(i))
            for entry in (se, pe, we):
                entry.bind("<KeyRelease>", lambda _: self._handle_input_change())
                entry.bind("<FocusOut>", lambda _: self._handle_input_change())

            self.rows.append({
                "frame": frame, "ticker_var": tv, "shares_var": sv, "price_var": pv,
                "target_var": wv, "currency_var": cv, "acct_var": av,
                "fx_label": fl, "current_label": vl, "hint_label": hl, "acct_combo": ac,
            })

        self._update_mode_ui()
        self._update_live_totals()
        for idx, r in enumerate(self.rows):
            if r["ticker_var"].get().strip():
                self._schedule_ticker_validation(idx)

    def _get_current_seed(self) -> list[dict]:
        return [{
            "ticker": r["ticker_var"].get().strip().upper(),
            "shares": r["shares_var"].get().strip(),
            "price": r["price_var"].get().strip(),
            "currencyKey": r["currency_var"].get() or "USD",
            "targetWeight": r["target_var"].get().strip(),
            "accountType": r["acct_var"].get(),
        } for r in self.rows]

    # ── live totals ──

    def _update_live_totals(self) -> None:
        total_current = 0.0
        total_weight = 0.0
        rkey = self.reporting_currency_var.get()
        for idx, r in enumerate(self.rows):
            shares = self._parse_float(r["shares_var"].get())
            price = self._parse_float(r["price_var"].get())
            target = self._parse_float(r["target_var"].get())
            ckey = r["currency_var"].get()
            fx = self._get_fx_to_reporting(ckey)
            is_live = ckey in self.live_fx_keys or rkey in self.live_fx_keys
            cv = shares * price * fx if shares is not None and price is not None and shares >= 0 and price > 0 else 0.0
            r["fx_label"].configure(text=format_fx(fx, is_live))
            r["current_label"].configure(text=format_currency(cv, rkey))
            ticker = r["ticker_var"].get().strip().upper()
            fb = self._ticker_validation_feedback.get(idx)
            if fb and fb.get("ticker") == ticker:
                r["hint_label"].configure(text=fb["text"], foreground=fb.get("color", STATUS_WARN))
            else:
                hint = build_ticker_input_hint(ticker, ckey)
                r["hint_label"].configure(text=hint, foreground=STATUS_WARN)
            total_current += cv
            if target is not None and target >= 0:
                total_weight += target

        self.live_current_total_var.set(f"Current total: {format_currency(total_current, rkey)}")
        self.live_weight_total_var.set(f"Target weight total: {format_pct(total_weight)}")

    def _update_mode_ui(self) -> None:
        mode = self.mode_var.get()
        if mode == "new_money":
            self.budget_frame.pack(fill="x", pady=(0, 4))
        else:
            self.budget_frame.pack_forget()

    # ── ticker validation ──

    def _on_ticker_change(self, row_idx: int) -> None:
        self._ticker_validation_feedback.pop(row_idx, None)
        self._handle_input_change()
        self._schedule_ticker_validation(row_idx)

    def _handle_input_change(self) -> None:
        self.validation_var.set("")
        self._update_live_totals()
        if self.has_calculated and not self.is_running:
            self._recalculate(show_error=False)

    def _schedule_ticker_validation(self, row_idx: int) -> None:
        existing = self._ticker_validate_after_ids.get(row_idx)
        if existing:
            try:
                self.root.after_cancel(existing)
            except Exception:
                pass
        token = self._ticker_validation_tokens.get(row_idx, 0) + 1
        self._ticker_validation_tokens[row_idx] = token
        self._ticker_validate_after_ids[row_idx] = self.root.after(
            800, lambda i=row_idx, t=token: self._validate_ticker(i, t)
        )

    def _validate_ticker(self, row_idx: int, token: int) -> None:
        self._ticker_validate_after_ids.pop(row_idx, None)
        if token != self._ticker_validation_tokens.get(row_idx):
            return
        if row_idx >= len(self.rows):
            return
        r = self.rows[row_idx]
        ticker = r["ticker_var"].get().strip().upper()
        ckey = r["currency_var"].get()
        if not ticker:
            self._ticker_validation_feedback.pop(row_idx, None)
            r["hint_label"].configure(text="", foreground=STATUS_WARN)
            return
        self._ticker_validation_feedback[row_idx] = {"ticker": ticker, "text": f"Checking {ticker}...", "color": "#3f5066"}
        self._update_live_totals()

        def _apply(msg: str, color: str) -> None:
            if token != self._ticker_validation_tokens.get(row_idx):
                return
            if row_idx >= len(self.rows):
                return
            if self.rows[row_idx]["ticker_var"].get().strip().upper() != ticker:
                return
            self._ticker_validation_feedback[row_idx] = {"ticker": ticker, "text": msg, "color": color}
            self._update_live_totals()

        def worker() -> None:
            candidates = build_ticker_candidates(ticker, ckey)
            sel_code = CURRENCY_OPTIONS.get(ckey, CURRENCY_OPTIONS["USD"])["code"]
            first_mismatch = None
            for c in candidates:
                q = fetch_live_quote_details(c)
                if q:
                    if q.get("quoteCurrency") and q["quoteCurrency"] != sel_code:
                        if not first_mismatch:
                            first_mismatch = q
                        continue
                    self.root.after(0, lambda: _apply(f"✓ Verified: {q['resolvedTicker']} ({q.get('quoteCurrency', '?')})", STATUS_SUCCESS))
                    return
            cross = find_cross_market_quote(ticker, candidates)
            if cross:
                cc = cross.get("quoteCurrency", "?")
                self.root.after(0, lambda: _apply(f"⚠ {ticker} not found in {sel_code}. Found as {cross['resolvedTicker']} ({cc}). Update row currency or ticker symbol.", STATUS_WARN))
                return
            if first_mismatch:
                self.root.after(0, lambda: _apply(f"⚠ Found {first_mismatch['resolvedTicker']} but quotes in {first_mismatch.get('quoteCurrency', '?')}, not {sel_code}. Check row currency.", STATUS_WARN))
                return
            hint = build_ticker_input_hint(ticker, ckey)
            msg = "✗ Not found on Yahoo Finance. Verify the symbol at finance.yahoo.com."
            if hint:
                msg += f" {hint}"
            self.root.after(0, lambda: _apply(msg, STATUS_ERROR))

        threading.Thread(target=worker, daemon=True).start()

    # ── parse & calculate ──

    def _parse_positions(self, require_price: bool = True) -> list[dict]:
        if not self.rows:
            raise ValueError("Add at least one security row.")
        positions = []
        rkey = self.reporting_currency_var.get()
        for idx, r in enumerate(self.rows):
            ticker = r["ticker_var"].get().strip().upper()
            shares = self._parse_float(r["shares_var"].get())
            price = self._parse_float(r["price_var"].get())
            target = self._parse_float(r["target_var"].get())
            ckey = r["currency_var"].get()
            acct = r["acct_var"].get() if self.show_account_type_var.get() else ""
            if not ticker:
                raise ValueError(f"Row {idx + 1}: ticker is required.")
            if shares is None or shares < 0:
                raise ValueError(f"Row {idx + 1}: shares must be a non-negative number.")
            if require_price and (price is None or price <= 0):
                raise ValueError(f"Row {idx + 1}: price must be greater than 0.")
            if not require_price and price is not None and price <= 0:
                raise ValueError(f"Row {idx + 1}: manual price must be > 0 when provided.")
            if target is None or target < 0:
                raise ValueError(f"Row {idx + 1}: target weight must be >= 0.")
            positions.append({
                "rowIndex": idx, "ticker": ticker, "shares": shares, "price": price,
                "currencyKey": ckey, "currencyLabel": get_meta(ckey)["label"],
                "targetWeight": target, "accountType": acct,
            })
        if not any(p["targetWeight"] > 0 for p in positions):
            raise ValueError("At least one target weight must be > 0.")
        return positions

    def _enrich(self, positions: list[dict], fx_map: dict[str, float]) -> list[dict]:
        rkey = self.reporting_currency_var.get()
        r2u = fx_map.get(rkey, fallback_fx_to_usd(rkey))
        enriched = []
        for p in positions:
            row2u = fx_map.get(p["currencyKey"], fallback_fx_to_usd(p["currencyKey"]))
            fx = row2u / r2u
            price = p["price"]
            if price is None or price <= 0:
                raise ValueError(f"{p['ticker']}: price must be > 0.")
            cv_local = p["shares"] * price
            enriched.append({**p, "fxToReporting": fx, "currentValueLocal": cv_local, "currentValue": cv_local * fx})
        return enriched

    def _recalculate(self, show_error: bool = True) -> None:
        self.validation_var.set("")
        try:
            positions = self._parse_positions(require_price=True)
            mode = self.mode_var.get()
            budget = self._parse_float(self.budget_var.get()) or 0.0
            fx_map = {k: get_fx_to_usd(k, self.live_fx_to_usd or None) for k in CURRENCY_OPTIONS}
            enriched = self._enrich(positions, fx_map)
            summary, results, warnings = calculate_rebalance_plan(enriched, mode, budget)
            self._render_output(self._build_output(summary, results, warnings))
            self.has_calculated = True
        except ValueError as exc:
            self._render_output("Output will appear here after you run rebalancing.")
            self.validation_var.set(str(exc))
            self.has_calculated = False
            if show_error:
                self.root.bell()

    def _build_output(self, summary: dict, results: list[dict], warnings: list[str] | None = None, notes: list[str] | None = None, exports: list[str] | None = None, live: bool = False) -> str:
        rkey = self.reporting_currency_var.get()
        mode_label = "New Money" if summary.get("mode") == "new_money" else "Rebalance (Pure)"
        lines = ["SUMMARY", "-" * 96]
        lines.append(f"Run Date:            {dt.datetime.now().isoformat(timespec='seconds')}")
        lines.append(f"Mode:                {mode_label}")
        lines.append(f"Live data used:      {'Yes' if live else 'No'}")
        lines.append(f"Total Current Value: {format_currency(summary['totalCurrent'], rkey)}")
        if summary.get("mode") == "new_money":
            lines.append(f"New Money Budget:    {format_currency(summary.get('budget', 0), rkey)}")
        lines.append(f"Target Pool:         {format_currency(summary['pool'], rkey)}")
        lines.append(f"Total Buy Value:     {format_currency(summary['totalBuys'], rkey)}")
        lines.append(f"Total Sell Value:    {format_currency(summary['totalSells'], rkey)}")
        lines.append("")
        show_acct = self.show_account_type_var.get()
        acct_hdr = f"{'Acct':>14}" if show_acct else ""
        lines.append("TRADE PLAN")
        lines.append("-" * (170 + (14 if show_acct else 0)))
        lines.append(f"{'Ticker':<8}{acct_hdr}{'Curr':<10}{'Shares':>12}{'Price':>14}{'Current':>14}{'Target%':>10}{'Target':>14}{'Trade':>14}{'Trade Local':>14}{'Trade Sh':>12}{'Action':>9}{'Post Sh':>12}")
        lines.append("-" * (170 + (14 if show_acct else 0)))
        for r in results:
            acct_col = f"{(r.get('accountType') or ''):>14}" if show_acct else ""
            lines.append(
                f"{r['ticker']:<8}{acct_col}{r['currencyLabel']:<10}"
                f"{format_shares(r['shares']):>12}{format_currency(r['price'], r['currencyKey']):>14}"
                f"{format_currency(r['currentValue'], rkey):>14}{format_pct(r['targetWeightNorm'] * 100):>10}"
                f"{format_currency(r['targetValue'], rkey):>14}{format_currency(r['tradeValue'], rkey):>14}"
                f"{format_currency(r['tradeValueLocal'], r['currencyKey']):>14}"
                f"{format_shares(r['tradeShares']):>12}{r['action']:>9}{format_shares(r['postTradeShares']):>12}"
            )
        if warnings:
            lines += ["", "WARNINGS", "-" * 96] + [f"- {w}" for w in warnings]
        if notes:
            lines += ["", "NOTES", "-" * 96] + [f"- {n}" for n in notes]
        if exports:
            lines += ["", "EXPORTS", "-" * 96] + [f"- {e}" for e in exports]
        return "\n".join(lines)

    # ── run ──

    def _on_run(self) -> None:
        if self.is_running:
            return
        self.validation_var.set("")
        mode = self.mode_var.get()
        budget = self._parse_float(self.budget_var.get()) or 0.0
        wants_live = bool(self.fetch_live_var.get())
        from portfolio_rebalancer.pricing import yf as _yf
        use_live = wants_live and _yf is not None
        pre_warnings: list[str] = []
        if wants_live and not use_live:
            pre_warnings.append("yfinance is not installed; using manual prices. Install with: pip install yfinance")
        try:
            csv_path = self._validate_path(self.export_csv_var, self.csv_path_var, ".csv")
            excel_path = self._validate_path(self.export_excel_var, self.excel_path_var, ".xlsx")
            positions = self._parse_positions(require_price=not use_live)
            if mode == "new_money" and budget <= 0:
                raise ValueError("New money budget must be greater than 0.")
        except ValueError as exc:
            self.validation_var.set(str(exc))
            self.root.bell()
            return

        self._set_running(True)
        self._set_status("Fetching live data..." if use_live else "Running rebalance...", STATUS_NEUTRAL)
        payload = {"positions": positions, "mode": mode, "budget": budget, "use_live": use_live,
                   "pre_warnings": pre_warnings, "csv_path": csv_path, "excel_path": excel_path,
                   "reporting_currency": self.reporting_currency_var.get()}
        self.worker_thread = threading.Thread(target=self._run_worker, args=(payload,), daemon=True)
        self.worker_thread.start()
        self.root.after(80, self._poll_events)

    def _validate_path(self, enabled_var: tk.BooleanVar, path_var: tk.StringVar, ext: str) -> Path | None:
        if not enabled_var.get():
            return None
        raw = path_var.get().strip()
        if not raw:
            raise ValueError(f"Export is enabled but no {ext} path is selected.")
        p = Path(raw)
        if p.suffix.lower() != ext:
            raise ValueError(f"Export path must end with {ext}")
        if not p.parent.exists():
            raise ValueError(f"Export folder does not exist: {p.parent}")
        return p

    def _run_worker(self, payload: dict) -> None:
        try:
            warnings = list(payload["pre_warnings"])
            notes: list[str] = []
            positions = [dict(p) for p in payload["positions"]]
            mode = str(payload["mode"])
            budget = float(payload["budget"])
            rkey = str(payload["reporting_currency"])
            use_live = bool(payload["use_live"])
            csv_path: Path | None = payload["csv_path"]
            excel_path: Path | None = payload["excel_path"]

            fx_map = {k: fallback_fx_to_usd(k) for k in CURRENCY_OPTIONS}
            live_keys: set[str] = set()
            price_updates: dict[int, float] = {}
            currency_updates: dict[int, str] = {}

            if use_live:
                self.worker_events.put(("status", "Fetching live prices..."))
                for pos in positions:
                    ticker = pos["ticker"]
                    ri = int(pos["rowIndex"])
                    sel_key = pos["currencyKey"]
                    sel_code = CURRENCY_OPTIONS[sel_key]["code"]
                    manual = pos["price"]
                    candidates = build_ticker_candidates(ticker, sel_key)
                    best = None
                    fallback = None
                    for c in candidates:
                        q = fetch_live_quote_details(c)
                        if not q:
                            continue
                        if q.get("quoteCurrency") == sel_code:
                            best = q
                            break
                        if not fallback:
                            fallback = q
                    chosen = best or fallback
                    if not chosen:
                        cross = find_cross_market_quote(ticker, candidates)
                        chosen = cross
                    if not chosen:
                        att = ", ".join(candidates) if candidates else ticker
                        if manual is None:
                            raise ValueError(f"Live price unavailable for {ticker} (tried: {att}). Enter a manual price.")
                        warnings.append(f"Live price unavailable for {ticker} (tried: {att}). Using manual entry {manual:.4f}.")
                        continue
                    qcode = chosen.get("quoteCurrency")
                    qkey = CURRENCY_CODE_TO_KEY.get(qcode) if qcode else None
                    cp = float(chosen["price"])
                    if qcode and qcode != sel_code:
                        if qkey and manual is None:
                            pos["currencyKey"] = qkey
                            pos["currencyLabel"] = get_meta(qkey)["label"]
                            currency_updates[ri] = qkey
                            pos["price"] = cp
                            price_updates[ri] = cp
                            warnings.append(f"{ticker}: using {chosen['resolvedTicker']} ({qcode}), adjusted currency.")
                            continue
                        if manual is not None:
                            warnings.append(f"{ticker}: found as {chosen['resolvedTicker']} ({qcode}). Keeping manual entry.")
                            continue
                        raise ValueError(f"{ticker}: unsupported currency {qcode}. Enter a manual price.")
                    pos["price"] = cp
                    price_updates[ri] = cp
                    if chosen["resolvedTicker"] != ticker:
                        warnings.append(f"{ticker}: used {chosen['resolvedTicker']} for live quote.")
                    if chosen.get("unitScale", 1.0) != 1.0:
                        notes.append(f"{ticker}: converted from sub-units ({chosen.get('rawQuoteCurrency')}).")

                self.worker_events.put(("status", "Fetching FX rates..."))
                in_scope = {rkey}
                in_scope.update(p["currencyKey"] for p in positions)
                for ck in sorted(in_scope):
                    code = CURRENCY_OPTIONS[ck]["code"]
                    rate = fetch_live_fx_to_usd(code)
                    if rate:
                        fx_map[ck] = rate
                        live_keys.add(ck)
                    else:
                        warnings.append(f"Live FX unavailable for {ck}; using fallback {fallback_fx_to_usd(ck):.4f}.")

            r2u = fx_map.get(rkey, fallback_fx_to_usd(rkey))
            enriched = []
            for p in positions:
                row2u = fx_map.get(p["currencyKey"], fallback_fx_to_usd(p["currencyKey"]))
                fx = row2u / r2u
                price = p["price"]
                if price is None or price <= 0:
                    raise ValueError(f"{p['ticker']}: price must be > 0.")
                cv = p["shares"] * price * fx
                enriched.append({**p, "fxToReporting": fx, "currentValue": cv})

            summary, results, plan_warnings = calculate_rebalance_plan(enriched, mode, budget)
            all_warnings = plan_warnings + warnings

            exports: list[str] = []
            if csv_path:
                self.worker_events.put(("status", "Writing CSV..."))
                write_csv_export(csv_path, summary, results, rkey, all_warnings, notes)
                exports.append(f"CSV: {csv_path}")
            if excel_path:
                self.worker_events.put(("status", "Writing Excel..."))
                write_excel_export(excel_path, summary, results, rkey)
                exports.append(f"Excel: {excel_path}")

            self.worker_events.put(("success", {
                "summary": summary, "results": results, "warnings": all_warnings,
                "notes": notes, "exports": exports, "live": use_live,
                "fx_map": fx_map if use_live else {}, "live_keys": live_keys,
                "price_updates": price_updates, "currency_updates": currency_updates,
            }))
        except Exception as exc:
            self.worker_events.put(("error", str(exc)))

    def _poll_events(self) -> None:
        while True:
            try:
                event, payload = self.worker_events.get_nowait()
            except queue.Empty:
                break
            if event == "status":
                self._set_status(str(payload), STATUS_NEUTRAL)
            elif event == "success":
                d = payload
                self._set_running(False)
                self.live_fx_to_usd = dict(d["fx_map"])
                self.live_fx_keys = set(d["live_keys"])
                for ri, np in d.get("price_updates", {}).items():
                    i = int(ri)
                    if 0 <= i < len(self.rows):
                        self.rows[i]["price_var"].set(format_input_price(float(np)))
                for ri, nk in d.get("currency_updates", {}).items():
                    i = int(ri)
                    if 0 <= i < len(self.rows):
                        self.rows[i]["currency_var"].set(nk)
                self._update_live_totals()
                self._render_output(self._build_output(d["summary"], d["results"], d["warnings"], d.get("notes"), d["exports"], d["live"]))
                self.has_calculated = True
                if d["warnings"]:
                    self._set_status(f"Completed with {len(d['warnings'])} warning(s).", STATUS_WARN)
                else:
                    self._set_status("Rebalance completed successfully.", STATUS_SUCCESS)
            elif event == "error":
                self._set_running(False)
                self._render_output("Output will appear here after you run rebalancing.")
                self.validation_var.set(str(payload))
                self.has_calculated = False
                self._set_status("Run failed.", STATUS_ERROR)
                self.root.bell()
        if self.is_running:
            self.root.after(80, self._poll_events)

    # ── UI callbacks ──

    def _on_apply_rows(self) -> None:
        seed = self._get_current_seed()
        count = clamp_row_count(int(float(self.row_count_var.get() or "1")))
        self.set_rows(count, [seed[i] if i < len(seed) else {} for i in range(count)])

    def _on_add_row(self) -> None:
        seed = self._get_current_seed()
        if len(seed) >= 50:
            self.validation_var.set("Maximum 50 rows.")
            return
        seed.append({})
        self.set_rows(len(seed), seed)

    def _on_remove_row(self) -> None:
        seed = self._get_current_seed()
        if len(seed) <= 1:
            self.validation_var.set("At least one row required.")
            return
        seed.pop()
        self.set_rows(len(seed), seed)

    def _load_sample(self) -> None:
        self.live_fx_to_usd.clear()
        self.live_fx_keys.clear()
        self.set_rows(len(SAMPLE_PORTFOLIO), SAMPLE_PORTFOLIO)
        self.budget_var.set("0")
        self.mode_var.set("new_money")
        self._update_mode_ui()
        self.validation_var.set("")
        self._render_output("Output will appear here after you run rebalancing.")
        self.has_calculated = False
        self._set_status("Sample portfolio loaded.", STATUS_NEUTRAL)


def main() -> None:
    if not TK_AVAILABLE:
        raise RuntimeError("tkinter is not available. Install tkinter to run the desktop GUI.")
    root = tk.Tk()
    PortfolioRebalancerApp(root)
    root.mainloop()
