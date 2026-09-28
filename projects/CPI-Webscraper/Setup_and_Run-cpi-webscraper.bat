@echo off
setlocal EnableExtensions DisableDelayedExpansion
title CPI-Webscraper - Setup and Run
cd /d "%~dp0"
echo CPI-Webscraper 0.3.0 - Assess and reconcile setup
set "CPI_PYTHON="
call :discover
if defined CPI_PYTHON goto :launch
echo A stable Python 3.11-3.14 installation is required.
set /p "CPI_INSTALL=Install Python 3.14 for this user account? (Y/N): "
if /i not "%CPI_INSTALL%"=="Y" goto :failure
winget install --id Python.Python.3.14 --exact --scope user --source winget --accept-package-agreements --accept-source-agreements --override "/quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0"
if errorlevel 1 goto :failure
call :discover
if not defined CPI_PYTHON goto :failure
:launch
"%CPI_PYTHON%" "%~dp0scripts\bootstrap.py" %*
set "CPI_RC=%ERRORLEVEL%"
if not "%CPI_RC%"=="0" echo CPI-Webscraper setup or application failed. See the message above.
goto :finish
:failure
echo Setup could not locate or provision supported Python. Check Python installation and user permissions.
set "CPI_RC=1"
:finish
if /i not "%~1"=="--check-only" pause
exit /b %CPI_RC%
:discover
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$candidates = @(); foreach ($minor in 14,13,12,11) { $p = & py ('-3.' + $minor) -c 'import sys; print(sys.executable)' 2>$null; if ($LASTEXITCODE -eq 0) { $candidates += $p }; $candidates += (Join-Path $env:LOCALAPPDATA ('Programs\Python\Python3' + $minor + '\python.exe')) }; $candidates += @(Get-Command python -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source); $valid = foreach ($p in ($candidates | Select-Object -Unique)) { if ($p -and $p -notlike '*WindowsApps*' -and (Test-Path -LiteralPath $p)) { $v = & $p -I -c 'import sys,tkinter,venv; assert (3,11) <= sys.version_info[:2] <= (3,14) and sys.version_info.releaselevel == str().join(map(chr,[102,105,110,97,108])); print(sys.version_info.minor)' 2>$null; if ($LASTEXITCODE -eq 0) { [pscustomobject]@{Path=$p;Minor=[int]$v} } } }; $valid | Sort-Object Minor -Descending | Select-Object -First 1 -ExpandProperty Path"`) do set "CPI_PYTHON=%%P"
exit /b 0
