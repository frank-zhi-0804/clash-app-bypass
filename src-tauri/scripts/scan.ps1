$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$entries = @{}
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) })
$windowsRoot = [IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\') + '\'
function Get-ValorantPaths([string]$path) {
  $root = [IO.Path]::GetDirectoryName($path)
  for ($depth = 0; $root -and $depth -lt 6; $depth++) {
    $prefix = $root.TrimEnd('\') + '\'
    $anchors = @('WeGameLauncher\launcher.exe', 'live\VALORANT.exe', 'live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe', 'ACLOS\aclos-launcher.exe', 'ACLOS\Launcher\无畏契约登录器.exe')
    if ($anchors -icontains $path.Substring($prefix.Length)) {
      $relative = @('live\VALORANT.exe', 'live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe', 'WeGameLauncher\launcher.exe', 'WeGameLauncher\TenioDL\TenioDL.exe', 'ACLOS\aclos-launcher.exe', 'ACLOS\Launcher\无畏契约登录器.exe', 'ACLOS\Cross\Core\Stable\CrossProxy.exe', 'ACLOS\Cross\qbblinktrial\browser.exe')
      $safe = @()
      foreach ($item in $relative) {
        $candidate = Join-Path $root $item
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $cursor = $candidate; $linked = $false
        while ($cursor) {
          if (((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $linked = $true; break }
          $cursor = [IO.Path]::GetDirectoryName($cursor)
        }
        if (-not $linked) { $safe += $candidate }
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
  if (-not $name) { try { $name = [Diagnostics.FileVersionInfo]::GetVersionInfo($full).ProductName } catch {} }
  if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($full) }
  $entries[$id] = [ordered]@{ id = $id; name = $name; path = $full; running = $false; processes = @($full); source = $source; warnings = @() }
}
if ($env:VERGE_DIRECT_INSPECT) {
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
  $product = ''; try { $product = [Diagnostics.FileVersionInfo]::GetVersionInfo($entry.path).ProductName } catch {}
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
  if ($env:VERGE_DIRECT_INSPECT) {
    # Limit traversal depth and never follow junctions into unrelated installations.
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@($appRoot, 0)); $visited = 0
    while ($queue.Count -gt 0 -and $visited -lt 2000) {
      $item = $queue.Dequeue()
      foreach ($child in @(Get-ChildItem -LiteralPath $item[0] -ErrorAction SilentlyContinue)) {
        $visited++
        if ($visited -gt 2000) { break }
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($child.PSIsContainer -and $item[1] -lt 3) { $queue.Enqueue(@($child.FullName, ($item[1] + 1))) }
        elseif (-not $child.PSIsContainer -and $child.Extension -ieq '.exe') { $candidates += $child.FullName }
      }
    }
    if ($visited -ge 2000) { $entry.warnings += '程序目录较大，扫描达到上限。未识别的辅助程序可单独添加。' }
  }
  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    $isRelated = $helperNames -icontains [IO.Path]::GetFileName($candidate)
    if (-not $isRelated -and $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      $relativePath = $candidate.Substring($rootPrefix.Length)
      $isRelated = $helperRelativePaths -icontains $relativePath
    }
    if (-not $isRelated -and $product) { try { $isRelated = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductName -ieq $product } catch {} }
    if ($isRelated) { $entry.processes += $candidate }
  }
  $entry.processes = @($entry.processes | Select-Object -Unique)
  $valorantPaths = @(Get-ValorantPaths $entry.path)
  if ($valorantPaths.Count -gt 0) {
    $entry.processes = @(@($entry.processes + $valorantPaths) | Select-Object -Unique)
    $entry.warnings += '已按无畏契约安装结构关联游戏主程序和登录辅助程序。'
  }
  $entry.warnings += '只关联同产品信息或已知辅助进程，目录外的共享服务需要单独添加。'
}
ConvertTo-Json -InputObject @($entries.Values | Sort-Object name) -Depth 5 -Compress
