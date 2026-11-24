"""Audit Appendix C, R1/R3/R4/R7/R8/R13: calendar alignment, chart, bins, FX, CSV, variance."""
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from analytics import (align_fx_rate, compute_correlation_matrix, compute_dashboard_metrics, compute_returns,  # noqa: E402
                       normalize_price_frames_to_currency, run_pairwise_regression)
from data_sources import DataSourceError, _resample_prices, load_offline_csv_folder  # noqa: E402


def _path(n, start=100.0, seed=1):
    rng = np.random.default_rng(seed)
    return start * np.exp(np.cumsum(rng.normal(0.0004, 0.01, n)))


def test_returns_per_ticker_are_not_cut_by_another_exchanges_holidays():
    us_days = pd.bdate_range("2026-01-02", "2026-06-30")
    ca_days = us_days.delete([10, 40, 70])  # TSX holidays the NYSE traded through
    us = pd.Series(_path(len(us_days)), index=us_days)
    ca = pd.Series(_path(len(ca_days), 30, 2), index=ca_days)
    alone = compute_returns(pd.DataFrame({"SPYX": us}))
    together = compute_returns(pd.concat({"SPYX": us, "XIU.TO": ca}, axis=1))
    assert together["SPYX"].dropna().count() == alone["SPYX"].dropna().count() == len(us_days) - 1
    m_alone = compute_dashboard_metrics(pd.DataFrame({"SPYX": us}), alone, 252)
    m_together = compute_dashboard_metrics(pd.concat({"SPYX": us, "XIU.TO": ca}, axis=1), together, 252)
    a, b = m_alone.set_index("Ticker").loc["SPYX"], m_together.set_index("Ticker").loc["SPYX"]
    for col in ("Annualized Return", "Annualized Volatility", "Sharpe Ratio", "Observations"):
        assert a[col] == pytest.approx(b[col]), col
    assert set(m_together["Data Completeness"]) == {"Complete"}


def test_cumulative_chart_ends_at_the_tables_total_return(tmp_path):
    matplotlib = pytest.importorskip("matplotlib")
    matplotlib.use("Agg")
    from plots import plot_cumulative_returns
    days = pd.bdate_range("2026-01-02", "2026-03-31")
    a = pd.Series(_path(len(days)), index=days)
    b = pd.Series(_path(len(days) - 5, 50, 3), index=days.delete([3, 9, 20, 33, 44]))
    prices = pd.concat({"A": a, "B": b}, axis=1)
    path = plot_cumulative_returns(prices, str(tmp_path / "c.png"))
    assert Path(path).exists()
    totals = compute_dashboard_metrics(prices, compute_returns(prices), 252).set_index("Ticker")["Total Return"]
    for t in ("A", "B"):
        s = prices[t].dropna()
        assert (s.iloc[-1] / s.iloc[0] - 1) == pytest.approx(totals[t])


def test_weekly_and_monthly_bars_are_complete_periods_dated_by_last_trading_day():
    days = pd.bdate_range("2026-09-01", "2026-11-03")
    frame = pd.DataFrame({"Close": range(len(days))}, index=days, dtype=float)
    weekly = _resample_prices(frame, "Weekly", today=dt.date(2026, 11, 3))
    assert weekly.index.max() == pd.Timestamp("2026-10-30"), "the week still trading is dropped"
    assert all(d.weekday() <= 4 and d <= pd.Timestamp("2026-11-03") for d in weekly.index), "no future Friday labels"
    monthly = _resample_prices(frame, "Monthly", today=dt.date(2026, 11, 3))
    assert list(monthly.index) == [pd.Timestamp("2026-09-30"), pd.Timestamp("2026-10-30")]


