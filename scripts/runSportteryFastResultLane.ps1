$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "sporttery-fast-result.log"
$RelayEnvFile = Join-Path $Root ".codex-tmp\sporttery-relay.env"
$CloudEnvFile = Join-Path $Root ".codex-tmp\cloud-sync.env"

function Import-EnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $Line = $_.Trim()
    if (-not $Line -or $Line.StartsWith("#") -or -not $Line.Contains("=")) { return }
    $Name, $Value = $Line.Split("=", 2)
    $Name = $Name.Trim()
    if ($Name -match "^[A-Za-z_][A-Za-z0-9_]*$") {
      [Environment]::SetEnvironmentVariable($Name, $Value.Trim(), "Process")
    }
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Import-EnvFile $CloudEnvFile
Import-EnvFile $RelayEnvFile

if (-not $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL) {
  if ($env:SPORTTERY_RELAY_PUSH_BASE_URL) {
    $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL = $env:SPORTTERY_RELAY_PUSH_BASE_URL
  } elseif ($env:FOOTBALL_CLOUD_API_BASE) {
    $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL = $env:FOOTBALL_CLOUD_API_BASE
  } elseif ($env:FOOTBALL_CLOUD_HOST) {
    $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL = "https://$($env:FOOTBALL_CLOUD_HOST)"
  } else {
    $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL = "https://134.175.132.183"
  }
}

if ($env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL -match '^http://') {
  $RelayUri = [Uri]$env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL
  $IsLoopback = $RelayUri.IsLoopback `
    -or $RelayUri.Host -eq 'localhost' `
    -or $RelayUri.Host -eq '::1' `
    -or $RelayUri.Host -match '^127(?:\.[0-9]{1,3}){3}$'
  if (-not $IsLoopback) {
    $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL = $env:SPORTTERY_FAST_RESULT_PUSH_BASE_URL -replace '^http://', 'https://'
  }
}

if (-not $env:SPORTTERY_FAST_RESULT_INTERVAL_SECONDS) {
  $env:SPORTTERY_FAST_RESULT_INTERVAL_SECONDS = "15"
}
if (-not $env:SPORTTERY_FAST_RESULT_BACKOFF_BASE_SECONDS) {
  $env:SPORTTERY_FAST_RESULT_BACKOFF_BASE_SECONDS = "30"
}
if (-not $env:SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS) {
  $env:SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS = "300"
}

$MaxLogBytes = 5MB
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
  $PreviousLog = Join-Path $LogDir "sporttery-fast-result.1.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $PreviousLog
  Move-Item -Force -Path $LogFile -Destination $PreviousLog
}

$Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$Stamp] fast result lane starting" | Add-Content -Path $LogFile

Push-Location $Root
try {
  $RunnerScript = [IO.Path]::GetFullPath((Join-Path $Root "scripts\runSportteryFastResultLane.cjs"))
  $Node = if ($env:FOOTBALL_FAST_RESULT_NODE) {
    [IO.Path]::GetFullPath($env:FOOTBALL_FAST_RESULT_NODE)
  } else {
    (Get-Command node.exe -ErrorAction Stop).Source
  }
  if (-not (Test-Path -LiteralPath $Node)) {
    throw "Configured Node executable does not exist. Set FOOTBALL_FAST_RESULT_NODE to an absolute machine-readable path."
  }
  & $Node $RunnerScript "--watch" 2>&1 | ForEach-Object {
    $_ | Add-Content -Path $LogFile
  }
  $Code = $LASTEXITCODE
  if ($null -eq $Code) { $Code = 1 }
  $Ended = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Ended] fast result lane exited with $Code" | Add-Content -Path $LogFile
  exit $Code
} finally {
  Pop-Location
}
