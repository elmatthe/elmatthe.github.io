from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))

def pytest_configure(config):
    if not config.option.basetemp:
        config.option.basetemp = str(ROOT / 'files/run-temp' / ('pytest-' + uuid.uuid4().hex))
