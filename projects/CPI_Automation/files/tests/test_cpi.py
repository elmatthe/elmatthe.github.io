"""
Fast, no-network unit tests for the CPI Dashboard Downloader.

These exercise the pure helper functions and the CSV writer so a regression
in date math, column order, or CSV formatting is caught mechanically. The
downloader module has a hyphen/dot in its filename, so it is loaded by path
via importlib rather than a plain import. Importing it does NOT open the GUI
(the tkinter window is only built inside main(), under __main__).
"""

import csv
import importlib.util
from datetime import date
from pathlib import Path

# ── Load the downloader module by file path ────────────────────────────────
# This file lives at files/tests/test_cpi.py, so the repo root (and thus the
# scripts/ folder) is three levels up.
_SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"
_MODULE_PATH = _SCRIPTS / "cpi_dashboard_downloader-v0.2.0.py"

_spec = importlib.util.spec_from_file_location("cpi_downloader", _MODULE_PATH)
cpi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpi)


def test_ym_to_date():
    assert cpi.ym_to_date("2020-03") == date(2020, 3, 1)
    assert cpi.ym_to_date("1913-01") == date(1913, 1, 1)


def test_month_range_inclusive():
    months = list(cpi.month_range("2020-01", "2020-03"))
    assert months == ["2020-01", "2020-02", "2020-03"]


def test_month_range_single_month():
    assert list(cpi.month_range("2024-06", "2024-06")) == ["2024-06"]


def test_last_day_of_month_handles_leap_year():
    assert cpi.last_day_of_month(date(2020, 2, 15)) == date(2020, 2, 29)
    assert cpi.last_day_of_month(date(2021, 2, 1)) == date(2021, 2, 28)
    assert cpi.last_day_of_month(date(2023, 12, 10)) == date(2023, 12, 31)


def test_output_columns_shape():
    # 17 columns (A–Q), Date first, no duplicates.
    assert len(cpi.OUTPUT_COLUMNS) == 17
    assert cpi.OUTPUT_COLUMNS[0] == "Date"
    assert len(set(cpi.OUTPUT_COLUMNS)) == len(cpi.OUTPUT_COLUMNS)


def test_write_to_csv_roundtrip(tmp_path):
    rows = [
        {col: None for col in cpi.OUTPUT_COLUMNS},
        {col: None for col in cpi.OUTPUT_COLUMNS},
    ]
    rows[0]["Date"] = date(2024, 1, 1)
    rows[0]["Headline CPI - Unadjusted CDN"] = 158.3
    rows[1]["Date"] = date(2024, 2, 1)

    out = tmp_path / "out.csv"
    cpi.write_to_csv(rows, str(out))

    with open(out, newline="", encoding="utf-8") as f:
        read = list(csv.reader(f))

    assert read[0] == cpi.OUTPUT_COLUMNS            # header row
    assert read[1][0] == "2024-01-01"               # date formatted YYYY-MM-DD
    assert read[1][1] == "158.3"                    # value preserved
    assert read[2][0] == "2024-02-01"
