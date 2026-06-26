#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
SRC_DIR="${SRC_DIR:-/tmp/football-predict-src}"
REPO_URL="${REPO_URL:-https://github.com/chen-1119/football-predict.git}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/chen-1119/football-predict/main}"
REVISION_FILE="${REVISION_FILE:-$APP_DIR/.deploy-revision}"
AUTO_REPAIR_BIN="${AUTO_REPAIR_BIN:-/usr/local/bin/football-predict-auto-repair}"
AUTO_REPAIR_SERVICE="/etc/systemd/system/football-predict-auto-repair.service"
AUTO_REPAIR_TIMER="/etc/systemd/system/football-predict-auto-repair.timer"
DEPLOY_TRIGGER_FILE="${DEPLOY_TRIGGER_FILE:-/var/lib/football-predict/deploy-request.json}"
DEPLOY_TRIGGER_PATH="/etc/systemd/system/football-predict-deploy-request.path"
SERVICE_RESTARTED=0
SERVICE_STOPPED=0

cleanup() {
  local exit_code=$?
  if [ "$SERVICE_STOPPED" -eq 1 ] && [ "$SERVICE_RESTARTED" -ne 1 ]; then
    echo "[cleanup] restart service after interrupted deploy"
    sudo systemctl restart football-predict || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if [ ! -f "$file" ]; then
    return 0
  fi
  if sudo grep -q "^${key}=" "$file"; then
    sudo sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" | sudo tee -a "$file" >/dev/null
  fi
}

ensure_lightweight_runtime_env() {
  local file="$1"
  if [ ! -f "$file" ]; then
    return 0
  fi
  set_env_value "$file" "SNAPSHOT_RETENTION_DAYS" "14"
  set_env_value "$file" "ENABLE_FULL_HISTORY_FILE_FALLBACK" "0"
  set_env_value "$file" "ODDS_HISTORY_RETENTION_DAYS" "30"
  set_env_value "$file" "DATASTORE_HISTORY_SNAPSHOT_RETENTION_DAYS" "14"
  set_env_value "$file" "DATASTORE_STORE_FULL_MATCH_SNAPSHOTS" "0"
  set_env_value "$file" "DATASTORE_ODDS_HISTORY_RETENTION_DAYS" "30"
  set_env_value "$file" "DATASTORE_ODDS_HISTORY_RECENT_ROWS" "12000"
  set_env_value "$file" "DATASTORE_COMPACT_ON_SYNC" "1"
  set_env_value "$file" "DATASTORE_COMPACT_INTERVAL_MINUTES" "60"
  set_env_value "$file" "DATASTORE_COMPACT_RETENTION_DAYS" "14"
  set_env_value "$file" "DATASTORE_COMPACT_MAX_ROWS" "150000"
}

install_deploy_automation() {
  echo "[automation] refresh auto repair timer and web deploy trigger"
  sudo curl -fsSL "$RAW_BASE/scripts/cloudAutoRepair.sh" -o "$AUTO_REPAIR_BIN"
  sudo chmod 755 "$AUTO_REPAIR_BIN"

  sudo tee "$AUTO_REPAIR_SERVICE" >/dev/null <<SERVICE
[Unit]
Description=Football Predict auto repair and safe deploy
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=REPO_URL=$REPO_URL
Environment=RAW_BASE=$RAW_BASE
ExecStart=$AUTO_REPAIR_BIN
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
SERVICE

  sudo tee "$AUTO_REPAIR_TIMER" >/dev/null <<'TIMER'
[Unit]
Description=Run Football Predict auto repair periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
RandomizedDelaySec=20s
Persistent=true

[Install]
WantedBy=timers.target
TIMER

  sudo mkdir -p "$(dirname "$DEPLOY_TRIGGER_FILE")"
  sudo touch "$DEPLOY_TRIGGER_FILE"
  if id football >/dev/null 2>&1; then
    sudo chown football:football "$DEPLOY_TRIGGER_FILE" "$(dirname "$DEPLOY_TRIGGER_FILE")" || true
  fi
  sudo chmod 664 "$DEPLOY_TRIGGER_FILE" || true

  sudo tee "$DEPLOY_TRIGGER_PATH" >/dev/null <<PATHUNIT
[Unit]
Description=Run Football Predict deploy when the web app writes a deploy request

[Path]
PathModified=$DEPLOY_TRIGGER_FILE
Unit=football-predict-auto-repair.service

[Install]
WantedBy=multi-user.target
PATHUNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now football-predict-auto-repair.timer
  sudo systemctl enable --now football-predict-deploy-request.path
}

