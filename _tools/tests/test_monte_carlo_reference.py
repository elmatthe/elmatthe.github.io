"""Monte Carlo simulator: both engines against INDEPENDENT expected values.

- a plain-integer Python port of mulberry32 + Box-Muller written from the algorithm,
  checked against the desktop generator (rng.py) and the browser generator (engine.js);
- a small reference simulator written here from the documented model (MODEL_NOTE),
  driven by that generator, checked against both engines' seeded runs;
- a five-path case with injected draws whose every number is calculated by hand below;
- a two-year case whose probability of success is a one-dimensional integral (scipy),
  checking that the seeded generator gives the right distribution end to end.
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
ENGINE = ROOT / "assets" / "js" / "monte-carlo" / "engine.js"
sys.path.insert(0, str(ROOT / "projects" / "monte-carlo-retirement-simulator" / "scripts"))
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")

np = pytest.importorskip("numpy")
from monte_carlo import core as mc_core  # noqa: E402
from monte_carlo.models import SimulationInputs  # noqa: E402
from monte_carlo.rng import SeededNormal  # noqa: E402

KEYS = ("p10", "p25", "p50", "p75", "p90")


def run_js(cases: list) -> list:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"tool": "monte-carlo", "cases": cases}),
                            capture_output=True, text=True, encoding="utf-8", timeout=300, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def desktop_inputs(raw: dict, seed: int | None = None) -> SimulationInputs:
    return SimulationInputs(
        current_portfolio=float(raw["currentPortfolio"]), annual_contribution=float(raw["annualContribution"]),
        contribution_growth_rate=float(raw["contributionGrowth"]), years_to_retirement=int(raw["yearsToRetirement"]),
        years_in_retirement=int(raw["yearsInRetirement"]), expected_return=float(raw["expectedReturn"]),
        volatility=float(raw["volatility"]), inflation_rate=float(raw["inflation"]), annual_spending=float(raw["annualSpending"]),
        pension_income=float(raw["pensionIncome"]), simulations=int(raw["simulations"]), workbook_path=Path("unused.xlsx"),
        spending_basis=raw.get("spendingBasis", "retirement"), seed=seed,
    )


# ------------------------------------------------------------ reference generator
def reference_normal(seed: int):
    """mulberry32 (Tommy Ettinger's 32-bit generator) with plain Python integers, then the
    Box-Muller cosine branch: z = sqrt(-2 ln max(u1, 1e-12)) cos(2 pi u2)."""
    state = seed & 0xFFFFFFFF

    def uniform() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ (t + ((t ^ (t >> 7)) * (t | 61)))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def normal() -> float:
        u1 = max(uniform(), 1e-12)
        u2 = uniform()
        return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)

    return normal


def js_draws(seed: int, count: int) -> list[float]:
    script = (f"import * as E from {json.dumps(ENGINE.as_uri())};"
              f"const n = E.boxMuller(E.mulberry32({seed}));"
              f"process.stdout.write(JSON.stringify(Array.from({{length: {count}}}, () => n())));")
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("seed", [0, 1, 42, 4294967295])
def test_both_generators_match_an_independent_mulberry32_box_muller(seed):
    ref = reference_normal(seed)
    expected = [ref() for _ in range(70_000)]  # crosses the desktop's 32,768-normal refill
    desktop = SeededNormal(seed)
    assert [desktop() for _ in range(70_000)] == expected
    browser = js_draws(seed, 3_000)
    assert max(abs(a - b) for a, b in zip(browser, expected)) < 1e-12


# ------------------------------------------------------------ reference simulator
def reference_simulation(raw: dict, normal) -> dict:
    """The documented model, written independently of both engines."""
    n, m, sims = raw["yearsToRetirement"], raw["yearsInRetirement"], raw["simulations"]
    mu, sd = raw["expectedReturn"] / 100, raw["volatility"] / 100
    growth, infl = raw["contributionGrowth"] / 100, raw["inflation"] / 100
    entered = raw["annualSpending"] - raw["pensionIncome"]
    first = entered * (1 + infl) ** n if raw.get("spendingBasis") == "today" else entered
    paths = np.zeros((sims, n + m + 1))
    ruin_years = []
    for s in range(sims):
        value = paths[s, 0] = raw["currentPortfolio"]
        for k in range(1, n + 1):  # year-end contribution c(1+g)^(k-1); negative floored at 0
            value = max(0.0, value * (1 + mu + sd * normal()) + raw["annualContribution"] * (1 + growth) ** (k - 1))
            paths[s, k] = value
        for k in range(1, m + 1):  # year-end withdrawal W1(1+i)^(k-1); <= 0 is ruin, then 0
            value = value * (1 + mu + sd * normal()) - first * (1 + infl) ** (k - 1)
            if value <= 0:
                ruin_years.append(k)
                break
            paths[s, n + k] = value
    at_retirement, final = paths[:, n], paths[:, -1]
    median_ret = float(np.percentile(at_retirement, 50))
    return {
        "bands": np.percentile(paths, [10, 25, 50, 75, 90], axis=0),
        "real": np.percentile(paths, [10, 25, 50, 75, 90], axis=0) / (1 + infl) ** np.arange(n + m + 1),
        "failed": len(ruin_years), "success": 100 * (sims - len(ruin_years)) / sims,
        "median_ret": median_ret, "median_final": float(np.percentile(final, 50)),
        "p10_final": float(np.percentile(final, 10)), "p90_final": float(np.percentile(final, 90)),
        "swr": first / median_ret * 100 if median_ret > 0 else 0.0, "first": first,
        "ruin": float(np.percentile(ruin_years, 50)) if ruin_years else None,
    }


def scenarios(count: int = 20):
    rng = random.Random(20261123)
    for _ in range(count):
        yield dict(currentPortfolio=rng.choice([20000, 150000, 900000]), annualContribution=rng.choice([0, 8000, 30000]),
                   contributionGrowth=rng.choice([-3, 0, 3]), yearsToRetirement=rng.randint(1, 35), yearsInRetirement=rng.randint(1, 40),
                   expectedReturn=rng.choice([-2, 4, 7, 10]), volatility=rng.choice([0, 6, 15, 30]), inflation=rng.choice([-1, 0, 2.5, 6]),
                   annualSpending=rng.choice([30000, 70000, 150000]), pensionIncome=rng.choice([0, 10000, 25000]),
                   simulations=rng.randint(1, 200), spendingBasis=rng.choice(["retirement", "today"])), rng.randrange(2 ** 32)


def close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)


def test_seeded_runs_match_an_independent_reference_simulation():
    cases = list(scenarios())
    browser = run_js([{"raw": raw, "seed": seed} for raw, seed in cases])
    for (raw, seed), b in zip(cases, browser):
        assert "error" not in b, b
        ref = reference_simulation(raw, reference_normal(seed))
        d = mc_core.run_monte_carlo(desktop_inputs(raw, seed))
        s = b["summary"]
        assert d.failed_simulations == s["failedRuns"] == ref["failed"], raw
        for label, desktop, web, expected in [
            ("success", d.success_probability, s["successProbability"], ref["success"]),
            ("median at retirement", d.median_portfolio_at_retirement, s["medianRetirement"]["nominal"], ref["median_ret"]),
            ("median final", d.median_final_value, s["medianFinal"]["nominal"], ref["median_final"]),
            ("p10 final", d.p10_final_value, s["finalP10"]["nominal"], ref["p10_final"]),
            ("p90 final", d.p90_final_value, s["finalP90"]["nominal"], ref["p90_final"]),
            ("initial withdrawal rate", d.safe_withdrawal_rate, s["swr"], ref["swr"]),
            ("first-year withdrawal", d.net_withdrawal, s["netWithdrawal"], ref["first"]),
            ("median ruin year", d.median_ruin_year, s["medianRuinYear"], ref["ruin"]),
        ]:
            assert close(desktop, expected) and close(web, expected), (raw, seed, label, desktop, web, expected)
        for q, key in enumerate(KEYS):
            desktop_series = getattr(d, key)
            for year in range(len(desktop_series)):
                assert close(float(desktop_series[year]), ref["bands"][q, year]), (raw, key, year)
                assert close(b["bands"][year][key], ref["bands"][q, year]), (raw, key, year)
                assert close(b["real"][year][key], ref["real"][q, year]), (raw, key, year)
                assert close(d.real(float(desktop_series[year]), year), ref["real"][q, year]), (raw, key, year)


# ------------------------------------------------------------ hand-calculated case
# Return 0%, volatility 10% (so r = 0.10 z), inflation 10%, 2 saving years, 5 retirement
# years, $100,000 today, $5,000 contribution growing 10% (5,000 then 5,500), spending
# $40,000 less $10,000 pension = $30,000 in TODAY's dollars -> W1 = 30,000 x 1.1^2 = 36,300,
# then 39,930; 43,923; 48,315.30; 53,146.83.
HAND = dict(currentPortfolio=100000, annualContribution=5000, contributionGrowth=10, yearsToRetirement=2, yearsInRetirement=5,
            expectedReturn=0, volatility=10, inflation=10, annualSpending=40000, pensionIncome=10000, simulations=5,
            spendingBasis="today")
HAND_Z = (
    [0, 0, 0, 0, 0]          # A: 105,000; 110,500 | 74,200; 34,270; -9,653 -> ruin in year 3
    + [0, 0, 3, 0, 0, 0]     # B: 110,500 | x1.3 = 143,650 - 36,300 = 107,350; 67,420; 23,497; -24,818.30 -> ruin year 4
    + [10, 10, 0, 0, 0, 0, 0]  # C: 205,000; 415,500 | 379,200; 339,270; 295,347; 247,031.70; 193,884.87 survives
    + [-15, 0, 0]            # D: -150% -> -45,000 floored to 0; 0 + 5,500 = 5,500 | 5,500 - 36,300 -> ruin year 1
    + [0, 0, 3, 0, 0, 0]     # E: same as B -> ruin year 4
)
# Ruin years [1, 3, 4, 4]: median (3 + 4) / 2 = 3.5; success 1 of 5 = 20%.
HAND_BANDS = {
    0: [100000] * 5,
    1: [0.4 * 105000, 105000, 105000, 105000, 105000 + 0.6 * 100000],     # sorted 0, 105k x3, 205k
    2: [5500 + 0.4 * 105000, 110500, 110500, 110500, 110500 + 0.6 * 305000],  # 5.5k, 110.5k x3, 415.5k
    3: [0.4 * 74200, 74200, 107350, 107350, 107350 + 0.6 * 271850],        # 0, 74.2k, 107.35k x2, 379.2k
    7: [0, 0, 0, 0, 0.6 * 193884.87],                                     # 0 x4, 193,884.87
}


def test_hand_calculated_paths_in_both_engines():
    (b,) = run_js([{"raw": HAND, "z": HAND_Z}])
    assert "error" not in b, b
    draws = iter(HAND_Z)
    d = mc_core.run_monte_carlo(desktop_inputs(HAND), normal=lambda: next(draws))
    s = b["summary"]
    assert b["used"] == d.draws == len(HAND_Z) == 27  # ruined paths stop drawing
    assert d.failed_simulations == s["failedRuns"] == 4
    assert d.success_probability == s["successProbability"] == 20
    assert d.median_ruin_year == s["medianRuinYear"] == 3.5
    for value in (d.net_withdrawal, s["netWithdrawal"]):
        assert math.isclose(value, 36300, rel_tol=1e-12)
    assert d.net_withdrawal_entered == s["netWithdrawalEntered"] == 30000
    for value in (d.median_portfolio_at_retirement, s["medianRetirement"]["nominal"]):
        assert math.isclose(value, 110500, rel_tol=1e-12)
    assert math.isclose(s["medianRetirement"]["real"], 110500 / 1.21, rel_tol=1e-12)
    for value in (d.safe_withdrawal_rate, s["swr"]):
        assert math.isclose(value, 36300 / 110500 * 100, rel_tol=1e-12)
    assert d.median_final_value == s["medianFinal"]["nominal"] == 0
    for value in (d.p90_final_value, s["finalP90"]["nominal"]):
        assert math.isclose(value, 0.6 * 193884.87, rel_tol=1e-12)
    assert math.isclose(s["finalP90"]["real"], 0.6 * 193884.87 / 1.1 ** 7, rel_tol=1e-12)
    for year, expected in HAND_BANDS.items():
        for q, key in enumerate(KEYS):
            assert math.isclose(b["bands"][year][key], expected[q], rel_tol=1e-12, abs_tol=1e-9), (year, key)
            assert math.isclose(float(getattr(d, key)[year]), expected[q], rel_tol=1e-12, abs_tol=1e-9), (year, key)
            assert math.isclose(b["real"][year][key], expected[q] / 1.1 ** year, rel_tol=1e-12, abs_tol=1e-9), (year, key)


# ------------------------------------------------------------ distribution check
def test_seeded_success_probability_matches_the_exact_two_year_probability():
    """1 saving year, 1 retirement year, no contribution: V1 = V0 (1 + mu + s z1), floored
    at 0; failure iff V1 (1 + mu + s z2) - W <= 0. So
        P(fail) = P(V1 <= 0) + integral over z1 with V1 > 0 of phi(z1) Phi(((W / V1) - 1 - mu) / s).
    The median at retirement is V0 (1 + mu) exactly in distribution."""
    stats = pytest.importorskip("scipy.stats")
    integrate = pytest.importorskip("scipy.integrate")
    v0, mu, s, w, sims = 100000.0, 0.05, 0.15, 90000.0, 10000
    z_zero = -(1 + mu) / s
    fail_when_positive, _ = integrate.quad(
        lambda z: stats.norm.pdf(z) * stats.norm.cdf((w / (v0 * (1 + mu + s * z)) - 1 - mu) / s), z_zero, np.inf, limit=200)
    p_fail = stats.norm.cdf(z_zero) + fail_when_positive
    raw = dict(currentPortfolio=v0, annualContribution=0, contributionGrowth=0, yearsToRetirement=1, yearsInRetirement=1,
               expectedReturn=mu * 100, volatility=s * 100, inflation=0, annualSpending=w, pensionIncome=0, simulations=sims)
    se = math.sqrt(p_fail * (1 - p_fail) / sims)
    median_se = 1.2533 * v0 * s / math.sqrt(sims)  # sqrt(pi/2) sigma / sqrt(N)
    browser = run_js([{"raw": raw, "seed": seed} for seed in (3, 2026)])
    for seed, b in zip((3, 2026), browser):
        d = mc_core.run_monte_carlo(desktop_inputs(raw, seed))
        assert d.failed_simulations == b["summary"]["failedRuns"]
        assert abs(d.failed_simulations / sims - p_fail) < 4 * se, (seed, d.failed_simulations / sims, p_fail)
        assert abs(d.median_portfolio_at_retirement - v0 * (1 + mu)) < 4 * median_se
