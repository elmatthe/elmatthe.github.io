"""CSV and Excel export of a plan, with sources, dates, exchange rates and warnings.

The same columns as the web app's export. Workbooks are written as a NEW file
(never merged into an existing workbook, which could lose that workbook's charts and
drawings); the save dialog asks before replacing a file. Text cells that a
spreadsheet could read as a formula are written as text.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

from portfolio_rebalancer.model import DISCLAIMER, export_fx, export_meta, export_table

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
except ImportError:  # pragma: no cover - the launcher installs openpyxl
    Workbook = None  # type: ignore[assignment,misc]

_FORMULA = re.compile(r"^[=+\-@\t\r\n＝＋－＠]")


def safe_text(value: object) -> object:
    """Prefixes an apostrophe to text a spreadsheet would treat as a formula."""
    if isinstance(value, str) and _FORMULA.match(value):
        return "'" + value
    return value


def _sections(run: dict) -> list[list]:
    notes = run["notes"]["attention"] + run["notes"]["info"]
    rows = export_meta(run) + [[]] + export_table(run) + [[], ["Not in the plan"]]
    rows += [[r.ticker, "not in the plan (0 shares, 0% target)"] for r in run["notValued"]]
    rows += [[]] + export_fx(run) + [[], ["Notes and warnings"]] + [[n] for n in notes] + [[], ["Disclaimer", DISCLAIMER]]
    return rows


def write_csv_export(path: Path, run: dict) -> None:
    with Path(path).open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        for row in _sections(run):
            writer.writerow([safe_text(c) for c in row])


def write_excel_export(path: Path, run: dict) -> None:
    if Workbook is None:
        raise RuntimeError("openpyxl is not installed. Run the setup launcher again.")
    wb = Workbook()
    plan = wb.active
    plan.title = "Trade Plan"
    navy = PatternFill(fill_type="solid", start_color="FF1A2E4A", end_color="FF1A2E4A")
    white = Font(color="FFFFFF", bold=True)
    table = export_table(run)
    for i, row in enumerate(table, start=1):
        for j, value in enumerate(row, start=1):
            cell = plan.cell(row=i, column=j, value=safe_text(value))
            if i == 1:
                cell.fill, cell.font = navy, white
    plan.freeze_panes = "B2"
    summary = wb.create_sheet("Summary")
    meta = export_meta(run)
    rows = meta + [[]] + export_fx(run) + [[], ["Not in the plan"]] + [[r.ticker, "0 shares and a 0% target"] for r in run["notValued"]]
    rows += [[], ["Notes and warnings"]] + [[n] for n in run["notes"]["attention"] + run["notes"]["info"]] + [[], ["Disclaimer", DISCLAIMER]]
    for i, row in enumerate(rows, start=1):
        for j, value in enumerate(row, start=1):
            summary.cell(row=i, column=j, value=safe_text(value))
    summary["A1"].font = Font(bold=True, size=13)
    summary.column_dimensions["A"].width = 30
    summary.column_dimensions["B"].width = 60
    wb.save(path)
