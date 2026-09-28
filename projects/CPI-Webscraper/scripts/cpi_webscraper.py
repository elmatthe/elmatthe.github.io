import tkinter as tk
from pathlib import Path
from tkinter import messagebox, filedialog
from cpi_config import load_config, ensure_config, save_api_key
from data_sources import MIN_YM, build_rows, normalize_range
from workbook_io import write_to_workbook, write_to_csv

VERSION = "0.3.0"

def download(start, end, api_key, workbook_path, csv_path=None):
    config = load_config()
    if csv_path and Path(csv_path).suffix.lower() != '.csv':
        raise ValueError('CSV export must use a .csv filename.')
    rows = build_rows(start, end, api_key, add_missing_data=config.add_missing_data)
    write_to_workbook(rows, workbook_path, config)
    if csv_path:
        try:
            write_to_csv(rows, csv_path, config)
        except OSError:
            raise ValueError('Excel was saved successfully, but CSV export failed. Check the CSV destination and permissions.') from None
    return rows, config


def run_download():
    mode = var_mode.get()
    y = entry_year.get().strip()
    m = entry_month.get().strip()
    y2 = entry_year2.get().strip()
    m2 = entry_month2.get().strip()
    workbook_path = entry_xlsm.get().strip()
    export_csv = var_csv.get()
    csv_path = entry_csv.get().strip()
    api_key = entry_apikey.get().strip()

    try:
        # Validate FRED API key
        if not api_key:
            raise ValueError(
                "Please enter your FRED API key.\n\n"
                "Get a free key at: https://fred.stlouisfed.org/docs/api/api_key.html"
            )

        # Validate date inputs
        if mode == "single":
            if not (y and m):
                raise ValueError("Enter year and month.")
            start_ym = end_ym = f"{int(y):04d}-{int(m):02d}"
        else:
            if not (y and m and y2 and m2):
                raise ValueError("Enter both start and end year/month.")
            start_ym = f"{int(y):04d}-{int(m):02d}"
            end_ym = f"{int(y2):04d}-{int(m2):02d}"
            if end_ym < start_ym:
                raise ValueError("End date must be after start date.")

        start_ym, end_ym = normalize_range(start_ym, end_ym, mode == "single")

        # Validate workbook path
        if not workbook_path:
            raise ValueError("Select the target .xlsm or .xlsx workbook.")
        if not workbook_path.lower().endswith((".xlsm", ".xlsx")):
            raise ValueError("Selected file must be a .xlsm or .xlsx workbook.")

        # Validate CSV path if export is enabled
        if export_csv and not csv_path:
            raise ValueError("Enter or browse to a destination path for the CSV export.")

        btn.config(state="disabled", text="Downloading…")
        root.update_idletasks()

        rows, config = download(start_ym, end_ym, api_key, workbook_path, csv_path if export_csv else None)
        msg = f"{len(rows)} rows written to '{config.sheet_name}'."

        try:
            save_api_key(api_key)
        except (ValueError, OSError):
            msg += '\nData was written, but the API key could not be saved. Check config.toml permissions or save the key there manually.'
        messagebox.showinfo("Done", msg)

    except Exception as e:
        messagebox.showerror("Error", str(e))

    finally:
        btn.config(state="normal", text="Download & Write to Excel")

def browse_xlsm():
    path = filedialog.askopenfilename(
        title="Select your .xlsm or .xlsx workbook",
        filetypes=[("Excel Workbooks", "*.xlsm *.xlsx"),
                   ("Excel Macro-Enabled Workbook", "*.xlsm"),
                   ("Excel Workbook", "*.xlsx"),
                   ("All files", "*.*")]
    )
    if path:
        entry_xlsm.delete(0, tk.END)
        entry_xlsm.insert(0, path)

def browse_csv():
    path = filedialog.asksaveasfilename(
        title="Save CSV as…",
        defaultextension=".csv",
        filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
    )
    if path:
        entry_csv.delete(0, tk.END)
        entry_csv.insert(0, path)

def on_csv_toggle():
    state = "normal" if var_csv.get() else "disabled"
    entry_csv.config(state=state)
    btn_csv.config(state=state)

def on_mode_change():
    if var_mode.get() == "single":
        entry_year2.config(state="disabled")
        entry_month2.config(state="disabled")
    else:
        entry_year2.config(state="normal")
        entry_month2.config(state="normal")

