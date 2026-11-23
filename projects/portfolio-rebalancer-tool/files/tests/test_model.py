"""Desktop planning model: the same rules as the web app, with every provider mocked."""
import csv
import datetime as dt
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from market_data.service import MarketData  # noqa: E402
from portfolio_rebalancer.export import write_csv_export, write_excel_export  # noqa: E402
from portfolio_rebalancer.model import Row, Settings, action_lines, build_plan, plan_source_order, rows_from_sample  # noqa: E402
from portfolio_rebalancer.sample import SAMPLE_PORTFOLIO, target_total_basis_points  # noqa: E402

AV_KEY, FH_KEY = "AVKEY1234567", "FHKEY1234567890ABCDEF"
NOW = 1793718000.0  # 2026-11-03 15:00 UTC: the fixtures' 2026-11-02 closes are the latest session everywhere
PRICES = {"VEQT.TRT": 60.84, "CNQ.TRT": 75.12, "XQQ.TRT": 68.0, "HEWB.TRT": 74.04, "VFV.TRT": 187.16, "AAPL": 338.32, "SPCX": 136.37, "CBRS": 96.36, "VST": 134.61,
          "SAP.DEX": 220.0, "VOD.LON": 7215.0, "600519.SHH": 1500.0}
FX = {"USD": 1.3978, "EUR": 1.6, "GBP": 1.85, "JPY": 0.0091, "CNY": 0.2102, "HKD": 0.1797, "CHF": 1.74, "AUD": 0.92}


GATEWAY = "https://md.gateway.test"
# Yahoo Finance quotes through the site's gateway (major units; VOD.L in pence, as Yahoo quotes it).
GW = {"VEQT.TO": ("XTSE", "CAD", 60.80), "CNQ.TO": ("XTSE", "CAD", 75.10), "XQQ.TO": ("XTSE", "CAD", 68.10), "HEWB.TO": ("XTSE", "CAD", 74.00),
      "AAPL": ("US", "USD", 338.10), "VFV.TO": ("XTSE", "CAD", 187.00), "SPCX": ("US", "USD", 136.30), "CBRS": ("US", "USD", 96.30),
      "YNVD.NE": ("NEOE", "CAD", 44.20), "VST": ("US", "USD", 134.60), "7203.T": ("XTKS", "JPY", 2851.0), "SAP.DE": ("XETR", "EUR", 220.10),
      "VOD.L": ("XLON", "GBp", 7212.0), "600519.SS": ("XSHG", "CNY", 1501.0)}


def gateway_answer(path: str, q: dict, mode: dict) -> tuple[int, str]:
    """A minimal stand-in for the gateway's JSON contract (the real Worker is tested in
    _tools/tests/test_desktop_gateway.py, which needs Node)."""
    if path == "/v1/health":
        return 200, json.dumps({"schema": "md-gateway.health.v1", "status": "ok", "keyless": {"enabled": not mode.get("off"), "reason": None, "attribution": "Data: Yahoo Finance."}})
    if mode.get("limited"):
        return 429, json.dumps({"schema": "md-gateway.error.v1", "error": {"code": "upstream_rate_limited", "message": "x", "retryable": True, "definitive": False, "retryAfterSeconds": 900}})
    sym = q.get("symbol")
    if path != "/v1/quote" or sym not in GW:
        return 404, json.dumps({"schema": "md-gateway.error.v1", "error": {"code": "symbol_not_found", "message": "x", "retryable": False, "definitive": True}})
    mic, raw, price = GW[sym]
    scale = 0.01 if raw == "GBp" else 1
    asia = mic in ("XTKS", "XSHG")
    # At NOW (15:00 UTC on 3 November) the Asian sessions of the 3rd are complete; staleDays shifts every date back.
    day = (dt.date(2026, 11, 3 if asia else 2) - dt.timedelta(days=mode.get("staleDays", 0))).isoformat()
    return 200, json.dumps({"schema": "md-gateway.quote.v1", "listing": {"symbol": sym, "mic": mic, "name": f"Mock {sym}"}, "currency": "GBP" if raw == "GBp" else raw,
                            "rawCurrency": raw, "quoteUnit": "minor" if scale != 1 else "major", "unitScale": scale, "price": round(price * scale, 10), "rawPrice": price,
                            "priceBasis": "regular_market_price", "adjusted": False, "tradingDate": day, "sourceTime": f"{day}T{'06' if asia else '21'}:00:00Z",
                            "delay": {"realTime": False, "note": "Yahoo Finance does not state the delay of this price."}, "retrievedAt": "2026-11-03T15:00:00Z",
                            "cache": {"status": "miss", "ageSeconds": 0, "ttlSeconds": 600}, "source": {"attribution": "Data: Yahoo Finance."}})


