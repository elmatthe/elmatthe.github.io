#!/usr/bin/env python3
"""Build the user download ZIPs for the four tools on /projects/.

    python _tools/build_project_zips.py          # (re)build the ZIPs in projects/
    python _tools/build_project_zips.py --check  # exit 1 if a ZIP differs from a fresh build

Each ZIP holds one top-level folder with only what a user needs: the launcher(s),
scripts/ (including bootstrap.py and pinned requirements.txt), config defaults, the
README and required data files. Tests, developer notes, caches, virtual environments,
logs and private configuration are never packaged. Builds are deterministic (fixed
timestamps, sorted entries), so an unchanged source produces a byte-identical ZIP.
"""
from __future__ import annotations

import argparse
import fnmatch
import io
import re
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ROOT / "projects"
FIXED_TIME = (2026, 9, 28, 0, 0, 0)

# Never packaged, whatever a spec includes.
ALWAYS_EXCLUDE = [
    "**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", "**/.venv/**", "**/.git/**",
    "**/.DS_Store", "**/Thumbs.db", "**/*.log", "files/temp/**", "files/test-logs/**",
    "files/runtime/**", "files/run-temp/**", "files/cache/**", "files/tests/**", "md-instructions/**",
    "**/.env", "**/.env.*", "**/*.pem", "**/*.key", ".gitignore", ".gitattributes",
]

