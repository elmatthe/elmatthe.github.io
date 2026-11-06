"""History by the user's source list (Yahoo Finance through the data gateway, and
providers with the user's own keys): every source mocked."""
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from data_sources import MARKET_SOURCE, DataSourceError, SourceListHistorySource, get_data_source  # noqa: E402
from market_data.service import MarketData  # noqa: E402

DAYS = pd.bdate_range("2026-01-05", "2026-10-30")


GATEWAY = "https://md.gateway.test"


def gateway_history(q):
    """A minimal stand-in for the gateway's history contract (the real Worker is tested in
    _tools/tests/test_desktop_gateway.py)."""
    sym = q["symbol"]
    listing = {"AAPL": ("US", "USD", 1), "SPCX": ("US", "USD", 1), "VOD.L": ("XLON", "GBp", 0.01)}.get(sym)
    if not listing:
        return 404, json.dumps({"schema": "md-gateway.error.v1", "error": {"code": "symbol_not_found", "message": "x", "retryable": False, "definitive": True}})
    mic, raw, scale = listing
    obs = [[str(d.date()), round((200.0 + i) * scale, 10), round((198.0 + i) * scale, 10)] for i, d in enumerate(DAYS)]
    return 200, json.dumps({"schema": "md-gateway.history.v1", "listing": {"symbol": sym, "mic": mic, "timeZone": "America/New_York"}, "currency": "GBP" if raw == "GBp" else raw,
                            "rawCurrency": raw, "quoteUnit": "minor" if scale != 1 else "major", "unitScale": scale, "range": q["range"], "interval": "1d", "frequency": "daily",
                            "adjustment": {"adjCloseAvailable": True}, "observations": obs, "retrievedAt": "2026-11-03T15:00:00Z", "cache": {"status": "miss", "ageSeconds": 0, "ttlSeconds": 43200}})


