Sub AutoFitSelectedCells()
    Dim cell As Range
    
    For Each cell In Selection
        ' Enable text wrapping so text stacks into lines
        cell.WrapText = True
        
        ' Auto fit the row height to match the wrapped text
        cell.Rows.AutoFit
    Next cell

End Sub
