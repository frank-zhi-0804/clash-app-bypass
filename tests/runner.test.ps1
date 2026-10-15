$ErrorActionPreference='Stop'
function Assert-R($Ok,[string]$Message){if(-not $Ok){throw $Message}}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$boot=[IO.File]::ReadAllText((Join-Path $repo 'src-tauri/scripts/runner.ps1'),[Text.Encoding]::UTF8)
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($boot))
$ps=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$argsText='-NoLogo -NoProfile -NonInteractive -EncodedCommand '+$encoded
Assert-R (($ps.Length+$argsText.Length+3) -lt 32767 -and $argsText.Length -lt 8192) 'Bootstrap command must stay short'
function Invoke-R([string]$Code,[string]$Data,[byte[]]$RawFrame=$null,[int]$TimeoutMs=20000){
 $utf8=[Text.UTF8Encoding]::new($false)
 if($null -eq $RawFrame){
  $codeBytes=$utf8.GetBytes($Code);$inputBytes=$utf8.GetBytes($Data);$n=[uint32]$codeBytes.Length
  $header=[byte[]]@(($n -band 255),(($n -shr 8) -band 255),(($n -shr 16) -band 255),(($n -shr 24) -band 255))
 }
 $si=[Diagnostics.ProcessStartInfo]::new();$si.FileName=$ps;$si.Arguments=$argsText
 $si.UseShellExecute=$false;$si.CreateNoWindow=$true
 $si.RedirectStandardInput=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
 $si.StandardOutputEncoding=$utf8;$si.StandardErrorEncoding=$utf8
 $si.EnvironmentVariables['CLASH_RUNNER_TEST']='environment-kept'
 $p=[Diagnostics.Process]::new();$p.StartInfo=$si
 try{
  # .NET Framework initializes redirected stdin from Console.InputEncoding.
  # A BOM-bearing encoding can write its preamble before our binary frame.
  $parentInputEncoding=[Console]::InputEncoding
  try{[Console]::InputEncoding=$utf8;[void]$p.Start()}
  finally{[Console]::InputEncoding=$parentInputEncoding}
  $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();$stdin=$p.StandardInput.BaseStream
  try{
   if($null -ne $RawFrame){$stdin.Write($RawFrame,0,$RawFrame.Length)}else{
    $stdin.Write($header,0,4)
    for($i=0;$i -lt $codeBytes.Length;$i+=997){$count=[Math]::Min(997,$codeBytes.Length-$i);$stdin.Write($codeBytes,$i,$count)}
    $stdin.Write($inputBytes,0,$inputBytes.Length)
   };$stdin.Flush()
  }finally{$stdin.Close()}
  if(-not $p.WaitForExit($TimeoutMs)){$p.Kill();$p.WaitForExit();throw 'Test-owned runner process timed out'}
  [pscustomobject]@{Code=$p.ExitCode;Out=$out.GetAwaiter().GetResult();Err=$err.GetAwaiter().GetResult()}
 }finally{$p.Dispose()}
}
$tempBase=[IO.Path]::GetFullPath($env:TEMP)
$testRoot=Join-Path $tempBase ('clash-bypass-runner-tests-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$marker=Join-Path $testRoot 'data-executed.txt'
try{
 $unicode=([string][char]0x4E2D)+([string][char]0x6587)+[char]::ConvertFromUtf32(0x1F680)+([string][char]0x00E9)
 $data=[ordered]@{unicode=$unicode;quotes='"double" ''single'' backtick:` slash:\ ${env:PATH}';lines="a`r`nb`nc";items=@(1,@('x','y'),$null,$false);nested=@{script='data only';input='data too'};injection="'; [IO.File]::WriteAllText('"+$marker.Replace("'","''")+"','bad'); #";padding=($unicode*12000)}
 $json="`r`n"+($data|ConvertTo-Json -Compress -Depth 20)+"`n"
 $body=@'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$raw=[Console]::In.ReadToEnd();$data=$raw|ConvertFrom-Json
[Console]::Out.Write(([ordered]@{raw=$raw;unicode=$data.unicode;quotes=$data.quotes;lines=$data.lines;items=$data.items;nested=$data.nested;injection=$data.injection;codeUnicode=$codeUnicode;environment=[Environment]::GetEnvironmentVariable('CLASH_RUNNER_TEST')}|ConvertTo-Json -Compress -Depth 20))
'@
 $literal='$codeUnicode = '+"'"+$unicode.Replace("'","''")+"'`r`n"
 $paddingUnit='# '+$unicode+' "quote" ''quote'' backtick:` slash:\ ${env:PATH}'+"`r`n"
 $code=($paddingUnit*4096)+$literal+$body
 Assert-R ([Text.Encoding]::UTF8.GetByteCount($code) -ge 102400) 'Code fixture must exceed 100 KiB'
 $r=Invoke-R $code $json;Assert-R ($r.Code -eq 0) ('Long UTF8 source failed: '+$r.Err);$x=$r.Out|ConvertFrom-Json
 Assert-R ($x.raw -ceq $json) 'Raw JSON/leading and trailing newlines changed'
 Assert-R ($x.unicode -ceq $unicode -and $x.codeUnicode -ceq $unicode) 'Unicode source/input corrupted'
 Assert-R ($x.quotes -ceq $data.quotes -and $x.lines -ceq $data.lines) 'Quotes/newlines changed'
 Assert-R ($x.injection -ceq $data.injection -and $x.nested.script -eq 'data only' -and $x.nested.input -eq 'data too') 'Input must remain data'
 Assert-R ($x.items.Count -eq 4 -and $x.items[1].Count -eq 2 -and $null -eq $x.items[2] -and $x.items[3] -eq $false) 'Array/null/bool shape changed'
 Assert-R ($x.environment -eq 'environment-kept') 'Process environment changed'
 Assert-R (-not (Test-Path -LiteralPath $marker)) 'Input executed'
 Write-Output 'PASS: 100 KiB source and data, Unicode, environment and inner InputEncoding reset'
 $arrayCode=@'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$raw=[Console]::In.ReadToEnd();$x=ConvertFrom-Json -InputObject $raw
[Console]::Out.Write(([ordered]@{raw=$raw;count=$x.Count;first=$x[0];second=$x[1].script;third=$x[2].Count}|ConvertTo-Json -Compress))
'@
 $arrayJson='["literal ${env:PATH}",{"script":"data only"},[1,2,3]]'
 $r=Invoke-R $arrayCode $arrayJson;$x=$r.Out|ConvertFrom-Json
 Assert-R ($r.Code -eq 0 -and $x.raw -ceq $arrayJson -and $x.count -eq 3 -and $x.first -ceq 'literal ${env:PATH}' -and $x.second -eq 'data only' -and $x.third -eq 3) 'Batch input changed'
 Write-Output 'PASS: batch arrays retain structure and literal strings'
 $empty=Invoke-R '[Console]::Out.Write([Console]::In.ReadToEnd().Length)' ''
 Assert-R ($empty.Code -eq 0 -and $empty.Out -ceq '0') 'Empty input changed'
 $badHeader=Invoke-R '' '' ([byte[]]@(1,2));$badScript=Invoke-R '' '' ([byte[]]@(10,0,0,0,35,32))
 Assert-R ($badHeader.Code -ne 0 -and $badScript.Code -ne 0) 'Truncated frames must fail'
 Write-Output 'PASS: frame boundary, partial EOF and empty input'
 $exit=Invoke-R '[Console]::Out.Write("before");[Console]::Error.Write("expected-stderr");exit 7' '{}'
 Assert-R ($exit.Code -eq 7 -and $exit.Out -ceq 'before' -and $exit.Err.Contains('expected-stderr')) 'Exit status/stderr changed'
 Write-Output 'PASS: inner exit code and stderr preserved'
}finally{
 $resolved=[IO.Path]::GetFullPath($testRoot);$prefix=$tempBase.TrimEnd('\')+'\clash-bypass-runner-tests-'
 if(-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path'}
 if(Test-Path -LiteralPath $marker){[IO.File]::Delete($marker)}
 if(Test-Path -LiteralPath $resolved){[IO.Directory]::Delete($resolved,$false)}
}
