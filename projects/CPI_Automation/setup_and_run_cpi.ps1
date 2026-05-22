# ============================================================
#  setup_and_run_cpi.ps1
#  Scans for Python + openpyxl + requests + python-dateutil,
#  shows a pop-up summary, downloads/installs anything missing,
#  then launches the CPI Dashboard Downloader GUI.
#  Called from Setup_and_Run_CPI.bat - not meant to be clicked directly.
# ============================================================

# --- Windows Forms for the popup dialogs ----------------------
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing       | Out-Null

# Note: we intentionally leave $ErrorActionPreference at its default ('Continue').
# Setting it to 'Stop' globally causes PowerShell to treat ANY stderr output from
# a native command (py.exe, pip, etc.) as a terminating error - which breaks
# "is this module installed?" probes that rely on Python printing a traceback.

# --- Config ---------------------------------------------------
# Using the latest Python 3.13 maintenance release (has binary installers).
# If this URL ever 404s, bump the version below.
$PythonVersion   = '3.13.12'
$PythonInstaller = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PyScript  = Join-Path $ScriptDir 'cpi_dashboard_downloader-v1.6.py'
$AppTitle  = 'CPI Dashboard Downloader'

# --- Helpers --------------------------------------------------
function Show-Info    ($title, $body) { [System.Windows.Forms.MessageBox]::Show($body, $title, 'OK',    'Information') | Out-Null }
function Show-Warning ($title, $body) { [System.Windows.Forms.MessageBox]::Show($body, $title, 'OK',    'Warning')     | Out-Null }
function Show-Error   ($title, $body) { [System.Windows.Forms.MessageBox]::Show($body, $title, 'OK',    'Error')       | Out-Null }
function Ask-YesNo    ($title, $body) {
    $r = [System.Windows.Forms.MessageBox]::Show($body, $title, 'YesNo', 'Question')
    return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Write-Step($msg) {
    Write-Host ""
    Write-Host ">> $msg" -ForegroundColor Cyan
}

# --- Find Python ----------------------------------------------
function Find-Python {
    # Prefer the 'py' launcher (it can pick the right Python 3.x)
    if (Get-Command py -ErrorAction SilentlyContinue) {
        $v = & py -3 --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            return @{ cmd = 'py'; gui = 'pyw'; baseArgs = @('-3'); version = "$v".Trim() }
        }
    }
    # Fallback to plain 'python'
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $v = & python --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            return @{ cmd = 'python'; gui = 'pythonw'; baseArgs = @(); version = "$v".Trim() }
        }
    }
    return $null
}

