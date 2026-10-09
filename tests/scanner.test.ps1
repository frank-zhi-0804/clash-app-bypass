$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('clash-app-bypass-scan-' + [guid]::NewGuid().ToString('N'))
$appDir = Join-Path $testRoot 'Steam'
$otherDir = Join-Path $testRoot 'Other'
New-Item -ItemType Directory -Path $appDir,$otherDir | Out-Null
$mainPath = Join-Path $appDir 'steam.exe'
$helperPath = Join-Path $appDir 'steamwebhelper.exe'
$unrelatedPath = Join-Path $appDir 'unrelated.exe'
$externalPath = Join-Path $otherDir 'steamwebhelper.exe'
@($mainPath,$helperPath,$unrelatedPath,$externalPath) | ForEach-Object { [IO.File]::WriteAllText($_, 'fixture, not executable') }
$oldInspect = $env:VERGE_DIRECT_INSPECT
try {
  # Mock only the process inventory; all fixture directory traversal uses the real filesystem.
  function Get-CimInstance {
    param([string]$ClassName)
    @([pscustomobject]@{ ExecutablePath = $mainPath }, [pscustomobject]@{ ExecutablePath = $externalPath })
  }
  $env:VERGE_DIRECT_INSPECT = $mainPath
  # Windows PowerShell 5.1 defaults to the system code page for BOM-less files.
  # Production passes this UTF-8 source as UTF-16 EncodedCommand; decode explicitly here too.
  $scanSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\src-tauri\scripts\scan.ps1'), [Text.Encoding]::UTF8)
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  if (@($result).Count -ne 1) { throw 'Expected exactly one inspected application' }
  if (-not $result.running) { throw 'Running main application was not detected' }
  if ($result.processes -notcontains $helperPath) { throw 'Known helper was not discovered on disk' }
  if ($result.processes -contains $unrelatedPath) { throw 'Unrelated executable was associated' }
  if ($result.processes -contains $externalPath) { throw 'External shared helper was associated' }
  Write-Output 'PASS: application selection, known helpers, unrelated files and external helpers'
  foreach ($case in @(
    @{ Main = 'QQ.exe'; Helper = 'QQEX.exe'; Unrelated = 'other.exe' },
    @{ Main = 'wegame.exe'; Helper = 'qbblinktrial\browser.exe'; Unrelated = 'Other\browser.exe' }
  )) {
    $caseRoot = Join-Path $testRoot ([IO.Path]::GetFileNameWithoutExtension($case.Main))
    $caseMain = Join-Path $caseRoot $case.Main
    $caseHelper = Join-Path $caseRoot $case.Helper
    $caseUnrelated = Join-Path $caseRoot $case.Unrelated
    foreach ($fixture in @($caseMain, $caseHelper, $caseUnrelated)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $fixture) -Force | Out-Null
      [IO.File]::WriteAllText($fixture, 'fixture, not executable')
    }
    $env:VERGE_DIRECT_INSPECT = $caseMain
    $result = Invoke-Expression $scanSource | ConvertFrom-Json
    if ($result.processes -notcontains $caseHelper) { throw "Missing application helper: $($case.Helper)" }
    if ($result.processes -contains $caseUnrelated) { throw "Unrelated helper was associated: $($case.Unrelated)" }
    if ($result.processes -contains $externalPath) { throw 'External helper was associated' }
    Write-Output "PASS: $($case.Main) associates $($case.Helper) without matching unrelated executables"
  }
  $gameRoot = Join-Path $testRoot 'Valorant'
  $gameRelative = @('WeGameLauncher\launcher.exe', 'live\VALORANT.exe', 'live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe', 'live\other-game.exe', 'ACLOS\Proxy\AclosGameProxy.exe')
  $gamePaths = @($gameRelative | ForEach-Object { Join-Path $gameRoot $_ })
  foreach ($fixture in $gamePaths) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $fixture) -Force | Out-Null
    [IO.File]::WriteAllText($fixture, 'fixture, not executable')
  }
  foreach ($anchor in $gamePaths[0..2]) {
    $env:VERGE_DIRECT_INSPECT = $anchor
    $result = Invoke-Expression $scanSource | ConvertFrom-Json
    foreach ($main in $gamePaths[1..2]) { if ($result.processes -notcontains $main) { throw 'Missing Valorant main executable' } }
    if ($result.processes -notcontains $gamePaths[4]) { throw 'Missing observed Valorant network helper' }
    if ($result.processes -contains $gamePaths[3]) { throw 'Unrelated game executable was associated' }
  }
  Remove-Item -LiteralPath $gamePaths[2]
  $env:VERGE_DIRECT_INSPECT = $gamePaths[0]
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  if ($result.processes -contains $gamePaths[1]) { throw 'Incomplete installation incorrectly identified as Valorant' }
  Write-Output 'PASS: Valorant launcher and game anchors, sibling main programs, unrelated and incomplete installations'
  $childPath = Join-Path $otherDir 'network-child.exe'
  $grandchildPath = Join-Path $otherDir 'network-grandchild.exe'
  @($childPath, $grandchildPath) | ForEach-Object { [IO.File]::WriteAllText($_, 'fixture, not executable') }
  $created = [DateTime]::UtcNow.AddMinutes(-5)
  $mockInventory = @(
    [pscustomobject]@{ ProcessId = 1; ParentProcessId = 0; CreationDate = $created; ExecutablePath = $mainPath },
    [pscustomobject]@{ ProcessId = 2; ParentProcessId = 1; CreationDate = $created.AddSeconds(1); ExecutablePath = $childPath },
    [pscustomobject]@{ ProcessId = 3; ParentProcessId = 2; CreationDate = $created.AddSeconds(2); ExecutablePath = $null },
    [pscustomobject]@{ ProcessId = 4; ParentProcessId = 3; CreationDate = $created.AddSeconds(3); ExecutablePath = $grandchildPath },
    [pscustomobject]@{ ProcessId = 5; ParentProcessId = 1; CreationDate = $created.AddSeconds(-1); ExecutablePath = $externalPath }
  )
  function Get-CimInstance { param([string]$ClassName) $mockInventory }
  $env:VERGE_DIRECT_INSPECT = $mainPath
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  foreach ($candidate in @($childPath, $grandchildPath)) {
    if ($result.suggestedProcesses -notcontains $candidate) { throw 'Startup-chain helper was not suggested' }
    if ($result.processes -contains $candidate) { throw 'Unconfirmed startup-chain helper was silently added' }
  }
  if ($result.suggestedProcesses -contains $externalPath) { throw 'Reused parent PID incorrectly associated an old process' }
  Write-Output 'PASS: external startup-chain candidates, unreadable intermediate processes, PID reuse, no silent association'
} finally {
  $env:VERGE_DIRECT_INSPECT = $oldInspect
  # Cleanup is strictly limited to the unique fixture directory created above.
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('clash-app-bypass-scan-'))) { throw 'Unexpected fixture cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