# Patterns that must not appear in any packaged text file.
SECRET_PATTERNS = [
    re.compile(r"api_key\s*=\s*\"[^\"]+\""),
    re.compile(r"\"api_key\"\s*:\s*\"[^\"]+\""),
    re.compile(r"\b[0-9a-f]{32}\b"),  # FRED keys are 32 lowercase hex characters
    re.compile(r"(?i)(secret|token|password)\s*[:=]\s*[\"'][^\"']{8,}[\"']"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
TEXT_SUFFIXES = {".py", ".md", ".toml", ".txt", ".bat", ".command", ".ts", ".csv", ".json", ".cfg", ".ini"}


@dataclass
class Spec:
    source: str  # folder under projects/
    zip_name: str
    folder: str  # top-level folder name inside the ZIP
    include: list[str]
    exclude: list[str] = field(default_factory=list)
    required: list[str] = field(default_factory=list)


SPECS = {
    "monte-carlo": Spec(
        "monte-carlo-retirement-simulator", "monte-carlo-retirement-simulator.zip",
        "monte-carlo-retirement-simulator",
        ["README.md", "config.toml", "Setup_and_Run-*.bat", "Setup_and_Run-*.command", "scripts/**"],
        required=["scripts/bootstrap.py", "scripts/main.py", "scripts/requirements.txt", "config.toml",
                  "Setup_and_Run-monte-carlo-retirement-simulator.bat",
                  "Setup_and_Run-monte-carlo-retirement-simulator.command"],
    ),
    "rebalancer": Spec(
        "portfolio-rebalancer-tool", "portfolio-rebalancer.zip", "portfolio-rebalancer-tool",
        ["README.md", "config.toml", "Setup_and_Run-*.bat", "Setup_and_Run-*.command", "scripts/**"],
        required=["scripts/bootstrap.py", "scripts/main.py", "scripts/requirements.txt", "config.toml",
                  "Setup_and_Run-portfolio-rebalancer.bat", "Setup_and_Run-portfolio-rebalancer.command"],
    ),
    "stock": Spec(
        "Stock-Data-Dashboard-Tool", "stock-data-dashboard-tool.zip", "Stock-Data-Dashboard-Tool",
        ["README.md", "config.toml", "Setup_and_Run-*.bat", "Setup_and_Run-*.command", "scripts/**",
         "test-files/**", "files/exports/.gitkeep", "files/plots/.gitkeep", "files/website-assets/.gitkeep"],
        required=["scripts/bootstrap.py", "scripts/main.py", "scripts/requirements.txt", "config.toml",
                  "test-files/sample_prices.csv", "test-files/fx_rates.csv",
                  "Setup_and_Run-stock-data-dashboard-tool.bat", "Setup_and_Run-stock-data-dashboard-tool.command"],
    ),
    # Packaged from projects/CPI-Webscraper, a copy of elmatthe/CPI-Webscraper main.
    # The user's config.toml is created by the launcher from scripts/config-default.toml.
    "cpi": Spec(
        "CPI-Webscraper", "cpi-web-scraper.zip", "CPI-Webscraper",
        ["README.md", "Setup_and_Run-*.bat", "scripts/**", "files/CPI.xlsx", "files/office-scripts/**"],
        exclude=["config.toml", "files/config.json", "scripts/verify.py"],
        required=["scripts/bootstrap.py", "scripts/cpi_webscraper.py", "scripts/requirements.txt",
                  "scripts/config-default.toml", "files/CPI.xlsx", "Setup_and_Run-cpi-webscraper.bat"],
    ),
}


def matches(rel: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatchcase(rel, pattern):
            return True
        if pattern.startswith("**/") and fnmatch.fnmatchcase(rel, pattern[3:]):
            return True
    return False


def collect(spec: Spec) -> list[str]:
    base = PROJECTS / spec.source
    files = []
    for path in sorted(base.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(base).as_posix()
        if matches(rel, spec.include) and not matches(rel, ALWAYS_EXCLUDE + spec.exclude):
            files.append(rel)
    missing = [r for r in spec.required if r not in files]
    if missing:
        raise SystemExit(f"{spec.zip_name}: required files missing: {', '.join(missing)}")
    return files


def content_for(rel: str, data: bytes) -> bytes:
    if rel.endswith(".bat"):  # cmd.exe parses labels/goto reliably only with CRLF
        return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    if rel.endswith(".command"):
        return data.replace(b"\r\n", b"\n")
    return data


def scan_secrets(rel: str, data: bytes) -> list[str]:
    if Path(rel).suffix.lower() not in TEXT_SUFFIXES:
        return []
    text = data.decode("utf-8", errors="replace")
    return [f"{rel}: matches {p.pattern!r}" for p in SECRET_PATTERNS if p.search(text)]


def build(spec: Spec) -> tuple[bytes, list[str]]:
    base = PROJECTS / spec.source
    buffer = io.BytesIO()
    problems: list[str] = []
    files = collect(spec)
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in files:
            data = content_for(rel, (base / rel).read_bytes())
            problems += scan_secrets(rel, data)
            info = zipfile.ZipInfo(f"{spec.folder}/{rel}", date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # Unix, so the permission bits below are honoured
            mode = 0o755 if rel.endswith(".command") else 0o644
            info.external_attr = (0o100000 | mode) << 16
            archive.writestr(info, data)
    return buffer.getvalue(), problems


def human_size(size: int) -> str:
    return f"{size / 1024:.0f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.1f} MB"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="verify only; do not write")
    parser.add_argument("only", nargs="*", metavar="TOOL", help=f"limit to these tools ({', '.join(SPECS)})")
    args = parser.parse_args()
    unknown = set(args.only) - set(SPECS)
    if unknown:
        parser.error(f"unknown tool(s): {', '.join(sorted(unknown))}")
    failed = False
    for key, spec in SPECS.items():
        if args.only and key not in args.only:
            continue
        data, problems = build(spec)
        if problems:
            print(f"{spec.zip_name}: possible secret(s), not written:\n  " + "\n  ".join(problems))
            failed = True
            continue
        target = PROJECTS / spec.zip_name
        if args.check:
            if not target.is_file() or target.read_bytes() != data:
                print(f"{spec.zip_name}: stale (run _tools/build_project_zips.py)")
                failed = True
            else:
                print(f"{spec.zip_name}: current ({human_size(len(data))})")
            continue
        target.write_bytes(data)
        with zipfile.ZipFile(target) as archive:
            count = len(archive.namelist())
        print(f"{spec.zip_name}: {count} files, {human_size(len(data))}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
