# Run desktop pytest suite.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run scripts\setup-desktop.ps1 first."
}

& $venvPython -m pytest (Join-Path $repo "desktop\tests") -v
