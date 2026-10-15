# Backend login credentials for the operations program (and other automations on this PC).
# Values are protected with Windows DPAPI, CurrentUser scope (ConvertFrom-SecureString without a
# key): only the same Windows account on this PC can decrypt them. Passwords are never printed.
#   (no switch)                 interactive setup, started by 設定後台帳密.cmd
#   -Decrypt -Platform <key|name|host>
#                               writes base64(UTF-8 JSON {"username","password"}) to stdout only;
#                               exit 2 = file missing, 3 = platform not set, 4 = cannot decrypt
#   -SelfTest [-Path <temp>] [-KeepDummy]
#                               encrypt/decrypt dummy values in a temp file; never the real file
param(
 [switch]$Decrypt,
 [string]$Platform,
 [switch]$SelfTest,
 [switch]$KeepDummy,
 [string]$Path
)
$ErrorActionPreference = 'Stop'
# Node inherits Codex's PowerShell Core module path. Windows PowerShell 5.1 can then find the
# Core copy of Microsoft.PowerShell.Security first and fail to load DPAPI cmdlets. Restrict this
# helper to Windows PowerShell-compatible module roots before any secure-string command runs.
$opsWindowsModuleRoots = @(
 (Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\Modules'),
 (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
 (Join-Path $PSHOME 'Modules')
)
$env:PSModulePath = ($opsWindowsModuleRoots -join [IO.Path]::PathSeparator)
$opsRoot = $PSScriptRoot
$opsRealFile = Join-Path $opsRoot 'private\backend-credentials.dpapi.json'
$opsPathGiven = $PSBoundParameters.ContainsKey('Path') -and $Path
if (-not $opsPathGiven) { $Path = $opsRealFile }
$opsUtf8 = New-Object System.Text.UTF8Encoding($false)
$Marshal = [System.Runtime.InteropServices.Marshal]

function Get-OpsPlatforms {
 $config = [IO.File]::ReadAllText((Join-Path $opsRoot 'config.json'), [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
 return @($config.platforms | ForEach-Object { [pscustomobject]@{ key = [string]$_.key; name = [string]$_.name; url = [string]$_.url } })
}

function Protect-OpsSecure([Security.SecureString]$Secure) { return (ConvertFrom-SecureString -SecureString $Secure) }
function Protect-OpsText([string]$Text) { return (ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $Text -AsPlainText -Force)) }
function Unprotect-OpsText([string]$Cipher) {
 $secure = ConvertTo-SecureString -String $Cipher
 $bstr = $Marshal::SecureStringToBSTR($secure)
 try { return $Marshal::PtrToStringBSTR($bstr) } finally { $Marshal::ZeroFreeBSTR($bstr) }
}
function Test-OpsSameSecret([Security.SecureString]$A, [Security.SecureString]$B) {
 if ($A.Length -ne $B.Length) { return $false }
 $pa = $Marshal::SecureStringToBSTR($A); $pb = $Marshal::SecureStringToBSTR($B)
 try { return ($Marshal::PtrToStringBSTR($pa) -ceq $Marshal::PtrToStringBSTR($pb)) }
 finally { $Marshal::ZeroFreeBSTR($pa); $Marshal::ZeroFreeBSTR($pb) }
}

function Get-OpsHost([string]$Value) {
 if (-not $Value) { return '' }
 $uri = $null
 if ([Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -and $uri.Host) { return $uri.Host.ToLowerInvariant() }
 return ($Value -replace ':\d+$', '').ToLowerInvariant()
}

function Read-OpsStore([string]$File) {
 if (-not (Test-Path -LiteralPath $File)) { return $null }
 $store = [IO.File]::ReadAllText($File, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
 if (-not $store.platforms) { throw 'invalid store' }
 return $store
}

# Existing entries as an ordered map key -> entry (ciphertext only; nothing is decrypted here).
function Get-OpsEntries($Store) {
 $entries = [ordered]@{}
 if ($Store -and $Store.platforms) {
  foreach ($prop in $Store.platforms.PSObject.Properties) {
   $e = $prop.Value
   $entries[$prop.Name] = [ordered]@{ name = [string]$e.name; url = [string]$e.url; username = [string]$e.username; password = [string]$e.password; updated = [string]$e.updated }
  }
 }
 return $entries
}

function Find-OpsEntry($Store, [string]$Wanted) {
 if (-not $Store -or -not $Wanted) { return $null }
 $wantedHost = Get-OpsHost $Wanted
 foreach ($prop in $Store.platforms.PSObject.Properties) {
  $e = $prop.Value
  if ($prop.Name -eq $Wanted -or ($e.name -and $e.name -eq $Wanted) -or ($e.url -and (Get-OpsHost $e.url) -eq $wantedHost)) { return $e }
 }
 return $null
}

function New-OpsEntry($P, [string]$UserCipher, [string]$PasswordCipher) {
 return [ordered]@{ name = $P.name; url = $P.url; username = $UserCipher; password = $PasswordCipher; updated = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
}

function Set-OpsOwnerOnly([string]$File) {
 $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl = New-Object System.Security.AccessControl.FileSecurity
 $acl.SetAccessRuleProtection($true, $false)
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)))
 (Get-Item -LiteralPath $File).SetAccessControl($acl)
}

function Write-OpsStore($Entries, [string]$File) {
 $dir = Split-Path -Parent $File
 if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
 $store = [ordered]@{
  schema = 1
  protection = 'Windows DPAPI CurrentUser (ConvertFrom-SecureString, no key); username and password are both encrypted'
  windowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  updated = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  platforms = $Entries
 }
 $temp = "$File.$PID.tmp"
 # Restrict the ACL before any content is written, then move into place.
 [IO.File]::WriteAllText($temp, '', $opsUtf8)
 Set-OpsOwnerOnly $temp
 [IO.File]::WriteAllText($temp, ($store | ConvertTo-Json -Depth 6), $opsUtf8)
 if (Test-Path -LiteralPath $File) { Remove-Item -LiteralPath $File -Force }
 Move-Item -LiteralPath $temp -Destination $File
 Set-OpsOwnerOnly $File
}

function Invoke-OpsDecrypt {
 if (-not $Platform) { exit 5 }
 if (-not (Test-Path -LiteralPath $Path)) { exit 2 }
 try { $store = Read-OpsStore $Path } catch { exit 4 }
 $entry = Find-OpsEntry $store $Platform
 if (-not $entry -or -not $entry.username -or -not $entry.password) { exit 3 }
 try { $user = Unprotect-OpsText $entry.username; $pass = Unprotect-OpsText $entry.password } catch { exit 4 }
 if (-not $user -or -not $pass) { exit 3 }
 $json = [ordered]@{ username = $user; password = $pass } | ConvertTo-Json -Compress
 [Console]::Out.Write([Convert]::ToBase64String($opsUtf8.GetBytes($json)))
 exit 0
}

function Read-OpsPassword {
 for ($i = 1; $i -le 3; $i++) {
  $first = Read-Host '密碼（輸入時不會顯示）' -AsSecureString
  if (-not $first -or $first.Length -eq 0) { Write-Host '密碼不可空白，請重新輸入。'; continue }
  $again = Read-Host '請再輸入一次密碼確認' -AsSecureString
  if ($again -and (Test-OpsSameSecret $first $again)) { return $first }
  Write-Host '兩次輸入的密碼不一致，請重新輸入。'
 }
 return $null
}

function Read-OpsLine([string]$Prompt) {
 $value = Read-Host $Prompt
 if ($null -eq $value) { throw '沒有收到輸入，已停止。' }
 return ([string]$value).Trim()
}

function Read-OpsUsername([string]$Prompt, [bool]$AllowEmpty) {
 while ($true) {
  $value = Read-OpsLine $Prompt
  if ($value -or $AllowEmpty) { return $value }
  Write-Host '帳號不可空白，請重新輸入。'
 }
}

function Invoke-OpsSetup {
 try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
 $platforms = Get-OpsPlatforms
 Write-Host '=== 設定後台帳密 ==='
 Write-Host '帳密會用 Windows DPAPI 加密，只有目前這個 Windows 帳號在這台電腦上能解開；不會顯示或記錄密碼。'
 Write-Host "儲存位置：$Path"
 Write-Host ''
 $existing = $null
 try { $existing = Read-OpsStore $Path } catch { Write-Host '既有的帳密檔無法讀取，這次會重新建立。'; $existing = $null }
 $entries = Get-OpsEntries $existing
 do { $answer = (Read-OpsLine '三個後台是否使用同一組帳密？(Y/N)').ToUpperInvariant() } until ($answer -eq 'Y' -or $answer -eq 'N')
 $changed = $false
 if ($answer -eq 'Y') {
  $user = Read-OpsUsername '帳號' $false
  $secure = Read-OpsPassword
  if (-not $secure) { Write-Host '密碼沒有設定成功，這次不儲存任何變更。'; return }
  $userCipher = Protect-OpsText $user; $passCipher = Protect-OpsSecure $secure
  foreach ($p in $platforms) { $entries[$p.key] = New-OpsEntry $p $userCipher $passCipher }
  $changed = $true
 } else {
  foreach ($p in $platforms) {
   Write-Host ''
   Write-Host "── $($p.name)（$($p.url)）──"
   $has = $entries.Contains($p.key) -and $entries[$p.key].username -and $entries[$p.key].password
   if ($has) { Write-Host '已有設定：帳號直接按 Enter 會保留原本的帳密。' }
   $user = Read-OpsUsername '帳號' $true
   if (-not $user) {
    if ($has) { Write-Host '保留原本的設定。' } else { Write-Host '未輸入，這個後台暫不設定。' }
    continue
   }
   $secure = Read-OpsPassword
   if (-not $secure) { Write-Host "$($p.name) 密碼沒有設定成功，保留原狀。"; continue }
   $entries[$p.key] = New-OpsEntry $p (Protect-OpsText $user) (Protect-OpsSecure $secure)
   $changed = $true
  }
 }
 if ($changed) { Write-OpsStore $entries $Path }
 Write-Host ''
 Write-Host ($(if ($changed) { '已儲存。' } else { '沒有變更。' }) + '目前狀態（不顯示密碼）：')
 foreach ($p in $platforms) {
  $ok = $entries.Contains($p.key) -and $entries[$p.key].username -and $entries[$p.key].password
  Write-Host ("  {0}：{1}" -f $p.name, $(if ($ok) { '已設定' } else { '未設定' }))
 }
 if ($changed -or $existing) { Write-Host "加密檔：$Path" }
 Write-Host '日後密碼變更時，再執行一次 設定後台帳密.cmd 即可更新。'
}

function Invoke-OpsSelfTest {
 if ($opsPathGiven -and ([IO.Path]::GetFullPath($Path) -eq [IO.Path]::GetFullPath($opsRealFile))) { throw 'SelfTest 不可使用正式帳密檔路徑。' }
 $temp = if ($opsPathGiven) { $Path } else { Join-Path ([IO.Path]::GetTempPath()) ('ops-cred-selftest-' + [guid]::NewGuid().ToString('N') + '.json') }
 $dummyUser = 'selftest-user'; $dummyPass = 'selftest-dummy-密碼-!"\'
 try {
  $platforms = Get-OpsPlatforms
  if ($platforms.Count -lt 1) { throw 'config.json 沒有平台' }
  $entries = [ordered]@{}
  $cipher = Protect-OpsText $dummyPass
  foreach ($p in $platforms) { $entries[$p.key] = New-OpsEntry $p (Protect-OpsText $dummyUser) $cipher }
  Write-OpsStore $entries $temp
  $raw = [IO.File]::ReadAllText($temp, [Text.Encoding]::UTF8)
  if ($raw.Contains($dummyUser) -or $raw.Contains('selftest-dummy')) { throw '加密檔內含明文' }
  $acl = Get-Acl -LiteralPath $temp
  $rules = @($acl.Access)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -ne $sid) { throw '檔案權限未限制為目前使用者' }
  $store = Read-OpsStore $temp
  foreach ($p in $platforms) {
   foreach ($wanted in @($p.key, $p.name, (Get-OpsHost $p.url))) {
    $e = Find-OpsEntry $store $wanted
    if (-not $e -or (Unprotect-OpsText $e.username) -cne $dummyUser -or (Unprotect-OpsText $e.password) -cne $dummyPass) { throw "解密不符：$wanted" }
   }
  }
  # Keeping an entry (setup answer N + Enter) must carry the ciphertext over unchanged.
  $kept = Get-OpsEntries $store
  if ($kept[$platforms[0].key].password -ne $cipher) { throw '保留既有設定失敗' }
  Write-Host ("SELFTEST OK：DPAPI 加解密、權限限制、{0} 個平台查找皆正常（未寫入正式帳密檔）。" -f $platforms.Count)
 } finally {
  if (-not $KeepDummy) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
 }
}

if ($Decrypt) { Invoke-OpsDecrypt }
elseif ($SelfTest) { try { Invoke-OpsSelfTest } catch { Write-Host "SELFTEST FAILED：$($_.Exception.Message)"; exit 1 } }
else { try { Invoke-OpsSetup } catch { Write-Host "設定失敗：$($_.Exception.Message)"; exit 1 } }
