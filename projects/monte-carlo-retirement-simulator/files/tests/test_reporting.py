"""Spending basis, warnings, input parsing, sample scenarios and exports."""
import csv
import random
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from monte_carlo.core import (  # noqa: E402
    FieldError,
    assumption_warnings,
    first_year_withdrawal,
    parse_raw_inputs,
    run_monte_carlo,
    typical_growth,
)
from monte_carlo.export import csv_rows, new_workbook_path, summary_rows, workbook_risks, write_csv_export, write_excel_report  # noqa: E402
from monte_carlo.models import ValidationError  # noqa: E402
from monte_carlo.rng import parse_seed  # noqa: E402
from monte_carlo.sample import sample_scenario  # noqa: E402

BASE = dict(currentPortfolio="150000", annualContribution="10000", contributionGrowth="0", yearsToRetirement="30",
            yearsInRetirement="25", expectedReturn="7", volatility="12", inflation="2.5", annualSpending="60000",
            pensionIncome="18000", simulations="400")


def parse(**overrides):
    return parse_raw_inputs(dict(BASE, **overrides), error_type=ValidationError, workbook_path=Path("unused.xlsx"), seed=11)


def test_retirement_year_basis_is_the_unchanged_default():
    inputs = parse()
    assert inputs.spending_basis == "retirement"
    first = first_year_withdrawal(inputs)
    assert first == {"entered": 42000.0, "factor": 1.0, "nominal": 42000.0, "basis": "retirement"}


def test_todays_dollars_are_converted_with_inflation_to_retirement():
    first = first_year_withdrawal(parse(spendingBasis="today"))
    assert first["factor"] == pytest.approx(1.025 ** 30, rel=1e-14)
    assert first["nominal"] == pytest.approx(88097.838321435, rel=1e-12)
    # The converted withdrawal is what the engine uses, and it lowers success.
    legacy = run_monte_carlo(parse())
    today = run_monte_carlo(parse(spendingBasis="today"))
    assert today.net_withdrawal == pytest.approx(88097.838321435, rel=1e-12)
    assert today.net_withdrawal_entered == 42000.0
    assert today.success_probability < legacy.success_probability


def test_invalid_spending_basis_is_rejected():
    with pytest.raises(ValidationError, match="Spending basis"):
        parse(spendingBasis="nominal")


@pytest.mark.parametrize("field,value,message", [
    ("currentPortfolio", "abc", "Current portfolio value must be a finite numeric value."),
    ("currentPortfolio", "nan", "Current portfolio value must be a finite numeric value."),
    ("currentPortfolio", "1_000", "Current portfolio value must be a finite numeric value."),
    ("currentPortfolio", "0x10", "Current portfolio value must be a finite numeric value."),
    ("currentPortfolio", "١٠٠٠", "Current portfolio value must be a finite numeric value."),
    ("yearsToRetirement", "2.5", "Years to retirement must be between 1 and 120."),
    ("annualContribution", "", "Annual contribution must be a finite numeric value."),
])
def test_parsing_rules_and_messages(field, value, message):
    with pytest.raises(ValidationError) as error:
        parse(**{field: value})
    assert str(error.value) == message
    assert error.value.field == field


def test_decimal_and_exponent_forms_are_accepted():
    inputs = parse(yearsToRetirement="30.0", simulations="1e2", currentPortfolio=" 1.5e5 ")
    assert (inputs.years_to_retirement, inputs.simulations, inputs.current_portfolio) == (30, 100, 150000.0)


def test_field_error_carries_the_field():
    with pytest.raises(FieldError) as error:
        parse_raw_inputs(dict(BASE, volatility="-1"))
    assert error.value.field == "volatility"


def test_seed_rules():
    assert parse_seed("") is None and parse_seed(" 42 ") == 42 and parse_seed("4294967295") == 4294967295
    for bad in ["-1", "1.5", "abc", "4294967296", "1e3"]:
        with pytest.raises(ValueError, match="Seed must be"):
            parse_seed(bad)


def test_warnings_for_extreme_or_fractional_assumptions():
    codes = lambda **o: [w["code"] for w in assumption_warnings(parse(**o))]  # noqa: E731
    assert codes() == []
    assert codes(expectedReturn="0.07") == ["return_looks_fractional"]
    assert codes(volatility="0.12") == ["volatility_looks_fractional"]
    assert codes(volatility="50") == ["volatility_high", "returns_below_total_loss"]
    assert codes(inflation="-100") == ["real_values_undefined"]
    message = next(w["message"] for w in assumption_warnings(parse(volatility="50")) if w["code"] == "returns_below_total_loss")
    assert "about 1.6% of simulated years" in message


def test_typical_growth_is_below_the_arithmetic_mean():
    assert typical_growth(7, 12) == pytest.approx(6.33, abs=0.01)
    assert typical_growth(7, 0) == pytest.approx(7.0, abs=1e-12)
    assert typical_growth(-100, 10) is None


