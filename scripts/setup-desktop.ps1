# PocketCode desktop setup: create .venv and install desktop package + dev tools.
# Usage: right-click -> Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File scripts\setup-desktop.ps1
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $repo ".venv"
$venvPython = Join-Path $venv "Scripts\python.exe"

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error "Python not found on PATH. Install Python 3.11+ from https://www.python.org/downloads/"
}
Write-Host "Using Python: $(& python --version 2>&1)"

if (-not (Test-Path $venvPython)) {
    Write-Host "Creating virtual environment at $venv ..."
    python -m venv $venv
}

& $venvPython -m pip install --upgrade pip --quiet
Write-Host "Installing desktop package (editable) + dev dependencies ..."
& $venvPython -m pip install -e "$repo\desktop[dev]"

Write-Host ""
Write-Host "Desktop setup done."
Write-Host "Next: scripts\start-desktop.ps1 to launch the app, scripts\test-desktop.ps1 to run tests."
