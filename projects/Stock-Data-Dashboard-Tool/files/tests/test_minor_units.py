"""Regression: minor-unit listing currencies (pence) are converted to the major currency."""
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from data_sources import OfflineCsvSource, convert_minor_units  # noqa: E402


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


def test_offline_csv_pence_converted(tmp_path):
    (tmp_path / "TSCO.L.csv").write_text("Date,Close,Adj Close,Currency\n2024-01-02,412,400,GBp\n2024-01-03,420,410,GBp\n", encoding="utf-8")
    result = OfflineCsvSource(str(tmp_path)).fetch_prices("TSCO.L", "2024-01-01", "2024-01-31", "Adjusted Close", "Daily")
    assert result.currency == "GBP"
    assert result.prices["Adj Close"].round(4).tolist() == [4.0, 4.1]


def test_offline_csv_rand_cents_and_agorot_converted(tmp_path):
    # Regression: only GBp/GBX were converted, so a Johannesburg file in ZAc kept its
    # cents (350000 instead of 3500.00) under the non-currency label "ZAC", and a Tel Aviv
    # file in ILA kept agorot labelled "ILA".
    (tmp_path / "NPN.JO.csv").write_text("Date,Close,Currency\n2024-01-02,350000,ZAc\n2024-01-03,352000,ZAc\n", encoding="utf-8")
    (tmp_path / "TEVA.TA.csv").write_text("Date,Close,Currency\n2024-01-02,4120,ILA\n2024-01-03,4150,ILA\n", encoding="utf-8")
    za = OfflineCsvSource(str(tmp_path)).fetch_prices("NPN.JO", "2024-01-01", "2024-01-31", "Close", "Daily")
    assert za.currency == "ZAR"
    assert za.prices["Close"].round(6).tolist() == [3500.0, 3520.0]
    assert any("1/100 ZAR" in w for w in za.warnings)
    il = OfflineCsvSource(str(tmp_path)).fetch_prices("TEVA.TA", "2024-01-01", "2024-01-31", "Close", "Daily")
    assert il.currency == "ILS"
    assert il.prices["Close"].round(6).tolist() == [41.2, 41.5]