def test_sample_scenarios_always_pass_validation():
    rng = random.Random(2026)
    for _ in range(100_000):
        raw = sample_scenario(rng)
        assert int(raw["pensionIncome"]) <= int(raw["annualSpending"]) - 5000
    for _ in range(300):
        parse_raw_inputs(sample_scenario(rng), error_type=ValidationError)


def test_excel_report_records_basis_seed_engine_and_real_values(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    pytest.importorskip("matplotlib")
    inputs = parse(spendingBasis="today")
    result = run_monte_carlo(inputs)
    path = write_excel_report(inputs, result, tmp_path / "report.xlsx")
    wb = openpyxl.load_workbook(path)
    assert wb.sheetnames == ["MC_Summary", "MC_Percentiles", "MC_Chart"]
    summary = {row[0].value: row[1].value for row in wb["MC_Summary"].iter_rows(min_row=3) if row[0].value}
    assert summary["Random seed"] == 11
    assert "mulberry32" in summary["Random generator"]
    assert summary["Engine version"] == result.engine_version
    assert summary["Spending and pension entered in"] == "Today's dollars"
    assert summary["First-year net withdrawal (retirement-year dollars)"] == pytest.approx(88097.838321435)
    assert "Safe Withdrawal Rate" not in summary
    assert any(k.startswith("Initial withdrawal rate") for k in summary)
    assert summary["Warnings"] == "None"
    header = [c.value for c in wb["MC_Percentiles"][1]]
    assert header[1] == "P10 nominal" and header[6] == "P10 today's $"
    year30 = [c.value for c in wb["MC_Percentiles"][32]]
    assert year30[0] == 30 and year30[8] == pytest.approx(year30[3] / 1.025 ** 30, rel=1e-12)
    assert year30[11] == "RETIREMENT BEGINS"


def test_csv_matches_the_web_layout_and_reproduces_the_run(tmp_path):
    inputs = parse()
    result = run_monte_carlo(inputs)
    out = tmp_path / "mc.csv"
    write_csv_export(out, result, inputs)
    raw = out.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(out.open(encoding="utf-8-sig")))
    labels = [r[0] for r in rows if r]
    for label in ["Probability of success (%)", "Spending basis", "Random seed", "Random generator", "Engine version", "Model", "Warnings", "Year"]:
        assert label in labels
    seed_row = next(r for r in rows if r and r[0] == "Random seed")
    assert seed_row[1] == "11"
    inputs_row = next(r for r in rows if r and r[0] == "Inputs")
    assert "currentPortfolio=150000" in inputs_row and "spendingBasis=retirement" in inputs_row
    table = rows[rows.index(next(r for r in rows if r and r[0] == "Year")) + 1:]
    assert len(table) == 56 and float(table[30][3]) == float(result.p50[30])
    # Re-running from the exported inputs and seed reproduces the exported numbers.
    again = run_monte_carlo(parse())
    assert float(table[-1][3]) == float(again.p50[-1])
    assert csv_rows(inputs, result)[1] == ["Probability of success (%)", result.success_probability]


def test_workbook_risks_detects_content_openpyxl_would_drop(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    pytest.importorskip("PIL")
    from openpyxl.chart import BarChart, Reference
    from openpyxl.drawing.image import Image
    from PIL import Image as PILImage

    plain = tmp_path / "plain.xlsx"
    wb = openpyxl.Workbook()
    wb.active.title = "Budget"
    wb.active.append([1, 2])
    wb.save(plain)
    assert workbook_risks(plain) == []
    assert workbook_risks(tmp_path / "missing.xlsx") == []

    png = tmp_path / "logo.png"
    PILImage.new("RGB", (8, 8)).save(png)
    rich = tmp_path / "rich.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Plan"
    for i in range(4):
        ws.append([i, i * i])
    ws.add_image(Image(str(png)), "D2")
    chart = BarChart()
    chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4))
    ws.add_chart(chart, "F2")
    wb.save(rich)
    risks = workbook_risks(rich)
    assert risks == ["sheet 'Plan': pictures, shapes, text boxes or charts"]

    # The report's own chart image (MC_Chart) is not counted on a second run.
    inputs = parse()
    write_excel_report(inputs, run_monte_carlo(inputs), plain)
    assert "MC_Chart" in openpyxl.load_workbook(plain).sheetnames
    assert workbook_risks(plain) == []
    assert zipfile.ZipFile(plain).namelist()  # still a valid package

    alternative = new_workbook_path(rich)
    assert alternative.name == "rich (Monte Carlo report).xlsx" and not alternative.exists()


def test_summary_rows_label_every_value():
    inputs = parse()
    rows = summary_rows(inputs, run_monte_carlo(inputs))
    labels = [r[0] for r in rows if r[0]]
    assert len(labels) == len(set(labels))
    assert "Expected return (arithmetic mean)" in labels
