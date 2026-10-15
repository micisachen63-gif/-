$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir "$(Get-Date -Format 'yyyy-MM-dd')-line-retry.log"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

try {
    $daily = Get-ScheduledTask -TaskName '每日三平台新手禮包執行器' -ErrorAction SilentlyContinue
    if ($daily -and $daily.State -eq 'Running') {
        Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'HH:mm:ss')] Daily runner still active; retry deferred." -Encoding UTF8
        exit 0
    }
    $nodePath = 'C:\Program Files\nodejs\node.exe'
    $chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js not found.' }
    if (-not (Test-Path -LiteralPath $chromePath)) { throw 'Chrome not found.' }
    $port = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
    if (-not $port) {
        $profilePath = Join-Path $root 'browser-profile'
        $chromeArgs = @("--user-data-dir=$profilePath", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--new-window', 'https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit')
        Start-Process -FilePath $chromePath -ArgumentList $chromeArgs
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Seconds 1
            $port = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
            if ($port) { break }
        }
    }
    if (-not $port) { throw 'Dedicated Chrome control port is unavailable.' }
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { Add-Content -LiteralPath $logPath -Value "Window hide failed: $($_.Exception.Message)" -Encoding UTF8 }
    # Windows PowerShell 5.1 在 'Stop' 模式下，只要子程式寫一行 stderr 就會拋例外並中斷讀取；
    # 以前每次 resume-broadcasts 回報品牌錯誤都被誤當成「啟動失敗」並多發一則 TG。這裡改成照常收集輸出。
    $ErrorActionPreference = 'Continue'
    $result = & $nodePath (Join-Path $root 'src\resume-broadcasts.cjs') 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($result) { @("[$(Get-Date -Format 'HH:mm:ss')] exit $exitCode") + @($result) | Out-File -LiteralPath $logPath -Append -Encoding UTF8 }
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { Add-Content -LiteralPath $logPath -Value "Window hide failed: $($_.Exception.Message)" -Encoding UTF8 }
    exit $exitCode
} catch {
    $ErrorActionPreference = 'Continue'
    $reason = $_.Exception.Message
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'HH:mm:ss')] Retry launcher failed: $reason" -Encoding UTF8
    $env:DAILY_GIFT_FATAL_ERROR = $reason
    try { & 'C:\Program Files\nodejs\node.exe' (Join-Path $root 'src\telegram-notify.cjs') 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath $logPath -Append -Encoding UTF8 }
    catch { Add-Content -LiteralPath $logPath -Value 'Telegram failure notice failed.' -Encoding UTF8 }
    finally { Remove-Item Env:DAILY_GIFT_FATAL_ERROR -ErrorAction SilentlyContinue }
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { }
    exit 1
}
