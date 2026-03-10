param(
  [Parameter(Mandatory = $true)]
  [string]$OwnerId,

  [Parameter(Mandatory = $true)]
  [string]$MonitorToken,

  [string]$PullUrl = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobPull',
  [string]$UpdateUrl = 'https://us-central1-ramdesignworks-exec-staff.cloudfunctions.net/opsJobUpdate',
  [string]$DeviceId = $env:COMPUTERNAME,
  [int]$PollSeconds = 12
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonPost {
  param(
    [string]$Uri,
    [hashtable]$Body
  )

  return Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json' -Headers @{
    'x-host-monitor-token' = $MonitorToken
  } -Body ($Body | ConvertTo-Json -Depth 8)
}

Write-Host "EA ops runner started on $DeviceId. Polling every $PollSeconds seconds..."

function Request-Approval {
  param(
    [string]$JobId,
    [string]$Message,
    [array]$Commands
  )

  Invoke-JsonPost -Uri $UpdateUrl -Body @{
    ownerId = $OwnerId
    jobId = $JobId
    status = 'needs_approval'
    needsApprovalAction = $Message
    proposedCommands = $Commands
  } | Out-Null
}

function Complete-Job {
  param(
    [string]$JobId,
    [string]$Summary
  )

  Invoke-JsonPost -Uri $UpdateUrl -Body @{
    ownerId = $OwnerId
    jobId = $JobId
    status = 'done'
    resultSummary = $Summary
  } | Out-Null
}

function Fail-Job {
  param(
    [string]$JobId,
    [string]$Message
  )

  Invoke-JsonPost -Uri $UpdateUrl -Body @{
    ownerId = $OwnerId
    jobId = $JobId
    status = 'failed'
    error = $Message
  } | Out-Null
}

while ($true) {
  try {
    $pull = Invoke-JsonPost -Uri $PullUrl -Body @{
      ownerId = $OwnerId
      deviceId = $DeviceId
    }

    if ($pull.ok -and $pull.job) {
      $job = $pull.job
      $jobId = [string]$job.id
      $instruction = [string]$job.instruction
      $projectPath = [string]$job.projectPath
      $jobType = [string]$job.type
      $jobStatus = [string]$job.status
      $metadata = $job.metadata
      $requireApproval = [bool]$job.requireApproval

      Invoke-JsonPost -Uri $UpdateUrl -Body @{
        ownerId = $OwnerId
        jobId = $jobId
        status = 'in_progress'
        progress = 'I picked up the job and I am starting execution.'
      } | Out-Null

      if ($requireApproval -and $jobStatus -eq 'queued') {
        $approvalMsg = if ($metadata -and $metadata.plan) {
          "I prepared an execution plan and need approval to proceed.`n" + (($metadata.plan | ForEach-Object { "- $_" }) -join "`n")
        }
        else {
          "I am ready to execute this request and need your approval to proceed.`nInstruction: $instruction"
        }

        Request-Approval -JobId $jobId -Message $approvalMsg -Commands @(
          "Validate plan",
          "Execute local action",
          "Report completion"
        )

        continue
      }

      # Local ALLOWED_APPS whitelist — mirrors the server-side list in functions/index.js.
      # This is a defense-in-depth check; the Cloud Function also enforces this list.
      $ALLOWED_APPS = @(
        'notepad', 'calc', 'calculator', 'explorer', 'chrome', 'firefox', 'edge',
        'code', 'vscode', 'visual studio code', 'word', 'excel', 'powerpoint',
        'outlook', 'teams', 'slack', 'zoom', 'notion', 'obsidian', 'cursor'
      )

      function Test-AppAllowed {
        param([string]$Name)
        $lower = $Name.ToLower().Trim()
        foreach ($a in $ALLOWED_APPS) {
          if ($lower -like "*$a*" -or $a -like "*$lower*") { return $true }
        }
        return $false
      }

      try {
        switch ($jobType) {
          'desktop_open_app' {
            $appName = [string]$metadata.appName
            if (-not $appName) { $appName = $instruction }

            # Defense-in-depth: validate against local whitelist before executing.
            if (-not (Test-AppAllowed -Name $appName)) {
              Fail-Job -JobId $jobId -Message "App '$appName' is not on the approved app list. Job rejected by local runner."
              continue
            }

            Start-Process -FilePath $appName
            Complete-Job -JobId $jobId -Summary "I launched app: $appName"
          }

          'desktop_search_file' {
            $query = [string]$metadata.fileQuery
            if (-not $query) { $query = $instruction }
            $results = Get-ChildItem -Path 'D:\' -File -Recurse -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -like "*$query*" } |
              Select-Object -First 10 -ExpandProperty FullName

            $summary = if ($results) {
              "I found files:`n" + ($results -join "`n")
            }
            else {
              "I did not find matching files for: $query"
            }
            Complete-Job -JobId $jobId -Summary $summary
          }

          'desktop_draft_email' {
            $to = [string]$metadata.emailTo
            $subject = [string]$metadata.emailSubject
            $body = [string]$metadata.emailBody
            $mailto = "mailto:$to?subject=$([uri]::EscapeDataString($subject))&body=$([uri]::EscapeDataString($body))"
            Start-Process $mailto
            Complete-Job -JobId $jobId -Summary "I opened your mail client with a draft to $to."
          }

          default {
            if ($projectPath -and (Test-Path $projectPath)) {
              Start-Process -FilePath 'code' -ArgumentList "`"$projectPath`""
              Complete-Job -JobId $jobId -Summary "I opened VS Code at $projectPath and queued execution context."
            }
            else {
              Start-Process -FilePath 'code'
              Complete-Job -JobId $jobId -Summary 'I opened VS Code and I am ready for the next step.'
            }
          }
        }
      }
      catch {
        Fail-Job -JobId $jobId -Message ("Execution error: " + $_.Exception.Message)
      }
    }
  }
  catch {
    Write-Warning ("Runner loop error: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $PollSeconds
}
