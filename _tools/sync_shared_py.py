#!/usr/bin/env python3
"""Copies the shared desktop market-data package into each desktop tool.

The canonical source is _tools/shared_py/market_data/ plus the site's curated
instrument reference assets/data/instruments.v1.json. Each desktop tool ships an
identical copy in scripts/market_data/ (its ZIP must be self-contained).

    python _tools/sync_shared_py.py          # write the copies
    python _tools/sync_shared_py.py --check  # fail if any copy differs (CI)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "_tools" / "shared_py" / "market_data"
REFERENCE = ROOT / "assets" / "data" / "instruments.v1.json"
TARGETS = [ROOT / "projects" / "portfolio-rebalancer-tool" / "scripts" / "market_data",
           ROOT / "projects" / "Stock-Data-Dashboard-Tool" / "scripts" / "market_data"]


def expected_files() -> dict[str, bytes]:
    files = {p.name: p.read_bytes() for p in sorted(SOURCE.glob("*.py"))}
    files["instruments.v1.json"] = REFERENCE.read_bytes()
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only check that every copy is current")
    args = parser.parse_args()
    files = expected_files()
    problems = []
    for target in TARGETS:
        present = {p.name for p in target.glob("*") if p.is_file()} if target.exists() else set()
        for name, data in files.items():
            path = target / name
            current = path.read_bytes() if path.exists() else None
            if current != data:
                if args.check:
                    problems.append(f"{path.relative_to(ROOT)} is {'missing' if current is None else 'out of date'}")
                else:
                    target.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
        for extra in sorted(present - set(files)):
            if args.check:
                problems.append(f"{(target / extra).relative_to(ROOT)} is not part of the shared package")
            else:
                (target / extra).unlink()
    if problems:
        print("\n".join(problems))
        print("Run: python _tools/sync_shared_py.py")
        return 1
    print("Shared market_data copies are current." if args.check else f"Wrote {len(files)} files to {len(TARGETS)} tools.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
