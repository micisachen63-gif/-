@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Backend credentials setup
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend-credentials.ps1" %*
echo.
pause
