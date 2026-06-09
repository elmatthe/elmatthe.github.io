"""Core portfolio comparison analytics."""

from __future__ import annotations

import math
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats


REQUIRED_METRIC_COLUMNS = [
    "Ticker",
    "Total Return",
    "Annualized Return",
    "Annualized Volatility",
    "Sharpe Ratio",
    "Max Drawdown",
    "Observations",
    "Data Completeness",
    "Currency",
]


def align_price_series(price_frames: dict[str, pd.DataFrame], price_column: str) -> pd.DataFrame:
    """Return one aligned price table with dates as index and tickers as columns."""
    series_by_ticker = {}
    for ticker, frame in price_frames.items():
        if price_column not in frame.columns:
            raise ValueError(f"{ticker} is missing required price column: {price_column}")
        prices = frame[price_column].copy()
        prices.index = pd.to_datetime(prices.index)
        series_by_ticker[ticker] = pd.to_numeric(prices, errors="coerce").sort_index()
    if not series_by_ticker:
        return pd.DataFrame()
    return pd.concat(series_by_ticker, axis=1).sort_index().dropna(how="all")


def compute_returns(prices: pd.DataFrame, return_type: str = "simple") -> pd.DataFrame:
    """Compute simple or log returns."""
    cleaned = prices.astype(float).replace([np.inf, -np.inf], np.nan)
    if return_type.strip().lower().startswith("log"):
        returns = np.log(cleaned / cleaned.shift(1))
    else:
        returns = cleaned.pct_change(fill_method=None)
    return returns.replace([np.inf, -np.inf], np.nan).dropna(how="all")


def compute_max_drawdown(price_series: pd.Series) -> float:
    prices = pd.to_numeric(price_series, errors="coerce").dropna()
    if prices.empty:
        return float("nan")
    running_max = prices.cummax()
    drawdowns = prices / running_max - 1.0
    return float(drawdowns.min())


def _annualized_return(total_return: float, observations: int, periods_per_year: int) -> float:
    if observations <= 0 or not math.isfinite(total_return) or total_return <= -1:
        return float("nan")
    return float((1 + total_return) ** (periods_per_year / observations) - 1)


def compute_dashboard_metrics(
    prices: pd.DataFrame,
    returns: pd.DataFrame,
    periods_per_year: int,
    risk_free_rate: float = 0.0,
) -> pd.DataFrame:
    """Return per-ticker performance and risk metrics."""
    rows = []
    risk_free_rate_per_period = risk_free_rate / periods_per_year if periods_per_year else 0.0
    full_observations = max(len(prices.index), 1)

    for ticker in prices.columns:
        price_series = pd.to_numeric(prices[ticker], errors="coerce").dropna()
        return_series = pd.to_numeric(returns.get(ticker, pd.Series(dtype=float)), errors="coerce").dropna()
        observations = int(len(return_series))
        if len(price_series) >= 2 and price_series.iloc[0] != 0:
            total_return = float(price_series.iloc[-1] / price_series.iloc[0] - 1)
        else:
            total_return = float("nan")
        annualized_return = _annualized_return(total_return, observations, periods_per_year)
        volatility = float(return_series.std(ddof=1) * math.sqrt(periods_per_year)) if observations > 1 else float("nan")
        excess_mean = return_series.mean() - risk_free_rate_per_period if observations else float("nan")
        sharpe = float(excess_mean / return_series.std(ddof=1) * math.sqrt(periods_per_year)) if observations > 1 and return_series.std(ddof=1) != 0 else float("nan")
        completeness = len(price_series) / full_observations

        rows.append(
            {
                "Ticker": ticker,
                "Total Return": total_return,
                "Annualized Return": annualized_return,
                "Annualized Volatility": volatility,
                "Sharpe Ratio": sharpe,
                "Max Drawdown": compute_max_drawdown(price_series),
                "Observations": observations,
                "Data Completeness": "Complete" if completeness >= 0.98 else f"{completeness:.1%}",
                "Currency": prices.attrs.get("currencies", {}).get(ticker, ""),
            }
        )

    return pd.DataFrame(rows, columns=REQUIRED_METRIC_COLUMNS)


