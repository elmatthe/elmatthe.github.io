"""Prepare and check the PUBLIC copy of the CPI Web Scraper workbook (files/CPI.xlsx).

Why: the canonical workbook (private repository elmatthe/CPI-Webscraper) contains
121 monthly S&P 500 closes from FRED series SP500, whose notes say "Reproduction of
S&P 500 in any form is prohibited except with the prior written permission of S&P Dow
Jones Indices LLC", plus local metadata (an absolute Windows path with a user name, an
Office add-in reference, a printer identifier and author names). The public ZIP must
not redistribute either. The private original is not changed by this tool.

What `--write` does (package-level edits only; no formula, style, chart, sheet or
defined-name changes, so the model's structure is preserved):
  * CPI_Downloader column N (S&P 500) rows 2+: values removed (header kept).
  * Cached results removed from every formula cell and every dynamic-array spill range,
    and from every chart's cached series (numCache/strCache), because they can be
    derived from the S&P values; <calcPr fullCalcOnLoad="1"> makes desktop Excel
    recalculate everything when the file is opened.
  * Removed: the x15ac:absPath block, the web-extension (add-in) parts, the printer
    settings part, and the creator / last-modified-by names in docProps/core.xml.
The ZIP is rewritten deterministically (fixed timestamps, original part order).

    python _tools/cpi_public_workbook.py --write   # scrub files/CPI.xlsx in place
    python _tools/cpi_public_workbook.py --check   # exit 1 if anything above remains
"""
from __future__ import annotations

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "projects" / "CPI-Webscraper" / "files" / "CPI.xlsx"
RAW_SHEET = "CPI_Downloader"
SP500_COLUMN = "N"
FIXED_TIME = (1980, 1, 1, 0, 0, 0)

_CELL = re.compile(r"<c\b([^>]*?)(/>|>(.*?)</c>)", re.S)
_REF = re.compile(r'\br="([A-Z]+)(\d+)"')
_ARRAY_REF = re.compile(r'<f\b[^>]*\bt="array"[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"')
_VALUE = re.compile(r"<v>.*?</v>|<v/>|<is>.*?</is>", re.S)
_TYPE = re.compile(r'\s+t="[^"]*"')
_ABS_PATH = re.compile(r"<mc:AlternateContent\b[^>]*>\s*<mc:Choice Requires=\"x15\">\s*<x15ac:absPath\b.*?</mc:AlternateContent>", re.S)


