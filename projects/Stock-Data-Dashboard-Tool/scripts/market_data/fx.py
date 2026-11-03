"""Official exchange rates: Bank of Canada Valet, falling back to the ECB.

Mirrors assets/js/market-data/providers/boc.js and ecb.js. Rates are "CAD per one
unit" fixings (CAD = 1); every pair is derived from them. These are indicative
daily averages published once per business day, not executable quotes.
Terms: https://www.bankofcanada.ca/terms/ and the ECB's reuse conditions.
"""
from __future__ import annotations

import csv
import io
import json
import re
from typing import Callable
from urllib.parse import urlencode

from .errors import DataError

BOC_PROVIDER = "Bank of Canada"
BOC_BASE = "https://www.bankofcanada.ca/valet"
BOC_CURRENCIES = ["AUD", "BRL", "CHF", "CNY", "EUR", "GBP", "HKD", "IDR", "INR", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PEN",
                  "PLN", "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "USD", "ZAR"]
ECB_PROVIDER = "European Central Bank"
ECB_BASE = "https://data-api.ecb.europa.eu/service/data/EXR"
ECB_CURRENCIES = ["AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN",
                  "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"]
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def boc_url(codes: list[str], recent: int = 5) -> str:
    series = [f"FX{c}CAD" for c in sorted(set(codes)) if c != "CAD"]
    return f"{BOC_BASE}/observations/{','.join(series)}/json?{urlencode({'recent': recent})}"


def parse_boc(text: str, codes: list[str]) -> dict[str, dict]:
    """Latest {CODE: {"date", "cadPer"}} plus CAD = 1 from a Valet observations body."""
    try:
        payload = json.loads(text)
    except ValueError:
        raise DataError("Bank of Canada response was not JSON", kind="invalid", provider=BOC_PROVIDER) from None
    obs = payload.get("observations") if isinstance(payload, dict) else None
    if not isinstance(obs, list):
        raise DataError("Bank of Canada response had no observations", kind="invalid", provider=BOC_PROVIDER)
    out: dict[str, dict] = {"CAD": {"date": None, "cadPer": 1.0}}
    for code in [c for c in codes if c != "CAD"]:
        sid = f"FX{code}CAD"
        points = []
        for row in obs:
            cell = row.get(sid) if isinstance(row, dict) else None
            if not cell or cell.get("v") in (None, "") or not _DAY.match(str(row.get("d", ""))):
                continue
            value = float(cell["v"])
            if not value > 0:
                raise DataError(f"Bank of Canada {sid} had an invalid value on {row['d']}", kind="invalid", provider=BOC_PROVIDER)
            points.append((row["d"], value))
        if not points:
            raise DataError(f"Bank of Canada returned no recent {code}/CAD rate.", kind="invalid", provider=BOC_PROVIDER)
        day, value = sorted(points)[-1]
        out[code] = {"date": day, "cadPer": value}
    return out


def ecb_url(codes: list[str], last: int = 5) -> str:
    wanted = sorted({c for c in codes if c != "EUR"} | {"CAD"})
    return f"{ECB_BASE}/D.{'+'.join(wanted)}.EUR.SP00.A?{urlencode({'format': 'csvdata', 'lastNObservations': last})}"


def parse_ecb(text: str, codes: list[str]) -> dict[str, dict]:
    per_eur: dict[str, list[tuple[str, float]]] = {}
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        if r.get("CURRENCY_DENOM") not in (None, "", "EUR"):
            continue
        day, raw = r.get("TIME_PERIOD", ""), r.get("OBS_VALUE", "")
        if not _DAY.match(day) or raw in ("", "NaN"):
            continue
        per_eur.setdefault(r["CURRENCY"], []).append((day, float(raw)))
    cad = dict(per_eur.get("CAD", []))
    if not cad:
        raise DataError("ECB response had no CAD rate", kind="invalid", provider=ECB_PROVIDER)
    out: dict[str, dict] = {"CAD": {"date": None, "cadPer": 1.0}}
    for code in [c for c in codes if c != "CAD"]:
        if code == "EUR":
            day = max(cad)
            out["EUR"] = {"date": day, "cadPer": cad[day]}
            continue
        points = [(d, cad[d] / v) for d, v in per_eur.get(code, []) if d in cad and v > 0]
        if not points:
            raise DataError(f"ECB returned no recent {code} rate.", kind="invalid", provider=ECB_PROVIDER)
        day, value = sorted(points)[-1]
        out[code] = {"date": day, "cadPer": value}
    return out


def latest_cad_rates(codes: list[str], get: Callable[[str, dict], tuple[int, str]]) -> dict:
    """{"cadPer": {...}, "provider", "attribution", "failures"} from the first source that answers.

    get(url, headers) -> (status, text): the caller's HTTP function (tests pass a fake).
    """
    wanted = sorted({c.upper() for c in codes if c and c.upper() != "CAD"})
    failures = []
    if not wanted:
        return {"cadPer": {"CAD": {"date": None, "cadPer": 1.0}}, "provider": None, "attribution": None, "failures": []}
    sources = [
        (BOC_PROVIDER, lambda: all(c in BOC_CURRENCIES for c in wanted), lambda: boc_url(wanted), parse_boc,
         "Source: Bank of Canada daily average exchange rates (indicative, published once per business day)."),
        (ECB_PROVIDER, lambda: all(c in ECB_CURRENCIES or c == "EUR" for c in wanted), lambda: ecb_url(wanted), parse_ecb,
         "Source: European Central Bank euro reference rates; non-euro crosses are derived."),
    ]
    for name, supports, url, parse, attribution in sources:
        if not supports():
            failures.append(f"{name}: does not publish {', '.join(wanted)}")
            continue
        try:
            status, text = get(url(), {"Accept": "text/csv" if name == ECB_PROVIDER else "application/json"})
            if status != 200:
                raise DataError(f"HTTP {status}", kind="unavailable" if status >= 500 else "http", provider=name)
            return {"cadPer": parse(text, wanted), "provider": name, "attribution": attribution, "failures": failures}
        except DataError as error:
            failures.append(f"{name}: {error.message}")
        except (ValueError, KeyError) as error:
            failures.append(f"{name}: unexpected response ({error})")
    raise DataError(f"Official exchange rates could not be retrieved ({'; '.join(failures)}).", kind="unavailable")
