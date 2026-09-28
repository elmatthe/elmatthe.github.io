"""Opt-in bounded release evidence. Excludes S&P; never prints credentials."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from cpi_config import load_config
import data_sources as ds

def main():
    key=load_config().api_key
    end=date.today().isoformat()[:7]
    jobs=[(id,vector,'statcan') for id,vector in ds.STATCAN_VECTORS.items()]
    jobs += [(id,sid,'monthly') for id,sid in ds.FRED_MONTHLY_SERIES.items()]
    jobs += [(id,sid,'daily') for id,sid in ds.FRED_DAILY_EOM_SERIES.items() if sid!='SP500']
    def check(job):
        id,sid,kind=job
        result={'id':id,'source':sid,'expected_start':ds.EXPECTED_STARTS[id]}
        try:
            if kind=='statcan': data=ds.fetch_statcan_vector_range(sid,ds.MIN_YM,end)
            else:
                if not key: return {**result,'status':'SKIP: no credential'}
                fetch=ds.fetch_fred_monthly if kind=='monthly' else ds.fetch_fred_daily_eom
                data=fetch(sid,ds.MIN_YM,end,key)
            result.update(first=min(data),last=max(data),months=len(data))
            result['status']='PASS' if result['first']==result['expected_start'] else 'FAIL: historical start differs'
        except Exception:
            result['status']='FAIL: source request or parse failed (details suppressed to protect credentials)'
        return result
    with ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(check,jobs))
    evidence={'date':date.today().isoformat(),'sp500':'NOT REQUESTED: business-use authorization unconfirmed','series':results}
    destination=ROOT/'files/run-temp/live-sources.json'
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    for result in results:
        print(result['source'],result['status'],result.get('first',''),result.get('last',''),result.get('months',''))
    return int(any(r['status'].startswith('FAIL') for r in results))

if __name__=='__main__':
    raise SystemExit(main())
