"""The Tk window with the download mocked (needs a display; skipped without one).

Checks that the download runs on a worker thread with progress, that the summary
reports merged months and the recalculation step, that Cancel stops cleanly, and that
the FRED key is saved only when "Remember" is ticked. Excel is never started.
"""
import os
import sys
import time
from types import SimpleNamespace

import pytest

tk = pytest.importorskip("tkinter")
if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
    pytest.skip("no display (run under xvfb-run)", allow_module_level=True)

import cpi_webscraper as app  # noqa: E402
import data_sources as ds  # noqa: E402


def pump(root, seconds, until):
    end = time.time() + seconds
    while time.time() < end:
        root.update()
        if until():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def window(monkeypatch):
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"no display: {error}")
    saved = []
    monkeypatch.setattr(app, "load_config", lambda: SimpleNamespace(api_key="", sheet_name="CPI_Downloader", add_missing_data=False))
    monkeypatch.setattr(app, "save_api_key", lambda key: saved.append(key))
    shown = []
    monkeypatch.setattr(app.messagebox, "showinfo", lambda title, msg: shown.append(msg))
    monkeypatch.setattr(app.messagebox, "showerror", lambda title, msg: shown.append("ERROR " + msg))
    ui = app.App(root)
    ui.year.insert(0, "2024")
    ui.month.insert(0, "1")
    ui.key.insert(0, "placeholder-key")
    ui.workbook.insert(0, "C:/models/CPI.xlsx")
    yield SimpleNamespace(root=root, ui=ui, saved=saved, shown=shown)
    root.destroy()


def test_download_runs_on_a_worker_and_reports_the_merge(window, monkeypatch):
    def fake_download(start, end, key, workbook, csv_path, replace, progress, cancel):
        for i in range(1, 4):
            progress(i, 3, "FRED GS10")
            time.sleep(0.05)
        return [{"date": None}], SimpleNamespace(sheet_name="CPI_Downloader"), {"kept": 1367, "updated": 1, "added": 0, "rows": 1368}
    monkeypatch.setattr(app, "download", fake_download)
    w = window
    w.ui.remember.set(False)
    w.ui.start()
    assert w.ui.button.cget("state") == "disabled" and w.ui.cancel_button.cget("state") == "normal"
    assert pump(w.root, 5, lambda: w.shown)
    assert "1 updated, 0 added, 1367 other months kept (1368 rows in total)" in w.shown[0]
    assert "Ctrl+Alt+F9" in w.shown[0]
    assert w.saved == []  # not remembered, and nothing was saved before
    assert w.ui.button.cget("state") == "normal"


def test_remember_saves_the_key_and_cancel_stops(window, monkeypatch):
    def slow_download(start, end, key, workbook, csv_path, replace, progress, cancel):
        for i in range(50):
            if cancel():
                raise ds.Cancelled("Download cancelled; workbook was not touched.")
            time.sleep(0.02)
        return [], SimpleNamespace(sheet_name="CPI_Downloader"), {"kept": 0, "updated": 0, "added": 0, "rows": 0}
    monkeypatch.setattr(app, "download", slow_download)
    w = window
    w.ui.start()
    w.ui.cancel()
    assert pump(w.root, 5, lambda: w.ui.worker is None)
    assert w.ui.status.get() == "Download cancelled; workbook was not touched."
    w.ui.remember.set(True)
    monkeypatch.setattr(app, "download", lambda *a: ([], SimpleNamespace(sheet_name="CPI_Downloader"), {"kept": 0, "updated": 0, "added": 1, "rows": 1}))
    w.ui.start()
    assert pump(w.root, 5, lambda: w.saved)
    assert w.saved == ["placeholder-key"]


def test_invalid_month_is_rejected_before_any_download(window, monkeypatch):
    called = []
    monkeypatch.setattr(app, "download", lambda *a: called.append(a))
    w = window
    w.ui.month.delete(0, "end")
    w.ui.month.insert(0, "13")
    w.ui.start()
    assert w.shown and w.shown[0].startswith("ERROR Enter the month") and not called
