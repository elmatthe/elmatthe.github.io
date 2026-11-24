"""The ordered market-data source list; mirrors assets/js/market-data/sources.js.

One list of price sources in the order they are tried, the same in both desktop apps
and on the website. Rules (identical to the web; _tools/tests/test_market_data_parity.py
compares every function's output, including message text):

* Yahoo Finance (through the site's data gateway) needs no key. In a fresh list it is
  the only source switched on, at position 1.
* A personal-key provider joins the list switched off. Saving a NEW key switches it on
  at the position it already has (by default below Yahoo Finance): saving a key never
  moves a provider to the top. The user may then reorder freely.
* Removing a key switches that provider off but keeps its position. If nothing else
  would be on, Yahoo Finance is switched back on, and the change is explained.
* A source is asked only for operations it has on this platform, only for listings it
  covers, and never while it is unavailable (no key, key rejected, a daily or monthly
  limit reached, or paused after a rate limit).
* Deferred or unsupported providers (Massive; Alpaca on the website) never appear.
"""
from __future__ import annotations

from .catalog import PROVIDER_IDS, PROVIDERS, coverage_gap as provider_gap, plan_of, provider_available
from .gateway import gateway_symbol

SOURCES_VERSION = "2026-11-04.1"
YAHOO_ID = "yahoo"
OPERATIONS = ("quote", "history")

SOURCE_INFO = {
    "yahoo": {
        "id": "yahoo", "name": "Yahoo Finance", "needsKey": False,
        "ops": {"browser": ["quote", "history"], "desktop": ["quote", "history"]},
        "labels": {"quote": "Latest prices", "history": "Daily history up to 5 years (close and adjusted close)"},
        "summary": "No key needed. Retrieved through this site's data gateway and briefly cached; quotes may be delayed.",
    },
    "alphavantage": {
        "id": "alphavantage", "name": "Alpha Vantage", "needsKey": True,
        "ops": {"browser": ["quote", "history"], "desktop": ["quote", "history"]},
        "labels": {"quote": "Latest prices", "history": "Daily closes as traded (up to about 4 months), weekly adjusted closes beyond"},
        "summary": "Your own key. 25 requests per day on the free plan.",
    },
    "marketstack": {
        "id": "marketstack", "name": "Marketstack", "needsKey": True,
        "ops": {"browser": ["quote"], "desktop": ["quote", "history"]},
        "labels": {"quote": "End-of-day prices", "history": "Daily close and adjusted close"},
        "summary": "Your own key. 100 requests per month on the free plan.",
    },
    "finnhub": {
        "id": "finnhub", "name": "Finnhub", "needsKey": True,
        "ops": {"browser": ["quote"], "desktop": ["quote"]},
        "labels": {"quote": "Latest prices (US listings on the free plan)"},
        "summary": "Your own key. 60 requests per minute on the free plan.",
    },
    "alpaca": {
        "id": "alpaca", "name": "Alpaca", "needsKey": True,
        "ops": {"browser": [], "desktop": ["quote", "history"]},
        "labels": {"quote": "Latest trades (US listings; IEX exchange on the free plan)", "history": "Daily bars (raw and adjusted)"},
        "summary": "Your own key ID and secret (desktop apps only).",
    },
}

DEFAULT_ORDER = ["yahoo", "alphavantage", "marketstack", "finnhub", "alpaca"]


def source_name(pid: str) -> str:
    info = SOURCE_INFO.get(pid) or PROVIDERS.get(pid) or {}
    return info.get("name") or str(pid)


def needs_key(pid: str) -> bool:
    return bool(SOURCE_INFO.get(pid, {}).get("needsKey"))


def capabilities(pid: str, platform: str = "desktop") -> list[str]:
    return list(SOURCE_INFO.get(pid, {}).get("ops", {}).get(platform, []))


def offered_sources(platform: str = "desktop") -> list[str]:
    known = DEFAULT_ORDER + [p for p in PROVIDER_IDS if p not in DEFAULT_ORDER]
    return [p for p in known if p in SOURCE_INFO and (p == YAHOO_ID or provider_available(p, platform)) and capabilities(p, platform)]


def _ensure_something_on(priority: dict, configured: list[str], notes: list[str]) -> None:
    usable = [p for p in priority["order"] if priority["enabled"].get(p) and (not needs_key(p) or p in configured)]
    if not usable and priority["enabled"].get(YAHOO_ID) is False:
        priority["enabled"][YAHOO_ID] = True
        notes.append(f"{source_name(YAHOO_ID)} was switched back on because no other source in your list can be used.")


