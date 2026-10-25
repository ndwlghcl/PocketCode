# Launch the PocketCode Windows desktop app (management window + tray + LAN service).
param([switch]$Background)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $repo ".venv\Scripts\python.exe"

try {
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        throw "Virtual environment not found. Run scripts\setup-desktop.ps1 first."
    }

    if ($Background) {
        $localData = [Environment]::GetFolderPath('LocalApplicationData')
        $logDir = Join-Path $localData "PocketCode\logs"
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $launchId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), $PID
        $stdoutLog = Join-Path $logDir "desktop-$launchId.stdout.log"
        $stderrLog = Join-Path $logDir "desktop-$launchId.stderr.log"
        $appProcess = Start-Process -FilePath $venvPython -ArgumentList '-m', 'pocketcode.main' `
            -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        # Catch early import/startup failures; the management window reports service errors.
        if ($appProcess.WaitForExit(1500) -and $appProcess.ExitCode -ne 0) {
            throw "PocketCode exited with code $($appProcess.ExitCode). Startup log: $stderrLog"
        }
        Write-Host "PocketCode launched. Use its management window or system tray."
        Write-Host "Startup logs: $logDir"
        exit 0
    }

    Write-Host "Starting PocketCode desktop app ..."
    Push-Location -LiteralPath $repo
    try {
        & $venvPython -m pocketcode.main
        $appExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $appExit
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