def compute_correlation_matrix(returns: pd.DataFrame) -> pd.DataFrame:
    return returns.corr()


def run_pairwise_regression(
    y_returns: pd.Series,
    x_returns: pd.Series,
    risk_free_rate_per_period: float = 0.0,
) -> dict:
    df = pd.concat([y_returns, x_returns], axis=1).dropna()
    if len(df) < 3:
        return {
            "alpha": float("nan"),
            "beta": float("nan"),
            "r_squared": float("nan"),
            "beta_standard_error": float("nan"),
            "beta_t_stat": float("nan"),
            "beta_p_value": float("nan"),
            "observations": int(len(df)),
        }

    y = df.iloc[:, 0].astype(float) - risk_free_rate_per_period
    x = df.iloc[:, 1].astype(float) - risk_free_rate_per_period
    x_var = ((x - x.mean()) ** 2).sum()
    if x_var == 0:
        raise ValueError("Regression x-series has no variance.")

    beta = float(((x - x.mean()) * (y - y.mean())).sum() / x_var)
    alpha = float(y.mean() - beta * x.mean())
    y_hat = alpha + beta * x
    residuals = y - y_hat
    ss_res = float((residuals**2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r_squared = float(1 - ss_res / ss_tot) if ss_tot else float("nan")
    residual_variance = ss_res / (len(df) - 2)
    beta_se = float(math.sqrt(residual_variance / x_var))
    beta_t = float(beta / beta_se) if beta_se else float("nan")
    beta_p = float(2 * stats.t.sf(abs(beta_t), df=len(df) - 2)) if math.isfinite(beta_t) else float("nan")

    return {
        "alpha": alpha,
        "beta": beta,
        "r_squared": r_squared,
        "beta_standard_error": beta_se,
        "beta_t_stat": beta_t,
        "beta_p_value": beta_p,
        "observations": int(len(df)),
    }


def run_benchmark_regressions(
    returns: pd.DataFrame,
    benchmark_ticker: str,
    risk_free_rate_per_period: float = 0.0,
) -> pd.DataFrame:
    if benchmark_ticker not in returns.columns:
        raise ValueError(f"Benchmark ticker not found in returns: {benchmark_ticker}")
    rows = []
    for ticker in returns.columns:
        if ticker == benchmark_ticker:
            continue
        result = run_pairwise_regression(returns[ticker], returns[benchmark_ticker], risk_free_rate_per_period)
        rows.append({"Y Ticker": ticker, "X Ticker": benchmark_ticker, **result})
    return pd.DataFrame(rows)


def run_all_pairwise_regressions(returns: pd.DataFrame, risk_free_rate_per_period: float = 0.0) -> pd.DataFrame:
    rows = []
    for x_ticker, y_ticker in combinations(returns.columns, 2):
        result = run_pairwise_regression(returns[y_ticker], returns[x_ticker], risk_free_rate_per_period)
        rows.append({"Y Ticker": y_ticker, "X Ticker": x_ticker, **result})
    return pd.DataFrame(rows)


def find_diversification_flags(
    corr_matrix: pd.DataFrame,
    high_threshold: float = 0.85,
    low_threshold: float = 0.30,
) -> dict:
    high_pairs = []
    low_pairs = []
    for left, right in combinations(corr_matrix.columns, 2):
        value = corr_matrix.loc[left, right]
        if pd.isna(value):
            continue
        pair = {"pair": (left, right), "correlation": float(value)}
        if value >= high_threshold:
            high_pairs.append(pair)
        elif value <= low_threshold:
            low_pairs.append(pair)
    return {"high_correlation_pairs": high_pairs, "low_correlation_pairs": low_pairs}
