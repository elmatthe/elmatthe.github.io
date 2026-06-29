"""Tkinter GUI entry point for the Stock Comparison & Analytics Tool."""

from __future__ import annotations

import datetime as dt
import re
import shutil
import traceback
from pathlib import Path
from tkinter import filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import pandas as pd

from analytics import (
    align_price_series,
    compute_correlation_matrix,
    compute_dashboard_metrics,
    compute_returns,
    find_diversification_flags,
    normalize_price_frames_to_currency,
    run_all_pairwise_regressions,
    run_benchmark_regressions,
)
from config import (
    DEFAULT_CURRENCY,
    DEFAULT_RISK_FREE_RATE,
    MAX_TICKERS,
    NORMALIZE_CURRENCY_OPTIONS,
    SUPPORTED_CURRENCIES,
    get_exports_dir,
    get_periods_per_year,
    get_plots_dir,
    get_website_assets_dir,
    ensure_directory,
    parse_normalization_choice,
)
from data_sources import DataSourceError, OfflineCsvSource, get_data_source
from exports import export_plot_images, export_results_to_csv_folder, export_results_to_excel
from plots import (
    plot_correlation_heatmap,
    plot_cumulative_returns,
    plot_drawdowns,
    plot_price_index,
    plot_regression_scatter,
    plot_risk_return_scatter,
    plot_rolling_correlation_vs_benchmark,
    plot_rolling_volatility,
)


APP_VERSION = "v0.3.0"

MULTI_CURRENCY_WARNING = (
    "Multiple listing currencies were detected. Returns and correlations are currently computed in each security's "
    "local currency. Cross-currency comparisons may be distorted without FX normalization."
)


def format_fx_normalization_note(target_currency: str, source_name: str) -> str:
    if source_name == "Offline CSV":
        return (
            f"FX normalization ON - all series converted to {target_currency} using bundled "
            "Offline CSV FX rates (test-files/fx_rates.csv)."
        )
    return (
        f"FX normalization ON - all series converted to {target_currency} using daily "
        "Yahoo Finance FX rates."
    )


def _normalize_currency(value: str | None) -> str:
    return str(value or "").strip().upper()


def build_currency_mismatch_warnings(
    selected_currency_by_ticker: dict[str, str],
    detected_currency_by_ticker: dict[str, str],
) -> list[str]:
    warnings = []
    for ticker, selected_currency in selected_currency_by_ticker.items():
        selected = _normalize_currency(selected_currency)
        detected = _normalize_currency(detected_currency_by_ticker.get(ticker))
        if selected and detected and selected != detected:
            warnings.append(f"{ticker} was entered as {selected}, but the data source reports {detected}.")
    return warnings


def format_currency_mismatch_warning(mismatch_warnings: list[str]) -> str:
    return (
        "Currency mismatch detected:\n\n"
        + "\n".join(mismatch_warnings)
        + "\n\nReturns and correlations will still be calculated, but incorrect currency labels may make the comparison misleading."
    )


def build_offline_csv_not_enough_data_message(failed_tickers: dict[str, str]) -> str:
    missing = [ticker for ticker, message in failed_tickers.items() if "was not found" in message]
    date_overlap = [ticker for ticker, message in failed_tickers.items() if "no rows overlap" in message]
    other = [ticker for ticker in failed_tickers if ticker not in missing and ticker not in date_overlap]
    selected_ranges = sorted({match for message in failed_tickers.values() for match in re.findall(r"Selected range: ([^\n]+)", message)})
    available_ranges = sorted({match for message in failed_tickers.values() for match in re.findall(r"Available range: ([^\n]+)", message)})

    if not date_overlap:
        return (
            "At least two valid securities are required for comparison.\n\n"
            "See Logs / Warnings for details about missing tickers, date range issues, or CSV format problems."
        )

    lines = [
        "Offline CSV data was found, but the selected date range does not overlap the CSV data.",
        "",
    ]
    if selected_ranges:
        lines.append(f"Selected range: {', '.join(selected_ranges)}")
    if available_ranges:
        lines.append(f"Available CSV date range: {', '.join(available_ranges)}")
    if selected_ranges or available_ranges:
        lines.append("")
    lines.append("The following tickers exist in the Offline CSV data, but have no rows in the selected date range:")
    lines.extend(date_overlap)
    if missing:
        lines.append("")
        lines.append("The following requested tickers were not found in the selected Offline CSV folder:")
        lines.extend(missing)
    if other:
        lines.append("")
        lines.append("Other Offline CSV issues were found. See Logs / Warnings for details.")
    lines.extend(
        [
            "",
            "To test Offline CSV with the included sample, use 2024-01-02 to 2024-01-04.",
            "For live 2025-2026 market data, switch Data Source to Yahoo Finance.",
            "",
            "At least two valid securities are required for comparison, but the main issue appears to be that the selected date range does not overlap the Offline CSV data.",
        ]
    )
    return "\n".join(lines)


