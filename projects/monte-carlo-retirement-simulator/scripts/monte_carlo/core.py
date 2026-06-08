"""Pure Monte Carlo simulation engine and input validation.

No GUI imports. Only depends on numpy, so it can be tested in isolation.
"""
from __future__ import annotations

import math

from monte_carlo.deps import np, require_numpy
from monte_carlo.models import (
    MAX_ABS_RATE_INPUT,
    MAX_MONETARY_INPUT,
    MAX_SIMULATIONS,
    MAX_VOLATILITY_INPUT,
    MAX_YEARS_INPUT,
    SimulationInputs,
    SimulationResult,
)


def validate_simulation_inputs(inputs: SimulationInputs, error_type=ValueError) -> None:
    """Reject invalid or numerically unstable configurations before running."""
    def _raise(message: str) -> None:
        raise error_type(message)

    monetary_checks = (
        ("Current portfolio value", inputs.current_portfolio, True),
        ("Annual contribution", inputs.annual_contribution, False),
        ("Annual retirement spending", inputs.annual_spending, True),
        ("CPP / OAS / Pension income", inputs.pension_income, False),
    )
    for label, value, must_be_positive in monetary_checks:
        if not math.isfinite(float(value)):
            _raise(f"{label} must be a finite numeric value.")
        if must_be_positive and value <= 0:
            _raise(f"{label} must be greater than 0.")
        if not must_be_positive and value < 0:
            _raise(f"{label} must be 0 or greater.")
        if abs(value) > MAX_MONETARY_INPUT:
            _raise(
                f"{label} is too large. Use values less than or equal to "
                f"{MAX_MONETARY_INPUT:,.0f}."
            )

    if not math.isfinite(float(inputs.contribution_growth_rate)):
        _raise("Contribution growth rate must be a finite numeric value.")
    if abs(inputs.contribution_growth_rate) > MAX_ABS_RATE_INPUT:
        _raise(
            f"Contribution growth rate must be between "
            f"-{MAX_ABS_RATE_INPUT:.0f}% and {MAX_ABS_RATE_INPUT:.0f}%."
        )

    if not math.isfinite(float(inputs.expected_return)):
        _raise("Expected annual return must be a finite numeric value.")
    if abs(inputs.expected_return) > MAX_ABS_RATE_INPUT:
        _raise(
            f"Expected annual return must be between "
            f"-{MAX_ABS_RATE_INPUT:.0f}% and {MAX_ABS_RATE_INPUT:.0f}%."
        )

    if not math.isfinite(float(inputs.volatility)):
        _raise("Volatility must be a finite numeric value.")
    if inputs.volatility < 0 or inputs.volatility > MAX_VOLATILITY_INPUT:
        _raise(f"Volatility must be between 0% and {MAX_VOLATILITY_INPUT:.0f}%.")

    if not math.isfinite(float(inputs.inflation_rate)):
        _raise("Inflation rate must be a finite numeric value.")
    if abs(inputs.inflation_rate) > MAX_ABS_RATE_INPUT:
        _raise(
            f"Inflation rate must be between "
            f"-{MAX_ABS_RATE_INPUT:.0f}% and {MAX_ABS_RATE_INPUT:.0f}%."
        )

    if inputs.years_to_retirement < 1 or inputs.years_to_retirement > MAX_YEARS_INPUT:
        _raise(f"Years to retirement must be between 1 and {MAX_YEARS_INPUT}.")
    if inputs.years_in_retirement < 1 or inputs.years_in_retirement > MAX_YEARS_INPUT:
        _raise(f"Years in retirement must be between 1 and {MAX_YEARS_INPUT}.")
    if inputs.simulations < 1 or inputs.simulations > MAX_SIMULATIONS:
        _raise(f"Number of simulations must be a whole number between 1 and {MAX_SIMULATIONS:,}.")

    if inputs.pension_income >= inputs.annual_spending:
        _raise(
            "CPP/OAS/Pension income must be less than annual retirement spending. "
            "If pension income fully covers spending, simulation is not required."
        )


