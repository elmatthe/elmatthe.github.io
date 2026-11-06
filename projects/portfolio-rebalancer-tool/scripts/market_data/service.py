"""MarketData: keys, the ordered source list, pacing, caching and md.quote.v1 quotes for the desktop apps.

Mirrors the quote side of assets/js/market-data/index.js. Prices come from ONE ordered
list of sources (./sources.py): Yahoo Finance through the site's data gateway
(./gateway.py; no key, position 1 by default) and the providers the user adds with
their own key, tried one after another; every answer says which source gave it and why
earlier sources were skipped or failed. The list is saved in
files/runtime/market-data-settings.json. Keys belong to the user:
they stay on this computer and are sent only to their own provider (Finnhub and
Alpaca in request headers; Alpha Vantage and Marketstack in the query string, the
only method those providers offer). A key is kept for this session only unless the
user ticks "Remember on this computer", which writes it to files/runtime/keys.json
(owner-only permissions where the system supports them). Keys never appear in
exports, messages or logs.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Callable
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlencode

from . import alphavantage as av
from .adapters import ADAPTERS, normalize_currency
from . import sources as src
from .catalog import PROVIDER_IDS, PROVIDERS, is_us_venue, key_valid, plan_of, provider_available
from .errors import DataError
from .fx import latest_cad_rates
from .gateway import GATEWAY_ID, GATEWAY_NAME, GATEWAY_VIA, GatewayClient, configured_gateway_url
from .instruments import InstrumentResolver
from .pacing import Scheduler, UsageCounter

QUOTE_SCHEMA = "md.quote.v1"
MAX_BYTES = 4 * 1024 * 1024
QUOTE_FRESH_S = {"last_trade": 600, "latest_trading_day": 4 * 3600, "eod_close": 4 * 3600, "previous_close": 4 * 3600}
# Errors after which the next source in the list may still answer.
FALLBACK_KINDS = {"not_found", "not_covered", "not_configured", "entitlement", "auth", "rate_limited", "unavailable", "network", "timeout", "http",
                  "provider_notice", "invalid", "ambiguous", "currency_mismatch"}
USER_AGENT = "PortfolioTools-Desktop/1.3 (+https://elmatthe.github.io/projects/)"


def default_http(url: str, headers: dict, timeout: float = 15.0) -> tuple[int, str]:
    """GET url -> (status, text). Network failures become DataError(kind="network")."""
    req = urlrequest.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT, **headers})
    try:
        with urlrequest.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https provider URLs only
            data = res.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise DataError("response too large", kind="too_large")
            return res.status, data.decode("utf-8", "replace")
    except urlerror.HTTPError as e:
        return e.code, e.read(MAX_BYTES).decode("utf-8", "replace")
    except (urlerror.URLError, TimeoutError, OSError) as e:
        raise DataError(f"network error ({type(e).__name__})", kind="network") from None


def fingerprint(key: str, pid: str) -> str:
    """Short, non-reversible label used only to name a key's request-count file."""
    return "k" + hashlib.sha256(f"md.{pid}:{key.strip()}".encode()).hexdigest()[:10]


def compare_quotes(a: dict, b: dict) -> dict:
    """Same rules as index.js compareQuotes. Never averages; advisory only."""
    out = {"comparable": False, "reason": None, "diffPct": None, "label": None, "causes": []}
    if a["canonicalId"] != b["canonicalId"]:
        out["reason"] = "different instruments"
        return out
    if a["nativeCurrency"] != b["nativeCurrency"]:
        out["reason"] = f"different currencies ({a['nativeCurrency']} vs {b['nativeCurrency']})"
        return out
    closes = {"eod_close", "latest_trading_day", "previous_close"}
    if not (a["priceType"] == b["priceType"] or (a["priceType"] in closes and b["priceType"] in closes)):
        out["reason"] = f"different price types ({a['priceType']} vs {b['priceType']})"
        return out
    if a["tradingDate"] != b["tradingDate"]:
        out["reason"] = f"different sessions ({a['tradingDate']} vs {b['tradingDate']})"
        return out
    out["comparable"] = True
    out["diffPct"] = (a["nativePriceMajorUnits"] - b["nativePriceMajorUnits"]) / b["nativePriceMajorUnits"] * 100
    diff = abs(out["diffPct"])
    out["label"] = "Consistent" if diff <= 0.10 else "Minor difference" if diff <= 1 else "Investigate"
    if out["label"] == "Investigate":
        ratio = a["nativePriceMajorUnits"] / b["nativePriceMajorUnits"]

        def near(x: float) -> bool:
            return abs(ratio - x) / x < 0.02 or abs(1 / ratio - x) / x < 0.02
        if near(100):
            out["causes"].append("a factor of 100: pence vs pounds (unit problem)")
        if any(near(x) for x in (1.25, 1.5, 2, 3, 4, 5, 10)):
            out["causes"].append("a ratio like a stock split: one source may be adjusted")
        out["causes"] += ["a corporate action on that date", "a stale feed at one source", "a different listing"]
    return out


