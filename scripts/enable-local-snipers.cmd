@echo off
chcp 65001 >nul
echo ============================================================
echo   ▶️ 重新啟用公司本機上的撿台排程
echo ============================================================
echo.
echo 正在啟用 ShuangbaoSlotNotifier (爽爆機台狙擊手)...
schtasks /change /tn "ShuangbaoSlotNotifier" /enable 2>nul
echo.
echo 正在啟用 QieziSlotNotifier (茄子機台狙擊手)...
schtasks /change /tn "QieziSlotNotifier" /enable 2>nul
echo.
echo 正在啟用 ATGRoomNotifier (贏麻選台通知)...
schtasks /change /tn "ATGRoomNotifier" /enable 2>nul
echo.
echo ============================================================
echo   ✅ 本機三大品牌撿台排程已重新啟用。
echo ============================================================
pause
