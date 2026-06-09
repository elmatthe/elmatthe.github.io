from pathlib import Path
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from analytics import (  # noqa: E402
    compute_correlation_matrix,
    compute_dashboard_metrics,
    compute_max_drawdown,
    compute_returns,
    run_pairwise_regression,
)


def sample_prices():
    return pd.DataFrame(
        {
            "AAPL": [100.0, 102.0, 101.0, 105.0],
            "MSFT": [200.0, 204.0, 208.0, 212.0],
        },
        index=pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]),
    )


def test_simple_return_calculation():
    returns = compute_returns(sample_prices(), "simple")
    assert np.isclose(returns.loc[pd.Timestamp("2024-01-03"), "AAPL"], 0.02)


def test_log_return_calculation():
    returns = compute_returns(sample_prices(), "log")
    assert np.isclose(returns.loc[pd.Timestamp("2024-01-03"), "AAPL"], np.log(1.02))


def test_max_drawdown():
    drawdown = compute_max_drawdown(pd.Series([100, 120, 90, 95]))
    assert np.isclose(drawdown, -0.25)


def test_dashboard_metrics_shape_and_required_columns():
    prices = sample_prices()
    returns = compute_returns(prices)
    metrics = compute_dashboard_metrics(prices, returns, periods_per_year=252)
    expected = {
        "Ticker",
        "Total Return",
        "Annualized Return",
        "Annualized Volatility",
        "Sharpe Ratio",
        "Max Drawdown",
        "Observations",
        "Data Completeness",
        "Currency",
    }
    assert set(metrics.columns) == expected
    assert len(metrics) == 2


def test_correlation_matrix_shape():
    corr = compute_correlation_matrix(compute_returns(sample_prices()))
    assert corr.shape == (2, 2)


def test_regression_result_includes_core_stats():
    returns = compute_returns(sample_prices())
    result = run_pairwise_regression(returns["AAPL"], returns["MSFT"])
    assert {"alpha", "beta", "r_squared"}.issubset(result)
    assert result["observations"] == 3
