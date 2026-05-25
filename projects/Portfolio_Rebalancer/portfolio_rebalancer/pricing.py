"""Yahoo Finance live price and FX lookup with graceful fallback."""
from __future__ import annotations

import sys

try:
    import yfinance as yf
except ImportError:
    yf = None  # type: ignore[assignment]


def _safe_positive_float(raw: object) -> float | None:
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _extract_yf_last_price(ticker: object) -> float | None:
    fast_info = getattr(ticker, "fast_info", None)
    if fast_info is not None:
        try:
            _ = getattr(fast_info, "three_month_average_volume", None)
        except Exception:
            pass
        for attr in ("last_price", "regular_market_price", "previous_close"):
            try:
                raw = getattr(fast_info, attr, None)
            except Exception:
                continue
            value = _safe_positive_float(raw)
            if value is not None:
                return value
    try:
        info = ticker.get_info()  # type: ignore[union-attr]
        if isinstance(info, dict):
            raw = info.get("regularMarketPrice") or info.get("previousClose")
            value = _safe_positive_float(raw)
            if value is not None:
                return value
    except Exception:
        pass
    try:
        history = ticker.history(period="5d", interval="1d")  # type: ignore[union-attr]
        if not history.empty:
            raw = history["Close"].dropna().iloc[-1]
            value = _safe_positive_float(raw)
            if value is not None:
                return value
    except Exception:
        pass
    return None


def _extract_yf_quote_currency(ticker: object) -> str | None:
    fast_info = getattr(ticker, "fast_info", None)
    if fast_info is not None:
        try:
            _ = getattr(fast_info, "three_month_average_volume", None)
        except Exception:
            pass
        for attr in ("currency", "currency_code"):
            try:
                raw = getattr(fast_info, attr, None)
            except Exception:
                continue
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
    try:
        info = ticker.get_info()  # type: ignore[union-attr]
        if isinstance(info, dict):
            raw = info.get("currency")
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
    except Exception:
        pass
    return None


def normalize_quote_currency(raw_currency: str | None) -> tuple[str | None, float]:
    if raw_currency is None:
        return None, 1.0
    cleaned = raw_currency.strip()
    if not cleaned:
        return None, 1.0
    if cleaned in {"GBp", "GBX"}:
        return "GBP", 0.01
    upper = cleaned.upper()
    if upper == "CNH":
        return "CNY", 1.0
    return upper, 1.0


def fetch_live_quote_details(ticker_symbol: str) -> dict | None:
    if yf is None:
        return None
    try:
        t = yf.Ticker(ticker_symbol)
        raw_price = _extract_yf_last_price(t)
        if raw_price is None:
            print(f"[yf] No price returned for {ticker_symbol}", file=sys.stderr)
            return None
        raw_quote_currency = _extract_yf_quote_currency(t)
        quote_currency, unit_scale = normalize_quote_currency(raw_quote_currency)
        return {
            "resolvedTicker": ticker_symbol,
            "rawPrice": raw_price,
            "price": raw_price * unit_scale,
            "rawQuoteCurrency": raw_quote_currency,
            "quoteCurrency": quote_currency,
            "unitScale": unit_scale,
        }
    except Exception as exc:
        print(f"[yf] Exception fetching {ticker_symbol}: {exc}", file=sys.stderr)
        return None


def fetch_live_fx_to_usd(currency_code: str) -> float | None:
    if currency_code == "USD":
        return 1.0
    if yf is None:
        return None
    pair = f"{currency_code}USD=X"
    try:
        t = yf.Ticker(pair)
        return _extract_yf_last_price(t)
    except Exception:
        return None


def find_cross_market_quote(
    ticker_symbol: str,
    attempted_candidates: list[str],
) -> dict | None:
    from portfolio_rebalancer.ticker_helper import build_cross_market_candidates

    for candidate in build_cross_market_candidates(ticker_symbol, attempted_candidates):
        result = fetch_live_quote_details(candidate)
        if result is not None:
            return result
    return None
