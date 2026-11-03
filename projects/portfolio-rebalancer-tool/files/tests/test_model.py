"""Desktop planning model: the same rules as the web app, with every provider mocked."""
import csv
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from market_data.service import MarketData  # noqa: E402
from portfolio_rebalancer.export import write_csv_export, write_excel_export  # noqa: E402
from portfolio_rebalancer.model import Row, Settings, action_lines, build_plan, rows_from_sample  # noqa: E402
from portfolio_rebalancer.sample import SAMPLE_PORTFOLIO  # noqa: E402

AV_KEY, FH_KEY = "AVKEY1234567", "FHKEY1234567890ABCDEF"
PRICES = {"VEQT.TRT": 60.84, "CNQ.TRT": 75.12, "XQQ.TRT": 68.0, "HEWB.TRT": 74.04, "VFV.TRT": 187.16, "AAPL": 338.32, "SPCX": 136.37, "CBRS": 96.36, "VST": 134.61,
          "SAP.DEX": 220.0, "VOD.LON": 7215.0, "600519.SHH": 1500.0}
FX = {"USD": 1.3978, "EUR": 1.6, "GBP": 1.85, "JPY": 0.0091, "CNY": 0.2102}


class FakeProviders:
    def __init__(self):
        self.calls = []

    def __call__(self, url, headers):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        self.calls.append((u.netloc, q.get("symbol") or q.get("function") or u.path))
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


def market(**kw):
    fake = FakeProviders()
    md = MarketData(None, http=fake, sleep=lambda s: None, pacing_override_ms=0, now=lambda: 1793718000.0, **kw)
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
    assert [(r.ticker, r.shares, r.target) for r in rows[:10]] == [("VEQT.TO", "305", "70"), ("CNQ.TO", "48", "10"), ("XQQ.TO", "27", "7"), ("HEWB.TO", "14", "5"),
                                                                  ("AAPL", "2", "2"), ("VFV.TO", "8", "1"), ("SPCX", "1", "1"), ("CBRS", "4", "1"), ("YNVD.TO", "4", "2"), ("VST", "1", "1")]
    assert [r.ticker for r in rows[10:]] == ["7203.T", "SAP.DE", "VOD.L", "600519.SS"]
    assert all(r.effective() is None for r in rows) and fake.calls == []
    assert rows[8].identity["canonicalId"] == "NEOE:YNVD" and rows[8].ticker == "YNVD.TO"


def test_routing_requests_and_withheld_plan_then_user_supplied_price():
    md, fake = market()
    md.set_key("alphavantage", AV_KEY)
    md.set_key("finnhub", FH_KEY)
    est = md.estimate([md.resolve(r["ticker"]) for r in SAMPLE_PORTFOLIO["rows"][:10]])
    assert est["perProvider"]["alphavantage"]["requests"] == 5 and est["perProvider"]["finnhub"]["requests"] == 4
    assert [u["displayTicker"] for u in est["uncovered"]] == ["YNVD.TO"]
    rows = priced_sample(md)
    sent = [c for c in fake.calls if c[0] != "www.bankofcanada.ca"]
    assert len(sent) == 9 and not any("YNVD" in str(c) for c in sent), sent
    fx = fx_table(md, ["USD", "GBP", "EUR", "CNY", "JPY"])
    run = build_plan(rows, Settings(), fx)
    assert run["plan"] is None and run["valuation"]["unpriced"][0]["ticker"] == "YNVD.TO"
    rows[8].set_manual("44.21", "CAD")
    run = build_plan(rows, Settings(), fx)
    assert run["plan"] is not None and run["valuation"]["manualOverrides"] == [{"rowId": rows[8].id, "ticker": "YNVD.TO", "kind": "manual"}]
    assert any("User-supplied prices" in n and "YNVD.TO" in n for n in run["notes"]["attention"])
    s = run["plan"]["summary"]
    assert s["totalBuys"] <= 3000 + 0.01 and s["totalSells"] == 0
    assert [r.ticker for r in run["notValued"]] == ["7203.T", "SAP.DE", "VOD.L", "600519.SS"]
    # Independent valuation: VEQT 305 x 60.84 CAD; AAPL 2 x 338.32 USD x 1.3978.
    lines = {x["row"].ticker: x for x in action_lines(run)}
    assert lines["VEQT.TO"]["result"]["currentValue"] == pytest.approx(305 * 60.84)
    assert lines["AAPL"]["result"]["currentValue"] == pytest.approx(2 * 338.32 * 1.3978)
    whole = build_plan(rows, Settings(whole_shares=True), fx)
    assert whole["whole"]["totalBuys"] <= 3000 + 1e-9 and all(float(r["wholeShares"]).is_integer() for r in whole["whole"]["results"])


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


def test_pence_conversion_and_test_rows_priced_only_on_request():
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
    rows = priced_sample(md)
    rows[8].set_manual("44.21", "CAD")
    run = build_plan(rows, Settings(), fx_table(md, ["USD"]))
    write_csv_export(tmp_path / "plan.csv", run)
    text = (tmp_path / "plan.csv").read_text(encoding="utf-8")
    assert "YNVD.TO,NEOE:YNVD" in text and "Entered by you (user-supplied)" in text and "Includes 1 user-supplied price" in text
    assert "Alpha Vantage (provider),VEQT.TRT,latest price for trading day,2026-11-02" in text
    assert "Bank of Canada" in text and AV_KEY not in text and FH_KEY not in text
    rows_csv = list(csv.reader(text.splitlines()))
    assert not any(cell.startswith("=") for row in rows_csv for cell in row)
    openpyxl = pytest.importorskip("openpyxl")
    write_excel_export(tmp_path / "plan.xlsx", run)
    wb = openpyxl.load_workbook(tmp_path / "plan.xlsx")
    assert wb.sheetnames == ["Trade Plan", "Summary"]
    ws = wb["Trade Plan"]
    assert ws.max_row == 11 and ws.cell(1, 1).value == "Ticker (as entered)"
    assert "YNVD.TO" in [ws.cell(i, 1).value for i in range(2, 12)]


def test_formula_like_text_is_neutralized():
    from portfolio_rebalancer.export import safe_text
    for bad in ["=HYPERLINK(\"x\")", "+1", "-2", "@SUM", "\t=1", "＝1"]:
        assert safe_text(bad).startswith("'")
    assert safe_text(5.0) == 5.0 and safe_text("VEQT.TO") == "VEQT.TO"
