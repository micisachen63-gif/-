@echo off
chcp 65001 >nul
echo ============================================================
echo   ▶️ 重新啟用公司本機上的撿台排程
echo ============================================================
echo.
schtasks /change /tn "ShuangbaoSlotNotifier" /enable
schtasks /change /tn "QieziSlotNotifier" /enable
echo.
echo ============================================================
echo   ✅ 本機撿台排程已重新啟用。
echo ============================================================
pause
