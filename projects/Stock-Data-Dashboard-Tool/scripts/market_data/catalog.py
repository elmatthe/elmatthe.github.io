"""Provider catalog for the desktop apps; mirrors assets/js/market-data/catalog.js.

Source of every fact: _tools/PROVIDER_MATRIX.md (checked 2026-11-03).
_tools/tests/test_market_data_parity.py checks that routing, plans, coverage and
symbol translation agree with the web catalog.
"""
from __future__ import annotations

import math
import re

CATALOG_VERSION = "2026-11-03.1"

US_FAMILY = ["US", "XNYS", "XNAS", "ARCX", "BATS", "XASE"]
YAHOO_SUFFIX = {"XTSE": ".TO", "XTSX": ".V", "NEOE": ".NE", "XCNQ": ".CN", "XLON": ".L", "XETR": ".DE", "XFRA": ".F",
                "XPAR": ".PA", "XAMS": ".AS", "XMIL": ".MI", "XSWX": ".SW", "XTKS": ".T", "XSHG": ".SS", "XSHE": ".SZ",
                "XHKG": ".HK", "XASX": ".AX", "XBOM": ".BO"}
VENUE_ALIASES = {"XTSE": ["XTSE"], "XTSX": ["XTSX", "XTNX"], "NEOE": ["NEOE", "XNEO", "NEOC", "NEON"], "XCNQ": ["XCNQ"],
                 "XLON": ["XLON"], "XETR": ["XETR", "XETRA"], "XFRA": ["XFRA"], "XPAR": ["XPAR"], "XAMS": ["XAMS"],
                 "XMIL": ["XMIL"], "XSWX": ["XSWX"], "XTKS": ["XTKS", "XJPX"], "XSHG": ["XSHG"], "XSHE": ["XSHE"],
                 "XHKG": ["XHKG"], "XASX": ["XASX"], "XBOM": ["XBOM"]}
US_EXCHANGE_CODES = ["XNYS", "XNAS", "ARCX", "BATS", "XASE", "IEXG", "XNGS", "XNMS", "XNCM", "XCBO", "EDGX", "AMEX", "NYSE", "NASDAQ"]
AV_SUFFIX = {"XTSE": ".TRT", "XTSX": ".TRV", "XLON": ".LON", "XETR": ".DEX", "XSHG": ".SHH", "XSHE": ".SHZ", "XBOM": ".BSE"}


def is_us_venue(mic: str | None) -> bool:
    return mic in US_FAMILY


def venue_matches(expected_mic: str, returned: object) -> bool:
    code = str(returned or "").upper()
    if not code:
        return False
    if is_us_venue(expected_mic):
        return code in US_EXCHANGE_CODES
    return code in VENUE_ALIASES.get(expected_mic, [expected_mic])


def _av_symbol(identity: dict, plan: dict | None = None) -> str | None:
    local = identity.get("localSymbol")
    if not local:
        return None
    if is_us_venue(identity.get("mic")):
        return local
    if local.endswith(".U"):
        return None
    suffix = AV_SUFFIX.get(identity.get("mic"))
    return local + suffix if suffix else None


def _yahoo_symbol(identity: dict, hyphen_classes: bool) -> str | None:
    local = identity.get("localSymbol")
    if not local:
        return None
    if is_us_venue(identity.get("mic")):
        return local.replace(".", "-") if hyphen_classes else local
    if local.endswith(".U"):
        return None
    suffix = YAHOO_SUFFIX.get(identity.get("mic"))
    return local + suffix if suffix else None


def _finnhub_symbol(identity: dict, plan: dict | None = None) -> str | None:
    if not identity.get("localSymbol"):
        return None
    if is_us_venue(identity.get("mic")):
        return identity["localSymbol"]
    if not (plan and plan.get("international")) or identity.get("currencyEvidence") != "curated_reference":
        return None
    return _yahoo_symbol(identity, False)


def _us_only(identity: dict, plan: dict | None = None) -> str | None:
    return identity.get("localSymbol") if identity.get("localSymbol") and is_us_venue(identity.get("mic")) else None


