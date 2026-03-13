Public Function BUBBLESORT(rng As Range) As Variant
    Dim arr As Variant
    Dim i As Long, j As Long, temp As Variant
    Dim result() As Variant
    
    arr = rng.Value
    ReDim result(1 To UBound(arr, 1), 1 To 1)
    
    Dim k As Long
    For k = 1 To UBound(arr, 1)
        result(k, 1) = arr(k, 1)
    Next k
    
    For i = 1 To UBound(result, 1) - 1
        For j = i + 1 To UBound(result, 1)
            If result(i, 1) > result(j, 1) Then
                temp = result(i, 1)
                result(i, 1) = result(j, 1)
                result(j, 1) = temp
            End If
        Next j
    Next i
    
    BUBBLESORT = result
End Function