def build_offline_csv_failure_summary(failed_tickers: dict[str, str]) -> str:
    missing = [ticker for ticker, message in failed_tickers.items() if "was not found" in message]
    date_overlap = [ticker for ticker, message in failed_tickers.items() if "no rows overlap" in message]
    other = [ticker for ticker in failed_tickers if ticker not in missing and ticker not in date_overlap]
    lines = []
    if date_overlap:
        lines.extend(
            [
                "Offline CSV date range mismatch detected.",
                "",
                "The requested tickers were found, but the selected date range does not overlap the CSV data."
                if not missing
                else "Some requested tickers were found, but the selected date range does not overlap the CSV data for those tickers.",
                "Use the CSV's available date range or switch to Yahoo Finance for live data.",
                "",
            ]
        )
    lines.append("Offline CSV issues were found:")
    if missing:
        lines.append("")
        lines.append("The following tickers were not found in the selected Offline CSV folder:")
        lines.extend(missing)
        lines.append("")
        lines.append("Check that the CSV contains a Ticker column or that one-file-per-ticker CSVs are named like AAPL.csv, MSFT.csv, XIU.TO.csv.")
    if date_overlap:
        lines.append("")
        lines.append("The following tickers exist in the Offline CSV data, but have no rows in the selected date range:")
        lines.extend(date_overlap)
        lines.append("")
        lines.append("The sample CSV in test-files/sample_prices.csv uses dates from 2024-01-02 to 2024-01-04.")
        lines.append("Use that date range for Offline CSV sample testing, or switch Data Source to Yahoo Finance for live 2025-2026 market data.")
    if other:
        lines.append("")
        lines.append("Other Offline CSV issues:")
        for ticker in other:
            lines.append(f"{ticker}: {failed_tickers[ticker]}")
    return "\n".join(lines)


class StockAnalyticsApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(f"Stock Comparison & Analytics Tool {APP_VERSION}")
        self.geometry("1180x760")
        self.minsize(1000, 660)

        self.ticker_rows: list[dict[str, tk.Variable]] = []
        self.current_results: dict[str, object] = {}
        self.plot_image_ref: tk.PhotoImage | None = None
        self.regression_plot_paths: dict[str, str] = {}

        self._build_variables()
        self._build_layout()
        self._set_default_ticker_rows()

    def _build_variables(self) -> None:
        today = dt.date.today()
        self.num_tickers_var = tk.IntVar(value=3)
        self.source_var = tk.StringVar(value="Yahoo Finance")
        self.start_var = tk.StringVar(value=f"{today.year - 1}-01-01")
        self.end_var = tk.StringVar(value=today.isoformat())
        self.frequency_var = tk.StringVar(value="Monthly")
        self.price_type_var = tk.StringVar(value="Adjusted Close")
        self.return_type_var = tk.StringVar(value="Simple returns")
        self.risk_free_var = tk.StringVar(value=str(DEFAULT_RISK_FREE_RATE))
        self.normalize_currency_var = tk.StringVar(value=NORMALIZE_CURRENCY_OPTIONS[0])
        self.regression_mode_var = tk.StringVar(value="Each vs chosen benchmark")
        self.benchmark_var = tk.StringVar(value="")
        self.offline_folder_var = tk.StringVar(value=str(Path(__file__).resolve().parents[1] / "test-files"))
        self.export_folder_var = tk.StringVar(value=str(get_exports_dir()))
        self.chart_type_var = tk.StringVar(value="Indexed Price")
        self.regression_selection_var = tk.StringVar(value="")
        self.source_var.trace_add("write", lambda *_args: self._update_offline_helper_visibility())

    def _build_layout(self) -> None:
        self.columnconfigure(0, weight=0)
        self.columnconfigure(1, weight=1)
        self.rowconfigure(0, weight=1)

        input_frame = ttk.Frame(self, padding=10)
        input_frame.grid(row=0, column=0, sticky="ns")
        output_frame = ttk.Frame(self, padding=(0, 10, 10, 10))
        output_frame.grid(row=0, column=1, sticky="nsew")
        output_frame.rowconfigure(0, weight=1)
        output_frame.columnconfigure(0, weight=1)

        self._build_input_panel(input_frame)
        self._build_output_tabs(output_frame)

    def _build_input_panel(self, parent: ttk.Frame) -> None:
        row = 0
        ttk.Label(parent, text="Securities").grid(row=row, column=0, sticky="w")
        ttk.Spinbox(parent, from_=2, to=MAX_TICKERS, width=6, textvariable=self.num_tickers_var, command=self._sync_ticker_rows).grid(row=row, column=1, sticky="ew")
        ttk.Button(parent, text="Apply", command=self._sync_ticker_rows).grid(row=row, column=2, sticky="ew")

        row += 1
        self.rows_frame = ttk.LabelFrame(parent, text="Tickers", padding=8)
        self.rows_frame.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(8, 8))
        for col, label in enumerate(("Ticker", "Label", "Currency")):
            ttk.Label(self.rows_frame, text=label).grid(row=0, column=col, sticky="w")

        row += 1
        controls = [
            ("Data source", self.source_var, ["Yahoo Finance", "Offline CSV", "Alpha Vantage", "Twelve Data"]),
            ("Frequency", self.frequency_var, ["Daily", "Weekly", "Monthly"]),
            ("Price type", self.price_type_var, ["Close", "Adjusted Close"]),
            ("Return type", self.return_type_var, ["Simple returns", "Log returns"]),
            ("Regression", self.regression_mode_var, ["Each vs chosen benchmark", "Pairwise"]),
        ]
        for label, variable, values in controls:
            ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=2)
            combo = ttk.Combobox(parent, textvariable=variable, values=values, state="readonly", width=24)
            combo.grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
            if label == "Data source":
                combo.bind("<<ComboboxSelected>>", lambda _event: self._update_offline_helper_visibility())
            row += 1

        for label, variable in (("Start date", self.start_var), ("End date", self.end_var), ("Risk-free rate", self.risk_free_var), ("Benchmark", self.benchmark_var)):
            ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=2)
            ttk.Entry(parent, textvariable=variable, width=26).grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
            row += 1

        ttk.Label(parent, text="Normalize to currency").grid(row=row, column=0, sticky="w", pady=2)
        ttk.Combobox(
            parent,
            textvariable=self.normalize_currency_var,
            values=NORMALIZE_CURRENCY_OPTIONS,
            state="readonly",
            width=24,
        ).grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
        row += 1

        ttk.Label(parent, text="Offline folder").grid(row=row, column=0, sticky="w", pady=2)
        ttk.Entry(parent, textvariable=self.offline_folder_var, width=26).grid(row=row, column=1, sticky="ew", pady=2)
        ttk.Button(parent, text="Browse", command=self._browse_offline_folder).grid(row=row, column=2, sticky="ew")

        row += 1
        self.offline_helper_label = ttk.Label(parent, text="Offline CSV sample dates: 2024-01-02 to 2024-01-04", wraplength=280)
        self.offline_helper_label.grid(row=row, column=0, columnspan=3, sticky="w", pady=(0, 4))
        self._offline_helper_grid = self.offline_helper_label.grid_info().copy()

        row += 1
        ttk.Label(parent, text="Export folder").grid(row=row, column=0, sticky="w", pady=2)
        ttk.Entry(parent, textvariable=self.export_folder_var, width=26).grid(row=row, column=1, sticky="ew", pady=2)
        ttk.Button(parent, text="Browse", command=self._browse_export_folder).grid(row=row, column=2, sticky="ew")

        row += 1
        button_frame = ttk.Frame(parent)
        button_frame.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(12, 0))
        for index, (text, command) in enumerate(
            (
                ("Fetch & Analyze", self.run_analysis),
                ("Export Results", self.export_results),
                ("Clear", self.clear_outputs),
            )
        ):
            ttk.Button(button_frame, text=text, command=command).grid(row=index, column=0, sticky="ew", pady=2)
        button_frame.columnconfigure(0, weight=1)

    def _build_output_tabs(self, parent: ttk.Frame) -> None:
        self.notebook = ttk.Notebook(parent)
        self.notebook.grid(row=0, column=0, sticky="nsew")

        self.dashboard_tree = self._make_tree_tab("Dashboard")
        self.correlation_tree = self._make_tree_tab("Correlation Matrix")
        self.regression_tree = self._make_regression_tab()
        self.plots_text = self._make_plots_tab()
        self.diversification_text = self._make_text_tab("Diversification Summary")
        self.logs_text = self._make_text_tab("Logs / Warnings")

    def _make_tree_tab(self, name: str) -> ttk.Treeview:
        frame = ttk.Frame(self.notebook, padding=8)
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        tree = ttk.Treeview(frame, show="headings")
        yscroll = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        xscroll = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
        tree.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)
        tree.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")
        self.notebook.add(frame, text=name)
        return tree

    def _make_text_tab(self, name: str) -> tk.Text:
        frame = ttk.Frame(self.notebook, padding=8)
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        text = tk.Text(frame, wrap="word", height=20)
        scrollbar = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
        text.configure(yscrollcommand=scrollbar.set)
        text.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.notebook.add(frame, text=name)
        return text

    def _make_plots_tab(self) -> tk.Text:
        frame = ttk.Frame(self.notebook, padding=8)
        frame.rowconfigure(1, weight=1)
        frame.columnconfigure(0, weight=1)
        controls = ttk.Frame(frame)
        controls.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(controls, text="Chart type").grid(row=0, column=0, sticky="w")
        self.chart_combo = ttk.Combobox(
            controls,
            textvariable=self.chart_type_var,
            state="readonly",
            values=[
                "Indexed Price",
                "Cumulative Return",
                "Correlation Heatmap",
                "Risk / Return Scatter",
                "Drawdown Chart",
                "Rolling Volatility",
                "Rolling Correlation",
                "Regression Scatter",
            ],
            width=28,
        )
        self.chart_combo.grid(row=0, column=1, sticky="w", padx=(8, 0))
        self.chart_combo.bind("<<ComboboxSelected>>", lambda _event: self.refresh_plot_viewer())
        self.plot_image_label = ttk.Label(frame, anchor="center", text="Run Fetch & Analyze first to generate charts.")
        self.plot_image_label.grid(row=1, column=0, sticky="nsew")
        self.plot_path_var = tk.StringVar(value="")
        ttk.Label(frame, textvariable=self.plot_path_var, wraplength=850).grid(row=2, column=0, sticky="ew", pady=(8, 0))
        self.notebook.add(frame, text="Plots")
        return tk.Text(frame)

    def _make_regression_tab(self) -> ttk.Treeview:
        frame = ttk.Frame(self.notebook, padding=8)
        frame.rowconfigure(2, weight=1)
        frame.columnconfigure(0, weight=1)
        controls = ttk.Frame(frame)
        controls.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(controls, text="Regression").grid(row=0, column=0, sticky="w")
        self.regression_combo = ttk.Combobox(controls, textvariable=self.regression_selection_var, state="readonly", width=28)
        self.regression_combo.grid(row=0, column=1, sticky="w", padx=(8, 0))
        self.regression_combo.bind("<<ComboboxSelected>>", self._update_regression_selection)
        self.regression_summary_text = tk.Text(frame, wrap="word", height=5)
        self.regression_summary_text.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        tree = ttk.Treeview(frame, show="headings")
        tree.grid(row=2, column=0, sticky="nsew")
        self.notebook.add(frame, text="Regression Analysis")
        return tree

    def _set_default_ticker_rows(self) -> None:
        self._sync_ticker_rows()
        defaults = ["AAPL", "MSFT", "XIU.TO"]
        for row, ticker in zip(self.ticker_rows, defaults):
            row["ticker"].set(ticker)
            row["currency"].set(DEFAULT_CURRENCY if ticker != "XIU.TO" else "CAD")
        self.benchmark_var.set("SPY")
        self._update_offline_helper_visibility()

    def _update_offline_helper_visibility(self) -> None:
        if not hasattr(self, "offline_helper_label"):
            return
        if self.source_var.get() == "Offline CSV":
            self.offline_helper_label.grid(**self._offline_helper_grid)
        else:
            self.offline_helper_label.grid_remove()

    def _sync_ticker_rows(self) -> None:
        count = min(max(int(self.num_tickers_var.get()), 2), MAX_TICKERS)
        self.num_tickers_var.set(count)
        while len(self.ticker_rows) < count:
            row_number = len(self.ticker_rows) + 1
            ticker_var = tk.StringVar()
            label_var = tk.StringVar()
            currency_var = tk.StringVar(value=DEFAULT_CURRENCY)
            ttk.Entry(self.rows_frame, textvariable=ticker_var, width=12).grid(row=row_number, column=0, sticky="ew", padx=(0, 4), pady=2)
            ttk.Entry(self.rows_frame, textvariable=label_var, width=16).grid(row=row_number, column=1, sticky="ew", padx=(0, 4), pady=2)
            ttk.Combobox(self.rows_frame, textvariable=currency_var, values=SUPPORTED_CURRENCIES, state="readonly", width=8).grid(row=row_number, column=2, sticky="ew", pady=2)
            self.ticker_rows.append({"ticker": ticker_var, "label": label_var, "currency": currency_var})
        for widget in self.rows_frame.grid_slaves():
            info = widget.grid_info()
            if int(info.get("row", 0)) > count:
                widget.grid_remove()

    def _browse_offline_folder(self) -> None:
        folder = filedialog.askdirectory(initialdir=self.offline_folder_var.get() or ".")
        if folder:
            self.offline_folder_var.set(folder)

    def _browse_export_folder(self) -> None:
        folder = filedialog.askdirectory(initialdir=self.export_folder_var.get() or str(get_exports_dir()))
        if folder:
            self.export_folder_var.set(folder)

    def _collect_settings(self) -> dict:
        tickers = []
        for row in self.ticker_rows[: self.num_tickers_var.get()]:
            ticker = row["ticker"].get().strip().upper()
            if ticker:
                tickers.append({"ticker": ticker, "label": row["label"].get().strip(), "currency": row["currency"].get().strip()})
        if len(tickers) > MAX_TICKERS:
            raise ValueError(f"Enter no more than {MAX_TICKERS} tickers.")
        if len(tickers) < 2:
            raise ValueError("At least two tickers are required.")
        pd.to_datetime(self.start_var.get(), format="%Y-%m-%d")
        pd.to_datetime(self.end_var.get(), format="%Y-%m-%d")
        risk_free_rate = float(self.risk_free_var.get() or 0)
        return {
            "tickers": tickers,
            "source": self.source_var.get(),
            "start": self.start_var.get(),
            "end": self.end_var.get(),
            "frequency": self.frequency_var.get(),
            "price_type": self.price_type_var.get(),
            "return_type": self.return_type_var.get(),
            "risk_free_rate": risk_free_rate,
            "normalize_to": parse_normalization_choice(self.normalize_currency_var.get()),
            "regression_mode": self.regression_mode_var.get(),
            "benchmark": self.benchmark_var.get().strip().upper(),
            "offline_folder": self.offline_folder_var.get().strip(),
            "export_folder": self.export_folder_var.get().strip(),
        }

    def run_analysis(self) -> None:
        try:
            settings = self._collect_settings()
            source = get_data_source(settings["source"], settings["offline_folder"])
            if not source.is_configured():
                messagebox.showwarning("Data source unavailable", f"{settings['source']} is not configured.")
                return
            is_offline_csv = isinstance(source, OfflineCsvSource)
            if is_offline_csv:
                try:
                    source._load()
                except DataSourceError as exc:
                    self._write_logs([str(exc)])
                    messagebox.showwarning("Offline CSV folder problem", str(exc))
                    return

            price_frames: dict[str, pd.DataFrame] = {}
            currencies: dict[str, str] = {}
            selected_currencies: dict[str, str] = {}
            warnings: list[str] = []
            failed_tickers: dict[str, str] = {}
            for ticker_info in settings["tickers"]:
                ticker = ticker_info["ticker"]
                try:
                    result = source.fetch_prices(ticker, settings["start"], settings["end"], settings["price_type"], settings["frequency"])
                    price_frames[ticker] = result.prices
                    selected_currencies[ticker] = ticker_info["currency"]
                    if result.currency:
                        currencies[ticker] = _normalize_currency(result.currency)
                    warnings.extend(result.warnings)
                except Exception as exc:
                    if is_offline_csv:
                        failed_tickers[ticker] = str(exc)
                        warnings.append(f"{ticker}: {exc}")
                        continue
                    detail = f"No usable data was returned for {ticker}. You can remove this ticker, retry with a different symbol, or proceed without it."
                    warnings.append(f"{detail} ({exc})")
                    if len(settings["tickers"]) <= 2 or not messagebox.askyesno("Ticker failed", f"{detail}\n\nProceed without it?"):
                        self._write_logs(warnings)
                        return

            if is_offline_csv and failed_tickers:
                summary = self._offline_failure_summary(failed_tickers)
                warnings.insert(0, summary)
                if len(price_frames) >= 2:
                    messagebox.showwarning("Offline CSV warnings", summary)

            if len(price_frames) < 2:
                if is_offline_csv and failed_tickers:
                    messagebox.showwarning("Offline CSV date range", build_offline_csv_not_enough_data_message(failed_tickers))
                else:
                    messagebox.showwarning("Not enough data", "At least two valid securities are required for comparison.")
                self._write_logs(warnings)
                return

            currency_mismatch_warnings = build_currency_mismatch_warnings(selected_currencies, currencies)
            if currency_mismatch_warnings:
                mismatch_summary = format_currency_mismatch_warning(currency_mismatch_warnings)
                warnings.append(mismatch_summary)
                messagebox.showwarning("Currency mismatch detected", mismatch_summary)

            target_currency = settings["normalize_to"]
            effective_currencies = dict(currencies)
            if target_currency:
                def _fx_provider(native: str, target: str) -> object:
                    return source.fetch_fx_rate(native, target, settings["start"], settings["end"], settings["frequency"])

                price_frames, fx_warnings, effective_currencies = normalize_price_frames_to_currency(
                    price_frames, currencies, target_currency, _fx_provider
                )
                warnings.extend(fx_warnings)
                warnings.append(format_fx_normalization_note(target_currency, settings["source"]))
            else:
                detected = {currency for currency in currencies.values() if currency}
                if len(detected) > 1:
                    warnings.append(MULTI_CURRENCY_WARNING)

            price_column = "Adj Close" if settings["price_type"].startswith("Adjusted") else "Close"
            prices = align_price_series(price_frames, price_column)
            prices.attrs["currencies"] = effective_currencies
            returns = compute_returns(prices, settings["return_type"])
            periods_per_year = get_periods_per_year(settings["frequency"])
            metrics = compute_dashboard_metrics(prices, returns, periods_per_year, settings["risk_free_rate"])
            corr = compute_correlation_matrix(returns)
            risk_free_per_period = settings["risk_free_rate"] / periods_per_year

            requested_benchmark = settings["benchmark"]
            benchmark = requested_benchmark if requested_benchmark in returns.columns else returns.columns[0]
            if requested_benchmark and requested_benchmark not in returns.columns:
                warnings.append(f"Selected benchmark {requested_benchmark} is not part of the current comparison set, so regression and rolling correlation used {benchmark} instead.")
            if settings["regression_mode"] == "Pairwise":
                regressions = run_all_pairwise_regressions(returns, risk_free_per_period)
            else:
                regressions = run_benchmark_regressions(returns, benchmark, risk_free_per_period)

            timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            plots_dir = get_plots_dir()
            rolling_returns, rolling_periods_per_year, rolling_window, rolling_label = self._rolling_chart_inputs(
                prices,
                returns,
                settings["frequency"],
                settings["return_type"],
            )
            plot_paths = {
                "Indexed Price": plot_price_index(prices, str(plots_dir / f"indexed_price_chart_{timestamp}.png")),
                "Cumulative Return": plot_cumulative_returns(returns, str(plots_dir / f"cumulative_return_chart_{timestamp}.png")),
                "Correlation Heatmap": plot_correlation_heatmap(corr, str(plots_dir / f"correlation_heatmap_{timestamp}.png")),
                "Risk / Return Scatter": plot_risk_return_scatter(metrics, str(plots_dir / f"risk_return_scatter_{timestamp}.png")),
                "Drawdown Chart": plot_drawdowns(prices, str(plots_dir / f"drawdown_chart_{timestamp}.png")),
                "Rolling Volatility": plot_rolling_volatility(
                    rolling_returns,
                    rolling_periods_per_year,
                    str(plots_dir / f"rolling_volatility_{timestamp}.png"),
                    rolling_window,
                    rolling_label,
                ),
            }
            if benchmark in rolling_returns.columns and len(rolling_returns.columns) > 1:
                plot_paths["Rolling Correlation"] = plot_rolling_correlation_vs_benchmark(
                    rolling_returns,
                    benchmark,
                    str(plots_dir / f"rolling_correlation_vs_benchmark_{timestamp}.png"),
                    rolling_window,
                    rolling_label,
                )

            self.regression_plot_paths = {}
            if not regressions.empty:
                for index, regression in regressions.iterrows():
                    key = self._regression_key(regression)
                    scatter_path = plot_regression_scatter(
                        returns[regression["X Ticker"]],
                        returns[regression["Y Ticker"]],
                        regression.to_dict(),
                        str(plots_dir / f"regression_scatter_{index}_{timestamp}.png"),
                    )
                    self.regression_plot_paths[key] = scatter_path
                first_key = next(iter(self.regression_plot_paths))
                plot_paths["Regression Scatter"] = self.regression_plot_paths[first_key]

            website_paths = self._copy_website_assets(plot_paths)

            flags = find_diversification_flags(corr)
            for item in flags["high_correlation_pairs"]:
                warnings.append(f"High correlation: {item['pair'][0]} and {item['pair'][1]} at {item['correlation']:.2f}.")

            self.current_results = {
                "metrics": metrics,
                "corr": corr,
                "regressions": regressions,
                "warnings": warnings,
                "plot_paths": plot_paths,
                "website_paths": website_paths,
                "prices": prices,
                "returns": returns,
            }
            self._display_dataframe(self.dashboard_tree, metrics)
            self._display_dataframe(self.correlation_tree, corr.reset_index().rename(columns={"index": "Ticker"}))
            self._display_dataframe(self.regression_tree, regressions)
            self._update_regression_dropdown(regressions)
            self._write_plots(plot_paths)
            self._write_diversification_summary(corr, flags)
            self._write_logs(warnings or ["Analysis completed without warnings."])
        except Exception as exc:
            self._write_logs([str(exc), traceback.format_exc()])
            messagebox.showerror("Analysis failed", str(exc))

    def _display_dataframe(self, tree: ttk.Treeview, frame: pd.DataFrame) -> None:
        tree.delete(*tree.get_children())
        columns = list(frame.columns)
        tree["columns"] = columns
        for column in columns:
            tree.heading(column, text=column)
            tree.column(column, width=max(110, min(210, len(str(column)) * 12)), anchor="center")
        for _, row in frame.iterrows():
            values = []
            for value in row.tolist():
                if isinstance(value, float):
                    values.append("" if pd.isna(value) else f"{value:.6f}")
                else:
                    values.append(value)
            tree.insert("", "end", values=values)

    def _rolling_window(self, frequency: str) -> int:
        normalized = frequency.strip().lower()
        if normalized == "daily":
            return 63
        if normalized == "weekly":
            return 26
        return 12

    def _rolling_chart_inputs(
        self,
        prices: pd.DataFrame,
        returns: pd.DataFrame,
        frequency: str,
        return_type: str,
    ) -> tuple[pd.DataFrame, int, int, str]:
        normalized = frequency.strip().lower()
        if normalized == "daily":
            monthly_prices = prices.resample("ME").last().dropna(how="all")
            monthly_returns = compute_returns(monthly_prices, return_type)
            return monthly_returns, 12, 12, "12-month window"
        if normalized == "weekly":
            return returns, 52, 26, "26-week window"
        if normalized == "monthly":
            return returns, 12, 12, "12-month window"
        return returns, get_periods_per_year(frequency), self._rolling_window(frequency), f"{self._rolling_window(frequency)} periods"

    def _copy_website_assets(self, plot_paths: dict[str, str]) -> dict[str, str]:
        name_map = {
            "Indexed Price": "indexed_price_chart.png",
            "Cumulative Return": "cumulative_return_chart.png",
            "Correlation Heatmap": "correlation_heatmap.png",
            "Risk / Return Scatter": "risk_return_scatter.png",
            "Drawdown Chart": "drawdown_chart.png",
            "Rolling Volatility": "rolling_volatility.png",
        }
        assets_dir = get_website_assets_dir()
        copied = {}
        for chart_name, filename in name_map.items():
            source = plot_paths.get(chart_name)
            if source and Path(source).exists():
                destination = assets_dir / filename
                shutil.copy2(source, destination)
                copied[chart_name] = str(destination)
        return copied

    def _write_plots(self, paths: dict[str, str]) -> None:
        self.chart_combo["values"] = list(paths.keys())
        if self.chart_type_var.get() not in paths and paths:
            self.chart_type_var.set(next(iter(paths)))
        self.refresh_plot_viewer()

    def refresh_plot_viewer(self) -> None:
        plot_paths = self.current_results.get("plot_paths", {}) if self.current_results else {}
        chart_name = self.chart_type_var.get()
        path = plot_paths.get(chart_name) if isinstance(plot_paths, dict) else None
        if not path:
            self.plot_image_label.configure(image="", text="Run Fetch & Analyze first to generate charts.")
            self.plot_image_ref = None
            self.plot_path_var.set("")
            return
        self.display_plot_image(path)

    def display_plot_image(self, path: str) -> None:
        try:
            image = tk.PhotoImage(file=path)
            self.plot_image_ref = image
            self.plot_image_label.configure(image=image, text="")
            self.plot_path_var.set(f"Saved image path: {path}")
        except tk.TclError as exc:
            self.plot_image_ref = None
            self.plot_image_label.configure(image="", text=f"Could not display chart image. Saved image path:\n{path}")
            self.plot_path_var.set(str(exc))

    def _regression_key(self, regression: pd.Series) -> str:
        return f"{regression['Y Ticker']} vs {regression['X Ticker']}"

    def _update_regression_dropdown(self, regressions: pd.DataFrame) -> None:
        keys = [self._regression_key(row) for _, row in regressions.iterrows()] if not regressions.empty else []
        self.regression_combo["values"] = keys
        if keys:
            self.regression_selection_var.set(keys[0])
            self._update_regression_selection()
        else:
            self.regression_selection_var.set("")
            self._write_selected_regression_summary(None)

    def _update_regression_selection(self, _event: object | None = None) -> None:
        selected = self.regression_selection_var.get()
        regressions = self.current_results.get("regressions")
        selected_row = None
        if isinstance(regressions, pd.DataFrame) and not regressions.empty and selected:
            for index, regression in regressions.iterrows():
                if self._regression_key(regression) == selected:
                    selected_row = regression
                    children = self.regression_tree.get_children()
                    if index < len(children):
                        item_id = children[index]
                        self.regression_tree.selection_set(item_id)
                        self.regression_tree.focus(item_id)
                        self.regression_tree.see(item_id)
                    break
        self._write_selected_regression_summary(selected_row)
        if selected and selected in self.regression_plot_paths:
            plot_paths = self.current_results.get("plot_paths", {})
            if isinstance(plot_paths, dict):
                plot_paths["Regression Scatter"] = self.regression_plot_paths[selected]
            if self.chart_type_var.get() == "Regression Scatter":
                self.refresh_plot_viewer()

    def _write_selected_regression_summary(self, regression: pd.Series | None) -> None:
        self.regression_summary_text.delete("1.0", tk.END)
        if regression is None:
            self.regression_summary_text.insert(tk.END, "Selected regression:\nNo regression selected.")
            return
        fields = [
            ("Y ticker", "Y Ticker"),
            ("X ticker", "X Ticker"),
            ("Alpha", "alpha"),
            ("Beta", "beta"),
            ("R-squared", "r_squared"),
            ("Observations", "observations"),
            ("Beta standard error", "beta_standard_error"),
            ("Beta t-stat", "beta_t_stat"),
            ("Beta p-value", "beta_p_value"),
        ]
        lines = ["Selected regression:"]
        for label, column in fields:
            value = regression.get(column, "")
            if isinstance(value, float):
                value = "" if pd.isna(value) else f"{value:.6f}"
            lines.append(f"{label}: {value}")
        self.regression_summary_text.insert(tk.END, "\n".join(lines))

    def _write_diversification_summary(self, corr: pd.DataFrame, flags: dict) -> None:
        lines = []
        pair_values = []
        columns = list(corr.columns)
        for left_index, left in enumerate(columns):
            for right in columns[left_index + 1 :]:
                value = corr.loc[left, right]
                if pd.isna(value):
                    continue
                pair_values.append((left, right, float(value)))
        if pair_values:
            highest = max(pair_values, key=lambda item: item[2])
            lowest = min(pair_values, key=lambda item: item[2])
            lines.append(f"Highest correlated pair: {highest[0]} and {highest[1]} ({highest[2]:.2f})")
            lines.append(f"Lowest correlated pair: {lowest[0]} and {lowest[1]} ({lowest[2]:.2f})")
        else:
            lines.append("No pairwise correlations were available.")
        high = flags.get("high_correlation_pairs", [])
        low = flags.get("low_correlation_pairs", [])
        lines.append("")
        lines.append("Pairs above 0.85 correlation:")
        lines.extend([f"- {item['pair'][0]} and {item['pair'][1]} ({item['correlation']:.2f})" for item in high] or ["- None"])
        lines.append("")
        lines.append("Pairs below 0.30 correlation:")
        lines.extend([f"- {item['pair'][0]} and {item['pair'][1]} ({item['correlation']:.2f})" for item in low] or ["- None"])
        lines.append("")
        lines.append("Interpretation:")
        lines.append("Highly correlated assets may behave similarly and may provide less diversification benefit.")
        lines.append("Lower-correlation assets may improve diversification, but risk, currency, sector, and data quality should also be considered.")
        self.diversification_text.delete("1.0", tk.END)
        self.diversification_text.insert(tk.END, "\n".join(lines))

    def _write_logs(self, warnings: list[str]) -> None:
        self.logs_text.delete("1.0", tk.END)
        self.logs_text.insert(tk.END, "\n".join(warnings))

    def _offline_failure_summary(self, failed_tickers: dict[str, str]) -> str:
        return build_offline_csv_failure_summary(failed_tickers)

    def export_results(self) -> None:
        if not self.current_results:
            messagebox.showwarning("Nothing to export", "Run an analysis before exporting.")
            return
        try:
            timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            exports_dir = ensure_directory(self.export_folder_var.get() or get_exports_dir())
            excel_path = export_results_to_excel(
                str(exports_dir / f"stock_analysis_{timestamp}.xlsx"),
                self.current_results["metrics"],
                self.current_results["corr"],
                self.current_results["regressions"],
                self.current_results["warnings"],
                self.current_results.get("plot_paths"),
            )
            csv_folder = export_results_to_csv_folder(
                str(exports_dir / f"stock_analysis_csv_{timestamp}"),
                self.current_results["metrics"],
                self.current_results["corr"],
                self.current_results["regressions"],
                self.current_results["warnings"],
            )
            image_folder = export_plot_images(exports_dir, self.current_results.get("plot_paths", {}), timestamp, export_jpg=True, export_png=False)
            messagebox.showinfo("Export complete", f"Excel:\n{excel_path}\n\nCSV folder:\n{csv_folder}\n\nImage folder:\n{image_folder}")
        except Exception as exc:
            self._write_logs([*self.current_results.get("warnings", []), f"Export failed: {exc}"])
            messagebox.showwarning("Export failed", str(exc))

    def clear_outputs(self) -> None:
        self.current_results = {}
        for tree in (self.dashboard_tree, self.correlation_tree, self.regression_tree):
            tree.delete(*tree.get_children())
            tree["columns"] = []
        self.plot_image_label.configure(image="", text="Run Fetch & Analyze first to generate charts.")
        self.plot_image_ref = None
        self.plot_path_var.set("")
        self.diversification_text.delete("1.0", tk.END)
        self.regression_summary_text.delete("1.0", tk.END)
        self.logs_text.delete("1.0", tk.END)


def main() -> None:
    app = StockAnalyticsApp()
    app.mainloop()


if __name__ == "__main__":
    main()
