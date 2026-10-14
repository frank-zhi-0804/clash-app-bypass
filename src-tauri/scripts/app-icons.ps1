Set-StrictMode -Version 2.0

function Get-SafeLocalPath {
  param([string]$Path, [switch]$Directory, [string[]]$Extensions)
  try {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 32767 -or $Path -match '[\x00-\x1f]') { return $null }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
    if ($expanded -notmatch '^[A-Za-z]:[\\/]') { return $null }
    $full = [IO.Path]::GetFullPath($expanded)
    if ($full.Substring(2).Contains(':')) { return $null }
    $root = [IO.Path]::GetPathRoot($full)
    $drive = New-Object IO.DriveInfo($root)
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { return $null }
    # Walk root to leaf before touching descendants; never follow junctions.
    $attributes = [IO.File]::GetAttributes($root)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    $parts = $full.Substring($root.Length).Split([char[]]@('\','/'), [StringSplitOptions]::RemoveEmptyEntries)
    $current = $root
    for ($i = 0; $i -lt $parts.Length; $i++) {
      if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { return $null }
      $current = [IO.Path]::Combine($current, $parts[$i])
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    }
    $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
    if ($Directory -and -not $isDirectory) { return $null }
    if (-not $Directory -and $isDirectory) { return $null }
    if ($Extensions -and $Extensions -notcontains [IO.Path]::GetExtension($full).ToLowerInvariant()) { return $null }
    return $full
  } catch { return $null }
}

function Get-AppIconRoots {
  @(
    [pscustomobject]@{ Path = [Environment]::GetFolderPath('DesktopDirectory'); Priority = 4 },
    [pscustomobject]@{ Path = [Environment]::GetFolderPath('CommonDesktopDirectory'); Priority = 3 },
    [pscustomobject]@{ Path = [Environment]::GetFolderPath('StartMenu'); Priority = 2 },
    [pscustomobject]@{ Path = [Environment]::GetFolderPath('CommonStartMenu'); Priority = 1 }
  )
}

function Get-AppIconShortcuts {
  $seen = @{}
  $count = 0
  foreach ($entry in (Get-AppIconRoots | Sort-Object Priority -Descending)) {
    $root = Get-SafeLocalPath -Path $entry.Path -Directory
    if (-not $root) { continue }
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue([pscustomobject]@{ Path = $root; Depth = 0 })
    while ($queue.Count -gt 0 -and $count -lt 4096) {
      $directory = $queue.Dequeue()
      try { $children = @([IO.Directory]::EnumerateFileSystemEntries($directory.Path) | Select-Object -First (4096 - $count) | Sort-Object) } catch { continue }
      foreach ($child in $children) {
        if ($count -ge 4096) { break }
        $count++
        try { $attributes = [IO.File]::GetAttributes($child) } catch { continue }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          if ($directory.Depth -lt 8) { $queue.Enqueue([pscustomobject]@{ Path = $child; Depth = ($directory.Depth + 1) }) }
          continue
        }
        if ([IO.Path]::GetExtension($child) -ine '.lnk' -or $seen.ContainsKey($child)) { continue }
        $seen[$child] = $true
        [pscustomobject]@{ Path = $child; Priority = $entry.Priority }
      }
    }
  }
}

