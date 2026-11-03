"""The public CPI workbook (shipped in the CPI ZIP) carries no S&P 500 values, no cached
results derived from them and no local metadata (see _tools/cpi_public_workbook.py)."""
import importlib.util
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cpi_public_workbook", ROOT / "_tools" / "cpi_public_workbook.py")
tool = importlib.util.module_from_spec(spec)
sys.modules["cpi_public_workbook"] = tool
spec.loader.exec_module(tool)


def test_shipped_workbook_is_clean_and_deterministic():
    data = tool.WORKBOOK.read_bytes()
    assert tool.audit(data) == []
    assert tool.scrub(data) == data, "run: python _tools/cpi_public_workbook.py --write"


def test_known_sp500_values_and_identifiers_are_absent():
    package = zipfile.ZipFile(tool.WORKBOOK)
    blob = b"".join(package.read(name) for name in package.namelist())
    for needle in (b"7619.98", b"2168.27", b"absPath", b"webextension", b"Users\\", b"xl/printerSettings/", b"claude.fileId"):
        assert needle not in blob, needle


def test_model_structure_is_kept():
    package = zipfile.ZipFile(tool.WORKBOOK)
    sheets = tool._sheet_parts({n: package.read(n) for n in ("xl/workbook.xml", "xl/_rels/workbook.xml.rels")})
    assert list(sheets) == ["CPI_Downloader", "US Data", "CDN Data", "Data Visualizations"]
    counts = {name: len(re.findall(rb"<f[ >/]", package.read(part))) for name, part in sheets.items()}
    assert counts == {"CPI_Downloader": 0, "US Data": 44, "CDN Data": 25, "Data Visualizations": 6402}
    assert sum(1 for n in package.namelist() if n.startswith("xl/charts/chart")) == 5
    assert b'fullCalcOnLoad="1"' in package.read("xl/workbook.xml")


def test_scrub_removes_a_planted_value(tmp_path):
    # Re-inserting one S&P value into column N is caught by the audit.
    data = tool.WORKBOOK.read_bytes()
    package = zipfile.ZipFile(tool.WORKBOOK)
    part = tool._sheet_parts({n: package.read(n) for n in ("xl/workbook.xml", "xl/_rels/workbook.xml.rels")})["CPI_Downloader"]
    out = tmp_path / "planted.xlsx"
    with zipfile.ZipFile(out, "w") as target:
        for name in package.namelist():
            body = package.read(name)
            if name == part:
                body = body.replace(b'<c r="N1300" s="115"/>', b'<c r="N1300" s="115"><v>4000.5</v></c>', 1)
                assert b"4000.5" in body
            target.writestr(name, body)
    assert any("S&P 500" in p for p in tool.audit(out.read_bytes()))
    assert tool.audit(tool.scrub(out.read_bytes())) == []
