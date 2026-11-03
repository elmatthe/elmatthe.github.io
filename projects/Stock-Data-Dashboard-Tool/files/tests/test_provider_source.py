"""Provider-key history source (replaces Yahoo Finance): every provider mocked."""
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from data_sources import DataSourceError, ProviderHistorySource, get_data_source  # noqa: E402
from market_data.service import MarketData  # noqa: E402

DAYS = pd.bdate_range("2026-01-05", "2026-10-30")


def fake_http(calls, currency="GBX", exchange="XLON", symbol_ok=True):
    def http(url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        calls.append((u.netloc, u.path, q.get("symbol") or q.get("symbols")))
        if u.netloc == "api.marketstack.com":
            sym = q["symbols"]
            rows = [{"symbol": sym if symbol_ok else "OTHER", "exchange": exchange, "price_currency": currency, "date": f"{d.date()}T00:00:00+0000",
                     "close": 400.0 + i, "adj_close": 390.0 + i} for i, d in enumerate(DAYS)]
            return 200, json.dumps({"pagination": {"total": len(rows), "count": len(rows)}, "data": rows})
        if u.netloc == "www.alphavantage.co":
            series = {str(d.date()): {"4. close": str(100 + i), "5. adjusted close": str(99 + i)} for i, d in enumerate(DAYS[DAYS.weekday == 4])}
            return 200, json.dumps({"Weekly Adjusted Time Series": series})
        if u.netloc == "www.bankofcanada.ca":
            series = u.path.split("/observations/")[1].split("/")[0].split(",")
            return 200, json.dumps({"observations": [{"d": str(d.date()), **{s: {"v": "1.85" if "GBP" in s else "1.40"} for s in series}} for d in DAYS[::5]]})
        return 404, "{}"
    return http


def market(calls, **kw):
    md = MarketData(None, http=fake_http(calls, **kw), sleep=lambda s: None, pacing_override_ms=0)
    md.set_key("marketstack", "MSKEY1234567890ABCDEF")
    md.set_key("alphavantage", "AVKEY1234567")
    return md


def test_marketstack_daily_adjusted_history_in_pounds():
    calls = []
    source = get_data_source("Marketstack (your key)", None, market(calls))
    assert isinstance(source, ProviderHistorySource) and source.is_configured()
    result = source.fetch_prices("VOD.L", "2026-01-01", "2026-10-30", "Adjusted Close", "Daily")
    assert result.currency == "GBP"
    assert result.prices["Close"].iloc[0] == pytest.approx(4.0) and result.prices["Adj Close"].iloc[0] == pytest.approx(3.9)
    assert len(result.prices) == len(DAYS)
    assert any("Marketstack daily close" in w for w in result.warnings)
    assert sum(1 for c in calls if c[0] == "api.marketstack.com") == 1


def test_wrong_exchange_or_currency_is_refused():
    with pytest.raises(DataSourceError, match="not Toronto Stock Exchange"):
        get_data_source("Marketstack (your key)", None, market([], exchange="XNYS", currency="USD")).fetch_prices("VEQT.TO", "2026-01-01", "2026-10-30", "Close", "Daily")
    with pytest.raises(DataSourceError, match="trades in CAD"):
        get_data_source("Marketstack (your key)", None, market([], exchange="XTSE", currency="USD")).fetch_prices("VEQT.TO", "2026-01-01", "2026-10-30", "Close", "Daily")


def test_alpha_vantage_long_window_uses_weekly_adjusted_and_reports_it():
    calls = []
    result = get_data_source("Alpha Vantage (your key)", None, market(calls)).fetch_prices("AAPL", "2025-11-01", "2026-10-30", "Adjusted Close", "Weekly")
    assert result.currency == "USD"
    assert any("weekly closes and adjusted closes" in w for w in result.warnings)
    assert [c[2] for c in calls if c[0] == "www.alphavantage.co"] == ["AAPL"], "curated identity: one request, no symbol search"


def test_ynvd_is_not_covered_and_yahoo_is_gone():
    with pytest.raises(DataSourceError, match="no symbol|not covered|Cboe Canada"):
        get_data_source("Alpha Vantage (your key)", None, market([])).fetch_prices("YNVD.TO", "2026-01-01", "2026-10-30", "Close", "Daily")
    with pytest.raises(DataSourceError):
        get_data_source("Yahoo Finance", None, market([]))
    import data_sources
    assert not hasattr(data_sources, "YahooFinanceSource")


def test_fx_history_from_bank_of_canada_derived_through_cad():
    source = get_data_source("Marketstack (your key)", None, market([]))
    rate = source.fetch_fx_rate("GBP", "USD", "2026-01-01", "2026-10-30", "Daily")
    assert rate is not None and rate.iloc[0] == pytest.approx(1.85 / 1.40)