function Get-AppIconLocation {
  param([string]$Location)
  if ([string]::IsNullOrWhiteSpace($Location)) { return $null }
  $text = $Location.Trim()
  $index = 0
  $match = [regex]::Match($text, '^(.*),\s*(-?\d+)\s*$')
  if ($match.Success) {
    if (-not [int]::TryParse($match.Groups[2].Value, [ref]$index)) { return $null }
    $text = $match.Groups[1].Value
  }
  $path = Get-SafeLocalPath -Path $text -Extensions @('.exe','.dll','.ico','.icl')
  if (-not $path) { return $null }
  [pscustomobject]@{ Path = $path; Index = $index }
}
function Initialize-AppIconNative {
  if ('ClashAppBypass.AppIconsNative' -as [type]) { return }
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace ClashAppBypass {
  public static class AppIconsNative {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern int SHDefExtractIconW(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern uint ExtractIconExW(string file, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll", ExactSpelling=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr icon);
  }
}
"@ -ErrorAction Stop
}

function Get-AppIconPng {
  param([string]$IconPath, [int]$Index = 0)
  $safe = Get-SafeLocalPath -Path $IconPath -Extensions @('.exe','.dll','.ico','.icl')
  if (-not $safe) { return $null }
  $large = [IntPtr]::Zero
  $small = [IntPtr]::Zero
  $icon = $source = $bitmap = $graphics = $stream = $null
  try {
    Initialize-AppIconNative
    $hr = [ClashAppBypass.AppIconsNative]::SHDefExtractIconW($safe, $Index, 0, [ref]$large, [ref]$small, [uint32](64 -bor (32 -shl 16)))
    if ($hr -lt 0 -or ($large -eq [IntPtr]::Zero -and $small -eq [IntPtr]::Zero)) {
      if ($large -ne [IntPtr]::Zero) { [void][ClashAppBypass.AppIconsNative]::DestroyIcon($large) }
      if ($small -ne [IntPtr]::Zero -and $small -ne $large) { [void][ClashAppBypass.AppIconsNative]::DestroyIcon($small) }
      $large = $small = [IntPtr]::Zero
      [void][ClashAppBypass.AppIconsNative]::ExtractIconExW($safe, $Index, [ref]$large, [ref]$small, 1)
    }
    $handle = $large
    if ($handle -eq [IntPtr]::Zero) { $handle = $small }
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $icon = [Drawing.Icon]::FromHandle($handle)
    $source = $icon.ToBitmap()
    $bitmap = New-Object Drawing.Bitmap(64, 64, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source, (New-Object Drawing.Rectangle(0, 0, 64, 64)))
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -gt 131072) { return $null }
    return 'data:image/png;base64,' + [Convert]::ToBase64String($stream.ToArray())
  } catch { return $null }
  finally {
    foreach ($resource in @($graphics, $source, $bitmap, $stream, $icon)) {
      if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
    }
    if ($large -ne [IntPtr]::Zero) { [void][ClashAppBypass.AppIconsNative]::DestroyIcon($large) }
    if ($small -ne [IntPtr]::Zero -and $small -ne $large) { [void][ClashAppBypass.AppIconsNative]::DestroyIcon($small) }
  }
}
function Invoke-AppIconBatch {
  param($Requests)
  $items = @($Requests)
  if ($items.Count -gt 32) { throw 'Icon batches must contain at most 32 requests.' }
  $result = @{}
  $valid = @{}
  $targets = @{}
  foreach ($request in $items) {
    try {
      $id = [string]$request.id
      if ([string]::IsNullOrWhiteSpace($id) -or $id.Length -gt 2048) { continue }
      $result[$id] = $null
      $path = Get-SafeLocalPath -Path ([string]$request.path) -Extensions @('.exe')
      if (-not $path) { continue }
      $hint = $null
      if ($request.PSObject.Properties['shortcutPath']) { $hint = [string]$request.shortcutPath }
      $valid[$id] = [pscustomobject]@{ Path = $path; Hint = $hint }
      $targets[$path] = $true
    } catch { continue }
  }
  if ($valid.Count -eq 0) { return $result }
  $shortcuts = @{}
  $shell = $null
  try {
    $shell = New-Object -ComObject WScript.Shell -ErrorAction Stop
    foreach ($candidate in (Get-AppIconShortcuts | Sort-Object @{Expression='Priority';Descending=$true}, Path)) {
      $link = $null
      try {
        $linkPath = Get-SafeLocalPath -Path $candidate.Path -Extensions @('.lnk')
        if (-not $linkPath) { continue }
        $link = $shell.CreateShortcut($linkPath)
        # Parameterized shortcuts can belong to another website or game.
        if (-not [string]::IsNullOrWhiteSpace([string]$link.Arguments)) { continue }
        $target = Get-SafeLocalPath -Path ([string]$link.TargetPath) -Extensions @('.exe')
        if (-not $target -or -not $targets.ContainsKey($target)) { continue }
        $location = Get-AppIconLocation -Location ([string]$link.IconLocation)
        if (-not $location) { continue }
        if (-not $shortcuts.ContainsKey($target)) { $shortcuts[$target] = New-Object 'System.Collections.Generic.List[object]' }
        $shortcuts[$target].Add([pscustomobject]@{ Link = $linkPath; Path = $location.Path; Index = $location.Index; Priority = $candidate.Priority })
      } catch { continue }
      finally { if ($null -ne $link -and [Runtime.InteropServices.Marshal]::IsComObject($link)) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) } catch {} } }
    }
  } catch { }
  finally { if ($null -ne $shell -and [Runtime.InteropServices.Marshal]::IsComObject($shell)) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) } catch {} } }
  $pngCache = @{}
  foreach ($id in $valid.Keys) {
    $app = $valid[$id]
    $candidates = @()
    if ($shortcuts.ContainsKey($app.Path)) {
      $all = @($shortcuts[$app.Path].ToArray())
      # Honor hints only from a discovered safe root and matching executable.
      # Root priority remains authoritative, even if an old hint points at Start Menu.
      $candidates = @($all | Sort-Object @{Expression='Priority';Descending=$true}, @{Expression={ [int]($_.Link -ieq $app.Hint) };Descending=$true}, Link)
    }
    $candidates += [pscustomobject]@{ Path = $app.Path; Index = 0 }
    foreach ($candidate in $candidates) {
      $key = $candidate.Path + '|' + [string]$candidate.Index
      if (-not $pngCache.ContainsKey($key)) { $pngCache[$key] = Get-AppIconPng -IconPath $candidate.Path -Index $candidate.Index }
      if ($pngCache[$key]) { $result[$id] = $pngCache[$key]; break }
    }
  }
  return $result
}

if ($MyInvocation.InvocationName -ne '.') {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $output = Invoke-AppIconBatch -Requests $payload.requests
    [Console]::Out.Write(($output | ConvertTo-Json -Depth 4 -Compress))
  } catch { [Console]::Out.Write('{}') }
}
