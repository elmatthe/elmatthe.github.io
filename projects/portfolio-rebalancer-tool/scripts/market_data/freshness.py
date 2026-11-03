"""Quote freshness by missed trading sessions; mirrors rows.js freshnessOf.

Weekdays only: exchange holidays are not known here, so a holiday shows as one
missed session. 0 missed = the latest or previous session.
"""
from __future__ import annotations

import datetime as dt
import re

STALE_SESSIONS = 1
TOO_OLD_SESSIONS = 4


def missed_sessions(trading_date: str | None, now_epoch_s: float, time_zone: str | None = "America/New_York") -> int | None:
    if not trading_date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", trading_date):
        return None
    try:
        from zoneinfo import ZoneInfo
        today = dt.datetime.fromtimestamp(now_epoch_s, ZoneInfo(time_zone or "America/New_York")).date()
    except Exception:  # noqa: BLE001 - no tz database
        today = dt.datetime.fromtimestamp(now_epoch_s, dt.timezone.utc).date()
    start = dt.date.fromisoformat(trading_date)
    if start > today:
        return 0
    missed = 0
    day = start + dt.timedelta(days=1)
    while day < today:
        if day.weekday() < 5:
            missed += 1
        day += dt.timedelta(days=1)
    return missed


def freshness_of(trading_date: str | None, now_epoch_s: float, time_zone: str | None = None) -> tuple[str, int | None]:
    missed = missed_sessions(trading_date, now_epoch_s, time_zone)
    if missed is None:
        return "unknown", None
    if missed >= TOO_OLD_SESSIONS:
        return "too_old", missed
    if missed >= STALE_SESSIONS:
        return "stale", missed
    return "current", missed
