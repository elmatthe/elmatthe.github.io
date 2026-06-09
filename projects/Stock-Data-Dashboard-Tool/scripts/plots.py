"""Matplotlib plot generation helpers."""

from __future__ import annotations

from pathlib import Path
import math

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def _prepare_output(output_path: str) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def plot_price_index(prices: pd.DataFrame, output_path: str) -> str:
    path = _prepare_output(output_path)
    indexed = prices / prices.ffill().bfill().iloc[0] * 100
    ax = indexed.plot(figsize=(9, 5), title="Indexed Price Performance")
    ax.set_ylabel("Index: First Observation = 100")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close()
    return str(path)


def plot_cumulative_returns(returns: pd.DataFrame, output_path: str) -> str:
    path = _prepare_output(output_path)
    cumulative = (1 + returns.fillna(0)).cumprod() - 1
    if cumulative.empty:
        fig, ax = plt.subplots(figsize=(9, 5))
        ax.set_title("Cumulative Returns")
        ax.text(0.5, 0.5, "Not enough observations for cumulative returns.", ha="center", va="center", transform=ax.transAxes)
        ax.set_axis_off()
        plt.tight_layout()
        plt.savefig(path, dpi=140)
        plt.close(fig)
        return str(path)
    ax = cumulative.plot(figsize=(9, 5), title="Cumulative Returns")
    ax.set_ylabel("Cumulative Return")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close()
    return str(path)


def plot_correlation_heatmap(corr_matrix: pd.DataFrame, output_path: str) -> str:
    path = _prepare_output(output_path)
    fig, ax = plt.subplots(figsize=(7, 6))
    image = ax.imshow(corr_matrix.values, vmin=-1, vmax=1, cmap="coolwarm")
    ax.set_xticks(range(len(corr_matrix.columns)), labels=corr_matrix.columns, rotation=45, ha="right")
    ax.set_yticks(range(len(corr_matrix.index)), labels=corr_matrix.index)
    for row in range(len(corr_matrix.index)):
        for col in range(len(corr_matrix.columns)):
            value = corr_matrix.iloc[row, col]
            ax.text(col, row, "" if pd.isna(value) else f"{value:.2f}", ha="center", va="center", fontsize=8)
    fig.colorbar(image, ax=ax, fraction=0.046, pad=0.04)
    ax.set_title("Return Correlation Matrix")
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close(fig)
    return str(path)


def plot_regression_scatter(
    x_returns: pd.Series,
    y_returns: pd.Series,
    regression_result: dict,
    output_path: str,
) -> str:
    path = _prepare_output(output_path)
    df = pd.concat([x_returns, y_returns], axis=1).dropna()
    fig, ax = plt.subplots(figsize=(7, 5))
    ax.scatter(df.iloc[:, 0], df.iloc[:, 1], alpha=0.7)
    if not df.empty and np.isfinite(regression_result.get("alpha", np.nan)) and np.isfinite(regression_result.get("beta", np.nan)):
        x_values = np.linspace(df.iloc[:, 0].min(), df.iloc[:, 0].max(), 50)
        y_values = regression_result["alpha"] + regression_result["beta"] * x_values
        ax.plot(x_values, y_values, color="red")
    ax.set_xlabel(df.columns[0])
    ax.set_ylabel(df.columns[1])
    ax.set_title("Regression Scatterplot")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close(fig)
    return str(path)


def plot_risk_return_scatter(metrics: pd.DataFrame, output_path: str) -> str:
    path = _prepare_output(output_path)
    fig, ax = plt.subplots(figsize=(7, 5))
    required = {"Ticker", "Annualized Return", "Annualized Volatility"}
    if not required.issubset(metrics.columns):
        raise ValueError("Metrics data is missing required risk/return columns.")
    plot_data = metrics.dropna(subset=["Annualized Return", "Annualized Volatility"])
    ax.scatter(plot_data["Annualized Volatility"], plot_data["Annualized Return"], s=70, alpha=0.8)
    for _, row in plot_data.iterrows():
        sharpe = row.get("Sharpe Ratio")
        label = str(row["Ticker"])
        if isinstance(sharpe, (int, float)) and math.isfinite(sharpe):
            label = f"{label} ({sharpe:.2f})"
        ax.annotate(label, (row["Annualized Volatility"], row["Annualized Return"]), xytext=(5, 5), textcoords="offset points", fontsize=8)
    ax.set_xlabel("Annualized Volatility")
    ax.set_ylabel("Annualized Return")
    ax.set_title("Risk / Return Scatter")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close(fig)
    return str(path)


def plot_drawdowns(prices: pd.DataFrame, output_path: str) -> str:
    path = _prepare_output(output_path)
    running_max = prices.cummax()
    drawdown = prices / running_max - 1
    ax = drawdown.plot(figsize=(9, 5), title="Drawdown")
    ax.set_ylabel("Drawdown")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close()
    return str(path)


def plot_rolling_volatility(
    returns: pd.DataFrame,
    periods_per_year: int,
    output_path: str,
    window: int = 12,
    window_label: str | None = None,
) -> str:
    path = _prepare_output(output_path)
    min_periods = min(window, max(3, window // 2))
    rolling_vol = returns.rolling(window=window, min_periods=min_periods).std() * math.sqrt(periods_per_year)
    title_label = window_label or f"{window} periods"
    if rolling_vol.dropna(how="all").empty:
        fig, ax = plt.subplots(figsize=(9, 5))
        ax.set_title(f"Rolling Volatility ({title_label})")
        ax.text(0.5, 0.5, "Not enough observations for rolling volatility.", ha="center", va="center", transform=ax.transAxes)
        ax.set_axis_off()
        plt.tight_layout()
        plt.savefig(path, dpi=140)
        plt.close(fig)
        return str(path)
    ax = rolling_vol.plot(figsize=(9, 5), title=f"Rolling Volatility ({title_label})")
    ax.set_ylabel("Annualized Volatility")
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close()
    return str(path)


def plot_rolling_correlation_vs_benchmark(
    returns: pd.DataFrame,
    benchmark_ticker: str,
    output_path: str,
    window: int = 12,
    window_label: str | None = None,
) -> str:
    if benchmark_ticker not in returns.columns:
        raise ValueError(f"Benchmark ticker not found: {benchmark_ticker}")
    path = _prepare_output(output_path)
    correlations = pd.DataFrame(index=returns.index)
    min_periods = min(window, max(3, window // 2))
    for ticker in returns.columns:
        if ticker == benchmark_ticker:
            continue
        pair = returns[[ticker, benchmark_ticker]].dropna()
        if pair.empty:
            continue
        correlations.loc[pair.index, ticker] = pair[ticker].rolling(window=window, min_periods=min_periods).corr(pair[benchmark_ticker])
    title_label = window_label or f"{window} periods"
    if correlations.dropna(how="all").empty:
        fig, ax = plt.subplots(figsize=(9, 5))
        ax.set_title(f"Rolling Correlation vs {benchmark_ticker} ({title_label})")
        ax.text(0.5, 0.5, "Not enough overlapping observations for rolling correlation.", ha="center", va="center", transform=ax.transAxes)
        ax.set_axis_off()
        plt.tight_layout()
        plt.savefig(path, dpi=140)
        plt.close(fig)
        return str(path)
    ax = correlations.plot(figsize=(9, 5), title=f"Rolling Correlation vs {benchmark_ticker} ({title_label})")
    ax.set_ylabel("Correlation")
    ax.set_ylim(-1, 1)
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(path, dpi=140)
    plt.close()
    return str(path)
