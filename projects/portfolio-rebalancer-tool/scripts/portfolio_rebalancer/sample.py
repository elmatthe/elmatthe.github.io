"""The sample portfolio, identical to the web app's assets/js/portfolio-rebalancer/sample.js.

Fourteen ordinary holdings in one list. The first ten are the owner's Questrade
holdings (symbols, shares and order) with their earlier targets scaled from 100% to
90%; the last four are international listings (Tokyo in JPY, Xetra in EUR, London
quoted in pence, Shanghai in CNY) with one share and a 2.5% target each, priced,
valued and planned exactly like the others. Targets total exactly 100.0%.
There are NO prices here.

``sampleTag`` marks the four international examples so "Remove international
examples" can remove them while they are still exactly as loaded. It is provenance
only and changes no pricing, valuation or plan rule.
"""
from __future__ import annotations

INTERNATIONAL_EXAMPLE_TAG = "international-example"
SAMPLE_PORTFOLIO = {
    "schema": "rb.sample-portfolio.v2",
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
        {"ticker": "7203.T", "shares": 1, "targetWeight": 2.5, "accountType": "", "sampleTag": INTERNATIONAL_EXAMPLE_TAG},
        {"ticker": "SAP.DE", "shares": 1, "targetWeight": 2.5, "accountType": "", "sampleTag": INTERNATIONAL_EXAMPLE_TAG},
        {"ticker": "VOD.L", "shares": 1, "targetWeight": 2.5, "accountType": "", "sampleTag": INTERNATIONAL_EXAMPLE_TAG},
        {"ticker": "600519.SS", "shares": 1, "targetWeight": 2.5, "accountType": "", "sampleTag": INTERNATIONAL_EXAMPLE_TAG},
    ],
}


def target_total_basis_points(rows) -> int:
    """Target weights summed in hundredths of a percent, so the total is exact."""
    return sum(round(float(r["targetWeight"]) * 100) for r in rows)


def is_unchanged_international_example(row) -> bool:
    """True while a loaded international example still has its loaded ticker, shares,
    target and account and no price the user supplied. A matching security the user
    added themselves has no sample tag and is never matched."""
    if getattr(row, "sample_tag", None) != INTERNATIONAL_EXAMPLE_TAG:
        return False
    original = next((r for r in SAMPLE_PORTFOLIO["rows"] if r.get("sampleTag") == INTERNATIONAL_EXAMPLE_TAG and r["ticker"] == row.sample_ticker), None)
    if original is None:
        return False
    same = lambda a, b: str("" if a is None else a).strip() == str("" if b is None else b).strip()  # noqa: E731
    return (same(row.ticker, original["ticker"]) and same(row.shares, original["shares"]) and same(row.target, original["targetWeight"])
            and same(row.account, original["accountType"]) and not row.manual)
