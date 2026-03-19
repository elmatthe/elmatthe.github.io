#!/usr/bin/env python3
"""
Portfolio Rebalancer Desktop Tool
---------------------------------
Run this script to open a desktop window that mirrors the website rebalancer
workflow: enter positions, choose currencies, set target weights, and generate
buy/sell trade instructions.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk


CURRENCY_OPTIONS = {
    "USD": {"code": "USD", "label": "USD", "fx_to_usd": 1.00, "symbol": "$"},
    "CAD": {"code": "CAD", "label": "CAD", "fx_to_usd": 0.74, "symbol": "C$"},
    "JPN": {"code": "JPY", "label": "JPN", "fx_to_usd": 0.0067, "symbol": "JPY "},
    "EUR": {"code": "EUR", "label": "EUR", "fx_to_usd": 1.09, "symbol": "EUR "},
    "GBP": {"code": "GBP", "label": "GBP", "fx_to_usd": 1.28, "symbol": "GBP "},
    "CHY_CNH": {"code": "CNY", "label": "CHY/CNH", "fx_to_usd": 0.14, "symbol": "CNY "},
}

SAMPLE_PORTFOLIO = [
    {"ticker": "VTI", "shares": 120, "price": 250, "targetWeight": 35, "currencyKey": "USD"},
    {"ticker": "XIC", "shares": 140, "price": 36, "targetWeight": 20, "currencyKey": "CAD"},
    {"ticker": "EWJ", "shares": 220, "price": 2480, "targetWeight": 15, "currencyKey": "JPN"},
    {"ticker": "VGK", "shares": 115, "price": 64, "targetWeight": 15, "currencyKey": "EUR"},
    {"ticker": "ISF", "shares": 260, "price": 7.4, "targetWeight": 15, "currencyKey": "GBP"},
]


def clamp_row_count(value: int) -> int:
    return max(1, min(50, int(value)))


class PortfolioRebalancerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Portfolio Rebalancer Desktop Tool")
        self.root.geometry("1320x840")
        self.root.minsize(1120, 720)

        self.rows = []
        self.has_calculated = False

        self.row_count_var = tk.StringVar(value=str(len(SAMPLE_PORTFOLIO)))
        self.reporting_currency_var = tk.StringVar(value="USD")
        self.net_flow_var = tk.StringVar(value="0")
        self.validation_var = tk.StringVar(value="")
        self.live_current_total_var = tk.StringVar(value="Current total: $0.00")
        self.live_weight_total_var = tk.StringVar(value="Target weight total: 0.00%")
        self.net_flow_label_var = tk.StringVar(value="Net contribution / withdrawal (USD)")

        self._build_ui()
        self.set_rows(len(SAMPLE_PORTFOLIO), SAMPLE_PORTFOLIO)

    def _build_ui(self) -> None:
        root_pad = {"padx": 10, "pady": 8}
        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True, **root_pad)

        title = ttk.Label(main, text="Portfolio Rebalancer Project", font=("TkDefaultFont", 16, "bold"))
        title.pack(anchor="w")

        subtitle = ttk.Label(
            main,
            text=(
                "Desktop version of the website tool. Enter holdings and target weights "
                "to generate buy/sell rebalancing instructions."
            ),
            foreground="#3f5066",
        )
        subtitle.pack(anchor="w", pady=(0, 8))

        controls = ttk.Frame(main)
        controls.pack(fill="x", pady=(0, 6))

        ttk.Label(controls, text="Number of securities").grid(row=0, column=0, sticky="w")
        self.row_count_spin = tk.Spinbox(
            controls,
            from_=1,
            to=50,
            width=6,
            textvariable=self.row_count_var,
            justify="right",
        )
        self.row_count_spin.grid(row=1, column=0, sticky="w", padx=(0, 10))

        ttk.Label(controls, text="Reporting currency").grid(row=0, column=1, sticky="w")
        self.reporting_currency_combo = ttk.Combobox(
            controls,
            width=10,
            values=list(CURRENCY_OPTIONS.keys()),
            textvariable=self.reporting_currency_var,
            state="readonly",
        )
        self.reporting_currency_combo.grid(row=1, column=1, sticky="w", padx=(0, 10))
        self.reporting_currency_combo.bind("<<ComboboxSelected>>", lambda _e: self.on_reporting_currency_change())

        ttk.Button(controls, text="Apply Rows", command=self.on_apply_rows).grid(row=1, column=2, sticky="w", padx=(0, 6))
        ttk.Button(controls, text="Add Row", command=self.on_add_row).grid(row=1, column=3, sticky="w", padx=(0, 6))
        ttk.Button(controls, text="Remove Last Row", command=self.on_remove_row).grid(row=1, column=4, sticky="w")

        table_section = ttk.LabelFrame(main, text="Portfolio Inputs")
        table_section.pack(fill="both", expand=False, pady=(6, 6))

        header = ttk.Frame(table_section)
        header.pack(fill="x", padx=6, pady=(6, 2))

        header_labels = [
            ("#", 4),
            ("Ticker", 14),
            ("Shares / Units", 14),
            ("Price (local)", 14),
            ("Row Currency", 12),
            ("FX to reporting", 14),
            ("Current Value", 18),
            ("Target Weight %", 14),
        ]

        for col, (label, width) in enumerate(header_labels):
            ttk.Label(header, text=label, width=width, anchor="w").grid(row=0, column=col, padx=2, sticky="w")

        canvas_holder = ttk.Frame(table_section)
        canvas_holder.pack(fill="both", expand=True, padx=6, pady=(0, 4))

        self.table_canvas = tk.Canvas(canvas_holder, height=280, highlightthickness=0)
        self.table_canvas.pack(side="left", fill="both", expand=True)

        scrollbar = ttk.Scrollbar(canvas_holder, orient="vertical", command=self.table_canvas.yview)
        scrollbar.pack(side="right", fill="y")
        self.table_canvas.configure(yscrollcommand=scrollbar.set)

        self.rows_frame = ttk.Frame(self.table_canvas)
        self.rows_window_id = self.table_canvas.create_window((0, 0), window=self.rows_frame, anchor="nw")
        self.rows_frame.bind("<Configure>", self._on_rows_frame_configure)
        self.table_canvas.bind("<Configure>", self._on_canvas_configure)

        totals = ttk.Frame(table_section)
        totals.pack(fill="x", padx=6, pady=(2, 8))
        ttk.Label(totals, textvariable=self.live_current_total_var).pack(side="left")
        ttk.Label(totals, textvariable=self.live_weight_total_var).pack(side="right")

        flow_frame = ttk.Frame(main)
        flow_frame.pack(fill="x", pady=(0, 4))
        ttk.Label(flow_frame, textvariable=self.net_flow_label_var).pack(anchor="w")
        self.net_flow_entry = ttk.Entry(flow_frame, textvariable=self.net_flow_var, width=24)
        self.net_flow_entry.pack(anchor="w", pady=(2, 0))
        self.net_flow_entry.bind("<KeyRelease>", lambda _e: self._handle_live_input_change())
        self.net_flow_entry.bind("<FocusOut>", lambda _e: self._handle_live_input_change())

        button_row = ttk.Frame(main)
        button_row.pack(fill="x", pady=(6, 6))
        ttk.Button(button_row, text="Run Rebalance", command=self.calculate_rebalance).pack(side="left", padx=(0, 6))
        ttk.Button(button_row, text="Load Sample Portfolio", command=self.load_sample_portfolio).pack(side="left")

        validation_label = ttk.Label(main, textvariable=self.validation_var, foreground="#B12828")
        validation_label.pack(anchor="w", pady=(0, 4))

        output = ttk.LabelFrame(main, text="Rebalance Output")
        output.pack(fill="both", expand=True)
        self.output_text = tk.Text(output, wrap="none", height=15, font=("Courier New", 10))
        self.output_text.pack(fill="both", expand=True, padx=6, pady=6)
        self.output_text.insert("1.0", "Output will appear here after you run rebalancing.")
        self.output_text.configure(state="disabled")

    def _on_rows_frame_configure(self, _event: tk.Event) -> None:
        self.table_canvas.configure(scrollregion=self.table_canvas.bbox("all"))

    def _on_canvas_configure(self, event: tk.Event) -> None:
        self.table_canvas.itemconfigure(self.rows_window_id, width=event.width)

    def _render_output(self, text: str) -> None:
        self.output_text.configure(state="normal")
        self.output_text.delete("1.0", "end")
        self.output_text.insert("1.0", text)
        self.output_text.configure(state="disabled")

    def get_reporting_meta(self) -> dict:
        key = self.reporting_currency_var.get()
        return CURRENCY_OPTIONS.get(key, CURRENCY_OPTIONS["USD"])

    def get_row_meta(self, currency_key: str) -> dict:
        return CURRENCY_OPTIONS.get(currency_key, CURRENCY_OPTIONS["USD"])

    def get_fx_to_reporting(self, currency_key: str) -> float:
        row_meta = self.get_row_meta(currency_key)
        report_meta = self.get_reporting_meta()
        return row_meta["fx_to_usd"] / report_meta["fx_to_usd"]

    @staticmethod
    def parse_float(raw: str) -> float | None:
        raw = str(raw).strip()
        if raw == "":
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    @staticmethod
    def format_fx(value: float) -> str:
        return f"{value:.4f}"

    @staticmethod
    def format_pct(value: float) -> str:
        return f"{value:.2f}%"

    @staticmethod
    def format_shares(value: float) -> str:
        text = f"{value:,.4f}"
        return text.rstrip("0").rstrip(".")

    def format_currency(self, value: float, currency_key: str | None = None) -> str:
        key = currency_key or self.reporting_currency_var.get()
        meta = self.get_row_meta(key)
        symbol = meta["symbol"]
        if value < 0:
            return f"-{symbol}{abs(value):,.2f}"
        return f"{symbol}{value:,.2f}"

    def get_current_row_seed(self) -> list[dict]:
        seed = []
        for row in self.rows:
            seed.append(
                {
                    "ticker": row["ticker_var"].get().strip().upper(),
                    "shares": row["shares_var"].get().strip(),
                    "price": row["price_var"].get().strip(),
                    "currencyKey": row["currency_var"].get().strip() or "USD",
                    "targetWeight": row["target_var"].get().strip(),
                }
            )
        return seed

    def set_rows(self, count: int, seed_data: list[dict] | None = None) -> None:
        row_count = clamp_row_count(count)
        self.row_count_var.set(str(row_count))

        for row in self.rows:
            row["frame"].destroy()
        self.rows = []

        for idx in range(row_count):
            data = seed_data[idx] if seed_data and idx < len(seed_data) else {}
            ticker = str(data.get("ticker", "")).upper()
            shares = str(data.get("shares", ""))
            price = str(data.get("price", ""))
            target = str(data.get("targetWeight", ""))
            currency_key = data.get("currencyKey", "USD")
            if currency_key not in CURRENCY_OPTIONS:
                currency_key = "USD"

            frame = ttk.Frame(self.rows_frame)
            frame.grid(row=idx, column=0, sticky="ew", pady=1)
            frame.columnconfigure(1, weight=1)

            ticker_var = tk.StringVar(value=ticker)
            shares_var = tk.StringVar(value=shares)
            price_var = tk.StringVar(value=price)
            target_var = tk.StringVar(value=target)
            currency_var = tk.StringVar(value=currency_key)

            ttk.Label(frame, text=str(idx + 1), width=4).grid(row=0, column=0, padx=2, sticky="w")
            ticker_entry = ttk.Entry(frame, textvariable=ticker_var, width=14)
            ticker_entry.grid(row=0, column=1, padx=2, sticky="w")
            shares_entry = ttk.Entry(frame, textvariable=shares_var, width=14)
            shares_entry.grid(row=0, column=2, padx=2, sticky="w")
            price_entry = ttk.Entry(frame, textvariable=price_var, width=14)
            price_entry.grid(row=0, column=3, padx=2, sticky="w")
            currency_combo = ttk.Combobox(
                frame,
                textvariable=currency_var,
                values=list(CURRENCY_OPTIONS.keys()),
                state="readonly",
                width=12,
            )
            currency_combo.grid(row=0, column=4, padx=2, sticky="w")
            fx_label = ttk.Label(frame, text=self.format_fx(self.get_fx_to_reporting(currency_key)), width=14)
            fx_label.grid(row=0, column=5, padx=2, sticky="w")
            current_label = ttk.Label(frame, text=self.format_currency(0), width=18)
            current_label.grid(row=0, column=6, padx=2, sticky="w")
            target_entry = ttk.Entry(frame, textvariable=target_var, width=14)
            target_entry.grid(row=0, column=7, padx=2, sticky="w")

            for entry in (ticker_entry, shares_entry, price_entry, target_entry):
                entry.bind("<KeyRelease>", lambda _e: self._handle_live_input_change())
                entry.bind("<FocusOut>", lambda _e: self._handle_live_input_change())

            currency_combo.bind("<<ComboboxSelected>>", lambda _e: self._handle_live_input_change())

            self.rows.append(
                {
                    "frame": frame,
                    "ticker_var": ticker_var,
                    "shares_var": shares_var,
                    "price_var": price_var,
                    "target_var": target_var,
                    "currency_var": currency_var,
                    "fx_label": fx_label,
                    "current_label": current_label,
                }
            )

        self.update_currency_ui()
        self.update_live_totals()

    def update_currency_ui(self) -> None:
        label = self.get_reporting_meta()["label"]
        self.net_flow_label_var.set(f"Net contribution / withdrawal ({label})")

    def _handle_live_input_change(self) -> None:
        self.validation_var.set("")
        self.update_live_totals()
        if self.has_calculated:
            self.calculate_rebalance(show_error=False)

    def update_live_totals(self) -> None:
        total_current = 0.0
        total_weight = 0.0

        for row in self.rows:
            shares = self.parse_float(row["shares_var"].get())
            price = self.parse_float(row["price_var"].get())
            target = self.parse_float(row["target_var"].get())
            currency_key = row["currency_var"].get()
            fx = self.get_fx_to_reporting(currency_key)

            if shares is not None and price is not None and shares >= 0 and price > 0:
                local_value = shares * price
                current_value = local_value * fx
            else:
                current_value = 0.0

            row["fx_label"].configure(text=self.format_fx(fx))
            row["current_label"].configure(text=self.format_currency(current_value))

            total_current += current_value
            if target is not None and target >= 0:
                total_weight += target

        self.live_current_total_var.set(f"Current total: {self.format_currency(total_current)}")
        self.live_weight_total_var.set(f"Target weight total: {self.format_pct(total_weight)}")

    def parse_positions(self) -> list[dict]:
        if not self.rows:
            raise ValueError("Add at least one security row.")

        positions = []
        for idx, row in enumerate(self.rows):
            ticker = row["ticker_var"].get().strip().upper()
            shares = self.parse_float(row["shares_var"].get())
            price = self.parse_float(row["price_var"].get())
            target_weight = self.parse_float(row["target_var"].get())
            currency_key = row["currency_var"].get()

            if not ticker:
                raise ValueError(f"Row {idx + 1}: ticker is required.")
            if shares is None or shares < 0:
                raise ValueError(f"Row {idx + 1}: shares/units must be a non-negative number.")
            if price is None or price <= 0:
                raise ValueError(f"Row {idx + 1}: price must be greater than 0.")
            if target_weight is None or target_weight < 0:
                raise ValueError(f"Row {idx + 1}: target weight must be 0 or greater.")
            if currency_key not in CURRENCY_OPTIONS:
                raise ValueError(f"Row {idx + 1}: row currency is invalid.")

            fx_to_reporting = self.get_fx_to_reporting(currency_key)
            positions.append(
                {
                    "ticker": ticker,
                    "shares": shares,
                    "price": price,
                    "currencyKey": currency_key,
                    "currencyLabel": self.get_row_meta(currency_key)["label"],
                    "fxToReporting": fx_to_reporting,
                    "currentValueLocal": shares * price,
                    "currentValue": shares * price * fx_to_reporting,
                    "targetWeight": target_weight,
                }
            )

        if not any(position["targetWeight"] > 0 for position in positions):
            raise ValueError("At least one target weight must be greater than 0.")

        return positions

    def build_output(self, summary: dict, rows: list[dict]) -> str:
        lines = []
        lines.append("SUMMARY")
        lines.append("-" * 92)
        lines.append(f"Total Current Value: {self.format_currency(summary['totalCurrent'])}")
        lines.append(f"Net Flow:            {self.format_currency(summary['netFlow'])}")
        lines.append(f"Target Ending Value: {self.format_currency(summary['endingValue'])}")
        lines.append(f"Total Buy Value:     {self.format_currency(summary['totalBuys'])}")
        lines.append(f"Total Sell Value:    {self.format_currency(summary['totalSells'])}")
        lines.append("")
        lines.append("TRADE PLAN")
        lines.append("-" * 170)
        lines.append(
            f"{'Ticker':<8}{'Curr':<10}{'Shares':>12}{'Price':>14}{'Current':>14}"
            f"{'Target%':>10}{'Target':>14}{'Trade':>14}{'Trade Local':>14}"
            f"{'Trade Sh':>12}{'Action':>9}{'Post Sh':>12}"
        )
        lines.append("-" * 170)
        for item in rows:
            lines.append(
                f"{item['ticker']:<8}{item['currencyLabel']:<10}"
                f"{self.format_shares(item['shares']):>12}"
                f"{self.format_currency(item['price'], item['currencyKey']):>14}"
                f"{self.format_currency(item['currentValue']):>14}"
                f"{self.format_pct(item['targetWeightNorm'] * 100):>10}"
                f"{self.format_currency(item['targetValue']):>14}"
                f"{self.format_currency(item['tradeValue']):>14}"
                f"{self.format_currency(item['tradeValueLocal'], item['currencyKey']):>14}"
                f"{self.format_shares(item['tradeShares']):>12}"
                f"{item['action']:>9}"
                f"{self.format_shares(item['postTradeShares']):>12}"
            )
        return "\n".join(lines)

    def calculate_rebalance(self, show_error: bool = True) -> None:
        self.validation_var.set("")
        try:
            positions = self.parse_positions()
            net_flow = self.parse_float(self.net_flow_var.get())
            if net_flow is None:
                raise ValueError("Net contribution / withdrawal must be a valid number.")

            total_current = sum(pos["currentValue"] for pos in positions)
            total_weight = sum(pos["targetWeight"] for pos in positions)
            ending_value = total_current + net_flow
            if ending_value <= 0:
                raise ValueError("Ending portfolio value must be greater than 0.")

            total_buys = 0.0
            total_sells = 0.0
            results = []

            for pos in positions:
                target_weight_norm = pos["targetWeight"] / total_weight
                target_value = target_weight_norm * ending_value
                trade_value = target_value - pos["currentValue"]
                trade_value_local = trade_value / pos["fxToReporting"]
                trade_shares = trade_value_local / pos["price"]

                action = "Hold"
                if trade_value > 0.005:
                    action = "Buy"
                    total_buys += trade_value
                elif trade_value < -0.005:
                    action = "Sell"
                    total_sells += abs(trade_value)

                if abs(trade_value) <= 0.005:
                    trade_value = 0.0
                    trade_value_local = 0.0
                    trade_shares = 0.0

                results.append(
                    {
                        "ticker": pos["ticker"],
                        "currencyKey": pos["currencyKey"],
                        "currencyLabel": pos["currencyLabel"],
                        "shares": pos["shares"],
                        "price": pos["price"],
                        "currentValue": pos["currentValue"],
                        "targetWeightNorm": target_weight_norm,
                        "targetValue": target_value,
                        "tradeValue": trade_value,
                        "tradeValueLocal": trade_value_local,
                        "tradeShares": trade_shares,
                        "action": action,
                        "postTradeShares": pos["shares"] + trade_shares,
                    }
                )

            summary = {
                "totalCurrent": total_current,
                "netFlow": net_flow,
                "endingValue": ending_value,
                "totalBuys": total_buys,
                "totalSells": total_sells,
            }

            self._render_output(self.build_output(summary, results))
            self.has_calculated = True
        except ValueError as exc:
            self._render_output("Output will appear here after you run rebalancing.")
            self.validation_var.set(str(exc))
            self.has_calculated = False
            if show_error:
                self.root.bell()

    def on_apply_rows(self) -> None:
        seed = self.get_current_row_seed()
        try:
            requested = int(float(self.row_count_var.get() or "1"))
        except ValueError:
            requested = 1
        count = clamp_row_count(requested)
        trimmed = [seed[i] if i < len(seed) else {} for i in range(count)]
        self.set_rows(count, trimmed)

    def on_add_row(self) -> None:
        seed = self.get_current_row_seed()
        if len(seed) >= 50:
            self.validation_var.set("Maximum row limit reached (50).")
            return
        seed.append({})
        self.set_rows(len(seed), seed)

    def on_remove_row(self) -> None:
        seed = self.get_current_row_seed()
        if len(seed) <= 1:
            self.validation_var.set("At least one row is required.")
            return
        seed.pop()
        self.set_rows(len(seed), seed)

    def on_reporting_currency_change(self) -> None:
        self.validation_var.set("")
        self.update_currency_ui()
        self.update_live_totals()
        if self.has_calculated:
            self.calculate_rebalance(show_error=False)

    def load_sample_portfolio(self) -> None:
        self.row_count_var.set(str(len(SAMPLE_PORTFOLIO)))
        self.set_rows(len(SAMPLE_PORTFOLIO), SAMPLE_PORTFOLIO)
        self.net_flow_var.set("0")
        self.validation_var.set("")
        self._render_output("Output will appear here after you run rebalancing.")
        self.has_calculated = False


def main() -> None:
    root = tk.Tk()
    app = PortfolioRebalancerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
