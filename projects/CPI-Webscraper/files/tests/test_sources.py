from datetime import date
from unittest.mock import Mock
import pytest
import requests
import data_sources as ds
import cpi_webscraper as app
from cpi_config import SUPPORTED_IDS, load_config, ROOT, Column, Config

def fred(monkeypatch, observations, **extra):
    response = Mock()
    response.json.return_value = {'observations':observations, 'count':len(observations), **extra}
    get = Mock(return_value=response)
    monkeypatch.setattr(ds.requests, 'get', get)
    return get

def test_dates():
    assert list(ds.month_range('2023-12','2024-02')) == ['2023-12','2024-01','2024-02']
    assert ds.last_day_of_month(date(2024,2,3)) == date(2024,2,29)
    assert ds.normalize_range('1900-01','2024-01')[0] == '1913-01'
    assert ds.normalize_range('1900-01','1900-01',True) == ('1913-01','1913-01')
    for start,end in [('2024-13','2025-01'),('2025-01','2024-01'),('1900-01','1901-01')]:
        with pytest.raises(ValueError): ds.normalize_range(start,end)

def test_monthly_and_missing(monkeypatch):
    get = fred(monkeypatch,[{'date':'2024-01-01','value':'12.5'},{'date':'2024-02-01','value':'.'}])
    assert ds.fetch_fred_monthly('GS10','2024-01','2024-02','placeholder') == {'2024-01':12.5}
    assert 'frequency' not in get.call_args.kwargs['params']

def test_eom_latest_valid_not_response_order(monkeypatch):
    fred(monkeypatch,[{'date':'2024-01-31','value':'.'},{'date':'2024-01-30','value':'3'},{'date':'2024-01-02','value':'2'}])
    assert ds.fetch_fred_daily_eom('DFF','2024-01','2024-01','placeholder') == {'2024-01':3}

@pytest.mark.parametrize('payload', [{}, {'count':1,'observations':[]}, {'count':1,'observations':[{'date':'2024-01-01','value':'bad'}]}, {'count':1,'observations':[{'date':'2024-01-01','value':'NaN'}]}])
def test_malformed_fred(monkeypatch,payload):
    get=fred(monkeypatch,[])
    get.return_value.json.return_value=payload
    with pytest.raises(ds.SourceError): ds.fetch_fred_monthly('GS10','2024-01','2024-01','placeholder')

def test_retries_sanitized(monkeypatch):
    get=Mock(side_effect=requests.ConnectionError('sensitive-url-placeholder'))
    monkeypatch.setattr(ds.requests,'get',get)
    monkeypatch.setattr(ds.time,'sleep',lambda _:None)
    with pytest.raises(ds.SourceError) as e: ds.fetch_fred_monthly('GS2','2024-01','2024-01','placeholder')
    assert get.call_count == 3
    assert 'sensitive-url-placeholder' not in str(e.value)

def test_statcan_chunks(monkeypatch):
    calls=[]
    def request(url, params, *args):
        calls.append(params)
        return [{'status':'SUCCESS','object':{'responseStatusCode':0,'vectorId':41690973,'vectorDataPoint':[]}}]
    monkeypatch.setattr(ds,'request_json',request)
    assert ds.fetch_statcan_vector_range(41690973,'1913-01','1923-01') == {}
    assert calls[0]['endReferencePeriod'] == '1922-12-01'
    assert calls[1]['startRefPeriod'] == '1923-01-01'
    monkeypatch.setattr(ds,'request_json',lambda *args:[{'status':'FAILED'}])
    with pytest.raises(ds.SourceError): ds.fetch_statcan_vector_range(41690973,'2024-01','2024-01')

def test_mapping_and_identity(monkeypatch):
    assert ds.FRED_DAILY_EOM_SERIES['us_fed_funds_eom'] == 'DFF'
    assert ds.FRED_MONTHLY_SERIES['us_treasury_10y_avg'] == 'GS10'
    assert ds.FRED_MONTHLY_SERIES['us_treasury_2y_avg'] == 'GS2'
    assert 'DFEDTARU' not in ds.FRED_DAILY_EOM_SERIES.values()
    monkeypatch.setattr(ds,'fetch_all_statcan',lambda *a:{k:{} for k in ds.STATCAN_VECTORS})
    monkeypatch.setattr(ds,'fetch_fred_monthly',lambda sid,*a: {'1913-01':9} if sid == 'CPIAUCNS' else {})
    monkeypatch.setattr(ds,'fetch_fred_daily_eom',lambda *a:{})
    rows=ds.build_rows('1913-01','1913-02','placeholder')
    assert rows[0]['us_cpi_headline_nsa']==9
    assert rows[0]['ca_cpi_headline_nsa'] is None
    assert rows[1]['date']==date(1913,2,1)
    default=load_config(ROOT/'scripts/config-default.toml')
    columns=tuple(Column(c.id, 'renamed' if c.id=='us_cpi_headline_nsa' else c.header) for c in reversed(default.columns))
    custom=Config('Custom','',columns)
    assert custom.values(rows[0])[12]==9

def test_release_lag_vs_failure():
    empty={k:{} for k in SUPPORTED_IDS[1:]}
    recent=date.today().isoformat()[:7]
    ds.validate_sources(empty,recent,recent)
    with pytest.raises(ds.SourceError): ds.validate_sources(empty,'2000-01','2000-02')

def test_source_failure_before_writer(monkeypatch):
    monkeypatch.setattr(app,'load_config',lambda:load_config(ROOT/'scripts/config-default.toml'))
    monkeypatch.setattr(app,'build_rows',Mock(side_effect=ds.SourceError('source failed')))
    writer=Mock()
    monkeypatch.setattr(app,'write_to_workbook',writer)
    with pytest.raises(ds.SourceError): app.download('2024-01','2024-02','placeholder','unused.xlsx')
    writer.assert_not_called()

