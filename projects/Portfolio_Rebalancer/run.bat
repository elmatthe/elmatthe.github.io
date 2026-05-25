@echo off
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo Virtual environment not found. Running setup first...
    call "%~dp0setup.bat"
    if %errorlevel% neq 0 exit /b 1
)

"%~dp0.venv\Scripts\python.exe" "%~dp0main.py"
if %errorlevel% neq 0 (
    echo.
    echo Program exited with an error.
    pause
)
