# CPI Dashboard Downloader — User Guide

> **This guide walks you through everything step by step. You do not need to know anything technical.**

---

## What Does This Tool Do?

The CPI Dashboard Downloader is a small program that automatically pulls economic data (CPI, unemployment, interest rates, etc.) from **Statistics Canada** and **FRED** and writes it directly into a specific tab in your Excel workbook — no copy-pasting, no manual downloads required.

You can also optionally export the same data to a **CSV file** at the same time.

---

## How to Set It Up — Just Double-Click

There is **one file** you run: **`Setup_and_Run-cpi_automation.bat`**. It handles everything — it checks for Python, builds a private environment for the program inside this folder, installs the libraries it needs, and then launches the program. You do not open a terminal or install anything by hand.

### Step 1 — Copy the folder

Copy this whole project folder to your computer. If someone shared it with you as a zip, unzip it first.

> 💡 If the folder contains a `.venv` sub-folder, you can safely delete it — the setup file rebuilds it automatically on first run. (It is fine if it isn't there at all.)

### Step 2 — Double-click `Setup_and_Run-cpi_automation.bat`

A black command window opens and shows you what it's doing. **Leave it open** — that window is just the progress log.

- **First time only:** Windows may show a blue **"Windows protected your PC"** box because the file isn't signed. This is normal. Click **More info**, then **Run anyway**. It only happens once.
- **If Python is already on your PC** (most work computers have it): the window prints "Found Python" and goes straight to setting things up. You won't be asked to install anything.
- **If Python is missing:** the window asks *"Install Python now? (Y/N)"*. Press **Y** and Enter. It installs Python **just for your user account** — no admin password needed. When it finishes, it asks you to close the window and double-click the file once more so Windows picks up the new install.

The first run takes a minute or two while it downloads the libraries. After that, every future run is quick.

### Step 3 — Get your free FRED API key (one time)

The program fetches US economic data from the **Federal Reserve Bank of St. Louis (FRED)**, which requires a free personal key (about 2 minutes to get). Statistics Canada data needs no key.

1. Go to [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
2. Click **"Request or view your API keys"** and create a free account (or log in)
3. Copy your key — a long string like `a1b2c3d4e5f6...`
4. You'll paste it into the program once; it remembers it after that.

> 💡 Your API key is personal. Don't share it publicly or commit it to a public GitHub repository.

### Step 4 — Close your Excel workbook before running

The program writes directly into your Excel file, so **Excel must be fully closed** before you click Download, or the file will be locked. You can reopen it afterward.

---

## Using the Program — Step by Step

When setup finishes, a small window appears with the options below. (To run the program again any other day, just double-click `Setup_and_Run-cpi_automation.bat` again — setup is instant once it's been done once.)

### 1. Choose Your Mode

- **Single month** — data for one specific month
- **Date range** — data across multiple months

Click the circle next to whichever you need.

### 2. Enter Your Dates

**Single month:** fill in **Start Year** (e.g. `2024`) and **Start Month** (e.g. `6` for June). The End fields grey out — leave them.

**Date range:** fill in **Start Year/Month** and **End Year/Month**. Example: Start `2023 / 1`, End `2024 / 12` pulls all of 2023 and 2024.

> **Month numbers:** January = 1 … December = 12

> 📋 **For the full historical dataset** (`CPI.xlsx`), use **Start: `1913 / 1`** and **End: the most recent month**. The program automatically splits this large request into smaller chunks behind the scenes — this is normal and expected.

### 3. Select Your Excel Workbook

1. Click **Browse…** next to **Target .xlsm/.xlsx**
2. Find your workbook and click **Open** (both `.xlsm` and `.xlsx` are shown)
3. The full path appears in the box — that's correct

> ⚠️ **Reminder:** Make sure the workbook is **closed in Excel** before clicking Download.

**Supported workbook types:** `.xlsm` (macros preserved) and `.xlsx` (standard).

### 4. Optional — Export to CSV at the Same Time

Check **"Also export to CSV:"**, then click **Browse…** to choose where to save the `.csv`. It's written automatically when you click Download.

> 💡 CSV dates are written in `YYYY-MM-DD` format and open in Excel, Google Sheets, or any data tool.

### 5. Enter Your FRED API Key

Paste the key from Step 3 into the **FRED API Key** field.

- After your first successful download, the key is saved to `files\config.json` and pre-filled next time — you only paste it once.
- Leaving it blank shows a reminder error when you try to download.

> 💡 `files\config.json` stores your key in plain text on your own PC and is excluded from version control via `.gitignore`, so it's never committed.

### 6. Click Download & Write to Excel

The button greys out and says **"Downloading…"** while it fetches live data.

- Large ranges (e.g. 1913 to present) take **2–5 minutes** — the program fetches Statistics Canada data in 10-year chunks to stay within API limits.
- **Do not close the window** while it downloads.

A pop-up confirms how many rows were written and which file(s) were updated.

### 7. Open Your Excel Workbook

Open your workbook and go to the **CPI_Downloader** tab. Data starts at cell A1, headers in row 1, one row per month.

> 💡 **If dates show as a number instead of a date:** select the Date column → right-click → **Format Cells** → **Date**. If that doesn't work: **Data → Text to Columns → Delimited → Next → Next → Finish**, then format as a date.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| The blue "Windows protected your PC" box appears | Normal for an unsigned file. Click **More info** → **Run anyway** (only happens once) |
| The setup window asks to install Python | Press **Y** — it installs just for you, no admin needed. Re-run the file once when it finishes |
| `Permission denied` or `file is locked` error | Make sure your Excel workbook is fully closed and try again |
| `Please enter your FRED API key` error | Paste your API key into the FRED API Key field — see Setup Step 3 |
| FRED returns a `Bad Request` or `API key invalid` error | Double-check you copied the full key with no extra spaces |
| The window appears to freeze during download | Normal for large ranges — the program is working. Wait up to 5 minutes |
| `Sheet 'CPI_Downloader' not found` error | Confirm the tab is named exactly `CPI_Downloader` (capital C, capital D, no spaces) |
| Only `.xlsm` files visible in the file browser | Choose "Excel Workbooks" from the file-type dropdown in the picker — shows both types |
| Data looks correct but dates show as numbers | Format the Date column in Excel as a Date (see tip above) |

---

## What Data Gets Downloaded?

The program pulls 17 columns into your spreadsheet in this exact order:

| Column | Description | Source |
|---|---|---|
| A | Date | — |
| B | Headline CPI – Unadjusted (Canada) | Statistics Canada |
| C | Headline CPI – Seasonally Adjusted (Canada) | Statistics Canada |
| D | Core CPI – Unadjusted (Canada) | Statistics Canada |
| E | Core CPI – Seasonally Adjusted (Canada) | Statistics Canada |
| F | Alberta CPI – Unadjusted | Statistics Canada |
| G | Headline CPI – Unadjusted (US) | FRED |
| H | Headline CPI – Seasonally Adjusted (US) | FRED |
| I | Core CPI – Unadjusted (US) | FRED |
| J | Core CPI – Seasonally Adjusted (US) | FRED |
| K | Unemployment Rate – Seasonally Adjusted (US) | FRED |
| L | Monthly Effective Fed Funds Rate (US) | FRED |
| M | Fed Funds Rate – End of Period (US) | FRED |
| N | S&P 500 by Month (US) | FRED |
| O | 10yr vs 2yr Treasury Spread (US) | FRED |
| P | PCE – Seasonally Adjusted (US) | FRED |
| Q | Core PCE – Seasonally Adjusted (US) | FRED |

---

## Notes for Developers

- **Entry point:** `scripts/cpi_dashboard_downloader-v0.2.0.py` (launched by the `.bat`).
- **Setup/run is self-contained:** `Setup_and_Run-cpi_automation.bat` builds a `.venv` in the repo, installs `scripts/requirements.txt` into it, and never installs anything system-wide except Python itself (and only if missing, user-scope, on a Y/N prompt). It does not depend on any separate `.ps1` script.
- **Copy without the venv:** the `.venv` is gitignored and rebuilds itself on first run, so the repo is fully reproducible from a copy that omits it.
- **Tests / verify:** run `.venv\Scripts\python.exe scripts\verify.py` to check that all dependencies are pinned and the `files/tests/` suite passes.
- You must supply your own FRED API key — none is included in the repository.
