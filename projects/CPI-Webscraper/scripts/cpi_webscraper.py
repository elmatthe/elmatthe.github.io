import queue
import threading
import tkinter as tk
import webbrowser
from datetime import date
from pathlib import Path
from tkinter import messagebox, filedialog
from cpi_config import load_config, ensure_config, save_api_key
from data_sources import INCOMPLETE_MONTH_NOTE, Cancelled, build_rows, current_month, normalize_range, request_count
from workbook_io import RECALCULATE_NOTE, write_to_workbook, write_to_csv

VERSION = "0.4.0"
FRED_KEY_URL = "https://fred.stlouisfed.org/docs/api/api_key.html"
YAHOO_DISABLED = ('The optional Yahoo Finance S&P 500 backfill ([sp500_history] add_missing_data = true) is not available '
                  'in this version: Yahoo does not permit automated collection, and S&P 500 history may not be redistributed '
                  'without permission. Set add_missing_data = false in config.toml.')
NOTICES = ('Statistics Canada data: Statistics Canada Open Licence (statcan.gc.ca/en/terms-conditions/open-licence). '
           'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis. '
           'S&P 500 values come from FRED with your own key; S&P Dow Jones Indices restricts their reproduction.')


def download(start, end, api_key, workbook_path, csv_path=None, replace=False, progress=None, cancel=None):
    config = load_config()
    if csv_path and Path(csv_path).suffix.lower() != '.csv':
        raise ValueError('CSV export must use a .csv filename.')
    if config.add_missing_data:
        raise ValueError(YAHOO_DISABLED)
    rows = build_rows(start, end, api_key, add_missing_data=False, progress=progress, cancel=cancel)
    if cancel is not None and cancel():
        raise Cancelled('Download cancelled; workbook was not touched.')
    stats = write_to_workbook(rows, workbook_path, config, replace=replace)
    if csv_path:
        try:
            write_to_csv(rows, csv_path, config)
        except OSError:
            raise ValueError('Excel was saved successfully, but CSV export failed. Check the CSV destination and permissions.') from None
    return rows, config, stats


def parse_months(mode, y, m, y2, m2, today=None):
    """GUI text -> (start, end, note) after clamping to 1913-01 .. the current month."""
    def ym(year, month, label):
        if not (year.isdigit() and month.isdigit() and len(year) == 4 and 1 <= int(month) <= 12):
            raise ValueError(f'Enter the {label} as a 4-digit year and a month from 1 to 12.')
        return f"{int(year):04d}-{int(month):02d}"
    if mode == "single":
        start = end = ym(y, m, "month")
    else:
        start, end = ym(y, m, "start month"), ym(y2, m2, "end month")
        if end < start:
            raise ValueError("End date must be after start date.")
    clamped = normalize_range(start, end, mode == "single", today=today)
    notes = []
    if clamped[0] != start:
        notes.append("Data begins in January 1913; the start was moved to 1913-01.")
    if clamped[1] != end:
        notes.append(f"The end was moved to {clamped[1]}, the current month.")
    if clamped[1] == current_month(today):
        notes.append(INCOMPLETE_MONTH_NOTE)
    return clamped[0], clamped[1], " ".join(notes)


