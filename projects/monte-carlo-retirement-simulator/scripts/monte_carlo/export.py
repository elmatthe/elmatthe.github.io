"""Excel report (summary, percentiles, embedded chart) and CSV export.

Every export records what is needed to reproduce the run: all inputs, the spending
basis, the random seed and generator, the engine version and the model. The CSV has
the same layout as the web app's CSV export.
"""
from __future__ import annotations

import csv
import datetime as dt
import posixpath
import re
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from monte_carlo.deps import (
    Alignment,
    Font,
    FuncFormatter,
    PatternFill,
    Workbook,
    XLImage,
    load_workbook,
    plt,
    require_export_deps,
)
from monte_carlo.models import (
    BRAND_NAVY,
    BRAND_NAVY_ARGB,
    MODEL_NOTE,
    SPENDING_BASES,
    SimulationInputs,
    SimulationResult,
)

REPORT_SHEETS = ("MC_Summary", "MC_Percentiles", "MC_Chart")
APP_TITLE = "Monte Carlo Retirement Simulator"
_FORMULA_PREFIX = re.compile(r"^[=+\-@\t\r\n＝＋－＠]")

_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

# Relationship types (by their last path segment) whose content openpyxl does not keep
# when it loads and re-saves a workbook.
_LOST_RELATIONSHIPS = {
    "drawing": "pictures, shapes, text boxes or charts",
    "pivotTable": "a pivot table",
    "control": "form controls",
    "ctrlProp": "form controls",
    "oleObject": "embedded objects",
    "slicer": "slicers",
    "timeline": "timelines",
}


def safe_text(value) -> str:
    """Neutralise spreadsheet formula injection in text cells (as the web export does)."""
    text = str(value)
    return f"'{text}" if _FORMULA_PREFIX.match(text) else text


def js_number(value) -> str:
    """Numbers written as the web app's CSV writes them (String(number) in JavaScript)."""
    number = float(value)
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    return repr(number)


def raw_input_pairs(inputs: SimulationInputs) -> list[tuple[str, float | int | str]]:
    return [
        ("currentPortfolio", inputs.current_portfolio),
        ("annualContribution", inputs.annual_contribution),
        ("contributionGrowth", inputs.contribution_growth_rate),
        ("yearsToRetirement", inputs.years_to_retirement),
        ("yearsInRetirement", inputs.years_in_retirement),
        ("expectedReturn", inputs.expected_return),
        ("volatility", inputs.volatility),
        ("inflation", inputs.inflation_rate),
        ("annualSpending", inputs.annual_spending),
        ("pensionIncome", inputs.pension_income),
        ("simulations", inputs.simulations),
        ("spendingBasis", inputs.spending_basis),
    ]


def workbook_risks(path: Path) -> list[str]:
    """Content of an existing .xlsx that would be lost when the report is written into it.

    openpyxl keeps cell values, formulas and formatting but drops pictures, shapes,
    text boxes, charts, pivot tables, form controls, slicers and some Excel extensions.
    The report's own sheets (MC_*) are replaced anyway and are not counted.
    """
    path = Path(path)
    if not path.exists():
        return []
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return ["the file is not a valid .xlsx workbook"]
    with archive:
        names = set(archive.namelist())

        def read_xml(name: str):
            try:
                return ET.fromstring(archive.read(name))
            except (KeyError, ET.ParseError):
                return None

        def rels_of(part: str) -> list[tuple[str, str]]:
            folder, file = posixpath.split(part)
            root = read_xml(posixpath.join(folder, "_rels", f"{file}.rels"))
            if root is None:
                return []
            out = []
            for rel in root.findall(f"{{{_NS_PKG}}}Relationship"):
                kind = rel.get("Type", "").rsplit("/", 1)[-1]
                target = rel.get("Target", "")
                if rel.get("TargetMode") != "External":
                    target = posixpath.normpath(posixpath.join(folder, target)) if not target.startswith("/") else target.lstrip("/")
                out.append((kind, target))
            return out

        workbook = read_xml("xl/workbook.xml")
        if workbook is None:
            return ["the workbook structure could not be read"]
        rel_root = read_xml("xl/_rels/workbook.xml.rels")
        targets = {}
        if rel_root is not None:
            for rel in rel_root.findall(f"{{{_NS_PKG}}}Relationship"):
                target = rel.get("Target", "")
                targets[rel.get("Id")] = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        risks: list[str] = []
        sheets = workbook.find(f"{{{_NS_MAIN}}}sheets")
        for sheet in (sheets if sheets is not None else []):
            name = sheet.get("name", "")
            if name in REPORT_SHEETS:
                continue
            part = targets.get(sheet.get(f"{{{_NS_REL}}}id"), "")
            if "chartsheets/" in part:
                risks.append(f"chart sheet '{name}'")
                continue
            found = []
            for kind, _target in rels_of(part):
                label = _LOST_RELATIONSHIPS.get(kind)
                if label and label not in found:
                    found.append(label)
            try:
                if b"<extLst" in archive.read(part) or b":extLst" in archive.read(part):
                    found.append("Excel extensions such as sparklines or extended conditional formatting")
            except KeyError:
                pass
            if found:
                risks.append(f"sheet '{name}': " + ", ".join(found))
        for prefix, label in (("xl/slicerCaches/", "slicers"), ("xl/timelineCaches/", "timelines")):
            if any(n.startswith(prefix) for n in names) and not any(label in r for r in risks):
                risks.append(f"workbook {label}")
        return risks


