from pathlib import Path
import json
import pytest
from cpi_config import ConfigError, SUPPORTED_IDS, ensure_config, load_config, parse_config, save_api_key

TEMPLATE = (Path(__file__).resolve().parents[2] / 'scripts/config-default.toml').read_text(encoding='utf-8')

@pytest.fixture
def root(tmp_path):
    (tmp_path / 'scripts').mkdir()
    (tmp_path / 'files').mkdir()
    (tmp_path / 'scripts/config-default.toml').write_text(TEMPLATE, encoding='utf-8')
    return tmp_path

def test_defaults_and_create(root):
    config = ensure_config(root)
    assert tuple(c.id for c in config.columns) == SUPPORTED_IDS
    assert config.api_key == ''
    assert config.add_missing_data is False
    assert tuple(c.id for c in config.columns[15:]) == ('us_treasury_10y_avg','us_treasury_2y_avg','us_pce_sa','us_core_pce_sa')
    assert (root / 'config.toml').read_text(encoding='utf-8') == TEMPLATE

def test_custom_schema_and_key_preservation(root):
    lines = TEMPLATE.replace('CPI_Downloader', 'Custom').replace('header = "Date"', 'header = "Month"').splitlines(True)
    indices = [i for i, line in enumerate(lines) if '{ id =' in line]
    lines[indices[0]], lines[indices[1]] = lines[indices[1]], lines[indices[0]]
    before = ''.join(lines)
    path = root / 'config.toml'
    path.write_text(before, encoding='utf-8')
    save_api_key('test-only-placeholder', path)
    config = load_config(path)
    assert config.sheet_name == 'Custom'
    assert config.columns[1].header == 'Month'
    assert config.columns[0].id == 'ca_cpi_headline_nsa'
    assert path.read_text(encoding='utf-8') == before.replace('api_key = ""', 'api_key = "test-only-placeholder"')
    assert 'test-only-placeholder' not in repr(config)

@pytest.mark.parametrize('bad', [
    TEMPLATE.replace('id = "date"', 'id = "unknown"'),
    TEMPLATE.replace('    { id = "date", header = "Date" },\n', ''),
    TEMPLATE.replace('id = "date"', 'id = "ca_cpi_headline_nsa"'),
    TEMPLATE.replace('header = "Date"', 'header = " "'),
    TEMPLATE.replace('header = "Date"', 'header = "=1+1"'),
    TEMPLATE + '\n[fred]\napi_key = ""',
    'invalid = [',
])
def test_invalid_preserved(root, bad):
    path = root / 'config.toml'
    path.write_text(bad, encoding='utf-8')
    with pytest.raises(ConfigError):
        ensure_config(root)
    assert path.read_text(encoding='utf-8') == bad

@pytest.mark.parametrize('legacy', [{'fred_api_key':'test-only-placeholder'}, {'fred_api_key':12}, {}, []])
def test_legacy(root, legacy):
    path = root / 'files/config.json'
    path.write_text(json.dumps(legacy), encoding='utf-8')
    config = ensure_config(root)
    assert config.api_key == ('test-only-placeholder' if legacy == {'fred_api_key':'test-only-placeholder'} else '')
    assert json.loads(path.read_text()) == legacy
    save_api_key('replacement-placeholder', root / 'config.toml')
    assert ensure_config(root).api_key == 'replacement-placeholder'

def test_old_config_defaults_to_false():
    old = TEMPLATE.split('[sp500_history]')[0]
    assert parse_config(old).add_missing_data is False

@pytest.mark.parametrize('literal,expected', [('true',True),('false',False)])
def test_backfill_boolean(literal,expected,root):
    text = TEMPLATE.replace('add_missing_data = false','add_missing_data = '+literal)
    path=root/'config.toml'
    path.write_text(text,encoding='utf-8')
    save_api_key('test-only-placeholder',path)
    assert load_config(path).add_missing_data is expected

@pytest.mark.parametrize('literal', ['"true"','1','0','[]','{}'])
def test_backfill_strict_boolean(literal):
    with pytest.raises(ConfigError):
        parse_config(TEMPLATE.replace('add_missing_data = false','add_missing_data = '+literal))

def test_backfill_rejects_unknown_setting():
    with pytest.raises(ConfigError): parse_config(TEMPLATE+'unexpected = true\n')
