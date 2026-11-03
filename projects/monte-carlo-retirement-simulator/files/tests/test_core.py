"""Unit tests for the Monte Carlo simulation engine and input validation."""
import sys
from pathlib import Path

import numpy as np  # noqa: F401 - used in assertions
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from monte_carlo.core import run_monte_carlo, validate_simulation_inputs
from monte_carlo.models import SimulationInputs, ValidationError


def _inputs(**overrides) -> SimulationInputs:
    base = dict(
        current_portfolio=150000.0,
        annual_contribution=10000.0,
        contribution_growth_rate=0.0,
        years_to_retirement=30,
        years_in_retirement=25,
        expected_return=7.0,
        volatility=12.0,
        inflation_rate=2.5,
        annual_spending=60000.0,
        pension_income=18000.0,
        simulations=500,
        workbook_path=Path("unused.xlsx"),
        csv_path=None,
    )
    base.update(overrides)
    return SimulationInputs(**base)


def test_result_shape_and_percentile_ordering():
    """Paths span every year and percentile bands are correctly ordered."""
    result = run_monte_carlo(_inputs(seed=42))
    total_years = 30 + 25
    assert len(result.years) == total_years + 1
    for arr in (result.p10, result.p25, result.p50, result.p75, result.p90):
        assert len(arr) == total_years + 1
    # At the final year, P10 <= P25 <= P50 <= P75 <= P90.
    last = -1
    assert result.p10[last] <= result.p25[last] <= result.p50[last] <= result.p75[last] <= result.p90[last]


def test_success_probability_within_bounds():
    """Probability of success is always a valid percentage and matches failures."""
    sims = 500
    result = run_monte_carlo(_inputs(simulations=sims, seed=7))
    assert 0.0 <= result.success_probability <= 100.0
    assert 0 <= result.failed_simulations <= sims
    expected = (sims - result.failed_simulations) / sims * 100.0
    assert result.success_probability == pytest.approx(expected)


def test_strong_plan_rarely_fails():
    """A well-funded, low-spending plan should almost always succeed."""
    result = run_monte_carlo(
        _inputs(current_portfolio=2_000_000.0, annual_spending=40000.0, pension_income=20000.0, volatility=8.0, seed=1)
    )
    assert result.success_probability >= 95.0


def test_seed_makes_run_deterministic():
    """Same seed + same inputs -> identical results; the seed is reported."""
    first = run_monte_carlo(_inputs(seed=123))
    second = run_monte_carlo(_inputs(seed=123))
    other = run_monte_carlo(_inputs(seed=124))
    assert first.success_probability == second.success_probability
    assert first.median_final_value == second.median_final_value
    assert np.array_equal(first.p50, second.p50)
    assert first.seed == 123 and "mulberry32" in first.rng
    assert not np.array_equal(first.p50, other.p50)


def test_blank_seed_draws_and_reports_a_fresh_seed():
    result = run_monte_carlo(_inputs(seed=None, simulations=20))
    assert isinstance(result.seed, int) and 0 <= result.seed < 4294967295


def test_pension_must_be_less_than_spending():
    with pytest.raises(ValidationError):
        validate_simulation_inputs(
            _inputs(annual_spending=30000.0, pension_income=30000.0), error_type=ValidationError
        )


def test_portfolio_must_be_positive():
    with pytest.raises(ValidationError):
        validate_simulation_inputs(_inputs(current_portfolio=0.0), error_type=ValidationError)


def test_simulation_count_bounds():
    with pytest.raises(ValidationError):
        validate_simulation_inputs(_inputs(simulations=0), error_type=ValidationError)
    with pytest.raises(ValidationError):
        validate_simulation_inputs(_inputs(simulations=10001), error_type=ValidationError)
