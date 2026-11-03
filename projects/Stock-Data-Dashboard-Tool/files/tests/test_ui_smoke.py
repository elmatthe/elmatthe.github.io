"""The Tk window runs a full analysis from the bundled CSV sample (needs a display).

Skipped without a display; on Linux CI it runs under Xvfb. Exercises the whole
pipeline in main.py (data source, analytics, charts, exports) rather than a stub.
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
tk = pytest.importorskip("tkinter")
if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
    pytest.skip("no display (run under xvfb-run)", allow_module_level=True)


def test_offline_csv_analysis_and_export(tmp_path, monkeypatch):
    import matplotlib
    matplotlib.use("Agg")
    import main
    from tkinter import messagebox
    for name in ("showwarning", "showinfo", "showerror"):
        monkeypatch.setattr(messagebox, name, lambda *a, **k: None)
    monkeypatch.setattr(messagebox, "askyesno", lambda *a, **k: True)
    monkeypatch.setattr(main, "RUNTIME_DIR", tmp_path / "runtime")
    try:
        app = main.StockAnalyticsApp()
    except tk.TclError as error:
        pytest.skip(f"no display: {error}")
    assert app.source_var.get() == "Alpha Vantage (your key)"
    assert "Yahoo Finance" not in main.SOURCES
    app.source_var.set("Offline CSV")
    app.start_var.set("2024-01-01")
    app.end_var.set("2024-01-05")
    app.frequency_var.set("Daily")
    app.risk_free_var.set("4")
    app.export_folder_var.set(str(tmp_path / "exports"))
    rows = [r for r in app.ticker_rows if r["ticker"].get()]
    assert len(rows) >= 2
    app.run_analysis()
    assert app.current_results, app.logs_text.get("1.0", "end")
    assert app.current_results["settings"]["risk_free_rate"] == pytest.approx(0.04), "risk-free entered in percent"
    app.export_results()
    workbooks = list((tmp_path / "exports").glob("stock_analysis_*.xlsx"))
    assert workbooks
    import openpyxl
    wb = openpyxl.load_workbook(workbooks[0])
    assert {"Prices", "Returns", "Settings", "Dashboard Metrics"} <= set(wb.sheetnames)
    app.destroy()