function Test-PyImport ($pyInfo, $moduleName) {
    $allArgs = $pyInfo.baseArgs + @('-c', "import $moduleName")
    # 2>&1 | Out-Null swallows both stdout and stderr (e.g. ModuleNotFoundError
    # tracebacks) without raising a NativeCommandError. We rely on $LASTEXITCODE.
    & $pyInfo.cmd @allArgs 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Install-PyPackage ($pyInfo, $packageName) {
    Write-Step "Installing $packageName ..."
    $allArgs = $pyInfo.baseArgs + @('-m', 'pip', 'install', '--user', '--upgrade', $packageName)
    & $pyInfo.cmd @allArgs
    return ($LASTEXITCODE -eq 0)
}

function Refresh-PathFromRegistry {
    # After installing Python, make the current PowerShell session see the new PATH
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# ============================================================
#  Verify the Python script is actually sitting next to us
# ============================================================
if (-not (Test-Path $PyScript)) {
    Show-Error $AppTitle @"
Can't find the application script.

Expected this file next to the installer:
    cpi_dashboard_downloader-v1.6.py

Please put all files in the same folder and try again.
"@
    exit 1
}

# ============================================================
#  STAGE 1 - scan the system
# ============================================================
Write-Step "Scanning this computer for Python and required libraries ..."

$pythonInfo     = Find-Python
$hasPython      = $pythonInfo -ne $null

$hasOpenpyxl    = $false
$hasRequests    = $false
$hasDateutil    = $false

if ($hasPython) {
    $hasOpenpyxl = Test-PyImport $pythonInfo 'openpyxl'
    $hasRequests = Test-PyImport $pythonInfo 'requests'
    $hasDateutil = Test-PyImport $pythonInfo 'dateutil'   # python-dateutil imports as 'dateutil'
}

$installedLines = @()
$toInstallLines = @()

if ($hasPython) {
    $installedLines += "    [OK]  Python  ($($pythonInfo.version))"
} else {
    $toInstallLines += "    [  ]  Python $PythonVersion  (official installer, ~25 MB)"
}

if ($hasOpenpyxl) {
    $installedLines += "    [OK]  openpyxl       (reads and writes Excel files)"
} else {
    $toInstallLines += "    [  ]  openpyxl       (reads and writes Excel files)"
}

if ($hasRequests) {
    $installedLines += "    [OK]  requests       (fetches data from Statistics Canada and FRED)"
} else {
    $toInstallLines += "    [  ]  requests       (fetches data from Statistics Canada and FRED)"
}

if ($hasDateutil) {
    $installedLines += "    [OK]  python-dateutil  (date parsing and arithmetic)"
} else {
    $toInstallLines += "    [  ]  python-dateutil  (date parsing and arithmetic)"
}

# ============================================================
#  STAGE 2 - tell the user what we found
# ============================================================
if ($toInstallLines.Count -eq 0) {
    # Nothing to do - everything is already here
    $msg = @"
Great news - everything needed to run $AppTitle is already installed on this computer:

$($installedLines -join "`r`n")

Click OK to launch the application.
"@
    Show-Info "$AppTitle - System check" $msg
} else {
    # We need to install something - ask first
    $alreadyBlock = if ($installedLines.Count -gt 0) {
        "Already installed on this computer:`r`n$($installedLines -join "`r`n")"
    } else {
        "Nothing related is currently installed on this computer."
    }
    $toInstallBlock = $toInstallLines -join "`r`n"

    $msg = @"
System scan complete.

$alreadyBlock

Will be downloaded and installed:
$toInstallBlock

Installation is per-user, so no administrator password is needed.
Python packages install into your user profile.

Do you want to continue?
"@

    if (-not (Ask-YesNo "$AppTitle - System check" $msg)) {
        Write-Host "User cancelled installation. Exiting." -ForegroundColor Yellow
        exit 0
    }

    # --------------------------------------------------------
    #  STAGE 3 - install what's missing
    # --------------------------------------------------------
    $justInstalled = @()
    $installFailed = @()

    # ---- Python ----
    if (-not $hasPython) {
        $installerPath = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"

        Write-Step "Downloading Python $PythonVersion installer ..."
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $PythonInstaller -OutFile $installerPath -UseBasicParsing -ErrorAction Stop
        } catch {
            Show-Error "$AppTitle - Download failed" @"
Couldn't download the Python installer from:
$PythonInstaller

Error:
$($_.Exception.Message)

Please check your internet connection and try again.
"@
            exit 1
        }

        Write-Step "Running Python installer silently ..."
        # User-scope install, add to PATH, include tcl/tk (for tkinter), pip, and the py launcher
        $installArgs = @(
            '/quiet',
            'InstallAllUsers=0',
            'PrependPath=1',
            'Include_tcltk=1',
            'Include_pip=1',
            'Include_launcher=1'
        )
        $p = Start-Process -FilePath $installerPath -ArgumentList $installArgs -Wait -PassThru
        Remove-Item $installerPath -ErrorAction SilentlyContinue

        if ($p.ExitCode -ne 0) {
            Show-Error "$AppTitle - Install failed" "The Python installer exited with code $($p.ExitCode)."
            exit 1
        }

        Refresh-PathFromRegistry
        $pythonInfo = Find-Python
        if (-not $pythonInfo) {
            Show-Error "$AppTitle - Install failed" @"
Python installed but couldn't be located in PATH.

Please reboot the computer and run this installer again.
"@
            exit 1
        }

        $justInstalled += "    [OK]  Python  ($($pythonInfo.version))"
    }

    # ---- pip quick self-upgrade (best effort, non-fatal) ----
    Write-Step "Checking pip ..."
    $upgradeArgs = $pythonInfo.baseArgs + @('-m', 'pip', 'install', '--user', '--upgrade', 'pip')
    & $pythonInfo.cmd @upgradeArgs 2>&1 | Out-Null

    # ---- openpyxl ----
    if (-not $hasOpenpyxl) {
        if (Install-PyPackage $pythonInfo 'openpyxl') {
            $justInstalled += "    [OK]  openpyxl       (reads and writes Excel files)"
        } else {
            $installFailed += "    [!!]  openpyxl  - install failed"
        }
    }

    # ---- requests ----
    if (-not $hasRequests) {
        if (Install-PyPackage $pythonInfo 'requests') {
            $justInstalled += "    [OK]  requests       (fetches data from Statistics Canada and FRED)"
        } else {
            $installFailed += "    [!!]  requests  - install failed"
        }
    }

    # ---- python-dateutil ----
    if (-not $hasDateutil) {
        if (Install-PyPackage $pythonInfo 'python-dateutil') {
            $justInstalled += "    [OK]  python-dateutil  (date parsing and arithmetic)"
        } else {
            $installFailed += "    [!!]  python-dateutil  - install failed"
        }
    }

    # --- Re-check: make sure the critical libraries are actually importable now ---
    $finalHasOpenpyxl = Test-PyImport $pythonInfo 'openpyxl'
    $finalHasRequests = Test-PyImport $pythonInfo 'requests'
    $finalHasDateutil = Test-PyImport $pythonInfo 'dateutil'

    if (-not ($finalHasOpenpyxl -and $finalHasRequests -and $finalHasDateutil)) {
        $missing = @()
        if (-not $finalHasOpenpyxl) { $missing += 'openpyxl' }
        if (-not $finalHasRequests) { $missing += 'requests' }
        if (-not $finalHasDateutil) { $missing += 'python-dateutil' }
        Show-Error "$AppTitle - Install failed" @"
The following required libraries could not be installed:
    $($missing -join ', ')

$AppTitle needs all three libraries to run.

You can try installing them manually in a command prompt:
    py -m pip install openpyxl requests python-dateutil

Or check your internet connection / antivirus and try again.
"@
        exit 1
    }

    # --------------------------------------------------------
    #  STAGE 4 - confirmation popup
    # --------------------------------------------------------
    $summary = "Setup complete.`r`n`r`n"
    if ($justInstalled.Count -gt 0) {
        $summary += "Installed just now:`r`n$($justInstalled -join "`r`n")`r`n`r`n"
    }
    if ($installFailed.Count -gt 0) {
        $summary += "Failed to install (the app may not work correctly):`r`n$($installFailed -join "`r`n")`r`n`r`n"
    }
    $summary += "Click OK to launch $AppTitle."

    Show-Info "$AppTitle - Setup complete" $summary
}

# ============================================================
#  STAGE 5 - launch the GUI app (windowless Python variant so
#            no console window flashes behind the GUI)
# ============================================================
Write-Step "Launching $AppTitle ..."

$launchCmd  = $pythonInfo.gui       # 'pyw' or 'pythonw'
$launchArgs = $pythonInfo.baseArgs + @("`"$PyScript`"")

try {
    Start-Process -FilePath $launchCmd -ArgumentList $launchArgs -WorkingDirectory $ScriptDir -ErrorAction Stop
} catch {
    # Fall back to the console variant if pyw/pythonw somehow isn't there
    try {
        $fallbackArgs = $pythonInfo.baseArgs + @("`"$PyScript`"")
        Start-Process -FilePath $pythonInfo.cmd -ArgumentList $fallbackArgs -WorkingDirectory $ScriptDir -ErrorAction Stop
    } catch {
        Show-Error "$AppTitle - Launch failed" @"
Couldn't start the application.

Error:
$($_.Exception.Message)
"@
        exit 1
    }
}

Write-Host ""
Write-Host "Done. You can close this window." -ForegroundColor Green
exit 0
