"""Excel report (summary, percentiles, embedded chart) and CSV export."""
from __future__ import annotations

import csv
import datetime as dt
import tempfile
from pathlib import Path

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
    SimulationInputs,
    SimulationResult,
)


def _add_years_safe(base_date: dt.date, years: int) -> dt.date:
    target_year = base_date.year + years
    try:
        return base_date.replace(year=target_year)
    except ValueError:
        return base_date.replace(year=target_year, day=28)


def _replace_or_create_sheet(workbook: "Workbook", title: str):  # type: ignore[type-arg]
    if title in workbook.sheetnames:
        idx = workbook.sheetnames.index(title)
        del workbook[title]
        return workbook.create_sheet(title=title, index=idx)
    return workbook.create_sheet(title=title)


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

    rows = [
        (3, "Run Date", dt.date.today().isoformat()),
        (4, "Simulations Run", inputs.simulations),
        (5, "Current Portfolio", inputs.current_portfolio),
        (6, "Annual Contribution", inputs.annual_contribution),
        (7, "Contribution Growth Rate", inputs.contribution_growth_rate / 100.0),
        (8, "Years to Retirement", inputs.years_to_retirement),
        (9, "Years in Retirement", inputs.years_in_retirement),
        (10, "Expected Return", inputs.expected_return / 100.0),
        (11, "Volatility", inputs.volatility / 100.0),
        (12, "Inflation Rate", inputs.inflation_rate / 100.0),
        (13, "Annual Retirement Spending", inputs.annual_spending),
        (14, "CPP / OAS / Pension Income", inputs.pension_income),
        (15, "Net Annual Withdrawal (Year 1)", result.net_withdrawal),
    ]

    for row_idx, label, value in rows:
        sheet.cell(row=row_idx, column=1, value=label).font = heading_font
        cell = sheet.cell(row=row_idx, column=2, value=value)
        if row_idx in {5, 6, 13, 14, 15}:
            cell.number_format = "$#,##0.00"
        elif row_idx in {7, 10, 11, 12}:
            cell.number_format = "0.00%"

    sheet.cell(row=17, column=1, value="RESULTS").font = Font(bold=True, color=BRAND_NAVY_ARGB)

    summary_rows = [
        (18, "Probability of Success", result.success_probability / 100.0, "0.0%"),
        (19, "Median Portfolio at Retirement", result.median_portfolio_at_retirement, "$#,##0.00"),
        (20, "Median Final Portfolio Value", result.median_final_value, "$#,##0.00"),
        (21, "10th Percentile Final Value", result.p10_final_value, "$#,##0.00"),
        (22, "90th Percentile Final Value", result.p90_final_value, "$#,##0.00"),
        (23, "Safe Withdrawal Rate", result.safe_withdrawal_rate / 100.0, "0.00%"),
        (24, "Failed Simulations", f"{result.failed_simulations} of {inputs.simulations}", None),
        (
            25,
            "Median Ruin Year (if any)",
            (
                f"Year {result.median_ruin_year:.1f} of retirement"
                if result.median_ruin_year is not None
                else "N/A - no failures"
            ),
            None,
        ),
    ]

    for row_idx, label, value, number_format in summary_rows:
        sheet.cell(row=row_idx, column=1, value=label).font = heading_font
        val_cell = sheet.cell(row=row_idx, column=2, value=value)
        if number_format:
            val_cell.number_format = number_format

    probability_cell = sheet.cell(row=18, column=2)
    if result.success_probability >= 85:
        probability_cell.fill = PatternFill(fill_type="solid", start_color="C6EFCE", end_color="C6EFCE")
    elif result.success_probability >= 70:
        probability_cell.fill = PatternFill(fill_type="solid", start_color="FFEB9C", end_color="FFEB9C")
    else:
        probability_cell.fill = PatternFill(fill_type="solid", start_color="FFC7CE", end_color="FFC7CE")

    sheet.column_dimensions["A"].width = 40
    sheet.column_dimensions["B"].width = 26


