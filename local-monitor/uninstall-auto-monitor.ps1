param(
  [string]$TaskName = 'EA-DDrive-Monitor'
)

$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task: $TaskName"
} else {
  Write-Host "Scheduled task not found: $TaskName"
}

$configPath = Join-Path $PSScriptRoot 'monitor-config.json'
if (Test-Path $configPath) {
  Remove-Item -Path $configPath -Force
  Write-Host "Removed config file: $configPath"
}
