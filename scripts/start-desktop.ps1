# Launch the PocketCode Windows desktop app (management window + tray + LAN service).
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run scripts\setup-desktop.ps1 first."
}

Write-Host "Starting PocketCode desktop app ..."
& $venvPython -m pocketcode.main
