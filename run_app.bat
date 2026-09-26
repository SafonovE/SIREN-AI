@echo off
set "APP_DIR=%~dp0"
start "Siren AI" /min "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%APP_DIR%run_app.ps1"
