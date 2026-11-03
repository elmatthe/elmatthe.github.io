"""Audit Appendix C, R1/R3/R4/R7/R8/R13: calendar alignment, chart, bins, FX, CSV, variance."""
import datetime as dt
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
