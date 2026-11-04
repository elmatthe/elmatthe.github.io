"""Daily price history for the desktop Stock Comparison tool, by the user's source list.

Sources (same list, catalog and pacing as quotes):
  Yahoo Finance  through the site's data gateway (./gateway.py), no key: daily close
                 (split-adjusted) and adjusted close (splits and distributions), 1mo-5y.
  Alpha Vantage  TIME_SERIES_DAILY (compact, ~100 sessions, AS TRADED) for windows up to
                 135 days, else TIME_SERIES_WEEKLY_ADJUSTED (close and adjusted close).
                 Daily adjusted closes are a premium Alpha Vantage feature.
  Marketstack    /v2/eod: daily close and adj_close, paged 1,000 rows per request (each
                 symbol per request counts against the monthly allowance).
  Alpaca         /v2/stocks/{symbol}/bars, 1Day bars, adjustment=all for adjusted closes
                 or raw; US listings only (IEX feed on the Basic plan).
Every series is checked for the symbol, exchange and currency it claims, and dates are
strict YYYY-MM-DD trading dates. Exchange-rate history comes from the Bank of Canada.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from urllib.parse import quote as urlquote, urlencode

from . import alphavantage as av
from .adapters import date_in, normalize_currency
from .catalog import PROVIDERS, venue_matches
from . import sources as src
from .errors import DataError
from .fx import BOC_BASE, BOC_CURRENCIES, BOC_PROVIDER
from .gateway import GATEWAY_ID

DAILY_WINDOW_DAYS = 135
HISTORY_PROVIDERS = ["yahoo", "alphavantage", "marketstack", "alpaca"]
_FINENESS = {"daily": 0, "weekly": 1, "monthly": 2}
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def history_kind(start: str, end: str) -> str:
    return "daily" if (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days <= DAILY_WINDOW_DAYS else "weekly"


def native_frequency(pid: str, start: str, end: str) -> str:
    """The series a source gives for a window, before anything is fetched."""
    return history_kind(start, end) if pid == "alphavantage" else "daily"


def history_by_sources(md, identity: dict, start: str, end: str, analysis_frequency: str | None = None, cancelled=lambda: False) -> dict:
    """History from the first source in the user's list that can give it (fetch_history's
    shape, plus "sourceId", "attempts" and "skipped"). With `analysis_frequency`, a source
    whose series would be coarser than it (Alpha Vantage's weekly closes for a Daily
    analysis) is skipped, so a comparison never silently mixes frequencies; finer series
    are resampled by the caller."""
    def require(pid: str):
        if not analysis_frequency:
            return None
        native = native_frequency(pid, start, end)
        if _FINENESS.get(native, 0) > _FINENESS.get(analysis_frequency.lower(), 0):
            return f"would give {native} prices for this period, and this comparison uses {analysis_frequency.lower()} prices"
        return None
    plan = md.route(identity, "history", require=require)
    h, attempts, used = md.try_sources(identity, "history", plan, lambda c: fetch_history(md, c["id"], identity, start, end, cancelled), "usable price history")
    return {**h, "sourceId": used, "sourceName": src.source_name(used), "attempts": attempts, "skipped": [x for x in plan["skipped"] if x["code"] != "off"]}


def fetch_history(md, pid: str, identity: dict, start: str, end: str, cancelled=lambda: False) -> dict:
    """{"observations": [(date, close, adjClose)], "currency", "basisNote", "frequency", "provider", "symbol"}."""
    if pid not in HISTORY_PROVIDERS:
        raise DataError(f"{PROVIDERS.get(pid, {}).get('name', pid)} does not provide price history here.", kind="not_covered", definitive=True)
    if pid == GATEWAY_ID:
        return md.gateway.history(identity, start, end, cancelled)
    s = md._session(pid)
    name = PROVIDERS[pid]["name"]
    if not s:
        raise DataError(f"No {name} key is saved.", kind="not_configured", provider=name)
    symbol = PROVIDERS[pid]["symbolFor"](identity, s.plan)
    if not symbol:
        raise DataError(f"{name} has no symbol for {identity['displayTicker']} ({identity.get('venueName')}).", kind="not_covered", definitive=True, provider=name)
    if pid == "alphavantage":
        return _alpha_vantage(md, s, identity, symbol, start, end, cancelled)
    if pid == "marketstack":
        return _marketstack(md, s, identity, symbol, start, end, cancelled)
    return _alpaca(md, s, identity, symbol, start, end, cancelled)


def _within(rows: list[tuple], start: str, end: str) -> list[tuple]:
    return [r for r in rows if start <= r[0] <= end]


def _alpha_vantage(md, s, identity, symbol, start, end, cancelled) -> dict:
    listing = None
    if identity.get("currencyEvidence") != "curated_reference":
        listing = md._av_listing(s, symbol, cancelled)
        if not listing:
            raise DataError(f"Alpha Vantage's symbol search does not list {symbol}.", kind="not_found", definitive=True, provider=av.AV_PROVIDER)
    currency = (listing or {}).get("currency") or identity.get("currency")
    scale = (listing or {}).get("unitScale") or identity.get("unitScale", 1.0)
    kind = history_kind(start, end)
    params = {"function": "TIME_SERIES_DAILY", "symbol": symbol, "outputsize": "compact"} if kind == "daily" else {"function": "TIME_SERIES_WEEKLY_ADJUSTED", "symbol": symbol}
    rows = av.parse_series(md._av_call(s, params, identity["displayTicker"], cancelled), identity["displayTicker"], kind, scale)
    note = ("Alpha Vantage daily closes as traded (not adjusted for splits or dividends; daily adjusted closes are premium)."
            if kind == "daily" else "Alpha Vantage weekly closes and adjusted closes (splits and dividends, provider definition).")
    return {"observations": _within(rows, start, end), "currency": currency, "basisNote": note, "frequency": kind, "provider": av.AV_PROVIDER,
            "symbol": symbol, "hasAdjusted": kind == "weekly", "currencyVerified": bool(currency)}


def _marketstack(md, s, identity, symbol, start, end, cancelled) -> dict:
    rows: list[tuple] = []
    currency = None
    scale = 1.0
    offset = 0
    adapter_name = "Marketstack"
    for _page in range(10):  # at most 10,000 rows
        url = "https://api.marketstack.com/v2/eod?" + urlencode({"access_key": s.key, "symbols": symbol, "date_from": start, "date_to": end, "limit": 1000, "offset": offset, "sort": "ASC"})
        status, text = md._send(s, url, {}, cancelled)
        if status != 200:
            from .adapters import Marketstack
            error = md._redact(s, Marketstack().classify(status, text))
            if error.kind == "rate_limited" and error.quota_scope == "monthly":
                s.usage.mark_limit("monthly", error.notice)
            raise error
        try:
            body = json.loads(text)
        except ValueError:
            raise DataError("Marketstack response was not JSON.", kind="invalid", provider=adapter_name) from None
        data = body.get("data") or []
        for row in data:
            if str(row.get("symbol", "")).upper() != symbol.upper():
                continue
            if not venue_matches(identity["mic"], row.get("exchange")):
                raise DataError(f"Marketstack's {symbol} is listed on {row.get('exchange')}, not {identity.get('venueName')}; not used.", kind="ambiguous", definitive=True, provider=adapter_name)
            c, sc, _raw = normalize_currency(row.get("price_currency"))
            if c:
                currency, scale = c, sc
            day = str(row.get("date") or "")[:10]
            close, adj = row.get("close"), row.get("adj_close")
            if _DAY.match(day):
                rows.append((day, float(close) * sc if isinstance(close, (int, float)) and close > 0 else None,
                             float(adj) * sc if isinstance(adj, (int, float)) and adj > 0 else None))
        total = (body.get("pagination") or {}).get("total", len(data))
        offset += len(data)
        if not data or offset >= total:
            break
    if not rows:
        raise DataError(f"Marketstack returned no end-of-day prices for {symbol} in this window.", kind="not_found", definitive=True, provider=adapter_name)
    if identity.get("currencyEvidence") == "curated_reference" and currency and currency != identity.get("currency"):
        raise DataError(f"Marketstack reports {symbol} in {currency}, but this listing trades in {identity['currency']}; not used.", kind="currency_mismatch", definitive=True, provider=adapter_name)
    rows = sorted({r[0]: r for r in rows}.values())
    return {"observations": rows, "currency": currency or (identity.get("currency") if identity.get("currencyEvidence") == "curated_reference" else None),
            "basisNote": "Marketstack daily close (as traded) and adjusted close (splits and dividends, provider definition).", "frequency": "daily",
            "provider": adapter_name, "symbol": symbol, "hasAdjusted": True, "currencyVerified": bool(currency) or identity.get("currencyEvidence") == "curated_reference"}


def _alpaca(md, s, identity, symbol, start, end, cancelled) -> dict:
    out: dict[str, list] = {}
    feed = s.plan.get("feed") or "iex"
    for adjustment in ("raw", "all"):
        token = None
        for _page in range(20):
            params = {"timeframe": "1Day", "start": start, "end": end, "adjustment": adjustment, "feed": feed, "limit": 10000}
            if token:
                params["page_token"] = token
            url = f"https://data.alpaca.markets/v2/stocks/{urlquote(symbol)}/bars?{urlencode(params)}"
            status, text = md._send(s, url, {"APCA-API-KEY-ID": s.key, "APCA-API-SECRET-KEY": s.secret or ""}, cancelled)
            if status != 200:
                from .adapters import Alpaca
                raise md._redact(s, Alpaca().classify(status, text))
            body = json.loads(text)
            for bar in body.get("bars") or []:
                stamp = str(bar.get("t") or "")
                try:
                    when = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                except ValueError:
                    continue
                day = date_in(when.timestamp() * 1000, identity.get("timeZone"))
                close = bar.get("c")
                if isinstance(close, (int, float)) and close > 0:
                    out.setdefault(day, [None, None])[0 if adjustment == "raw" else 1] = float(close)
            token = body.get("next_page_token")
            if not token:
                break
    if not out:
        raise DataError(f"Alpaca returned no daily bars for {symbol} in this window.", kind="not_found", definitive=True, provider="Alpaca")
    rows = [(d, v[0], v[1]) for d, v in sorted(out.items())]
    return {"observations": rows, "currency": "USD", "basisNote": f"Alpaca daily bars ({feed.upper()} feed{'; single exchange, not consolidated' if feed == 'iex' else ''}): raw close and split/dividend-adjusted close.",
            "frequency": "daily", "provider": "Alpaca", "symbol": symbol, "hasAdjusted": True, "currencyVerified": True}


def boc_history(md, codes: list[str], start: str, end: str) -> dict[str, list[tuple[str, float]]]:
    """{CODE: [(date, CAD per unit)]} from Bank of Canada daily averages (keyless)."""
    wanted = sorted({c for c in codes if c and c != "CAD"})
    if not wanted:
        return {}
    missing = [c for c in wanted if c not in BOC_CURRENCIES]
    if missing:
        raise DataError(f"The Bank of Canada does not publish {', '.join(missing)}.", kind="not_found", definitive=True, provider=BOC_PROVIDER)
    url = f"{BOC_BASE}/observations/{','.join(f'FX{c}CAD' for c in wanted)}/json?{urlencode({'start_date': start, 'end_date': end})}"
    status, text = md.http(url, {"Accept": "application/json"})
    if status != 200:
        raise DataError(f"Bank of Canada HTTP {status}", kind="unavailable", provider=BOC_PROVIDER)
    payload = json.loads(text)
    out: dict[str, list[tuple[str, float]]] = {c: [] for c in wanted}
    for row in payload.get("observations") or []:
        day = str(row.get("d", ""))
        if not _DAY.match(day):
            continue
        for c in wanted:
            cell = row.get(f"FX{c}CAD") or {}
            try:
                value = float(cell.get("v"))
            except (TypeError, ValueError):
                continue
            if value > 0:
                out[c].append((day, value))
    return out
