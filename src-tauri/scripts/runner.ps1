# Keep the command line short. Read only the framed script bytes from the pipe;
# Console.In remains untouched for the business script's original stdin data.
$__cabPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Read-CabExact([IO.Stream]$Stream, [byte[]]$Buffer) {
  $offset = 0
  while ($offset -lt $Buffer.Length) {
    $count = $Stream.Read($Buffer, $offset, $Buffer.Length - $offset)
    if ($count -le 0) { throw 'Incomplete Windows helper frame.' }
    $offset += $count
  }
}
$__cabStream = [Console]::OpenStandardInput()
[byte[]]$__cabHeader = New-Object byte[] 4
Read-CabExact $__cabStream $__cabHeader
$__cabLength = [BitConverter]::ToUInt32($__cabHeader, 0)
if ($__cabLength -eq 0 -or $__cabLength -gt 4194304) { throw 'Invalid Windows helper frame length.' }
[byte[]]$__cabCode = New-Object byte[] ([int]$__cabLength)
Read-CabExact $__cabStream $__cabCode
$__cabScript = [Text.UTF8Encoding]::new($false, $true).GetString($__cabCode).TrimStart([char]0xfeff)
$ErrorActionPreference = $__cabPreference
& ([ScriptBlock]::Create($__cabScript))
