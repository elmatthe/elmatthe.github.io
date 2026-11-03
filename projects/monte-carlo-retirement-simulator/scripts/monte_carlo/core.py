"""Pure Monte Carlo simulation engine, input parsing and validation.

No GUI imports. Only depends on numpy, so it can be tested in isolation. Mirrors
assets/js/monte-carlo/engine.js on the website: same number grammar, validation order
and messages, spending basis, warnings and seeded generator (see rng.py), so the same
inputs and seed give the same results in both apps.
"""
from __future__ import annotations

import math
import re

from monte_carlo.deps import np, require_numpy
from monte_carlo.models import (
    DEFAULT_SPENDING_BASIS,
    ENGINE_VERSION,
    HIGH_VOLATILITY,
    MAX_ABS_RATE_INPUT,
    MAX_MONETARY_INPUT,
    MAX_SIMULATIONS,
    MAX_VOLATILITY_INPUT,
    MAX_YEARS_INPUT,
    RNG_NAME,
    SPENDING_BASES,
    TOTAL_LOSS_WARN,
    SimulationInputs,
    SimulationResult,
)

# One number grammar for both apps (engine.js NUMBER_PATTERN): optional sign, ASCII
# digits with an optional decimal point, optional exponent.
NUMBER_PATTERN = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", re.ASCII)

RAW_FIELDS = {
    "currentPortfolio": "current_portfolio",
    "annualContribution": "annual_contribution",
    "contributionGrowth": "contribution_growth_rate",
    "yearsToRetirement": "years_to_retirement",
    "yearsInRetirement": "years_in_retirement",
    "expectedReturn": "expected_return",
    "volatility": "volatility",
    "inflation": "inflation_rate",
    "annualSpending": "annual_spending",
    "pensionIncome": "pension_income",
    "simulations": "simulations",
}


