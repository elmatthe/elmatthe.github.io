"""Latest-price adapters for Marketstack, Finnhub, Alpaca and Massive.

Mirrors assets/js/market-data/providers/quote-adapters.js (Alpaca is desktop-only).
Each adapter builds a request and turns the answer into raw quote fields or a
classified DataError. Every answer is checked against the instrument asked for.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from urllib.parse import quote as urlquote, urlencode

from .catalog import venue_matches
from .errors import DataError

_MINOR = {"GBX": ("GBP", 0.01), "GBp": ("GBP", 0.01), "ZAC": ("ZAR", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


def normalize_currency(raw: object) -> tuple[str | None, float, str | None]:
    text = str(raw if raw is not None else "").strip()
    if text in _MINOR:
        code, scale = _MINOR[text]
        return code, scale, text
    code = text.upper()
    if code in _MINOR:
        c, scale = _MINOR[code]
        return c, scale, text
    return (code, 1.0, text) if re.fullmatch(r"[A-Z]{3}", code) else (None, 1.0, text or None)


def _json(text: str, provider: str):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        raise DataError(f"{provider} response was not JSON.", kind="invalid", provider=provider) from None


def _positive(value: object) -> float | None:
    try:
        n = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if n > 0 and n != float("inf") else None


def _short(text: object) -> str:
    return re.sub(r"\s+", " ", str(text if text is not None else "")).strip()[:400]


def date_in(epoch_ms: float, time_zone: str | None) -> str:
    """Trading date (YYYY-MM-DD) of an epoch time in the listing's time zone."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(time_zone or "America/New_York")
    except Exception:  # noqa: BLE001 - no tz database: fall back to UTC
        tz = dt.timezone.utc
    return dt.datetime.fromtimestamp(epoch_ms / 1000, tz).date().isoformat()


class Marketstack:
    id = "marketstack"
    name = "Marketstack"
    base = "https://api.marketstack.com/v2/eod/latest"

    def request(self, symbol: str, key: str, **_) -> tuple[str, dict]:
        return f"{self.base}?{urlencode({'access_key': key, 'symbols': symbol})}", {}

    def classify(self, status: int, text: str) -> DataError:
        try:
            body = json.loads(text)
        except (ValueError, TypeError):
            body = None
        err = body.get("error") if isinstance(body, dict) else None
        code = str((err or {}).get("code") or "").lower()
        p = {"provider": self.name, "notice": _short((err or {}).get("message")) or None, "status": status}
        if code == "usage_limit_reached":
            return DataError("Marketstack says this key has used its monthly request allowance.", kind="rate_limited", quota_scope="monthly",
                             definitive=True, hint="Marketstack counts every symbol as one request. The allowance renews on your plan's billing date.", **p)
        if code == "rate_limit_reached" or status == 429:
            return DataError("Marketstack asked for slower requests (per-second limit).", kind="rate_limited", quota_scope="burst", retry_after_ms=1500, **p)
        if code in ("invalid_access_key", "missing_access_key", "inactive_user") or status == 401:
            return DataError("Marketstack rejected the access key. Check it in Settings.", kind="auth", definitive=True, **p)
        if code in ("function_access_restricted", "https_access_restricted") or status == 403:
            return DataError("Your Marketstack plan does not include this data.", kind="entitlement", definitive=True, **p)
        if code in ("no_valid_symbols_provided", "invalid_symbols") or status in (404, 422):
            return DataError("Marketstack has no end-of-day data for this symbol.", kind="not_found", definitive=True, **p)
        if status >= 500:
            return DataError(f"Marketstack is unavailable (HTTP {status}).", kind="unavailable", **p)
        return DataError(f"Marketstack refused the request (HTTP {status}{', ' + code if code else ''}).", kind="http", **p)

    def parse(self, text: str, symbol: str, identity: dict) -> dict:
        body = _json(text, self.name)
        if isinstance(body, dict) and body.get("error"):
            raise self.classify(200, text)
        rows = body.get("data") if isinstance(body, dict) else None
        row = next((r for r in rows or [] if str(r.get("symbol", "")).upper() == symbol.upper()), None)
        if not row:
            raise DataError(f"Marketstack returned no end-of-day price for {symbol}.", kind="not_found", definitive=True, provider=self.name)
        if not venue_matches(identity["mic"], row.get("exchange")):
            raise DataError(f"Marketstack's {symbol} is listed on {row.get('exchange') or 'an unknown exchange'}, not {identity.get('venueName')}. It was not used.",
                            kind="ambiguous", definitive=True, provider=self.name)
        currency, scale, raw = normalize_currency(row.get("price_currency"))
        close = _positive(row.get("close"))
        day = str(row.get("date") or "")[:10]
        if close is None:
            raise DataError(f"Marketstack returned no valid close for {symbol}.", kind="invalid", provider=self.name)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise DataError(f"Marketstack returned an invalid date for {symbol}.", kind="invalid", provider=self.name)
        return {"rawPrice": close, "rawCurrency": raw, "currency": currency, "unitScale": scale, "tradingDate": day,
                "asOf": None, "priceType": "eod_close"}


