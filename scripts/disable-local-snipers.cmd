@echo off
chcp 65001 >nul
echo ============================================================
echo   🛑 停用公司本機上的撿台排程（釋放 CPU 與記憶體效能）
echo ============================================================
echo.
echo 正在停用 ShuangbaoSlotNotifier (爽爆機台狙擊手)...
schtasks /change /tn "ShuangbaoSlotNotifier" /disable
echo.
echo 正在停用 QieziSlotNotifier (茄子機台狙擊手)...
schtasks /change /tn "QieziSlotNotifier" /disable
echo.
echo ============================================================
echo   🎉 完成！本機撿台排程已停用，公司電腦不會再定時卡死吃效能！
echo   （雲端排程已接管此任務）
echo ============================================================
pause
