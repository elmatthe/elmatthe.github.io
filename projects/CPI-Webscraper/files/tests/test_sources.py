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
