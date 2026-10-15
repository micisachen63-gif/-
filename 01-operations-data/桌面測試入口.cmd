@echo off
chcp 65001 >nul
setlocal
title Operations Test
set "OPS_ROOT=C:\Users\User\Documents\Codex\2026-09-18\new-chat\outputs\operations-program"
set "OPS_NODE=C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
cd /d "%OPS_ROOT%"
if not exist "logs" mkdir "logs"
echo Starting login check. Keep Chrome open...
"%OPS_NODE%" "%OPS_ROOT%\check-login.mjs" > "logs\desktop-login-console.log" 2>&1
set "OPS_RESULT=%ERRORLEVEL%"
type "logs\desktop-login-console.log"
if not "%OPS_RESULT%"=="0" goto failed
echo Login check passed. Reading data only; no spreadsheet changes.
"%OPS_NODE%" "%OPS_ROOT%\run.mjs"
if errorlevel 1 goto failed
echo Test completed. Please tell Codex to check the results.
goto finished
:failed
echo Test did not complete. Please report the message above to Codex.
:finished
pause
endlocal