def test_fx_has_no_look_ahead_and_no_stale_rates():
    fix = pd.Series([1.30, 1.40], index=pd.to_datetime(["2026-01-05", "2026-01-20"]))
    targets = pd.to_datetime(["2025-12-29", "2026-01-05", "2026-01-09", "2026-01-15", "2026-01-21"])
    aligned = align_fx_rate(fix, targets)
    assert np.isnan(aligned.iloc[0]), "a price before the first fixing gets no rate (no back-fill)"
    assert aligned.iloc[1] == 1.30 and aligned.iloc[2] == 1.30
    assert np.isnan(aligned.iloc[3]), "a fixing more than 7 days old is not used"
    assert aligned.iloc[4] == 1.40
    frames = {"X": pd.DataFrame({"Close": [10.0, 11.0, 12.0]}, index=pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07"]))}
    converted, warnings, cur = normalize_price_frames_to_currency(frames, {"X": "ARS"}, "USD", lambda a, b: None)
    assert "X" not in converted and any("left out" in w for w in warnings), "an unconvertible series is never kept in its native currency"


def test_csv_rejects_duplicate_dates_and_non_positive_prices(tmp_path):
    (tmp_path / "AAA.csv").write_text("Date,Close\n2026-01-02,10\n2026-01-02,18\n2026-01-05,11\n", encoding="utf-8")
    with pytest.raises(DataSourceError, match="more than one row for 2026-01-02"):
        load_offline_csv_folder(str(tmp_path))
    (tmp_path / "AAA.csv").write_text("Date,Close\n2026-01-02,10\n2026-01-05,0\n", encoding="utf-8")
    with pytest.raises(DataSourceError, match="zero or negative on 2026-01-05"):
        load_offline_csv_folder(str(tmp_path))


def test_constant_benchmark_and_short_overlaps_give_no_numbers_instead_of_crashing():
    days = pd.bdate_range("2026-01-02", "2026-03-31")
    flat = pd.Series(10.0, index=days)
    moving = pd.Series(_path(len(days)), index=days)
    returns = compute_returns(pd.DataFrame({"FLAT": flat, "MOV": moving}))
    result = run_pairwise_regression(returns["MOV"], returns["FLAT"], 0.0)  # used to raise with rf = 0
    assert np.isnan(result["beta"]) and "no variance" in result["note"]
    corr = compute_correlation_matrix(returns)
    assert np.isnan(corr.loc["MOV", "FLAT"])
    two = compute_returns(pd.DataFrame({"A": pd.Series([1.0, 2.0, 3.0], index=days[:3]), "B": pd.Series([1.0, 1.5, 3.0], index=days[:3])}))
    assert np.isnan(compute_correlation_matrix(two).loc["A", "B"]), "two shared returns never give a correlation of +/-1"


# --- Exact-interval pairing (same rule as the browser's analytics.js pairReturns) ----------
#
# Cross-market holiday fixture, 2026-06-22 to 2026-07-17 on weekdays:
#   NYSE ("SPY") closed Fri 2026-07-03 (Independence Day observed);
#   TSX ("XIU.TO") closed Wed 2026-07-01 (Canada Day).
# SPY's 06-30|07-01 and 07-02|07-06 returns, and XIU.TO's 06-30|07-02 and 07-03|07-06
# returns, have no partner over the same interval. Pairing by end date alone used to pair
# XIU.TO's two-day 06-30|07-02 return with SPY's one-day 07-01|07-02 return (and SPY's
# 07-02|07-06 with XIU.TO's 07-03|07-06).

def _cross_market_fixture():
    days = pd.bdate_range("2026-06-22", "2026-07-17")
    rng = np.random.default_rng(20260703)
    market = rng.normal(0.0003, 0.012, len(days))
    spy = 500 * np.exp(np.cumsum(market))
    xiu = 40 * np.exp(np.cumsum(0.7 * market + rng.normal(0.0001, 0.008, len(days))))
    spy_s = pd.Series(spy, index=days).drop(pd.Timestamp("2026-07-03"))
    xiu_s = pd.Series(xiu, index=days).drop(pd.Timestamp("2026-07-01"))
    # Large moves on the holiday-spanning days, so wrong pairing changes the answer visibly.
    xiu_s.loc["2026-07-02":] *= 1.05
    spy_s.loc["2026-07-06":] *= 0.95
    return spy_s, xiu_s


def _reference_intervals(series: pd.Series) -> dict:
    """Written from the definition, not from analytics.py: {(previous date, date): ln return}."""
    dates = [d.strftime("%Y-%m-%d") for d in series.index]
    values = series.to_numpy()
    return {(dates[i - 1], dates[i]): float(np.log(values[i] / values[i - 1])) for i in range(1, len(values))}


def _reference_pair(left: pd.Series, right: pd.Series):
    a, b = _reference_intervals(left), _reference_intervals(right)
    shared = sorted(set(a) & set(b))
    return np.array([a[k] for k in shared]), np.array([b[k] for k in shared]), shared


def test_cross_market_holidays_pair_only_identical_intervals():
    from analytics import compute_interval_returns, paired_observation_counts, short_overlap_warnings
    scipy_stats = pytest.importorskip("scipy.stats")
    spy, xiu = _cross_market_fixture()
    prices = pd.concat({"SPY": spy, "XIU.TO": xiu}, axis=1, sort=True)
    x_ref, y_ref, shared = _reference_pair(spy, xiu)
    assert len(shared) == 15, "18 returns per market, less the 3 per market that touch the other market's holiday"
    assert ("2026-06-30", "2026-07-02") not in shared and ("2026-07-02", "2026-07-06") not in shared

    paired = compute_interval_returns(prices, "Log", "Daily")
    assert int(paired_observation_counts(paired).loc["SPY", "XIU.TO"]) == len(shared)
    assert short_overlap_warnings(paired) == []
    expected_corr = float(np.corrcoef(x_ref, y_ref)[0, 1])
    corr = compute_correlation_matrix(paired)
    assert corr.loc["SPY", "XIU.TO"] == pytest.approx(expected_corr, rel=1e-12)
    assert corr.loc["SPY", "SPY"] == pytest.approx(1.0)
    lr = scipy_stats.linregress(x_ref, y_ref)
    result = run_pairwise_regression(paired["XIU.TO"], paired["SPY"], 0.0)
    assert result["observations"] == len(shared)
    assert result["beta"] == pytest.approx(lr.slope, rel=1e-12)
    assert result["alpha"] == pytest.approx(lr.intercept, rel=1e-9, abs=1e-15)
    assert result["r_squared"] == pytest.approx(lr.rvalue ** 2, rel=1e-12)
    assert result["beta_p_value"] == pytest.approx(lr.pvalue, rel=1e-9, abs=1e-15)

    # The previous end-date pairing gave a different, wrong answer on the same prices.
    by_end_date = compute_returns(prices, "Log")
    assert by_end_date[["SPY", "XIU.TO"]].dropna().shape[0] == len(shared) + 2
    assert not np.isclose(compute_correlation_matrix(by_end_date).loc["SPY", "XIU.TO"], expected_corr, rtol=1e-6)


def test_short_overlap_is_reported_and_left_blank():
    from analytics import compute_interval_returns, short_overlap_warnings
    a = pd.Series([100.0, 101, 102, 101, 103], index=pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]))
    b = pd.Series([50.0, 51, 50.5, 52], index=pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09"]))
    paired = compute_interval_returns(pd.concat({"X": a, "Y": b}, axis=1), "Log", "Daily")
    assert np.isnan(compute_correlation_matrix(paired).loc["X", "Y"])
    assert np.isnan(run_pairwise_regression(paired["Y"], paired["X"])["beta"])
    assert short_overlap_warnings(paired) == ["X and Y share only 2 identical return interval(s); correlation and beta need at least 3, so they are left blank."]


def test_weekly_and_monthly_pair_by_period_not_by_bar_date():
    from analytics import compute_interval_returns, interval_end_dates
    # A Thursday close (Good Friday 2026-04-03 holiday) pairs with another market's Friday close.
    x = pd.Series([100.0, 101, 103, 102, 104], index=pd.to_datetime(["2026-03-27", "2026-04-02", "2026-04-10", "2026-04-17", "2026-04-24"]))
    y = pd.Series([50.0, 50.6, 51, 50.2, 51.5], index=pd.to_datetime(["2026-03-27", "2026-04-03", "2026-04-10", "2026-04-17", "2026-04-24"]))
    paired = compute_interval_returns(pd.concat({"X": x, "Y": y}, axis=1, sort=True), "Log", "Weekly")
    assert list(paired.index) == ["2026-W13|2026-W14", "2026-W14|2026-W15", "2026-W15|2026-W16", "2026-W16|2026-W17"]
    assert paired.notna().all().all()
    assert list(interval_end_dates(paired.index))[:2] == [pd.Timestamp("2026-04-03"), pd.Timestamp("2026-04-10")]
    expected = np.corrcoef(np.diff(np.log(x.to_numpy())), np.diff(np.log(y.to_numpy())))[0, 1]
    assert compute_correlation_matrix(paired).loc["X", "Y"] == pytest.approx(expected, rel=1e-12)
    monthly = compute_interval_returns(pd.DataFrame({"X": x.iloc[[0, 4]]}), "Log", "Monthly")
    assert list(monthly.index) == ["2026-03|2026-04"] and list(interval_end_dates(monthly.index)) == [pd.Timestamp("2026-04-30")]


def test_rolling_correlation_chart_accepts_interval_pairs(tmp_path):
    pytest.importorskip("matplotlib")
    from analytics import compute_interval_returns
    from plots import plot_rolling_correlation_vs_benchmark
    spy, xiu = _cross_market_fixture()
    paired = compute_interval_returns(pd.concat({"SPY": spy, "XIU.TO": xiu}, axis=1, sort=True), "Log", "Daily")
    assert Path(plot_rolling_correlation_vs_benchmark(paired, "SPY", str(tmp_path / "r.png"), window=5)).exists()


_SITE = Path(__file__).resolve().parents[4]
_JS_RUNNER = _SITE / "_tools" / "tests" / "js_engines.mjs"


@pytest.mark.skipif(shutil.which("node") is None or not _JS_RUNNER.exists(), reason="needs Node.js and the site's browser engine")
@pytest.mark.parametrize("frequency", ["Daily", "Weekly"])
def test_desktop_and_browser_give_the_same_correlation_and_beta(frequency):
    """Equivalent inputs on both platforms: the browser engine (log returns) and the
    desktop's Log return type must agree on counts, correlation, beta, alpha and R^2."""
    from analytics import compute_interval_returns
    if frequency == "Daily":
        spy, xiu = _cross_market_fixture()
    else:
        spy = pd.Series([100.0, 101, 103, 102, 104, 103.5, 106], index=pd.to_datetime(
            ["2026-03-20", "2026-03-27", "2026-04-02", "2026-04-10", "2026-04-17", "2026-04-24", "2026-05-01"]))
        xiu = pd.Series([50.0, 50.4, 50.9, 51.3, 50.2, 51.5, 51.1], index=pd.to_datetime(
            ["2026-03-20", "2026-03-27", "2026-04-03", "2026-04-10", "2026-04-17", "2026-04-24", "2026-04-30"]))
    case = {"series": {t: {"frequency": frequency.lower(), "prices": [[d.strftime("%Y-%m-%d"), float(p)] for d, p in s.items()]}
                       for t, s in (("SPY", spy), ("XIU.TO", xiu))}, "riskFree": 0, "benchmark": "SPY"}
    run = subprocess.run(["node", str(_JS_RUNNER)], input=json.dumps({"tool": "stock-analytics", "cases": [case]}),
                         capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert run.returncode == 0, run.stderr
    web = json.loads(run.stdout)[0]
    assert "error" not in web, web
    paired = compute_interval_returns(pd.concat({"SPY": spy, "XIU.TO": xiu}, axis=1, sort=True), "Log", frequency)
    corr = compute_correlation_matrix(paired)
    assert int(paired[["SPY", "XIU.TO"]].dropna().shape[0]) == web["counts"]["SPY"]["XIU.TO"]
    assert corr.loc["SPY", "XIU.TO"] == pytest.approx(web["matrix"]["SPY"]["XIU.TO"], rel=1e-12)
    desktop = run_pairwise_regression(paired["XIU.TO"], paired["SPY"], 0.0)
    browser = web["regression"][0]
    assert desktop["observations"] == browser["n"]
    assert desktop["beta"] == pytest.approx(browser["beta"], rel=1e-12)
    assert desktop["alpha"] == pytest.approx(browser["alpha"], rel=1e-9, abs=1e-15)
    assert desktop["r_squared"] == pytest.approx(browser["r2"], rel=1e-12)


@pytest.mark.skipif(shutil.which("node") is None or not _JS_RUNNER.exists(), reason="needs Node.js and the site's browser engine")
@pytest.mark.parametrize("rf", [0.04, 0.25])
def test_log_mode_sharpe_and_alpha_use_a_log_risk_free_rate_like_the_browser(rf):
    """Regression: in Log returns mode the desktop subtracted rf / P (a simple rate) from log
    returns: Sharpe was 0.18 lower than the browser's at a 25% rate, and alpha differed."""
    from analytics import compute_interval_returns, risk_free_per_period
    days = pd.bdate_range("2025-01-02", periods=253)
    rng = np.random.default_rng(7)
    m = rng.normal(0.0004, 0.01, 253)
    prices = pd.DataFrame({"MKT": 100 * np.exp(np.cumsum(m)), "B": 50 * np.exp(np.cumsum(0.8 * m + rng.normal(0, 0.006, 253)))}, index=days)
    case = {"series": {t: {"prices": [[d.strftime("%Y-%m-%d"), float(v)] for d, v in prices[t].items()]} for t in prices}, "riskFree": rf, "benchmark": "MKT"}
    run = subprocess.run(["node", str(_JS_RUNNER)], input=json.dumps({"tool": "stock-analytics", "cases": [case]}),
                         capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    web = json.loads(run.stdout)[0]
    metrics = compute_dashboard_metrics(prices, compute_returns(prices, "Log returns"), 252, rf, "Log returns").set_index("Ticker")
    for m_web in web["metrics"]:
        assert metrics.loc[m_web["ticker"], "Sharpe Ratio"] == pytest.approx(m_web["sharpe"], rel=1e-9)
    paired = compute_interval_returns(prices, "Log returns", "Daily")
    desktop = run_pairwise_regression(paired["B"], paired["MKT"], risk_free_per_period(rf, 252, "Log returns"))
    assert desktop["alpha"] == pytest.approx(web["regression"][0]["alpha"], rel=1e-9)
    # Simple-return mode keeps rf / P.
    assert risk_free_per_period(rf, 252, "Simple returns") == rf / 252
