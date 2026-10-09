$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$entries = @{}
$inventory = @(Get-CimInstance Win32_Process)
$processes = @($inventory | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) })
$processById = @{}
$signatureCache = @{}
$directoryCache = @{}
$productCache = @{}
$linkCache = @{}
function Test-LinkedPath([string]$path) {
  $checked = @(); $linked = $false
  while ($path) {
    if ($linkCache.ContainsKey($path)) { $linked = $linkCache[$path]; break }
    $checked += $path
    try { if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $linked = $true; break } } catch { $linked = $true; break }
    $path = [IO.Path]::GetDirectoryName($path)
  }
  foreach ($item in $checked) { $linkCache[$item] = $linked }
  return $linked
}
function Get-Product([string]$path) {
  if (-not $productCache.ContainsKey($path)) {
    $value = ''; try { $value = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductName } catch {}
    $productCache[$path] = $value
  }
  return $productCache[$path]
}
function Get-VerifiedSigner([string]$path) {
  if (-not $signatureCache.ContainsKey($path)) {
    $thumbprint = ''
    try { $signature = Get-AuthenticodeSignature -LiteralPath $path; if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate) { $thumbprint = $signature.SignerCertificate.Thumbprint } } catch {}
    $signatureCache[$path] = $thumbprint
  }
  return $signatureCache[$path]
}
foreach ($proc in $inventory) { if ($proc.ProcessId) { $processById[[string]$proc.ProcessId] = $proc } }
$windowsRoot = [IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\') + '\'
function Get-ValorantPaths([string]$path) {
  $root = [IO.Path]::GetDirectoryName($path)
  for ($depth = 0; $root -and $depth -lt 6; $depth++) {
    $prefix = $root.TrimEnd('\') + '\'
    $anchors = @('WeGameLauncher\launcher.exe', 'live\VALORANT.exe', 'live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe', 'ACLOS\aclos-launcher.exe', 'ACLOS\Launcher\无畏契约登录器.exe')
    if ($anchors -icontains $path.Substring($prefix.Length)) {
      $relative = @('live\VALORANT.exe', 'live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe', 'WeGameLauncher\launcher.exe', 'WeGameLauncher\TenioDL\TenioDL.exe', 'ACLOS\aclos-launcher.exe', 'ACLOS\Launcher\无畏契约登录器.exe', 'ACLOS\Proxy\AclosGameProxy.exe', 'ACLOS\Cross\Core\Stable\CrossProxy.exe', 'ACLOS\Cross\qbblinktrial\browser.exe')
      $safe = @()
      foreach ($item in $relative) {
        $candidate = Join-Path $root $item
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        if (-not (Test-LinkedPath $candidate)) { $safe += $candidate }
      }
      if ($safe -icontains (Join-Path $root $relative[0]) -and $safe -icontains (Join-Path $root $relative[1])) { return $safe }
    }
    $root = [IO.Path]::GetDirectoryName($root)
  }
}
function Add-App([string]$path, [string]$name, [string]$source) {
  if (-not $path -or -not $path.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
  try { $full = [IO.Path]::GetFullPath($path) } catch { return }
  if ($full.StartsWith($windowsRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
  $id = $full.ToLowerInvariant()
  if ($entries.ContainsKey($id)) { return }
  if (-not $name) { $name = Get-Product $full }
  if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($full) }
  $entries[$id] = [ordered]@{ id = $id; name = $name; path = $full; running = $false; processes = @($full); suggestedProcesses = @(); source = $source; warnings = @() }
}
$isInspection = [bool]($env:VERGE_DIRECT_INSPECT_BATCH -or $env:VERGE_DIRECT_INSPECT)
if ($env:VERGE_DIRECT_INSPECT_BATCH) {
  $batch = $env:VERGE_DIRECT_INSPECT_BATCH.Trim()
  if (-not $batch.StartsWith('[') -or -not $batch.EndsWith(']')) { throw '批量程序路径必须是 JSON 数组' }
  $paths = ConvertFrom-Json -InputObject $batch
  if ($paths.Count -gt 128) { throw '一次最多扫描 128 个程序' }
  foreach ($path in $paths) {
    if ($path -isnot [string]) { throw '程序路径必须是字符串' }
    Add-App $path '' '手动添加'
  }
} elseif ($env:VERGE_DIRECT_INSPECT) {
  Add-App $env:VERGE_DIRECT_INSPECT '' '手动添加'
} else {
  $shell = New-Object -ComObject WScript.Shell
  $roots = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  foreach ($root in $roots) {
    foreach ($link in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue)) {
      try { $shortcut = $shell.CreateShortcut($link.FullName); Add-App $shortcut.TargetPath $link.BaseName '快捷方式' } catch {}
    }
  }
  # Running executables without a shortcut remain available as process entries.
  foreach ($proc in $processes) { Add-App $proc.ExecutablePath '' '运行进程' }
}
foreach ($entry in $entries.Values) {
  $entry.running = @($processes | Where-Object { $_.ExecutablePath -ieq $entry.path }).Count -gt 0
  $appRoot = [IO.Path]::GetDirectoryName($entry.path)
  $rootPrefix = $appRoot.TrimEnd('\') + '\'
  $genericRoots = @($env:USERPROFILE, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $env:APPDATA, [IO.Path]::GetPathRoot($appRoot), (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'))
  if ($genericRoots -icontains $appRoot) { $entry.warnings += '程序位于公共目录，仅关联主程序。建议选择安装目录内的程序。'; continue }
  $product = Get-Product $entry.path
  $helperNames = @()
  $helperRelativePaths = @()
  switch ([IO.Path]::GetFileName($entry.path).ToLowerInvariant()) {
    'steam.exe' { $helperNames = @('steamwebhelper.exe', 'gameoverlayui.exe', 'steamerrorreporter.exe') }
    'wechat.exe' { $helperNames = @('wechatappex.exe', 'wechatutility.exe', 'wechatplayer.exe') }
    'weixin.exe' { $helperNames = @('weixinappex.exe', 'weixinutility.exe') }
    'qq.exe' { $helperNames = @('qqcrashreport.exe', 'qqexternal.exe', 'qqex.exe') }
    # This browser has different product metadata. Match only WeGame's known subdirectory.
    'wegame.exe' { $helperRelativePaths = @('qbblinktrial\browser.exe') }
    'cloudmusic.exe' { $helperNames = @('cloudmusic_reporter.exe', 'cloudmusic_helper.exe') }
  }
  $candidates = @($processes | Where-Object { $_.ExecutablePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ExecutablePath })
  if ($isInspection) {
    if (-not $directoryCache.ContainsKey($appRoot)) {
    # Limit traversal depth and never follow junctions into unrelated installations.
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@($appRoot, 0)); $visited = 0; $diskPaths = @()
    while ($queue.Count -gt 0 -and $visited -lt 2000) {
      $item = $queue.Dequeue()
      foreach ($child in @(Get-ChildItem -LiteralPath $item[0] -ErrorAction SilentlyContinue)) {
        $visited++
        if ($visited -gt 2000) { break }
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($child.PSIsContainer -and $item[1] -lt 3) { $queue.Enqueue(@($child.FullName, ($item[1] + 1))) }
        elseif (-not $child.PSIsContainer -and $child.Extension -ieq '.exe') { $diskPaths += $child.FullName }
      }
    }
    $directoryCache[$appRoot] = @{ Paths = $diskPaths; Limited = $visited -ge 2000 }
    }
    $candidates += $directoryCache[$appRoot].Paths
    if ($directoryCache[$appRoot].Limited) { $entry.warnings += '程序目录较大，扫描达到上限。未识别的辅助程序可单独添加。' }
  }
  $linkedCandidate = $false
  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if (Test-LinkedPath $candidate) { $linkedCandidate = $true; continue }
    $isRelated = $helperNames -icontains [IO.Path]::GetFileName($candidate)
    if (-not $isRelated -and $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      $relativePath = $candidate.Substring($rootPrefix.Length)
      $isRelated = $helperRelativePaths -icontains $relativePath
    }
    if (-not $isRelated -and $product) { $isRelated = (Get-Product $candidate) -ieq $product }
    if ($isRelated) { $entry.processes += $candidate }
  }
  if ($linkedCandidate) { $entry.warnings += '已跳过目录链接中的辅助程序，避免关联其他安装目录。' }
  $entry.processes = @($entry.processes | Select-Object -Unique)
  $valorantPaths = @(Get-ValorantPaths $entry.path)
  if ($valorantPaths.Count -gt 0) {
    $entry.processes = @(@($entry.processes + $valorantPaths) | Select-Object -Unique)
    $entry.warnings += '已按无畏契约安装结构关联游戏主程序和登录辅助程序。'
  }
  # A launcher may start another product outside its directory. Offer those paths
  # for review instead of silently bypassing every app launched by Steam/browsers.
  $relatedIds = @{}
  foreach ($proc in $processes) { if ($entry.processes -icontains $proc.ExecutablePath -and $proc.ProcessId) { $relatedIds[[string]$proc.ProcessId] = $true } }
  for ($depth = 0; $depth -lt 16; $depth++) {
    $added = $false
    foreach ($proc in $inventory) {
      $key = [string]$proc.ProcessId; $parentKey = [string]$proc.ParentProcessId
      if (-not $proc.ProcessId -or $relatedIds.ContainsKey($key) -or -not $relatedIds.ContainsKey($parentKey)) { continue }
      $parent = $processById[$parentKey]
      # PID reuse must not attach a child to a newer, unrelated parent.
      if (-not $proc.CreationDate -or -not $parent.CreationDate -or $proc.CreationDate -lt $parent.CreationDate) { continue }
      $relatedIds[$key] = $true; $added = $true
      $candidate = $proc.ExecutablePath
      if ($candidate -and $candidate.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and -not $candidate.StartsWith($windowsRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and $entry.processes -inotcontains $candidate) {
        $trusted = $false
        if ($product -and (Get-Product $candidate) -ieq $product -and -not (Test-LinkedPath $candidate)) {
          $signer = Get-VerifiedSigner $entry.path
          $trusted = $signer -and $signer -eq (Get-VerifiedSigner $candidate)
        }
        if ($trusted) { $entry.processes += $candidate }
        else { $entry.suggestedProcesses += $candidate }
      }
    }
    if (-not $added) { break }
  }
  $entry.suggestedProcesses = @($entry.suggestedProcesses | Select-Object -Unique)
  $entry.running = @($processes | Where-Object { $entry.processes -icontains $_.ExecutablePath }).Count -gt 0
  if ($entry.suggestedProcesses.Count -gt 0) { $entry.warnings += '发现启动链中的其他程序，请检查候选关联程序；确认后自动应用规则。' }
  if (@($inventory | Where-Object { $relatedIds.ContainsKey([string]$_.ProcessId) -and -not $_.ExecutablePath }).Count -gt 0) { $entry.warnings += '部分关联进程路径无法读取，关联清单可能不完整。' }
  $entry.warnings += '自动关联同产品信息或已知辅助进程；启动链候选需要确认，未识别的共享服务可单独添加。'
}
ConvertTo-Json -InputObject @($entries.Values | Sort-Object name) -Depth 5 -Compress
