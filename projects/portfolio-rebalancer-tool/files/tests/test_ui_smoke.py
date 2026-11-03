"""The Tk window end to end with mocked providers (needs a display; skipped without one).

On Linux CI it runs under Xvfb; on Windows and macOS it runs on the desktop. It
proves the workflow (sample, keys, Get prices, plan withheld, user-supplied price,
plan ready) and that the window fits a 1366x768 screen. It does not replace the
manual Windows check at 125% and 150% display scaling.
"""
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

tk = pytest.importorskip("tkinter")
if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
    pytest.skip("no display (run under xvfb-run)", allow_module_level=True)

from test_model import AV_KEY, FH_KEY, FakeProviders  # noqa: E402
from market_data.service import MarketData  # noqa: E402
from portfolio_rebalancer.ui import RebalancerApp  # noqa: E402


def pump(root, seconds=3.0, until=None):
    end = time.time() + seconds
    while time.time() < end:
        root.update()
        if until and until():
            return True
        time.sleep(0.02)
    return False


def test_window_workflow():
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"no display: {error}")
    root.geometry("1366x768")
    md = MarketData(None, http=FakeProviders(), sleep=lambda s: None, pacing_override_ms=0, now=lambda: 1793718000.0)
    md.set_key("alphavantage", AV_KEY)
    md.set_key("finnhub", FH_KEY)
    app = RebalancerApp(root, market=md)
    pump(root, 0.5)
    app._load_sample()
    pump(root, 0.3)
    estimate = app.estimate.cget("text")
    assert "Get prices: about 8 Alpha Vantage requests" in estimate and "about 4 Finnhub requests" in estimate
    assert "YNVD.NE" in estimate and "Listings outside Canada and the US: 7203.T" in estimate
    assert len(app.rows) == 14 and all(r.active for r in app.rows)
    app._price_all()
    assert pump(root, 10, until=lambda: sum(1 for r in app.rows if r.effective()) == 12)
    assert pump(root, 3, until=lambda: "12 of 14 priced" in app.status.cget("text"))
    assert "YNVD.NE (not covered" in app.status.cget("text") and "7203.T (not covered" in app.status.cget("text")
    app._calculate()
    assert app.headline.cget("text") == "Plan withheld"
    app.rows[8].set_manual("44.21", "CAD")
    app.rows[10].set_manual("2850", "JPY")
    app._calculate()
    assert app.headline.cget("text").startswith("Plan includes 2 user-supplied price")
    assert len(app.tree.get_children()) == 14
    app._remove_international()
    pump(root, 0.3)
    # 7203.T has a price the user supplied, so it is a user holding now and stays.
    assert [r.ticker for r in app.rows][-2:] == ["VST", "7203.T"] and len(app.rows) == 11, [r.ticker for r in app.rows]
    app._calculate()
    first = app.tree.item(app.tree.get_children()[0])["values"]
    assert first[0] in ("BUY", "HOLD")
    app.tree.selection_set(app.tree.get_children()[0])
    pump(root, 0.3)
    assert "Price:" in app.details.get("1.0", "end")
    root.update_idletasks()
    # The window sizes itself to the screen (CI runs Xvfb at 1366x768): it must fit.
    assert root.winfo_width() <= root.winfo_screenwidth() and root.winfo_height() <= root.winfo_screenheight()
    shot = os.environ.get("RB_SCREENSHOT")
    if shot:
        pump(root, 0.5)
        os.system(f"import -window root {shot}")  # noqa: S605 - test artefact only
    app._close()
