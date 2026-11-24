"""Browser Stock analytics vs an independent numpy/scipy reference.

The browser engine (assets/js/stock-dashboard/analytics.js) runs under Node through
js_engines.mjs. The reference below is written from the documented definitions,
not from the JavaScript, and uses numpy/scipy primitives:
  log return            ln(p_t / p_{t-1})
  annualized return     exp(mean * P) - 1           (P = 252 daily, 52 weekly, 12 monthly)
  annualized volatility sample std (ddof=1) * sqrt(P)
  Sharpe                (mean * P - ln(1 + rf)) / annualized volatility
  max drawdown          min(p / cummax(p) - 1)
  correlation           Pearson over identical intervals (numpy.corrcoef)
  regression            OLS of excess returns (scipy.stats.linregress): beta, alpha, R^2, p
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from datetime import date, timedelta
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
stats = pytest.importorskip("scipy.stats")
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")
RUNNER = Path(__file__).with_name("js_engines.mjs")


def run_js(cases: list) -> list:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"tool": "stock-analytics", "cases": cases}),
                            capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def weekdays(start: date, count: int, step_days: int = 1) -> list[str]:
    out, d = [], start
    while len(out) < count:
        if step_days > 1 or d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=step_days)
    return out


def random_walk(rng, n: int, start: float, mu: float, sigma: float) -> list[float]:
    return list(start * np.exp(np.cumsum(rng.normal(mu, sigma, n))))


def reference_metrics(prices: list[float], periods: int, rf: float) -> dict:
    p = np.array(prices)
    r = np.diff(np.log(p))
    vol = r.std(ddof=1) * math.sqrt(periods)
    return {
        "totalReturn": p[-1] / p[0] - 1,
        "annualizedReturn": math.exp(r.mean() * periods) - 1,
        "annualizedVolatility": vol,
        "sharpe": (r.mean() * periods - math.log(1 + rf)) / vol,
        "maxDrawdown": float((p / np.maximum.accumulate(p) - 1).min()),
        "returnObservations": len(r),
    }


@pytest.mark.parametrize("frequency,periods,step", [("daily", 252, 1), ("weekly", 52, 7)])
def test_metrics_correlation_regression_match_reference(frequency, periods, step):
    rng = np.random.default_rng(20261102)
    n = 260 if frequency == "daily" else 156
    dates = weekdays(date(2023, 1, 6), n, step)
    market = rng.normal(0.0004, 0.01, n - 1)
    a = 100 * np.exp(np.concatenate([[0], np.cumsum(market)]))
    b = 50 * np.exp(np.concatenate([[0], np.cumsum(0.8 * market + rng.normal(0.0001, 0.006, n - 1))]))
    c = list(random_walk(rng, n, 30.0, 0.0002, 0.015))
    rf = 0.03
    series = {"MKT": a.tolist(), "B": b.tolist(), "C": c}
    case = {"series": {t: {"frequency": frequency, "prices": list(zip(dates, v))} for t, v in series.items()}, "riskFree": rf, "benchmark": "MKT"}
    out = run_js([case])[0]
    assert "error" not in out, out
    assert out["periodsPerYear"] == periods
    by_ticker = {m["ticker"]: m for m in out["metrics"]}
    for ticker, prices in series.items():
        ref = reference_metrics(prices, periods, rf)
        for key, value in ref.items():
            assert math.isclose(by_ticker[ticker][key], value, rel_tol=1e-9, abs_tol=1e-12), (ticker, key, by_ticker[ticker][key], value)
    logs = {t: np.diff(np.log(np.array(v))) for t, v in series.items()}
    for left in series:
        for right in series:
            ref = np.corrcoef(logs[left], logs[right])[0, 1]
            assert math.isclose(out["matrix"][left][right], ref, rel_tol=1e-9, abs_tol=1e-12)
            assert out["counts"][left][right] == n - 1
    rf_per = math.log(1 + rf) / periods
    for row in out["regression"]:
        y = logs[row["ticker"]] - rf_per
        x = logs["MKT"] - rf_per
        lr = stats.linregress(x, y)
        assert math.isclose(row["beta"], lr.slope, rel_tol=1e-9)
        assert math.isclose(row["alpha"], lr.intercept, rel_tol=1e-7, abs_tol=1e-12)
        assert math.isclose(row["alphaAnnualized"], lr.intercept * periods, rel_tol=1e-7, abs_tol=1e-10)
        assert math.isclose(row["r2"], lr.rvalue ** 2, rel_tol=1e-9)
        assert math.isclose(row["p"], lr.pvalue, rel_tol=1e-4, abs_tol=1e-10), (row["p"], lr.pvalue)
        assert row["n"] == n - 1


def test_hand_calculated_example():
    # 100 -> 110 -> 99 -> 108.9: returns ln(1.1), ln(0.9), ln(1.1); peak 110, trough 99.
    case = {"series": {"X": {"prices": [["2026-01-05", 100], ["2026-01-06", 110], ["2026-01-07", 99], ["2026-01-08", 108.9]]},
                       "Y": {"prices": [["2026-01-05", 10], ["2026-01-06", 10.5], ["2026-01-07", 10.2], ["2026-01-08", 10.4]]}},
            "riskFree": 0, "benchmark": "Y"}
    m = {r["ticker"]: r for r in run_js([case])[0]["metrics"]}["X"]
    assert math.isclose(m["totalReturn"], 0.089, rel_tol=1e-12)
    assert math.isclose(m["maxDrawdown"], -0.1, rel_tol=1e-12)
    mean = (2 * math.log(1.1) + math.log(0.9)) / 3
    assert math.isclose(m["annualizedReturn"], math.exp(mean * 252) - 1, rel_tol=1e-12)


def test_misaligned_dates_use_only_identical_intervals():
    # Y misses 2026-01-07 (e.g. a local holiday): its 01-06|01-08 return has no partner,
    # so X/Y share only the 01-05|01-06 and 01-08|01-09 intervals.
    case = {"series": {"X": {"prices": [["2026-01-05", 100], ["2026-01-06", 101], ["2026-01-07", 102], ["2026-01-08", 101], ["2026-01-09", 103]]},
                       "Y": {"prices": [["2026-01-05", 50], ["2026-01-06", 51], ["2026-01-08", 50.5], ["2026-01-09", 52]]}},
            "benchmark": "X"}
    out = run_js([case])[0]
    assert out["counts"]["X"]["Y"] == 2
    assert out["matrix"]["X"]["Y"] is None  # below the three-return minimum


def test_weekly_intervals_align_by_iso_week():
    # A Thursday close (Friday holiday) aligns with another market's Friday close.
    x = [["2026-03-27", 100], ["2026-04-02", 101], ["2026-04-10", 103], ["2026-04-17", 102], ["2026-04-24", 104]]
    y = [["2026-03-27", 50], ["2026-04-03", 50.6], ["2026-04-10", 51], ["2026-04-17", 50.2], ["2026-04-24", 51.5]]
    out = run_js([{"series": {"X": {"frequency": "weekly", "prices": x}, "Y": {"frequency": "weekly", "prices": y}}, "benchmark": "X"}])[0]
    assert out["counts"]["X"]["Y"] == 4
    assert out["periodsPerYear"] == 52


def test_mixed_frequencies_rejected_and_large_moves_flagged():
    out = run_js([{"series": {"X": {"frequency": "daily", "prices": [["2026-01-05", 1], ["2026-01-06", 2]]},
                              "Y": {"frequency": "weekly", "prices": [["2026-01-02", 1], ["2026-01-09", 2]]}}, "benchmark": "X"}])[0]
    assert "same frequency" in out["error"]
    split = [["2026-01-05", 200], ["2026-01-06", 202], ["2026-01-07", 101], ["2026-01-08", 102]]  # unadjusted 2:1 split
    out = run_js([{"series": {"S": {"prices": split}, "T": {"prices": [[d, 10 + i] for i, (d, _) in enumerate(split)]}}, "benchmark": "T"}])[0]
    assert any("S: 1 unusually large" in w and "2026-01-07" in w for w in out["warnings"]), out["warnings"]
