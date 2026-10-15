param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = '每日三平台新手禮包執行器'
if ($Remove) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; Write-Output "已移除排程：$taskName"; exit 0 }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath 'C:\Program Files\Google\Chrome\Application\chrome.exe')) { throw '找不到 Google Chrome。' }
foreach ($script in @('daily-runner.cjs','export-members.cjs','import-members.cjs','process-sheet.cjs','mail-gift.cjs','line-audience.cjs','line-broadcast.cjs','telegram-notify.cjs')) {
    & node --check (Join-Path $root "src\$script")
    if ($LASTEXITCODE -ne 0) { throw "程式語法檢查失敗：$script" }
}
$sessions = & node (Join-Path $root 'src\probe-sessions.cjs') 2>&1
if ($LASTEXITCODE -ne 0 -or @($sessions | Where-Object { $_ -match 'LOGIN_REQUIRED' }).Count -gt 0) {
    throw "專用 Chrome 尚有網站未登入；排程未安裝。`n$($sessions -join "`n")"
}
try {
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\run-daily.ps1`"" -WorkingDirectory $root -ErrorAction Stop
    $trigger = New-ScheduledTaskTrigger -Daily -At '7:00AM' -ErrorAction Stop
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -ErrorAction Stop
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited -ErrorAction Stop
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '每日處理前一天三品牌新手禮包、LINE受眾與18:00推播，清理表格並以TG通知結果。' -Force -ErrorAction Stop | Select-Object TaskName,State
} catch {
    throw "建立工作排程失敗。請在一般使用者 PowerShell 重試；若系統仍拒絕存取，請由系統管理員授權工作排程器權限後重試。排程未建立。詳細原因：$($_.Exception.Message)"
}
