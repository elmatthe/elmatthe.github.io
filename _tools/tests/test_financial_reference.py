"""Hand-calculated financial reference cases, checked against BOTH implementations.

Each expected value below is derived by hand from the documented model (shown in the
comments), not from either engine. The browser engines run under Node; the desktop
engines run in-process.
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name("js_engines.mjs")
sys.path.insert(0, str(ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts"))
sys.path.insert(0, str(ROOT / "projects" / "monte-carlo-retirement-simulator" / "scripts"))
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")

from portfolio_rebalancer.core import calculate_rebalance_plan  # noqa: E402


def run_js(tool: str, cases: list) -> list:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"tool": tool, "cases": cases}),
                            capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ------------------------------------------------------------------ rebalancer
USDCAD = 1.40  # 1 USD = 1.40 CAD  ->  1 CAD = 1/1.40 USD
FX_TO_USD = {"USD": 1.0, "CAD": 1 / USDCAD, "JPN": 0.0064, "EUR": 1.1, "GBP": 1.3, "CHY_CNH": 0.15}


def pos(ticker, shares, price, target, key="USD", account=""):
    return {"rowIndex": 0, "ticker": ticker, "shares": shares, "price": price, "currencyKey": key,
            "currencyLabel": key, "targetWeight": target, "accountType": account}


def both_plans(positions, mode, budget, reporting="USD"):
    js = run_js("rebalancer", [{"positions": positions, "fxToUsd": FX_TO_USD, "reportingKey": reporting, "mode": mode, "budget": budget}])[0]
    assert "error" not in js, js
    enriched = []
    for p in positions:
        fx = FX_TO_USD[p["currencyKey"]] / FX_TO_USD[reporting]
        enriched.append({**p, "fxToReporting": fx, "currentValue": p["shares"] * p["price"] * fx})
    summary, results, warnings = calculate_rebalance_plan(enriched, mode, budget)
    return [(js["summary"], js["results"], js["warnings"]), (summary, results, warnings)]


def test_fx_direction_and_valuation():
    # 100 shares of a CAD security at C$50 = C$5,000 = 5,000 / 1.40 = US$3,571.43.
    # 10 shares of a USD security at $100 = US$1,000 = C$1,400 in CAD reporting.
    for summary, results, _ in both_plans([pos("XIU.TO", 100, 50, 50, "CAD"), pos("SPY", 10, 100, 50)], "rebalance", 0):
        assert math.isclose(results[0]["currentValue"], 5000 / 1.40, rel_tol=1e-12)
        assert math.isclose(summary["totalCurrent"], 5000 / 1.40 + 1000, rel_tol=1e-12)
    for summary, results, _ in both_plans([pos("XIU.TO", 100, 50, 50, "CAD"), pos("SPY", 10, 100, 50)], "rebalance", 0, reporting="CAD"):
        assert math.isclose(results[1]["currentValue"], 1400, rel_tol=1e-12)
        assert math.isclose(summary["totalCurrent"], 6400, rel_tol=1e-12)
        # Target 3,200 each: sell C$1,800 of XIU.TO = 36 shares at C$50; buy C$1,800 of SPY
        # = US$1,800/1.40 = US$1,285.71 = 12.857 shares at $100.
        assert results[0]["action"] == "Sell" and math.isclose(results[0]["tradeShares"], -36, rel_tol=1e-12)
        assert results[1]["action"] == "Buy" and math.isclose(results[1]["tradeValueLocal"], 1800 / 1.40, rel_tol=1e-12)
        assert math.isclose(results[1]["tradeShares"], 1800 / 1.40 / 100, rel_tol=1e-12)


def test_new_money_exact_fit_and_budget_cap():
    # A $6,000, B $4,000, 50/50, budget $2,000: pool $12,000, targets $6,000 each.
    # A is on target (Hold); B buys exactly $2,000 = 20 shares at $100.
    for summary, results, warnings in both_plans([pos("A", 60, 100, 50), pos("B", 40, 100, 50)], "new_money", 2000):
        assert results[0]["action"] == "Hold" and results[1]["action"] == "Buy"
        assert math.isclose(results[1]["tradeShares"], 20, rel_tol=1e-12)
        assert math.isclose(summary["totalBuys"], 2000, rel_tol=1e-12)
        assert not warnings
    # A $8,000, B $2,000, budget $1,000: pool $11,000, targets $5,500; A is overweight (Hold,
    # never sold); B needs $3,500 but the cap scales it to $1,000 = 10 shares.
    for summary, results, warnings in both_plans([pos("A", 80, 100, 50), pos("B", 20, 100, 50)], "new_money", 1000):
        assert results[0]["action"] == "Hold" and results[0]["tradeValue"] == 0
        assert math.isclose(results[1]["tradeValue"], 1000, rel_tol=1e-12)
        assert math.isclose(results[1]["postTradeShares"], 30, rel_tol=1e-12)
        assert math.isclose(summary["totalBuys"], 1000, rel_tol=1e-12)
        assert any("scaled down by 71.4%" in w for w in warnings)  # 1 - 1000/3500


def test_rebalance_is_self_funding_and_hold_threshold():
    # A $7,000, B $3,000, 50/50: sell $2,000 of A, buy $2,000 of B.
    for summary, results, _ in both_plans([pos("A", 70, 100, 50), pos("B", 30, 100, 50)], "rebalance", 0):
        assert math.isclose(results[0]["tradeValue"], -2000, rel_tol=1e-12)
        assert math.isclose(results[1]["tradeValue"], 2000, rel_tol=1e-12)
        assert math.isclose(summary["totalBuys"], summary["totalSells"], rel_tol=1e-12)
    # Deviations of $0.50 on a $10,000 pool (0.005%) are inside the 0.01% hold band.
    for _, results, _ in both_plans([pos("A", 50.005, 100, 50), pos("B", 49.995, 100, 50)], "rebalance", 0):
        assert [r["action"] for r in results] == ["Hold", "Hold"]
        assert all(r["tradeValue"] == 0 for r in results)


def test_weights_are_normalized():
    # Weights 10/10/20 behave like 25/25/50.
    for summary, results, _ in both_plans([pos("A", 10, 100, 10), pos("B", 10, 100, 10), pos("C", 20, 100, 20)], "rebalance", 0):
        assert [round(r["targetWeightNorm"], 12) for r in results] == [0.25, 0.25, 0.5]
        assert all(r["action"] == "Hold" for r in results)


# ------------------------------------------------------------------ Monte Carlo
np = pytest.importorskip("numpy")
from monte_carlo import core as mc_core  # noqa: E402
from monte_carlo.models import SimulationInputs  # noqa: E402


def closed_form(v0, c, g, n, r):
    """Year-end contributions growing at g: V_n = V0(1+r)^n + sum_k c(1+g)^(k-1)(1+r)^(n-k)."""
    return v0 * (1 + r) ** n + sum(c * (1 + g) ** (k - 1) * (1 + r) ** (n - k) for k in range(1, n + 1))


@pytest.mark.parametrize("raw", [
    dict(currentPortfolio=100000, annualContribution=5000, contributionGrowth=2, yearsToRetirement=10, yearsInRetirement=20,
         expectedReturn=6, volatility=0, inflation=2, annualSpending=40000, pensionIncome=10000, simulations=3),
    dict(currentPortfolio=50000, annualContribution=0, contributionGrowth=0, yearsToRetirement=5, yearsInRetirement=30,
         expectedReturn=3, volatility=0, inflation=3, annualSpending=60000, pensionIncome=0, simulations=2),
])
def test_monte_carlo_zero_volatility_matches_closed_form(raw):
    r, g, i = raw["expectedReturn"] / 100, raw["contributionGrowth"] / 100, raw["inflation"] / 100
    n = raw["yearsToRetirement"]
    at_retirement = closed_form(raw["currentPortfolio"], raw["annualContribution"], g, n, r)
    # Retirement: V_k = V_{k-1}(1+r) - W(1+i)^(k-1), ruin when V <= 0.
    value, withdrawal, ruined = at_retirement, raw["annualSpending"] - raw["pensionIncome"], False
    for _ in range(raw["yearsInRetirement"]):
        value = value * (1 + r) - withdrawal
        withdrawal *= 1 + i
        if value <= 0:
            value, ruined = 0.0, True
            break
    total_years = n + raw["yearsInRetirement"]
    js = run_js("monte-carlo", [{"raw": raw, "z": [0.0] * (raw["simulations"] * total_years)}])[0]
    assert "error" not in js, js
    s = js["summary"]
    assert math.isclose(s["medianRetirement"]["nominal"], at_retirement, rel_tol=1e-12)
    assert math.isclose(s["medianRetirement"]["real"], at_retirement / (1 + i) ** n, rel_tol=1e-12)
    assert math.isclose(s["medianFinal"]["nominal"], value, rel_tol=1e-9, abs_tol=1e-6)
    assert s["successProbability"] == (0 if ruined else 100)
    assert math.isclose(s["swr"], (raw["annualSpending"] - raw["pensionIncome"]) / at_retirement * 100, rel_tol=1e-12)
    # The desktop engine gives the same deterministic path.
    inputs = SimulationInputs(
        current_portfolio=float(raw["currentPortfolio"]), annual_contribution=float(raw["annualContribution"]),
        contribution_growth_rate=float(raw["contributionGrowth"]), years_to_retirement=n, years_in_retirement=raw["yearsInRetirement"],
        expected_return=float(raw["expectedReturn"]), volatility=0.0, inflation_rate=float(raw["inflation"]),
        annual_spending=float(raw["annualSpending"]), pension_income=float(raw["pensionIncome"]), simulations=raw["simulations"],
        workbook_path=Path("unused.xlsx"),
    )
    desktop = mc_core.run_monte_carlo(inputs, normal=lambda: 0.0)  # zero shocks, as in the browser run
    assert math.isclose(desktop.median_portfolio_at_retirement, at_retirement, rel_tol=1e-12)
    assert math.isclose(desktop.median_final_value, value, rel_tol=1e-9, abs_tol=1e-6)
    assert desktop.success_probability == (0 if ruined else 100)


def test_monte_carlo_percentiles_use_linear_interpolation():
    # Five paths with distinct shocks at year 1: numpy's linear percentile of the year-1
    # values must equal the browser's P10/P25/P50/P75/P90 for that year.
    raw = dict(currentPortfolio=1000, annualContribution=0, contributionGrowth=0, yearsToRetirement=1, yearsInRetirement=1,
               expectedReturn=5, volatility=10, inflation=0, annualSpending=10, pensionIncome=0, simulations=5)
    z = [-1.5, 0, -0.3, 0, 0.2, 0, 0.9, 0, 2.0, 0]  # per path: accumulation draw, retirement draw
    js = run_js("monte-carlo", [{"raw": raw, "z": z}])[0]
    year1 = np.array([1000 * (1 + 0.05 + 0.10 * zz) for zz in z[::2]])
    bands = js["bands"][1]
    for key, q in [("p10", 10), ("p25", 25), ("p50", 50), ("p75", 75), ("p90", 90)]:
        assert math.isclose(bands[key], float(np.percentile(year1, q)), rel_tol=1e-12)
