<#
  EA Local Ops Worker Launcher
  Usage:
    .\start-worker.ps1           — Start now, no window (background)
    .\start-worker.ps1 -Install  — Install as scheduled task (auto-starts at login, no window ever)
    .\start-worker.ps1 -Remove   — Remove scheduled task
    .\start-worker.ps1 -Status   — Show if running
    .\start-worker.ps1 -Stop     — Stop the running worker
    .\start-worker.ps1 -Console  — Start in a visible console window (for debugging)
#>
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [switch]$Stop,
  [switch]$Console
)

$WorkerDir    = $PSScriptRoot
$WorkerScript = Join-Path $WorkerDir "ops-worker.js"
$TaskName     = "EAOpsWorker"
$PidFile      = Join-Path $WorkerDir ".worker-pid"

# ── Verify prerequisites ──────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not installed or not in PATH."
  exit 1
}
if (-not (Test-Path $WorkerScript)) {
  Write-Error "Cannot find ops-worker.js at: $WorkerScript"
  exit 1
}

$NodePath = (Get-Command node).Source

# ── Remove scheduled task ─────────────────────────────────────────────────────
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[OK] EA Ops Worker removed from scheduled tasks."
  exit
}

# ── Status ────────────────────────────────────────────────────────────────────
if ($Status) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Host "[INSTALLED] Scheduled task '$TaskName' is $($task.State)"
  } else {
    Write-Host "[NOT INSTALLED] No scheduled task found."
  }
  $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*ops-worker*"
  }
  if ($procs) {
    Write-Host "[RUNNING] Worker process PID: $($procs.Id -join ', ')"
  } else {
    Write-Host "[NOT RUNNING] No worker process detected."
  }
  exit
}

# ── Stop ──────────────────────────────────────────────────────────────────────
if ($Stop) {
  if (Test-Path $PidFile) {
    $workerPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($workerPid) {
      Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      Write-Host "[OK] Stopped worker (PID $workerPid)."
    }
  } else {
    # Try by command line match
    Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
        if ($cmd -like "*ops-worker*") { Stop-Process -Id $_.Id -Force; Write-Host "[OK] Stopped PID $($_.Id)" }
      } catch {}
    }
  }
  exit
}

# ── Install as startup item (runs at login, hidden, no window) ───────────────
if ($Install) {
  # Write a VBScript to C:\EAWorker (no spaces = reliable shell.Run)
  $vbsDir  = "C:\EAWorker"
  New-Item -ItemType Directory -Path $vbsDir -Force | Out-Null
  $vbsPath = "$vbsDir\run.vbs"
  @"
Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "$NodePath" & Chr(34) & " " & Chr(34) & "$WorkerScript" & Chr(34), 0, False
"@ | Set-Content -Path $vbsPath -Encoding ASCII

  # Add to HKCU Run key (no elevation needed, runs for this user at login)
  $regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  Set-ItemProperty -Path $regKey -Name $TaskName -Value "wscript.exe `"$vbsPath`""
  Write-Host "[OK] EA Ops Worker installed - will auto-start silently at every login."

  # Start right now too
  $proc = Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`"" -PassThru -WindowStyle Hidden
  Start-Sleep 2
  Write-Host "[OK] Worker started now - no window."
  exit
}

# ── Console mode (debugging) ──────────────────────────────────────────────────
if ($Console) {
  Write-Host "Starting EA Ops Worker in console (Ctrl+C to stop)..."
  Push-Location $WorkerDir
  & node $WorkerScript
  Pop-Location
  exit
}

# ── Default: start silently in background (no window) ────────────────────────
$proc = Start-Process `
  -FilePath $NodePath `
  -ArgumentList "`"$WorkerScript`"" `
  -WorkingDirectory $WorkerDir `
  -WindowStyle Hidden `
  -PassThru

"$($proc.Id)" | Set-Content -Path $PidFile
Write-Host "[OK] EA Ops Worker running in background (PID: $($proc.Id)) - no window."
Write-Host "     To stop:   .\start-worker.ps1 -Stop"
Write-Host "     To install at login: .\start-worker.ps1 -Install"
