@echo off
chcp 65001 >nul
echo ============================================================
echo   🛑 停用公司本機上的撿台排程（釋放 CPU 與記憶體效能）
echo ============================================================
echo.
echo 正在停用 ShuangbaoSlotNotifier (爽爆機台狙擊手)...
schtasks /change /tn "ShuangbaoSlotNotifier" /disable 2>nul
echo.
echo 正在停用 QieziSlotNotifier (茄子機台狙擊手)...
schtasks /change /tn "QieziSlotNotifier" /disable 2>nul
echo.
echo 正在停用 ATGRoomNotifier (贏麻選台通知)...
schtasks /change /tn "ATGRoomNotifier" /disable 2>nul
echo.
echo ============================================================
echo   🎉 完成！三大品牌本機撿台排程已全部停用！
echo   - 爽爆機台狙擊手 (ShuangbaoSlotNotifier) -> 已停用
echo   - 茄子機台狙擊手 (QieziSlotNotifier)     -> 已停用
echo   - 贏麻選台通知   (ATGRoomNotifier)       -> 已停用
echo   公司電腦不會再因為定時跑 Chromium 吃爆 100%% CPU 與記憶體！
echo ============================================================
pause
