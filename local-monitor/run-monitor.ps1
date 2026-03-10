param(
  [string]$ConfigPath = "",
  [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $PSScriptRoot 'monitor-config.json'
}

if (-not (Test-Path $ConfigPath)) {
  throw "Monitor config not found: $ConfigPath"
}

$config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
$monitorScript = Join-Path $PSScriptRoot 'monitor-d-drive.ps1'

if (-not (Test-Path $monitorScript)) {
  throw "Monitor script not found: $monitorScript"
}

while ($true) {
  try {
    & $monitorScript \
      -EndpointUrl $config.endpointUrl \
      -MonitorToken $config.monitorToken \
      -OwnerId $config.ownerId \
      -DeviceId $config.deviceId \
      -DriveRoot $config.driveRoot \
      -IntervalSeconds ([int]$config.intervalSeconds) \
      -MaxEventsPerBatch ([int]$config.maxEventsPerBatch)
  } catch {
    Write-Warning ("Monitor crashed: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $RestartDelaySeconds
}
