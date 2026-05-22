import tkinter as tk
from tkinter import messagebox, filedialog
import requests
import csv
from datetime import datetime, date
from dateutil.relativedelta import relativedelta

# ========= CONFIGURATION =========

FRED_API_KEY = "719fac656228747786ccc0d9f1a2ced2"
FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"

# StatCan WDS base (REST)
STATCAN_WDS_BASE = "https://www150.statcan.gc.ca/t1/wds/rest"

# ---- StatCan vectors (numeric ids, no leading 'v') ----
# Updated: Core CPI - Seasonally Adjusted (CDN) now uses 41690924 (ex‑food & energy). [file:52]
STATCAN_VECTORS = {
    "Headline CPI - Unadjusted (CDN)": 41690973,
    "Headline CPI - Seasonally Adjusted (CDN)": 41690914,
    "Core CPI - Unadjusted (CDN)": 41691233,
    "Core CPI - Seasonally Adjusted (CDN)": 41690924,  # <-- changed from 41690923
    "Alberta CPI - Unadjusted (CDN)": 41692327,
}

STATCAN_COLUMNS = list(STATCAN_VECTORS.keys())

# Monthly US series (one value per month from FRED).
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

# Daily US series where we want end-of-month (or latest) values.
FRED_DAILY_EOM_SERIES = {
    "Monthly Fed Fund Rate - EOP (US)": "DFEDTARU",
    "S&P % by month (US)": "SP500",
    "10yr vs 2yr (US)": "T10Y2Y",
}

# Output order – same as your CSV.
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

# ========= HELPER =========

def ym_to_label(ym: str) -> str:
    year, month = ym.split("-")
    return f"{MONTH_NAMES[int(month) - 1][0:3]}-{int(year) % 100:02d}"

def month_range(start_ym: str, end_ym: str):
    start = datetime.strptime(start_ym, "%Y-%m")
    end = datetime.strptime(end_ym, "%Y-%m")
    cur = start
    while cur <= end:
        yield cur.strftime("%Y-%m")
        cur += relativedelta(months=1)

# ========= STATCAN FETCH via latestN =========

def fetch_statcan_vector_latest(vector_id: int, start_ym: str, end_ym: str, latest_n: int = 1500):
    """
    Use getDataFromVectorsAndLatestNPeriods.
    POST body must be a list of objects.
    Returns dict {'YYYY-MM': value} clipped to [start_ym, end_ym].
    """
    url = f"{STATCAN_WDS_BASE}/getDataFromVectorsAndLatestNPeriods"
    payload = [{"vectorId": vector_id, "latestN": latest_n}]
    r = requests.post(url, json=payload, timeout=30)
    r.raise_for_status()
    j = r.json()
    data = {}
    for item in j:
        if item.get("status") != "SUCCESS":
            continue
        obj = item.get("object", {})
        for dp in obj.get("vectorDataPoint", []):
            ref = dp.get("refPer")  # e.g., "2025-09-01"
            val = dp.get("value")
            if not ref or val is None:
                continue
            ym = ref[:7]
            if ym < start_ym or ym > end_ym:
                continue
            try:
                data[ym] = float(val)
            except ValueError:
                continue
    return data

def fetch_all_statcan(start_ym: str, end_ym: str):
    out = {}
    for col, vec_id in STATCAN_VECTORS.items():
        out[col] = fetch_statcan_vector_latest(vec_id, start_ym, end_ym)
    return out

# ========= FRED FETCH (US) – UNCHANGED =========

def fetch_fred_monthly(series_id: str, start_ym: str, end_ym: str):
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
        ym = dt[:7]
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
    tmp = {}
    for obs in j.get("observations", []):
        dt_str = obs["date"]
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

# ========= BUILD SERIES AND ROWS =========

def build_all_series(start_ym: str, end_ym: str):
    statcan_data = fetch_all_statcan(start_ym, end_ym)
    fred_monthly = {
        name: fetch_fred_monthly(sid, start_ym, end_ym)
        for name, sid in FRED_MONTHLY_SERIES.items()
    }
    fred_eom = {
        name: fetch_fred_daily_eom(sid, start_ym, end_ym)
        for name, sid in FRED_DAILY_EOM_SERIES.items()
    }
    return statcan_data, fred_monthly, fred_eom

def build_rows(start_ym: str, end_ym: str):
    statcan_data, fred_monthly, fred_eom = build_all_series(start_ym, end_ym)
    rows = []
    for ym in month_range(start_ym, end_ym):
        row = {col: "" for col in OUTPUT_COLUMNS}
        row["Date"] = ym_to_label(ym)

        # Canada
        for col in STATCAN_COLUMNS:
            if ym in statcan_data.get(col, {}):
                row[col] = statcan_data[col][ym]

        # US monthly
        for col_name, series in fred_monthly.items():
            if ym in series:
                row[col_name] = series[ym]

        # US daily EOM
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
    root.title("CPI Dashboard Downloader (Canada + US)")

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
