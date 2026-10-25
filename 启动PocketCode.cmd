@echo off
setlocal
title PocketCode Launcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop.ps1" -Background
if errorlevel 1 (
    echo.
    echo PocketCode could not start. See the error above.
    pause
    exit /b 1
)
exit /b 0
