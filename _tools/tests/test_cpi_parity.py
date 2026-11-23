"""CPI Web Scraper: browser vs desktop parity (decision 4A).

The browser code (assets/js/cpi, through tests/cpi_engines.mjs) and the desktop
downloader (projects/CPI-Webscraper/scripts) must agree on:
  * the nineteen A:S columns: ids, exact headers, order, Statistics Canada vectors,
    FRED series, monthly vs daily end-of-month aggregation and first months;
  * the data gateway's allowlist (the thirteen FRED series and their kinds);
  * the month rules (January 1913 clamp, current-month ceiling, invalid input);
  * the latest-valid-observation reduction of daily series;
  * the CSV itself, byte for byte, from identical deterministic source fixtures
    (fixtures/cpi/sources.json): dates, values, blank observations and headers.

The desktop side runs data_sources.build_rows and workbook_io.write_to_csv with
requests.get mocked; the browser side runs the Statistics Canada client, the FRED client
and the real gateway module with fetch mocked. No network, no key.
"""
from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
import tomllib
from datetime import date
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlparse

import pytest

ROOT = Path(__file__).resolve().parents[2]
CPI = ROOT / "projects" / "CPI-Webscraper"
RUNNER = Path(__file__).with_name("cpi_engines.mjs")
FIXTURE = Path(__file__).parent / "fixtures" / "cpi" / "sources.json"
sys.path.insert(0, str(CPI / "scripts"))

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")
pytest.importorskip("requests")
pytest.importorskip("dateutil")

import cpi_config  # noqa: E402
import data_sources as ds  # noqa: E402
import workbook_io  # noqa: E402

TODAY = date(2026, 11, 3)


