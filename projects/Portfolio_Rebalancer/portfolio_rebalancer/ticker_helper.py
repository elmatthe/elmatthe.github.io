"""Ticker disambiguation and helper messaging system."""
from __future__ import annotations

from portfolio_rebalancer.fx import CURRENCY_OPTIONS

EXCHANGE_SUFFIX_HINTS: dict[str, list[str]] = {
    "USD": [""],
    "CAD": [".TO", ".V", ""],
    "JPN": [".T", ""],
    "EUR": [".DE", ".AS", ".PA", ".MI", ".BR", ""],
    "GBP": [".L", ""],
    "CHY_CNH": [".SS", ".SZ", ".HK", ""],
}

SUFFIX_TO_CURRENCY_KEY: dict[str, str] = {
    ".TO": "CAD", ".V": "CAD", ".T": "JPN", ".L": "GBP",
    ".DE": "EUR", ".AS": "EUR", ".PA": "EUR", ".MI": "EUR", ".BR": "EUR",
    ".SS": "CHY_CNH", ".SZ": "CHY_CNH", ".HK": "CHY_CNH",
}

PREFIX_TO_SUFFIX: dict[str, str] = {
    "TSE:": ".TO", "TSX:": ".TO", "LSE:": ".L", "JPX:": ".T",
}

CROSS_MARKET_SUFFIXES: list[str] = [
    ".TO", ".V", ".L", ".T", ".DE", ".AS", ".PA", ".MI", ".BR",
    ".SS", ".SZ", ".HK", "",
]


def build_ticker_candidates(ticker_symbol: str, currency_key: str) -> list[str]:
    base = ticker_symbol.strip().upper()
    if not base:
        return []
    for prefix, preferred_suffix in PREFIX_TO_SUFFIX.items():
        if base.startswith(prefix):
            stripped = base[len(prefix):].strip()
            if not stripped:
                return []
            inferred_key = SUFFIX_TO_CURRENCY_KEY.get(preferred_suffix, currency_key)
            suffixes = EXCHANGE_SUFFIX_HINTS.get(inferred_key, [""])
            ordered = [preferred_suffix] + [s for s in suffixes if s != preferred_suffix]
            candidates: list[str] = []
            for suffix in ordered:
                c = f"{stripped}{suffix}" if suffix else stripped
                if c not in candidates:
                    candidates.append(c)
            return candidates
    if "=" in base:
        return [base]
    if "." in base:
        stem, raw_suffix = base.rsplit(".", 1)
        suffix = f".{raw_suffix}"
        if stem and suffix in SUFFIX_TO_CURRENCY_KEY:
            candidates = [base]
            inferred_key = SUFFIX_TO_CURRENCY_KEY.get(suffix, currency_key)
            for key in (currency_key, inferred_key):
                for alt in EXCHANGE_SUFFIX_HINTS.get(key, [""]):
                    c = f"{stem}{alt}" if alt else stem
                    if c not in candidates:
                        candidates.append(c)
            return candidates
        return [base]
    candidates = []
    for suffix in EXCHANGE_SUFFIX_HINTS.get(currency_key, [""]):
        c = f"{base}{suffix}" if suffix else base
        if c not in candidates:
            candidates.append(c)
    return candidates


def build_ticker_input_hint(ticker_symbol: str, currency_key: str) -> str:
    cleaned = ticker_symbol.strip().upper()
    if not cleaned:
        return ""
    expected_key = currency_key if currency_key in CURRENCY_OPTIONS else "USD"
    expected_code = CURRENCY_OPTIONS[expected_key]["code"]

    for prefix, suffix in PREFIX_TO_SUFFIX.items():
        if cleaned.startswith(prefix):
            base = cleaned[len(prefix):].strip()
            if not base:
                return ""
            suggestion = f"{base}{suffix}"
            mapped_key = SUFFIX_TO_CURRENCY_KEY.get(suffix, expected_key)
            mapped_code = CURRENCY_OPTIONS[mapped_key]["code"]
            if mapped_key != expected_key:
                return (
                    f"'{prefix}' prefix not supported by Yahoo Finance. "
                    f"Try '{suggestion}' ({mapped_code}) or switch row currency."
                )
            return f"'{prefix}' prefix not supported. Try '{suggestion}'."

    if "." in cleaned:
        dot_suffix = "." + cleaned.rsplit(".", 1)[1]
        mapped_key = SUFFIX_TO_CURRENCY_KEY.get(dot_suffix)
        if mapped_key and mapped_key != expected_key:
            mapped_code = CURRENCY_OPTIONS[mapped_key]["code"]
            return f"'{dot_suffix}' implies {mapped_code} but row is {expected_code} - check row currency."
        return ""

    for candidate in build_ticker_candidates(cleaned, expected_key):
        if candidate != cleaned:
            if expected_key == "CHY_CNH":
                return (
                    "For CNY live quotes, use .SS/.SZ/.HK only for securities listed on "
                    "Shanghai/Shenzhen/HK exchanges. Verify the exact symbol at finance.yahoo.com."
                )
            return (
                f"For {expected_code} live quotes, try '{candidate}'. "
                "Verify the exact symbol at finance.yahoo.com."
            )
    return ""


def extract_bare_ticker(ticker_symbol: str) -> str:
    base = ticker_symbol.strip().upper()
    if not base:
        return ""
    for prefix in PREFIX_TO_SUFFIX:
        if base.startswith(prefix):
            base = base[len(prefix):].strip()
            break
    if "." in base:
        stem, _ = base.rsplit(".", 1)
        if stem:
            return stem
    return base


def build_cross_market_candidates(
    ticker_symbol: str,
    attempted_candidates: list[str],
) -> list[str]:
    bare = extract_bare_ticker(ticker_symbol)
    if not bare:
        return []
    attempted_set = {c.strip().upper() for c in attempted_candidates}
    candidates: list[str] = []
    for suffix in CROSS_MARKET_SUFFIXES:
        c = f"{bare}{suffix}" if suffix else bare
        if c not in attempted_set and c not in candidates:
            candidates.append(c)
    return candidates
