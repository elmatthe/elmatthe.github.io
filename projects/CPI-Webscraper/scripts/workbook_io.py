"""Excel owns workbook serialization; only raw-sheet contents are assigned.

By default a download is MERGED into the raw sheet: months that were downloaded are
replaced, every other month already in the sheet is kept (a single-month update no
longer clears the history, which matters because FRED's S&P 500 window rolls forward
and older months cannot be downloaded again). `replace=True` keeps the old behaviour:
the sheet then holds exactly the downloaded months.
"""
import csv
from datetime import date
import gc
import math
from pathlib import Path
from cpi_config import SUPPORTED_IDS

RECALCULATE_NOTE = ('Open the workbook in desktop Excel and press Ctrl+Alt+F9 (full recalculation), then save: '
                    'the model sheets are not recalculated while this program writes the raw data.')

class WorkbookError(ValueError):
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


def merge_rows(existing, matrix):
    """Existing raw-sheet values (Value2 rows, header first) + new rows -> merged rows.

    `matrix` rows hold Excel date serials in column A. Returns (rows, stats) where
    stats counts kept, updated and added months.
    """
    header, new_rows = matrix[0], matrix[1:]
    width = len(header)
    old = {}
    for index, row in enumerate(existing[1:], start=2):
        row = tuple(row) + (None,) * (width - len(row))
        if all(value is None or value == '' for value in row[:width]):
            continue
        serial = row[0]
        if isinstance(serial, bool) or not isinstance(serial, (int, float)) or not math.isfinite(serial) or serial != int(serial):
            raise WorkbookError(f'Raw-data row {index} has values but no valid date in column A; workbook was not changed. '
                                'Fix the row or use "Replace all rows".')
        if int(serial) in old:
            raise WorkbookError(f'Raw-data row {index} repeats a month already in the sheet; workbook was not changed.')
        old[int(serial)] = tuple(None if value == '' else value for value in row[:width])
    new = {int(row[0]): tuple(row) for row in new_rows}
    stats = {'kept': sum(1 for k in old if k not in new), 'updated': sum(1 for k in new if k in old),
             'added': sum(1 for k in new if k not in old)}
    merged = {**old, **new}
    return (tuple(header), *(merged[k] for k in sorted(merged))), stats


def write_to_workbook(rows, workbook_path, config, replace=False):
    """Write the downloaded months into the raw sheet; returns {'kept','updated','added','rows'}."""
    matrix = validate_rows(rows, config)
    path = Path(workbook_path).resolve()
    if path.suffix.lower() not in ('.xlsx','.xlsm') or not path.is_file():
        raise WorkbookError('Select an existing .xlsx or .xlsm workbook.')
    if path.with_name('~$'+path.name).exists():
        raise WorkbookError('Workbook is open or locked. Close it in Excel before downloading.')
    import pythoncom
    import win32com.client
    excel = workbook = sheet = target = owned = last = model_sheet = None
    stats = None
    pythoncom.CoInitialize()
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
        used = int(last.Row) if last is not None else 1
        height = max(len(matrix), used)
        target = sheet.Range(sheet.Cells(1,1), sheet.Cells(height,19))
        if target.MergeCells is not False and target.MergeCells != 0:
            raise WorkbookError('Raw output area contains merged cells; workbook was not changed.')
        if target.HasFormula is not False and target.HasFormula != 0:
            raise WorkbookError('Raw output area contains formulas; workbook was not changed.')
        # Value2 serials preserve existing number formats and respect the workbook date system.
        epoch = date(1904,1,1) if workbook.Date1904 else date(1899,12,30)
        values = tuple(tuple((value-epoch).days if type(value) is date else value for value in row) for row in matrix)
        if replace or used < 2:
            stats = {'kept': 0, 'updated': 0, 'added': len(values) - 1}
        else:
            existing = sheet.Range(sheet.Cells(1,1), sheet.Cells(used,19)).Value2
            if not isinstance(existing, tuple) or not all(isinstance(row, tuple) for row in existing):
                raise WorkbookError('The existing raw data could not be read; workbook was not changed.')
            values, stats = merge_rows(existing, values)
            height = max(height, len(values))
            target = sheet.Range(sheet.Cells(1,1), sheet.Cells(height,19))
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
        stats['rows'] = len(values) - 1
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
    return stats


def write_to_csv(rows, csv_path, config):
    matrix = validate_rows(rows, config)
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerows(tuple(value.isoformat() if type(value) is date else value for value in row) for row in matrix)
