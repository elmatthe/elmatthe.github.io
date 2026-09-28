"""Opt-in real provisioning/repair proof, entirely below files/run-temp."""
from pathlib import Path
import shutil
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import bootstrap as b

def main():
    root=ROOT/'files/run-temp/bootstrap-proof'
    if root.exists():
        raise RuntimeError('Use a fresh proof directory; previous evidence must be reviewed first.')
    (root/'scripts').mkdir(parents=True)
    for name in ('config-default.toml','requirements.txt'):
        shutil.copy2(ROOT/'scripts'/name,root/'scripts'/name)
    calls=[]
    original=b.run_command
    def record(args,root):
        calls.append(args)
        return original(args,root)
    b.run_command=record
    b.reconcile(root)
    assert calls and b.probe(root/'.venv/Scripts/python.exe',root,True)
    print('PROOF missing environment: PASS',flush=True)
    calls.clear()
    b.reconcile(root)
    assert not calls
    print('PROOF healthy repeat: PASS',flush=True)
    # Remove only the disposable environment interpreter, not any user/runtime Python.
    interpreter=b.contained(root/'.venv/Scripts/python.exe',ROOT)
    interpreter.unlink()
    calls.clear()
    b.reconcile(root)
    assert any('-m' in c and 'venv' in c for c in calls)
    print('PROOF broken environment rebuild: PASS',flush=True)
    package=root/'.venv/Lib/site-packages/requests/__init__.py'
    assert root in package.resolve().parents
    package.write_text('raise ImportError("synthetic broken import")\n',encoding='utf-8')
    calls.clear()
    b.reconcile(root)
    assert any('--force-reinstall' in c for c in calls)
    print('PROOF damaged import repair: PASS',flush=True)
    req=root/'scripts/requirements.txt'
    req.write_text(req.read_text().replace('requests==2.34.2','requests==2.32.5'))
    calls.clear()
    b.reconcile(root)
    assert calls and b.probe(root/'.venv/Scripts/python.exe',root,True)
    print('PROOF changed requirements reconcile: PASS',flush=True)

if __name__=='__main__':
    main()
