"""Randomized but plausible sample scenarios (same ranges and rules as the web app)."""
from __future__ import annotations

import random


def _step(rng: random.Random, low: float, high: float, step: float) -> float:
    steps = int(round((high - low) / step))
    return round(low + step * rng.randint(0, steps), 2)


def _trim(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def sample_scenario(rng: random.Random | None = None) -> dict[str, str]:
    """Raw text inputs keyed like the web app. Pension is always at least $5,000 below
    spending, so a sample never fails the 'pension must be less than spending' rule."""
    rng = rng or random.Random()
    spending = _step(rng, 30000, 120000, 5000)
    pension = min(_step(rng, 0, 40000, 1000), spending - 5000)
    return {
        "currentPortfolio": str(int(_step(rng, 25000, 750000, 5000))),
        "annualContribution": str(int(_step(rng, 0, 40000, 1000))),
        "contributionGrowth": _trim(_step(rng, 0, 5, 0.5)),
        "yearsToRetirement": str(rng.randint(5, 40)),
        "yearsInRetirement": str(rng.randint(15, 35)),
        "expectedReturn": _trim(_step(rng, 4, 9, 0.5)),
        "volatility": _trim(_step(rng, 8, 20, 0.5)),
        "inflation": _trim(_step(rng, 1.5, 3.5, 0.5)),
        "annualSpending": str(int(spending)),
        "pensionIncome": str(int(pension)),
        "simulations": str(rng.choice([1000, 2000, 5000])),
    }
