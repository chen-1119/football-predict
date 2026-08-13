$ErrorActionPreference = "Stop"

$TaskName = if ($env:FOOTBALL_FAST_RESULT_TASK_NAME) { $env:FOOTBALL_FAST_RESULT_TASK_NAME } else { "FootballPredictSportteryFastResultLane" }
$StartNow = $env:FOOTBALL_FAST_RESULT_START_NOW -ne "0"
$WakeToRun = $env:FOOTBALL_FAST_RESULT_WAKE_TO_RUN -eq "1"
$ValidateOnly = $env:FOOTBALL_FAST_RESULT_VALIDATE_ONLY -eq "1"
$TaskIdentity = if ($env:FOOTBALL_FAST_RESULT_TASK_IDENTITY) { $env:FOOTBALL_FAST_RESULT_TASK_IDENTITY.Trim().ToUpperInvariant() } else { "S4U" }
$AllowInteractive = $env:FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE -eq "1"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Wrapper = Join-Path $Root "scripts\runSportteryFastResultLane.ps1"
$HiddenWrapper = Join-Path $Root "scripts\runSportteryFastResultLaneHidden.vbs"
$LockDir = Join-Path $Root "logs\sporttery-fast-result.lock.d"
$LockOwner = Join-Path $LockDir "owner.json"

if (-not (Test-Path $Wrapper)) { throw "Wrapper script not found: $Wrapper" }
if (-not (Test-Path $HiddenWrapper)) { throw "Hidden wrapper script not found: $HiddenWrapper" }

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$RegistrationUser = $CurrentIdentity
$RegistrationLogonType = 2 # TASK_LOGON_S4U: unattended, no stored password.
$RunLevel = 0
switch ($TaskIdentity) {
  "S4U" {
    $RegistrationUser = $CurrentIdentity
    $RegistrationLogonType = 2
  }
  "SYSTEM" {
    $RegistrationUser = "SYSTEM"
    $RegistrationLogonType = 5 # TASK_LOGON_SERVICE_ACCOUNT
    $RunLevel = 1
  }
  "INTERACTIVE" {
    if (-not $AllowInteractive) {
      throw "INTERACTIVE identity stops at logoff; set FOOTBALL_FAST_RESULT_ALLOW_INTERACTIVE=1 only for an explicit temporary diagnostic."
    }
    $RegistrationUser = $CurrentIdentity
    $RegistrationLogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
  }
  default {
    throw "FOOTBALL_FAST_RESULT_TASK_IDENTITY must be S4U or SYSTEM (INTERACTIVE requires explicit diagnostic opt-in)."
  }
}

if ($ValidateOnly) {
  [pscustomobject]@{
    ok = $true
    validateOnly = $true
    taskName = $TaskName
    identity = $TaskIdentity
    user = if ($TaskIdentity -eq "SYSTEM") { "SYSTEM" } else { "current-user" }
    logonType = $RegistrationLogonType
    unattendedAcrossLogoff = $RegistrationLogonType -in @(2, 5)
    storesPassword = $false
    interactiveOptIn = $AllowInteractive
  } | ConvertTo-Json -Compress | Write-Output
  exit 0
}

