"""Excel owns workbook serialization; only raw-sheet contents are assigned."""
import csv
from datetime import date
import gc
import math
import os
from pathlib import Path
import subprocess
import time
from cpi_config import SUPPORTED_IDS

class WorkbookError(ValueError):
    pass

def _get_onedrive_exe() -> str | None:
    """
    Return the path to OneDrive.exe if it exists on this machine,
    otherwise return None (so we silently skip pause/resume on machines
    that don't have OneDrive installed).
    """
    candidate = os.path.join(
        os.environ.get("LOCALAPPDATA", ""),
        "Microsoft", "OneDrive", "OneDrive.exe"
    )
    return candidate if os.path.isfile(candidate) else None


def onedrive_pause():
    """
    Pause OneDrive syncing. Safe to call even if OneDrive is not installed —
    it will simply do nothing.
    """
    exe = _get_onedrive_exe()
    if exe:
        try:
            subprocess.run([exe, "/pause"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            # Give OneDrive a moment to actually pause before we touch the file
            time.sleep(2)
        except Exception:
            pass  # Never let a OneDrive issue block the main task


def onedrive_resume():
    """
    Resume OneDrive syncing. Safe to call even if OneDrive is not installed.
    """
    exe = _get_onedrive_exe()
    if exe:
        try:
            subprocess.run([exe, "/resume"], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception:
            pass


def validate_rows(rows, config):
    if not rows or len(rows)+1 > 1048576:
        raise WorkbookError('Dataset must contain 1 to 1048575 monthly rows.')
    previous = None
    for row in rows:
        if set(row) != set(SUPPORTED_IDS):
            raise WorkbookError('Incomplete dataset: workbook was not touched.')
        d = row['date']
        if type(d) is not date or d.day != 1 or (previous and d <= previous):
            raise WorkbookError('Dataset dates must be increasing first-of-month dates.')
        previous = d
        for key,value in row.items():
            if key != 'date' and value is not None and (type(value) not in (int,float) or not math.isfinite(value)):
                raise WorkbookError('Dataset contains an invalid numeric value.')
    return (config.headers, *(config.values(row) for row in rows))


def write_to_workbook(rows, workbook_path, config):
    matrix = validate_rows(rows, config)
    path = Path(workbook_path).resolve()
    if path.suffix.lower() not in ('.xlsx','.xlsm') or not path.is_file():
        raise WorkbookError('Select an existing .xlsx or .xlsm workbook.')
    if path.with_name('~$'+path.name).exists():
        raise WorkbookError('Workbook is open or locked. Close it in Excel before downloading.')
    import pythoncom
    import win32com.client
    excel = workbook = sheet = target = owned = last = model_sheet = None
    pythoncom.CoInitialize()
    onedrive_pause()
    try:
        excel = win32com.client.DispatchEx('Excel.Application')
        excel.Visible = False
        excel.DisplayAlerts = False
        excel.EnableEvents = False
        excel.AutomationSecurity = 3  # Disable workbook macros during programmatic open.
        excel.AskToUpdateLinks = False
        workbook = excel.Workbooks.Open(str(path), UpdateLinks=0, ReadOnly=False,
                                        IgnoreReadOnlyRecommended=True, Notify=False, AddToMru=False)
        if workbook.ReadOnly:
            raise WorkbookError('Workbook is read-only or locked. Close it and check write permissions.')
        try:
            sheet = workbook.Worksheets(config.sheet_name)
        except Exception:
            raise WorkbookError('Configured raw-data sheet does not exist; workbook was not changed.') from None
        if sheet.ProtectContents:
            raise WorkbookError('Configured raw-data sheet is protected; workbook was not changed.')
        # Find contents only within the 19 owned columns, including stale historical rows.
        owned = sheet.Range('A:S')
        last = owned.Find(What='*', After=sheet.Cells(1,1), LookIn=-4123,
                          LookAt=2, SearchOrder=1, SearchDirection=2, MatchCase=False)
        height = max(len(matrix), int(last.Row) if last is not None else 1)
        target = sheet.Range(sheet.Cells(1,1), sheet.Cells(height,19))
        if target.MergeCells is not False and target.MergeCells != 0:
            raise WorkbookError('Raw output area contains merged cells; workbook was not changed.')
        if target.HasFormula is not False and target.HasFormula != 0:
            raise WorkbookError('Raw output area contains formulas; workbook was not changed.')
        # Value2 serials preserve existing number formats and respect the workbook date system.
        epoch = date(1904,1,1) if workbook.Date1904 else date(1899,12,30)
        values = tuple(tuple((value-epoch).days if type(value) is date else value for value in row) for row in matrix)
        # Session-only Excel calculation suppression prevents dynamic-array spills
        # from changing model cells/formatting during raw-data replacement.
        # EnableCalculation is not a workbook calculation-mode change.
        for model_sheet in workbook.Worksheets:
            model_sheet.EnableCalculation = False
        model_sheet = None
        target.ClearContents()
        target = sheet.Range(sheet.Cells(1,1), sheet.Cells(len(values),19))
        target.Value2 = values
        workbook.Save()
    except WorkbookError:
        raise
    except Exception:
        raise WorkbookError('Excel could not safely write or save the workbook. Close the workbook, check permissions and Excel availability, then retry. No recovery or row deletion was attempted.') from None
    finally:
        target = owned = last = sheet = model_sheet = None
        try:
            if workbook is not None:
                workbook.Close(SaveChanges=False)
        finally:
            workbook = None
            try:
                if excel is not None:
                    excel.Quit()
            finally:
                excel = None
                gc.collect()
                pythoncom.CoUninitialize()
                onedrive_resume()


def write_to_csv(rows, csv_path, config):
    matrix = validate_rows(rows, config)
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerows(tuple(value.isoformat() if type(value) is date else value for value in row) for row in matrix)