def main():
    global entry_year, entry_month, entry_year2, entry_month2, var_mode
    global entry_xlsm, entry_csv, btn_csv, var_csv, entry_apikey, btn, root

    ensure_config()
    root = tk.Tk()
    root.title("CPI-Webscraper 0.3.0 — Direct to Excel")
    root.resizable(False, False)

    frame = tk.Frame(root, padx=14, pady=14)
    frame.pack()

    # ── Mode ──────────────────────────────────────────────────────────────────
    var_mode = tk.StringVar(value="single")
    tk.Label(frame, text="Mode:").grid(row=0, column=0, sticky="w")
    tk.Radiobutton(frame, text="Single month", variable=var_mode,
                   value="single", command=on_mode_change).grid(row=0, column=1, sticky="w")
    tk.Radiobutton(frame, text="Date range", variable=var_mode,
                   value="range", command=on_mode_change).grid(row=0, column=2, sticky="w")

    # ── Start date ────────────────────────────────────────────────────────────
    tk.Label(frame, text="Start Year (YYYY):").grid(row=1, column=0, sticky="w", pady=(8, 0))
    entry_year = tk.Entry(frame, width=6)
    entry_year.grid(row=1, column=1, sticky="w", pady=(8, 0))

    tk.Label(frame, text="Start Month (1-12):").grid(row=1, column=2, sticky="w", pady=(8, 0))
    entry_month = tk.Entry(frame, width=4)
    entry_month.grid(row=1, column=3, sticky="w", pady=(8, 0))

    # ── Min-date hint ─────────────────────────────────────────────────────────
    tk.Label(frame, text="Data availability begins January 1913. Earlier dates will be adjusted automatically.",
             font=("Segoe UI", 7), fg="#666666").grid(
        row=2, column=0, columnspan=4, sticky="w", pady=(2, 0))

    # ── End date ──────────────────────────────────────────────────────────────
    tk.Label(frame, text="End Year (YYYY):").grid(row=3, column=0, sticky="w")
    entry_year2 = tk.Entry(frame, width=6)
    entry_year2.grid(row=3, column=1, sticky="w")

    tk.Label(frame, text="End Month (1-12):").grid(row=3, column=2, sticky="w")
    entry_month2 = tk.Entry(frame, width=4)
    entry_month2.grid(row=3, column=3, sticky="w")

    on_mode_change()

    # ── Workbook picker ───────────────────────────────────────────────────────
    tk.Label(frame, text="Target .xlsm/.xlsx:").grid(row=4, column=0, sticky="w", pady=(12, 0))
    entry_xlsm = tk.Entry(frame, width=42)
    entry_xlsm.grid(row=4, column=1, columnspan=2, sticky="ew", pady=(12, 0))
    tk.Button(frame, text="Browse…", command=browse_xlsm).grid(
        row=4, column=3, sticky="w", pady=(12, 0), padx=(4, 0))

    # ── CSV export ────────────────────────────────────────────────────────────
    var_csv = tk.BooleanVar(value=False)
    tk.Checkbutton(frame, text="Also export to CSV:", variable=var_csv,
                   command=on_csv_toggle).grid(row=5, column=0, sticky="w", pady=(10, 0))
    entry_csv = tk.Entry(frame, width=42, state="disabled")
    entry_csv.grid(row=5, column=1, columnspan=2, sticky="ew", pady=(10, 0))
    btn_csv = tk.Button(frame, text="Browse…", command=browse_csv, state="disabled")
    btn_csv.grid(row=5, column=3, sticky="w", pady=(10, 0), padx=(4, 0))

    # ── FRED API key ──────────────────────────────────────────────────────────
    tk.Label(frame, text="FRED API Key:").grid(row=6, column=0, sticky="w", pady=(12, 0))
    entry_apikey = tk.Entry(frame, width=42, show="*")
    entry_apikey.grid(row=6, column=1, columnspan=2, sticky="ew", pady=(12, 0))
    entry_apikey.insert(0, load_config().api_key)
    tk.Label(frame, text="fred.stlouisfed.org/docs/api/api_key.html",
             fg="#1a6faf", cursor="hand2", font=("Segoe UI", 7)).grid(
        row=7, column=1, columnspan=3, sticky="w")

    # ── Action button ─────────────────────────────────────────────────────────
    btn = tk.Button(frame, text="Download & Write to Excel",
                    command=run_download, bg="#1a6faf", fg="white",
                    font=("Segoe UI", 10, "bold"), padx=8, pady=4)
    btn.grid(row=8, column=0, columnspan=4, pady=(16, 0))

    tk.Label(frame, text="This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.", wraplength=510, font=("Segoe UI", 7)).grid(row=9, column=0, columnspan=4, pady=(10, 0))
    root.mainloop()

if __name__ == "__main__":
    main()
