#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/football-predict"
FAILED_DIR="/opt/football-predict.failed"
STORE_DIR="/var/lib/football-predict"
SQLITE_PATH="${STORE_DIR}/football.db"
RECOVERY_ROOT="/var/lib/football-release/recovery"
RECOVERY_CURRENT="${RECOVERY_ROOT}/current"
ENV_FILE="/etc/football-predict/env"
NODE_HOME="/opt/node-v22.22.1"

fail() {
  printf 'publication-affinity-recovery: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "must run as root from the server console"
for directory in "$APP_DIR" "$STORE_DIR" "$RECOVERY_ROOT"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "unsafe required directory: ${directory}"
done
[ -d "$RECOVERY_CURRENT" ] && [ ! -L "$RECOVERY_CURRENT" ] \
  || fail "no unresolved release transaction exists"
[ -f "$RECOVERY_CURRENT/phase" ] && [ ! -L "$RECOVERY_CURRENT/phase" ] \
  || fail "recovery phase file is unsafe"
phase="$(head -n 1 "$RECOVERY_CURRENT/phase")"
[ "$phase" = "recovering-rollback" ] \
  || fail "expected recovering-rollback, found ${phase}"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "runtime environment is unsafe"
[ -x "$NODE_HOME/bin/npm" ] || fail "fixed npm runtime is unavailable"

bundle_marker="$(head -n 1 "$APP_DIR/.release-bundle-sha256" 2>/dev/null || true)"
live_marker="$(head -n 1 "$APP_DIR/.release-live-complete" 2>/dev/null || true)"
[[ "$bundle_marker" =~ ^[0-9a-f]{64}$ ]] || fail "active release marker is invalid"
[ "$bundle_marker" = "$live_marker" ] || fail "active release is not live-complete"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
audit_dir="/var/lib/football-release/manual-recovery/${timestamp}-${bundle_marker:0:12}"
[ ! -e "$audit_dir" ] && [ ! -L "$audit_dir" ] || fail "audit directory already exists"
install -d -o root -g root -m 0700 "$audit_dir"

for suffix in "" "-wal" "-shm"; do
  source_path="${SQLITE_PATH}${suffix}"
  if [ -e "$source_path" ] || [ -L "$source_path" ]; then
    [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail "unsafe SQLite source: ${source_path}"
    cp --reflink=auto --sparse=always --no-dereference -- "$source_path" "$audit_dir/$(basename "$source_path").before"
    chmod 0600 "$audit_dir/$(basename "$source_path").before"
    sha256sum "$audit_dir/$(basename "$source_path").before" >>"$audit_dir/sqlite-before.sha256"
  fi
done
sync -f "$audit_dir"

systemctl stop football-sync-worker.service football-predict.service \
  football-cleanup.timer football-monitor.timer
systemctl is-active --quiet football-predict.service && fail "application service did not stop"
systemctl is-active --quiet football-sync-worker.service && fail "sync worker did not stop"

runuser -u football -- bash -c \
  'set -a; . "$1"; set +a; cd "$2"; exec "$3" run datastore:sqlite' \
  bash "$ENV_FILE" "$APP_DIR" "$NODE_HOME/bin/npm"

systemctl start football-predict.service
healthy=0
for attempt in $(seq 1 90); do
  if curl -fsS --max-time 8 http://127.0.0.1:8788/api/v1/health >"$audit_dir/health.json"; then
    healthy=$((healthy + 1))
    [ "$healthy" -ge 2 ] && break
  else
    healthy=0
  fi
  sleep 2
done
[ "$healthy" -ge 2 ] || fail "application did not become stably healthy after SQLite rebuild"

# The old application is now healthy with the current serving generation. Keep
# the failed candidate and unresolved transaction as recoverable audit evidence
# while clearing the fixed paths that block the next signed release.
if [ -e "$FAILED_DIR" ] || [ -L "$FAILED_DIR" ]; then
  [ -d "$FAILED_DIR" ] && [ ! -L "$FAILED_DIR" ] || fail "failed app path is unsafe"
  mv -T -- "$FAILED_DIR" "$audit_dir/failed-app"
fi
mv -T -- "$RECOVERY_CURRENT" "$audit_dir/recovery-transaction"
sync -f "$(dirname "$FAILED_DIR")"
sync -f "$RECOVERY_ROOT"

systemctl start football-sync-worker.service football-cleanup.timer football-monitor.timer
systemctl is-active --quiet football-predict.service || fail "application service is not active"
systemctl is-active --quiet football-sync-worker.service || fail "sync worker is not active"
systemctl is-active --quiet football-cleanup.timer || fail "cleanup timer is not active"
systemctl is-active --quiet football-monitor.timer || fail "monitor timer is not active"
curl -fsS --max-time 8 http://127.0.0.1:8788/api/v1/health >"$audit_dir/health-final.json"

printf 'publication-affinity-recovery: complete audit=%s release=%s\n' "$audit_dir" "$bundle_marker"
