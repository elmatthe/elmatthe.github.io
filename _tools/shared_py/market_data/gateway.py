"""Yahoo Finance through the site's market-data gateway, for the desktop apps.

Mirrors assets/js/market-data/keyless.js: the same gateway contract
(_services/market-data-gateway: md-gateway.health.v1 / quote.v1 / history.v1 /
error.v1), the same symbol mapping, the same checks on every answer and the same
"slow is better than blocked" rules:

* requests go one at a time, at least 0.35 s apart (all threads of the program);
* answers are reused for 10 minutes (quotes) and 12 hours (history);
* after any "slow down" answer (rate limit, busy, Yahoo refusing the gateway), and
  after an outage when the gateway's own circuit breaker is open, nothing more is sent
  until the time the gateway gives has passed; that pause is saved in
  files/runtime/yahoo-pause.json, so a restart honours it;
* only a network error or timeout reaching the gateway is retried, once; a refusal or
  rate limit is never retried.

Requests carry only a ticker symbol and a history range: never holdings, keys or
account data. The desktop apps send no Origin header; the owner's production gateway
accepts that (ALLOW_NO_ORIGIN). No browser, extension or local web server is needed.

The gateway address is DEFAULT_GATEWAY_URL (kept equal to the website's
_data/market_data.yml by _tools/tests/test_market_data_parity.py), or the
MD_GATEWAY_URL environment variable; empty means "not set up" (MD_GATEWAY_URL="" switches
Yahoo Finance off for one run, which the tests use so they never reach the live gateway).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlencode, urlsplit

from .errors import DataError

DEFAULT_GATEWAY_URL = "https://market-data-gateway.elmatthe.workers.dev"
GATEWAY_ID = "yahoo"
GATEWAY_NAME = "Yahoo Finance"
GATEWAY_VIA = "this site's data gateway"
PRICE_TYPE = "regular_market_price"
SCHEMAS = {"health": "md-gateway.health.v1", "quote": "md-gateway.quote.v1", "history": "md-gateway.history.v1", "error": "md-gateway.error.v1"}

# Venues the gateway serves (MIC -> exchange suffix); equal to keyless.js KEYLESS_VENUES.
VENUES = {"US": "", "XTSE": ".TO", "XTSX": ".V", "NEOE": ".NE", "XLON": ".L", "XETR": ".DE", "XPAR": ".PA", "XAMS": ".AS",
          "XSWX": ".SW", "XTKS": ".T", "XSHG": ".SS", "XSHE": ".SZ", "XHKG": ".HK", "XASX": ".AX"}
_US_FAMILY = ["US", "XNYS", "XNAS", "ARCX", "BATS", "XASE"]
HISTORY_BUCKETS = [("1mo", 31), ("3mo", 92), ("6mo", 184), ("1y", 366), ("2y", 731), ("5y", 1827)]
QUOTE_FRESH_S = 600
HISTORY_FRESH_S = 12 * 3600
REQUEST_SPACING_S = 0.35
MIN_PAUSE_S = {"rate_limited": 60, "unavailable": 30, "timeout": 30}
MAX_PAUSE_S = 2 * 3600
_SYMBOL = re.compile(r"^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){0,13}(?:\.[A-Z]{1,2})?$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MESSAGES = {
    "not_configured": "Yahoo Finance is not available on this site yet.",
    "unreachable": "Yahoo Finance is not available right now: this site's data gateway could not be reached.",
    "disabled": "Yahoo Finance is switched off on this site at the moment.",
    "checking": "Yahoo Finance is still being checked.",
}
AVAILABILITY_REASON = {"checking": "still being checked", "not_configured": "not available on this site yet",
                       "disabled": "switched off on this site at the moment", "unreachable": "unavailable because this site's data gateway could not be reached"}

# Gateway error codes -> (kind, message, extra); identical to keyless.js ERRORS.
# "pause": True pauses always; "breaker" only when Retry-After is a minute or more.
ERRORS = {
    "source_disabled": ["unavailable", "Yahoo Finance is switched off on this site at the moment.", {"definitive": True}],
    "origin_not_allowed": ["unavailable", "This site's data gateway does not accept requests from this page.", {"definitive": True}],
    "rate_limited": ["rate_limited", "Too many Yahoo Finance requests from this browser. Requests pause for a minute.", {"quotaScope": "minute", "pause": True}],
    "throttled": ["rate_limited", "The data gateway's shared Yahoo Finance budget is used up for the moment. Requests pause briefly.", {"quotaScope": "minute", "pause": True}],
    "upstream_rate_limited": ["rate_limited", "Yahoo Finance asked this site to slow down. Requests to it pause for a while.", {"quotaScope": "minute", "pause": True}],
    "busy": ["unavailable", "The data gateway is busy. Requests pause briefly.", {"pause": True}],
    "upstream_unavailable": ["unavailable", "Yahoo Finance is unavailable right now.", {"pause": "breaker"}],
    "upstream_timeout": ["timeout", "Yahoo Finance did not answer in time.", {"pause": "breaker"}],
    "upstream_blocked": ["unavailable", "Yahoo Finance refused the data gateway's request. Requests to it pause for a while.", {"pause": True}],
    "upstream_rejected": ["unavailable", "Yahoo Finance refused the request."],
    "upstream_invalid": ["invalid", "Yahoo Finance returned data that failed its checks, so it was not used."],
    "symbol_not_found": ["not_found", "Yahoo Finance has no data for this symbol.", {"definitive": True}],
    "no_price": ["not_found", "Yahoo Finance returned no current price for this listing.", {"definitive": True}],
    "no_history": ["not_found", "Yahoo Finance returned no price history for this listing and period.", {"definitive": True}],
    "listing_mismatch": ["ambiguous", "Yahoo Finance answered for a different listing or exchange; the answer was not used.", {"definitive": True}],
    "currency_mismatch": ["currency_mismatch", "Yahoo Finance reported a currency this listing does not trade in; the answer was not used.", {"definitive": True}],
    "currency_unknown": ["currency_mismatch", "Yahoo Finance did not state the currency; the answer was not used.", {"definitive": True}],
    "unsupported_instrument": ["not_covered", "Yahoo Finance data here does not include this kind of instrument (index, currency, future).", {"definitive": True}],
    "unsupported_listing": ["not_covered", "Yahoo Finance data here does not include this exchange.", {"definitive": True}],
    "invalid_symbol": ["invalid", "Yahoo Finance does not accept this symbol.", {"definitive": True}],
}


def configured_gateway_url() -> str:
    return os.environ.get("MD_GATEWAY_URL", DEFAULT_GATEWAY_URL).strip()


def validate_base_url(value: str | None) -> str:
    """The https gateway origin (or http on this computer), without a trailing slash; "" if unusable."""
    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    try:
        u = urlsplit(text)
    except ValueError:
        return ""
    loopback = u.hostname in ("127.0.0.1", "localhost")
    if u.scheme not in ("https", "http") or (u.scheme == "http" and not loopback) or not u.hostname or u.username or u.password or u.query or u.fragment:
        return ""
    return text


def gateway_symbol(identity: dict | None) -> str | None:
    """The gateway symbol for a resolved instrument, or None when the gateway does not serve it."""
    if not identity or identity.get("status") != "resolved" or not identity.get("localSymbol"):
        return None
    venue = "US" if identity.get("mic") in _US_FAMILY else identity.get("mic")
    if venue not in VENUES:
        return None
    local = identity["localSymbol"]
    if venue == "US":
        local = local.replace(".", "-")
    elif venue == "XTSE" and local.endswith(".U"):
        local = local[:-2] + "-U"
    elif "." in local:
        return None
    symbol = f"{local}{VENUES[venue]}"
    return symbol if len(symbol) <= 20 and _SYMBOL.match(symbol) else None


def history_bucket(start: str, end: str) -> str:
    days = (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 3
    return next((name for name, d in HISTORY_BUCKETS if d >= days), HISTORY_BUCKETS[-1][0])


def _short(text: object, limit: int = 300) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(text if text is not None else ""))).strip()[:limit]


def _positive(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 and v == v and v != float("inf")


def _local_day(epoch_s: float, time_zone: str | None) -> str:
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(time_zone or "UTC")
    except Exception:  # noqa: BLE001 - no tz database: UTC
        tz = dt.timezone.utc
    return dt.datetime.fromtimestamp(epoch_s, tz).date().isoformat()


def _invalid(message: str) -> DataError:
    return DataError(f"The Yahoo Finance answer failed a check ({message}), so it was not used.", kind="invalid", provider=GATEWAY_NAME)


class GatewayClient:
    def __init__(self, base_url: str | None, http: Callable[[str, dict], tuple[int, str]], now: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep, runtime_dir: Path | str | None = None, spacing_s: float = REQUEST_SPACING_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.base = validate_base_url(base_url)
        self.http, self.now, self.sleep, self.clock = http, now, sleep, clock
        self.spacing_s = spacing_s
        self.runtime = Path(runtime_dir) if runtime_dir else None
        self.lock = threading.Lock()  # one request at a time, spaced
        self.state_lock = threading.RLock()
        self.last_start = -1e18
        self.requests = 0
        self.quotes: dict[str, tuple[float, dict]] = {}
        self.histories: dict[str, tuple[float, dict]] = {}
        self.memory_pause: dict | None = None
        self.status = {"state": "checking", "message": MESSAGES["checking"]} if self.base else {"state": "not_configured", "message": MESSAGES["not_configured"]}

    # ------------------------------------------------------------ pause
    def _pause_path(self) -> Path | None:
        return self.runtime / "yahoo-pause.json" if self.runtime else None

    def _read_pause(self) -> dict | None:
        entry = self.memory_pause
        path = self._pause_path()
        if path and path.exists():
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                entry = self.memory_pause
        if isinstance(entry, dict) and isinstance(entry.get("until"), (int, float)) and 0 < entry["until"] - self.now() <= MAX_PAUSE_S:
            return entry
        return None

    def _pause(self, kind: str, retry_after_s: float | None, message: str) -> None:
        seconds = max(MIN_PAUSE_S.get(kind, 5), retry_after_s or 0)
        until = self.now() + min(seconds, MAX_PAUSE_S)
        with self.state_lock:
            current = self._read_pause()
            if current and current["until"] >= until:
                return
            entry = {"until": until, "kind": kind, "message": _short(message, 200)}
            self.memory_pause = entry
            path = self._pause_path()
            if path:
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(entry), encoding="utf-8")
                except OSError:
                    pass

    def pause_state(self) -> dict:
        p = self._read_pause()
        if not p:
            return {"paused": False, "until": None, "minutesLeft": 0, "kind": None, "reason": None, "short": None}
        minutes = max(1, -(-int(p["until"] - self.now()) // 60))
        why = "after it asked this site to slow down" if p.get("kind") == "rate_limited" else "after it was unavailable"
        return {"paused": True, "until": p["until"], "minutesLeft": minutes, "kind": p.get("kind"),
                "reason": f"paused for about {minutes} more minute{'' if minutes == 1 else 's'} {why}",
                "short": "paused after a rate limit" if p.get("kind") == "rate_limited" else "paused after an outage"}

    def _paused_error(self) -> DataError:
        p = self.pause_state()
        rate = p["kind"] == "rate_limited"
        error = DataError(f"Yahoo Finance is {p['reason']}. Nothing was sent; other sources in your list are tried instead.",
                          kind="rate_limited" if rate else "unavailable", quota_scope="minute" if rate else None, provider=GATEWAY_NAME,
                          retry_after_ms=int((p["until"] - self.now()) * 1000))
        error.paused = True
        return error

    # ------------------------------------------------------------ availability
    def configured(self) -> bool:
        return bool(self.base)

    def enabled(self) -> bool:
        return self.status["state"] == "enabled"

    def check(self) -> dict:
        """One GET /v1/health; its answer decides whether the source is offered at all."""
        if not self.base:
            return dict(self.status)
        try:
            status, text = self.http(f"{self.base}/v1/health", {"Accept": "application/json"})
        except DataError:
            self.status = {"state": "unreachable", "message": f"{MESSAGES['unreachable']} (network or timeout)"}
            return dict(self.status)
        if status != 200:
            self.status = {"state": "unreachable", "message": f"{MESSAGES['unreachable']} (HTTP {status})"}
            return dict(self.status)
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        keyless = (body or {}).get("keyless") if isinstance(body, dict) else None
        if not isinstance(body, dict) or body.get("schema") != SCHEMAS["health"] or not isinstance((keyless or {}).get("enabled"), bool):
            self.status = {"state": "unreachable", "message": f"{MESSAGES['unreachable']} (unexpected answer)"}
        elif not keyless["enabled"]:
            self.status = {"state": "disabled", "message": MESSAGES["disabled"], "reason": _short(keyless.get("reason")) or None}
        else:
            upstream = body.get("upstream") or {}
            if upstream.get("state") == "cooling_down" and isinstance(upstream.get("retryAfterSeconds"), (int, float)):
                self._pause("rate_limited", upstream["retryAfterSeconds"], "the data gateway is pausing Yahoo Finance requests")
            self.status = {"state": "enabled", "message": None, "attribution": _short(keyless.get("attribution")) or None, "version": _short(body.get("version"), 20)}
        return dict(self.status)

    def availability(self) -> dict:
        if not self.enabled():
            reason = AVAILABILITY_REASON.get(self.status["state"], "not available right now")
            return {"available": False, "code": self.status["state"], "reason": reason, "short": reason}
        p = self.pause_state()
        if p["paused"]:
            return {"available": False, "code": "paused", "reason": p["reason"], "short": p["short"]}
        return {"available": True, "code": None, "reason": None}

    def _unavailable(self) -> DataError:
        st = self.status
        message = f"{st['message']} {st['reason']}" if st["state"] == "disabled" and st.get("reason") else st.get("message") or MESSAGES["not_configured"]
        return DataError(message, kind="not_configured" if st["state"] == "not_configured" else "unavailable", definitive=True, provider=GATEWAY_NAME)

    # ------------------------------------------------------------ requests
    def _gateway_error(self, status: int, text: str) -> DataError:
        code, after_s = None, None
        try:
            body = json.loads(text)
            if isinstance(body, dict) and body.get("schema") == SCHEMAS["error"]:
                code = str((body.get("error") or {}).get("code") or "")
                sec = (body.get("error") or {}).get("retryAfterSeconds")
                if isinstance(sec, (int, float)) and 0 <= sec <= MAX_PAUSE_S:
                    after_s = float(sec)
        except ValueError:
            pass
        if code == "source_disabled":
            self.status = {"state": "disabled", "message": MESSAGES["disabled"], "reason": None}
        if code == "origin_not_allowed":
            self.status = {"state": "unreachable", "message": f"{MESSAGES['unreachable']} (it does not accept this program)"}
        entry = ERRORS.get(code)
        if not entry:
            return DataError(f"The data gateway answered HTTP {status}.", kind="unavailable" if status >= 500 else "http", status=status, provider=GATEWAY_NAME)
        kind, message = entry[0], entry[1]
        extra = dict(entry[2]) if len(entry) > 2 else {}
        pauses = extra.pop("pause", False)
        if pauses is True or (pauses == "breaker" and (after_s or 0) >= 60):
            self._pause(kind, after_s, message)
        error = DataError(message, kind=kind, status=status, provider=GATEWAY_NAME, retry_after_ms=int(after_s * 1000) if after_s is not None else None,
                          quota_scope=extra.get("quotaScope"), definitive=bool(extra.get("definitive")),
                          hint="Other sources in your list are tried; you can also use your own price." if kind == "rate_limited" else None)
        error.gateway_code = code
        return error

    def _get(self, path: str, params: dict, cancelled: Callable[[], bool]) -> dict:
        if not self.enabled():
            raise self._unavailable()
        if self.pause_state()["paused"]:
            raise self._paused_error()
        url = f"{self.base}{path}?{urlencode(params)}"
        for attempt in range(2):
            retry = False
            with self.lock:
                if cancelled():
                    raise DataError("Request cancelled.", kind="aborted")
                if self.pause_state()["paused"]:  # a pause may have started while this waited
                    raise self._paused_error()
                wait = self.last_start + self.spacing_s - self.clock()
                if wait > 0:
                    self.sleep(wait)
                self.last_start = self.clock()
                self.requests += 1
                try:
                    status, text = self.http(url, {"Accept": "application/json"})
                except DataError as error:
                    if error.kind in ("network", "timeout") and attempt == 0:
                        retry = True  # reaching the gateway failed: one retry, never for a refusal
                    else:
                        raise
            if retry:
                self.sleep(0.8)
                continue
            if status != 200:
                raise self._gateway_error(status, text)
            try:
                return json.loads(text)
            except ValueError:
                raise _invalid("not JSON") from None
        raise DataError("The data gateway could not be reached.", kind="network", provider=GATEWAY_NAME)

    @staticmethod
    def _check_listing(body: dict, schema: str, symbol: str, identity: dict) -> dict:
        if not isinstance(body, dict) or body.get("schema") != schema:
            raise _invalid("schema")
        listing = body.get("listing") or {}
        if listing.get("symbol") != symbol:
            raise _invalid("different symbol")
        venue = "US" if identity.get("mic") in _US_FAMILY else identity.get("mic")
        if listing.get("mic") != venue:
            raise _invalid("different exchange")
        if not re.fullmatch(r"[A-Z]{3}", str(body.get("currency") or "")):
            raise _invalid("currency")
        if body.get("unitScale") not in (1, 0.01) or body.get("quoteUnit") != ("major" if body.get("unitScale") == 1 else "minor"):
            raise _invalid("unit")
        if not isinstance(body.get("rawCurrency"), str) or len(body["rawCurrency"]) > 5:
            raise _invalid("raw currency")
        try:
            dt.datetime.fromisoformat(str(body.get("retrievedAt")).replace("Z", "+00:00"))
        except ValueError:
            raise _invalid("retrieval time") from None
        cache = body.get("cache") or {}
        if cache.get("status") not in ("hit", "miss") or not isinstance(cache.get("ageSeconds"), (int, float)) or cache["ageSeconds"] < 0:
            raise _invalid("cache record")
        return {"status": cache["status"], "ageSeconds": cache["ageSeconds"]}

    def quote(self, identity: dict, use_cache: bool = True, cancelled: Callable[[], bool] = lambda: False) -> dict:
        """Latest regular-session price: raw fields for md.quote.v1 (service.py builds the quote)."""
        symbol = gateway_symbol(identity)
        if not self.enabled():
            raise self._unavailable()
        if not symbol:
            raise DataError(f"Yahoo Finance data here does not cover {identity.get('venueName') or identity.get('mic') or 'this listing'}.", kind="not_covered", definitive=True, provider=GATEWAY_NAME)
        hit = self.quotes.get(symbol)
        if use_cache and hit and self.now() - hit[0] <= QUOTE_FRESH_S:
            return {**hit[1], "cacheAgeS": self.now() - hit[0]}
        body = self._get("/v1/quote", {"symbol": symbol}, cancelled)
        gateway_cache = self._check_listing(body, SCHEMAS["quote"], symbol, identity)
        raw_price, price, scale = body.get("rawPrice"), body.get("price"), body.get("unitScale")
        if not _positive(raw_price) or not _positive(price) or abs(price - raw_price * scale) > 1e-9 * max(1, price):
            raise _invalid("price")
        if not _DAY.match(str(body.get("tradingDate") or "")):
            raise _invalid("date")
        try:
            dt.date.fromisoformat(body["tradingDate"])
            as_of = dt.datetime.fromisoformat(str(body.get("sourceTime")).replace("Z", "+00:00"))
        except ValueError:
            raise _invalid("date") from None
        if body.get("priceBasis") != PRICE_TYPE or body.get("adjusted") is not False or (body.get("delay") or {}).get("realTime") is not False:
            raise _invalid("price basis")
        optional = lambda v: v if _positive(v) else None  # noqa: E731
        listing = body["listing"]
        raw = {
            "symbol": symbol, "rawPrice": raw_price, "rawCurrency": body["rawCurrency"], "currency": body["currency"], "unitScale": float(scale),
            "tradingDate": body["tradingDate"], "asOf": as_of.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "priceType": PRICE_TYPE,
            "name": _short(listing.get("name"), 120) or None, "exchangeName": _short(listing.get("exchangeName"), 60) or None,
            "retrievedAt": str(body["retrievedAt"]), "gatewayCache": gateway_cache, "delayNote": _short((body.get("delay") or {}).get("note")) or None,
            "previousClose": optional(body.get("previousClose")), "dayHigh": optional(body.get("dayHigh")), "dayLow": optional(body.get("dayLow")),
            "attribution": _short((body.get("source") or {}).get("attribution")) or self.status.get("attribution"),
        }
        self.quotes[symbol] = (self.now(), raw)
        return {**raw, "cacheAgeS": None}

    def history(self, identity: dict, start: str, end: str, cancelled: Callable[[], bool] = lambda: False) -> dict:
        """Daily close and adjusted close for [start, end] in the same shape as history.fetch_history."""
        symbol = gateway_symbol(identity)
        if not self.enabled():
            raise self._unavailable()
        if not symbol:
            raise DataError(f"Yahoo Finance data here does not cover {identity.get('venueName') or identity.get('mic') or 'this listing'}.", kind="not_covered", definitive=True, provider=GATEWAY_NAME)
        bucket = history_bucket(start, end)
        key = f"{symbol}|{bucket}"
        hit = self.histories.get(key)
        if hit and self.now() - hit[0] <= HISTORY_FRESH_S:
            packed, age = hit[1], self.now() - hit[0]
        else:
            body = self._get("/v1/history", {"symbol": symbol, "range": bucket, "interval": "1d"}, cancelled)
            gateway_cache = self._check_listing(body, SCHEMAS["history"], symbol, identity)
            obs = body.get("observations")
            if body.get("frequency") != "daily" or body.get("interval") != "1d" or body.get("range") != bucket or not isinstance(obs, list) or len(obs) > 2000:
                raise _invalid("history shape")
            previous = ""
            for o in obs:
                if not isinstance(o, list) or len(o) != 3 or not _DAY.match(str(o[0])) or o[0] <= previous:
                    raise _invalid("dates")
                if (o[1] is not None and not _positive(o[1])) or (o[2] is not None and not _positive(o[2])) or (o[1] is None and o[2] is None):
                    raise _invalid("prices")
                previous = o[0]
            adjustment = body.get("adjustment") or {}
            packed = {"symbol": symbol, "currency": body["currency"], "rawCurrency": body["rawCurrency"], "unitScale": float(body["unitScale"]),
                      "observations": [tuple(o) for o in obs], "timeZone": _short((body.get("listing") or {}).get("timeZone"), 40) or identity.get("timeZone") or "UTC",
                      "adjCloseAvailable": adjustment.get("adjCloseAvailable") is True, "retrievedAt": str(body["retrievedAt"]), "gatewayCache": gateway_cache}
            self.histories[key] = (self.now(), packed)
            age = None
        today = _local_day(self.now(), packed["timeZone"])
        rows = [o for o in packed["observations"] if o[0] < today and start <= o[0] <= end]
        if identity.get("currencyEvidence") == "curated_reference" and packed["currency"] != identity.get("currency"):
            raise DataError(f"Yahoo Finance reports {identity['displayTicker']} in {packed['rawCurrency'] or packed['currency']}, but this listing trades in {identity['currency']}. The prices were not used.",
                            kind="currency_mismatch", definitive=True, provider=GATEWAY_NAME)
        note = ("Yahoo Finance daily close (adjusted for splits, not dividends) and adjusted close (also dividends and capital-gain distributions, "
                "as Yahoo Finance calculates them); may be delayed; the session still trading is left out.")
        return {"observations": rows, "currency": packed["currency"], "basisNote": note, "frequency": "daily", "provider": GATEWAY_NAME,
                "symbol": symbol, "hasAdjusted": packed["adjCloseAvailable"], "currencyVerified": True, "retrievedAt": packed["retrievedAt"],
                "cache": "local" if age is not None else ("gateway" if packed["gatewayCache"]["status"] == "hit" else None), "via": GATEWAY_VIA}

    def requests_sent(self) -> int:
        return self.requests
