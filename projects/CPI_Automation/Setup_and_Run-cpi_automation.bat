@echo off
setlocal EnableExtensions EnableDelayedExpansion
title CPI Dashboard Downloader - Setup and Run
cd /d "%~dp0"

echo ============================================================
echo  CPI Dashboard Downloader - Setup and Run
echo ============================================================
echo.
echo  First time running this? Windows may show a blue "Windows
echo  protected your PC" warning because this file isn't signed.
echo  That's normal for an unsigned script - click "More info",
echo  then "Run anyway" to continue. This only happens once.
echo.
echo  This window stays open so you can see what's happening.
echo  Setup keeps everything inside this project folder. The only
echo  thing ever installed onto your PC is Python itself, and only
echo  if it isn't already there - you'll be asked first.
echo.

set "SCRIPT_REL=scripts\cpi_dashboard_downloader-v0.2.0.py"
set "REQS_REL=scripts\requirements.txt"
set "RC=0"

if not exist "%~dp0%SCRIPT_REL%" (
    echo ERROR: Could not find "%SCRIPT_REL%" next to this batch file.
    echo Please make sure the "scripts" folder is intact.
    set "RC=1"
    goto :end_pause
)

if not exist "%~dp0%REQS_REL%" (
    echo ERROR: Could not find "%REQS_REL%" next to this batch file.
    set "RC=1"
    goto :end_pause
)

REM ----------------------------------------------------------
REM  Find a real Python install. The "py" launcher is the most
REM  reliable signal - plain "python" can be a Windows Store stub
REM  that doesn't actually run Python.
REM ----------------------------------------------------------
set "PYCMD="

py --version >nul 2>&1
if !errorlevel!==0 set "PYCMD=py"

if not defined PYCMD (
    for /f "delims=" %%P in ('where python 2^>nul') do (
        echo %%P | findstr /i "WindowsApps" >nul
        if errorlevel 1 if not defined PYCMD set "PYCMD=python"
    )
)

if not defined PYCMD (
    echo.
    echo  Python was not found on this PC.
    echo.
    echo  Python is required to run this program. It can be installed
    echo  just for your user account - no admin rights and no IT
    echo  password needed.
    echo.
    set /p "INSTALL_PY=  Install Python now? (Y/N): "
    if /i not "!INSTALL_PY!"=="Y" (
        echo.
        echo  Setup can't continue without Python. You can install it
        echo  yourself anytime at https://www.python.org/downloads/
        echo  ^(check "Add Python to PATH" during install^), then run
        echo  this file again.
        set "RC=1"
        goto :end_pause
    )

    where winget >nul 2>&1
    if not !errorlevel!==0 (
        echo.
        echo  winget ^(the Windows package installer^) isn't available on
        echo  this PC, so Python can't be installed automatically.
        echo  Please install it manually from:
        echo      https://www.python.org/downloads/
        echo  ^(check "Add Python to PATH" during install^), then run
        echo  this file again.
        set "RC=1"
        goto :end_pause
    )

    echo.
    echo  Installing Python for your user account only - this does NOT
    echo  require admin rights and does not affect other users...
    winget install --id Python.Python.3.12 --scope user --source winget --accept-package-agreements --accept-source-agreements
    if not !errorlevel!==0 (
        echo.
        echo  The automatic install didn't succeed. Please install Python
        echo  manually from https://www.python.org/downloads/ ^(check
        echo  "Add Python to PATH"^), then run this file again.
        set "RC=1"
        goto :end_pause
    )

    echo.
    echo  Python was installed. Please close this window and double-click
    echo  this file again so Windows can pick up the new install.
    goto :end_pause
)

echo  Found Python:
!PYCMD! --version

REM ----------------------------------------------------------
REM  Create the virtual environment (first run only)
REM ----------------------------------------------------------
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo.
    echo  Setting up a private Python environment in ".venv"...
    !PYCMD! -m venv "%~dp0.venv"
    if not exist "%~dp0.venv\Scripts\python.exe" (
        echo ERROR: Failed to create the virtual environment.
        set "RC=1"
        goto :end_pause
    )
)

set "VENV_PY=%~dp0.venv\Scripts\python.exe"

REM ----------------------------------------------------------
REM  Install required libraries into the venv
REM ----------------------------------------------------------
echo.
echo  Checking required libraries...
"%VENV_PY%" -m pip install --quiet --disable-pip-version-check --upgrade pip
"%VENV_PY%" -m pip install --quiet --disable-pip-version-check -r "%~dp0%REQS_REL%"
if not !errorlevel!==0 (
    echo ERROR: Failed to install required libraries.
    set "RC=1"
    goto :end_pause
)

REM ----------------------------------------------------------
REM  Launch the program
REM ----------------------------------------------------------
echo.
echo  Starting CPI Dashboard Downloader...
echo.
"%VENV_PY%" "%~dp0%SCRIPT_REL%"
set "RC=!errorlevel!"

if not "!RC!"=="0" (
    echo.
    echo  The program exited with an error ^(code !RC!^).
)

:end_pause
echo.
echo ------------------------------------------------------------
echo Press any key to close this window . . .
pause >nul
exit /b %RC%
