"""Alpha Vantage: symbol rules, ordered notice classification and response parsing.

Mirrors assets/js/market-data/providers/alphavantage.js. The fixture file
_tools/tests/fixtures/providers/alphavantage-notices.json is run against both.

Alpha Vantage reports limits as HTTP-200 JSON notices whose wording has changed
several times; the per-second "burst" notice ALSO mentions "(25 requests per day)".
The rules are therefore ordered: burst first (retried, never stored), then the
daily-limit sentence itself (stored until 00:00 UTC), then premium, then demo key;
anything else is a provider notice, never a definitive limit.
"""
from __future__ import annotations

import json
import re

from .errors import DataError

AV_PROVIDER = "Alpha Vantage"
AV_BASE = "https://www.alphavantage.co/query"
AV_DAILY_LIMIT = 25
AV_BURST_BACKOFF_S = (2.0, 5.0, 10.0)
KEY_PATTERN = re.compile(r"^[A-Za-z0-9]{8,64}$")
MINOR_UNITS = {"GBX": ("GBP", 0.01), "GBp": ("GBP", 0.01), "ZAC": ("ZAR", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}

_RULES = [
    (re.compile(r"spreading out|per[- ]second|\bburst\b|call frequency|requests? per minute|calls? per minute", re.I), "rate_limited", "burst"),
    (re.compile(r"rate limit is \d+ (?:requests|calls) per day|remove all daily rate limits|daily (?:rate|request) limit (?:is|has been) (?:reached|exceeded)", re.I), "rate_limited", "daily"),
    (re.compile(r"premium endpoint|premium feature|premium (?:plan )?(?:only|required)", re.I), "entitlement", None),
    (re.compile(r"\bdemo\b", re.I), "auth", None),
]


def valid_key(key: object) -> bool:
    return isinstance(key, str) and bool(KEY_PATTERN.match(key.strip()))


def classify_notice(text: str) -> tuple[str, str | None]:
    for pattern, kind, scope in _RULES:
        if pattern.search(text or ""):
            return kind, scope
    return "provider_notice", None


def redact_key(message: object, key: str = "") -> str:
    text = re.sub(r"(api ?key (?:as|is|=)\s*)[A-Za-z0-9]+", r"\1[redacted]", str(message if message is not None else ""), flags=re.I)
    if key and len(key) >= 4:
        text = text.replace(key, "[redacted]")
    return text


def _notice(text: str) -> str:
    return re.sub(r"\s+", " ", redact_key(text)).strip()[:400]


def parse_body(text: str, symbol: str = "") -> dict:
    """Returns the parsed body, or raises a classified DataError for a notice/error body."""
    try:
        body = json.loads(text)
    except (ValueError, TypeError):
        raise DataError("Alpha Vantage response was not JSON", kind="invalid", provider=AV_PROVIDER) from None
    if not isinstance(body, dict):
        raise DataError("Alpha Vantage response was empty", kind="invalid", provider=AV_PROVIDER)
    info = str(body.get("Information") or body.get("Note") or "")
    if info:
        kind, scope = classify_notice(info)
        said = _notice(info)
        if kind == "rate_limited" and scope == "burst":
            raise DataError("Alpha Vantage asked for slower requests (its per-second limit). This is temporary.", kind=kind,
                            quota_scope=scope, provider=AV_PROVIDER, retry_after_ms=2000, notice=said,
                            hint="Wait a few seconds and retry; requests are spaced automatically.")
        if kind == "rate_limited":
            raise DataError("Alpha Vantage says this key has reached its daily request limit.", kind=kind, quota_scope=scope,
                            definitive=True, provider=AV_PROVIDER, notice=said,
                            hint="Alpha Vantage counts every use of the key (other devices and apps included). Its free plan allows 25 requests per day.")
        if kind == "entitlement":
            raise DataError(f"{symbol + ': ' if symbol else ''}this data is a premium Alpha Vantage feature, not available with a free key.",
                            kind=kind, definitive=True, provider=AV_PROVIDER, notice=said)
        if kind == "auth":
            raise DataError("The Alpha Vantage demo key only works for the documentation examples. Add your own free key.",
                            kind=kind, definitive=True, provider=AV_PROVIDER, notice=said)
        raise DataError(f"Alpha Vantage sent a notice instead of data: {said[:160]}", kind="provider_notice", provider=AV_PROVIDER,
                        notice=said, hint="This is not treated as a daily limit. Retry later.")
    if body.get("Error Message"):
        message = str(body["Error Message"])
        if re.search("apikey", message, re.I):
            raise DataError("Alpha Vantage rejected the API key. Check the key in Settings.", kind="auth", definitive=True,
                            provider=AV_PROVIDER, notice=_notice(message))
        raise DataError(f"{symbol or 'Symbol'}: Alpha Vantage has no data for this symbol.", kind="not_found", definitive=True,
                        provider=AV_PROVIDER, notice=_notice(message))
    return body


def currency_from_search(raw: object) -> tuple[str | None, float, str | None]:
    """(ISO currency, unit scale, raw text) from a SYMBOL_SEARCH currency field."""
    text = str(raw or "").strip()
    if text in MINOR_UNITS:
        code, scale = MINOR_UNITS[text]
        return code, scale, text
    code = text.upper()
    if code in MINOR_UNITS:
        c, scale = MINOR_UNITS[code]
        return c, scale, text
    return (code, 1.0, text) if re.fullmatch(r"[A-Z]{3}", code) else (None, 1.0, text or None)


def pick_listing(body: dict, av_symbol: str) -> dict | None:
    """The SYMBOL_SEARCH match for exactly av_symbol, or None."""
    for m in body.get("bestMatches") or []:
        if str(m.get("1. symbol", "")).upper() == av_symbol.upper():
            currency, scale, raw = currency_from_search(m.get("8. currency"))
            return {"avSymbol": av_symbol, "name": str(m.get("2. name") or "")[:120] or None, "region": m.get("4. region"),
                    "currency": currency, "unitScale": scale, "rawCurrency": raw}
    return None


def parse_global_quote(body: dict, symbol: str) -> tuple[float, str | None]:
    """(raw price, trading date) from a GLOBAL_QUOTE body."""
    q = body.get("Global Quote")
    if not isinstance(q, dict) or not q:
        raise DataError(f"{symbol}: Alpha Vantage returned no quote for this symbol.", kind="not_found", definitive=True, provider=AV_PROVIDER)
    try:
        price = float(str(q.get("05. price", "")).replace("%", ""))
    except ValueError:
        price = float("nan")
    day = str(q.get("07. latest trading day") or "")
    if not (price > 0) or price != price or price == float("inf"):
        raise DataError(f"{symbol}: Alpha Vantage returned no valid price.", kind="invalid", provider=AV_PROVIDER)
    return price, day if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else None


def parse_series(body: dict, symbol: str, kind: str, unit_scale: float = 1.0) -> list[tuple[str, float | None, float | None]]:
    """[(YYYY-MM-DD, close, adjusted close)] ascending, from TIME_SERIES_DAILY or WEEKLY_ADJUSTED."""
    key = "Weekly Adjusted Time Series" if kind == "weekly" else "Time Series (Daily)"
    series = body.get(key)
    if not isinstance(series, dict):
        raise DataError(f"{symbol}: Alpha Vantage returned no price history.", kind="not_found", definitive=True, provider=AV_PROVIDER)

    def positive(v: object) -> float | None:
        try:
            n = float(v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return n * unit_scale if n > 0 and n != float("inf") else None

    out = []
    for day in sorted(series):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            continue
        row = series[day]
        close = positive(row.get("4. close"))
        adj = positive(row.get("5. adjusted close")) if kind == "weekly" else None
        if close is not None or adj is not None:
            out.append((day, close, adj))
    return out
