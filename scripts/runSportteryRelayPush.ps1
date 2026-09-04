$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "sporttery-relay.log"
$LockFile = Join-Path $LogDir "sporttery-relay.lock"
$RelayEnvFile = Join-Path $Root ".codex-tmp\sporttery-relay.env"
$CloudEnvFile = Join-Path $Root ".codex-tmp\cloud-sync.env"

function Import-EnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    $Line = $_.Trim()
    if (-not $Line -or $Line.StartsWith("#") -or -not $Line.Contains("=")) {
      return
    }
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

$DefaultSshKey = Join-Path $Root ".codex-tmp\football.pem"
if (-not $env:SPORTTERY_RELAY_UPLOAD_TRANSPORT) {
  $HasAdminToken = $env:SPORTTERY_RELAY_ADMIN_TOKEN `
    -or $env:FOOTBALL_CLOUD_ADMIN_TOKEN `
    -or $env:ACCESS_CODE_ADMIN_TOKEN `
    -or $env:ADMIN_TOKEN
  if ($HasAdminToken) {
    # Prefer the authenticated HTTPS merge endpoint so the one-minute lane
    # uploads only current/calculator plus result page 1. SSH remains an
    # explicit break-glass transport because it must replace the full file.
    $env:SPORTTERY_RELAY_UPLOAD_TRANSPORT = "http"
  } elseif (Test-Path $DefaultSshKey) {
    $env:SPORTTERY_RELAY_UPLOAD_TRANSPORT = "ssh"
  }
}
if ($env:SPORTTERY_RELAY_UPLOAD_TRANSPORT -eq "ssh") {
  if (-not $env:SPORTTERY_RELAY_SSH_KEY) {
    $env:SPORTTERY_RELAY_SSH_KEY = $DefaultSshKey
  }
  if (-not $env:SPORTTERY_RELAY_SSH_HOST) {
    $env:SPORTTERY_RELAY_SSH_HOST = if ($env:FOOTBALL_CLOUD_HOST) { $env:FOOTBALL_CLOUD_HOST } else { "134.175.132.183" }
  }
  if (-not $env:SPORTTERY_RELAY_SSH_PORT) {
    $env:SPORTTERY_RELAY_SSH_PORT = "22"
  }
  if (-not $env:SPORTTERY_RELAY_SSH_USER) {
    $env:SPORTTERY_RELAY_SSH_USER = "ubuntu"
  }
}

$LockStream = $null
try {
  $LockStream = [System.IO.File]::Open($LockFile, "OpenOrCreate", "ReadWrite", "None")
} catch {
  $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Stamp] sporttery relay skipped: previous run is still active" | Add-Content -Path $LogFile
  exit 0
}

$MaxLogBytes = 5MB
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
  $PreviousLog = Join-Path $LogDir "sporttery-relay.1.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $PreviousLog
  Move-Item -Force -Path $LogFile -Destination $PreviousLog
}

if (-not $env:SPORTTERY_RELAY_PUSH_BASE_URL -and -not $env:FOOTBALL_CLOUD_API_BASE) {
  if ($env:FOOTBALL_CLOUD_HOST) {
    $env:SPORTTERY_RELAY_PUSH_BASE_URL = "https://$($env:FOOTBALL_CLOUD_HOST)"
  } else {
    $env:SPORTTERY_RELAY_PUSH_BASE_URL = "https://134.175.132.183"
  }
}

$ConfiguredRelayBase = if ($env:SPORTTERY_RELAY_PUSH_BASE_URL) {
  $env:SPORTTERY_RELAY_PUSH_BASE_URL
} else {
  $env:FOOTBALL_CLOUD_API_BASE
}
if ($ConfiguredRelayBase -and $ConfiguredRelayBase -match '^http://') {
  $RelayUri = [Uri]$ConfiguredRelayBase
  $IsLoopback = $RelayUri.IsLoopback `
    -or $RelayUri.Host -eq 'localhost' `
    -or $RelayUri.Host -eq '::1' `
    -or $RelayUri.Host -match '^127(?:\.[0-9]{1,3}){3}$'
  if (-not $IsLoopback) {
    # The production endpoint has certificate-backed IP HTTPS. Upgrade legacy
    # cloud-sync env files before any bearer token can leave this machine.
    $env:SPORTTERY_RELAY_PUSH_BASE_URL = $ConfiguredRelayBase -replace '^http://', 'https://'
  }
}