def new_workbook_path(path: Path) -> Path:
    """A free 'name (Monte Carlo report).xlsx' next to `path`."""
    path = Path(path)
    candidate = path.with_name(f"{path.stem} (Monte Carlo report).xlsx")
    counter = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem} (Monte Carlo report {counter}).xlsx")
        counter += 1
    return candidate


def _replace_or_create_sheet(workbook: "Workbook", title: str):  # type: ignore[type-arg]
    if title in workbook.sheetnames:
        idx = workbook.sheetnames.index(title)
        del workbook[title]
        return workbook.create_sheet(title=title, index=idx)
    return workbook.create_sheet(title=title)


def summary_rows(inputs: SimulationInputs, result: SimulationResult) -> list[tuple[str, object, str | None]]:
    """(label, value, number format) rows for the summary sheet; None marks a blank row."""
    total_years = inputs.years_to_retirement + inputs.years_in_retirement
    real_retirement = result.real(result.median_portfolio_at_retirement, inputs.years_to_retirement)
    real_final = result.real(result.median_final_value, total_years)
    basis_label = SPENDING_BASES.get(result.spending_basis, result.spending_basis)
    factor_text = (
        f"x {result.inflation_factor_to_retirement:.6f} = (1 + inflation)^{inputs.years_to_retirement}"
        if result.spending_basis == "today" else "x 1 (already in retirement-year dollars)"
    )
    rows: list[tuple[str, object, str | None]] = [
        ("Run date", dt.date.today().isoformat(), None),
        ("Engine version", result.engine_version, None),
        ("Random seed", result.seed if result.seed is not None else "n/a", None),
        ("Random generator", result.rng, None),
        ("Simulations run", inputs.simulations, None),
        ("Current portfolio", inputs.current_portfolio, "$#,##0.00"),
        ("Annual contribution", inputs.annual_contribution, "$#,##0.00"),
        ("Contribution growth rate", inputs.contribution_growth_rate / 100.0, "0.00%"),
        ("Years to retirement", inputs.years_to_retirement, None),
        ("Years in retirement", inputs.years_in_retirement, None),
        ("Expected return (arithmetic mean)", inputs.expected_return / 100.0, "0.00%"),
        ("Volatility (standard deviation)", inputs.volatility / 100.0, "0.00%"),
        ("Inflation rate", inputs.inflation_rate / 100.0, "0.00%"),
        ("Spending and pension entered in", basis_label, None),
        ("Annual retirement spending (as entered)", inputs.annual_spending, "$#,##0.00"),
        ("CPP / OAS / Pension income (as entered)", inputs.pension_income, "$#,##0.00"),
        ("Net withdrawal as entered", result.net_withdrawal_entered, "$#,##0.00"),
        ("Conversion to retirement-year dollars", factor_text, None),
        ("First-year net withdrawal (retirement-year dollars)", result.net_withdrawal, "$#,##0.00"),
        (None, None, None),  # type: ignore[list-item]
        ("RESULTS", None, "heading"),
        ("Probability of success", result.success_probability / 100.0, "0.0%"),
        ("Median portfolio at retirement (nominal)", result.median_portfolio_at_retirement, "$#,##0.00"),
        ("Median portfolio at retirement (today's dollars)", real_retirement if real_retirement is not None else "n/a", "$#,##0.00"),
        ("Median final portfolio value (nominal)", result.median_final_value, "$#,##0.00"),
        ("Median final portfolio value (today's dollars)", real_final if real_final is not None else "n/a", "$#,##0.00"),
        ("10th percentile final value (nominal)", result.p10_final_value, "$#,##0.00"),
        ("90th percentile final value (nominal)", result.p90_final_value, "$#,##0.00"),
        ("Initial withdrawal rate (first-year net withdrawal / median at retirement)", result.safe_withdrawal_rate / 100.0, "0.00%"),
        ("Failed simulations", f"{result.failed_simulations} of {inputs.simulations}", None),
        (
            "Median ruin year (failed paths only)",
            f"Year {result.median_ruin_year:.1f} of retirement" if result.median_ruin_year is not None else "N/A - no failures",
            None,
        ),
        (None, None, None),  # type: ignore[list-item]
        ("Model", MODEL_NOTE, None),
    ]
    if result.warnings:
        for index, warning in enumerate(result.warnings, start=1):
            rows.append((f"Warning {index}", warning["message"], None))
    else:
        rows.append(("Warnings", "None", None))
    return rows


