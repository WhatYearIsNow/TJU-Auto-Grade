@echo off
chcp 65001 >nul
cd /d "D:\project\tju-auto-grade"
node watchdog.js
pause
