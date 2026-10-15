# monthly-deck DPAPI helper (Windows DPAPI, CurrentUser scope). Never prints plaintext to the console:
# results go to stdout as base64 for the calling Node process only.
#   -Backend -Platform <key> -Path <dpapi.json>   decrypt one backend login (same file format as
#                                                 operations-program\private\backend-credentials.dpapi.json)
#   -Protect     stdin = base64(plaintext)  -> stdout = DPAPI cipher text
#   -Unprotect   stdin = DPAPI cipher text  -> stdout = base64(plaintext)
# exit 2 = file missing, 3 = platform not set, 4 = cannot decrypt, 5 = bad arguments
param([switch]$Backend, [string]$Platform, [string]$Path, [switch]$Protect, [switch]$Unprotect)
$ErrorActionPreference = 'Stop'
function Unprotect-Text([string]$Cipher) {
  $secure = ConvertTo-SecureString $Cipher
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
if ($Backend) {
  if (-not $Platform -or -not $Path) { exit 5 }
  if (-not (Test-Path -LiteralPath $Path)) { exit 2 }
  try { $store = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { exit 4 }
  $entry = $store.platforms.$Platform
  if (-not $entry -or -not $entry.username -or -not $entry.password) { exit 3 }
  try { $u = Unprotect-Text $entry.username; $p = Unprotect-Text $entry.password } catch { exit 4 }
  if (-not $u -or -not $p) { exit 3 }
  $json = (@{ username = $u; password = $p } | ConvertTo-Json -Compress)
  [Console]::Out.Write([Convert]::ToBase64String($utf8.GetBytes($json)))
  exit 0
}
$in = [Console]::In.ReadToEnd().Trim()
if ($Protect) {
  try { $plain = $utf8.GetString([Convert]::FromBase64String($in)) } catch { exit 5 }
  $secure = ConvertTo-SecureString $plain -AsPlainText -Force
  [Console]::Out.Write((ConvertFrom-SecureString $secure))
  exit 0
}
if ($Unprotect) {
  try { $plain = Unprotect-Text $in } catch { exit 4 }
  [Console]::Out.Write([Convert]::ToBase64String($utf8.GetBytes($plain)))
  exit 0
}
exit 5
