import csv
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock
import sys
import pytest
from cpi_config import ROOT, load_config, Config
import workbook_io as io

@pytest.fixture
def config():
    return load_config(ROOT/'scripts/config-default.toml')

@pytest.fixture
def rows(config):
    return [{'date':date(2024,1,1), **{c.id:float(i) for i,c in enumerate(config.columns) if c.id != 'date'}}]

@pytest.fixture
def com(monkeypatch,tmp_path):
    cell = Mock()
    cell.MergeCells = cell.HasFormula = False
    cell.Find.return_value = SimpleNamespace(Row=1500)
    sheet = Mock()
    sheet.Range.return_value = cell
    sheet.ProtectContents = False
    wb = Mock(ReadOnly=False,Date1904=False)
    wb.Worksheets = MagicMock()
    wb.Worksheets.__iter__.return_value = iter([sheet])
    wb.Worksheets.return_value = sheet
    excel = Mock()
    excel.Workbooks.Open.return_value = wb
    dispatch=Mock(return_value=excel)
    pythoncom=Mock()
    monkeypatch.setitem(sys.modules,'pythoncom',pythoncom)
    client=SimpleNamespace(DispatchEx=dispatch)
    monkeypatch.setitem(sys.modules,'win32com',SimpleNamespace(client=client))
    monkeypatch.setitem(sys.modules,'win32com.client',client)
    monkeypatch.setattr(io,'onedrive_pause',lambda:None)
    monkeypatch.setattr(io,'onedrive_resume',lambda:None)
    path=tmp_path/'test.xlsm'
    path.touch()
    return SimpleNamespace(path=path,wb=wb,excel=excel,sheet=sheet,cell=cell,pythoncom=pythoncom,dispatch=dispatch)

def test_bulk_clear_and_cleanup(com,config,rows):
    io.write_to_workbook(rows,com.path,config)
    com.cell.ClearContents.assert_called_once()
    assert com.cell.Value2[0] == config.headers
    assert com.cell.Value2[1][0] == (date(2024,1,1)-date(1899,12,30)).days
    assert len(com.cell.Value2[1])==19
    com.wb.Save.assert_called_once()
    com.wb.Close.assert_called_once_with(SaveChanges=False)
    com.excel.Quit.assert_called_once()
    com.pythoncom.CoUninitialize.assert_called_once()
    assert not any('Delete' in str(call) or 'Add(' in str(call) for call in com.sheet.mock_calls)
    assert com.sheet.EnableCalculation is False

def test_quit_even_when_close_fails(com,config,rows):
    com.wb.Close.side_effect=RuntimeError('close failed')
    with pytest.raises(RuntimeError): io.write_to_workbook(rows,com.path,config)
    com.excel.Quit.assert_called_once()
    com.pythoncom.CoUninitialize.assert_called_once()

def test_1904_dates(com,config,rows):
    com.wb.Date1904=True
    io.write_to_workbook(rows,com.path,config)
    assert com.cell.Value2[1][0]==(date(2024,1,1)-date(1904,1,1)).days

@pytest.mark.parametrize('failure',['missing','readonly','open','clear','save','protected','formula','merged'])
def test_failure_cleanup(com,config,rows,failure):
    if failure=='missing': com.wb.Worksheets.side_effect=RuntimeError()
    if failure=='readonly': com.wb.ReadOnly=True
    if failure=='open': com.excel.Workbooks.Open.side_effect=RuntimeError()
    if failure=='clear': com.cell.ClearContents.side_effect=RuntimeError()
    if failure=='save': com.wb.Save.side_effect=RuntimeError()
    if failure=='protected': com.sheet.ProtectContents=True
    if failure=='formula': com.cell.HasFormula=None
    if failure=='merged': com.cell.MergeCells=None
    with pytest.raises(io.WorkbookError): io.write_to_workbook(rows,com.path,config)
    com.excel.Quit.assert_called_once()
    com.pythoncom.CoUninitialize.assert_called_once()
    if failure!='open': com.wb.Close.assert_called_once_with(SaveChanges=False)
    if failure in ['missing','readonly','open','protected','formula','merged']:
        com.cell.ClearContents.assert_not_called()
        com.wb.Save.assert_not_called()

def test_lock_and_bad_dataset_before_excel(com,config,rows):
    com.path.with_name('~$'+com.path.name).touch()
    with pytest.raises(io.WorkbookError): io.write_to_workbook(rows,com.path,config)
    com.dispatch.assert_not_called()
    rows[0]['us_pce_sa']=float('nan')
    with pytest.raises(io.WorkbookError): io.write_to_workbook(rows,com.path,config)
    com.dispatch.assert_not_called()

def test_csv_schema(config,rows,tmp_path):
    config=Config(config.sheet_name,'',tuple(reversed(config.columns)))
    path=tmp_path/'data.csv'
    io.write_to_csv(rows,path,config)
    with path.open(newline='',encoding='utf-8') as f: result=list(csv.reader(f))
    assert result[0]==list(config.headers)
    assert result[1][-1]=='2024-01-01'
    assert result[1][0]=='18.0'

def test_onedrive_absent_or_fails(monkeypatch):
    monkeypatch.setattr(io,'_get_onedrive_exe',lambda:None)
    io.onedrive_pause(); io.onedrive_resume()
    monkeypatch.setattr(io,'_get_onedrive_exe',lambda:'fake.exe')
    monkeypatch.setattr(io.subprocess,'run',Mock(side_effect=OSError()))
    io.onedrive_pause(); io.onedrive_resume()
