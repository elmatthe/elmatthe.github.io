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


def test_first_price_on_a_bank_of_canada_holiday_uses_the_previous_fixing():
    """Regression: rates were requested from the window's first day only, so a first price on
    a day the Bank of Canada does not publish (Canada Day, 2026-07-01, NYSE open) had no
    earlier fixing and was dropped from a USD->CAD comparison."""
    from analytics import normalize_price_frames_to_currency

    fixings = {str(d.date()): 1.30 + 0.01 * i for i, d in enumerate(pd.bdate_range("2026-06-15", "2026-07-10")) if str(d.date()) != "2026-07-01"}
    asked = []

    def http(url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        assert u.netloc == "www.bankofcanada.ca"
        asked.append(q)
        return 200, json.dumps({"observations": [{"d": d, "FXUSDCAD": {"v": str(v)}} for d, v in fixings.items() if q["start_date"] <= d <= q["end_date"]]})

    src = source(MarketData(None, http=http, sleep=lambda s: None, pacing_override_ms=0, gateway_url=""))
    days = pd.bdate_range("2026-07-01", "2026-07-03")
    frame = pd.DataFrame({"Close": [100.0, 101.0, 102.0], "Adj Close": [100.0, 101.0, 102.0]}, index=days)
    out, warnings, currencies = normalize_price_frames_to_currency(
        {"SPY": frame}, {"SPY": "USD"}, "CAD", lambda a, b: src.fetch_fx_rate(a, b, "2026-07-01", "2026-07-03", "Daily"))
    assert asked[0]["start_date"] < "2026-07-01", "rates are requested from before the window"
    assert warnings == [] and currencies == {"SPY": "CAD"}
    # 2026-06-30 is the 12th business day from 2026-06-15 (index 11): 1.30 + 0.11 = 1.41 CAD per USD;
    # 2026-07-02 is index 13 (1.43) and 2026-07-03 index 14 (1.44).
    assert out["SPY"]["Close"].tolist() == pytest.approx([100 * 1.41, 101 * 1.43, 102 * 1.44], rel=1e-12)


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


# --- Historical exchange rates: Bank of Canada first, ECB as the fallback (as fx.js) -------
#
# ECB fixture: euro reference rates on TARGET days from 2026-03-16 to 2026-04-17. TARGET is
# closed on Good Friday (04-03) and Easter Monday (04-06); CAD is missing on 04-14, so no
# CAD-per-unit rate exists that day. A row dated 05-29 (after every window below) is served
# regardless of endPeriod, to prove a fixing after the window is never used.

ECB_DAYS = [str(d.date()) for d in pd.bdate_range("2026-03-16", "2026-04-17") if str(d.date()) not in ("2026-04-03", "2026-04-06")]
ECB_PER_EUR = {"CAD": {d: 1.50 + 0.001 * i for i, d in enumerate(ECB_DAYS) if d != "2026-04-14"},
               "USD": {d: 1.08 + 0.0005 * i for i, d in enumerate(ECB_DAYS)},
               "GBP": {d: 0.86 - 0.0002 * i for i, d in enumerate(ECB_DAYS)},
               "CZK": {d: 25.0 + 0.01 * i for i, d in enumerate(ECB_DAYS)}}
ECB_FUTURE = "2026-05-29"


def ecb_csv(codes, start, end, future=True):
    rows = ["KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE"]
    for code in codes:
        for day, value in ECB_PER_EUR[code].items():
            if start <= day <= end:
                rows.append(f"EXR.D.{code}.EUR.SP00.A,D,{code},EUR,SP00,A,{day},{value!r}")
        if code == "CAD":
            rows.append(f"EXR.D.CAD.EUR.SP00.A,D,CAD,EUR,SP00,A,2026-04-14,NaN")
        if future:
            rows.append(f"EXR.D.{code}.EUR.SP00.A,D,{code},EUR,SP00,A,{ECB_FUTURE},99")
    return "\n".join(rows) + "\n"


def fx_http(boc=(503, "unavailable"), ecb_status=200, asked=None):
    """Bank of Canada answers `boc`; the ECB answers from the fixture for the requested period."""
    def http(url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if asked is not None:
            asked.append((u.netloc, u.path, q))
        if u.netloc == "www.bankofcanada.ca":
            return boc
        if u.netloc == "data-api.ecb.europa.eu":
            codes = u.path.split("/D.")[1].split(".EUR")[0].split("+")
            return ecb_status, ecb_csv(codes, q["startPeriod"], q["endPeriod"]) if ecb_status == 200 else "error"
        raise AssertionError(f"unexpected request {url}")
    return http


def fx_source(http):
    return source(MarketData(None, http=http, sleep=lambda s: None, pacing_override_ms=0, gateway_url=""))


def cad_per(code, day):
    """Independent expectation: CAD per one unit = (CAD per EUR) / (unit per EUR)."""
    cad = ECB_PER_EUR["CAD"].get(day)
    if code == "EUR":
        return cad
    return None if cad is None else cad / ECB_PER_EUR[code][day]


def test_ecb_fallback_when_the_bank_of_canada_fails():
    asked = []
    src = fx_source(fx_http(asked=asked))
    assert src.prepare_fx(["USD", "GBP"], "CAD", "2026-04-01", "2026-04-17") == []
    hosts = [a[0] for a in asked]
    assert hosts == ["www.bankofcanada.ca", "data-api.ecb.europa.eu"], "Bank of Canada first, one ECB request for every currency"
    ecb = asked[1]
    assert ecb[1].endswith("/D.CAD+GBP+USD.EUR.SP00.A") and ecb[2]["startPeriod"] == "2026-03-18" and ecb[2]["endPeriod"] == "2026-04-17"
    usd = src.fetch_fx_rate("USD", "CAD", "2026-04-01", "2026-04-17", "Daily")
    expected = {d: cad_per("USD", d) for d in ECB_DAYS if "2026-03-18" <= d <= "2026-04-17" and cad_per("USD", d)}
    assert [str(d.date()) for d in usd.index] == sorted(expected)
    assert usd.tolist() == pytest.approx([expected[d] for d in sorted(expected)], rel=1e-12)
    assert "2026-04-14" not in expected and ECB_FUTURE not in [str(d.date()) for d in usd.index]
    gbp_usd = src.fetch_fx_rate("GBP", "USD", "2026-04-01", "2026-04-17", "Daily")
    assert gbp_usd.loc["2026-04-09"] == pytest.approx(cad_per("GBP", "2026-04-09") / cad_per("USD", "2026-04-09"), rel=1e-12)
    assert len(asked) == 2, "both pairs came from the one ECB answer"
    assert src.fx_sources == {"USD": "European Central Bank daily rates", "GBP": "European Central Bank daily rates (derived via CAD)"}


def test_bank_of_canada_stays_primary_and_ecb_serves_what_it_does_not_publish():
    asked = []
    boc_body = json.dumps({"observations": [{"d": "2026-04-09", "FXUSDCAD": {"v": "1.3800"}}]})
    src = fx_source(fx_http(boc=(200, boc_body), asked=asked))
    src.prepare_fx(["USD"], "CAD", "2026-04-09", "2026-04-09")
    assert [a[0] for a in asked] == ["www.bankofcanada.ca"], "the ECB is not asked when the Bank of Canada answers"
    assert src.fetch_fx_rate("USD", "CAD", "2026-04-09", "2026-04-09", "Daily").tolist() == [1.38]
    assert src.fx_sources == {"USD": "Bank of Canada daily rates"}
    # CZK is not a Bank of Canada series: the whole request (USD too) comes from the ECB, as in the browser.
    asked.clear()
    src.prepare_fx(["CZK", "USD"], "CAD", "2026-04-01", "2026-04-17")
    assert [a[0] for a in asked] == ["data-api.ecb.europa.eu"]
    assert src.fetch_fx_rate("CZK", "CAD", "2026-04-01", "2026-04-17", "Daily").loc["2026-04-09"] == pytest.approx(cad_per("CZK", "2026-04-09"), rel=1e-12)
    assert src.fetch_fx_rate("USD", "CAD", "2026-04-01", "2026-04-17", "Daily").loc["2026-04-09"] == pytest.approx(cad_per("USD", "2026-04-09"), rel=1e-12)


def test_invalid_bank_of_canada_answer_falls_back_and_total_failure_invents_nothing():
    from analytics import normalize_price_frames_to_currency
    bad = json.dumps({"observations": [{"d": "2026-04-09", "FXUSDCAD": {"v": "0"}}]})
    src = fx_source(fx_http(boc=(200, bad)))
    assert src.prepare_fx(["USD"], "CAD", "2026-04-01", "2026-04-17") == []
    assert src.fx_sources == {} and src._fx["provider"] == "European Central Bank"
    src = fx_source(fx_http(boc=(200, "not json"), ecb_status=500))
    warnings = src.prepare_fx(["USD"], "CAD", "2026-04-01", "2026-04-17")
    assert warnings == ["Official exchange rates are unavailable (Official exchange rates could not be retrieved (Bank of Canada: Bank of Canada "
                        "response was not JSON; European Central Bank: ECB HTTP 500).); series in other currencies were left out."]
    frame = pd.DataFrame({"Close": [10.0, 11.0]}, index=pd.to_datetime(["2026-04-08", "2026-04-09"]))
    out, notes, currencies = normalize_price_frames_to_currency({"SPY": frame}, {"SPY": "USD"}, "CAD",
                                                                lambda a, b: src.fetch_fx_rate(a, b, "2026-04-01", "2026-04-17", "Daily"))
    assert out == {} and currencies == {} and any("left out" in n for n in notes), "never converted with an invented rate, never kept unconverted"
    # A currency neither bank publishes is not requested at all.
    asked = []
    assert fx_source(fx_http(asked=asked)).prepare_fx(["ARS"], "CAD", "2026-04-01", "2026-04-17") == [] and asked == []


def test_ecb_holidays_use_the_previous_fixing_within_seven_days_and_never_a_later_one():
    from analytics import normalize_price_frames_to_currency
    src = fx_source(fx_http())
    days = pd.to_datetime(["2026-04-02", "2026-04-03", "2026-04-06", "2026-04-14", "2026-04-17"])
    frame = pd.DataFrame({"Close": [100.0, 101, 102, 103, 104], "Adj Close": [100.0, 101, 102, 103, 104]}, index=days)
    provider = lambda a, b: src.fetch_fx_rate(a, b, "2026-04-02", "2026-04-17", "Daily")  # noqa: E731
    src.prepare_fx(["USD"], "CAD", "2026-04-02", "2026-04-17")
    out, notes, _ = normalize_price_frames_to_currency({"SPY": frame}, {"SPY": "USD"}, "CAD", provider)
    # Good Friday and Easter Monday (no ECB fixing) use Thursday's; 04-14 (no CAD rate) uses 04-13's.
    expected = [100 * cad_per("USD", "2026-04-02"), 101 * cad_per("USD", "2026-04-02"), 102 * cad_per("USD", "2026-04-02"),
                103 * cad_per("USD", "2026-04-13"), 104 * cad_per("USD", "2026-04-17")]
    assert out["SPY"]["Close"].tolist() == pytest.approx(expected, rel=1e-12) and notes == []
    # A price more than 7 days after the last fixing in the window is dropped, not converted with a later one.
    late = pd.DataFrame({"Close": [100.0, 101.0, 102.0]}, index=pd.to_datetime(["2026-04-16", "2026-04-17", "2026-04-27"]))
    src.prepare_fx(["USD"], "CAD", "2026-04-16", "2026-04-27")
    out, notes, _ = normalize_price_frames_to_currency({"SPY": late}, {"SPY": "USD"}, "CAD",
                                                       lambda a, b: src.fetch_fx_rate(a, b, "2026-04-16", "2026-04-27", "Daily"))
    assert list(out["SPY"].index) == list(late.index[:2]), "04-27 is 10 days after the last fixing (04-17); the later 05-29 row is never used"
    assert any("1 price(s) had no USD->CAD fixing within 7 days" in n for n in notes)


_JS_RUNNER = Path(__file__).resolve().parents[4] / "_tools" / "tests" / "js_engines.mjs"


@pytest.mark.skipif(__import__("shutil").which("node") is None or not _JS_RUNNER.exists(), reason="needs Node.js and the site's market-data code")
@pytest.mark.parametrize("boc,codes,pairs", [
    ((503, "unavailable"), ["USD", "GBP", "CAD"], [["USD", "CAD"], ["GBP", "USD"], ["CAD", "USD"], ["GBP", "CAD"]]),
    ((200, json.dumps({"observations": [{"d": "2026-04-09", "FXUSDCAD": {"v": "-1"}}]})), ["EUR", "USD", "CAD"], [["EUR", "USD"], ["CAD", "EUR"]]),
    ((200, json.dumps({"observations": []})), ["CZK", "USD", "CAD"], [["CZK", "USD"], ["USD", "CAD"]]),
])
def test_desktop_and_browser_take_the_same_historical_rates(boc, codes, pairs):
    """The same Bank of Canada and ECB answers give the same provider and the same dated
    rates on both platforms (the fixture serves only the requested period here, as the
    real APIs do)."""
    import subprocess
    start, end = "2026-03-18", "2026-04-17"
    ecb_codes = sorted({c for c in codes if c not in ("EUR",)} | {"CAD"})
    case = {"responses": {"boc": {"status": boc[0], "body": boc[1]}, "ecb": {"status": 200, "body": ecb_csv(ecb_codes, start, end, future=False)}},
            "codes": codes, "start": start, "end": end, "pairs": pairs}
    run = subprocess.run(["node", str(_JS_RUNNER)], input=json.dumps({"tool": "fx-history", "cases": [case]}),
                         capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert run.returncode == 0, run.stderr
    web = json.loads(run.stdout)[0]
    assert "error" not in web, web
    assert web["provider"] == "European Central Bank"

    def http(url, headers):
        u = urlparse(url)
        if u.netloc == "www.bankofcanada.ca":
            return boc
        return 200, ecb_csv(ecb_codes, start, end, future=False)

    src = fx_source(http)
    target = pairs[0][1]
    # The desktop requests from 14 days before the window's start; pass the start that gives the browser's period.
    desktop_start = (pd.Timestamp(start) + pd.Timedelta(days=14)).strftime("%Y-%m-%d")
    assert src.prepare_fx([c for c in codes if c != target], target, desktop_start, end) == []
    assert src._fx["provider"] == web["provider"]
    for (frm, to), points in zip(pairs, web["pairs"]):
        rate = src.fetch_fx_rate(frm, to, desktop_start, end, "Daily")
        assert [str(d.date()) for d in rate.index] == [p["date"] for p in points], (frm, to)
        assert rate.tolist() == pytest.approx([p["rate"] for p in points], rel=1e-12), (frm, to)
