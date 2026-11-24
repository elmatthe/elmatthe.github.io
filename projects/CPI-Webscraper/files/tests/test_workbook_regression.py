"""Opt-in real Excel regression; ordinary pytest never launches Excel."""
from copy import copy
from datetime import date
import hashlib
import os
from pathlib import Path
import re
import shutil
import warnings
import zipfile
import io
from xml.etree import ElementTree as ET
import openpyxl
from openpyxl.worksheet.cell_range import CellRange
import pytest
from cpi_config import ROOT, load_config
from workbook_io import write_to_workbook

# Public copy: S&P 500 values, cached results and local metadata removed by
# _tools/cpi_public_workbook.py (the private original is unchanged).
CANONICAL_SHA256 = 'fc88e36ee737d9e3f3ca72a697a1d4a1b521068c9ef5720b610f40f967bceaa1'

def test_reference_schema_matches_default():
    config=load_config(ROOT/'scripts/config-default.toml')
    wb=openpyxl.load_workbook(ROOT/'files/CPI.xlsx',read_only=True,data_only=False)
    try:
        assert tuple(next(wb['CPI_Downloader'].iter_rows(min_row=1,max_row=1,max_col=19,values_only=True)))==config.headers
        cells={openpyxl.utils.get_column_letter(i):getattr(c.value,'text',c.value) for i,c in enumerate(next(wb['US Data'].iter_rows(min_row=5,max_row=5)),1)}
        for output,raw in [('AI','O'),('AJ','P'),('AK','Q')]:
            assert f'CPI_Downloader!${raw}$2:${raw}$5000' in cells[output]
        for output in ['AM','AN','AO','AP','AQ','AR','AS']:
            assert 'CPI_Downloader!$R$2:$R$5000' in cells[output]
        for output in ['AU','AV','AW','AX','AY','AZ','BA']:
            assert 'CPI_Downloader!$S$2:$S$5000' in cells[output]
        assert 'CPI_Downloader!$B$2:$S$5000' in cells['A']
    finally:
        wb.close()

def formula_value(value):
    # Modern array/dynamic formulas are objects, not plain strings.
    if hasattr(value, '__dict__'):
        return (type(value).__name__, dict(vars(value)))
    return value

def snapshot(path):
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        wb = openpyxl.load_workbook(path, data_only=False)
        cached = openpyxl.load_workbook(path, data_only=True)
    sheets = {}
    for ws in wb:
        cells = {}
        styles = {}
        array_ranges = [CellRange(ref) for ref in ws.array_formulae.values()]
        for cell in list(ws._cells.values()):
            if cell.value is not None or cell.has_style:
                if cell.style_id not in styles:
                    styles[cell.style_id] = (copy(cell.font), copy(cell.fill), copy(cell.border), copy(cell.alignment), cell.number_format, copy(cell.protection))
                value = cell.value
                # Excel can serialize array interior cells with an empty <f/>.
                # openpyxl exposes those markers as '='; saving in Excel removes
                # them. Compare their actual cached values, only inside a known
                # array range; retain the real anchor formula and all formatting.
                if value == '=':
                    assert any(cell.coordinate in r and (cell.row,cell.column)!=(r.min_row,r.min_col) for r in array_ranges), 'Empty formula outside array interior'
                    value = cached[ws.title][cell.coordinate].value
                cells[cell.coordinate] = (formula_value(value), *styles[cell.style_id])
        sheets[ws.title] = {
            'cells':cells,
            'cached_values':{c.coordinate:c.value for c in cached[ws.title]._cells.values() if c.value is not None},
            'rows': {k:dict(v) for k,v in ws.row_dimensions.items()},
            'cols': {k:dict(v) for k,v in ws.column_dimensions.items()},
            'merges':str(ws.merged_cells),
            'tables':[openpyxl.xml.functions.tostring(t.to_tree()) for t in ws.tables.values()],
            'conditional':[ (str(k), [openpyxl.xml.functions.tostring(r.to_tree()) for r in rules]) for k,rules in ws.conditional_formatting._cf_rules.items()],
            'charts':[openpyxl.xml.functions.tostring(c._write()) for c in ws._charts],
            'state':ws.sheet_state,
        }
    result = {'sheets':sheets,'names':[(k,dict(v)) for k,v in wb.defined_names.items()], 'calculation':dict(wb.calculation)}
    wb.close()
    cached.close()
    return result

