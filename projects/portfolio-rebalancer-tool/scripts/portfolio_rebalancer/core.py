"""Pure rebalancing logic — two modes and three invariants.

No GUI imports. This module can be tested in isolation.
"""
from __future__ import annotations

HOLD_THRESHOLD_PCT = 0.0001  # 0.01% of pool value


def calculate_rebalance_plan(
    positions: list[dict],
    mode: str,
    budget: float = 0.0,
) -> tuple[dict, list[dict], list[str]]:
    """Compute rebalance trades.

    Returns (summary, results, warnings).
    """
    total_current = sum(p["currentValue"] for p in positions)
    total_weight = sum(p["targetWeight"] for p in positions)

    if mode == "new_money":
        if budget <= 0:
            raise ValueError("New money budget must be greater than 0.")
        pool = total_current + budget
    else:
        pool = total_current

    if pool <= 0:
        raise ValueError("Portfolio value must be greater than 0.")
    if total_weight <= 0:
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
            "ticker": p["ticker"],
            "currencyKey": p["currencyKey"],
            "currencyLabel": p["currencyLabel"],
            "shares": p["shares"],
            "price": p["price"],
            "currentValue": p["currentValue"],
            "targetWeightNorm": tw_norm,
            "targetValue": target_val,
            "tradeValue": delta,
            "tradeValueLocal": tv_local,
            "tradeShares": t_shares,
            "action": action,
            "postTradeShares": p["shares"] + t_shares,
            "accountType": p.get("accountType", ""),
        })

    total_buys = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    total_sells = sum(abs(r["tradeValue"]) for r in results if r["action"] == "Sell")

    # Invariant 1: new-money budget cap
    if mode == "new_money" and total_buys > budget + 0.01 and total_buys > 0:
        scale = budget / total_buys
        _scale_buys(results, scale)
        scaled = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
        warnings.append(
            f"Buy recommendations scaled down by {(1 - scale) * 100:.1f}% to stay "
            f"within the new-money budget of ${budget:,.2f} "
            f"(raw need was ${total_buys:,.2f}; scaled to ${scaled:,.2f})."
        )
        total_buys = scaled

    # Invariant 2: rebalance self-funding
    if mode == "rebalance" and total_buys > total_sells + 0.01 and total_buys > 0:
        scale = total_sells / total_buys
        _scale_buys(results, scale)
        scaled = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
        warnings.append(
            f"Buy recommendations scaled down by {(1 - scale) * 100:.1f}% to stay "
            f"within sell proceeds of ${total_sells:,.2f} "
            f"(raw need was ${total_buys:,.2f}; scaled to ${scaled:,.2f})."
        )
        total_buys = scaled

    # Invariant 3: cross-account funding
    _check_cross_account(results, mode, warnings)

    summary = {
        "totalCurrent": total_current,
        "pool": pool,
        "totalBuys": total_buys,
        "totalSells": total_sells,
        "mode": mode,
        "budget": budget if mode == "new_money" else 0.0,
    }
    return summary, results, warnings


def _hold_row(p: dict, tw_norm: float, target_val: float) -> dict:
    return {
        "ticker": p["ticker"],
        "currencyKey": p["currencyKey"],
        "currencyLabel": p["currencyLabel"],
        "shares": p["shares"],
        "price": p["price"],
        "currentValue": p["currentValue"],
        "targetWeightNorm": tw_norm,
        "targetValue": target_val,
        "tradeValue": 0.0,
        "tradeValueLocal": 0.0,
        "tradeShares": 0.0,
        "action": "Hold",
        "postTradeShares": p["shares"],
        "accountType": p.get("accountType", ""),
    }


def _scale_buys(results: list[dict], scale: float) -> None:
    for r in results:
        if r["action"] == "Buy":
            r["tradeValue"] *= scale
            fx = r.get("_fxToReporting")
            if fx is None:
                if r["tradeValueLocal"] != 0:
                    fx = r["tradeValue"] / scale / r["tradeValueLocal"]
                else:
                    fx = 1.0
            r["tradeValueLocal"] = r["tradeValue"] / fx if fx else 0.0
            r["tradeShares"] = r["tradeValueLocal"] / r["price"] if r["price"] else 0.0
            r["postTradeShares"] = r["shares"] + r["tradeShares"]


def _check_cross_account(results: list[dict], mode: str, warnings: list[str]) -> None:
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
                    f"{at}: recommended buys total ${buy_amt:,.2f} but same-account "
                    f"sells only total ${sell_amt:,.2f}. The gap of "
                    f"${buy_amt - sell_amt:,.2f} must come from existing cash or new "
                    f"contributions — proceeds from other account types cannot be "
                    f"transferred without triggering a withdrawal/contribution event."
                )

    ticker_accts: dict[str, set[str]] = {}
    for r in results:
        if r["action"] != "Hold" and r.get("accountType"):
            ticker_accts.setdefault(r["ticker"], set()).add(r["accountType"])
    for ticker, accts in ticker_accts.items():
        if len(accts) > 1:
            warnings.append(
                f"{ticker} appears in multiple account types ({', '.join(sorted(accts))}) "
                f"— sells from one account can't fund buys in another."
            )