def col_number(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def _sheet_parts(files: dict[str, bytes]) -> dict[str, str]:
    """Sheet name -> part name (xl/worksheets/sheetN.xml)."""
    workbook = files["xl/workbook.xml"].decode("utf-8")
    rels = files["xl/_rels/workbook.xml.rels"].decode("utf-8")
    targets = dict(re.findall(r'<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
    targets.update({rid: target for target, rid in re.findall(r'<Relationship [^>]*Target="([^"]+)"[^>]*Id="([^"]+)"', rels)})
    out = {}
    for name, rid in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="([^"]+)"', workbook):
        target = targets[rid]
        out[name] = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
    return out


def _array_ranges(xml: str) -> list[tuple[int, int, int, int]]:
    return [(col_number(c1), int(r1), col_number(c2), int(r2)) for c1, r1, c2, r2 in _ARRAY_REF.findall(xml)]


def _strip_cell(attrs: str) -> str:
    return f"<c{_TYPE.sub('', attrs)}/>"


def scrub_sheet(xml: str, blank_column: str | None = None) -> str:
    """Remove cached results of formulas and spills (and optionally one column's values)."""
    ranges = _array_ranges(xml)
    blank = col_number(blank_column) if blank_column else None

    def in_spill(col: int, row: int) -> bool:
        return any(c1 <= col <= c2 and r1 <= row <= r2 for c1, r1, c2, r2 in ranges)

    def fix(match: re.Match) -> str:
        attrs, body = match.group(1), match.group(3)
        if body is None:
            return match.group(0)
        ref = _REF.search(attrs)
        col, row = (col_number(ref.group(1)), int(ref.group(2))) if ref else (0, 0)
        if "<f" in body:
            formula = re.search(r"<f\b.*?(?:</f>|/>)", body, re.S).group(0)
            return f"<c{_TYPE.sub('', attrs)}>{formula}</c>"
        if (blank is not None and col == blank and row >= 2) or in_spill(col, row):
            return _strip_cell(attrs)
        return match.group(0)

    return _CELL.sub(fix, xml)


def scrub_chart(xml: str) -> str:
    xml = re.sub(r"<c:numCache>.*?</c:numCache>", "", xml, flags=re.S)
    return re.sub(r"<c:strCache>.*?</c:strCache>", "", xml, flags=re.S)


def scrub(data: bytes) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(data))
    order = [info.filename for info in source.infolist()]
    files = {name: source.read(name) for name in order}
    sheets = _sheet_parts(files)
    raw_part = sheets[RAW_SHEET]

    for name, part in sheets.items():
        files[part] = scrub_sheet(files[part].decode("utf-8"), SP500_COLUMN if part == raw_part else None).encode("utf-8")
    for name in order:
        if name.startswith("xl/charts/chart") and name.endswith(".xml"):
            files[name] = scrub_chart(files[name].decode("utf-8")).encode("utf-8")

    workbook = files["xl/workbook.xml"].decode("utf-8")
    workbook = _ABS_PATH.sub("", workbook)
    workbook = re.sub(r"<calcPr\b([^>]*?)\s*/>", lambda m: "<calcPr" + re.sub(r'\s+fullCalcOnLoad="[^"]*"', "", m.group(1)) + ' fullCalcOnLoad="1"/>', workbook)
    files["xl/workbook.xml"] = workbook.encode("utf-8")

    # Office add-in (web extension) parts.
    drop = {n for n in order if n.startswith("xl/webextensions/")}
    rels = files["_rels/.rels"].decode("utf-8")
    rels = re.sub(r'<Relationship [^>]*Target="xl/webextensions/[^"]*"[^>]*/>', "", rels)
    files["_rels/.rels"] = rels.encode("utf-8")

    # Printer settings (device name and identifier).
    printer_parts = {n for n in order if n.startswith("xl/printerSettings/")}
    drop |= printer_parts
    for name in order:
        if name.startswith("xl/worksheets/_rels/") and name in files:
            text = files[name].decode("utf-8")
            ids = re.findall(r'<Relationship Id="([^"]+)"[^>]*Target="\.\./printerSettings/[^"]+"[^>]*/>', text)
            ids += re.findall(r'<Relationship [^>]*Target="\.\./printerSettings/[^"]+"[^>]*Id="([^"]+)"[^>]*/>', text)
            if not ids:
                continue
            text = re.sub(r'<Relationship [^>]*Target="\.\./printerSettings/[^"]+"[^>]*/>', "", text)
            sheet_part = "xl/worksheets/" + name.rsplit("/", 1)[1][:-5]
            sheet_xml = files[sheet_part].decode("utf-8")
            for rid in ids:
                sheet_xml = re.sub(rf'\s+r:id="{re.escape(rid)}"', "", sheet_xml)
            files[sheet_part] = sheet_xml.encode("utf-8")
            if "<Relationship " in text:
                files[name] = text.encode("utf-8")
            else:
                drop.add(name)

    types = files["[Content_Types].xml"].decode("utf-8")
    for part in drop:
        types = re.sub(rf'<Override PartName="/{re.escape(part)}"[^>]*/>', "", types)
    files["[Content_Types].xml"] = types.encode("utf-8")

    core = files["docProps/core.xml"].decode("utf-8")
    core = re.sub(r"<dc:creator>.*?</dc:creator>", "<dc:creator></dc:creator>", core, flags=re.S)
    core = re.sub(r"<cp:lastModifiedBy>.*?</cp:lastModifiedBy>", "<cp:lastModifiedBy></cp:lastModifiedBy>", core, flags=re.S)
    files["docProps/core.xml"] = core.encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for name in order:
            if name in drop:
                continue
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            target.writestr(info, files[name])
    return out.getvalue()


