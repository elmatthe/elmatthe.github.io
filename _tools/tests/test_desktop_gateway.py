"""The desktop market-data layer against the REAL gateway Worker code.

gateway_server.mjs serves _services/market-data-gateway on 127.0.0.1 with the synthetic
Yahoo fixtures as its upstream (nothing leaves this computer). The desktop package
(_tools/shared_py/market_data) talks to it over HTTP exactly as the desktop apps do,
without an Origin header. Personal-key providers are answered by small fakes.

Covers: zero keys (Yahoo Finance first and on), the 14-holding sample with exact
listings, currencies and GBp -> GBP, privacy of requests, history with both bases, the
order of sources and sequential fallback, exhausted and rejected keys, rate limits and
the persisted pause, the gateway's circuit breaker, a switched-off source, persistence
of the order across restarts, and no key ever reaching the gateway.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib import request as urlrequest

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts"))
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")

from market_data import history as hist  # noqa: E402
from market_data.errors import DataError  # noqa: E402
from market_data.service import MarketData, default_http  # noqa: E402
from portfolio_rebalancer.sample import SAMPLE_PORTFOLIO  # noqa: E402

REFERENCE = json.loads((ROOT / "assets" / "data" / "instruments.v1.json").read_text(encoding="utf-8"))
AV_KEY = "AVKEY1234567"
FH_KEY = "FHKEY1234567890ABCD"
AV_LIMIT = {"Information": f"We have detected your API key as {AV_KEY} and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits."}


@pytest.fixture(scope="module")
def server():
    proc = subprocess.Popen(["node", str(Path(__file__).with_name("gateway_server.mjs"))], stdout=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    assert line.startswith("PORT "), line
    base = f"http://127.0.0.1:{int(line.split()[1])}"
    yield base
    proc.terminate()
    proc.wait(timeout=10)


def control(base: str, **flags) -> None:
    query = "&".join(f"{k}={v}" for k, v in flags.items())
    urlrequest.urlopen(f"{base}/__mode?{query}", timeout=5).read()  # noqa: S310 - loopback test server


def upstream_calls(base: str) -> int:
    return json.loads(urlrequest.urlopen(f"{base}/__calls", timeout=5).read())  # noqa: S310


class World:
    """MarketData with the real gateway, fake personal-key providers and a request log."""

    def __init__(self, base: str, runtime: Path, av: str = "ok", fh: str = "ok") -> None:
        self.log: list[tuple[str, dict]] = []
        self.av, self.fh = av, fh

        def http(url: str, headers: dict) -> tuple[int, str]:
            self.log.append((url, dict(headers)))
            if url.startswith(base):
                return default_http(url, headers, timeout=5)
            if "alphavantage.co" in url:
                if self.av == "limit":
                    return 200, json.dumps(AV_LIMIT)
                symbol = url.split("symbol=")[1].split("&")[0] if "symbol=" in url else "X"
                return 200, json.dumps({"Global Quote": {"01. symbol": symbol, "05. price": "45.10", "07. latest trading day": "2026-11-02"}})
            if "finnhub.io" in url:
                if self.fh == "reject":
                    return 401, json.dumps({"error": "Invalid API key."})
                return 200, json.dumps({"c": 230.5, "d": 1, "dp": 0.4, "h": 231, "l": 229, "o": 230, "pc": 229.5, "t": 1762200000})
            raise AssertionError(f"unexpected host: {url}")
        self.md = MarketData(runtime, http=http, reference=REFERENCE, gateway_url=base, pacing_override_ms=0, sleep=lambda s: None)
        self.md.gateway.check()

    def gateway_urls(self, base: str) -> list[str]:
        return [u for u, _ in self.log if u.startswith(base) and "/v1/health" not in u]


def test_zero_keys_yahoo_first_prices_all_fourteen_with_exact_listing_currency_and_unit(server, tmp_path):
    control(server, reset=1)
    w = World(server, tmp_path)
    assert [(s["position"], s["id"], s["status"]) for s in w.md.sources_list()][:2] == [(1, "yahoo", "on"), (2, "alphavantage", "needs_key")]
    quotes = {r["ticker"]: w.md.price_instrument(w.md.resolve(r["ticker"])) for r in SAMPLE_PORTFOLIO["rows"]}
    for ticker, q in quotes.items():
        identity = w.md.resolve(ticker)
        assert q["providerId"] == "yahoo" and q["provider"] == "Yahoo Finance" and q["sourceTier"] == "free", ticker
        assert q["canonicalId"] == identity["canonicalId"] and q["nativeCurrency"] == identity["currency"], ticker
        assert q["priceType"] == "regular_market_price" and q["adjusted"] is False and q["nativePriceMajorUnits"] > 0
        assert any("delayed" in n for n in q["notes"]), "the delay note travels with the quote"
    vod = quotes["VOD.L"]
    assert vod["rawCurrency"] == "GBp" and vod["quoteUnit"] == "minor" and abs(vod["nativePriceMajorUnits"] - vod["rawPrice"] / 100) < 1e-12
    assert quotes["YNVD.NE"]["providerSymbol"] == "YNVD.NE" and quotes["YNVD.NE"]["nativeCurrency"] == "CAD"
    assert {q["nativeCurrency"] for q in quotes.values()} == {"CAD", "USD", "JPY", "EUR", "GBP", "CNY"}
    sent = w.gateway_urls(server)
    assert len(sent) == 14
    assert all(u.split("?")[1].startswith("symbol=") and "&" not in u.split("?")[1] for u in sent), "only the symbol is sent"
    assert all("Origin" not in h for u, h in w.log if u.startswith(server)), "the desktop sends no Origin header"
    again = w.md.price_instrument(w.md.resolve("SAP.DE"))
    assert again["cacheStatus"] == "cached" and len(w.gateway_urls(server)) == 14, "a saved copy costs no request"


def test_history_both_bases_daily_and_nothing_invented(server, tmp_path):
    control(server, reset=1)
    w = World(server, tmp_path)
    h = hist.history_by_sources(w.md, w.md.resolve("VOD.L"), "2025-11-01", "2026-11-01")
    assert h["sourceId"] == "yahoo" and h["frequency"] == "daily" and h["currency"] == "GBP" and h["hasAdjusted"] is True
    assert all(c is None or c < 3 for _, c, _ in h["observations"]), "pence converted to pounds"
    assert any(c is not None and a is not None and c != a for _, c, a in h["observations"]), "close and adjusted close kept apart"
    plain = hist.history_by_sources(w.md, w.md.resolve("NOADJ"), "2026-10-01", "2026-11-01")
    assert plain["hasAdjusted"] is False and all(a is None for _, _, a in plain["observations"])
    assert [u for u in w.gateway_urls(server) if "/v1/history" in u][0].split("?")[1] == "symbol=VOD.L&range=2y&interval=1d"


def test_order_and_sequential_fallback_exhausted_and_rejected_keys(server, tmp_path):
    control(server, reset=1, downFor="AAPL")
    w = World(server, tmp_path, av="limit", fh="ok")
    w.md.set_key("alphavantage", AV_KEY)
    w.md.set_key("finnhub", FH_KEY)
    notes = w.md.take_notes()
    assert "Alpha Vantage is switched on at position 2 of 5, after Yahoo Finance" in notes[0], notes
    # Two consecutive failures (Yahoo Finance unavailable, Alpha Vantage's daily limit), the third source answers.
    q = w.md.price_instrument(w.md.resolve("AAPL"), use_cache=False)
    assert q["providerId"] == "finnhub"
    assert [(a["providerId"], a["kind"]) for a in q["fallbackFrom"]] == [("yahoo", "unavailable"), ("alphavantage", "rate_limited")]
    assert q["fallbackFrom"][1]["quotaScope"] == "daily"
    # The exhausted provider is skipped afterwards, never asked again.
    av_before = sum(1 for u, _ in w.log if "alphavantage" in u)
    plan = w.md.route(w.md.resolve("MSFT"), "quote")
    assert [c["id"] for c in plan["candidates"]] == ["yahoo", "finnhub"] and any(x["id"] == "alphavantage" and x["code"] == "rate_limited" for x in plan["skipped"])
    w.md.price_instrument(w.md.resolve("MSFT"), use_cache=False)
    assert sum(1 for u, _ in w.log if "alphavantage" in u) == av_before
    # Complete failure: nothing is invented, every source's reason is given.
    w.fh = "reject"
    with pytest.raises(DataError) as e:
        w.md.price_instrument(w.md.resolve("AAPL"), use_cache=False)
    assert e.value.kind == "auth" and "Yahoo Finance: unavailable" in e.value.message and "Finnhub: rejected the key" in e.value.message
    assert "Alpha Vantage: daily limit reached" in e.value.message
    assert w.md.source_state("finnhub")["code"] == "auth", "a rejected key is not retried"
    # No key ever reaches the gateway.
    assert not any(AV_KEY in u or FH_KEY in u or AV_KEY in json.dumps(h) for u, h in w.log if u.startswith(server))


def test_order_persists_across_restarts_and_key_removal_explains_itself(server, tmp_path):
    control(server, reset=1)
    w = World(server, tmp_path)
    w.md.set_key("alphavantage", AV_KEY, remember=True)
    r = w.md.move_source("yahoo", 9)
    assert r["message"] == "Yahoo Finance moved to position 5 of 5."
    w2 = World(server, tmp_path)
    assert w2.md.priority["order"] == ["alphavantage", "marketstack", "finnhub", "alpaca", "yahoo"], "the order survives a restart"
    assert w2.md.sources_list()[0]["status"] == "on"
    w2.md.set_source_enabled("yahoo", False)
    w2.md.set_key("alphavantage", "")
    note = " ".join(w2.md.take_notes())
    assert "Alpha Vantage is switched off because its key was removed; it keeps position 1" in note
    assert "Yahoo Finance was switched back on because no other source in your list can be used" in note
    assert json.loads((tmp_path / "market-data-settings.json").read_text())["sources"]["enabled"]["yahoo"] is True


def test_rate_limit_pauses_and_the_pause_survives_a_restart(server, tmp_path):
    control(server, reset=1, limited=1)
    w = World(server, tmp_path)
    with pytest.raises(DataError) as e:
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert e.value.kind == "rate_limited" and "Yahoo Finance: rate-limited" in e.value.message
    assert (tmp_path / "yahoo-pause.json").exists() and w.md.gateway.pause_state()["minutesLeft"] >= 15
    sent = len(w.gateway_urls(server))
    for t in ("MSFT", "SPY"):
        with pytest.raises(DataError) as paused:
            w.md.price_instrument(w.md.resolve(t))
        assert "Yahoo Finance: paused after a rate limit" in paused.value.message
    assert len(w.gateway_urls(server)) == sent, "nothing is sent while paused"
    control(server, limited=0)
    restarted = World(server, tmp_path)
    assert restarted.md.gateway.pause_state()["paused"] is True and restarted.md.has_price_source() is False
    with pytest.raises(DataError):
        restarted.md.price_instrument(restarted.md.resolve("AAPL"))
    assert restarted.gateway_urls(server) == []


def test_breaker_after_three_outages_and_a_single_outage_does_not_pause(server, tmp_path):
    control(server, reset=1, downFor="AAPL")
    w = World(server, tmp_path / "a")
    with pytest.raises(DataError):
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert w.md.gateway.pause_state()["paused"] is False
    assert w.md.price_instrument(w.md.resolve("MSFT"))["providerId"] == "yahoo"
    control(server, reset=1, down=1)
    d = World(server, tmp_path / "b")
    for t in ("AAPL", "MSFT", "SPY"):
        with pytest.raises(DataError):
            d.md.price_instrument(d.md.resolve(t))
    assert d.md.gateway.pause_state()["kind"] == "unavailable"
    with pytest.raises(DataError) as e:
        d.md.price_instrument(d.md.resolve("VST"))
    assert "Yahoo Finance: paused after an outage" in e.value.message
    assert upstream_calls(server) == 3, "nothing more reaches the data source"


def test_switched_off_and_not_configured(server, tmp_path):
    control(server, reset=1, off=1)
    w = World(server, tmp_path)
    assert w.md.gateway.status["state"] == "disabled"
    with pytest.raises(DataError) as e:
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert e.value.kind == "not_configured" and "Yahoo Finance: switched off on this site at the moment" in e.value.message
    assert w.gateway_urls(server) == []
    none = MarketData(tmp_path / "none", http=lambda url, h: (_ for _ in ()).throw(AssertionError(url)), reference=REFERENCE, gateway_url="")
    assert none.gateway.check()["state"] == "not_configured" and none.sources_list()[0]["state"]["reason"] == "not available on this site yet"
    control(server, reset=1)


def test_desktop_history_frequency_rule(server, tmp_path):
    control(server, reset=1)
    w = World(server, tmp_path)
    w.md.set_key("alphavantage", AV_KEY)
    w.md.move_source("alphavantage", 0)
    identity = w.md.resolve("AAPL")
    # A one-year window: Alpha Vantage would give weekly prices, so a Daily analysis skips it.
    plan = w.md.route(identity, "history", require=lambda pid: "weekly" if pid == "alphavantage" else None)
    assert [c["id"] for c in plan["candidates"]] == ["yahoo"]
    h = hist.history_by_sources(w.md, identity, "2025-11-01", "2026-11-01", analysis_frequency="Daily")
    assert h["sourceId"] == "yahoo" and any(x["id"] == "alphavantage" and x["code"] == "incompatible" for x in h["skipped"])
    assert "would give weekly prices for this period, and this comparison uses daily prices" in next(x["reason"] for x in h["skipped"] if x["id"] == "alphavantage")


# ---------------- B3: the desktop waits as long as the data source said ----------------
def test_source_retry_after_is_honoured_for_the_hour_and_survives_a_restart(server, tmp_path):
    control(server, reset=1, limited=1, retryAfter=3600)
    w = World(server, tmp_path)
    with pytest.raises(DataError):
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert w.md.gateway.pause_state()["minutesLeft"] == 60
    calls = upstream_calls(server)
    sent = len(w.gateway_urls(server))
    control(server, limited=0)
    with pytest.raises(DataError) as paused:
        w.md.price_instrument(w.md.resolve("MSFT"))
    assert "paused after a rate limit" in paused.value.message
    assert len(w.gateway_urls(server)) == sent
    restarted = World(server, tmp_path)
    assert restarted.md.gateway.pause_state()["minutesLeft"] >= 59
    assert restarted.gateway_urls(server) == [] and upstream_calls(server) == calls


def test_waits_above_the_previous_two_hour_cap_are_not_dropped(server, tmp_path):
    """They used to be ignored here, which left a one-minute pause and an early retry."""
    control(server, reset=1, blocked=1, retryAfter=14400)
    w = World(server, tmp_path)
    with pytest.raises(DataError):
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert w.md.gateway.pause_state()["minutesLeft"] == 240


def test_a_stop_beyond_the_maximum_pauses_for_the_maximum_and_nothing_reaches_the_source(server, tmp_path):
    control(server, reset=1, limited=1, retryAfter=172800)
    w = World(server, tmp_path)
    with pytest.raises(DataError):
        w.md.price_instrument(w.md.resolve("AAPL"))
    assert w.md.gateway.pause_state()["minutesLeft"] == 1440
    calls = upstream_calls(server)
    control(server, limited=0)
    (tmp_path / "yahoo-pause.json").unlink()  # even with the saved pause gone, the gateway stays stopped
    fresh = World(server, tmp_path)
    assert fresh.md.gateway.pause_state()["paused"] is True, "health reports the stop"
    health = json.loads(urlrequest.urlopen(f"{server}/v1/health", timeout=5).read())  # noqa: S310 - loopback test server
    assert health["upstream"]["state"] == "halted" and health["upstream"]["manualReactivationRequired"] is True
    assert upstream_calls(server) == calls


def test_pause_boundaries_and_damaged_saved_pauses_with_a_controlled_clock(tmp_path):
    from market_data.gateway import GatewayClient, MAX_PAUSE_S

    assert MAX_PAUSE_S == 86400
    clock = {"t": 1_800_000_000.0}
    answers = []

    def http(url, headers):
        if url.endswith("/v1/health"):
            return 200, json.dumps({"schema": "md-gateway.health.v1", "keyless": {"enabled": True}, "upstream": {"state": "ok"}})
        answers.append(url)
        return 429, json.dumps({"schema": "md-gateway.error.v1", "error": {"code": "upstream_rate_limited", "message": "x", "retryAfterSeconds": 3600}})

    c = GatewayClient("http://127.0.0.1:9", http, now=lambda: clock["t"], sleep=lambda s: None, runtime_dir=tmp_path, spacing_s=0)
    c.check()
    identity = {"status": "resolved", "localSymbol": "AAPL", "mic": "XNAS", "displayTicker": "AAPL"}
    with pytest.raises(DataError):
        c.quote(identity)
    assert len(answers) == 1
    clock["t"] += 3599.999
    assert c.pause_state()["paused"] is True
    with pytest.raises(DataError) as e:
        c.quote(identity)
    assert e.value.paused is True and len(answers) == 1
    clock["t"] += 0.001
    assert c.pause_state()["paused"] is False
    for bad in ("{oops", json.dumps({"until": clock["t"] + 400 * 86400, "kind": "rate_limited"}), json.dumps({"until": "soon"})):
        (tmp_path / "yahoo-pause.json").write_text(bad, encoding="utf-8")
        assert GatewayClient("http://127.0.0.1:9", http, now=lambda: clock["t"], runtime_dir=tmp_path).pause_state()["paused"] is False, bad


# ---------------- B1: a reused ticker's earlier prices ----------------
def test_history_from_before_a_listing_date_is_never_used(server, tmp_path):
    control(server, reset=1)
    w = World(server, tmp_path)
    spcx = hist.history_by_sources(w.md, w.md.resolve("SPCX"), "2025-11-01", "2026-11-01")
    days = [r[0] for r in spcx["observations"]]
    assert days and days[0] == "2026-06-12" and all(d >= "2026-06-12" for d in days)
    assert spcx["listing"]["removed"] > 100
    assert spcx["listing"]["note"] == "SPCX: listed only since 2026-06-12; earlier history under this symbol belongs to a different security and is not used."
    aapl = hist.history_by_sources(w.md, w.md.resolve("AAPL"), "2025-11-01", "2026-11-01")
    assert aapl["observations"][0][0] < "2026-06-12" and "listing" not in aapl, "a listing without a date on file is not cut"
    cbrs = hist.history_by_sources(w.md, w.md.resolve("CBRS"), "2025-11-01", "2026-11-01")
    assert cbrs["observations"][0][0] == "2026-05-14"
    # A window entirely after the listing date loses nothing and says nothing.
    later = hist.history_by_sources(w.md, w.md.resolve("SPCX"), "2026-07-01", "2026-11-01")
    assert later["listing"]["removed"] == 0 and later["listing"]["note"] is None


def test_a_source_with_only_earlier_prices_is_not_used(server, tmp_path):
    control(server, reset=1, staleDays=200)
    w = World(server, tmp_path)
    with pytest.raises(DataError) as e:
        hist.history_by_sources(w.md, w.md.resolve("SPCX"), "2025-11-01", "2026-11-01")
    assert "listed only since 2026-06-12" in e.value.attempts[0]["message"]
    assert "different security" in e.value.attempts[0]["message"]
    control(server, reset=1)
