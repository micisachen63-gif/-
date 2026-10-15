$ErrorActionPreference = 'Stop'
$opsRoot = $PSScriptRoot
$opsConfigPath = Join-Path $opsRoot 'config.json'
$opsConfig = Get-Content -LiteralPath $opsConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$opsLatest = Get-Content -LiteralPath (Join-Path $opsRoot 'logs\latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$opsLatest.completed -or $opsLatest.mode -ne 'apply') { throw '必須先完成一次固定程式寫入及讀回驗證，才能安裝排程。' }
if (!$opsConfig.weeklyEnabled) { throw '週一機台流程尚未完成實測，暫不切換整個排程。' }
if ((Get-TimeZone).Id -ne 'Taipei Standard Time') { throw 'Windows 時區不是台灣，請確認時區後再安裝。' }
$opsAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "' + (Join-Path $opsRoot 'run-scheduled.ps1') + '"') -WorkingDirectory $opsRoot
$opsTrigger = New-ScheduledTaskTrigger -Daily -At '08:00'
$opsUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$opsPrincipal = New-ScheduledTaskPrincipal -UserId $opsUser -LogonType Interactive -RunLevel Limited
$opsSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$opsTaskName = 'ThreePlatformOperations0800'
Register-ScheduledTask -TaskName $opsTaskName -Action $opsAction -Trigger $opsTrigger -Principal $opsPrincipal -Settings $opsSettings -Description '三平台營運表；每日08:00，週一加做上一完整週機台報表。固定程式不呼叫AI。' -Force | Out-Null
$opsConfig.enabled = $true
[System.IO.File]::WriteAllText($opsConfigPath, ($opsConfig | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
Get-ScheduledTaskInfo -TaskName $opsTaskName | Select-Object NextRunTime,LastTaskResult
Write-Host 'Windows 排程已建立。請回報給 Codex，停用舊 Codex 排程，避免重複執行。'
