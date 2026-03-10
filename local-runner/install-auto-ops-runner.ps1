param(
  [string]$OwnerId,
  [string]$MonitorToken,
  [string]$PullUrl = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobPull',
  [string]$UpdateUrl = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobUpdate',
  [string]$DeviceId = $env:COMPUTERNAME,
  [int]$PollSeconds = 12,
  [string]$TaskName = 'EA-Ops-Runner'
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

$configPath = Join-Path $PSScriptRoot 'ops-runner-config.json'
$runnerPath = Join-Path $PSScriptRoot 'run-ops-runner.ps1'

$config = [ordered]@{
  ownerId = $OwnerId
  monitorToken = $MonitorToken
  pullUrl = $PullUrl
  updateUrl = $UpdateUrl
  deviceId = $DeviceId
  pollSeconds = $PollSeconds
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
  -Description 'EA local ops runner auto-start task'

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Config file: $configPath"
Write-Host "To remove: .\\local-runner\\uninstall-auto-ops-runner.ps1"