class FieldError(ValueError):
    """A validation message plus the web field name it refers to."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.field = field


def parse_number_text(text) -> float | None:
    trimmed = str("" if text is None else text).strip()
    if not NUMBER_PATTERN.fullmatch(trimmed):
        return None
    value = float(trimmed)
    return value if math.isfinite(value) else None


def parse_raw_inputs(raw: dict, error_type=FieldError, **extra) -> SimulationInputs:
    """Text inputs keyed like the web app -> validated SimulationInputs.

    Same parsing order and messages as engine.js validateInputs. `extra` supplies
    workbook_path, csv_path and seed.
    """
    def fail(message: str, field: str):
        if error_type is FieldError:
            raise FieldError(message, field)
        error = error_type(message)
        error.field = field  # type: ignore[attr-defined]
        raise error

    def number(field: str, message: str) -> float:
        value = parse_number_text(raw.get(field))
        if value is None:
            fail(message, field)
        return value  # type: ignore[return-value]

    def integer(field: str, message: str) -> int:
        value = number(field, message)
        if not float(value).is_integer():
            fail(message, field)
        return int(value)

    values = {
        "currentPortfolio": number("currentPortfolio", "Current portfolio value must be a finite numeric value."),
        "annualContribution": number("annualContribution", "Annual contribution must be a finite numeric value."),
        "contributionGrowth": number("contributionGrowth", "Contribution growth rate must be a finite numeric value."),
        "yearsToRetirement": integer("yearsToRetirement", f"Years to retirement must be between 1 and {MAX_YEARS_INPUT}."),
        "yearsInRetirement": integer("yearsInRetirement", f"Years in retirement must be between 1 and {MAX_YEARS_INPUT}."),
        "expectedReturn": number("expectedReturn", "Expected annual return must be a finite numeric value."),
        "volatility": number("volatility", "Volatility must be a finite numeric value."),
        "inflation": number("inflation", "Inflation rate must be a finite numeric value."),
        "annualSpending": number("annualSpending", "Annual retirement spending must be a finite numeric value."),
        "pensionIncome": number("pensionIncome", "CPP / OAS / Pension income must be a finite numeric value."),
        "simulations": integer("simulations", f"Number of simulations must be a whole number between 1 and {MAX_SIMULATIONS:,}."),
    }
    basis = str(raw.get("spendingBasis") or "").strip() or DEFAULT_SPENDING_BASIS
    if basis not in SPENDING_BASES:
        fail('Spending basis must be "retirement" or "today".', "spendingBasis")
    inputs = SimulationInputs(
        **{RAW_FIELDS[k]: v for k, v in values.items()},
        workbook_path=extra.get("workbook_path"),
        csv_path=extra.get("csv_path"),
        spending_basis=basis,
        seed=extra.get("seed"),
    )
    validate_simulation_inputs(inputs, error_type=error_type)
    return inputs


_FIELD_OF_MESSAGE = (
    ("Current portfolio", "currentPortfolio"),
    ("Annual contribution", "annualContribution"),
    ("Annual retirement spending", "annualSpending"),
    ("CPP", "pensionIncome"),
    ("Contribution growth", "contributionGrowth"),
    ("Expected annual return", "expectedReturn"),
    ("Volatility", "volatility"),
    ("Inflation rate", "inflation"),
    ("Years to retirement", "yearsToRetirement"),
    ("Years in retirement", "yearsInRetirement"),
    ("Number of simulations", "simulations"),
    ("Spending basis", "spendingBasis"),
)


def validate_simulation_inputs(inputs: SimulationInputs, error_type=ValueError) -> None:
    """Reject invalid or numerically unstable configurations before running."""
    def _raise(message: str) -> None:
        error = error_type(message)
        field = next((f for prefix, f in _FIELD_OF_MESSAGE if message.startswith(prefix)), None)
        try:
            error.field = field  # type: ignore[attr-defined]
        except AttributeError:  # pragma: no cover - built-in exception types accept attributes
            pass
        raise error

    if inputs.spending_basis not in SPENDING_BASES:
        _raise('Spending basis must be "retirement" or "today".')

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


def inflation_factor(inflation_percent: float, years: int) -> float:
    """(1 + inflation)^years by repeated multiplication (bit-identical to engine.js)."""
    step = 1 + inflation_percent / 100
    factor = 1.0
    for _ in range(years):
        factor *= step
    return factor


def first_year_withdrawal(inputs: SimulationInputs) -> dict:
    """First-year net withdrawal in retirement-year dollars, as the model uses it."""
    entered = inputs.annual_spending - inputs.pension_income
    basis = inputs.spending_basis or DEFAULT_SPENDING_BASIS
    factor = inflation_factor(inputs.inflation_rate, inputs.years_to_retirement) if basis == "today" else 1.0
    return {"entered": entered, "factor": factor, "nominal": entered * factor, "basis": basis}


def normal_cdf(x: float) -> float:
    """Numerical Recipes erfc approximation, exactly as engine.js normalCdf."""
    z = abs(x) / math.sqrt(2)
    t = 1 / (1 + 0.5 * z)
    erfc = t * math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
        + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
    return 1 - 0.5 * erfc if x >= 0 else 0.5 * erfc


def total_loss_probability(inputs: SimulationInputs) -> float:
    if inputs.volatility <= 0:
        return 1.0 if inputs.expected_return < -100 else 0.0
    return normal_cdf((-100 - inputs.expected_return) / inputs.volatility)


def typical_growth(expected_return_percent: float, volatility_percent: float) -> float | None:
    """Approximate median compound growth per year in percent (engine.js typicalGrowth)."""
    mu = expected_return_percent / 100
    sigma = volatility_percent / 100
    if mu <= -1:
        return None
    return (math.exp(math.log(1 + mu) - (sigma * sigma) / (2 * (1 + mu) * (1 + mu))) - 1) * 100


def _percent_text(value: float) -> str:
    return f"{value:.1f}" if value >= 1 else f"{value:.2f}"


def assumption_warnings(inputs: SimulationInputs) -> list[dict]:
    """Non-blocking warnings about the assumptions (same text as the web app)."""
    out: list[dict] = []
    mu = inputs.expected_return
    sigma = inputs.volatility
    if mu != 0 and abs(mu) < 1:
        out.append({"code": "return_looks_fractional", "message": "Expected return is entered in percent: a value between -1 and 1 (for example 0.07) means less than 1% a year. For 7% a year, enter 7."})
    if 0 < sigma < 1:
        out.append({"code": "volatility_looks_fractional", "message": "Volatility is entered in percent: a value below 1 (for example 0.12) means less than 1% a year. For 12%, enter 12."})
    if sigma > HIGH_VOLATILITY:
        out.append({"code": "volatility_high", "message": f"Volatility above {HIGH_VOLATILITY:.0f}% a year is far higher than diversified portfolios have shown historically; treat these results with caution."})
    loss = total_loss_probability(inputs)
    if loss >= TOTAL_LOSS_WARN:
        out.append({"code": "returns_below_total_loss", "message": f"With this expected return and volatility, about {_percent_text(loss * 100)}% of simulated years return less than -100% (a loss larger than the whole portfolio), which a real portfolio cannot do. The model treats such a year as a total loss (the balance becomes $0), so the results overstate the risk of running out. Consider a lower volatility."})
    if inputs.inflation_rate <= -100:
        out.append({"code": "real_values_undefined", "message": "With inflation at -100%, real (today's) dollars are undefined; results are available in nominal dollars only."})
    return out


def _percentile_sorted(values: list[float], q: float) -> float:
    """numpy 'linear' percentile on a sorted list (engine.js percentileSorted)."""
    if not values:
        return 0.0
    idx = (len(values) - 1) * q
    lo, hi = math.floor(idx), math.ceil(idx)
    return values[lo] if lo == hi else values[lo] * (1 - (idx - lo)) + values[hi] * (idx - lo)


def run_monte_carlo(inputs: SimulationInputs, normal=None) -> SimulationResult:
    """Run the two-phase (accumulation + decumulation) Monte Carlo simulation.

    `normal` returns standard-normal draws. By default the seeded generator in rng.py
    is used with inputs.seed (a fresh seed when None); tests inject their own draws.
    """
    require_numpy()
    assert np is not None
    validate_simulation_inputs(inputs, error_type=ValueError)

    seed = inputs.seed
    rng_name = RNG_NAME
    if normal is None:
        from monte_carlo.rng import SeededNormal, random_seed

        if seed is None:
            seed = random_seed()
        normal = SeededNormal(seed)
    else:
        rng_name = "injected draws (test)"

    total_years = inputs.years_to_retirement + inputs.years_in_retirement
    years = np.arange(total_years + 1)

    paths = np.zeros((inputs.simulations, total_years + 1), dtype=float)
    ruin_years: list[int] = []
    final_values = np.zeros(inputs.simulations, dtype=float)
    retirement_values = np.zeros(inputs.simulations, dtype=float)

    first = first_year_withdrawal(inputs)
    net_withdrawal = first["nominal"]
    if not math.isfinite(net_withdrawal):
        raise ValueError(
            "Inflation-adjusted withdrawal produced non-finite values. "
            "Use smaller spending/pension inputs or inflation rates."
        )
    mean_return = inputs.expected_return / 100.0
    volatility = inputs.volatility / 100.0
    contrib_growth = inputs.contribution_growth_rate / 100.0
    inflation_rate = inputs.inflation_rate / 100.0
    draws = 0

    for sim_idx in range(inputs.simulations):
        portfolio = inputs.current_portfolio
        contribution = inputs.annual_contribution
        row = [0.0] * (total_years + 1)
        row[0] = portfolio
        ruined = False
        ruin_year = None

        for year in range(1, inputs.years_to_retirement + 1):
            draws += 1
            annual_return = mean_return + volatility * normal()
            portfolio = portfolio * (1.0 + annual_return) + contribution
            if not math.isfinite(portfolio):
                raise ValueError(
                    "Simulation produced non-finite values. "
                    "Reduce large input magnitudes and try again."
                )
            # Accumulation can recover via future contributions, so only clamp negatives.
            if portfolio < 0:
                portfolio = 0.0
            row[year] = portfolio
            contribution *= 1.0 + contrib_growth
            if not math.isfinite(contribution):
                raise ValueError(
                    "Contribution growth produced non-finite values. "
                    "Use smaller contribution inputs or growth rates."
                )

        retirement_withdrawal = net_withdrawal
        for retire_year in range(1, inputs.years_in_retirement + 1):
            year_idx = inputs.years_to_retirement + retire_year

            if ruined:
                row[year_idx] = 0.0
                continue

            draws += 1
            annual_return = mean_return + volatility * normal()
            portfolio = portfolio * (1.0 + annual_return) - retirement_withdrawal
            if not math.isfinite(portfolio):
                raise ValueError(
                    "Simulation produced non-finite values during retirement. "
                    "Reduce large input magnitudes and try again."
                )
            # Retirement cannot recover after hitting zero; treat zero as failure.
            if portfolio <= 0:
                portfolio = 0.0
                ruined = True
                ruin_year = retire_year
            row[year_idx] = portfolio
            retirement_withdrawal *= 1.0 + inflation_rate
            if not math.isfinite(retirement_withdrawal):
                raise ValueError(
                    "Inflation-adjusted withdrawal produced non-finite values. "
                    "Use smaller spending/pension inputs or inflation rates."
                )

        if ruin_year is not None:
            ruin_years.append(ruin_year)

        paths[sim_idx] = row
        final_values[sim_idx] = portfolio
        retirement_values[sim_idx] = row[inputs.years_to_retirement]

    if not np.isfinite(paths).all():
        raise ValueError(
            "Simulation produced invalid values. "
            "Please use smaller magnitudes for portfolio/contribution/spending."
        )

    p10, p25, p50, p75, p90 = np.percentile(paths, [10, 25, 50, 75, 90], axis=0)

    failed_simulations = len(ruin_years)
    success_probability = ((inputs.simulations - failed_simulations) / inputs.simulations) * 100.0
    median_retirement = float(np.percentile(retirement_values, 50))
    finals = np.percentile(final_values, [10, 25, 50, 75, 90])
    swr = (net_withdrawal / median_retirement * 100.0) if median_retirement > 0 else 0.0
    median_ruin_year = _percentile_sorted(sorted(float(y) for y in ruin_years), 0.5) if ruin_years else None

    scalar_values = [success_probability, median_retirement, *[float(v) for v in finals], swr]
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
        median_final_value=float(finals[2]),
        p10_final_value=float(finals[0]),
        p90_final_value=float(finals[4]),
        safe_withdrawal_rate=swr,
        failed_simulations=failed_simulations,
        median_ruin_year=median_ruin_year,
        net_withdrawal=net_withdrawal,
        net_withdrawal_entered=first["entered"],
        spending_basis=first["basis"],
        inflation_factor_to_retirement=first["factor"],
        seed=seed,
        rng=rng_name,
        engine_version=ENGINE_VERSION,
        warnings=assumption_warnings(inputs),
        draws=draws,
        inflation_rate=inputs.inflation_rate,
        p25_final_value=float(finals[1]),
        p75_final_value=float(finals[3]),
    )