class Finnhub:
    id = "finnhub"
    name = "Finnhub"
    base = "https://finnhub.io/api/v1/quote"

    def request(self, symbol: str, key: str, **_) -> tuple[str, dict]:
        # The desktop sends the key in Finnhub's header, so it never appears in a URL.
        return f"{self.base}?{urlencode({'symbol': symbol})}", {"X-Finnhub-Token": key}

    def classify(self, status: int, text: str) -> DataError:
        try:
            body = json.loads(text)
        except (ValueError, TypeError):
            body = None
        p = {"provider": self.name, "notice": _short(body.get("error") if isinstance(body, dict) else text) or None, "status": status}
        if status == 429:
            return DataError("Finnhub's per-minute limit was reached.", kind="rate_limited", quota_scope="minute", retry_after_ms=5000, **p)
        if status == 401:
            return DataError("Finnhub rejected the API key. Check it in Settings.", kind="auth", definitive=True, **p)
        if status == 403:
            return DataError("Your Finnhub plan does not include this market.", kind="entitlement", definitive=True, **p)
        if status >= 500:
            return DataError(f"Finnhub is unavailable (HTTP {status}).", kind="unavailable", **p)
        return DataError(f"Finnhub refused the request (HTTP {status}).", kind="http", **p)

    def parse(self, text: str, symbol: str, identity: dict) -> dict:
        body = _json(text, self.name)
        if isinstance(body, dict) and body.get("error"):
            err = _short(body["error"])
            raise DataError(f"Finnhub: {err}", kind="entitlement" if re.search(r"access|premium|subscri", err, re.I) else "provider_notice",
                            provider=self.name, notice=err)
        price = _positive((body or {}).get("c"))
        try:
            t = float((body or {}).get("t") or 0)
        except (TypeError, ValueError):
            t = 0
        if price is None or t <= 0:
            raise DataError(f"Finnhub has no quote for {symbol}.", kind="not_found", definitive=True, provider=self.name)
        return {"rawPrice": price, "rawCurrency": None, "currency": None, "unitScale": 1.0,
                "tradingDate": date_in(t * 1000, identity.get("timeZone")),
                "asOf": dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat().replace("+00:00", "Z"), "priceType": "last_trade"}