def _write_percentiles_sheet(sheet, inputs: SimulationInputs, result: SimulationResult) -> None:
    assert Font is not None and PatternFill is not None

    headers = ["Year", "P10", "P25", "P50 (Median)", "P75", "P90", "Phase marker"]
    header_fill = PatternFill(fill_type="solid", start_color=BRAND_NAVY_ARGB, end_color=BRAND_NAVY_ARGB)
    header_font = Font(color="FFFFFF", bold=True)

    for col_idx, header in enumerate(headers, start=1):
        cell = sheet.cell(row=1, column=col_idx, value=header)
        cell.fill = header_fill
        cell.font = header_font

    for idx, year in enumerate(result.years, start=2):
        year_i = int(year)
        sheet.cell(row=idx, column=1, value=year_i)
        p10_cell = sheet.cell(row=idx, column=2, value=float(result.p10[year_i]))
        p25_cell = sheet.cell(row=idx, column=3, value=float(result.p25[year_i]))
        p50_cell = sheet.cell(row=idx, column=4, value=float(result.p50[year_i]))
        p75_cell = sheet.cell(row=idx, column=5, value=float(result.p75[year_i]))
        p90_cell = sheet.cell(row=idx, column=6, value=float(result.p90[year_i]))

        for value_cell in (p10_cell, p25_cell, p50_cell, p75_cell, p90_cell):
            value_cell.number_format = "$#,##0.00"

        if year_i == inputs.years_to_retirement:
            marker_cell = sheet.cell(row=idx, column=7, value="RETIREMENT BEGINS")
            marker_cell.fill = PatternFill(fill_type="solid", start_color="D9E2F3", end_color="D9E2F3")
            marker_cell.font = Font(bold=True)

    widths = {"A": 10, "B": 16, "C": 16, "D": 18, "E": 16, "F": 16, "G": 24}
    for col, width in widths.items():
        sheet.column_dimensions[col].width = width
    sheet.freeze_panes = "A2"


def _render_chart_image(result: SimulationResult, retirement_year: int) -> Path:
    require_export_deps()
    assert plt is not None and FuncFormatter is not None

    fig, axis = plt.subplots(figsize=(11, 5.8))
    years = result.years

    axis.fill_between(years, result.p10, result.p90, color=BRAND_NAVY, alpha=0.20, label="10th-90th percentile")
    axis.fill_between(years, result.p25, result.p75, color=BRAND_NAVY, alpha=0.35, label="25th-75th percentile")
    axis.plot(years, result.p50, color=BRAND_NAVY, linewidth=2.0, label="Median")
    axis.axvline(retirement_year, color="#3d5f8e", linestyle="--", linewidth=1.5)

    axis.set_title("Monte Carlo Simulation - Portfolio Projection")
    axis.set_xlabel("Years")
    axis.set_ylabel("Portfolio value ($)")
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


def write_excel_report(inputs: SimulationInputs, result: SimulationResult) -> None:
    require_export_deps()
    assert Workbook is not None and load_workbook is not None

    workbook_path = inputs.workbook_path
    workbook_is_new = not workbook_path.exists()
    workbook = load_workbook(workbook_path) if workbook_path.exists() else Workbook()

    summary_sheet = _replace_or_create_sheet(workbook, "MC_Summary")
    percentiles_sheet = _replace_or_create_sheet(workbook, "MC_Percentiles")
    chart_sheet = _replace_or_create_sheet(workbook, "MC_Chart")

    # Remove openpyxl's default blank sheet only for newly created workbooks.
    if workbook_is_new and "Sheet" in workbook.sheetnames:
        del workbook["Sheet"]

    _write_summary_sheet(summary_sheet, inputs, result)
    _write_percentiles_sheet(percentiles_sheet, inputs, result)
    chart_path = _write_chart_sheet(chart_sheet, result, inputs.years_to_retirement)

    try:
        try:
            workbook.save(workbook_path)
        except PermissionError as exc:
            raise PermissionError(
                "The workbook appears to be open. Close it in Excel and try again."
            ) from exc
    finally:
        chart_path.unlink(missing_ok=True)


def write_csv_export(csv_path: Path, result: SimulationResult) -> None:
    today = dt.date.today()
    with csv_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["Year", "Date", "P10", "P25", "P50", "P75", "P90"])
        for year in result.years:
            year_i = int(year)
            writer.writerow(
                [
                    year_i,
                    _add_years_safe(today, year_i).isoformat(),
                    f"{float(result.p10[year_i]):.2f}",
                    f"{float(result.p25[year_i]):.2f}",
                    f"{float(result.p50[year_i]):.2f}",
                    f"{float(result.p75[year_i]):.2f}",
                    f"{float(result.p90[year_i]):.2f}",
                ]
            )
