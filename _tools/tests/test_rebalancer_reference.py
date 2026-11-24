"""Portfolio Rebalancer: hand-calculated reference cases for BOTH engines, plus web/desktop parity.

Every expected number below is worked out by hand in the comments (prices x shares x
exchange rate, normalized targets, whole-share rounding step by step); none is taken
from either engine. The browser engine runs under Node (js_engines.mjs), the desktop
engine in-process. Exchange rates are given the way both apps hold them: CAD per one
unit of each currency (Bank of Canada style), so "reporting units per 1 unit of X" is
cadPer[X] / cadPer[reporting].
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name("js_engines.mjs")
sys.path.insert(0, str(ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts"))
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")

from portfolio_rebalancer import core  # noqa: E402

CAD_PER = {"CAD": 1.0, "USD": 1.40, "EUR": 1.50, "GBP": 1.75}


def run_js(tool: str, cases: list) -> list:
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps({"tool": tool, "cases": cases}),
                            capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def pos(ticker, shares, price, target, currency="USD"):
    return {"ticker": ticker, "shares": shares, "price": price, "currencyKey": currency, "targetWeight": target, "accountType": ""}


def both(positions, mode, budget, reporting="USD"):
    """[("web", plan), ("desktop", plan)]; plan = {summary, results, warnings, whole} or {error}."""
    positions = [{**p, "rowIndex": i} for i, p in enumerate(positions)]
    case = {"op": "whole", "positions": positions, "fxToUsd": CAD_PER, "reportingKey": reporting, "mode": mode, "budget": budget}
    (js,) = run_js("rebalancer-extras", [case])
    web = js if "error" in js else {**js["plan"], "whole": js["whole"]}
    rate = lambda code: CAD_PER[code] / CAD_PER[reporting]  # noqa: E731
    enriched = [{**p, "currencyLabel": p["currencyKey"], "fxToReporting": rate(p["currencyKey"]),
                 "currentValue": p["shares"] * p["price"] * rate(p["currencyKey"])} for p in positions]
    try:
        summary, results, warnings = core.calculate_rebalance_plan(enriched, mode, budget)
        desktop = {"summary": summary, "results": results, "warnings": warnings, "whole": core.apply_whole_shares(summary, results)}
    except ValueError as error:
        desktop = {"error": str(error)}
    return [("web", web), ("desktop", desktop)]


def near(a, b, tol=1e-9):
    return math.isclose(a, b, rel_tol=1e-12, abs_tol=tol)


def check_invariants(plan, mode, budget):
    """Rules that hold for every plan, checked with arithmetic independent of the engines."""
    s, results, whole = plan["summary"], plan["results"], plan["whole"]
    assert near(sum(r["targetWeightNorm"] for r in results), 1.0), "normalized targets add up to 100%"
    buys = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    sells = sum(-r["tradeValue"] for r in results if r["action"] == "Sell")
    assert near(s["totalBuys"], buys) and near(s["totalSells"], sells)
    for r in results:
        if r["action"] != "Hold":  # value = shares x price x rate; post = held + traded
            assert near(r["tradeValue"], r["tradeShares"] * r["price"] * r["fxToReporting"], 1e-7)
        assert near(r["postTradeShares"], r["shares"] + r["tradeShares"])
        assert r["postTradeShares"] >= -1e-9, "never sells more than is held"
    if mode == "new_money":
        assert not any(r["action"] == "Sell" for r in results), "New Money never sells"
        assert buys <= budget + 0.01 and near(s["cashLeft"], max(0.0, budget - buys))
    else:
        assert buys <= sells + 0.01 and near(s["cashLeft"], max(0.0, sells - buys))
    w_buys = sum(r["wholeShares"] * r["price"] * r["fxToReporting"] for r in whole["results"] if r["wholeShares"] > 0)
    w_sells = sum(-r["wholeShares"] * r["price"] * r["fxToReporting"] for r in whole["results"] if r["wholeShares"] < 0)
    available = budget if mode == "new_money" else w_sells
    assert near(whole["totalBuys"], w_buys) and near(whole["totalSells"], w_sells)
    assert w_buys <= available + 1e-9, "whole shares never spend more cash than is available"
    assert near(whole["cashLeft"], available - w_buys), "buys + cash left = cash available"
    for r in whole["results"]:
        assert float(r["wholeShares"]).is_integer()
        assert -r["wholeShares"] <= math.floor(r["shares"] + 1e-9), "never sells more whole shares than held"
        assert near(r["wholeTradeValueLocal"], r["wholeShares"] * r["price"])
        assert near(r["wholePostTradeShares"], r["shares"] + r["wholeShares"])


def by_ticker(plan):
    return {r["ticker"]: r for r in plan["results"]}, {r["ticker"]: r for r in plan["whole"]["results"]}


def test_multi_currency_rebalance_in_usd_with_whole_shares():
    # Reporting USD; rates CAD per unit: USD 1.40, EUR 1.50, GBP 1.75.
    #   X 10 EUR @ 84 = 840 EUR x (1.50/1.40) = 900 USD;  Y 20 CAD @ 35 = 700 CAD / 1.40 = 500 USD
    #   Z 4 GBP @ 50 = 200 GBP x (1.75/1.40 = 1.25) = 250 USD;  W 5 USD @ 70 = 350 USD.  Total 2,000.
    # Targets 25% = 500 each: X sells 400 USD = 373.33 EUR = 4.444 sh; Y holds; Z buys 250 USD
    # = 200 GBP = 4 sh; W buys 150 USD = 2.142857 sh. Buys 400 = sells 400.
    # Whole shares: X sells 4 (336 EUR = 360 USD of proceeds). Z 4 (250) + W 2 (140) = 390 > 360,
    # so one share comes off the largest buy (Z -> 3, 187.50): 327.50 <= 360. Neither Z (62.50)
    # nor W (70) fits in the 32.50 left. Cash left 32.50.
    positions = [pos("X", 10, 84, 25, "EUR"), pos("Y", 20, 35, 25, "CAD"), pos("Z", 4, 50, 25, "GBP"), pos("W", 5, 70, 25, "USD")]
    for name, plan in both(positions, "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        r, w = by_ticker(plan)
        assert near(plan["summary"]["totalCurrent"], 2000), name
        assert [near(r[t]["currentValue"], v) for t, v in (("X", 900), ("Y", 500), ("Z", 250), ("W", 350))] == [True] * 4, name
        assert near(r["X"]["fxToReporting"], 1.5 / 1.4) and near(r["Z"]["fxToReporting"], 1.25)
        assert [r[t]["action"] for t in "XYZW"] == ["Sell", "Hold", "Buy", "Buy"], name
        assert near(r["X"]["tradeValue"], -400) and near(r["X"]["tradeValueLocal"], -400 * 1.4 / 1.5)
        assert near(r["X"]["tradeShares"], -400 * 1.4 / 1.5 / 84)
        assert near(r["Z"]["tradeValueLocal"], 200) and near(r["Z"]["tradeShares"], 4)
        assert near(r["W"]["tradeShares"], 150 / 70)
        assert near(plan["summary"]["totalBuys"], 400) and near(plan["summary"]["totalSells"], 400) and near(plan["summary"]["cashLeft"], 0)
        assert [w[t]["wholeShares"] for t in "XYZW"] == [-4, 0, 3, 2], name
        assert near(w["X"]["wholeTradeValueLocal"], -336) and near(w["X"]["wholeTradeValue"], -360)
        assert near(w["Z"]["wholeTradeValue"], 187.5) and near(w["Z"]["wholeTradeValueLocal"], 150)
        assert near(plan["whole"]["totalBuys"], 327.5) and near(plan["whole"]["totalSells"], 360) and near(plan["whole"]["cashLeft"], 32.5)
        assert not plan["warnings"]


def test_new_money_whole_shares_with_non_integer_prices():
    # A 10 @ 33.33 = 333.30, B 0 @ 47.10, 50/50, budget 500: pool 833.30, targets 416.65.
    # A buys 83.35 (2.50075 sh), B buys 416.65 (8.846 sh): 500 = budget, so no scaling.
    # Whole: A 2 (66.66) + B 8 (376.80) = 443.46, 56.54 left. Shortfalls: A 416.65 - 399.96 = 16.69,
    # B 416.65 - 376.80 = 39.85 -> B 9 (423.90). Buys 490.56, 9.44 left (< both prices).
    for name, plan in both([pos("A", 10, 33.33, 50), pos("B", 0, 47.10, 50)], "new_money", 500):
        check_invariants(plan, "new_money", 500)
        r, w = by_ticker(plan)
        assert near(r["A"]["tradeValue"], 83.35, 1e-9) and near(r["B"]["tradeValue"], 416.65, 1e-9), name
        assert near(r["A"]["tradeShares"], 83.35 / 33.33) and near(r["B"]["tradeShares"], 416.65 / 47.10)
        assert near(plan["summary"]["totalBuys"], 500) and not plan["warnings"]
        assert (w["A"]["wholeShares"], w["B"]["wholeShares"]) == (2, 9), name
        assert near(plan["whole"]["totalBuys"], 490.56) and near(plan["whole"]["cashLeft"], 9.44)


def test_sell_only_rebalance_whole_and_fractional():
    # Whole shares: A 20 @ 10 = 200 (target 25%), B 1 @ 200 (target 75%); total 400.
    # A sells 100 (10 sh), B buys 100 = 0.5 sh -> 0 whole shares, and B's 200 price does not fit
    # in the 100 of proceeds: the whole-share plan only sells, 100 left as cash.
    for name, plan in both([pos("A", 20, 10, 25), pos("B", 1, 200, 75)], "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        r, w = by_ticker(plan)
        assert near(r["A"]["tradeShares"], -10) and near(r["B"]["tradeShares"], 0.5), name
        assert (w["A"]["wholeAction"], w["A"]["wholeShares"], w["B"]["wholeAction"]) == ("Sell", -10, "Hold"), name
        assert near(plan["whole"]["totalBuys"], 0) and near(plan["whole"]["totalSells"], 100) and near(plan["whole"]["cashLeft"], 100)
    # Fractional: pool 10,000, hold band 0.01% = 1.00. A 2,003 vs 2,000 target sells 3; B-E each
    # 0.75 under target (inside the band) hold. Sells 3, buys 0, 3 of proceeds not reinvested.
    positions = [pos("A", 1, 2003, 20)] + [pos(t, 1, 1999.25, 20) for t in "BCDE"]
    for name, plan in both(positions, "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        assert [r["action"] for r in plan["results"]] == ["Sell", "Hold", "Hold", "Hold", "Hold"], name
        assert near(plan["summary"]["totalSells"], 3) and plan["summary"]["totalBuys"] == 0 and near(plan["summary"]["cashLeft"], 3)
        assert not plan["warnings"]
        assert plan["whole"]["results"][0]["wholeShares"] == 0, "3/2003 of a share rounds down to none"


def test_single_asset():
    # New Money: 10 @ 333.33 = 3,333.30 + 1,000 -> buy 1,000 = 3.00003 sh; whole 3 = 999.99, 0.01 left.
    for name, plan in both([pos("A", 10, 333.33, 100)], "new_money", 1000):
        check_invariants(plan, "new_money", 1000)
        assert plan["results"][0]["action"] == "Buy" and near(plan["results"][0]["tradeShares"], 1000 / 333.33), name
        assert plan["whole"]["results"][0]["wholeShares"] == 3 and near(plan["whole"]["cashLeft"], 0.01)
    # Rebalance: already 100% -> hold, nothing traded, no warnings.
    for name, plan in both([pos("A", 10, 333.33, 100)], "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        assert plan["results"][0]["action"] == "Hold" and plan["summary"]["totalBuys"] == plan["summary"]["totalSells"] == 0, name
        assert not plan["warnings"]


def test_cash_only_portfolio():
    # No holdings yet: New Money invests the budget at target: A 600 = 12 sh @ 50, B 400 = 20 sh @ 20.
    for name, plan in both([pos("A", 0, 50, 60), pos("B", 0, 20, 40)], "new_money", 1000):
        check_invariants(plan, "new_money", 1000)
        r, w = by_ticker(plan)
        assert near(r["A"]["tradeShares"], 12) and near(r["B"]["tradeShares"], 20), name
        assert (w["A"]["wholeShares"], w["B"]["wholeShares"]) == (12, 20) and near(plan["whole"]["cashLeft"], 0)
    # Rebalance has nothing to sell: both refuse with the same message.
    for name, plan in both([pos("A", 0, 50, 60), pos("B", 0, 20, 40)], "rebalance", 0):
        assert plan == {"error": "Portfolio value must be greater than 0."}, name


def test_zero_target_holding():
    # Rebalance: A 10 @ 100 = 1,000 (target 0%), B 10 @ 50 = 500 (target 100%), total 1,500.
    # A sells everything (10 sh); B buys 1,000 = 20 sh, ending with 30.
    for name, plan in both([pos("A", 10, 100, 0), pos("B", 10, 50, 100)], "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        r, w = by_ticker(plan)
        assert near(r["A"]["tradeShares"], -10) and near(r["A"]["postTradeShares"], 0), name
        assert near(r["B"]["tradeShares"], 20) and near(r["B"]["postTradeShares"], 30)
        assert (w["A"]["wholeShares"], w["B"]["wholeShares"]) == (-10, 20)
    # New Money 500: pool 2,000; A is never sold (Hold); B needs 1,500, scaled to 500 = 10 sh
    # (scaled down by 1 - 500/1500 = 66.7%).
    for name, plan in both([pos("A", 10, 100, 0), pos("B", 10, 50, 100)], "new_money", 500):
        check_invariants(plan, "new_money", 500)
        r, _ = by_ticker(plan)
        assert r["A"]["action"] == "Hold" and r["A"]["tradeValue"] == 0 and r["A"]["postTradeShares"] == 10, name
        assert near(r["B"]["tradeShares"], 10) and any("scaled down by 66.7%" in x for x in plan["warnings"])


def test_fractional_holding_sold_in_whole_shares_never_oversells_or_overspends():
    # A 10.5 @ 10 = 105 (target 0%), B 0 @ 5 (target 100%). Fractional: sell 10.5, buy 21.
    # Whole: sell 10 (floor; 0.5 share stays) = 100 of proceeds; B 21 = 105 > 100 -> 20 = 100. Cash 0.
    for name, plan in both([pos("A", 10.5, 10, 0), pos("B", 0, 5, 100)], "rebalance", 0):
        check_invariants(plan, "rebalance", 0)
        _, w = by_ticker(plan)
        assert (w["A"]["wholeShares"], w["B"]["wholeShares"]) == (-10, 20), name
        assert near(plan["whole"]["cashLeft"], 0) and near(w["A"]["wholePostTradeShares"], 0.5)


PARITY_CASES = [
    ([pos("X", 10, 84, 25, "EUR"), pos("Y", 20, 35, 25, "CAD"), pos("Z", 4, 50, 25, "GBP"), pos("W", 5, 70, 25, "USD")], "rebalance", 0, "USD"),
    ([pos("X", 10, 84, 25, "EUR"), pos("Y", 20, 35, 25, "CAD"), pos("Z", 4, 50, 25, "GBP"), pos("W", 5, 70, 25, "USD")], "new_money", 750, "CAD"),
    ([pos("A", 10, 33.33, 50), pos("B", 0, 47.10, 50)], "new_money", 500, "USD"),
    ([pos("A", 20, 10, 25), pos("B", 1, 200, 75)], "rebalance", 0, "USD"),
    ([pos("A", 1, 2003, 20)] + [pos(t, 1, 1999.25, 20) for t in "BCDE"], "rebalance", 0, "USD"),
    ([pos("A", 10, 333.33, 100)], "new_money", 1000, "EUR"),
    ([pos("A", 10, 333.33, 100)], "rebalance", 0, "USD"),
    ([pos("A", 0, 50, 60), pos("B", 0, 20, 40)], "new_money", 1000, "USD"),
    ([pos("A", 0, 50, 60), pos("B", 0, 20, 40)], "rebalance", 0, "USD"),
    ([pos("A", 10, 100, 0), pos("B", 10, 50, 100)], "new_money", 500, "GBP"),
    ([pos("A", 10.5, 10, 0), pos("B", 0, 5, 100)], "rebalance", 0, "USD"),
    ([pos("A", 3, 19.99, 33.3), pos("B", 7.25, 101.01, 33.3, "CAD"), pos("C", 1, 0.37, 33.4, "GBP")], "new_money", 0.5, "USD"),
]


@pytest.mark.parametrize("positions,mode,budget,reporting", PARITY_CASES)
def test_web_and_desktop_give_the_same_plan(positions, mode, budget, reporting):
    (_, web), (_, desktop) = both(positions, mode, budget, reporting)
    if "error" in desktop or "error" in web:
        assert web == desktop
        return
    check_invariants(web, mode, budget)
    check_invariants(desktop, mode, budget)
    assert web["warnings"] == desktop["warnings"]
    for key in ("totalCurrent", "pool", "totalBuys", "totalSells", "cashLeft"):
        assert math.isclose(web["summary"][key], desktop["summary"][key], rel_tol=1e-12, abs_tol=1e-9), key
    for a, b in zip(web["results"], desktop["results"], strict=True):
        assert a["action"] == b["action"]
        for key in ("currentValue", "targetWeightNorm", "targetValue", "tradeValue", "tradeValueLocal", "tradeShares", "postTradeShares"):
            assert math.isclose(a[key], b[key], rel_tol=1e-12, abs_tol=1e-9), (a["ticker"], key)
    assert [r["wholeShares"] for r in web["whole"]["results"]] == [r["wholeShares"] for r in desktop["whole"]["results"]]
    for key in ("totalBuys", "totalSells", "cashLeft"):
        assert math.isclose(web["whole"][key], desktop["whole"][key], rel_tol=1e-12, abs_tol=1e-9), key


def test_negative_shares_or_target_withhold_the_plan_in_both_apps():
    # Regression: a negative target (-10%) used to be accepted and normalized, so B (10 held)
    # was told to sell 12 shares (target value -200 vs 1,000 held), ending at -2 shares.
    def row(t, shares, target):
        return {"rowId": t, "ticker": t, "shares": shares, "targetWeight": target, "price": 100, "currency": "USD",
                "fxAvailable": True, "source": {"kind": "manual", "currencyVerified": False, "freshness": "current"}}
    sets = [[row("A", "10", "110"), row("B", "10", "-10")], [row("A", "-10", "50"), row("B", "30", "50")], [row("A", "-5", "0")]]
    cases = [{"op": "valuation", "rows": rows, "acceptStale": False} for rows in sets]
    for c, web in zip(cases, run_js("rebalancer-extras", cases), strict=True):
        desktop = core.assess_valuation(c["rows"])
        assert web == desktop
        assert desktop["ready"] is False and desktop["blockedReason"].startswith("1 of ")
        assert [u["reason"] for u in desktop["unpriced"]] == ["shares and target must be numbers of 0 or more"]