def js(payload: dict):
    result = subprocess.run(["node", str(RUNNER)], input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8", timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_schema_matches_the_desktop_downloader():
    schema = js({"op": "schema"})
    cols = schema["columns"]
    default = tomllib.loads((CPI / "scripts" / "config-default.toml").read_text(encoding="utf-8"))
    assert [c["id"] for c in cols] == list(cpi_config.SUPPORTED_IDS), "ids and order"
    assert [c["header"] for c in cols] == [c["header"] for c in default["output"]["columns"]], "exact headers"
    assert [c["id"] for c in cols] == [c["id"] for c in default["output"]["columns"]]
    assert [c["col"] for c in cols] == list("ABCDEFGHIJKLMNOPQRS")
    statcan = {c["id"]: c["sourceId"] for c in cols if c["source"] == "statcan"}
    fred_monthly = {c["id"]: c["sourceId"] for c in cols if c["source"] == "fred" and c["kind"] == "monthly"}
    fred_daily = {c["id"]: c["sourceId"] for c in cols if c["source"] == "fred" and c["kind"] == "daily_eom"}
    assert statcan == ds.STATCAN_VECTORS
    assert fred_monthly == ds.FRED_MONTHLY_SERIES
    assert fred_daily == ds.FRED_DAILY_EOM_SERIES
    assert {c["id"]: c["firstMonth"] for c in cols if c["source"] != "date"} == ds.EXPECTED_STARTS
    assert schema["minMonth"] == ds.MIN_YM
    groups = {g["label"]: g["ids"] for g in schema["groups"]}
    assert list(groups) == ["Canada", "US Inflation", "Rates", "Other"]
    assert sorted(i for ids in groups.values() for i in ids) == sorted(cpi_config.SUPPORTED_IDS[1:]), "every series in exactly one group"


def test_gateway_allowlist_is_exactly_the_desktop_fred_series():
    gw = js({"op": "gateway"})
    expected = {**{s: "monthly" for s in ds.FRED_MONTHLY_SERIES.values()}, **{s: "daily" for s in ds.FRED_DAILY_EOM_SERIES.values()}}
    assert gw["series"] == expected
    assert gw["url"] == ds.FRED_OBS_URL, "the same FRED endpoint as the desktop"
    assert gw["limits"]["minDate"] == ds.MIN_YM + "-01"


DATE_CASES = [
    ("single", "2024", "3", "", ""), ("single", "1850", "7", "", ""), ("single", "2026", "11", "", ""), ("single", "2027", "1", "", ""),
    ("range", "2023", "11", "2024", "02"), ("range", "1900", "1", "1913", "6"), ("range", "1900", "1", "1910", "1"),
    ("range", "2026", "1", "9999", "12"), ("range", "2024", "5", "2024", "4"), ("range", "2024", "13", "2025", "1"),
    ("single", "24", "1", "", ""), ("single", "2024", "0", "", ""), ("single", "abcd", "1", "", ""), ("range", "2020", "1", "", ""),
]


def test_month_rules_match_the_desktop():
    gui = pytest.importorskip("cpi_webscraper", reason="the desktop GUI module needs tkinter")
    browser = js({"op": "dates", "today": TODAY.isoformat(), "cases": [dict(zip(("mode", "y", "m", "y2", "m2"), c)) for c in DATE_CASES]})
    for case, b in zip(DATE_CASES, browser):
        try:
            start, end, _ = gui.parse_months(*case, today=TODAY)
            assert b == {"start": start, "end": end}, case
        except ValueError:
            assert "error" in b, (case, b)


def test_range_clamp_matches_normalize_range():
    # The same rules without the GUI module (runs where tkinter is missing).
    cases = [("1900-01", "2024-01", False), ("1900-01", "1900-01", True), ("2026-01", "9998-12", False), ("2026-11", "2026-11", True)]
    browser = js({"op": "dates", "today": TODAY.isoformat(), "cases": [{"mode": "single" if single else "range", "y": s[:4], "m": s[5:], "y2": e[:4], "m2": e[5:]} for s, e, single in cases]})
    for (s, e, single), b in zip(cases, browser):
        start, end = ds.normalize_range(s, e, single, today=TODAY)
        assert b == {"start": start, "end": end}, (s, e)


def test_daily_end_of_month_reduction_identical():
    rng = random.Random(2026)
    cases = []
    for _ in range(60):
        days = sorted(rng.sample(range(1, 29), rng.randint(1, 12)))
        rows = [[f"2024-0{rng.randint(1, 3)}-{d:02d}", None if rng.random() < 0.3 else round(rng.uniform(-1, 6), 2)] for d in days]
        uniq = {r[0]: r for r in rows}
        rows = list(uniq.values())
        rng.shuffle(rows)
        cases.append(rows)
    for rows, browser in zip(cases, js({"op": "reduce", "cases": cases})):
        desktop = ds.reduce_daily_eom([(date.fromisoformat(d), v) for d, v in rows])
        assert browser == desktop, rows


def _desktop_csv(monkeypatch, tmp_path, start, end, fixture_path=FIXTURE, today=TODAY):
    fixture = json.loads(Path(fixture_path).read_text(encoding="utf-8"))

    def get(url, params=None, timeout=None, headers=None):
        response = Mock()
        response.raise_for_status = Mock()
        host = urlparse(url).netloc
        if host == "www150.statcan.gc.ca":
            vector = params["vectorIds"]
            lo, hi = params["startRefPeriod"][:7], params["endReferencePeriod"][:7]
            points = [p for p in fixture["statcan"][vector] if lo <= p["refPer"][:7] <= hi]
            response.json.return_value = [{"status": "SUCCESS", "object": {"responseStatusCode": 0, "vectorId": int(vector), "vectorDataPoint": points}}]
        elif host == "api.stlouisfed.org":
            obs = [o for o in fixture["fred"][params["series_id"]] if params["observation_start"] <= o["date"] <= params["observation_end"]]
            response.json.return_value = {"count": len(obs), "observations": obs}
        else:
            raise AssertionError(f"unexpected host {host}")
        return response

    monkeypatch.setattr(ds.requests, "get", get)
    rows = ds.build_rows(start, end, "placeholder-key", today=today)
    config = cpi_config.load_config(CPI / "scripts" / "config-default.toml")
    path = tmp_path / "desktop.csv"
    workbook_io.write_to_csv(rows, path, config)
    return path.read_bytes()


CSV_CASES = [("1913-01", "1913-03"), ("2023-11", "2024-02"), ("2023-10", "2024-03"), ("2023-11", "2023-11"), ("2026-08", "2026-11"), ("2026-11", "2026-11")]


@pytest.mark.parametrize("start,end", CSV_CASES)
def test_csv_identical_to_the_desktop_downloader(monkeypatch, tmp_path, start, end):
    desktop = _desktop_csv(monkeypatch, tmp_path, start, end)
    (browser,) = js({"op": "csv", "fixture": str(FIXTURE), "cases": [{"start": start, "end": end}]})
    assert browser["failed"] == [], browser["failed"]
    assert browser["csv"].encode("utf-8") == desktop, f"\n--- desktop\n{desktop.decode()}\n--- browser\n{browser['csv']}"
    lines = desktop.decode("utf-8").split("\r\n")
    assert lines[0].split(",") == [c.header for c in cpi_config.load_config(CPI / "scripts" / "config-default.toml").columns]
    assert all(len(line.split(",")) == 19 for line in lines[:-1]), "nineteen columns on every row"
    assert lines[-1] == "", "CRLF after the last row"


def test_csv_edge_values_and_current_month():
    (browser,) = js({"op": "csv", "fixture": str(FIXTURE), "cases": [{"start": "2023-10", "end": "2024-03"}]})
    rows = {r.split(",")[0]: r.split(",") for r in browser["csv"].split("\r\n")[1:] if r}
    headers = browser["csv"].split("\r\n")[0].split(",")
    col = {h: i for i, h in enumerate(headers)}
    assert rows["2023-12-01"][col["Headline CPI - Seasonally Adjusted CDN"]] == "160.0", "whole numbers keep Python's .0"
    assert rows["2024-01-01"][col["Alberta CPI - Unadjusted CDN"]] == "", "a Statistics Canada '..' is blank, not zero"
    assert rows["2024-02-01"][col["2-Year Treasury Yield - Monthly Average US"]] == "", "a FRED '.' is blank"
    assert rows["2024-01-01"][col["PCE - Seasonally Adjusted US"]] == "100.0"
    assert rows["2023-11-01"][col["Unemployment Rate - Seasonally Adjusted US"]] == "4.0"
    assert rows["2024-01-01"][col["10yr vs 2yr US"]] == "0.0"
    assert rows["2023-10-01"][col["10yr vs 2yr US"]] == "-0.0", "negative zero as Python writes it"
    (current,) = js({"op": "csv", "fixture": str(FIXTURE), "cases": [{"start": "2026-11", "end": "2026-11"}]})
    row = current["csv"].split("\r\n")[1].split(",")
    for h in ("Monthly Fed Fund Rate - EOP US", "SP by month US", "10yr vs 2yr US"):
        assert row[col[h]] == "", f"{h}: the unfinished month's end-of-month value is blank"
    assert current["gatewayRequests"] == 13 and current["statcanRequests"] == 1


def test_known_difference_single_month_with_a_published_gap(monkeypatch, tmp_path):
    """Documented difference, kept on purpose: when a series has no value for the only
    requested month (Statistics Canada '..', here Alberta CPI 2024-01), the desktop's
    validate_sources stops the whole download before Excel opens; the browser keeps every
    other column and leaves that one cell blank with the reason 'No value published'."""
    with pytest.raises(ds.SourceError, match="no observations in an established historical interval"):
        _desktop_csv(monkeypatch, tmp_path, "2024-01", "2024-01")
    (browser,) = js({"op": "csv", "fixture": str(FIXTURE), "cases": [{"start": "2024-01", "end": "2024-01"}]})
    row = browser["csv"].split("\r\n")[1].split(",")
    assert row[0] == "2024-01-01"
    assert row[5] == "", "Alberta CPI (column F) is blank"
    assert all(row[i] != "" for i in (1, 2, 3, 4)), "the other Canadian columns are kept"
    assert browser["failed"] == []


def test_parity_does_not_depend_on_the_wall_clock(monkeypatch, tmp_path):
    """Regression: build_rows(today=...) validated against date.today(), so the fixed-today
    case 2026-11 failed once the real clock reached 2027-02 (lag boundary 2026-11)."""
    class Later(date):
        @classmethod
        def today(cls):
            return cls(2027, 3, 1)

    monkeypatch.setattr(ds, "date", Later)
    monkeypatch.setattr(workbook_io, "date", Later)  # rows now carry Later dates
    desktop = _desktop_csv(monkeypatch, tmp_path, "2026-11", "2026-11")
    (browser,) = js({"op": "csv", "fixture": str(FIXTURE), "cases": [{"start": "2026-11", "end": "2026-11"}]})
    assert browser["csv"].encode("utf-8") == desktop


# ---------------------------------------------------------------------------------------
# Independent expected values. A small hand-written fixture (not generate.py, not the
# implementation) whose expected CSV is worked out by hand from the series definitions:
#   * B-L, P-S are monthly series used exactly as published (FEDFUNDS, GS10 and GS2 are
#     already FRED's monthly averages of daily rates: nothing is re-averaged locally);
#   * M/N/O (DFF, SP500, T10Y2Y) take the LAST VALID daily observation of each calendar
#     month: weekends (SP500/T10Y2Y have no weekend rows, DFF has 7-day rows), market
#     holidays and a missing last day (FRED ".") fall back to the previous valid day;
#   * the current month (today 2024-04-10) is blank in M/N/O even though April data exist;
#   * FRED "." and StatCan ".." are blank (never 0, never the previous month's value);
#   * months not yet published are blank; rows are keyed YYYY-MM-01.
HAND_TODAY = "2024-04-10"
HAND_HEADERS = ["Date", "Headline CPI - Unadjusted CDN", "Headline CPI - Seasonally Adjusted CDN", "Core CPI - Unadjusted CDN",
                "Core CPI - Seasonally Adjusted CDN", "Alberta CPI - Unadjusted CDN", "Headline CPI - Unadjusted US",
                "Headline CPI - Seasonally Adjusted US", "Core CPI - Unadjusted US", "Core CPI - Seasonally Adjusted US",
                "Unemployment Rate - Seasonally Adjusted US", "Monthly Effective Fed Fund Rate US", "Monthly Fed Fund Rate - EOP US",
                "SP by month US", "10yr vs 2yr US", "10-Year Treasury Yield - Monthly Average US",
                "2-Year Treasury Yield - Monthly Average US", "PCE - Seasonally Adjusted US", "Core PCE - Seasonally Adjusted US"]
# Official identifiers per column (Statistics Canada tables 18-10-0004 NSA / 18-10-0006 SA;
# FRED series IDs), written out independently of schema.js and data_sources.py.
HAND_SOURCES = {"B": "41690973", "C": "41690914", "D": "41691233", "E": "41690924", "F": "41692327",
                "G": "CPIAUCNS", "H": "CPIAUCSL", "I": "CPILFENS", "J": "CPILFESL", "K": "UNRATE", "L": "FEDFUNDS",
                "M": "DFF", "N": "SP500", "O": "T10Y2Y", "P": "GS10", "Q": "GS2", "R": "PCEPI", "S": "PCEPILFE"}
HAND_EOM = {"M", "N", "O"}


def _hand_fixture():
    def sc(ym, value):
        return {"refPer": f"{ym}-01", "value": value, "decimals": 1, "scalarFactorCode": 0, "symbolCode": 0,
                "statusCode": 1 if value is None else 0, "securityLevelCode": 0, "releaseTime": "2024-03-19T08:30", "frequencyCode": 6}

    def fr(day, value):
        return {"realtime_start": HAND_TODAY, "realtime_end": HAND_TODAY, "date": day, "value": value}

    months = ["2023-11", "2023-12", "2024-01", "2024-02", "2024-03"]
    statcan = {  # published through 2024-02 on 2024-04-10; None is StatCan ".."
        "41690973": [158.3, 157.6, 158.3, 158.8], "41690914": [158.7, 159.0, 159.1, 159.3],
        "41691233": [152.2, 151.9, 152.6, 153.0], "41690924": [152.4, 152.6, 152.9, 153.1],
        "41692327": [164.8, None, 165.0, 165.6],
    }
    monthly = {  # FRED text as published; "." is FRED's missing value
        "CPIAUCNS": ["307.051", "306.746", "308.417", "310.326"], "CPIAUCSL": ["307.531", "308.024", "309.685", "311.054"],
        "CPILFENS": ["311.380", "310.919", "313.157", "314.651"], "CPILFESL": ["311.649", "312.711", "313.948", "315.130"],
        "UNRATE": ["3.7", "3.7", "3.7", "3.9", "3.8"], "FEDFUNDS": ["5.33", "5.33", "5.33", "5.33", "5.33"],
        "GS10": ["4.50", "4.02", "4.06", "4.21", "4.21"], "GS2": ["4.89", "4.46", "4.32", ".", "4.59"],
        "PCEPI": ["121.231", "121.373", "121.701", "122.000"], "PCEPILFE": ["120.987", "121.188", "121.761", "122.051"],
    }
    daily = {
        # DFF is a 7-day series (weekend rows exist). 2023-12-31 (Sun) is ".": the 30th wins.
        "DFF": [("2023-11-28", "5.32"), ("2023-11-29", "5.33"), ("2023-11-30", "5.34"),
                ("2023-12-29", "5.32"), ("2023-12-30", "5.31"), ("2023-12-31", "."),
                ("2024-01-30", "5.33"), ("2024-01-31", "5.32"), ("2024-02-28", "5.31"), ("2024-02-29", "5.30"),
                ("2024-03-29", "5.34"), ("2024-03-30", "5.34"), ("2024-03-31", "5.33"),
                ("2024-04-01", "5.33"), ("2024-04-08", "5.32")],
        # Trading days only: 2023-12-30/31 is a weekend; 2024-03-29 is Good Friday (".").
        "SP500": [("2023-11-29", "4550.58"), ("2023-11-30", "4567.80"), ("2023-12-28", "4783.35"), ("2023-12-29", "4769.83"),
                  ("2024-01-30", "4924.97"), ("2024-01-31", "4845.65"), ("2024-02-28", "5069.76"), ("2024-02-29", "5096.27"),
                  ("2024-03-27", "5248.49"), ("2024-03-28", "5254.35"), ("2024-03-29", "."),
                  ("2024-04-01", "5243.77"), ("2024-04-09", "5209.91")],
        "T10Y2Y": [("2023-11-29", "-0.37"), ("2023-11-30", "-0.36"), ("2023-12-28", "-0.38"), ("2023-12-29", "-0.35"),
                   ("2024-01-30", "-0.30"), ("2024-01-31", "-0.29"), ("2024-02-28", "-0.37"), ("2024-02-29", "-0.39"),
                   ("2024-03-27", "-0.40"), ("2024-03-28", "-0.39"), ("2024-03-29", "."), ("2024-04-01", "-0.39")],
    }
    fixture = {"schema": "cpi.source-fixture.v1", "today": HAND_TODAY, "statcan": {}, "fred": {}}
    for vector, values in statcan.items():
        fixture["statcan"][vector] = [sc(ym, v) for ym, v in zip(months, values)]
    for series, values in monthly.items():
        fixture["fred"][series] = [fr(f"{ym}-01", v) for ym, v in zip(months, values)]
    for series, rows in daily.items():
        obs = [fr(d, v) for d, v in rows]
        fixture["fred"][series] = obs[::-1] if series == "DFF" else obs  # response order must not matter
    return fixture


# Worked out by hand. Columns: Date, B..S. "" is an empty CSV cell.
HAND_EXPECTED = [
    ["2023-11-01", "158.3", "158.7", "152.2", "152.4", "164.8", "307.051", "307.531", "311.38", "311.649", "3.7", "5.33", "5.34", "4567.8", "-0.36", "4.5", "4.89", "121.231", "120.987"],
    ["2023-12-01", "157.6", "159.0", "151.9", "152.6", "", "306.746", "308.024", "310.919", "312.711", "3.7", "5.33", "5.31", "4769.83", "-0.35", "4.02", "4.46", "121.373", "121.188"],
    ["2024-01-01", "158.3", "159.1", "152.6", "152.9", "165.0", "308.417", "309.685", "313.157", "313.948", "3.7", "5.33", "5.32", "4845.65", "-0.29", "4.06", "4.32", "121.701", "121.761"],
    ["2024-02-01", "158.8", "159.3", "153.0", "153.1", "165.6", "310.326", "311.054", "314.651", "315.13", "3.9", "5.33", "5.3", "5096.27", "-0.39", "4.21", "", "122.0", "122.051"],
    ["2024-03-01", "", "", "", "", "", "", "", "", "", "3.8", "5.33", "5.33", "5254.35", "-0.39", "4.21", "4.59", "", ""],
    ["2024-04-01", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
]


def test_column_sources_are_the_official_series():
    cols = js({"op": "schema"})["columns"]
    by_col = {c["col"]: c for c in cols}
    assert {k: by_col[k]["sourceId"] for k in HAND_SOURCES} == HAND_SOURCES, "browser"
    desktop = {**ds.STATCAN_VECTORS, **ds.FRED_MONTHLY_SERIES, **ds.FRED_DAILY_EOM_SERIES}
    assert {k: desktop[by_col[k]["id"]] for k in HAND_SOURCES} == HAND_SOURCES, "desktop"
    assert {k for k, c in by_col.items() if c.get("kind") == "daily_eom"} == HAND_EOM
    assert set(ds.FRED_DAILY_EOM_SERIES.values()) == {HAND_SOURCES[k] for k in HAND_EOM}
    # The documentation tables state the same identifiers in the same columns.
    readme = (CPI / "README.md").read_text(encoding="utf-8")
    data_doc = (ROOT / "_tools" / "CPI_DATA.md").read_text(encoding="utf-8")
    for letter, sid in HAND_SOURCES.items():
        provider = "StatCan" if sid.isdigit() else "FRED"
        header = HAND_HEADERS[ord(letter) - ord("A")]
        assert f"| {letter} / `{by_col[letter]['id']}` | {header} | {provider} {sid} |" in readme, letter
        assert f"| {letter} | {header} | {provider} {sid} |" in data_doc, letter


def test_hand_computed_csv_on_both_engines(monkeypatch, tmp_path):
    path = tmp_path / "hand.json"
    path.write_text(json.dumps(_hand_fixture()), encoding="utf-8")
    expected = "\r\n".join(",".join(r) for r in [HAND_HEADERS, *HAND_EXPECTED]) + "\r\n"
    desktop = _desktop_csv(monkeypatch, tmp_path, "2023-11", "2024-04", fixture_path=path, today=date.fromisoformat(HAND_TODAY))
    assert desktop.decode("utf-8") == expected, "desktop"
    (browser,) = js({"op": "csv", "fixture": str(path), "cases": [{"start": "2023-11", "end": "2024-04"}]})
    assert browser["failed"] == []
    assert browser["csv"] == expected, "browser"
