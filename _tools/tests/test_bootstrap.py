"""Tests for the shared desktop bootstrap (scripts/bootstrap.py in each tool).

Fast tests mock the operating system to cover Windows/macOS branches. Tests marked
`e2e` really run the bootstrap on this machine: they create a .venv in a temporary
copy of each tool, install the pinned packages (network required) and exercise the
repair paths. Run everything with:

    python -m pytest _tools/tests/test_bootstrap.py -q            # fast + e2e
    python -m pytest _tools/tests/test_bootstrap.py -q -m "not e2e"  # fast only

The e2e tests need a Python 3.11-3.14 with tkinter on PATH. Windows and macOS
provisioning (winget / Homebrew) cannot be executed here; those branches are
covered by the mocked tests and remain manual platform checks.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPECS = tomllib.loads((ROOT / "_tools" / "bootstrap" / "projects.toml").read_text(encoding="utf-8"))
TOOLS = {key: ROOT / spec["dir"] for key, spec in SPECS.items()}
IGNORE = shutil.ignore_patterns(".venv", "__pycache__", "files", ".pytest_cache")


def load(path: Path):
    spec = importlib.util.spec_from_file_location(f"bootstrap_{abs(hash(path))}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses need the module registered
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def copy_tool(key: str, dest: Path) -> Path:
    target = dest / TOOLS[key].name
    shutil.copytree(TOOLS[key], target, ignore=IGNORE)
    return target


# ---------------------------------------------------------------- rendering
def test_rendered_files_are_current():
    result = subprocess.run([sys.executable, str(ROOT / "_tools" / "bootstrap" / "render.py"), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("key", sorted(TOOLS))
def test_launcher_files(key):
    slug = SPECS[key]["slug"]
    bat = (TOOLS[key] / f"Setup_and_Run-{slug}.bat").read_bytes()
    command = TOOLS[key] / f"Setup_and_Run-{slug}.command"
    assert b"\r\n" in bat and b"\n" not in bat.replace(b"\r\n", b""), "the .bat must use CRLF only"
    assert bat.isascii(), "the .bat must be plain ASCII for cmd.exe"
    text = bat.decode()
    labels = {line[1:].split()[0].lower() for line in text.splitlines() if line.startswith(":") and not line.startswith("::")}
    import re
    targets = {t.lower() for t in re.findall(r"(?:goto|call)\s+:?([A-Za-z_]+)", text) if t.lower() != "eof"}
    assert targets <= labels, f"undefined labels: {targets - labels}"
    body = command.read_bytes()
    assert b"\r" not in body and body.startswith(b"#!/bin/bash")
    if os.name != "nt":
        assert command.stat().st_mode & stat.S_IXUSR
    assert subprocess.run(["bash", "-n", str(command)]).returncode == 0
    config = tomllib.loads((TOOLS[key] / "config.toml").read_text(encoding="utf-8"))
    assert config["python"] == {"minimum_version": "3.11", "maximum_version_exclusive": "3.15"}
    assert (TOOLS[key] / config["execution"]["entry_point"]).is_file()


@pytest.mark.parametrize("key", sorted(TOOLS))
def test_requirements_are_exact_pins_without_test_tools(key):
    module = load(TOOLS[key] / "scripts" / "bootstrap.py")
    pins = module.requirement_pins()
    assert pins and "pytest" not in {k.lower() for k in pins}


# ---------------------------------------------------------------- mocked behaviour
@pytest.fixture
def boot(tmp_path):
    root = copy_tool("monte-carlo", tmp_path)
    return load(root / "scripts" / "bootstrap.py"), root


def test_runtime_bounds_and_entry_point(boot):
    module, root = boot
    assert module.runtime_bounds(module.read_config()) == ((3, 11), (3, 15))
    with pytest.raises(module.BootstrapError):
        module.runtime_bounds({"python": {"minimum_version": "3.14", "maximum_version_exclusive": "3.11"}})
    with pytest.raises(module.BootstrapError, match="outside"):
        module.entry_point({"execution": {"entry_point": "../../etc/passwd"}})
    assert module.entry_point(module.read_config()) == (root / "scripts" / "main.py").resolve()


def test_requirement_pins_rejects_loose_specifiers(boot):
    module, root = boot
    (root / "scripts" / "requirements.txt").write_text("numpy>=2\n")
    with pytest.raises(module.BootstrapError, match="exact pin"):
        module.requirement_pins()


@pytest.mark.parametrize("payload,accepted", [
    ({"exe": "C:/Python313/python.exe", "v": [3, 13, 1], "level": "final", "missing": [], "venv": False}, True),
    ({"exe": "C:/Python313/python.exe", "v": [3, 15, 0], "level": "final", "missing": [], "venv": False}, False),
    ({"exe": "C:/Python313/python.exe", "v": [3, 10, 9], "level": "final", "missing": [], "venv": False}, False),
    ({"exe": "C:/Python314/python.exe", "v": [3, 14, 0], "level": "candidate", "missing": [], "venv": False}, False),
    ({"exe": "C:/Users/x/AppData/Local/Microsoft/WindowsApps/python.exe", "v": [3, 12, 0], "level": "final", "missing": [], "venv": False}, False),
    ({"exe": "/opt/homebrew/bin/python3.13", "v": [3, 13, 0], "level": "final", "missing": ["tkinter"], "venv": False}, True),
    ({"exe": "/tmp/x/.venv/bin/python", "v": [3, 12, 0], "level": "final", "missing": [], "venv": True}, False),
])
def test_probe_python_filters(boot, monkeypatch, payload, accepted):
    module, _ = boot
    monkeypatch.setattr(module, "run_bounded", lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps(payload)))
    candidate = module.probe_python("python", (), (3, 11), (3, 15), modules=("tkinter",))
    assert (candidate is not None) == accepted
    if candidate is not None and payload["missing"]:
        assert not candidate.usable


def test_windows_install_is_user_scope_without_path_changes(boot, monkeypatch):
    module, _ = boot
    calls = []
    monkeypatch.setattr(module.os, "name", "nt")
    monkeypatch.setattr(module.shutil, "which", lambda name: "C:/winget.exe" if name == "winget" else None)
    monkeypatch.setattr(module, "ask_yes_no", lambda q: True)
    monkeypatch.setattr(module, "run_visible", lambda args: calls.append([str(a) for a in args]) or 0)
    assert module.offer_python_install([]) is True
    args = calls[0]
    assert args[:4] == ["C:/winget.exe", "install", "--id", "Python.Python.3.13"]
    assert "--scope" in args and args[args.index("--scope") + 1] == "user"
    override = args[args.index("--override") + 1]
    assert "InstallAllUsers=0" in override and "PrependPath=0" in override


def test_windows_install_declined_or_no_winget(boot, monkeypatch):
    module, _ = boot
    monkeypatch.setattr(module.os, "name", "nt")
    monkeypatch.setattr(module.shutil, "which", lambda name: None)
    assert module.offer_python_install([]) is False
    monkeypatch.setattr(module.shutil, "which", lambda name: "C:/winget.exe")
    monkeypatch.setattr(module, "ask_yes_no", lambda q: False)
    monkeypatch.setattr(module, "run_visible", lambda args: pytest.fail("must not install without consent"))
    assert module.offer_python_install([]) is False


def test_macos_offers_python_tk_for_homebrew_python_without_tkinter(boot, monkeypatch):
    module, _ = boot
    calls = []
    monkeypatch.setattr(module.os, "name", "posix")
    monkeypatch.setattr(module.sys, "platform", "darwin")
    monkeypatch.setattr(module, "brew", lambda: "/opt/homebrew/bin/brew")
    monkeypatch.setattr(module, "ask_yes_no", lambda q: True)
    monkeypatch.setattr(module, "run_visible", lambda args: calls.append([str(a) for a in args]) or 0)
    lacking = module.PythonCandidate(Path("/opt/homebrew/bin/python3.12"), (), (3, 12, 7), ("tkinter",))
    assert module.offer_python_install([lacking]) is True
    assert calls[0] == ["/opt/homebrew/bin/brew", "install", "python-tk@3.12"]
    calls.clear()
    assert module.offer_python_install([]) is True
    assert calls[0] == ["/opt/homebrew/bin/brew", "install", "python@3.13", "python-tk@3.13"]


def test_no_python_gives_actionable_error(boot, monkeypatch):
    module, _ = boot
    monkeypatch.setattr(module, "discover_pythons", lambda lo, hi: [])
    monkeypatch.setattr(module, "offer_python_install", lambda unusable: False)
    with pytest.raises(module.BootstrapError, match="No compatible Python 3.11-3.14 with tkinter"):
        module.ensure_base_python((3, 11), (3, 15))


def test_refuses_to_rebuild_from_inside_venv(boot, monkeypatch):
    module, _ = boot
    monkeypatch.setattr(module, "running_from_venv", lambda: True)
    with pytest.raises(module.BootstrapError, match="cannot rebuild"):
        module.rebuild_venv(module.PythonCandidate(Path(sys.executable), (), (3, 12, 0)))


def test_failed_rebuild_restores_previous_venv(boot, monkeypatch):
    module, root = boot
    (root / ".venv").mkdir()
    (root / ".venv" / "keep.txt").write_text("old")
    monkeypatch.setattr(module, "run_visible", lambda args: 1)
    with pytest.raises(module.BootstrapError, match="could not create"):
        module.rebuild_venv(module.PythonCandidate(Path(sys.executable), (), (3, 12, 0)))
    assert (root / ".venv" / "keep.txt").read_text() == "old"
    assert not list((root / "files" / "temp" / "bootstrap").glob("venv-backup-*"))


def test_venv_check_is_read_only(boot):
    module, root = boot
    assert module.main(["--venv-check"]) == module.EXIT_VENV_UNHEALTHY
    assert not (root / "files").exists() and not (root / ".venv").exists()


def test_launch_only_refuses_unhealthy_environment(boot):
    module, _ = boot
    assert module.main(["--launch-only"]) == module.EXIT_SETUP_FAILED


# ---------------------------------------------------------------- real end-to-end runs
def host_python() -> str | None:
    for name in ("python3.13", "python3.12", "python3.11", "python3.14", "python3"):
        exe = shutil.which(name)
        if exe and subprocess.run([exe, "-c", "import tkinter, venv, ensurepip, sys; assert (3,11) <= sys.version_info[:2] < (3,15)"],
                                  capture_output=True).returncode == 0:
            return exe
    return None


HOST = host_python()
e2e = pytest.mark.skipif(HOST is None, reason="needs a Python 3.11-3.14 with tkinter on PATH")


def run(args, cwd, env_extra=None, timeout=900):
    env = {**os.environ, "AI_BOOTSTRAP_TEST_MODE": "1", **(env_extra or {})}
    return subprocess.run([str(a) for a in args], cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)


def venv_py(root: Path) -> Path:
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def site_packages(root: Path) -> Path:
    return next((root / ".venv").glob("lib/python3.*/site-packages")) if os.name != "nt" else root / ".venv" / "Lib" / "site-packages"


@pytest.mark.e2e
@e2e
@pytest.mark.parametrize("key", sorted(TOOLS))
def test_bootstrap_end_to_end(key, tmp_path):
    root = copy_tool(key, tmp_path)
    boot = root / "scripts" / "bootstrap.py"
    # 1. First run through the macOS/Unix launcher: provisions .venv and proves it.
    first = run(["bash", root / f"Setup_and_Run-{SPECS[key]['slug']}.command", "--setup-only"], root)
    assert first.returncode == 0, first.stdout[-3000:] + first.stderr[-2000:]
    assert "Environment proven" in first.stdout
    assert json.loads((root / "files" / "runtime" / "bootstrap-state.json").read_text())["result"] == "pass"
    assert (root / "files" / "test-logs" / "setup-and-run-latest.log").is_file()
    assert run([venv_py(root), boot, "--venv-check"], root).returncode == 0
    # 2. Healthy repeat: nothing is reinstalled.
    again = run([HOST, boot, "--setup-only"], root)
    assert again.returncode == 0 and "Environment is healthy" in again.stdout and "Reconciling" not in again.stdout
    # 3. A damaged package is detected even though the success stamp exists, then repaired.
    first_import = SPECS[key]["imports"][1]
    package_dir = site_packages(root) / first_import
    init = package_dir / "__init__.py"
    init.unlink()
    assert run([venv_py(root), boot, "--venv-check"], root).returncode == 3
    fixed = run([HOST, boot, "--setup-only"], root)
    assert fixed.returncode == 0, fixed.stdout[-3000:]
    assert init.is_file() and run([venv_py(root), boot, "--venv-check"], root).returncode == 0
    # 4. Version drift (a different openpyxl) is reconciled back to the pin.
    assert run([venv_py(root), "-m", "pip", "install", "-q", "openpyxl==3.1.4"], root).returncode == 0
    assert run([venv_py(root), boot, "--venv-check"], root).returncode == 3
    assert run([HOST, boot, "--setup-only"], root).returncode == 0
    assert "3.1.5" in run([venv_py(root), "-c", "import openpyxl; print(openpyxl.__version__)"], root).stdout
    # 5. A broken .venv interpreter triggers a rebuild from the external Python.
    venv_py(root).unlink()
    rebuilt = run([HOST, boot, "--setup-only"], root)
    assert rebuilt.returncode == 0 and "Creating the project environment" in rebuilt.stdout, rebuilt.stdout[-2000:]
    # 6. Changed requirements.txt invalidates the stamp, forcing a reconcile.
    req = root / "scripts" / "requirements.txt"
    req.write_text(req.read_text() + "\n# comment change\n")
    assert run([venv_py(root), boot, "--venv-check"], root).returncode == 3
    assert run([HOST, boot, "--setup-only"], root).returncode == 0
    # 7. Nothing escaped the tool folder: scratch and cache stayed under files/.
    assert (root / "files" / "temp").is_dir()


@pytest.mark.e2e
@e2e
@pytest.mark.skipif(shutil.which("xvfb-run") is None, reason="needs xvfb-run for a headless GUI start")
@pytest.mark.parametrize("key", sorted(TOOLS))
def test_gui_starts_after_bootstrap(key, tmp_path):
    root = copy_tool(key, tmp_path)
    assert run([HOST, root / "scripts" / "bootstrap.py", "--setup-only"], root).returncode == 0
    # --launch-only proves health, then starts the GUI; a still-running GUI after 8 s is a successful start.
    result = subprocess.run(["timeout", "8", "xvfb-run", "-a", str(venv_py(root)), str(root / "scripts" / "bootstrap.py"), "--launch-only"],
                            cwd=root, capture_output=True, text=True)
    assert result.returncode == 124, result.stdout[-2000:] + result.stderr[-2000:]
    assert "Traceback" not in result.stderr
