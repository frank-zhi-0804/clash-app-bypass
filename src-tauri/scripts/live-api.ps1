$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
# $controller is supplied by the backend from the selected local configuration.
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
      if ($remaining -le 0) { throw 'LIVE_TRANSPORT' }
      $read = $pipe.ReadAsync($buffer, 0, $buffer.Length)
      if (-not $read.Wait($remaining)) { throw 'LIVE_TRANSPORT' }
      $count = $read.Result
      if ($count -eq 0) { break }
      $output.Write($buffer, 0, $count)
      if ($output.Length -gt 8388608) { throw 'LIVE_TRANSPORT' }
    }
    $response = [Text.Encoding]::UTF8.GetString($output.ToArray())
    $split = $response.IndexOf("`r`n`r`n")
    if ($split -lt 0 -or $response -notmatch '^HTTP/1\.[01] (?:200|204) ') { throw 'LIVE_TRANSPORT' }
    if ($response -match '^HTTP/1\.[01] 204 ') { return $null }
    return ($response.Substring($split + 4) | ConvertFrom-Json)
  } finally { $pipe.Dispose(); $output.Dispose() }
}

function Assert-Rules($expected) {
  $actual = @( (Read-ClashApi '/rules').rules )
  if ($actual.Count -ne @($expected).Count) { throw 'LIVE_CONFLICT' }
  for ($i = 0; $i -lt $actual.Count; $i++) {
    $parts = $expected[$i].Split(',')
    if ($parts.Count -lt 2 -or $parts.Count -gt 4 -or $parts[0] -in @('AND','OR','NOT','SUB-RULE')) { throw 'LIVE_UNSUPPORTED' }
    if ($actual[$i].extra.disabled -eq $true) { throw 'LIVE_CONFLICT' }
    if ([string]::IsNullOrEmpty($actual[$i].type) -or $actual[$i].type.Replace('-', '').ToUpperInvariant() -ne $parts[0].Replace('-', '').ToUpperInvariant()) { throw 'LIVE_CONFLICT' }
    $proxy = if ($parts[0] -eq 'MATCH') { $parts[1] } else { $parts[2] }
    $payloadChanged = if ($parts[0] -in @('PROCESS-PATH', 'PROCESS-NAME')) { $actual[$i].payload -ine $parts[1] } else { $actual[$i].payload -cne $parts[1] }
    if ($actual[$i].proxy -cne $proxy -or ($parts[0] -ne 'MATCH' -and $payloadChanged)) { throw 'LIVE_CONFLICT' }
  }
}
function Assert-General($expected, [bool]$routing = $false, $snapshot = $null) {
  if ($null -eq $expected) { throw 'LIVE_INVALID' }
  $active = Read-ClashApi '/configs'
  foreach ($name in @('port','socks-port','mixed-port','redir-port','tproxy-port','allow-lan','ipv6')) {
    if ($null -ne $expected.$name -and $active.$name -ne $expected.$name) { throw 'LIVE_CONFLICT' }
  }
  if ($null -ne $expected.tun -and $active.tun.enable -ne $expected.tun.enable) { throw 'LIVE_CONFLICT' }
  if ($routing) {
    foreach ($name in @('mode','find-process-mode')) {
      if ($null -ne $expected.$name -and $active.$name -ne $expected.$name) { throw 'LIVE_CONFLICT' }
    }
  }
  if ($null -ne $snapshot) { $snapshot.Value = $active }
}
try {
  $packet = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $controller = $packet.controller
  if ($packet.action -notin @('apply','preflight','restore') -or $controller -notmatch '^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$') { throw 'LIVE_INVALID' }
  if ($packet.action -in @('apply', 'preflight')) {
    Assert-Rules $packet.previousRules
    $active = $null
    Assert-General $packet.general $false ([ref]$active)
  }
  if ($packet.action -eq 'preflight') {
    @{ verified = $true; previousRouting = @{ mode = $active.mode; findProcessMode = $active.'find-process-mode' } } | ConvertTo-Json -Compress
    return
  }
  if ($packet.action -eq 'restore') {
    try {
      Assert-Rules $packet.nextRules
      Assert-General $packet.general $true
      '{"verified":true}'; return
    } catch {}
    Assert-Rules $packet.previousRules
    Assert-General $packet.previousGeneral $true
  }
  $body = @{ payload = $packet.payload } | ConvertTo-Json -Compress
  Read-ClashApi '/configs' 'PUT' $body | Out-Null
  Assert-Rules $packet.nextRules
  if ($packet.action -eq 'apply') {
    $active = Read-ClashApi '/configs'
    if ($active.mode -ne 'rule' -or $active.'find-process-mode' -ne 'always') { throw 'LIVE_CONFLICT' }
  } else { Assert-General $packet.general $true }
  '{"verified":true}'
} catch {
  # Never include API responses, full YAML payloads, or PowerShell source in errors.
  $code = [string]$_.Exception.Message
  if ($code -notin @('LIVE_CONFLICT','LIVE_UNSUPPORTED','LIVE_INVALID','LIVE_TRANSPORT')) { $code = 'LIVE_TRANSPORT' }
  $code
  return
}
