@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ========================================
echo   Stock Comparison ^& Analytics Tool v0.2.5
echo ========================================
echo.
echo   This window sets up and launches the program.
echo   Setup keeps dependencies inside this project folder.
echo.

set "PYTHON_VERSION=3.11"
set "REQUIREMENTS=scripts\requirements.txt"
set "MAIN_SCRIPT=scripts\main.py"
set "VENV_PYTHON=.venv\Scripts\python.exe"
if not exist ".run-temp\" mkdir ".run-temp"
set "TEMP=%CD%\.run-temp"
set "TMP=%TEMP%"

echo Checking for Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Python is required but was not found.
    echo   Install Python from https://www.python.org/downloads/
    echo   Make sure to check "Add python.exe to PATH".
    echo.
    pause
    exit /b 1
)

echo Setting up virtual environment...
if not exist ".venv\" (
    python -m venv .venv
    if %errorlevel% neq 0 if not exist "%VENV_PYTHON%" (
        echo   Failed to create virtual environment.
        pause
        exit /b 1
    )
)

if not exist "%VENV_PYTHON%" (
    echo   ERROR: Virtual environment Python was not found.
    pause
    exit /b 1
)

if exist "%REQUIREMENTS%" (
    echo Installing dependencies into the project environment...
    py -m pip --python .venv install --disable-pip-version-check --no-cache-dir -r "%REQUIREMENTS%"
    if %errorlevel% neq 0 (
        echo.
        echo   Dependency installation failed.
        pause
        exit /b 1
    )
) else (
    echo   ERROR: Requirements file not found: %REQUIREMENTS%
    pause
    exit /b 1
)

echo.
echo Launching application...
echo.

if /i "%STOCK_TOOL_SETUP_ONLY%"=="1" (
    echo Setup-only mode requested. Skipping GUI launch.
    endlocal
    exit /b 0
)

if exist "%MAIN_SCRIPT%" (
    "%VENV_PYTHON%" "%MAIN_SCRIPT%"
) else (
    echo   ERROR: Main script not found: %MAIN_SCRIPT%
    pause
    exit /b 1
)

echo.
echo Program finished.
pause
endlocal