echo "[1/10] ensure tools and swap"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y git rsync curl
fi
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile || true
  sudo swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "[2/10] fetch latest code"
rm -rf "$SRC_DIR"
git clone --depth 1 "$REPO_URL" "$SRC_DIR"
git -C "$SRC_DIR" log --oneline -3
DEPLOY_SHA="$(git -C "$SRC_DIR" rev-parse HEAD)"
grep -n "withoutEmbeddedReview" "$SRC_DIR/scripts/syncData.cjs"

echo "[3/10] seed temp workspace with live data"
mkdir -p "$SRC_DIR/public/data"
if [ -d "$APP_DIR/public/data" ]; then
  rsync -a "$APP_DIR/public/data/" "$SRC_DIR/public/data/"
fi
for file_name in matches.json odds-history.json; do
  if [ -f "$APP_DIR/public/$file_name" ]; then
    cp -f "$APP_DIR/public/$file_name" "$SRC_DIR/public/$file_name"
  fi
done

cd "$SRC_DIR"

echo "[4/10] install dependencies in temp workspace"
npm ci --include=dev --no-audit --no-fund

echo "[5/10] run data sync in temp workspace"
ensure_lightweight_runtime_env "$APP_DIR/deploy/light-server/env"
set +u
if [ -r "$APP_DIR/deploy/light-server/env" ]; then
  set -a
  . "$APP_DIR/deploy/light-server/env"
  set +a
fi
set -u
npm run sync:500 || true
npm run sync:500:details || true
npm run sync:prematch || true
npm run optimize:strategy
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1400" npm run sync:data
npm run optimize:strategy

echo "[6/10] validate and build in temp workspace"
npm run validate:data
npm run build

echo "[7/10] stop service for final switch"
sudo systemctl stop football-predict || true
SERVICE_STOPPED=1

echo "[8/10] deploy prepared workspace"
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete \
  --exclude='.git' \
  --exclude='logs' \
  --exclude='server-data' \
  --exclude='.codex-tmp' \
  --exclude='deploy/light-server/env' \
  "$SRC_DIR/" "$APP_DIR/"
echo "$DEPLOY_SHA" | sudo tee "$REVISION_FILE" >/dev/null

cd "$APP_DIR"

echo "[9/10] compact datastore, permissions, restart"
npm run compact:datastore
sudo chown -R football:football "$APP_DIR" /var/lib/football-predict || true
install_deploy_automation
sudo systemctl restart football-predict
SERVICE_RESTARTED=1

echo "[10/10] verify"
sleep 8
curl -fsS http://127.0.0.1:8788/api/health | head -c 5000
echo
node - <<'NODE'
const fs = require('fs');
const review = JSON.parse(fs.readFileSync('public/data/post-match-reviews.json', 'utf8'));
const history = JSON.parse(fs.readFileSync('public/data/matches-history.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('public/data/sync-meta.json', 'utf8'));
console.log(JSON.stringify({
  metaUpdatedAt: meta.updatedAt,
  historyRows: history.length,
  historyBytes: fs.statSync('public/data/matches-history.json').size,
  embeddedReviews: history.filter((match) => match.postMatchReview).length,
  postMatchReviews: review.summary
}, null, 2));
NODE
