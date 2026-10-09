$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
# $controller is supplied by the backend from the selected local configuration.
$packet = [Console]::In.ReadToEnd() | ConvertFrom-Json
$controller = $packet.controller
function Read-ClashApi([string]$resource, [string]$method = 'GET', [string]$body = '') {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $controller.Substring(9), [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  $buffer = [byte[]]::new(8192); $output = [IO.MemoryStream]::new()
  try {
    $pipe.Connect(1500)
    # HTTP/1.0 avoids chunked transfer encoding; Connection: close bounds the body.
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
    $header = [Text.Encoding]::ASCII.GetBytes("$method $resource HTTP/1.0`r`nHost: localhost`r`nContent-Type: application/json`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n")
    $request = [byte[]]($header + $bodyBytes)
    $pipe.Write($request, 0, $request.Length)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $remaining = 4000 - [int]$clock.ElapsedMilliseconds
      if ($remaining -le 0) { throw 'Clash 诊断接口读取超时' }
      $read = $pipe.ReadAsync($buffer, 0, $buffer.Length)
      if (-not $read.Wait($remaining)) { throw 'Clash 诊断接口读取超时' }
      $count = $read.Result
      if ($count -eq 0) { break }
      $output.Write($buffer, 0, $count)
      if ($output.Length -gt 8388608) { throw 'Clash 诊断数据过大，请稍后重试' }
    }
    $response = [Text.Encoding]::UTF8.GetString($output.ToArray())
    $split = $response.IndexOf("`r`n`r`n")
    if ($split -lt 0 -or $response -notmatch '^HTTP/1\.[01] (?:200|204) ') { throw 'Clash 诊断接口返回异常' }
    if ($response -match '^HTTP/1\.[01] 204 ') { return $null }
    return ($response.Substring($split + 4) | ConvertFrom-Json)
  } finally { $pipe.Dispose(); $output.Dispose() }
}

function Assert-Rules($expected) {
  $actual = @( (Read-ClashApi '/rules').rules )
  if ($actual.Count -ne @($expected).Count) { throw '运行规则在操作期间发生变化' }
  for ($i = 0; $i -lt $actual.Count; $i++) {
    $parts = $expected[$i].Split(',')
    if ($parts.Count -lt 2 -or $parts.Count -gt 4 -or $parts[0] -in @('AND','OR','NOT','SUB-RULE')) { throw '此规则结构暂不支持在线验证' }
    if ($actual[$i].type.Replace('-', '').ToUpperInvariant() -ne $parts[0].Replace('-', '').ToUpperInvariant()) { throw '运行规则类型发生变化' }
    $proxy = if ($parts[0] -eq 'MATCH') { $parts[1] } else { $parts[2] }
    if ($actual[$i].proxy -cne $proxy -or ($parts[0] -ne 'MATCH' -and $actual[$i].payload -ine $parts[1])) { throw '运行规则内容发生变化' }
  }
}
if ($packet.action -in @('apply', 'preflight')) {
  Assert-Rules $packet.previousRules
  $active = Read-ClashApi '/configs'
  foreach ($name in @('port','socks-port','mixed-port','redir-port','tproxy-port','allow-lan','ipv6')) {
    if ($null -ne $packet.general.$name -and $active.$name -ne $packet.general.$name) { throw '运行网络设置与文件不一致，请刷新 Clash 配置后重试' }
  }
  if ($null -ne $packet.general.tun -and $active.tun.enable -ne $packet.general.tun.enable) { throw '运行 TUN 设置与文件不一致' }
}
if ($packet.action -eq 'preflight') { '{"verified":true}'; return }
if ($packet.action -eq 'restore') {
  try { Assert-Rules $packet.nextRules; '{"verified":true}'; return } catch {}
  Assert-Rules $packet.previousRules
}
$body = @{ payload = $packet.payload } | ConvertTo-Json -Compress
Read-ClashApi '/configs' 'PUT' $body | Out-Null
Assert-Rules $packet.nextRules
if ($packet.action -eq 'apply' -and (Read-ClashApi '/configs').mode -ne 'rule') { throw '规则模式未生效' }
'{"verified":true}'
