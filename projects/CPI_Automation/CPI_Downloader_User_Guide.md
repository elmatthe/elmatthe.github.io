# CPI Dashboard Downloader — User Guide

> **This guide walks you through everything step by step.**

---

## What Does This Tool Do?

The CPI Dashboard Downloader is a small program that automatically pulls economic data (CPI, unemployment, interest rates, etc.) from **Statistics Canada** and **FRED** and writes it directly into a specific tab in your Excel workbook — no copy-pasting, no manual downloads required.

You can also optionally export the same data to a **CSV file** at the same time.

---

## Before You Use It — One-Time Setup

You only need to do these steps once.

### Step 1 — Make Sure Python Is Installed

Python is the engine that runs this script. To check if you have it:

1. Press the **Windows key**, type `cmd` or `powershell`, and press **Enter** to open a command window
2. Type the following and press **Enter**:
   ```
   python --version
   ```
3. If you see something like `Python 3.13.0` you're good to go
4. If you get an error, download Python for free at [python.org/downloads](https://www.python.org/downloads/) — click the big **Download** button and run the installer. **Make sure to check the box that says "Add Python to PATH"** during installation

---

### Step 2 — Install the Required Libraries

The script needs a few helper packages. In the same command window:

1. Copy and paste the line below, then press **Enter**:
   ```
   pip install openpyxl requests python-dateutil
   ```
2. Wait for it to finish — you'll see text scrolling and a prompt again when it's done

---

### Step 3 — Get Your Free FRED API Key

The script fetches US economic data from the **Federal Reserve Bank of St. Louis (FRED)**. FRED requires a free personal API key to access their data — it takes about 2 minutes to get one.

1. Go to [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html)
2. Click **"Request or view your API keys"**
3. Create a free account (or log in if you already have one)
4. Once logged in, your API key will be displayed — it looks like a long string of letters and numbers, e.g. `a1b2c3d4e5f6...`
5. Copy it and keep it somewhere handy — you'll paste it into the program each time you run it

> 💡 Your API key is personal. Don't share it publicly or commit it to a public GitHub repository.

---

### Step 4 — Close Your Excel Workbook

The script writes directly into your Excel file. **Excel must be fully closed before you run the script**, otherwise the file will be locked and the script can't save. You can reopen Excel after the script finishes.

---

## How to Run the Script

1. Find the file called **`cpi_dashboard_downloader-v7.py`** on your computer
2. **Right-click → Open With → Python**

A small window will appear with all the options described below.

---

## Using the Program — Step by Step

### 1. Choose Your Mode

At the top you'll see two options:

- **Single month** — use this if you only want data for one specific month
- **Date range** — use this if you want data across multiple months

Click the circle next to whichever you need.

---

### 2. Enter Your Dates

**If you chose Single month:**
- Fill in **Start Year** (e.g. `2024`) and **Start Month** (e.g. `6` for June)
- The End Year and End Month fields will be greyed out — leave them alone

**If you chose Date range:**
- Fill in **Start Year** and **Start Month** for the earliest month you want
- Fill in **End Year** and **End Month** for the latest month you want
- Example: Start `2023 / 1` and End `2024 / 12` pulls all of 2023 and 2024

> **Month numbers:** January = 1, February = 2 … December = 12

> 📋 **For the full historical dataset** (`CPI.xlsm`), always use **Start: `1913 / 1`** and **End: the most recent available month**. The script automatically splits this large request into smaller chunks behind the scenes to stay within Statistics Canada's data limits — this is normal and expected.

---

### 3. Select Your Excel Workbook

1. Click **Browse…** next to the **Target .xlsm/.xlsx** field
2. A file picker window will open — navigate to where your Excel workbook is saved
3. The file browser shows **both `.xlsm` and `.xlsx` files** by default. Select your workbook and click **Open**
4. The full file path will appear in the box — this is correct

> ⚠️ **Reminder:** Make sure the workbook is **closed in Excel** before clicking Download.

**Supported workbook types:**
- `.xlsm` — Excel macro-enabled workbooks (VBA macros are preserved)
- `.xlsx` — Standard Excel workbooks

---

### 4. Optional — Export to CSV at the Same Time

If you also want to save the data as a CSV file:

1. Check the box labelled **"Also export to CSV:"**
2. The CSV path field and its **Browse…** button will activate
3. Click **Browse…** and choose where to save the `.csv` file and what to name it
4. The CSV will be written automatically when you click Download — no extra steps needed

> 💡 CSV dates are written in `YYYY-MM-DD` format and open easily in Excel, Google Sheets, or any data tool.

If you don't need a CSV, leave the checkbox unchecked.

---

### 5. Enter Your FRED API Key

In the **FRED API Key** field near the bottom of the window, paste in the API key you obtained in Setup Step 3.

- The key is not saved between sessions — you'll need to paste it each time you open the program
- If the field is left blank, the script will show an error when you try to download and remind you where to get a key
- The URL `fred.stlouisfed.org/docs/api/api_key.html` is shown below the field as a quick reminder

---

### 6. Click Download & Write to Excel

Click the blue **Download & Write to Excel** button.

- The button will grey out and say **"Downloading…"** — the program is fetching live data from Statistics Canada and FRED
- For large date ranges (e.g. 1913 to present), expect this to take **2–5 minutes** — the script fetches Statistics Canada data in 10-year chunks to stay within API limits
- **Do not close the window** while it is downloading

When it finishes, a pop-up will confirm how many rows were written and which file(s) were updated.

---

### 7. Open Your Excel Workbook

Open your workbook in Excel and navigate to the **CPI_Downloader** tab. Your data will be there starting at cell A1, with headers in row 1 and one row per month below.

> 💡 **If dates show as a number instead of a date:** Select the Date column → right-click → **Format Cells** → choose **Date** and pick your preferred format (e.g. `mmmm yyyy`).
>
> If that doesn't work: select the column → go to **Data → Text to Columns → Delimited → Next → Next → Finish**, then format the column as a date.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Double-clicking the script opens Notepad instead of running | Right-click → **Open with** → **Python** |
| `No module named openpyxl` error | Re-run Step 2 of the setup above |
| `Permission denied` or `file is locked` error | Make sure your Excel workbook is fully closed and try again |
| `Please enter your FRED API key` error | Paste your API key into the FRED API Key field — see Setup Step 3 |
| FRED returns a `Bad Request` or `API key invalid` error | Double-check you copied the full key correctly with no extra spaces |
| The window appears to freeze during download | This is normal for large date ranges — the script is working. Wait up to 5 minutes |
| `Sheet 'CPI_Downloader' not found` error | Open your workbook and confirm the tab is named exactly `CPI_Downloader` (capital C, capital D, no spaces) |
| Only `.xlsm` files visible in the file browser | Select "Excel Workbooks" from the file type dropdown at the bottom of the file picker — this shows both types |
| Data looks correct but dates show as numbers | Format the Date column in Excel as a Date (see tip above) |
| Download is slow on a big date range | Expected — Statistics Canada limits data per request, so the script breaks it into 10-year chunks automatically |

---

## What Data Gets Downloaded?

The script pulls the following 17 columns into your spreadsheet in this exact order:

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

## Notes for GitHub Users

If you're cloning this from GitHub, the only file you need to run is **`cpi_dashboard_downloader-v7.py`**. Complete setup instructions are in Steps 1–3 above.

You will need to supply your own FRED API key — no API key is included in the repository. Get one free at [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html). Statistics Canada data requires no key.
