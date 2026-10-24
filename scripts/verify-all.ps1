# Run every check that works on this machine: contract validation + desktop tests + mobile build/test.
# Skips a section with a clear message when its toolchain is missing.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$failed = $false

Write-Host "=== 1/3 Contracts ==="
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check-contracts.ps1")
if ($LASTEXITCODE -ne 0) { $failed = $true }

Write-Host ""
Write-Host "=== 2/3 Desktop tests ==="
$venvPython = Join-Path $repo ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    & $venvPython -m pytest (Join-Path $repo "desktop\tests") -v
    if ($LASTEXITCODE -ne 0) { $failed = $true }
}
else {
    Write-Host "[SKIP] .venv missing - run scripts\setup-desktop.ps1"
}

Write-Host ""
Write-Host "=== 3/3 Mobile ==="
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Push-Location (Join-Path $repo "mobile")
    try {
        if (-not (Test-Path "node_modules")) { npm install }
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { $failed = $true }
        npm test
        if ($LASTEXITCODE -ne 0) { $failed = $true }
        npm run build
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
    finally { Pop-Location }
}
else {
    Write-Host "[SKIP] Node.js not found"
}

Write-Host ""
if ($failed) {
    Write-Host "verify-all: FAILED (see output above)"
    exit 1
}
Write-Host "verify-all: ALL CHECKS PASSED"
