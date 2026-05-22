Public Function BUBBLESORTUNIQUE(rng As Range) As Variant
    Dim dict As Object: Set dict = CreateObject("Scripting.Dictionary")
    Dim cell As Range, arr() As Variant, i As Long, j As Long, temp As Variant
    
    ' Step 1: Collect unique values only
    For Each cell In rng
        If Not dict.Exists(CStr(cell.Value)) And cell.Value <> "" Then
            dict.Add CStr(cell.Value), cell.Value
        End If
    Next cell
    
    ' Step 2: Convert to array
    ReDim arr(1 To dict.Count, 1 To 1)
    Dim k As Long: k = 1
    Dim keys: keys = dict.keys
    For Each key In keys
        arr(k, 1) = dict(key)
        k = k + 1
    Next key
    
    ' Step 3: Bubble sort unique array
    For i = 1 To UBound(arr, 1) - 1
        For j = i + 1 To UBound(arr, 1)
            If arr(i, 1) > arr(j, 1) Then
                temp = arr(i, 1)
                arr(i, 1) = arr(j, 1)
                arr(j, 1) = temp
            End If
        Next j
    Next i
    
    BUBBLESORTUNIQUE = arr
End Function

