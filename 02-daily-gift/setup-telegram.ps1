$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $projectRoot 'telegram.local.json'
$secret = Read-Host '請貼上 BotFather 給你的 Bot token（輸入不會顯示）' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ($token -notmatch '^\d+:[A-Za-z0-9_-]+$') { throw 'Bot token 格式不正確。' }

    try {
        $bot = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$token/getMe" -TimeoutSec 15
        if (-not $bot.ok -or -not $bot.result.username) { throw 'invalid bot' }
    } catch { throw '無法驗證 Bot token。請確認從官方 BotFather 複製完整 token。' }

    $botName = $bot.result.username
    Write-Host "已驗證 Bot：@$botName"
    Write-Host "請在目標群組加入 @$botName，並傳 /start@$botName；私人對話則傳 /start。"
    Read-Host '完成後按 Enter 讀取對話'

    try {
        $updates = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$token/getUpdates?limit=100&timeout=0" -TimeoutSec 15
        if (-not $updates.ok) { throw 'invalid updates' }
    } catch { throw '無法讀取 Bot 對話。請確認 Bot 沒有設定 webhook，並稍後重試。' }

    $chats = @($updates.result | ForEach-Object {
        if ($_.message) { $_.message.chat }
        if ($_.my_chat_member) { $_.my_chat_member.chat }
        if ($_.chat_member) { $_.chat_member.chat }
    } | Where-Object { $_ -and $_.type -in @('private', 'group', 'supergroup') } |
        Group-Object id | ForEach-Object { $_.Group[-1] })
    if ($chats.Count -eq 0) {
        throw '找不到群組或私人對話。請先在目標對話傳 /start 指令，再重新執行設定程式。'
    }
    Write-Host '可用的群組／私人對話：'
    for ($i = 0; $i -lt $chats.Count; $i++) {
        $chat = $chats[$i]
        $name = if ($chat.title) { $chat.title } else { "$($chat.first_name) $($chat.last_name) @$($chat.username)" }
        Write-Host "$($i + 1). $name（$($chat.type)，ID $($chat.id)）"
    }
    $choice = Read-Host '請輸入要接收每日通知的對話編號'
    $index = 0
    if (-not [int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $chats.Count) {
        throw '對話編號無效，尚未儲存設定。'
    }
    $chatId = [string]$chats[$index - 1].id
    $groupName = $chats[$index - 1].title
    $json = @{ botToken = $token; chatId = $chatId; botUsername = $botName; groupName = $groupName } | ConvertTo-Json -Depth 3
    $temp = "$configPath.$PID.tmp"
    [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $acl = Get-Acl -LiteralPath $temp
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temp -AclObject $acl
    Move-Item -LiteralPath $temp -Destination $configPath -Force
    Write-Host '已儲存本機通知設定，正在發送測試訊息...'
    & node (Join-Path $projectRoot 'src\telegram-notify.cjs') --test
    if ($LASTEXITCODE -ne 0) { throw '測試訊息未送達；請檢查 Bot 對話與網路。' }
    Write-Host '設定完成，之後每日排程會自動發送結果。'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $token = $null
}
