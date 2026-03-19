"""Monte Carlo Retirement Simulator - starter desktop scaffold.

This initial version focuses on UI and input validation so the project
structure is in place on the portfolio site. Simulation export and chart
embedding can be layered in next.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, messagebox


WINDOW_TITLE = "Monte Carlo Retirement Simulator"
WINDOW_SIZE = "480x580"


class MonteCarloApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(WINDOW_TITLE)
        self.root.geometry(WINDOW_SIZE)
        self.root.resizable(False, False)

        self.main = ttk.Frame(root, padding=12)
        self.main.pack(fill=tk.BOTH, expand=True)

        self.entries: dict[str, ttk.Entry] = {}
        self._build_form()

        self.status_var = tk.StringVar(value="Ready. Fill in inputs and run the starter check.")
        status = ttk.Label(self.main, textvariable=self.status_var, foreground="#1f4f8a")
        status.pack(fill=tk.X, pady=(10, 0))

    def _build_form(self) -> None:
        fields = [
            ("Current Portfolio Value ($)", "current_portfolio", ""),
            ("Annual Contribution ($)", "annual_contribution", ""),
            ("Contribution Growth Rate (% / yr)", "contribution_growth", "0"),
            ("Years to Retirement", "years_to_retirement", ""),
            ("Years in Retirement", "years_in_retirement", "25"),
            ("Expected Annual Return (%)", "expected_return", "7.0"),
            ("Annual Volatility / Std Dev (%)", "volatility", "12.0"),
            ("Inflation Rate (%)", "inflation", "2.5"),
            ("Annual Retirement Spending ($)", "annual_spending", ""),
            ("CPP / OAS / Pension Income ($ / yr)", "pension_income", "0"),
            ("Number of Simulations", "simulations", "1000"),
        ]

        for label_text, key, default in fields:
            row = ttk.Frame(self.main)
            row.pack(fill=tk.X, pady=4)

            label = ttk.Label(row, text=label_text)
            label.pack(anchor=tk.W)

            entry = ttk.Entry(row)
            entry.insert(0, default)
            entry.pack(fill=tk.X)
            self.entries[key] = entry

        run_btn = ttk.Button(self.main, text="Run Simulation", command=self.run_starter_check)
        run_btn.pack(fill=tk.X, pady=(10, 0))

    def _read_float(self, key: str, label: str, allow_zero: bool = True) -> float:
        raw = self.entries[key].get().strip()
        try:
            value = float(raw)
        except ValueError as exc:
            raise ValueError(f"{label} must be numeric.") from exc
        if not allow_zero and value <= 0:
            raise ValueError(f"{label} must be greater than 0.")
        if allow_zero and value < 0:
            raise ValueError(f"{label} must be 0 or greater.")
        return value

    def _read_int(self, key: str, label: str, minimum: int = 1) -> int:
        raw = self.entries[key].get().strip()
        try:
            value = int(raw)
        except ValueError as exc:
            raise ValueError(f"{label} must be a whole number.") from exc
        if value < minimum:
            raise ValueError(f"{label} must be {minimum} or greater.")
        return value

    def run_starter_check(self) -> None:
        try:
            self._read_float("current_portfolio", "Current portfolio value", allow_zero=False)
            self._read_float("annual_contribution", "Annual contribution")
            self._read_float("contribution_growth", "Contribution growth rate")
            self._read_int("years_to_retirement", "Years to retirement", minimum=1)
            self._read_int("years_in_retirement", "Years in retirement", minimum=1)
            self._read_float("expected_return", "Expected annual return")
            self._read_float("volatility", "Volatility")
            self._read_float("inflation", "Inflation rate")
            self._read_float("annual_spending", "Annual retirement spending", allow_zero=False)
            self._read_float("pension_income", "CPP / OAS / Pension income")
            runs = self._read_int("simulations", "Number of simulations", minimum=1)
            if runs > 10000:
                raise ValueError("Number of simulations must be 10,000 or fewer.")
        except ValueError as err:
            self.status_var.set(f"Error: {err}")
            messagebox.showerror(WINDOW_TITLE, str(err))
            return

        self.status_var.set("Starter scaffold validated. Full simulation engine is next.")
        messagebox.showinfo(
            WINDOW_TITLE,
            "Input validation passed.\n\n"
            "This starter build sets up the project structure and GUI.\n"
            "Simulation math and Excel export are planned in the next iteration.",
        )


def main() -> None:
    root = tk.Tk()
    app = MonteCarloApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
