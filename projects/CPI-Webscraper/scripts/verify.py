"""Fast offline release gate for CPI-Webscraper."""
import importlib.metadata
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib
from bootstrap import requirements, IMPORTS
from cpi_config import ROOT, SUPPORTED_IDS, load_config


def git(*args):
    return subprocess.run(['git',*args],cwd=ROOT,capture_output=True,text=True)


def main():
    checks=[]
    def record(label,ok):
        checks.append(bool(ok)); print('[verify] '+('PASS ' if ok else 'FAIL ')+label,flush=True)
    try:
        pins=requirements(ROOT)
        record('dependency pins/installed versions',all(importlib.metadata.version(k)==v for k,v in pins.items()))
        for module in IMPORTS: __import__(module)
        record('required imports',True)
    except Exception:
        record('dependency pins/imports',False)
    try:
        config=load_config(ROOT/'scripts/config-default.toml')
        record('default TOML, final A-S IDs, blank key and backfill disabled',tuple(c.id for c in config.columns)==SUPPORTED_IDS and not config.api_key and config.add_missing_data is False)
    except Exception:
        record('default TOML',False)
    candidates=git('ls-files','--cached','--others','--exclude-standard')
    files=candidates.stdout.splitlines()
    tracked=git('ls-files').stdout.splitlines()
    secret_paths=['config.toml','files/config.json','files/fred_api_key.md']
    record('secret files ignored/untracked',all(p not in tracked and git('check-ignore','--quiet',p).returncode==0 for p in secret_paths))
    keys=[]
    try:
        obj=tomllib.loads((ROOT/'config.toml').read_text(encoding='utf-8-sig'))
        key=obj.get('fred',{}).get('api_key')
        if isinstance(key,str) and key.strip(): keys.append(key.strip().encode())
    except (OSError,ValueError,AttributeError): pass
    try:
        obj=json.loads((ROOT/'files/config.json').read_text(encoding='utf-8-sig'))
        key=obj.get('fred_api_key')
        if isinstance(key,str) and key.strip(): keys.append(key.strip().encode())
    except (OSError,ValueError,AttributeError): pass
    safe=True
    for name in files:
        path=ROOT/name
        if path.is_file() and any(key in path.read_bytes() for key in keys): safe=False
    record('credential values absent from publishable files',safe)
    allowed={'scripts','files','md-instructions','README.md','.gitignore','Setup_and_Run-cpi-webscraper.bat'}
    record('shipped root structure',candidates.returncode==0 and all(Path(f).parts[0] in allowed for f in files))
    stale=re.compile(r'CPI Dashboard Downloader|cpi_dashboard_downloader|Setup_and_Run-cpi_automation|delete_rows\(')
    surfaces=[ROOT/'README.md',ROOT/'Setup_and_Run-cpi-webscraper.bat',* (ROOT/'scripts').glob('*.py'),*(ROOT/'md-instructions').glob('*.md')]
    # The temporary implementation drop is removed only at the final checkpoint.
    surfaces=[p for p in surfaces if not p.name.startswith('md-instructions') and p.name!='verify.py']
    record('branding/obsolete entry points',not any(stale.search(p.read_text(encoding='utf-8')) for p in surfaces))
    required=['bootstrap.py','cpi_webscraper.py','cpi_config.py','data_sources.py','workbook_io.py','config-default.toml']
    record('application structure',all((ROOT/'scripts'/n).is_file() for n in required))
    record('permanent documentation',all((ROOT/'md-instructions'/n).is_file() for n in ('Briefing.md','Changelog.md','Decisions.md','Handoff.md')))
    result=subprocess.run([sys.executable,'-m','pytest',str(ROOT/'files/tests'),'-q','-p','no:cacheprovider','-p','no:faulthandler'],cwd=ROOT)
    record('pytest',result.returncode==0)
    print('[verify] '+('PASS' if all(checks) else 'FAIL'))
    return int(not all(checks))

if __name__=='__main__':
    raise SystemExit(main())
