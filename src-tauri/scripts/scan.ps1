$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$entries = @{}
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) })
$windowsRoot = [IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\') + '\'
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
  switch ([IO.Path]::GetFileName($entry.path).ToLowerInvariant()) {
    'steam.exe' { $helperNames = @('steamwebhelper.exe', 'gameoverlayui.exe', 'steamerrorreporter.exe') }
    'wechat.exe' { $helperNames = @('wechatappex.exe', 'wechatutility.exe', 'wechatplayer.exe') }
    'weixin.exe' { $helperNames = @('weixinappex.exe', 'weixinutility.exe') }
    'qq.exe' { $helperNames = @('qqcrashreport.exe', 'qqexternal.exe') }
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
    if (-not $isRelated -and $product) { try { $isRelated = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductName -ieq $product } catch {} }
    if ($isRelated) { $entry.processes += $candidate }
  }
  $entry.processes = @($entry.processes | Select-Object -Unique)
  $entry.warnings += '只关联同产品信息或已知辅助进程，目录外的共享服务需要单独添加。'
}
ConvertTo-Json -InputObject @($entries.Values | Sort-Object name) -Depth 5 -Compress
