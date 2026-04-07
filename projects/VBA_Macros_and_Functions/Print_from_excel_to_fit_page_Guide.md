# Print_from_excel_to_fit_page.bas - Macro Guide

This guide explains each macro in `Print_from_excel_to_fit_page.bas`, what it does, and the quickest ways to adapt it for your workbook.

---

## What this module is for

The module exports formatted summary ranges from Excel to PDF and automatically chooses portrait or landscape so the selected range fits on a single page.

By default it includes two button-ready macros:
- `PrintMedicalSummary`
- `PrintDonationSummary`

Both call a shared helper:
- `ExportSheetToPDF` (private helper)

---

## Macro list (what each one does)

| Macro | Type | Default target | Purpose |
|---|---|---|---|
| `ExportSheetToPDF(sheetName, printRange, fileName)` | Private helper | Any sheet/range passed in | Validates sheet + range, calculates best page orientation, applies print settings, exports PDF |
| `PrintMedicalSummary()` | Public button macro | `MEDICAL!A1:I30` | Exports to `Summary_of_medical.pdf` |
| `PrintDonationSummary()` | Public button macro | `DONATIONS!A1:H30` | Exports to `Summary_of_donations.pdf` |

---

## How the logic works

1. Looks up the worksheet by exact tab name.
2. Builds the output PDF path in the same folder as the workbook.
3. Checks whether the output file already exists and prompts before overwrite.
4. Resolves the print range.
5. Measures total width and height of the range (in points).
6. Compares portrait vs landscape scaling room and selects the better fit.
7. Applies page setup:
   - fit to 1 page wide x 1 page tall
   - 0.5" margins (0.25" header/footer)
   - horizontal centering
8. Exports with `ExportAsFixedFormat` to PDF.

---

## How to modify for your own use

### 1) Change sheet names

In each public macro, change:
```vb
sheetName:="MEDICAL"
```
to your tab name exactly (for example `sheetName:="SUMMARY"`).

### 2) Change what range is printed

Update `printRange` in each macro, for example:
```vb
printRange:="A1:K40"
```

### 3) Change output file names

Update `fileName` in each macro, for example:
```vb
fileName:="Quarterly_Report.pdf"
```

### 4) Add more print buttons/macros

Copy one public macro and change all 3 inputs:
```vb
Public Sub PrintOperationsSummary()
    Call ExportSheetToPDF( _
        sheetName:="OPERATIONS", _
        printRange:="A1:J35", _
        fileName:="Summary_of_operations.pdf")
End Sub
```

### 5) Adjust margins or centering globally

Edit the `With ws.PageSetup` block inside `ExportSheetToPDF`:
- `.TopMargin`, `.BottomMargin`, `.LeftMargin`, `.RightMargin`
- `.CenterHorizontally`
- `.CenterVertically`

These changes apply to every public macro that calls the helper.

---

## Installation + button setup

1. In Excel, press `Alt + F11`.
2. Right-click your workbook in the Project pane -> **Import File...**
3. Select `Print_from_excel_to_fit_page.bas`.
4. Save workbook as `.xlsm`.
5. Add a shape/button, right-click it -> **Assign Macro...**
6. Pick `PrintMedicalSummary` or `PrintDonationSummary`.

---

## Troubleshooting

- **"Sheet not found"** -> verify tab name spelling matches the macro exactly.
- **"Range error"** -> verify `printRange` exists on that sheet.
- **Export fails** -> close any PDF viewer locking the target file.
- **Workbook path blank** -> save the workbook first so `ThisWorkbook.Path` exists.
