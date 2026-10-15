@echo off
chcp 65001 >nul
node "%~dp0push-to-github.mjs"
pause
