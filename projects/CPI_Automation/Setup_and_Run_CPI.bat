@echo off
REM ============================================================
REM  CPI Dashboard Downloader - Setup and Run
REM
REM  Double-click this file. It will:
REM    1. Scan this PC for Python + required libraries
REM    2. Pop up a window showing what's already installed
REM       and what (if anything) needs to be downloaded
REM    3. Ask before downloading anything
REM    4. Install whatever is missing
REM    5. Pop up a confirmation of what was installed
REM    6. Launch cpi_dashboard_downloader-v1.6.py
REM
REM  Keep this file in the same folder as:
REM      - cpi_dashboard_downloader-v1.6.py
REM      - setup_and_run_cpi.ps1
REM ============================================================

setlocal
title CPI Dashboard Downloader - Setup

REM Jump to the folder this batch file lives in
cd /d "%~dp0"

REM Sanity check: make sure the PowerShell helper is next to us
if not exist "%~dp0setup_and_run_cpi.ps1" (
    echo.
    echo ERROR: setup_and_run_cpi.ps1 was not found next to this batch file.
    goto :missing
)

REM Sanity check: make sure the Python script is next to us
if not exist "%~dp0cpi_dashboard_downloader-v1.6.py" (
    echo.
    echo ERROR: cpi_dashboard_downloader-v1.6.py was not found next to this batch file.
    goto :missing
)

REM Hand off to PowerShell (bypass the execution policy just for this run)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_and_run_cpi.ps1"
set "RC=%ERRORLEVEL%"

REM If something went wrong, keep the window open so the user can read it
if not "%RC%"=="0" (
    echo.
    echo Exited with code %RC%.
    pause
)

endlocal
exit /b %RC%

:missing
echo.
echo Please make sure these three files are all in the same folder:
echo    - Setup_and_Run_CPI.bat
echo    - setup_and_run_cpi.ps1
echo    - cpi_dashboard_downloader-v1.6.py
echo.
pause
endlocal
exit /b 1
