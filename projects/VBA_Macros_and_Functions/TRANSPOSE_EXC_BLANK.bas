Public Function TRANSPOSE_EXC_BLANK(rng As Range) As Variant
    Dim cell As Range
    Dim nonBlanks() As Variant
    Dim i As Long
    ReDim nonBlanks(1 To rng.Cells.Count)
    i = 0
    
    For Each cell In rng
        If Not IsEmpty(cell.Value) And Trim(CStr(cell.Value)) <> "" Then
            i = i + 1
            nonBlanks(i) = cell.Value
        End If
    Next cell
    
    If i = 0 Then
        TRANSPOSE_EXC_BLANK = CVErr(xlErrNA)
        Exit Function
    End If
    
    ReDim Preserve nonBlanks(1 To i)
    TRANSPOSE_EXC_BLANK = Application.Transpose(nonBlanks)
End Function

