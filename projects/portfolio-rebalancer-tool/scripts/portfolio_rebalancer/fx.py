"""Currency options and FX conversion helpers."""
from __future__ import annotations

# fx_to_usd values are built-in estimates used only when live FX is off or
# unavailable: Bank of Canada daily average rates for DEFAULT_FX_AS_OF, converted to
# US dollars per unit (same values as the web app's engine.js).
DEFAULT_FX_AS_OF = "2026-10-30"

CURRENCY_OPTIONS: dict[str, dict] = {
    "USD": {"code": "USD", "label": "USD", "fx_to_usd": 1.00, "symbol": "$"},
    "CAD": {"code": "CAD", "label": "CAD", "fx_to_usd": 0.716332, "symbol": "C$"},
    "JPN": {"code": "JPY", "label": "JPN", "fx_to_usd": 0.006354, "symbol": "JPY "},
    "EUR": {"code": "EUR", "label": "EUR", "fx_to_usd": 1.116189, "symbol": "EUR "},
    "GBP": {"code": "GBP", "label": "GBP", "fx_to_usd": 1.33947, "symbol": "GBP "},
    "CHY_CNH": {"code": "CNY", "label": "CHY/CNH", "fx_to_usd": 0.150287, "symbol": "CN¥"},
}

CURRENCY_CODE_TO_KEY: dict[str, str] = {
    meta["code"]: key for key, meta in CURRENCY_OPTIONS.items()
}

EXCEL_CURRENCY_FORMATS: dict[str, str] = {
    "USD": '"$"#,##0.00',
    "CAD": '"C$"#,##0.00',
    "EUR": '"€"#,##0.00',
    "GBP": '"£"#,##0.00',
    "JPN": '"¥"#,##0',
    "CHY_CNH": '"CN¥"#,##0.00',
}

ACCOUNT_TYPES: list[str] = [
    "", "TFSA", "RRSP", "RESP", "RRIF", "FHSA", "LIRA",
    "Margin", "Non-Registered", "Individual", "Crypto", "Other",
]


def get_meta(currency_key: str) -> dict:
    return CURRENCY_OPTIONS.get(currency_key, CURRENCY_OPTIONS["USD"])


def fallback_fx_to_usd(currency_key: str) -> float:
    return float(get_meta(currency_key)["fx_to_usd"])


def get_fx_to_usd(currency_key: str, live_map: dict[str, float] | None = None) -> float:
    if live_map and currency_key in live_map:
        return float(live_map[currency_key])
    return fallback_fx_to_usd(currency_key)


def get_fx_to_reporting(
    row_key: str,
    reporting_key: str,
    live_map: dict[str, float] | None = None,
) -> float:
    return get_fx_to_usd(row_key, live_map) / get_fx_to_usd(reporting_key, live_map)


def format_currency(value: float, currency_key: str = "USD") -> str:
    meta = get_meta(currency_key)
    symbol = meta["symbol"]
    if value < 0:
        return f"-{symbol}{abs(value):,.2f}"
    return f"{symbol}{value:,.2f}"


def format_fx(value: float, is_live: bool = False) -> str:
    return f"~{value:.4f}" if is_live else f"{value:.4f}"


def format_pct(value: float) -> str:
    return f"{value:.2f}%"


def format_shares(value: float) -> str:
    text = f"{value:,.4f}"
    return text.rstrip("0").rstrip(".")


def format_input_price(value: float) -> str:
    text = f"{value:.4f}"
    return text.rstrip("0").rstrip(".")