function Stop-VerifiedFastResultRunner {
  if (-not (Test-Path $LockOwner)) { return }

  # Task Scheduler can terminate the WScript/PowerShell parents before their
  # Node child, so verify the lock owner's command line before terminating that
  # exact process tree. Never kill an unverified PID or remove a live lock.
  $Owner = Get-Content -Raw -Encoding UTF8 $LockOwner | ConvertFrom-Json
  $OwnerPid = [int]$Owner.pid
  $OwnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid" -ErrorAction SilentlyContinue
  if ($OwnerProcess) {
    $ExpectedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $OwnerRoot = [IO.Path]::GetFullPath([string]$Owner.root).TrimEnd('\')
    $ExpectedRunner = [IO.Path]::GetFullPath((Join-Path $Root "scripts\runSportteryFastResultLane.cjs"))
    $ActualStartedAt = if ($OwnerProcess.CreationDate -is [datetime]) {
      $OwnerProcess.CreationDate.ToUniversalTime().ToString('o')
    } else {
      [string]$OwnerProcess.CreationDate
    }
    $NormalizedCommand = ([string]$OwnerProcess.CommandLine -replace '\s+', ' ').Trim()
    $Sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $ActualCommandSignature = ([BitConverter]::ToString($Sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($NormalizedCommand)))).Replace('-', '').ToLowerInvariant()
    } finally {
      $Sha256.Dispose()
    }
    $VerifiedOwner = [int]$Owner.version -eq 2 `
      -and $OwnerRoot.Equals($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase) `
      -and [string]$Owner.processStartKey -eq $ActualStartedAt `
      -and [string]$Owner.commandSignature -eq $ActualCommandSignature `
      -and $OwnerProcess.Name -eq "node.exe" `
      -and $NormalizedCommand -match [Regex]::Escape($ExpectedRunner)
    if (-not $VerifiedOwner) {
      throw "Refusing to terminate unverified fast-result lock owner pid=$OwnerPid."
    }
    & taskkill.exe /PID $OwnerPid /T /F | Out-Null
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) {
    throw "Fast-result lock owner pid=$OwnerPid did not stop."
  }
  $ResolvedLogs = [IO.Path]::GetFullPath((Join-Path $Root "logs"))
  $ResolvedLock = [IO.Path]::GetFullPath($LockDir)
  if (-not $ResolvedLock.StartsWith($ResolvedLogs, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove fast-result lock outside logs directory."
  }
  Remove-Item -LiteralPath $ResolvedLock -Recurse -Force
}

$Action = "wscript.exe `"$HiddenWrapper`""
Write-Host "Installing persistent fast-result task '$TaskName'."
# A one-minute trigger is only a supervisor heartbeat. The action itself stays
# alive and probes result page 1 at SPORTTERY_FAST_RESULT_INTERVAL_SECONDS.
# IgnoreNew prevents supervisor triggers from overlapping the resident watcher.
$CandidateTaskName = "$TaskName.__candidate__.$PID"
$CreateArgs = @("/Create", "/TN", $CandidateTaskName, "/SC", "MINUTE", "/MO", "1", "/TR", $Action, "/F")
if ($TaskIdentity -eq "SYSTEM") {
  $CreateArgs += @("/RU", "SYSTEM")
}
$CandidateCreated = $false
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$ExistingStopped = $false
$Installed = $false

try {
  # Stage and validate the requested principal under a disposable name first.
  # This prevents a failed S4U registration from leaving the schtasks-created
  # interactive/PT72H fallback under the production task name.
  & schtasks.exe @CreateArgs | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "Unable to create fast-result candidate task (exit=$LASTEXITCODE)." }
  $CandidateCreated = $true
  & schtasks.exe /Change /TN $CandidateTaskName /DISABLE | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to disable fast-result candidate task (exit=$LASTEXITCODE)." }

  $ScheduleService = New-Object -ComObject "Schedule.Service"
  $ScheduleService.Connect()
  $Folder = $ScheduleService.GetFolder("\")
  $CandidateTask = $Folder.GetTask($CandidateTaskName)
  $Definition = $CandidateTask.Definition
  $Definition.Settings.Enabled = $false
  $Definition.Settings.Hidden = $true
  $Definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
  $Definition.Settings.StartWhenAvailable = $true
  $Definition.Settings.DisallowStartIfOnBatteries = $false
  $Definition.Settings.StopIfGoingOnBatteries = $false
  $Definition.Settings.RestartCount = 3
  $Definition.Settings.RestartInterval = "PT1M"
  $Definition.Settings.ExecutionTimeLimit = "PT0S" # resident watcher; no forced cutoff
  $Definition.Settings.WakeToRun = $WakeToRun
  $Definition.Principal.UserId = $RegistrationUser
  $Definition.Principal.LogonType = $RegistrationLogonType
  $Definition.Principal.RunLevel = $RunLevel
  $Folder.RegisterTaskDefinition(
    $CandidateTaskName,
    $Definition,
    6,
    $RegistrationUser,
    $null,
    $RegistrationLogonType
  ) | Out-Null

  # The candidate registration above is the privilege/logon-policy probe. Only
  # after it succeeds do we interrupt the currently working production task.
  $TargetDefinition = $Folder.GetTask($CandidateTaskName).Definition
  $TargetDefinition.Settings.Enabled = $true
  if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $ExistingStopped = $true
    Start-Sleep -Milliseconds 500
  }
  Stop-VerifiedFastResultRunner
  $Folder.RegisterTaskDefinition(
    $TaskName,
    $TargetDefinition,
    6,
    $RegistrationUser,
    $null,
    $RegistrationLogonType
  ) | Out-Null
  $Installed = $true
} catch {
  if ($ExistingTask -and $ExistingStopped -and -not $Installed) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if ($CandidateCreated) {
    & schtasks.exe /Delete /TN $CandidateTaskName /F 2>$null | Out-Null
  }
}

if ($StartNow) {
  Write-Host "Starting '$TaskName'."
  & schtasks.exe /Run /TN $TaskName | Write-Host
}

Write-Host "Installed with $TaskIdentity identity (no stored password). Probe interval defaults to 15 seconds; logs: $(Join-Path $Root 'logs\sporttery-fast-result.log')"
