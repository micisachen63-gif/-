$ErrorActionPreference = 'Stop'
$opsRoot = $PSScriptRoot
$opsLog = Join-Path $opsRoot 'logs\desktop-test-console.log'
New-Item -ItemType Directory -Path (Join-Path $opsRoot 'logs') -Force | Out-Null
try {
    Start-Transcript -Path $opsLog -Force | Out-Null
    Write-Host ('測試開始：' + (Get-Date))
    $opsNode = 'C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (!(Test-Path -LiteralPath $opsNode)) { throw '找不到程式執行元件。' }
    Set-Location -LiteralPath $opsRoot
    Write-Host '正在檢查專用 Chrome；請保持瀏覽器開啟。'
    & $opsNode (Join-Path $opsRoot 'check-login.mjs')
    if ($LASTEXITCODE -ne 0) { throw '登入或連線檢查未通過，原因已記錄。' }
    Write-Host '開始讀取資料。本次不寫入表格。'
    & $opsNode (Join-Path $opsRoot 'run.mjs')
    if ($LASTEXITCODE -ne 0) { throw '資料試跑未完成，原因已記錄。' }
    Write-Host '測試完成，請通知 Codex 查看結果。'
} catch {
    Write-Host ('測試未完成：' + $_.Exception.Message) -ForegroundColor Red
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}