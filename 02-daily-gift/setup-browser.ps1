$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeModules = 'C:\Users\User\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
if (-not (Test-Path (Join-Path $nodeModules 'playwright'))) { throw "Playwright runtime unavailable at $nodeModules" }
$env:NODE_PATH = $nodeModules
& node (Join-Path $root 'src\auth-setup.cjs')
exit $LASTEXITCODE
