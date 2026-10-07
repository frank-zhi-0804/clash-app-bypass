param([ValidateSet('dev','build','web')][string]$Mode = 'dev')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 22 LTS or newer, then reopen this launcher.' }
  if ($Mode -ne 'web') {
    if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { throw 'Please install Rust (rustup) and Visual Studio C++ Build Tools first. See README.md.' }
    & rustc --version
    if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain is missing. Run: rustup default stable' }
  }
  if (-not (Test-Path -LiteralPath 'node_modules\@mui\material\package.json')) {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'Dependency download failed. Check network access to npm.' }
  }
  & node scripts/generate-icon.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
  if ($Mode -eq 'build') { & npm.cmd run desktop:build }
  elseif ($Mode -eq 'web') { & npm.cmd run dev -- --open }
  else { & npm.cmd run desktop }
  if ($LASTEXITCODE -ne 0) { throw 'Build/start failed. See the error output above.' }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
