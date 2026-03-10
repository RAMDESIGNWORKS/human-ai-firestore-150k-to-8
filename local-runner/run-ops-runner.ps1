param(
  [string]$ConfigPath = "",
  [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $PSScriptRoot 'ops-runner-config.json'
}

if (-not (Test-Path $ConfigPath)) {
  throw "Ops runner config not found: $ConfigPath"
}

$config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
$runnerScript = Join-Path $PSScriptRoot 'ea-ops-runner.ps1'

if (-not (Test-Path $runnerScript)) {
  throw "Runner script not found: $runnerScript"
}

while ($true) {
  try {
    & $runnerScript \
      -OwnerId $config.ownerId \
      -MonitorToken $config.monitorToken \
      -PullUrl $config.pullUrl \
      -UpdateUrl $config.updateUrl \
      -DeviceId $config.deviceId \
      -PollSeconds ([int]$config.pollSeconds)
  } catch {
    Write-Warning ("Ops runner crashed: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $RestartDelaySeconds
}
