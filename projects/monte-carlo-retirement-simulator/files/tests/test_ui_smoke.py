"""The Tk window end to end (needs a display; skipped without one).

On Linux CI it runs under Xvfb; on Windows and macOS it runs on the desktop. It checks
the spending-basis conversion note, a seeded run that writes the workbook, that warnings
stay visible after "Done", and the safe new-workbook choice. It does not replace the
manual Windows check at 125% and 150% display scaling.
"""
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

tk = pytest.importorskip("tkinter")
pytest.importorskip("openpyxl")
pytest.importorskip("matplotlib")
if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
    pytest.skip("no display (run under xvfb-run)", allow_module_level=True)

from monte_carlo.ui import MonteCarloApp  # noqa: E402

VALUES = dict(currentPortfolio="150000", annualContribution="10000", yearsToRetirement="30", yearsInRetirement="25",
              annualSpending="60000", pensionIncome="18000", simulations="300", seed="11")


def pump(root, seconds=3.0, until=None):
    end = time.time() + seconds
    while time.time() < end:
        root.update()
        if until and until():
            return True
        time.sleep(0.02)
    return False


def fill(app, **values):
    for key, value in values.items():
        entry = app.entries[key]
        entry.delete(0, "end")
        entry.insert(0, value)
    app._refresh_notes()


def test_window_runs_seeded_simulation_and_keeps_warnings(tmp_path):
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"no display: {error}")
    asked = []
    app = MonteCarloApp(root, ask=lambda title, message: asked.append(message) or True)
    pump(root, 0.3)
    fill(app, **VALUES)
    assert "$42,000 in first-retirement-year dollars" in app.conversion_var.get()
    app.basis_var.set("Today's dollars (converted with inflation)")
    app._refresh_notes()
    assert "$42,000 in today's dollars = $88,098" in app.conversion_var.get()
    assert "6.33% a year" in app.growth_var.get()

    app.workbook_path_var.set(str(tmp_path / "report.xlsx"))
    fill(app, volatility="45")
    app._on_run_clicked()
    assert pump(root, 30, until=lambda: not app.is_running and app.last_result is not None)
    status = app.status_var.get()
    assert status.startswith("Done. 300 simulations complete (seed 11). Workbook updated.") and "warnings below" in status
    assert "Volatility above 30%" in app.warnings_var.get()
    assert "Probability of success" in app.results_var.get()
    assert (tmp_path / "report.xlsx").exists() and asked == []

    # A workbook with a picture on another sheet is not modified: the report goes to a new file.
    import openpyxl
    from openpyxl.drawing.image import Image
    from PIL import Image as PILImage
    png = tmp_path / "p.png"
    PILImage.new("RGB", (8, 8)).save(png)
    wb = openpyxl.Workbook()
    wb.active.title = "Plan"
    wb.active.add_image(Image(str(png)), "B2")
    rich = tmp_path / "mine.xlsx"
    wb.save(rich)
    before = rich.read_bytes()
    app.workbook_path_var.set(str(rich))
    fill(app, volatility="12")
    app._on_run_clicked()
    assert pump(root, 30, until=lambda: not app.is_running and app.last_path is not None and app.last_path.name.startswith("mine ("))
    assert asked and "pictures, shapes" in asked[0]
    assert rich.read_bytes() == before
    assert app.last_path.name == "mine (Monte Carlo report).xlsx"
    assert "Saved as mine (Monte Carlo report).xlsx" in app.status_var.get()
    assert app.warnings_var.get() == ""

    # An unreadable target (here a folder named like a workbook; an Excel lock behaves the
    # same) is reported; Run no longer fails silently inside the Tk callback.
    shown = []
    import monte_carlo.ui as ui_module
    original = ui_module.messagebox.showerror
    ui_module.messagebox.showerror = lambda title, message: shown.append(message)
    try:
        folder = tmp_path / "folder.xlsx"
        folder.mkdir()
        app.workbook_path_var.set(str(folder))
        app.last_path = None
        app._on_run_clicked()
    finally:
        ui_module.messagebox.showerror = original
    assert not app.is_running and app.last_path is None and folder.is_dir()
    assert shown and "cannot be opened" in shown[0]
    assert app.status_var.get().startswith("Error: The selected workbook cannot be opened")

    # Fits a 1366x768 screen.
    root.update_idletasks()
    assert root.winfo_reqheight() <= 740 and root.winfo_reqwidth() <= 1366
    root.destroy()
