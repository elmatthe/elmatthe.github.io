"""Published economic series; no interpolation or substitute history."""
from datetime import date, datetime, timedelta, timezone
from dateutil.relativedelta import relativedelta
from dateutil.tz import gettz
import math
import re
import time
import requests
from cpi_config import SUPPORTED_IDS

MIN_YM = "1913-01"
STATCAN_WDS_BASE = "https://www150.statcan.gc.ca/t1/wds/rest"
FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations"
STATCAN_VECTORS = {
    'ca_cpi_headline_nsa': '41690973', 'ca_cpi_headline_sa': '41690914',
    'ca_cpi_core_nsa': '41691233', 'ca_cpi_core_sa': '41690924',
    'ca_cpi_alberta_nsa': '41692327',
}
FRED_MONTHLY_SERIES = {
    'us_cpi_headline_nsa': 'CPIAUCNS', 'us_cpi_headline_sa': 'CPIAUCSL',
    'us_cpi_core_nsa': 'CPILFENS', 'us_cpi_core_sa': 'CPILFESL',
    'us_unemployment_sa': 'UNRATE', 'us_fed_funds_avg': 'FEDFUNDS',
    'us_treasury_10y_avg': 'GS10', 'us_treasury_2y_avg': 'GS2',
    'us_pce_sa': 'PCEPI', 'us_core_pce_sa': 'PCEPILFE',
}
FRED_DAILY_EOM_SERIES = {
    'us_fed_funds_eom': 'DFF', 'us_sp500_eom': 'SP500', 'us_10y2y_eom': 'T10Y2Y',
}
EXPECTED_STARTS = {
    'ca_cpi_headline_nsa': '1914-01', 'ca_cpi_headline_sa': '1992-01',
    'ca_cpi_core_nsa': '1961-01', 'ca_cpi_core_sa': '1992-01', 'ca_cpi_alberta_nsa': '1978-09',
    'us_cpi_headline_nsa': '1913-01', 'us_cpi_headline_sa': '1947-01',
    'us_cpi_core_nsa': '1957-01', 'us_cpi_core_sa': '1957-01',
    'us_unemployment_sa': '1948-01', 'us_fed_funds_avg': '1954-07',
    'us_fed_funds_eom': '1954-07', 'us_sp500_eom': None, 'us_10y2y_eom': '1976-06',
    'us_treasury_10y_avg': '1953-04', 'us_treasury_2y_avg': '1976-06',
    'us_pce_sa': '1959-01', 'us_core_pce_sa': '1959-01',
}
YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC'
YAHOO_ERROR = 'Optional Yahoo historical backfill is unavailable or inconsistent; workbook was not touched.'
# FRED publishes SP500 to 0.01 index points. 120 completed live overlap months
# differed by at most 0.000234375 points (Yahoo binary float representation).
# Allow half of FRED's last published decimal place, with no relative tolerance.
SP500_ABSOLUTE_TOLERANCE = 0.005

class SourceError(ValueError):
    """Sanitized error: HTTP exception strings can contain an API key."""


def ym_to_date(ym):
    if not isinstance(ym, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}", ym):
        raise ValueError('Use a valid YYYY-MM date.')
    return date.fromisoformat(ym + '-01')


def month_range(start_ym, end_ym):
    cur, end = ym_to_date(start_ym), ym_to_date(end_ym)
    if cur > end:
        raise ValueError('End date must not precede start date.')
    while cur <= end:
        yield cur.isoformat()[:7]
        cur += relativedelta(months=1)


def normalize_range(start, end, single=False):
    ym_to_date(start); ym_to_date(end)
    if end < start:
        raise ValueError('End date must not precede start date.')
    start = max(start, MIN_YM)
    if single:
        end = start
    if end < start:
        raise ValueError('The range ends before January 1913.')
    return start, end


def last_day_of_month(d):
    return d.replace(day=1) + relativedelta(months=1, days=-1)


def request_json(url, params, source, max_retries=3, headers=None):
    if not 1 <= max_retries <= 5:
        raise ValueError('Retry count must be between 1 and 5.')
    for attempt in range(max_retries):
        try:
            response = requests.get(url, params=params, timeout=60, headers=headers)
            response.raise_for_status()
        except requests.RequestException:
            if attempt + 1 == max_retries:
                raise SourceError(f'{source}: request failed after bounded retries. Check connection and credentials; workbook was not touched.') from None
            time.sleep(2 ** attempt)
            continue
        try:
            return response.json()
        except ValueError:
            raise SourceError(f'{source}: invalid JSON response; workbook was not touched.') from None


def numeric(value):
    if isinstance(value, bool):
        raise ValueError
    result = float(value)
    if not math.isfinite(result):
        raise ValueError
    return result


