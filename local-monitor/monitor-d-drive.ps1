param(
  [string]$EndpointUrl,
  [string]$MonitorToken,
  [string]$OwnerId,
  [string]$DeviceId = $env:COMPUTERNAME,
  [string]$DriveRoot = 'D:\',
  [int]$IntervalSeconds = 30,
  [int]$MaxEventsPerBatch = 300
)

if (-not $EndpointUrl) {
  throw 'EndpointUrl is required.'
}
if (-not $MonitorToken) {
  throw 'MonitorToken is required.'
}
if (-not $OwnerId) {
  throw 'OwnerId is required.'
}
if (-not (Test-Path $DriveRoot)) {
  throw "Drive root not found: $DriveRoot"
}

$script:eventQueue = [System.Collections.Generic.List[object]]::new()
$script:installedProgramsCache = @()
$script:installedProgramsLastRefresh = [datetime]::MinValue

function Add-EventToQueue {
  param([object]$Item)
  if ($script:eventQueue.Count -ge 5000) {
    $script:eventQueue.RemoveRange(0, 500)
  }
  $script:eventQueue.Add($Item)
}

function Get-DriveSummary {
  $driveName = ($DriveRoot.TrimEnd('\\').TrimEnd(':')).ToUpper()
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveName:'" -ErrorAction SilentlyContinue

  $rootItems = @(Get-ChildItem -LiteralPath $DriveRoot -Force -ErrorAction SilentlyContinue)
  $rootFolders = @($rootItems | Where-Object { $_.PSIsContainer }).Count
  $rootFiles = @($rootItems | Where-Object { -not $_.PSIsContainer }).Count

  $total = [double]($disk.Size | ForEach-Object { $_ })
  $free = [double]($disk.FreeSpace | ForEach-Object { $_ })
  $used = [Math]::Max(0, $total - $free)
  $pct = if ($total -gt 0) { [Math]::Round(($used / $total) * 100, 2) } else { 0 }

  return [pscustomobject]@{
    name = $driveName
    totalBytes = [int64]$total
    freeBytes = [int64]$free
    usedBytes = [int64]$used
    usedPercent = $pct
    rootItems = $rootItems.Count
    rootFolders = $rootFolders
    rootFiles = $rootFiles
  }
}

function Get-DriveRelatedProcesses {
  $drivePrefix = ($DriveRoot.TrimEnd('\\')).ToUpper()

  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.ExecutablePath -and $_.ExecutablePath.ToUpper().StartsWith($drivePrefix)) -or
      ($_.CommandLine -and $_.CommandLine.ToUpper().Contains($drivePrefix))
    } |
    Select-Object ProcessId, Name, ExecutablePath, CommandLine

  $procMap = @{}
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $procMap[$_.Id] = $_
  }

  $result = foreach ($p in $procs) {
    $cpu = 0
    $wsMb = 0
    if ($procMap.ContainsKey($p.ProcessId)) {
      $cpu = [Math]::Round([double]$procMap[$p.ProcessId].CPU, 2)
      $wsMb = [Math]::Round([double]$procMap[$p.ProcessId].WorkingSet64 / 1MB, 2)
    }

    [pscustomobject]@{
      pid = [int]$p.ProcessId
      name = [string]$p.Name
      path = [string]$p.ExecutablePath
      commandLine = [string]$p.CommandLine
      cpu = $cpu
      workingSetMb = $wsMb
    }
  }

  return @($result | Sort-Object -Property cpu -Descending)
}

function Get-TopIoProcesses {
  $samples = Get-Counter '\Process(*)\IO Data Bytes/sec' -ErrorAction SilentlyContinue
  if (-not $samples) { return @() }

  $rows = foreach ($c in $samples.CounterSamples) {
    if ($c.InstanceName -eq '_Total' -or $c.InstanceName -eq 'Idle') { continue }
    [pscustomobject]@{
      name = [string]$c.InstanceName
      ioBytesPerSec = [Math]::Round([double]$c.CookedValue, 2)
      idProcess = [int]($c.InstanceName -replace '.*#', '')
    }
  }

  return @($rows | Sort-Object -Property ioBytesPerSec -Descending | Select-Object -First 20)
}

function Flush-EventQueue {
  if ($script:eventQueue.Count -eq 0) { return @() }

  $take = [Math]::Min($MaxEventsPerBatch, $script:eventQueue.Count)
  $batch = $script:eventQueue.GetRange(0, $take)
  $script:eventQueue.RemoveRange(0, $take)
  return @($batch)
}

