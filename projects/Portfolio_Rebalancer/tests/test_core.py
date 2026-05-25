"""Unit tests for the rebalancing core — proves the three invariants."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio_rebalancer.core import calculate_rebalance_plan


def _pos(ticker, shares, price, target, fx=1.0, account_type=""):
    return {
        "ticker": ticker,
        "shares": shares,
        "price": price,
        "currencyKey": "USD",
        "currencyLabel": "USD",
        "targetWeight": target,
        "fxToReporting": fx,
        "currentValue": shares * price * fx,
        "accountType": account_type,
    }


def test_new_money_budget_cap():
    """Invariant 1: total buys <= budget in new_money mode."""
    positions = [_pos("A", 10, 100, 50), _pos("B", 10, 100, 50)]
    budget = 100.0
    summary, results, warnings = calculate_rebalance_plan(positions, "new_money", budget)
    total_buys = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    assert total_buys <= budget + 0.02, f"Buys {total_buys} exceeded budget {budget}"


def test_new_money_scaling_warning():
    """Invariant 1: a warning is emitted when buys are scaled down."""
    positions = [_pos("A", 10, 100, 50), _pos("B", 0, 100, 50)]
    budget = 50.0
    summary, results, warnings = calculate_rebalance_plan(positions, "new_money", budget)
    total_buys = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    assert total_buys <= budget + 0.02, f"Buys {total_buys} exceeded budget {budget}"
    assert any("scaled down" in w.lower() for w in warnings), f"Expected scaling warning, got: {warnings}"


def test_rebalance_sell_funds_buys():
    """Invariant 2: total buys <= total sells in rebalance mode."""
    positions = [_pos("A", 100, 10, 10), _pos("B", 10, 10, 90)]
    summary, results, warnings = calculate_rebalance_plan(positions, "rebalance")
    total_buys = sum(r["tradeValue"] for r in results if r["action"] == "Buy")
    total_sells = sum(abs(r["tradeValue"]) for r in results if r["action"] == "Sell")
    assert total_buys <= total_sells + 0.02, f"Buys {total_buys} exceeded sells {total_sells}"


def test_cross_account_funding_warning():
    """Invariant 3: warns when cross-account funding is implied."""
    positions = [
        _pos("A", 100, 10, 10, account_type="TFSA"),
        _pos("B", 10, 10, 90, account_type="Margin"),
    ]
    summary, results, warnings = calculate_rebalance_plan(positions, "rebalance")
    assert any("Margin" in w for w in warnings), f"Expected cross-account warning, got: {warnings}"


def test_new_money_buy_only():
    """In new_money mode, no sell actions should appear."""
    positions = [_pos("A", 100, 10, 10), _pos("B", 10, 10, 90)]
    summary, results, warnings = calculate_rebalance_plan(positions, "new_money", 500.0)
    sells = [r for r in results if r["action"] == "Sell"]
    assert len(sells) == 0, f"Expected no sells, got {len(sells)}"


def test_rebalance_hold_small_delta():
    """Positions close to target should be Hold, not Buy/Sell."""
    positions = [_pos("A", 50, 100, 50), _pos("B", 50, 100, 50)]
    summary, results, warnings = calculate_rebalance_plan(positions, "rebalance")
    for r in results:
        assert r["action"] == "Hold", f"{r['ticker']} should be Hold, got {r['action']}"


def test_new_money_zero_budget_raises():
    """new_money mode with budget=0 should raise."""
    positions = [_pos("A", 10, 100, 100)]
    try:
        calculate_rebalance_plan(positions, "new_money", 0.0)
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


if __name__ == "__main__":
    test_new_money_budget_cap()
    test_new_money_scaling_warning()
    test_rebalance_sell_funds_buys()
    test_cross_account_funding_warning()
    test_new_money_buy_only()
    test_rebalance_hold_small_delta()
    test_new_money_zero_budget_raises()
    print("All tests passed.")
