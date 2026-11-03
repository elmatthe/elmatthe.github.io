"""Writes sources.json: deterministic, synthetic Statistics Canada and FRED observations
for the CPI parity tests (no network, no real data). Run from this folder:

    python3 generate.py

Windows cover early history (1913, only CPIAUCNS exists), an ordinary historical
period (2023-10 to 2024-03, every series) and the months around the fixed "today" of
the tests, 2026-11-03 (current, unfinished month). Values include the edge cases the CSV
writers must agree on: whole numbers (100.0), zero, negative zero, negatives, trailing
zeros ("5.30"), FRED "." (no value), Statistics Canada nulls and an unordered daily list.
"""
import json
from datetime import date, timedelta

STATCAN = {"41690973": 1914, "41690914": 1992, "41691233": 1961, "41690924": 1992, "41692327": 1978}
MONTHLY = {"CPIAUCNS": (1913, 3), "CPIAUCSL": (1947, 3), "CPILFENS": (1957, 3), "CPILFESL": (1957, 3), "UNRATE": (1948, 1),
           "FEDFUNDS": (1954, 2), "GS10": (1953, 2), "GS2": (1976, 2), "PCEPI": (1959, 3), "PCEPILFE": (1959, 3)}
DAILY = {"DFF": 1954, "SP500": 2016, "T10Y2Y": 1976}
WINDOWS = [(date(1913, 1, 1), date(1913, 12, 31)), (date(2023, 10, 1), date(2024, 3, 31)), (date(2026, 8, 1), date(2026, 11, 3))]
PUBLISHED_THROUGH = {"statcan": "2026-09", "monthly": "2026-10"}  # later months are "not published yet"


def months(a, b):
    y, m = a.year, a.month
    while (y, m) <= (b.year, b.month):
        yield f"{y:04d}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def lcg(seed):
    state = seed
    while True:
        state = (state * 1103515245 + 12345) % 2**31
        yield state / 2**31


out = {"schema": "cpi.source-fixture.v1", "today": "2026-11-03", "statcan": {}, "fred": {}}
for i, (vector, first) in enumerate(STATCAN.items()):
    rnd = lcg(100 + i)
    points = []
    for a, b in WINDOWS:
        for ym in months(a, b):
            if int(ym[:4]) < first or ym > PUBLISHED_THROUGH["statcan"]:
                continue
            value = round(100 + 70 * next(rnd), 1)
            if vector == "41692327" and ym == "2024-01":
                value = None  # ".." not available
            if vector == "41690914" and ym == "2023-12":
                value = 160.0  # whole number: written as 160.0
            points.append({"refPer": f"{ym}-01", "value": value, "decimals": 1, "scalarFactorCode": 0, "symbolCode": 3 if ym == "2026-09" else 0,
                           "statusCode": 1 if value is None else 0, "securityLevelCode": 0, "releaseTime": "2026-10-19T08:30", "frequencyCode": 6})
    out["statcan"][vector] = points
for i, (series, (first, decimals)) in enumerate(MONTHLY.items()):
    rnd = lcg(200 + i)
    obs = []
    for a, b in WINDOWS:
        for ym in months(a, b):
            if int(ym[:4]) < first or ym > PUBLISHED_THROUGH["monthly"]:
                continue
            base = 300 if series.startswith("CPI") else 120 if series.startswith("PCE") else 4
            text = f"{base + (10 if base > 100 else 2) * next(rnd):.{decimals}f}"
            if series == "GS2" and ym == "2024-02":
                text = "."
            if series == "UNRATE" and ym == "2023-11":
                text = "4.0"
            if series == "PCEPI" and ym == "2024-01":
                text = "100.000"
            obs.append({"realtime_start": "2026-11-03", "realtime_end": "2026-11-03", "date": f"{ym}-01", "value": text})
    out["fred"][series] = obs
for i, (series, first) in enumerate(DAILY.items()):
    rnd = lcg(300 + i)
    obs = []
    for a, b in WINDOWS:
        d = a
        while d <= b:
            if d.year >= first and (series == "DFF" or d.weekday() < 5):
                if series == "SP500":
                    text = f"{5000 + 2000 * next(rnd):.2f}"
                elif series == "T10Y2Y":
                    text = f"{-0.6 + 1.2 * next(rnd):.2f}"
                else:
                    text = f"{4.5 + next(rnd):.2f}"
                if d.day >= 29 and d.month in (12, 2):
                    text = "."  # month ends on a holiday: the latest VALID day wins
                if series == "T10Y2Y" and d == date(2024, 1, 31):
                    text = "0.00"
                if series == "T10Y2Y" and d == date(2023, 10, 31):
                    text = "-0.00"
                obs.append({"realtime_start": "2026-11-03", "realtime_end": "2026-11-03", "date": d.isoformat(), "value": text})
            d += timedelta(days=1)
    obs.reverse() if series == "DFF" else None  # response order must not matter
    out["fred"][series] = obs
with open("sources.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=0, separators=(",", ":"))
    f.write("\n")
