' =============================================================
' SIMILAR_ID Custom Excel Function
' =============================================================
' Usage: =SIMILAR_ID(cell, keyword1, keyword2, ..., match_return, no_match_return)
'
' - cell            : The cell whose text you want to search
' - keyword1...N    : One or more search strings (min 2 chars, ignores single chars/symbols)
' - match_return    : Value to return when a keyword IS found
' - no_match_return : Value to return when NO keyword is found
'
' Example: =SIMILAR_ID(A1, "red", "blue", "green", "Hello", "No Match")
'   -> If A1 contains "red" anywhere, returns "Hello", else "No Match"
' =============================================================

Function SIMILAR_ID(cell As Range, ParamArray args() As Variant) As Variant
    Dim cellText      As String
    Dim keyword       As String
    Dim matchReturn   As Variant
    Dim noMatchReturn As Variant
    Dim i             As Integer
    Dim c             As Integer
    Dim lastIdx       As Integer
    Dim cleanedWord   As String

    ' Need at least 2 args: one keyword + match + no_match = 3 minimum
    If UBound(args) < 2 Then
        SIMILAR_ID = CVErr(xlErrValue)
        Exit Function
    End If

    lastIdx = UBound(args)

    ' Last two args are the return values
    matchReturn = args(lastIdx - 1)
    noMatchReturn = args(lastIdx)

    ' Cell text — case-insensitive comparison
    cellText = LCase(CStr(cell.Value))

    ' Loop through search keywords (all args except last two)
    For i = 0 To lastIdx - 2
        keyword = Trim(CStr(args(i)))

        ' Skip single-character strings and pure punctuation/symbols
        If Len(keyword) < 2 Then GoTo NextKeyword
        cleanedWord = ""
        For c = 1 To Len(keyword)
            If Mid(keyword, c, 1) Like "[A-Za-z0-9]" Then
                cleanedWord = cleanedWord & Mid(keyword, c, 1)
            End If
        Next c
        If Len(cleanedWord) < 2 Then GoTo NextKeyword

        ' Check if keyword appears in cell text
        If InStr(1, cellText, LCase(keyword), vbTextCompare) > 0 Then
            SIMILAR_ID = matchReturn
            Exit Function
        End If

NextKeyword:
    Next i

    ' No match found
    SIMILAR_ID = noMatchReturn
End Function

