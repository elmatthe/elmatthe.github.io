"""Browser vs desktop calculation parity for the Monte Carlo and Rebalancer tools.

The browser engines (assets/js/...) run under Node and the desktop engines
(projects/.../scripts) run in-process; both receive identical inputs and, for Monte
Carlo, an identical sequence of standard-normal draws, so results must agree to
floating-point precision.

Run from the repository root with a Python that has numpy and pytest:
    python -m pytest _tools/tests/test_engine_parity.py -q
"""
from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name("js_engines.mjs")
MC_SCRIPTS = ROOT / "projects" / "monte-carlo-retirement-simulator" / "scripts"
RB_SCRIPTS = ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts"
# Commit whose inline browser rebalancer is the pre-refactor behaviour baseline.
LEGACY_REF = "7b41f11"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")


def run_js(tool: str, cases: list, **extra) -> list:
    payload = json.dumps({"tool": tool, "cases": cases, **extra})
    result = subprocess.run(["node", str(RUNNER)], input=payload, capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def close(a: float, b: float, rel: float = 1e-9, abs_tol: float = 1e-6) -> bool:
    return math.isclose(a, b, rel_tol=rel, abs_tol=abs_tol)


# ---------------------------------------------------------------- Monte Carlo
sys.path.insert(0, str(MC_SCRIPTS))
np = pytest.importorskip("numpy")
from monte_carlo import core as mc_core  # noqa: E402
from monte_carlo.models import SimulationInputs, ValidationError  # noqa: E402

MC_BASE = dict(currentPortfolio=150000, annualContribution=10000, contributionGrowth=0, yearsToRetirement=30,
               yearsInRetirement=25, expectedReturn=7, volatility=12, inflation=2.5, annualSpending=60000,
               pensionIncome=18000, simulations=400)


def mc_desktop_inputs(raw: dict) -> SimulationInputs:
    return SimulationInputs(
        current_portfolio=float(raw["currentPortfolio"]), annual_contribution=float(raw["annualContribution"]),
        contribution_growth_rate=float(raw["contributionGrowth"]), years_to_retirement=int(raw["yearsToRetirement"]),
        years_in_retirement=int(raw["yearsInRetirement"]), expected_return=float(raw["expectedReturn"]),
        volatility=float(raw["volatility"]), inflation_rate=float(raw["inflation"]), annual_spending=float(raw["annualSpending"]),
        pension_income=float(raw["pensionIncome"]), simulations=int(raw["simulations"]), workbook_path=Path("unused.xlsx"),
    )


def mc_scenarios():
    rng = random.Random(20260928)
    yield dict(MC_BASE)
    yield dict(MC_BASE, volatility=0, simulations=3)                                      # deterministic path
    yield dict(MC_BASE, currentPortfolio=20000, annualSpending=90000, pensionIncome=0)   # frequent ruin
    yield dict(MC_BASE, annualContribution=0, contributionGrowth=-5, inflation=-1)       # negative rates
    for _ in range(4):
        yield dict(
            currentPortfolio=rng.choice([25000, 150000, 750000]), annualContribution=rng.choice([0, 5000, 40000]),
            contributionGrowth=rng.choice([0, 2.5, 5]), yearsToRetirement=rng.randint(1, 40), yearsInRetirement=rng.randint(1, 40),
            expectedReturn=rng.choice([3, 6.5, 9]), volatility=rng.choice([5, 12, 25]), inflation=rng.choice([0, 2, 3.5]),
            annualSpending=rng.choice([30000, 60000, 120000]), pensionIncome=rng.choice([0, 10000, 25000]), simulations=rng.randint(1, 300),
        )


def run_mc_desktop(raw: dict, z: list[float]):
    draws = iter(z)
    original = np.random.normal
    np.random.normal = lambda loc, scale: loc + scale * next(draws)  # noqa: E731 - identical draws for both engines
    try:
        return mc_core.run_monte_carlo(mc_desktop_inputs(raw))
    finally:
        np.random.normal = original


def test_monte_carlo_browser_matches_desktop():
    cases = []
    rng = np.random.default_rng(7)
    for raw in mc_scenarios():
        needed = raw["simulations"] * (raw["yearsToRetirement"] + raw["yearsInRetirement"])
        cases.append({"raw": raw, "z": rng.standard_normal(needed).tolist()})
    js = run_js("monte-carlo", cases)
    for case, browser in zip(cases, js):
        assert "error" not in browser, browser
        desktop = run_mc_desktop(case["raw"], case["z"])
        s = browser["summary"]
        assert close(s["successProbability"], desktop.success_probability)
        assert s["failedRuns"] == desktop.failed_simulations
        assert close(s["medianRetirement"]["nominal"], desktop.median_portfolio_at_retirement)
        assert close(s["medianFinal"]["nominal"], desktop.median_final_value)
        assert close(s["finalP10"]["nominal"], desktop.p10_final_value)
        assert close(s["finalP90"]["nominal"], desktop.p90_final_value)
        assert close(s["swr"], desktop.safe_withdrawal_rate)
        assert close(s["netWithdrawal"], desktop.net_withdrawal)
        if desktop.median_ruin_year is None:
            assert s["medianRuinYear"] is None
        else:
            assert close(s["medianRuinYear"], desktop.median_ruin_year)
        for year, band in enumerate(browser["bands"]):
            for key, series in (("p10", desktop.p10), ("p25", desktop.p25), ("p50", desktop.p50), ("p75", desktop.p75), ("p90", desktop.p90)):
                assert close(band[key], float(series[year])), (case["raw"], year, key)


INVALID = [
    dict(MC_BASE, currentPortfolio=0),
    dict(MC_BASE, annualContribution=-1),
    dict(MC_BASE, annualSpending=0),
    dict(MC_BASE, pensionIncome=60000),          # pension must be below spending
    dict(MC_BASE, pensionIncome=70000),
    dict(MC_BASE, expectedReturn=101),
    dict(MC_BASE, contributionGrowth=-101),
    dict(MC_BASE, volatility=-1),
    dict(MC_BASE, volatility=301),
    dict(MC_BASE, inflation=150),
    dict(MC_BASE, yearsToRetirement=0),
    dict(MC_BASE, yearsInRetirement=121),
    dict(MC_BASE, simulations=0),
    dict(MC_BASE, simulations=10001),
    dict(MC_BASE, currentPortfolio=2e15),
]


@pytest.mark.parametrize("raw", INVALID)
def test_monte_carlo_validation_matches_desktop(raw):
    with pytest.raises(ValidationError) as desktop_error:
        mc_core.validate_simulation_inputs(mc_desktop_inputs(raw), error_type=ValidationError)
    (browser,) = run_js("monte-carlo", [{"raw": raw}])
    assert browser.get("error") == str(desktop_error.value)


def test_monte_carlo_valid_limits_accepted_by_both():
    for raw in (dict(MC_BASE, simulations=10000, yearsToRetirement=1, yearsInRetirement=1), dict(MC_BASE, volatility=300, simulations=1)):
        mc_core.validate_simulation_inputs(mc_desktop_inputs(raw), error_type=ValidationError)
        needed = raw["simulations"] * 2 if raw["simulations"] > 1 else 60
        (browser,) = run_js("monte-carlo", [{"raw": raw, "z": [0.0] * needed}])
        assert "error" not in browser, browser


# ---------------------------------------------------------------- Rebalancer
sys.path.insert(0, str(RB_SCRIPTS))
from portfolio_rebalancer import core as rb_core  # noqa: E402

FX = {"USD": 1.0, "CAD": 0.73, "JPN": 0.0068, "EUR": 1.09, "GBP": 1.28, "CHY_CNH": 0.14}


def rb_scenarios(count: int = 60):
    rng = random.Random(42)
    accounts = ["", "TFSA", "RRSP", "Margin"]
    for i in range(count):
        n = rng.randint(1, 12)
        positions = []
        for j in range(n):
            positions.append({
                "rowIndex": j, "ticker": f"T{j}", "shares": round(rng.uniform(0, 500), 4) if rng.random() > 0.1 else 0,
                "price": round(rng.uniform(1, 400), 4), "currencyKey": rng.choice(list(FX)),
                "targetWeight": rng.choice([0, 5, 10, 12.5, 20, 33]), "accountType": rng.choice(accounts) if i % 3 == 0 else "",
            })
        if not any(p["targetWeight"] > 0 for p in positions):
            positions[0]["targetWeight"] = 10
        fx = {k: v * rng.uniform(0.95, 1.05) if k != "USD" else 1.0 for k, v in FX.items()}
        yield {"positions": positions, "fxToUsd": fx, "reportingKey": rng.choice(list(FX)),
               "mode": rng.choice(["new_money", "rebalance"]), "budget": rng.choice([0, 1000, 25000, 250000])}


def rb_desktop(case: dict):
    fx = lambda key: case["fxToUsd"][key] / case["fxToUsd"][case["reportingKey"]]  # noqa: E731
    positions = [{**p, "currencyLabel": p["currencyKey"], "fxToReporting": fx(p["currencyKey"]),
                  "currentValue": p["shares"] * p["price"] * fx(p["currencyKey"])} for p in case["positions"]]
    summary, results, warnings = rb_core.calculate_rebalance_plan(positions, case["mode"], case["budget"])
    return {"summary": summary, "results": results, "warnings": warnings}


def assert_same_plan(a: dict, b: dict, label: str):
    for key in ("totalCurrent", "pool", "totalBuys", "totalSells"):
        assert close(a["summary"][key], b["summary"][key]), (label, key)
    assert len(a["results"]) == len(b["results"])
    for ra, rb in zip(a["results"], b["results"]):
        assert ra["action"] == rb["action"], label
        for key in ("targetValue", "tradeValue", "tradeValueLocal", "tradeShares", "postTradeShares"):
            assert close(ra[key], rb[key]), (label, ra["ticker"], key)
    assert len(a["warnings"]) == len(b["warnings"]), (label, a["warnings"], b["warnings"])


def test_rebalancer_browser_matches_desktop():
    cases = list(rb_scenarios())
    browser = run_js("rebalancer", cases)
    checked = 0
    for index, (case, result) in enumerate(zip(cases, browser)):
        try:
            desktop = rb_desktop(case)
        except ValueError as error:
            assert result.get("error") == str(error), index
            continue
        assert "error" not in result, (index, result)
        assert_same_plan(result, desktop, f"case {index}")
        checked += 1
    assert checked >= 40


def test_rebalancer_refactor_matches_legacy_browser_engine():
    git = shutil.which("git")
    if git is None:
        pytest.skip("git is required")
    shown = subprocess.run([git, "show", f"{LEGACY_REF}:projects/portfolio-rebalancer.md"], cwd=ROOT, capture_output=True, text=True, check=False)
    if shown.returncode != 0:
        pytest.skip(f"baseline {LEGACY_REF} unavailable in this checkout")
    cases = list(rb_scenarios())
    new = run_js("rebalancer", cases)
    old = run_js("rebalancer-legacy", cases, source=shown.stdout)
    for index, (a, b) in enumerate(zip(new, old)):
        if "error" in a or "error" in b:
            assert a.get("error") == b.get("error"), index
            continue
        assert_same_plan(a, b, f"legacy case {index}")