class App:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker = None
        root.title(f"CPI-Webscraper {VERSION} — Direct to Excel")
        root.resizable(False, False)
        f = tk.Frame(root, padx=14, pady=14)
        f.pack()
        self.mode = tk.StringVar(value="single")
        tk.Label(f, text="Mode:").grid(row=0, column=0, sticky="w")
        tk.Radiobutton(f, text="Single month", variable=self.mode, value="single", command=self.on_mode).grid(row=0, column=1, sticky="w")
        tk.Radiobutton(f, text="Date range", variable=self.mode, value="range", command=self.on_mode).grid(row=0, column=2, sticky="w")

        tk.Label(f, text="Start Year (YYYY):").grid(row=1, column=0, sticky="w", pady=(8, 0))
        self.year = tk.Entry(f, width=6); self.year.grid(row=1, column=1, sticky="w", pady=(8, 0))
        tk.Label(f, text="Start Month (1-12):").grid(row=1, column=2, sticky="w", pady=(8, 0))
        self.month = tk.Entry(f, width=4); self.month.grid(row=1, column=3, sticky="w", pady=(8, 0))
        tk.Label(f, text="Data begins January 1913; months after the current month are not requested.",
                 font=("Segoe UI", 9), fg="#555555").grid(row=2, column=0, columnspan=4, sticky="w", pady=(2, 0))
        tk.Label(f, text="End Year (YYYY):").grid(row=3, column=0, sticky="w")
        self.year2 = tk.Entry(f, width=6); self.year2.grid(row=3, column=1, sticky="w")
        tk.Label(f, text="End Month (1-12):").grid(row=3, column=2, sticky="w")
        self.month2 = tk.Entry(f, width=4); self.month2.grid(row=3, column=3, sticky="w")
        self.on_mode()

        tk.Label(f, text="Target .xlsm/.xlsx:").grid(row=4, column=0, sticky="w", pady=(12, 0))
        self.workbook = tk.Entry(f, width=42); self.workbook.grid(row=4, column=1, columnspan=2, sticky="ew", pady=(12, 0))
        tk.Button(f, text="Browse…", command=self.browse_workbook).grid(row=4, column=3, sticky="w", pady=(12, 0), padx=(4, 0))
        self.replace = tk.BooleanVar(value=False)
        tk.Checkbutton(f, text="Replace all rows (otherwise the downloaded months are merged and other months are kept)",
                       variable=self.replace, wraplength=470, justify="left").grid(row=5, column=0, columnspan=4, sticky="w")

        self.csv = tk.BooleanVar(value=False)
        tk.Checkbutton(f, text="Also export to CSV:", variable=self.csv, command=self.on_csv).grid(row=6, column=0, sticky="w", pady=(10, 0))
        self.csv_path = tk.Entry(f, width=42, state="disabled"); self.csv_path.grid(row=6, column=1, columnspan=2, sticky="ew", pady=(10, 0))
        self.csv_button = tk.Button(f, text="Browse…", command=self.browse_csv, state="disabled")
        self.csv_button.grid(row=6, column=3, sticky="w", pady=(10, 0), padx=(4, 0))

        tk.Label(f, text="FRED API Key:").grid(row=7, column=0, sticky="w", pady=(12, 0))
        self.key = tk.Entry(f, width=42, show="*"); self.key.grid(row=7, column=1, columnspan=2, sticky="ew", pady=(12, 0))
        saved = load_config().api_key
        self.key.insert(0, saved)
        self.remember = tk.BooleanVar(value=bool(saved))
        tk.Checkbutton(f, text="Remember on this computer (saved in config.toml as plain text)", variable=self.remember).grid(
            row=8, column=1, columnspan=3, sticky="w")
        link = tk.Label(f, text="Get a free key: fred.stlouisfed.org/docs/api/api_key.html", fg="#1a6faf", cursor="hand2", font=("Segoe UI", 9, "underline"))
        link.grid(row=9, column=1, columnspan=3, sticky="w")
        link.bind("<Button-1>", lambda _e: webbrowser.open(FRED_KEY_URL))

        buttons = tk.Frame(f)
        buttons.grid(row=10, column=0, columnspan=4, pady=(16, 0))
        self.button = tk.Button(buttons, text="Download & Write to Excel", command=self.start, bg="#1a6faf", fg="white",
                                font=("Segoe UI", 10, "bold"), padx=8, pady=4)
        self.button.pack(side="left")
        self.cancel_button = tk.Button(buttons, text="Cancel", command=self.cancel, state="disabled", padx=8, pady=4)
        self.cancel_button.pack(side="left", padx=(8, 0))
        self.status = tk.StringVar(value="")
        tk.Label(f, textvariable=self.status, wraplength=510, justify="left", fg="#1f4f8a", font=("Segoe UI", 9)).grid(
            row=11, column=0, columnspan=4, sticky="w", pady=(8, 0))
        tk.Label(f, text=NOTICES, wraplength=510, justify="left", font=("Segoe UI", 8), fg="#444444").grid(
            row=12, column=0, columnspan=4, pady=(10, 0), sticky="w")

    # ------------------------------------------------------------------ helpers
    def on_mode(self):
        state = "disabled" if self.mode.get() == "single" else "normal"
        self.year2.config(state=state)
        self.month2.config(state=state)

    def on_csv(self):
        state = "normal" if self.csv.get() else "disabled"
        self.csv_path.config(state=state)
        self.csv_button.config(state=state)

    def browse_workbook(self):
        path = filedialog.askopenfilename(title="Select your .xlsm or .xlsx workbook", filetypes=[
            ("Excel Workbooks", "*.xlsm *.xlsx"), ("Excel Macro-Enabled Workbook", "*.xlsm"), ("Excel Workbook", "*.xlsx"), ("All files", "*.*")])
        if path:
            self.workbook.delete(0, tk.END)
            self.workbook.insert(0, path)

    def browse_csv(self):
        path = filedialog.asksaveasfilename(title="Save CSV as…", defaultextension=".csv", filetypes=[("CSV files", "*.csv"), ("All files", "*.*")])
        if path:
            self.csv_path.delete(0, tk.END)
            self.csv_path.insert(0, path)

    def cancel(self):
        self.cancel_event.set()
        self.status.set("Cancelling after the current request…")

    # ------------------------------------------------------------------ run
    def start(self):
        if self.worker is not None:
            return
        api_key = self.key.get().strip()
        workbook = self.workbook.get().strip()
        try:
            if not api_key:
                raise ValueError(f"Please enter your FRED API key.\n\nGet a free key at: {FRED_KEY_URL}")
            start, end, note = parse_months(self.mode.get(), self.year.get().strip(), self.month.get().strip(),
                                            self.year2.get().strip(), self.month2.get().strip())
            if not workbook:
                raise ValueError("Select the target .xlsm or .xlsx workbook.")
            if not workbook.lower().endswith((".xlsm", ".xlsx")):
                raise ValueError("Selected file must be a .xlsm or .xlsx workbook.")
            csv_path = self.csv_path.get().strip() if self.csv.get() else None
            if self.csv.get() and not csv_path:
                raise ValueError("Enter or browse to a destination path for the CSV export.")
            if self.replace.get() and not messagebox.askyesno(
                    "Replace all rows?", f"The raw-data sheet will then hold only {start} to {end}; every other month "
                    "in it is removed (older S&P 500 months cannot be downloaded again). Continue?", icon="warning"):
                return
        except ValueError as e:
            messagebox.showerror("Error", str(e))
            return
        self.cancel_event.clear()
        self.button.config(state="disabled", text="Downloading…")
        self.cancel_button.config(state="normal")
        self.status.set(f"Downloading {start} to {end} ({request_count(start, end)} requests). {note}".strip())
        args = (start, end, api_key, workbook, csv_path, self.replace.get(), self.remember.get())
        self.worker = threading.Thread(target=self.run, args=args, daemon=True)
        self.worker.start()
        self.root.after(100, self.poll)

    def run(self, start, end, api_key, workbook, csv_path, replace, remember):
        try:
            progress = lambda done, total, source: self.events.put(("progress", f"{source}: request {done} of {total}"))  # noqa: E731
            rows, config, stats = download(start, end, api_key, workbook, csv_path, replace, progress, self.cancel_event.is_set)
            self.events.put(("done", (rows, config, stats, api_key, remember, end)))
        except Cancelled as e:
            self.events.put(("cancelled", str(e)))
        except Exception as e:  # noqa: BLE001 - shown to the user; messages are sanitized
            self.events.put(("error", str(e)))

    def poll(self):
        while True:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "progress":
                self.status.set(payload)
                continue
            self.worker = None
            self.button.config(state="normal", text="Download & Write to Excel")
            self.cancel_button.config(state="disabled")
            if kind == "done":
                rows, config, stats, api_key, remember, end = payload
                msg = (f"{len(rows)} months downloaded into '{config.sheet_name}': {stats['updated']} updated, "
                       f"{stats['added']} added, {stats['kept']} other months kept ({stats['rows']} rows in total).")
                if end == current_month():
                    msg += "\n\n" + INCOMPLETE_MONTH_NOTE
                msg += "\n\n" + RECALCULATE_NOTE
                try:
                    if remember:
                        save_api_key(api_key)
                    elif load_config().api_key:
                        save_api_key("")
                except (ValueError, OSError):
                    msg += '\n\nData was written, but the API-key setting could not be updated. Check config.toml permissions.'
                self.status.set(f"Done: {stats['rows']} rows in '{config.sheet_name}'. Recalculate in Excel (Ctrl+Alt+F9).")
                messagebox.showinfo("Done", msg)
            elif kind == "cancelled":
                self.status.set(payload)
            else:
                self.status.set("Error: " + payload)
                messagebox.showerror("Error", payload)
            return
        self.root.after(100, self.poll)


def enable_dpi_awareness():
    """Sharp text at 125% and 150% Windows display scaling (before the window exists)."""
    import sys
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001 - older Windows: fall back to system scaling
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:  # noqa: BLE001
                pass


def main():
    ensure_config()
    enable_dpi_awareness()
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
