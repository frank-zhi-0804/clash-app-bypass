$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AppIconTestNative {
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetGuiResources(IntPtr process,int flag);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryExW(string path,IntPtr file,uint flags);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
 delegate bool EnumName(IntPtr module,IntPtr type,IntPtr name,IntPtr parameter);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool EnumResourceNamesW(IntPtr module,IntPtr type,EnumName callback,IntPtr parameter);
 public static int FirstGroupIconId(string path) {
  var module=LoadLibraryExW(path,IntPtr.Zero,2);if(module==IntPtr.Zero)throw new Exception("LoadLibraryEx failed");int found=0;
  try { EnumName callback=(m,t,n,p)=>{long value=n.ToInt64();if(value>0&&value<=65535){found=(int)value;return false;}return true;};
   EnumResourceNamesW(module,new IntPtr(14),callback,IntPtr.Zero);GC.KeepAlive(callback);
  }finally{FreeLibrary(module);}if(found==0)throw new Exception("No integer group icon");return found;
 }
}
"@
function Assert-Icon($Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Decode-TestIcon($Data){
 Assert-Icon ($Data -is [string] -and $Data.StartsWith('data:image/png;base64,')) 'PNG data URL expected'
 $bytes=[Convert]::FromBase64String($Data.Substring(22));Assert-Icon ($bytes.Length -le 131072) 'PNG too large'
 $stream=[IO.MemoryStream]::new($bytes,$false)
 try{$bitmap=[Drawing.Bitmap]::new($stream);try{
  Assert-Icon ($bitmap.Width -eq 64 -and $bitmap.Height -eq 64) 'Expected 64 square PNG'
  $transparent=0;$magenta=0;$green=0
  for($y=0;$y -lt 64;$y++){for($x=0;$x -lt 64;$x++){
   $c=$bitmap.GetPixel($x,$y);if($c.A -lt 255){$transparent++}
   if($c.A -gt 220 -and $c.R -gt 180 -and $c.B -gt 180 -and $c.G -lt 80){$magenta++}
   if($c.A -gt 220 -and $c.G -gt 180 -and $c.R -lt 80 -and $c.B -lt 80){$green++}
  }};[pscustomobject]@{Transparent=$transparent;Magenta=$magenta;Green=$green}
 }finally{$bitmap.Dispose()}}finally{$stream.Dispose()}
}
function New-TestIco([string]$Path){
 $bmp=[Drawing.Bitmap]::new(64,64,[Drawing.Imaging.PixelFormat]::Format32bppArgb);$g=[Drawing.Graphics]::FromImage($bmp)
 $left=[Drawing.SolidBrush]::new([Drawing.Color]::Magenta);$right=[Drawing.SolidBrush]::new([Drawing.Color]::Lime)
 $h=[IntPtr]::Zero;$wrapped=$owned=$file=$null
 try{$g.Clear([Drawing.Color]::Transparent);$g.FillRectangle($left,8,8,16,48);$g.FillRectangle($right,40,8,16,48)
  $h=$bmp.GetHicon();$wrapped=[Drawing.Icon]::FromHandle($h);$owned=$wrapped.Clone();$file=[IO.File]::Open($Path,[IO.FileMode]::Create);$owned.Save($file)
 }finally{foreach($r in @($file,$owned,$wrapped,$left,$right,$g,$bmp)){if($r){$r.Dispose()}};if($h -ne [IntPtr]::Zero){[void][AppIconTestNative]::DestroyIcon($h)}}
}
function New-TestShortcut([string]$Path,[string]$Target,[string]$IconLocation,[string]$Arguments=''){
 $shell=$link=$null;try{$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($Path);$link.TargetPath=$Target;$link.Arguments=$Arguments;$link.IconLocation=$IconLocation;$link.Save()}
 finally{if($link){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)};if($shell){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}}
}
function Request-TestIcon([string]$Id,[string]$Path,[string]$Shortcut=''){
 $map=Invoke-AppIconBatch @([pscustomobject]@{id=$Id;path=$Path;shortcutPath=$Shortcut});Assert-Icon ($map.ContainsKey($Id)) ('Missing result '+$Id);$map[$Id]
}
function Set-TestCase([string]$Name){$script:IconActiveRoot=Join-Path $script:IconTestDirectory $Name;[void][IO.Directory]::CreateDirectory($script:IconActiveRoot)}
$tempBase=[IO.Path]::GetFullPath($env:TEMP)
$script:IconTestDirectory=Join-Path $tempBase ('clash-bypass-icon-tests-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($script:IconTestDirectory)
$oldEnv=[Environment]::GetEnvironmentVariable('CLASH_BYPASS_ICON_TEST_ROOT','Process')
$junction=Join-Path $script:IconTestDirectory 'junction'
try {
 . (Join-Path $repo 'src-tauri/scripts/app-icons.ps1')
 function Get-AppIconRoots {@([pscustomobject]@{Path=$script:IconActiveRoot;Priority=3})}
 $exe=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $dll=Join-Path $env:WINDIR 'System32/shell32.dll'
 Set-TestCase 'baseline';$baseline=Request-TestIcon 'baseline' $exe;[void](Decode-TestIcon $baseline)
 $ico=Join-Path $script:IconTestDirectory 'custom, icon.ico';New-TestIco $ico
 Set-TestCase 'custom';$customLink=Join-Path $script:IconActiveRoot 'custom.lnk';New-TestShortcut $customLink $exe ($ico+',0')
 $custom=Request-TestIcon 'custom' $exe $customLink;$pixels=Decode-TestIcon $custom
 Assert-Icon ($pixels.Magenta -gt 150 -and $pixels.Green -gt 150 -and $pixels.Transparent -gt 150) 'Custom ICO and alpha not honored'
 Assert-Icon ($custom -ne $baseline) 'Shortcut must override embedded icon'
 Write-Output 'PASS: custom shortcut ICO, comma filename and transparent 64px PNG'
 [Environment]::SetEnvironmentVariable('CLASH_BYPASS_ICON_TEST_ROOT',$script:IconTestDirectory,'Process')
 Set-TestCase 'env';$link=Join-Path $script:IconActiveRoot 'env.lnk';New-TestShortcut $link $exe '%CLASH_BYPASS_ICON_TEST_ROOT%\custom, icon.ico,0'
 $pixels=Decode-TestIcon (Request-TestIcon 'env' $exe $link);Assert-Icon ($pixels.Magenta -gt 150 -and $pixels.Green -gt 150) 'Environment variable not resolved'
 $resource=[AppIconTestNative]::FirstGroupIconId($dll)
 foreach($index in @(0,(-$resource))){
  $expected=Get-AppIconPng $dll $index;[void](Decode-TestIcon $expected)
  Set-TestCase ('resource'+$index);$link=Join-Path $script:IconActiveRoot 'resource.lnk';New-TestShortcut $link $exe ($dll+','+$index)
  Assert-Icon ((Request-TestIcon 'resource' $exe $link) -eq $expected) 'Resource index not honored'
 }
 Write-Output 'PASS: environment variables and positive/negative resource indices'
 Set-TestCase 'missing';Assert-Icon ((Request-TestIcon 'missing' $exe (Join-Path $script:IconActiveRoot 'absent.lnk')) -eq $baseline) 'Missing shortcut fallback'
 $link=Join-Path $script:IconActiveRoot 'missing-icon.lnk';New-TestShortcut $link $exe ((Join-Path $script:IconActiveRoot 'absent.ico')+',0')
 Assert-Icon ((Request-TestIcon 'missingIcon' $exe $link) -eq $baseline) 'Missing icon fallback'
 Set-TestCase 'corrupt';$broken=Join-Path $script:IconActiveRoot 'broken.ico';[IO.File]::WriteAllText($broken,'not an icon')
 $link=Join-Path $script:IconActiveRoot 'corrupt.lnk';New-TestShortcut $link $exe ($broken+',0')
 Assert-Icon ((Request-TestIcon 'corrupt' $exe $link) -eq $baseline) 'Corrupt icon fallback'
 Set-TestCase 'mismatch';$link=Join-Path $script:IconActiveRoot 'other.lnk';New-TestShortcut $link (Join-Path $env:WINDIR 'System32/rundll32.exe') ($ico+',0')
 Assert-Icon ((Request-TestIcon 'mismatch' $exe $link) -eq $baseline) 'Different target accepted'
 Set-TestCase 'parameters';$marker=Join-Path $script:IconActiveRoot 'executed.txt';$link=Join-Path $script:IconActiveRoot 'parameters.lnk'
 New-TestShortcut $link $exe ($ico+',0') ('-NoProfile -Command "[IO.File]::WriteAllText('''+$marker+''',''bad'')"')
 Assert-Icon ((Request-TestIcon 'parameters' $exe $link) -eq $baseline) 'Parameterized logo accepted'
 Assert-Icon (-not (Test-Path -LiteralPath $marker)) 'Shortcut was executed'
 Write-Output 'PASS: missing, damaged, mismatched and parameterized shortcut fallbacks without execution'
 Set-TestCase 'mixed';$customLink=Join-Path $script:IconActiveRoot 'valid.lnk';New-TestShortcut $customLink $exe ($ico+',0')
 $invalid=@(
  [pscustomobject]@{id='unc';path='\\example.invalid\share\app.exe'},
  [pscustomobject]@{id='device';path='\\?\C:\app.exe'},
  [pscustomobject]@{id='relative';path='.\app.exe'},
  [pscustomobject]@{id='driveRelative';path='C:app.exe'},
  [pscustomobject]@{id='ads';path=($exe+':stream.exe')},
  [pscustomobject]@{id='url';path='https://example.invalid/app.exe'},
  [pscustomobject]@{id='missing';path=(Join-Path $script:IconActiveRoot 'missing.exe')},
  [pscustomobject]@{id='notExe';path=$ico},
  [pscustomobject]@{id='valid';path=$exe;shortcutPath=$customLink})
 $mixed=Invoke-AppIconBatch $invalid
 foreach($r in $invalid){if($r.id -ne 'valid'){Assert-Icon ($mixed.ContainsKey($r.id) -and $null -eq $mixed[$r.id]) ('Unsafe path '+$r.id)}}
 [void](Decode-TestIcon $mixed['valid'])
 Write-Output 'PASS: unsafe source rejection and failed item isolation'
 $realDir=Join-Path $script:IconTestDirectory 'real';[void][IO.Directory]::CreateDirectory($realDir)
 $copiedExe=Join-Path $realDir 'fixture.exe';[IO.File]::Copy($exe,$copiedExe)
 [void](New-Item -ItemType Junction -Path $junction -Target $realDir)
 Assert-Icon ($null -eq (Request-TestIcon 'junction' (Join-Path $junction 'fixture.exe'))) 'Junction source accepted'
 Set-TestCase 'remote';$link=Join-Path $script:IconActiveRoot 'remote.lnk';New-TestShortcut $link $exe '\\example.invalid\share\icon.ico,0'
 Assert-Icon ((Request-TestIcon 'remote' $exe $link) -eq $baseline) 'Remote icon hint accepted'
 Write-Output 'PASS: junction source and remote icon hint rejection'
 Set-TestCase 'priority'
 $desktop=Join-Path $script:IconActiveRoot 'desktop';$start=Join-Path $script:IconActiveRoot 'start';[void][IO.Directory]::CreateDirectory($desktop);[void][IO.Directory]::CreateDirectory($start)
 $desktopLink=Join-Path $desktop 'custom.lnk';$startLink=Join-Path $start 'custom.lnk'
 New-TestShortcut $desktopLink $exe ($ico+',0');New-TestShortcut $startLink $exe ($dll+',0')
 function Get-AppIconRoots {@([pscustomobject]@{Path=$desktop;Priority=4},[pscustomobject]@{Path=$start;Priority=2})}
 Assert-Icon ((Request-TestIcon 'priority' $exe $startLink) -eq $custom) 'Old Start Menu hint overrode desktop icon'
 New-TestShortcut $desktopLink $exe ($dll+',0')
 Assert-Icon ((Request-TestIcon 'updated' $exe $desktopLink) -eq (Get-AppIconPng $dll 0)) 'Updated custom icon not observed on fresh batch'
 Write-Output 'PASS: desktop precedence and fresh-batch icon updates'
 $batch=@(1..32 | ForEach-Object {[pscustomobject]@{id=('batch'+$_);path=$exe}})
 Assert-Icon ((Invoke-AppIconBatch $batch).Count -eq 32) '32-item batch failed'
 $threw=$false;try{[void](Invoke-AppIconBatch ($batch+@([pscustomobject]@{id='extra';path=$exe})))}catch{$threw=$true};Assert-Icon $threw 'Oversized batch accepted'
 Assert-Icon ((Invoke-AppIconBatch @()).Count -eq 0) 'Empty batch failed'
 Write-Output 'PASS: empty and bounded 32-item batches'
 1..10 | ForEach-Object {[void](Get-AppIconPng $ico 0)}
 [GC]::Collect();[GC]::WaitForPendingFinalizers();[GC]::Collect();$process=[Diagnostics.Process]::GetCurrentProcess()
 $beforeGdi=[AppIconTestNative]::GetGuiResources($process.Handle,0);$beforeUser=[AppIconTestNative]::GetGuiResources($process.Handle,1)
 1..100 | ForEach-Object {[void](Get-AppIconPng $ico 0)}
 [GC]::Collect();[GC]::WaitForPendingFinalizers();[GC]::Collect()
 $afterGdi=[AppIconTestNative]::GetGuiResources($process.Handle,0);$afterUser=[AppIconTestNative]::GetGuiResources($process.Handle,1);$process.Dispose()
 Assert-Icon (($afterGdi-$beforeGdi) -le 16 -and ($afterUser-$beforeUser) -le 16) 'USER/GDI handles accumulating'
 Write-Output 'PASS: 100 native extractions without USER/GDI handle accumulation'
} finally {
 [Environment]::SetEnvironmentVariable('CLASH_BYPASS_ICON_TEST_ROOT',$oldEnv,'Process')
 $resolved=[IO.Path]::GetFullPath($script:IconTestDirectory);$prefix=$tempBase.TrimEnd('\')+'\clash-bypass-icon-tests-'
 if(-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path'}
 if(Test-Path -LiteralPath $junction){
  $attributes=[IO.File]::GetAttributes($junction)
  if(($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){throw 'Unexpected cleanup junction'}
  [IO.Directory]::Delete($junction)
  Assert-Icon (-not (Test-Path -LiteralPath $junction)) 'Junction remained during cleanup'
 }
 if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
