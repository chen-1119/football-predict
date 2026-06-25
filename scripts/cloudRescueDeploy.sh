#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
SRC_DIR="${SRC_DIR:-/tmp/football-predict-src}"
REPO_URL="${REPO_URL:-https://github.com/chen-1119/football-predict.git}"

echo "[1/9] stop service"
sudo systemctl stop football-predict || true

echo "[2/9] ensure tools and swap"
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

echo "[3/9] fetch latest code"
rm -rf "$SRC_DIR"
git clone --depth 1 "$REPO_URL" "$SRC_DIR"
git -C "$SRC_DIR" log --oneline -3
grep -n "withoutEmbeddedReview" "$SRC_DIR/scripts/syncData.cjs"

echo "[4/9] deploy code while preserving env and data"
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='logs' \
  --exclude='server-data' \
  --exclude='.codex-tmp' \
  --exclude='deploy/light-server/env' \
  --exclude='public/data' \
  --exclude='public/matches.json' \
  --exclude='public/odds-history.json' \
  "$SRC_DIR/" "$APP_DIR/"

cd "$APP_DIR"

echo "[5/9] install dependencies"
npm ci --include=dev --no-audit --no-fund

echo "[6/9] run data sync with production env"
set +u
if [ -r deploy/light-server/env ]; then
  set -a
  . deploy/light-server/env
  set +a
fi
set -u
npm run sync:500 || true
npm run sync:500:details || true
npm run sync:prematch || true
NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1400" npm run sync:data

echo "[7/9] validate, compact, build"
npm run validate:data
npm run compact:datastore
npm run build

echo "[8/9] permissions and restart"
sudo chown -R football:football "$APP_DIR" /var/lib/football-predict || true
sudo systemctl restart football-predict

echo "[9/9] verify"
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