class _Session:
    def __init__(self, pid: str, key: str, secret: str | None, plan: dict, usage: UsageCounter, scheduler: Scheduler) -> None:
        self.pid, self.key, self.secret, self.plan, self.usage, self.scheduler = pid, key, secret, plan, usage, scheduler
        self.fp = fingerprint(key, pid)
        self.quotes: dict[str, tuple[float, dict]] = {}
        self.misses: dict[str, tuple[float, dict]] = {}
        self.listings: dict[str, tuple[float, dict | None]] = {}
        self.rejected = False
        self.retired = False


class MarketData:
    def __init__(self, runtime_dir: Path | str | None = None, http: Callable[[str, dict], tuple[int, str]] | None = None,
                 now: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep, reference: dict | None = None,
                 platform: str = "desktop", pacing_override_ms: int | None = None, clock: Callable[[], float] = time.monotonic,
                 gateway_url: str | None = None) -> None:
        self.runtime = Path(runtime_dir) if runtime_dir else None
        self.http = http or default_http
        self.now, self.sleep, self.clock = now, sleep, clock
        self.platform = platform
        self.pacing_override_ms = pacing_override_ms
        self.resolver = InstrumentResolver(reference)
        self.lock = threading.RLock()
        self.keys: dict[str, dict] = {}
        self.sessions: dict[str, _Session] = {}
        self.prefs: dict = {"plans": {}}
        self.priority: dict = {"order": [], "enabled": {}}
        self.notes: list[str] = []  # explanations of list changes the UI has not shown yet
        self.gateway = GatewayClient(configured_gateway_url() if gateway_url is None else gateway_url, self.http, now=now, sleep=sleep,
                                     runtime_dir=self.runtime, spacing_s=0 if pacing_override_ms == 0 else 0.35, clock=clock)
        self._load()

    # ------------------------------------------------------------ persistence
    def _path(self, name: str) -> Path | None:
        return self.runtime / name if self.runtime else None

    def _load(self) -> None:
        for name, target in (("market-data-settings.json", "prefs"), ("keys.json", "keys")):
            path = self._path(name)
            if not path or not path.exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if target == "prefs" and isinstance(data, dict):
                if isinstance(data.get("plans"), dict):
                    self.prefs["plans"] = data["plans"]
                if isinstance(data.get("sources"), dict):
                    self.prefs["sources"] = data["sources"]
                elif "routing" in data or "fallback" in data:
                    self.prefs["legacy"] = {"routing": data.get("routing"), "fallback": data.get("fallback")}
            if target == "keys" and isinstance(data, dict):
                for pid, entry in data.items():
                    if pid in PROVIDERS and provider_available(pid, self.platform) and isinstance(entry, dict) and key_valid(pid, entry.get("key")):
                        self.keys[pid] = {"key": entry["key"].strip(), "secret": entry.get("secret"), "persistence": "local"}
        # The source list: as saved, or built once from the previous routing choice.
        legacy = self.prefs.pop("legacy", None)
        saved = self.prefs.get("sources")
        if isinstance(saved, dict) and isinstance(saved.get("order"), list):
            built = src.normalize_priority(saved, self.platform, self.configured())
        elif legacy:
            built = src.migrate_legacy(legacy, self.platform, self.configured())
        else:
            built = src.normalize_priority(None, self.platform, self.configured())
        self.priority = {"order": built["order"], "enabled": built["enabled"]}
        self.notes.extend(built["notes"])
        if legacy or built["notes"] or (isinstance(saved, dict) and (saved.get("order") != self.priority["order"] or saved.get("enabled") != self.priority["enabled"])):
            self._save_prefs()

    def _save_prefs(self) -> None:
        path = self._path("market-data-settings.json")
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {"plans": self.prefs.get("plans", {}), "sources": {"v": 1, **self.priority}}
            path.write_text(json.dumps(data, indent=1), encoding="utf-8")

    def _save_keys(self) -> None:
        path = self._path("keys.json")
        if not path:
            return
        remembered = {pid: {"key": e["key"], **({"secret": e["secret"]} if e.get("secret") else {})} for pid, e in self.keys.items() if e["persistence"] == "local"}
        if not remembered:
            try:
                path.unlink()
            except OSError:
                pass
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(remembered), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    # ------------------------------------------------------------ keys, plans, routing
    def plan_for(self, pid: str) -> dict:
        saved = self.prefs["plans"].get(pid) or {}
        return plan_of(pid, saved.get("id"), saved)

    def set_key(self, pid: str, key: str, secret: str | None = None, remember: bool = False) -> str:
        if not provider_available(pid, self.platform):
            raise ValueError(f"{PROVIDERS.get(pid, {}).get('name', pid)} is not available here.")
        key = (key or "").strip()
        with self.lock:
            had_key = pid in self.keys
            if key:
                if not key_valid(pid, key):
                    raise ValueError(f"That does not look like a {PROVIDERS[pid]['name']} key (letters and digits only).")
                if pid == "alpaca" and not (secret or "").strip():
                    raise ValueError("Alpaca needs both the key ID and the secret key.")
                self.keys[pid] = {"key": key, "secret": (secret or "").strip() or None, "persistence": "local" if remember else "session"}
            else:
                old = self.keys.pop(pid, None)
                if old:  # a removed key also removes its request-count file
                    path = self._path(f"usage-{pid}-{fingerprint(old['key'], pid)}.json")
                    if path and path.exists():
                        path.unlink()
            self._retire(pid)
            self._save_keys()
            # A new key switches the provider on where it stands in the list (never at the
            # top); a removed key switches it off and keeps its place.
            if bool(key) != had_key:
                r = src.key_changed(self.priority, pid, bool(key), is_new=not had_key, configured=self.configured())
                self.priority = {"order": r["priority"]["order"], "enabled": r["priority"]["enabled"]}
                if r["note"]:
                    self.notes.append(r["note"])
                self._save_prefs()
            return self.keys.get(pid, {}).get("persistence", "")

    def forget_all_keys(self) -> None:
        for pid in list(self.keys):
            self.set_key(pid, "")
        fixed = src.normalize_priority(self.priority, self.platform, [])
        self.priority = {"order": fixed["order"], "enabled": fixed["enabled"]}
        self.notes.extend(fixed["notes"])
        self._save_prefs()

    def set_plan(self, pid: str, plan_id: str, limit: float | None = None, international: bool = False) -> dict:
        with self.lock:
            self.prefs["plans"][pid] = {"id": plan_id, **({"limit": limit} if limit else {}), **({"international": True} if international else {})}
            self._save_prefs()
            self._retire(pid)
        return self.plan_for(pid)

    # ------------------------------------------------------------ the source list
    def take_notes(self) -> list[str]:
        """Explanations of list changes (keys added or removed, repairs) not yet shown."""
        notes, self.notes = self.notes, []
        return notes

    def source_state(self, pid: str) -> dict:
        """Whether a source can be asked right now, and why not: {"available", "code", "reason", "short"}."""
        if pid == GATEWAY_ID:
            return self.gateway.availability()
        if not provider_available(pid, self.platform):
            return {"available": False, "code": "not_offered", "reason": PROVIDERS.get(pid, {}).get("unsupportedReason") or "not offered here"}
        if pid not in self.keys:
            return {"available": False, "code": "no_key", "reason": "no API key saved", "short": "no key"}
        s = self._session(pid)
        if s.rejected:
            return {"available": False, "code": "auth", "reason": "rejected your key earlier (check the key)", "short": "rejected the key"}
        lim = s.usage.limit
        if lim:
            when = dt.datetime.fromtimestamp(lim["at"] / 1000, dt.timezone.utc).strftime("%H:%M")
            period = "month" if lim["scope"] == "monthly" else "day"
            return {"available": False, "code": "rate_limited", "short": f"{lim['scope']} limit reached",
                    "reason": f"reported its {lim['scope']} limit at {when} UTC; nothing more is sent until the {period} ends (UTC) unless you choose \"Check again\""}
        return {"available": True, "code": None, "reason": None}

    def _states(self) -> dict:
        return {pid: self.source_state(pid) for pid in self.priority["order"]}

    def has_price_source(self, op: str = "quote") -> bool:
        return any(self.priority["enabled"].get(p) and op in src.capabilities(p, self.platform) and self.source_state(p)["available"] for p in self.priority["order"])

    def sources_list(self) -> list[dict]:
        out = []
        for index, pid in enumerate(self.priority["order"]):
            st = self.source_state(pid)
            info = src.SOURCE_INFO[pid]
            enabled = bool(self.priority["enabled"].get(pid))
            status = ("needs_key" if info["needsKey"] and pid not in self.keys else "off") if not enabled else ("on" if st["available"] else "unavailable")
            out.append({"id": pid, "name": info["name"], "position": index + 1, "enabled": enabled, "needsKey": info["needsKey"],
                        "configured": (pid in self.keys) if info["needsKey"] else True, "available": st["available"], "state": st,
                        "ops": src.capabilities(pid, self.platform), "labels": info["labels"], "summary": info["summary"], "status": status})
        return out

    def move_source(self, pid: str, to_index: int) -> dict:
        with self.lock:
            before = self.priority["order"].index(pid) if pid in self.priority["order"] else -1
            self.priority = src.move_source(self.priority, pid, to_index)
            self._save_prefs()
            after = self.priority["order"].index(pid) if pid in self.priority["order"] else -1
        return {"moved": before != after, "position": after + 1, "count": len(self.priority["order"]),
                "message": f"{src.source_name(pid)} moved to position {after + 1} of {len(self.priority['order'])}."}

    def set_source_enabled(self, pid: str, on: bool) -> dict:
        with self.lock:
            r = src.set_source_enabled(self.priority, pid, on, self.configured())
            self.priority = {"order": r["priority"]["order"], "enabled": r["priority"]["enabled"]}
            self._save_prefs()
        return {"changed": r["changed"], "note": r["note"], "message": r["note"] or f"{src.source_name(pid)} switched {'on' if on else 'off'}."}

    def configured(self) -> list[str]:
        return [pid for pid in PROVIDER_IDS if pid in self.keys and provider_available(pid, self.platform)]

    def _retire(self, pid: str) -> None:
        s = self.sessions.pop(pid, None)
        if s:
            s.retired = True

    def _session(self, pid: str) -> _Session | None:
        with self.lock:
            entry = self.keys.get(pid)
            if not entry:
                return None
            if pid in self.sessions:
                return self.sessions[pid]
            plan = self.plan_for(pid)
            pacing = {"minSpacingMs": self.pacing_override_ms} if self.pacing_override_ms is not None else plan["pacing"]
            usage = UsageCounter(self._path(f"usage-{pid}-{fingerprint(entry['key'], pid)}.json"), now=self.now)
            scheduler = Scheduler(pacing.get("minSpacingMs", 0), pacing.get("minGapAfterMs", 0), pacing.get("perMinute"), pacing.get("jitterMs", 0),
                                  clock=self.clock, sleep=self.sleep)
            s = _Session(pid, entry["key"], entry.get("secret"), plan, usage, scheduler)
            self.sessions[pid] = s
            return s

    # ------------------------------------------------------------ routing and estimates
    def resolve(self, text: str) -> dict:
        return self.resolver.resolve(text)

    def route(self, identity: dict, op: str = "quote", require=None) -> dict:
        """The sources to try for an identity and operation, in list order, and why others are skipped."""
        return src.plan_sources(identity, op, self.priority, self.platform, self._states(), {pid: self.plan_for(pid) for pid in PROVIDER_IDS}, require)

    def budget(self, pid: str) -> dict:
        if pid == GATEWAY_ID:
            return {"shared": True, "sentToday": None, "sentMonth": None, "planId": "free", "planLabel": "Yahoo Finance (no key; shared and rate-limited)",
                    "remaining": None, "period": None, "limitRecord": None}
        s = self._session(pid)
        plan = self.plan_for(pid)
        out = {"sentToday": s.usage.count if s else 0, "sentMonth": s.usage.month_count if s else 0, "planId": plan["id"],
               "planLabel": plan["label"], "remaining": None, "period": None, "limitRecord": s.usage.limit if s else None}
        limits = plan["limits"]
        if limits.get("perDay"):
            out["remaining"], out["period"] = max(0, limits["perDay"] - out["sentToday"]), "day"
        elif limits.get("perMonth"):
            out["remaining"], out["period"] = max(0, limits["perMonth"] - out["sentMonth"]), "month"
        elif limits.get("perMinute"):
            out["period"], out["perMinute"] = "minute", limits["perMinute"]
        return out

    def estimate(self, identities: list[dict]) -> dict:
        per: dict[str, dict] = {}
        uncovered = []
        for identity in identities:
            if not identity or identity.get("status") != "resolved":
                uncovered.append({"displayTicker": (identity or {}).get("displayTicker"), "reason": (identity or {}).get("reason") or "not resolved"})
                continue
            r = self.route(identity, "quote")
            if not r["candidates"]:
                reasons = "; ".join(src.describe_skipped(r["skipped"])) or "no source switched on"
                uncovered.append({"displayTicker": identity["displayTicker"], "reason": reasons})
                continue
            first = r["candidates"][0]
            if first["id"] == GATEWAY_ID:
                hit = self.gateway.quotes.get(first["symbol"])
                cost = 0 if hit and self.now() - hit[0] <= 600 else 1
                entry = per.setdefault(GATEWAY_ID, {"requests": 0, "rows": 0})
                entry["requests"] += cost
                entry["rows"] += 1
                continue
            s = self.sessions.get(first["id"])
            hit = s.quotes.get(f"{identity['canonicalId']}|{first['symbol']}") if s else None
            fresh = hit and self.now() - hit[0] <= QUOTE_FRESH_S.get(hit[1]["priceType"], 600)
            listing_cached = bool(s and first["id"] == "alphavantage" and (s.listings.get(first["symbol"]) or (0, None))[1])
            cost = 0 if fresh else PROVIDERS[first["id"]]["requestCost"](identity, listing_cached)
            entry = per.setdefault(first["id"], {"requests": 0, "rows": 0})
            entry["requests"] += cost
            entry["rows"] += 1
        for pid, entry in per.items():
            entry.update(self.budget(pid))
        return {"perProvider": per, "uncovered": uncovered, "total": sum(e["requests"] for e in per.values())}

    # ------------------------------------------------------------ quotes
    def _limit_error(self, s: _Session) -> DataError:
        lim = s.usage.limit
        name = PROVIDERS[s.pid]["name"]
        when = dt.datetime.fromtimestamp(lim["at"] / 1000, dt.timezone.utc).strftime("%H:%M")
        period = "month" if lim["scope"] == "monthly" else "day"
        return DataError(f"{name} reported its {lim['scope']} limit at {when} UTC. No more {name} requests are sent from this computer "
                         f"until the {period} ends (UTC) unless you choose \"Check again\".", kind="rate_limited", quota_scope=lim["scope"],
                         definitive=True, provider=name, notice=lim.get("notice"), retryable=False)

    def _send(self, s: _Session, url: str, headers: dict, cancelled: Callable[[], bool], probe: bool = False) -> tuple[int, str]:
        def task() -> tuple[int, str]:
            if s.retired:
                raise DataError("Your API key changed while this request was running; nothing from it was used.", kind="key_changed", provider=PROVIDERS[s.pid]["name"])
            if s.usage.limit and not probe:
                raise self._limit_error(s)
            if s.rejected and not probe:
                raise DataError(f"{PROVIDERS[s.pid]['name']} rejected the key earlier. Check it in Settings.", kind="auth", definitive=True, provider=PROVIDERS[s.pid]["name"])
            s.usage.increment()
            return self.http(url, headers)
        return s.scheduler.run(task, cancelled)

    def _redact(self, s: _Session, error: DataError) -> DataError:
        for secret in (s.key, s.secret):
            if secret:
                error.message = av.redact_key(error.message, secret)
                if error.notice:
                    error.notice = av.redact_key(error.notice, secret)
        return error

    def _av_listing(self, s: _Session, symbol: str, cancelled) -> dict | None:
        hit = s.listings.get(symbol)
        if hit and (hit[1] or self.now() - hit[0] < 86400):
            return hit[1]
        found = None
        for keywords in (symbol, symbol.rsplit(".", 1)[0] if "." in symbol else None):
            if not keywords:
                continue
            body = self._av_call(s, {"function": "SYMBOL_SEARCH", "keywords": keywords}, symbol, cancelled)
            found = av.pick_listing(body, symbol)
            if found:
                break
        s.listings[symbol] = (self.now(), found)
        return found

    def _av_call(self, s: _Session, params: dict, symbol: str, cancelled, probe: bool = False) -> dict:
        url = f"{av.AV_BASE}?{urlencode({**params, 'apikey': s.key})}"
        for attempt in range(len(av.AV_BURST_BACKOFF_S) + 1):
            status, text = self._send(s, url, {}, cancelled, probe=probe)
            if status != 200:
                raise self._redact(s, DataError(f"Alpha Vantage HTTP {status}", kind="unavailable" if status >= 500 else "http", status=status, provider=av.AV_PROVIDER))
            try:
                body = av.parse_body(text, symbol)
                if probe:
                    s.usage.clear_limit()
                return body
            except DataError as error:
                self._redact(s, error)
                if error.kind == "rate_limited" and error.quota_scope == "burst" and attempt < len(av.AV_BURST_BACKOFF_S):
                    self.sleep(av.AV_BURST_BACKOFF_S[attempt])
                    continue
                if error.kind == "auth" and "rejected" in error.message:
                    s.rejected = True
                if error.kind == "rate_limited" and error.quota_scope == "daily":
                    s.usage.mark_limit("daily", error.notice)
                raise
        raise DataError("unreachable", kind="unavailable")

    def _settle_currency(self, pid: str, identity: dict, raw: dict, listing: dict | None) -> dict:
        name = GATEWAY_NAME if pid == GATEWAY_ID else PROVIDERS[pid]["name"]
        if raw.get("currency"):
            if identity.get("currencyEvidence") == "curated_reference" and raw["currency"] != identity.get("currency"):
                raise DataError(f"{name} reports {identity['displayTicker']} in {raw.get('rawCurrency') or raw['currency']}, but this listing trades in {identity['currency']}. The price was not used.",
                                kind="currency_mismatch", definitive=True, provider=name)
            note = (f"{name} reports this listing trades in {raw['currency']}, not {identity['currency']} as the exchange suffix suggested."
                    if identity.get("currencyEvidence") != "curated_reference" and identity.get("currency") and raw["currency"] != identity["currency"] else None)
            return {"currency": raw["currency"], "unitScale": raw["unitScale"], "verified": True, "evidence": "provider_quote", "note": note}
        if listing and listing.get("currency"):
            return {"currency": listing["currency"], "unitScale": listing["unitScale"], "verified": True, "evidence": "provider_listing", "note": None}
        if identity.get("currencyEvidence") == "curated_reference":
            return {"currency": identity["currency"], "unitScale": identity["unitScale"], "verified": True, "evidence": "curated_reference", "note": None}
        if pid in ("finnhub", "massive", "alpaca") and is_us_venue(identity.get("mic")):
            return {"currency": "USD", "unitScale": 1.0, "verified": True, "evidence": "provider_market", "note": None}
        return {"currency": identity.get("currency"), "unitScale": identity.get("unitScale", 1.0), "verified": False,
                "evidence": "venue_default_unconfirmed", "note": f"{name} did not state the currency."}

    def _price_gateway(self, identity: dict, use_cache: bool, cancelled: Callable[[], bool]) -> dict:
        """A quote from Yahoo Finance through the site's gateway, in the md.quote.v1 contract."""
        try:
            raw = self.gateway.quote(identity, use_cache, cancelled)
        except DataError as error:
            error.instrument = error.instrument or identity.get("canonicalId")
            raise
        cur = self._settle_currency(GATEWAY_ID, identity, raw, None)
        price = float(f"{raw['rawPrice'] * cur['unitScale']:.12g}")
        if not price > 0:
            raise DataError(f"Yahoo Finance returned an invalid price for {identity['displayTicker']}.", kind="invalid", provider=GATEWAY_NAME)
        local = raw.get("cacheAgeS") is not None
        gw = raw["gatewayCache"]
        return {
            "schema": QUOTE_SCHEMA, "canonicalId": identity["canonicalId"], "displayTicker": identity["displayTicker"],
            "provider": GATEWAY_NAME, "providerId": GATEWAY_ID, "sourceTier": "free", "via": GATEWAY_VIA, "providerSymbol": raw["symbol"],
            "nativePriceMajorUnits": price, "nativeCurrency": cur["currency"], "quoteUnit": "major" if cur["unitScale"] == 1 else "minor",
            "rawPrice": raw["rawPrice"], "rawCurrency": raw["rawCurrency"], "priceType": raw["priceType"], "tradingDate": raw["tradingDate"],
            "asOf": raw["asOf"], "delayMinutes": None, "adjusted": False, "retrievedAt": raw["retrievedAt"],
            "cacheStatus": "cached" if local else ("gateway_cache" if gw["status"] == "hit" else "live"),
            "cachedAgeS": raw["cacheAgeS"] if local else (gw["ageSeconds"] if gw["status"] == "hit" else 0),
            "attribution": raw.get("attribution") or f"Data from {GATEWAY_NAME} through {GATEWAY_VIA}.", "entitlement": "free", "feed": None,
            "currencyVerified": cur["verified"], "currencyEvidence": cur["evidence"], "notes": [n for n in (cur["note"], raw.get("delayNote")) if n],
        }

    def price_with(self, pid: str, identity: dict, use_cache: bool = True, cancelled: Callable[[], bool] = lambda: False) -> dict:
        if pid == GATEWAY_ID:
            return self._price_gateway(identity, use_cache, cancelled)
        name = PROVIDERS[pid]["name"]
        s = self._session(pid)
        if not s:
            raise DataError(f"No {name} key is saved.", kind="not_configured", provider=name)
        symbol = PROVIDERS[pid]["symbolFor"](identity, s.plan)
        if not symbol:
            raise DataError(f"{name} has no symbol for {identity['displayTicker']}.", kind="not_covered", definitive=True, provider=name)
        cache_key = f"{identity['canonicalId']}|{symbol}"
        miss = s.misses.get(cache_key)
        if use_cache and miss and self.now() - miss[0] < 3600:
            raise DataError(miss[1]["message"], kind=miss[1]["kind"], definitive=True, provider=name)
        hit = s.quotes.get(cache_key)
        if use_cache and hit and self.now() - hit[0] <= QUOTE_FRESH_S.get(hit[1]["priceType"], 600):
            return {**hit[1], "cacheStatus": "cached"}
        if pid != "alphavantage" and s.usage.limit:
            raise self._limit_error(s)
        try:
            listing = None
            if pid == "alphavantage":
                if s.usage.limit:
                    raise self._limit_error(s)
                if identity.get("currencyEvidence") != "curated_reference":
                    listing = self._av_listing(s, symbol, cancelled)
                    if not listing:
                        raise DataError(f"Alpha Vantage's symbol search does not list {symbol}.", kind="not_found", definitive=True, provider=name)
                price, day = av.parse_global_quote(self._av_call(s, {"function": "GLOBAL_QUOTE", "symbol": symbol}, identity["displayTicker"], cancelled), identity["displayTicker"])
                raw = {"rawPrice": price, "rawCurrency": None, "currency": None, "unitScale": 1.0, "tradingDate": day, "asOf": None, "priceType": "latest_trading_day"}
            else:
                adapter = ADAPTERS[pid]
                url, headers = adapter.request(symbol, s.key, secret=s.secret or "", feed=s.plan.get("feed") or "iex")
                for attempt in range(4):
                    status, text = self._send(s, url, headers, cancelled)
                    try:
                        if status != 200:
                            raise adapter.classify(status, text)
                        raw = adapter.parse(text, symbol, identity)
                        break
                    except DataError as error:
                        self._redact(s, error)
                        if error.kind == "rate_limited" and error.quota_scope in ("burst", "minute", "unknown") and attempt < 3:
                            self.sleep(max((error.retry_after_ms or 0) / 1000, (2.0, 5.0, 10.0)[attempt]))
                            continue
                        if error.kind == "auth":
                            s.rejected = True
                        if error.kind == "rate_limited" and error.quota_scope in ("daily", "monthly"):
                            s.usage.mark_limit(error.quota_scope, error.notice)
                        raise
            if s.retired:
                raise DataError("Your API key changed while this request was running; nothing from it was used.", kind="key_changed", provider=name)
            if raw.get("currency") is None and raw.get("rawCurrency"):
                raw["currency"], raw["unitScale"], _ = normalize_currency(raw["rawCurrency"])
            cur = self._settle_currency(pid, identity, raw, listing)
            quote = {
                "schema": QUOTE_SCHEMA, "canonicalId": identity["canonicalId"], "displayTicker": identity["displayTicker"],
                "provider": name, "providerId": pid, "providerSymbol": symbol,
                "nativePriceMajorUnits": raw["rawPrice"] * cur["unitScale"], "nativeCurrency": cur["currency"],
                "quoteUnit": "major" if cur["unitScale"] == 1 else "minor", "rawPrice": raw["rawPrice"],
                "rawCurrency": raw.get("rawCurrency") or (listing or {}).get("rawCurrency"), "priceType": raw["priceType"],
                "tradingDate": raw["tradingDate"], "asOf": raw.get("asOf"), "delayMinutes": None, "adjusted": False,
                "retrievedAt": dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                "cacheStatus": "live", "attribution": f"Data from {name} with your own key.", "entitlement": s.plan["id"],
                "feed": s.plan.get("feed"), "currencyVerified": cur["verified"], "currencyEvidence": cur["evidence"],
                "notes": [cur["note"]] if cur["note"] else [],
            }
            if not quote["nativePriceMajorUnits"] > 0:
                raise DataError(f"{name} returned an invalid price for {symbol}.", kind="invalid", provider=name)
            s.quotes[cache_key] = (self.now(), quote)
            return quote
        except DataError as error:
            if error.definitive and error.kind in ("not_found", "ambiguous", "currency_mismatch"):
                s.misses[cache_key] = (self.now(), {"message": error.message, "kind": error.kind})
            error.instrument = error.instrument or identity["canonicalId"]
            raise

    def try_sources(self, identity: dict, op: str, plan: dict, run: Callable[[dict], object], label: str) -> tuple[object, list[dict], str]:
        """Runs `run(candidate)` for each candidate in order; returns (value, attempts, used id) or
        raises one DataError listing every source's reason (same rules and text as the web)."""
        attempts: list[dict] = []
        for c in plan["candidates"]:
            try:
                return run(c), attempts, c["id"]
            except DataError as error:
                if error.kind in ("aborted", "key_changed"):
                    raise
                attempts.append({"provider": src.source_name(c["id"]), "providerId": c["id"], "kind": error.kind, "quotaScope": error.quota_scope,
                                 "message": error.message, "paused": bool(getattr(error, "paused", False))})
                if error.kind not in FALLBACK_KINDS:
                    error.attempts, error.skipped = attempts, plan["skipped"]
                    raise
        reasons = [f"{a['provider']}: {src.short_failure(a)}" for a in attempts] + src.describe_skipped(plan["skipped"], short=True)
        any_available = self.has_price_source(op)
        kinds = [a["kind"] for a in attempts]
        if not plan["candidates"]:
            kind = "not_covered" if any_available or any(x["code"] == "not_covered" for x in plan["skipped"]) else "not_configured"
        elif "auth" in kinds:
            kind = "auth"
        elif "rate_limited" in kinds:
            kind = "rate_limited"
        elif all(k in ("not_found", "not_covered") for k in kinds):
            kind = "not_found"
        else:
            kind = kinds[-1] if kinds else "unavailable"
        head = "No source in your list could give" if plan["candidates"] else "No source in your list can give"
        error = DataError(f"{head} {label}{' (' + '; '.join(reasons) + ')' if reasons else ''}.", kind=kind,
                          definitive=not plan["candidates"] or all(k in ("not_found", "not_covered", "ambiguous", "currency_mismatch") for k in kinds),
                          instrument=identity.get("canonicalId"), quota_scope=next((a["quotaScope"] for a in attempts if a["kind"] == "rate_limited"), None),
                          provider=attempts[0]["provider"] if len(attempts) == 1 else None,
                          hint="Use your own price, or add or reorder sources." if plan["candidates"] else
                          "Add a source that covers this market, or use your own price." if any_available else "Switch on Yahoo Finance or add your own key, or use your own price.")
        error.attempts, error.skipped = attempts, plan["skipped"]
        raise error

    def describe_order(self) -> str:
        """The list in order, as words, at this moment: stored with what it was used for,
        because a later reorder must not rewrite the record of an earlier request."""
        return "; ".join(f"{x['position']}. {x['name']}{'' if x['enabled'] else ' (off)'}" for x in self.sources_list())

    def price_instrument(self, identity: dict, use_cache: bool = True, cancelled: Callable[[], bool] = lambda: False) -> dict:
        """Latest price from the first source in the list that can give a usable one."""
        if not identity or identity.get("status") != "resolved":
            raise DataError((identity or {}).get("reason") or "The ticker is not resolved.", kind="invalid", definitive=True)
        plan = self.route(identity, "quote")
        source_order = self.describe_order()
        quote, attempts, _used = self.try_sources(identity, "quote", plan, lambda c: self.price_with(c["id"], identity, use_cache, cancelled), "a usable price")
        skipped = [x for x in plan["skipped"] if x["code"] != "off"]
        return {**quote, "sourceOrder": source_order, **({"fallbackFrom": attempts} if attempts else {}), **({"skippedSources": skipped} if skipped else {})}

    def check_again(self, pid: str) -> dict:
        s = self._session(pid)
        if not s:
            return {"ok": False, "message": f"No {PROVIDERS[pid]['name']} key is saved."}
        try:
            if pid == "alphavantage":
                self._av_call(s, {"function": "GLOBAL_QUOTE", "symbol": "IBM"}, "IBM", lambda: False, probe=True)
            else:
                s.usage.clear_limit()
                s.rejected = False
                self.price_with(pid, self.resolve("AAPL"), use_cache=False)
            return {"ok": True, "message": f"{PROVIDERS[pid]['name']} answered normally."}
        except DataError as error:
            return {"ok": False, "message": error.message, "notice": error.notice, "kind": error.kind, "quotaScope": error.quota_scope}

    def latest_fx(self, codes: list[str]) -> dict:
        def get(url: str, headers: dict) -> tuple[int, str]:
            return self.http(url, headers)
        return latest_cad_rates(codes, get)

    def status(self, pid: str) -> dict:
        p = PROVIDERS[pid]
        out = {"id": pid, "name": p["name"], "status": p["status"][self.platform], "available": provider_available(pid, self.platform),
               "reason": None if provider_available(pid, self.platform) else p.get("unsupportedReason"),
               "configured": pid in self.keys, "persistence": self.keys.get(pid, {}).get("persistence", ""), "plan": self.plan_for(pid)}
        if pid in self.keys:
            out.update(self.budget(pid))
        return out
