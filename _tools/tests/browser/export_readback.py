"""Reads back files the web apps exported, for exports.test.js. Prints JSON.

    python export_readback.py xlsx <file>       every sheet's cell values with their types,
                                                 after checking the ZIP's CRCs and that no
                                                 cell holds a formula
    python export_readback.py mc <csv file>     the desktop Monte Carlo engine's result for the
                                                 inputs and seed recorded in a web CSV export

Needs openpyxl (xlsx) and numpy (mc), as the browser CI job and the private gate provide.
"""
from __future__ import annotations

import csv
import json
import math
import sys
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def dump_xlsx(path: str) -> dict:
    import openpyxl

    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
    warnings.simplefilter("error")  # any repair or style warning fails the read
    book = openpyxl.load_workbook(path)
    sheets = {}
    formulas = 0
    for ws in book.worksheets:
        rows = []
        for row in ws.iter_rows():
            cells = []
            for c in row:
                if c.data_type == "f":
                    formulas += 1
                v = c.value
                cells.append({"v": v if not isinstance(v, float) or math.isfinite(v) else str(v), "t": type(v).__name__})
            rows.append(cells)
        sheets[ws.title] = rows
    return {"crcError": bad, "sheetNames": book.sheetnames, "formulas": formulas, "sheets": sheets}


def desktop_mc(csv_path: str) -> dict:
    sys.path.insert(0, str(ROOT / "projects" / "monte-carlo-retirement-simulator" / "scripts"))
    from monte_carlo import core
    from monte_carlo.models import SimulationInputs
    from monte_carlo.rng import SeededNormal

    rows = list(csv.reader(Path(csv_path).read_text(encoding="utf-8-sig").splitlines()))
    raw = dict(cell.split("=", 1) for cell in next(r for r in rows if r and r[0] == "Inputs")[1:])
    seed = int(next(r for r in rows if r and r[0] == "Random seed")[1])
    inputs = SimulationInputs(
        current_portfolio=float(raw["currentPortfolio"]), annual_contribution=float(raw["annualContribution"]),
        contribution_growth_rate=float(raw["contributionGrowth"]), years_to_retirement=int(raw["yearsToRetirement"]),
        years_in_retirement=int(raw["yearsInRetirement"]), expected_return=float(raw["expectedReturn"]),
        volatility=float(raw["volatility"]), inflation_rate=float(raw["inflation"]), annual_spending=float(raw["annualSpending"]),
        pension_income=float(raw["pensionIncome"]), simulations=int(raw["simulations"]), workbook_path=Path("unused.xlsx"),
        spending_basis=raw.get("spendingBasis", "retirement"),
    )
    result = core.run_monte_carlo(inputs, normal=SeededNormal(seed))
    years = len(result.p50)
    return {
        "seed": seed, "successProbability": result.success_probability, "failed": result.failed_simulations,
        "nominal": {k: [float(v) for v in getattr(result, k)] for k in ("p10", "p25", "p50", "p75", "p90")},
        "real": {k: [result.real(float(getattr(result, k)[y]), y) for y in range(years)] for k in ("p10", "p25", "p50", "p75", "p90")},
    }


if __name__ == "__main__":
    command, target = sys.argv[1], sys.argv[2]
    print(json.dumps(dump_xlsx(target) if command == "xlsx" else desktop_mc(target), default=str))