def audit(data: bytes) -> list[str]:
    """Problems that must not be in the public workbook (empty list = clean)."""
    problems: list[str] = []
    package = zipfile.ZipFile(io.BytesIO(data))
    names = package.namelist()
    files = {n: package.read(n) for n in names}
    text = {n: b.decode("utf-8", "replace") for n, b in files.items() if n.endswith((".xml", ".rels"))}
    sheets = _sheet_parts(files)
    raw = text[sheets[RAW_SHEET]]
    for match in _CELL.finditer(raw):
        ref = _REF.search(match.group(1))
        if ref and ref.group(1) == SP500_COLUMN and int(ref.group(2)) >= 2 and match.group(3) and "<v>" in match.group(3):
            problems.append(f"{RAW_SHEET}!{SP500_COLUMN}{ref.group(2)} still holds an S&P 500 value")
            break
    for name, part in sheets.items():
        xml = text[part]
        ranges = _array_ranges(xml)
        for match in _CELL.finditer(xml):
            body = match.group(3) or ""
            if "<v>" not in body:
                continue
            if "<f" in body:
                problems.append(f"{name}: a formula cell keeps a cached value")
                break
            ref = _REF.search(match.group(1))
            col, row = col_number(ref.group(1)), int(ref.group(2))
            if any(c1 <= col <= c2 and r1 <= row <= r2 for c1, r1, c2, r2 in ranges):
                problems.append(f"{name}: a dynamic-array spill keeps cached values")
                break
    if any("<c:numCache>" in x or "<c:strCache>" in x for n, x in text.items() if n.startswith("xl/charts/chart")):
        problems.append("a chart keeps cached series values")
    if 'fullCalcOnLoad="1"' not in text["xl/workbook.xml"]:
        problems.append("the workbook is not set to recalculate when opened")
    for n, x in text.items():
        if "absPath" in x:
            problems.append(f"{n}: absolute local path")
        if re.search(r"[A-Za-z]:\\\\?Users\\\\?", x):
            problems.append(f"{n}: local user folder")
    if any(n.startswith("xl/webextensions/") for n in names) or "webextension" in text["[Content_Types].xml"] + text["_rels/.rels"]:
        problems.append("Office add-in (web extension) parts")
    if any(n.startswith("xl/printerSettings/") for n in names):
        problems.append("printer settings part")
    core = text["docProps/core.xml"]
    if re.search(r"<dc:creator>[^<]+</dc:creator>|<cp:lastModifiedBy>[^<]+</cp:lastModifiedBy>", core):
        problems.append("author names in document properties")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="scrub the workbook in place")
    parser.add_argument("--check", action="store_true", help="fail if the workbook is not clean")
    parser.add_argument("--path", type=Path, default=WORKBOOK)
    args = parser.parse_args(argv)
    data = args.path.read_bytes()
    if args.write:
        cleaned = scrub(data)
        args.path.write_bytes(cleaned)
        data = cleaned
        print(f"wrote {args.path} ({len(cleaned):,} bytes)")
    problems = audit(data)
    if not problems and scrub(data) != data:
        problems.append("the workbook is not in its deterministic scrubbed form (run --write)")
    for problem in problems:
        print(f"NOT CLEAN: {problem}")
    if not problems:
        print("Public CPI workbook is clean: no S&P 500 values, cached results, local paths, add-in parts, printer settings or author names.")
    return 1 if problems and (args.check or args.write) else 0


if __name__ == "__main__":
    sys.exit(main())
