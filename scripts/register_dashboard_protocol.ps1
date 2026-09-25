param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$protocol = 'tju-auto-grade'
$protocolKey = "HKCU:\Software\Classes\$protocol"

if ($Uninstall) {
  if (Test-Path $protocolKey) {
    Remove-Item -LiteralPath $protocolKey -Recurse -Force
  }
  Write-Host 'HTML launcher protocol removed.'
  exit 0
}

$launcher = Join-Path $PSScriptRoot 'launch_dashboard.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" "%1"' -f $powershell, $launcher

New-Item -Path $protocolKey -Force | Out-Null
Set-Item -Path $protocolKey -Value 'URL:TJU Auto Grade'
New-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$protocolKey\shell\open\command" -Force | Out-Null
Set-Item -Path "$protocolKey\shell\open\command" -Value $command

Write-Host 'HTML launcher protocol installed.'