def reduce_daily_eom(observations):
    """Select the latest valid trading date, independent of response ordering."""
    seen, latest = set(), {}
    for d, value in observations:
        if type(d) is not date or d in seen:
            raise ValueError('Invalid or duplicate daily observation date.')
        seen.add(d)
        if value is None:
            continue
        value = numeric(value)
        ym = d.isoformat()[:7]
        if ym not in latest or d > latest[ym][0]:
            latest[ym] = (d, value)
    return {ym: value for ym, (_, value) in latest.items()}


def parse_yahoo_daily(payload, start, end):
    """Raw daily Close only; exchange-local dates, including pre-1970 Windows."""
    try:
        chart = payload['chart']
        if chart['error'] is not None or not isinstance(chart['result'], list) or len(chart['result']) != 1:
            raise ValueError
        result = chart['result'][0]
        meta = result['meta']
        if meta['symbol'] != '^GSPC' or meta['exchangeTimezoneName'] != 'America/New_York' or meta['dataGranularity'] != '1d':
            raise ValueError
        exchange_tz = gettz(meta['exchangeTimezoneName'])
        quotes = result['indicators']['quote']
        if exchange_tz is None or not isinstance(quotes, list) or len(quotes) != 1:
            raise ValueError
        stamps, closes = result['timestamp'], quotes[0]['close']
        if not isinstance(stamps, list) or not isinstance(closes, list) or len(stamps) != len(closes) or not stamps:
            raise ValueError
        seen, daily = set(), []
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        for stamp, close in zip(stamps, closes):
            if type(stamp) is not int:
                raise ValueError
            d = (epoch + timedelta(seconds=stamp)).astimezone(exchange_tz).date()
            if d in seen or not start <= d <= end:
                raise ValueError
            seen.add(d)
            if close is None:
                continue
            if type(close) not in (int, float) or not math.isfinite(close) or close <= 0:
                raise ValueError
            daily.append((d, float(close)))
        if not daily:
            raise ValueError
        return daily
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise SourceError(YAHOO_ERROR) from None


def fetch_yahoo_sp500(start_ym, end_ym):
    start, end = ym_to_date(start_ym), last_day_of_month(ym_to_date(end_ym))
    # Local-midnight bounds match Yahoo's exchange-local daily timestamps.
    exchange_tz = gettz('America/New_York')
    if exchange_tz is None:
        raise SourceError(YAHOO_ERROR)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    def seconds(d):
        local = datetime(d.year, d.month, d.day, tzinfo=exchange_tz)
        return int((local.astimezone(timezone.utc) - epoch).total_seconds())
    params = {'period1': seconds(start), 'period2': seconds(end + timedelta(days=1)), 'interval': '1d'}
    try:
        payload = request_json(YAHOO_CHART_URL, params, 'Yahoo', headers={
            'User-Agent': 'CPI-Webscraper/0.3.0', 'Accept': 'application/json'})
        return reduce_daily_eom(parse_yahoo_daily(payload, start, end))
    except SourceError:
        raise SourceError(YAHOO_ERROR) from None


def validate_sp500_overlap(fred, yahoo, months):
    if not 3 <= len(months) <= 6 or len(set(months)) != len(months):
        raise SourceError(YAHOO_ERROR)
    for month in months:
        if month not in fred or month not in yahoo:
            raise SourceError(YAHOO_ERROR)
        a, b = fred[month], yahoo[month]
        if any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in (a,b)) or abs(a-b) > SP500_ABSOLUTE_TOLERANCE:
            raise SourceError(YAHOO_ERROR)


def merge_sp500_history(fred, yahoo, start_ym, end_ym):
    # Only genuine observations fill missing months. FRED always takes precedence.
    return {**{m: v for m, v in yahoo.items() if start_ym <= m <= end_ym}, **fred}


def fetch_sp500(start_ym, end_ym, api_key, add_missing_data=False):
    fred = fetch_fred_daily_eom('SP500', start_ym, end_ym, api_key)
    if not add_missing_data:
        return fred
    current_month = date.today().isoformat()[:7]
    reference = dict(fred)
    completed = sorted(m for m in reference if m < current_month)
    if len(completed) < 3:
        # Historical-only/single-month runs still need an observed FRED boundary
        # and enough completed overlap months to authenticate the cash-index scale.
        previous = (date.today().replace(day=1) - timedelta(days=1)).isoformat()[:7]
        reference = {**fetch_fred_daily_eom('SP500', MIN_YM, previous, api_key), **fred}
        completed = sorted(m for m in reference if m < current_month)
    if len(completed) < 3:
        raise SourceError(YAHOO_ERROR)
    boundary = min(reference)  # Actual returned FRED window; never a fixed year.
    sample = completed[:6]
    yahoo = fetch_yahoo_sp500(min(start_ym, boundary), max(end_ym, sample[-1]))
    validate_sp500_overlap(reference, yahoo, sample)
    return merge_sp500_history(fred, yahoo, start_ym, end_ym)


def fetch_statcan_vector_range(vector_id, start_ym, end_ym, max_retries=3):
    months = list(month_range(start_ym, end_ym))
    out = {}
    for offset in range(0, len(months), 120):
        chunk = months[offset:offset+120]
        obj = request_json(STATCAN_WDS_BASE + '/getDataFromVectorByReferencePeriodRange', {
            'vectorIds':str(vector_id), 'startRefPeriod':chunk[0]+'-01',
            'endReferencePeriod':chunk[-1]+'-01'}, 'Statistics Canada', max_retries)
        try:
            if not isinstance(obj, list) or len(obj) != 1 or obj[0]['status'] != 'SUCCESS':
                raise ValueError
            data = obj[0]['object']
            if data['responseStatusCode'] != 0 or str(data['vectorId']) != str(vector_id) or not isinstance(data['vectorDataPoint'], list):
                raise ValueError
            for point in data['vectorDataPoint']:
                d = date.fromisoformat(point['refPer'])
                ym = d.isoformat()[:7]
                if d.day != 1 or ym not in chunk or ym in out:
                    raise ValueError
                value = point['value']
                out[ym] = None if value is None else numeric(value)
        except (ValueError, TypeError, KeyError, IndexError):
            raise SourceError('Statistics Canada: malformed or unsuccessful vector response; workbook was not touched.') from None
    return {k:v for k,v in out.items() if v is not None}


def fetch_all_statcan(start_ym, end_ym):
    return {key:fetch_statcan_vector_range(vector,start_ym,end_ym) for key,vector in STATCAN_VECTORS.items()}


def fetch_fred(series_id, start_ym, end_ym, api_key, daily=False, max_retries=3):
    if not api_key.strip():
        raise ValueError('Please enter your FRED API key.')
    start, end = ym_to_date(start_ym), last_day_of_month(ym_to_date(end_ym))
    params = {'series_id':series_id, 'api_key':api_key, 'file_type':'json',
              'observation_start':start.isoformat(), 'observation_end':end.isoformat(),
              'limit':100000, 'sort_order':'asc'}
    # Native monthly series need no frequency conversion. Daily series are reduced locally.
    payload = request_json(FRED_OBS_URL, params, 'FRED ' + series_id, max_retries)
    try:
        observations = payload['observations']
        if not isinstance(observations, list) or type(payload['count']) is not int or payload['count'] != len(observations):
            raise ValueError
        seen, daily_values = set(), []
        for obs in observations:
            d = date.fromisoformat(obs['date'])
            if d in seen or not start <= d <= end or (not daily and d.day != 1):
                raise ValueError
            seen.add(d)
            value = obs['value']
            daily_values.append((d, None if value == '.' else numeric(value)))
        return reduce_daily_eom(daily_values)
    except (ValueError, TypeError, KeyError):
        raise SourceError('FRED ' + series_id + ': malformed or incomplete observations; workbook was not touched.') from None


def fetch_fred_monthly(series_id, start_ym, end_ym, api_key, max_retries=3):
    return fetch_fred(series_id,start_ym,end_ym,api_key,False,max_retries)


def fetch_fred_daily_eom(series_id, start_ym, end_ym, api_key, max_retries=3):
    return fetch_fred(series_id,start_ym,end_ym,api_key,True,max_retries)


def validate_sources(data, start, end):
    if set(data) != set(SUPPORTED_IDS[1:]):
        raise SourceError('Incomplete source collection; workbook was not touched.')
    # An empty historical interval after inception is suspicious; allow recent release lag.
    lag_boundary = (date.today().replace(day=1) - relativedelta(months=3)).isoformat()[:7]
    for key, observations in data.items():
        if not isinstance(observations, dict):
            raise SourceError('Invalid source collection; workbook was not touched.')
        for ym, value in observations.items():
            ym_to_date(ym)
            if not start <= ym <= end:
                raise SourceError('Source returned dates outside the requested range.')
            numeric(value)
        first = EXPECTED_STARTS[key]
        if key == 'us_sp500_eom':
            first = (date.today() - relativedelta(years=10, months=-1)).isoformat()[:7]
        if not observations and first and max(start, first) <= min(end, lag_boundary):
            raise SourceError('A required source returned no observations in an established historical interval; workbook was not touched.')


def build_rows(start_ym, end_ym, api_key, add_missing_data=False):
    start_ym, end_ym = normalize_range(start_ym,end_ym)
    if not api_key.strip():
        raise ValueError('Please enter your FRED API key.')
    data = fetch_all_statcan(start_ym,end_ym)
    data.update({key:fetch_fred_monthly(sid,start_ym,end_ym,api_key) for key,sid in FRED_MONTHLY_SERIES.items()})
    data.update({key:fetch_fred_daily_eom(sid,start_ym,end_ym,api_key) for key,sid in FRED_DAILY_EOM_SERIES.items() if key != 'us_sp500_eom'})
    data['us_sp500_eom'] = fetch_sp500(start_ym, end_ym, api_key, add_missing_data)
    validate_sources(data,start_ym,end_ym)
    return [{'date':ym_to_date(ym), **{key:data[key].get(ym) for key in SUPPORTED_IDS[1:]}} for ym in month_range(start_ym,end_ym)]
