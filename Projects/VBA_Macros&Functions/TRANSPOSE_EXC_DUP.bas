Public Function TRANSPOSE_EXC_DUP(rng As Range) As Variant
    Dim cell As Range
    Dim uniques As Object
    Dim values() As Variant
    Dim i As Long
    Dim val As String
    
    Set uniques = CreateObject("Scripting.Dictionary")
    
    For Each cell In rng
        val = Trim(CStr(cell.Value))
        If val <> "" And Not uniques.Exists(val) Then
            uniques(val) = True
        End If
    Next cell
    
    If uniques.Count = 0 Then
        TRANSPOSE_EXC_DUP = CVErr(xlErrNA)
        Exit Function
    End If
    
    ReDim values(1 To uniques.Count)
    i = 0
    Dim key As Variant
    For Each key In uniques.keys
        i = i + 1
        values(i) = key
    Next key
    
    TRANSPOSE_EXC_DUP = Application.Transpose(values)
End Function

