"""Tkinter GUI for the Monte Carlo Retirement Simulator.

Inputs are parsed by monte_carlo.core.parse_raw_inputs, which follows the web app's
rules and messages exactly. The simulation and report writing run on a worker thread;
Tk is only touched on the main thread (results come back through a queue).
"""
from __future__ import annotations

import queue
import sys
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

from monte_carlo.core import (
    FieldError,
    first_year_withdrawal,
    parse_number_text,
    parse_raw_inputs,
    run_monte_carlo,
    typical_growth,
)
from monte_carlo.deps import require_all_dependencies
from monte_carlo.export import new_workbook_path, workbook_risks, write_csv_export, write_excel_report
from monte_carlo.models import (
    ENGINE_VERSION,
    SPENDING_BASES,
    STATUS_ERROR,
    STATUS_NEUTRAL,
    STATUS_SUCCESS,
    STATUS_WARNING,
    WINDOW_MIN_SIZE,
    WINDOW_SIZE,
    WINDOW_TITLE,
    SimulationInputs,
    ValidationError,
)
from monte_carlo.rng import parse_seed, random_seed
from monte_carlo.sample import sample_scenario

# (label, web field key, default) laid out two per row.
FIELDS = [
    ("Current portfolio ($)", "currentPortfolio", ""),
    ("Annual contribution ($)", "annualContribution", ""),
    ("Contribution growth (% / yr)", "contributionGrowth", "0"),
    ("Years to retirement", "yearsToRetirement", ""),
    ("Years in retirement", "yearsInRetirement", "25"),
    ("Simulations (1 to 10,000)", "simulations", "1000"),
    ("Expected return, arithmetic mean (% / yr)", "expectedReturn", "7"),
    ("Volatility, standard deviation (% / yr)", "volatility", "12"),
    ("Inflation (% / yr)", "inflation", "2.5"),
    ("Random seed (blank = new run)", "seed", ""),
    ("Retirement spending ($ / yr)", "annualSpending", ""),
    ("CPP / OAS / pension ($ / yr)", "pensionIncome", "0"),
]
BASIS_CHOICES = {
    "Retirement-year dollars (first year of retirement)": "retirement",
    "Today's dollars (converted with inflation)": "today",
}


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


def money(value: float) -> str:
    return f"${value:,.0f}"


