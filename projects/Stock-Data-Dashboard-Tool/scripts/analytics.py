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


FX_MAX_AGE_DAYS = 7


def align_fx_rate(fx_series: pd.Series, target_index: pd.Index, max_age_days: int = FX_MAX_AGE_DAYS) -> pd.Series:
    """Align an FX-rate series to price dates using the latest fixing ON OR BEFORE each date.

    A fixing older than `max_age_days` is not used, and nothing is back-filled: a price
    dated before the first available fixing gets no rate (no look-ahead, D6).
    """
    rate = pd.to_numeric(pd.Series(fx_series), errors="coerce")
    rate.index = pd.to_datetime(rate.index)
    rate = rate.sort_index().dropna()
    target_index = pd.to_datetime(pd.Index(target_index))
    if rate.empty:
        return pd.Series([float("nan")] * len(target_index), index=target_index)
    fixings = pd.DataFrame({"fix_date": rate.index, "rate": rate.to_numpy()})
    targets = pd.DataFrame({"date": target_index}).reset_index()
    merged = pd.merge_asof(targets.sort_values("date"), fixings, left_on="date", right_on="fix_date", direction="backward")
    stale = (merged["date"] - merged["fix_date"]).dt.days > max_age_days
    merged.loc[stale, "rate"] = float("nan")
    merged = merged.sort_values("index")
    return pd.Series(merged["rate"].to_numpy(), index=target_index)


def convert_price_frame(frame: pd.DataFrame, fx_rate: pd.Series) -> pd.DataFrame:
    """Multiply a price frame's price columns by an aligned FX rate.

    `fx_rate` is expressed as target-currency units per one unit of the security's
    native currency (from Bank of Canada fixings), so multiplying converts prices
    into the target currency before any returns are derived.
    """
    converted = frame.copy()
    rate = align_fx_rate(fx_rate, converted.index)
    for column in ("Close", "Adj Close"):
        if column in converted.columns:
            converted[column] = pd.to_numeric(converted[column], errors="coerce") * rate.to_numpy()
    # Prices without a usable fixing are dropped, never kept unconverted.
    converted.attrs["fx_dropped"] = int(rate.isna().sum())
    return converted.loc[rate.notna().to_numpy()]


def normalize_price_frames_to_currency(
    price_frames: dict[str, pd.DataFrame],
    currencies: dict[str, str],
    target_currency: str,
    fx_rate_provider,
) -> tuple[dict[str, pd.DataFrame], list[str], dict[str, str]]:
    """Convert every security's price series into `target_currency`.

    `fx_rate_provider(native, target)` returns a pd.Series of target-per-native
    rates, or None when the pair is unavailable. Securities already in the target
    currency (or with unknown currency) are passed through unchanged. Conversion
    fails soft: an unavailable pair leaves the security in its native currency and
    appends a clear warning rather than raising.

    Returns (converted_frames, warnings, result_currencies) where
    result_currencies maps each ticker to the currency it is now expressed in.
    """
    target = str(target_currency or "").strip().upper()
    converted: dict[str, pd.DataFrame] = {}
    warnings: list[str] = []
    result_currencies: dict[str, str] = {}
    for ticker, frame in price_frames.items():
        native = str(currencies.get(ticker) or "").strip().upper()
        if not native:
            warnings.append(f"{ticker}: listing currency unknown, so it cannot be converted to {target}; left out of the normalized comparison.")
            continue
        if native == target:
            converted[ticker] = frame
            result_currencies[ticker] = target
            continue
        rate = fx_rate_provider(native, target)
        if rate is None or pd.Series(rate).dropna().empty:
            warnings.append(f"Official exchange rates are unavailable for {native}->{target}; {ticker} is left out of the normalized comparison (never mixed in unconverted).")
            continue
        result = convert_price_frame(frame, pd.Series(rate))
        if result.attrs.get("fx_dropped"):
            warnings.append(f"{ticker}: {result.attrs['fx_dropped']} price(s) had no {native}->{target} fixing within {FX_MAX_AGE_DAYS} days before them and were dropped.")
        if len(result) < 2:
            warnings.append(f"{ticker}: too few prices remain after conversion; left out.")
            continue
        converted[ticker] = result
        result_currencies[ticker] = target
    return converted, warnings, result_currencies


def compute_returns(prices: pd.DataFrame, return_type: str = "simple") -> pd.DataFrame:
    """Simple or log returns, computed on EACH ticker's own price series (D1).

    Tickers on different exchange calendars are not forced onto one union of dates:
    a holiday on one exchange no longer removes the other tickers' returns.
    """
    columns = {}
    for ticker in prices.columns:
        series = pd.to_numeric(prices[ticker], errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
        series = series[series > 0]
        if return_type.strip().lower().startswith("log"):
            r = np.log(series / series.shift(1))
        else:
            r = series / series.shift(1) - 1
        columns[ticker] = r.dropna()
    if not columns:
        return pd.DataFrame()
    return pd.concat(columns, axis=1).sort_index().dropna(how="all")


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
    window_start = prices.index.min() if len(prices.index) else None
    window_end = prices.index.max() if len(prices.index) else None
    slack = pd.Timedelta(days={252: 7, 52: 10, 12: 35}.get(periods_per_year, 7))

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
        # Coverage of the comparison window, judged on this ticker's own calendar.
        if price_series.empty:
            coverage = "No data"
        elif price_series.index.min() > window_start + slack:
            coverage = f"Partial: from {price_series.index.min().date()}"
        elif price_series.index.max() < window_end - slack:
            coverage = f"Partial: to {price_series.index.max().date()}"
        else:
            coverage = "Complete"

        rows.append(
            {
                "Ticker": ticker,
                "Total Return": total_return,
                "Annualized Return": annualized_return,
                "Annualized Volatility": volatility,
                "Sharpe Ratio": sharpe,
                "Max Drawdown": compute_max_drawdown(price_series),
                "Observations": observations,
                "Data Completeness": coverage,
                "Currency": prices.attrs.get("currencies", {}).get(ticker, ""),
            }
        )

    return pd.DataFrame(rows, columns=REQUIRED_METRIC_COLUMNS)


MIN_CORRELATION_OBSERVATIONS = 3
MIN_RETURN_STDEV = 1e-9


def compute_correlation_matrix(returns: pd.DataFrame) -> pd.DataFrame:
    """Pairwise correlation over shared return dates; at least 3 shared returns (D8),
    and none for a series without variance."""
    corr = returns.corr(min_periods=MIN_CORRELATION_OBSERVATIONS)
    for ticker in returns.columns:
        values = returns[ticker].dropna()
        if len(values) < 2 or values.std(ddof=1) <= MIN_RETURN_STDEV:
            corr.loc[ticker, :] = float("nan")
            corr.loc[:, ticker] = float("nan")
    return corr


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
    if not x.std(ddof=1) > MIN_RETURN_STDEV:
        # A constant benchmark has no beta; report it instead of aborting the run (D4).
        return {"alpha": float("nan"), "beta": float("nan"), "r_squared": float("nan"), "beta_standard_error": float("nan"),
                "beta_t_stat": float("nan"), "beta_p_value": float("nan"), "observations": int(len(df)),
                "note": "The benchmark's returns have no variance, so beta and alpha are not defined."}

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