def run_monte_carlo(inputs: SimulationInputs) -> SimulationResult:
    """Run the two-phase (accumulation + decumulation) Monte Carlo simulation."""
    require_numpy()
    assert np is not None
    validate_simulation_inputs(inputs, error_type=ValueError)

    total_years = inputs.years_to_retirement + inputs.years_in_retirement
    years = np.arange(total_years + 1)

    paths = np.zeros((inputs.simulations, total_years + 1), dtype=float)
    ruin_years: list[int] = []
    final_values = np.zeros(inputs.simulations, dtype=float)
    retirement_values = np.zeros(inputs.simulations, dtype=float)

    net_withdrawal = inputs.annual_spending - inputs.pension_income
    mean_return = inputs.expected_return / 100.0
    volatility = inputs.volatility / 100.0
    contrib_growth = inputs.contribution_growth_rate / 100.0
    inflation_rate = inputs.inflation_rate / 100.0

    for sim_idx in range(inputs.simulations):
        portfolio = inputs.current_portfolio
        contribution = inputs.annual_contribution
        paths[sim_idx, 0] = portfolio
        ruined = False
        ruin_year = None

        for year in range(1, inputs.years_to_retirement + 1):
            annual_return = float(np.random.normal(mean_return, volatility))
            portfolio = portfolio * (1.0 + annual_return) + contribution
            if not np.isfinite(portfolio):
                raise ValueError(
                    "Simulation produced non-finite values. "
                    "Reduce large input magnitudes and try again."
                )
            # Accumulation can recover via future contributions, so only clamp negatives.
            if portfolio < 0:
                portfolio = 0.0
            paths[sim_idx, year] = portfolio
            contribution *= 1.0 + contrib_growth
            if not np.isfinite(contribution):
                raise ValueError(
                    "Contribution growth produced non-finite values. "
                    "Use smaller contribution inputs or growth rates."
                )

        retirement_withdrawal = net_withdrawal
        for retire_year in range(1, inputs.years_in_retirement + 1):
            year_idx = inputs.years_to_retirement + retire_year

            if ruined:
                paths[sim_idx, year_idx] = 0.0
                continue

            annual_return = float(np.random.normal(mean_return, volatility))
            portfolio = portfolio * (1.0 + annual_return) - retirement_withdrawal
            if not np.isfinite(portfolio):
                raise ValueError(
                    "Simulation produced non-finite values during retirement. "
                    "Reduce large input magnitudes and try again."
                )
            # Retirement cannot recover after hitting zero; treat zero as failure.
            if portfolio <= 0:
                portfolio = 0.0
                ruined = True
                ruin_year = retire_year
            paths[sim_idx, year_idx] = portfolio
            retirement_withdrawal *= 1.0 + inflation_rate
            if not np.isfinite(retirement_withdrawal):
                raise ValueError(
                    "Inflation-adjusted withdrawal produced non-finite values. "
                    "Use smaller spending/pension inputs or inflation rates."
                )

        if ruin_year is not None:
            ruin_years.append(ruin_year)

        final_values[sim_idx] = portfolio
        retirement_values[sim_idx] = paths[sim_idx, inputs.years_to_retirement]

    if not np.isfinite(paths).all():
        raise ValueError(
            "Simulation produced invalid values. "
            "Please use smaller magnitudes for portfolio/contribution/spending."
        )

    p10, p25, p50, p75, p90 = np.percentile(paths, [10, 25, 50, 75, 90], axis=0)

    failed_simulations = len(ruin_years)
    success_probability = ((inputs.simulations - failed_simulations) / inputs.simulations) * 100.0
    median_retirement = float(np.percentile(retirement_values, 50))
    median_final = float(np.percentile(final_values, 50))
    p10_final = float(np.percentile(final_values, 10))
    p90_final = float(np.percentile(final_values, 90))
    swr = (net_withdrawal / median_retirement * 100.0) if median_retirement > 0 else 0.0
    median_ruin_year = float(np.median(np.array(ruin_years))) if ruin_years else None

    scalar_values = [
        success_probability,
        median_retirement,
        median_final,
        p10_final,
        p90_final,
        swr,
    ]
    if not all(math.isfinite(float(v)) for v in scalar_values):
        raise ValueError(
            "Simulation output became non-finite. "
            "Reduce large input magnitudes and try again."
        )

    return SimulationResult(
        years=years,
        p10=p10,
        p25=p25,
        p50=p50,
        p75=p75,
        p90=p90,
        success_probability=success_probability,
        median_portfolio_at_retirement=median_retirement,
        median_final_value=median_final,
        p10_final_value=p10_final,
        p90_final_value=p90_final,
        safe_withdrawal_rate=swr,
        failed_simulations=failed_simulations,
        median_ruin_year=median_ruin_year,
        net_withdrawal=net_withdrawal,
    )
