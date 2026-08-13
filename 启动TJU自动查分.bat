@echo off
chcp 65001 >nul
setlocal
title TJU Auto Grade
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto node_missing

if exist "node_modules\playwright\package.json" if exist "node_modules\nodemailer\package.json" goto dependency_ok
echo [ERROR] Dependencies are not installed.
echo Run npm install in this directory first.
goto failed

:dependency_ok
if /i "%~1"=="--verify" goto verify

echo ================================================
echo   Starting TJU Auto Grade
echo   Project: %CD%
echo   Closing this window will stop monitoring.
echo ================================================
echo.
npm start
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto finished
echo.
echo [ERROR] TJU Auto Grade exited with code %EXIT_CODE%.
echo See eams_monitor.log for details.
goto finished

:verify
node eams_grade_checker_v2.js --verify
set "EXIT_CODE=%ERRORLEVEL%"
goto finished

:node_missing
echo [ERROR] Node.js was not found. Install Node.js 22 or newer.

:failed
set "EXIT_CODE=1"

:finished
echo.
if not "%~1"=="--verify" pause
endlocal & exit /b %EXIT_CODE%
