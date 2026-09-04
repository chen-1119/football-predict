$ErrorActionPreference = "Stop"

$TaskName = if ($env:FOOTBALL_RELAY_TASK_NAME) { $env:FOOTBALL_RELAY_TASK_NAME } else { "FootballPredictSportteryRelay" }
$DefaultIntervalMinutes = 1
$IntervalMinutes = if ($env:FOOTBALL_RELAY_INTERVAL_MINUTES) { [int]$env:FOOTBALL_RELAY_INTERVAL_MINUTES } else { $DefaultIntervalMinutes }
$RetryCount = if ($env:FOOTBALL_RELAY_RETRY_COUNT) { [int]$env:FOOTBALL_RELAY_RETRY_COUNT } else { 3 }
$RetryIntervalMinutes = if ($env:FOOTBALL_RELAY_RETRY_INTERVAL_MINUTES) { [int]$env:FOOTBALL_RELAY_RETRY_INTERVAL_MINUTES } else { 1 }
$ExecutionTimeLimitMinutes = if ($env:FOOTBALL_RELAY_EXECUTION_LIMIT_MINUTES) { [int]$env:FOOTBALL_RELAY_EXECUTION_LIMIT_MINUTES } else { 10 }
$StartNow = $env:FOOTBALL_RELAY_START_NOW -ne "0"
$WakeToRun = $env:FOOTBALL_RELAY_WAKE_TO_RUN -eq "1"
$UseS4U = $env:FOOTBALL_RELAY_USE_S4U -eq "1"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Wrapper = Join-Path $Root "scripts\runSportteryRelayPush.ps1"
$HiddenWrapper = Join-Path $Root "scripts\runSportteryRelayPushHidden.vbs"

if (-not (Test-Path $Wrapper)) {
  throw "Wrapper script not found: $Wrapper"
}
if (-not (Test-Path $HiddenWrapper)) {
  throw "Hidden wrapper script not found: $HiddenWrapper"
}
if ($IntervalMinutes -lt 1) {
  throw "FOOTBALL_RELAY_INTERVAL_MINUTES must be at least 1."
}
if ($RetryCount -lt 1 -or $RetryCount -gt 10) {
  throw "FOOTBALL_RELAY_RETRY_COUNT must be between 1 and 10."
}
if ($RetryIntervalMinutes -lt 1 -or $RetryIntervalMinutes -gt 60) {
  throw "FOOTBALL_RELAY_RETRY_INTERVAL_MINUTES must be between 1 and 60."
}
if ($ExecutionTimeLimitMinutes -lt 5 -or $ExecutionTimeLimitMinutes -gt 60) {
  throw "FOOTBALL_RELAY_EXECUTION_LIMIT_MINUTES must be between 5 and 60."
}

$Action = "wscript.exe `"$HiddenWrapper`""

Write-Host "Installing scheduled task '$TaskName' every $IntervalMinutes minute(s)."
& schtasks.exe /Create /TN $TaskName /SC MINUTE /MO $IntervalMinutes /TR $Action /F | Write-Host

$ScheduleService = New-Object -ComObject "Schedule.Service"
$ScheduleService.Connect()
$Task = $ScheduleService.GetFolder("\").GetTask($TaskName)
$Definition = $Task.Definition
$Definition.Settings.Hidden = $true
# TASK_INSTANCES_IGNORE_NEW: a one-minute trigger must never queue or overlap a
# still-running relay push. The wrapper also holds an exclusive file lock as a
# second line of defence when a run is started outside Task Scheduler.
$Definition.Settings.MultipleInstances = 2
$Definition.Settings.StartWhenAvailable = $true
$Definition.Settings.DisallowStartIfOnBatteries = $false
$Definition.Settings.StopIfGoingOnBatteries = $false
$Definition.Settings.RestartCount = $RetryCount
$Definition.Settings.RestartInterval = "PT$($RetryIntervalMinutes)M"
$Definition.Settings.ExecutionTimeLimit = "PT$($ExecutionTimeLimitMinutes)M"
# Waking every minute is intentionally opt-in. The default remains false.
$Definition.Settings.WakeToRun = $WakeToRun

$RegistrationUser = $null
$RegistrationLogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: preserve the existing safe default.
if ($UseS4U) {
  $RegistrationUser = $Definition.Principal.UserId
  if (-not $RegistrationUser) {
    throw "Unable to resolve the scheduled-task principal for explicit S4U registration."
  }
  $RegistrationLogonType = 2 # TASK_LOGON_S4U: explicit opt-in only.
}

$ScheduleService.GetFolder("\").RegisterTaskDefinition(
  $TaskName,
  $Definition,
  6,
  $RegistrationUser,
  $null,
  $RegistrationLogonType
) | Out-Null

Write-Host "Task recovery: start-when-available=true, retries=$RetryCount every $RetryIntervalMinutes minute(s), execution-limit=$ExecutionTimeLimitMinutes minute(s)."
Write-Host "Power/logon: wake-to-run=$WakeToRun, allow-battery=true, logon-mode=$(if ($UseS4U) { 'S4U (explicit opt-in)' } else { 'interactive (default)' })."

if ($StartNow) {
  Write-Host "Starting first run for '$TaskName'."
  & schtasks.exe /Run /TN $TaskName | Write-Host
} else {
  Write-Host "Initial run skipped for '$TaskName'."
}

Write-Host "Installed. Logs: $(Join-Path $Root 'logs\sporttery-relay.log')"
