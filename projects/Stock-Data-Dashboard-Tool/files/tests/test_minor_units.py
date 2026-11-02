"""Regression: minor-unit listing currencies (pence) are converted to the major currency."""
from pathlib import Path
import sys
import types

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import data_sources  # noqa: E402
from data_sources import OfflineCsvSource, YahooFinanceSource, convert_minor_units  # noqa: E402


def test_convert_minor_units_scales_prices_and_relabels():
    frame = pd.DataFrame({"Close": [412.0, 420.0], "Adj Close": [400.0, 410.0], "Currency": ["GBp", "GBp"]},
                         index=pd.to_datetime(["2026-10-29", "2026-10-30"]))
    converted, currency, warnings = convert_minor_units(frame, "GBp", "TSCO.L")
    assert currency == "GBP"
    assert converted["Close"].tolist() == [4.12, 4.20]
    assert converted["Adj Close"].tolist() == [4.0, 4.1]
    assert set(converted["Currency"]) == {"GBP"}
    assert "1/100 GBP" in warnings[0]
    same, currency, warnings = convert_minor_units(frame, "USD", "X")
    assert same is frame and currency == "USD" and warnings == []


def test_yahoo_source_converts_pence(monkeypatch):
    history = pd.DataFrame({"Close": [412.0, 420.0], "Adj Close": [400.0, 410.0]},
                           index=pd.to_datetime(["2026-10-29", "2026-10-30"]).tz_localize("Europe/London"))

    class FakeTicker:
        def __init__(self, symbol):
            self.fast_info = {"currency": "GBp"}

        def history(self, **kwargs):
            return history

        def get_info(self):
            return {"shortName": "Tesco PLC"}

    fake = types.SimpleNamespace(Ticker=FakeTicker, set_tz_cache_location=lambda path: None)
    monkeypatch.setattr(data_sources, "yf", fake)
    monkeypatch.setattr(data_sources, "get_files_dir", lambda: Path(__file__).resolve().parents[2] / "files" / "run-temp")
    result = YahooFinanceSource().fetch_prices("TSCO.L", "2026-10-29", "2026-10-31", "Adjusted Close", "Daily")
    assert result.currency == "GBP"
    assert result.prices["Close"].round(4).tolist() == [4.12, 4.2]
    assert any("converted to GBP" in w for w in result.warnings)


def test_offline_csv_pence_converted(tmp_path):
    (tmp_path / "TSCO.L.csv").write_text("Date,Close,Adj Close,Currency\n2024-01-02,412,400,GBp\n2024-01-03,420,410,GBp\n", encoding="utf-8")
    result = OfflineCsvSource(str(tmp_path)).fetch_prices("TSCO.L", "2024-01-01", "2024-01-31", "Adjusted Close", "Daily")
    assert result.currency == "GBP"
    assert result.prices["Adj Close"].round(4).tolist() == [4.0, 4.1]