if (-not $env:SPORTTERY_RELAY_VERIFY_REMOTE) {
  $env:SPORTTERY_RELAY_VERIFY_REMOTE = "1"
}

if (-not $env:SPORTTERY_RELAY_RUN_SYNC) {
  $env:SPORTTERY_RELAY_RUN_SYNC = "0"
}

if (-not $env:SPORTTERY_RELAY_TOLERATE_COLLECT_FAILURE) {
  $env:SPORTTERY_RELAY_TOLERATE_COLLECT_FAILURE = "1"
}

if (-not $env:SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD) {
  $env:SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD = "0"
}

$TimeoutMinutes = if ($env:SPORTTERY_RELAY_TIMEOUT_MINUTES) { [int]$env:SPORTTERY_RELAY_TIMEOUT_MINUTES } else { 4 }
$TimeoutMs = [Math]::Max(1, $TimeoutMinutes) * 60 * 1000

$Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$Stamp] sporttery relay push started" | Add-Content -Path $LogFile

Push-Location $Root
try {
  $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $OutFile = Join-Path $LogDir "sporttery-relay.stdout.tmp"
  $ErrFile = Join-Path $LogDir "sporttery-relay.stderr.tmp"
  Remove-Item -Force -ErrorAction SilentlyContinue $OutFile, $ErrFile

  $Process = Start-Process -FilePath $Npm `
    -ArgumentList @("run", "sync:sporttery-relay-push") `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutFile `
    -RedirectStandardError $ErrFile `
    -WindowStyle Hidden `
    -PassThru

  if (-not $Process.WaitForExit($TimeoutMs)) {
    $TimedOut = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$TimedOut] sporttery relay timeout after $TimeoutMinutes minute(s); terminating process tree pid=$($Process.Id)" | Add-Content -Path $LogFile
    & taskkill.exe /PID $Process.Id /T /F | Add-Content -Path $LogFile
    $Process.WaitForExit(10000) | Out-Null
    $env:SPORTTERY_RELAY_LAST_TIMEOUT = "1"
  }

  if (Test-Path $OutFile) {
    Get-Content $OutFile | Add-Content -Path $LogFile
  }
  if (Test-Path $ErrFile) {
    Get-Content $ErrFile | Add-Content -Path $LogFile
  }

  $Process.Refresh()
  $PayloadOk = $null
  if (Test-Path $OutFile) {
    $OutText = Get-Content -Raw -Path $OutFile
    $JsonStart = $OutText.IndexOf("{")
    if ($JsonStart -ge 0) {
      try {
        $Payload = $OutText.Substring($JsonStart) | ConvertFrom-Json
        if ($null -ne $Payload.ok) {
          $PayloadOk = [bool]$Payload.ok
        }
      } catch {
        $PayloadOk = $null
      }
    }
  }
  $Code = if ($env:SPORTTERY_RELAY_LAST_TIMEOUT -eq "1") { 124 } else { $Process.ExitCode }
  if ($null -eq $Code) {
    $Code = if ($null -ne $PayloadOk -and $PayloadOk) { 0 } else { 1 }
  } elseif ($Code -eq 0 -and $null -ne $PayloadOk -and -not $PayloadOk) {
    $Code = 1
  }
  Remove-Item Env:\SPORTTERY_RELAY_LAST_TIMEOUT -ErrorAction SilentlyContinue
  $Ended = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Ended] sporttery relay push exited with $Code" | Add-Content -Path $LogFile
  exit $Code
} finally {
  Pop-Location
  if ($LockStream) {
    $LockStream.Close()
    $LockStream.Dispose()
  }
}
