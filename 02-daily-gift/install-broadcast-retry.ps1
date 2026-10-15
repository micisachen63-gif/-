param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'DailyGiftLineRetry'
$wrapper = Join-Path $root 'run-broadcast-retry.ps1'
$script = Join-Path $root 'src\resume-broadcasts.cjs'
$nodePath = 'C:\Program Files\nodejs\node.exe'
foreach ($file in @($wrapper, $script, $nodePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing file: $file" }
}
if ((Get-TimeZone).Id -ne 'Taipei Standard Time') { throw 'Expected Taipei Standard Time.' }
& $nodePath --check $script
if ($LASTEXITCODE -ne 0) { throw 'Retry script syntax check failed.' }
if ($ValidateOnly) { Write-Output 'Retry schedule preflight passed; task not installed.'; return }

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapper`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '07:05'
$trigger.Repetition = New-CimInstance -ClientOnly -Namespace root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskRepetitionPattern -Property @{ Interval = 'PT5M'; Duration = 'PT10H25M'; StopAtDurationEnd = $false }
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Check LINE audiences every five minutes, retry one stuck upload, and schedule 18:00 broadcasts when ready.' -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