PROVIDERS: dict[str, dict] = {
    "alphavantage": {
        "id": "alphavantage", "name": "Alpha Vantage", "status": {"browser": "enabled", "desktop": "enabled"},
        "keyHelpUrl": "https://www.alphavantage.co/support/#api-key", "termsUrl": "https://www.alphavantage.co/terms_of_service/",
        "keyPattern": r"^[A-Za-z0-9]{8,64}$", "licence": "Personal, non-commercial use of your own key.",
        "plans": [
            {"id": "free", "label": "Free: 25 requests per day", "limits": {"perDay": 25}, "pacing": {"minSpacingMs": 1200, "minGapAfterMs": 1100, "jitterMs": 300}},
            {"id": "premium", "label": "Premium: requests per minute of your plan", "limits": {"perMinute": 75}, "editable": "perMinute", "pacing": {"minGapAfterMs": 0}},
        ],
        "priceType": "latest_trading_day", "priceLabel": "latest price for the trading day shown (end of day on free keys)",
        "coverage": lambda plan: US_FAMILY + list(AV_SUFFIX), "symbolFor": _av_symbol,
        "requestCost": lambda identity, listing_cached=False: 1 if identity.get("currencyEvidence") == "curated_reference" or listing_cached else 2,
        "gaps": {},
    },
    "marketstack": {
        "id": "marketstack", "name": "Marketstack", "status": {"browser": "enabled", "desktop": "enabled"},
        "keyHelpUrl": "https://marketstack.com/signup/free", "termsUrl": "https://marketstack.com/terms",
        "keyPattern": r"^[A-Za-z0-9]{16,64}$",
        "licence": "Free plan: non-commercial testing and evaluation (APILayer agreement §16(c)); paid plans for ongoing use.",
        "plans": [
            {"id": "free", "label": "Free: 100 requests per month", "limits": {"perMonth": 100}, "pacing": {"minSpacingMs": 250}},
            {"id": "basic", "label": "Basic: 10,000 requests per month", "limits": {"perMonth": 10000}, "pacing": {"minSpacingMs": 250}},
            {"id": "custom", "label": "Other paid plan: monthly requests of your plan", "limits": {"perMonth": 100000}, "editable": "perMonth", "pacing": {"minSpacingMs": 250}},
        ],
        "priceType": "eod_close", "priceLabel": "end-of-day close (unadjusted)",
        "coverage": lambda plan: US_FAMILY + list(YAHOO_SUFFIX), "symbolFor": lambda identity, plan=None: _yahoo_symbol(identity, True),
        "requestCost": lambda identity, listing_cached=False: 1,
        "gaps": {"NEOE:YNVD": "not in Marketstack's end-of-day ticker list (checked 2026-11-03)"},
    },
    "finnhub": {
        "id": "finnhub", "name": "Finnhub", "status": {"browser": "enabled", "desktop": "enabled"},
        "keyHelpUrl": "https://finnhub.io/register", "termsUrl": "https://finnhub.io/terms-of-service",
        "keyPattern": r"^[A-Za-z0-9]{16,64}$", "licence": "Strictly personal use of your own key; no sharing or redistribution.",
        "plans": [
            {"id": "free", "label": "Free: 60 calls per minute, US listings", "limits": {"perMinute": 60}, "pacing": {"perMinute": 55, "minSpacingMs": 50}},
            {"id": "paid", "label": "Paid: calls per minute of your plan", "limits": {"perMinute": 150}, "editable": "perMinute", "pacing": {"minSpacingMs": 50}, "international": "optional"},
        ],
        "priceType": "last_trade", "priceLabel": "last price (real-time for US listings during market hours)",
        "coverage": lambda plan: US_FAMILY + list(YAHOO_SUFFIX) if plan and plan.get("international") else list(US_FAMILY),
        "symbolFor": _finnhub_symbol, "requestCost": lambda identity, listing_cached=False: 1, "gaps": {},
    },
    "alpaca": {
        "id": "alpaca", "name": "Alpaca", "status": {"browser": "unsupported", "desktop": "enabled"},
        "unsupportedReason": "Alpaca keys are brokerage-account credentials (key ID and secret) that can also place trades. This website does not keep trading credentials in browser storage; Alpaca is available in the desktop apps.",
        "keyHelpUrl": "https://app.alpaca.markets/", "termsUrl": "https://alpaca.markets/disclosures",
        "keyPattern": r"^[A-Za-z0-9]{16,64}$", "secretPattern": r"^[A-Za-z0-9/+=]{20,128}$",
        "licence": "Personal use only; no redistribution.",
        "plans": [
            {"id": "basic", "label": "Basic: 200 calls per minute, IEX exchange only", "limits": {"perMinute": 200}, "pacing": {"perMinute": 190}, "feed": "iex"},
            {"id": "algo-plus", "label": "Algo Trader Plus: all US exchanges (SIP)", "limits": {"perMinute": 10000}, "pacing": {"minSpacingMs": 10}, "feed": "sip"},
        ],
        "priceType": "last_trade", "priceLabel": "last trade (IEX only on the Basic plan; not the consolidated US price)",
        "coverage": lambda plan: list(US_FAMILY), "symbolFor": _us_only, "requestCost": lambda identity, listing_cached=False: 1, "gaps": {},
    },
    "massive": {
        "id": "massive", "name": "Massive", "status": {"browser": "deferred", "desktop": "deferred"},
        "unsupportedReason": "Massive's Market Data Terms (§1) say its data may not be used to build an application for end users other than the account holder. This integration stays off until the site owner has written confirmation from Massive.",
        "keyHelpUrl": "https://massive.com/dashboard/keys", "termsUrl": "https://massive.com/legal/market-data-terms",
        "keyPattern": r"^[A-Za-z0-9_-]{16,64}$", "licence": "Personal, non-business use; no application for other end users (Market Data Terms §1).",
        "plans": [
            {"id": "basic", "label": "Stocks Basic: 5 calls per minute, end of day", "limits": {"perMinute": 5}, "pacing": {"perMinute": 5, "minSpacingMs": 250}},
            {"id": "starter", "label": "Stocks Starter or higher", "limits": {"perMinute": 100}, "editable": "perMinute", "pacing": {"minSpacingMs": 100}},
        ],
        "priceType": "previous_close", "priceLabel": "previous session close (unadjusted)",
        "coverage": lambda plan: list(US_FAMILY), "symbolFor": _us_only, "requestCost": lambda identity, listing_cached=False: 1, "gaps": {},
    },
}
PROVIDER_IDS = list(PROVIDERS)

