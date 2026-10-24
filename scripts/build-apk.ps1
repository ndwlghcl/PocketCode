# Build the Android debug APK (mobile\android\app\build\outputs\apk\debug\app-debug.apk).
# Requires: JDK 17+ (JAVA_HOME), Android SDK (ANDROID_HOME or %LOCALAPPDATA%\Android\Sdk),
# and scripts\setup-mobile.ps1 already executed once.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $repo "mobile\android"

if (-not (Test-Path $androidDir)) {
    Write-Error "mobile\android not found. Run scripts\setup-mobile.ps1 first."
}

# Locate Android SDK
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $sdk)) {
    Write-Error ("Android SDK not found. Set ANDROID_HOME or install SDK at " + (Join-Path $env:LOCALAPPDATA "Android\Sdk"))
}

# local.properties (machine-specific, git-ignored)
$localProps = Join-Path $androidDir "local.properties"
if (-not (Test-Path $localProps)) {
    $sdkDir = $sdk -replace '\\', '/'
    Set-Content -Path $localProps -Value "sdk.dir=$sdkDir" -Encoding ASCII
    Write-Host "Created local.properties with sdk.dir=$sdkDir"
}

Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "Android SDK=$sdk"

Push-Location $androidDir
try {
    $gradlew = Join-Path $androidDir "gradlew.bat"
    if (Test-Path $gradlew) {
        & $gradlew.bat assembleDebug --no-daemon
    }
    else {
        Write-Host "gradlew.bat not found, using system gradle ..."
        $gradle = Get-Command gradle -ErrorAction SilentlyContinue
        if (-not $gradle) { Write-Error "Neither gradlew.bat nor system gradle found." }
        & gradle assembleDebug --no-daemon
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "APK build failed" }
}
finally {
    Pop-Location
}

$apk = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
Write-Host ""
Write-Host "Debug APK: $apk"
