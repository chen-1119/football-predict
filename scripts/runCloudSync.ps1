$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "cloud-sync.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $env:FOOTBALL_CLOUD_KEY) {
  $env:FOOTBALL_CLOUD_KEY = ".codex-tmp/football.pem"
}

if (-not $env:FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC) {
  $env:FOOTBALL_REMOTE_SUPPLEMENTAL_SYNC = "1"
}

$Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"[$Stamp] cloud sync started" | Tee-Object -FilePath $LogFile -Append

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
    -NoNewWindow `
    -Wait `
    -PassThru

  if (Test-Path $OutFile) {
    Get-Content $OutFile | Tee-Object -FilePath $LogFile -Append
  }
  if (Test-Path $ErrFile) {
    Get-Content $ErrFile | Tee-Object -FilePath $LogFile -Append
  }

  $Code = $Process.ExitCode
  $Ended = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$Ended] cloud sync exited with $Code" | Tee-Object -FilePath $LogFile -Append
  exit $Code
} finally {
  Pop-Location
}
