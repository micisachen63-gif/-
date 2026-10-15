@echo off
chcp 65001 >nul
setlocal
title Operations Update
set "OPS_ROOT=C:\Users\User\Documents\Codex\2026-09-18\new-chat\outputs\operations-program"
cd /d "%OPS_ROOT%"
if errorlevel 1 goto failed
echo Updating spreadsheets and verifying saved values. Keep Chrome open.
"C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%OPS_ROOT%\run.mjs" --apply
if errorlevel 1 goto failed
echo Update and verification completed. Please tell Codex to check the log.
goto finished
:failed
echo Update did not fully complete. Please tell Codex to check the log.
:finished
pause
endlocal