class Alpaca:
    id = "alpaca"
    name = "Alpaca"
    base = "https://data.alpaca.markets/v2/stocks"

    def request(self, symbol: str, key: str, secret: str = "", feed: str = "iex", **_) -> tuple[str, dict]:
        return (f"{self.base}/{urlquote(symbol)}/trades/latest?{urlencode({'feed': feed})}",
                {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret})

    def classify(self, status: int, text: str) -> DataError:
        try:
            body = json.loads(text)
        except (ValueError, TypeError):
            body = None
        p = {"provider": self.name, "notice": _short(body.get("message") if isinstance(body, dict) else "") or None, "status": status}
        if status == 429:
            return DataError("Alpaca's per-minute limit was reached.", kind="rate_limited", quota_scope="minute", retry_after_ms=3000, **p)
        if status in (401, 403) and re.search(r"subscription|sip|permit", str(p["notice"] or ""), re.I):
            return DataError("Your Alpaca plan does not include this feed.", kind="entitlement", definitive=True, **p)
        if status in (401, 403):
            return DataError("Alpaca rejected the key ID or secret. Check them in Settings.", kind="auth", definitive=True, **p)
        if status in (404, 422):
            return DataError("Alpaca has no data for this symbol.", kind="not_found", definitive=True, **p)
        if status >= 500:
            return DataError(f"Alpaca is unavailable (HTTP {status}).", kind="unavailable", **p)
        return DataError(f"Alpaca refused the request (HTTP {status}).", kind="http", **p)

    def parse(self, text: str, symbol: str, identity: dict) -> dict:
        body = _json(text, self.name)
        trade = (body or {}).get("trade") if isinstance(body, dict) else None
        if not isinstance(trade, dict) or str(body.get("symbol", symbol)).upper() != symbol.upper():
            raise DataError(f"Alpaca has no latest trade for {symbol}.", kind="not_found", definitive=True, provider=self.name)
        price = _positive(trade.get("p"))
        stamp = str(trade.get("t") or "")
        try:
            when = dt.datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", stamp).replace("Z", "+00:00"))
        except ValueError:
            when = None
        if price is None or when is None:
            raise DataError(f"Alpaca returned an invalid trade for {symbol}.", kind="invalid", provider=self.name)
        return {"rawPrice": price, "rawCurrency": None, "currency": None, "unitScale": 1.0,
                "tradingDate": date_in(when.timestamp() * 1000, identity.get("timeZone")),
                "asOf": when.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "priceType": "last_trade"}


class Massive:
    id = "massive"
    name = "Massive"
    base = "https://api.massive.com/v2/aggs/ticker"

    def request(self, symbol: str, key: str, **_) -> tuple[str, dict]:
        return f"{self.base}/{urlquote(symbol)}/prev?adjusted=false", {"Authorization": f"Bearer {key}"}

    def classify(self, status: int, text: str) -> DataError:
        try:
            body = json.loads(text)
        except (ValueError, TypeError):
            body = None
        msg = (body.get("message") or body.get("error")) if isinstance(body, dict) else ""
        p = {"provider": self.name, "notice": _short(msg) or None, "status": status}
        if status == 429:
            return DataError("Massive's per-minute limit was reached.", kind="rate_limited", quota_scope="minute", retry_after_ms=12000, **p)
        if status == 401:
            return DataError("Massive rejected the API key.", kind="auth", definitive=True, **p)
        if status == 403:
            return DataError("Your Massive plan does not include this data.", kind="entitlement", definitive=True, **p)
        if status == 404:
            return DataError("Massive has no data for this symbol.", kind="not_found", definitive=True, **p)
        if status >= 500:
            return DataError(f"Massive is unavailable (HTTP {status}).", kind="unavailable", **p)
        return DataError(f"Massive refused the request (HTTP {status}).", kind="http", **p)

    def parse(self, text: str, symbol: str, identity: dict) -> dict:
        body = _json(text, self.name)
        results = body.get("results") if isinstance(body, dict) else None
        bar = results[0] if isinstance(results, list) and results else None
        if not bar or str(bar.get("T") or body.get("ticker") or "").upper() != symbol.upper():
            raise DataError(f"Massive has no previous close for {symbol}.", kind="not_found", definitive=True, provider=self.name)
        close = _positive(bar.get("c"))
        t = _positive(bar.get("t"))
        if close is None or t is None:
            raise DataError(f"Massive returned an invalid bar for {symbol}.", kind="invalid", provider=self.name)
        return {"rawPrice": close, "rawCurrency": None, "currency": None, "unitScale": 1.0,
                "tradingDate": date_in(t, identity.get("timeZone")), "asOf": None, "priceType": "previous_close"}


ADAPTERS = {"marketstack": Marketstack(), "finnhub": Finnhub(), "alpaca": Alpaca(), "massive": Massive()}