ROUTES = {
    "US": ["finnhub", "alpaca", "alphavantage", "marketstack", "massive"],
    "XTSE": ["alphavantage", "marketstack", "finnhub"],
    "XTSX": ["alphavantage", "marketstack", "finnhub"],
    "NEOE": ["marketstack", "finnhub"],
    "XLON": ["alphavantage", "marketstack", "finnhub"],
    "XETR": ["alphavantage", "marketstack", "finnhub"],
    "XSHG": ["alphavantage", "marketstack", "finnhub"],
    "XSHE": ["alphavantage", "marketstack", "finnhub"],
    "XBOM": ["alphavantage", "marketstack"],
    "default": ["marketstack", "finnhub"],
}


def provider_available(pid: str, platform: str = "desktop") -> bool:
    return PROVIDERS.get(pid, {}).get("status", {}).get(platform) == "enabled"


def providers_for(platform: str = "desktop") -> list[str]:
    return [pid for pid in PROVIDER_IDS if provider_available(pid, platform)]


def key_valid(pid: str, key: object) -> bool:
    return isinstance(key, str) and bool(re.fullmatch(PROVIDERS[pid]["keyPattern"], key.strip()))


def plan_of(pid: str, plan_id: str | None = None, overrides: dict | None = None) -> dict:
    overrides = overrides or {}
    provider = PROVIDERS[pid]
    plan = next((p for p in provider["plans"] if p["id"] == plan_id), provider["plans"][0])
    limits = dict(plan["limits"])
    editable = plan.get("editable")
    limit = overrides.get("limit")
    if editable and isinstance(limit, (int, float)) and math.isfinite(limit) and limit > 0:
        limits[editable] = int(limit)
    pacing = dict(plan["pacing"])
    if editable == "perMinute":
        pacing["perMinute"] = max(1, int(limits["perMinute"] * 0.95))
        pacing["minSpacingMs"] = max(pacing.get("minSpacingMs", 0), math.ceil(60000 / limits["perMinute"]))
    international = bool(overrides.get("international")) if plan.get("international") == "optional" else bool(plan.get("international"))
    return {**plan, "limits": limits, "pacing": pacing, "international": international}


def coverage_gap(pid: str, identity: dict | None, plan: dict | None) -> str | None:
    provider = PROVIDERS[pid]
    if not identity or identity.get("status") != "resolved":
        return "the ticker is not resolved"
    if identity.get("canonicalId") in provider["gaps"]:
        return provider["gaps"][identity["canonicalId"]]
    if identity.get("mic") not in provider["coverage"](plan):
        free = " on the free plan" if not plan or plan.get("id") == "free" else ""
        return f"{provider['name']} does not cover {identity.get('venueName') or identity.get('mic')}{free}"
    if not provider["symbolFor"](identity, plan):
        return f"{provider['name']} has no documented symbol for this listing"
    return None


def route_instrument(identity: dict, mode: str = "auto", configured: list[str] | None = None,
                     plans: dict | None = None, platform: str = "desktop") -> dict:
    """{"candidates": [{"id", "symbol"}], "skipped": [{"id", "reason"}]} in routing order."""
    configured = configured or []
    plans = plans or {}
    mic = (identity or {}).get("mic")
    if mode == "auto":
        order = ROUTES["US"] if is_us_venue(mic) else ROUTES.get(mic, ROUTES["default"])
    else:
        order = [mode]
    candidates, skipped = [], []
    for pid in order:
        if pid not in PROVIDERS:
            continue
        if not provider_available(pid, platform):
            if mode != "auto":
                skipped.append({"id": pid, "reason": PROVIDERS[pid].get("unsupportedReason", "not available here")})
            continue
        if pid not in configured:
            skipped.append({"id": pid, "reason": f"no {PROVIDERS[pid]['name']} key saved"})
            continue
        plan = plans.get(pid) or plan_of(pid)
        gap = coverage_gap(pid, identity, plan)
        if gap:
            skipped.append({"id": pid, "reason": gap})
            continue
        candidates.append({"id": pid, "symbol": PROVIDERS[pid]["symbolFor"](identity, plan)})
    return {"candidates": candidates, "skipped": skipped}
