$ErrorActionPreference = "Stop"

$TaskName = if ($env:FOOTBALL_CLOUD_TASK_NAME) { $env:FOOTBALL_CLOUD_TASK_NAME } else { "FootballPredictCloudSync" }
$IntervalMinutes = if ($env:FOOTBALL_CLOUD_INTERVAL_MINUTES) { [int]$env:FOOTBALL_CLOUD_INTERVAL_MINUTES } else { 5 }
$StartNow = $env:FOOTBALL_CLOUD_START_NOW -ne "0"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Wrapper = Join-Path $Root "scripts\runCloudSync.ps1"
$HiddenWrapper = Join-Path $Root "scripts\runCloudSyncHidden.vbs"

if (-not (Test-Path $Wrapper)) {
  throw "Wrapper script not found: $Wrapper"
}

$Action = "wscript.exe `"$HiddenWrapper`""

Write-Host "Installing scheduled task '$TaskName' every $IntervalMinutes minute(s)."
& schtasks.exe /Create /TN $TaskName /SC MINUTE /MO $IntervalMinutes /TR $Action /F | Write-Host

$ScheduleService = New-Object -ComObject "Schedule.Service"
$ScheduleService.Connect()
$Task = $ScheduleService.GetFolder("\").GetTask($TaskName)
$Definition = $Task.Definition
$Definition.Settings.Hidden = $true
$Definition.Settings.MultipleInstances = 2
$ScheduleService.GetFolder("\").RegisterTaskDefinition($TaskName, $Definition, 6, $null, $null, 3) | Out-Null

if ($StartNow) {
  Write-Host "Starting first run for '$TaskName'."
  & schtasks.exe /Run /TN $TaskName | Write-Host
} else {
  Write-Host "Initial run skipped for '$TaskName'."
}

Write-Host "Installed. Logs: $(Join-Path $Root 'logs\cloud-sync.log')"
