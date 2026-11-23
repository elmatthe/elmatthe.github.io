from pathlib import Path
import json
import shutil
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from analytics import (  # noqa: E402
    compute_correlation_matrix,
    compute_dashboard_metrics,
    compute_max_drawdown,
    compute_returns,
    run_benchmark_regressions,
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


# ---------------------------------------------------------------------------
# Independent expected values: hand arithmetic or numpy/scipy written from the
# definitions, never the implementation compared with itself.

def test_hand_calculated_metrics_simple_and_log():
    # 100 -> 110 -> 99 -> 108.9: simple returns +0.1, -0.1, +0.1; peak 110, trough 99.
    days = pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"])
    prices = pd.DataFrame({"X": [100.0, 110.0, 99.0, 108.9], "Y": [10.0, 10.5, 10.2, 10.4]}, index=days)
    m = compute_dashboard_metrics(prices, compute_returns(prices, "Simple returns"), 252, 0.0).set_index("Ticker").loc["X"]
    assert np.isclose(m["Total Return"], 0.089, rtol=1e-12)                    # 108.9 / 100 - 1
    assert np.isclose(m["Annualized Return"], 1.089 ** (252 / 3) - 1, rtol=1e-12)  # CAGR over 3 periods
    # mean 1/30, sample sd sqrt((2 * (1/15)^2 + (2/15)^2) / 2) = 0.2 / sqrt(3)
    assert np.isclose(m["Annualized Volatility"], 0.2 / np.sqrt(3) * np.sqrt(252), rtol=1e-12)
    assert np.isclose(m["Sharpe Ratio"], (1 / 30) / (0.2 / np.sqrt(3)) * np.sqrt(252), rtol=1e-12)  # = sqrt(756) / 6
    assert np.isclose(m["Max Drawdown"], 99 / 110 - 1, rtol=1e-12)
    assert m["Observations"] == 3
    log = compute_dashboard_metrics(prices, compute_returns(prices, "Log returns"), 252, 0.0).set_index("Ticker").loc["X"]
    # Log returns ln 1.1, ln 0.9, ln 1.1: the annualized return is the same CAGR, exp(mean x 252) - 1.
    mean = (2 * np.log(1.1) + np.log(0.9)) / 3
    assert np.isclose(log["Annualized Return"], np.exp(mean * 252) - 1, rtol=1e-10)
    sd = np.sqrt(((np.log(1.1) - mean) ** 2 * 2 + (np.log(0.9) - mean) ** 2) / 2)
    assert np.isclose(log["Annualized Volatility"], sd * np.sqrt(252), rtol=1e-12)


def test_hand_calculated_regression_and_correlation():
    # x = 0.01..0.05, y as below. xbar 0.03, ybar 0.0306, Sxx 0.001, Sxy 0.00094
    # -> beta 0.94, alpha 0.0306 - 0.94 x 0.03 = 0.0024; residuals 0.0002, -0.0022, 0.0024,
    # 0.001, -0.0014 -> SSres 1.36e-5; SStot 8.972e-4 -> R^2 = 1 - 1.36e-5 / 8.972e-4;
    # SE(beta) = sqrt(1.36e-5 / 3 / 0.001); t = 0.94 / SE; p from Student t with 3 df.
    idx = pd.bdate_range("2026-02-02", periods=5)
    x = pd.Series([0.01, 0.02, 0.03, 0.04, 0.05], index=idx)
    y = pd.Series([0.012, 0.019, 0.033, 0.041, 0.048], index=idx)
    r = run_pairwise_regression(y, x)
    se = np.sqrt(1.36e-5 / 3 / 0.001)
    assert np.isclose(r["beta"], 0.94, rtol=1e-12)
    assert np.isclose(r["alpha"], 0.0024, rtol=1e-9)
    assert np.isclose(r["r_squared"], 1 - 1.36e-5 / 8.972e-4, rtol=1e-12)
    assert np.isclose(r["beta_standard_error"], se, rtol=1e-10)
    assert np.isclose(r["beta_t_stat"], 0.94 / se, rtol=1e-10)
    assert np.isclose(r["beta_p_value"], 2 * stats.t.sf(0.94 / se, 3), rtol=1e-10)
    assert r["observations"] == 5
    # Excess returns: subtracting rf from both sides leaves beta and moves alpha by -rf x (1 - beta).
    rf = 0.001
    excess = run_pairwise_regression(y, x, rf)
    assert np.isclose(excess["beta"], 0.94, rtol=1e-12)
    assert np.isclose(excess["alpha"], 0.0024 - rf * (1 - 0.94), rtol=1e-9)
    corr = compute_correlation_matrix(pd.DataFrame({"X": x, "Y": y}))
    assert np.isclose(corr.loc["X", "Y"], 0.00094 / np.sqrt(0.001 * 8.972e-4), rtol=1e-12)


def _paths(seed=20261123, n=260):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2025-01-02", periods=n)
    market = rng.normal(0.0004, 0.01, n - 1)
    a = 100 * np.exp(np.concatenate([[0], np.cumsum(market)]))
    b = 50 * np.exp(np.concatenate([[0], np.cumsum(0.8 * market + rng.normal(0.0001, 0.006, n - 1))]))
    c = 30 * np.exp(np.concatenate([[0], np.cumsum(rng.normal(0.0002, 0.015, n - 1))]))
    return pd.DataFrame({"MKT": a, "B": b, "C": c}, index=days)


@pytest.mark.parametrize("return_type", ["Simple returns", "Log returns"])
def test_metrics_correlation_and_regressions_match_numpy_scipy_reference(return_type):
    prices, periods, rf = _paths(), 252, 0.03
    returns = compute_returns(prices, return_type)
    metrics = compute_dashboard_metrics(prices, returns, periods, rf).set_index("Ticker")
    ref_returns = {}
    for ticker in prices:
        p = prices[ticker].to_numpy()
        r = p[1:] / p[:-1] - 1 if return_type.startswith("Simple") else np.diff(np.log(p))
        ref_returns[ticker] = r
        got = metrics.loc[ticker]
        assert np.isclose(got["Total Return"], p[-1] / p[0] - 1, rtol=1e-12)
        assert np.isclose(got["Annualized Return"], (p[-1] / p[0]) ** (periods / len(r)) - 1, rtol=1e-10)
        assert np.isclose(got["Annualized Volatility"], r.std(ddof=1) * np.sqrt(periods), rtol=1e-12)
        assert np.isclose(got["Sharpe Ratio"], (r.mean() - rf / periods) / r.std(ddof=1) * np.sqrt(periods), rtol=1e-10)
        assert np.isclose(got["Max Drawdown"], (p / np.maximum.accumulate(p) - 1).min(), rtol=1e-12)
        assert got["Observations"] == len(r) == len(p) - 1
    corr = compute_correlation_matrix(returns)
    for left in prices:
        for right in prices:
            assert np.isclose(corr.loc[left, right], np.corrcoef(ref_returns[left], ref_returns[right])[0, 1], rtol=1e-12)
    rf_per = rf / periods
    for _, row in run_benchmark_regressions(returns, "MKT", rf_per).iterrows():
        lr = stats.linregress(ref_returns["MKT"] - rf_per, ref_returns[row["Y Ticker"]] - rf_per)
        assert np.isclose(row["beta"], lr.slope, rtol=1e-10)
        assert np.isclose(row["alpha"], lr.intercept, rtol=1e-8, atol=1e-15)
        assert np.isclose(row["r_squared"], lr.rvalue ** 2, rtol=1e-10)
        assert np.isclose(row["beta_standard_error"], lr.stderr, rtol=1e-10)
        assert np.isclose(row["beta_p_value"], lr.pvalue, rtol=1e-8, atol=1e-300)
        assert row["observations"] == len(ref_returns["MKT"])


# ---------------------------------------------------------------------------
# Browser vs desktop on one fixed price fixture (Node runs the browser engine).

JS_RUNNER = Path(__file__).resolve().parents[4] / "_tools" / "tests" / "js_engines.mjs"


def _run_browser(prices: pd.DataFrame, rf: float, benchmark: str) -> dict:
    if shutil.which("node") is None or not JS_RUNNER.exists():
        pytest.skip("Node.js and the site's _tools/tests/js_engines.mjs are needed for the browser comparison")
    series = {t: {"frequency": "daily", "prices": [[d.date().isoformat(), float(v)] for d, v in prices[t].dropna().items()]} for t in prices}
    payload = json.dumps({"tool": "stock-analytics", "cases": [{"series": series, "riskFree": rf, "benchmark": benchmark}]})
    done = subprocess.run(["node", str(JS_RUNNER)], input=payload, capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout)[0]
    assert "error" not in out, out
    return out


def test_browser_and_desktop_agree_on_one_fixture_in_log_return_mode():
    prices, rf = _paths(), 0.03
    # D misses three sessions (another exchange's holidays): its own metrics must still agree.
    prices["D"] = prices["C"].where(~prices.index.isin(prices.index[[40, 41, 150]])) * 1.7
    web = _run_browser(prices, rf, "MKT")
    returns = compute_returns(prices, "Log returns")
    desk = compute_dashboard_metrics(prices, returns, 252, rf).set_index("Ticker")
    by_ticker = {m["ticker"]: m for m in web["metrics"]}
    for t in prices:
        w, d = by_ticker[t], desk.loc[t]
        assert w["returnObservations"] == d["Observations"]
        assert np.isclose(w["totalReturn"], d["Total Return"], rtol=1e-12)
        assert np.isclose(w["annualizedReturn"], d["Annualized Return"], rtol=1e-10)
        assert np.isclose(w["annualizedVolatility"], d["Annualized Volatility"], rtol=1e-12)
        assert np.isclose(w["maxDrawdown"], d["Max Drawdown"], rtol=1e-12)
        # Documented convention difference, not float noise: the desktop subtracts rf / P per
        # period, the browser ln(1 + rf) / P, so the Sharpe ratios differ by exactly
        # (rf - ln(1 + rf)) / annualized volatility.
        assert np.isclose(w["sharpe"] - d["Sharpe Ratio"], (rf - np.log1p(rf)) / d["Annualized Volatility"], rtol=1e-8)
    corr = compute_correlation_matrix(returns)
    for left in ("MKT", "B", "C"):  # one calendar: identical intervals = identical dates
        for right in ("MKT", "B", "C"):
            assert np.isclose(web["matrix"][left][right], corr.loc[left, right], rtol=1e-12)
            assert web["counts"][left][right] == len(prices) - 1
    rf_d, rf_w = rf / 252, np.log1p(rf) / 252
    desk_reg = run_benchmark_regressions(returns[["MKT", "B", "C"]], "MKT", rf_d).set_index("Y Ticker")
    for row in (r for r in web["regression"] if r["ticker"] in ("B", "C")):
        d = desk_reg.loc[row["ticker"]]
        assert np.isclose(row["beta"], d["beta"], rtol=1e-10)
        assert np.isclose(row["r2"], d["r_squared"], rtol=1e-10)
        assert np.isclose(row["p"], d["beta_p_value"], rtol=1e-5, atol=1e-12)  # browser's incomplete-beta series stops at 3e-7
        # alpha = mean(y) - beta x mean(x) - rf_per x (1 - beta), so the two per-period
        # risk-free conventions move alpha by exactly (rf_w - rf_d) x (beta - 1).
        assert np.isclose(row["alpha"] - d["alpha"], (rf_w - rf_d) * (d["beta"] - 1), rtol=1e-6, atol=1e-15)
