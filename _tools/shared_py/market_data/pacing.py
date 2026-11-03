"""Request pacing and per-key request counts for the desktop apps.

Scheduler mirrors assets/js/market-data/scheduler.js within one process (the desktop
apps run one window): start spacing, a gap after each response, a per-minute cap
and jitter. UsageCounter mirrors createUsageCounter: requests sent from THIS
computer per UTC day and month, plus the provider's own daily or monthly limit
answer (with its redacted wording) for the rest of that UTC day or month.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable

from .errors import DataError


class Scheduler:
    def __init__(self, min_spacing_ms: int = 0, min_gap_after_ms: int = 0, per_minute: int | None = None, jitter_ms: int = 0,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 rand: Callable[[], float] = random.random) -> None:
        self.min_spacing = min_spacing_ms / 1000
        self.min_gap = min_gap_after_ms / 1000
        self.per_minute = per_minute
        self.jitter = jitter_ms / 1000
        self.clock, self.sleep, self.rand = clock, sleep, rand
        self.last_start = -1e18
        self.last_end = None
        self.starts: deque[float] = deque()
        self.lock = threading.Lock()

    def wait_seconds(self, at: float | None = None) -> float:
        at = self.clock() if at is None else at
        wait = 0.0
        if self.min_spacing:
            wait = max(wait, self.last_start + self.min_spacing - at)
        if self.min_gap and self.last_end is not None:
            wait = max(wait, self.last_end + self.min_gap - at)
        if self.per_minute:
            recent = [t for t in self.starts if at - t < 60]
            if len(recent) >= self.per_minute:
                wait = max(wait, recent[-self.per_minute] + 60 - at)
        return max(0.0, wait)

    def run(self, task: Callable[[], object], cancelled: Callable[[], bool] = lambda: False):
        with self.lock:  # one request at a time per provider and key
            while True:
                wait = self.wait_seconds()
                if wait <= 0:
                    break
                self.sleep(wait + self.rand() * self.jitter)
            if cancelled():
                raise DataError("Request cancelled.", kind="aborted")
            start = self.clock()
            self.last_start = start
            self.starts.append(start)
            while self.starts and start - self.starts[0] >= 60:
                self.starts.popleft()
            try:
                return task()
            finally:
                self.last_end = self.clock()


class UsageCounter:
    """Counts requests in a small JSON file (or in memory when path is None)."""

    def __init__(self, path: Path | None = None, now: Callable[[], float] = time.time) -> None:
        self.path = Path(path) if path else None
        self.now = now
        self.memory: dict = {}
        self.lock = threading.Lock()

    def _today(self) -> str:
        return dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).date().isoformat()

    def _read(self) -> dict:
        entry: dict = {}
        if self.path:
            try:
                entry = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                entry = {}
        else:
            entry = dict(self.memory)
        t = self._today()
        same_day = entry.get("day") == t and isinstance(entry.get("count"), int) and entry["count"] >= 0
        same_month = entry.get("month") == t[:7] and isinstance(entry.get("monthCount"), int) and entry["monthCount"] >= 0
        raw = entry.get("limit") if isinstance(entry.get("limit"), dict) else None
        limit = None
        if raw and isinstance(raw.get("at"), (int, float)):
            at = dt.datetime.fromtimestamp(raw["at"] / 1000, dt.timezone.utc).date().isoformat()
            if (raw.get("scope") == "daily" and at == t) or (raw.get("scope") == "monthly" and at[:7] == t[:7]):
                limit = {"scope": raw["scope"], "at": raw["at"], "notice": str(raw.get("notice"))[:400] if raw.get("notice") else None}
        return {"day": t, "month": t[:7], "count": entry["count"] if same_day else 0,
                "monthCount": entry["monthCount"] if same_month else 0, "limit": limit}

    def _write(self, entry: dict) -> None:
        if self.path:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps(entry), encoding="utf-8")
            except OSError:
                pass
        else:
            self.memory = dict(entry)

    @property
    def count(self) -> int:
        return self._read()["count"]

    @property
    def month_count(self) -> int:
        return self._read()["monthCount"]

    @property
    def limit(self) -> dict | None:
        return self._read()["limit"]

    def increment(self) -> int:
        with self.lock:
            e = self._read()
            e["count"] += 1
            e["monthCount"] += 1
            self._write(e)
            return e["count"]

    def mark_limit(self, scope: str, notice: str | None = None) -> None:
        with self.lock:
            e = self._read()
            e["limit"] = {"scope": scope, "at": int(self.now() * 1000), "notice": notice[:400] if notice else None}
            self._write(e)

    def clear_limit(self) -> None:
        with self.lock:
            e = self._read()
            e["limit"] = None
            self._write(e)
