param([string]$Uri)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$port = 3765
$envFile = Join-Path $projectRoot 'eams.env'

if ($env:DASHBOARD_PORT -match '^\d+$') {
  $port = [int]$env:DASHBOARD_PORT
} elseif (Test-Path -LiteralPath $envFile) {
  $portLine = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -match '^\s*DASHBOARD_PORT\s*=\s*(\d+)\s*$' } |
    Select-Object -Last 1
  if ($portLine -match '^\s*DASHBOARD_PORT\s*=\s*(\d+)\s*$') {
    $port = [int]$Matches[1]
  }
}

$readyUrl = "http://127.0.0.1:$port/launcher-ready"
try {
  $response = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 1
  if ($response.StatusCode -eq 200) { exit 0 }
} catch {}
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 1
  if ($response.StatusCode -eq 200) { exit 0 }
} catch {}

$npm = Get-Command npm.cmd -ErrorAction Stop
Start-Process -FilePath $npm.Source `
  -ArgumentList @('start', '--', '--no-open') `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden
