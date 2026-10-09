$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# $controller is supplied by the backend from the selected local configuration.
function Read-ClashApi([string]$resource) {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $controller.Substring(9), [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  $buffer = [byte[]]::new(8192); $output = [IO.MemoryStream]::new()
  try {
    $pipe.Connect(1500)
    # HTTP/1.0 avoids chunked transfer encoding; Connection: close bounds the body.
    $request = [Text.Encoding]::ASCII.GetBytes("GET $resource HTTP/1.0`r`nHost: localhost`r`nConnection: close`r`n`r`n")
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
    if ($split -lt 0 -or $response -notmatch '^HTTP/1\.[01] 200 ') { throw 'Clash 诊断接口返回异常' }
    return ($response.Substring($split + 4) | ConvertFrom-Json)
  } finally { $pipe.Dispose(); $output.Dispose() }
}
$config = Read-ClashApi '/configs'
$rules = Read-ClashApi '/rules'
$connections = Read-ClashApi '/connections'
# Only return routing evidence. Do not expose destinations, subscription data or secrets.
$snapshot = [ordered]@{
  checkedAt = [DateTime]::UtcNow.ToString('o')
  mode = $config.mode
  findProcessMode = $config.'find-process-mode'
  rules = @($rules.rules | Where-Object { $_.type -eq 'ProcessPath' -and $_.proxy -eq 'DIRECT' -and -not $_.extra.disabled } | ForEach-Object { $_.payload })
  unidentifiedConnections = @($connections.connections | Where-Object { -not $_.metadata.processPath }).Count
  connections = @($connections.connections | Where-Object { $_.metadata.processPath } | ForEach-Object {
    [ordered]@{ path = $_.metadata.processPath; direct = (@($_.chains) -ccontains 'DIRECT'); rejected = (@($_.chains | Where-Object { $_ -cmatch '^REJECT(?:-DROP)?$' }).Count -gt 0); unknown = (@($_.chains).Count -eq 0); rule = $_.rule; start = $_.start }
  })
}
ConvertTo-Json -InputObject $snapshot -Depth 5 -Compress
