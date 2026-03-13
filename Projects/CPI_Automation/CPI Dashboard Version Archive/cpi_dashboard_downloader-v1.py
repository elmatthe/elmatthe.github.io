import tkinter as tk
from tkinter import messagebox, filedialog
import requests
import csv
from datetime import datetime, date
from dateutil.relativedelta import relativedelta

# ========= CONFIGURATION =========

FRED_API_KEY = "719fac656228747786ccc0d9f1a2ced2"
FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"

# Monthly series (one value per month from FRED). [file:4]
FRED_MONTHLY_SERIES = {
    "Headline CPI - Unadjusted (US)": "CPIAUCNS",
    "Headline CPI - Seasonally Adjusted (US)": "CPIAUCSL",
    "Core CPI - Unadjusted (US)": "CPILFENS",
    "Core CPI - Seasonally Adjusted (US)": "CPILFESL",
    "Unemployment Rate - Seasonally Adjusted (US)": "UNRATE",
    "Monthly Effective Fed Fund Rate (US)": "FEDFUNDS",
    "PCE - Seasonally Adjusted (US)": "PCEPI",
    "Core PCE - Seasonally Adjusted (US)": "PCEPILFE",
}

# Daily series where we want end-of-month (or latest) values. [file:4]
FRED_DAILY_EOM_SERIES = {
    "Monthly Fed Fund Rate - EOP (US)": "DFEDTARU",
    "S&P % by month (US)": "SP500",     # S&P 500 index level (end-of-month close)
    "10yr vs 2yr (US)": "T10Y2Y",
}

# Canada columns (placeholder, blank) – still included but can be ignored in Excel. [file:4]
STATCAN_COLUMNS = [
    "Headline CPI - Unadjusted (CDN)",
    "Headline CPI - Seasonally Adjusted (CDN)",
    "Core CPI - Unadjusted (CDN)",
    "Core CPI - Seasonally Adjusted (CDN)",
    "Alberta CPI - Unadjusted (CDN)",
]

# Output order – exactly as requested for US columns, after Date and the CDN placeholders. [file:4]
OUTPUT_COLUMNS = [
    "Date",
    *STATCAN_COLUMNS,
    "Headline CPI - Unadjusted (US)",
    "Headline CPI - Seasonally Adjusted (US)",
    "Core CPI - Unadjusted (US)",
    "Core CPI - Seasonally Adjusted (US)",
    "Unemployment Rate - Seasonally Adjusted (US)",
    "Monthly Fed Fund Rate - EOP (US)",
    "Monthly Effective Fed Fund Rate (US)",
    "S&P % by month (US)",
    "10yr vs 2yr (US)",
    "PCE - Seasonally Adjusted (US)",
    "Core PCE - Seasonally Adjusted (US)",
]

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# ========= HELPER FUNCTIONS =========

def ym_to_label(ym: str) -> str:
    year, month = ym.split("-")
    # Matches your existing format like "Sep-25" once you adjust if needed in Excel. [file:3]
    return f"{MONTH_NAMES[int(month) - 1]}-{int(year) % 100:02d}"

def month_range(start_ym: str, end_ym: str):
    start = datetime.strptime(start_ym, "%Y-%m")
    end = datetime.strptime(end_ym, "%Y-%m")
    cur = start
    while cur <= end:
        yield cur.strftime("%Y-%m")
        cur += relativedelta(months=1)

def fetch_fred_monthly(series_id: str, start_ym: str, end_ym: str):
    """Monthly frequency, one observation per month (average). [file:4]"""
    params = {
        "series_id": series_id,
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "frequency": "m",
        "aggregation_method": "avg",
        "observation_start": f"{start_ym}-01",
        "observation_end": f"{end_ym}-28",
    }
    r = requests.get(FRED_OBS_URL, params=params, timeout=30)
    r.raise_for_status()
    j = r.json()
    out = {}
    for obs in j.get("observations", []):
        dt = obs["date"]
        ym = dt[:7]  # YYYY-MM
        val_str = obs.get("value")
        if not val_str or val_str == ".":
            continue
        try:
            out[ym] = float(val_str)
        except ValueError:
            continue
    return out

def last_day_of_month(d: date) -> date:
    return (d.replace(day=1) + relativedelta(months=1)) - relativedelta(days=1)

