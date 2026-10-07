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
} finally {
  $env:VERGE_DIRECT_INSPECT = $oldInspect
  # Cleanup is strictly limited to the unique fixture directory created above.
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('clash-app-bypass-scan-'))) { throw 'Unexpected fixture cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
