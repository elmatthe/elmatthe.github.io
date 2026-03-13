Public Function TRANSPOSE_MERGE_ID(rng As Range) As Variant
    Dim cell As Range
    Dim uniqueAreas As Object
    Dim areaKey As Variant
    Dim values() As Variant
    Dim i As Long
    
    Set uniqueAreas = CreateObject("Scripting.Dictionary")
    
    For Each cell In rng
        If cell.MergeCells Then
            areaKey = cell.MergeArea.Cells(1, 1).Address(False, False)
            If Not uniqueAreas.Exists(areaKey) Then
                uniqueAreas(areaKey) = cell.MergeArea.Cells(1, 1).Value
            End If
        Else
            areaKey = cell.Address(False, False)
            If Not uniqueAreas.Exists(areaKey) Then
                uniqueAreas(areaKey) = cell.Value
            End If
        End If  ' <- Required End If
    Next cell  ' <- Correct Next (only one)
    
    ReDim values(1 To uniqueAreas.Count)
    i = 0
    For Each areaKey In uniqueAreas.keys
        i = i + 1
        values(i) = uniqueAreas(areaKey)
    Next areaKey
    
    TRANSPOSE_MERGE_ID = Application.Transpose(values)
End Function

