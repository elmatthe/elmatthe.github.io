"""
Minimal verify gate for the CPI Dashboard Downloader.

Run with the repo's venv interpreter:
    .venv\\Scripts\\python.exe scripts\\verify.py

It performs the fast, mechanical checks from AI-WORKSPACE.md:
  1. Every dependency in scripts/requirements.txt is pinned with '=='.
  2. The pytest suite in files/tests/ passes.

Exits non-zero if any check fails, so it can gate a commit/release.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQS = ROOT / "scripts" / "requirements.txt"
TESTS = ROOT / "files" / "tests"


def check_pins() -> bool:
    print("[verify] Checking requirements.txt pins...")
    unpinned = []
    for raw in REQS.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "==" not in line:
            unpinned.append(line)
    if unpinned:
        print("  FAIL - unpinned dependencies:")
        for u in unpinned:
            print(f"    {u}")
        return False
    print("  OK - all dependencies pinned.")
    return True


def run_pytest() -> bool:
    print("[verify] Running pytest...")
    result = subprocess.run([sys.executable, "-m", "pytest", str(TESTS), "-q"])
    if result.returncode != 0:
        print("  FAIL - tests did not pass.")
        return False
    print("  OK - all tests passed.")
    return True


def main() -> int:
    ok = True
    ok &= check_pins()
    ok &= run_pytest()
    print()
    if ok:
        print("[verify] PASS")
        return 0
    print("[verify] FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
