$ErrorActionPreference = 'Stop'
$opsConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($opsConfig.localControlApproved -ne $true) { throw '尚未確認啟用本機瀏覽器控制；目前不會開啟控制連線。' }
$opsChrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (!(Test-Path -LiteralPath $opsChrome)) { $opsChrome = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }
if (!(Test-Path -LiteralPath $opsChrome)) { throw '找不到 Chrome。' }
$opsProfile = [IO.Path]::GetFullPath($opsConfig.browserProfile)
$opsArgs = @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=19385',('--user-data-dir="' + $opsProfile + '"'),'--new-window')
$opsArgs += @($opsConfig.platforms | ForEach-Object { $_.url + '/' })
$opsArgs += 'https://docs.google.com/spreadsheets/d/' + $opsConfig.revenueId + '/edit'
# Explicitly visible: the user signs in here and keeps this dedicated browser open.
Start-Process -FilePath $opsChrome -ArgumentList $opsArgs
Write-Host '請保持專用 Chrome 開啟。登入完成後執行桌面測試入口；這個版本測試完成只會斷線，不會關閉你的瀏覽器。'