def test_array_interior_serialization_preserves_real_values(tmp_path):
    path=tmp_path/'array.xlsx'
    wb=openpyxl.Workbook()
    ws=wb.active
    ws['A1']=openpyxl.worksheet.formula.ArrayFormula(ref='A1:A2',text='=SEQUENCE(2)')
    ws['A2']=2
    wb.save(path);wb.close()
    expected=snapshot(path)
    original=path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(path,'w') as target:
        for entry in source.infolist():
            data=source.read(entry.filename)
            if entry.filename=='xl/worksheets/sheet1.xml':
                root=ET.fromstring(data)
                cell=root.find(".//{*}c[@r='A2']")
                cell.insert(0,ET.Element('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}f',ca='1'))
                data=ET.tostring(root)
            target.writestr(entry,data)
    assert snapshot(path)==expected
    # A real value or anchor-formula change must still fail preservation.
    wb=openpyxl.load_workbook(io.BytesIO(original))
    wb.active['A2']=3;wb.save(path)
    assert snapshot(path)!=expected
    wb.active['A2']=2
    wb.active['A1']=openpyxl.worksheet.formula.ArrayFormula(ref='A1:A2',text='=SEQUENCE(2)+1')
    wb.save(path);wb.close()
    assert snapshot(path)!=expected

def test_empty_formula_outside_array_rejected(tmp_path):
    path=tmp_path/'invalid.xlsx'
    wb=openpyxl.Workbook();wb.active['A1']='=';wb.save(path);wb.close()
    with pytest.raises(AssertionError,match='Empty formula outside array'):
        snapshot(path)

def _style(obj):
    return (repr(obj.font), repr(obj.fill), repr(obj.border), repr(obj.alignment), obj.number_format, repr(obj.protection))

def _chart_definitions(path):
    # Chart XML without its cached series (numCache/strCache), which Excel refreshes.
    with zipfile.ZipFile(path) as z:
        return {n: re.sub(r'<c:(numCache|strCache)>.*?</c:\1>', '', z.read(n).decode(), flags=re.S)
                for n in z.namelist() if n.startswith('xl/charts/chart')}

def _full_calc_on_load(path):
    with zipfile.ZipFile(path) as z:
        return 'fullCalcOnLoad="1"' in z.read('xl/workbook.xml').decode()

def preservation_view(path):
    """What a write must never change, independent of how Excel serializes cached results.

    Formulas are compared by anchor text (a dynamic array's spill extent is a calculation
    result, not structure). A cell element Excel drops because its style equals its
    column's style is compared through the column's style (same visible formatting).
    """
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        wb=openpyxl.load_workbook(path,data_only=False)
        cached=openpyxl.load_workbook(path,data_only=True)
    sheets={}
    for ws in wb:
        formulas,styles,values,volatile={},{},{},set()
        for cell in ws._cells.values():
            value=cell.value
            if hasattr(value,'text'):
                formulas[cell.coordinate]=value.text
            elif isinstance(value,str) and value.startswith('=') and value!='=':
                formulas[cell.coordinate]=value
                if re.search(r'\b(TODAY|NOW|RAND|RANDBETWEEN)\(',value.upper()):
                    volatile.add(cell.coordinate)
            if cell.has_style:
                styles[cell.coordinate]=_style(cell)
        for cell in cached[ws.title]._cells.values():
            if cell.value is not None and cell.coordinate not in volatile:
                values[cell.coordinate]=cell.value
        sheets[ws.title]={
            'formulas':formulas,'styles':styles,'values':values,
            'column_styles':{k:_style(v) for k,v in ws.column_dimensions.items()},
            'structure':{
                'rows':{k:dict(v) for k,v in ws.row_dimensions.items()},
                'cols':{k:dict(v) for k,v in ws.column_dimensions.items()},
                'merges':str(ws.merged_cells),
                'tables':[openpyxl.xml.functions.tostring(t.to_tree()) for t in ws.tables.values()],
                'conditional':[(str(k),[openpyxl.xml.functions.tostring(r.to_tree()) for r in rules]) for k,rules in ws.conditional_formatting._cf_rules.items()],
                'validation':repr([(d.sqref,d.formula1,d.formula2) for d in ws.data_validations.dataValidation]),
                'state':ws.sheet_state,
            },
        }
    view={'sheets':sheets,'names':sorted((k,v.attr_text) for k,v in wb.defined_names.items()),
          'charts':_chart_definitions(path),'recalculates_on_open':_full_calc_on_load(path)}
    wb.close();cached.close()
    return view

