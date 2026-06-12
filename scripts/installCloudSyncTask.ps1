$ErrorActionPreference = "Stop"

$TaskName = if ($env:FOOTBALL_CLOUD_TASK_NAME) { $env:FOOTBALL_CLOUD_TASK_NAME } else { "FootballPredictCloudSync" }
$IntervalMinutes = if ($env:FOOTBALL_CLOUD_INTERVAL_MINUTES) { [int]$env:FOOTBALL_CLOUD_INTERVAL_MINUTES } else { 5 }
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Wrapper = Join-Path $Root "scripts\runCloudSync.ps1"

if (-not (Test-Path $Wrapper)) {
  throw "Wrapper script not found: $Wrapper"
}

$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`""

Write-Host "Installing scheduled task '$TaskName' every $IntervalMinutes minute(s)."
& schtasks.exe /Create /TN $TaskName /SC MINUTE /MO $IntervalMinutes /TR $Action /F | Write-Host

Write-Host "Starting first run for '$TaskName'."
& schtasks.exe /Run /TN $TaskName | Write-Host

Write-Host "Installed. Logs: $(Join-Path $Root 'logs\cloud-sync.log')"
