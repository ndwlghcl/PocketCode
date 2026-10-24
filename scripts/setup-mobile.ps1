# Mobile web build + Capacitor android project bootstrap.
# 1) npm install  2) vite build (web assets)  3) cap add android (first run)  4) cap sync
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $repo "mobile"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found on PATH. Install Node.js 20+ from https://nodejs.org/"
}
Write-Host "Using Node: $(& node --version)"

Push-Location $mobile
try {
    Write-Host "Installing npm dependencies ..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed" }

    Write-Host "Building web assets (tsc + vite) ..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Error "web build failed" }

    if (-not (Test-Path (Join-Path $mobile "android"))) {
        Write-Host "Generating Capacitor android project (first run only) ..."
        npx cap add android
        if ($LASTEXITCODE -ne 0) { Write-Error "cap add android failed" }
    }

    Write-Host "Syncing web assets into android project ..."
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { Write-Error "cap sync failed" }

    Write-Host ""
    Write-Host "Mobile web build + android project ready."
    Write-Host "Next: scripts\build-apk.ps1 to build the debug APK (requires JDK 17+ and Android SDK)."
}
finally {
    Pop-Location
}
