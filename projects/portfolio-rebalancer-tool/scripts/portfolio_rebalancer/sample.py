"""The sample portfolio, identical to the web app's assets/js/portfolio-rebalancer/sample.js.

Fourteen ordinary holdings in one list. The first ten are the owner's Questrade
holdings (symbols, shares and order) with their earlier targets scaled from 100% to
90%; the last four are international listings (Tokyo in JPY, Xetra in EUR, London
quoted in pence, Shanghai in CNY) with one share and a 2.5% target each, priced,
valued and planned exactly like the others. Targets total exactly 100.0%.
There are NO prices here.
"""
from __future__ import annotations

SAMPLE_PORTFOLIO = {
    "schema": "rb.sample-portfolio.v3",
    "reportingCurrency": "CAD",
    "mode": "new_money",
    "budget": 3000,
    "rows": [
        {"ticker": "VEQT.TO", "shares": 305, "targetWeight": 63, "accountType": ""},
        {"ticker": "CNQ.TO", "shares": 48, "targetWeight": 9, "accountType": ""},
        {"ticker": "XQQ.TO", "shares": 27, "targetWeight": 6.3, "accountType": ""},
        {"ticker": "HEWB.TO", "shares": 14, "targetWeight": 4.5, "accountType": ""},
        {"ticker": "AAPL", "shares": 2, "targetWeight": 1.8, "accountType": ""},
        {"ticker": "VFV.TO", "shares": 8, "targetWeight": 0.9, "accountType": ""},
        {"ticker": "SPCX", "shares": 1, "targetWeight": 0.9, "accountType": ""},
        {"ticker": "CBRS", "shares": 4, "targetWeight": 0.9, "accountType": ""},
        {"ticker": "YNVD.NE", "shares": 4, "targetWeight": 1.8, "accountType": ""},
        {"ticker": "VST", "shares": 1, "targetWeight": 0.9, "accountType": ""},
        {"ticker": "7203.T", "shares": 1, "targetWeight": 2.5, "accountType": ""},
        {"ticker": "SAP.DE", "shares": 1, "targetWeight": 2.5, "accountType": ""},
        {"ticker": "VOD.L", "shares": 1, "targetWeight": 2.5, "accountType": ""},
        {"ticker": "600519.SS", "shares": 1, "targetWeight": 2.5, "accountType": ""},
    ],
}


def target_total_basis_points(rows) -> int:
    """Target weights summed in hundredths of a percent, so the total is exact."""
    return sum(round(float(r["targetWeight"]) * 100) for r in rows)
