"""Web vs desktop parity for the shared market-data layer and the Rebalancer extras.

The browser modules (assets/js/...) run under Node; the desktop package
(_tools/shared_py/market_data, copied into the desktop tools) runs in-process. Both
read the same fixtures: verbatim Alpha Vantage notices, provider response bodies and
the curated instrument reference. Results must be identical, including message text.
"""
from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name("js_engines.mjs")
FIXTURES = ROOT / "_tools" / "tests" / "fixtures" / "providers"
sys.path.insert(0, str(ROOT / "_tools" / "shared_py"))
sys.path.insert(0, str(ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts"))
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")

from market_data import alphavantage as av  # noqa: E402
from market_data import catalog as cat  # noqa: E402
from market_data import gateway as gw  # noqa: E402
from market_data import sources as src  # noqa: E402
from market_data.errors import DataError  # noqa: E402
from market_data.freshness import freshness_of  # noqa: E402
from market_data.instruments import InstrumentResolver, load_reference  # noqa: E402
from market_data.service import MarketData, compare_quotes  # noqa: E402
from portfolio_rebalancer import core  # noqa: E402
from portfolio_rebalancer.sample import SAMPLE_PORTFOLIO, target_total_basis_points  # noqa: E402

REFERENCE = json.loads((ROOT / "assets" / "data" / "instruments.v1.json").read_text(encoding="utf-8"))
NOTICES = json.loads((FIXTURES / "alphavantage-notices.json").read_text(encoding="utf-8"))
RESPONSES = json.loads((FIXTURES / "quote-responses.json").read_text(encoding="utf-8"))
TICKERS = [r["ticker"] for r in SAMPLE_PORTFOLIO["rows"]] + [
    "RY.TO", "DLR-U.TO", "MSFT", "BRK.B", "TSX:RY", "^GSPC", "CADUSD=X", "CL=F", "AB.XYZ", "bad ticker!", "0700.HK",
    "TSCO.L", "YNVD.TO", "ynvd.to", "SHOP.V", "MC.PA", "BHP.AX", "RELIANCE.BO", "", "  vfv.to ",
]


def run_js(tool: str, cases: list) -> list:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"tool": tool, "cases": cases}), capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_shared_package_copies_are_current():
    result = subprocess.run([sys.executable, str(ROOT / "_tools" / "sync_shared_py.py"), "--check"], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert load_reference() == REFERENCE, "the desktop package ships the site's instrument reference"


def test_alpha_vantage_notices_classified_identically():
    js = run_js("market-data", [{"op": "notice", "text": n["text"]} for n in NOTICES["notices"]])
    for n, browser in zip(NOTICES["notices"], js):
        kind, scope = av.classify_notice(n["text"])
        assert {"kind": kind, "quotaScope": scope} == browser, n["name"]
        with pytest.raises(DataError) as e:
            av.parse_body(json.dumps({n["field"]: n["text"]}), "AAPL")
        assert e.value.kind == n["expect"]["kind"], n["name"]
        assert e.value.quota_scope == n["expect"]["quotaScope"], n["name"]
        if n["expect"].get("redacts"):
            assert n["expect"]["redacts"] not in e.value.message and n["expect"]["redacts"] not in (e.value.notice or "")


def test_burst_notice_containing_daily_wording_is_always_a_burst():
    for b in ["spreading out your free API requests", "1 request per second", "raise the per-second burst limit"]:
        for d in ["(25 requests per day)", "our standard API rate limit is 25 requests per day", "to instantly remove all daily rate limits"]:
            assert av.classify_notice(f"{b}. {d}.") == ("rate_limited", "burst")
            assert av.classify_notice(f"{d}. {b}.") == ("rate_limited", "burst")


def test_identity_resolution_identical():
    js = run_js("market-data", [{"op": "resolve", "ticker": t} for t in TICKERS])
    resolver = InstrumentResolver(REFERENCE)
    for ticker, browser in zip(TICKERS, js):
        desktop = resolver.resolve(ticker)
        assert desktop == browser, (ticker, desktop, browser)


def test_catalog_plans_identical():
    (js,) = run_js("market-data", [{"op": "catalog"}])
    assert js["version"] == cat.CATALOG_VERSION
    for pid, p in cat.PROVIDERS.items():
        mine = {"name": p["name"], "status": p["status"], "plans": [{"id": pl["id"], "label": pl["label"], "limits": pl["limits"], "editable": pl.get("editable")} for pl in p["plans"]], "gaps": p["gaps"]}
        assert mine == js["catalog"][pid], pid
    assert len(cat.PROVIDERS) == 5
    assert not hasattr(cat, "ROUTES") and not hasattr(cat, "route_instrument"), "no per-market table: the user's list decides"


def test_source_list_tables_gateway_symbols_and_errors_identical():
    (js,) = run_js("market-data", [{"op": "sources", "fn": "info", "args": {"tickers": TICKERS}}])
    assert js["info"] == src.SOURCE_INFO
    assert js["defaultOrder"] == src.DEFAULT_ORDER
    assert js["offered"] == {"browser": src.offered_sources("browser"), "desktop": src.offered_sources("desktop")}
    assert js["version"] == src.SOURCES_VERSION
    assert js["venues"] == gw.VENUES
    assert js["errors"] == gw.ERRORS, "gateway error codes mean the same on the web and the desktop"
    resolver = InstrumentResolver(REFERENCE)
    assert js["symbols"] == [gw.gateway_symbol(resolver.resolve(t)) for t in TICKERS]
    assert gw.gateway_symbol(resolver.resolve("YNVD.TO")) == "YNVD.NE"


def _priorities():
    base = src.normalize_priority(None, "desktop")
    yield {"order": base["order"], "enabled": base["enabled"]}
    yield {"order": ["finnhub", "alphavantage", "yahoo", "marketstack", "alpaca"], "enabled": {"finnhub": True, "alphavantage": True, "yahoo": True, "marketstack": False, "alpaca": True}}
    yield {"order": ["alphavantage", "marketstack", "finnhub", "alpaca", "yahoo"], "enabled": {p: True for p in src.DEFAULT_ORDER}}
    yield {"order": ["marketstack", "yahoo", "alpaca", "finnhub", "alphavantage"], "enabled": {"marketstack": True, "yahoo": False, "alpaca": False, "finnhub": True, "alphavantage": True}}


STATES = [
    {},
    {"yahoo": {"available": False, "code": "paused", "reason": "paused for about 12 more minutes after it asked this site to slow down", "short": "paused after a rate limit"}},
    {"alphavantage": {"available": False, "code": "rate_limited", "reason": "reported its daily limit at 14:02 UTC", "short": "daily limit reached"},
     "finnhub": {"available": False, "code": "auth", "reason": "rejected your key earlier (check the key)", "short": "rejected the key"}},
    {"yahoo": {"available": False, "code": "not_configured", "reason": "not available on this site yet"}, "marketstack": {"available": False, "code": "no_key", "reason": "no API key saved", "short": "no key"}},
]


def test_source_plans_identical_for_every_ticker_order_state_operation_and_platform():
    resolver = InstrumentResolver(REFERENCE)
    plans = {pid: cat.plan_of(pid) for pid in cat.PROVIDER_IDS}
    cases = [{"op": "sources", "fn": "plan", "args": {"ticker": t, "op": op, "priority": pr, "platform": platform, "state": st}}
             for t in TICKERS for pr in _priorities() for st in STATES for op in ("quote", "history") for platform in ("browser", "desktop")]
    for c, browser in zip(cases, run_js("market-data", cases)):
        a = c["args"]
        desktop = src.plan_sources(resolver.resolve(a["ticker"]), a["op"], a["priority"], a["platform"], a["state"], plans)
        assert desktop == browser, c
    # The behaviour the requirements name, checked on the shared result.
    aapl = src.plan_sources(resolver.resolve("AAPL"), "history", {"order": ["finnhub", "yahoo"], "enabled": {"finnhub": True, "yahoo": True}}, "desktop")
    assert [c["id"] for c in aapl["candidates"]] == ["yahoo"] and aapl["skipped"][0]["code"] == "no_capability", "a quote-only source is never asked for history"


def test_source_list_changes_identical():
    configured_sets = [[], ["alphavantage"], ["finnhub", "marketstack"], ["alpaca", "alphavantage", "finnhub", "marketstack"]]
    saved = [None, {"order": ["finnhub", "massive", "finnhub", "nope", "yahoo"], "enabled": {"finnhub": True, "yahoo": False}},
             {"order": ["alpaca", "yahoo"], "enabled": {"yahoo": False, "alpaca": True}}, {"order": "bad", "enabled": []}, {"order": [], "enabled": {"yahoo": False}}]
    legacy = [None, {"routing": "auto"}, {"routing": "auto", "fallback": True}, {"routing": "alphavantage", "fallback": False}, {"routing": "alphavantage", "fallback": True},
              {"routing": "keyless", "fallback": True}, {"routing": "massive"}, {"routing": "finnhub"}]
    cases, expected = [], []
    for platform in ("browser", "desktop"):
        for conf in configured_sets:
            for sv in saved:
                cases.append({"op": "sources", "fn": "normalize", "args": {"saved": sv, "platform": platform, "configured": conf}})
                expected.append(src.normalize_priority(sv, platform, conf))
            for lg in legacy:
                cases.append({"op": "sources", "fn": "migrate", "args": {"prefs": lg, "platform": platform, "configured": conf}})
                expected.append(src.migrate_legacy(lg, platform, conf))
            for pr in _priorities():
                for pid in src.DEFAULT_ORDER + ["massive"]:
                    for to in (-3, 0, 2, 99):
                        cases.append({"op": "sources", "fn": "move", "args": {"priority": pr, "id": pid, "to": to}})
                        expected.append(src.move_source(pr, pid, to))
                    for on in (True, False):
                        cases.append({"op": "sources", "fn": "enable", "args": {"priority": pr, "id": pid, "on": on, "configured": conf}})
                        expected.append(src.set_source_enabled(pr, pid, on, conf))
                    for has_key, is_new in ((True, True), (True, False), (False, False)):
                        cases.append({"op": "sources", "fn": "key", "args": {"priority": pr, "id": pid, "hasKey": has_key, "isNew": is_new, "configured": conf}})
                        expected.append(src.key_changed(pr, pid, has_key, is_new, conf))
    attempts = [{"kind": k, "quotaScope": q, "paused": pz} for k in ("auth", "rate_limited", "not_found", "not_covered", "ambiguous", "currency_mismatch", "invalid", "timeout", "network", "unavailable", "entitlement", "not_configured", "weird")
                for q in (None, "daily", "monthly", "minute") for pz in (False, True)]
    for a in attempts:
        cases.append({"op": "sources", "fn": "short", "args": a})
        expected.append(src.short_failure(a))
    skipped = [{"id": "yahoo", "code": "paused", "reason": "paused for about 3 more minutes", "short": "paused after a rate limit"}, {"id": "finnhub", "code": "off", "reason": "switched off in your source list"},
               {"id": "alphavantage", "code": "not_covered", "reason": "does not cover Cboe Canada on the free plan"}]
    for include_off in (False, True):
        for short in (False, True):
            cases.append({"op": "sources", "fn": "describe", "args": {"skipped": skipped, "includeOff": include_off, "short": short}})
            expected.append(src.describe_skipped(skipped, include_off, short))
    for c, mine, browser in zip(cases, expected, run_js("market-data", cases)):
        assert mine == browser, c


def test_desktop_gateway_address_is_the_site_setting():
    text = (ROOT / "_data" / "market_data.yml").read_text(encoding="utf-8")
    import re
    m = re.search(r'^gateway:\s*"([^"]*)"', text, re.M)
    assert m is not None
    assert gw.DEFAULT_GATEWAY_URL == m.group(1), "the desktop apps use the same gateway as the website"
    assert gw.validate_base_url(gw.DEFAULT_GATEWAY_URL) == gw.DEFAULT_GATEWAY_URL


def test_paid_plan_profiles_identical():
    cases = [{"op": "plan", "id": "alphavantage", "planId": "premium", "overrides": {"limit": 150}},
             {"op": "plan", "id": "marketstack", "planId": "basic"}, {"op": "plan", "id": "marketstack", "planId": "custom", "overrides": {"limit": 50000}},
             {"op": "plan", "id": "finnhub", "planId": "paid", "overrides": {"limit": 300, "international": True}},
             {"op": "plan", "id": "alpaca", "planId": "algo-plus"}, {"op": "plan", "id": "finnhub", "planId": "nonexistent"}]
    for c, browser in zip(cases, run_js("market-data", cases)):
        assert cat.plan_of(c["id"], c["planId"], c.get("overrides")) == browser, c


def _fake_http(case):
    def http(url, headers):
        return case["status"], case["body"]
    return http


@pytest.mark.parametrize("case", RESPONSES["cases"], ids=lambda c: c["name"])
def test_provider_fixtures_give_the_same_quote_or_error(case):
    resolver = InstrumentResolver(REFERENCE)
    identity = resolver.resolve(case["ticker"])
    if case["provider"] == "massive":  # deferred: adapter level only (as in the JS tests)
        from market_data.adapters import ADAPTERS
        a = ADAPTERS["massive"]
        if case["expect"].get("kind"):
            with pytest.raises(DataError) as e:
                if case["status"] != 200:
                    raise a.classify(case["status"], case["body"])
                a.parse(case["body"], case["symbol"], identity)
            assert e.value.kind == case["expect"]["kind"]
        else:
            raw = a.parse(case["body"], case["symbol"], identity)
            assert raw["rawPrice"] == case["expect"]["price"] and raw["tradingDate"] == case["expect"]["tradingDate"]
        return
    md = MarketData(None, http=_fake_http(case), reference=REFERENCE, sleep=lambda s: None, pacing_override_ms=0, now=lambda: 1793714400.0)
    keys = {"marketstack": "MSKEY1234567890ABCDEF", "finnhub": "FHKEY1234567890ABCDEF"}
    md.set_key(case["provider"], keys[case["provider"]])
    if case["expect"].get("kind"):
        with pytest.raises(DataError) as e:
            md.price_with(case["provider"], identity)
        assert e.value.kind == case["expect"]["kind"]
        if case["expect"].get("quotaScope"):
            assert e.value.quota_scope == case["expect"]["quotaScope"]
        if case["expect"].get("persist"):
            assert md.budget(case["provider"])["limitRecord"]["scope"] == case["expect"]["quotaScope"]
            sent = md.budget(case["provider"])["sentToday"]
            with pytest.raises(DataError) as again:
                md.price_with(case["provider"], resolver.resolve("VST"))
            assert again.value.quota_scope == case["expect"]["quotaScope"] and md.budget(case["provider"])["sentToday"] == sent
    else:
        q = md.price_with(case["provider"], identity)
        assert q["schema"] == "md.quote.v1"
        assert math.isclose(q["nativePriceMajorUnits"], case["expect"]["price"], rel_tol=1e-12)
        assert q["nativeCurrency"] == case["expect"]["currency"]
        assert q["tradingDate"] == case["expect"]["tradingDate"]
        if case["expect"].get("currencyEvidence"):
            assert q["currencyEvidence"] == case["expect"]["currencyEvidence"]
        assert q["currencyVerified"] is True
        assert not any(k in json.dumps(q) for k in keys.values())


def test_alpha_vantage_service_burst_retry_and_daily_record():
    notices = {n["name"]: n["text"] for n in NOTICES["notices"]}
    answers = iter([json.dumps({"Information": notices["burst-2026"]}), json.dumps({"Global Quote": {"05. price": "60.84", "07. latest trading day": "2026-11-02"}}),
                    json.dumps({"Information": notices["daily"]})])
    waits = []
    md = MarketData(None, http=lambda url, headers: (200, next(answers)), reference=REFERENCE, sleep=waits.append, pacing_override_ms=0)
    md.set_key("alphavantage", "AVKEY1234567")
    q = md.price_with("alphavantage", md.resolve("VEQT.TO"))
    assert q["nativePriceMajorUnits"] == 60.84 and q["providerSymbol"] == "VEQT.TRT" and q["currencyEvidence"] == "curated_reference"
    assert waits == [2.0] and md.budget("alphavantage")["limitRecord"] is None
    with pytest.raises(DataError) as e:
        md.price_with("alphavantage", md.resolve("CNQ.TO"))
    assert e.value.quota_scope == "daily" and md.budget("alphavantage")["limitRecord"]["scope"] == "daily"
    with pytest.raises(DataError) as local:
        md.price_with("alphavantage", md.resolve("XQQ.TO"))
    assert "Check again" in local.value.message and md.budget("alphavantage")["sentToday"] == 3
    with pytest.raises(DataError) as ynvd:
        md.price_instrument(md.resolve("YNVD.TO"))
    assert ynvd.value.kind == "not_covered" and "Cboe Canada" in ynvd.value.message


def test_keys_remembered_only_when_asked_and_removed_completely(tmp_path):
    md = MarketData(tmp_path, http=lambda url, headers: (500, ""), reference=REFERENCE)
    md.set_key("finnhub", "FHKEY1234567890ABCDEF")
    assert not (tmp_path / "keys.json").exists(), "session-only by default"
    md.set_key("alpaca", "ALPACAKEYID000000001", secret="SECRETSECRETSECRETSECRET", remember=True)
    saved = json.loads((tmp_path / "keys.json").read_text())
    assert set(saved) == {"alpaca"} and saved["alpaca"]["secret"]
    reopened = MarketData(tmp_path, http=lambda url, headers: (500, ""), reference=REFERENCE)
    assert reopened.configured() == ["alpaca"]
    with pytest.raises(ValueError):
        md.set_key("massive", "MASSIVEKEY0000000000")
    md.forget_all_keys()
    assert not (tmp_path / "keys.json").exists()


def test_compare_quotes_and_freshness_identical():
    base = {"canonicalId": "XNAS:AAPL", "nativeCurrency": "USD", "priceType": "eod_close", "tradingDate": "2026-11-02", "nativePriceMajorUnits": 100.0}
    variants = [{}, {"nativePriceMajorUnits": 100.05}, {"nativePriceMajorUnits": 100.6}, {"nativePriceMajorUnits": 1.0}, {"nativePriceMajorUnits": 150.0},
                {"tradingDate": "2026-10-30"}, {"priceType": "last_trade"}, {"canonicalId": "XTSE:AAPL"}, {"nativeCurrency": "CAD"}, {"priceType": "latest_trading_day"}]
    cases = [{"op": "compare", "a": base, "b": {**base, **v}} for v in variants]
    for c, browser in zip(cases, run_js("market-data", cases)):
        desktop = compare_quotes(c["a"], c["b"])
        browser = {k: browser[k] for k in desktop}
        d_pct, b_pct = desktop.pop("diffPct"), browser.pop("diffPct")
        assert (d_pct is None and b_pct is None) or d_pct == pytest.approx(b_pct, rel=1e-12), c
        assert desktop == browser, c
    now = 1793718000.0  # 2026-11-03 15:00 UTC (Tuesday)
    fcases = [{"op": "freshness", "date": d, "now": now * 1000, "tz": tz} for d in ["2026-11-03", "2026-11-02", "2026-10-30", "2026-10-29", "2026-10-26", None, "bad"]
              for tz in ["America/Toronto", "Asia/Tokyo", "Europe/London"]]
    for c, browser in zip(fcases, run_js("market-data", fcases)):
        state, missed = freshness_of(c["date"], now, c["tz"])
        assert {"freshness": state, "missed": missed} == browser, c


def test_sample_portfolio_identical():
    (js,) = run_js("market-data", [{"op": "sample"}])
    assert js == SAMPLE_PORTFOLIO
    rows = SAMPLE_PORTFOLIO["rows"]
    assert [(r["ticker"], r["shares"], r["targetWeight"]) for r in rows] == [
        ("VEQT.TO", 305, 63), ("CNQ.TO", 48, 9), ("XQQ.TO", 27, 6.3), ("HEWB.TO", 14, 4.5), ("AAPL", 2, 1.8), ("VFV.TO", 8, 0.9),
        ("SPCX", 1, 0.9), ("CBRS", 4, 0.9), ("YNVD.NE", 4, 1.8), ("VST", 1, 0.9),
        ("7203.T", 1, 2.5), ("SAP.DE", 1, 2.5), ("VOD.L", 1, 2.5), ("600519.SS", 1, 2.5)]
    assert target_total_basis_points(rows) == 10000, "targets total exactly 100.0%"
    assert target_total_basis_points(rows[:10]) == 9000, "the ten Questrade targets scaled to 90%"
    assert all(r["accountType"] == "" for r in rows)
    assert not any("price" in r or "group" in r for r in rows), "no prices and no separate group"
    assert all(set(r) == {"ticker", "shares", "targetWeight", "accountType"} for r in rows), "ordinary rows: no tag or marker"
    assert SAMPLE_PORTFOLIO["schema"] == "rb.sample-portfolio.v3"
    assert SAMPLE_PORTFOLIO["reportingCurrency"] == "CAD" and SAMPLE_PORTFOLIO["mode"] == "new_money" and SAMPLE_PORTFOLIO["budget"] == 3000


# Identical reference prices (major units; VOD.L 7215 pence = 72.15 GBP) and FX for the
# 14-row sample: the browser and desktop engines must give the same plan.
SAMPLE_REFERENCE_PRICES = {"VEQT.TO": (60.84, "CAD"), "CNQ.TO": (75.12, "CAD"), "XQQ.TO": (68.0, "CAD"), "HEWB.TO": (74.04, "CAD"),
                           "AAPL": (338.32, "USD"), "VFV.TO": (187.16, "CAD"), "SPCX": (136.37, "USD"), "CBRS": (96.36, "USD"),
                           "YNVD.NE": (44.21, "CAD"), "VST": (134.61, "USD"), "7203.T": (2850.0, "JPY"), "SAP.DE": (220.0, "EUR"),
                           "VOD.L": (7215 * 0.01, "GBP"), "600519.SS": (1500.0, "CNY")}
SAMPLE_CAD_PER = {"CAD": 1.0, "USD": 1.3978, "EUR": 1.6, "GBP": 1.85, "JPY": 0.0091, "CNY": 0.2102}


@pytest.mark.parametrize("mode", ["new_money", "rebalance"])
def test_sample_plan_identical_with_reference_prices(mode):
    positions = [{"rowIndex": i, "ticker": r["ticker"], "shares": r["shares"], "price": SAMPLE_REFERENCE_PRICES[r["ticker"]][0],
                  "currencyKey": SAMPLE_REFERENCE_PRICES[r["ticker"]][1], "targetWeight": r["targetWeight"], "accountType": ""}
                 for i, r in enumerate(SAMPLE_PORTFOLIO["rows"])]
    case = {"op": "whole", "positions": positions, "fxToUsd": SAMPLE_CAD_PER, "reportingKey": "CAD", "mode": mode, "budget": SAMPLE_PORTFOLIO["budget"]}
    (browser,) = run_js("rebalancer-extras", [case])
    summary, results, warnings, _ = _desktop_plan(case)
    assert len(results) == len(browser["plan"]["results"]) == 14, "all fourteen holdings are in the plan"
    assert browser["plan"]["warnings"] == warnings
    for d, b in zip(results, browser["plan"]["results"]):
        assert d["ticker"] == b["ticker"] and d["action"] == b["action"]
        for key in ("currentValue", "targetWeightNorm", "targetValue", "tradeValue", "tradeValueLocal", "tradeShares"):
            assert math.isclose(d[key], b[key], rel_tol=1e-12, abs_tol=1e-9), (d["ticker"], key)
    by = {r["ticker"]: r for r in results}
    assert math.isclose(by["VOD.L"]["currentValue"], 72.15 * 1.85, rel_tol=1e-12), "pence converted to pounds, then GBP to CAD"
    assert math.isclose(by["7203.T"]["currentValue"], 2850 * 0.0091, rel_tol=1e-12)
    assert all(math.isclose(by[t]["targetWeightNorm"], 0.025, rel_tol=1e-12) for t in ("7203.T", "SAP.DE", "VOD.L", "600519.SS"))
    assert math.isclose(sum(r["targetWeightNorm"] for r in results), 1.0, rel_tol=1e-12)
    whole = core.apply_whole_shares(summary, results)
    assert [r["wholeShares"] for r in browser["whole"]["results"]] == [r["wholeShares"] for r in whole["results"]]
    if mode == "new_money":
        assert summary["totalSells"] == 0 and summary["totalBuys"] <= 3000 + 1e-9


# ---------------------------------------------------------------- Rebalancer extras
PROBES = ["", " ", "nan", "NaN", "inf", "Infinity", "-inf", "1e999", "1,5", "abc", "0x10", "0", "5", " 2.5 ", ".5", "1e3", "-0", "12.", "+3", 7, 2.5, None]


def test_number_parsing_identical():
    (js,) = run_js("rebalancer-extras", [{"op": "parse", "values": PROBES}])
    for value, browser in zip(PROBES, js):
        assert core.parse_number(value) == browser, repr(value)


def _scenarios(count=80):
    rng = random.Random(2026)
    fx = {"USD": 1.0, "CAD": 0.73, "EUR": 1.09, "GBP": 1.28, "JPY": 0.0068}
    for i in range(count):
        n = rng.randint(1, 10)
        positions = [{"rowIndex": j, "ticker": f"T{j}", "shares": rng.choice([0, 1, 3, 12.5, 40, 305]), "price": round(rng.uniform(1, 400), 4),
                      "currencyKey": rng.choice(list(fx)), "targetWeight": rng.choice([0, 1, 2, 5, 7, 10, 70]),
                      "accountType": rng.choice(["", "TFSA", "RRSP"]) if i % 4 == 0 else ""} for j in range(n)]
        if not any(p["targetWeight"] for p in positions):
            positions[0]["targetWeight"] = 10
        yield {"positions": positions, "fxToUsd": fx, "reportingKey": rng.choice(list(fx)), "mode": rng.choice(["new_money", "rebalance"]), "budget": rng.choice([500, 3000, 25000])}


def _desktop_plan(c):
    rate = lambda k: c["fxToUsd"][k] / c["fxToUsd"][c["reportingKey"]]  # noqa: E731
    positions = [{**p, "currencyLabel": p["currencyKey"], "fxToReporting": rate(p["currencyKey"]), "currentValue": p["shares"] * p["price"] * rate(p["currencyKey"])} for p in c["positions"]]
    summary, results, warnings = core.calculate_rebalance_plan(positions, c["mode"], c["budget"])
    return summary, results, warnings, positions


def test_warning_text_and_whole_shares_identical():
    cases = [{"op": "whole", **c} for c in _scenarios()]
    checked = 0
    for c, browser in zip(cases, run_js("rebalancer-extras", cases)):
        try:
            summary, results, warnings, positions = _desktop_plan(c)
        except ValueError as error:
            assert browser.get("error") == str(error)
            continue
        assert browser["plan"]["warnings"] == warnings, "warning text, not just the count"
        assert math.isclose(browser["plan"]["summary"]["cashLeft"], summary["cashLeft"], abs_tol=1e-9)
        whole = core.apply_whole_shares(summary, results)
        assert math.isclose(browser["whole"]["totalBuys"], whole["totalBuys"], rel_tol=1e-12, abs_tol=1e-9)
        assert math.isclose(browser["whole"]["cashLeft"], whole["cashLeft"], rel_tol=1e-12, abs_tol=1e-9)
        assert [r["wholeShares"] for r in browser["whole"]["results"]] == [r["wholeShares"] for r in whole["results"]]
        if c["mode"] == "new_money":
            assert whole["totalBuys"] <= c["budget"] + 1e-9
        else:
            assert whole["totalBuys"] <= whole["totalSells"] + 1e-9
        assert all(float(r["wholeShares"]).is_integer() for r in whole["results"])
        checked += 1
        (js_w,) = run_js("rebalancer-extras", [{"op": "weights", "positions": c["positions"]}]) if checked <= 5 else [None]
        if js_w is not None:
            assert js_w == core.weight_warnings(c["positions"])
    assert checked >= 50


def test_rb01_zero_proceeds_identical():
    rows = [{"rowIndex": i, "ticker": t, "shares": 100, "price": p, "currencyKey": "USD", "targetWeight": 1, "accountType": ""} for i, (t, p) in enumerate([("A", 100.02), ("B", 100.02), ("C", 99.96)])]
    case = {"op": "whole", "positions": rows, "fxToUsd": {"USD": 1.0}, "reportingKey": "USD", "mode": "rebalance", "budget": 0}
    (browser,) = run_js("rebalancer-extras", [case])
    summary, results, warnings, _ = _desktop_plan(case)
    assert [r["action"] for r in results] == ["Hold", "Hold", "Hold"] == [r["action"] for r in browser["plan"]["results"]]
    assert warnings == browser["plan"]["warnings"] and "cannot be funded" in warnings[0]


def test_valuation_gate_identical():
    def row(t, shares, target, price, **kw):
        return {"rowId": t, "ticker": t, "shares": shares, "targetWeight": target, "price": price, "currency": "CAD" if price else None,
                "fxAvailable": True, "source": {"kind": "provider", "currencyVerified": True, "freshness": "current"} if price else {}, **kw}
    sets = [
        [row(r["ticker"], r["shares"], r["targetWeight"], None) for r in SAMPLE_PORTFOLIO["rows"]],
        [row(r["ticker"], r["shares"], r["targetWeight"], 10) for r in SAMPLE_PORTFOLIO["rows"]],
        [row(r["ticker"], r["shares"], r["targetWeight"], None if r["ticker"] == "600519.SS" else 10) for r in SAMPLE_PORTFOLIO["rows"]],
        [row("A", 1, 1, 10, source={"kind": "provider", "currencyVerified": False, "freshness": "current"})],
        [row("A", 1, 1, 10, source={"kind": "provider", "currencyVerified": True, "freshness": "stale", "tradingDate": "2026-10-29"})],
        [row("A", 1, 1, 10, source={"kind": "manual", "freshness": "current"}), row("B", "", 1, 10)],
        [row("A", 1, 1, 10, fxAvailable=False)],
        [row("A", 0, 0, None)],
    ]
    cases = [{"op": "valuation", "rows": rows, "acceptStale": accept} for rows in sets for accept in (False, True)]
    for c, browser in zip(cases, run_js("rebalancer-extras", cases)):
        assert core.assess_valuation(c["rows"], c["acceptStale"]) == browser, c
