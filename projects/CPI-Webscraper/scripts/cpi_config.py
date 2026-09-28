"""Small, strict user schema for CPI-Webscraper. Never include secrets in errors."""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent
SUPPORTED_IDS = (
    'date', 'ca_cpi_headline_nsa', 'ca_cpi_headline_sa', 'ca_cpi_core_nsa',
    'ca_cpi_core_sa', 'ca_cpi_alberta_nsa', 'us_cpi_headline_nsa',
    'us_cpi_headline_sa', 'us_cpi_core_nsa', 'us_cpi_core_sa',
    'us_unemployment_sa', 'us_fed_funds_avg', 'us_fed_funds_eom',
    'us_sp500_eom', 'us_10y2y_eom', 'us_treasury_10y_avg',
    'us_treasury_2y_avg', 'us_pce_sa', 'us_core_pce_sa',
)

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class Column:
    id: str
    header: str

@dataclass(frozen=True)
class Config:
    sheet_name: str
    api_key: str = field(repr=False)
    columns: tuple[Column, ...]
    add_missing_data: bool = False

    @property
    def headers(self):
        return tuple(c.header for c in self.columns)

    def values(self, row):
        return tuple(row[c.id] for c in self.columns)

def parse_config(text):
    try:
        obj = tomllib.loads(text)
        if set(obj) not in ({'workbook', 'fred', 'output'}, {'workbook', 'fred', 'output', 'sp500_history'}):
            raise ValueError
        history = obj.get('sp500_history', {'add_missing_data': False})
        if not isinstance(history, dict) or set(history) != {'add_missing_data'} or type(history['add_missing_data']) is not bool:
            raise ValueError
        if set(obj['workbook']) != {'sheet_name'} or set(obj['fred']) != {'api_key'} or set(obj['output']) != {'columns'}:
            raise ValueError
        sheet, key, entries = obj['workbook']['sheet_name'], obj['fred']['api_key'], obj['output']['columns']
        if not isinstance(sheet, str) or not sheet.strip() or len(sheet) > 31 or any(c in sheet for c in '[]:*?/\\'):
            raise ValueError
        if not isinstance(key, str) or not isinstance(entries, list):
            raise ValueError
        columns = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'id', 'header'}:
                raise ValueError
            if not isinstance(entry['id'], str) or not isinstance(entry['header'], str) or not entry['header'].strip():
                raise ValueError
            # Excel must receive literal headers, never formulas.
            if entry['header'].startswith(('=', '+', '-', '@')):
                raise ValueError
            columns.append(Column(**entry))
        if len(columns) != len(SUPPORTED_IDS) or {c.id for c in columns} != set(SUPPORTED_IDS):
            raise ValueError
        return Config(sheet, key.strip(), tuple(columns), history['add_missing_data'])
    except (ValueError, KeyError, TypeError):
        raise ConfigError('Invalid config.toml: use the template sections, a valid sheet name, a string API key, and every supported column ID exactly once with a non-empty literal header. sp500_history.add_missing_data must be true or false. Existing config was preserved.') from None

def load_config(path=None):
    path = Path(path) if path is not None else ROOT / 'config.toml'
    try:
        return parse_config(path.read_text(encoding='utf-8-sig'))
    except (OSError, UnicodeError):
        raise ConfigError('Cannot read config.toml. Run the launcher or check file permissions.') from None

def save_api_key(api_key, path=None):
    path = Path(path) if path is not None else ROOT / 'config.toml'
    original = path.read_text(encoding='utf-8-sig')
    config = parse_config(original)
    # Locate the setting in the conventional template table; preserve every other byte.
    table = re.search(r'(?m)^\s*\[fred\][ \t]*(?:#[^\n]*)?$', original)
    if not table:
        raise ConfigError('Save the API key manually in config.toml: the [fred] table uses a custom TOML layout.')
    tail = original[table.end():]
    end = re.search(r'(?m)^\s*\[', tail)
    section = tail[:end.start()] if end else tail
    literal = r'"""[\s\S]*?"""|\x27\x27\x27[\s\S]*?\x27\x27\x27|"(?:\\.|[^"\\\n])*"|\x27[^\x27\n]*\x27'
    match = re.search(r'(?m)^[ \t]*(?:api_key|"api_key"|\x27api_key\x27)[ \t]*=[ \t]*(' + literal + ')', section)
    if not match:
        raise ConfigError('Save the API key manually in config.toml: cannot locate the API-key setting safely.')
    start, stop = table.end() + match.start(1), table.end() + match.end(1)
    updated = original[:start] + json.dumps(api_key.strip(), ensure_ascii=True) + original[stop:]
    checked = parse_config(updated)
    if checked.columns != config.columns or checked.sheet_name != config.sheet_name or checked.add_missing_data != config.add_missing_data:
        raise ConfigError('Config persistence validation failed; original preserved.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='', dir=path.parent, prefix=path.name+'.', suffix='.tmp', delete=False) as f:
            temporary = Path(f.name)
            f.write(updated)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def ensure_config(root=ROOT):
    root = Path(root)
    template = root / 'scripts/config-default.toml'
    default_text = template.read_text(encoding='utf-8')
    default = parse_config(default_text)
    if default.api_key:
        raise ConfigError('Default configuration must contain a blank API key.')
    destination = root / 'config.toml'
    if destination.exists():
        return load_config(destination)
    with destination.open('x', encoding='utf-8', newline='') as f:
        f.write(default_text)
    try:
        legacy = json.loads((root / 'files/config.json').read_text(encoding='utf-8-sig'))
        key = legacy.get('fred_api_key') if isinstance(legacy, dict) else None
    except (OSError, ValueError):
        key = None
    if isinstance(key, str) and key.strip():
        save_api_key(key, destination)
    return load_config(destination)
