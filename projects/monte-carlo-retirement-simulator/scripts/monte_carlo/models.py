"""Shared data models, constants, and the ValidationError type.

No third-party imports here, so this module is always importable.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    import numpy as np

# ── Branding / UI constants ──
WINDOW_TITLE = "Monte Carlo Retirement Simulator"
WINDOW_SIZE = "480x580"
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
