param(
  [string]$OwnerId,
  [string]$MonitorToken,

  [string]$EndpointUrl = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/hostMonitorIngest',
  [string]$DeviceId = $env:COMPUTERNAME,
  [string]$DriveRoot = 'D:\\',
  [int]$IntervalSeconds = 30,
  [int]$MaxEventsPerBatch = 300,
  [string]$TaskName = 'EA-DDrive-Monitor'
)

$ErrorActionPreference = 'Stop'

if (-not $OwnerId) {
  $OwnerId = Read-Host 'Enter your Firebase Auth UID (OwnerId)'
}
if (-not $MonitorToken) {
  $MonitorToken = Read-Host 'Enter HOST_MONITOR_TOKEN value'
}
if (-not $OwnerId) {
  throw 'OwnerId is required.'
}
if (-not $MonitorToken) {
  throw 'MonitorToken is required.'
}

$configPath = Join-Path $PSScriptRoot 'monitor-config.json'
$runnerPath = Join-Path $PSScriptRoot 'run-monitor.ps1'

$config = [ordered]@{
  endpointUrl = $EndpointUrl
  monitorToken = $MonitorToken
  ownerId = $OwnerId
  deviceId = $DeviceId
  driveRoot = $DriveRoot
  intervalSeconds = $IntervalSeconds
  maxEventsPerBatch = $MaxEventsPerBatch
}

$config | ConvertTo-Json -Depth 4 | Out-File -FilePath $configPath -Encoding ascii -Force

$action = New-ScheduledTaskAction \
  -Execute 'powershell.exe' \
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -ConfigPath `"$configPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet \
  -AllowStartIfOnBatteries \
  -DontStopIfGoingOnBatteries \
  -RestartCount 999 \
  -RestartInterval (New-TimeSpan -Minutes 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask \
  -TaskName $TaskName \
  -Action $action \
  -Trigger $trigger \
  -Settings $settings \
  -Description 'EA D: drive monitor auto-start task'

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Config file: $configPath"
Write-Host "To remove: .\\local-monitor\\uninstall-auto-monitor.ps1"
