# VBA Scripts & Custom Functions — User Guide

> A reference guide for all included macros and custom worksheet functions.

---

## How to Install a VBA Script

All scripts are provided as `.bas` files. Here's how to get them into your workbook:

1. Open your Excel workbook
2. Press **`Alt + F11`** to open the Visual Basic Editor (VBE)
3. In the left panel, right-click your workbook name → **Import File...**
4. Select the `.bas` file and click **Open**
5. Close the VBE (`Alt + F4` or just close the window)
6. **Save your workbook as `.xlsm`** (macro-enabled) — if you save as `.xlsx` the macros will be stripped out

> ⚠️ If Excel shows a security warning about macros when you open the file, click **Enable Content** to allow the scripts to run.

---

## Contents

| Script | Type | What It Does |
|---|---|---|
| [Auto_Fit_Selected_Cell_Height](#auto_fit_selected_cell_height) | Macro | Auto-fits row heights for selected cells with wrapped text |
| [BUBBLESORT](#bubblesort) | Custom Function | Sorts a column range A→Z |
| [BUBBLESORTUNIQUE](#bubblesortunique) | Custom Function | Sorts a column range A→Z, removing duplicates |
| [Multi-Select_Data_Validation_List](#multi-select_data_validation_list) | Worksheet Event | Allows picking multiple items from a dropdown list |
| [Paste_Absolute_Values](#paste_absolute_values) | Macro | Replaces formulas with their calculated values, with undo backup |
| [Print_from_excel_to_fit_page](#print_from_excel_to_fit_page) | Macro | Exports summary ranges to one-page PDFs with auto orientation |
| [SIMILAR_ID](#similar_id) | Custom Function | Returns a value based on whether a cell contains any of your keywords |
| [TRANSPOSE_EXC_BLANK](#transpose_exc_blank) | Custom Function | Transposes a range into a column, skipping blank cells |
| [TRANSPOSE_EXC_DUP](#transpose_exc_dup) | Custom Function | Transposes a range into a column, skipping duplicates and blanks |
| [TRANSPOSE_MERGE_ID](#transpose_merge_id) | Custom Function | Transposes a range into a column, treating merged cells as one value |

---

## Auto_Fit_Selected_Cell_Height

**Type:** Macro (run manually)

**What it does:** When cells contain long text with wrapping enabled, Excel sometimes doesn't resize the row height to show all the text. This macro fixes that — it enables text wrapping on all selected cells and then auto-fits each row to the correct height.

**How to use:**
1. Select the cell(s) or row(s) whose height you want to fix
2. Run the macro: press **`Alt + F8`**, select **`AutoFitSelectedCells`**, click **Run**

**Tip:** You can also assign this macro to a button on your sheet for one-click access — right-click any shape or button → **Assign Macro** → select `AutoFitSelectedCells`.

---

## BUBBLESORT

**Type:** Custom worksheet function

**What it does:** Takes a single-column range of values and returns them sorted from A to Z (or smallest to largest for numbers). The result spills downward into as many rows as there are values.

**Syntax:**
```
=BUBBLESORT(range)
```

**Example:**
```
=BUBBLESORT(A1:A10)
```
Returns the 10 values from A1:A10 sorted in ascending order.

**Notes:**
- The input range must be a single column
- Duplicates are kept — all values are returned
- Select enough empty cells below your formula to fit all the results before entering it, or use it in a spill-capable version of Excel (Microsoft 365)

---

## BUBBLESORTUNIQUE

**Type:** Custom worksheet function

**What it does:** Same as `BUBBLESORT`, but also removes duplicate values. The result is a sorted list of only the unique values from the range.

**Syntax:**
```
=BUBBLESORTUNIQUE(range)
```

**Example:**
```
=BUBBLESORTUNIQUE(A1:A50)
```
Returns a sorted list of every distinct value found in A1:A50, with duplicates removed.

**Notes:**
- Blank cells are automatically excluded
- Useful for building clean dropdown source lists from messy data columns

---

## Multi-Select_Data_Validation_List

**Type:** Worksheet Event (runs automatically in the background)

**What it does:** Normally, Excel's dropdown (data validation) lists only let you pick one item at a time — selecting a new item replaces the old one. This script changes that behaviour so you can **pick multiple items** from the same dropdown. Each selection is added to the cell, separated by a comma. Clicking an already-selected item removes it.

**How to install (special steps for this one):**

Because this is a **worksheet event**, it must be placed inside the specific sheet's code module — not in a standard module.

1. Press **`Alt + F11`** to open the VBE
2. In the left panel, find your workbook and expand it
3. Double-click the **sheet** where your dropdowns are (e.g. `Sheet1`)
4. Paste the contents of `Multi-Select_Data_Validation_List.bas` directly into that sheet's code window
5. Close the VBE and save as `.xlsm`

**How to use:**
- Set up your data validation list on the sheet as normal (Data → Data Validation → List)
- Once the script is installed on that sheet, clicking a dropdown and selecting items will automatically accumulate them in the cell, comma-separated
- Clicking an item that's already in the cell will **remove** it

**Notes:**
- Only works on cells that already have a data validation list applied
- The delimiter is `, ` (comma + space) — this is set at the top of the script and can be changed if needed

---

## Paste_Absolute_Values

**Type:** Macro (run via buttons)

**What it does:** Replaces a defined range of formulas with their current calculated values — permanently "locking in" the numbers. Before it does this, it automatically saves a hidden backup of the original data so you can undo if needed.

This is useful when you want to freeze a year's worth of calculated data so it no longer updates with formula changes.

**How it works:**

The file contains three layers:

**1. Core functions (do not assign these to buttons directly):**
- `PasteValuesOver(range, backupName)` — saves a backup, then pastes values over the range
- `UndoPasteValues(range, backupName)` — restores the range from the backup

**2. Year-specific button macros** (assign one per button, one per year):
```
Year_2018_PasteValues  →  locks columns H4:S10000
Year_2019_PasteValues  →  locks columns U4:AF10000
Year_2020_PasteValues  →  locks columns AH4:AS10000
... and so on through Year_2030_PasteValues
```

**3. Single undo button:**
```
Undo_Last_PasteValues  →  restores whichever range was most recently locked
```

**How to set up:**
1. Import the `.bas` file into your workbook
2. Create a button on your sheet for each year you want (Insert → Shapes, or Developer → Insert → Button)
3. Right-click each button → **Assign Macro** → select the matching `Year_XXXX_PasteValues` macro
4. Create one more button and assign `Undo_Last_PasteValues` to it
5. In the VBE, create a named range called **`LAST_BACKUP`** in your workbook pointing to any spare empty cell — the undo tracker writes to this cell (Formulas → Name Manager → New → name it `LAST_BACKUP`, set it to a cell like `Sheet1!$A$1` in a hidden area)

**Notes:**
- Backups are stored in hidden sheets named `BAK_XXXX` — do not delete these if you may need to undo
- Only the **most recent** paste operation can be undone with the single undo button
- To customise the ranges for your own workbook, edit the range strings in each `Year_XXXX_PasteValues` sub

---

## Print_from_excel_to_fit_page

**Type:** Macro module (run via button macros)

**What it does:** Exports summary sections to PDF and forces each export to fit on a single page. The helper macro compares portrait and landscape scale and picks the better fit automatically.

**Public button macros:**
- `PrintMedicalSummary` -> prints `MEDICAL!A1:I30` to `Summary_of_medical.pdf`
- `PrintDonationSummary` -> prints `DONATIONS!A1:H30` to `Summary_of_donations.pdf`

**How to use:**
1. Import `Print_from_excel_to_fit_page.bas` into your workbook.
2. Create one or more buttons (Insert -> Shapes, or Developer -> Insert -> Button).
3. Assign `PrintMedicalSummary` or `PrintDonationSummary` to each button.
4. Save the workbook, then run the button macro to generate the PDF in the same folder as the workbook.

**How to customise:**
- Edit `sheetName` if your tab names differ from `MEDICAL` / `DONATIONS`.
- Edit `printRange` to change what gets exported.
- Edit `fileName` to change the PDF output file names.
- Adjust margins in `ExportSheetToPDF` if you need tighter or wider print spacing.

**Note:** If a target PDF file already exists, the macro prompts before replacing it.

---

## SIMILAR_ID

**Type:** Custom worksheet function

**What it does:** Searches a cell's text for any of your specified keywords. If any keyword is found, it returns one value you define; if none are found, it returns a different value. Think of it as a flexible, multi-keyword `IF(SEARCH(...))`.

**Syntax:**
```
=SIMILAR_ID(cell, keyword1, keyword2, ..., value_if_match, value_if_no_match)
```

| Argument | Description |
|---|---|
| `cell` | The cell whose text you want to search |
| `keyword1, keyword2, ...` | One or more words or phrases to look for (at least one required) |
| `value_if_match` | What to return if any keyword is found |
| `value_if_no_match` | What to return if no keyword is found |

**Examples:**
```
=SIMILAR_ID(A1, "red", "blue", "green", "Colour found", "No colour")
```
→ If A1 contains the word "red", "blue", or "green" anywhere, returns `"Colour found"`. Otherwise returns `"No colour"`.

```
=SIMILAR_ID(B2, "invoice", "receipt", "billing", 1, 0)
```
→ Returns `1` if B2 mentions any of those words, otherwise `0`.

**Notes:**
- The search is **case-insensitive** — "RED", "Red", and "red" all match
- Keywords shorter than 2 characters or made up entirely of symbols are automatically ignored
- The last two arguments are always the match/no-match return values — everything between the cell and those two is treated as a keyword

---

## TRANSPOSE_EXC_BLANK

**Type:** Custom worksheet function

**What it does:** Takes a range (which can be a row or column) and returns the values as a vertical column, **skipping any blank cells**. Useful for compacting a sparse list into a clean, gapless column.

**Syntax:**
```
=TRANSPOSE_EXC_BLANK(range)
```

**Example:**
```
=TRANSPOSE_EXC_BLANK(A1:A20)
```
If A1:A20 has values in only 12 of the 20 cells, this returns a 12-row column with just the non-blank values.

**Notes:**
- Returns a `#N/A` error if the entire range is blank
- Works on both row and column input ranges
- Make sure there are enough empty cells below the formula for the results to spill into

---

## TRANSPOSE_EXC_DUP

**Type:** Custom worksheet function

**What it does:** Takes a range and returns its values as a vertical column, **removing both duplicates and blanks**. Each unique value appears only once in the output.

**Syntax:**
```
=TRANSPOSE_EXC_DUP(range)
```

**Example:**
```
=TRANSPOSE_EXC_DUP(B1:B100)
```
Returns a column of every distinct non-blank value found in B1:B100, in the order they first appear.

**Notes:**
- Returns `#N/A` if the range contains no non-blank values
- The order of results reflects the first occurrence of each unique value in the range
- Pair this with `BUBBLESORTUNIQUE` if you also want the results sorted

---

## TRANSPOSE_MERGE_ID

**Type:** Custom worksheet function

**What it does:** Takes a range that contains **merged cells** and returns the values as a vertical column, treating each merged group as a single value. Without this function, iterating over a merged range in Excel can produce repeated or blank values — this handles that cleanly.

**Syntax:**
```
=TRANSPOSE_MERGE_ID(range)
```

**Example:**

If A1:A3 is a merged cell containing "Group A", and A4:A5 is merged containing "Group B", then:
```
=TRANSPOSE_MERGE_ID(A1:A5)
```
Returns a 2-row column: `Group A`, `Group B` — one entry per merged group, no duplicates from the merge.

**Notes:**
- Non-merged cells in the range are treated normally — each is its own entry
- Mixed ranges (some merged, some not) are handled correctly
- Returns `#N/A` if the range is empty
