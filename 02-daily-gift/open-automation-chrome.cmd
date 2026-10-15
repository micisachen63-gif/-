@echo off
 powershell.exe -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
 if not errorlevel 1 (
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1" -Action Show -Port 9222
   exit /b 0
 )
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\User\Documents\Codex\2026-09-21\new-chat\daily_gift\browser-profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --new-window "https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit"
