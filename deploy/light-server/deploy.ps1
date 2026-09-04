param(
  [string]$HostName = "134.175.132.183",
  [string]$User = "root",
  [string]$KeyPath = ".codex-tmp/football_server_ed25519",
  [string]$RepoUrl = "https://github.com/chen-1119/football-predict.git",
  [string]$AppDir = "/opt/football-predict",
  [string]$Domain = "",
  [string]$AdminToken = "",
  [string]$GptRelayBaseUrl = "",
  [string]$GptRelayApiKey = "",
  [switch]$EnableGptCron
)

throw 'deploy/light-server/deploy.ps1 is disabled: unsigned deployment is not permitted. Use only the signed path: npm run release:bundle; npm run verify:release-bundle; npm run release:deploy-bundle.'

$ErrorActionPreference = "Stop"

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$resolvedKey = Resolve-Path $KeyPath
if (-not $AdminToken) {
  $AdminToken = New-RandomToken
}

$target = "$User@$HostName"
$sshBase = @(
  "-i", $resolvedKey.Path,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
  $target
)

$remoteScript = @"
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
APP_DIR="$AppDir"
REPO_URL="$RepoUrl"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl git nginx
  if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
else
  echo "This deploy script currently supports Debian/Ubuntu apt servers." >&2
  exit 1
fi

id football >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin football
mkdir -p "`$APP_DIR" /var/lib/football-predict

if [ -d "`$APP_DIR/.git" ]; then
  git -C "`$APP_DIR" fetch origin main
  git -C "`$APP_DIR" reset --hard origin/main
else
  rm -rf "`$APP_DIR"
  git clone "`$REPO_URL" "`$APP_DIR"
fi

chown -R football:football "`$APP_DIR" /var/lib/football-predict
cd "`$APP_DIR"
npm ci
npm run build

cp deploy/light-server/env.example deploy/light-server/env
sed -i "s|^HOST=.*|HOST=127.0.0.1|" deploy/light-server/env
sed -i "s|^PORT=.*|PORT=8788|" deploy/light-server/env
sed -i "s|^ENABLE_SYNC_CRON=.*|ENABLE_SYNC_CRON=1|" deploy/light-server/env
sed -i "s|^ENABLE_500_SYNC=.*|ENABLE_500_SYNC=1|" deploy/light-server/env
sed -i "s|^REQUIRE_EXTERNAL_SIGNALS=.*|REQUIRE_EXTERNAL_SIGNALS=1|" deploy/light-server/env
sed -i "s|^SKIP_SPORTTERY_FETCH=.*|SKIP_SPORTTERY_FETCH=0|" deploy/light-server/env
sed -i "s|^SOURCE_MAX_AGE_MINUTES=.*|SOURCE_MAX_AGE_MINUTES=20|" deploy/light-server/env
sed -i "s|^SOURCE_MIN_EXTERNAL_COVERAGE=.*|SOURCE_MIN_EXTERNAL_COVERAGE=0.50|" deploy/light-server/env
sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$AdminToken|" deploy/light-server/env
sed -i "s|^ALLOW_LOCAL_ADMIN=.*|ALLOW_LOCAL_ADMIN=0|" deploy/light-server/env
"@

if ($GptRelayBaseUrl) {
  $remoteScript += "`nsed -i `"s|^GPT_RELAY_BASE_URL=.*|GPT_RELAY_BASE_URL=$GptRelayBaseUrl|`" deploy/light-server/env"
}
if ($GptRelayApiKey) {
  $remoteScript += "`nsed -i `"s|^GPT_RELAY_API_KEY=.*|GPT_RELAY_API_KEY=$GptRelayApiKey|`" deploy/light-server/env"
}
if ($EnableGptCron) {
  $remoteScript += "`nsed -i `"s|^ENABLE_GPT_CRON=.*|ENABLE_GPT_CRON=1|`" deploy/light-server/env"
}

$remoteScript += @"

cp deploy/light-server/football-predict.service /etc/systemd/system/football-predict.service
systemctl daemon-reload
systemctl enable --now football-predict
systemctl restart football-predict

install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
install -m 0644 deploy/light-server/nginx-http-common.conf /etc/nginx/conf.d/football-predict-common.conf
install -m 0644 deploy/light-server/nginx-server-common.conf /etc/nginx/snippets/football-predict-server.conf
install -m 0644 deploy/light-server/nginx-security-headers.conf /etc/nginx/snippets/football-predict-security-headers.conf
install -m 0644 deploy/light-server/nginx.conf /etc/nginx/sites-available/football-predict
ln -sf /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

sleep 3
curl -fsS http://127.0.0.1:8788/api/health >/tmp/football-health.json
cat /tmp/football-health.json
"@

$remotePath = "/tmp/football-deploy-$([guid]::NewGuid().ToString("N")).sh"
$temp = New-TemporaryFile
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $remoteScript = $remoteScript -replace "`r`n", "`n" -replace "`r", "`n"
  [System.IO.File]::WriteAllText($temp, $remoteScript, $utf8NoBom)
  scp -i $resolvedKey.Path -o StrictHostKeyChecking=accept-new $temp "${target}:$remotePath"
  if ($User -eq "root") {
    ssh @sshBase "bash $remotePath; rm -f $remotePath"
  } else {
    ssh @sshBase "sudo bash $remotePath; rm -f $remotePath"
  }
  Write-Host ""
  Write-Host "Deployment finished."
  Write-Host "HTTP bootstrap URL: http://$HostName/"
  Write-Host "Run deploy/light-server/enable-nginx-tls.sh before sending credentials over the public origin."
  Write-Host "ADMIN_TOKEN was not printed; keep it in secure operator storage."
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}
