param(
  [int]$StartPort = 8787,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$nodePath = Join-Path $appRoot 'runtime\node.exe'
$serverPath = Join-Path $appRoot 'server\main.js'
$pidPath = Join-Path $appRoot '.siren-ai-server.pid'
$portPath = Join-Path $appRoot '.siren-ai-server.port'
$logDirectory = Join-Path $appRoot 'logs'
$stdoutPath = Join-Path $logDirectory 'server.out.log'
$stderrPath = Join-Path $logDirectory 'server.err.log'

function Get-InstanceId([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$instanceId = Get-InstanceId $appRoot

function Get-SirenAiHealth([int]$Port) {
  try {
    $response = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 1
    if ($response.ok -eq $true -and $response.product -eq 'Siren AI' -and $response.instanceId -eq $instanceId) {
      return $response
    }
  } catch { }
  return $null
}

function Test-PortFree([int]$Port) {
  $probe = $null
  try {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $probe.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($probe) { $probe.Stop() }
  }
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Не найден встроенный runtime: $nodePath"
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "Не найден сервер Siren AI: $serverPath"
}

$port = 0
for ($candidate = $StartPort; $candidate -lt ($StartPort + 20); $candidate += 1) {
  if (Get-SirenAiHealth $candidate) {
    if (-not $NoBrowser) { Start-Process ("http://127.0.0.1:{0}/index.html" -f $candidate) }
    exit 0
  }
}
for ($candidate = $StartPort; $candidate -lt ($StartPort + 20); $candidate += 1) {
  if (Test-PortFree $candidate) {
    $port = $candidate
    break
  }
}

if ($port -eq 0) {
  throw 'Siren AI не нашёл свободный локальный порт.'
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$env:SIREN_AI_HOST = '127.0.0.1'
$env:SIREN_AI_PORT = [string]$port
$env:SIREN_AI_ROOT = $appRoot
$env:SIREN_AI_INSTANCE_ID = $instanceId
$env:NODE_USE_SYSTEM_CA = '1'

$serverProcess = Start-Process `
  -FilePath $nodePath `
  -ArgumentList @(('"{0}"' -f $serverPath)) `
  -WorkingDirectory $appRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  if ($serverProcess.HasExited) { break }
  if (Get-SirenAiHealth $port) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  if (-not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  throw "Siren AI не запустился. Подробности: $stderrPath"
}

[System.IO.File]::WriteAllText($pidPath, [string]$serverProcess.Id, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText($portPath, [string]$port, [System.Text.Encoding]::ASCII)

if (-not $NoBrowser) {
  Start-Process ("http://127.0.0.1:{0}/index.html" -f $port)
}
