$ErrorActionPreference = 'SilentlyContinue'
$appRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$pidPath = Join-Path $appRoot '.siren-ai-server.pid'
$portPath = Join-Path $appRoot '.siren-ai-server.port'

function Get-InstanceId([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

if ((Test-Path -LiteralPath $pidPath) -and (Test-Path -LiteralPath $portPath)) {
  $serverPid = 0
  $serverPort = 0
  [void][int]::TryParse(([System.IO.File]::ReadAllText($pidPath).Trim()), [ref]$serverPid)
  [void][int]::TryParse(([System.IO.File]::ReadAllText($portPath).Trim()), [ref]$serverPort)
  if ($serverPid -gt 0 -and $serverPort -gt 0) {
    $serverProcess = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    $listenPattern = "127\.0\.0\.1:$serverPort\s+.*LISTENING\s+$serverPid$"
    $ownsPort = [bool](netstat -ano -p tcp | Select-String -Pattern $listenPattern | Select-Object -First 1)
    $isExpectedInstance = $false
    try {
      $health = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:{0}/api/health" -f $serverPort) -TimeoutSec 1
      $isExpectedInstance = $health.product -eq 'Siren AI' -and $health.instanceId -eq (Get-InstanceId $appRoot)
    } catch { }
    if ($serverProcess -and $serverProcess.ProcessName -eq 'node' -and $ownsPort -and $isExpectedInstance) {
      Stop-Process -Id $serverPid -Force
    }
  }
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
