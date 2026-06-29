from pathlib import Path
import sys

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from analytics import (  # noqa: E402
    align_fx_rate,
    compute_dashboard_metrics,
    compute_returns,
    convert_price_frame,
    normalize_price_frames_to_currency,
)
from config import NORMALIZE_CURRENCY_OPTIONS, parse_normalization_choice  # noqa: E402
from data_sources import get_offline_fx_rate, load_offline_fx_rates  # noqa: E402


DATES = pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"])


def cad_frame():
    return pd.DataFrame(
        {"Close": [30.0, 30.5, 30.25], "Adj Close": [30.0, 30.5, 30.25]},
        index=DATES,
    )


def test_parse_normalization_choice():
    assert parse_normalization_choice(NORMALIZE_CURRENCY_OPTIONS[0]) is None
    assert parse_normalization_choice("Off (native listing currency)") is None
    assert parse_normalization_choice("usd") == "USD"
    assert parse_normalization_choice("CAD") == "CAD"


def test_convert_price_frame_with_known_rate():
    rate = pd.Series([0.75, 0.75, 0.75], index=DATES)
    converted = convert_price_frame(cad_frame(), rate)
    assert np.allclose(converted["Close"].to_numpy(), [22.5, 22.875, 22.6875])


def test_align_fx_rate_forward_and_back_fills():
    # Rate only known for the middle date; edges should fill from nearest known value.
    sparse = pd.Series([0.752], index=pd.to_datetime(["2024-01-03"]))
    aligned = align_fx_rate(sparse, DATES)
    assert list(aligned.to_numpy()) == [0.752, 0.752, 0.752]


def test_normalize_to_target_is_noop_when_already_target():
    frames = {"AAPL": cad_frame()}
    converted, warnings, result_currencies = normalize_price_frames_to_currency(
        frames, {"AAPL": "USD"}, "USD", lambda n, t: pd.Series([99.0], index=DATES)
    )
    # AAPL is already USD here, so no FX provider call should change its values.
    assert np.allclose(converted["AAPL"]["Close"].to_numpy(), cad_frame()["Close"].to_numpy())
    assert result_currencies["AAPL"] == "USD"
    assert warnings == []


def test_normalize_known_prices_and_varying_fx_match_expected():
    frames = {"XIU.TO": cad_frame()}
    varying = pd.Series([0.75, 0.752, 0.749], index=DATES)
    converted, warnings, result_currencies = normalize_price_frames_to_currency(
        frames, {"XIU.TO": "CAD"}, "USD", lambda n, t: varying
    )
    usd_prices = converted["XIU.TO"]["Adj Close"]
    assert np.allclose(usd_prices.to_numpy(), [22.5, 22.936, 22.65725])
    assert result_currencies["XIU.TO"] == "USD"

    returns = compute_returns(converted["XIU.TO"][["Adj Close"]].rename(columns={"Adj Close": "XIU.TO"}))
    metrics = compute_dashboard_metrics(
        converted["XIU.TO"][["Adj Close"]].rename(columns={"Adj Close": "XIU.TO"}),
        returns,
        periods_per_year=252,
    )
    total = float(metrics.loc[0, "Total Return"])
    # USD total return differs from the native CAD total return (0.008333) because
    # of FX drift over the window — proving conversion happens before returns.
    assert np.isclose(total, 22.65725 / 22.5 - 1)
    assert not np.isclose(total, 30.25 / 30.0 - 1)


def test_normalize_fails_soft_when_rate_unavailable():
    frames = {"XIU.TO": cad_frame()}
    converted, warnings, result_currencies = normalize_price_frames_to_currency(
        frames, {"XIU.TO": "CAD"}, "USD", lambda n, t: None
    )
    # Native values preserved, native currency retained, clear warning surfaced.
    assert np.allclose(converted["XIU.TO"]["Close"].to_numpy(), cad_frame()["Close"].to_numpy())
    assert result_currencies["XIU.TO"] == "CAD"
    assert any("FX rates unavailable" in w for w in warnings)


def test_bundled_offline_fx_rates_load_and_invert():
    rates = load_offline_fx_rates(str(ROOT / "test-files"))
    assert "CADUSD" in rates
    cad_usd = get_offline_fx_rate(rates, "CAD", "USD")
    assert cad_usd is not None and not cad_usd.empty
    # USD->CAD can be derived from the inverse of CADUSD or read directly.
    usd_cad = get_offline_fx_rate(rates, "USD", "CAD")
    assert usd_cad is not None and (usd_cad.to_numpy() > 1).all()
