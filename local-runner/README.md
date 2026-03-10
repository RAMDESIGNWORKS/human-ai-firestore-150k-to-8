# EA Ops Runner (Local Worker)

This worker pulls jobs from EA, opens VS Code/project folders, and reports progress.

## Start runner

```powershell
Set-Location "D:\BUSINESS\9 RMCMANUS HOLDINGS LLC\AI-Executive-Assistant"
$token = gcloud secrets versions access latest --secret=HOST_MONITOR_TOKEN --project=ramdesignworks-exec-staff
.\local-runner\ea-ops-runner.ps1 -OwnerId "<your_firebase_uid>" -MonitorToken $token
```

## Automate runner at login (recommended)

Install a Windows Scheduled Task that auto-starts and auto-restarts the ops runner:

```powershell
Set-Location "D:\BUSINESS\9 RMCMANUS HOLDINGS LLC\AI-Executive-Assistant"
$token = gcloud secrets versions access latest --secret=HOST_MONITOR_TOKEN --project=ramdesignworks-exec-staff
.\local-runner\install-auto-ops-runner.ps1 -OwnerId "<your_firebase_uid>" -MonitorToken $token
```

To remove automation:

```powershell
.\local-runner\uninstall-auto-ops-runner.ps1
```

## What it does (Phase 1)

- Polls `opsJobPull`
- Claims queued jobs
- Opens VS Code on provided project path
- Sends `needs_approval` with an action summary
- Waits for next jobs

## Endpoints used

- `https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobPull`
- `https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobUpdate`

Auth header:
- `x-host-monitor-token` (from Secret Manager)