def _write_summary_sheet(sheet, inputs: SimulationInputs, result: SimulationResult) -> None:
    assert Font is not None and PatternFill is not None and Alignment is not None

    navy_fill = PatternFill(fill_type="solid", start_color=BRAND_NAVY_ARGB, end_color=BRAND_NAVY_ARGB)
    white_bold = Font(color="FFFFFF", bold=True)
    heading_font = Font(bold=True)

    sheet.merge_cells("A1:B1")
    header = sheet["A1"]
    header.value = "Monte Carlo Simulation Summary"
    header.fill = navy_fill
    header.font = white_bold
    header.alignment = Alignment(horizontal="center")

    row_idx = 3
    for label, value, number_format in summary_rows(inputs, result):
        if label is None:
            row_idx += 1
            continue
        if number_format == "heading":
            sheet.cell(row=row_idx, column=1, value=label).font = Font(bold=True, color=BRAND_NAVY_ARGB)
            row_idx += 1
            continue
        sheet.cell(row=row_idx, column=1, value=label).font = heading_font
        cell = sheet.cell(row=row_idx, column=2, value=safe_text(value) if isinstance(value, str) else value)
        if number_format and not isinstance(value, str):
            cell.number_format = number_format
        if isinstance(value, str) and len(value) > 40:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        if label == "Probability of success":
            colour = "C6EFCE" if result.success_probability >= 85 else "FFEB9C" if result.success_probability >= 70 else "FFC7CE"
            cell.fill = PatternFill(fill_type="solid", start_color=colour, end_color=colour)
        row_idx += 1

    sheet.column_dimensions["A"].width = 52
    sheet.column_dimensions["B"].width = 60


def _write_percentiles_sheet(sheet, inputs: SimulationInputs, result: SimulationResult) -> None:
    assert Font is not None and PatternFill is not None

    keys = ("P10", "P25", "P50 (Median)", "P75", "P90")
    headers = ["Year", *[f"{k} nominal" for k in keys], *[f"{k} today's $" for k in keys], "Phase marker"]
    header_fill = PatternFill(fill_type="solid", start_color=BRAND_NAVY_ARGB, end_color=BRAND_NAVY_ARGB)
    header_font = Font(color="FFFFFF", bold=True)

    for col_idx, header in enumerate(headers, start=1):
        cell = sheet.cell(row=1, column=col_idx, value=header)
        cell.fill = header_fill
        cell.font = header_font

    series = (result.p10, result.p25, result.p50, result.p75, result.p90)
    for idx, year in enumerate(result.years, start=2):
        year_i = int(year)
        sheet.cell(row=idx, column=1, value=year_i)
        for offset, values in enumerate(series):
            nominal = float(values[year_i])
            sheet.cell(row=idx, column=2 + offset, value=nominal).number_format = "$#,##0.00"
            real = result.real(nominal, year_i)
            sheet.cell(row=idx, column=7 + offset, value=real if real is not None else "n/a").number_format = "$#,##0.00"
        if year_i == inputs.years_to_retirement:
            marker_cell = sheet.cell(row=idx, column=12, value="RETIREMENT BEGINS")
            marker_cell.fill = PatternFill(fill_type="solid", start_color="D9E2F3", end_color="D9E2F3")
            marker_cell.font = Font(bold=True)

    sheet.column_dimensions["A"].width = 8
    for col in "BCDEFGHIJK":
        sheet.column_dimensions[col].width = 17
    sheet.column_dimensions["L"].width = 22
    sheet.freeze_panes = "B2"


def _render_chart_image(result: SimulationResult, retirement_year: int) -> Path:
    require_export_deps()
    assert plt is not None and FuncFormatter is not None

    fig, axis = plt.subplots(figsize=(11, 5.8))
    years = result.years

    axis.fill_between(years, result.p10, result.p90, color=BRAND_NAVY, alpha=0.20, label="10th-90th percentile")
    axis.fill_between(years, result.p25, result.p75, color=BRAND_NAVY, alpha=0.35, label="25th-75th percentile")
    axis.plot(years, result.p50, color=BRAND_NAVY, linewidth=2.0, label="Median")
    axis.axvline(retirement_year, color="#3d5f8e", linestyle="--", linewidth=1.5)

    axis.set_title("Monte Carlo Simulation - Portfolio Projection (nominal dollars)")
    axis.set_xlabel("Years")
    axis.set_ylabel("Portfolio value ($, nominal)")
    axis.grid(alpha=0.18)
    axis.legend(loc="upper left")

    ylim = axis.get_ylim()
    axis.text(min(retirement_year + 0.6, years[-1]), ylim[1] * 0.95, "Retirement", color="#2c476d", fontsize=10)

    axis.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"${value:,.0f}"))
    fig.tight_layout()

    temp_file = tempfile.NamedTemporaryFile(prefix="mc_chart_", suffix=".png", delete=False)
    temp_path = Path(temp_file.name)
    temp_file.close()
    fig.savefig(temp_path, dpi=150)
    plt.close(fig)
    return temp_path