class MonteCarloApp:
    def __init__(self, root: "tk.Tk", ask=None) -> None:
        self.root = root
        self.root.title(WINDOW_TITLE)
        self.root.geometry(WINDOW_SIZE)
        self.root.minsize(*WINDOW_MIN_SIZE)
        # Dialog hook (tests replace it): ask(title, message) -> True/False.
        self.ask = ask or (lambda title, message: messagebox.askyesno(title, message, icon="warning"))

        self.entries: dict[str, ttk.Entry] = {}
        self.workbook_path_var = tk.StringVar(value="")
        self.export_csv_var = tk.BooleanVar(value=False)
        self.csv_path_var = tk.StringVar(value="")
        self.basis_var = tk.StringVar(value=next(iter(BASIS_CHOICES)))
        self.status_var = tk.StringVar(value="Ready. Fill in the inputs and choose a workbook.")
        self.warnings_var = tk.StringVar(value="")
        self.results_var = tk.StringVar(value="")
        self.conversion_var = tk.StringVar(value="")
        self.growth_var = tk.StringVar(value="")

        self.worker_thread: threading.Thread | None = None
        self.worker_events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.is_running = False
        self.last_result = None
        self.last_path: Path | None = None

        self._build_ui()
        self._refresh_notes()

    # ------------------------------------------------------------------ layout
    def _build_ui(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Primary.TButton", foreground="#ffffff", background=STATUS_NEUTRAL)

        frame = ttk.Frame(self.root, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        for col in (1, 3):
            frame.columnconfigure(col, weight=1)
        self.frame = frame

        row = 0
        for index, (label_text, key, default) in enumerate(FIELDS):
            col = (index % 2) * 2
            ttk.Label(frame, text=label_text).grid(row=row, column=col, sticky="w", pady=2, padx=(0 if col == 0 else 12, 6))
            entry = ttk.Entry(frame, width=14)
            entry.insert(0, default)
            entry.grid(row=row, column=col + 1, sticky="ew", pady=2)
            entry.bind("<KeyRelease>", lambda _e: self._refresh_notes())
            self.entries[key] = entry
            if index % 2:
                row += 1

        ttk.Label(frame, text="Spending and pension are in").grid(row=row, column=0, sticky="w", pady=(6, 2))
        self.basis_box = ttk.Combobox(frame, textvariable=self.basis_var, values=list(BASIS_CHOICES), state="readonly")
        self.basis_box.grid(row=row, column=1, columnspan=3, sticky="ew", pady=(6, 2))
        self.basis_box.bind("<<ComboboxSelected>>", lambda _e: self._refresh_notes())
        row += 1
        self.wrapped: list[tk.Label] = []
        for var, colour in ((self.conversion_var, "#333333"), (self.growth_var, "#333333")):
            label = tk.Label(frame, textvariable=var, anchor="w", justify="left", fg=colour, bg=self.root.cget("bg"))
            label.grid(row=row, column=0, columnspan=4, sticky="ew", pady=(1, 1))
            self.wrapped.append(label)
            row += 1
        self.conversion_label, self.growth_label = self.wrapped

        ttk.Separator(frame).grid(row=row, column=0, columnspan=4, sticky="ew", pady=8)
        row += 1

        ttk.Label(frame, text="Target .xlsx workbook").grid(row=row, column=0, sticky="w", pady=2)
        self.workbook_entry = ttk.Entry(frame, textvariable=self.workbook_path_var)
        self.workbook_entry.grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
        self.workbook_button = ttk.Button(frame, text="Browse...", command=self._browse_workbook)
        self.workbook_button.grid(row=row, column=3, sticky="w", pady=2, padx=(6, 0))
        row += 1

        csv_check = ttk.Checkbutton(frame, text="Also export CSV", variable=self.export_csv_var, command=self._toggle_csv_controls)
        csv_check.grid(row=row, column=0, sticky="w", pady=2)
        self.csv_entry = ttk.Entry(frame, textvariable=self.csv_path_var, state="disabled")
        self.csv_entry.grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
        self.csv_button = ttk.Button(frame, text="Browse...", command=self._browse_csv, state="disabled")
        self.csv_button.grid(row=row, column=3, sticky="w", pady=2, padx=(6, 0))
        row += 1

        self.progress = ttk.Progressbar(frame, mode="indeterminate")
        self.progress.grid(row=row, column=0, columnspan=4, sticky="ew", pady=(8, 6))
        row += 1

        buttons = ttk.Frame(frame)
        buttons.grid(row=row, column=0, columnspan=4, sticky="ew")
        buttons.columnconfigure(0, weight=1)
        buttons.columnconfigure(1, weight=1)
        self.sample_button = ttk.Button(buttons, text="Load Sample Scenario", command=self._load_sample_scenario)
        self.sample_button.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self.run_button = ttk.Button(buttons, text="Run Simulation", command=self._on_run_clicked, style="Primary.TButton")
        self.run_button.grid(row=0, column=1, sticky="ew", padx=(4, 0))
        row += 1

        for var, colour in ((self.status_var, STATUS_NEUTRAL), (self.results_var, "#1a2e4a"), (self.warnings_var, STATUS_WARNING)):
            label = tk.Label(frame, textvariable=var, anchor="w", justify="left", fg=colour, bg=self.root.cget("bg"))
            label.grid(row=row, column=0, columnspan=4, sticky="ew", pady=(4, 0))
            self.wrapped.append(label)
            row += 1
        self.status_label, self.results_label, self.warnings_label = self.wrapped[2:]
        ttk.Label(frame, text=f"Engine {ENGINE_VERSION}. Illustrative and educational only; not financial advice.",
                  foreground="#555555").grid(row=row, column=0, columnspan=4, sticky="w", pady=(8, 0))
        frame.bind("<Configure>", self._rewrap)

    def _rewrap(self, event) -> None:
        width = max(event.width - 30, 200)
        for label in self.wrapped:
            label.config(wraplength=width)

    # ------------------------------------------------------------------ helpers
    def raw_inputs(self) -> dict[str, str]:
        raw = {key: entry.get() for key, entry in self.entries.items() if key != "seed"}
        raw["spendingBasis"] = BASIS_CHOICES.get(self.basis_var.get(), "retirement")
        return raw

    def _refresh_notes(self) -> None:
        raw = self.raw_inputs()
        spending = parse_number_text(raw.get("annualSpending"))
        pension = parse_number_text(raw.get("pensionIncome"))
        inflation = parse_number_text(raw.get("inflation"))
        years = parse_number_text(raw.get("yearsToRetirement"))
        basis = raw["spendingBasis"]
        if spending is None or pension is None:
            self.conversion_var.set("Enter spending and pension to see the first-year withdrawal.")
        elif basis == "today" and (inflation is None or years is None or not float(years).is_integer() or years < 1):
            self.conversion_var.set("Enter inflation and years to retirement to convert today's dollars.")
        else:
            probe = SimulationInputs(0, 0, 0, int(years or 0), 1, 0, 0, inflation or 0.0, spending, pension, 1, Path("x.xlsx"), spending_basis=basis)
            first = first_year_withdrawal(probe)
            if basis == "today":
                self.conversion_var.set(
                    f"First-year net withdrawal: {money(first['entered'])} in today's dollars = {money(first['nominal'])} "
                    f"in the first year of retirement (x {first['factor']:.4f} = (1 + inflation)^{int(years)})."
                )
            else:
                self.conversion_var.set(f"First-year net withdrawal: {money(first['nominal'])} in first-retirement-year dollars (spending minus pension).")
        mu = parse_number_text(raw.get("expectedReturn"))
        sigma = parse_number_text(raw.get("volatility"))
        growth = typical_growth(mu, sigma) if mu is not None and sigma is not None and sigma >= 0 else None
        self.growth_var.set(
            f"Typical (median) compound growth at this volatility is about {growth:.2f}% a year; the expected return is an arithmetic mean."
            if growth is not None else ""
        )

    def _toggle_csv_controls(self) -> None:
        enabled = bool(self.export_csv_var.get())
        state = "normal" if enabled else "disabled"
        self.csv_entry.config(state=state)
        self.csv_button.config(state=state)
        if not enabled:
            self.csv_path_var.set("")

    def _load_sample_scenario(self) -> None:
        """Fill the inputs with a fresh, plausible, randomized sample each click."""
        if self.is_running:
            return
        for key, value in sample_scenario().items():
            entry = self.entries[key]
            entry.delete(0, tk.END)
            entry.insert(0, value)
        self._refresh_notes()
        self._set_status("Random sample scenario loaded. Select a target workbook, then Run Simulation.", STATUS_NEUTRAL)

    def _browse_workbook(self) -> None:
        path = filedialog.asksaveasfilename(title="Select target workbook", defaultextension=".xlsx", filetypes=[("Excel workbook", "*.xlsx")])
        if path:
            self.workbook_path_var.set(path)

    def _browse_csv(self) -> None:
        path = filedialog.asksaveasfilename(title="Select CSV output", defaultextension=".csv", filetypes=[("CSV file", "*.csv")])
        if path:
            self.csv_path_var.set(path)

    def _set_status(self, message: str, color: str = STATUS_NEUTRAL) -> None:
        self.status_var.set(message)
        self.status_label.config(fg=color)

    def _show_validation_error(self, message: str, field: str | None = None) -> None:
        self._set_status(f"Error: {message}", STATUS_ERROR)
        if field in self.entries:
            self.entries[field].focus_set()
        messagebox.showerror(WINDOW_TITLE, message)

    def _validate_inputs(self) -> SimulationInputs:
        try:
            seed = parse_seed(self.entries["seed"].get())
        except ValueError as exc:
            error = ValidationError(str(exc))
            error.field = "seed"  # type: ignore[attr-defined]
            raise error from exc
        workbook_raw = self.workbook_path_var.get().strip()
        csv_path: Path | None = None
        if self.export_csv_var.get():
            csv_raw = self.csv_path_var.get().strip()
            csv_path = Path(csv_raw) if csv_raw else None
        inputs = parse_raw_inputs(self.raw_inputs(), error_type=ValidationError, workbook_path=Path(workbook_raw) if workbook_raw else None,
                                  csv_path=csv_path, seed=seed if seed is not None else random_seed())
        if not workbook_raw.lower().endswith(".xlsx"):
            raise ValidationError("Please select a target .xlsx workbook before running.")
        if self.export_csv_var.get() and csv_path is None:
            raise ValidationError("Please select a CSV output path.")
        return inputs

    def _choose_workbook(self, path: Path) -> Path | None:
        """The workbook to write: the chosen one, or a new file when writing into the
        chosen one would lose content openpyxl cannot keep. None = cancelled."""
        risks = workbook_risks(path)
        if not risks:
            return path
        alternative = new_workbook_path(path)
        keep = self.ask(
            WINDOW_TITLE,
            "Writing the report into this workbook would remove content that this program cannot preserve:\n\n- "
            + "\n- ".join(risks)
            + f"\n\nSave the report as a new workbook instead?\n\n{alternative.name}\n\n"
            "Yes: save the new workbook (your workbook is not changed).\nNo: cancel.",
        )
        return alternative if keep else None

    def _set_running_state(self, running: bool) -> None:
        self.is_running = running
        state = "disabled" if running else "normal"
        self.run_button.config(state=state)
        self.sample_button.config(state=state)
        self.workbook_button.config(state=state)
        self.workbook_entry.config(state=state)
        if running:
            self.progress.start(12)
        else:
            self.progress.stop()
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
        except (ValidationError, FieldError) as err:
            self._show_validation_error(str(err), getattr(err, "field", None))
            return
        target = self._choose_workbook(inputs.workbook_path)
        if target is None:
            self._set_status("Cancelled: the workbook was not changed.", STATUS_NEUTRAL)
            return

        self.warnings_var.set("")
        self.results_var.set("")
        self._set_running_state(True)
        self._set_status(f"Running {inputs.simulations:,} simulations (seed {inputs.seed})... please wait.", STATUS_NEUTRAL)
        self.worker_thread = threading.Thread(target=self._run_worker, args=(inputs, target), daemon=True)
        self.worker_thread.start()
        self.root.after(80, self._poll_worker_events)

    def _run_worker(self, inputs: SimulationInputs, target: Path) -> None:
        try:
            result = run_monte_carlo(inputs)
            self.worker_events.put(("status", "Writing results to workbook..."))
            written = write_excel_report(inputs, result, target)
            if inputs.csv_path is not None:
                write_csv_export(inputs.csv_path, result, inputs)
            self.worker_events.put(("success", (inputs, result, written)))
        except PermissionError:
            self.worker_events.put(("error", "The workbook appears to be open. Close it in Excel and try again."))
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
                inputs, result, written = payload  # type: ignore[misc]
                self._set_running_state(False)
                self.last_result, self.last_path = result, written
                count = len(result.warnings)
                where = "Workbook updated" if written == inputs.workbook_path else f"Saved as {written.name}"
                self._set_status(
                    f"Done. {inputs.simulations:,} simulations complete (seed {result.seed}). {where}."
                    + (f" {count} warning{'s' if count != 1 else ''} below." if count else ""),
                    STATUS_WARNING if count else STATUS_SUCCESS,
                )
                self.results_var.set(
                    f"Probability of success {result.success_probability:.1f}% ({result.failed_simulations:,} of {inputs.simulations:,} failed). "
                    f"Median at retirement {money(result.median_portfolio_at_retirement)} nominal. "
                    f"First-year net withdrawal {money(result.net_withdrawal)} ({SPENDING_BASES[result.spending_basis].lower()} basis). "
                    f"Initial withdrawal rate {result.safe_withdrawal_rate:.2f}%."
                )
                self.warnings_var.set("\n".join(f"Warning: {w['message']}" for w in result.warnings))
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
    enable_dpi_awareness()
    root = tk.Tk()
    MonteCarloApp(root)
    root.mainloop()