def normalize_priority(saved: dict | None, platform: str = "desktop", configured: list[str] | None = None) -> dict:
    """A clean list from whatever was saved (or nothing): {"order", "enabled", "notes"}."""
    configured = configured or []
    offered = offered_sources(platform)
    order: list[str] = []
    saved_order = saved.get("order") if isinstance(saved, dict) else None
    for pid in saved_order if isinstance(saved_order, list) else []:
        if pid in offered and pid not in order:
            order.append(pid)
    for pid in offered:
        if pid not in order:
            order.append(pid)
    saved_enabled = saved.get("enabled") if isinstance(saved, dict) and isinstance(saved.get("enabled"), dict) else {}
    enabled = {p: saved_enabled[p] if isinstance(saved_enabled.get(p), bool) else p == YAHOO_ID for p in order}
    notes: list[str] = []
    result = {"order": order, "enabled": enabled}
    _ensure_something_on(result, configured, notes)
    return {**result, "notes": notes}


def migrate_legacy(prefs: dict | None, platform: str = "desktop", configured: list[str] | None = None) -> dict:
    """The previous {"routing", "fallback"} settings as a list (the earlier choice survives)."""
    configured = configured or []
    offered = offered_sources(platform)
    keyed = [p for p in ("finnhub", "alphavantage", "marketstack", "alpaca") if p in offered and p in configured]
    routing = prefs.get("routing") if isinstance(prefs, dict) and isinstance(prefs.get("routing"), str) else "auto"
    fallback = isinstance(prefs, dict) and prefs.get("fallback") is True
    enabled: dict[str, bool] = {}
    if routing == "keyless":
        order = [YAHOO_ID, *keyed]
        for p in keyed:
            enabled[p] = fallback
        enabled[YAHOO_ID] = True
    elif routing in offered and routing != YAHOO_ID and routing in configured:
        order = [routing, *[p for p in keyed if p != routing], YAHOO_ID]
        enabled[routing] = True
        for p in keyed:
            if p != routing:
                enabled[p] = fallback
        enabled[YAHOO_ID] = fallback
    else:
        order = [*keyed, YAHOO_ID] if keyed else [YAHOO_ID]
        for p in keyed:
            enabled[p] = True
        enabled[YAHOO_ID] = True
    return normalize_priority({"order": order, "enabled": enabled}, platform, configured)


def move_source(priority: dict, pid: str, to_index: int) -> dict:
    order = [p for p in priority["order"] if p != pid]
    if len(order) == len(priority["order"]):
        return {**priority, "order": list(priority["order"])}
    try:
        at = int(to_index)
    except (TypeError, ValueError):
        at = 0
    at = max(0, min(len(order), at))
    order.insert(at, pid)
    return {**priority, "order": order, "enabled": dict(priority["enabled"])}


def set_source_enabled(priority: dict, pid: str, on: bool, configured: list[str] | None = None) -> dict:
    """{"priority", "changed", "note"}; a provider without a key cannot be switched on and the
    last usable source cannot be switched off."""
    configured = configured or []
    nxt = {**priority, "order": list(priority["order"]), "enabled": dict(priority["enabled"])}
    if pid not in nxt["order"]:
        return {"priority": nxt, "changed": False, "note": f"{source_name(pid)} is not offered here."}
    if on and needs_key(pid) and pid not in configured:
        return {"priority": nxt, "changed": False, "note": f"Add your {source_name(pid)} key first; it is then switched on."}
    if not on:
        others = [p for p in nxt["order"] if p != pid and nxt["enabled"].get(p) and (not needs_key(p) or p in configured)]
        if not others:
            return {"priority": nxt, "changed": False, "note": f"{source_name(pid)} stays on: it is the only source in your list that can be used. Add a key for another source first."}
    changed = nxt["enabled"].get(pid) != bool(on)
    nxt["enabled"][pid] = bool(on)
    return {"priority": nxt, "changed": changed, "note": None}


