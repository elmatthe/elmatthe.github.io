#!/usr/bin/env python3
"""
Stock Comparison & Analytics Tool - setup, self-repair and launch.

Called by the root Setup_and_Run-*.bat / .command launchers. The normal launch
path is also the repair path:

    ASSESS -> RECONCILE -> REPAIR / PROVISION -> PROVE -> LAUNCH -> REPORT

- A healthy repeat launch runs a read-only health check and starts the program
  without touching pip.
- A missing, broken, incompatible or drifted environment is repaired: the
  repository-local .venv is rebuilt from a validated external Python, and exact
  pinned dependencies are reconciled and proven by actually importing them.
- Nothing is installed machine-wide and administrator rights are never requested.
  If no compatible Python exists, a per-user install is offered (winget on
  Windows, Homebrew on macOS) and validated again afterwards.
- Repair never runs from the .venv interpreter it is replacing.
- Scratch files, pip cache and logs stay inside this folder (files/temp,
  files/runtime, files/test-logs). No secrets are written to logs or state.

Standard library only, so it runs before any dependency is installed.
Generated from _tools/bootstrap/bootstrap.py.in in the website repository;
edit the template, not the rendered copies.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - hosts older than 3.11 are rejected by the launchers
    tomllib = None  # type: ignore[assignment]


# ============================================================================
# PROJECT CUSTOMIZATION (rendered from _tools/bootstrap/projects.toml)
# ============================================================================

PROJECT_NAME = "Stock Comparison & Analytics Tool"
# Import names that prove the application can run (imported, not just located).
REQUIRED_IMPORTS: tuple[str, ...] = ('tkinter', 'pandas', 'numpy', 'matplotlib', 'yfinance', 'openpyxl', 'PIL', 'scipy')
# Modules a candidate base Python must provide to build this GUI project's .venv.
REQUIRED_BASE_MODULES: tuple[str, ...] = ("tkinter", "venv", "ensurepip")
# Offered only when no compatible Python exists (per-user installs).
PYTHON_WINGET_ID = "Python.Python.3.13"
PYTHON_BREW_FORMULA = "python@3.13"
PYTHON_TK_BREW_FORMULA = "python-tk@3.13"
LAUNCH_MODE = "wait"  # the GUI runs attached to the setup window
DEFAULT_MIN_PYTHON = (3, 11)
DEFAULT_MAX_PYTHON_EXCLUSIVE = (3, 15)


# ============================================================================
# ENGINE
# ============================================================================

EXIT_OK = 0
EXIT_CANCELLED = 2
EXIT_VENV_UNHEALTHY = 3
EXIT_SETUP_FAILED = 10
STATE_SCHEMA = 2

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config.toml"
REQUIREMENTS_PATH = REPO_ROOT / "scripts" / "requirements.txt"
VENV_DIR = REPO_ROOT / ".venv"
FILES_DIR = REPO_ROOT / "files"
TEMP_DIR = FILES_DIR / "temp" / "bootstrap"
PIP_CACHE_DIR = FILES_DIR / "temp" / "pip-cache"
RUNTIME_DIR = FILES_DIR / "runtime"
LOG_DIR = FILES_DIR / "test-logs"
STATE_PATH = RUNTIME_DIR / "bootstrap-state.json"
LOG_PATH = LOG_DIR / "setup-and-run-latest.log"

if os.name == "nt":
    VENV_PYTHON = VENV_DIR / "Scripts" / "python.exe"
else:
    VENV_PYTHON = VENV_DIR / "bin" / "python"

_LOG = None


class BootstrapError(RuntimeError):
    """Expected setup failure with a user-readable message."""


@dataclass(frozen=True)
class PythonCandidate:
    executable: Path
    args: tuple[str, ...]
    version: tuple[int, int, int]
    missing_modules: tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        return not self.missing_modules

    @property
    def label(self) -> str:
        return f"Python {'.'.join(map(str, self.version))} ({self.executable})"


# ---------------------------------------------------------------- output/log
def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def open_log() -> None:
    global _LOG
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _LOG = LOG_PATH.open("w", encoding="utf-8", newline="\n")
    _LOG.write(f"{PROJECT_NAME} bootstrap\nStarted: {utc_now()}\nPlatform: {sys.platform}\n")
    _LOG.flush()


def close_log() -> None:
    global _LOG
    if _LOG is not None:
        _LOG.close()
        _LOG = None


def say(message: str = "") -> None:
    print(message, flush=True)
    if _LOG is not None:
        _LOG.write(message + "\n")
        _LOG.flush()


def stage(name: str) -> None:
    say()
    say(f"[{name}]")


def ask_yes_no(question: str) -> bool:
    if os.environ.get("AI_BOOTSTRAP_ASSUME_YES") == "1":
        return True
    if os.environ.get("AI_BOOTSTRAP_ASSUME_NO") == "1" or not sys.stdin or not sys.stdin.isatty():
        return False
    try:
        return input(f"{question} [y/N]: ").strip().lower() in {"y", "yes"}
    except EOFError:
        return False


def contained_env(*, scratch: bool = False) -> dict[str, str]:
    """Environment for child processes. With scratch=True (installs), temp files and
    the pip cache are redirected into this folder; read-only probes create nothing."""
    env = os.environ.copy()
    env.update(PIP_DISABLE_PIP_VERSION_CHECK="1", PYTHONNOUSERSITE="1")
    if scratch:
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        PIP_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        env.update(TEMP=str(TEMP_DIR), TMP=str(TEMP_DIR), TMPDIR=str(TEMP_DIR), PIP_CACHE_DIR=str(PIP_CACHE_DIR))
    return env


def run_bounded(args: Sequence[str | os.PathLike[str]], *, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    """Run a short probe. Arguments are never logged (they could contain user data)."""
    try:
        return subprocess.run([os.fspath(a) for a in args], cwd=REPO_ROOT, text=True, encoding="utf-8", errors="replace",
                              capture_output=True, timeout=timeout, check=False, env=contained_env(),
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BootstrapError(f"A required process could not run ({type(exc).__name__}).") from exc


def run_visible(args: Sequence[str | os.PathLike[str]]) -> int:
    """Run an installer step with its output visible in this window."""
    try:
        return subprocess.run([os.fspath(a) for a in args], cwd=REPO_ROOT, check=False, env=contained_env(scratch=True)).returncode
    except OSError as exc:
        raise BootstrapError(f"{Path(os.fspath(args[0])).name} could not be started ({exc.strerror or type(exc).__name__}).") from exc


# ---------------------------------------------------------------- config
def read_config() -> dict:
    if not CONFIG_PATH.is_file() or tomllib is None:
        return {}
    try:
        with CONFIG_PATH.open("rb") as handle:
            data = tomllib.load(handle)
    except Exception as exc:
        raise BootstrapError(f"config.toml could not be read ({exc}). Restore it from the original download.") from exc
    return data if isinstance(data, dict) else {}


def _pair(value: object, fallback: tuple[int, int]) -> tuple[int, int]:
    match = re.fullmatch(r"\s*(\d+)\.(\d+)\s*", value) if isinstance(value, str) else None
    return (int(match[1]), int(match[2])) if match else fallback


def runtime_bounds(config: dict) -> tuple[tuple[int, int], tuple[int, int]]:
    section = config.get("python", {}) if isinstance(config.get("python"), dict) else {}
    minimum = _pair(section.get("minimum_version"), DEFAULT_MIN_PYTHON)
    maximum = _pair(section.get("maximum_version_exclusive"), DEFAULT_MAX_PYTHON_EXCLUSIVE)
    if minimum >= maximum:
        raise BootstrapError(f"config.toml has an invalid Python range: {minimum} must be below {maximum}.")
    return minimum, maximum


def entry_point(config: dict) -> Path:
    section = config.get("execution", {}) if isinstance(config.get("execution"), dict) else {}
    raw = section.get("entry_point", "scripts/main.py")
    if not isinstance(raw, str) or not raw.strip():
        raise BootstrapError("config.toml [execution].entry_point is missing.")
    target = (REPO_ROOT / raw.strip()).resolve()
    try:
        target.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise BootstrapError("The configured entry point is outside this folder.") from exc
    if not target.is_file():
        raise BootstrapError(f"The program file {raw} is missing. Re-extract the download.")
    return target


def requirement_pins() -> dict[str, str]:
    if not REQUIREMENTS_PATH.is_file():
        raise BootstrapError("scripts/requirements.txt is missing. Re-extract the download.")
    pins: dict[str, str] = {}
    for line in REQUIREMENTS_PATH.read_text(encoding="utf-8").splitlines():
        text = line.split("#", 1)[0].strip()
        if not text:
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.+!-]*)", text)
        if not match:
            raise BootstrapError(f"requirements.txt entry is not an exact pin: {text!r}.")
        pins[match[1]] = match[2]
    return pins


def requirements_hash() -> str:
    return hashlib.sha256(REQUIREMENTS_PATH.read_bytes()).hexdigest()


# ---------------------------------------------------------------- state
def load_state() -> dict:
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(python_version: str) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"schema": STATE_SCHEMA, "result": "pass", "timestamp_utc": utc_now(), "python_version": python_version,
               "requirements_sha256": requirements_hash()}
    temp = STATE_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, STATE_PATH)


def clear_state() -> None:
    try:
        STATE_PATH.unlink()
    except FileNotFoundError:
        pass


def state_current() -> bool:
    state = load_state()
    return state.get("schema") == STATE_SCHEMA and state.get("result") == "pass" and state.get("requirements_sha256") == requirements_hash()


# ---------------------------------------------------------------- Python discovery
_PROBE = (
    "import json,sys,importlib.util as u;"
    "mods={mods!r};"
    "print(json.dumps({{'exe':sys.executable,'v':list(sys.version_info[:3]),'level':sys.version_info.releaselevel,"
    "'missing':[m for m in mods if u.find_spec(m) is None],'venv':sys.prefix!=sys.base_prefix}}))"
)


def probe_python(executable: str | os.PathLike[str], args: Sequence[str], minimum, maximum, *, modules: Sequence[str] = ()) -> PythonCandidate | None:
    code = _PROBE.format(mods=tuple(modules))
    try:
        result = run_bounded([executable, *args, "-I", "-c", code], timeout=15)
    except BootstrapError:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        info = json.loads(result.stdout.strip().splitlines()[-1])
        version = tuple(int(x) for x in info["v"])
        resolved = Path(info["exe"]).resolve()
    except (KeyError, TypeError, ValueError, OSError):
        return None
    if info.get("level") != "final" or not (minimum <= version[:2] < maximum) or info.get("venv"):
        return None
    if "WindowsApps" in str(resolved):
        return None
    return PythonCandidate(resolved, tuple(args), version, tuple(info.get("missing", ())))


def exact_py_selectors(minimum, maximum) -> Iterable[str]:
    if minimum[0] != maximum[0]:
        return ()
    return (f"-{minimum[0]}.{minor}" for minor in range(maximum[1] - 1, minimum[1] - 1, -1))


def candidate_commands(minimum, maximum) -> list[tuple[str, tuple[str, ...]]]:
    """Bounded discovery: launcher, PATH, and standard per-user/framework locations."""
    found: list[tuple[str, tuple[str, ...]]] = [(sys.executable, ())]
    if os.name == "nt":
        py = shutil.which("py")
        if py:
            found += [(py, (sel,)) for sel in exact_py_selectors(minimum, maximum)]
        python = shutil.which("python")
        if python:
            found.append((python, ()))
        local = os.environ.get("LOCALAPPDATA")
        if local:
            base = Path(local) / "Programs" / "Python"
            found += [(str(p / "python.exe"), ()) for p in sorted(base.glob("Python3*"), reverse=True) if (p / "python.exe").is_file()]
    else:
        minors = range(maximum[1] - 1, minimum[1] - 1, -1) if minimum[0] == maximum[0] == 3 else ()
        for minor in minors:
            for name in (f"python3.{minor}",):
                resolved = shutil.which(name)
                if resolved:
                    found.append((resolved, ()))
            for prefix in ("/opt/homebrew/bin", "/usr/local/bin", f"/Library/Frameworks/Python.framework/Versions/3.{minor}/bin"):
                path = Path(prefix) / f"python3.{minor}"
                if path.is_file():
                    found.append((str(path), ()))
        resolved = shutil.which("python3")
        if resolved:
            found.append((resolved, ()))
    seen: set[tuple[str, tuple[str, ...]]] = set()
    unique = []
    for exe, args in found:
        key = (os.path.normcase(exe), args)
        if key not in seen:
            seen.add(key)
            unique.append((exe, args))
    return unique


def discover_pythons(minimum, maximum) -> list[PythonCandidate]:
    candidates: dict[Path, PythonCandidate] = {}
    for exe, args in candidate_commands(minimum, maximum):
        candidate = probe_python(exe, args, minimum, maximum, modules=REQUIRED_BASE_MODULES)
        if candidate is not None and candidate.executable not in candidates:
            candidates[candidate.executable] = candidate
    return sorted(candidates.values(), key=lambda c: (c.usable, c.version, str(c.executable).lower()), reverse=True)


def brew() -> str | None:
    for path in (shutil.which("brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if path and Path(path).is_file():
            return path
    return None


def offer_python_install(unusable: list[PythonCandidate]) -> bool:
    """Per-user provisioning. Returns True when an install ran successfully."""
    if os.name == "nt":
        winget = shutil.which("winget")
        if not winget:
            say("Windows Package Manager (winget) is not available, so Python cannot be installed automatically.")
            return False
        say("No compatible Python was found. A per-user Python can be installed with winget (no administrator rights, PATH unchanged).")
        if not ask_yes_no(f"Install {PYTHON_WINGET_ID.split('.', 1)[1].replace('.', ' ', 1)} for this Windows user now?"):
            return False
        stage("PROVISION: Python (winget, current user)")
        return run_visible([winget, "install", "--id", PYTHON_WINGET_ID, "--exact", "--scope", "user", "--source", "winget",
                            "--accept-package-agreements", "--accept-source-agreements",
                            "--override", "/quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0"]) == 0
    if sys.platform == "darwin":
        brew_path = brew()
        if not brew_path:
            say("Homebrew is not installed, so Python cannot be installed automatically from here.")
            return False
        brew_owned = [c for c in unusable if "tkinter" in c.missing_modules and ("/opt/homebrew/" in str(c.executable) or "/usr/local/" in str(c.executable))]
        if brew_owned:
            major_minor = f"{brew_owned[0].version[0]}.{brew_owned[0].version[1]}"
            formulae = [f"python-tk@{major_minor}"]
            say(f"Homebrew Python {major_minor} is installed but lacks tkinter, which this desktop program needs.")
        else:
            formulae = [PYTHON_BREW_FORMULA, PYTHON_TK_BREW_FORMULA]
            say("No compatible Python was found.")
        if not ask_yes_no(f"Install {' and '.join(formulae)} with Homebrew for this user now?"):
            return False
        stage("PROVISION: Python (Homebrew)")
        return run_visible([brew_path, "install", *formulae]) == 0
    return False


def ensure_base_python(minimum, maximum) -> PythonCandidate:
    candidates = discover_pythons(minimum, maximum)
    usable = [c for c in candidates if c.usable]
    if usable:
        return usable[0]
    if offer_python_install([c for c in candidates if not c.usable]):
        usable = [c for c in discover_pythons(minimum, maximum) if c.usable]
        if usable:
            return usable[0]
        raise BootstrapError("Python was installed but could not be validated in this window. Close this window and run the launcher again so the new installation is picked up.")
    lacking = [c for c in candidates if not c.usable]
    detail = ""
    if lacking:
        detail = f" Found {lacking[0].label}, but it is missing: {', '.join(lacking[0].missing_modules)}."
    hint = {
        "nt": "Install Python 3.11-3.14 from https://www.python.org/downloads/windows/ (the standard installer includes tkinter), then run the launcher again.",
        "darwin": f"Install Python from https://www.python.org/downloads/macos/ (includes tkinter), or run: brew install {PYTHON_BREW_FORMULA} {PYTHON_TK_BREW_FORMULA}. Then run the launcher again.",
    }.get(os.name if os.name == "nt" else sys.platform, "Install Python 3.11-3.14 with tkinter (e.g. your distribution's python3-tk package), then run the launcher again.")
    raise BootstrapError(f"No compatible Python {minimum[0]}.{minimum[1]}-{maximum[0]}.{maximum[1] - 1} with tkinter was found.{detail} {hint}")


# ---------------------------------------------------------------- environment health
def venv_version(minimum, maximum) -> tuple[int, int, int] | None:
    if not VENV_PYTHON.is_file():
        return None
    code = "import json,sys;print(json.dumps({'v':list(sys.version_info[:3]),'venv':sys.prefix!=sys.base_prefix}))"
    try:
        result = run_bounded([VENV_PYTHON, "-I", "-c", code], timeout=15)
        info = json.loads(result.stdout.strip().splitlines()[-1]) if result.returncode == 0 else {}
        version = tuple(int(x) for x in info.get("v", ()))
    except (BootstrapError, ValueError, IndexError):
        return None
    if not info.get("venv") or len(version) != 3 or not (minimum <= version[:2] < maximum):
        return None
    return version  # type: ignore[return-value]


def pip_works() -> bool:
    try:
        return run_bounded([VENV_PYTHON, "-m", "pip", "--version"], timeout=30).returncode == 0
    except BootstrapError:
        return False


def dependencies_proven() -> tuple[bool, str]:
    """Exact installed versions AND real imports (catches drift and damaged packages)."""
    pins = requirement_pins()
    code = (
        "import importlib,importlib.metadata as md,json,sys\n"
        f"pins={pins!r}\nmods={REQUIRED_IMPORTS!r}\n"
        "bad=[]\n"
        "for name,want in pins.items():\n"
        "    try:\n"
        "        got=md.version(name)\n"
        "    except md.PackageNotFoundError:\n"
        "        got=None\n"
        "    if got!=want: bad.append(f'{name} {got or \"missing\"} (needs {want})')\n"
        "for mod in mods:\n"
        "    try:\n"
        "        m=importlib.import_module(mod)\n"
        "    except Exception as exc:\n"
        "        bad.append(f'import {mod} failed: {type(exc).__name__}')\n"
        "        continue\n"
        "    # A package whose __init__.py was lost imports as an empty namespace package.\n"
        "    if getattr(m,'__file__',None) is None: bad.append(f'{mod} is incomplete (package files missing)')\n"
        "print(json.dumps(bad))\n"
        "sys.exit(1 if bad else 0)\n"
    )
    try:
        result = run_bounded([VENV_PYTHON, "-I", "-c", code], timeout=120)
    except BootstrapError as exc:
        return False, str(exc)
    if result.returncode == 0:
        return True, "dependencies proven"
    try:
        problems = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        problems = ["the dependency probe did not run"]
    return False, "; ".join(problems[:4])


def pip_check() -> tuple[bool, str]:
    try:
        result = run_bounded([VENV_PYTHON, "-m", "pip", "check"], timeout=60)
    except BootstrapError as exc:
        return False, str(exc)
    return result.returncode == 0, (result.stdout or result.stderr).strip()


def fast_health_check() -> tuple[bool, str]:
    """Read-only gate used by the launchers before --launch-only. Never repairs."""
    try:
        config = read_config()
        minimum, maximum = runtime_bounds(config)
        if venv_version(minimum, maximum) is None:
            return False, "the project environment (.venv) is missing or uses an unsupported Python"
        if not state_current():
            return False, "dependency state is missing or requirements.txt changed"
        ok, detail = dependencies_proven()
        if not ok:
            return False, detail
        ok, detail = pip_check()
        if not ok:
            return False, f"pip check failed: {detail[:200]}"
        entry_point(config)
        return True, "healthy"
    except BootstrapError as exc:
        return False, str(exc)


# ---------------------------------------------------------------- repair
def running_from_venv() -> bool:
    try:
        Path(sys.executable).resolve().relative_to(VENV_DIR.resolve())
        return True
    except (OSError, ValueError):
        return False


def rebuild_venv(base: PythonCandidate) -> None:
    if running_from_venv():
        raise BootstrapError("Setup cannot rebuild .venv while running from it. Use the Setup_and_Run launcher, which repairs from an external Python.")
    clear_state()
    backup = None
    if VENV_DIR.exists() or VENV_DIR.is_symlink():
        if VENV_DIR.is_symlink():
            raise BootstrapError(".venv is a link; refusing to modify anything outside this folder. Delete it and run the launcher again.")
        backup = TEMP_DIR / f"venv-backup-{os.getpid()}"
        shutil.rmtree(backup, ignore_errors=True)
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        say("Moving the unhealthy .venv aside...")
        try:
            VENV_DIR.rename(backup)
        except OSError as exc:
            raise BootstrapError("The existing .venv is in use. Close any running copy of the program and try again.") from exc
    say(f"Creating the project environment with {base.label}...")
    try:
        if run_visible([base.executable, *base.args, "-m", "venv", VENV_DIR]) != 0 or not VENV_PYTHON.is_file():
            raise BootstrapError("Python could not create the project environment (.venv). Check free disk space and folder permissions.")
    except BootstrapError:
        shutil.rmtree(VENV_DIR, ignore_errors=True)
        if backup is not None and backup.exists():
            backup.rename(VENV_DIR)  # restore the previous state rather than leaving nothing
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


def ensure_pip() -> None:
    if pip_works():
        return
    say("Repairing pip inside .venv...")
    if run_visible([VENV_PYTHON, "-m", "ensurepip", "--upgrade"]) != 0 or not pip_works():
        raise BootstrapError("pip inside .venv is damaged and could not be repaired. Delete the .venv folder and run the launcher again.")


def reconcile_dependencies() -> None:
    ok, detail = dependencies_proven()
    if ok and state_current():
        say("Dependencies already match requirements.txt; nothing to install.")
        return
    say(f"Reconciling pinned dependencies ({detail})...")
    base = [VENV_PYTHON, "-m", "pip", "install", "--disable-pip-version-check", "-r", REQUIREMENTS_PATH]
    if run_visible(base) != 0:
        raise BootstrapError("Dependency installation failed. Check your internet connection (or proxy) and free disk space; details are shown above.")
    ok, detail = dependencies_proven()
    if not ok:
        # Metadata can match while package files are damaged: reinstall once.
        say(f"Packages still unhealthy ({detail}); reinstalling them...")
        if run_visible([*base, "--force-reinstall", "--no-deps"]) != 0:
            raise BootstrapError("Reinstalling the damaged packages failed; details are shown above.")


def prove(config: dict, minimum, maximum) -> str:
    version = venv_version(minimum, maximum)
    if version is None:
        raise BootstrapError("The project environment failed its runtime check after setup.")
    ensure_pip()
    ok, detail = dependencies_proven()
    if not ok:
        raise BootstrapError(f"Dependencies are still unhealthy after repair: {detail}")
    ok, detail = pip_check()
    if not ok:
        raise BootstrapError(f"pip reports conflicting packages: {detail[:300]}")
    entry_point(config)
    text = ".".join(map(str, version))
    write_state(text)
    return text


def launch(config: dict) -> int:
    target = entry_point(config)
    say()
    say(f"Launching {PROJECT_NAME}...")
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    return subprocess.run([os.fspath(VENV_PYTHON), os.fspath(target)], cwd=REPO_ROOT, check=False, env=env).returncode


def setup(*, force_rebuild: bool, launch_after: bool) -> int:
    open_log()
    try:
        for path in (TEMP_DIR, RUNTIME_DIR):
            path.mkdir(parents=True, exist_ok=True)
        config = read_config()
        minimum, maximum = runtime_bounds(config)
        stage("ASSESS")
        say(f"{PROJECT_NAME}: needs Python {minimum[0]}.{minimum[1]}-{maximum[0]}.{maximum[1] - 1} with tkinter.")
        current = venv_version(minimum, maximum)
        healthy, reason = fast_health_check() if current and not force_rebuild else (False, "repair requested" if force_rebuild else "no usable .venv")
        say("Environment is healthy." if healthy else f"Needs attention: {reason}.")
        if not healthy:
            stage("RECONCILE")
            if current is None or force_rebuild or not pip_works():
                base = ensure_base_python(minimum, maximum)
                say(f"Using {base.label}.")
                stage("REPAIR / PROVISION")
                rebuild_venv(base)
            ensure_pip()
            reconcile_dependencies()
        stage("PROVE")
        version = prove(config, minimum, maximum)
        say(f"Environment proven: Python {version}, pinned dependencies imported successfully.")
        if not launch_after:
            stage("REPORT")
            say("Setup complete (launch skipped).")
            return EXIT_OK
        stage("LAUNCH")
        code = launch(config)
        stage("REPORT")
        say("Program closed." if code == 0 else f"Program exited with code {code}.")
        return code
    finally:
        close_log()


def launch_only() -> int:
    healthy, reason = fast_health_check()
    if not healthy:
        raise BootstrapError(f"The environment is not healthy ({reason}). Run the Setup_and_Run launcher to repair it.")
    return launch(read_config())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"{PROJECT_NAME} setup, repair and launch")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--venv-check", action="store_true", help="read-only health gate: exit 0 healthy, 3 repair needed")
    mode.add_argument("--launch-only", action="store_true", help="launch after proving the environment is healthy")
    mode.add_argument("--repair-venv", action="store_true", help="rebuild .venv, reconcile, prove, then launch")
    mode.add_argument("--setup-only", action="store_true", help="assess, repair if needed and prove, without launching")
    parser.add_argument("--debug", action="store_true", help="show tracebacks for unexpected errors")
    args = parser.parse_args(argv)
    if args.venv_check:
        healthy, reason = fast_health_check()
        if not healthy and os.environ.get("AI_BOOTSTRAP_VERBOSE") == "1":
            print(reason)
        return EXIT_OK if healthy else EXIT_VENV_UNHEALTHY
    try:
        if args.launch_only:
            return launch_only()
        return setup(force_rebuild=args.repair_venv, launch_after=not args.setup_only)
    except KeyboardInterrupt:
        say()
        say("Setup cancelled.")
        return EXIT_CANCELLED
    except BootstrapError as exc:
        say()
        say(f"ERROR: {exc}")
        if LOG_PATH.exists():
            say(f"Setup log: {LOG_PATH}")
        return EXIT_SETUP_FAILED
    except Exception as exc:  # pragma: no cover - defensive
        say()
        say(f"ERROR: unexpected setup failure: {exc}")
        if args.debug:
            traceback.print_exc()
        return EXIT_SETUP_FAILED
    finally:
        close_log()


if __name__ == "__main__":
    raise SystemExit(main())
