@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "OPS_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%OPS_CHROME%" set "OPS_CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%OPS_CHROME%" (
 echo Google Chrome was not found. Please install Chrome first.
 pause
 exit /b 1
)
"C:\Program Files\nodejs\node.exe" "%~dp0start-resident.mjs" --visible
