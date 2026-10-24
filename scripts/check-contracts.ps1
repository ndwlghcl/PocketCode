# Validate contracts/openapi.yaml, fixtures, and backend implementation alignment.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run scripts\setup-desktop.ps1 first."
}

& $venvPython (Join-Path $repo "integration-tests\contract\check_contracts.py")
exit $LASTEXITCODE
