"""ASSESS -> RECONCILE -> REPAIR/PROVISION -> PROVE -> LAUNCH -> REPORT."""
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent
IMPORTS = ('tkinter', 'requests', 'dateutil', 'openpyxl', 'pytest', 'pythoncom', 'win32com.client')

class BootstrapError(ValueError):
    pass

def supported(version):
    return (3,11) <= tuple(version[:2]) <= (3,14) and version[3] == 'final'

def requirements(root):
    result = {}
    for line in (root/'scripts/requirements.txt').read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_-]+)==([0-9][A-Za-z0-9.]*)', line)
        if not match or match[1] in result:
            raise BootstrapError('requirements.txt must contain unique exact package pins.')
        result[match[1]] = match[2]
    if not result:
        raise BootstrapError('requirements.txt is empty.')
    return result

def probe(python, root, dependencies=False):
    code = 'import sys,json,tkinter,venv; print(json.dumps([list(sys.version_info),sys.prefix,sys.base_prefix]))'
    if dependencies:
        pins = requirements(root)
        code = ('import importlib,importlib.metadata; '
                + f'[importlib.import_module(m) for m in {IMPORTS!r}]; '
                + f'assert all(importlib.metadata.version(k)==v for k,v in {pins!r}.items())')
    try:
        p = subprocess.run([str(python), '-I', '-c', code], capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if p.returncode:
            return False
        if dependencies:
            return True
        version, prefix, base = json.loads(p.stdout)
        return supported(version) and Path(prefix).resolve() == (root/'.venv').resolve() and prefix != base
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False

def contained(path, root):
    resolved, root = path.resolve(), root.resolve()
    is_link = path.is_symlink() or (path.exists() and bool(getattr(path.lstat(), 'st_file_attributes', 0) & 1024))
    if resolved == root or root not in resolved.parents or is_link:
        raise BootstrapError('Refusing to repair an environment outside this project or through a link.')
    return resolved

def run_command(args, root):
    env = os.environ.copy()
    scratch = root/'files/temp/bootstrap'
    contained(scratch,root)
    contained(root/'files/temp/pip',root)
    scratch.mkdir(parents=True, exist_ok=True)
    env.update(TEMP=str(scratch), TMP=str(scratch), PIP_CACHE_DIR=str(root/'files/temp/pip'))
    result = subprocess.run([str(a) for a in args], cwd=root, env=env,
                            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode:
        raise BootstrapError('Environment provisioning failed. Check connectivity, disk space and permissions; run this launcher again to retry repair.')

def reconcile(root=ROOT):
    root = Path(root).resolve()
    if os.name != 'nt' or not supported(sys.version_info):
        raise BootstrapError('Use stable Python 3.11 through 3.14 on Windows with desktop Excel.')
    # Invalid user settings stop setup before any application or Excel launch.
    from cpi_config import ensure_config
    config = ensure_config(root)
    requirements(root)
    venv = root/'.venv'
    python = venv/'Scripts/python.exe'
    backup = None
    if not probe(python, root):
        print('[bootstrap] Repair/provision: private Python environment.')
        if Path(sys.prefix).resolve() == venv.resolve():
            raise BootstrapError('Cannot rebuild the interpreter running bootstrap. Use the batch launcher with a base Python.')
        contained(venv, root)
        if venv.exists():
            backup = root/'files/temp/bootstrap'/('venv-backup-'+uuid.uuid4().hex)
            contained(backup, root)
            backup.parent.mkdir(parents=True, exist_ok=True)
            venv.rename(backup)
        try:
            run_command([sys.executable,'-m','venv',venv],root)
            if not probe(python,root):
                raise BootstrapError('New private Python failed its runtime health check.')
        except Exception:
            if venv.exists():
                shutil.rmtree(contained(venv,root))
            if backup is not None:
                backup.rename(venv)
            raise
    if not probe(python,root,True):
        print('[bootstrap] Reconcile: pinned dependencies and imports.')
        run_command([python,'-m','ensurepip','--upgrade'],root)
        run_command([python,'-m','pip','install','--disable-pip-version-check','-r',root/'scripts/requirements.txt'],root)
        if not probe(python,root,True):
            # Metadata may match while package files are damaged.
            run_command([python,'-m','pip','install','--disable-pip-version-check','--force-reinstall','-r',root/'scripts/requirements.txt'],root)
        if not probe(python,root,True):
            raise BootstrapError('Required imports or versions remain unhealthy after repair.')
    if backup is not None:
        shutil.rmtree(contained(backup,root))
    print('[bootstrap] Proved: supported environment, exact pins, imports and config.')
    return python, config

def main():
    if sys.argv[1:] not in ([], ['--check-only']):
        print('Usage: bootstrap.py [--check-only]')
        return 2
    try:
        python, _ = reconcile()
        if '--check-only' not in sys.argv:
            print('[bootstrap] Launch: CPI-Webscraper 0.3.0')
            return subprocess.call([str(python),str(ROOT/'scripts/cpi_webscraper.py')],cwd=ROOT)
        return 0
    except ValueError as error:
        print('[bootstrap] ' + str(error))
        return 1
    except OSError:
        # User config and subprocess errors must never echo credential-bearing content.
        print('[bootstrap] Setup failed. Check config.toml against scripts/config-default.toml, supported Python, connectivity and file permissions. Existing user config is preserved.')
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
