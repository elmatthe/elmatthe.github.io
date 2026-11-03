"""Shared market-data layer for the desktop tools (Portfolio Rebalancer, Stock Comparison).

A Python mirror of the web apps' assets/js/market-data/: the same provider catalog,
notice classification, instrument identity, quote contract (md.quote.v1), error
contract (md.data-error.v1), request pacing and Bank of Canada exchange rates.
Standard library only (urllib, json, threading).

The canonical copy is _tools/shared_py/market_data/ in the website repository;
_tools/sync_shared_py.py copies it into each desktop tool and checks the copies.
"""

__version__ = "2026.11.03"
