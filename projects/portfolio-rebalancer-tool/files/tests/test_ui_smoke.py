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
    md = MarketData(None, http=FakeProviders(), sleep=lambda s: None, pacing_override_ms=0, now=lambda: 1793718000.0, gateway_url="")
    md.set_key("alphavantage", AV_KEY)
    md.set_key("finnhub", FH_KEY)
    md.move_source("finnhub", 1)
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
    labels = [w.cget("text") for w in app.root.winfo_children()[0].winfo_children() if isinstance(w, tk.ttk.Button)]
    assert not hasattr(app, "_remove_international") and not any("international" in str(t).lower() for t in labels)
    assert "Sources, in the order tried: 1. Yahoo Finance (unavailable) · 2. Finnhub · 3. Alpha Vantage · 4. Marketstack (off) · 5. Alpaca (off)" in app.sources_line.cget("text")
    # The source editor: keyboard move, switch on/off, persisted through MarketData.
    app._sources_dialog()
    pump(root, 0.3)
    dialog = app.sources_window
    assert [dialog.tree.item(i)["values"][1] for i in dialog.tree.get_children()] == ["Yahoo Finance", "Finnhub", "Alpha Vantage", "Marketstack", "Alpaca"]
    dialog.tree.selection_set("alphavantage")
    dialog.tree.focus("alphavantage")
    dialog.tree.event_generate("<Alt-Up>")
    pump(root, 0.2)
    assert md.priority["order"][:3] == ["yahoo", "alphavantage", "finnhub"] and "Alpha Vantage moved to position 2 of 5." in dialog.live.cget("text")
    assert "Needs your API key" in dialog.tree.item("marketstack")["values"][2] and str(dialog.toggle.cget("state")) == "normal"
    dialog.tree.selection_set("marketstack")
    pump(root, 0.1)
    assert str(dialog.toggle.cget("state")) == "disabled", "a provider without a key cannot be switched on"
    dialog.top.destroy()
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