def fetch_fred_daily_eom(series_id: str, start_ym: str, end_ym: str):
    """
    Daily frequency; pick the last available observation in each calendar month
    (latest day in that month with data). [file:4]
    """
    start_date = datetime.strptime(start_ym + "-01", "%Y-%m-%d").date()
    end_date = last_day_of_month(datetime.strptime(end_ym + "-01", "%Y-%m-%d").date())
    params = {
        "series_id": series_id,
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "frequency": "d",
        "observation_start": start_date.isoformat(),
        "observation_end": end_date.isoformat(),
    }
    r = requests.get(FRED_OBS_URL, params=params, timeout=30)
    r.raise_for_status()
    j = r.json()
    tmp = {}  # ym -> (latest_date, value)
    for obs in j.get("observations", []):
        dt_str = obs["date"]       # YYYY-MM-DD
        val_str = obs.get("value")
        if not val_str or val_str == ".":
            continue
        try:
            val = float(val_str)
        except ValueError:
            continue
        ym = dt_str[:7]
        d_val = datetime.strptime(dt_str, "%Y-%m-%d").date()
        if ym not in tmp or d_val > tmp[ym][0]:
            tmp[ym] = (d_val, val)
    out = {}
    for ym, (d_val, v) in tmp.items():
        out[ym] = v
    return out

def build_all_series(start_ym: str, end_ym: str):
    # Canada placeholder (blank for now). [file:4]
    statcan_data = {name: {} for name in STATCAN_COLUMNS}

    # US monthly series
    fred_monthly = {}
    for name, sid in FRED_MONTHLY_SERIES.items():
        fred_monthly[name] = fetch_fred_monthly(sid, start_ym, end_ym)

    # US daily series, end-of-month/latest
    fred_eom = {}
    for name, sid in FRED_DAILY_EOM_SERIES.items():
        fred_eom[name] = fetch_fred_daily_eom(sid, start_ym, end_ym)

    return statcan_data, fred_monthly, fred_eom

def build_rows(start_ym: str, end_ym: str):
    statcan_data, fred_monthly, fred_eom = build_all_series(start_ym, end_ym)
    rows = []
    for ym in month_range(start_ym, end_ym):
        row = {col: "" for col in OUTPUT_COLUMNS}
        row["Date"] = ym_to_label(ym)

        # Canada (blank)
        for col in STATCAN_COLUMNS:
            if ym in statcan_data.get(col, {}):
                row[col] = statcan_data[col][ym]

        # US monthly series
        for col_name, series in fred_monthly.items():
            if ym in series:
                row[col_name] = series[ym]

        # US daily EOM series
        for col_name, series in fred_eom.items():
            if ym in series:
                row[col_name] = series[ym]

        rows.append(row)
    return rows

def save_to_csv(rows, filename):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

# ========= GUI =========

def run_download():
    mode = var_mode.get()
    y = entry_year.get().strip()
    m = entry_month.get().strip()
    y2 = entry_year2.get().strip()
    m2 = entry_month2.get().strip()
    try:
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

        filename = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if not filename:
            return

        rows = build_rows(start_ym, end_ym)
        save_to_csv(rows, filename)
        messagebox.showinfo("Done", f"Saved {len(rows)} rows to:\n{filename}")
    except Exception as e:
        messagebox.showerror("Error", str(e))

def on_mode_change():
    if var_mode.get() == "single":
        entry_year2.config(state="disabled")
        entry_month2.config(state="disabled")
    else:
        entry_year2.config(state="normal")
        entry_month2.config(state="normal")

def main():
    global entry_year, entry_month, entry_year2, entry_month2, var_mode
    root = tk.Tk()
    root.title("US CPI Downloader")

    var_mode = tk.StringVar(value="single")

    frame = tk.Frame(root, padx=10, pady=10)
    frame.pack()

    tk.Label(frame, text="Mode:").grid(row=0, column=0, sticky="w")
    tk.Radiobutton(
        frame, text="Single month", variable=var_mode, value="single",
        command=on_mode_change
    ).grid(row=0, column=1, sticky="w")
    tk.Radiobutton(
        frame, text="Date range", variable=var_mode, value="range",
        command=on_mode_change
    ).grid(row=0, column=2, sticky="w")

    tk.Label(frame, text="Start Year (YYYY):").grid(row=1, column=0, sticky="w")
    entry_year = tk.Entry(frame, width=6)
    entry_year.grid(row=1, column=1, sticky="w")

    tk.Label(frame, text="Start Month (1-12):").grid(row=1, column=2, sticky="w")
    entry_month = tk.Entry(frame, width=4)
    entry_month.grid(row=1, column=3, sticky="w")

    tk.Label(frame, text="End Year (YYYY):").grid(row=2, column=0, sticky="w")
    entry_year2 = tk.Entry(frame, width=6)
    entry_year2.grid(row=2, column=1, sticky="w")

    tk.Label(frame, text="End Month (1-12):").grid(row=2, column=2, sticky="w")
    entry_month2 = tk.Entry(frame, width=4)
    entry_month2.grid(row=2, column=3, sticky="w")

    on_mode_change()

    btn = tk.Button(frame, text="Download CPI Data", command=run_download)
    btn.grid(row=3, column=0, columnspan=4, pady=10)

    root.mainloop()

if __name__ == "__main__":
    main()