class FakeProviders:
    def __init__(self, gateway_mode=None):
        self.calls = []
        self.gateway_mode = gateway_mode if gateway_mode is not None else {}

    def __call__(self, url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        self.calls.append((u.netloc, q.get("symbol") or q.get("function") or u.path))
        if u.netloc == "md.gateway.test":
            assert "Origin" not in headers and not any(k in json.dumps(headers) for k in (AV_KEY, FH_KEY)), "no key or Origin to the gateway"
            return gateway_answer(u.path, q, self.gateway_mode)
        if u.netloc == "www.alphavantage.co":
            sym = q.get("symbol")
            if q.get("function") == "GLOBAL_QUOTE" and sym in PRICES:
                return 200, json.dumps({"Global Quote": {"01. symbol": sym, "05. price": str(PRICES[sym]), "07. latest trading day": "2026-11-02"}})
            return 200, json.dumps({"Global Quote": {}})
        if u.netloc == "finnhub.io":
            assert headers.get("X-Finnhub-Token") == FH_KEY and "token" not in q, "desktop sends the Finnhub key in its header"
            sym = q["symbol"]
            return (200, json.dumps({"c": PRICES[sym], "t": 1793653200})) if sym in PRICES else (200, json.dumps({"c": 0, "t": 0}))
        if u.netloc == "www.bankofcanada.ca":
            series = u.path.split("/observations/")[1].split("/")[0].split(",")
            return 200, json.dumps({"observations": [{"d": "2026-11-02", **{s: {"v": str(FX[s[2:5]])} for s in series}}]})
        return 404, "{}"


def market(gateway_url="", gateway_mode=None, **kw):
    """Without a gateway by default (personal-key providers only); with gateway_url=GATEWAY the fake gateway answers."""
    fake = FakeProviders(gateway_mode)
    md = MarketData(None, http=fake, sleep=lambda s: None, pacing_override_ms=0, now=lambda: NOW, gateway_url=gateway_url, **kw)
    md.gateway.check()
    return md, fake


def priced_sample(md):
    rows = rows_from_sample(SAMPLE_PORTFOLIO)
    for r in rows:
        r.apply_identity(md.resolve(r.ticker))
    for r in rows:
        if r.active and r.status == "resolved":
            try:
                r.apply_quote(r.token(), md.price_instrument(r.identity))
            except Exception as error:  # noqa: BLE001
                r.apply_error(r.token(), {"kind": getattr(error, "kind", "failed"), "message": str(error)})
    return rows


def fx_table(md, codes):
    fx = md.latest_fx(codes)
    return {"CAD": {"cadPer": 1.0, "kind": "official", "label": "base"}, **{c: {"cadPer": v["cadPer"], "kind": "official", "label": f"{fx['provider']}, {v['date']}"} for c, v in fx["cadPer"].items() if c != "CAD"}}


def test_sample_loads_exactly_with_no_prices_and_no_requests():
    md, fake = market()
    rows = rows_from_sample(SAMPLE_PORTFOLIO)
    for r in rows:
        r.apply_identity(md.resolve(r.ticker))
    assert [(r.ticker, r.shares, r.target) for r in rows] == [
        ("VEQT.TO", "305", "63"), ("CNQ.TO", "48", "9"), ("XQQ.TO", "27", "6.3"), ("HEWB.TO", "14", "4.5"), ("AAPL", "2", "1.8"),
        ("VFV.TO", "8", "0.9"), ("SPCX", "1", "0.9"), ("CBRS", "4", "0.9"), ("YNVD.NE", "4", "1.8"), ("VST", "1", "0.9"),
        ("7203.T", "1", "2.5"), ("SAP.DE", "1", "2.5"), ("VOD.L", "1", "2.5"), ("600519.SS", "1", "2.5")]
    assert target_total_basis_points(SAMPLE_PORTFOLIO["rows"]) == 10000
    assert all(r.active for r in rows) and all(r.account == "" for r in rows)
    assert all(r.effective() is None for r in rows) and fake.calls == []
    assert rows[8].identity["canonicalId"] == "NEOE:YNVD" and rows[8].ticker == "YNVD.NE"
    assert md.resolve("YNVD.TO")["canonicalId"] == "NEOE:YNVD", "legacy Questrade alias: same instrument"
    assert [(r.identity["currency"], r.identity["unitScale"]) for r in rows[10:]] == [("JPY", 1), ("EUR", 1), ("GBP", 0.01), ("CNY", 1)]


def test_routing_requests_and_withheld_plan_then_user_supplied_prices():
    md, fake = market()
    md.set_key("alphavantage", AV_KEY)
    md.set_key("finnhub", FH_KEY)
    md.move_source("finnhub", 1)  # Finnhub before Alpha Vantage: US listings to Finnhub, the rest to Alpha Vantage
    est = md.estimate([md.resolve(r["ticker"]) for r in SAMPLE_PORTFOLIO["rows"]])
    assert est["perProvider"]["alphavantage"]["requests"] == 8 and est["perProvider"]["finnhub"]["requests"] == 4
    assert [u["displayTicker"] for u in est["uncovered"]] == ["YNVD.NE", "7203.T"]
    rows = priced_sample(md)
    sent = [c for c in fake.calls if c[0] != "www.bankofcanada.ca"]
    assert len(sent) == 12 and not any("YNVD" in str(c) or "7203" in str(c) for c in sent), sent
    fx = fx_table(md, ["USD", "GBP", "EUR", "CNY", "JPY"])
    run = build_plan(rows, Settings(), fx, now=NOW)
    assert run["plan"] is None and [u["ticker"] for u in run["valuation"]["unpriced"]] == ["YNVD.NE", "7203.T"]
    rows[8].set_manual("44.21", "CAD")
    assert build_plan(rows, Settings(), fx, now=NOW)["plan"] is None, "7203.T still has no price"
    rows[10].set_manual("2850", "JPY")
    run = build_plan(rows, Settings(), fx, now=NOW)
    assert run["plan"] is not None and [m["ticker"] for m in run["valuation"]["manualOverrides"]] == ["YNVD.NE", "7203.T"]
    assert any("User-supplied prices" in n and "YNVD.NE" in n and "7203.T" in n for n in run["notes"]["attention"])
    s = run["plan"]["summary"]
    assert s["totalBuys"] <= 3000 + 0.01 and s["totalSells"] == 0
    assert run["notValued"] == [] and len(run["plan"]["results"]) == 14
    # Independent valuation: VEQT 305 x 60.84 CAD; AAPL 2 x 338.32 USD x 1.3978; VOD 7215p = 72.15 GBP x 1.85.
    lines = {x["row"].ticker: x for x in action_lines(run)}
    assert lines["VEQT.TO"]["result"]["currentValue"] == pytest.approx(305 * 60.84)
    assert lines["AAPL"]["result"]["currentValue"] == pytest.approx(2 * 338.32 * 1.3978)
    assert lines["VOD.L"]["result"]["currentValue"] == pytest.approx(72.15 * 1.85)
    assert lines["7203.T"]["result"]["currentValue"] == pytest.approx(2850 * 0.0091)
    assert lines["SAP.DE"]["result"]["targetWeightNorm"] == pytest.approx(0.025)
    whole = build_plan(rows, Settings(whole_shares=True), fx, now=NOW)
    assert whole["whole"]["totalBuys"] <= 3000 + 1e-9 and all(float(r["wholeShares"]).is_integer() for r in whole["whole"]["results"])
    # Removing a holding updates the plan and the 100% check.
    run = build_plan([r for r in rows if r.ticker != "VST"], Settings(), fx, now=NOW)
    assert len(run["plan"]["results"]) == 13 and any("99.10%" in w for w in run["plan"]["warnings"] + run["notes"]["info"])


def test_international_holdings_are_ordinary_rows():
    """The four international sample holdings are ordinary rows (no tag, no special removal)."""
    import portfolio_rebalancer.sample as sample
    rows = rows_from_sample(SAMPLE_PORTFOLIO)
    assert [r.ticker for r in rows][10:] == ["7203.T", "SAP.DE", "VOD.L", "600519.SS"]
    assert not hasattr(sample, "is_unchanged_international_example") and not hasattr(sample, "INTERNATIONAL_EXAMPLE_TAG")
    assert not hasattr(rows[10], "sample_tag")
    assert all(set(r) == {"ticker", "shares", "targetWeight", "accountType"} for r in SAMPLE_PORTFOLIO["rows"])

def test_invalid_currencies_and_units_are_rejected():
    row = Row("VOD.L", "1", "2.5")
    for bad in ["", "gbp", "GB", "GBPX", "US$"]:
        with pytest.raises(ValueError, match="currency"):
            row.set_manual("1", bad)
    with pytest.raises(ValueError, match="minor unit"):
        row.set_manual("7215", "GBX")
    with pytest.raises(ValueError, match="pence"):
        row.set_manual("1", "GBP", 0.5)
    for bad in ["0", "-1", "nan", "abc", ""]:
        with pytest.raises(ValueError, match="greater than 0"):
            row.set_manual(bad, "GBP")
    row.set_manual("7215", "GBP", 0.01)
    assert row.effective()["price"] == pytest.approx(72.15) and row.effective()["currency"] == "GBP"


def test_ticker_edit_clears_price_and_late_answer_is_ignored():
    md, _ = market()
    md.set_key("alphavantage", AV_KEY)
    row = Row("VEQT.TO", "305", "100")
    row.apply_identity(md.resolve(row.ticker))
    token = row.token()
    quote = md.price_instrument(row.identity)
    row.edit_ticker("VFV.TO")
    assert row.effective() is None and row.quote is None and row.shares == "305"
    row.apply_identity(md.resolve(row.ticker))
    assert row.apply_quote(token, quote) is False, "late VEQT answer is not applied to VFV"
    assert row.apply_quote(row.token(), md.price_instrument(row.identity)) is True
    assert row.effective()["price"] == PRICES["VFV.TRT"]


def test_pence_conversion_and_tokyo_not_covered_without_marketstack():
    md, fake = market()
    md.set_key("alphavantage", AV_KEY)
    vod = md.price_instrument(md.resolve("VOD.L"))
    assert vod["nativePriceMajorUnits"] == pytest.approx(72.15) and vod["quoteUnit"] == "minor" and vod["nativeCurrency"] == "GBP"
    with pytest.raises(Exception) as e:
        md.price_instrument(md.resolve("7203.T"))
    assert getattr(e.value, "kind", None) == "not_covered"


def test_exports_carry_sources_and_no_keys(tmp_path):
    md, _ = market()
    md.set_key("alphavantage", AV_KEY)
    md.set_key("finnhub", FH_KEY)
    md.move_source("finnhub", 1)
    rows = priced_sample(md)
    rows[8].set_manual("44.21", "CAD")
    rows[10].set_manual("2850", "JPY")
    run = build_plan(rows, Settings(), fx_table(md, ["USD", "EUR", "GBP", "JPY", "CNY"]), now=NOW)
    run["sourceOrder"] = plan_source_order(rows)
    md.move_source("alphavantage", 0)  # after pricing: must not rewrite the record of what was requested
    assert plan_source_order(rows).startswith("1. Yahoo Finance; 2. Finnhub")
    write_csv_export(tmp_path / "plan.csv", run)
    text = (tmp_path / "plan.csv").read_text(encoding="utf-8")
    assert "YNVD.NE,NEOE:YNVD" in text and "Entered by you (user-supplied)" in text and "Includes 2 user-supplied price" in text
    assert "VOD.L,XLON:VOD" in text and "600519.SS,XSHG:600519" in text and "SAP.DE,XETR:SAP" in text
    assert "Alpha Vantage (your own key),VEQT.TRT,latest price for trading day,2026-11-02" in text
    assert "Source order (first tried first),1. Yahoo Finance; 2. Finnhub; 3. Alpha Vantage; 4. Marketstack (off); 5. Alpaca (off)" in text
    assert "Sources tried first,Sources skipped" in text and "Finnhub: does not cover Toronto Stock Exchange on the free plan" in text
    assert "Bank of Canada" in text and AV_KEY not in text and FH_KEY not in text
    rows_csv = list(csv.reader(text.splitlines()))
    assert not any(cell.startswith("=") for row in rows_csv for cell in row)
    openpyxl = pytest.importorskip("openpyxl")
    write_excel_export(tmp_path / "plan.xlsx", run)
    wb = openpyxl.load_workbook(tmp_path / "plan.xlsx")
    assert wb.sheetnames == ["Trade Plan", "Summary"]
    ws = wb["Trade Plan"]
    assert ws.max_row == 15 and ws.cell(1, 1).value == "Ticker (as entered)"
    assert [ws.cell(i, 1).value for i in range(2, 16)] == [r["ticker"] for r in SAMPLE_PORTFOLIO["rows"]]


def _usd_plan(budget="", **settings):
    """Four user-priced holdings in four currencies, reporting in USD (CAD per unit: USD 1.40,
    EUR 1.50, GBP 1.75). X 10 EUR @ 84 = 900 USD; Y 20 CAD @ 35 = 500 USD; Z 4 GBP @ 5000p
    = 200 GBP = 250 USD; W 5 USD @ 70 = 350 USD. Total 2,000; targets 25% = 500 each."""
    fx = {"CAD": {"cadPer": 1.0, "kind": "official", "label": "base"}, "USD": {"cadPer": 1.40, "kind": "official", "label": "Bank of Canada, 2026-11-02"},
          "EUR": {"cadPer": 1.50, "kind": "official", "label": "Bank of Canada, 2026-11-02"}, "GBP": {"cadPer": 1.75, "kind": "official", "label": "Bank of Canada, 2026-11-02"}}
    rows = [Row("X", "10", "25"), Row("Y", "20", "25"), Row("Z", "4", "25"), Row("W", "5", "25")]
    for row, (price, currency, scale) in zip(rows, [("84", "EUR", 1), ("35", "CAD", 1), ("5000", "GBP", 0.01), ("70", "USD", 1)]):
        row.set_manual(price, currency, scale)
    return build_plan(rows, Settings(reporting="USD", budget=budget, **settings), fx, now=NOW)


def test_whole_share_export_values_match_hand_calculation(tmp_path):
    # Rebalance: X sells 400 USD; Y holds; Z buys 250, W buys 150. Whole shares: X sells 4 = 336 EUR
    # = 360 USD of proceeds; Z 4 + W 2 = 390 > 360, so Z drops to 3 (187.50 USD = 150 GBP); W 2 = 140.
    # Buys 327.50, sells 360, cash not invested 32.50.
    run = _usd_plan(mode="rebalance", whole_shares=True)
    assert run["plan"] is not None, run["valuation"]
    expected = {  # ticker: (FX to USD, current, action, trade USD, trade local, trade shares, post shares)
        "X": (1.5 / 1.4, 900, "Sell", -360, -336, -4, 6), "Y": (1 / 1.4, 500, "Hold", 0, 0, 0, 20),
        "Z": (1.25, 250, "Buy", 187.5, 150, 3, 7), "W": (1.0, 350, "Buy", 140, 140, 2, 7)}
    lines = {x["row"].ticker: x for x in action_lines(run)}
    assert sum(x["after"] for x in lines.values()) == pytest.approx(1.0), "weights after trading add up to 100% (cash excluded)"
    assert lines["X"]["after"] == pytest.approx((900 - 360) / (2000 + 327.5 - 360))
    assert any("US$32.50 of sell proceeds is not reinvested after rounding to whole shares" in n for n in run["notes"]["info"])

    def check_table(header, body):
        col = {name: i for i, name in enumerate(header)}
        assert len(body) == 4
        for cells in body:
            fx, current, action, trade, local, shares, post = expected[cells[col["Ticker (as entered)"]]]
            assert float(cells[col["FX to USD"]]) == pytest.approx(fx, rel=1e-12)
            assert float(cells[col["Current value (USD)"]]) == pytest.approx(current, rel=1e-12)
            assert float(cells[col["Target weight"]]) == pytest.approx(0.25) and float(cells[col["Target value (USD)"]]) == pytest.approx(500)
            assert cells[col["Action"]] == action
            assert float(cells[col["Trade value (USD)"]]) == pytest.approx(trade, abs=1e-9)
            assert float(cells[col["Trade value (local)"]]) == pytest.approx(local, abs=1e-9)
            assert float(cells[col["Trade shares"]]) == shares and float(cells[col["Post-trade shares"]]) == post

    def check_meta(meta):
        for key, value in {"Total current": 2000, "Target pool": 2000, "Total buys": 327.5, "Total sells": 360, "Cash not invested": 32.5}.items():
            assert float(meta[key]) == pytest.approx(value, rel=1e-12), key
        assert meta["Mode"] == "Rebalance" and meta["Reporting currency"] == "USD" and meta["Share quantities"] == "Whole shares"

    write_csv_export(tmp_path / "plan.csv", run)
    rows_csv = list(csv.reader((tmp_path / "plan.csv").read_text(encoding="utf-8").splitlines()))
    start = next(i for i, r in enumerate(rows_csv) if r and r[0] == "Ticker (as entered)")
    check_table(rows_csv[start], rows_csv[start + 1:start + 5])
    assert rows_csv[start + 5] == []
    check_meta({r[0]: r[1] for r in rows_csv[:start] if len(r) == 2})
    fx_start = next(i for i, r in enumerate(rows_csv) if r and r[0] == "Currency")
    assert rows_csv[fx_start] == ["Currency", "USD per unit", "Source"]
    assert {r[0]: float(r[1]) for r in rows_csv[fx_start + 1:fx_start + 4]} == pytest.approx({"CAD": 1 / 1.4, "EUR": 1.5 / 1.4, "GBP": 1.25})

    openpyxl = pytest.importorskip("openpyxl")
    write_excel_export(tmp_path / "plan.xlsx", run)
    wb = openpyxl.load_workbook(tmp_path / "plan.xlsx")
    table = [[c.value for c in row] for row in wb["Trade Plan"].iter_rows()]
    check_table(table[0], [[str(v) if isinstance(v, str) else v for v in row] for row in table[1:]])
    check_meta({row[0].value: row[1].value for row in wb["Summary"].iter_rows() if row[0].value and len(row) > 1 and row[1].value is not None})


def test_fractional_new_money_totals_reconcile_in_usd(tmp_path):
    # New Money 600 USD: pool 2,600, targets 650. X (900) is overweight: Hold, never sold.
    # Underweight: Y 150, Z 400, W 300 = 850 > 600, so buys are scaled by 600/850 (29.4% down):
    # Y 105.88 USD = 148.24 CAD = 4.2353 sh; Z 282.35 USD = 225.88 GBP = 4.5176 sh; W 211.76 = 3.0252 sh.
    run = _usd_plan(budget="600", mode="new_money")
    s = run["plan"]["summary"]
    assert s["totalBuys"] == pytest.approx(600) and s["totalSells"] == 0 and s["cashLeft"] == pytest.approx(0, abs=1e-9)
    by = {r["ticker"]: r for r in run["plan"]["results"]}
    scale = 600 / 850
    assert by["X"]["action"] == "Hold" and by["X"]["tradeShares"] == 0
    assert by["Y"]["tradeShares"] == pytest.approx(150 * scale * 1.4 / 35)
    assert by["Z"]["tradeValueLocal"] == pytest.approx(400 * scale / 1.25) and by["Z"]["tradeShares"] == pytest.approx(400 * scale / 1.25 / 50)
    assert by["W"]["tradeShares"] == pytest.approx(300 * scale / 70)
    assert any("scaled down by 29.4%" in n and "US$600.00" in n and "US$850.00" in n for n in run["notes"]["info"])
    write_csv_export(tmp_path / "plan.csv", run)
    meta = {r[0]: r[1] for r in csv.reader((tmp_path / "plan.csv").read_text(encoding="utf-8").splitlines()) if len(r) == 2}
    assert float(meta["New money budget"]) == 600 and float(meta["Total buys"]) == pytest.approx(600) and float(meta["Cash not invested"]) == pytest.approx(0, abs=1e-9)


def test_negative_shares_or_target_withhold_the_desktop_plan():
    # Regression: B with 10 shares and a -10% target was told to sell 12 shares (to -2).
    fx = {"CAD": {"cadPer": 1.0, "kind": "official", "label": "base"}}
    for shares, target in (("10", "-10"), ("-10", "50")):
        a, b = Row("A", "10", "110"), Row("B", shares, target)
        a.set_manual("100", "CAD")
        b.set_manual("100", "CAD")
        run = build_plan([a, b], Settings(mode="rebalance"), fx, now=NOW)
        assert run["plan"] is None
        assert run["valuation"]["unpriced"] == [{"rowId": b.id, "ticker": "B", "reason": "shares and target must be numbers of 0 or more"}]


def test_formula_like_text_is_neutralized():
    from portfolio_rebalancer.export import safe_text
    for bad in ["=HYPERLINK(\"x\")", "+1", "-2", "@SUM", "\t=1", "＝1"]:
        assert safe_text(bad).startswith("'")
    assert safe_text(5.0) == 5.0 and safe_text("VEQT.TO") == "VEQT.TO"


def test_zero_keys_yahoo_first_prices_all_fourteen_then_a_key_joins_below_it():
    md, fake = market(gateway_url=GATEWAY)
    assert [s["id"] for s in md.sources_list() if s["status"] == "on"] == ["yahoo"], "zero keys: Yahoo Finance only, switched on"
    rows = priced_sample(md)
    assert all(r.effective() and r.quote["providerId"] == "yahoo" for r in rows), [r.ticker for r in rows if not r.effective()]
    vod = next(r for r in rows if r.ticker == "VOD.L").quote
    assert vod["nativeCurrency"] == "GBP" and vod["rawCurrency"] == "GBp" and vod["nativePriceMajorUnits"] == pytest.approx(72.12)
    assert next(r for r in rows if r.ticker == "YNVD.NE").quote["providerSymbol"] == "YNVD.NE"
    sent = [c for c in fake.calls if c[0] == "md.gateway.test" and c[1] != "/v1/health"]
    assert len(sent) == 14 and not any(c[0] in ("www.alphavantage.co", "finnhub.io") for c in fake.calls)
    run = build_plan(rows, Settings(), fx_table(md, ["USD", "EUR", "GBP", "JPY", "CNY"]), now=NOW)
    assert run["plan"] is not None and len(run["plan"]["results"]) == 14 and run["valuation"]["manualOverrides"] == []
    assert any("Priced by Yahoo Finance through this site's data gateway" in n for n in run["notes"]["info"])
    md.set_key("alphavantage", AV_KEY)
    assert "Alpha Vantage is switched on at position 2 of 5, after Yahoo Finance" in md.take_notes()[0]
    # Stale data is never used silently: an old Yahoo Finance date withholds the plan until accepted.
    old, _ = market(gateway_url=GATEWAY, gateway_mode={"staleDays": 7})
    stale_rows = priced_sample(old)
    stale = build_plan(stale_rows, Settings(), fx_table(old, ["USD", "EUR", "GBP", "JPY", "CNY"]), now=NOW)
    assert stale["plan"] is None and len(stale["valuation"]["stale"]) + len(stale["valuation"]["unpriced"]) == 14, stale["valuation"]
    assert all("too old" in u["reason"] for u in stale["valuation"]["unpriced"]), "a week-old price is too old to use"
    assert [c["id"] for c in md.route(md.resolve("VEQT.TO"), "quote")["candidates"]] == ["yahoo", "alphavantage"]


def test_yahoo_rate_limit_falls_back_to_the_next_source_and_pauses():
    mode = {"limited": True}
    md, fake = market(gateway_url=GATEWAY, gateway_mode=mode)
    md.set_key("alphavantage", AV_KEY)
    q = md.price_instrument(md.resolve("VEQT.TO"))
    assert q["providerId"] == "alphavantage" and q["fallbackFrom"][0]["providerId"] == "yahoo" and q["fallbackFrom"][0]["kind"] == "rate_limited"
    assert md.gateway.pause_state()["paused"] is True
    sent = sum(1 for c in fake.calls if c[0] == "md.gateway.test")
    q2 = md.price_instrument(md.resolve("CNQ.TO"))
    assert q2["providerId"] == "alphavantage" and any(x["id"] == "yahoo" and x["code"] == "paused" for x in q2["skippedSources"])
    assert sum(1 for c in fake.calls if c[0] == "md.gateway.test") == sent, "no request to Yahoo Finance while it is paused"
