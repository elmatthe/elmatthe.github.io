Attribute VB_Name = "SummaryPrintMacros"
' ============================================================
'  SummaryPrintMacros.bas
'  Attach PrintMedicalSummary  -> "Print Medical Summary"  button (Sheet: MEDICAL)
'  Attach PrintDonationSummary -> "Print Donation Summary" button (Sheet: DONATIONS)
' ============================================================

Option Explicit

' ------------------------------------------------------------
'  Shared helper – does the actual PDF export work
'  sheetName   : exact tab name ("MEDICAL" or "DONATIONS")
'  printRange  : range address string  e.g. "A1:I30"
'  fileName    : output file name      e.g. "Summary_of_medical.pdf"
' ------------------------------------------------------------
Private Sub ExportSheetToPDF(sheetName As String, _
                              printRange As String, _
                              fileName As String)

    Dim ws          As Worksheet
    Dim savePath    As String
    Dim fullPath    As String
    Dim rng         As Range
    Dim pgW         As Double   ' page width  in inches (usable)
    Dim pgH         As Double   ' page height in inches (usable)
    Dim rngW        As Double   ' range width  in points
    Dim rngH        As Double   ' range height in points
    Dim usePortrait As Boolean
    Dim response    As VbMsgBoxResult

    ' --- Locate the worksheet ---
    On Error Resume Next
    Set ws = ThisWorkbook.Sheets(sheetName)
    On Error GoTo 0

    If ws Is Nothing Then
        MsgBox "Sheet """ & sheetName & """ was not found." & vbCrLf & _
               "Please make sure the tab is named exactly: " & sheetName, _
               vbCritical, "Sheet Not Found"
        Exit Sub
    End If

    ' --- Build the full output path (same folder as the workbook) ---
    savePath = ThisWorkbook.Path
    If Right(savePath, 1) <> "\" Then savePath = savePath & "\"
    fullPath = savePath & fileName

    ' --- Check for existing file and prompt if found ---
    If Dir(fullPath) <> "" Then
        response = MsgBox("A file named """ & fileName & """ already exists in:" & vbCrLf & _
                          savePath & vbCrLf & vbCrLf & _
                          "Do you want to replace it?", _
                          vbQuestion + vbYesNo, "File Already Exists")
        If response = vbNo Then
            MsgBox "Export cancelled. The existing file was not changed.", _
                   vbInformation, "Export Cancelled"
            Exit Sub
        End If
    End If

    ' --- Capture the target range ---
    On Error Resume Next
    Set rng = ws.Range(printRange)
    On Error GoTo 0

    If rng Is Nothing Then
        MsgBox "The print range """ & printRange & """ could not be resolved on sheet """ & sheetName & """.", _
               vbCritical, "Range Error"
        Exit Sub
    End If

    ' --- Measure the range (in points; 72 pts = 1 inch) ---
    Dim col As Range
    Dim row As Range
    rngW = 0
    rngH = 0

    For Each col In rng.Columns
        rngW = rngW + col.Width
    Next col

    For Each row In rng.Rows
        rngH = rngH + row.Height
    Next row

    ' --- Usable page area: Letter (8.5 x 11 in), 0.5 in margins each side ---
    '     Portrait  usable: 7.5 w  x 10.0 h  (in points: 540 x 720)
    '     Landscape usable: 10.0 w x 7.5  h  (in points: 720 x 540)
    Const PORTRAIT_W  As Double = 540    ' 7.5 in * 72
    Const PORTRAIT_H  As Double = 720    ' 10.0 in * 72
    Const LANDSCAPE_W As Double = 720
    Const LANDSCAPE_H As Double = 540

    ' Choose orientation that leaves the most white space (best fit)
    Dim scalePortrait  As Double
    Dim scaleLandscape As Double
    scalePortrait  = Application.Min(PORTRAIT_W / rngW,  PORTRAIT_H / rngH)
    scaleLandscape = Application.Min(LANDSCAPE_W / rngW, LANDSCAPE_H / rngH)
    usePortrait = (scalePortrait >= scaleLandscape)

    ' --- Configure the sheet page setup ---
    With ws.PageSetup
        .PrintArea = rng.Address
        .Zoom = False
        .FitToPagesWide = 1
        .FitToPagesTall = 1

        If usePortrait Then
            .Orientation = xlPortrait
        Else
            .Orientation = xlLandscape
        End If

        ' Tidy margins (0.5 in = 36 pts, but PageSetup uses inches)
        .TopMargin    = Application.InchesToPoints(0.5)
        .BottomMargin = Application.InchesToPoints(0.5)
        .LeftMargin   = Application.InchesToPoints(0.5)
        .RightMargin  = Application.InchesToPoints(0.5)
        .HeaderMargin = Application.InchesToPoints(0.25)
        .FooterMargin = Application.InchesToPoints(0.25)
        .CenterHorizontally = True
        .CenterVertically   = False
    End With

    ' --- Export to PDF ---
    On Error GoTo ExportError
    ws.ExportAsFixedFormat _
        Type:=xlTypePDF, _
        Filename:=fullPath, _
        Quality:=xlQualityStandard, _
        IncludeDocProperties:=False, _
        IgnorePrintAreas:=False, _
        OpenAfterPublish:=False

    MsgBox "PDF saved successfully:" & vbCrLf & fullPath, _
           vbInformation, "Export Complete"
    Exit Sub

ExportError:
    MsgBox "An error occurred while saving the PDF." & vbCrLf & vbCrLf & _
           "Error " & Err.Number & ": " & Err.Description & vbCrLf & vbCrLf & _
           "Make sure the file is not already open in a PDF viewer.", _
           vbCritical, "Export Failed"

End Sub


' ============================================================
'  PUBLIC – assign this to the button on the MEDICAL sheet
' ============================================================
Public Sub PrintMedicalSummary()
    Call ExportSheetToPDF( _
        sheetName  := "MEDICAL", _
        printRange := "A1:I30", _
        fileName   := "Summary_of_medical.pdf")
End Sub


' ============================================================
'  PUBLIC – assign this to the button on the DONATIONS sheet
' ============================================================
Public Sub PrintDonationSummary()
    Call ExportSheetToPDF( _
        sheetName  := "DONATIONS", _
        printRange := "A1:H30", _
        fileName   := "Summary_of_donations.pdf")
End Sub
