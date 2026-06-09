from pathlib import Path
import shutil
import sys

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from data_sources import DataSourceError, OfflineCsvSource, load_offline_csv_folder, normalize_price_frame  # noqa: E402


def temp_offline_dir(name: str) -> Path:
    path = Path(__file__).resolve().parents[1] / ".run-temp" / name
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def test_offline_csv_loads_combined_sample():
    folder = Path(__file__).resolve().parents[1] / "test-files"
    data = load_offline_csv_folder(str(folder))
    assert {"AAPL", "MSFT", "XIU.TO"}.issubset(data)
    assert data["AAPL"].loc[pd.Timestamp("2024-01-03"), "Close"] == 102


def test_missing_required_columns_raise_clean_error():
    frame = pd.DataFrame({"Date": ["2024-01-02"], "Ticker": ["AAPL"]})
    with pytest.raises(DataSourceError, match="missing a Close or Adjusted Close"):
        normalize_price_frame(frame, "AAPL")


def test_ticker_inferred_from_filename_when_missing_column():
    temp_dir = Path(__file__).resolve().parents[1] / ".run-temp" / "offline-single"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True)
    csv_path = temp_dir / "MSFT.csv"
    csv_path.write_text("Date,Close,Adj Close\n2024-01-02,200,199\n", encoding="utf-8")
    data = load_offline_csv_folder(str(temp_dir))
    assert "MSFT" in data
    assert data["MSFT"].loc[pd.Timestamp("2024-01-02"), "Adj Close"] == 199


def test_ticker_matching_is_case_insensitive_and_whitespace_safe():
    temp_dir = temp_offline_dir("offline-case")
    csv_path = temp_dir / "sample.csv"
    csv_path.write_text(
        "Date,Ticker,Close,Adj Close,Currency\n2024-01-02, xiu.to ,30,30,CAD\n",
        encoding="utf-8",
    )
    data = load_offline_csv_folder(str(temp_dir))
    assert "XIU.TO" in data


def test_offline_fetch_accepts_case_insensitive_request():
    source = OfflineCsvSource(str(Path(__file__).resolve().parents[1] / "test-files"))
    result = source.fetch_prices(" xiu.to ", "2024-01-02", "2024-01-04", "Adjusted Close", "Daily")
    assert result.ticker == "XIU.TO"
    assert len(result.prices) == 3
    assert result.currency == "CAD"


def test_offline_csv_without_currency_column_returns_none_currency():
    temp_dir = temp_offline_dir("offline-no-currency")
    csv_path = temp_dir / "AAPL.csv"
    csv_path.write_text("Date,Close,Adj Close\n2024-01-02,100,100\n2024-01-03,101,101\n", encoding="utf-8")
    source = OfflineCsvSource(str(temp_dir))
    result = source.fetch_prices("AAPL", "2024-01-02", "2024-01-03", "Adjusted Close", "Daily")
    assert result.currency is None


def test_offline_csv_mixed_currency_uses_most_common_with_warning():
    temp_dir = temp_offline_dir("offline-mixed-currency")
    csv_path = temp_dir / "AAPL.csv"
    csv_path.write_text(
        "Date,Close,Adj Close,Currency\n"
        "2024-01-02,100,100,USD\n"
        "2024-01-03,101,101,USD\n"
        "2024-01-04,102,102,CAD\n",
        encoding="utf-8",
    )
    source = OfflineCsvSource(str(temp_dir))
    result = source.fetch_prices("AAPL", "2024-01-02", "2024-01-04", "Adjusted Close", "Daily")
    assert result.currency == "USD"
    assert any("Multiple currency values" in warning for warning in result.warnings)


def test_offline_fetch_missing_date_overlap_has_clear_error():
    source = OfflineCsvSource(str(Path(__file__).resolve().parents[1] / "test-files"))
    with pytest.raises(DataSourceError, match="no rows overlap the selected date range"):
        source.fetch_prices("AAPL", "2025-01-01", "2026-06-09", "Adjusted Close", "Daily")


def test_adjusted_close_falls_back_to_close_with_warning():
    temp_dir = temp_offline_dir("offline-close-fallback")
    csv_path = temp_dir / "AAPL.csv"
    csv_path.write_text("Date,Close,Currency\n2024-01-02,100,USD\n2024-01-03,101,USD\n", encoding="utf-8")
    source = OfflineCsvSource(str(temp_dir))
    result = source.fetch_prices("AAPL", "2024-01-02", "2024-01-03", "Adjusted Close", "Daily")
    assert result.prices["Adj Close"].tolist() == [100, 101]
    assert any("Falling back to Close" in warning for warning in result.warnings)


def test_invalid_offline_folder_returns_clean_error():
    missing = temp_offline_dir("offline-invalid-parent") / "missing"
    with pytest.raises(DataSourceError, match="Offline CSV folder does not exist"):
        load_offline_csv_folder(str(missing))


def test_no_csv_files_returns_clean_error():
    temp_dir = temp_offline_dir("offline-empty")
    with pytest.raises(DataSourceError, match="No CSV files were found"):
        load_offline_csv_folder(str(temp_dir))
