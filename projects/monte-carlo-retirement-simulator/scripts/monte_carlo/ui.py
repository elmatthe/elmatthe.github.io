"""Tkinter GUI for the Monte Carlo Retirement Simulator."""
from __future__ import annotations

import queue
import random
import threading
from pathlib import Path

TK_AVAILABLE = True
try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:
    TK_AVAILABLE = False
    tk = None  # type: ignore[assignment]
    filedialog = None  # type: ignore[assignment]
    messagebox = None  # type: ignore[assignment]
    ttk = None  # type: ignore[assignment]

from monte_carlo.core import run_monte_carlo
from monte_carlo.deps import require_all_dependencies
from monte_carlo.export import write_csv_export, write_excel_report
from monte_carlo.models import (
    STATUS_ERROR,
    STATUS_NEUTRAL,
    STATUS_SUCCESS,
    WINDOW_SIZE,
    WINDOW_TITLE,
    SimulationInputs,
    ValidationError,
)


class MonteCarloApp:
    def __init__(self, root: "tk.Tk") -> None:
        self.root = root
        self.root.title(WINDOW_TITLE)
        self.root.geometry(WINDOW_SIZE)
        self.root.resizable(False, False)

        self.entries: dict[str, ttk.Entry] = {}
        self.workbook_path_var = tk.StringVar(value="")
        self.export_csv_var = tk.BooleanVar(value=False)
        self.csv_path_var = tk.StringVar(value="")
        self.status_var = tk.StringVar(value="Ready. Fill in inputs and select a workbook.")

        self.worker_thread: threading.Thread | None = None
        self.worker_events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.is_running = False

        self._build_ui()

    def _build_ui(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Primary.TButton", foreground="#ffffff", background=STATUS_NEUTRAL)

        frame = ttk.Frame(self.root, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        frame.columnconfigure(1, weight=1)

        fields = [
            ("Current Portfolio Value ($)", "current_portfolio", ""),
            ("Annual Contribution ($)", "annual_contribution", ""),
            ("Contribution Growth Rate (% / yr)", "contribution_growth_rate", "0"),
            ("Years to Retirement", "years_to_retirement", ""),
            ("Years in Retirement", "years_in_retirement", "25"),
            ("Expected Annual Return (%)", "expected_return", "7.0"),
            ("Annual Volatility / Std Dev (%)", "volatility", "12.0"),
            ("Inflation Rate (%)", "inflation_rate", "2.5"),
            ("Annual Retirement Spending ($)", "annual_spending", ""),
            ("CPP / OAS / Pension Income ($ / yr)", "pension_income", "0"),
            ("Number of Simulations", "simulations", "1000"),
        ]

        row = 0
        for label_text, key, default in fields:
            ttk.Label(frame, text=label_text).grid(row=row, column=0, sticky="w", pady=2, padx=(0, 8))
            entry = ttk.Entry(frame)
            entry.insert(0, default)
            entry.grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
            self.entries[key] = entry
            row += 1

        csv_check = ttk.Checkbutton(
            frame,
            text="Also export to CSV",
            variable=self.export_csv_var,
            command=self._toggle_csv_controls,
        )
        csv_check.grid(row=row, column=0, columnspan=3, sticky="w", pady=(6, 2))
        row += 1

        ttk.Label(frame, text="CSV Output Path").grid(row=row, column=0, sticky="w", pady=2, padx=(0, 8))
        self.csv_entry = ttk.Entry(frame, textvariable=self.csv_path_var, state="disabled")
        self.csv_entry.grid(row=row, column=1, sticky="ew", pady=2)
        self.csv_button = ttk.Button(frame, text="Browse...", command=self._browse_csv, state="disabled")
        self.csv_button.grid(row=row, column=2, sticky="ew", pady=2, padx=(6, 0))
        row += 1

        ttk.Label(frame, text="Target .xlsx Workbook").grid(row=row, column=0, sticky="w", pady=2, padx=(0, 8))
        self.workbook_entry = ttk.Entry(frame, textvariable=self.workbook_path_var)
        self.workbook_entry.grid(row=row, column=1, sticky="ew", pady=2)
        self.workbook_button = ttk.Button(frame, text="Browse...", command=self._browse_workbook)
        self.workbook_button.grid(row=row, column=2, sticky="ew", pady=2, padx=(6, 0))
        row += 1

        self.progress = ttk.Progressbar(frame, mode="indeterminate")
        self.progress.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(8, 6))
        row += 1

        self.sample_button = ttk.Button(
            frame,
            text="Load Sample Scenario",
            command=self._load_sample_scenario,
        )
        self.sample_button.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(2, 2))
        row += 1

        self.run_button = ttk.Button(
            frame,
            text="Run Simulation",
            command=self._on_run_clicked,
            style="Primary.TButton",
        )
        self.run_button.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(2, 6))
        row += 1

        self.status_label = tk.Label(
            frame,
            textvariable=self.status_var,
            anchor="w",
            fg=STATUS_NEUTRAL,
            bg=self.root.cget("bg"),
        )
        self.status_label.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(2, 0))

    def _toggle_csv_controls(self) -> None:
        enabled = bool(self.export_csv_var.get())
        state = "normal" if enabled else "disabled"
        self.csv_entry.config(state=state)
        self.csv_button.config(state=state)
        if not enabled:
            self.csv_path_var.set("")

    def _load_sample_scenario(self) -> None:
        """Fill the inputs with a fresh, plausible, randomized sample each click.

        Ranges mirror the web simulator and always satisfy input validation.
        """
        if self.is_running:
            return

        def rand_step(low: float, high: float, step: float) -> float:
            steps = int(round((high - low) / step))
            return round(low + step * random.randint(0, steps), 2)

        def put(key: str, value: str) -> None:
            entry = self.entries[key]
            entry.delete(0, tk.END)
            entry.insert(0, value)

        def money(value: float) -> str:
            return str(int(round(value)))

        def trim(value: float) -> str:
            text = f"{value:.2f}".rstrip("0").rstrip(".")
            return text or "0"

        put("current_portfolio", money(rand_step(25000, 750000, 5000)))
        put("annual_contribution", money(rand_step(0, 40000, 1000)))
        put("contribution_growth_rate", trim(rand_step(0, 5, 0.5)))
        put("years_to_retirement", str(random.randint(5, 40)))
        put("years_in_retirement", str(random.randint(15, 35)))
        put("expected_return", trim(rand_step(4, 9, 0.5)))
        put("volatility", trim(rand_step(8, 20, 0.5)))
        put("inflation_rate", trim(rand_step(1.5, 3.5, 0.5)))
        put("annual_spending", money(rand_step(30000, 120000, 5000)))
        put("pension_income", money(rand_step(0, 40000, 1000)))
        put("simulations", str(random.choice([1000, 2000, 5000])))
        self._set_status(
            "Random sample scenario loaded. Select a target workbook, then Run Simulation.",
            STATUS_NEUTRAL,
        )

    def _browse_workbook(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Select target workbook",
            defaultextension=".xlsx",
            filetypes=[("Excel workbook", "*.xlsx")],
        )
        if path:
            self.workbook_path_var.set(path)

    def _browse_csv(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Select CSV output",
            defaultextension=".csv",
            filetypes=[("CSV file", "*.csv")],
        )
        if path:
            self.csv_path_var.set(path)

    def _set_status(self, message: str, color: str = STATUS_NEUTRAL) -> None:
        self.status_var.set(message)
        self.status_label.config(fg=color)

    def _show_validation_error(self, message: str) -> None:
        self._set_status(f"Error: {message}", STATUS_ERROR)
        messagebox.showerror(WINDOW_TITLE, message)

    def _parse_float(self, key: str, message: str, allow_empty: bool = False) -> float:
        raw = self.entries[key].get().strip()
        if raw == "":
            if allow_empty:
                return 0.0
            raise ValidationError(message)
        try:
            return float(raw)
        except ValueError as exc:
            raise ValidationError(message) from exc

    def _parse_int(self, key: str, message: str) -> int:
        raw = self.entries[key].get().strip()
        if raw == "":
            raise ValidationError(message)
        try:
            return int(raw)
        except ValueError as exc:
            raise ValidationError(message) from exc

    def _validate_inputs(self) -> SimulationInputs:
        from monte_carlo.core import validate_simulation_inputs

        current_portfolio = self._parse_float(
            "current_portfolio", "Current portfolio value must be greater than 0."
        )
        if current_portfolio <= 0:
            raise ValidationError("Current portfolio value must be greater than 0.")

        annual_contribution = self._parse_float(
            "annual_contribution", "Enter annual contribution (0 is valid)."
        )
        contribution_growth_rate = self._parse_float(
            "contribution_growth_rate", "Contribution growth rate must be a number (0 is valid)."
        )

        years_to_retirement = self._parse_int(
            "years_to_retirement", "Years to retirement must be a whole number of 1 or more."
        )
        if years_to_retirement < 1:
            raise ValidationError("Years to retirement must be a whole number of 1 or more.")

        years_in_retirement = self._parse_int(
            "years_in_retirement", "Years in retirement must be a whole number of 1 or more."
        )
        if years_in_retirement < 1:
            raise ValidationError("Years in retirement must be a whole number of 1 or more.")

        expected_return = self._parse_float("expected_return", "Expected annual return must be a number.")

        volatility = self._parse_float("volatility", "Volatility must be 0 or greater.")
        if volatility < 0:
            raise ValidationError("Volatility must be 0 or greater.")

        inflation_rate = self._parse_float("inflation_rate", "Inflation rate must be a number (0 is valid).")

        annual_spending = self._parse_float(
            "annual_spending", "Annual retirement spending must be greater than 0."
        )
        if annual_spending <= 0:
            raise ValidationError("Annual retirement spending must be greater than 0.")

        pension_income = self._parse_float(
            "pension_income", "CPP/OAS/Pension income must be a number (0 is valid)."
        )

        simulations = self._parse_int(
            "simulations", "Number of simulations must be a whole number between 1 and 10,000."
        )
        if simulations < 1 or simulations > 10000:
            raise ValidationError("Number of simulations must be a whole number between 1 and 10,000.")

        workbook_raw = self.workbook_path_var.get().strip()
        if not workbook_raw.lower().endswith(".xlsx"):
            raise ValidationError("Please select a target .xlsx workbook before running.")
        workbook_path = Path(workbook_raw)

        csv_path: Path | None = None
        if self.export_csv_var.get():
            csv_raw = self.csv_path_var.get().strip()
            if not csv_raw:
                raise ValidationError("Please select a CSV output path.")
            csv_path = Path(csv_raw)

        parsed_inputs = SimulationInputs(
            current_portfolio=current_portfolio,
            annual_contribution=annual_contribution,
            contribution_growth_rate=contribution_growth_rate,
            years_to_retirement=years_to_retirement,
            years_in_retirement=years_in_retirement,
            expected_return=expected_return,
            volatility=volatility,
            inflation_rate=inflation_rate,
            annual_spending=annual_spending,
            pension_income=pension_income,
            simulations=simulations,
            workbook_path=workbook_path,
            csv_path=csv_path,
        )
        validate_simulation_inputs(parsed_inputs, error_type=ValidationError)
        return parsed_inputs

    def _set_running_state(self, running: bool) -> None:
        self.is_running = running
        run_state = "disabled" if running else "normal"
        browse_state = "disabled" if running else "normal"
        self.run_button.config(state=run_state)
        self.sample_button.config(state=run_state)
        self.workbook_button.config(state=browse_state)
        self.workbook_entry.config(state=("disabled" if running else "normal"))

        if running:
            self.progress.start(12)
        else:
            self.progress.stop()
            self.workbook_entry.config(state="normal")
        self._toggle_csv_controls()
        if running and self.export_csv_var.get():
            self.csv_entry.config(state="disabled")
            self.csv_button.config(state="disabled")

    def _on_run_clicked(self) -> None:
        if self.is_running:
            return

        try:
            require_all_dependencies()
        except RuntimeError as err:
            self._show_validation_error(str(err))
            return

        try:
            inputs = self._validate_inputs()
        except ValidationError as err:
            self._show_validation_error(str(err))
            return

        self._set_running_state(True)
        self._set_status(f"Running {inputs.simulations:,} simulations... please wait.", STATUS_NEUTRAL)

        self.worker_thread = threading.Thread(target=self._run_worker, args=(inputs,), daemon=True)
        self.worker_thread.start()
        self.root.after(80, self._poll_worker_events)

    def _run_worker(self, inputs: SimulationInputs) -> None:
        try:
            result = run_monte_carlo(inputs)
            self.worker_events.put(("status", "Writing results to workbook..."))
            write_excel_report(inputs, result)
            if inputs.csv_path is not None:
                write_csv_export(inputs.csv_path, result)
            self.worker_events.put(("success", (inputs, result)))
        except PermissionError:
            self.worker_events.put(
                ("error", "The workbook appears to be open. Close it in Excel and try again.")
            )
        except Exception as err:  # pylint: disable=broad-except
            self.worker_events.put(("error", str(err)))

    def _poll_worker_events(self) -> None:
        while True:
            try:
                event, payload = self.worker_events.get_nowait()
            except queue.Empty:
                break

            if event == "status":
                self._set_status(str(payload), STATUS_NEUTRAL)
            elif event == "success":
                inputs, _result = payload  # type: ignore[misc]
                self._set_running_state(False)
                self._set_status(
                    f"Done. {inputs.simulations:,} simulations complete. Workbook updated.",
                    STATUS_SUCCESS,
                )
            elif event == "error":
                self._set_running_state(False)
                error_message = str(payload)
                self._set_status(f"Error: {error_message}", STATUS_ERROR)
                messagebox.showerror(WINDOW_TITLE, error_message)

        if self.is_running:
            self.root.after(80, self._poll_worker_events)


def main() -> None:
    if not TK_AVAILABLE:
        raise RuntimeError(
            "tkinter is not available in this Python environment. "
            "Install tkinter support to run the desktop GUI."
        )

    root = tk.Tk()
    MonteCarloApp(root)
    root.mainloop()
