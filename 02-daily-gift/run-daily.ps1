param([string]$Date = "", [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

try {
    $chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    if (-not (Test-Path -LiteralPath $chromePath)) { throw "找不到 Chrome：$chromePath" }
    $debugPort = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
    if (-not $debugPort) {
        $profilePath = Join-Path $projectRoot 'browser-profile'
        $profileFull = [IO.Path]::GetFullPath($profilePath)
        $staleChrome = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
            $_.CommandLine -like "*--user-data-dir=*$profileFull*" -and $_.CommandLine -notlike '*--type=*'
        })
        if ($staleChrome.Count -gt 0) {
            Write-Warning '新手禮包專用 Chrome 存在，但 9222 控制端點失效；正在自動重啟專用視窗。'
            foreach ($process in $staleChrome) { & taskkill.exe /PID $process.ProcessId /T /F | Out-Null }
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                Start-Sleep -Milliseconds 500
                $stillRunning = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
                    $_.CommandLine -like "*--user-data-dir=*$profileFull*" -and $_.CommandLine -notlike '*--type=*'
                })
                if ($stillRunning.Count -eq 0) { break }
            }
        }
        $chromeArgs = @("--user-data-dir=$profilePath", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--new-window', '--start-minimized', 'https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit')
        Start-Process -FilePath $chromePath -ArgumentList $chromeArgs -WindowStyle Hidden
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Seconds 1
            $debugPort = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
            if ($debugPort) { break }
        }
    }
    if (-not $debugPort) { throw '專用 Chrome 的本機控制連線未啟動。請關閉占用同一設定檔的 Chrome，然後重試。' }
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { Write-Warning "禮包開始時無法隱藏專用視窗：$($_.Exception.Message)" }

    $opsStarter = 'C:\Users\User\Documents\Codex\2026-09-18\new-chat\outputs\operations-program\start-resident.mjs'
    $opsPort = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 19385 -State Listen -ErrorAction SilentlyContinue
    if (-not $opsPort -and (Test-Path -LiteralPath $opsStarter)) {
        & node $opsStarter
        if ($LASTEXITCODE -ne 0) { Write-Warning '另一個後台專用 Chrome 尚未就緒；若本視窗的後台登入過期，禮包會停止並發出通知。' }
    }

    $runnerArgs = @((Join-Path $projectRoot 'src\daily-runner.cjs'))
    if ($Date) { $runnerArgs += "--date=$Date" }
    if ($VerifyOnly) { $runnerArgs += '--verify-only' }
    & node @runnerArgs
    $runExitCode = $LASTEXITCODE
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { Write-Warning "禮包結束後無法隱藏專用視窗：$($_.Exception.Message)" }
    exit $runExitCode
} catch {
    $reason = $_.Exception.Message
    [Console]::Error.WriteLine("每日禮包啟動失敗：$reason")
    if (-not $VerifyOnly -and -not $Date) {
        $env:DAILY_GIFT_FATAL_ERROR = $reason
        try { & node (Join-Path $projectRoot 'src\telegram-notify.cjs') } catch {
            [Console]::Error.WriteLine('TG 啟動失敗通知也未能送出。')
        } finally { Remove-Item Env:DAILY_GIFT_FATAL_ERROR -ErrorAction SilentlyContinue }
    }
    try { & 'C:\Users\User\Documents\ChatGPT\營運自動化\scripts\dedicated-chrome-window.ps1' -Action Hide -Port 9222 | Out-Null } catch { }
    exit 1
}