def _effective_style_differences(old,new):
    def effective(view,coord):
        if coord in view['styles']:
            return view['styles'][coord]
        letter=''.join(ch for ch in coord if ch.isalpha())
        return view['column_styles'].get(letter)
    return sorted(c for c in old['styles'].keys()|new['styles'].keys() if effective(old,c)!=effective(new,c))

def assert_write_preserved(before,after,raw_sheet,changed_rows):
    """Only the raw sheet's written rows may change; everything that defines the model stays."""
    assert before['names']==after['names'], 'Defined names changed'
    assert before['charts']==after['charts'], 'Chart definitions changed'
    assert before['sheets'].keys()==after['sheets'].keys(), 'Sheets added or removed'
    for name,old in before['sheets'].items():
        new=after['sheets'][name]
        assert old['formulas']==new['formulas'], f'Formulas changed: {name}'
        assert old['structure']==new['structure'], f'Rows, columns, merges, tables, conditional formats or validation changed: {name}'
        if name==raw_sheet:
            # Raw cells outside the written months keep their values and formatting.
            moved=[c for c in old['values'].keys()|new['values'].keys()
                   if old['values'].get(c)!=new['values'].get(c) and int(''.join(ch for ch in c if ch.isdigit())) not in changed_rows]
            assert not moved, f'Raw values outside the written months changed: {sorted(moved)[:5]}'
            styled=[c for c in _effective_style_differences(old,new) if int(''.join(ch for ch in c if ch.isdigit())) not in changed_rows]
            assert not styled, f'Raw formatting changed: {styled[:5]}'
            continue
        assert not _effective_style_differences(old,new), f'Model formatting changed: {name}'
        if not before['recalculates_on_open']:
            # A real, already-calculated workbook: the write suppresses calculation, so the
            # saved model results are untouched (Excel recalculates when it is next opened).
            # A workbook flagged fullCalcOnLoad (the public copy) is calculated by Excel as
            # it opens, by design, so its cached results are not part of this contract.
            assert old['values']==new['values'], f'Model results changed during the write: {name}'

# CPI_EXCEL_WORKBOOK may name a real private workbook (for example the canonical one);
# it is only copied and read, never written.
@pytest.mark.skipif(os.environ.get('CPI_EXCEL_REGRESSION') != '1', reason='Opt-in desktop Excel test')
def test_canonical_copy_preserves_model(tmp_path):
    canonical=Path(os.environ.get('CPI_EXCEL_WORKBOOK') or ROOT/'files/CPI.xlsx')
    digest=lambda:hashlib.sha256(canonical.read_bytes()).hexdigest()
    initial=digest()
    if not os.environ.get('CPI_EXCEL_WORKBOOK'):
        assert initial==CANONICAL_SHA256
    target=tmp_path/'CPI-regression.xlsx'
    shutil.copy2(canonical,target)
    before=preservation_view(target)
    probe=openpyxl.load_workbook(target,read_only=True)
    before_rows=probe['CPI_Downloader'].max_row
    existing_dates=[r[0] for r in probe['CPI_Downloader'].iter_rows(min_row=2,max_col=1,values_only=True)]
    probe.close()
    config=load_config(ROOT/'scripts/config-default.toml')
    rows=[{'date':date(2024,m,1), **{c.id:float(i+m) for i,c in enumerate(config.columns) if c.id!='date'}} for m in (1,2)]
    written_rows={2+[d.date() if hasattr(d,'date') else d for d in existing_dates].index(r['date']) for r in rows}
    try:
        write_to_workbook(rows,target,config)
        assert_write_preserved(before,preservation_view(target),config.sheet_name,written_rows)
        wb=openpyxl.load_workbook(target,data_only=False)
        ws=wb[config.sheet_name]
        assert tuple(ws.cell(1,c).value for c in range(1,20))==config.headers
        dates=[ws.cell(r,1).value for r in range(2,ws.max_row+1)]
        for row in rows:
            index=2+[d.date() if hasattr(d,'date') else d for d in dates].index(row['date'])
            for col,value in enumerate(config.values(row),1):
                actual=ws.cell(index,col).value
                if isinstance(value,date):
                    actual=actual.date() if hasattr(actual,'date') else actual
                assert actual==value
        # Merge: the two downloaded months are replaced, every other month is kept.
        assert ws.max_row == before_rows
        assert tuple(c.id for c in config.columns[15:])==('us_treasury_10y_avg','us_treasury_2y_avg','us_pce_sa','us_core_pce_sa')
        wb.close()
    finally:
        assert digest()==initial, 'Canonical workbook changed'
