@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\register_dashboard_protocol.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] 安装失败，请查看上方提示。
  pause
  exit /b 1
)
echo.
pause
