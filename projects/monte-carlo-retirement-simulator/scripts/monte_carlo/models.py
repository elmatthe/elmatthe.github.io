"""Shared data models, constants, and the ValidationError type.

No third-party imports here, so this module is always importable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    import numpy as np

# ── Branding / UI constants ──
WINDOW_TITLE = "Monte Carlo Retirement Simulator"
WINDOW_SIZE = "860x620"
WINDOW_MIN_SIZE = (760, 560)
STATUS_WARNING = "#8a5a00"
BRAND_NAVY = "#1a2e4a"
BRAND_NAVY_ARGB = "FF1A2E4A"
STATUS_NEUTRAL = "#1f4f8a"
STATUS_ERROR = "#9b2f2f"
STATUS_SUCCESS = "#1c7550"

# ── Numeric safety bounds ──
MAX_MONETARY_INPUT = 1.0e15
MAX_YEARS_INPUT = 120
MAX_ABS_RATE_INPUT = 100.0
MAX_VOLATILITY_INPUT = 300.0
MAX_SIMULATIONS = 10000

# ── Engine identity and options (identical in assets/js/monte-carlo/engine.js) ──
ENGINE_VERSION = "2.0.0"
RNG_NAME = "mulberry32 + Box-Muller (cosine branch)"
MAX_SEED = 4294967295
SPENDING_BASES = {"retirement": "Retirement-year dollars", "today": "Today's dollars"}
DEFAULT_SPENDING_BASIS = "retirement"
HIGH_VOLATILITY = 30.0
TOTAL_LOSS_WARN = 1e-4
MODEL_NOTE = (
    "Annual return ~ Normal(arithmetic expected return, volatility), independent each year; "
    "year-end contributions and withdrawals; a negative balance before retirement is floored at 0; "
    "ruin when the balance reaches 0 or less in retirement; withdrawal grows with inflation; "
    "real = nominal / (1 + inflation)^year; percentiles by linear interpolation."
)


class ValidationError(Exception):
    """Raised when user input validation fails."""


@dataclass
class SimulationInputs:
    current_portfolio: float
    annual_contribution: float
    contribution_growth_rate: float
    years_to_retirement: int
    years_in_retirement: int
    expected_return: float
    volatility: float
    inflation_rate: float
    annual_spending: float
    pension_income: float
    simulations: int
    workbook_path: Path
    csv_path: Path | None = None
    spending_basis: str = DEFAULT_SPENDING_BASIS
    seed: int | None = None


@dataclass
class SimulationResult:
    years: "np.ndarray"
    p10: "np.ndarray"
    p25: "np.ndarray"
    p50: "np.ndarray"
    p75: "np.ndarray"
    p90: "np.ndarray"
    success_probability: float
    median_portfolio_at_retirement: float
    median_final_value: float
    p10_final_value: float
    p90_final_value: float
    safe_withdrawal_rate: float
    failed_simulations: int
    median_ruin_year: float | None
    net_withdrawal: float
    net_withdrawal_entered: float = 0.0
    spending_basis: str = DEFAULT_SPENDING_BASIS
    inflation_factor_to_retirement: float = 1.0
    seed: int | None = None
    rng: str = RNG_NAME
    engine_version: str = ENGINE_VERSION
    warnings: list = field(default_factory=list)
    draws: int = 0
    inflation_rate: float = 0.0
    p25_final_value: float = 0.0
    p75_final_value: float = 0.0

    @property
    def real_available(self) -> bool:
        return 1.0 + self.inflation_rate / 100.0 > 0

    def deflator(self, year: int) -> float:
        return (1.0 + self.inflation_rate / 100.0) ** year

    def real(self, value: float, year: int) -> float | None:
        """Nominal value in today's dollars, or None when undefined (inflation -100%)."""
        if not self.real_available:
            return None
        out = value / self.deflator(year)
        return out if out == out and abs(out) != float("inf") else None