def _write_chart_sheet(sheet, result: SimulationResult, retirement_year: int) -> Path:
    assert XLImage is not None

    chart_path = _render_chart_image(result, retirement_year)
    img = XLImage(str(chart_path))
    img.width = 980
    img.height = 520
    sheet.add_image(img, "A1")
    return chart_path


def write_excel_report(inputs: SimulationInputs, result: SimulationResult, workbook_path: Path | None = None) -> Path:
    """Write MC_Summary, MC_Percentiles and MC_Chart; returns the path written.

    Writing into an existing workbook replaces only the MC_* sheets. Callers should
    check workbook_risks() first: openpyxl cannot keep pictures, shapes, charts or
    pivot tables on the other sheets.
    """
    require_export_deps()
    assert Workbook is not None and load_workbook is not None

    workbook_path = Path(workbook_path or inputs.workbook_path)
    workbook_is_new = not workbook_path.exists()
    workbook = Workbook() if workbook_is_new else load_workbook(workbook_path)

    summary_sheet = _replace_or_create_sheet(workbook, "MC_Summary")
    percentiles_sheet = _replace_or_create_sheet(workbook, "MC_Percentiles")
    chart_sheet = _replace_or_create_sheet(workbook, "MC_Chart")

    # Remove openpyxl's default blank sheet only for newly created workbooks.
    if workbook_is_new and "Sheet" in workbook.sheetnames:
        del workbook["Sheet"]

    _write_summary_sheet(summary_sheet, inputs, result)
    _write_percentiles_sheet(percentiles_sheet, inputs, result)
    chart_path = _write_chart_sheet(chart_sheet, result, inputs.years_to_retirement)
    workbook.properties.creator = APP_TITLE
    workbook.properties.lastModifiedBy = APP_TITLE

    try:
        try:
            workbook.save(workbook_path)
        except PermissionError as exc:
            raise PermissionError(
                "The workbook appears to be open. Close it in Excel and try again."
            ) from exc
    finally:
        chart_path.unlink(missing_ok=True)
    return workbook_path


def csv_rows(inputs: SimulationInputs, result: SimulationResult, title: str = f"{APP_TITLE} - desktop export") -> list[list]:
    """Rows in the same layout as the web app's CSV export."""
    total_years = inputs.years_to_retirement + inputs.years_in_retirement
    rows: list[list] = [
        [title, dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")],
        ["Probability of success (%)", result.success_probability],
        ["Failed simulations", result.failed_simulations, "of", inputs.simulations],
        ["Initial withdrawal rate (%)", result.safe_withdrawal_rate],
        ["Spending basis", SPENDING_BASES.get(result.spending_basis, result.spending_basis)],
        ["First-year net withdrawal (retirement-year dollars)", result.net_withdrawal],
        ["Inputs", *[f"{k}={js_number(v) if not isinstance(v, str) else v}" for k, v in raw_input_pairs(inputs)]],
        ["Random seed", result.seed if result.seed is not None else ""],
        ["Random generator", result.rng],
        ["Engine version", result.engine_version],
        ["Model", MODEL_NOTE],
        ["Warnings", *([w["message"] for w in result.warnings] or ["None"])],
        [],
        ["Year", "P10 nominal", "P25 nominal", "Median nominal", "P75 nominal", "P90 nominal",
         "P10 real", "P25 real", "Median real", "P75 real", "P90 real"],
    ]
    series = (result.p10, result.p25, result.p50, result.p75, result.p90)
    for year in range(total_years + 1):
        nominal = [float(values[year]) for values in series]
        rows.append([year, *nominal, *[result.real(v, year) for v in nominal]])
    return rows


def write_csv_export(csv_path: Path, result: SimulationResult, inputs: SimulationInputs | None = None) -> None:
    if inputs is None:
        raise ValueError("write_csv_export needs the simulation inputs.")
    with Path(csv_path).open("w", newline="", encoding="utf-8-sig") as csv_file:
        writer = csv.writer(csv_file, lineterminator="\r\n")
        for row in csv_rows(inputs, result):
            writer.writerow([
                "" if cell is None else js_number(cell) if isinstance(cell, (int, float)) and not isinstance(cell, bool) else safe_text(cell)
                for cell in row
            ])
