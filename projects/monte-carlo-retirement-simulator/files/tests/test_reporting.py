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


@pytest.mark.parametrize("value,text", [
    # Expected text is JavaScript's String(value), as the web CSV writes it (checked in Node).
    (123456789012345680000.0, "123456789012345680000"),  # above 2**53: shortest digits, not ...683968
    (41234567890123456.0, "41234567890123460"),
    (9007199254740992.0, "9007199254740992"),
    (1e-7, "1e-7"), (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (0.00001, "0.00001"), (-1.25e-5, "-0.0000125"),
    (0.0001, "0.0001"), (2.5, "2.5"), (100.0, "100"), (0.1 + 0.2, "0.30000000000000004"),
    (1e21, "1e+21"), (1.5e21, "1.5e+21"), (1e300, "1e+300"), (-0.0, "0"), (4294967295, "4294967295"),
])
def test_csv_numbers_are_written_as_javascript_writes_them(value, text):
    from monte_carlo.export import js_number
    assert js_number(value) == text


# Hand-calculated run (injected draws, so every number is known): return 0%, volatility
# 10% (r = 0.10 z), inflation 10%, 2 saving years, 5 retirement years, $100,000 today,
# $5,000 contribution growing 10%, $40,000 spending less $10,000 pension in today's
# dollars -> first-year withdrawal 30,000 x 1.1^2 = 36,300 (then 39,930; 43,923;
# 48,315.30; 53,146.83). Paths: A ruins in retirement year 3, B and E in year 4, D (a
# -150% first year, floored at 0, then 5,500) in year 1, C survives with 193,884.87.
HAND_RAW = dict(currentPortfolio="100000", annualContribution="5000", contributionGrowth="10", yearsToRetirement="2",
                yearsInRetirement="5", expectedReturn="0", volatility="10", inflation="10", annualSpending="40000",
                pensionIncome="10000", simulations="5", spendingBasis="today")
HAND_Z = [0, 0, 0, 0, 0] + [0, 0, 3, 0, 0, 0] + [10, 10, 0, 0, 0, 0, 0] + [-15, 0, 0] + [0, 0, 3, 0, 0, 0]
# Year: P10..P90 nominal (linear interpolation over 5 paths: index 0.4, 1, 2, 3, 3.6).
HAND_BANDS = {
    2: [5500 + 0.4 * 105000, 110500, 110500, 110500, 110500 + 0.6 * 305000],  # 5.5k, 110.5k x3, 415.5k
    3: [0.4 * 74200, 74200, 107350, 107350, 107350 + 0.6 * 271850],          # 0, 74.2k, 107.35k x2, 379.2k
    7: [0, 0, 0, 0, 0.6 * 193884.87],
}


def _hand_run():
    inputs = parse_raw_inputs(HAND_RAW, error_type=ValidationError, workbook_path=Path("unused.xlsx"))
    draws = iter(HAND_Z)
    return inputs, run_monte_carlo(inputs, normal=lambda: next(draws))


def test_excel_report_values_match_a_hand_calculated_run(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    pytest.importorskip("matplotlib")
    inputs, result = _hand_run()
    wb = openpyxl.load_workbook(write_excel_report(inputs, result, tmp_path / "hand.xlsx"))
    summary = {row[0].value: row[1] for row in wb["MC_Summary"].iter_rows(min_row=3) if row[0].value}
    value = lambda label: summary[label].value  # noqa: E731
    assert value("Probability of success") == pytest.approx(0.20) and summary["Probability of success"].number_format == "0.0%"
    assert value("Failed simulations") == "4 of 5"
    assert value("Median ruin year (failed paths only)") == "Year 3.5 of retirement"  # ruin years 1, 3, 4, 4
    assert value("Inflation rate") == pytest.approx(0.10) and value("Contribution growth rate") == pytest.approx(0.10)
    assert value("Net withdrawal as entered") == 30000
    assert value("Conversion to retirement-year dollars") == "x 1.210000 = (1 + inflation)^2"
    assert value("First-year net withdrawal (retirement-year dollars)") == pytest.approx(36300, rel=1e-12)
    assert value("Median portfolio at retirement (nominal)") == pytest.approx(110500, rel=1e-12)
    assert value("Median portfolio at retirement (today's dollars)") == pytest.approx(110500 / 1.21, rel=1e-12)
    assert value("Median final portfolio value (nominal)") == 0
    assert value("90th percentile final value (nominal)") == pytest.approx(0.6 * 193884.87, rel=1e-12)
    rate = value("Initial withdrawal rate (first-year net withdrawal / median at retirement)")
    assert rate == pytest.approx(36300 / 110500, rel=1e-12) and summary[
        "Initial withdrawal rate (first-year net withdrawal / median at retirement)"].number_format == "0.00%"
    rows = list(wb["MC_Percentiles"].iter_rows(min_row=2, values_only=True))
    assert [r[0] for r in rows] == list(range(8))
    for year, expected in HAND_BANDS.items():
        assert list(rows[year][1:6]) == pytest.approx(expected, rel=1e-12, abs=1e-9), year
        assert list(rows[year][6:11]) == pytest.approx([v / 1.1 ** year for v in expected], rel=1e-12, abs=1e-9), year
    assert [r[11] for r in rows].count("RETIREMENT BEGINS") == 1 and rows[2][11] == "RETIREMENT BEGINS"


def test_csv_values_match_a_hand_calculated_run(tmp_path):
    inputs, result = _hand_run()
    out = tmp_path / "hand.csv"
    write_csv_export(out, result, inputs)
    rows = list(csv.reader(out.open(encoding="utf-8-sig")))
    by_label = {r[0]: r[1:] for r in rows if r}
    assert float(by_label["Probability of success (%)"][0]) == 20
    assert by_label["Failed simulations"] == ["4", "of", "5"]
    assert float(by_label["Initial withdrawal rate (%)"][0]) == pytest.approx(36300 / 110500 * 100, rel=1e-12)
    assert by_label["Spending basis"] == ["Today's dollars"]
    assert float(by_label["First-year net withdrawal (retirement-year dollars)"][0]) == pytest.approx(36300, rel=1e-12)
    assert "annualSpending=40000" in by_label["Inputs"] and "pensionIncome=10000" in by_label["Inputs"]
    table = rows[next(i for i, r in enumerate(rows) if r and r[0] == "Year") + 1:]
    assert [int(r[0]) for r in table] == list(range(8))
    for year, expected in HAND_BANDS.items():
        assert [float(v) for v in table[year][1:6]] == pytest.approx(expected, rel=1e-12, abs=1e-9), year
        assert [float(v) for v in table[year][6:11]] == pytest.approx([v / 1.1 ** year for v in expected], rel=1e-12, abs=1e-9), year


def test_summary_rows_label_every_value():
    inputs = parse()
    rows = summary_rows(inputs, run_monte_carlo(inputs))
    labels = [r[0] for r in rows if r[0]]
    assert len(labels) == len(set(labels))
    assert "Expected return (arithmetic mean)" in labels
