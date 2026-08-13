@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\register_dashboard_protocol.ps1" -Uninstall
echo.
pause
