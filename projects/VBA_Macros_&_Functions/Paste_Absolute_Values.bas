'=======================================================
' CORE FUNCTION - Do not attach this directly to buttons
'=======================================================
Sub PasteValuesOver(sRange As String, sBackupName As String)
    Dim ws As Worksheet
    Dim wsBak As Worksheet
    Dim rng As Range
    Dim sheetExists As Boolean
    
    Set ws = ActiveSheet
    
    On Error GoTo InvalidRange
    Set rng = ws.Range(sRange)
    On Error GoTo 0
    
    ' --- Check if backup sheet already exists ---
    sheetExists = False
    For Each wsBak In ThisWorkbook.Sheets
        If wsBak.Name = sBackupName Then
            sheetExists = True
            Exit For
        End If
    Next wsBak
    
    ' If it doesnt exist, create it
    If Not sheetExists Then
        Set wsBak = ThisWorkbook.Sheets.Add
        wsBak.Name = sBackupName
        wsBak.Visible = xlSheetVeryHidden
    End If
    
    ' Clear the backup sheet and overwrite with fresh copy
    wsBak.Cells.Clear
    rng.Copy wsBak.Range("A1")
    
    ' --- Track the most recent backup for the single undo button ---
    ThisWorkbook.Names("LAST_BACKUP").RefersToRange.Value = sRange & "|" & sBackupName
    
    ' --- Now paste values over the original ---
    With rng
        .Copy
        .PasteSpecial Paste:=xlPasteValues
    End With
    
    Application.CutCopyMode = False
    MsgBox "Values pasted over: " & sRange & vbNewLine & _
           "A backup has been saved. You can undo with the Undo button.", _
           vbInformation, "Done"
    Exit Sub

InvalidRange:
    MsgBox "Invalid range: '" & sRange & "'" & vbNewLine & _
           "Please check the range defined in this button's macro.", _
           vbCritical, "Range Error"
End Sub


'=======================================================
' CORE UNDO FUNCTION - Do not attach this directly to buttons
'=======================================================
Sub UndoPasteValues(sRange As String, sBackupName As String)
    Dim ws As Worksheet
    Dim wsBak As Worksheet
    Dim rng As Range
    
    Set ws = ActiveSheet
    
    On Error Resume Next
    Set wsBak = ThisWorkbook.Sheets(sBackupName)
    On Error GoTo 0
    
    If wsBak Is Nothing Then
        MsgBox "No backup found for this range. Either the macro hasn't been run yet, " & _
               "or the backup was already restored.", vbExclamation, "No Backup Found"
        Exit Sub
    End If
    
    Set rng = ws.Range(sRange)
    wsBak.Range("A1").Resize(rng.Rows.Count, rng.Columns.Count).Copy
    rng.PasteSpecial Paste:=xlPasteAll
    
    Application.CutCopyMode = False
    
    ' Just clear the backup sheet instead of deleting it
    wsBak.Cells.Clear
    
    MsgBox "Range " & sRange & " has been restored to its original state.", _
           vbInformation, "Undo Successful"
End Sub


'=======================================================
' SINGLE UNDO BUTTON - assign this to one undo button on the sheet
'=======================================================
Sub Undo_Last_PasteValues()
    Dim lastBackup As String
    
    On Error Resume Next
    lastBackup = ThisWorkbook.Names("LAST_BACKUP").RefersToRange.Value
    On Error GoTo 0
    
    If lastBackup = "" Then
        MsgBox "Nothing to undo.", vbExclamation, "No Action Found"
        Exit Sub
    End If
    
    Dim parts() As String
    parts = Split(lastBackup, "|")
    
    Call UndoPasteValues(parts(0), parts(1))
    
    ' Clear the tracker after undoing
    ThisWorkbook.Names("LAST_BACKUP").RefersToRange.Value = ""
End Sub


'=======================================================
' BUTTON MACROS - Assign each one to a button on the sheet
'=======================================================

Sub Year_2018_PasteValues()
    Call PasteValuesOver("H4:S10000", "BAK_2018")
End Sub

Sub Year_2019_PasteValues()
    Call PasteValuesOver("U4:AF10000", "BAK_2019")
End Sub

Sub Year_2020_PasteValues()
    Call PasteValuesOver("AH4:AS10000", "BAK_2020")
End Sub

Sub Year_2021_PasteValues()
    Call PasteValuesOver("AU4:BF10000", "BAK_2021")
End Sub

Sub Year_2022_PasteValues()
    Call PasteValuesOver("BH4:BS10000", "BAK_2022")
End Sub

Sub Year_2023_PasteValues()
    Call PasteValuesOver("BU4:CF10000", "BAK_2023")
End Sub

Sub Year_2024_PasteValues()
    Call PasteValuesOver("CH4:CS10000", "BAK_2024")
End Sub

Sub Year_2025_PasteValues()
    Call PasteValuesOver("CU4:DF10000", "BAK_2025")
End Sub

Sub Year_2026_PasteValues()
    Call PasteValuesOver("DH4:DS10000", "BAK_2026")
End Sub

Sub Year_2027_PasteValues()
    Call PasteValuesOver("DU4:EF10000", "BAK_2027")
End Sub

Sub Year_2028_PasteValues()
    Call PasteValuesOver("EH4:ES10000", "BAK_2028")
End Sub

Sub Year_2029_PasteValues()
    Call PasteValuesOver("EU4:FF10000", "BAK_2029")
End Sub

Sub Year_2030_PasteValues()
    Call PasteValuesOver("FH4:FS10000", "BAK_2030")
End Sub