def fake_http(calls, currency="GBX", exchange="XLON", symbol_ok=True):
    def http(url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        calls.append((u.netloc, u.path, q.get("symbol") or q.get("symbols")))
        if u.netloc == "md.gateway.test":
            assert not any(k in url or k in json.dumps(headers) for k in ("MSKEY1234567890ABCDEF", "AVKEY1234567")), "no key reaches the gateway"
            if u.path == "/v1/health":
                return 200, json.dumps({"schema": "md-gateway.health.v1", "keyless": {"enabled": True}})
            return gateway_history(q)
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


def market(calls, first=None, gateway_url="", **kw):
    """Keys for Marketstack and Alpha Vantage; `first` moves one source to the top of the list."""
    md = MarketData(None, http=fake_http(calls, **kw), sleep=lambda s: None, pacing_override_ms=0, gateway_url=gateway_url)
    md.gateway.check()
    md.set_key("marketstack", "MSKEY1234567890ABCDEF")
    md.set_key("alphavantage", "AVKEY1234567")
    if first:
        md.move_source(first, 0)
    return md


def source(md):
    return get_data_source(MARKET_SOURCE, None, md)


def test_marketstack_daily_adjusted_history_in_pounds():
    calls = []
    src = source(market(calls, first="marketstack"))
    assert isinstance(src, SourceListHistorySource) and src.is_configured()
    result = src.fetch_prices("VOD.L", "2026-01-01", "2026-10-30", "Adjusted Close", "Daily")
    assert result.source == "Marketstack"
    assert result.currency == "GBP"
    assert result.prices["Close"].iloc[0] == pytest.approx(4.0) and result.prices["Adj Close"].iloc[0] == pytest.approx(3.9)
    assert len(result.prices) == len(DAYS)
    assert any("Marketstack daily close" in w for w in result.warnings)
    assert sum(1 for c in calls if c[0] == "api.marketstack.com") == 1


def test_wrong_exchange_or_currency_is_refused():
    with pytest.raises(DataSourceError, match="not Toronto Stock Exchange"):
        source(market([], first="marketstack", exchange="XNYS", currency="USD")).fetch_prices("VEQT.TO", "2026-01-01", "2026-10-30", "Close", "Daily")
    with pytest.raises(DataSourceError, match="trades in CAD"):
        source(market([], first="marketstack", exchange="XTSE", currency="USD")).fetch_prices("VEQT.TO", "2026-01-01", "2026-10-30", "Close", "Daily")


def test_alpha_vantage_long_window_uses_weekly_adjusted_and_reports_it():
    calls = []
    result = source(market(calls, first="alphavantage")).fetch_prices("AAPL", "2025-11-01", "2026-10-30", "Adjusted Close", "Weekly")
    assert result.source == "Alpha Vantage"
    assert result.currency == "USD"
    assert any("weekly closes and adjusted closes" in w for w in result.warnings)
    assert [c[2] for c in calls if c[0] == "www.alphavantage.co"] == ["AAPL"], "curated identity: one request, no symbol search"


def test_ynvd_is_not_covered_and_yahoo_is_gone():
    with pytest.raises(DataSourceError, match="no symbol|not covered|Cboe Canada"):
        source(market([], first="alphavantage")).fetch_prices("YNVD.TO", "2026-01-01", "2026-10-30", "Close", "Weekly")
    with pytest.raises(DataSourceError):
        get_data_source("Yahoo Finance", None, market([]))
    import data_sources
    assert not hasattr(data_sources, "YahooFinanceSource"), "no yfinance: Yahoo Finance only through the data gateway"


def test_fx_history_from_bank_of_canada_derived_through_cad():
    rate = source(market([])).fetch_fx_rate("GBP", "USD", "2026-01-01", "2026-10-30", "Daily")
    assert rate is not None and rate.iloc[0] == pytest.approx(1.85 / 1.40)


def test_yahoo_first_then_fallback_and_the_desktop_frequency_rule():
    calls = []
    md = market(calls, gateway_url=GATEWAY)
    assert [s["id"] for s in md.sources_list()][:3] == ["yahoo", "alphavantage", "marketstack"], "keys join below Yahoo Finance"
    vod = source(md).fetch_prices("VOD.L", "2026-01-01", "2026-10-30", "Adjusted Close", "Daily")
    assert vod.source == "Yahoo Finance" and vod.currency == "GBP" and vod.prices["Close"].iloc[0] == pytest.approx(2.0) and vod.prices["Adj Close"].iloc[0] == pytest.approx(1.98)
    assert not any(c[0] in ("api.marketstack.com", "www.alphavantage.co") for c in calls), "the first source answered: no other source asked"
    # Yahoo Finance has no data for TSCO.L here: Alpha Vantage would give weekly prices for a Daily analysis, so it is skipped; Marketstack answers.
    sap = source(md).fetch_prices("TSCO.L", "2026-01-01", "2026-10-30", "Close", "Daily")
    assert sap.source == "Marketstack" and sap.tried == ["Yahoo Finance: has no data for this listing"]
    assert any("Alpha Vantage: would give weekly prices for this period, and this comparison uses daily prices" in x for x in sap.skipped)
    assert any("Marketstack was used because Yahoo Finance: has no data for this listing" in w for w in sap.warnings)
    # A Weekly analysis accepts Alpha Vantage's weekly series: it is asked (before Marketstack). This fake's
    # symbol search does not list TSCO.LON, so Alpha Vantage says so and Marketstack answers.
    weekly = source(md).fetch_prices("TSCO.L", "2026-01-01", "2026-10-30", "Close", "Weekly")
    assert not any("would give weekly" in x for x in weekly.skipped)
    assert weekly.tried == ["Yahoo Finance: has no data for this listing", "Alpha Vantage: has no data for this listing"] and weekly.source == "Marketstack"
    with pytest.raises(DataSourceError, match="market indexes are not available"):
        source(md).fetch_prices("^GSPC", "2026-01-01", "2026-10-30", "Close", "Daily")


def test_reused_ticker_history_excludes_the_older_security_at_every_frequency(monkeypatch):
    """SPCX reused an older security's ticker. Even with no bar on the listing date itself,
    no price of the older security survives into daily or weekly series."""
    days = DAYS[DAYS != pd.Timestamp("2026-06-12")]
    monkeypatch.setitem(globals(), "DAYS", days)
    calls = []
    src = source(market(calls, first="yahoo", gateway_url=GATEWAY))
    daily = src.fetch_prices("SPCX", "2026-01-05", "2026-10-30", "Adjusted Close", "Daily")
    assert daily.prices.index.min() >= pd.Timestamp("2026-06-12")
    assert any("listed only since 2026-06-12" in w for w in daily.warnings)
    weekly = src.fetch_prices("SPCX", "2026-01-05", "2026-10-30", "Adjusted Close", "Weekly")
    old_prices = {198.0 + i for i, d in enumerate(days) if d < pd.Timestamp("2026-06-12")}
    assert not (set(weekly.prices["Adj Close"]) & old_prices), "no price of the earlier security survives resampling"
    assert weekly.prices.index.min() >= pd.Timestamp("2026-06-12")
    # Another listing is untouched.
    assert src.fetch_prices("AAPL", "2026-01-05", "2026-10-30", "Adjusted Close", "Daily").prices.index.min() == days[0]
