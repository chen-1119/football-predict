#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
REPO_URL="${REPO_URL:-https://github.com/chen-1119/football-predict.git}"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/chen-1119/football-predict/main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8788/api/health}"
REVISION_FILE="${REVISION_FILE:-$APP_DIR/.deploy-revision}"
LOCK_FILE="${LOCK_FILE:-/var/lock/football-predict-auto-repair.lock}"
RESCUE_SCRIPT="${RESCUE_SCRIPT:-/tmp/cloudRescueDeploy.sh}"
CHECK_DIR="${CHECK_DIR:-/tmp/football-predict-deploy-check}"
DEPLOY_TRIGGER_FILE="${DEPLOY_TRIGGER_FILE:-/var/lib/football-predict/deploy-request.json}"
DEPLOY_PATHS=(
  package.json
  package-lock.json
  index.html
  vite.config.ts
  eslint.config.js
  tsconfig.json
  tsconfig.app.json
  tsconfig.node.json
  src
  server
  scripts
  deploy/light-server
  server-data/training
  server-data/worldcup
)

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[auto-repair] another repair is running"
  exit 0
fi

timestamp() {
  date -Is
}

health_ok=0
if curl -fsS --max-time 8 "$HEALTH_URL" >/tmp/football-predict-health.json 2>/tmp/football-predict-health.err; then
  health_ok=1
fi

remote_sha="$(git ls-remote "$REPO_URL" refs/heads/main 2>/tmp/football-predict-ls-remote.err | awk '{print $1}' || true)"
local_sha="$(cat "$REVISION_FILE" 2>/dev/null || true)"
trigger_requested=0
if [ -s "$DEPLOY_TRIGGER_FILE" ]; then
  trigger_mtime="$(stat -c %Y "$DEPLOY_TRIGGER_FILE" 2>/dev/null || echo 0)"
  revision_mtime="$(stat -c %Y "$REVISION_FILE" 2>/dev/null || echo 0)"
  if [ "${trigger_mtime:-0}" -gt "${revision_mtime:-0}" ]; then
    trigger_requested=1
  fi
fi

echo "[auto-repair] $(timestamp) health=$health_ok local=${local_sha:-none} remote=${remote_sha:-unknown} trigger=$trigger_requested"

deploy_paths_changed() {
  if [ -z "$remote_sha" ]; then
    return 1
  fi
  if [ -z "$local_sha" ]; then
    return 0
  fi

  rm -rf "$CHECK_DIR"
  mkdir -p "$CHECK_DIR"
  git -C "$CHECK_DIR" init -q
  git -C "$CHECK_DIR" remote add origin "$REPO_URL"
  git -C "$CHECK_DIR" fetch --depth=80 --filter=blob:none origin main >/tmp/football-predict-fetch-check.log 2>&1 || return 0
  git -C "$CHECK_DIR" cat-file -e "$local_sha^{commit}" 2>/dev/null || return 0
  git -C "$CHECK_DIR" cat-file -e "$remote_sha^{commit}" 2>/dev/null || return 0

  if git -C "$CHECK_DIR" diff --quiet "$local_sha" "$remote_sha" -- "${DEPLOY_PATHS[@]}"; then
    return 1
  fi
  return 0
}

if [ "$health_ok" -eq 1 ] && [ -n "$remote_sha" ] && [ "$remote_sha" = "$local_sha" ]; then
  echo "[auto-repair] no repair needed"
  rm -f "$DEPLOY_TRIGGER_FILE" || true
  exit 0
fi

if [ "$health_ok" -eq 1 ] && [ -z "$remote_sha" ]; then
  echo "[auto-repair] service is healthy; GitHub check failed, skip deploy"
  exit 0
fi

if [ "$health_ok" -eq 1 ] && [ "$trigger_requested" -ne 1 ] && ! deploy_paths_changed; then
  echo "[auto-repair] only data changed; service is healthy, skip deploy"
  exit 0
fi

if [ "$health_ok" -ne 1 ]; then
  echo "[auto-repair] local health failed; trying quick service restart first"
  sudo systemctl restart football-predict || true
  sleep 8
  if curl -fsS --max-time 8 "$HEALTH_URL" >/tmp/football-predict-health.json 2>/tmp/football-predict-health.err; then
    health_ok=1
    local_sha="$(cat "$REVISION_FILE" 2>/dev/null || true)"
    if [ -n "$remote_sha" ] && [ "$remote_sha" = "$local_sha" ]; then
      echo "[auto-repair] service recovered after restart"
      exit 0
    fi
  fi
fi

echo "[auto-repair] running safe rescue deploy"
curl -fsSL "$RAW_BASE/scripts/cloudRescueDeploy.sh" -o "$RESCUE_SCRIPT"
chmod +x "$RESCUE_SCRIPT"
APP_DIR="$APP_DIR" REPO_URL="$REPO_URL" REVISION_FILE="$REVISION_FILE" bash "$RESCUE_SCRIPT"
rm -f "$DEPLOY_TRIGGER_FILE" || true
