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
$oldBatch = $env:VERGE_DIRECT_INSPECT_BATCH
$junction = $null
try {
  $env:VERGE_DIRECT_INSPECT_BATCH = $null
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

  $script:inventoryReads = 0
  $script:rootReads = 0
  function Get-CimInstance { param([string]$ClassName) $script:inventoryReads++; $mockInventory }
  function Get-ChildItem {
    param([string]$LiteralPath, [string]$ErrorAction)
    if ($LiteralPath -ieq $appDir) { $script:rootReads++ }
    Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -ErrorAction $ErrorAction
  }
  $batchPaths = @($mainPath, $helperPath, (Join-Path $testRoot 'QQ\QQ.exe'))
  $singleApps = @()
  foreach ($path in $batchPaths) {
    $env:VERGE_DIRECT_INSPECT = $path
    $inspected = Invoke-Expression $scanSource | ConvertFrom-Json
    $singleApps += $inspected
  }
  $env:VERGE_DIRECT_INSPECT = $null
  $env:VERGE_DIRECT_INSPECT_BATCH = ConvertTo-Json -InputObject @($batchPaths + $mainPath + (Join-Path $testRoot 'missing.exe')) -Compress
  $script:inventoryReads = 0; $script:rootReads = 0
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  $singleJson = ConvertTo-Json -InputObject @($singleApps | Sort-Object id) -Depth 5 -Compress
  $batchJson = ConvertTo-Json -InputObject @($result | Sort-Object id) -Depth 5 -Compress
  if ($singleJson -cne $batchJson) { throw 'Batch inspection differs from individual inspections' }
  if ($script:inventoryReads -ne 1) { throw 'Batch inspection rebuilt the process inventory' }
  if ($script:rootReads -ne 1) { throw 'Batch inspection enumerated a shared directory more than once' }
  $env:VERGE_DIRECT_INSPECT_BATCH = '[]'
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  if (@($result).Count -ne 0) { throw 'Empty batch unexpectedly scanned all applications' }
  foreach ($invalid in @('{}', '[null]', '[7]', '[{}]', '[[]]', '[broken]', (ConvertTo-Json -InputObject (@('path') * 129) -Compress))) {
    $env:VERGE_DIRECT_INSPECT_BATCH = $invalid
    $rejected = $false
    try { $null = Invoke-Expression $scanSource } catch { $rejected = $true }
    if (-not $rejected) { throw 'Malformed or oversized batch was accepted' }
  }
  $env:VERGE_DIRECT_INSPECT_BATCH = $null
  Write-Output 'PASS: batch equivalence, duplicate/missing paths, shared inventory/directory cache, empty and invalid batches'

  # Product metadata alone does not trust an external child. Require a valid,
  # identical signer; mocked signatures keep this test independent of trust stores.
  $trustedRoot = Join-Path $testRoot 'Trusted'
  New-Item -ItemType Directory -Path $trustedRoot | Out-Null
  $trustedMain = Join-Path $trustedRoot 'trusted.exe'
  $trustedChild = Join-Path $otherDir 'trusted-child.exe'
  $differentSigner = Join-Path $otherDir 'different-signer.exe'
  $invalidSigner = Join-Path $otherDir 'invalid-signer.exe'
  foreach ($fixture in @($trustedMain, $trustedChild, $differentSigner, $invalidSigner)) {
    Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\cmd.exe') -Destination $fixture
  }
  if (-not [Diagnostics.FileVersionInfo]::GetVersionInfo($trustedMain).ProductName) { throw 'Signed-product fixture has no metadata' }
  $script:signatureReads = @{}
  function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    $script:signatureReads[$LiteralPath] = 1 + [int]$script:signatureReads[$LiteralPath]
    $status = 'Valid'; $thumbprint = 'MATCHING'
    if ($LiteralPath -ieq $differentSigner) { $thumbprint = 'DIFFERENT' }
    if ($LiteralPath -ieq $invalidSigner) { $status = 'HashMismatch' }
    [pscustomobject]@{ Status = $status; SignerCertificate = [pscustomobject]@{ Thumbprint = $thumbprint } }
  }
  $mockInventory = @([pscustomobject]@{ ProcessId = 1; ParentProcessId = 0; CreationDate = $created; ExecutablePath = $trustedMain })
  $procId = 2
  foreach ($path in @($trustedChild, $trustedChild, $differentSigner, $invalidSigner, $childPath)) {
    $mockInventory += [pscustomobject]@{ ProcessId = $procId; ParentProcessId = 1; CreationDate = $created.AddSeconds($procId); ExecutablePath = $path }
    $procId++
  }
  $env:VERGE_DIRECT_INSPECT = $trustedMain
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  if ($result.processes -notcontains $trustedChild -or $result.suggestedProcesses -contains $trustedChild) { throw 'Matching valid signer/product was not automatically associated' }
  foreach ($candidate in @($differentSigner, $invalidSigner, $childPath)) {
    if ($result.processes -contains $candidate -or $result.suggestedProcesses -notcontains $candidate) { throw 'Untrusted external child escaped confirmation' }
  }
  if ($script:signatureReads[$trustedMain] -ne 1 -or $script:signatureReads[$trustedChild] -ne 1) { throw 'Signature cache did not reuse repeated verification' }
  Write-Output 'PASS: matching valid signer/product auto association, changed/invalid signer and metadata confirmation, signature cache'

  # A running path can expose a junction even though disk traversal skips it.
  $junction = Join-Path $appDir 'linked-child'
  New-Item -ItemType Junction -Path $junction -Target $otherDir | Out-Null
  $linkedHelper = Join-Path $junction 'steamwebhelper.exe'
  $mockInventory = @(
    [pscustomobject]@{ ProcessId = 1; ParentProcessId = 0; CreationDate = $created; ExecutablePath = $mainPath },
    [pscustomobject]@{ ProcessId = 2; ParentProcessId = 0; CreationDate = $created; ExecutablePath = $linkedHelper }
  )
  $env:VERGE_DIRECT_INSPECT = $mainPath
  $result = Invoke-Expression $scanSource | ConvertFrom-Json
  if ($result.processes -contains $linkedHelper) { throw 'Running helper through a junction was automatically associated' }
  if ($result.processes -contains $externalPath) { throw 'Directory traversal followed a junction into another installation' }
  Write-Output 'PASS: running helpers and disk traversal cannot cross a directory junction'
} finally {
  $env:VERGE_DIRECT_INSPECT = $oldInspect
  $env:VERGE_DIRECT_INSPECT_BATCH = $oldBatch
  # Remove the junction itself before recursive cleanup; never traverse its target.
  if ($junction -and (Test-Path -LiteralPath $junction)) { [IO.Directory]::Delete($junction) }
  # Cleanup is strictly limited to the unique fixture directory created above.
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('clash-app-bypass-scan-'))) { throw 'Unexpected fixture cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
