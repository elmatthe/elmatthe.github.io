"""Pure rebalancing logic — two modes and three invariants.

No GUI imports. This module can be tested in isolation. It is kept identical to
the web app's assets/js/portfolio-rebalancer/engine.js (checked by
_tools/tests/test_engine_parity.py): same numbers, same warning text.

Valuation readiness (assess_valuation) decides whether a plan may be shown at all:
every holding that matters (shares > 0 or target > 0) needs a verified price in a
confirmed currency, or a price the user explicitly supplied. Holdings with 0 shares
and a 0% target are "not valued" and never block the plan.
"""
from __future__ import annotations

import math
import re
from typing import Callable

HOLD_THRESHOLD_PCT = 0.0001  # 0.01% of pool value
READINESS_SCHEMA = "md.valuation-readiness.v1"

_NUMBER = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")


def _plain_sum(values) -> float:
    """Left-to-right float addition, like JavaScript's reduce. (Python 3.12+ sum() uses
    compensated summation, which can differ from the web engine in the last bit.)"""
    total = 0.0
    for v in values:
        total += v
    return total


def _dollars(value: float) -> str:
    return f"${value:,.2f}"


def parse_number(value) -> float | None:
    """Same rule as engine.parseNumber: a finite plain decimal number, else None.

    Blank, whitespace, "nan", "inf", "1e999" and text are rejected rather than
    read as 0 (RB-02, RB-03).
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    text = str(value if value is not None else "").strip()
    if not text or not _NUMBER.match(text):
        return None
    number = float(text)
    return number if math.isfinite(number) else None


def weight_warnings(positions: list[dict]) -> list[str]:
    """Same text as engine.weightWarnings: says when targets do not add up to 100."""
    total = _plain_sum(p["targetWeight"] for p in positions)
    if not total > 0 or abs(total - 100) < 0.005:
        return []
    return [f"Target weights add up to {total:.2f}%, not 100%; each target is divided by "
            f"{total / 100:.4f} so that they add up to 100%."]


def calculate_rebalance_plan(
    positions: list[dict],
    mode: str,
    budget: float = 0.0,
    money: Callable[[float], str] | None = None,
) -> tuple[dict, list[dict], list[str]]:
    """Compute rebalance trades.

    Returns (summary, results, warnings). `money` formats reporting-currency amounts
    in warnings (US-dollar style by default, as in the web engine's default).
    """
    money = money or _dollars
    total_current = _plain_sum(p["currentValue"] for p in positions)
    total_weight = _plain_sum(p["targetWeight"] for p in positions)

    if mode == "new_money":
        if not budget > 0:
            raise ValueError("New money budget must be greater than 0.")
        pool = total_current + budget
    else:
        pool = total_current

    if not pool > 0:
        raise ValueError("Portfolio value must be greater than 0.")
    if not total_weight > 0:
        raise ValueError("At least one target weight must be greater than 0.")

    threshold = pool * HOLD_THRESHOLD_PCT
    warnings: list[str] = []

    results: list[dict] = []
    for p in positions:
        tw_norm = p["targetWeight"] / total_weight
        target_val = tw_norm * pool
        delta = target_val - p["currentValue"]

        if mode == "new_money" and delta <= 0:
            results.append(_hold_row(p, tw_norm, target_val))
            continue

        action = "Hold"
        if delta > threshold:
            action = "Buy"
        elif delta < -threshold:
            action = "Sell"

        if abs(delta) <= threshold:
            delta = 0.0

        tv_local = delta / p["fxToReporting"] if delta != 0 else 0.0
        t_shares = tv_local / p["price"] if delta != 0 else 0.0

        results.append({
            **_base_row(p, tw_norm, target_val),
            "tradeValue": delta,
            "tradeValueLocal": tv_local,
            "tradeShares": t_shares,
            "action": action,
            "postTradeShares": p["shares"] + t_shares,
        })

    total_buys = _plain_sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    total_sells = _plain_sum(abs(r["tradeValue"]) for r in results if r["action"] == "Sell")

    # Invariant 1: new-money budget cap
    if mode == "new_money" and total_buys > budget + 0.01 and total_buys > 0:
        scale = budget / total_buys
        _scale_buys(results, scale)
        scaled = _plain_sum(r["tradeValue"] for r in results if r["action"] == "Buy")
        warnings.append(
            f"Buy recommendations scaled down by {(1 - scale) * 100:.1f}% to stay "
            f"within the new-money budget of {money(budget)} "
            f"(raw need was {money(total_buys)}; scaled to {money(scaled)})."
        )
        total_buys = scaled

    # Invariant 2: rebalance self-funding. With no sell proceeds at all (every
    # overweight holding is inside the hold band) nothing can be bought (RB-01).
    if mode == "rebalance" and total_buys > total_sells + 0.01 and total_buys > 0:
        if total_sells > 0:
            scale = total_sells / total_buys
            _scale_buys(results, scale)
            scaled = _plain_sum(r["tradeValue"] for r in results if r["action"] == "Buy")
            warnings.append(
                f"Buy recommendations scaled down by {(1 - scale) * 100:.1f}% to stay "
                f"within sell proceeds of {money(total_sells)} "
                f"(raw need was {money(total_buys)}; scaled to {money(scaled)})."
            )
            total_buys = scaled
        else:
            _hold_buys(results)
            warnings.append(
                f"No sells are needed (every overweight holding is within the 0.01% hold band), "
                f"so the {money(total_buys)} of buys cannot be funded in Rebalance mode and are "
                f"shown as Hold. Use New Money mode to invest new cash."
            )
            total_buys = 0.0

    # Invariant 3: cross-account funding
    _check_cross_account(results, mode, warnings, money)

    if mode == "new_money":
        cash_left = max(0.0, budget - total_buys)
    else:
        cash_left = max(0.0, total_sells - total_buys)
    summary = {
        "totalCurrent": total_current,
        "pool": pool,
        "totalBuys": total_buys,
        "totalSells": total_sells,
        "mode": mode,
        "budget": budget if mode == "new_money" else 0.0,
        "cashLeft": cash_left,
    }
    return summary, results, warnings


def _base_row(p: dict, tw_norm: float, target_val: float) -> dict:
    return {
        "rowIndex": p.get("rowIndex", 0),
        "ticker": p["ticker"],
        "currencyKey": p["currencyKey"],
        "currencyLabel": p["currencyLabel"],
        "shares": p["shares"],
        "price": p["price"],
        "currentValue": p["currentValue"],
        "targetWeightNorm": tw_norm,
        "targetValue": target_val,
        "accountType": p.get("accountType", ""),
        "fxToReporting": p["fxToReporting"],
    }


def _hold_row(p: dict, tw_norm: float, target_val: float) -> dict:
    return {
        **_base_row(p, tw_norm, target_val),
        "tradeValue": 0.0,
        "tradeValueLocal": 0.0,
        "tradeShares": 0.0,
        "action": "Hold",
        "postTradeShares": p["shares"],
    }


def _scale_buys(results: list[dict], scale: float) -> None:
    """Scales every Buy; local values use the row's stored rate (no division by scale)."""
    for r in results:
        if r["action"] == "Buy":
            r["tradeValue"] *= scale
            fx = r["fxToReporting"]
            r["tradeValueLocal"] = r["tradeValue"] / fx if fx else 0.0
            r["tradeShares"] = r["tradeValueLocal"] / r["price"] if r["price"] else 0.0
            r["postTradeShares"] = r["shares"] + r["tradeShares"]


def _hold_buys(results: list[dict]) -> None:
    for r in results:
        if r["action"] == "Buy":
            r.update(action="Hold", tradeValue=0.0, tradeValueLocal=0.0, tradeShares=0.0, postTradeShares=r["shares"])


def _check_cross_account(results: list[dict], mode: str, warnings: list[str], money: Callable[[float], str]) -> None:
    has_types = any(r.get("accountType") for r in results)
    if not has_types:
        return

    if mode == "rebalance":
        sells_by: dict[str, float] = {}
        buys_by: dict[str, float] = {}
        for r in results:
            at = r.get("accountType") or "Unspecified"
            if r["action"] == "Sell":
                sells_by[at] = sells_by.get(at, 0.0) + abs(r["tradeValue"])
            elif r["action"] == "Buy":
                buys_by[at] = buys_by.get(at, 0.0) + r["tradeValue"]
        for at, buy_amt in buys_by.items():
            sell_amt = sells_by.get(at, 0.0)
            if buy_amt > sell_amt + 0.01:
                warnings.append(
                    f"{at}: recommended buys total {money(buy_amt)} but same-account "
                    f"sells only total {money(sell_amt)}. The gap of "
                    f"{money(buy_amt - sell_amt)} must come from existing cash or new "
                    f"contributions — proceeds from other account types cannot be "
                    f"transferred without triggering a withdrawal/contribution event."
                )

    ticker_accts: dict[str, set[str]] = {}
    for r in results:
        if r["action"] != "Hold" and r.get("accountType"):
            ticker_accts.setdefault(r["ticker"], set()).add(r["accountType"])
    for ticker, accts in ticker_accts.items():
        if len(accts) > 1:
            listed = ", ".join(sorted(accts))
            if mode == "rebalance":
                warnings.append(f"{ticker} appears in multiple account types ({listed}) "
                                f"— sells from one account can’t fund buys in another.")
            else:
                warnings.append(f"{ticker} is bought in multiple account types ({listed}) "
                                f"— make sure each account has the cash for its part.")


def apply_whole_shares(summary: dict, results: list[dict], max_steps: int = 100000) -> dict:
    """Whole-share alternative to a fractional plan (identical to engine.applyWholeShares).

    1. Sells and buys are rounded DOWN to whole shares.
    2. If buys then cost more than the cash available (the budget in New Money,
       whole-share sell proceeds in Rebalance), one share at a time is removed from
       the largest buy until they fit.
    3. Leftover cash buys one more share at a time of the Buy row furthest below its
       target, while a share fits.
    Returns {"results", "totalBuys", "totalSells", "cashLeft"}.
    """
    mode = summary["mode"]
    budget = summary["budget"]
    eps = 1e-9
    rows = []
    for r in results:
        unit = r["price"] * r["fxToReporting"]
        whole = 0
        if r["action"] == "Buy":
            whole = math.floor(r["tradeShares"] + eps)
        elif r["action"] == "Sell":
            whole = -min(math.floor(-r["tradeShares"] + eps), math.floor(r["shares"] + eps))
        rows.append({**r, "_unit": unit, "wholeShares": whole})

    def total(side: str) -> float:
        if side == "buy":
            return _plain_sum(x["wholeShares"] * x["_unit"] for x in rows if x["wholeShares"] > 0)
        return _plain_sum(-x["wholeShares"] * x["_unit"] for x in rows if x["wholeShares"] < 0)

    def available() -> float:
        return budget if mode == "new_money" else total("sell")

    steps = 0
    while total("buy") > available() + eps and steps < max_steps:
        buys = [x for x in rows if x["wholeShares"] > 0]
        if not buys:
            break
        largest = sorted(buys, key=lambda x: (-(x["wholeShares"] * x["_unit"]), x["rowIndex"]))[0]
        largest["wholeShares"] -= 1
        steps += 1
    while steps < max_steps:
        left = available() - total("buy")
        candidates = []
        for x in rows:
            if x["action"] == "Buy" and x["_unit"] <= left + eps:
                shortfall = x["targetValue"] - (x["currentValue"] + x["wholeShares"] * x["_unit"])
                if shortfall > eps:
                    candidates.append((shortfall, x))
        if not candidates:
            break
        candidates.sort(key=lambda c: (-c[0], c[1]["rowIndex"]))
        candidates[0][1]["wholeShares"] += 1
        steps += 1

    buys, sells, cash = total("buy"), total("sell"), max(0.0, available() - total("buy"))
    out = []
    for x in rows:
        unit = x.pop("_unit")
        w = x["wholeShares"]
        out.append({
            **x,
            "wholeAction": "Buy" if w > 0 else "Sell" if w < 0 else "Hold",
            "wholeTradeValueLocal": w * x["price"],
            "wholeTradeValue": w * unit,
            "wholePostTradeShares": x["shares"] + w,
        })
    return {"results": out, "totalBuys": buys, "totalSells": sells, "cashLeft": cash}


def assess_valuation(rows: list[dict], accept_stale: bool = False) -> dict:
    """Same rules and output as engine.assessValuation (md.valuation-readiness.v1)."""
    out = {"schema": READINESS_SCHEMA, "ready": False, "required": 0, "priced": [], "unpriced": [], "stale": [],
           "manualOverrides": [], "notValued": [], "fxMissing": [], "blockedReason": None}
    for row in rows:
        shares = parse_number(row.get("shares"))
        target = parse_number(row.get("targetWeight"))
        ref = {"rowId": row.get("rowId"), "ticker": row.get("ticker")}
        if shares == 0 and target == 0:
            out["notValued"].append({**ref, "reason": "0 shares and a 0% target: not part of the plan"})
            continue
        out["required"] += 1
        src = row.get("source") or {}
        price = parse_number(row.get("price"))
        reason = None
        if shares is None or target is None:
            reason = "shares and target must be numbers"
        elif not (price is not None and price > 0):
            reason = row.get("problem") or "no price yet"
        elif not row.get("currency"):
            reason = "quote currency unknown"
        elif src.get("kind") == "provider" and not src.get("currencyVerified"):
            reason = "the provider did not confirm the quote currency"
        elif src.get("kind") not in ("provider", "manual", "csv"):
            reason = "price source unknown"
        elif src.get("freshness") == "too_old":
            reason = f"price is too old ({src.get('tradingDate') or 'date unknown'})"
        elif not row.get("fxAvailable"):
            out["fxMissing"].append({**ref, "currency": row.get("currency")})
            reason = f"no exchange rate for {row.get('currency')}"
        if reason:
            out["unpriced"].append({**ref, "reason": reason})
            continue
        if src.get("kind") in ("manual", "csv"):
            out["manualOverrides"].append({**ref, "kind": src.get("kind")})
        if src.get("freshness") in ("stale", "unknown"):
            out["stale"].append({**ref, "tradingDate": src.get("tradingDate"), "freshness": src.get("freshness")})
        out["priced"].append(ref)
    required = out["required"]
    unpriced = len(out["unpriced"])
    stale = len(out["stale"])
    if not required:
        out["blockedReason"] = "Add at least one holding with shares or a target weight."
    elif unpriced:
        out["blockedReason"] = (f"{unpriced} of {required} holding{'' if required == 1 else 's'} "
                                f"{'has' if unpriced == 1 else 'have'} no usable price.")
    elif stale and not accept_stale:
        out["blockedReason"] = (f"{stale} price{' is' if stale == 1 else 's are'} older than the latest trading "
                                f"session. Review and accept them, or refresh.")
    out["ready"] = out["blockedReason"] is None
    return out