def key_changed(priority: dict, pid: str, has_key: bool, is_new: bool = False, configured: list[str] | None = None) -> dict:
    """After a key is saved or removed: {"priority", "note"}."""
    configured = configured or []
    nxt = {**priority, "order": list(priority["order"]), "enabled": dict(priority["enabled"])}
    if pid not in nxt["order"]:
        return {"priority": nxt, "note": None}
    position = nxt["order"].index(pid) + 1
    name = source_name(pid)
    if has_key and is_new:
        nxt["enabled"][pid] = True
        above = [source_name(p) for p in nxt["order"][:position - 1] if nxt["enabled"].get(p)]
        tail = f", after {', '.join(above)}" if above else ""
        return {"priority": nxt, "note": f"{name} is switched on at position {position} of {len(nxt['order'])}{tail}. Move it up or down to change when it is tried."}
    if not has_key:
        nxt["enabled"][pid] = False
        notes = [f"{name} is switched off because its key was removed; it keeps position {position}, so your order is unchanged if you add a key again."]
        _ensure_something_on(nxt, [p for p in configured if p != pid], notes)
        return {"priority": nxt, "note": " ".join(notes)}
    return {"priority": nxt, "note": None}


def coverage_gap(pid: str, identity: dict | None, plans: dict | None = None) -> str | None:
    plans = plans or {}
    if not identity or identity.get("status") != "resolved":
        return "the ticker is not resolved"
    if pid == YAHOO_ID:
        return None if gateway_symbol(identity) else f"does not cover {identity.get('venueName') or identity.get('mic')}"
    gap = provider_gap(pid, identity, plans.get(pid) or plan_of(pid))
    if not gap:
        return None
    prefix = f"{PROVIDERS[pid]['name']} "
    return gap[len(prefix):] if gap.startswith(prefix) else gap


def symbol_for(pid: str, identity: dict, plans: dict | None = None) -> str | None:
    plans = plans or {}
    if pid == YAHOO_ID:
        return gateway_symbol(identity)
    provider = PROVIDERS.get(pid)
    return provider["symbolFor"](identity, plans.get(pid) or plan_of(pid)) if provider else None


OP_GAP = {"quote": "does not provide latest prices here", "history": "provides latest prices only, not price history"}


def plan_sources(identity: dict | None, op: str, priority: dict, platform: str = "desktop", state: dict | None = None,
                 plans: dict | None = None, require=None) -> dict:
    """{"candidates": [{"id", "symbol"}], "skipped": [{"id", "code", "reason"(, "short")}]} in list order."""
    state = state or {}
    candidates: list[dict] = []
    skipped: list[dict] = []
    offered = offered_sources(platform)
    for pid in priority["order"]:
        if pid not in offered:
            continue
        if not priority["enabled"].get(pid):
            skipped.append({"id": pid, "code": "off", "reason": "switched off in your source list"})
            continue
        if op not in capabilities(pid, platform):
            skipped.append({"id": pid, "code": "no_capability", "reason": OP_GAP.get(op, f"does not provide {op}")})
            continue
        # Coverage first: "does not cover this exchange" is a lasting reason, availability a passing one.
        gap = coverage_gap(pid, identity, plans)
        if gap:
            skipped.append({"id": pid, "code": "not_covered", "reason": gap})
            continue
        st = state.get(pid)
        if st and st.get("available") is False:
            reason = st.get("reason") or "not available right now"
            skipped.append({"id": pid, "code": st.get("code") or "unavailable", "reason": reason, "short": st.get("short") or reason})
            continue
        extra = require(pid) if require else None
        if extra:
            skipped.append({"id": pid, "code": "incompatible", "reason": extra})
            continue
        candidates.append({"id": pid, "symbol": symbol_for(pid, identity, plans)})
    return {"candidates": candidates, "skipped": skipped}


def describe_skipped(skipped: list[dict], include_off: bool = False, short: bool = False) -> list[str]:
    return [f"{source_name(s['id'])}: {(s.get('short') or s['reason']) if short else s['reason']}" for s in skipped if include_off or s["code"] != "off"]


def short_failure(a: dict) -> str:
    """A short, listing-independent phrase for a failed attempt."""
    kind = a.get("kind")
    if kind == "auth":
        return "rejected the key"
    if kind == "rate_limited":
        scope = a.get("quotaScope")
        if scope in ("daily", "monthly"):
            return f"{scope} limit reached"
        return "paused after a rate limit" if a.get("paused") else "rate-limited"
    if a.get("paused"):
        return "paused after an outage"
    return {"not_found": "has no data for this listing", "not_covered": "does not cover this listing", "ambiguous": "answered for a different listing",
            "currency_mismatch": "could not confirm the currency", "invalid": "returned data that failed its checks", "timeout": "did not answer in time",
            "network": "could not be reached", "unavailable": "unavailable", "entitlement": "not included in your plan", "not_configured": "not available"}.get(kind, "failed")
