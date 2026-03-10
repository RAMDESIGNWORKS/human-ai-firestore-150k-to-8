# Local D: Drive Monitor

This script runs on your Windows machine and streams D: drive telemetry to Firebase.

## What it captures

- D: drive capacity and root-level summary
- File system change events on D: (create/change/delete/rename)
- Running processes that reference D: in executable path or command line
- Top process I/O rates (host-level signal)

## What it does NOT do

- It does not read or exfiltrate passwords.
- It does not capture exact per-process open file handles on D: with full fidelity.
  For exact handle-level attribution, you would need ETW/Sysmon/Sysinternals integration.

## 1. Configure Firebase secret

From project root:

```powershell
firebase functions:secrets:set HOST_MONITOR_TOKEN
```

Set a long random value and keep it private.

## 2. Deploy functions

From project root:

```powershell
firebase deploy --only "functions"
```

If discovery timeout appears in this repo, regenerate `functions/functions.yaml` then redeploy.

## 3. Start monitor locally (manual)

```powershell
Set-Location "D:\BUSINESS\9 RMCMANUS HOLDINGS LLC\AI-Executive-Assistant"
$endpoint = "https://us-central1-<your-project-id>.cloudfunctions.net/hostMonitorIngest"
$token = "<your HOST_MONITOR_TOKEN value>"
$owner = "<your firebase auth uid>"

.\local-monitor\monitor-d-drive.ps1 -EndpointUrl $endpoint -MonitorToken $token -OwnerId $owner
```

## 3b. Automate monitor at login (recommended)

Run once to install a Windows Scheduled Task that auto-starts and auto-restarts the monitor:

```powershell
Set-Location "D:\BUSINESS\9 RMCMANUS HOLDINGS LLC\AI-Executive-Assistant"
.\local-monitor\install-auto-monitor.ps1 \
  -OwnerId "<your firebase auth uid>" \
  -MonitorToken "<your HOST_MONITOR_TOKEN value>"
```

Optional install flags:

- `-EndpointUrl "https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/hostMonitorIngest"`
- `-DeviceId "MY-WORKSTATION"`
- `-DriveRoot "D:\"`
- `-IntervalSeconds 15`
- `-MaxEventsPerBatch 500`
- `-TaskName "EA-DDrive-Monitor"`

What this installer does:

- Writes `local-monitor/monitor-config.json`
- Registers scheduled task `EA-DDrive-Monitor` (or custom name)
- Starts the task immediately

To remove automation:

```powershell
.\local-monitor\uninstall-auto-monitor.ps1
```

Optional flags:

- `-DeviceId "MY-WORKSTATION"`
- `-DriveRoot "D:\"`
- `-IntervalSeconds 15`
- `-MaxEventsPerBatch 500`

## 4. Read latest snapshot in app backend

Callable function: `getHostMonitorStatus`

Input:

```json
{ "deviceId": "optional-device-id" }
```

It returns latest monitor snapshots for the authenticated owner.