function Get-InstalledProgramsInventory {
  $locations = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  $items = foreach ($loc in $locations) {
    Get-ItemProperty -Path $loc -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -and $_.DisplayName.Trim().Length -gt 0 } |
      Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation
  }

  $unique = $items |
    Sort-Object DisplayName, DisplayVersion -Unique |
    Select-Object -First 600 |
    ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.DisplayName
        version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        installLocation = [string]$_.InstallLocation
      }
    }

  return @($unique)
}

function Get-CachedInstalledPrograms {
  $refreshEveryMinutes = 360
  $ageMinutes = ((Get-Date) - $script:installedProgramsLastRefresh).TotalMinutes

  if ($script:installedProgramsCache.Count -eq 0 -or $ageMinutes -ge $refreshEveryMinutes) {
    try {
      $script:installedProgramsCache = Get-InstalledProgramsInventory
      $script:installedProgramsLastRefresh = Get-Date
      Write-Host "[$((Get-Date).ToString('T'))] Refreshed installed program inventory: $($script:installedProgramsCache.Count) entries"
    } catch {
      Write-Warning "Failed to refresh installed program inventory: $($_.Exception.Message)"
    }
  }

  return $script:installedProgramsCache
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $DriveRoot
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size, CreationTime'
$watcher.Filter = '*'

$createdReg = Register-ObjectEvent -InputObject $watcher -EventName Created -Action {
  Add-EventToQueue ([pscustomobject]@{
    changeType = 'Created'
    path = [string]$Event.SourceEventArgs.FullPath
    oldPath = ''
    when = (Get-Date).ToString('o')
  })
}

$changedReg = Register-ObjectEvent -InputObject $watcher -EventName Changed -Action {
  Add-EventToQueue ([pscustomobject]@{
    changeType = 'Changed'
    path = [string]$Event.SourceEventArgs.FullPath
    oldPath = ''
    when = (Get-Date).ToString('o')
  })
}

$deletedReg = Register-ObjectEvent -InputObject $watcher -EventName Deleted -Action {
  Add-EventToQueue ([pscustomobject]@{
    changeType = 'Deleted'
    path = [string]$Event.SourceEventArgs.FullPath
    oldPath = ''
    when = (Get-Date).ToString('o')
  })
}

$renamedReg = Register-ObjectEvent -InputObject $watcher -EventName Renamed -Action {
  Add-EventToQueue ([pscustomobject]@{
    changeType = 'Renamed'
    path = [string]$Event.SourceEventArgs.FullPath
    oldPath = [string]$Event.SourceEventArgs.OldFullPath
    when = (Get-Date).ToString('o')
  })
}

$watcher.EnableRaisingEvents = $true
Write-Host "D-drive monitor started for $DriveRoot on $DeviceId. Press Ctrl+C to stop."

try {
  while ($true) {
    Start-Sleep -Seconds $IntervalSeconds

    $payload = [pscustomobject]@{
      ownerId = $OwnerId
      deviceId = $DeviceId
      timestamp = (Get-Date).ToString('o')
      drive = Get-DriveSummary
      processes = Get-DriveRelatedProcesses
      topIoProcesses = Get-TopIoProcesses
      fsEvents = Flush-EventQueue
      installedPrograms = Get-CachedInstalledPrograms
      notes = @(
        'Drive process matching is based on executable path/command line references to D:.',
        'Per-process exact open-handle mapping requires kernel/ETW tooling.',
        'Installed program inventory is refreshed every 6 hours from Windows uninstall registry keys.'
      )
    }

    try {
      $json = $payload | ConvertTo-Json -Depth 8 -Compress
      $response = Invoke-RestMethod -Uri $EndpointUrl -Method Post -ContentType 'application/json' -Headers @{
        'x-host-monitor-token' = $MonitorToken
      } -Body $json

      $eventCount = @($payload.fsEvents).Count
      $procCount = @($payload.processes).Count
      Write-Host "[$((Get-Date).ToString('T'))] Sent monitor batch. events=$eventCount processes=$procCount"
    } catch {
      Write-Warning "Failed to send monitor batch: $($_.Exception.Message)"
    }
  }
}
finally {
  $watcher.EnableRaisingEvents = $false
  Unregister-Event -SourceIdentifier $createdReg.Name -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier $changedReg.Name -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier $deletedReg.Name -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier $renamedReg.Name -ErrorAction SilentlyContinue
  $watcher.Dispose()
}
