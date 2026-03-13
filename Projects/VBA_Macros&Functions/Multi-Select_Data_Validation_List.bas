Option Explicit
Private Sub Worksheet_Change(ByVal Destination As Range)
Dim rngDropdown As Range
Dim oldValue As String
Dim newValue As String
Dim DelimiterType As String
DelimiterType = ", "
Dim DelimiterCount As Integer
Dim TargetType As Integer
Dim i As Integer
Dim arr() As String
 
If Destination.Count > 1 Then Exit Sub
On Error Resume Next
 
Set rngDropdown = Cells.SpecialCells(xlCellTypeAllValidation)
On Error GoTo exitError
 
If rngDropdown Is Nothing Then GoTo exitError
 
TargetType = 0
    TargetType = Destination.Validation.Type
    If TargetType = 3 Then  ' is validation type is "list"
        Application.ScreenUpdating = False
        Application.EnableEvents = False
        newValue = Destination.Value
        Application.Undo
        oldValue = Destination.Value
        Destination.Value = newValue
        If oldValue <> "" Then
            If newValue <> "" Then
                If oldValue = newValue Or oldValue = newValue & Replace(DelimiterType, " ", "") Or oldValue = newValue & DelimiterType Then ' leave the value if there is only one in the list
                    oldValue = Replace(oldValue, DelimiterType, "")
                    oldValue = Replace(oldValue, Replace(DelimiterType, " ", ""), "")
                    Destination.Value = oldValue
                ElseIf InStr(1, oldValue, DelimiterType & newValue) Or InStr(1, oldValue, newValue & DelimiterType) Or InStr(1, oldValue, DelimiterType & newValue & DelimiterType) Then
                    arr = Split(oldValue, DelimiterType)
                If Not IsError(Application.Match(newValue, arr, 0)) = 0 Then
                    Destination.Value = oldValue & DelimiterType & newValue
                        Else:
                    Destination.Value = ""
                    For i = 0 To UBound(arr)
                    If arr(i) <> newValue Then
                        Destination.Value = Destination.Value & arr(i) & DelimiterType
                    End If
                    Next i
                Destination.Value = Left(Destination.Value, Len(Destination.Value) - Len(DelimiterType))
                End If
                ElseIf InStr(1, oldValue, newValue & Replace(DelimiterType, " ", "")) Then
                    oldValue = Replace(oldValue, newValue, "")
                    Destination.Value = oldValue
                Else
                    Destination.Value = oldValue & DelimiterType & newValue
                End If
                Destination.Value = Replace(Destination.Value, Replace(DelimiterType, " ", "") & Replace(DelimiterType, " ", ""), Replace(DelimiterType, " ", "")) ' remove extra commas and spaces
                Destination.Value = Replace(Destination.Value, DelimiterType & Replace(DelimiterType, " ", ""), Replace(DelimiterType, " ", ""))
                If Destination.Value <> "" Then
                    If Right(Destination.Value, 2) = DelimiterType Then  ' remove delimiter at the end
                        Destination.Value = Left(Destination.Value, Len(Destination.Value) - 2)
                    End If
                End If
                If InStr(1, Destination.Value, DelimiterType) = 1 Then ' remove delimiter as first characters
                    Destination.Value = Replace(Destination.Value, DelimiterType, "", 1, 1)
                End If
                If InStr(1, Destination.Value, Replace(DelimiterType, " ", "")) = 1 Then
                    Destination.Value = Replace(Destination.Value, Replace(DelimiterType, " ", ""), "", 1, 1)
                End If
                DelimiterCount = 0
                For i = 1 To Len(Destination.Value)
                    If InStr(i, Destination.Value, Replace(DelimiterType, " ", "")) Then
                        DelimiterCount = DelimiterCount + 1
                    End If
                Next i
                If DelimiterCount = 1 Then ' remove delimiter if last character
                    Destination.Value = Replace(Destination.Value, DelimiterType, "")
                    Destination.Value = Replace(Destination.Value, Replace(DelimiterType, " ", ""), "")
                End If
            End If
        End If
        Application.EnableEvents = True
        Application.ScreenUpdating = True
    End If
 
exitError:
  Application.EnableEvents = True
End Sub
 
Private Sub Worksheet_SelectionChange(ByVal Target As Range)
 
End Sub
