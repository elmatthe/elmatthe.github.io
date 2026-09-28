"""Offline Yahoo/FRED integration checks. All HTTP calls are mocked."""
from copy import deepcopy
from datetime import date, datetime, timezone, timedelta
from unittest.mock import Mock
import math
import pytest
import requests
from cpi_config import Config, ROOT, load_config
import cpi_webscraper as app
import data_sources as ds


def stamp(iso):
    return int((datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)-datetime(1970,1,1,tzinfo=timezone.utc)).total_seconds())


def payload(points=None):
    points = points if points is not None else [('2024-01-30T21:00:00',2),('2024-01-31T21:00:00',3),('2024-02-29T21:00:00',None)]
    return {'chart':{'error':None,'result':[{
        'meta':{'symbol':'^GSPC','exchangeTimezoneName':'America/New_York','dataGranularity':'1d'},
        'timestamp':[stamp(d) for d,v in points],
        'indicators':{'quote':[{'close':[v for d,v in points]}], 'adjclose':[{'adjclose':[999]*len(points)}]},
    }]}}


def test_parse_raw_close_and_eom():
    daily=ds.parse_yahoo_daily(payload(),date(2024,1,1),date(2024,2,29))
    assert daily==[(date(2024,1,30),2),(date(2024,1,31),3)]
    assert ds.reduce_daily_eom(reversed(daily))=={'2024-01':3}


def test_timezone_uses_exchange_date_and_pre1970():
    data=payload([('1927-12-30T21:00:00',17.66),('2024-03-01T00:30:00',5)])
    daily=ds.parse_yahoo_daily(data,date(1913,1,1),date(2024,2,29))
    assert daily==[(date(1927,12,30),17.66),(date(2024,2,29),5)]
    summer=payload([('2024-06-01T03:30:00',6)])
    assert ds.parse_yahoo_daily(summer,date(2024,5,1),date(2024,5,31))==[(date(2024,5,31),6)]


@pytest.mark.parametrize('mutation', [
    lambda p:p['chart'].update(error={'code':'bad'}),
    lambda p:p['chart'].update(result=[]),
    lambda p:p['chart']['result'].append(deepcopy(p['chart']['result'][0])),
    lambda p:p['chart']['result'][0]['meta'].update(symbol='SPY'),
    lambda p:p['chart']['result'][0]['meta'].update(exchangeTimezoneName='UTC'),
    lambda p:p['chart']['result'][0]['meta'].update(dataGranularity='1mo'),
    lambda p:p['chart']['result'][0]['timestamp'].append(stamp('2024-02-01T21:00:00')),
    lambda p:p['chart']['result'][0]['timestamp'].__setitem__(0,True),
    lambda p:p['chart']['result'][0]['timestamp'].__setitem__(0,10**25),
    lambda p:p['chart']['result'][0]['timestamp'].__setitem__(0,stamp('2023-12-31T21:00:00')),
    lambda p:p['chart']['result'][0]['indicators']['quote'][0]['close'].__setitem__(0,float('nan')),
    lambda p:p['chart']['result'][0]['indicators']['quote'][0]['close'].__setitem__(0,float('inf')),
    lambda p:p['chart']['result'][0]['indicators']['quote'][0]['close'].__setitem__(0,0),
    lambda p:p['chart']['result'][0]['indicators']['quote'][0]['close'].__setitem__(0,-2),
    lambda p:p['chart']['result'][0]['indicators']['quote'][0]['close'].__setitem__(0,'3'),
])
def test_malformed_result_rejected(mutation):
    data=payload();mutation(data)
    with pytest.raises(ds.SourceError,match='Optional Yahoo'):
        ds.parse_yahoo_daily(data,date(2024,1,1),date(2024,2,29))


@pytest.mark.parametrize('second',[2,3,None])
def test_duplicate_exchange_dates_rejected(second):
    data=payload([('2024-01-31T20:00:00',2),('2024-01-31T21:00:00',second)])
    with pytest.raises(ds.SourceError): ds.parse_yahoo_daily(data,date(2024,1,1),date(2024,1,31))


def test_unusable_null_history_rejected():
    with pytest.raises(ds.SourceError):
        ds.parse_yahoo_daily(payload([('2024-01-31T21:00:00',None)]),date(2024,1,1),date(2024,1,31))


def test_request_is_daily_gspc_without_key(monkeypatch):
    response=Mock();response.json.return_value=payload()
    get=Mock(return_value=response);monkeypatch.setattr(ds.requests,'get',get)
    assert ds.fetch_yahoo_sp500('2024-01','2024-02')=={'2024-01':3}
    assert get.call_args.args==(ds.YAHOO_CHART_URL,)
    args=get.call_args.kwargs
    assert args['params']=={'period1':stamp('2024-01-01T05:00:00'),'period2':stamp('2024-03-01T05:00:00'),'interval':'1d'}
    assert args['headers']['User-Agent']=='CPI-Webscraper/0.3.0'
    assert 'api_key' not in args['params']


def test_false_has_zero_yahoo_calls(monkeypatch):
    original={'2024-01':10}
    fred=Mock(return_value=original);yahoo=Mock(side_effect=AssertionError('must not call'))
    monkeypatch.setattr(ds,'fetch_fred_daily_eom',fred);monkeypatch.setattr(ds,'fetch_yahoo_sp500',yahoo)
    actual=ds.fetch_sp500('1913-01','2024-02','private-placeholder')
    assert actual is original and actual.get('1913-01') is None
    fred.assert_called_once_with('SP500','1913-01','2024-02','private-placeholder')
    yahoo.assert_not_called()


@pytest.mark.parametrize('boundary',['2020-02','2021-04'])
def test_dynamic_boundary_merge_and_fred_first(monkeypatch,boundary):
    months=list(ds.month_range(boundary,(ds.ym_to_date(boundary)+ds.relativedelta(months=5)).isoformat()[:7]))
    fred={m:100+i for i,m in enumerate(months)}
    events=[]
    def fetch_fred(*a):events.append('fred');return fred
    def fetch_yahoo(start,end):
        events.append(('yahoo',start,end))
        return {'1927-12':17.66, '1928-02':18,**{m:v+0.0002 for m,v in fred.items()}}
    monkeypatch.setattr(ds,'fetch_fred_daily_eom',fetch_fred)
    monkeypatch.setattr(ds,'fetch_yahoo_sp500',fetch_yahoo)
    result=ds.fetch_sp500('1913-01',months[-1],'private-placeholder',True)
    assert events==['fred',('yahoo','1913-01',months[-1])]
    assert result[boundary]==fred[boundary]
    assert result['1927-12']==17.66
    assert '1913-01' not in result and '1928-01' not in result


def test_historical_only_run_obtains_real_overlap(monkeypatch):
    reference={'2023-03':100,'2023-04':101,'2023-05':102}
    fred=Mock(side_effect=[{},reference]);yahoo=Mock(return_value={'1927-12':17.66,**reference})
    monkeypatch.setattr(ds,'fetch_fred_daily_eom',fred);monkeypatch.setattr(ds,'fetch_yahoo_sp500',yahoo)
    result=ds.fetch_sp500('1913-01','1930-01','private-placeholder',True)
    assert fred.call_count==2
    yahoo.assert_called_once_with('1913-01','2023-05')
    assert result=={'1927-12':17.66}


def test_merge_only_real_missing_values():
    assert ds.merge_sp500_history({'2020-01':100},{'1912-01':1,'1913-01':2,'2020-01':999,'2020-02':3},'1913-01','2020-02')=={'1913-01':2,'2020-01':100,'2020-02':3}


@pytest.mark.parametrize('offset,passes',[(0.000234375,True),(0.004,True),(0.006,False),(1,False)])
def test_overlap_absolute_tolerance(offset,passes):
    fred={'2024-01':5000,'2024-02':5100,'2024-03':5200}
    yahoo={m:v+offset for m,v in fred.items()}
    if passes:ds.validate_sp500_overlap(fred,yahoo,list(fred))
    else:
        with pytest.raises(ds.SourceError):ds.validate_sp500_overlap(fred,yahoo,list(fred))


@pytest.mark.parametrize('fault',['401','403','429','500','network','json','malformed','mismatch','missing_overlap'])
def test_failures_before_writer_and_no_key_disclosure(monkeypatch,capsys,fault):
    secret='private-placeholder-must-not-appear'
    config=load_config(ROOT/'scripts/config-default.toml')
    monkeypatch.setattr(app,'load_config',lambda:Config(config.sheet_name,secret,config.columns,True))
    writer=Mock();monkeypatch.setattr(app,'write_to_workbook',writer)
    # Exercise real app -> build -> source validation -> Yahoo parsing.
    months=['2024-01','2024-02','2024-03']
    values={m:100+i for i,m in enumerate(months)}
    monkeypatch.setattr(ds,'fetch_all_statcan',lambda *a:{k:values for k in ds.STATCAN_VECTORS})
    monkeypatch.setattr(ds,'fetch_fred_monthly',lambda *a:values)
    monkeypatch.setattr(ds,'fetch_fred_daily_eom',lambda *a:values)
    response=Mock()
    data=payload([(f'2024-{i:02d}-28T21:00:00',99+i) for i in range(1,4)])
    if fault.isdigit():response.raise_for_status.side_effect=requests.HTTPError(secret+' HTTP '+fault)
    elif fault=='json':response.json.side_effect=ValueError(secret)
    elif fault=='malformed':data={}
    elif fault=='mismatch':data['chart']['result'][0]['indicators']['quote'][0]['close'][0]=999
    elif fault=='missing_overlap':data['chart']['result'][0]['indicators']['quote'][0]['close'][0]=None
    response.json.return_value=data
    get=Mock(return_value=response)
    if fault=='network':get.side_effect=requests.ConnectionError(secret)
    monkeypatch.setattr(ds.requests,'get',get);monkeypatch.setattr(ds.time,'sleep',lambda _:None)
    with pytest.raises(ds.SourceError,match='Optional Yahoo') as error:
        app.download('2024-01','2024-03',secret,'unused.xlsx')
    writer.assert_not_called()
    assert secret not in str(error.value)
    output=capsys.readouterr();assert secret not in output.out+output.err
    assert get.call_count <= 3


def test_live_identity_independent_of_order():
    assert ds.FRED_MONTHLY_SERIES['us_treasury_10y_avg']=='GS10'
    assert ds.FRED_MONTHLY_SERIES['us_treasury_2y_avg']=='GS2'
    assert ds.FRED_MONTHLY_SERIES['us_pce_sa']=='PCEPI'
    assert ds.FRED_MONTHLY_SERIES['us_core_pce_sa']=='PCEPILFE'

def test_overlap_nonfinite_or_insufficient_rejected():
    reference={'2024-01':10,'2024-02':11,'2024-03':12}
    for bad in [float('nan'),float('inf'),0]:
        with pytest.raises(ds.SourceError):
            ds.validate_sp500_overlap(reference,{**reference,'2024-01':bad},list(reference))
    with pytest.raises(ds.SourceError):
        ds.validate_sp500_overlap(reference,reference,['2024-01'])
