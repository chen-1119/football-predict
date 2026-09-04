$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "cloud-sync.log"
$LockFile = Join-Path $LogDir "cloud-sync.lock"
$EnvFile = Join-Path $Root ".codex-tmp\cloud-sync.env"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
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

$LockStream = $null
try {
  $LockStream = [System.IO.File]::Open($LockFile, "OpenOrCreate", "ReadWrite", "None")
} catch {
  $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Stamp] cloud sync skipped: previous run is still active" | Add-Content -Path $LogFile
  exit 0
}

$MaxLogBytes = 10MB
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
  $PreviousLog = Join-Path $LogDir "cloud-sync.1.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $PreviousLog
  Move-Item -Force -Path $LogFile -Destination $PreviousLog
}

if (-not $env:FOOTBALL_CLOUD_KEY) {
  $env:FOOTBALL_CLOUD_KEY = ".codex-tmp/football.pem"
}

if (-not $env:FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC) {
  $env:FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC = "1"
}

$TimeoutMinutes = if ($env:FOOTBALL_CLOUD_SYNC_TIMEOUT_MINUTES) { [int]$env:FOOTBALL_CLOUD_SYNC_TIMEOUT_MINUTES } else { 8 }
$TimeoutMs = [Math]::Max(1, $TimeoutMinutes) * 60 * 1000

$Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$Stamp] cloud sync started" | Add-Content -Path $LogFile

Push-Location $Root
try {
  $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $OutFile = Join-Path $LogDir "cloud-sync.stdout.tmp"
  $ErrFile = Join-Path $LogDir "cloud-sync.stderr.tmp"
  Remove-Item -Force -ErrorAction SilentlyContinue $OutFile, $ErrFile

  $Process = Start-Process -FilePath $Npm `
    -ArgumentList @("run", "sync:cloud-push") `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutFile `
    -RedirectStandardError $ErrFile `
    -WindowStyle Hidden `
    -PassThru

  if (-not $Process.WaitForExit($TimeoutMs)) {
    $TimedOut = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$TimedOut] cloud sync timeout after $TimeoutMinutes minute(s); terminating process tree pid=$($Process.Id)" | Add-Content -Path $LogFile
    & taskkill.exe /PID $Process.Id /T /F | Add-Content -Path $LogFile
    $Process.WaitForExit(10000) | Out-Null
    $env:FOOTBALL_CLOUD_LAST_TIMEOUT = "1"
  }

  if (Test-Path $OutFile) {
    Get-Content $OutFile | Add-Content -Path $LogFile
  }
  if (Test-Path $ErrFile) {
    Get-Content $ErrFile | Add-Content -Path $LogFile
  }

  $Code = if ($env:FOOTBALL_CLOUD_LAST_TIMEOUT -eq "1") { 124 } else { $Process.ExitCode }
  Remove-Item Env:\FOOTBALL_CLOUD_LAST_TIMEOUT -ErrorAction SilentlyContinue
  $Ended = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Ended] cloud sync exited with $Code" | Add-Content -Path $LogFile
  exit $Code
} finally {
  Pop-Location
  if ($LockStream) {
    $LockStream.Close()
    $LockStream.Dispose()
  }
}
