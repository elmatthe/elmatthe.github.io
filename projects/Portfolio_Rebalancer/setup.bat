@echo off
echo ============================================
echo   Portfolio Rebalancer - First Time Setup
echo ============================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not on PATH.
    echo.
    echo Download Python from: https://www.python.org/downloads/
    echo During install, check "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

echo Creating virtual environment...
python -m venv "%~dp0.venv"
if %errorlevel% neq 0 (
    echo ERROR: Failed to create virtual environment.
    pause
    exit /b 1
)

echo Upgrading pip...
"%~dp0.venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>&1

echo Installing dependencies...
"%~dp0.venv\Scripts\pip.exe" install -r "%~dp0requirements.txt"
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete!
echo   Double-click run.bat to start.
echo ============================================
pause
