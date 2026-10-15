$ErrorActionPreference = 'Stop'
$opsRoot = $PSScriptRoot
$opsNode = 'C:\Program Files\nodejs\node.exe'
if (!(Test-Path -LiteralPath $opsNode)) { throw "找不到系統安裝的 Node：$opsNode" }
try {
    & $opsNode (Join-Path $opsRoot 'run.mjs') --apply --scheduled 2>&1 | Out-File -LiteralPath (Join-Path $opsRoot 'logs\scheduled-console.log') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw '營運表更新未全部完成。請查看程式資料夾 logs\latest.json。' }
} catch {
    $opsShell = New-Object -ComObject WScript.Shell
    $null = $opsShell.Popup('營運表更新失敗或需要重新登入。請查看 operations-program\logs\latest.json；部分資料可能已更新，重跑會按日期核對。', 60, '三平台營運表', 48)
    exit 1
}
