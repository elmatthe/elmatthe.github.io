from pathlib import Path
import shutil
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from plots import (  # noqa: E402
    plot_correlation_heatmap,
    plot_drawdowns,
    plot_risk_return_scatter,
    plot_rolling_correlation_vs_benchmark,
    plot_rolling_volatility,
)


def temp_plot_dir(name: str) -> Path:
    path = Path(__file__).resolve().parents[1] / ".run-temp" / name
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def sample_prices() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "AAPL": [100.0, 102.0, 101.0, 105.0, 107.0],
            "MSFT": [200.0, 204.0, 208.0, 212.0, 214.0],
        },
        index=pd.date_range("2024-01-01", periods=5),
    )


def sample_metrics() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Ticker": ["AAPL", "MSFT"],
            "Annualized Return": [0.12, 0.10],
            "Annualized Volatility": [0.20, 0.18],
            "Sharpe Ratio": [0.60, 0.55],
        }
    )


def test_risk_return_scatterplot_creates_png():
    folder = temp_plot_dir("plot-risk-return")
    path = plot_risk_return_scatter(sample_metrics(), str(folder / "risk_return.png"))
    assert Path(path).exists()


def test_drawdown_chart_creates_png():
    folder = temp_plot_dir("plot-drawdown")
    path = plot_drawdowns(sample_prices(), str(folder / "drawdown.png"))
    assert Path(path).exists()


def test_rolling_volatility_chart_creates_png():
    folder = temp_plot_dir("plot-rolling-vol")
    returns = sample_prices().pct_change(fill_method=None)
    path = plot_rolling_volatility(returns, 252, str(folder / "rolling_vol.png"), window=2, window_label="2-day window")
    assert Path(path).exists()


def test_rolling_correlation_chart_creates_png():
    folder = temp_plot_dir("plot-rolling-corr")
    returns = sample_prices().pct_change(fill_method=None)
    path = plot_rolling_correlation_vs_benchmark(returns, "AAPL", str(folder / "rolling_corr.png"), window=2, window_label="2-day window")
    assert Path(path).exists()


def test_correlation_heatmap_creates_png():
    folder = temp_plot_dir("plot-corr")
    corr = sample_prices().pct_change(fill_method=None).corr()
    path = plot_correlation_heatmap(corr, str(folder / "corr.png"))
    assert Path(path).exists()