def test_csv_path_cannot_overwrite_workbook(monkeypatch):
    monkeypatch.setattr(app,'load_config',lambda:load_config(ROOT/'scripts/config-default.toml'))
    build=Mock()
    monkeypatch.setattr(app,'build_rows',build)
    with pytest.raises(ValueError): app.download('2024-01','2024-02','placeholder','model.xlsx','model.xlsx')
    build.assert_not_called()

def test_csv_failure_reports_excel_success(monkeypatch):
    monkeypatch.setattr(app,'load_config',lambda:load_config(ROOT/'scripts/config-default.toml'))
    monkeypatch.setattr(app,'build_rows',Mock(return_value=[]))
    monkeypatch.setattr(app,'write_to_workbook',Mock())
    monkeypatch.setattr(app,'write_to_csv',Mock(side_effect=OSError()))
    with pytest.raises(ValueError,match='Excel was saved successfully'):
        app.download('2024-01','2024-02','placeholder','model.xlsx','output.csv')


def test_end_month_is_clamped_to_the_current_month():
    today = date(2026, 11, 3)
    assert ds.normalize_range('2026-01', '9998-12', today=today) == ('2026-01', '2026-11')
    assert ds.normalize_range('2026-11', '2026-11', True, today=today) == ('2026-11', '2026-11')
    with pytest.raises(ValueError, match='in the future'):
        ds.normalize_range('2027-01', '2027-02', today=today)
    with pytest.raises(ValueError, match='YYYY-MM'):
        ds.normalize_range('2026-13', '2026-12', today=today)
    start, end, note = app.parse_months('range', '2026', '1', '9999', '12', today=today)
    assert (start, end) == ('2026-01', '2026-11') and 'current month' in note and 'left blank' in note


@pytest.mark.parametrize('status,retried,message', [
    (400, False, 'FRED rejected the request (HTTP 400). Check that your FRED API key is correct'),
    (403, False, 'FRED rejected the request (HTTP 403)'),
    (404, False, 'series was not found'),
    (429, True, 'too many requests (HTTP 429)'),
    (500, True, 'request failed after bounded retries (HTTP 500)'),
])
def test_client_errors_are_not_retried_and_are_explained(monkeypatch, status, retried, message):
    response = Mock(status_code=status)
    response.raise_for_status.side_effect = requests.HTTPError('https://example.invalid/?api_key=sensitive-placeholder')
    get = Mock(return_value=response)
    monkeypatch.setattr(ds.requests, 'get', get)
    monkeypatch.setattr(ds.time, 'sleep', lambda _: None)
    with pytest.raises(ds.SourceError) as error:
        ds.fetch_fred_monthly('GS10', '2024-01', '2024-01', 'sensitive-placeholder')
    assert message in str(error.value) and 'sensitive-placeholder' not in str(error.value)
    assert get.call_count == (3 if retried else 1)


def test_statcan_lock_window_message(monkeypatch):
    response = Mock(status_code=409)
    response.raise_for_status.side_effect = requests.HTTPError('locked')
    monkeypatch.setattr(ds.requests, 'get', Mock(return_value=response))
    monkeypatch.setattr(ds.time, 'sleep', lambda _: None)
    with pytest.raises(ds.SourceError, match='Statistics Canada is updating its tables'):
        ds.fetch_statcan_vector_range(41690973, '2024-01', '2024-01')


def _fake_sources(monkeypatch, calls):
    def statcan(vector, start, end, max_retries=3):
        ds._before_request('Statistics Canada')
        return {m: 100.0 for m in ds.month_range(start, end)}
    def fred(series, start, end, key, daily=False, max_retries=3):
        ds._before_request('FRED ' + series)
        calls.append(series)
        return {m: 1.0 for m in ds.month_range(start, end)}
    monkeypatch.setattr(ds, 'fetch_statcan_vector_range', statcan)
    monkeypatch.setattr(ds, 'fetch_fred', fred)


def test_current_month_end_of_month_values_are_left_blank(monkeypatch):
    _fake_sources(monkeypatch, [])
    rows = ds.build_rows('2026-10', '2026-11', 'placeholder', today=date(2026, 11, 3))
    october, november = rows
    assert october['us_sp500_eom'] == 1.0 and october['us_10y2y_eom'] == 1.0
    assert november['us_sp500_eom'] is None and november['us_fed_funds_eom'] is None and november['us_10y2y_eom'] is None
    assert november['us_cpi_headline_nsa'] == 1.0 and november['ca_cpi_headline_nsa'] == 100.0


def test_progress_and_cancel(monkeypatch):
    calls = []
    _fake_sources(monkeypatch, calls)
    seen = []
    ds.build_rows('2024-01', '2024-02', 'placeholder', progress=lambda done, total, source: seen.append((done, total)), today=date(2026, 11, 3))
    assert seen[-1] == (18, 18) and ds.request_count('2024-01', '2024-02') == 18
    with pytest.raises(ds.Cancelled):
        ds.build_rows('2024-01', '2024-02', 'placeholder', cancel=lambda: len(calls) >= 3, today=date(2026, 11, 3))


def test_yahoo_backfill_is_disabled_before_any_request(monkeypatch):
    config = load_config(ROOT/'scripts/config-default.toml')
    monkeypatch.setattr(app, 'load_config', lambda: Config(config.sheet_name, '', config.columns, True))
    build = Mock()
    monkeypatch.setattr(app, 'build_rows', build)
    with pytest.raises(ValueError, match='Yahoo Finance S&P 500 backfill'):
        app.download('2024-01', '2024-02', 'placeholder', 'model.xlsx')
    build.assert_not_called()
