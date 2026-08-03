#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/football-predict}"
NEXT_DIR="${NEXT_DIR:-${APP_DIR}.next}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}.previous}"
FAILED_DIR="${FAILED_DIR:-${APP_DIR}.failed}"
SERVICE_NAME="${SERVICE_NAME:-football-predict}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-football-sync-worker}"
NODE_HOME="${NODE_HOME:-/opt/node-v22.22.1}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8788}"
CANDIDATE_PORT="${CANDIDATE_PORT:-8789}"
KEEP_BACKUP="${KEEP_BACKUP:-1}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-/etc/football-predict/env}"
BUILD_USER="${BUILD_USER:-football-build}"
TRUSTED_SOURCE_DIR="${1:-${TRUSTED_SOURCE_DIR:-}}"
BUNDLE_SHA256="${BUNDLE_SHA256:-}"
RELEASE_SITE="${RELEASE_SITE:-}"
RELEASE_CHANNEL="${RELEASE_CHANNEL:-}"
RELEASE_SEQUENCE="${RELEASE_SEQUENCE:-}"
readonly FIXED_RECOVERY_HELPER_ROTATION_CONTRACT="football-fixed-recovery-helper-rotation-v1"
readonly FIXED_RECOVERY_HELPER_ROTATION_SOURCE="deploy/light-server/football-release-recovery.cjs"
readonly FIXED_RECOVERY_HELPER_ROTATION_TARGET="/usr/local/libexec/football-release-recovery.cjs"
TRANSACTION_VERSION=3
RECOVERY_ROOT="/var/lib/football-release/recovery"
RECOVERY_DIR="${RECOVERY_ROOT}/current"
READINESS_EVIDENCE_ROOT="/var/lib/football-release/readiness-failures"
RELEASE_ENRICHMENT_REUSE_REQUEST="/var/lib/football-predict/release-enrichment-reuse-request.json"
RELEASE_WORKER_PRIORITY_REQUEST="/var/lib/football-predict/release-worker-priority-request.json"
LIVE_STORE_DIR="/var/lib/football-predict"
LIVE_SQLITE_PATH="${LIVE_STORE_DIR}/football.db"
RECOVERY_STAGING_DIR=""
RECOVERY_RESOLVED_DIR=""
RECOVERY_ACTIVE=0
RUNTIME_ENV_DIRTY=0
HOST_CONFIG_DIRTY=0
TIMER_STATE_DIRTY=0
RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=0
RELEASE_FAST_WATCHER_PAUSED_PROCESS=0
RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP=""
RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP=""
TRANSACTION_FINALIZING=0
TRANSACTION_COMMITTED=0
BUILD_DIR="${APP_DIR}.build-${BUNDLE_SHA256:0:12}-$$"
BUILD_HOME="${BUILD_DIR}/.build-home"
CANDIDATE_STORE_DIR="${BUILD_DIR}/server-data"
CANDIDATE_SQLITE_PATH="${CANDIDATE_STORE_DIR}/football.db"
CANDIDATE_TRANSITION_LEASE="${RECOVERY_DIR}/candidate-transition-lease.json"
CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS="${RELEASE_CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS:-600}"
CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS="${RELEASE_CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS:-420}"
CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS="${RELEASE_CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS:-30}"
CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS="${RELEASE_CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS:-90}"
LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS="${RELEASE_LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS:-120}"
ALLOW_STOPPED_WINDOW_SQLITE_EXPORT="${RELEASE_ALLOW_STOPPED_WINDOW_SQLITE_EXPORT:-0}"
WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS="${RELEASE_WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS:-600}"
POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS="${RELEASE_POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS:-120}"
POST_SWAP_TRANSITION_START_BUDGET_SECONDS="${RELEASE_POST_SWAP_TRANSITION_START_BUDGET_SECONDS:-}"
RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS="${RELEASE_CANDIDATE_HEARTBEAT_KEEPER_INTERVAL_SECONDS:-20}"
RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS="${RELEASE_CANDIDATE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS:-25000}"
RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS="${RELEASE_CANDIDATE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS:-10000}"
RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS="${RELEASE_CANDIDATE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS:-60}"
RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS="${RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS:-30000}"
RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS="${RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS:-45}"
WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS="${RELEASE_WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS:-90}"
readonly LIVE_SQLITE_PREBUILD_HEARTBEAT_MAX_AGE_SECONDS=90
readonly POST_PREBUILD_HTTP_HEARTBEAT_MAX_AGE_SECONDS=110
CANDIDATE_UNIT=""
RELEASE_HEARTBEAT_KEEPER_UNIT=""
RELEASE_HEARTBEAT_KEEPER_RUNTIME_DIR=""
RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE=""
RELEASE_SYNC_WRITE_BARRIER_UNIT=""
RELEASE_SYNC_WRITE_BARRIER_RUNTIME_DIR=""
RELEASE_SYNC_WRITE_BARRIER_CONTROL_FILE=""
RELEASE_SYNC_WRITE_BARRIER_PID=""
RELEASE_POINTER_COMMIT_KEEPER_UNIT=""
RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR=""
RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE=""
RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE=""
RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=0
RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR=""
RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE=""
RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE=""
RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE=""
RELEASE_POINTER_COMMIT_KEEPER_PID=""
RELEASE_POINTER_COMMIT_KEEPER_LOCK_DIR=""
LIVE_SQLITE_PREBUILD_PATH=""
LIVE_SQLITE_PREBUILD_DIR=""
LIVE_SQLITE_PREBUILD_DIR_DEVICE=""
LIVE_SQLITE_PREBUILD_DIR_INODE=""
LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST=""
LIVE_SQLITE_PREBUILD_STAGE_MANIFEST=""
LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL=""
LIVE_SQLITE_PREBUILD_ROLLBACK_DIR=""
LIVE_SQLITE_PREBUILD_ROLLBACK_PATH=""
LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL=""
LIVE_SQLITE_PREBUILD_READY=0
LIVE_SQLITE_PREBUILD_ACTIVATED=0
LIVE_SQLITE_PREBUILD_ADOPTED=0
CANDIDATE_CAPTURE_HEARTBEAT_REFRESH_SUCCESS_EPOCH_SECONDS=""
TRANSIENT_COUNTER=0
NEXT_TRANSIENT_UNIT=""

PUBLIC_DATA_CACHE_FILES=(
  sync-meta.json
  matches-current.json
  matches-history.json
  odds-history.json
  prediction-snapshots.json
  post-match-reviews.json
  external-signals.json
  five-hundred-details.json
  pre-match-signals.json
  web-consensus-signals.json
  team-index.json
  model-calibration.json
  model-evaluation.json
  model-strategy.json
  gpt-predictions.json
)
PUBLIC_ROOT_CACHE_FILES=(matches.json odds-history.json)
MANAGED_CONFIG_PATHS=(
  /etc/systemd/system/football-predict.service
  /etc/systemd/system/football-sync-worker.service
  /etc/systemd/system/football-cleanup.service
  /etc/systemd/system/football-cleanup.timer
  /etc/systemd/system/football-monitor.service
  /etc/systemd/system/football-monitor.timer
  /etc/nginx/conf.d/football-predict-common.conf
  /etc/nginx/snippets/football-predict-server.conf
  /etc/nginx/snippets/football-predict-security-headers.conf
  /etc/nginx/sites-available/football-predict
  /etc/nginx/sites-enabled/football-predict
)
MANAGED_TIMERS=(football-cleanup.timer football-monitor.timer)
MANAGED_STATE_UNITS=(football-predict.service football-sync-worker.service nginx.service)
MODEL_ARTIFACT_TOKENS=(strategy evaluation candidate-registry candidate-challenger-suite candidate-temperature-suite candidate-common-cohort-g2-v1 candidate-common-cohort-g2-v2 candidate-capture-status benchmark-prospective-ledger)
MODEL_ARTIFACT_PATHS=(
  /var/lib/football-predict/model-strategy.json
  /var/lib/football-predict/model-artifacts/evaluation.json
  /var/lib/football-predict/model-artifacts/candidate-prospective-registry.json
  /var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json
  /var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json
  /var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json
  /var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json
  /var/lib/football-predict/candidate-prospective-capture-status.json
  /var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json
)

log() {
  printf '[football-bundle-release] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_build_user() {
  if id "$BUILD_USER" >/dev/null 2>&1; then
    return 0
  fi
  useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
}

assert_build_user_quiescent() {
  if pgrep -u "$BUILD_USER" >/dev/null 2>&1; then
    printf 'persistent build user has an out-of-band process; refusing release: %s\n' "$BUILD_USER" >&2
    pgrep -a -u "$BUILD_USER" >&2 || true
    return 1
  fi
}

next_transient_unit() {
  local label="${1//[^a-zA-Z0-9_-]/-}"
  TRANSIENT_COUNTER=$((TRANSIENT_COUNTER + 1))
  NEXT_TRANSIENT_UNIT="football-release-${BUNDLE_SHA256:0:12}-${label}-${TRANSIENT_COUNTER}.service"
}

assert_transient_unit_cleared() {
  local unit="$1"
  local attempt active_state control_group
  for attempt in $(seq 1 50); do
    active_state="$(systemctl show "$unit" --property=ActiveState --value 2>/dev/null || true)"
    control_group="$(systemctl show "$unit" --property=ControlGroup --value 2>/dev/null || true)"
    if [ -n "$control_group" ] && [ -r "/sys/fs/cgroup${control_group}/cgroup.procs" ] \
      && [ -s "/sys/fs/cgroup${control_group}/cgroup.procs" ]; then
      sleep 0.1
      continue
    fi
    case "$active_state" in
      ""|inactive|failed)
        systemctl reset-failed "$unit" >/dev/null 2>&1 || true
        log "confirmed transient cgroup empty: ${unit}"
        return 0
        ;;
    esac
    sleep 0.1
  done
  printf 'transient unit did not clear: %s (state=%s cgroup=%s)\n' \
    "$unit" "${active_state:-unknown}" "${control_group:-unknown}" >&2
  return 1
}

transient_build_properties() {
  printf '%s\n' \
    "--property=UMask=0077" \
    "--property=NoNewPrivileges=yes" \
    "--property=ProtectSystem=strict" \
    "--property=ProtectHome=yes" \
    "--property=PrivateTmp=yes" \
    "--property=PrivateDevices=yes" \
    "--property=ProtectKernelTunables=yes" \
    "--property=ProtectKernelModules=yes" \
    "--property=ProtectKernelLogs=yes" \
    "--property=ProtectControlGroups=yes" \
    "--property=ProtectClock=yes" \
    "--property=ProtectHostname=yes" \
    "--property=LockPersonality=yes" \
    "--property=RestrictRealtime=yes" \
    "--property=RestrictSUIDSGID=yes" \
    "--property=RestrictNamespaces=yes" \
    "--property=SystemCallArchitectures=native" \
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    "--property=CapabilityBoundingSet=" \
    "--property=AmbientCapabilities=" \
    "--property=KillMode=control-group" \
    "--property=TimeoutStopSec=15s"
}

run_build_step() {
  local label="$1"
  shift
  local unit rc
  local -a properties=()
  next_transient_unit "$label"
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties)
  set +e
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
    --unit="$unit" --uid="$BUILD_USER" --working-directory="$BUILD_DIR" \
    "${properties[@]}" \
    --property="ReadWritePaths=$BUILD_DIR" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release" \
    -- "$@"
  rc="$?"
  set -e
  assert_transient_unit_cleared "$unit" || return 1
  return "$rc"
}

run_candidate_refresh_step() {
  local label="$1"
  shift
  local unit rc
  local -a properties=()
  next_transient_unit "$label"
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties)
  set +e
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
    --unit="$unit" --uid="$BUILD_USER" --working-directory="$NEXT_DIR" \
    "${properties[@]}" \
    --property="ReadWritePaths=$NEXT_DIR/public/data $CANDIDATE_STORE_DIR" \
    --property="ReadOnlyPaths=$BUILD_DIR/.release-archive-evidence" \
    --property="RuntimeMaxSec=${CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS}s" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release" \
    -- "$@"
  rc="$?"
  set -e
  assert_transient_unit_cleared "$unit" || return 1
  return "$rc"
}

run_live_sqlite_prebuild_step() {
  local label="$1"
  shift
  local unit rc
  local -a properties=()
  next_transient_unit "$label"
  unit="$NEXT_TRANSIENT_UNIT"
  # This helper deliberately runs as root so the SQLite projection never has
  # to live in a directory writable by the long-running `football` UID.  Keep
  # read/search plus the narrowly needed DAC override capability: the source
  # generation lock lives in football-owned 0700 data-generations, while this
  # root prebuild remains sandbox-writable only for that one path and its
  # private staging directory. Every heavy copy/hash/check
  # remains inside this low-priority, memory-bounded cgroup.
  mapfile -t properties < <(transient_build_properties \
    | grep -v -- '--property=CapabilityBoundingSet=' \
    | grep -v -- '--property=AmbientCapabilities=')
  set +e
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
    --unit="$unit" --uid=root --working-directory="$NEXT_DIR" \
    "${properties[@]}" \
    --property="ReadOnlyPaths=$NEXT_DIR $RUNTIME_ENV_FILE /var/lib/football-release $LIVE_STORE_DIR" \
    --property="ReadWritePaths=$LIVE_SQLITE_PREBUILD_DIR $LIVE_STORE_DIR/data-generations" \
    --property="InaccessiblePaths=-/etc/football-release" \
    --property="CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE" \
    --property="AmbientCapabilities=" \
    --property="Nice=10" \
    --property="IOSchedulingClass=best-effort" \
    --property="IOSchedulingPriority=4" \
    --property="IOWeight=50" \
    --property="MemoryHigh=768M" \
    --property="MemoryMax=1024M" \
    --property="MemorySwapMax=256M" \
    --property="OOMPolicy=stop" \
    --property="RuntimeMaxSec=${LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS}s" \
    -- /bin/bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' bash "$RUNTIME_ENV_FILE" "$@"
  rc="$?"
  set -e
  assert_transient_unit_cleared "$unit" || return 1
  return "$rc"
}

start_candidate_unit() {
  local working_directory="$1"
  shift
  local unit
  local -a properties=()
  next_transient_unit candidate-server
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties)
  systemd-run --quiet --collect --service-type=exec \
    --unit="$unit" --uid="$BUILD_USER" --working-directory="$working_directory" \
    "${properties[@]}" \
    --property="ReadWritePaths=$BUILD_DIR" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release" \
    -- "$@"
  CANDIDATE_UNIT="$unit"
  local attempt
  for attempt in $(seq 1 50); do
    systemctl is-active --quiet "$CANDIDATE_UNIT" && return 0
    systemctl is-failed --quiet "$CANDIDATE_UNIT" && break
    sleep 0.1
  done
  journalctl -u "$CANDIDATE_UNIT" --no-pager -n 80 >&2 || true
  stop_candidate || return 1
  return 1
}

run_trusted_candidate_verifier() {
  local unit rc
  local -a properties=()
  next_transient_unit candidate-verifier
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties)
  set +e
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
    --unit="$unit" --uid="$BUILD_USER" --working-directory="$NEXT_DIR" \
    "${properties[@]}" \
    --property="ReadOnlyPaths=$NEXT_DIR" \
    --property="ReadWritePaths=$BUILD_DIR" \
    --property="RuntimeMaxSec=${CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS}s" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-predict -/var/lib/football-release" \
    -- "$@"
  rc="$?"
  set -e
  assert_transient_unit_cleared "$unit" || return 1
  return "$rc"
}

run_as_service_user() {
  runuser -u football -- "$@"
}

run_as_service_user_with_runtime_env() {
  runuser -u football -- bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' bash "$RUNTIME_ENV_FILE" "$@"
}

release_fast_watcher_pause_paths() {
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || {
    printf 'release fast watcher pause received an unsafe service name: %s\n' "$SERVICE_NAME" >&2
    return 1
  }
  RELEASE_FAST_WATCHER_PAUSE_ENV_FILE="/run/football-release-fast-watcher-pause.env"
  RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR="/run/systemd/system/${SERVICE_NAME}.service.d"
  RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE="${RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR}/90-release-fast-watcher-pause.conf"
}

remove_release_fast_watcher_pause_override() {
  release_fast_watcher_pause_paths || return 1
  local changed=0
  for target in "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP"; do
    [ -n "$target" ] || continue
    case "$target" in
      "${RELEASE_FAST_WATCHER_PAUSE_ENV_FILE}.install."*|"${RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE}.install."*) ;;
      *) printf 'release fast watcher pause temp path is unsafe: %s\n' "$target" >&2; return 1 ;;
    esac
    if [ -e "$target" ] || [ -L "$target" ]; then
      [ -f "$target" ] && [ ! -L "$target" ] || return 1
      rm -f -- "$target" || return 1
      changed=1
    fi
  done
  RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP=""
  RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP=""
  for target in "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      [ -f "$target" ] && [ ! -L "$target" ] || {
        printf 'release fast watcher pause path became unsafe: %s\n' "$target" >&2
        return 1
      }
      rm -f -- "$target" || return 1
      changed=1
    fi
  done
  if [ -d "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" ] \
    && [ -z "$(find "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    rmdir -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" || return 1
    changed=1
  fi
  if [ "$changed" = "1" ] || [ "$RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE" = "1" ]; then
    systemctl daemon-reload || return 1
  fi
  RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=0
}

write_release_fast_watcher_pause_override() {
  release_fast_watcher_pause_paths || return 1
  [[ "$RUNTIME_ENV_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
    printf 'release fast watcher pause received an unsafe runtime env path: %s\n' "$RUNTIME_ENV_FILE" >&2
    return 1
  }
  [ -f "$RUNTIME_ENV_FILE" ] && [ ! -L "$RUNTIME_ENV_FILE" ] || return 1
  [ ! -e "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" ] \
    && [ ! -e "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" ] || {
      printf 'release fast watcher pause refuses a pre-existing runtime override\n' >&2
      return 1
    }
  install -d -o root -g root -m 0755 -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" || return 1
  [ -d "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR")" = "root:root:755" ] \
    || return 1
  RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE=1
  RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP="${RELEASE_FAST_WATCHER_PAUSE_ENV_FILE}.install.$$"
  RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP="${RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE}.install.$$"
  [ ! -e "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" ] && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" ] \
    && [ ! -e "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" ] || return 1
  ( umask 077; printf 'RELAY_FAST_WATCHER_ENABLED=0\n' >"$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" ) || return 1
  chown root:football "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" || return 1
  chmod 0640 "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" || return 1
  sync -f "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" || return 1
  mv -fT -- "$RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP" "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" || return 1
  RELEASE_FAST_WATCHER_PAUSE_ENV_TEMP=""
  ( umask 077; cat >"$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" <<EOF
[Service]
EnvironmentFile=
EnvironmentFile=${RUNTIME_ENV_FILE}
EnvironmentFile=${RELEASE_FAST_WATCHER_PAUSE_ENV_FILE}
EOF
  ) || return 1
  chown root:root "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" || return 1
  chmod 0644 "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" || return 1
  sync -f "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" || return 1
  mv -fT -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP" "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" || return 1
  RELEASE_FAST_WATCHER_PAUSE_DROPIN_TEMP=""
  sync -f "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" || return 1
  sync -f "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" || return 1
  sync -f "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_DIR" || return 1
  [ "$(stat -c '%U:%G:%a:%h' -- "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE")" = "root:football:640:1" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE")" = "root:root:644:1" ] \
    || return 1
  systemctl daemon-reload || return 1
}

assert_release_fast_watcher_pause_override() {
  release_fast_watcher_pause_paths || return 1
  [ "$RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE" = "1" ] || return 1
  [ -f "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE")" = "root:football:640:1" ] \
    && [ "$(cat -- "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE")" = "RELAY_FAST_WATCHER_ENABLED=0" ] \
    || return 1
  [ -f "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" ] \
    && [ ! -L "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE")" = "root:root:644:1" ] \
    || return 1
  [ "$(cat -- "$RELEASE_FAST_WATCHER_PAUSE_DROPIN_FILE")" = "[Service]
EnvironmentFile=
EnvironmentFile=${RUNTIME_ENV_FILE}
EnvironmentFile=${RELEASE_FAST_WATCHER_PAUSE_ENV_FILE}" ] || return 1
  systemctl cat "$SERVICE_NAME" 2>/dev/null \
    | grep -Fq "EnvironmentFile=${RELEASE_FAST_WATCHER_PAUSE_ENV_FILE}" || return 1
}

assert_release_fast_watcher_process_state() {
  local expected="$1"
  local main_pid count
  [ "$expected" = "0" ] || [ "$expected" = "1" ] || return 1
  systemctl is-active --quiet "$SERVICE_NAME" || return 1
  main_pid="$(systemctl show "$SERVICE_NAME" --property=MainPID --value 2>/dev/null)" || return 1
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -r "/proc/${main_pid}/environ" ] || return 1
  count="$(tr '\0' '\n' <"/proc/${main_pid}/environ" \
    | grep -Fxc "RELAY_FAST_WATCHER_ENABLED=${expected}" || true)"
  [ "$count" = "1" ] || {
    printf 'release fast watcher process state mismatch: expected=%s count=%s pid=%s\n' \
      "$expected" "$count" "$main_pid" >&2
    return 1
  }
}

assert_release_fast_watcher_health_state() {
  local expected="$1"
  [ "$expected" = "0" ] || [ "$expected" = "1" ] || return 1
  "$NODE_HOME/bin/node" - "$HOST" "$PORT" "$expected" <<'NODE'
const http = require("node:http");
const [host, port, expectedText] = process.argv.slice(2);
const expected = expectedText === "1";
const request = http.get({ host, port: Number(port), path: "/api/v1/health", timeout: 10_000 }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    try {
      const payload = JSON.parse(body);
      if (response.statusCode !== 200 || payload?.sync?.fastResultWatcher?.enabled !== expected) process.exit(1);
    } catch {
      process.exit(1);
    }
  });
});
request.on("timeout", () => request.destroy(new Error("health timeout")));
request.on("error", () => process.exit(1));
NODE
}

assert_release_fast_watcher_pause_guard() {
  assert_release_fast_watcher_pause_override || return 1
  assert_release_fast_watcher_process_state 0 || return 1
  assert_release_fast_watcher_health_state 0 || return 1
}

wait_for_current_service_cgroup_reclaimed() {
  local control_group="$1"
  local expected_control_group="/system.slice/${SERVICE_NAME}.service"
  local cgroup_dir active_state populated memory_current attempt
  [ "$control_group" = "$expected_control_group" ] || {
    printf 'release fast watcher pause rejected unexpected service cgroup: %s\n' "$control_group" >&2
    return 1
  }
  cgroup_dir="/sys/fs/cgroup${control_group}"
  for attempt in $(seq 1 150); do
    active_state="$(systemctl show "$SERVICE_NAME" --property=ActiveState --value 2>/dev/null || true)"
    case "$active_state" in
      inactive|failed) ;;
      *) sleep 0.2; continue ;;
    esac
    if [ ! -e "$cgroup_dir" ]; then
      log "current service cgroup removed before watcher-disabled restart: ${control_group}"
      return 0
    fi
    if [ ! -d "$cgroup_dir" ] || [ -L "$cgroup_dir" ]; then
      # systemd may remove the empty cgroup between the first existence check
      # and this metadata check.  Absence is the successful drained state;
      # any object still present with the wrong type remains fail-closed.
      [ ! -e "$cgroup_dir" ] && [ ! -L "$cgroup_dir" ] && return 0
      return 1
    fi
    if [ ! -r "$cgroup_dir/cgroup.events" ] || [ ! -r "$cgroup_dir/memory.current" ]; then
      [ ! -e "$cgroup_dir" ] && return 0
      sleep 0.2
      continue
    fi
    populated="$(awk '$1 == "populated" { value = $2; count += 1 } END { if (count == 1) print value }' \
      "$cgroup_dir/cgroup.events")" || {
        [ ! -e "$cgroup_dir" ] && [ ! -L "$cgroup_dir" ] && return 0
        return 1
      }
    memory_current="$(cat -- "$cgroup_dir/memory.current")" || {
      [ ! -e "$cgroup_dir" ] && [ ! -L "$cgroup_dir" ] && return 0
      return 1
    }
    [[ "$populated" =~ ^[01]$ ]] && [[ "$memory_current" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
    if [ "$populated" = "0" ] && [ "$memory_current" = "0" ]; then
      log "current service cgroup drained before watcher-disabled restart: ${control_group}"
      return 0
    fi
    sleep 0.2
  done
  printf 'release fast watcher pause timed out draining service cgroup: cgroup=%s activeState=%s populated=%s memoryCurrent=%s\n' \
    "$control_group" "${active_state:-unknown}" "${populated:-unknown}" "${memory_current:-unknown}" >&2
  return 1
}

pause_current_fast_watcher_for_live_prebuild() {
  local old_control_group
  systemctl is-active --quiet "$SERVICE_NAME" || return 1
  [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || {
    printf 'release fast watcher pause requires the sync worker to be stopped first\n' >&2
    return 1
  }
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 \
    && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
    printf 'release fast watcher pause refuses an active sync worker\n' >&2
    return 1
  fi
  for unit in "${MANAGED_TIMERS[@]}" football-cleanup.service football-monitor.service; do
    systemctl is-active --quiet "$unit" && {
      printf 'release fast watcher pause requires quiescent maintenance: %s\n' "$unit" >&2
      return 1
    }
  done
  old_control_group="$(systemctl show "$SERVICE_NAME" --property=ControlGroup --value 2>/dev/null)" \
    || return 1
  [ "$old_control_group" = "/system.slice/${SERVICE_NAME}.service" ] || {
    printf 'release fast watcher pause could not prove the current service cgroup: %s\n' "$old_control_group" >&2
    return 1
  }
  write_release_fast_watcher_pause_override || return 1
  RELEASE_FAST_WATCHER_PAUSED_PROCESS=1
  systemctl stop "$SERVICE_NAME" || return 1
  systemctl is-active --quiet "$SERVICE_NAME" && return 1
  wait_for_current_service_cgroup_reclaimed "$old_control_group" || return 1
  systemctl start "$SERVICE_NAME" || return 1
  wait_for_health "http://${HOST}:${PORT}" "release-fast-watcher-paused" 120 2 service || return 1
  assert_release_fast_watcher_pause_guard || return 1
  # Keep the root-owned override installed for the whole live-prebuild window.
  # Restart=always may replace the old process at any point; every replacement
  # must therefore inherit watcher=0 until systemctl stop has completed.
  log "current service cgroup recycled with the fast watcher paused for the guarded live SQLite prebuild window"
}

restore_release_fast_watcher_after_failed_pre_swap() {
  local restore_required=0
  if [ "$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1" ] \
    || [ "$RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE" = "1" ]; then
    restore_required=1
    RELEASE_FAST_WATCHER_PAUSED_PROCESS=1
  fi
  remove_release_fast_watcher_pause_override || return 1
  if [ "$restore_required" = "1" ]; then
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      systemctl restart "$SERVICE_NAME" || return 1
    else
      systemctl start "$SERVICE_NAME" || return 1
    fi
    wait_for_health "http://${HOST}:${PORT}" "release-fast-watcher-restored" 120 2 service || return 1
    assert_release_fast_watcher_process_state 1 || return 1
    assert_release_fast_watcher_health_state 1 || return 1
  fi
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    RELEASE_FAST_WATCHER_PAUSED_PROCESS=0
  fi
}

assert_live_sqlite_prebuild_capacity() {
  local app_control_group app_cgroup_dir app_memory_current app_memory_current_before
  local app_memory_current_after app_inactive_file capacity_output memory_sample sample_current
  local sample_inactive_file policy_script runtime_env_identity
  assert_release_fast_watcher_pause_guard || {
    printf 'live SQLite prebuild capacity gate requires the guarded watcher pause\n' >&2
    return 1
  }
  [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || {
    printf 'live SQLite prebuild capacity gate requires the sync worker to be stopped\n' >&2
    return 1
  }
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 \
    && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
    printf 'live SQLite prebuild capacity gate refuses an active sync worker\n' >&2
    return 1
  fi
  systemctl is-active --quiet "$SERVICE_NAME" || {
    printf 'live SQLite prebuild capacity gate requires the current app service to be active\n' >&2
    return 1
  }
  [ -f "$RUNTIME_ENV_FILE" ] && [ ! -L "$RUNTIME_ENV_FILE" ] || {
    printf 'live SQLite prebuild capacity gate requires the restricted runtime env\n' >&2
    return 1
  }
  runtime_env_identity="$(stat -c '%U:%G:%a:%h' -- "$RUNTIME_ENV_FILE")" || return 1
  [ "$runtime_env_identity" = "root:football:640:1" ] || {
    printf 'live SQLite prebuild capacity gate rejected unsafe runtime env metadata: %s\n' "$runtime_env_identity" >&2
    return 1
  }
  app_control_group="$(systemctl show "$SERVICE_NAME" --property=ControlGroup --value 2>/dev/null)" \
    || return 1
  [ "$app_control_group" = "/system.slice/${SERVICE_NAME}.service" ] || {
    printf 'live SQLite prebuild capacity gate rejected unexpected app cgroup: %s\n' "$app_control_group" >&2
    return 1
  }
  app_cgroup_dir="/sys/fs/cgroup${app_control_group}"
  [ -d "$app_cgroup_dir" ] && [ ! -L "$app_cgroup_dir" ] \
    && [ -r "$app_cgroup_dir/memory.current" ] && [ -r "$app_cgroup_dir/memory.stat" ] || {
    printf 'live SQLite prebuild capacity gate cannot read the app cgroup memory evidence\n' >&2
    return 1
  }
  app_memory_current=""
  app_inactive_file=""
  for memory_sample in 1 2; do
    app_memory_current_before="$(cat -- "$app_cgroup_dir/memory.current")" || return 1
    sample_inactive_file="$(awk '$1 == "inactive_file" { value = $2; count += 1 } END { if (count == 1) print value }' \
      "$app_cgroup_dir/memory.stat")" || return 1
    app_memory_current_after="$(cat -- "$app_cgroup_dir/memory.current")" || return 1
    [[ "$app_memory_current_before" =~ ^(0|[1-9][0-9]*)$ ]] \
      && [[ "$app_memory_current_after" =~ ^(0|[1-9][0-9]*)$ ]] \
      && [[ "$sample_inactive_file" =~ ^(0|[1-9][0-9]*)$ ]] || {
      printf 'live SQLite prebuild capacity gate received invalid app cgroup memory evidence: sample=%s before=%s after=%s inactiveFile=%s\n' \
        "$memory_sample" "$app_memory_current_before" "$app_memory_current_after" "$sample_inactive_file" >&2
      return 1
    }
    if (( app_memory_current_before >= app_memory_current_after )); then
      sample_current="$app_memory_current_before"
    else
      sample_current="$app_memory_current_after"
    fi
    (( sample_inactive_file <= sample_current )) || {
      printf 'live SQLite prebuild capacity gate rejected inconsistent app cgroup memory evidence: sample=%s current=%s inactiveFile=%s\n' \
        "$memory_sample" "$sample_current" "$sample_inactive_file" >&2
      return 1
    }
    if [ -z "$app_memory_current" ] || (( sample_current > app_memory_current )); then
      app_memory_current="$sample_current"
    fi
    if [ -z "$app_inactive_file" ] || (( sample_inactive_file < app_inactive_file )); then
      app_inactive_file="$sample_inactive_file"
    fi
    [ "$memory_sample" = "2" ] || sleep 1
  done
  policy_script="$NEXT_DIR/scripts/releasePrebuildPolicy.cjs"
  [ -f "$policy_script" ] && [ ! -L "$policy_script" ] \
    && [ "$(stat -c '%h' -- "$policy_script")" = "1" ] || {
      printf 'live SQLite prebuild capacity policy is unavailable\n' >&2
      return 1
    }
  capacity_output="$(run_as_service_user_with_runtime_env \
    "$NODE_HOME/bin/node" "$policy_script" capacity \
      --app-memory-current-bytes "$app_memory_current" \
      --app-inactive-file-bytes "$app_inactive_file")" || return 1
  [ -n "$capacity_output" ] || {
    printf 'live SQLite prebuild capacity policy returned no evidence\n' >&2
    return 1
  }
  log "live SQLite prebuild capacity accepted: ${capacity_output}"
}

assert_recovery_root_safe() {
  local release_root="/var/lib/football-release"
  local release_root_mode
  [ -d "$release_root" ] && [ ! -L "$release_root" ] \
    || { printf 'release state root is missing or unsafe: %s\n' "$release_root" >&2; return 1; }
  [ "$(stat -c '%u:%g' -- "$release_root")" = "0:0" ] \
    || { printf 'release state root must be root:root: %s\n' "$release_root" >&2; return 1; }
  release_root_mode="$(stat -c '%a' -- "$release_root")" || return 1
  (( (8#$release_root_mode & 8#022) == 0 )) \
    || { printf 'release state root must not be group/other writable: %s mode=%s\n' "$release_root" "$release_root_mode" >&2; return 1; }
  [ -d "$RECOVERY_ROOT" ] && [ ! -L "$RECOVERY_ROOT" ] \
    || { printf 'release recovery root is missing or unsafe: %s\n' "$RECOVERY_ROOT" >&2; return 1; }
  [ "$(stat -c '%u:%g:%a' -- "$RECOVERY_ROOT")" = "0:0:700" ] \
    || { printf 'release recovery root must be root:root 0700: %s\n' "$RECOVERY_ROOT" >&2; return 1; }
}

is_managed_config_path() {
  local candidate="$1"
  local expected
  for expected in "${MANAGED_CONFIG_PATHS[@]}"; do
    [ "$candidate" = "$expected" ] && return 0
  done
  return 1
}

snapshot_runtime_env_for_rollback() {
  local transaction_dir="$1"
  local snapshot_dir="${transaction_dir}/runtime-env"
  local parent_state="absent"
  local present=0 bytes="-" digest="-" uid="-" gid="-" mode="-"
  local env_parent
  env_parent="$(dirname "$RUNTIME_ENV_FILE")"
  install -d -o root -g root -m 0700 -- "$snapshot_dir" || return 1
  if [ -d "$env_parent" ] && [ ! -L "$env_parent" ]; then
    parent_state="present"
    stat -c '%u %g %a' -- "$env_parent" >"${snapshot_dir}/parent-metadata" || return 1
  elif [ -e "$env_parent" ] || [ -L "$env_parent" ]; then
    printf 'runtime env parent is not a real directory: %s\n' "$env_parent" >&2
    return 1
  fi
  if [ -e "$RUNTIME_ENV_FILE" ] || [ -L "$RUNTIME_ENV_FILE" ]; then
    if [ ! -f "$RUNTIME_ENV_FILE" ] || [ -L "$RUNTIME_ENV_FILE" ] \
      || [ "$(stat -c '%h' -- "$RUNTIME_ENV_FILE")" != "1" ]; then
      printf 'runtime env must be an unlinked regular file before release: %s\n' "$RUNTIME_ENV_FILE" >&2
      return 1
    fi
    present=1
    bytes="$(stat -c '%s' -- "$RUNTIME_ENV_FILE")"
    digest="$(sha256sum "$RUNTIME_ENV_FILE" | awk '{print $1}')"
    uid="$(stat -c '%u' -- "$RUNTIME_ENV_FILE")"
    gid="$(stat -c '%g' -- "$RUNTIME_ENV_FILE")"
    mode="$(stat -c '%a' -- "$RUNTIME_ENV_FILE")"
    cp -a --no-dereference -- "$RUNTIME_ENV_FILE" "${snapshot_dir}/env" || return 1
    chown root:root "${snapshot_dir}/env" || return 1
    chmod 0600 "${snapshot_dir}/env" || return 1
    [ "$(stat -c '%s' -- "${snapshot_dir}/env")" = "$bytes" ] || return 1
    [ "$(sha256sum "${snapshot_dir}/env" | awk '{print $1}')" = "$digest" ] || return 1
    sync -f "${snapshot_dir}/env" || return 1
  fi
  printf 'env\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$RUNTIME_ENV_FILE" "$present" "$bytes" "$digest" "$uid" "$gid" "$mode" >"${snapshot_dir}/manifest.tsv"
  printf '%s\n' "$parent_state" >"${snapshot_dir}/parent-state"
  chown root:root "${snapshot_dir}/manifest.tsv" "${snapshot_dir}/parent-state"
  chmod 0600 "${snapshot_dir}/manifest.tsv" "${snapshot_dir}/parent-state"
  if [ -f "${snapshot_dir}/parent-metadata" ]; then
    chown root:root "${snapshot_dir}/parent-metadata"
    chmod 0600 "${snapshot_dir}/parent-metadata"
    sync -f "${snapshot_dir}/parent-metadata"
  fi
  sync -f "${snapshot_dir}/manifest.tsv"
  sync -f "${snapshot_dir}/parent-state"
  sync -f "$snapshot_dir"
}

snapshot_managed_config_for_rollback() {
  local transaction_dir="$1"
  local snapshot_dir="${transaction_dir}/managed-config"
  local entries_dir="${snapshot_dir}/entries"
  local manifest="${snapshot_dir}/manifest.tsv"
  local timer_state="${snapshot_dir}/timers.tsv"
  local unit_state="${snapshot_dir}/units.tsv"
  local index=0 path type timer unit enabled active bytes digest link_target
  # GNU install only guarantees the requested mode on the final path. Create
  # the parent explicitly so the cold-recovery validator never sees a 0755
  # intermediate directory after a failed release.
  install -d -o root -g root -m 0700 -- "$snapshot_dir" || return 1
  install -d -o root -g root -m 0700 -- "$entries_dir" || return 1
  : >"$manifest"
  : >"$timer_state"
  : >"$unit_state"
  chown root:root "$manifest" "$timer_state" "$unit_state"
  chmod 0600 "$manifest" "$timer_state" "$unit_state"
  for path in "${MANAGED_CONFIG_PATHS[@]}"; do
    index=$((index + 1))
    type="absent"
    bytes="-"
    digest="-"
    if [ -L "$path" ]; then
      type="symlink"
      link_target="$(readlink -- "$path")" || return 1
      [[ "$link_target" != *$'\n'* && "$link_target" != *$'\r'* ]] || return 1
      ln -s -- "$link_target" "${entries_dir}/${index}" || return 1
      bytes="$(printf '%s' "$link_target" | wc -c | tr -d '[:space:]')"
      digest="$(printf '%s' "$link_target" | sha256sum | awk '{print $1}')"
    elif [ -e "$path" ]; then
      if [ ! -f "$path" ] || [ "$(stat -c '%h' -- "$path")" != "1" ]; then
        printf 'managed config is not a single-link regular file or symlink: %s\n' "$path" >&2
        return 1
      fi
      [ "$(stat -c '%u:%g:%a' -- "$path")" = "0:0:644" ] \
        || { printf 'managed config file is not root:root 0644: %s\n' "$path" >&2; return 1; }
      type="file"
      cp -a --no-dereference -- "$path" "${entries_dir}/${index}" || return 1
      bytes="$(stat -c '%s' -- "${entries_dir}/${index}")"
      digest="$(sha256sum "${entries_dir}/${index}" | awk '{print $1}')"
      chown root:root "${entries_dir}/${index}" || return 1
      chmod 0600 "${entries_dir}/${index}" || return 1
      sync -f "${entries_dir}/${index}" || return 1
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$index" "$type" "$path" "$bytes" "$digest" >>"$manifest"
  done
  for timer in "${MANAGED_TIMERS[@]}"; do
    enabled=0
    active=0
    systemctl is-enabled --quiet "$timer" >/dev/null 2>&1 && enabled=1
    systemctl is-active --quiet "$timer" >/dev/null 2>&1 && active=1
    printf '%s\t%s\t%s\n' "$timer" "$enabled" "$active" >>"$timer_state"
  done
  for unit in "${MANAGED_STATE_UNITS[@]}"; do
    enabled=0
    active=0
    systemctl is-enabled --quiet "$unit" >/dev/null 2>&1 && enabled=1
    systemctl is-active --quiet "$unit" >/dev/null 2>&1 && active=1
    printf '%s\t%s\t%s\n' "$unit" "$enabled" "$active" >>"$unit_state"
  done
  sync -f "$manifest"
  sync -f "$timer_state"
  sync -f "$unit_state"
  sync -f "$entries_dir"
  sync -f "$snapshot_dir"
}

ensure_app_tree_identity_marker() {
  local tree_path="$1"
  local marker_path="${tree_path}/.release-tree-identity"
  local marker_tmp="${marker_path}.next.$$.$RANDOM"
  [ -d "$tree_path" ] && [ ! -L "$tree_path" ] || return 1
  if [ -e "$marker_path" ] || [ -L "$marker_path" ]; then
    "$NODE_HOME/bin/node" - "$marker_path" <<'NODE'
const fs = require("node:fs");
const markerPath = process.argv[2];
const stat = fs.lstatSync(markerPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o600) {
  throw new Error("existing app tree identity marker is unsafe");
}
const value = fs.readFileSync(markerPath, "utf8").replace(/\n$/, "");
if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("existing app tree identity marker is invalid");
NODE
    return $?
  fi
  (umask 077; "$NODE_HOME/bin/node" - "$marker_tmp" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const markerPath = process.argv[2];
fs.writeFileSync(markerPath, `${crypto.randomBytes(32).toString("hex")}\n`, {
  flag: "wx",
  mode: 0o600
});
NODE
  ) || { rm -f -- "$marker_tmp"; return 1; }
  chown root:root "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  chmod 0600 "$marker_tmp" || { rm -f -- "$marker_tmp"; return 1; }
  if [ -e "$marker_path" ] || [ -L "$marker_path" ]; then
    rm -f -- "$marker_tmp"
    return 1
  fi
  mv -T -- "$marker_tmp" "$marker_path" || { rm -f -- "$marker_tmp"; return 1; }
  sync -f "$marker_path" || return 1
  sync -f "$tree_path" || return 1
}

snapshot_app_tree_identity() {
  local transaction_dir="$1"
  local name="$2"
  local tree_path="$3"
  local recorded_path="$4"
  local trees_dir="${transaction_dir}/trees"
  local output="${trees_dir}/${name}.json"
  [ -d "$tree_path" ] && [ ! -L "$tree_path" ] || return 1
  ensure_app_tree_identity_marker "$tree_path" || return 1
  ! mountpoint -q -- "$tree_path" || { printf 'managed app tree is a mountpoint: %s\n' "$tree_path" >&2; return 1; }
  [ "$(stat -c '%d' -- "$tree_path")" = "$(stat -c '%d' -- "$(dirname "$tree_path")")" ] \
    || { printf 'managed app tree crosses a filesystem boundary: %s\n' "$tree_path" >&2; return 1; }
  install -d -o root -g root -m 0700 -- "$trees_dir" || return 1
  node - "$tree_path" "$recorded_path" "$output" <<'NODE'
const fs = require("node:fs");
const [treePath, recordedPath, output] = process.argv.slice(2);
const stat = fs.lstatSync(treePath, { bigint: true });
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("app tree is not a real directory");
const readMarker = (name) => {
  const markerPath = `${treePath}/${name}`;
  let markerStat;
  try { markerStat = fs.lstatSync(markerPath); } catch (error) {
    if (error.code === "ENOENT") return "-";
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error(`unsafe app identity marker: ${name}`);
  }
  const value = fs.readFileSync(markerPath, "utf8").replace(/\n$/, "");
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid app identity marker: ${name}`);
  return value;
};
const identity = {
  path: recordedPath,
  dev: String(stat.dev),
  ino: String(stat.ino),
  uid: String(stat.uid),
  gid: String(stat.gid),
  mode: (Number(stat.mode & 0o7777n)).toString(8),
  treeMarker: readMarker(".release-tree-identity"),
  bundleMarker: readMarker(".release-bundle-sha256"),
  liveMarker: readMarker(".release-live-complete")
};
fs.writeFileSync(output, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
NODE
  chown root:root "$output" || return 1
  chmod 0600 "$output" || return 1
  sync -f "$output" || return 1
  sync -f "$trees_dir" || return 1
}

assert_safe_managed_tree() {
  local tree_path="$1"
  local label="$2"
  [ -d "$tree_path" ] && [ ! -L "$tree_path" ] \
    || { printf '%s is not a real directory: %s\n' "$label" "$tree_path" >&2; return 1; }
  ! mountpoint -q -- "$tree_path" \
    || { printf '%s is a mountpoint: %s\n' "$label" "$tree_path" >&2; return 1; }
  [ "$(stat -c '%d' -- "$tree_path")" = "$(stat -c '%d' -- "$(dirname "$tree_path")")" ] \
    || { printf '%s crosses a filesystem boundary: %s\n' "$label" "$tree_path" >&2; return 1; }
  [ "$(stat -c '%u' -- "$tree_path")" = "0" ] \
    || { printf '%s is not root-owned: %s\n' "$label" "$tree_path" >&2; return 1; }
}

prepare_managed_tree_topology_for_transaction() {
  assert_safe_managed_tree "$APP_DIR" "APP" || return 1
  if [ -e "$FAILED_DIR" ] || [ -L "$FAILED_DIR" ]; then
    printf 'FAILED must be absent before a new release transaction: %s\n' "$FAILED_DIR" >&2
    return 1
  fi
  local stale label
  for stale in "$BACKUP_DIR" "$NEXT_DIR"; do
    label="BACKUP"
    [ "$stale" = "$BACKUP_DIR" ] || label="NEXT"
    if [ -e "$stale" ] || [ -L "$stale" ]; then
      assert_safe_managed_tree "$stale" "$label" || return 1
      rm -rf --one-file-system -- "$stale" || return 1
      sync -f "$(dirname "$stale")" || return 1
    fi
    [ ! -e "$stale" ] && [ ! -L "$stale" ] || return 1
  done
}

initialize_release_recovery_snapshot() {
  assert_recovery_root_safe || return 1
  if [ -e "$RECOVERY_DIR" ] || [ -L "$RECOVERY_DIR" ]; then
    printf 'an unresolved release recovery transaction already exists: %s\n' "$RECOVERY_DIR" >&2
    return 1
  fi
  RECOVERY_STAGING_DIR="$(mktemp -d "${RECOVERY_ROOT}/.current.${BUNDLE_SHA256:0:12}.XXXXXX")" || return 1
  chown root:root "$RECOVERY_STAGING_DIR"
  chmod 0700 "$RECOVERY_STAGING_DIR"
  printf '%s\n' "$TRANSACTION_VERSION" >"${RECOVERY_STAGING_DIR}/transaction-version"
  printf '%s\n' "$BUNDLE_SHA256" >"${RECOVERY_STAGING_DIR}/bundle-sha256"
  printf '%s\n' "$RELEASE_SITE" >"${RECOVERY_STAGING_DIR}/site"
  printf '%s\n' "$RELEASE_CHANNEL" >"${RECOVERY_STAGING_DIR}/channel"
  printf '%s\n' "$RELEASE_SEQUENCE" >"${RECOVERY_STAGING_DIR}/release-sequence"
  printf 'prepared\n' >"${RECOVERY_STAGING_DIR}/phase"
  chown root:root "${RECOVERY_STAGING_DIR}/transaction-version" "${RECOVERY_STAGING_DIR}/bundle-sha256" \
    "${RECOVERY_STAGING_DIR}/site" "${RECOVERY_STAGING_DIR}/channel" \
    "${RECOVERY_STAGING_DIR}/release-sequence" "${RECOVERY_STAGING_DIR}/phase"
  chmod 0600 "${RECOVERY_STAGING_DIR}/transaction-version" "${RECOVERY_STAGING_DIR}/bundle-sha256" \
    "${RECOVERY_STAGING_DIR}/site" "${RECOVERY_STAGING_DIR}/channel" \
    "${RECOVERY_STAGING_DIR}/release-sequence" "${RECOVERY_STAGING_DIR}/phase"
  snapshot_app_tree_identity "$RECOVERY_STAGING_DIR" "old-app" "$APP_DIR" "/opt/football-predict" || return 1
  snapshot_runtime_env_for_rollback "$RECOVERY_STAGING_DIR" || return 1
  snapshot_managed_config_for_rollback "$RECOVERY_STAGING_DIR" || return 1
  sync -f "${RECOVERY_STAGING_DIR}/transaction-version"
  sync -f "${RECOVERY_STAGING_DIR}/bundle-sha256"
  sync -f "${RECOVERY_STAGING_DIR}/site"
  sync -f "${RECOVERY_STAGING_DIR}/channel"
  sync -f "${RECOVERY_STAGING_DIR}/release-sequence"
  sync -f "${RECOVERY_STAGING_DIR}/phase"
  sync -f "$RECOVERY_STAGING_DIR"
  mv -T -- "$RECOVERY_STAGING_DIR" "$RECOVERY_DIR" || return 1
  RECOVERY_STAGING_DIR=""
  sync -f "$RECOVERY_ROOT"
  RECOVERY_ACTIVE=1
}

write_recovery_phase() {
  local phase="$1"
  [ "$RECOVERY_ACTIVE" = "1" ] && [ -d "$RECOVERY_DIR" ] && [ ! -L "$RECOVERY_DIR" ] || return 1
  local temporary
  temporary="$(mktemp "${RECOVERY_DIR}/.phase.XXXXXX")" || return 1
  printf '%s\n' "$phase" >"$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "${RECOVERY_DIR}/phase"
  sync -f "$RECOVERY_DIR"
}

commit_release_transaction() {
  TRANSACTION_FINALIZING=1
  write_recovery_phase "finalizing" || return 1
  write_recovery_phase "committed" || return 1
  TRANSACTION_COMMITTED=1
  SWAP_STARTED=0
  TRANSACTION_FINALIZING=0
}

restore_runtime_env_after_rollback() {
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  local snapshot_dir="${RECOVERY_DIR}/runtime-env"
  local manifest="${snapshot_dir}/manifest.tsv"
  local token target present bytes digest uid gid mode extra
  local parent_state env_parent temporary parent_uid parent_gid parent_mode actual_bytes actual_digest
  [ "$(stat -c '%u:%g:%a:%h' -- "$manifest")" = "0:0:600:1" ] || return 1
  [ "$(wc -l <"$manifest" | tr -d '[:space:]')" = "1" ] || return 1
  IFS=$'\t' read -r token target present bytes digest uid gid mode extra <"$manifest" || return 1
  [ "$token" = "env" ] && [ "$target" = "/etc/football-predict/env" ] && [ -z "${extra:-}" ] || return 1
  parent_state="$(head -n 1 "${snapshot_dir}/parent-state")" || return 1
  env_parent="$(dirname "$RUNTIME_ENV_FILE")"
  case "$present" in
    1)
      [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ \
        && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      [ -f "${snapshot_dir}/env" ] && [ ! -L "${snapshot_dir}/env" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "${snapshot_dir}/env")" = "0:0:600:1" ] || return 1
      actual_bytes="$(stat -c '%s' -- "${snapshot_dir}/env")"
      actual_digest="$(sha256sum "${snapshot_dir}/env" | awk '{print $1}')"
      [ "$actual_bytes" = "$bytes" ] && [ "$actual_digest" = "$digest" ] || return 1
      [ "$parent_state" = "present" ] && [ -d "$env_parent" ] && [ ! -L "$env_parent" ] || return 1
      temporary="$(mktemp "${env_parent}/.env.rollback.XXXXXX")" || return 1
      rm -f -- "$temporary"
      cp --no-preserve=ownership,mode,timestamps --no-dereference -- "${snapshot_dir}/env" "$temporary" || return 1
      chown "$uid:$gid" "$temporary" || return 1
      chmod "$mode" "$temporary" || return 1
      [ "$(stat -c '%s' -- "$temporary")" = "$bytes" ] \
        && [ "$(sha256sum "$temporary" | awk '{print $1}')" = "$digest" ] || return 1
      sync -f "$temporary"
      mv -fT -- "$temporary" "$RUNTIME_ENV_FILE" || return 1
      sync -f "$env_parent"
      ;;
    0)
      [ "$bytes" = "-" ] && [ "$digest" = "-" ] && [ "$uid" = "-" ] \
        && [ "$gid" = "-" ] && [ "$mode" = "-" ] || return 1
      [ ! -e "${snapshot_dir}/env" ] && [ ! -L "${snapshot_dir}/env" ] || return 1
      if [ -d "$RUNTIME_ENV_FILE" ]; then
        printf 'refusing to replace a directory while restoring absent runtime env\n' >&2
        return 1
      fi
      rm -f -- "$RUNTIME_ENV_FILE" || return 1
      if [ "$parent_state" = "absent" ]; then
        rmdir -- "$env_parent" 2>/dev/null || {
          printf 'runtime env parent was originally absent but is not removable: %s\n' "$env_parent" >&2
          return 1
        }
      elif [ "$parent_state" != "present" ]; then
        return 1
      fi
      ;;
    *)
      printf 'runtime env recovery state is malformed: %s\n' "$present" >&2
      return 1
      ;;
  esac
  if [ "$parent_state" = "present" ]; then
    IFS=' ' read -r parent_uid parent_gid parent_mode <"${snapshot_dir}/parent-metadata" || return 1
    [[ "$parent_uid" =~ ^[0-9]+$ && "$parent_gid" =~ ^[0-9]+$ && "$parent_mode" =~ ^[0-7]{3,4}$ ]] || return 1
    chown "$parent_uid:$parent_gid" "$env_parent" || return 1
    chmod "$parent_mode" "$env_parent" || return 1
  fi
  RUNTIME_ENV_DIRTY=0
}

restore_managed_config_after_rollback() {
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  local snapshot_dir="${RECOVERY_DIR}/managed-config"
  local manifest="${snapshot_dir}/manifest.tsv"
  local index type path bytes digest extra source parent temporary actual_bytes actual_digest link_target expected_index=0 line_count=0
  [ "$(stat -c '%u:%g:%a:%h' -- "$manifest")" = "0:0:600:1" ] || return 1
  while IFS=$'\t' read -r index type path bytes digest extra; do
    [ -n "$index" ] && [ -z "${extra:-}" ] || return 1
    expected_index=$((expected_index + 1))
    [ "$index" = "$expected_index" ] && [ "$path" = "${MANAGED_CONFIG_PATHS[$((expected_index - 1))]}" ] || return 1
    is_managed_config_path "$path" || {
      printf 'recovery manifest contains an unmanaged path: %s\n' "$path" >&2
      return 1
    }
    source="${snapshot_dir}/entries/${index}"
    parent="$(dirname "$path")"
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    case "$type" in
      absent)
        [ "$bytes" = "-" ] && [ "$digest" = "-" ] || return 1
        [ ! -e "$source" ] && [ ! -L "$source" ] || return 1
        ;;
      file)
        [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
        [ -f "$source" ] && [ ! -L "$source" ] \
          && [ "$(stat -c '%u:%g:%a:%h' -- "$source")" = "0:0:600:1" ] || return 1
        actual_bytes="$(stat -c '%s' -- "$source")"
        actual_digest="$(sha256sum "$source" | awk '{print $1}')"
        [ "$actual_bytes" = "$bytes" ] && [ "$actual_digest" = "$digest" ] || return 1
        ;;
      symlink)
        [ -L "$source" ] || return 1
        [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
        link_target="$(readlink -- "$source")" || return 1
        actual_bytes="$(printf '%s' "$link_target" | wc -c | tr -d '[:space:]')"
        actual_digest="$(printf '%s' "$link_target" | sha256sum | awk '{print $1}')"
        [ "$actual_bytes" = "$bytes" ] && [ "$actual_digest" = "$digest" ] || return 1
        ;;
      *)
        printf 'managed config recovery type is malformed: %s\n' "$type" >&2
        return 1
        ;;
    esac
    line_count=$((line_count + 1))
  done <"$manifest"
  [ "$line_count" -eq "${#MANAGED_CONFIG_PATHS[@]}" ] || return 1

  while IFS=$'\t' read -r index type path bytes digest extra; do
    source="${snapshot_dir}/entries/${index}"
    parent="$(dirname "$path")"
    [ ! -d "$path" ] || { printf 'managed path became a directory: %s\n' "$path" >&2; return 1; }
    case "$type" in
      absent)
        rm -f -- "$path" || return 1
        ;;
      file)
        temporary="${parent}/.${path##*/}.rollback.$$.$index"
        rm -f -- "$temporary"
        cp --no-preserve=ownership,mode,timestamps --no-dereference -- "$source" "$temporary" || return 1
        chown root:root "$temporary" || return 1
        chmod 0644 "$temporary" || return 1
        sync -f "$temporary"
        mv -fT -- "$temporary" "$path" || return 1
        ;;
      symlink)
        temporary="${parent}/.${path##*/}.rollback.$$.$index"
        rm -f -- "$temporary"
        ln -s -- "$(readlink -- "$source")" "$temporary" || return 1
        mv -fT -- "$temporary" "$path" || return 1
        ;;
      *) return 1 ;;
    esac
    sync -f "$parent" || return 1
  done <"$manifest"
  sync -f /etc/systemd/system
  systemctl daemon-reload || return 1
  if command -v nginx >/dev/null 2>&1; then
    nginx -t || return 1
    if systemctl cat nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
      systemctl reload nginx || return 1
    elif ! systemctl cat nginx >/dev/null 2>&1; then
      nginx -s reload || return 1
    fi
  fi
  HOST_CONFIG_DIRTY=0
}

restore_managed_unit_states_after_rollback() {
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  local unit_state="${RECOVERY_DIR}/managed-config/units.tsv"
  local unit enabled active extra expected_index=0 line_count=0 actual_enabled actual_active
  local -A enabled_by_unit=() active_by_unit=()
  [ -f "$unit_state" ] && [ ! -L "$unit_state" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$unit_state")" = "0:0:600:1" ] || return 1
  while IFS=$'\t' read -r unit enabled active extra; do
    [ -n "$unit" ] && [ -z "${extra:-}" ] || return 1
    [ "$expected_index" -lt "${#MANAGED_STATE_UNITS[@]}" ] || return 1
    [ "$unit" = "${MANAGED_STATE_UNITS[$expected_index]}" ] || return 1
    [[ "$enabled" =~ ^[01]$ && "$active" =~ ^[01]$ ]] || return 1
    enabled_by_unit[$unit]="$enabled"
    active_by_unit[$unit]="$active"
    expected_index=$((expected_index + 1))
    line_count=$((line_count + 1))
  done <"$unit_state"
  [ "$line_count" -eq "${#MANAGED_STATE_UNITS[@]}" ] || return 1

  for unit in "${MANAGED_STATE_UNITS[@]}"; do
    if [ "${enabled_by_unit[$unit]}" = "1" ]; then
      systemctl enable "$unit" >/dev/null 2>&1 || return 1
    else
      systemctl disable "$unit" >/dev/null 2>&1 || true
    fi
  done

  # Restore the network front door first, then the original HTTP service.  Do
  # not resume the writer until the old HTTP process has passed its health gate.
  for unit in nginx.service football-predict.service; do
    if [ "${active_by_unit[$unit]}" = "1" ]; then
      systemctl start "$unit" >/dev/null 2>&1 || return 1
    else
      systemctl stop "$unit" >/dev/null 2>&1 || return 1
    fi
  done
  [ "${active_by_unit[football-predict.service]}" = "1" ] || {
    printf 'original application service was not active; refusing to clear recovery state\n' >&2
    return 1
  }
  wait_for_health "http://${HOST}:${PORT}" "pre-swap-restored-service" 120 2 service || return 1

  # Restore the exact app process before any writer or persistent timer is
  # resumed. A failed pause restart may have left an active watcher=0 process
  # even though the original unit and runtime files are already back on disk.
  if [ "$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1" ] \
    || [ "$RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE" = "1" ]; then
    restore_release_fast_watcher_after_failed_pre_swap || return 1
  fi

  unit="football-sync-worker.service"
  if [ "${active_by_unit[$unit]}" = "1" ]; then
    systemctl start "$unit" >/dev/null 2>&1 || return 1
  else
    systemctl stop "$unit" >/dev/null 2>&1 || return 1
  fi

  for unit in "${MANAGED_STATE_UNITS[@]}"; do
    actual_enabled=0
    actual_active=0
    systemctl is-enabled --quiet "$unit" >/dev/null 2>&1 && actual_enabled=1
    systemctl is-active --quiet "$unit" >/dev/null 2>&1 && actual_active=1
    [ "$actual_enabled" = "${enabled_by_unit[$unit]}" ] \
      && [ "$actual_active" = "${active_by_unit[$unit]}" ] || return 1
  done
  SERVICE_STOPPED_FOR_SWAP=0
  WORKER_STOPPED_FOR_SWAP=0
  WORKER_FROZEN_FOR_READINESS=0
  WORKER_FROZEN_MAIN_PID=""
}

restore_timer_states_after_rollback() {
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  local timer_state="${RECOVERY_DIR}/managed-config/timers.tsv"
  local timer enabled active actual_enabled actual_active
  [ -f "$timer_state" ] && [ ! -L "$timer_state" ] || return 1
  while IFS=$'\t' read -r timer enabled active; do
    case "$timer" in
      football-cleanup.timer|football-monitor.timer) ;;
      *) return 1 ;;
    esac
    if [ "$enabled" = "1" ]; then
      systemctl enable "$timer" >/dev/null 2>&1 || return 1
    elif [ "$enabled" = "0" ]; then
      systemctl disable "$timer" >/dev/null 2>&1 || true
    else
      return 1
    fi
    if [ "$active" = "1" ]; then
      systemctl start "$timer" >/dev/null 2>&1 || return 1
    elif [ "$active" = "0" ]; then
      systemctl stop "$timer" >/dev/null 2>&1 || true
    else
      return 1
    fi
    actual_enabled=0
    actual_active=0
    systemctl is-enabled --quiet "$timer" >/dev/null 2>&1 && actual_enabled=1
    systemctl is-active --quiet "$timer" >/dev/null 2>&1 && actual_active=1
    [ "$actual_enabled" = "$enabled" ] && [ "$actual_active" = "$active" ] || return 1
  done <"$timer_state"
  TIMER_STATE_DIRTY=0
}

clear_release_recovery_snapshot() {
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  [ "$RECOVERY_DIR" = "/var/lib/football-release/recovery/current" ] || return 1
  RECOVERY_RESOLVED_DIR="${RECOVERY_ROOT}/.resolved.${BUNDLE_SHA256:0:12}.$$.$RANDOM"
  [ ! -e "$RECOVERY_RESOLVED_DIR" ] && [ ! -L "$RECOVERY_RESOLVED_DIR" ] || return 1
  mv -T -- "$RECOVERY_DIR" "$RECOVERY_RESOLVED_DIR" || return 1
  RECOVERY_ACTIVE=0
  if ! sync -f "$RECOVERY_ROOT"; then
    log "warning: resolved recovery rename could not be fsynced; preserved at ${RECOVERY_RESOLVED_DIR}"
    return 0
  fi
  if ! rm -rf --one-file-system -- "$RECOVERY_RESOLVED_DIR"; then
    log "warning: resolved recovery snapshot could not be deleted: ${RECOVERY_RESOLVED_DIR}"
    return 0
  fi
  RECOVERY_RESOLVED_DIR=""
  sync -f "$RECOVERY_ROOT" || log "warning: resolved recovery deletion could not be fsynced"
}

restore_pre_swap_transaction() {
  local failed=0
  if [ "$RUNTIME_ENV_DIRTY" = "1" ]; then
    restore_runtime_env_after_rollback || failed=1
  fi
  if [ "$HOST_CONFIG_DIRTY" = "1" ]; then
    restore_managed_config_after_rollback || failed=1
  fi
  if [ "$RECOVERY_ACTIVE" = "1" ] && [ "$failed" -eq 0 ]; then
    restore_managed_unit_states_after_rollback || failed=1
  fi
  if { [ "$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1" ] \
      || [ "$RELEASE_FAST_WATCHER_PAUSE_OVERRIDE_ACTIVE" = "1" ]; } \
    && [ "$failed" -eq 0 ]; then
    restore_release_fast_watcher_after_failed_pre_swap || failed=1
  fi
  if [ "$TIMER_STATE_DIRTY" = "1" ] && [ "$failed" -eq 0 ]; then
    restore_timer_states_after_rollback || failed=1
  fi
  # Recovery evidence is deliberately the commit record for restoration.  It
  # is cleared only after the original unit states and service health succeed.
  if [ "$failed" -eq 0 ]; then
    clear_release_recovery_snapshot || failed=1
  fi
  return "$failed"
}

is_sensitive_release_path() {
  local normalized="${1#./}"
  normalized="${normalized%/}"
  normalized="${normalized,,}"
  local base_name="${normalized##*/}"

  if [ "$normalized" = "deploy/light-server/env" ] || [[ "$normalized" = */deploy/light-server/env ]]; then
    return 0
  fi
  case "$base_name" in
    .env|.env.*|.npmrc|.netrc|.pypirc|*.local|*.pem|*.key|*.p12|*.pfx|id_rsa|id_ed25519|credentials|credentials.json|secrets|secrets.json|.ssh|.aws|.azure|.docker)
      return 0
      ;;
  esac
  case "/${normalized}/" in
    */.ssh/*|*/.aws/*|*/.azure/*|*/.docker/*|*/.config/gcloud/*)
      return 0
      ;;
  esac
  return 1
}

assert_bundle_has_no_sensitive_entries() {
  local bundle_path="$1"
  local entries
  local entry
  if ! entries="$(tar -tzf "$bundle_path")"; then
    printf 'bundle contents could not be inspected: %s\n' "$bundle_path" >&2
    return 1
  fi
  while IFS= read -r entry; do
    if is_sensitive_release_path "$entry"; then
      printf 'bundle contains forbidden sensitive entry: %s\n' "${entry#./}" >&2
      return 1
    fi
  done <<< "$entries"
}

is_unsafe_production_secret() {
  local normalized="${1,,}"
  case "$normalized" in
    ""|replace-with-*|football-predict-local-access-secret|changeme|change-me)
      return 0
      ;;
  esac
  return 1
}

assert_safe_production_secrets() {
  if [ "${NODE_ENV:-}" != "production" ]; then
    return 0
  fi
  local resolved_access_admin="${ACCESS_CODE_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}"
  local resolved_access_secret="${ACCESS_CODE_SECRET:-${ACCESS_SESSION_SECRET:-${ADMIN_TOKEN:-}}}"
  local unsafe_names=()
  if is_unsafe_production_secret "$resolved_access_admin"; then
    unsafe_names+=("ACCESS_CODE_ADMIN_TOKEN")
  fi
  if is_unsafe_production_secret "$resolved_access_secret"; then
    unsafe_names+=("ACCESS_CODE_SECRET")
  fi
  if [ "${#unsafe_names[@]}" -gt 0 ]; then
    printf 'unsafe production access secrets: %s\n' "${unsafe_names[*]}" >&2
    return 1
  fi
}

assert_runtime_env_safe() (
  load_env "$RUNTIME_ENV_FILE"
  assert_safe_production_secrets
)

if [ -x "${NODE_HOME}/bin/node" ]; then
  export PATH="${NODE_HOME}/bin:${PATH}"
fi

ensure_node_runtime_env() {
  local env_file="$1"
  local runtime_path="${NODE_HOME}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  touch "$env_file"
  chown root:football "$env_file" >/dev/null 2>&1 || chown root:root "$env_file" >/dev/null 2>&1 || true
  chmod 0640 "$env_file"
  if grep -q '^NODE_HOME=' "$env_file"; then
    sed -i "s|^NODE_HOME=.*|NODE_HOME=${NODE_HOME}|" "$env_file"
  else
    printf '\nNODE_HOME=%s\n' "$NODE_HOME" >>"$env_file"
  fi
  if grep -q '^PATH=' "$env_file"; then
    sed -i "s|^PATH=.*|PATH=${runtime_path}|" "$env_file"
  else
    printf 'PATH=%s\n' "$runtime_path" >>"$env_file"
  fi
  set_env_value "$env_file" "SERVER_STORE_DIR" "/var/lib/football-predict"
  set_env_value "$env_file" "PRODUCTION_DATA_MODE" "server-primary"
  set_env_value "$env_file" "SERVER_DATA_PRIMARY" "1"
  set_env_value "$env_file" "LOCAL_DATA_PUSH_REQUIRED" "0"
  set_env_value "$env_file" "CLOUD_SYNC_REQUIRED" "0"
  set_env_value "$env_file" "SPORTTERY_RELAY_REQUIRED" "0"
  set_env_value "$env_file" "CURRENT_MATCH_SOURCE" "sqlite"
  set_env_value "$env_file" "DATASTORE_READ_SOURCE" "sqlite"
  set_env_value "$env_file" "DATASTORE_SQLITE_PATH" "/var/lib/football-predict/football.db"
  set_env_value "$env_file" "ENABLE_SQLITE_EXPORT" "1"
  set_env_value "$env_file" "ENABLE_SYNC_CRON" "0"
  set_env_value "$env_file" "ENABLE_GPT_CRON" "0"
  set_env_value "$env_file" "SYNC_INTERVAL_SECONDS" "300"
  set_env_value "$env_file" "HOT_SYNC_INTERVAL_SECONDS" "90"
  set_env_value "$env_file" "POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS" "300"
  set_env_value "$env_file" "HOT_SYNC_WINDOW_MINUTES" "120"
  set_env_value "$env_file" "CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES" "120"
  set_env_value "$env_file" "POST_KICKOFF_HOT_WINDOW_MINUTES" "180"
  set_env_value "$env_file" "SYNC_WORKER_MIN_IDLE_SECONDS" "10"
  set_env_value "$env_file" "SYNC_WORKER_EVENT_BRIDGE" "1"
  set_env_value "$env_file" "SYNC_WORKER_EVENT_POLL_MS" "1000"
  set_env_value "$env_file" "DATASTORE_COMPACT_ON_SYNC" "1"
  set_env_value "$env_file" "DATASTORE_COMPACT_INTERVAL_MINUTES" "60"
  set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"
  set_env_value "$env_file" "ODDS_HISTORY_RETENTION_DAYS" "14"
  set_env_value "$env_file" "ODDS_HISTORY_MAX_ROWS" "12000"
  set_env_value "$env_file" "ENABLE_OPEN_RESEARCH_SYNC" "1"
  set_env_value "$env_file" "ENABLE_WEB_CONSENSUS_SYNC" "1"
  set_env_value "$env_file" "WEB_CONSENSUS_REFRESH_MINUTES" "30"
  set_env_value "$env_file" "OPEN_RESEARCH_MAX_MATCHES" "4"
  set_env_value "$env_file" "OPEN_RESEARCH_MAX_RESULTS" "8"
  set_env_value "$env_file" "OPEN_RESEARCH_TIMEOUT_MS" "7000"
  set_env_value "$env_file" "OPEN_RESEARCH_CACHE_TTL_MINUTES" "30"
  set_env_value "$env_file" "OPEN_RESEARCH_REFRESH_MINUTES" "30"
  set_env_value "$env_file" "OPEN_RESEARCH_MAX_CONCURRENCY" "2"
  set_env_value "$env_file" "OPEN_RESEARCH_RATE_BURST" "3"
  set_env_value "$env_file" "OPEN_RESEARCH_RATE_REFILL_MS" "5000"
  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    set_env_value "$env_file" "OPEN_RESEARCH_CONTACT_URL" "$PUBLIC_BASE_URL"
  fi
  set_env_value "$env_file" "SQLITE_BUSY_TIMEOUT_MS" "60000"
  set_env_value "$env_file" "SQLITE_EXPORT_ATTEMPTS" "3"
  set_env_value "$env_file" "SQLITE_EXPORT_RETRY_DELAY_MS" "5000"
  set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MIN_MEM_AVAILABLE_MIB" "1152"
  set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_MEMORY_CURRENT_MIB" "640"
  set_env_value "$env_file" "RELEASE_LIVE_SQLITE_PREBUILD_MAX_APP_WORKING_SET_MIB" "512"
  set_env_value "$env_file" "ENABLE_MODEL_BACKTEST_ON_SYNC" "1"
  set_env_value "$env_file" "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES" "30"
  set_env_value "$env_file" "ENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE" "1"
  set_env_value "$env_file" "CANDIDATE_PROSPECTIVE_CAPTURE_INTERVAL_SECONDS" "30"
  set_env_value "$env_file" "CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS" "45000"
  set_env_value "$env_file" "MODEL_BACKTEST_SQLITE_ODDS_LIMIT" "120000"
  set_env_value "$env_file" "MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT" "50000"
  set_env_value "$env_file" "MODEL_BACKTEST_SNAPSHOTS_PER_MATCH" "6"
  set_env_value "$env_file" "MODEL_EVALUATION_SQLITE_COVERAGE_MIN" "0.95"
  set_env_value "$env_file" "MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO" "0.98"
  set_env_value "$env_file" "SPORTTERY_RELAY_MODE" "prefer"
  set_env_value "$env_file" "SPORTTERY_RELAY_SNAPSHOT" "/var/lib/football-predict/sporttery-relay-snapshot.json"
  set_env_value "$env_file" "SPORTTERY_RELAY_FAST_LANE_SNAPSHOT" "/var/lib/football-predict/sporttery-relay-fast-lane.json"
  set_env_value "$env_file" "SPORTTERY_RELAY_FAST_LANE_UPLOAD_MAX_BYTES" "8388608"
  set_env_value "$env_file" "RELAY_FAST_WATCHER_ENABLED" "1"
  set_env_value "$env_file" "RELAY_FAST_WATCHER_POLL_MS" "1000"
  set_env_value "$env_file" "RELAY_FAST_WATCHER_TIMEOUT_MS" "8000"
  set_env_value "$env_file" "TRUSTED_MAX_FUTURE_SKEW_SECONDS" "300"
  set_env_value "$env_file" "SYNC_META_COMMIT_LOCK_WAIT_MS" "30000"
  set_env_value "$env_file" "SYNC_META_COMMIT_LOCK_STALE_MS" "120000"
  set_env_value "$env_file" "RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER" "1"
  set_env_value "$env_file" "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS" "5000"
  set_env_value "$env_file" "RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS" "30"
  set_env_value "$env_file" "SPORTTERY_RELAY_MAX_AGE_MINUTES" "20"
  set_env_value "$env_file" "SOURCE_STRICT_PRIMARY_HEALTH" "0"
  set_env_value "$env_file" "SKIP_SPORTTERY_DIRECT_FETCH" "1"
  set_env_value "$env_file" "SPORTTERY_DIRECT_FETCH" "0"
  set_env_value "$env_file" "MIRROR_PUBLISHED_DATA_TO_DIST" "0"
  set_env_value "$env_file" "WRITE_LEGACY_STATIC_PAYLOADS" "0"
  if grep -Eq '^GPT_MODEL=(gpt-4o-mini|5\.5|gpt-5\.5)$' "$env_file"; then
    set_env_value "$env_file" "GPT_MODEL" ""
    log "disabled legacy implicit GPT model; configure an explicitly provisioned model ID to enable LLM risk review"
  fi
}

set_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

prepare_runtime_env() {
  local fallback_example="${1:-}"
  local legacy_env="${APP_DIR}/deploy/light-server/env"
  install -d -o root -g football -m 0750 "$(dirname "$RUNTIME_ENV_FILE")" || return 1
  if [ ! -f "$RUNTIME_ENV_FILE" ]; then
    if [ -f "$legacy_env" ]; then
      install -o root -g football -m 0640 "$legacy_env" "$RUNTIME_ENV_FILE" || return 1
    elif [ -n "$fallback_example" ] && [ -f "$fallback_example" ]; then
      install -o root -g football -m 0640 "$fallback_example" "$RUNTIME_ENV_FILE" || return 1
    else
      install -o root -g football -m 0640 /dev/null "$RUNTIME_ENV_FILE" || return 1
    fi
  fi
  ensure_node_runtime_env "$RUNTIME_ENV_FILE" || return 1
  chown root:football "$RUNTIME_ENV_FILE" || return 1
  chmod 0640 "$RUNTIME_ENV_FILE" || return 1
}

link_runtime_env() {
  local app_dir="$1"
  local legacy_env="${app_dir}/deploy/light-server/env"
  if [ ! -d "${app_dir}/deploy/light-server" ]; then
    return 0
  fi
  rm -f "$legacy_env" || return 1
  ln -s "$RUNTIME_ENV_FILE" "$legacy_env" || return 1
}

sync_model_artifact_mirrors() {
  local store_dir="$1"
  local app_dir="${2:-$PWD}"
  local mode="${3:-bidirectional}"
  local public_data_dir="${app_dir}/public/data"
  case "$mode" in
    bidirectional|store-only) ;;
    *) return 1 ;;
  esac
  mkdir -p "$store_dir" "${store_dir}/model-artifacts" || return 1
  mkdir -p "$public_data_dir" || return 1
  [ -d "$store_dir" ] && [ ! -L "$store_dir" ] \
    && [ -d "${store_dir}/model-artifacts" ] && [ ! -L "${store_dir}/model-artifacts" ] \
    && [ -d "$public_data_dir" ] && [ ! -L "$public_data_dir" ] || return 1
  if [ -f "${store_dir}/model-strategy.json" ] && [ ! -L "${store_dir}/model-strategy.json" ]; then
    if [ -e "${public_data_dir}/model-strategy.json" ] || [ -L "${public_data_dir}/model-strategy.json" ]; then
      [ -f "${public_data_dir}/model-strategy.json" ] && [ ! -L "${public_data_dir}/model-strategy.json" ] || return 1
    fi
    cp "${store_dir}/model-strategy.json" "${public_data_dir}/model-strategy.json" || return 1
    chmod 0644 "${public_data_dir}/model-strategy.json" || return 1
  elif [ -e "${store_dir}/model-strategy.json" ] || [ -L "${store_dir}/model-strategy.json" ]; then
    return 1
  elif [ "$mode" = "store-only" ]; then
    return 1
  elif [ -f "${public_data_dir}/model-strategy.json" ] && [ ! -L "${public_data_dir}/model-strategy.json" ]; then
    cp "${public_data_dir}/model-strategy.json" "${store_dir}/model-strategy.json" || return 1
    chmod 0644 "${store_dir}/model-strategy.json" || return 1
  elif [ -e "${public_data_dir}/model-strategy.json" ] || [ -L "${public_data_dir}/model-strategy.json" ]; then
    return 1
  fi
  if [ -f "${store_dir}/model-artifacts/evaluation.json" ] && [ ! -L "${store_dir}/model-artifacts/evaluation.json" ]; then
    if [ -e "${public_data_dir}/model-evaluation.json" ] || [ -L "${public_data_dir}/model-evaluation.json" ]; then
      [ -f "${public_data_dir}/model-evaluation.json" ] && [ ! -L "${public_data_dir}/model-evaluation.json" ] || return 1
    fi
    cp "${store_dir}/model-artifacts/evaluation.json" "${public_data_dir}/model-evaluation.json" || return 1
    chmod 0644 "${public_data_dir}/model-evaluation.json" || return 1
  elif [ -e "${store_dir}/model-artifacts/evaluation.json" ] || [ -L "${store_dir}/model-artifacts/evaluation.json" ]; then
    return 1
  elif [ "$mode" = "store-only" ]; then
    return 1
  elif [ -f "${public_data_dir}/model-evaluation.json" ] && [ ! -L "${public_data_dir}/model-evaluation.json" ]; then
    cp "${public_data_dir}/model-evaluation.json" "${store_dir}/model-artifacts/evaluation.json" || return 1
    chmod 0644 "${store_dir}/model-artifacts/evaluation.json" || return 1
  elif [ -e "${public_data_dir}/model-evaluation.json" ] || [ -L "${public_data_dir}/model-evaluation.json" ]; then
    return 1
  fi
  if id football >/dev/null 2>&1; then
    chown football:football "${store_dir}/model-strategy.json" >/dev/null 2>&1 || true
    chown football:football "${store_dir}/model-artifacts/evaluation.json" >/dev/null 2>&1 || true
  fi
}

run_model_artifact_catchup() {
  local store_dir="$1"
  local sqlite_path="$2"
  local app_dir="${3:-$PWD}"
  if [ "${ENABLE_MODEL_BACKTEST_ON_SYNC:-1}" != "1" ]; then
    sync_model_artifact_mirrors "$store_dir" "$app_dir" || return 1
    return 0
  fi
  run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run model:backtest || return 1
  run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run optimize:strategy || return 1
  sync_model_artifact_mirrors "$store_dir" "$app_dir" || return 1
}

run_candidate_model_artifact_catchup() {
  local store_dir="$1"
  local sqlite_path="$2"
  run_build_step model-backtest env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run model:backtest || return 1
  run_build_step optimize-strategy env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run optimize:strategy || return 1
  sync_model_artifact_mirrors "$store_dir" "$BUILD_DIR" || return 1
  # optimize:strategy can fail closed from guarded-active to shadow and remove
  # stale strategy injection from mutable current rows. Re-export after that
  # reconciliation so the candidate API and its public artifacts are identical.
  run_build_step candidate-datastore-reconciled env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run datastore:sqlite || return 1
  # model:backtest can refreeze the candidate registry under a new revision.
  # Refresh the deadline heartbeat from that exact revision before candidate
  # API verification so a stale pre-release status can never be accepted.
  run_build_step candidate-deadline-capture env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/npm" run candidate:capture-deadline || return 1
}

prepare_release_enrichment_reuse_request() {
  local request_path="${RELEASE_ENRICHMENT_REUSE_REQUEST}"
  local helper="${APP_DIR}/scripts/releaseEnrichmentReuse.cjs"
  local max_age_seconds="${RELEASE_ENRICHMENT_REUSE_MAX_AGE_SECONDS:-5400}"
  if [ -e "$request_path" ] || [ -L "$request_path" ]; then
    if [ ! -f "$request_path" ] || [ -L "$request_path" ] \
      || [ "$(stat -c '%h' -- "$request_path")" != "1" ]; then
      log "warning: unsafe prior enrichment reuse request blocks acceleration; full enrichment remains required"
      return 0
    fi
    rm -f -- "$request_path" || return 1
  fi
  [ -f "$helper" ] && [ ! -L "$helper" ] || return 1
  "$NODE_HOME/bin/node" "$helper" prepare \
    --old-root "$BACKUP_DIR" \
    --new-root "$APP_DIR" \
    --store-dir "$LIVE_STORE_DIR" \
    --bundle-sha "$BUNDLE_SHA256" \
    --output "$request_path" \
    --max-age-seconds "$max_age_seconds" \
    || return 1
  if [ -e "$request_path" ] || [ -L "$request_path" ]; then
    [ -f "$request_path" ] && [ ! -L "$request_path" ] \
      && [ "$(stat -c '%h' -- "$request_path")" = "1" ] || return 1
    chown root:football "$request_path" || return 1
    chmod 0640 "$request_path" || return 1
    sync -f "$request_path" || return 1
    sync -f "$(dirname "$request_path")" || return 1
    log "prepared one-cycle hash-bound enrichment reuse request"
  else
    log "no safe enrichment reuse evidence; release worker will run the complete enrichment lane"
  fi
}

clear_release_enrichment_reuse_request() {
  local request_path="${RELEASE_ENRICHMENT_REUSE_REQUEST}"
  if [ ! -e "$request_path" ] && [ ! -L "$request_path" ]; then
    return 0
  fi
  if [ ! -f "$request_path" ] || [ -L "$request_path" ] \
    || [ "$(stat -c '%h' -- "$request_path")" != "1" ]; then
    log "warning: unsafe enrichment reuse request was not removed"
    return 1
  fi
  rm -f -- "$request_path" || return 1
  sync -f "$(dirname "$request_path")" || return 1
}

prepare_release_worker_priority_request() {
  local request_path="${RELEASE_WORKER_PRIORITY_REQUEST}"
  local helper="${APP_DIR}/scripts/releaseEnrichmentReuse.cjs"
  if [ -e "$request_path" ] || [ -L "$request_path" ]; then
    [ -f "$request_path" ] && [ ! -L "$request_path" ] \
      && [ "$(stat -c '%h' -- "$request_path")" = "1" ] || return 1
    rm -f -- "$request_path" || return 1
  fi
  "$NODE_HOME/bin/node" "$helper" prepare-priority \
    --root "$APP_DIR" \
    --bundle-sha "$BUNDLE_SHA256" \
    --release-sequence "$RELEASE_SEQUENCE" \
    --output "$request_path" \
    --ttl-seconds 1800 \
    >/dev/null || return 1
  [ -f "$request_path" ] && [ ! -L "$request_path" ] \
    && [ "$(stat -c '%h' -- "$request_path")" = "1" ] || return 1
  chown root:football "$request_path" || return 1
  chmod 0640 "$request_path" || return 1
  sync -f "$request_path" || return 1
  sync -f "$(dirname "$request_path")" || return 1
  log "prepared one-cycle bundle-bound release worker priority request"
}

clear_release_worker_priority_request() {
  local request_path="${RELEASE_WORKER_PRIORITY_REQUEST}"
  if [ ! -e "$request_path" ] && [ ! -L "$request_path" ]; then
    return 0
  fi
  [ -f "$request_path" ] && [ ! -L "$request_path" ] \
    && [ "$(stat -c '%h' -- "$request_path")" = "1" ] || return 1
  rm -f -- "$request_path" || return 1
  sync -f "$(dirname "$request_path")" || return 1
}

prepare_candidate_llm_cache() {
  run_build_step llm-cache-initialize env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" \
    "$NODE_HOME/bin/node" -e '
const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve("public/data/gpt-predictions.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("refusing unsafe preserved LLM cache");
  }
} else {
  const payload = {
    version: 2,
    source: "llm-risk-review",
    promptVersion: "llm-risk-review-v1",
    updatedAt: null,
    rows: []
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
' || return 1
  run_build_step llm-cache-repair env PATH="$PATH" HOME="${BUILD_HOME:-/nonexistent}" \
    VERIFY_LLM_REVIEW_REPAIR=1 \
    "$NODE_HOME/bin/node" scripts/verifyLlmReviewBoundary.cjs || return 1
}

refresh_live_store_after_swap() {
  local store_dir="$1"
  local sqlite_path="$2"
  local export_mode="${RELEASE_EXPORT_LIVE_SQLITE:-always}"
  local defer_model_catchup="${RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1}"

  live_sqlite_export() {
    run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$store_dir" \
      DATASTORE_SQLITE_PATH="$sqlite_path" \
      SQLITE_VACUUM_AFTER_EXPORT=1 \
      SQLITE_MAINTENANCE_WINDOW=release-stopped \
      SQLITE_WAL_CHECKPOINT_MODE=TRUNCATE \
      npm run datastore:sqlite
  }

  if [ "$export_mode" = "preserve" ] && [ -f "$sqlite_path" ]; then
    log "preserve existing live sqlite ${sqlite_path}"
    live_sqlite_export || return 1
    if [ "$defer_model_catchup" != "1" ]; then
      run_model_artifact_catchup "$store_dir" "$sqlite_path" || return 1
      live_sqlite_export || return 1
    else
      log "defer live model catchup until the HTTP service is healthy"
    fi
    return 0
  fi

  log "refresh live sqlite ${sqlite_path}"
  live_sqlite_export || return 1
  if [ "$defer_model_catchup" != "1" ]; then
    run_model_artifact_catchup "$store_dir" "$sqlite_path" || return 1
    live_sqlite_export || return 1
  else
    log "defer live model catchup until the HTTP service is healthy"
  fi
}

copy_regular_file_nofollow() {
  local source="$1"
  local target="$2"
  local temporary="${target}.release-copy.$$"
  if [ ! -e "$source" ] && [ ! -L "$source" ]; then
    return 2
  fi
  if [ ! -f "$source" ] || [ -L "$source" ] \
    || [ "$(stat -c '%F' -- "$source")" != "regular file" ] \
    || [ "$(stat -c '%h' -- "$source")" != "1" ]; then
    printf 'refusing non-regular, linked, or multiply-linked cache file: %s\n' "$source" >&2
    return 1
  fi
  rm -f -- "$temporary"
  cp --no-dereference --preserve=timestamps -- "$source" "$temporary" || return 1
  if [ ! -f "$temporary" ] || [ -L "$temporary" ] \
    || [ "$(stat -c '%h' -- "$temporary")" != "1" ]; then
    rm -f -- "$temporary"
    printf 'cache copy changed type while being copied: %s\n' "$source" >&2
    return 1
  fi
  chmod 0600 "$temporary" || return 1
  mv -fT -- "$temporary" "$target" || return 1
}

rotate_fixed_recovery_helper() (
  set -euo pipefail

  local source_path source_real source_sha target_sha current_target_sha target_parent target_parent_real
  local target_parent_mode target_token current_target_token temporary="" rotation_committed=0
  source_path="${TRUSTED_SOURCE_DIR}/${FIXED_RECOVERY_HELPER_ROTATION_SOURCE}"
  target_parent="$(dirname "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")"

  cleanup_fixed_recovery_helper_rotation() {
    local status=$?
    if [ -n "$temporary" ]; then
      rm -f -- "$temporary" >/dev/null 2>&1 || true
    fi
    if [ "$status" -ne 0 ] && [ "$rotation_committed" = "1" ]; then
      printf 'fixed recovery helper rotation committed; application release not started\n' >&2
    fi
    exit "$status"
  }
  trap cleanup_fixed_recovery_helper_rotation EXIT HUP INT TERM

  if [ -e "$RECOVERY_DIR" ] || [ -L "$RECOVERY_DIR" ]; then
    printf 'recovery transaction appeared before fixed helper rotation\n' >&2
    return 1
  fi
  source_real="$(realpath -e -- "$source_path")"
  [ "$source_real" = "$source_path" ] \
    && [ -f "$source_path" ] && [ ! -L "$source_path" ] && [ -s "$source_path" ] \
    && [ "$(stat -c '%F' -- "$source_path")" = "regular file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$source_path")" = "0:0:600:1" ] \
    || { printf 'trusted fixed recovery helper source is unsafe\n' >&2; return 1; }
  "$NODE_HOME/bin/node" --check "$source_path" >/dev/null \
    || { printf 'trusted fixed recovery helper source has invalid syntax\n' >&2; return 1; }
  source_sha="$(sha256sum -- "$source_path" | awk '{print $1}')"
  [[ "$source_sha" =~ ^[0-9a-f]{64}$ ]] \
    || { printf 'trusted fixed recovery helper source digest is invalid\n' >&2; return 1; }

  [ -d "$target_parent" ] && [ ! -L "$target_parent" ] \
    || { printf 'fixed recovery helper parent is unsafe\n' >&2; return 1; }
  target_parent_real="$(realpath -e -- "$target_parent")"
  [ "$target_parent_real" = "$target_parent" ] \
    && [ "$(stat -c '%F' -- "$target_parent")" = "directory" ] \
    && [ "$(stat -c '%u:%g' -- "$target_parent")" = "0:0" ] \
    || { printf 'fixed recovery helper parent ownership or identity is unsafe\n' >&2; return 1; }
  target_parent_mode="$(stat -c '%a' -- "$target_parent")"
  [[ "$target_parent_mode" =~ ^[0-7]{3,4}$ ]] \
    && [ $((8#$target_parent_mode & 0022)) -eq 0 ] \
    || { printf 'fixed recovery helper parent is group or world writable\n' >&2; return 1; }

  [ -f "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" ] \
    && [ ! -L "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" ] \
    && [ "$(stat -c '%F' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")" = "regular file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")" = "0:0:644:1" ] \
    || { printf 'existing fixed recovery helper is unsafe\n' >&2; return 1; }
  "$NODE_HOME/bin/node" --check "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" >/dev/null \
    || { printf 'existing fixed recovery helper has invalid syntax\n' >&2; return 1; }
  target_sha="$(sha256sum -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" | awk '{print $1}')"
  target_token="$(stat -c '%d:%i:%s:%Y:%Z:%u:%g:%a:%h' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET"):${target_sha}"

  if [ "$target_sha" = "$source_sha" ]; then
    log "fixed recovery helper already matches signed bundle"
    trap - EXIT HUP INT TERM
    return 0
  fi

  temporary="$(mktemp "${target_parent}/.football-release-recovery.rotate.XXXXXX.cjs")"
  [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$temporary")" = "0:0:600:1" ] \
    || { printf 'fixed recovery helper temporary file is unsafe\n' >&2; return 1; }
  install -o root -g root -m 0644 -- "$source_path" "$temporary" \
    || { printf 'fixed recovery helper temporary install failed\n' >&2; return 1; }
  [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%F' -- "$temporary")" = "regular file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$temporary")" = "0:0:644:1" ] \
    && [ "$(sha256sum -- "$temporary" | awk '{print $1}')" = "$source_sha" ] \
    || { printf 'fixed recovery helper temporary validation failed\n' >&2; return 1; }
  "$NODE_HOME/bin/node" --check "$temporary" >/dev/null \
    || { printf 'fixed recovery helper temporary syntax validation failed\n' >&2; return 1; }
  sync -f "$temporary" \
    || { printf 'fixed recovery helper temporary file sync failed\n' >&2; return 1; }

  [ "$(sha256sum -- "$source_path" | awk '{print $1}')" = "$source_sha" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$source_path")" = "0:0:600:1" ] \
    || { printf 'trusted fixed recovery helper source changed during rotation\n' >&2; return 1; }
  current_target_sha="$(sha256sum -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" | awk '{print $1}')"
  current_target_token="$(stat -c '%d:%i:%s:%Y:%Z:%u:%g:%a:%h' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET"):${current_target_sha}"
  [ "$current_target_token" = "$target_token" ] \
    || { printf 'fixed recovery helper target changed during rotation\n' >&2; return 1; }
  if [ -e "$RECOVERY_DIR" ] || [ -L "$RECOVERY_DIR" ]; then
    printf 'recovery transaction appeared during fixed helper rotation\n' >&2
    return 1
  fi

  mv -fT -- "$temporary" "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" \
    || { printf 'fixed recovery helper atomic commit failed\n' >&2; return 1; }
  temporary=""
  rotation_committed=1
  sync -f "$target_parent" \
    || { printf 'fixed recovery helper parent sync failed\n' >&2; return 1; }
  [ -f "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" ] \
    && [ ! -L "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" ] \
    && [ "$(stat -c '%F' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")" = "regular file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET")" = "0:0:644:1" ] \
    && [ "$(sha256sum -- "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" | awk '{print $1}')" = "$source_sha" ] \
    || { printf 'fixed recovery helper post-commit validation failed\n' >&2; return 1; }
  "$NODE_HOME/bin/node" --check "$FIXED_RECOVERY_HELPER_ROTATION_TARGET" >/dev/null \
    || { printf 'fixed recovery helper post-commit syntax validation failed\n' >&2; return 1; }

  log "fixed recovery helper rotated to signed bundle digest ${source_sha}"
  trap - EXIT HUP INT TERM
  return 0
)

preserve_live_public_data_cache() {
  local source_app_dir="$1"
  local target_app_dir="$2"
  if [ -L "${source_app_dir}/public" ] || [ -L "${source_app_dir}/public/data" ] \
    || [ -L "${target_app_dir}/public" ] || [ -L "${target_app_dir}/public/data" ]; then
    printf 'refusing public cache copy through a symlinked directory\n' >&2
    return 1
  fi
  if [ ! -d "${source_app_dir}/public/data" ] || [ ! -d "${target_app_dir}/public/data" ]; then
    return 0
  fi

  local copied=0
  local file copy_status
  for file in "${PUBLIC_DATA_CACHE_FILES[@]}"; do
    if copy_regular_file_nofollow "${source_app_dir}/public/data/${file}" "${target_app_dir}/public/data/${file}"; then
      copied=$((copied + 1))
    else
      copy_status="$?"
      [ "$copy_status" -eq 2 ] || return "$copy_status"
    fi
  done

  for file in "${PUBLIC_ROOT_CACHE_FILES[@]}"; do
    if copy_regular_file_nofollow "${source_app_dir}/public/${file}" "${target_app_dir}/public/${file}"; then
      copied=$((copied + 1))
    else
      copy_status="$?"
      [ "$copy_status" -eq 2 ] || return "$copy_status"
    fi
  done

  if [ "$copied" -gt 0 ]; then
    log "preserved ${copied} live public data cache files"
  fi
}

validate_build_artifacts() {
  local artifact_root="${1:-$BUILD_DIR}"
  node - "$artifact_root" "${PUBLIC_DATA_CACHE_FILES[*]}" "${PUBLIC_ROOT_CACHE_FILES[*]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [buildRoot, dataNamesRaw, rootNamesRaw] = process.argv.slice(2);
const nodeModulesRoot = path.join(buildRoot, "node_modules");
const distRoot = path.join(buildRoot, "dist");
const historicalTrainingRoot = path.join(buildRoot, ".release-model-assets");
const historicalTrainingPath = path.join(historicalTrainingRoot, "historical-training-index.json");
const limits = { entries: 300000, bytes: 3 * 1024 * 1024 * 1024 };
let entries = 0;
let bytes = 0;

const fail = (message) => {
  throw new Error(`build artifact rejected: ${message}`);
};
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const assertDirectory = (target, label) => {
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a real directory`);
  if ((info.mode & 0o022) !== 0) fail(`${label} is group/world writable`);
};
const walk = (root, allowInternalRelativeSymlinks) => {
  assertDirectory(root, path.relative(buildRoot, root));
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const fullPath = path.join(current, name);
      const relative = path.relative(buildRoot, fullPath).split(path.sep).join("/");
      const info = fs.lstatSync(fullPath);
      entries += 1;
      if (entries > limits.entries) fail(`entry limit exceeded at ${relative}`);
      if ((info.mode & 0o6000) !== 0) fail(`setuid/setgid mode on ${relative}`);
      if (info.isSymbolicLink()) {
        if (!allowInternalRelativeSymlinks) fail(`symlink outside node_modules: ${relative}`);
        const target = fs.readlinkSync(fullPath);
        if (!target || path.isAbsolute(target) || /[\0-\x1f\x7f\\]/.test(target)) {
          fail(`unsafe symlink target at ${relative}`);
        }
        const lexicalTarget = path.resolve(path.dirname(fullPath), target);
        if (!inside(nodeModulesRoot, lexicalTarget)) fail(`symlink escapes node_modules: ${relative}`);
        let realTarget;
        try {
          realTarget = fs.realpathSync(fullPath);
        } catch {
          fail(`dangling symlink at ${relative}`);
        }
        if (!inside(nodeModulesRoot, realTarget)) fail(`resolved symlink escapes node_modules: ${relative}`);
        continue;
      }
      if ((info.mode & 0o022) !== 0) fail(`group/world-writable artifact: ${relative}`);
      if (info.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!info.isFile()) fail(`device, fifo, socket, or unsupported type: ${relative}`);
      if (info.nlink !== 1) fail(`multiply-linked file: ${relative}`);
      bytes += info.size;
      if (bytes > limits.bytes) fail(`total artifact bytes exceed ${limits.bytes}`);
    }
  }
};

walk(distRoot, false);
walk(nodeModulesRoot, true);
assertDirectory(historicalTrainingRoot, ".release-model-assets");
const historicalTrainingInfo = fs.lstatSync(historicalTrainingPath);
if (!historicalTrainingInfo.isFile()
    || historicalTrainingInfo.isSymbolicLink()
    || historicalTrainingInfo.nlink !== 1
    || historicalTrainingInfo.size <= 0
    || historicalTrainingInfo.size > 64 * 1024 * 1024
    || (historicalTrainingInfo.mode & 0o022) !== 0) {
  fail("historical training release asset is not a safe single-link file");
}
const historicalTrainingValidatorPath = path.join(
  buildRoot,
  "scripts",
  "historicalTrainingReleaseArtifact.cjs"
);
const historicalTrainingValidatorInfo = fs.lstatSync(historicalTrainingValidatorPath);
if (!historicalTrainingValidatorInfo.isFile()
    || historicalTrainingValidatorInfo.isSymbolicLink()
    || historicalTrainingValidatorInfo.nlink !== 1) {
  fail("historical training validator is not a safe single-link file");
}
const {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  inspectHistoricalTrainingFile
} = require(historicalTrainingValidatorPath);
if (HISTORICAL_TRAINING_RELEASE_ENTRY !== ".release-model-assets/historical-training-index.json") {
  fail("historical training release entry contract changed");
}
const historicalTrainingArtifact = inspectHistoricalTrainingFile(historicalTrainingPath);
if (!historicalTrainingArtifact.ok) {
  fail(`historical training release asset failed validation: ${
    (historicalTrainingArtifact.blockers || []).join(",")
  }`);
}
for (const relative of ["public", "public/data"]) {
  const target = path.join(buildRoot, relative);
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${relative} is not a real directory`);
}
const indexInfo = fs.lstatSync(path.join(distRoot, "index.html"));
if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || indexInfo.nlink !== 1) {
  fail("dist/index.html is not a single-link regular file");
}
const indexText = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
const mainAssetMatch = indexText.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)
  || indexText.match(/<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i);
if (!mainAssetMatch) fail("dist/index.html is missing the module entry asset");
const mainAssetPath = path.resolve(distRoot, mainAssetMatch[1].replace(/^\/+/, ""));
if (!inside(distRoot, mainAssetPath)) fail("module entry asset escapes dist");
const mainAssetInfo = fs.lstatSync(mainAssetPath);
if (!mainAssetInfo.isFile() || mainAssetInfo.isSymbolicLink() || mainAssetInfo.nlink !== 1) {
  fail("module entry asset is not a single-link regular file");
}
const mainAssetText = fs.readFileSync(mainAssetPath, "utf8");
for (const marker of ["Download the React DevTools", "Each child in a list should have a unique"]) {
  if (mainAssetText.includes(marker)) fail(`module entry asset contains React development marker: ${marker}`);
}

const inspectOptionalData = (relative) => {
  const target = path.join(buildRoot, relative);
  if (!fs.existsSync(target)) return;
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512 * 1024 * 1024) {
    fail(`unsafe whitelisted data file: ${relative}`);
  }
};
for (const name of dataNamesRaw.split(" ").filter(Boolean)) inspectOptionalData(`public/data/${name}`);
for (const name of rootNamesRaw.split(" ").filter(Boolean)) inspectOptionalData(`public/${name}`);

console.log(JSON.stringify({
  ok: true,
  artifactEntries: entries,
  artifactBytes: bytes,
  historicalTrainingArtifact: {
    entry: historicalTrainingArtifact.entry,
    sha256: historicalTrainingArtifact.sha256,
    bytes: historicalTrainingArtifact.bytes,
    rows: historicalTrainingArtifact.rows,
    teams: historicalTrainingArtifact.teams,
    finiteEloTeams: historicalTrainingArtifact.finiteEloTeams
  }
}));
NODE
}

normalize_validated_artifact_modes() {
  local artifact_root="$1"
  chown -hR root:root -- "$artifact_root/dist" "$artifact_root/node_modules" || return 1
  find "$artifact_root/dist" -type d -exec chmod 0755 {} + || return 1
  find "$artifact_root/dist" -type f -exec chmod 0644 {} + || return 1
  find "$artifact_root/node_modules" -type d -exec chmod 0755 {} + || return 1
  find "$artifact_root/node_modules" -type f -perm /111 -exec chmod 0755 {} + || return 1
  find "$artifact_root/node_modules" -type f \! -perm /111 -exec chmod 0644 {} + || return 1
}

assemble_final_tree() {
  [ ! -e "$NEXT_DIR" ] && [ ! -L "$NEXT_DIR" ] || {
    printf 'final assembly target must not exist: %s\n' "$NEXT_DIR" >&2
    return 1
  }
  install -d -o root -g root -m 0700 -- "$NEXT_DIR" || return 1
  cp -a --no-dereference -- "$TRUSTED_SOURCE_DIR/." "$NEXT_DIR/" || return 1
  rm -f -- "$NEXT_DIR/.release-trusted-sha256" || return 1
  rm -rf -- "$NEXT_DIR/dist" "$NEXT_DIR/node_modules" "$NEXT_DIR/server-data" || return 1
  install -d -o root -g root -m 0755 -- "$NEXT_DIR/dist" "$NEXT_DIR/node_modules" || return 1
  cp -a --no-dereference -- "$BUILD_DIR/dist/." "$NEXT_DIR/dist/" || return 1
  cp -a --no-dereference -- "$BUILD_DIR/node_modules/." "$NEXT_DIR/node_modules/" || return 1

  local file copy_status
  install -d -o root -g root -m 0755 -- "$NEXT_DIR/public" "$NEXT_DIR/public/data" || return 1
  for file in "${PUBLIC_DATA_CACHE_FILES[@]}"; do
    if copy_regular_file_nofollow "$BUILD_DIR/public/data/$file" "$NEXT_DIR/public/data/$file"; then
      :
    else
      copy_status="$?"
      [ "$copy_status" -eq 2 ] || return "$copy_status"
    fi
  done
  for file in "${PUBLIC_ROOT_CACHE_FILES[@]}"; do
    if copy_regular_file_nofollow "$BUILD_DIR/public/$file" "$NEXT_DIR/public/$file"; then
      :
    else
      copy_status="$?"
      [ "$copy_status" -eq 2 ] || return "$copy_status"
    fi
  done

  chown -hR root:root -- "$NEXT_DIR" || return 1
}

fix_store_permissions() {
  local store_dir="$1"
  if id football >/dev/null 2>&1 && [ -d "$store_dir" ]; then
    chown -R football:football "$store_dir" >/dev/null 2>&1 || return 1
  fi
}

verify_store_write_permissions() {
  local store_dir="$1"
  local sqlite_path="${2:-${store_dir}/football.db}"
  [ -d "$store_dir" ] && [ ! -L "$store_dir" ] || return 1
  [ -d "${store_dir}/model-artifacts" ] && [ ! -L "${store_dir}/model-artifacts" ] || return 1
  [ -f "$sqlite_path" ] && [ ! -L "$sqlite_path" ] \
    && [ "$(stat -c '%h' -- "$sqlite_path")" = "1" ] || return 1
  runuser -u football -- env RELEASE_STORE_DIR="$store_dir" RELEASE_SQLITE_PATH="$sqlite_path" \
    "$NODE_HOME/bin/node" - <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const storeDir = process.env.RELEASE_STORE_DIR;
const sqlitePath = process.env.RELEASE_SQLITE_PATH;
for (const root of [storeDir, path.join(storeDir, "model-artifacts")]) {
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) process.exit(2);
  const probe = path.join(root, `.release-write-probe-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  const descriptor = fs.openSync(probe, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, "write-probe\n", "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(probe, { force: true });
  }
}
fs.accessSync(sqlitePath, fs.constants.R_OK | fs.constants.W_OK);
NODE
}

fix_app_permissions() {
  local app_dir="$1"
  if [ ! -d "$app_dir" ]; then
    return 0
  fi
  chown -R root:root "$app_dir" >/dev/null 2>&1 || return 1
  find "$app_dir" -type d -exec chmod 0755 {} + >/dev/null 2>&1 || return 1
  # npm ci deliberately marks package executables. Do not flatten those modes or
  # node_modules/.bin shims become non-executable after the candidate check.
  find "$app_dir" -path "${app_dir}/node_modules" -prune -o -type f \
    ! -name '.release-tree-identity' -exec chmod 0644 {} + >/dev/null 2>&1 || return 1
  if [ -f "${app_dir}/.release-tree-identity" ] && [ ! -L "${app_dir}/.release-tree-identity" ]; then
    chown root:root "${app_dir}/.release-tree-identity" || return 1
    chmod 0600 "${app_dir}/.release-tree-identity" || return 1
  fi
  if [ -f "${app_dir}/deploy/light-server/env" ]; then
    chown root:football "${app_dir}/deploy/light-server/env" >/dev/null 2>&1 \
      || chown root:root "${app_dir}/deploy/light-server/env" >/dev/null 2>&1 \
      || return 1
    chmod 0640 "${app_dir}/deploy/light-server/env" || return 1
  fi
}

fix_worker_write_permissions() {
  local app_dir="$1"
  if ! id football >/dev/null 2>&1 || [ ! -d "$app_dir" ]; then
    return 0
  fi
  install -d -o football -g football -m 0755 "${app_dir}/server-data" || return 1
  if [ -d "${app_dir}/public/data" ]; then
    chown -R football:football "${app_dir}/public/data" >/dev/null 2>&1 || return 1
    find "${app_dir}/public/data" -type d -exec chmod 0775 {} + >/dev/null 2>&1 || return 1
    find "${app_dir}/public/data" -type f -exec chmod 0664 {} + >/dev/null 2>&1 || return 1
  fi
  if [ -d "${app_dir}/server-data" ]; then
    chown -R football:football "${app_dir}/server-data" >/dev/null 2>&1 || return 1
    find "${app_dir}/server-data" -type d -exec chmod 0775 {} + >/dev/null 2>&1 || return 1
    find "${app_dir}/server-data" -type f -exec chmod 0664 {} + >/dev/null 2>&1 || return 1
  fi
  if [ -d "${app_dir}/public" ]; then
    chown root:root "${app_dir}/public" >/dev/null 2>&1 || return 1
    chmod 0755 "${app_dir}/public" >/dev/null 2>&1 || return 1
    find "${app_dir}/public" -maxdepth 1 -type f -name '*.json' -exec chown root:root {} + >/dev/null 2>&1 || return 1
    find "${app_dir}/public" -maxdepth 1 -type f -name '*.json' -exec chmod 0644 {} + >/dev/null 2>&1 || return 1
  fi
}

verify_worker_write_permissions() {
  local app_dir="$1"
  if ! id football >/dev/null 2>&1 || [ ! -d "${app_dir}/public/data" ]; then
    return 0
  fi
  local probe="${app_dir}/public/data/.football-write-probe.$$"
  if command -v runuser >/dev/null 2>&1; then
    runuser -u football -- sh -c 'probe="$1"; printf ok >"$probe" && mv "$probe" "${probe}.done" && rm -f "${probe}.done"' sh "$probe"
  else
    su -s /bin/sh football -c "printf ok >'${probe}' && mv '${probe}' '${probe}.done' && rm -f '${probe}.done'"
  fi
}

compact_public_odds_history() {
  local app_dir="$1"
  if [ ! -d "$app_dir" ]; then
    return 0
  fi
  run_build_step compact-odds env COMPACT_APP_DIR="$app_dir" \
    COMPACT_RETENTION_DAYS="${ODDS_HISTORY_RETENTION_DAYS:-14}" \
    COMPACT_MAX_ROWS="${ODDS_HISTORY_MAX_ROWS:-12000}" \
    NODE_OPTIONS=--max-old-space-size=4096 \
    "$NODE_HOME/bin/node" scripts/compactPublicOddsHistory.cjs
}

install_managed_file() {
  local source="$1"
  local target="$2"
  local parent temporary
  is_managed_config_path "$target" || return 1
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  parent="$(dirname "$target")"
  install -d -o root -g root -m 0755 -- "$parent" || return 1
  temporary="${parent}/.${target##*/}.install.$$"
  rm -f -- "$temporary"
  install -o root -g root -m 0644 -- "$source" "$temporary" || return 1
  sync -f "$temporary"
  mv -fT -- "$temporary" "$target" || return 1
  sync -f "$parent"
}

remove_managed_path() {
  local target="$1"
  is_managed_config_path "$target" || return 1
  [ ! -d "$target" ] || return 1
  rm -f -- "$target"
}

replace_managed_symlink() {
  local link_target="$1"
  local link_path="$2"
  local parent temporary
  is_managed_config_path "$link_path" || return 1
  parent="$(dirname "$link_path")"
  install -d -o root -g root -m 0755 -- "$parent" || return 1
  temporary="${parent}/.${link_path##*/}.install.$$"
  rm -f -- "$temporary"
  ln -s -- "$link_target" "$temporary" || return 1
  mv -fT -- "$temporary" "$link_path" || return 1
  sync -f "$parent"
}

quiesce_managed_timers_for_config_change() {
  local timer
  for timer in "${MANAGED_TIMERS[@]}"; do
    if systemctl is-active --quiet "$timer"; then
      systemctl stop "$timer" >/dev/null 2>&1 || return 1
    fi
  done
}

quiesce_managed_maintenance_for_sqlite_snapshot() {
  local unit state
  for unit in "${MANAGED_TIMERS[@]}" football-cleanup.service football-monitor.service; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in
      active|activating|deactivating|reloading)
        systemctl stop "$unit" >/dev/null 2>&1 || return 1
        ;;
    esac
  done
  for unit in "${MANAGED_TIMERS[@]}" football-cleanup.service football-monitor.service; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in
      ""|inactive|failed|unknown) ;;
      *)
        printf 'managed maintenance unit is not quiescent: %s (%s)\n' "$unit" "$state" >&2
        return 1
        ;;
    esac
  done
}

enable_managed_timers_after_readiness() {
  local timer
  for timer in "${MANAGED_TIMERS[@]}"; do
    if systemctl cat "$timer" >/dev/null 2>&1; then
      systemctl enable --now "$timer" >/dev/null 2>&1 || return 1
      systemctl is-enabled --quiet "$timer" || return 1
      systemctl is-active --quiet "$timer" || return 1
    fi
  done
  TIMER_STATE_DIRTY=0
}

install_systemd_units() {
  local source_root="${1:-$PWD}"
  local deploy_root="${source_root}/deploy/light-server"
  if [ -f "${deploy_root}/football-predict.service" ] && [ ! -L "${deploy_root}/football-predict.service" ]; then
    install_managed_file "${deploy_root}/football-predict.service" /etc/systemd/system/football-predict.service || return 1
  fi
  if [ -f "${deploy_root}/football-sync-worker.service" ] && [ ! -L "${deploy_root}/football-sync-worker.service" ]; then
    install_managed_file "${deploy_root}/football-sync-worker.service" /etc/systemd/system/football-sync-worker.service || return 1
  fi
  for unit in football-cleanup.service football-cleanup.timer football-monitor.service football-monitor.timer; do
    if [ -f "${deploy_root}/${unit}" ] && [ ! -L "${deploy_root}/${unit}" ]; then
      install_managed_file "${deploy_root}/${unit}" "/etc/systemd/system/${unit}" || return 1
    fi
  done
}

install_nginx_config() {
  local source_root="${1:-$PWD}"
  local deploy_root="${source_root}/deploy/light-server"
  if ! command -v nginx >/dev/null 2>&1 || [ ! -f "${deploy_root}/nginx.conf" ] || [ -L "${deploy_root}/nginx.conf" ]; then
    return 0
  fi
  local tls_site_enabled=0
  if [ -e /etc/nginx/sites-enabled/football-predict-tls ] || [ -L /etc/nginx/sites-enabled/football-predict-tls ]; then
    tls_site_enabled=1
  fi
  if [ ! -f "${deploy_root}/nginx-http-common.conf" ] || [ -L "${deploy_root}/nginx-http-common.conf" ] \
    || [ ! -f "${deploy_root}/nginx-server-common.conf" ] || [ -L "${deploy_root}/nginx-server-common.conf" ] \
    || [ ! -f "${deploy_root}/nginx-security-headers.conf" ] || [ -L "${deploy_root}/nginx-security-headers.conf" ]; then
    log "legacy monolithic nginx config detected"
    install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled || return 1
    install_managed_file "${deploy_root}/nginx.conf" /etc/nginx/sites-available/football-predict || return 1
    if [ "$tls_site_enabled" = "1" ]; then
      if [ ! -f /etc/nginx/conf.d/football-predict-common.conf ] || [ ! -f /etc/nginx/snippets/football-predict-server.conf ] || [ ! -f /etc/nginx/snippets/football-predict-security-headers.conf ]; then
        printf 'enabled TLS site requires installed managed nginx common config\n' >&2
        return 1
      fi
      remove_managed_path /etc/nginx/sites-enabled/football-predict || return 1
    else
      remove_managed_path /etc/nginx/conf.d/football-predict-common.conf || return 1
      remove_managed_path /etc/nginx/snippets/football-predict-server.conf || return 1
      remove_managed_path /etc/nginx/snippets/football-predict-security-headers.conf || return 1
      replace_managed_symlink /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict || return 1
    fi
  else
    install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled || return 1
    install_managed_file "${deploy_root}/nginx-http-common.conf" /etc/nginx/conf.d/football-predict-common.conf || return 1
    install_managed_file "${deploy_root}/nginx-server-common.conf" /etc/nginx/snippets/football-predict-server.conf || return 1
    install_managed_file "${deploy_root}/nginx-security-headers.conf" /etc/nginx/snippets/football-predict-security-headers.conf || return 1
    install_managed_file "${deploy_root}/nginx.conf" /etc/nginx/sites-available/football-predict || return 1
    if [ "$tls_site_enabled" = "1" ]; then
      log "preserve enabled host-local TLS site"
      remove_managed_path /etc/nginx/sites-enabled/football-predict || return 1
    else
      replace_managed_symlink /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict || return 1
    fi
  fi
  nginx -t || return 1
  if command -v systemctl >/dev/null 2>&1 && systemctl cat nginx >/dev/null 2>&1; then
    systemctl reload nginx || return 1
  else
    nginx -s reload || return 1
  fi
}

HEALTH_PROBE_CURL_EXIT="-"
HEALTH_PROBE_HTTP_STATUS="000"
HEALTH_PROBE_REASON="not-run"
HEALTH_PROBE_BODY=""
HEALTH_PROBE_ERROR=""

probe_health_endpoint() {
  local endpoint="$1"
  local acceptance="${2:-full}"
  local body_file error_file http_status curl_exit validator_exit
  [ "$acceptance" = "full" ] || [ "$acceptance" = "service" ] \
    || { printf 'invalid health acceptance mode: %s\n' "$acceptance" >&2; return 1; }
  HEALTH_PROBE_CURL_EXIT="-"
  HEALTH_PROBE_HTTP_STATUS="000"
  HEALTH_PROBE_REASON="probe-initialization-failed"
  HEALTH_PROBE_BODY=""
  HEALTH_PROBE_ERROR=""
  body_file="$(mktemp /tmp/football-health-body.XXXXXX)" || return 1
  error_file="$(mktemp /tmp/football-health-error.XXXXXX)" \
    || { rm -f -- "$body_file"; return 1; }
  chmod 0600 "$body_file" "$error_file" || {
    rm -f -- "$body_file" "$error_file"
    return 1
  }

  set +e
  http_status="$(curl -sS --connect-timeout 2 --max-time 8 --max-filesize 1048576 \
    --output "$body_file" --write-out '%{http_code}' "$endpoint" 2>"$error_file")"
  curl_exit="$?"
  set -e

  HEALTH_PROBE_CURL_EXIT="$curl_exit"
  HEALTH_PROBE_HTTP_STATUS="${http_status:-000}"
  HEALTH_PROBE_BODY="$(head -c 16384 -- "$body_file" 2>/dev/null || true)"
  HEALTH_PROBE_ERROR="$(head -c 4096 -- "$error_file" 2>/dev/null || true)"
  HEALTH_PROBE_REASON="curl-exit-${curl_exit}"

  if [ "$curl_exit" -eq 0 ] && [[ "$HEALTH_PROBE_HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]; then
    set +e
    "$NODE_HOME/bin/node" - "$body_file" "$acceptance" <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const acceptance = process.argv[3] || "full";
if (payload?.apiVersion !== "v1") process.exit(2);
if (payload?.status?.serviceOk === false) process.exit(3);
if (acceptance === "full" && payload?.ok === false) process.exit(3);
NODE
    validator_exit="$?"
    set -e
    case "$validator_exit" in
      0)
        HEALTH_PROBE_REASON="healthy-v1"
        rm -f -- "$body_file" "$error_file"
        return 0
        ;;
      2) HEALTH_PROBE_REASON="unexpected-api-version" ;;
      3) HEALTH_PROBE_REASON="service-health-false" ;;
      *) HEALTH_PROBE_REASON="invalid-health-json" ;;
    esac
  elif [ "$curl_exit" -eq 0 ]; then
    HEALTH_PROBE_REASON="http-${HEALTH_PROBE_HTTP_STATUS}"
  fi

  rm -f -- "$body_file" "$error_file"
  return 1
}

persist_health_failure_evidence() {
  local base_url="$1"
  local label="$2"
  local attempts="$3"
  local elapsed_seconds="$4"
  local safe_label timestamp evidence_path observed_unit
  safe_label="${label//[^a-zA-Z0-9_-]/-}"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)" || timestamp="unknown-time"
  evidence_path="${READINESS_EVIDENCE_ROOT}/${timestamp}-${BUNDLE_SHA256:0:12}-${safe_label}-$$.log"
  observed_unit="$SERVICE_NAME"
  if [ "$base_url" = "http://${HOST}:${CANDIDATE_PORT}" ] && [ -n "${CANDIDATE_UNIT:-}" ]; then
    observed_unit="$CANDIDATE_UNIT"
  fi

  install -d -o root -g root -m 0700 -- "$READINESS_EVIDENCE_ROOT" || return 1
  [ -d "$READINESS_EVIDENCE_ROOT" ] && [ ! -L "$READINESS_EVIDENCE_ROOT" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$READINESS_EVIDENCE_ROOT")" = "0:0:700" ] || return 1
  (
    umask 077
    {
      printf 'capturedAt=%s\n' "$timestamp"
      printf 'releaseBundle=%s\n' "$BUNDLE_SHA256"
      printf 'label=%s\n' "$label"
      printf 'endpoint=%s/api/v1/health\n' "$base_url"
      printf 'attempts=%s\n' "$attempts"
      printf 'elapsedSeconds=%s\n' "$elapsed_seconds"
      printf 'lastCurlExit=%s\n' "$HEALTH_PROBE_CURL_EXIT"
      printf 'lastHttpStatus=%s\n' "$HEALTH_PROBE_HTTP_STATUS"
      printf 'lastReason=%s\n' "$HEALTH_PROBE_REASON"
      printf '\n[last-curl-error]\n%s\n' "$HEALTH_PROBE_ERROR"
      printf '\n[last-health-body-first-16384-bytes]\n%s\n' "$HEALTH_PROBE_BODY"
      printf '\n[systemd-show:%s]\n' "$observed_unit"
      systemctl show "$observed_unit" \
        --property=LoadState --property=ActiveState --property=SubState \
        --property=MainPID --property=ExecMainCode --property=ExecMainStatus 2>&1 || true
      printf '\n[systemd-status:%s]\n' "$observed_unit"
      systemctl status "$observed_unit" --no-pager -l 2>&1 || true
      printf '\n[journal:%s:last-120]\n' "$observed_unit"
      journalctl -u "$observed_unit" --no-pager -n 120 2>&1 || true
    } >"$evidence_path"
  ) || return 1
  chown root:root "$evidence_path" || return 1
  chmod 0600 "$evidence_path" || return 1
  sync -f "$evidence_path" || return 1
  sync -f "$READINESS_EVIDENCE_ROOT" || return 1
  log "health failure evidence saved: ${evidence_path}"
}

wait_for_health() {
  local base_url="$1"
  local label="${2:-service-health}"
  local timeout_seconds="${3:-90}"
  local required_successes="${4:-2}"
  local acceptance="${5:-full}"
  local retry_delay_seconds="${RELEASE_HEALTH_RETRY_DELAY_SECONDS:-2}"
  local started_at deadline attempt=0 consecutive_successes=0 elapsed=0

  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] && [ "$timeout_seconds" -ge 10 ] && [ "$timeout_seconds" -le 600 ] \
    || { printf 'invalid health timeout seconds: %s\n' "$timeout_seconds" >&2; return 1; }
  [[ "$required_successes" =~ ^[0-9]+$ ]] && [ "$required_successes" -ge 1 ] && [ "$required_successes" -le 5 ] \
    || { printf 'invalid required consecutive health successes: %s\n' "$required_successes" >&2; return 1; }
  [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] && [ "$retry_delay_seconds" -ge 1 ] && [ "$retry_delay_seconds" -le 10 ] \
    || { printf 'invalid health retry delay seconds: %s\n' "$retry_delay_seconds" >&2; return 1; }

  started_at="$SECONDS"
  deadline=$((started_at + timeout_seconds))
  while :; do
    attempt=$((attempt + 1))
    if probe_health_endpoint "${base_url}/api/v1/health" "$acceptance"; then
      consecutive_successes=$((consecutive_successes + 1))
      if [ "$consecutive_successes" -ge "$required_successes" ]; then
        elapsed=$((SECONDS - started_at))
        log "health stable: label=${label} attempts=${attempt} consecutive=${consecutive_successes} elapsed=${elapsed}s"
        return 0
      fi
      log "health probe success pending confirmation: label=${label} attempt=${attempt} consecutive=${consecutive_successes}/${required_successes}"
    else
      consecutive_successes=0
      elapsed=$((SECONDS - started_at))
      log "health probe pending: label=${label} attempt=${attempt} elapsed=${elapsed}s curlExit=${HEALTH_PROBE_CURL_EXIT} http=${HEALTH_PROBE_HTTP_STATUS} reason=${HEALTH_PROBE_REASON}"
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      elapsed=$((SECONDS - started_at))
      printf 'timed out waiting for stable health: label=%s endpoint=%s/api/v1/health attempts=%s elapsed=%ss lastHttp=%s lastReason=%s\n' \
        "$label" "$base_url" "$attempt" "$elapsed" "$HEALTH_PROBE_HTTP_STATUS" "$HEALTH_PROBE_REASON" >&2
      persist_health_failure_evidence "$base_url" "$label" "$attempt" "$elapsed" \
        || log "warning: could not persist health failure evidence for ${label}"
      return 1
    fi
    sleep "$retry_delay_seconds"
  done
}

load_env() {
  local env_file="$1"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

stop_candidate() {
  if [ -n "${CANDIDATE_UNIT:-}" ]; then
    systemctl stop "$CANDIDATE_UNIT" >/dev/null 2>&1 || true
    if ! assert_transient_unit_cleared "$CANDIDATE_UNIT"; then
      systemctl kill --kill-who=all --signal=KILL "$CANDIDATE_UNIT" >/dev/null 2>&1 || true
      systemctl stop "$CANDIDATE_UNIT" >/dev/null 2>&1 || true
      assert_transient_unit_cleared "$CANDIDATE_UNIT" || return 1
    fi
  fi
  CANDIDATE_UNIT=""
}

WORKER_STOPPED_FOR_SWAP=0
WORKER_FROZEN_FOR_READINESS=0
WORKER_FROZEN_MAIN_PID=""
SERVICE_STOPPED_FOR_SWAP=0
SWAP_STARTED=0
ROLLBACK_IN_PROGRESS=0
LIVE_SQLITE_BACKUP_DIR=""

cleanup_build_tree() {
  case "$BUILD_DIR" in
    "${APP_DIR}.build-"*)
      rm -rf --one-file-system -- "$BUILD_DIR" || return 1
      ;;
    *)
      printf 'refusing to clean unexpected build path: %s\n' "$BUILD_DIR" >&2
      return 1
      ;;
  esac
}

cleanup_live_sqlite_backup() {
  LIVE_SQLITE_BACKUP_DIR=""
  return 0
}

register_live_sqlite_prebuild_cleanup_state() {
  local stage_dir="$1"
  local identity device inode uid gid mode links extra
  [[ "$stage_dir" =~ ^/var/lib/football-release/live-sqlite-prebuild\.[A-Za-z0-9]{6}$ ]] || return 1

  # mktemp has already created the directory.  Register every derived path
  # before the first fallible validation so abort/EXIT can identify a partially
  # initialized prebuild without guessing from a directory glob.
  LIVE_SQLITE_PREBUILD_DIR="$stage_dir"
  LIVE_SQLITE_PREBUILD_PATH="${stage_dir}/football.db"
  LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST="${stage_dir}/source-seal.json"
  LIVE_SQLITE_PREBUILD_STAGE_MANIFEST="${stage_dir}/stage-seal.json"
  LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL="${stage_dir}/publication-seal.json"
  LIVE_SQLITE_PREBUILD_ROLLBACK_DIR="${stage_dir}/rollback"
  LIVE_SQLITE_PREBUILD_ROLLBACK_PATH="${stage_dir}/rollback/football.db"
  LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL="${stage_dir}/rollback-seal.json"
  LIVE_SQLITE_PREBUILD_DIR_DEVICE=""
  LIVE_SQLITE_PREBUILD_DIR_INODE=""
  LIVE_SQLITE_PREBUILD_READY=0
  LIVE_SQLITE_PREBUILD_ACTIVATED=0
  LIVE_SQLITE_PREBUILD_ADOPTED=0

  identity="$(stat -c '%d:%i:%u:%g:%a:%h' -- "$stage_dir")" || return 1
  IFS=: read -r device inode uid gid mode links extra <<<"$identity"
  [ -z "$extra" ] \
    && [[ "$device" =~ ^[0-9]+$ ]] \
    && [[ "$inode" =~ ^[0-9]+$ ]] \
    && [ "$uid" = "0" ] && [ "$gid" = "0" ] \
    && [ "$mode" = "700" ] && [ "$links" = "2" ] \
    && [ -d "$stage_dir" ] && [ ! -L "$stage_dir" ] || return 1
  LIVE_SQLITE_PREBUILD_DIR_DEVICE="$device"
  LIVE_SQLITE_PREBUILD_DIR_INODE="$inode"
  return 0
}

cleanup_live_sqlite_prebuild() {
  local stage_dir="${LIVE_SQLITE_PREBUILD_DIR:-}"
  local stage_path="${LIVE_SQLITE_PREBUILD_PATH:-}"
  local rollback_dir="${LIVE_SQLITE_PREBUILD_ROLLBACK_DIR:-}"
  local expected_device="${LIVE_SQLITE_PREBUILD_DIR_DEVICE:-}"
  local expected_inode="${LIVE_SQLITE_PREBUILD_DIR_INODE:-}"
  local identity device inode uid gid mode links extra
  [ -n "$stage_dir" ] || return 0
  [[ "$stage_dir" =~ ^/var/lib/football-release/live-sqlite-prebuild\.[A-Za-z0-9]{6}$ ]] || {
    printf 'refusing to clean unsafe live sqlite prebuild directory: %s\n' "$stage_dir" >&2
    return 1
  }
  [ "$stage_path" = "${stage_dir}/football.db" ] || return 1
  [ "${LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST:-}" = "${stage_dir}/source-seal.json" ] || return 1
  [ "${LIVE_SQLITE_PREBUILD_STAGE_MANIFEST:-}" = "${stage_dir}/stage-seal.json" ] || return 1
  [ "${LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL:-}" = "${stage_dir}/publication-seal.json" ] || return 1
  [ "$rollback_dir" = "${stage_dir}/rollback" ] || return 1
  [ "${LIVE_SQLITE_PREBUILD_ROLLBACK_PATH:-}" = "${rollback_dir}/football.db" ] || return 1
  [ "${LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL:-}" = "${stage_dir}/rollback-seal.json" ] || return 1
  if [ -e "$stage_dir" ] || [ -L "$stage_dir" ]; then
    identity="$(stat -c '%d:%i:%u:%g:%a:%h' -- "$stage_dir")" || return 1
    IFS=: read -r device inode uid gid mode links extra <<<"$identity"
    [ -z "$extra" ] \
      && [[ "$device" =~ ^[0-9]+$ ]] \
      && [[ "$inode" =~ ^[0-9]+$ ]] \
      && [ "$uid" = "0" ] && [ "$gid" = "0" ] \
      && [ "$mode" = "700" ] \
      && [[ "$links" =~ ^[0-9]+$ ]] && [ "$links" -ge 2 ] && [ "$links" -le 3 ] \
      && [ -d "$stage_dir" ] && [ ! -L "$stage_dir" ] || return 1
    if [ -n "$expected_device" ] || [ -n "$expected_inode" ]; then
      [ "$expected_device" = "$device" ] && [ "$expected_inode" = "$inode" ] || return 1
      rm -rf --one-file-system -- "$stage_dir" || return 1
    else
      # Registration can fail while capturing identity.  Only an unchanged,
      # empty mktemp directory is safe to remove without the recorded inode.
      [ "$links" = "2" ] \
        && [ -z "$(find "$stage_dir" -mindepth 1 -maxdepth 1 -print -quit)" ] || return 1
      rmdir -- "$stage_dir" || return 1
    fi
  fi
  LIVE_SQLITE_PREBUILD_DIR=""
  LIVE_SQLITE_PREBUILD_PATH=""
  LIVE_SQLITE_PREBUILD_DIR_DEVICE=""
  LIVE_SQLITE_PREBUILD_DIR_INODE=""
  LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST=""
  LIVE_SQLITE_PREBUILD_STAGE_MANIFEST=""
  LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL=""
  LIVE_SQLITE_PREBUILD_ROLLBACK_DIR=""
  LIVE_SQLITE_PREBUILD_ROLLBACK_PATH=""
  LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL=""
  LIVE_SQLITE_PREBUILD_READY=0
  LIVE_SQLITE_PREBUILD_ADOPTED=0
  return 0
}

snapshot_external_model_artifacts_for_rollback() {
  local snapshot_dir="${RECOVERY_DIR}/external-model-artifacts"
  local manifest="${snapshot_dir}/manifest.tsv"
  local index token artifact_path snapshot_file present bytes digest uid gid mode
  [ "$RECOVERY_ACTIVE" = "1" ] && [ -d "$RECOVERY_DIR" ] && [ ! -L "$RECOVERY_DIR" ] || return 1
  [ ! -e "$snapshot_dir" ] && [ ! -L "$snapshot_dir" ] || return 1
  [ "${#MODEL_ARTIFACT_TOKENS[@]}" -eq "${#MODEL_ARTIFACT_PATHS[@]}" ] || return 1
  install -d -o root -g root -m 0700 -- "$snapshot_dir" || return 1
  : >"$manifest"
  chown root:root "$manifest"
  chmod 0600 "$manifest"
  for index in "${!MODEL_ARTIFACT_TOKENS[@]}"; do
    token="${MODEL_ARTIFACT_TOKENS[$index]}"
    artifact_path="${MODEL_ARTIFACT_PATHS[$index]}"
    case "$token:$artifact_path" in
      strategy:/var/lib/football-predict/model-strategy.json|evaluation:/var/lib/football-predict/model-artifacts/evaluation.json|candidate-registry:/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json|candidate-challenger-suite:/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json|candidate-temperature-suite:/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json|candidate-common-cohort-g2-v1:/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json|candidate-common-cohort-g2-v2:/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json|candidate-capture-status:/var/lib/football-predict/candidate-prospective-capture-status.json|benchmark-prospective-ledger:/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json) ;;
      *) return 1 ;;
    esac
    snapshot_file="${snapshot_dir}/${token}"
    present=0
    bytes="-"
    digest="-"
    uid="-"
    gid="-"
    mode="-"
    if [ -e "$artifact_path" ] || [ -L "$artifact_path" ]; then
      [ -f "$artifact_path" ] && [ ! -L "$artifact_path" ] \
        && [ "$(stat -c '%h' -- "$artifact_path")" = "1" ] || return 1
      cp -a --no-dereference -- "$artifact_path" "$snapshot_file" || return 1
      [ -f "$snapshot_file" ] && [ ! -L "$snapshot_file" ] \
        && [ "$(stat -c '%h' -- "$snapshot_file")" = "1" ] || return 1
      present=1
      bytes="$(stat -c '%s' -- "$snapshot_file")"
      digest="$(sha256sum "$snapshot_file" | awk '{print $1}')"
      uid="$(stat -c '%u' -- "$artifact_path")"
      gid="$(stat -c '%g' -- "$artifact_path")"
      mode="$(stat -c '%a' -- "$artifact_path")"
      chown root:root "$snapshot_file" || return 1
      chmod 0600 "$snapshot_file" || return 1
      sync -f "$snapshot_file" || return 1
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$token" "$artifact_path" "$present" "$bytes" "$digest" "$uid" "$gid" "$mode" >>"$manifest"
  done
  sync -f "$manifest" || return 1
  sync -f "$snapshot_dir" || return 1
  write_recovery_phase "external-model-artifacts-snapshotted" || return 1
  log "captured exact external model artifact rollback state"
}

restore_external_model_artifacts_after_rollback() {
  local snapshot_dir="${RECOVERY_DIR}/external-model-artifacts"
  local manifest="${snapshot_dir}/manifest.tsv"
  local token artifact_path present bytes digest uid gid mode extra expected_path snapshot_file
  local actual_bytes actual_digest parent temporary line_count=0
  local -A seen_tokens=() present_by_token=() path_by_token=() bytes_by_token=() digest_by_token=()
  local -A uid_by_token=() gid_by_token=() mode_by_token=()
  [ "$RECOVERY_ACTIVE" = "1" ] || return 0
  [ "${#MODEL_ARTIFACT_TOKENS[@]}" -eq "${#MODEL_ARTIFACT_PATHS[@]}" ] || return 1
  [ -d "$snapshot_dir" ] && [ ! -L "$snapshot_dir" ] || return 1
  [ -f "$manifest" ] && [ ! -L "$manifest" ] \
    && [ "$(stat -c '%h' -- "$manifest")" = "1" ] || return 1
  while IFS=$'\t' read -r token artifact_path present bytes digest uid gid mode extra; do
    [ -n "$token" ] && [ -n "$artifact_path" ] && [ -z "${extra:-}" ] || return 1
    case "$token" in
      strategy) expected_path="/var/lib/football-predict/model-strategy.json" ;;
      evaluation) expected_path="/var/lib/football-predict/model-artifacts/evaluation.json" ;;
      candidate-registry) expected_path="/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json" ;;
      candidate-challenger-suite) expected_path="/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json" ;;
      candidate-temperature-suite) expected_path="/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json" ;;
      candidate-common-cohort-g2-v1) expected_path="/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json" ;;
      candidate-common-cohort-g2-v2) expected_path="/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json" ;;
      candidate-capture-status) expected_path="/var/lib/football-predict/candidate-prospective-capture-status.json" ;;
      benchmark-prospective-ledger) expected_path="/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json" ;;
      *) return 1 ;;
    esac
    [ "$artifact_path" = "$expected_path" ] || return 1
    [ -z "${seen_tokens[$token]:-}" ] || return 1
    seen_tokens[$token]=1
    line_count=$((line_count + 1))
    snapshot_file="${snapshot_dir}/${token}"
    if [ "$present" = "1" ]; then
      [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ \
        && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      [ -f "$snapshot_file" ] && [ ! -L "$snapshot_file" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$snapshot_file")" = "0:0:600:1" ] || return 1
      actual_bytes="$(stat -c '%s' -- "$snapshot_file")"
      actual_digest="$(sha256sum "$snapshot_file" | awk '{print $1}')"
      [ "$actual_bytes" = "$bytes" ] && [ "$actual_digest" = "$digest" ] || return 1
    elif [ "$present" = "0" ]; then
      [ "$bytes" = "-" ] && [ "$digest" = "-" ] && [ "$uid" = "-" ] \
        && [ "$gid" = "-" ] && [ "$mode" = "-" ] || return 1
      [ ! -e "$snapshot_file" ] && [ ! -L "$snapshot_file" ] || return 1
    else
      return 1
    fi
    present_by_token[$token]="$present"
    path_by_token[$token]="$artifact_path"
    bytes_by_token[$token]="$bytes"
    digest_by_token[$token]="$digest"
    uid_by_token[$token]="$uid"
    gid_by_token[$token]="$gid"
    mode_by_token[$token]="$mode"
  done <"$manifest"
  [ "$line_count" -eq "${#MODEL_ARTIFACT_TOKENS[@]}" ] || return 1
  for token in "${MODEL_ARTIFACT_TOKENS[@]}"; do
    [ "${seen_tokens[$token]:-0}" = "1" ] || return 1
    artifact_path="${path_by_token[$token]}"
    parent="$(dirname "$artifact_path")"
    if [ "${present_by_token[$token]}" = "1" ]; then
      [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    elif [ -e "$parent" ] || [ -L "$parent" ]; then
      [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    fi
    [ ! -d "$artifact_path" ] || return 1
  done

  for token in "${MODEL_ARTIFACT_TOKENS[@]}"; do
    artifact_path="${path_by_token[$token]}"
    parent="$(dirname "$artifact_path")"
    snapshot_file="${snapshot_dir}/${token}"
    if [ "${present_by_token[$token]}" = "1" ]; then
      temporary="$(mktemp "${parent}/.${artifact_path##*/}.rollback.XXXXXX")" || return 1
      rm -f -- "$temporary" || return 1
      cp -a --no-dereference -- "$snapshot_file" "$temporary" || return 1
      [ -f "$temporary" ] && [ ! -L "$temporary" ] \
        && [ "$(stat -c '%h' -- "$temporary")" = "1" ] || return 1
      actual_bytes="$(stat -c '%s' -- "$temporary")"
      actual_digest="$(sha256sum "$temporary" | awk '{print $1}')"
      [ "$actual_bytes" = "${bytes_by_token[$token]}" ] \
        && [ "$actual_digest" = "${digest_by_token[$token]}" ] || return 1
      chown "${uid_by_token[$token]}:${gid_by_token[$token]}" "$temporary" || return 1
      chmod "${mode_by_token[$token]}" "$temporary" || return 1
      sync -f "$temporary" || return 1
      mv -fT -- "$temporary" "$artifact_path" || return 1
      sync -f "$parent" || return 1
    elif [ -d "$parent" ] && [ ! -L "$parent" ]; then
      rm -f -- "$artifact_path" || return 1
      sync -f "$parent" || return 1
    fi
  done
  log "restored exact external model artifact rollback state"
}

backup_live_sqlite_for_rollback() {
  local sqlite_path="$1"
  local sqlite_name="${sqlite_path##*/}"
  local token suffix present bytes digest uid gid mode snapshot_file base_present=0
  local -a sqlite_tokens=(base wal shm)
  [ "${ALLOW_STOPPED_WINDOW_SQLITE_EXPORT:-0}" = "1" ] || {
    printf 'stopped-window SQLite rollback copy is restricted to explicit break-glass\n' >&2
    return 1
  }
  [ "$RECOVERY_ACTIVE" = "1" ] && [ -d "$RECOVERY_DIR" ] || return 1
  LIVE_SQLITE_PATH="$sqlite_path"
  LIVE_SQLITE_BACKUP_DIR="${RECOVERY_DIR}/sqlite"
  [ ! -e "$LIVE_SQLITE_BACKUP_DIR" ] && [ ! -L "$LIVE_SQLITE_BACKUP_DIR" ] || return 1
  install -d -o root -g root -m 0700 -- "$LIVE_SQLITE_BACKUP_DIR" || return 1
  printf '%s\n' "$sqlite_path" >"${LIVE_SQLITE_BACKUP_DIR}/live-path"
  : >"${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  chown root:root "${LIVE_SQLITE_BACKUP_DIR}/live-path" "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  chmod 0600 "${LIVE_SQLITE_BACKUP_DIR}/live-path" "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  for token in "${sqlite_tokens[@]}"; do
    case "$token" in
      base) suffix="" ;;
      wal) suffix="-wal" ;;
      shm) suffix="-shm" ;;
      *) return 1 ;;
    esac
    present=0
    bytes="-"
    digest="-"
    uid="-"
    gid="-"
    mode="-"
    snapshot_file="${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}"
    if [ -e "${sqlite_path}${suffix}" ] || [ -L "${sqlite_path}${suffix}" ]; then
      [ -f "${sqlite_path}${suffix}" ] && [ ! -L "${sqlite_path}${suffix}" ] \
        && [ "$(stat -c '%h' -- "${sqlite_path}${suffix}")" = "1" ] || return 1
      cp -a --no-dereference -- "${sqlite_path}${suffix}" "$snapshot_file" || return 1
      present=1
      bytes="$(stat -c '%s' -- "$snapshot_file")"
      digest="$(sha256sum "$snapshot_file" | awk '{print $1}')"
      uid="$(stat -c '%u' -- "${sqlite_path}${suffix}")"
      gid="$(stat -c '%g' -- "${sqlite_path}${suffix}")"
      mode="$(stat -c '%a' -- "${sqlite_path}${suffix}")"
      chown root:root "$snapshot_file" || return 1
      chmod 0600 "$snapshot_file" || return 1
      sync -f "$snapshot_file" || return 1
      [ "$token" != "base" ] || base_present=1
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$token" "$present" "$bytes" "$digest" "$uid" "$gid" "$mode" >>"${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  done
  [ "$base_present" = "1" ] || return 1
  sync -f "${LIVE_SQLITE_BACKUP_DIR}/live-path"
  sync -f "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  sync -f "$LIVE_SQLITE_BACKUP_DIR"
  write_recovery_phase "sqlite-snapshotted" || return 1
  log "captured live sqlite rollback state at ${LIVE_SQLITE_BACKUP_DIR}"
}

validate_prebuilt_live_sqlite_publication() {
  local module_root="$1"
  local store_dir="$2"
  local public_data_dir="$3"
  local sqlite_path="$4"
  local run_quick_check="${5:-0}"
  local validation_mode="${6:-full-capture}"
  local publication_seal_path="${7:-}"
  local stage_seal_path="${8:-}"
  [ -f "$sqlite_path" ] && [ ! -L "$sqlite_path" ] \
    && [ "$(stat -c '%h' -- "$sqlite_path")" = "1" ] || return 1
  "$NODE_HOME/bin/node" - \
    "$module_root" "$store_dir" "$public_data_dir" "$sqlite_path" "$run_quick_check" \
    "$validation_mode" "$publication_seal_path" "$stage_seal_path" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const [
  moduleRoot,
  storeDir,
  publicDataDir,
  sqlitePath,
  runQuickCheck,
  validationMode,
  publicationSealPath,
  stageSealPath,
] = process.argv.slice(2);
const PUBLICATION_SEAL_VERSION = "release-prebuilt-publication-seal-v1";
const PUBLICATION_IDENTITY_VERSION = "immutable-base-generation-v1";
const STAGE_SEAL_VERSION = "release-sqlite-seal-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATION_ID_PATTERN = /^g-[a-f0-9]{64}$/u;
const POINTER_FIELDS = Object.freeze([
  "schemaVersion",
  "generationId",
  "sourceCycleId",
  "manifestHash",
  "committedAt",
]);
const PUBLICATION_FIELDS = Object.freeze([
  "version",
  "mode",
  "generationId",
  "manifestHash",
  "sourceCycleId",
  "committedAt",
  "active",
]);
const METADATA_FIELDS = Object.freeze([
  "dev",
  "ino",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
  "uid",
  "gid",
  "mode",
]);

const modeOf = (stat) => String(Number(stat.mode & 0o7777n).toString(8));
const metadataFromStat = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  nlink: String(stat.nlink),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
  uid: String(stat.uid),
  gid: String(stat.gid),
  mode: modeOf(stat),
});
const sameMetadata = (left, right) => METADATA_FIELDS.every(
  (key) => String(left?.[key] ?? "") === String(right?.[key] ?? ""),
);
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has an unexpected shape`);
  }
};
const openStableRegularFile = (filePath, { maxBytes = null } = {}) => {
  const resolvedPath = path.resolve(filePath);
  const beforePath = fs.lstatSync(resolvedPath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
    throw new Error(`unsafe release validation file: ${resolvedPath}`);
  }
  if (maxBytes !== null && beforePath.size > BigInt(maxBytes)) {
    throw new Error(`release validation file is too large: ${resolvedPath}`);
  }
  const descriptor = fs.openSync(
    resolvedPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || !sameMetadata(metadataFromStat(beforePath), metadataFromStat(before))) {
      throw new Error(`release validation path changed while opening: ${resolvedPath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(metadataFromStat(before), metadataFromStat(after))) {
      throw new Error(`release validation file changed while reading: ${resolvedPath}`);
    }
    return Object.freeze({
      path: resolvedPath,
      bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      metadata: Object.freeze(metadataFromStat(before)),
    });
  } finally {
    fs.closeSync(descriptor);
  }
};
const observeStableRegularFileMetadata = (filePath) => {
  const resolvedPath = path.resolve(filePath);
  const beforePath = fs.lstatSync(resolvedPath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
    throw new Error(`unsafe release validation file: ${resolvedPath}`);
  }
  const descriptor = fs.openSync(
    resolvedPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const observed = fs.fstatSync(descriptor, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1n
        || !sameMetadata(metadataFromStat(beforePath), metadataFromStat(observed))) {
      throw new Error(`release validation path changed while observing metadata: ${resolvedPath}`);
    }
    return Object.freeze({
      path: resolvedPath,
      metadata: Object.freeze(metadataFromStat(observed)),
    });
  } finally {
    fs.closeSync(descriptor);
  }
};
const parseJsonObservation = (observation, label) => {
  try {
    return JSON.parse(observation.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
};
const assertPointer = (pointer, label) => {
  exactKeys(pointer, POINTER_FIELDS, label);
  if (pointer.schemaVersion !== 1
      || !GENERATION_ID_PATTERN.test(String(pointer.generationId || ""))
      || !HASH_PATTERN.test(String(pointer.manifestHash || ""))
      || typeof pointer.sourceCycleId !== "string" || !pointer.sourceCycleId.trim()
      || !Number.isFinite(Date.parse(String(pointer.committedAt || "")))) {
    throw new Error(`${label} is invalid`);
  }
  return pointer;
};
const publicationIdentityFrom = (value, label) => {
  exactKeys(value, PUBLICATION_FIELDS, label);
  if (value.version !== PUBLICATION_IDENTITY_VERSION
      || value.mode !== "active-generation"
      || value.active !== true
      || !GENERATION_ID_PATTERN.test(String(value.generationId || ""))
      || !HASH_PATTERN.test(String(value.manifestHash || ""))
      || typeof value.sourceCycleId !== "string" || !value.sourceCycleId.trim()
      || !Number.isFinite(Date.parse(String(value.committedAt || "")))) {
    throw new Error(`${label} is invalid`);
  }
  return Object.fromEntries(PUBLICATION_FIELDS.map((key) => [key, value[key]]));
};
const assertPointerMatchesIdentity = (pointer, identity, label) => {
  const checks = [
    ["generationId", identity.generationId],
    ["manifestHash", identity.manifestHash],
    ["sourceCycleId", identity.sourceCycleId],
    ["committedAt", identity.committedAt],
  ];
  for (const [key, expected] of checks) {
    if (String(pointer[key]) !== String(expected)) {
      throw new Error(`${label} mismatch for ${key}`);
    }
  }
};
const assertStageSeal = (stageSeal, sqliteObservation) => {
  exactKeys(stageSeal, ["version", "basePath", "entries"], "stage SQLite seal");
  if (stageSeal.version !== STAGE_SEAL_VERSION
      || path.resolve(stageSeal.basePath || "") !== path.resolve(sqlitePath)
      || !Array.isArray(stageSeal.entries) || stageSeal.entries.length !== 2) {
    throw new Error("stage SQLite seal is invalid");
  }
  const [base, wal] = stageSeal.entries;
  if (base?.token !== "base" || base.present !== true
      || wal?.token !== "wal" || typeof wal.present !== "boolean") {
    throw new Error("stage SQLite seal entries are invalid");
  }
  for (const entry of stageSeal.entries) {
    const allowed = entry.present
      ? ["token", "present", ...METADATA_FIELDS, "sha256"]
      : ["token", "present"];
    exactKeys(entry, allowed, `stage SQLite seal entry ${entry.token || "unknown"}`);
    if (!entry.present) continue;
    if (!HASH_PATTERN.test(String(entry.sha256 || "")) || entry.nlink !== "1"
        || METADATA_FIELDS.some((key) => !/^\d+$/u.test(String(entry[key] || "")))) {
      throw new Error(`stage SQLite seal entry is invalid: ${entry.token}`);
    }
  }
  if (!sameMetadata(base, sqliteObservation.metadata)) {
    throw new Error("stage SQLite metadata no longer matches its trusted seal");
  }
  return base;
};
const readSqlitePublicationMeta = () => {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (runQuickCheck === "1") {
      if (validationMode !== "full-capture") {
        throw new Error("pointer-only publication validation cannot run quick_check");
      }
      const quickCheck = Object.values(db.prepare("PRAGMA quick_check").get() || {})[0];
      if (quickCheck !== "ok") throw new Error(`prebuilt SQLite quick_check failed: ${quickCheck}`);
    }
    const rows = db.prepare(`
      SELECT key, value FROM schema_meta
      WHERE key IN (
        'data_publication_mode',
        'data_generation_id',
        'manifest_hash',
        'data_generation_source_cycle_id',
        'committed_at'
      )
    `).all();
    if (rows.length !== 5) throw new Error("prebuilt SQLite publication metadata is incomplete");
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value ?? "")]));
  } finally {
    db.close();
  }
};
const assertSqliteMetaMatchesIdentity = (meta, identity) => {
  const checks = [
    ["data_publication_mode", identity.mode],
    ["data_generation_id", identity.generationId],
    ["manifest_hash", identity.manifestHash],
    ["data_generation_source_cycle_id", identity.sourceCycleId],
    ["committed_at", identity.committedAt],
  ];
  for (const [key, expected] of checks) {
    if (meta[key] !== String(expected)) {
      throw new Error(`prebuilt SQLite publication CAS mismatch for ${key}`);
    }
  }
};
const assertRecordedObservation = (recorded, actual, label) => {
  exactKeys(recorded, ["path", ...METADATA_FIELDS, "sha256"], label);
  if (recorded.path !== actual.path || recorded.sha256 !== actual.sha256
      || !HASH_PATTERN.test(String(recorded.sha256 || ""))
      || !sameMetadata(recorded, actual.metadata)) {
    throw new Error(`${label} changed after online validation`);
  }
};
const observationRecord = (observation) => Object.freeze({
  path: observation.path,
  ...observation.metadata,
  sha256: observation.sha256,
});
const relativeTreePath = (root, absolutePath) => {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative === "." || relative === ".." || relative.startsWith("../")) {
    throw new Error(`unsafe active generation tree path: ${absolutePath}`);
  }
  return relative;
};
const listGenerationTreeMetadata = (generationDir) => {
  const root = path.resolve(generationDir);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("active generation root is unsafe");
  }
  const directories = [];
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeTreePath(root, absolutePath);
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`active generation tree contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        directories.push({ path: relativePath, ...metadataFromStat(stat) });
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw new Error(`active generation tree contains an unsafe entry: ${relativePath}`);
      }
      files.push({ path: relativePath, ...metadataFromStat(stat) });
    }
  };
  visit(root);
  return Object.freeze({
    root,
    rootMetadata: Object.freeze(metadataFromStat(rootStat)),
    directories: Object.freeze(directories),
    files: Object.freeze(files),
  });
};
const captureValidatedGenerationTree = (publication) => {
  const context = publication?.context;
  const observed = listGenerationTreeMetadata(context?.generationDir || "");
  const declared = new Map((context?.manifest?.files || []).map((entry) => [entry.path, entry]));
  const expectedPaths = ["manifest.json", ...declared.keys()].sort((left, right) => left.localeCompare(right, "en"));
  const observedPaths = observed.files.map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(expectedPaths) !== JSON.stringify(observedPaths)) {
    throw new Error("active generation contains files outside the fully validated manifest set");
  }
  const files = observed.files.map((entry) => {
    if (entry.path === "manifest.json") {
      const manifestObservation = openStableRegularFile(path.join(observed.root, "manifest.json"), {
        maxBytes: 16 * 1024 * 1024,
      });
      if (!sameMetadata(entry, manifestObservation.metadata)) {
        throw new Error("active generation manifest changed after full validation");
      }
      return Object.freeze({ ...entry, validatedSha256: manifestObservation.sha256 });
    }
    const manifestEntry = declared.get(entry.path);
    if (!manifestEntry || String(manifestEntry.bytes) !== entry.size
        || !HASH_PATTERN.test(String(manifestEntry.sha256 || ""))) {
      throw new Error(`active generation metadata disagrees with its validated manifest: ${entry.path}`);
    }
    return Object.freeze({ ...entry, validatedSha256: manifestEntry.sha256 });
  });
  return Object.freeze({ ...observed, files: Object.freeze(files) });
};
const assertSealedGenerationTreeUnchanged = (sealedTree, identity) => {
  exactKeys(sealedTree, ["root", "rootMetadata", "directories", "files"], "sealed generation tree");
  const expectedRoot = path.join(
    path.resolve(storeDir),
    "data-generations",
    "generations",
    identity.generationId,
  );
  if (sealedTree.root !== expectedRoot) throw new Error("sealed generation root is invalid");
  const actual = listGenerationTreeMetadata(expectedRoot);
  if (!sameMetadata(sealedTree.rootMetadata, actual.rootMetadata)) {
    throw new Error("active generation root metadata changed after online validation");
  }
  if (JSON.stringify(sealedTree.directories) !== JSON.stringify(actual.directories)) {
    throw new Error("active generation directory set or metadata changed after online validation");
  }
  if (!Array.isArray(sealedTree.files)) throw new Error("sealed generation file set is invalid");
  const sealedMetadata = sealedTree.files.map((entry) => {
    exactKeys(entry, ["path", ...METADATA_FIELDS, "validatedSha256"], `sealed generation file ${entry?.path || "unknown"}`);
    if (!HASH_PATTERN.test(String(entry.validatedSha256 || ""))) {
      throw new Error(`sealed generation file digest is invalid: ${entry.path}`);
    }
    return Object.fromEntries(["path", ...METADATA_FIELDS].map((key) => [key, entry[key]]));
  });
  if (JSON.stringify(sealedMetadata) !== JSON.stringify(actual.files)) {
    throw new Error("active generation exact file set or metadata changed after online validation");
  }
};
const writeSealExclusive = (sealPath, payload) => {
  if (path.dirname(path.resolve(sealPath)) !== path.dirname(path.resolve(sqlitePath))) {
    throw new Error("publication seal must share the private SQLite prebuild directory");
  }
  const descriptor = fs.openSync(
    path.resolve(sealPath),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

if (!["full-capture", "pointer-only"].includes(validationMode)) {
  throw new Error(`unsupported prebuilt publication validation mode: ${validationMode}`);
}
if (!publicationSealPath || !stageSealPath) {
  throw new Error("publication and stage seal paths are required");
}
// Never stream or hash the potentially multi-gigabyte SQLite database here.
// Its digest was captured by sqliteReleaseSeal during the online prebuild;
// the freeze path performs only its nanosecond metadata CAS plus five indexed
// schema_meta lookups.
const sqliteObservation = observeStableRegularFileMetadata(sqlitePath);
const stageSealObservation = openStableRegularFile(stageSealPath, { maxBytes: 1024 * 1024 });
const stageSeal = parseJsonObservation(stageSealObservation, "stage SQLite seal");
const stageBaseEntry = assertStageSeal(stageSeal, sqliteObservation);
const pointerPath = path.join(path.resolve(storeDir), "data-generations", "current.json");
const pointerObservation = openStableRegularFile(pointerPath, { maxBytes: 64 * 1024 });
const currentPointer = assertPointer(
  parseJsonObservation(pointerObservation, "current generation pointer"),
  "current generation pointer",
);
const sqliteMeta = readSqlitePublicationMeta();

if (validationMode === "full-capture") {
  const { resolveActivePublication } = require(
    path.join(moduleRoot, "server", "dataGenerationBundle.cjs"),
  );
  const publication = resolveActivePublication({ storeDir, publicDataDir });
  if (publication?.mode !== "active-generation" || !publication?.identity?.generationId) {
    throw new Error("prebuilt SQLite requires an active immutable generation");
  }
  const identity = publicationIdentityFrom(publication.identity, "active publication identity");
  const resolvedPointer = assertPointer(publication?.context?.pointer, "resolved publication pointer");
  if (JSON.stringify(resolvedPointer) !== JSON.stringify(currentPointer)) {
    throw new Error("full publication validation resolved a different current pointer");
  }
  assertPointerMatchesIdentity(currentPointer, identity, "active publication pointer");
  assertSqliteMetaMatchesIdentity(sqliteMeta, identity);
  const generationTree = captureValidatedGenerationTree(publication);
  writeSealExclusive(publicationSealPath, {
    version: PUBLICATION_SEAL_VERSION,
    publicationIdentity: identity,
    pointer: currentPointer,
    pointerFile: observationRecord(pointerObservation),
    stageSealFile: observationRecord(stageSealObservation),
    stageBaseEntry,
    generationTree,
  });
} else {
  const publicationSealObservation = openStableRegularFile(
    publicationSealPath,
    { maxBytes: 256 * 1024 },
  );
  const seal = parseJsonObservation(publicationSealObservation, "prebuilt publication seal");
  exactKeys(
    seal,
    [
      "version",
      "publicationIdentity",
      "pointer",
      "pointerFile",
      "stageSealFile",
      "stageBaseEntry",
      "generationTree",
    ],
    "prebuilt publication seal",
  );
  if (seal.version !== PUBLICATION_SEAL_VERSION) {
    throw new Error("prebuilt publication seal version is invalid");
  }
  const identity = publicationIdentityFrom(seal.publicationIdentity, "sealed publication identity");
  const sealedPointer = assertPointer(seal.pointer, "sealed generation pointer");
  if (JSON.stringify(sealedPointer) !== JSON.stringify(currentPointer)) {
    throw new Error("current generation pointer changed after online validation");
  }
  assertRecordedObservation(seal.pointerFile, pointerObservation, "current generation pointer file");
  assertRecordedObservation(seal.stageSealFile, stageSealObservation, "stage SQLite seal file");
  if (JSON.stringify(seal.stageBaseEntry) !== JSON.stringify(stageBaseEntry)) {
    throw new Error("stage SQLite base seal changed after online validation");
  }
  assertPointerMatchesIdentity(currentPointer, identity, "sealed publication pointer");
  assertSqliteMetaMatchesIdentity(sqliteMeta, identity);
  assertSealedGenerationTreeUnchanged(seal.generationTree, identity);
}
NODE
}

prepare_live_sqlite_prebuild() {
  local store_dir="$1"
  local sqlite_path="$2"
  local stage_dir stage_path source_manifest stage_manifest publication_seal helper_path
  local rollback_dir rollback_path rollback_seal seal_helper
  case "$store_dir" in
    /*) ;;
    *) printf 'live SQLite prebuild requires an absolute store directory\n' >&2; return 1 ;;
  esac
  [ "$sqlite_path" = "${store_dir%/}/football.db" ] || {
    printf 'live SQLite prebuild source must be the configured live database\n' >&2
    return 1
  }
  [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || {
    printf 'live SQLite prebuild requires the heavyweight sync worker to be stopped\n' >&2
    return 1
  }
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 \
    && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
    printf 'live SQLite prebuild refuses to overlap an active sync worker\n' >&2
    return 1
  fi
  release_sync_write_barrier_is_healthy || {
    printf 'live SQLite prebuild requires the canonical sync write barrier\n' >&2
    return 1
  }
  cleanup_live_sqlite_prebuild || return 1
  assert_recovery_root_safe || return 1
  stage_dir="$(mktemp -d /var/lib/football-release/live-sqlite-prebuild.XXXXXX)" || return 1
  register_live_sqlite_prebuild_cleanup_state "$stage_dir" || return 1
  stage_path="$LIVE_SQLITE_PREBUILD_PATH"
  source_manifest="$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST"
  stage_manifest="$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST"
  publication_seal="$LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL"
  rollback_dir="$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR"
  rollback_path="$LIVE_SQLITE_PREBUILD_ROLLBACK_PATH"
  rollback_seal="$LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL"
  helper_path="${stage_dir}/prepare.sh"
  seal_helper="${NEXT_DIR}/scripts/sqliteReleaseSeal.cjs"
  [ -f "$seal_helper" ] && [ ! -L "$seal_helper" ] \
    && [ "$(stat -c '%h' -- "$seal_helper")" = "1" ] || return 1
  install -d -o root -g root -m 0700 -- "$rollback_dir" || return 1
  for file in "$stage_path" "${stage_path}-wal" "${stage_path}-shm" \
    "$rollback_path" "${rollback_path}-wal" "${rollback_path}-shm" \
    "${rollback_dir}/live-path" "${rollback_dir}/manifest.tsv" \
    "$source_manifest" "$stage_manifest" "$publication_seal" "$rollback_seal" "$helper_path"; do
    [ ! -e "$file" ] && [ ! -L "$file" ] || return 1
  done
  ( umask 077; set -o noclobber; cat >"$helper_path" <<'PREBUILD_HELPER'
#!/usr/bin/env bash
set -euo pipefail
sqlite_path="$1"
stage_path="$2"
source_manifest="$3"
stage_manifest="$4"
node_bin="$5"
next_dir="$6"
store_dir="$7"
seal_helper="$8"
rollback_path="$9"
rollback_seal="${10}"
run_prebuild_stage() {
  local stage_name="$1"
  shift
  local started_at started_epoch finished_at finished_epoch elapsed_seconds rc status
  started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  started_epoch="$(date -u +'%s')"
  printf '[release-live-sqlite-prebuild] stage=%s event=start at=%s\n' "$stage_name" "$started_at"
  set +e
  ( set -euo pipefail; "$@" )
  rc="$?"
  set -e
  finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  finished_epoch="$(date -u +'%s')"
  elapsed_seconds=$((finished_epoch - started_epoch))
  status=ok
  [ "$rc" -eq 0 ] || status=failed
  printf '[release-live-sqlite-prebuild] stage=%s event=finish at=%s elapsedSeconds=%s status=%s exitCode=%s\n' \
    "$stage_name" "$finished_at" "$elapsed_seconds" "$status" "$rc"
  return "$rc"
  }

copy_rollback_stage() {
  "$node_bin" "$seal_helper" copy-rollback \
    --source-base "$sqlite_path" \
    --snapshot-base "$rollback_path" \
    --source-seal-output "$source_manifest" \
    --snapshot-seal-output "$rollback_seal" \
    --max-attempts 4 \
    --retry-delay-ms 250
  }

verify_production_clone_migration() {
  "$node_bin" "$next_dir/scripts/verifyFastResultProductionClone.cjs" \
    --sqlite-path "$rollback_path" --require-receipt
  }

stage_copy_stage() {
  cp --reflink=auto --sparse=always --no-preserve=ownership,mode,timestamps --no-dereference \
    -- "$rollback_path" "$stage_path"
  if [ -f "${rollback_path}-wal" ] && [ ! -L "${rollback_path}-wal" ]; then
    cp --reflink=auto --sparse=always --no-preserve=ownership,mode,timestamps --no-dereference \
      -- "${rollback_path}-wal" "${stage_path}-wal"
  fi
  chmod 0600 "$stage_path"
  [ ! -e "${stage_path}-wal" ] || chmod 0600 "${stage_path}-wal"
  }

export_stage() {
  env SERVER_STORE_DIR="$store_dir" DATASTORE_SQLITE_PATH="$stage_path" \
    SQLITE_EXPORT_PUBLIC_DATA_DIR="$next_dir/public/data" \
    SQLITE_EXPORT_SOURCE_POINTER_READ_ONLY=1 \
    SQLITE_VACUUM_AFTER_EXPORT=0 SQLITE_MAINTENANCE_WINDOW=release-stopped \
    SQLITE_WAL_CHECKPOINT_MODE=TRUNCATE \
    "$node_bin" "$next_dir/scripts/exportDataStoreSqlite.cjs"
  }

quick_check_stage() {
  "$node_bin" -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  try {
    const result = Object.values(db.prepare("PRAGMA quick_check").get() || {})[0];
    if (result !== "ok") throw new Error(`prebuilt SQLite quick_check failed: ${result}`);
  } finally { db.close(); }
' "$stage_path"
  }

seal_stage() {
  "$node_bin" "$seal_helper" verify-metadata --base "$sqlite_path" --seal "$source_manifest"
  "$node_bin" "$seal_helper" capture --base "$stage_path" --output "$stage_manifest"
  chmod 0600 "$source_manifest" "$stage_manifest" "$rollback_seal"
  sync -f "$stage_path"
  [ ! -e "${stage_path}-wal" ] || sync -f "${stage_path}-wal"
  sync -f "$source_manifest"; sync -f "$stage_manifest"; sync -f "$rollback_seal"
  sync -f "$(dirname "$rollback_path")"; sync -f "$(dirname "$stage_path")"
  }

run_prebuild_stage copy-rollback copy_rollback_stage
run_prebuild_stage production-clone-migration verify_production_clone_migration
run_prebuild_stage stage-copy stage_copy_stage
run_prebuild_stage export export_stage
run_prebuild_stage quick_check quick_check_stage
run_prebuild_stage seal seal_stage
PREBUILD_HELPER
  ) || return 1
  chown root:root "$helper_path" || return 1
  chmod 0500 "$helper_path" || return 1
  run_live_sqlite_prebuild_step live-sqlite-prebuild \
    "$helper_path" "$sqlite_path" "$stage_path" "$source_manifest" "$stage_manifest" \
      "$NODE_HOME/bin/node" "$NEXT_DIR" "$store_dir" "$seal_helper" "$rollback_path" "$rollback_seal" \
    || return 1
  validate_prebuilt_live_sqlite_publication \
    "$NEXT_DIR" "$store_dir" "$NEXT_DIR/public/data" "$stage_path" 0 \
    full-capture "$publication_seal" "$stage_manifest" || return 1
  rm -f -- "$helper_path" || return 1
  [ "$(stat -c '%u:%g:%a' -- "$stage_dir")" = "0:0:700" ] || return 1
  [ -d "$rollback_dir" ] && [ ! -L "$rollback_dir" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$rollback_dir")" = "0:0:700:2" ] || return 1
  for file in "$stage_path" "$source_manifest" "$stage_manifest" "$publication_seal" \
    "$rollback_path" "$rollback_seal"; do
    [ -f "$file" ] && [ ! -L "$file" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$file")" = "0:0:600:1" ] || return 1
  done
  if [ -e "${stage_path}-wal" ]; then
    [ -f "${stage_path}-wal" ] && [ ! -L "${stage_path}-wal" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "${stage_path}-wal")" = "0:0:600:1" ] || return 1
  fi
  if [ -e "${rollback_path}-wal" ]; then
    [ -f "${rollback_path}-wal" ] && [ ! -L "${rollback_path}-wal" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "${rollback_path}-wal")" = "0:0:600:1" ] || return 1
  fi
  LIVE_SQLITE_PREBUILD_READY=1
  log "prepared release-live-sqlite-prebuild-v1 while HTTP remained available"
}

verify_live_sqlite_prebuild_after_freeze() {
  local seal_helper="${TRUSTED_SOURCE_DIR}/scripts/sqliteReleaseSeal.cjs"
  [ "${LIVE_SQLITE_PREBUILD_READY:-0}" = "1" ] || return 1
  release_pointer_commit_keeper_is_healthy || {
    printf 'post-freeze SQLite validation requires the canonical pointer keeper\n' >&2
    return 1
  }
  [ "$RECOVERY_ACTIVE" = "1" ] && [ -d "$RECOVERY_DIR" ] && [ ! -L "$RECOVERY_DIR" ] || return 1
  [ -f "$seal_helper" ] && [ ! -L "$seal_helper" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$seal_helper")" = "0:0:600:1" ] || return 1
  [ -d "$LIVE_SQLITE_PREBUILD_DIR" ] && [ ! -L "$LIVE_SQLITE_PREBUILD_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$LIVE_SQLITE_PREBUILD_DIR")" = "0:0:700" ] || return 1
  [ -d "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" ] && [ ! -L "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR")" = "0:0:700:2" ] || return 1
  [ -f "$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST" ] \
    && [ ! -L "$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST")" = "0:0:600:1" ] \
    || return 1
  [ -f "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" ] \
    && [ ! -L "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST")" = "0:0:600:1" ] \
    || return 1
  [ -f "$LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL" ] \
    && [ ! -L "$LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL")" = "0:0:600:1" ] \
    || return 1
  [ -f "$LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL" ] \
    && [ ! -L "$LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL")" = "0:0:600:1" ] \
    || return 1
  [ ! -e "${RECOVERY_DIR}/sqlite" ] && [ ! -L "${RECOVERY_DIR}/sqlite" ] || return 1
  "$NODE_HOME/bin/node" "$seal_helper" finalize-recovery \
    --live-base "$LIVE_SQLITE_PATH" \
    --snapshot-base "$LIVE_SQLITE_PREBUILD_ROLLBACK_PATH" \
    --source-seal "$LIVE_SQLITE_PREBUILD_SOURCE_MANIFEST" \
    --snapshot-seal "$LIVE_SQLITE_PREBUILD_ROLLBACK_SEAL" \
    --live-path-output "${LIVE_SQLITE_PREBUILD_ROLLBACK_DIR}/live-path" \
    --manifest-output "${LIVE_SQLITE_PREBUILD_ROLLBACK_DIR}/manifest.tsv" \
    || return 1
  "$NODE_HOME/bin/node" "$seal_helper" verify-metadata \
    --base "$LIVE_SQLITE_PREBUILD_PATH" --seal "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" \
    || return 1
  validate_prebuilt_live_sqlite_publication \
    "$NEXT_DIR" "$LIVE_STORE_DIR" "$NEXT_DIR/public/data" "$LIVE_SQLITE_PREBUILD_PATH" 0 \
    pointer-only "$LIVE_SQLITE_PREBUILD_PUBLICATION_SEAL" "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" \
    || return 1
  release_pointer_commit_keeper_is_healthy || {
    printf 'canonical pointer keeper changed during post-freeze SQLite validation\n' >&2
    return 1
  }
  sync -f "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" || return 1
  mv -T -- "$LIVE_SQLITE_PREBUILD_ROLLBACK_DIR" "${RECOVERY_DIR}/sqlite" || return 1
  sync -f "$RECOVERY_DIR" || return 1
  sync -f "$LIVE_SQLITE_PREBUILD_DIR" || return 1
  LIVE_SQLITE_BACKUP_DIR="${RECOVERY_DIR}/sqlite"
  LIVE_SQLITE_PREBUILD_ADOPTED=1
  write_recovery_phase "sqlite-snapshotted" || return 1
  log "post-freeze O(1) source/stage seal CAS accepted the transient rollback snapshot"
}

activate_prebuilt_live_sqlite() {
  local stage_path="$LIVE_SQLITE_PREBUILD_PATH"
  local seal_helper="${TRUSTED_SOURCE_DIR}/scripts/sqliteReleaseSeal.cjs"
  [ "${LIVE_SQLITE_PREBUILD_READY:-0}" = "1" ] \
    && [ "${SWAP_STARTED:-0}" = "1" ] \
    && [ "${SERVICE_STOPPED_FOR_SWAP:-0}" = "1" ] \
    && [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || return 1
  [ -f "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" ] \
    && [ ! -L "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST")" = "0:0:600:1" ] \
    || return 1
  [ -f "$stage_path" ] && [ ! -L "$stage_path" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$stage_path")" = "0:0:600:1" ] \
    || return 1
  [ -d "$LIVE_SQLITE_PREBUILD_DIR" ] && [ ! -L "$LIVE_SQLITE_PREBUILD_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$LIVE_SQLITE_PREBUILD_DIR")" = "0:0:700" ] || return 1
  [ -f "$seal_helper" ] && [ ! -L "$seal_helper" ] || return 1
  # The full stage digest and SQLite integrity check ran inside the bounded transient.
  # The root-private directory makes the nanosecond inode seal sufficient here,
  # keeping the stopped window free of a second whole-database read.
  "$NODE_HOME/bin/node" "$seal_helper" verify-metadata \
    --base "$stage_path" --seal "$LIVE_SQLITE_PREBUILD_STAGE_MANIFEST" \
    || return 1
  rm -f -- "${LIVE_SQLITE_PATH}-wal" "${LIVE_SQLITE_PATH}-shm" || return 1
  mv -fT -- "$stage_path" "$LIVE_SQLITE_PATH" || return 1
  if [ -f "${stage_path}-wal" ] && [ ! -L "${stage_path}-wal" ]; then
    mv -fT -- "${stage_path}-wal" "${LIVE_SQLITE_PATH}-wal" || return 1
  fi
  rm -f -- "${stage_path}-shm" || return 1
  chown football:football "$LIVE_SQLITE_PATH" || return 1
  chmod 0600 "$LIVE_SQLITE_PATH" || return 1
  if [ -e "${LIVE_SQLITE_PATH}-wal" ]; then
    chown football:football "${LIVE_SQLITE_PATH}-wal" || return 1
    chmod 0600 "${LIVE_SQLITE_PATH}-wal" || return 1
    sync -f "${LIVE_SQLITE_PATH}-wal" || return 1
  fi
  sync -f "$LIVE_SQLITE_PATH" || return 1
  sync -f "$(dirname "$LIVE_SQLITE_PATH")" || return 1
  LIVE_SQLITE_PREBUILD_READY=0
  LIVE_SQLITE_PREBUILD_ACTIVATED=1
  log "activated CAS-verified prebuilt live SQLite without a stopped-window export"
}

restore_live_sqlite_after_rollback() {
  if [ -z "${LIVE_SQLITE_PATH:-}" ] || [ -z "${LIVE_SQLITE_BACKUP_DIR:-}" ] || [ ! -d "$LIVE_SQLITE_BACKUP_DIR" ]; then
    return 0
  fi
  local sqlite_name="${LIVE_SQLITE_PATH##*/}"
  local token suffix present bytes digest uid gid mode extra snapshot_file actual_bytes actual_digest line_count=0
  local parent temporary
  local -a sqlite_tokens=(base wal shm)
  local -A seen_tokens=() present_by_token=() bytes_by_token=() digest_by_token=()
  local -A uid_by_token=() gid_by_token=() mode_by_token=() staged_by_token=()
  [ -f "${LIVE_SQLITE_BACKUP_DIR}/live-path" ] && [ ! -L "${LIVE_SQLITE_BACKUP_DIR}/live-path" ] \
    && [ "$(stat -c '%h' -- "${LIVE_SQLITE_BACKUP_DIR}/live-path")" = "1" ] || return 1
  [ -f "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv" ] && [ ! -L "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv" ] \
    && [ "$(stat -c '%h' -- "${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv")" = "1" ] || return 1
  [ "$(head -n 1 "${LIVE_SQLITE_BACKUP_DIR}/live-path")" = "$LIVE_SQLITE_PATH" ] || return 1
  while IFS=$'\t' read -r token present bytes digest uid gid mode extra; do
    [ -n "$token" ] && [ -z "${extra:-}" ] || return 1
    case "$token" in
      base) suffix="" ;;
      wal) suffix="-wal" ;;
      shm) suffix="-shm" ;;
      *) return 1 ;;
    esac
    [ -z "${seen_tokens[$token]:-}" ] || return 1
    seen_tokens[$token]=1
    line_count=$((line_count + 1))
    snapshot_file="${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}"
    if [ "$present" = "1" ]; then
      [[ "$bytes" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ \
        && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      [ -f "$snapshot_file" ] && [ ! -L "$snapshot_file" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$snapshot_file")" = "0:0:600:1" ] || return 1
      actual_bytes="$(stat -c '%s' -- "$snapshot_file")"
      actual_digest="$(sha256sum "$snapshot_file" | awk '{print $1}')"
      [ "$actual_bytes" = "$bytes" ] && [ "$actual_digest" = "$digest" ] || return 1
    elif [ "$present" = "0" ]; then
      [ "$bytes" = "-" ] && [ "$digest" = "-" ] && [ "$uid" = "-" ] \
        && [ "$gid" = "-" ] && [ "$mode" = "-" ] || return 1
      [ ! -e "$snapshot_file" ] && [ ! -L "$snapshot_file" ] || return 1
    else
      return 1
    fi
    present_by_token[$token]="$present"
    bytes_by_token[$token]="$bytes"
    digest_by_token[$token]="$digest"
    uid_by_token[$token]="$uid"
    gid_by_token[$token]="$gid"
    mode_by_token[$token]="$mode"
  done <"${LIVE_SQLITE_BACKUP_DIR}/manifest.tsv"
  [ "$line_count" -eq 3 ] || return 1
  for token in "${sqlite_tokens[@]}"; do
    [ "${seen_tokens[$token]:-0}" = "1" ] || return 1
  done
  [ "${present_by_token[base]}" = "1" ] || return 1

  parent="$(dirname "$LIVE_SQLITE_PATH")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  for token in "${sqlite_tokens[@]}"; do
    case "$token" in base) suffix="" ;; wal) suffix="-wal" ;; shm) suffix="-shm" ;; esac
    if [ "${present_by_token[$token]}" = "1" ]; then
      snapshot_file="${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}"
      temporary="${LIVE_SQLITE_PATH}${suffix}.rollback.$$.$RANDOM"
      [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
      cp --no-preserve=ownership,mode,timestamps --no-dereference -- "$snapshot_file" "$temporary" || return 1
      [ "$(stat -c '%s' -- "$temporary")" = "${bytes_by_token[$token]}" ] \
        && [ "$(sha256sum "$temporary" | awk '{print $1}')" = "${digest_by_token[$token]}" ] || return 1
      chown "${uid_by_token[$token]}:${gid_by_token[$token]}" "$temporary" || return 1
      chmod "${mode_by_token[$token]}" "$temporary" || return 1
      sync -f "$temporary" || return 1
      staged_by_token[$token]="$temporary"
    fi
  done
  for token in "${sqlite_tokens[@]}"; do
    case "$token" in base) suffix="" ;; wal) suffix="-wal" ;; shm) suffix="-shm" ;; esac
    [ ! -d "${LIVE_SQLITE_PATH}${suffix}" ] || return 1
    rm -f -- "${LIVE_SQLITE_PATH}${suffix}" || return 1
  done
  for token in "${sqlite_tokens[@]}"; do
    case "$token" in base) suffix="" ;; wal) suffix="-wal" ;; shm) suffix="-shm" ;; esac
    if [ "${present_by_token[$token]}" = "1" ]; then
      mv -fT -- "${staged_by_token[$token]}" "${LIVE_SQLITE_PATH}${suffix}" || return 1
    fi
  done
  sync -f "$(dirname "$LIVE_SQLITE_PATH")" || return 1
  log "restored live sqlite rollback state"
}

restart_worker_if_needed() {
  if [ "${WORKER_STOPPED_FOR_SWAP:-0}" != "1" ]; then
    return 0
  fi
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1; then
    systemctl start "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || return 1
    systemctl is-active --quiet "$WORKER_SERVICE_NAME" || return 1
  fi
  WORKER_STOPPED_FOR_SWAP=0
}

restart_service_if_needed() {
  if [ "${SERVICE_STOPPED_FOR_SWAP:-0}" != "1" ]; then
    return 0
  fi
  systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || return 1
  systemctl is-active --quiet "$SERVICE_NAME" || return 1
  if [ "$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1" ]; then
    assert_release_fast_watcher_process_state 1 || return 1
    RELEASE_FAST_WATCHER_PAUSED_PROCESS=0
  fi
  SERVICE_STOPPED_FOR_SWAP=0
}

stop_worker_for_release_window() {
  stop_release_candidate_heartbeat_keeper || return 1
  if [ "${WORKER_FROZEN_FOR_READINESS:-0}" = "1" ]; then
    resume_worker_after_readiness || return 1
  fi
  if [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ]; then
    if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
      systemctl stop "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || return 1
      systemctl is-active --quiet "$WORKER_SERVICE_NAME" && return 1
    fi
    return 0
  fi
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
    log "pause ${WORKER_SERVICE_NAME} for release window"
    WORKER_STOPPED_FOR_SWAP=1
    systemctl stop "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || return 1
    systemctl is-active --quiet "$WORKER_SERVICE_NAME" && return 1
  fi
  return 0
}

stop_service_for_release_window() {
  if [ "${SERVICE_STOPPED_FOR_SWAP:-0}" = "1" ]; then
    return 0
  fi
  log "pause ${SERVICE_NAME} for atomic live-state handoff"
  SERVICE_STOPPED_FOR_SWAP=1
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || return 1
  systemctl is-active --quiet "$SERVICE_NAME" && return 1
  if [ "$RELEASE_FAST_WATCHER_PAUSED_PROCESS" = "1" ]; then
    # A manual stop suppresses Restart=always.  Only now is it safe to remove
    # the pause override so the candidate (or rollback) starts with watcher=1.
    remove_release_fast_watcher_pause_override || return 1
    systemctl cat "$SERVICE_NAME" 2>/dev/null \
      | grep -Fq "$RELEASE_FAST_WATCHER_PAUSE_ENV_FILE" && return 1
    systemctl is-active --quiet "$SERVICE_NAME" && return 1
  fi
  return 0
}

start_worker_for_live_release() {
  if ! systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1; then
    WORKER_STOPPED_FOR_SWAP=0
    return 0
  fi
  systemctl start "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || return 1
  systemctl is-active --quiet "$WORKER_SERVICE_NAME" || return 1
  WORKER_STOPPED_FOR_SWAP=0
}

verify_post_swap_transition_window() {
  local required_margin_seconds="$1"
  local label="${2:-post-swap-worker-wait}"
  local verified_at
  verified_at="$("$NODE_HOME/bin/node" -e 'process.stdout.write(new Date().toISOString())')" || return 1
  "$NODE_HOME/bin/node" "$APP_DIR/scripts/releaseTransitionLease.cjs" verify \
    --current "$APP_DIR/public/data/matches-current.json" \
    --lease "$CANDIDATE_TRANSITION_LEASE" \
    --at "$verified_at" \
    --required-margin-seconds "$required_margin_seconds" \
    >/dev/null || {
      printf 'release transition window became unsafe during %s at %s\n' "$label" "$verified_at" >&2
      return 1
    }
}

wait_for_worker_official_publish_after() {
  local worker_started_at="$1"
  local status_file="${2:-/var/lib/football-predict/sync-worker-status.json}"
  local timeout_seconds="$WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS"
  local poll_seconds="${RELEASE_WORKER_OFFICIAL_PUBLISH_POLL_SECONDS:-2}"
  local deadline evidence_rc

  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || timeout_seconds=600
  [[ "$poll_seconds" =~ ^[0-9]+$ ]] || poll_seconds=2
  [ "$timeout_seconds" -ge 30 ] || timeout_seconds=30
  [ "$poll_seconds" -ge 1 ] || poll_seconds=1
  [ "$poll_seconds" -le 30 ] || poll_seconds=30
  deadline=$((SECONDS + timeout_seconds))

  log "wait for this release worker to publish the official-result phase (started after ${worker_started_at})"
  while [ "$SECONDS" -lt "$deadline" ]; do
    verify_post_swap_transition_window "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" \
      "official-result publication" || return 1
    evidence_rc=1
    if [ -f "$status_file" ] && [ ! -L "$status_file" ]; then
      if "$NODE_HOME/bin/node" - "$APP_DIR/scripts/runSyncWorker.cjs" "$status_file" "$worker_started_at" <<'NODE'
const fs = require("node:fs");
const [workerModulePath, statusPath, workerStartedAt] = process.argv.slice(2);
let status = null;
try {
  const info = fs.lstatSync(statusPath);
  if (!info.isFile() || info.isSymbolicLink()) process.exit(1);
  status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
} catch {
  process.exit(1);
}
const { officialPublishEvidenceAfter } = require(workerModulePath);
const evidence = officialPublishEvidenceAfter(status, workerStartedAt);
if (evidence.state === "published") process.exit(0);
if (evidence.state === "failed") {
  process.stderr.write(`${JSON.stringify({
    message: "release worker official-result phase failed",
    phase: evidence.phase,
    finishedAt: evidence.finishedAt,
    error: evidence.error,
    errorCode: evidence.errorCode,
  })}\n`);
  process.exit(2);
}
process.exit(1);
NODE
      then
        evidence_rc=0
      else
        evidence_rc="$?"
      fi
    fi

    if [ "$evidence_rc" -eq 0 ]; then
      log "confirmed this release worker published official results after ${worker_started_at}"
      return 0
    fi
    if [ "$evidence_rc" -eq 2 ]; then
      return 1
    fi
    if ! systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
      printf 'sync worker became inactive before publishing this release official-result phase\n' >&2
      return 1
    fi
    sleep "$poll_seconds"
  done

  printf 'timed out after %ss waiting for this release worker official-result publication (started after %s)\n' \
    "$timeout_seconds" "$worker_started_at" >&2
  return 1
}

wait_for_worker_readiness_idle_after() {
  local worker_started_at="$1"
  local status_file="${2:-/var/lib/football-predict/sync-worker-status.json}"
  local timeout_seconds="${RELEASE_WORKER_READINESS_IDLE_TIMEOUT_SECONDS:-1800}"
  local poll_seconds="${RELEASE_WORKER_READINESS_IDLE_POLL_SECONDS:-2}"
  local deadline evidence_rc

  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || timeout_seconds=1800
  [[ "$poll_seconds" =~ ^[0-9]+$ ]] || poll_seconds=2
  [ "$timeout_seconds" -ge 30 ] || timeout_seconds=30
  [ "$poll_seconds" -ge 1 ] || poll_seconds=1
  [ "$poll_seconds" -le 30 ] || poll_seconds=30
  deadline=$((SECONDS + timeout_seconds))

  log "wait for this release worker cycle to finish slow enrichment and enter readiness-safe idle"
  while [ "$SECONDS" -lt "$deadline" ]; do
    verify_post_swap_transition_window "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" \
      "readiness-safe idle" || return 1
    evidence_rc=1
    if [ -f "$status_file" ] && [ ! -L "$status_file" ]; then
      if "$NODE_HOME/bin/node" - "$APP_DIR/scripts/runSyncWorker.cjs" "$status_file" "$worker_started_at" <<'NODE'
const fs = require("node:fs");
const [workerModulePath, statusPath, workerStartedAt] = process.argv.slice(2);
let status = null;
try {
  const info = fs.lstatSync(statusPath);
  if (!info.isFile() || info.isSymbolicLink()) process.exit(1);
  status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
} catch {
  process.exit(1);
}
const { readinessIdleEvidenceAfter } = require(workerModulePath);
const evidence = readinessIdleEvidenceAfter(status, workerStartedAt);
if (evidence.state === "idle") process.exit(0);
if (evidence.state === "failed") {
  process.stderr.write(`${JSON.stringify({
    message: "release worker failed before readiness-safe idle",
    phase: evidence.phase,
    finishedAt: evidence.finishedAt,
    error: evidence.error,
    errorCode: evidence.errorCode,
  })}\n`);
  process.exit(2);
}
process.exit(1);
NODE
      then
        evidence_rc=0
      else
        evidence_rc="$?"
      fi
    fi

    if [ "$evidence_rc" -eq 0 ]; then
      log "confirmed this release worker completed its full cycle and entered readiness-safe idle"
      return 0
    fi
    if [ "$evidence_rc" -eq 2 ]; then
      return 1
    fi
    if ! systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
      printf 'sync worker became inactive before readiness-safe idle\n' >&2
      return 1
    fi
    sleep "$poll_seconds"
  done

  printf 'timed out after %ss waiting for this release worker readiness-safe idle (started after %s)\n' \
    "$timeout_seconds" "$worker_started_at" >&2
  return 1
}

worker_process_is_stopped() {
  local pid="$1"
  [ -r "/proc/${pid}/status" ] && grep -Eq '^State:[[:space:]]+[Tt]' "/proc/${pid}/status"
}

worker_status_is_readiness_idle_after() {
  local worker_started_at="$1"
  local status_file="$2"
  local expected_pid="$3"
  [ -f "$status_file" ] && [ ! -L "$status_file" ] || return 1
  "$NODE_HOME/bin/node" - "$APP_DIR/scripts/runSyncWorker.cjs" "$status_file" "$worker_started_at" "$expected_pid" <<'NODE'
const fs = require("node:fs");
const [workerModulePath, statusPath, workerStartedAt, expectedPid] = process.argv.slice(2);
const info = fs.lstatSync(statusPath);
if (!info.isFile() || info.isSymbolicLink()) process.exit(1);
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
const { readinessIdleEvidenceAfter } = require(workerModulePath);
const evidence = readinessIdleEvidenceAfter(status, workerStartedAt);
if (evidence.state !== "idle" || String(evidence.pid) !== String(expectedPid)) process.exit(1);
NODE
}

frozen_worker_live_child_pids() {
  local main_pid="$1"
  local cgroup_file="$2"
  local pid state
  [ -r "$cgroup_file" ] || return 1
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    [ "$pid" != "$main_pid" ] || continue
    if [ ! -r "/proc/${pid}/status" ]; then
      continue
    fi
    state="$(awk '$1 == "State:" { print $2; exit }' "/proc/${pid}/status" 2>/dev/null || true)"
    # A child that exited while the stopped main process cannot reap it may
    # remain as a zombie in cgroup.procs. It no longer owns descriptors or the
    # candidate registry lock and is therefore already drained for this gate.
    case "$state" in
      ""|Z|X) continue ;;
    esac
    printf '%s\n' "$pid"
  done <"$cgroup_file"
}

wait_for_frozen_worker_children_to_drain() {
  local expected_main_pid="$1"
  local timeout_seconds="$WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS"
  local deadline current_pid control_group cgroup_file child_pid child_state child_name child_output
  local -a live_children=()
  [ "${WORKER_FROZEN_FOR_READINESS:-0}" = "1" ] \
    && [ "$expected_main_pid" = "$WORKER_FROZEN_MAIN_PID" ] || return 1
  deadline=$((SECONDS + timeout_seconds))
  while true; do
    systemctl is-active --quiet "$WORKER_SERVICE_NAME" || return 1
    current_pid="$(systemctl show "$WORKER_SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
    [ "$current_pid" = "$expected_main_pid" ] \
      && worker_process_is_stopped "$expected_main_pid" || return 1
    control_group="$(systemctl show "$WORKER_SERVICE_NAME" --property=ControlGroup --value 2>/dev/null || true)"
    [[ "$control_group" =~ ^/[A-Za-z0-9_.@:/-]+$ ]] \
      && [[ "$control_group" != *".."* ]] || return 1
    cgroup_file="/sys/fs/cgroup${control_group}/cgroup.procs"
    [ -r "$cgroup_file" ] || return 1
    child_output="$(frozen_worker_live_child_pids "$expected_main_pid" "$cgroup_file")" \
      || return 1
    live_children=()
    if [ -n "$child_output" ]; then
      mapfile -t live_children <<<"$child_output"
    fi
    if [ "${#live_children[@]}" -eq 0 ]; then
      log "confirmed frozen sync worker child processes drained before keeper handoff"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'timed out after %ss waiting for frozen worker children to drain:' \
        "$timeout_seconds" >&2
      for child_pid in "${live_children[@]}"; do
        child_state="$(awk '$1 == "State:" { print $2; exit }' "/proc/${child_pid}/status" 2>/dev/null || true)"
        child_name="$(tr -d '\000' <"/proc/${child_pid}/comm" 2>/dev/null || true)"
        printf ' pid=%s state=%s name=%s' "$child_pid" "${child_state:-unknown}" "${child_name:-unknown}" >&2
      done
      printf '\n' >&2
      return 1
    fi
    sleep 0.2
  done
}

freeze_worker_for_readiness() {
  local worker_started_at="$1"
  local status_file="$2"
  local main_pid current_pid attempt freeze_attempt stopped
  [ "${WORKER_FROZEN_FOR_READINESS:-0}" != "1" ] || return 0
  for freeze_attempt in 1 2 3; do
    if [ "$freeze_attempt" -gt 1 ]; then
      log "readiness idle changed before freeze; wait for the next complete worker idle window"
      wait_for_worker_readiness_idle_after "$worker_started_at" "$status_file" || return 1
    fi
    systemctl is-active --quiet "$WORKER_SERVICE_NAME" || return 1
    main_pid="$(systemctl show "$WORKER_SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || {
      printf 'sync worker has no valid main PID for readiness freeze\n' >&2
      return 1
    }

    systemctl kill --kill-who=main --signal=SIGSTOP "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || return 1
    stopped=0
    for attempt in $(seq 1 50); do
      current_pid="$(systemctl show "$WORKER_SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
      if [ "$current_pid" != "$main_pid" ] || ! systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
        break
      fi
      if worker_process_is_stopped "$main_pid"; then
        stopped=1
        break
      fi
      sleep 0.1
    done

    if [ "$stopped" = "1" ] \
      && worker_status_is_readiness_idle_after "$worker_started_at" "$status_file" "$main_pid"; then
      WORKER_FROZEN_FOR_READINESS=1
      WORKER_FROZEN_MAIN_PID="$main_pid"
      log "froze readiness-safe idle sync worker ${main_pid} across strict SQLite verification"
      return 0
    fi
    systemctl kill --kill-who=main --signal=SIGCONT "$WORKER_SERVICE_NAME" >/dev/null 2>&1 \
      || kill -CONT "$main_pid" >/dev/null 2>&1 \
      || true
  done

  printf 'sync worker did not retain a readiness-safe idle state while being frozen\n' >&2
  return 1
}

resume_worker_after_readiness() {
  local current_pid attempt
  if [ "${WORKER_FROZEN_FOR_READINESS:-0}" != "1" ]; then
    return 0
  fi

  systemctl kill --kill-who=main --signal=SIGCONT "$WORKER_SERVICE_NAME" >/dev/null 2>&1 \
    || kill -CONT "$WORKER_FROZEN_MAIN_PID" >/dev/null 2>&1 \
    || return 1
  for attempt in $(seq 1 50); do
    current_pid="$(systemctl show "$WORKER_SERVICE_NAME" --property=MainPID --value 2>/dev/null || true)"
    if [ "$current_pid" = "$WORKER_FROZEN_MAIN_PID" ] \
      && systemctl is-active --quiet "$WORKER_SERVICE_NAME" \
      && ! worker_process_is_stopped "$WORKER_FROZEN_MAIN_PID"; then
      log "resumed sync worker ${WORKER_FROZEN_MAIN_PID} after strict SQLite verification"
      WORKER_FROZEN_FOR_READINESS=0
      WORKER_FROZEN_MAIN_PID=""
      return 0
    fi
    sleep 0.1
  done

  printf 'sync worker did not resume with the same identity after readiness verification\n' >&2
  return 1
}

validate_candidate_capture_heartbeat_status() {
  local status_file="${1:-}" expected_evaluated_at="${2:-}" matcher_module="${3:-}" validator_root="${4:-}" validation_mode="${5:-}"
  local expected_validation_mode unit rc
  if [ "${SWAP_STARTED:-0}" = "1" ]; then
    expected_validation_mode="strict"
  else
    expected_validation_mode="pre-swap-legacy-top-level-due"
  fi
  [ "$#" -eq 5 ] && [ -n "$status_file" ] && [ -n "$expected_evaluated_at" ] \
    && [ -n "$matcher_module" ] && [ -n "$validator_root" ] \
    && [ "$validation_mode" = "$expected_validation_mode" ] \
    || return 1
  unit="football-release-heartbeat-validate-$$-${RANDOM}"
  set +e
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
    --unit="$unit" --uid=football --working-directory="$validator_root" \
    --property="NoNewPrivileges=yes" \
    --property="ProtectSystem=strict" \
    --property="ProtectHome=true" \
    --property="PrivateNetwork=yes" \
    --property="PrivateTmp=yes" \
    --property="PrivateDevices=yes" \
    --property="MemoryMax=256M" \
    --property="TasksMax=32" \
    --property="RuntimeMaxSec=30s" \
    --property="ReadOnlyPaths=$APP_DIR" \
    --property="ReadOnlyPaths=$validator_root" \
    --property="ReadOnlyPaths=$LIVE_STORE_DIR" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-release" \
    -- "$NODE_HOME/bin/node" - "$status_file" "$expected_evaluated_at" "$matcher_module" "$validation_mode" <<'NODE'
const fs = require("node:fs");
const [statusPath, expectedEvaluatedAt, matcherModule, validationMode] = process.argv.slice(2);
if (!["strict", "pre-swap-legacy-top-level-due"].includes(validationMode)) process.exit(1);
const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const fd = fs.openSync(statusPath, flags);
let status;
try {
  const info = fs.fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) process.exit(1);
  status = JSON.parse(fs.readFileSync(fd, "utf8"));
 } finally {
  fs.closeSync(fd);
 }
const { exactHeartbeatMatches } = require(matcherModule);
if (!exactHeartbeatMatches(status, expectedEvaluatedAt, {
  requireFresh: true,
  maxAgeMs: 120_000,
  allowPreSwapLegacyTopLevelDueOmission: validationMode === "pre-swap-legacy-top-level-due",
})) process.exit(1);
NODE
  rc="$?"
  set -e
  assert_transient_unit_cleared "$unit" || return 1
  return "$rc"
}

refresh_candidate_capture_heartbeat_for_readiness() {
  local evaluated_at status_file runtime_root validator_root expected_validator_root validation_mode capture_script matcher_module collector_trust_registry attempt max_attempts retry_delay_seconds capture_lock_timeout_ms success_epoch_seconds
  runtime_root="${1:-}"
  validator_root="${2:-}"
  [ "$#" -eq 2 ] || {
    printf 'candidate deadline capture requires explicit active and validator roots\n' >&2
    return 1
  }
  [ "$runtime_root" = "$APP_DIR" ] || {
    printf 'candidate deadline capture must use active app root: %s\n' "$runtime_root" >&2
    return 1
  }
  if [ "${SWAP_STARTED:-0}" = "1" ]; then
    expected_validator_root="$APP_DIR"
    validation_mode="strict"
  else
    expected_validator_root="$NEXT_DIR"
    validation_mode="pre-swap-legacy-top-level-due"
  fi
  [ "$validator_root" = "$expected_validator_root" ] || {
    printf 'candidate deadline capture validator root does not match release phase: %s\n' "$validator_root" >&2
    return 1
  }
  status_file="$LIVE_STORE_DIR/candidate-prospective-capture-status.json"
  capture_script="$runtime_root/scripts/captureCandidateProspectiveDeadline.cjs"
  matcher_module="$validator_root/scripts/runReleaseCandidateHeartbeatKeeper.cjs"
  collector_trust_registry="$runtime_root/deploy/light-server/collector-trust-registry.json"
  [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ] \
    && [ -d "$validator_root" ] && [ ! -L "$validator_root" ] \
    && [ -f "$capture_script" ] && [ ! -L "$capture_script" ] \
    && [ -f "$matcher_module" ] && [ ! -L "$matcher_module" ] \
    && [ -f "$collector_trust_registry" ] && [ ! -L "$collector_trust_registry" ] \
    && [ "$(stat -c '%h' -- "$capture_script")" = "1" ] \
    && [ "$(stat -c '%h' -- "$matcher_module")" = "1" ] \
    && [ "$(stat -c '%h' -- "$collector_trust_registry")" = "1" ] || {
      printf 'candidate deadline capture runtime scripts are unavailable\n' >&2
      return 1
    }
  max_attempts="${RELEASE_CANDIDATE_CAPTURE_REFRESH_ATTEMPTS:-8}"
  retry_delay_seconds="${RELEASE_CANDIDATE_CAPTURE_REFRESH_RETRY_SECONDS:-3}"
  capture_lock_timeout_ms="${RELEASE_CANDIDATE_CAPTURE_LOCK_TIMEOUT_MS:-10000}"
  [[ "$max_attempts" =~ ^[0-9]+$ ]] && [ "$max_attempts" -ge 1 ] && [ "$max_attempts" -le 20 ] \
    || { printf 'invalid candidate capture refresh attempts: %s\n' "$max_attempts" >&2; return 1; }
  [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] && [ "$retry_delay_seconds" -ge 1 ] && [ "$retry_delay_seconds" -le 10 ] \
    || { printf 'invalid candidate capture refresh retry seconds: %s\n' "$retry_delay_seconds" >&2; return 1; }
  [[ "$capture_lock_timeout_ms" =~ ^[0-9]+$ ]] && [ "$capture_lock_timeout_ms" -ge 1000 ] && [ "$capture_lock_timeout_ms" -le 60000 ] \
    || { printf 'invalid candidate capture lock timeout milliseconds: %s\n' "$capture_lock_timeout_ms" >&2; return 1; }

  # Before swap this runs only after the regular worker has been stopped, so the
  # capture cannot race its registry transaction. After swap it runs once after
  # the release worker has published readiness-safe idle and before SIGSTOP.
  # Retry only the fail-closed lock/status condition; every successful attempt
  # must publish a new exact evaluatedAt heartbeat before readiness can continue.
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    evaluated_at="$("$NODE_HOME/bin/node" -e 'process.stdout.write(new Date().toISOString())')" \
      || return 1
    if run_as_service_user_with_runtime_env env \
      SERVER_STORE_DIR="$LIVE_STORE_DIR" \
      DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" \
      SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH="$collector_trust_registry" \
      CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS="$capture_lock_timeout_ms" \
      CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT="$evaluated_at" \
      "$NODE_HOME/bin/node" "$capture_script"; then
      if validate_candidate_capture_heartbeat_status \
        "$status_file" "$evaluated_at" "$matcher_module" "$validator_root" "$validation_mode"
      then
        success_epoch_seconds="$(date -u +'%s')" || return 1
        [[ "$success_epoch_seconds" =~ ^[1-9][0-9]*$ ]] || return 1
        CANDIDATE_CAPTURE_HEARTBEAT_REFRESH_SUCCESS_EPOCH_SECONDS="$success_epoch_seconds"
        log "candidate deadline capture heartbeat refreshed after attempt ${attempt}/${max_attempts} at epoch ${success_epoch_seconds}"
        return 0
      fi
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      printf 'candidate deadline capture heartbeat refresh exhausted after %s attempts\n' "$max_attempts" >&2
      return 1
    fi
    log "candidate deadline capture heartbeat refresh retry ${attempt}/${max_attempts}: registry/status not yet available"
    sleep "$retry_delay_seconds"
    attempt=$((attempt + 1))
  done
  return 1
}

assert_candidate_capture_heartbeat_refresh_fresh() {
  local max_age_seconds="$1"
  local phase="$2"
  local policy_script freshness_output
  [[ "$max_age_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_age_seconds" -le 300 ] || {
    printf 'invalid candidate capture heartbeat freshness limit: %s\n' "$max_age_seconds" >&2
    return 1
  }
  [[ "$phase" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || {
    printf 'invalid candidate capture heartbeat freshness phase: %s\n' "$phase" >&2
    return 1
  }
  [[ "$CANDIDATE_CAPTURE_HEARTBEAT_REFRESH_SUCCESS_EPOCH_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
    printf 'candidate capture heartbeat has no recorded successful refresh time\n' >&2
    return 1
  }
  policy_script="$NEXT_DIR/scripts/releasePrebuildPolicy.cjs"
  [ -f "$policy_script" ] && [ ! -L "$policy_script" ] \
    && [ "$(stat -c '%h' -- "$policy_script")" = "1" ] || {
      printf 'candidate capture heartbeat freshness policy is unavailable\n' >&2
      return 1
    }
  freshness_output="$("$NODE_HOME/bin/node" "$policy_script" freshness \
    --refreshed-at-epoch-seconds "$CANDIDATE_CAPTURE_HEARTBEAT_REFRESH_SUCCESS_EPOCH_SECONDS" \
    --max-age-seconds "$max_age_seconds" \
    --phase "$phase")" || return 1
  [ -n "$freshness_output" ] || {
    printf 'candidate capture heartbeat freshness policy returned no evidence\n' >&2
    return 1
  }
  log "candidate deadline capture heartbeat freshness accepted: ${freshness_output}"
}

release_candidate_heartbeat_keeper_is_healthy() {
  local unit="$RELEASE_HEARTBEAT_KEEPER_UNIT"
  local control_file="$RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE"
  local heartbeat_file="$LIVE_STORE_DIR/candidate-prospective-capture-status.json"
  local main_pid max_age_seconds
  [ -n "$unit" ] && [ -n "$control_file" ] || return 1
  systemctl is-active --quiet "$unit" || return 1
  main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  max_age_seconds=$((
    RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS
    + (RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS / 1000)
    + 5
  ))
  run_as_service_user "$NODE_HOME/bin/node" - \
    "$control_file" "$heartbeat_file" "$unit" "$main_pid" "$max_age_seconds" \
    "$APP_DIR/scripts/runReleaseCandidateHeartbeatKeeper.cjs" <<'NODE'
const fs = require("node:fs");
const [
  controlPath,
  heartbeatPath,
  expectedInstanceId,
  expectedPid,
  maxAgeSeconds,
  matcherModule,
] = process.argv.slice(2);
const readRegularJson = (filePath) => {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) {
      throw new Error("unsafe keeper evidence file");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
};
const { exactHeartbeatMatches } = require(matcherModule);
const control = readRegularJson(controlPath);
const heartbeat = readRegularJson(heartbeatPath);
const lastSuccessMs = Date.parse(control?.lastSuccessAt || "");
const activeAttemptValid = control?.activeAttempt == null || (
  Number.isSafeInteger(control.activeAttempt?.sequence)
  && control.activeAttempt.sequence === Number(control.captureSequence) + 1
  && Number.isFinite(Date.parse(control.activeAttempt?.evaluatedAt || ""))
  && Number.isFinite(Date.parse(control.activeAttempt?.startedAt || ""))
);
if (
  control?.version !== "release-candidate-heartbeat-keeper-v2"
  || control?.instanceId !== expectedInstanceId
  || String(control?.pid) !== String(expectedPid)
  || control?.ok !== true
  || control?.state !== "running"
  || !Number.isSafeInteger(Number(control?.captureSequence))
  || Number(control.captureSequence) < 1
  || !Number.isFinite(lastSuccessMs)
  || Date.now() - lastSuccessMs < 0
  || Date.now() - lastSuccessMs > Number(maxAgeSeconds) * 1000
  || !activeAttemptValid
  || !exactHeartbeatMatches(heartbeat, control?.lastEvaluatedAt, {
    requireFresh: true,
    maxAgeMs: Number(maxAgeSeconds) * 1000,
  })
  || control?.lastRegistryRootHash !== heartbeat?.audit?.rootHash
  || control?.lastCandidateRevisionId !== heartbeat?.audit?.candidateRevisionId
) process.exit(1);
NODE
}

release_candidate_heartbeat_keeper_has_latched_failure() {
  local unit="$RELEASE_HEARTBEAT_KEEPER_UNIT"
  local control_file="$RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE"
  local main_pid
  [ -n "$unit" ] && [ -n "$control_file" ] || return 1
  systemctl is-active --quiet "$unit" || return 1
  main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  run_as_service_user "$NODE_HOME/bin/node" - \
    "$control_file" "$unit" "$main_pid" <<'NODE'
const fs = require("node:fs");
const [controlPath, expectedInstanceId, expectedPid] = process.argv.slice(2);
const info = fs.lstatSync(controlPath);
if (!info.isFile() || info.isSymbolicLink()) process.exit(1);
const control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
if (
  control?.version !== "release-candidate-heartbeat-keeper-v2"
  || control?.instanceId !== expectedInstanceId
  || String(control?.pid) !== String(expectedPid)
  || control?.ok !== false
  || control?.state !== "failed-latched"
  || control?.failedClosed !== true
  || control?.awaitingExplicitStop !== true
) process.exit(1);
NODE
}

release_candidate_heartbeat_keeper_clean_baseline() {
  local control_file="$1"
  local registry_file="$2"
  local expected_instance_id="$3"
  local expected_pid="$4"
  run_as_service_user "$NODE_HOME/bin/node" - \
    "$control_file" "$registry_file" "$expected_instance_id" "$expected_pid" \
    "$APP_DIR/scripts/candidateProspectiveLedger.cjs" <<'NODE'
const fs = require("node:fs");
const [controlPath, registryPath, expectedInstanceId, expectedPid, ledgerModule] = process.argv.slice(2);
const readRegularJson = (filePath, maxBytes) => {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
      throw new Error("unsafe keeper baseline file");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
};
const { verifyRegistry, ledgerState } = require(ledgerModule);
const control = readRegularJson(controlPath, 1024 * 1024);
const registry = readRegularJson(registryPath, 128 * 1024 * 1024);
if (
  control?.version !== "release-candidate-heartbeat-keeper-v2"
  || control?.instanceId !== expectedInstanceId
  || String(control?.pid) !== String(expectedPid)
  || control?.state !== "running"
  || control?.ok !== true
  || !Number.isSafeInteger(control?.captureSequence)
  || control.captureSequence < 1
  || !registry || typeof registry !== "object"
  || !Array.isArray(registry.ledgers)
  || !String(registry.activeLedgerId || "")
) process.exit(1);
const verification = verifyRegistry(registry);
const active = registry.ledgers.find((ledger) => ledger?.ledgerId === registry.activeLedgerId);
const candidateRevisionId = String(active?.header?.candidateRevisionId || "");
if (
  verification.valid !== true
  || !active
  || ledgerState(active) !== "ACTIVE"
  || !candidateRevisionId
) process.exit(1);
process.stdout.write(JSON.stringify({
  captureSequence: control.captureSequence,
  activeLedgerId: active.ledgerId,
  candidateRevisionId,
}));
NODE
}

release_candidate_heartbeat_keeper_clean_stop_evidence_is_valid() {
  local control_file="$1"
  local heartbeat_file="$2"
  local registry_file="$3"
  local expected_instance_id="$4"
  local expected_pid="$5"
  local baseline_json="$6"
  local max_age_seconds="$7"
  run_as_service_user "$NODE_HOME/bin/node" - \
    "$control_file" "$heartbeat_file" "$registry_file" \
    "$expected_instance_id" "$expected_pid" "$baseline_json" "$max_age_seconds" \
    "$APP_DIR/scripts/runReleaseCandidateHeartbeatKeeper.cjs" \
    "$APP_DIR/scripts/candidateProspectiveLedger.cjs" <<'NODE'
const fs = require("node:fs");
const [
  controlPath,
  heartbeatPath,
  registryPath,
  expectedInstanceId,
  expectedPid,
  baselineJson,
  maxAgeSeconds,
  matcherModule,
  ledgerModule,
] = process.argv.slice(2);
const readRegularJson = (filePath, maxBytes) => {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
      throw new Error("unsafe keeper stop evidence file");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
};
const { exactHeartbeatMatches } = require(matcherModule);
const { GENESIS_HASH, verifyRegistry, ledgerState } = require(ledgerModule);
const baseline = JSON.parse(baselineJson);
const control = readRegularJson(controlPath, 1024 * 1024);
const heartbeat = readRegularJson(heartbeatPath, 16 * 1024 * 1024);
const registry = readRegularJson(registryPath, 128 * 1024 * 1024);
const stopRequestedMs = Date.parse(control?.stopRequestedAt || "");
const stoppedMs = Date.parse(control?.stoppedAt || "");
if (
  control?.version !== "release-candidate-heartbeat-keeper-v2"
  || control?.instanceId !== expectedInstanceId
  || String(control?.pid) !== String(expectedPid)
  || control?.ok !== true
  || control?.state !== "stopped"
  || control?.failedClosed !== false
  || control?.awaitingExplicitStop !== false
  || control?.stopSignal !== "SIGTERM"
  || control?.stopDrained !== true
  || control?.activeAttempt !== null
  || control?.failure !== null
  || !Number.isSafeInteger(control?.captureSequence)
  || !Number.isSafeInteger(baseline?.captureSequence)
  || control.captureSequence < baseline.captureSequence
  || !Number.isFinite(stopRequestedMs)
  || !Number.isFinite(stoppedMs)
  || stoppedMs < stopRequestedMs
  || !exactHeartbeatMatches(heartbeat, control?.lastEvaluatedAt, {
    requireFresh: true,
    maxAgeMs: Number(maxAgeSeconds) * 1000,
  })
  || control?.lastRegistryRootHash !== heartbeat?.audit?.rootHash
  || control?.lastCandidateRevisionId !== heartbeat?.audit?.candidateRevisionId
  || heartbeat?.registryFile !== registryPath
  || !registry || typeof registry !== "object"
  || !Array.isArray(registry.ledgers)
  || !String(registry.activeLedgerId || "")
) process.exit(1);
const verification = verifyRegistry(registry);
const active = registry.ledgers.find((ledger) => ledger?.ledgerId === registry.activeLedgerId);
const candidateRevisionId = String(active?.header?.candidateRevisionId || "");
const rootHash = String(active?.rootHash || "");
const terminalRootHash = active?.events?.at(-1)?.eventHash || GENESIS_HASH;
if (
  verification.valid !== true
  || !active
  || ledgerState(active) !== "ACTIVE"
  || active.ledgerId !== baseline.activeLedgerId
  || candidateRevisionId !== baseline.candidateRevisionId
  || !/^[a-f0-9]{64}$/u.test(rootHash)
  || terminalRootHash !== rootHash
  || heartbeat?.audit?.state !== "ACTIVE"
  || heartbeat?.audit?.chainValid !== true
  || heartbeat?.audit?.candidateRevisionId !== candidateRevisionId
  || heartbeat?.audit?.rootHash !== rootHash
  || heartbeat?.readiness?.candidateRevisionId !== candidateRevisionId
  || control?.lastCandidateRevisionId !== candidateRevisionId
  || control?.lastRegistryRootHash !== rootHash
) process.exit(1);
process.stdout.write(JSON.stringify({
  activeLedgerId: active.ledgerId,
  candidateRevisionId,
  rootHash,
  captureSequence: control.captureSequence,
}));
NODE
}

cleanup_release_candidate_heartbeat_keeper_runtime() {
  local runtime_dir="$RELEASE_HEARTBEAT_KEEPER_RUNTIME_DIR"
  [ -n "$runtime_dir" ] || return 0
  [[ "$runtime_dir" =~ ^/run/football-release-heartbeat\.[A-Za-z0-9]{6}$ ]] || {
    printf 'refusing to clean unsafe release heartbeat keeper path: %s\n' "$runtime_dir" >&2
    return 1
  }
  if [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
    [ -d "$runtime_dir" ] && [ ! -L "$runtime_dir" ] \
      && [ "$(stat -c '%U:%G:%a' -- "$runtime_dir")" = "football:football:700" ] \
      || return 1
    rm -f -- "$runtime_dir/keeper-status.json" "$runtime_dir"/keeper-status.json.*.tmp \
      || return 1
    rmdir -- "$runtime_dir" || return 1
  fi
  RELEASE_HEARTBEAT_KEEPER_RUNTIME_DIR=""
  RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE=""
}

stop_release_candidate_heartbeat_keeper() {
  local mode="${1:-cleanup}"
  local unit="$RELEASE_HEARTBEAT_KEEPER_UNIT"
  local control_file="$RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE"
  local heartbeat_file="$LIVE_STORE_DIR/candidate-prospective-capture-status.json"
  local registry_file="$LIVE_STORE_DIR/model-artifacts/candidate-prospective-registry.json"
  local main_pid baseline_json="" stop_failed=0 forced_kill=0 max_age_seconds
  [ "$mode" = "cleanup" ] || [ "$mode" = "clean" ] || return 1
  if [ "$mode" = "clean" ] && { [ -z "$unit" ] || [ -z "$control_file" ]; }; then
    return 1
  fi
  if [ -n "$unit" ]; then
    main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    if [ "$mode" = "clean" ]; then
      [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
      baseline_json="$(release_candidate_heartbeat_keeper_clean_baseline \
        "$control_file" "$registry_file" "$unit" "$main_pid")" || return 1
      [ -n "$baseline_json" ] || return 1
    fi
    if ! systemctl stop "$unit" >/dev/null 2>&1; then
      stop_failed=1
    fi
    if ! assert_transient_unit_cleared "$unit"; then
      forced_kill=1
      systemctl kill --kill-who=all --signal=KILL "$unit" >/dev/null 2>&1 || true
      systemctl stop "$unit" >/dev/null 2>&1 || true
      assert_transient_unit_cleared "$unit" || return 1
    fi
    if [ "$mode" = "clean" ]; then
      [ "$stop_failed" -eq 0 ] && [ "$forced_kill" -eq 0 ] || return 1
      max_age_seconds=$((
        RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS
        + (RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS / 1000)
        + 5
      ))
      release_candidate_heartbeat_keeper_clean_stop_evidence_is_valid \
        "$control_file" "$heartbeat_file" "$registry_file" \
        "$unit" "$main_pid" "$baseline_json" "$max_age_seconds" \
        || return 1
      log "release heartbeat keeper drained and its final exact heartbeat matches the active registry"
    fi
    RELEASE_HEARTBEAT_KEEPER_UNIT=""
  fi
  cleanup_release_candidate_heartbeat_keeper_runtime || return 1
  return 0
}

cleanup_release_sync_write_barrier_runtime() {
  local runtime_dir="$RELEASE_SYNC_WRITE_BARRIER_RUNTIME_DIR"
  [ -n "$runtime_dir" ] || return 0
  [[ "$runtime_dir" =~ ^/run/football-release-sync-barrier\.[A-Za-z0-9]{6}$ ]] || {
    printf 'refusing to clean unsafe release sync write barrier path: %s\n' "$runtime_dir" >&2
    return 1
  }
  if [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
    [ -d "$runtime_dir" ] && [ ! -L "$runtime_dir" ] \
      && [ "$(stat -c '%U:%G:%a' -- "$runtime_dir")" = "football:football:700" ] \
      || return 1
    rm -f -- "$runtime_dir/barrier-status.json" \
      "$runtime_dir"/barrier-status.json.*.tmp || return 1
    rmdir -- "$runtime_dir" || return 1
  fi
  RELEASE_SYNC_WRITE_BARRIER_RUNTIME_DIR=""
  RELEASE_SYNC_WRITE_BARRIER_CONTROL_FILE=""
}

cleanup_release_sync_write_barrier_owned_lock() {
  local helper_pid="$1"
  local lock_dir="$LIVE_STORE_DIR/locks/sync.lock"
  local output rc
  [[ "$helper_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -f "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" ] \
    && [ ! -L "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" ] || return 1
  set +e
  output="$(runuser -u football -- \
    "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" cleanup-dead-owned \
      --store-dir "$LIVE_STORE_DIR" \
      --lock-dir "$lock_dir" \
      --owner release-live-sqlite-prebuild \
      --source signed-release \
      --pid "$helper_pid" 2>&1)"
  rc="$?"
  set -e
  if [ "$rc" -eq 0 ]; then
    [ -z "$output" ] || log "release sync write barrier cleanup: ${output}"
    return 0
  fi
  if [ "$rc" -eq 3 ]; then
    log "release sync write barrier cleanup preserved a foreign/live lock: ${output}"
    return 3
  fi
  printf 'release sync write barrier owned-lock cleanup failed: %s\n' "$output" >&2
  return 1
}

release_sync_write_barrier_is_healthy() {
  local unit="$RELEASE_SYNC_WRITE_BARRIER_UNIT"
  local control_file="$RELEASE_SYNC_WRITE_BARRIER_CONTROL_FILE"
  local lock_dir="$LIVE_STORE_DIR/locks/sync.lock"
  local lock_file="$lock_dir/lock.json"
  local main_pid
  [ -n "$unit" ] && [ -n "$control_file" ] || return 1
  systemctl is-active --quiet "$unit" || return 1
  main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$lock_dir")" = "football:football:700" ] || return 1
  for file in "$lock_file" "$control_file"; do
    [ -f "$file" ] && [ ! -L "$file" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$file")" = "football:football:600:1" ] || return 1
  done
  "$NODE_HOME/bin/node" - "$control_file" "$lock_file" "$main_pid" "$lock_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [controlFile, lockFile, mainPidText, expectedLockDir] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const mainPid = Number(mainPidText);
if (
  control?.version !== "release-sync-write-barrier-v1"
  || control?.state !== "HELD"
  || control?.pid !== mainPid
  || control?.lockDir !== path.resolve(expectedLockDir)
  || control?.owner !== "release-live-sqlite-prebuild"
  || control?.source !== "signed-release"
  || lock?.pid !== mainPid
  || lock?.lockDir !== path.resolve(expectedLockDir)
  || lock?.owner !== control.owner
  || lock?.source !== control.source
) process.exit(1);
NODE
}

stop_release_sync_write_barrier() {
  local mode="${1:-cleanup}"
  local unit="$RELEASE_SYNC_WRITE_BARRIER_UNIT"
  local lock_dir="$LIVE_STORE_DIR/locks/sync.lock"
  local main_pid cleanup_rc=0 stop_failed=0 forced_kill=0
  [ "$mode" = "cleanup" ] || [ "$mode" = "clean" ] || return 1
  if [ "$mode" = "clean" ]; then
    release_sync_write_barrier_is_healthy || return 1
  fi
  if [ -n "$unit" ]; then
    main_pid="${RELEASE_SYNC_WRITE_BARRIER_PID:-}"
    if ! [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    fi
    if ! systemctl stop "$unit" >/dev/null 2>&1; then
      stop_failed=1
    fi
    if ! assert_transient_unit_cleared "$unit"; then
      forced_kill=1
      systemctl kill --kill-who=all --signal=KILL "$unit" >/dev/null 2>&1 || true
      systemctl stop "$unit" >/dev/null 2>&1 || true
      assert_transient_unit_cleared "$unit" || return 1
    fi
    if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
      && { [ -e "$lock_dir" ] || [ -L "$lock_dir" ]; }; then
      # SIGKILL cannot run the helper's ownership-checked finally path.  Stop
      # the remaining live writer before reclaiming only the exact dead helper
      # identity, so a concurrent relay cannot be displaced during quarantine.
      if systemctl is-active --quiet "$SERVICE_NAME"; then
        stop_service_for_release_window || return 1
      fi
      cleanup_release_sync_write_barrier_owned_lock "$main_pid" || cleanup_rc="$?"
      if [ "$cleanup_rc" -ne 0 ] && [ "$cleanup_rc" -ne 3 ]; then
        return 1
      fi
    fi
    RELEASE_SYNC_WRITE_BARRIER_UNIT=""
    RELEASE_SYNC_WRITE_BARRIER_PID=""
    if [ "$mode" = "clean" ]; then
      [ "$stop_failed" -eq 0 ] && [ "$forced_kill" -eq 0 ] \
        && [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
      [ "$cleanup_rc" -eq 0 ] \
        && [ ! -e "$lock_dir" ] && [ ! -L "$lock_dir" ] || return 1
      log "release sync write barrier drained after the live service stopped"
    fi
  elif [ "$mode" = "clean" ]; then
    return 1
  fi
  cleanup_release_sync_write_barrier_runtime || return 1
}

write_release_pointer_commit_keeper_helper() {
  local helper_file="$1"
  ( umask 077; set -o noclobber; cat >"$helper_file" <<'POINTER_KEEPER'
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const command = String(process.argv[2] || "");
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  const key = String(process.argv[index] || "");
  if (!key.startsWith("--") || index + 1 >= process.argv.length) {
    process.stderr.write("invalid release pointer keeper arguments\n");
    process.exit(2);
  }
  options[key.slice(2)] = String(process.argv[index + 1]);
}

const required = (name) => {
  const value = String(options[name] || "").trim();
  if (!value) throw new Error(`missing --${name}`);
  return value;
};
const modulePath = path.resolve(required("module"));
const storeDir = path.resolve(required("store-dir"));
const { acquirePointerCommitLock, storePaths, STORE_SCHEMA_VERSION } = require(modulePath);
const paths = storePaths(storeDir);
if (path.dirname(paths.root) !== storeDir || path.dirname(paths.pointerLockDir) !== paths.root) {
  throw new Error("storePaths returned an unexpected pointer-lock location");
}
if (!Number.isSafeInteger(STORE_SCHEMA_VERSION) || STORE_SCHEMA_VERSION <= 0) {
  throw new Error("data generation store schema version is unavailable");
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const readJsonOrNull = (filePath) => {
  try { return readJson(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
let writeSequence = 0;
const writeJsonAtomic = (filePath, payload) => {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${++writeSequence}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = fs.openSync(temporary, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  try {
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch {
    // The file fsync and same-directory rename are the portable guarantee.
  }
};
const ownerPath = path.join(paths.pointerLockDir, "owner.json");
const lockOwner = () => readJsonOrNull(ownerPath);
const ownerTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const validCanonicalOwner = (owner) => {
  if (!owner || Object.getPrototypeOf(owner) !== Object.prototype) return false;
  const keys = Object.keys(owner).sort();
  if (keys.join("\0") !== ["acquiredAt", "hostname", "pid", "schemaVersion", "token"].join("\0")) {
    return false;
  }
  const acquiredAt = String(owner.acquiredAt || "");
  let canonicalAcquiredAt = "";
  try { canonicalAcquiredAt = new Date(acquiredAt).toISOString(); } catch { return false; }
  return owner.schemaVersion === STORE_SCHEMA_VERSION
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.hostname === "string" && owner.hostname.length > 0 && owner.hostname.length <= 255
    && ownerTokenPattern.test(String(owner.token || ""))
    && canonicalAcquiredAt === acquiredAt;
};
const ownerMatches = (owner, pid, token) => validCanonicalOwner(owner)
  && owner.pid === pid
  && owner.token === token
  && owner.hostname === os.hostname();
const lstatOrNull = (filePath) => {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const sameFilesystemIdentity = (left, right) => Boolean(left && right)
  && left.dev === right.dev
  && left.ino === right.ino
  && left.uid === right.uid
  && left.gid === right.gid;
const lockEvidence = (lockDir, ownerFileName) => {
  if (path.dirname(lockDir) !== paths.root || path.basename(ownerFileName) !== ownerFileName) {
    throw new Error("pointer lock evidence path escaped the canonical generation root");
  }
  const evidenceOwnerPath = path.join(lockDir, ownerFileName);
  const rootStat = lstatOrNull(paths.root);
  const lockStat = lstatOrNull(lockDir);
  const ownerStat = lstatOrNull(evidenceOwnerPath);
  if (!rootStat || !lockStat || !ownerStat) {
    throw new Error("pointer lock ownership evidence is incomplete");
  }
  const entries = fs.readdirSync(lockDir);
  const nativeDirectoryLinkCounts = process.platform !== "win32";
  if (
    !rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !lockStat.isDirectory() || lockStat.isSymbolicLink()
    || (nativeDirectoryLinkCounts && lockStat.nlink !== 2)
    || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1
    || rootStat.dev !== lockStat.dev || lockStat.dev !== ownerStat.dev
    || rootStat.uid !== lockStat.uid || lockStat.uid !== ownerStat.uid
    || rootStat.gid !== lockStat.gid || lockStat.gid !== ownerStat.gid
    || ownerStat.size <= 0 || ownerStat.size > 1024
    || entries.length !== 1 || entries[0] !== ownerFileName
  ) throw new Error("pointer lock filesystem identity mismatch");
  const owner = readJson(evidenceOwnerPath);
  if (!validCanonicalOwner(owner)) throw new Error("pointer lock owner schema mismatch");
  return { owner, rootStat, lockStat, ownerStat, ownerPath: evidenceOwnerPath };
};
const canonicalLockEvidence = () => lockEvidence(paths.pointerLockDir, "owner.json");
const canonicalLockOwner = () => canonicalLockEvidence().owner;
const controlBase = (instanceId) => ({
  version: "release-pointer-commit-keeper-v1",
  instanceId,
  pid: process.pid,
  storeDir,
  generationRoot: paths.root,
  lockDir: paths.pointerLockDir,
});

const runHold = () => {
  const controlFile = path.resolve(required("control-file"));
  const stopFile = options["stop-file"] ? path.resolve(options["stop-file"]) : null;
  const instanceId = required("instance-id");
  const waitMs = Number(required("wait-ms"));
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw new Error("invalid pointer-lock wait interval");
  }
  if (path.dirname(controlFile) === controlFile || fs.existsSync(controlFile)) {
    throw new Error("unsafe or occupied pointer keeper control file");
  }
  if (stopFile && path.dirname(stopFile) !== path.dirname(controlFile)) {
    throw new Error("pointer keeper stop file must share the private control directory");
  }
  let lockHandle = null;
  let timer = null;
  let exiting = false;
  const finish = (state, details, exitCode) => {
    if (exiting) return;
    exiting = true;
    if (timer) clearInterval(timer);
    let releaseError = null;
    try { lockHandle?.release(); } catch (error) { releaseError = error; }
    const successorOwner = lockOwner();
    const ownedLockStillPresent = ownerMatches(
      successorOwner,
      process.pid,
      lockHandle?.owner?.token,
    );
    const finalState = releaseError || ownedLockStillPresent ? "FAILED" : state;
    writeJsonAtomic(controlFile, {
      ...controlBase(instanceId),
      state: finalState,
      ownerToken: lockHandle?.owner?.token || null,
      acquiredAt: lockHandle?.owner?.acquiredAt || null,
      finishedAt: new Date().toISOString(),
      ...details,
      successorOwner: successorOwner && !ownedLockStillPresent ? {
        pid: successorOwner.pid,
        token: successorOwner.token,
        hostname: successorOwner.hostname,
        acquiredAt: successorOwner.acquiredAt,
      } : null,
      failure: releaseError
        ? String(releaseError?.message || releaseError)
        : ownedLockStillPresent ? "owned pointer lock remained after release" : null,
    });
    process.exit(finalState === state ? exitCode : 1);
  };
  try {
    lockHandle = acquirePointerCommitLock({
      lockDir: paths.pointerLockDir,
      timeoutMs: waitMs,
      staleMs: 60_000,
      pollMs: 20,
    });
    writeJsonAtomic(controlFile, {
      ...controlBase(instanceId),
      state: "HELD",
      ownerToken: lockHandle.owner.token,
      acquiredAt: lockHandle.owner.acquiredAt,
      checkedAt: new Date().toISOString(),
      failure: null,
    });
    timer = setInterval(() => {
      try {
        if (stopFile && fs.existsSync(stopFile)) {
          finish("RELEASED", { signal: "CONTROL" }, 0);
          return;
        }
        const owner = lockOwner();
        if (!ownerMatches(owner, process.pid, lockHandle.owner.token)) {
          throw new Error("pointer lock ownership changed while keeper was active");
        }
      } catch (error) {
        finish("FAILED", { signal: null, failure: String(error?.message || error) }, 1);
      }
    }, 100);
    process.on("SIGTERM", () => finish("RELEASED", { signal: "SIGTERM" }, 0));
    process.on("SIGINT", () => finish("RELEASED", { signal: "SIGINT" }, 0));
    process.on("uncaughtException", (error) => finish(
      "FAILED",
      { signal: null, failure: String(error?.message || error) },
      1,
    ));
    process.on("unhandledRejection", (error) => finish(
      "FAILED",
      { signal: null, failure: String(error?.message || error) },
      1,
    ));
  } catch (error) {
    finish("FAILED", { signal: null, failure: String(error?.message || error) }, 1);
  }
};

const requireControl = (expectedState) => {
  const controlFile = path.resolve(required("control-file"));
  const expectedInstanceId = required("instance-id");
  const expectedPid = Number(required("expected-pid"));
  const control = readJson(controlFile);
  if (
    control?.version !== "release-pointer-commit-keeper-v1"
    || control?.state !== expectedState
    || control?.instanceId !== expectedInstanceId
    || control?.pid !== expectedPid
    || control?.storeDir !== storeDir
    || control?.generationRoot !== paths.root
    || control?.lockDir !== paths.pointerLockDir
    || !ownerTokenPattern.test(String(control?.ownerToken || ""))
  ) throw new Error("pointer keeper control identity mismatch");
  return control;
};

const runVerify = () => {
  const control = requireControl("HELD");
  if (!ownerMatches(lockOwner(), control.pid, control.ownerToken)) {
    throw new Error("pointer keeper lock owner mismatch");
  }
  process.stdout.write(JSON.stringify({ pid: control.pid, token: control.ownerToken }));
};

const runIdentity = () => {
  const controlFile = path.resolve(required("control-file"));
  const control = readJson(controlFile);
  if (
    control?.version !== "release-pointer-commit-keeper-v1"
    || !["HELD", "FAILED"].includes(control?.state)
    || !Number.isSafeInteger(control?.pid) || control.pid <= 0
    || !ownerTokenPattern.test(String(control?.ownerToken || ""))
    || control?.storeDir !== storeDir
    || control?.generationRoot !== paths.root
    || control?.lockDir !== paths.pointerLockDir
  ) throw new Error("pointer keeper identity is unavailable");
  process.stdout.write(`${control.pid}\t${control.ownerToken}`);
};

const runVerifyReleased = () => {
  const control = requireControl("RELEASED");
  const expectedToken = required("expected-token");
  const currentOwner = lockOwner();
  if (
    control.ownerToken !== expectedToken
    || (fs.existsSync(paths.pointerLockDir) && !currentOwner)
    || (currentOwner && currentOwner.token === expectedToken)
    || (currentOwner && !validCanonicalOwner(currentOwner))
  ) {
    throw new Error("pointer keeper did not release the exact owned lock");
  }
};

const runVerifyUnacquiredFailure = () => {
  const controlFile = path.resolve(required("control-file"));
  const expectedInstanceId = required("instance-id");
  const expectedPid = Number(required("expected-pid"));
  const control = readJson(controlFile);
  const owner = lockOwner();
  if (
    control?.version !== "release-pointer-commit-keeper-v1"
    || control?.state !== "FAILED"
    || control?.instanceId !== expectedInstanceId
    || control?.pid !== expectedPid
    || control?.storeDir !== storeDir
    || control?.generationRoot !== paths.root
    || control?.lockDir !== paths.pointerLockDir
    || control?.ownerToken !== null
    || control?.acquiredAt !== null
    || (owner && owner.pid === expectedPid)
  ) throw new Error("pointer keeper unacquired failure identity mismatch");
};

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

const runRecoverDeadOwnerIdentity = () => {
  const controlFile = path.resolve(required("control-file"));
  const expectedPid = Number(required("expected-pid"));
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new Error("invalid expected pointer keeper pid");
  }
  if (lstatOrNull(controlFile)) {
    throw new Error("no-control recovery refuses an existing control path");
  }
  const owner = canonicalLockOwner();
  if (owner.pid !== expectedPid || owner.hostname !== os.hostname() || processAlive(expectedPid)) {
    process.stderr.write("foreign-or-live-pointer-lock\n");
    process.exit(3);
  }
  process.stdout.write(`${owner.pid}\t${owner.token}`);
};

const runCleanupDeadOwned = () => {
  const expectedPid = Number(required("expected-pid"));
  const expectedToken = required("expected-token");
  if (!lstatOrNull(paths.pointerLockDir)) return;
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !ownerTokenPattern.test(expectedToken)) {
    throw new Error("invalid expected dead-owner identity");
  }
  const initial = canonicalLockEvidence();
  if (!ownerMatches(initial.owner, expectedPid, expectedToken) || processAlive(expectedPid)) {
    process.stderr.write("foreign-or-live-pointer-lock\n");
    process.exit(3);
  }
  const beforeClaim = canonicalLockEvidence();
  if (
    !sameFilesystemIdentity(beforeClaim.lockStat, initial.lockStat)
    || !sameFilesystemIdentity(beforeClaim.ownerStat, initial.ownerStat)
    || !ownerMatches(beforeClaim.owner, expectedPid, expectedToken)
    || processAlive(expectedPid)
  ) {
    process.stderr.write("foreign-or-live-pointer-lock\n");
    process.exit(3);
  }

  const claimName = `.owner.release-claim.${process.pid}.${crypto.randomUUID()}.json`;
  const claimPath = path.join(paths.pointerLockDir, claimName);
  const restoreClaim = () => {
    const claimStat = lstatOrNull(claimPath);
    if (!claimStat || !claimStat.isFile() || claimStat.isSymbolicLink() || claimStat.nlink !== 1) return false;
    if (lstatOrNull(ownerPath)) return false;
    fs.renameSync(claimPath, ownerPath);
    return true;
  };

  fs.renameSync(ownerPath, claimPath);
  let claimed;
  try {
    claimed = lockEvidence(paths.pointerLockDir, claimName);
  } catch (error) {
    if (!restoreClaim()) throw error;
    process.stderr.write("foreign-or-live-pointer-lock\n");
    process.exit(3);
  }
  if (
    !sameFilesystemIdentity(claimed.lockStat, initial.lockStat)
    || !sameFilesystemIdentity(claimed.ownerStat, initial.ownerStat)
    || !ownerMatches(claimed.owner, expectedPid, expectedToken)
    || processAlive(expectedPid)
  ) {
    if (!restoreClaim()) throw new Error("pointer owner claim drifted and could not be restored");
    process.stderr.write("foreign-or-live-pointer-lock\n");
    process.exit(3);
  }

  const restoreExactCanonicalClaim = () => {
    let current;
    try { current = lockEvidence(paths.pointerLockDir, claimName); } catch { return false; }
    if (
      !sameFilesystemIdentity(current.lockStat, initial.lockStat)
      || !sameFilesystemIdentity(current.ownerStat, initial.ownerStat)
      || !ownerMatches(current.owner, expectedPid, expectedToken)
    ) return false;
    return restoreClaim();
  };

  const quarantineName = `.pointer-commit.lock.release-quarantine.${process.pid}.${crypto.randomUUID()}`;
  const quarantinePath = path.join(paths.root, quarantineName);
  try {
    if (lstatOrNull(quarantinePath)) throw new Error("pointer lock quarantine path collision");
    fs.renameSync(paths.pointerLockDir, quarantinePath);
  } catch (error) {
    // A failed quarantine must not leave the canonical lock ownerless. Restore
    // only when the canonical path is still the exact claimed inode. If a
    // successor replaced that path, preserve it and retain the claim evidence.
    restoreExactCanonicalClaim();
    throw error;
  }
  const quarantined = lockEvidence(quarantinePath, claimName);
  if (
    !sameFilesystemIdentity(quarantined.lockStat, initial.lockStat)
    || !sameFilesystemIdentity(quarantined.ownerStat, initial.ownerStat)
    || !ownerMatches(quarantined.owner, expectedPid, expectedToken)
    || processAlive(expectedPid)
  ) throw new Error("quarantined pointer lock identity drifted");
  fs.unlinkSync(quarantined.ownerPath);
  fs.rmdirSync(quarantinePath);
  try {
    const rootDescriptor = fs.openSync(paths.root, "r");
    try { fs.fsyncSync(rootDescriptor); } finally { fs.closeSync(rootDescriptor); }
  } catch {
    // The exact unlink+rmdir is complete even where directory fsync is unavailable.
  }
};

try {
  if (command === "hold") runHold();
  else if (command === "verify") runVerify();
  else if (command === "identity") runIdentity();
  else if (command === "verify-released") runVerifyReleased();
  else if (command === "verify-unacquired-failure") runVerifyUnacquiredFailure();
  else if (command === "recover-dead-owner-identity") runRecoverDeadOwnerIdentity();
  else if (command === "cleanup-dead-owned") runCleanupDeadOwned();
  else throw new Error(`unsupported pointer keeper command: ${command}`);
} catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exit(1);
}
POINTER_KEEPER
  )
}

cleanup_release_pointer_commit_keeper_runtime() {
  local runtime_dir="${RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR:-}"
  local control_dir="${RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR:-}"
  local helper_file="${RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE:-}"
  local module_file="${RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE:-}"
  local control_file="${RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE:-}"
  local initialized="${RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED:-0}"
  local identity device inode owner group mode links extra entry entry_identity
  [ -n "$runtime_dir" ] || return 0
  [[ "$runtime_dir" =~ ^/run/football-release-pointer-lock\.[A-Za-z0-9]{6}$ ]] || return 1
  [ "$control_dir" = "${runtime_dir}/control" ] || return 1
  [ "$helper_file" = "${runtime_dir}/keeper.cjs" ] || return 1
  [ "$module_file" = "${runtime_dir}/dataGenerationStore.cjs" ] || return 1
  [ "$control_file" = "${control_dir}/keeper-status.json" ] || return 1
  if [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
    identity="$(stat -c '%d:%i:%U:%G:%a:%h' -- "$runtime_dir")" || return 1
    IFS=: read -r device inode owner group mode links extra <<<"$identity"
    [ -z "$extra" ] && [ "$device" = "$RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE" ] \
      && [ "$inode" = "$RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE" ] \
      && [ "$owner" = "root" ] && [ "$group" = "football" ] \
      && [ "$mode" = "750" ] && { [ "$links" = "2" ] || [ "$links" = "3" ]; } \
      && [ -d "$runtime_dir" ] && [ ! -L "$runtime_dir" ] || return 1
    while IFS= read -r entry; do
      case "${entry##*/}" in
        keeper.cjs)
          [ -f "$entry" ] && [ ! -L "$entry" ] || return 1
          entry_identity="$(stat -c '%U:%G:%a:%h' -- "$entry")" || return 1
          if [ "$initialized" = "1" ]; then
            [ "$entry_identity" = "root:football:550:1" ] || return 1
          else
            case "$entry_identity" in
              root:root:600:1|root:football:600:1|root:football:550:1) ;;
              *) return 1 ;;
            esac
          fi
          ;;
        dataGenerationStore.cjs)
          [ -f "$entry" ] && [ ! -L "$entry" ] || return 1
          entry_identity="$(stat -c '%U:%G:%a:%h' -- "$entry")" || return 1
          if [ "$initialized" = "1" ]; then
            [ "$entry_identity" = "root:football:440:1" ] || return 1
          else
            case "$entry_identity" in
              root:root:600:1|root:football:600:1|root:football:440:1) ;;
              *) return 1 ;;
            esac
          fi
          ;;
        control)
          [ "$entry" = "$control_dir" ] && [ -d "$entry" ] && [ ! -L "$entry" ] || return 1
          entry_identity="$(stat -c '%U:%G:%a:%h' -- "$entry")" || return 1
          if [ "$initialized" = "1" ]; then
            [ "$entry_identity" = "football:football:700:2" ] || return 1
          else
            case "$entry_identity" in
              root:root:700:2|football:football:700:2) ;;
              *) return 1 ;;
            esac
          fi
          ;;
        *) return 1 ;;
      esac
    done < <(find "$runtime_dir" -mindepth 1 -maxdepth 1 -print)
    if [ -d "$control_dir" ]; then
      while IFS= read -r entry; do
        [ "$initialized" = "1" ] || return 1
        case "${entry##*/}" in
          keeper-status.json|keeper-status.json.*.tmp)
            [ -f "$entry" ] && [ ! -L "$entry" ] \
              && [ "$(stat -c '%U:%G:%a:%h' -- "$entry")" = "football:football:600:1" ] || return 1
            ;;
          *) return 1 ;;
        esac
      done < <(find "$control_dir" -mindepth 1 -maxdepth 1 -print)
    fi
    rm -f -- "$helper_file" "$module_file" "$control_file" "$control_file".*.tmp || return 1
    if [ -e "$control_dir" ] || [ -L "$control_dir" ]; then
      [ -d "$control_dir" ] && [ ! -L "$control_dir" ] || return 1
      rmdir -- "$control_dir" || return 1
    fi
    rmdir -- "$runtime_dir" || return 1
  fi
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR=""
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE=""
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE=""
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=0
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR=""
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE=""
  RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE=""
  RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE=""
  RELEASE_POINTER_COMMIT_KEEPER_LOCK_DIR=""
  return 0
}

release_pointer_commit_keeper_is_healthy() {
  local unit="$RELEASE_POINTER_COMMIT_KEEPER_UNIT"
  local helper_file="$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
  local module_file="$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"
  local control_file="$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE"
  local main_pid
  [ -n "$unit" ] && [ -n "$helper_file" ] && [ -n "$control_file" ] || return 1
  systemctl is-active --quiet "$unit" || return 1
  main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -f "$helper_file" ] && [ ! -L "$helper_file" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$helper_file")" = "root:football:550:1" ] || return 1
  [ -f "$module_file" ] && [ ! -L "$module_file" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$module_file")" = "root:football:440:1" ] || return 1
  [ -f "$control_file" ] && [ ! -L "$control_file" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$control_file")" = "football:football:600:1" ] || return 1
  RELEASE_POINTER_COMMIT_KEEPER_PID="$main_pid"
  "$NODE_HOME/bin/node" "$helper_file" verify \
    --module "$module_file" \
    --store-dir "$LIVE_STORE_DIR" \
    --control-file "$control_file" \
    --instance-id "$unit" \
    --expected-pid "$main_pid" >/dev/null
}

stop_release_pointer_commit_keeper() {
  local mode="${1:-cleanup}"
  local unit="$RELEASE_POINTER_COMMIT_KEEPER_UNIT"
  local helper_file="$RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE"
  local module_file="$RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE"
  local control_file="$RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE"
  local lock_dir="$RELEASE_POINTER_COMMIT_KEEPER_LOCK_DIR"
  local main_pid identity_pid identity_token identity extra stop_failed=0 forced_kill=0 cleanup_rc=0
  local recovery_identity recovery_rc=0 no_control_foreign=0 unacquired_failure=0
  [ "$mode" = "cleanup" ] || [ "$mode" = "clean" ] || return 1
  if [ "$mode" = "clean" ]; then
    release_pointer_commit_keeper_is_healthy || return 1
  fi
  if [ -n "$unit" ]; then
    main_pid="${RELEASE_POINTER_COMMIT_KEEPER_PID:-}"
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
      || main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
      || main_pid="$(systemctl show "$unit" --property=ExecMainPID --value 2>/dev/null || true)"
    identity="$("$NODE_HOME/bin/node" "$helper_file" identity \
      --module "$module_file" \
      --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" 2>/dev/null || true)"
    IFS=$'\t' read -r identity_pid identity_token extra <<<"$identity"
    if [ -n "$identity" ]; then
      [ -z "$extra" ] && [ "$identity_pid" = "$main_pid" ] \
        && [[ "$identity_token" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
        || return 1
    elif [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] \
      && "$NODE_HOME/bin/node" "$helper_file" verify-unacquired-failure \
        --module "$module_file" \
        --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" \
        --instance-id "$unit" --expected-pid "$main_pid" >/dev/null 2>&1; then
      unacquired_failure=1
    fi
    if ! systemctl stop "$unit" >/dev/null 2>&1; then
      stop_failed=1
    fi
    if ! assert_transient_unit_cleared "$unit"; then
      forced_kill=1
      systemctl kill --kill-who=all --signal=KILL "$unit" >/dev/null 2>&1 || true
      systemctl stop "$unit" >/dev/null 2>&1 || true
      assert_transient_unit_cleared "$unit" || return 1
    fi
    if [ -z "$identity" ] && [ "$unacquired_failure" -eq 0 ] \
      && { [ -e "$lock_dir" ] || [ -L "$lock_dir" ]; }; then
      # The keeper can be killed after acquirePointerCommitLock has published
      # canonical owner.json but before the first HELD control record is
      # durable.  Only after systemd proves the unit is gone may we recover
      # that exact local, dead ExecMainPID identity from the canonical path.
      # Exit 3 means a valid foreign/live/successor owner and is preservation,
      # never permission to remove it.
      [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
      set +e
      recovery_identity="$("$NODE_HOME/bin/node" "$helper_file" recover-dead-owner-identity \
        --module "$module_file" \
        --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" \
        --expected-pid "$main_pid" 2>/dev/null)"
      recovery_rc="$?"
      set -e
      if [ "$recovery_rc" -eq 0 ]; then
        IFS=$'\t' read -r identity_pid identity_token extra <<<"$recovery_identity"
        [ -n "$recovery_identity" ] && [ -z "$extra" ] && [ "$identity_pid" = "$main_pid" ] \
          && [[ "$identity_token" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
          || return 1
        identity="$recovery_identity"
        log "release pointer-commit keeper recovered exact dead owner from canonical no-control window"
      elif [ "$recovery_rc" -eq 3 ]; then
        no_control_foreign=1
      else
        return 1
      fi
    fi
    if [ "$mode" = "clean" ]; then
      [ "$stop_failed" -eq 0 ] && [ "$forced_kill" -eq 0 ] && [ -n "$identity" ] || return 1
      "$NODE_HOME/bin/node" "$helper_file" verify-released \
        --module "$module_file" \
        --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" \
        --instance-id "$unit" --expected-pid "$identity_pid" \
        --expected-token "$identity_token" || return 1
      log "release pointer-commit keeper released its exact storePaths token"
    elif [ -e "$lock_dir" ] || [ -L "$lock_dir" ]; then
      if [ -n "$identity" ]; then
        if "$NODE_HOME/bin/node" "$helper_file" verify-released \
          --module "$module_file" \
          --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" \
          --instance-id "$unit" --expected-pid "$identity_pid" \
          --expected-token "$identity_token" >/dev/null 2>&1; then
          log "release pointer-commit keeper preserved a successor writer after releasing its token"
        else
          set +e
          "$NODE_HOME/bin/node" "$helper_file" cleanup-dead-owned \
            --module "$module_file" \
            --store-dir "$LIVE_STORE_DIR" \
            --expected-pid "$identity_pid" --expected-token "$identity_token"
          cleanup_rc="$?"
          set -e
          if [ "$cleanup_rc" -eq 3 ]; then
            log "release pointer-commit keeper preserved a foreign/live successor during dead-owner cleanup"
          else
            [ "$cleanup_rc" -eq 0 ] || return "$cleanup_rc"
          fi
        fi
      else
        if [ "$unacquired_failure" -eq 1 ]; then
          log "release pointer-commit keeper preserved the foreign lock that prevented acquisition"
        elif [ "$no_control_foreign" -eq 1 ]; then
          log "release pointer-commit keeper preserved a canonical foreign/live owner after no-control shutdown"
        else
          return 1
        fi
      fi
    fi
    RELEASE_POINTER_COMMIT_KEEPER_UNIT=""
    RELEASE_POINTER_COMMIT_KEEPER_PID=""
  elif [ "$mode" = "clean" ]; then
    return 1
  fi
  cleanup_release_pointer_commit_keeper_runtime || return 1
}

start_release_pointer_commit_keeper() {
  local unit runtime_dir control_dir helper_file module_file control_file generation_root lock_dir identity
  local device inode owner group mode links extra main_pid attempt max_attempts
  local -a properties=() generation_paths=()
  [ -z "${RELEASE_POINTER_COMMIT_KEEPER_UNIT:-}" ] || return 1
  [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || {
    printf 'release pointer-commit keeper requires the sync worker to be stopped\n' >&2
    return 1
  }
  release_sync_write_barrier_is_healthy || {
    printf 'release pointer-commit keeper requires the canonical sync write barrier\n' >&2
    return 1
  }
  systemctl is-active --quiet "$SERVICE_NAME" || {
    printf 'release pointer-commit keeper must be acquired while the current HTTP service is healthy\n' >&2
    return 1
  }
  [ -f "$TRUSTED_SOURCE_DIR/server/dataGenerationStore.cjs" ] \
    && [ ! -L "$TRUSTED_SOURCE_DIR/server/dataGenerationStore.cjs" ] \
    && [ "$(stat -c '%h' -- "$TRUSTED_SOURCE_DIR/server/dataGenerationStore.cjs")" = "1" ] || return 1
  runtime_dir="$(mktemp -d /run/football-release-pointer-lock.XXXXXX)" || return 1
  chown root:football "$runtime_dir" || { rmdir -- "$runtime_dir"; return 1; }
  chmod 0750 "$runtime_dir" || { rmdir -- "$runtime_dir"; return 1; }
  identity="$(stat -c '%d:%i:%U:%G:%a:%h' -- "$runtime_dir")" || { rmdir -- "$runtime_dir"; return 1; }
  IFS=: read -r device inode owner group mode links extra <<<"$identity"
  [ -z "$extra" ] && [ "$owner" = "root" ] && [ "$group" = "football" ] \
    && [ "$mode" = "750" ] && [ "$links" = "2" ] || { rmdir -- "$runtime_dir"; return 1; }
  helper_file="${runtime_dir}/keeper.cjs"
  module_file="${runtime_dir}/dataGenerationStore.cjs"
  control_dir="${runtime_dir}/control"
  control_file="${control_dir}/keeper-status.json"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DIR="$runtime_dir"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_DEVICE="$device"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INODE="$inode"
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_DIR="$control_dir"
  RELEASE_POINTER_COMMIT_KEEPER_HELPER_FILE="$helper_file"
  RELEASE_POINTER_COMMIT_KEEPER_MODULE_FILE="$module_file"
  RELEASE_POINTER_COMMIT_KEEPER_CONTROL_FILE="$control_file"
  install -d -o football -g football -m 0700 -- "$control_dir" || return 1
  write_release_pointer_commit_keeper_helper "$helper_file" || return 1
  chown root:football "$helper_file" || return 1
  chmod 0550 "$helper_file" || return 1
  ( umask 077; set -o noclobber; cp --no-dereference --no-preserve=ownership,mode,timestamps \
    -- "$TRUSTED_SOURCE_DIR/server/dataGenerationStore.cjs" "$module_file" ) || return 1
  chown root:football "$module_file" || return 1
  chmod 0440 "$module_file" || return 1
  [ -f "$module_file" ] && [ ! -L "$module_file" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$module_file")" = "root:football:440:1" ] || return 1
  [ "$(sha256sum "$TRUSTED_SOURCE_DIR/server/dataGenerationStore.cjs" | awk '{print $1}')" \
    = "$(sha256sum "$module_file" | awk '{print $1}')" ] || return 1
  runuser -u football -- "$NODE_HOME/bin/node" -e '
    const runtimeModule = require(process.argv[1]);
    if (typeof runtimeModule.acquirePointerCommitLock !== "function"
      || typeof runtimeModule.storePaths !== "function") process.exit(1);
  ' "$module_file" || return 1
  mapfile -t generation_paths < <("$NODE_HOME/bin/node" - \
    "$module_file" "$LIVE_STORE_DIR" <<'NODE'
const path = require("node:path");
const [modulePath, storeDir] = process.argv.slice(2);
const { storePaths } = require(path.resolve(modulePath));
const paths = storePaths(path.resolve(storeDir));
process.stdout.write(`${paths.root}\n${paths.pointerLockDir}\n`);
NODE
  ) || return 1
  [ "${#generation_paths[@]}" -eq 2 ] || return 1
  generation_root="${generation_paths[0]}"
  lock_dir="${generation_paths[1]}"
  [ "$generation_root" = "${LIVE_STORE_DIR}/data-generations" ] \
    && [ "$lock_dir" = "${generation_root}/.pointer-commit.lock" ] || return 1
  [ -d "$generation_root" ] && [ ! -L "$generation_root" ] \
    && [ "$(stat -c '%U:%G' -- "$generation_root")" = "football:football" ] || return 1
  RELEASE_POINTER_COMMIT_KEEPER_LOCK_DIR="$lock_dir"
  RELEASE_POINTER_COMMIT_KEEPER_RUNTIME_INITIALIZED=1
  next_transient_unit release-pointer-commit-keeper
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties \
    | grep -v -- '--property=KillMode=' \
    | grep -v -- '--property=TimeoutStopSec=' \
    | grep -v -- '--property=RestrictAddressFamilies=')
  RELEASE_POINTER_COMMIT_KEEPER_UNIT="$unit"
  if ! systemd-run --quiet --collect --service-type=exec \
    --unit="$unit" --uid=football --working-directory="$runtime_dir" \
    "${properties[@]}" \
    --property="KillMode=mixed" \
    --property="TimeoutStopSec=20s" \
    --property="RuntimeMaxSec=120s" \
    --property="MemoryHigh=128M" \
    --property="MemoryMax=256M" \
    --property="MemorySwapMax=0" \
    --property="OOMPolicy=stop" \
    --property="TasksMax=32" \
    --property="LimitNOFILE=1024" \
    --property="PrivateNetwork=yes" \
    --property="RestrictAddressFamilies=AF_UNIX" \
    --property="ReadOnlyPaths=$runtime_dir" \
    --property="ReadWritePaths=$generation_root $control_dir" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-release" \
    -- "$NODE_HOME/bin/node" "$helper_file" hold \
      --module "$module_file" \
      --store-dir "$LIVE_STORE_DIR" --control-file "$control_file" \
      --instance-id "$unit" --wait-ms 30000; then
    stop_release_pointer_commit_keeper || true
    return 1
  fi
  max_attempts=225
  for attempt in $(seq 1 "$max_attempts"); do
    main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      RELEASE_POINTER_COMMIT_KEEPER_PID="$main_pid"
    fi
    if release_pointer_commit_keeper_is_healthy; then
      log "release pointer-commit keeper acquired the canonical storePaths lock: ${unit}"
      return 0
    fi
    systemctl is-failed --quiet "$unit" && break
    systemctl is-active --quiet "$unit" || break
    sleep 0.2
  done
  journalctl -u "$unit" --no-pager -n 80 >&2 || true
  stop_release_pointer_commit_keeper || true
  printf 'release pointer-commit keeper failed to acquire the canonical storePaths lock\n' >&2
  return 1
}

start_release_sync_write_barrier() {
  local unit runtime_dir control_file lock_dir locks_parent main_pid attempt max_attempts
  local -a properties=()
  [ -z "${RELEASE_SYNC_WRITE_BARRIER_UNIT:-}" ] || return 1
  [ "${WORKER_STOPPED_FOR_SWAP:-0}" = "1" ] || {
    printf 'release sync write barrier requires the sync worker to be stopped\n' >&2
    return 1
  }
  [ -f "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" ] \
    && [ ! -L "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" ] \
    && [ "$(stat -c '%h' -- "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs")" = "1" ] || return 1
  runtime_dir="$(mktemp -d /run/football-release-sync-barrier.XXXXXX)" || return 1
  chown football:football "$runtime_dir" || { rmdir "$runtime_dir"; return 1; }
  chmod 0700 "$runtime_dir" || { rmdir "$runtime_dir"; return 1; }
  control_file="$runtime_dir/barrier-status.json"
  # Register the private runtime immediately after it is safe.  Every locks
  # parent validation below may fail; abort/EXIT must still be able to remove
  # this exact directory even when no transient unit was started.
  RELEASE_SYNC_WRITE_BARRIER_RUNTIME_DIR="$runtime_dir"
  RELEASE_SYNC_WRITE_BARRIER_CONTROL_FILE="$control_file"
  locks_parent="$LIVE_STORE_DIR/locks"
  if [ ! -e "$locks_parent" ] && [ ! -L "$locks_parent" ]; then
    install -d -o football -g football -m 0700 -- "$locks_parent" || return 1
  fi
  [ -d "$locks_parent" ] && [ ! -L "$locks_parent" ] \
    && [ "$(stat -c '%U:%G' -- "$locks_parent")" = "football:football" ] || return 1
  chmod 0700 -- "$locks_parent" || return 1
  [ "$(stat -c '%U:%G:%a' -- "$locks_parent")" = "football:football:700" ] || return 1
  lock_dir="$LIVE_STORE_DIR/locks/sync.lock"
  next_transient_unit release-sync-write-barrier
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties \
    | grep -v -- '--property=KillMode=' \
    | grep -v -- '--property=TimeoutStopSec=' \
    | grep -v -- '--property=RestrictAddressFamilies=')
  RELEASE_SYNC_WRITE_BARRIER_UNIT="$unit"

  if ! systemd-run --quiet --collect --service-type=exec \
    --unit="$unit" --uid=football --working-directory="$NEXT_DIR" \
    "${properties[@]}" \
    --property="KillMode=mixed" \
    --property="TimeoutStopSec=20s" \
    --property="MemoryHigh=128M" \
    --property="MemoryMax=256M" \
    --property="MemorySwapMax=0" \
    --property="OOMPolicy=stop" \
    --property="TasksMax=32" \
    --property="LimitNOFILE=1024" \
    --property="PrivateNetwork=yes" \
    --property="RestrictAddressFamilies=AF_UNIX" \
    --property="ReadOnlyPaths=$NEXT_DIR" \
    --property="ReadWritePaths=$locks_parent $runtime_dir" \
    --property="InaccessiblePaths=-/etc/football-predict -/etc/football-release -/var/lib/football-release" \
    -- env SERVER_STORE_DIR="$LIVE_STORE_DIR" \
      "$NODE_HOME/bin/node" "$NEXT_DIR/scripts/runReleaseSyncWriteBarrier.cjs" \
      --store-dir "$LIVE_STORE_DIR" \
      --lock-dir "$lock_dir" \
      --control-file "$control_file" \
      --owner release-live-sqlite-prebuild \
      --source signed-release \
      --wait-ms "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS"; then
    stop_release_sync_write_barrier || true
    return 1
  fi

  max_attempts=$((RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS * 5))
  for attempt in $(seq 1 "$max_attempts"); do
    main_pid="$(systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
      RELEASE_SYNC_WRITE_BARRIER_PID="$main_pid"
    fi
    if release_sync_write_barrier_is_healthy; then
      log "release sync write barrier acquired the canonical live sync.lock: ${unit}"
      return 0
    fi
    systemctl is-failed --quiet "$unit" && break
    systemctl is-active --quiet "$unit" || break
    sleep 0.2
  done
  journalctl -u "$unit" --no-pager -n 80 >&2 || true
  stop_release_sync_write_barrier || true
  printf 'release sync write barrier failed to acquire the canonical live sync.lock\n' >&2
  return 1
}

start_release_candidate_heartbeat_keeper() {
  local unit runtime_dir control_file status_file attempt max_attempts
  local -a properties=()
  [ -z "${RELEASE_HEARTBEAT_KEEPER_UNIT:-}" ] || return 1
  [ "${WORKER_FROZEN_FOR_READINESS:-0}" = "1" ] || {
    printf 'release heartbeat keeper requires a readiness-frozen sync worker\n' >&2
    return 1
  }
  [ -f "$APP_DIR/scripts/runReleaseCandidateHeartbeatKeeper.cjs" ] \
    && [ ! -L "$APP_DIR/scripts/runReleaseCandidateHeartbeatKeeper.cjs" ] || return 1
  runtime_dir="$(mktemp -d /run/football-release-heartbeat.XXXXXX)" || return 1
  chown football:football "$runtime_dir" || { rmdir "$runtime_dir"; return 1; }
  chmod 0700 "$runtime_dir" || { rmdir "$runtime_dir"; return 1; }
  control_file="$runtime_dir/keeper-status.json"
  status_file="$LIVE_STORE_DIR/candidate-prospective-capture-status.json"
  next_transient_unit release-heartbeat-keeper
  unit="$NEXT_TRANSIENT_UNIT"
  mapfile -t properties < <(transient_build_properties \
    | grep -v -- '--property=KillMode=' \
    | grep -v -- '--property=TimeoutStopSec=')
  RELEASE_HEARTBEAT_KEEPER_UNIT="$unit"
  RELEASE_HEARTBEAT_KEEPER_RUNTIME_DIR="$runtime_dir"
  RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE="$control_file"

  if ! systemd-run --quiet --collect --service-type=exec \
    --unit="$unit" --uid=football --working-directory="$APP_DIR" \
    "${properties[@]}" \
    --property="KillMode=mixed" \
    --property="TimeoutStopSec=35s" \
    --property="MemoryHigh=900M" \
    --property="MemoryMax=1200M" \
    --property="MemorySwapMax=256M" \
    --property="OOMPolicy=stop" \
    --property="TasksMax=64" \
    --property="LimitNOFILE=4096" \
    --property="CPUWeight=50" \
    --property="IOWeight=25" \
    --property="Nice=5" \
    --property="IOSchedulingClass=best-effort" \
    --property="IOSchedulingPriority=7" \
    --property="ReadOnlyPaths=$APP_DIR $RUNTIME_ENV_FILE" \
    --property="ReadWritePaths=$LIVE_STORE_DIR $runtime_dir" \
    --property="InaccessiblePaths=-/etc/football-release -/var/lib/football-release" \
    -- /bin/bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' bash "$RUNTIME_ENV_FILE" \
      env SERVER_STORE_DIR="$LIVE_STORE_DIR" DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" \
      "$NODE_HOME/bin/node" "$APP_DIR/scripts/runReleaseCandidateHeartbeatKeeper.cjs" \
      --instance-id "$unit" \
      --capture-script "$APP_DIR/scripts/captureCandidateProspectiveDeadline.cjs" \
      --heartbeat-status-file "$status_file" \
      --control-file "$control_file" \
      --working-directory "$APP_DIR" \
      --store-dir "$LIVE_STORE_DIR" \
      --sqlite-path "$LIVE_SQLITE_PATH" \
      --interval-seconds "$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS" \
      --attempt-timeout-ms "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" \
      --lock-timeout-ms "$RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS"; then
    stop_release_candidate_heartbeat_keeper || true
    return 1
  fi

  max_attempts=$((RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS * 5))
  for attempt in $(seq 1 "$max_attempts"); do
    if release_candidate_heartbeat_keeper_is_healthy; then
      log "release heartbeat keeper published its first exact evaluatedAt and is active: ${unit}"
      return 0
    fi
    if release_candidate_heartbeat_keeper_has_latched_failure; then
      log "release heartbeat keeper latched a failure before its first exact evaluatedAt"
      break
    fi
    systemctl is-failed --quiet "$unit" && break
    systemctl is-active --quiet "$unit" || break
    sleep 0.2
  done
  journalctl -u "$unit" --no-pager -n 80 >&2 || true
  stop_release_candidate_heartbeat_keeper || true
  printf 'release heartbeat keeper failed to publish its first exact evaluatedAt\n' >&2
  return 1
}

abort_before_swap() {
  local reason="$1"
  if [ "${SWAP_STARTED:-0}" = "1" ]; then
    rollback "$reason"
  fi
  log "abort before swap: ${reason}"
  stop_release_pointer_commit_keeper \
    || { log "fail-stop: release pointer-commit keeper could not be reaped before abort"; exit 1; }
  stop_release_sync_write_barrier \
    || { log "fail-stop: release sync write barrier could not be reaped before abort"; exit 1; }
  stop_release_candidate_heartbeat_keeper \
    || { log "fail-stop: release heartbeat keeper could not be reaped before abort"; exit 1; }
  stop_candidate
  cleanup_live_sqlite_prebuild \
    || { log "fail-stop: live SQLite prebuild could not be cleaned before abort"; exit 1; }
  cleanup_build_tree || true
  rm -rf --one-file-system -- "$NEXT_DIR" || true
  exit 1
}

restore_app_tree_after_rollback() {
  if [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ]; then
    if [ -e "$FAILED_DIR" ] || [ -L "$FAILED_DIR" ]; then
      log "FAIL-STOP: FAILED is occupied; refusing to delete an unverified tree"
      return 1
    fi
    if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
      mv -T -- "$APP_DIR" "$FAILED_DIR" \
        || { log "FAIL-STOP: APP to FAILED move failed; unique backup was not moved"; return 1; }
    fi
    mv -T -- "$BACKUP_DIR" "$APP_DIR" \
      || { log "FAIL-STOP: BACKUP to APP move failed; no further tree moves will be attempted"; return 1; }
    return 0
  fi
  if [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ]; then
    log "rollback tree move was never completed; original APP remains in place"
    return 0
  fi
  log "FAIL-STOP: neither a restorable backup nor an intact APP tree exists"
  return 1
}

isolate_known_failed_tree_after_rollback() {
  if [ ! -e "$FAILED_DIR" ] && [ ! -L "$FAILED_DIR" ]; then
    return 0
  fi
  assert_safe_managed_tree "$FAILED_DIR" "FAILED" || return 1
  local identity_file="${RECOVERY_DIR}/trees/new-app.json"
  local quarantine="${FAILED_DIR}.resolved.${BUNDLE_SHA256:0:12}.$$.$RANDOM"
  [ -f "$identity_file" ] && [ ! -L "$identity_file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$identity_file")" = "0:0:600:1" ] || return 1
  node - "$FAILED_DIR" "$identity_file" <<'NODE'
const fs = require("node:fs");
const [failedPath, identityPath] = process.argv.slice(2);
const stat = fs.lstatSync(failedPath, { bigint: true });
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== BigInt(identity.dev) || stat.ino !== BigInt(identity.ino)) {
  throw new Error("FAILED is not the recorded new app identity");
}
NODE
  [ ! -e "$quarantine" ] && [ ! -L "$quarantine" ] || return 1
  mv -T -- "$FAILED_DIR" "$quarantine" || return 1
  sync -f "$(dirname "$FAILED_DIR")" || return 1
  rm -rf --one-file-system -- "$quarantine" \
    || log "warning: known failed tree was isolated but its quarantine could not be deleted: ${quarantine}"
  sync -f "$(dirname "$FAILED_DIR")" || true
}

rollback() {
  local reason="$1"
  if [ "${TRANSACTION_COMMITTED:-0}" = "1" ] || [ "${TRANSACTION_FINALIZING:-0}" = "1" ]; then
    trap - EXIT
    log "FAIL-STOP: rollback is forbidden once transaction finalization has started; recovery state retained"
    exit 1
  fi
  if [ "${SWAP_STARTED:-0}" != "1" ]; then
    abort_before_swap "$reason"
  fi
  ROLLBACK_IN_PROGRESS=1
  trap - EXIT
  log "rollback: ${reason}"
  stop_release_candidate_heartbeat_keeper || {
    log "rollback fail-stop: release heartbeat keeper could not be reaped"
    exit 1
  }
  write_recovery_phase "rollback-starting" || {
    log "rollback fail-stop: recovery phase could not be recorded"
    exit 1
  }
  stop_candidate
  local quiesce_failed=0
  stop_worker_for_release_window || true
  if systemctl cat "$WORKER_SERVICE_NAME" >/dev/null 2>&1 && systemctl is-active --quiet "$WORKER_SERVICE_NAME"; then
    quiesce_failed=1
  fi
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  SERVICE_STOPPED_FOR_SWAP=1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    quiesce_failed=1
  fi
  if [ "$quiesce_failed" -ne 0 ]; then
    log "rollback cannot safely proceed while service or worker is active; operator intervention required"
    exit 1
  fi
  stop_release_pointer_commit_keeper || {
    log "rollback fail-stop: release pointer-commit keeper could not be reaped"
    exit 1
  }
  quiesce_managed_timers_for_config_change || {
    log "rollback cannot safely quiesce managed timers; recovery/current retained"
    exit 1
  }
  restore_app_tree_after_rollback || {
    log "rollback fail-stop preserved recovery/current for operator recovery"
    exit 1
  }
  restore_live_sqlite_after_rollback || {
    log "rollback fail-stop: sqlite restoration failed; recovery/current retained"
    exit 1
  }
  cleanup_live_sqlite_prebuild || {
    log "rollback fail-stop: live SQLite prebuild cleanup failed; recovery/current retained"
    exit 1
  }
  restore_external_model_artifacts_after_rollback || {
    log "rollback fail-stop: external model artifact restoration failed; recovery/current retained"
    exit 1
  }
  restore_runtime_env_after_rollback || {
    log "rollback fail-stop: runtime env restoration failed; recovery/current retained"
    exit 1
  }
  if [ "$HOST_CONFIG_DIRTY" = "1" ]; then
    restore_managed_config_after_rollback || {
      log "rollback fail-stop: managed host config restoration failed; recovery/current retained"
      exit 1
    }
  fi
  [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ] || {
    log "rollback fail-stop: restored APP tree is unavailable"
    exit 1
  }
  cd "$APP_DIR" || exit 1
  fix_app_permissions "$APP_DIR" || { log "rollback fail-stop: app permissions failed"; exit 1; }
  fix_worker_write_permissions "$APP_DIR" || { log "rollback fail-stop: worker permissions failed"; exit 1; }
  restore_managed_unit_states_after_rollback \
    || { log "rollback incomplete: original unit states or service health were not restored"; exit 1; }
  restore_timer_states_after_rollback || { log "rollback incomplete: timer state restoration failed"; exit 1; }
  isolate_known_failed_tree_after_rollback \
    || { log "rollback incomplete: known failed tree could not be safely isolated"; exit 1; }
  write_recovery_phase "rolled-back" || { log "rollback restored state but could not record completion phase"; exit 1; }
  clear_release_recovery_snapshot || { log "rollback restored service but could not clear recovery/current"; exit 1; }
  cleanup_live_sqlite_backup || true
  log "rollback restored the previous app, exact runtime/config state, sqlite, timers, service, and worker"
  exit 1
}

release_exit_trap() {
  local status="$?"
  local recovery_restored=1
  trap - EXIT
  stop_release_pointer_commit_keeper || {
    log "fail-stop: release pointer-commit keeper could not be reaped from EXIT trap"
    exit 1
  }
  stop_release_sync_write_barrier || {
    log "fail-stop: release sync write barrier could not be reaped from EXIT trap"
    exit 1
  }
  stop_release_candidate_heartbeat_keeper || {
    log "fail-stop: release heartbeat keeper could not be reaped from EXIT trap"
    exit 1
  }
  stop_candidate || true
  cleanup_live_sqlite_prebuild || log "warning: live SQLite prebuild cleanup failed in EXIT trap"
  cleanup_build_tree || true
  if [ "$status" -ne 0 ] \
    && { [ "${TRANSACTION_FINALIZING:-0}" = "1" ] || [ "${TRANSACTION_COMMITTED:-0}" = "1" ]; }; then
    log "fail-stop after transaction finalization began; no rollback or pre-swap restoration was attempted"
    cleanup_live_sqlite_backup || true
    exit "$status"
  fi
  if [ "$status" -ne 0 ] && [ "${SWAP_STARTED:-0}" = "1" ] && [ "${ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
    rollback "unexpected command failure (exit ${status})"
  fi
  if [ "$status" -ne 0 ]; then
    if ! restore_pre_swap_transaction; then
      log "pre-swap recovery was incomplete; recovery/current retained for operator recovery"
      recovery_restored=0
    fi
    if [ "$recovery_restored" != "1" ]; then
      log "fail-stop: services were not restarted after incomplete pre-swap recovery"
    fi
  fi
  if [ "$status" -eq 0 ] && ! restore_release_fast_watcher_after_failed_pre_swap; then
    log "fail-stop: successful release left a fast watcher runtime override or paused process"
    exit 1
  fi
  if [ -n "${RECOVERY_STAGING_DIR:-}" ] && [ -d "$RECOVERY_STAGING_DIR" ]; then
    rm -rf --one-file-system -- "$RECOVERY_STAGING_DIR" || true
  fi
  cleanup_live_sqlite_backup || true
  exit "$status"
}

require_cmd npm
require_cmd node
require_cmd curl
require_cmd systemctl
require_cmd systemd-run
require_cmd runuser
require_cmd useradd
require_cmd journalctl
require_cmd realpath
require_cmd stat
require_cmd find
require_cmd seq
require_cmd pgrep
require_cmd mktemp
require_cmd sync
require_cmd rmdir
require_cmd sha256sum
require_cmd mountpoint
require_cmd readlink
require_cmd wc
require_cmd tr
require_cmd ln

if [ -z "$BUNDLE_SHA256" ] || [[ ! "$BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'a validated 64-character BUNDLE_SHA256 is required\n' >&2
  exit 1
fi
[[ "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" -ge 60 ] \
  && [ "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" -le 600 ] \
  || { printf 'invalid candidate verifier RuntimeMaxSec: %s\n' "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" >&2; exit 1; }
[[ "$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS" -ge 30 ] \
  && [ "$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS" -le 600 ] \
  || { printf 'invalid candidate pre-verification refresh budget: %s\n' "$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS" >&2; exit 1; }
[[ "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS" -ge 5 ] \
  && [ "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS" -le 120 ] \
  || { printf 'invalid candidate atomic swap margin: %s\n' "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS" >&2; exit 1; }
[[ "$CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS" -ge 30 ] \
  && [ "$CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS" -le 300 ] \
  || { printf 'invalid candidate refresh step RuntimeMaxSec: %s\n' "$CANDIDATE_REFRESH_STEP_RUNTIME_MAX_SECONDS" >&2; exit 1; }
[[ "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -ge 60 ] \
  && [ "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" -le 120 ] \
  || { printf 'invalid live SQLite prebuild RuntimeMaxSec: %s\n' "$LIVE_SQLITE_PREBUILD_RUNTIME_MAX_SECONDS" >&2; exit 1; }
[[ "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" =~ ^[01]$ ]] \
  || { printf 'invalid stopped-window SQLite export break-glass flag: %s\n' "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" >&2; exit 1; }
[[ "$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS" -ge 5 ] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS" -le 30 ] \
  || { printf 'invalid release heartbeat keeper interval: %s\n' "$RELEASE_HEARTBEAT_KEEPER_INTERVAL_SECONDS" >&2; exit 1; }
[[ "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" -ge 1000 ] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" -le 25000 ] \
  || { printf 'invalid release heartbeat keeper attempt timeout: %s\n' "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" >&2; exit 1; }
[[ "$RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS" -ge 1000 ] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS" -lt "$RELEASE_HEARTBEAT_KEEPER_ATTEMPT_TIMEOUT_MS" ] \
  || { printf 'invalid release heartbeat keeper lock timeout: %s\n' "$RELEASE_HEARTBEAT_KEEPER_LOCK_TIMEOUT_MS" >&2; exit 1; }
[[ "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS" -ge 1000 ] \
  && [ "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS" -le 120000 ] \
  || { printf 'invalid release sync write barrier lock wait: %s\n' "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS" >&2; exit 1; }
[[ "$RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS" -ge 5 ] \
  && [ "$RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS" -le 180 ] \
  && [ $((RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS * 1000)) -gt "$RELEASE_SYNC_WRITE_BARRIER_LOCK_WAIT_MS" ] \
  || { printf 'invalid release sync write barrier start timeout: %s\n' "$RELEASE_SYNC_WRITE_BARRIER_START_TIMEOUT_SECONDS" >&2; exit 1; }
[[ "$RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS" -ge 10 ] \
  && [ "$RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS" -le 120 ] \
  || { printf 'invalid release heartbeat keeper start timeout: %s\n' "$RELEASE_HEARTBEAT_KEEPER_START_TIMEOUT_SECONDS" >&2; exit 1; }
[[ "$WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS" -ge 30 ] \
  && [ "$WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS" -le 180 ] \
  || { printf 'invalid frozen worker child drain timeout: %s\n' "$WORKER_FROZEN_CHILD_DRAIN_TIMEOUT_SECONDS" >&2; exit 1; }
[[ "$WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS" -ge 30 ] \
  && [ "$WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS" -le 600 ] \
  || { printf 'invalid worker official publication timeout: %s\n' "$WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS" >&2; exit 1; }
[[ "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" -ge 30 ] \
  && [ "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" -le 600 ] \
  || { printf 'invalid post-swap transition rollback margin: %s\n' "$POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS" >&2; exit 1; }
if [ -z "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" ]; then
  POST_SWAP_TRANSITION_START_BUDGET_SECONDS=$((
    WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS + POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS
  ))
fi
[[ "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" =~ ^[0-9]+$ ]] \
  && [ "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" -ge "$((
    WORKER_OFFICIAL_PUBLISH_TIMEOUT_SECONDS + POST_SWAP_TRANSITION_ROLLBACK_MARGIN_SECONDS
  ))" ] \
  && [ "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" -le 1800 ] \
  || { printf 'invalid post-swap transition start budget: %s\n' "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" >&2; exit 1; }
if [ "$APP_DIR" != "/opt/football-predict" ] || [ "$NEXT_DIR" != "/opt/football-predict.next" ] \
  || [ "$BACKUP_DIR" != "/opt/football-predict.previous" ] || [ "$FAILED_DIR" != "/opt/football-predict.failed" ] \
  || [ "$RUNTIME_ENV_FILE" != "/etc/football-predict/env" ]; then
  printf 'managed release paths must match the fixed production topology\n' >&2
  exit 1
fi
if [[ ! "$RELEASE_SITE" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] \
  || [[ ! "$RELEASE_CHANNEL" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] \
  || [[ ! "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]]; then
  printf 'validated RELEASE_SITE, RELEASE_CHANNEL, and positive RELEASE_SEQUENCE are required\n' >&2
  exit 1
fi
if [ "${#RELEASE_SEQUENCE}" -gt 16 ] \
  || { [ "${#RELEASE_SEQUENCE}" -eq 16 ] && [[ "$RELEASE_SEQUENCE" > "9007199254740991" ]]; }; then
  printf 'RELEASE_SEQUENCE exceeds the JavaScript safe integer range\n' >&2
  exit 1
fi
if [ -z "$TRUSTED_SOURCE_DIR" ] || [ ! -d "$TRUSTED_SOURCE_DIR" ] || [ -L "$TRUSTED_SOURCE_DIR" ]; then
  printf 'root-private TRUSTED_SOURCE_DIR is required\n' >&2
  exit 1
fi
trusted_source_real="$(realpath -e -- "$TRUSTED_SOURCE_DIR")"
if [[ ! "$trusted_source_real" =~ ^/var/lib/football-release/work/${BUNDLE_SHA256}\.[A-Za-z0-9]+/trusted$ ]]; then
  printf 'trusted source is outside the guarded release work root: %s\n' "$trusted_source_real" >&2
  exit 1
fi
TRUSTED_SOURCE_DIR="$trusted_source_real"
trusted_marker="${TRUSTED_SOURCE_DIR}/.release-trusted-sha256"
if [ ! -f "$trusted_marker" ] || [ -L "$trusted_marker" ] \
  || [ "$(stat -c '%u:%g:%a:%h' -- "$trusted_marker")" != "0:0:600:1" ] \
  || [ "$(head -n 1 -- "$trusted_marker")" != "$BUNDLE_SHA256" ]; then
  printf 'trusted source marker is missing or unsafe\n' >&2
  exit 1
fi
if [ "$(stat -c '%u:%g:%a' -- "$TRUSTED_SOURCE_DIR")" != "0:0:700" ]; then
  printf 'trusted source root ownership or mode is unsafe\n' >&2
  exit 1
fi
if find "$TRUSTED_SOURCE_DIR" -xdev \( \! -user root -o -perm /022 -o -type l -o -type b -o -type c -o -type p -o -type s -o -type f -links +1 \) -print -quit | grep -q .; then
  printf 'trusted source tree failed owner, mode, type, or hard-link validation\n' >&2
  exit 1
fi
if [ ! -f "$TRUSTED_SOURCE_DIR/package.json" ] || [ -L "$TRUSTED_SOURCE_DIR/package.json" ]; then
  printf 'trusted source package.json is missing or unsafe\n' >&2
  exit 1
fi
node -e "require('node:sqlite')" >/dev/null
if [ ! -d "$APP_DIR" ]; then
  printf 'APP_DIR does not exist: %s\n' "$APP_DIR" >&2
  exit 1
fi

log "trusted signed source accepted for ${BUNDLE_SHA256}"
node "$TRUSTED_SOURCE_DIR/scripts/verifyDeploymentConfig.cjs" \
  || { printf 'trusted deployment configuration verification failed\n' >&2; exit 1; }
rotate_fixed_recovery_helper \
  || { printf 'signed fixed recovery helper rotation failed\n' >&2; exit 1; }

TLS_ACTION_DIR="${TRUSTED_SOURCE_DIR}/.release-actions"
if [ -e "$TLS_ACTION_DIR" ] || [ -L "$TLS_ACTION_DIR" ]; then
  TLS_ACTION_PATH="${TLS_ACTION_DIR}/enable-ip-tls.json"
  TLS_ACTION_RUNNER="${TRUSTED_SOURCE_DIR}/deploy/light-server/activate-signed-ip-tls.sh"
  TLS_ACTION_VALIDATOR="${TRUSTED_SOURCE_DIR}/scripts/validateTlsReleaseAction.cjs"
  [ -d "$TLS_ACTION_DIR" ] && [ ! -L "$TLS_ACTION_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$TLS_ACTION_DIR")" = "0:0:700" ] \
    || { printf 'signed release action directory is unsafe\n' >&2; exit 1; }
  [ "$(find "$TLS_ACTION_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n')" = "enable-ip-tls.json" ] \
    || { printf 'signed release action directory must contain only enable-ip-tls.json\n' >&2; exit 1; }
  for action_file in "$TLS_ACTION_PATH" "$TLS_ACTION_RUNNER" "$TLS_ACTION_VALIDATOR"; do
    [ -f "$action_file" ] && [ ! -L "$action_file" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$action_file")" = "0:0:600:1" ] \
      || { printf 'signed release action file is unsafe: %s\n' "$action_file" >&2; exit 1; }
  done
  bash -n "$TLS_ACTION_RUNNER" || { printf 'signed TLS action runner has invalid Bash syntax\n' >&2; exit 1; }
  tls_action_email="$("$NODE_HOME/bin/node" "$TLS_ACTION_VALIDATOR" "$TLS_ACTION_PATH" \
    "$RELEASE_SITE" "$RELEASE_CHANNEL" "$RELEASE_SEQUENCE")" \
    || { printf 'signed TLS action validation failed\n' >&2; exit 1; }
  [ -n "$tls_action_email" ] && [[ "$tls_action_email" != *$'\n'* ]] && [[ "$tls_action_email" != *$'\r'* ]] \
    || { printf 'signed TLS action validator returned an unsafe email value\n' >&2; exit 1; }
  log "execute the signed, one-time IP TLS release action"
  env -i \
    PATH="$PATH" \
    HOME="/root" \
    LANG="C.UTF-8" \
    TLS_SIGNED_SOURCE_ROOT="$TRUSTED_SOURCE_DIR" \
    TLS_SIGNED_ACME_EMAIL="$tls_action_email" \
    NODE_BIN="$NODE_HOME/bin/node" \
    bash "$TLS_ACTION_RUNNER" \
    || { printf 'signed IP TLS release action failed\n' >&2; exit 1; }
  log "signed IP TLS release action complete"
  rm -f -- "$TLS_ACTION_PATH" \
    || { printf 'validated TLS action request could not be removed\n' >&2; exit 1; }
  rmdir -- "$TLS_ACTION_DIR" \
    || { printf 'validated TLS action directory could not be removed\n' >&2; exit 1; }
  PUBLIC_BASE_URL="https://170.106.75.73"
  log "continue the signed application release over the verified HTTPS origin"
fi

trap release_exit_trap EXIT
log "preflight current service before stale backup cleanup"
wait_for_health "http://${HOST}:${PORT}" "preflight-before-topology-cleanup" 90 2 service \
  || { printf 'current service is unhealthy; preserving the existing backup and refusing release\n' >&2; exit 1; }
prepare_managed_tree_topology_for_transaction \
  || { printf 'managed APP/BACKUP/FAILED/NEXT topology is unsafe before transaction start\n' >&2; exit 1; }
initialize_release_recovery_snapshot
RUNTIME_ENV_DIRTY=1
write_recovery_phase "runtime-env-updating"
prepare_runtime_env "$TRUSTED_SOURCE_DIR/deploy/light-server/env.example"
assert_runtime_env_safe
write_recovery_phase "runtime-env-updated"
ensure_build_user
assert_build_user_quiescent || { printf 'build user is not quiescent before release\n' >&2; exit 1; }

log "preflight current service"
wait_for_health "http://${HOST}:${PORT}" "preflight-before-build" 90 2 service \
  || abort_before_swap "current service is not healthy before bundle release"

log "create isolated build tree from trusted source"
cleanup_build_tree || abort_before_swap "stale isolated build tree could not be removed"
rm -rf --one-file-system -- "$NEXT_DIR" || abort_before_swap "stale final assembly tree could not be removed"
install -d -o root -g root -m 0700 -- "$BUILD_DIR"
cp -a --no-dereference -- "$TRUSTED_SOURCE_DIR/." "$BUILD_DIR/"
rm -f -- "$BUILD_DIR/.release-trusted-sha256"
install -d -o root -g root -m 0700 -- "$BUILD_DIR/.release-archive-evidence"
copy_regular_file_nofollow \
  "$BUILD_DIR/public/data/prediction-snapshots.json" \
  "$BUILD_DIR/.release-archive-evidence/prediction-snapshots.json" \
  || abort_before_swap "signed pre-match archive evidence could not be preserved"
copy_regular_file_nofollow \
  "$BUILD_DIR/public/data/matches-current.json" \
  "$BUILD_DIR/.release-archive-evidence/matches-current.json" \
  || abort_before_swap "signed current archive evidence could not be preserved"
stop_worker_for_release_window \
  || abort_before_swap "sync worker could not be paused for candidate cache snapshot"
preserve_live_public_data_cache "$APP_DIR" "$BUILD_DIR" \
  || abort_before_swap "live public cache failed no-follow validation"
restart_worker_if_needed \
  || abort_before_swap "sync worker could not resume during isolated candidate build"
chown -hR "$BUILD_USER:$BUILD_USER" "$BUILD_DIR"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME"

log "build candidate inside disposable transient cgroups"
run_build_step npm-ci env PATH="$PATH" HOME="$BUILD_HOME" npm_config_cache="${BUILD_HOME}/.npm" NODE_ENV=development \
  "$NODE_HOME/bin/npm" ci --include=dev --ignore-scripts
compact_public_odds_history "$BUILD_DIR"
log "migrate immutable pre-match reference archives from preserved snapshots"
run_build_step archive-migration env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  PUBLIC_DATA_DIR="$BUILD_DIR/public/data" \
  ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR="$BUILD_DIR/.release-archive-evidence" \
  "$NODE_HOME/bin/npm" run datastore:migrate-archives \
  || abort_before_swap "candidate pre-match archive migration failed"
prepare_candidate_llm_cache \
  || abort_before_swap "candidate LLM cache repair/audit failed in writable build tree"
run_build_step application-build env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  "$NODE_HOME/bin/npm" run build
run_build_step candidate-datastore env PATH="$PATH" HOME="$BUILD_HOME" SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" \
  DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  "$NODE_HOME/bin/npm" run datastore:sqlite
run_candidate_model_artifact_catchup "$CANDIDATE_STORE_DIR" "$CANDIDATE_SQLITE_PATH"
chown -R "$BUILD_USER:$BUILD_USER" "$CANDIDATE_STORE_DIR"
run_build_step npm-prune env PATH="$PATH" HOME="$BUILD_HOME" npm_config_cache="${BUILD_HOME}/.npm" NODE_ENV=production \
  "$NODE_HOME/bin/npm" prune --omit=dev --ignore-scripts
assert_build_user_quiescent || abort_before_swap "build user is not quiescent before artifact validation"
validate_build_artifacts || abort_before_swap "strict build artifact validation failed"
normalize_validated_artifact_modes "$BUILD_DIR" || abort_before_swap "validated artifact mode normalization failed"
validate_build_artifacts || abort_before_swap "normalized build artifacts failed strict revalidation"

log "assemble brand-new final tree from trusted source and validated artifacts"
assemble_final_tree || abort_before_swap "trusted final tree assembly failed"
fix_app_permissions "$NEXT_DIR"
fix_worker_write_permissions "$NEXT_DIR"
validate_build_artifacts "$NEXT_DIR" || abort_before_swap "assembled artifact tree changed safety properties"
verify_worker_write_permissions "$NEXT_DIR" || abort_before_swap "candidate worker write probe failed"

log "start root-owned assembled candidate on ${HOST}:${CANDIDATE_PORT}"
CANDIDATE_ADMIN_TOKEN="release-candidate-admin-$$"
CANDIDATE_ACCESS_SECRET="release-candidate-secret-$$"
start_candidate_unit "$NEXT_DIR" env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_SECRET="$CANDIDATE_ACCESS_SECRET" \
  HOST="$HOST" PORT="$CANDIDATE_PORT" \
  ENABLE_SYNC_CRON=0 ENABLE_GPT_CRON=0 RELAY_FAST_WATCHER_ENABLED=0 SYNC_WORKER_EVENT_BRIDGE=0 \
  DATASTORE_READ_SOURCE=sqlite \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  "$NODE_HOME/bin/node" server/index.cjs \
  || abort_before_swap "candidate transient unit failed to start"

wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server" 90 2 service \
  || abort_before_swap "candidate health failed"
# Acquire the transition lease before pausing production writes. The lease
# includes every future live cutoff, candidate decision/finalization boundary,
# and kickoff archive boundary in the candidate current file. If the complete
# refresh + bounded verifier + atomic-swap budget does not fit, fail safely now;
# never wait for a better window while the worker is paused.
CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT="$("$NODE_HOME/bin/node" -e 'process.stdout.write(new Date().toISOString())')" \
  || abort_before_swap "candidate transition lease instant could not be captured"
[ -n "$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT" ] \
  || abort_before_swap "candidate transition lease instant was empty"
[ ! -e "$CANDIDATE_TRANSITION_LEASE" ] && [ ! -L "$CANDIDATE_TRANSITION_LEASE" ] \
  || abort_before_swap "candidate transition lease path already exists"
"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseTransitionLease.cjs" create \
  --current "$NEXT_DIR/public/data/matches-current.json" \
  --lease "$CANDIDATE_TRANSITION_LEASE" \
  --at "$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT" \
  --verifier-runtime-max-seconds "$CANDIDATE_VERIFIER_RUNTIME_MAX_SECONDS" \
  --preverify-refresh-budget-seconds "$CANDIDATE_PREVERIFY_REFRESH_BUDGET_SECONDS" \
  --atomic-swap-margin-seconds "$CANDIDATE_ATOMIC_SWAP_MARGIN_SECONDS" \
  || abort_before_swap "candidate transition horizon is unsafe before worker pause"
[ -f "$CANDIDATE_TRANSITION_LEASE" ] && [ ! -L "$CANDIDATE_TRANSITION_LEASE" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$CANDIDATE_TRANSITION_LEASE")" = "0:0:600:1" ] \
  || abort_before_swap "candidate transition lease metadata is unsafe"
# Pause production writes only while the candidate archive and SQLite snapshot
# are refreshed at one fixed instant. The live worker is resumed before the
# longer isolated candidate verifier, then paused again for the bounded live
# SQLite prebuild and atomic handoff below.
stop_worker_for_release_window \
  || abort_before_swap "sync worker could not be paused for candidate readiness"
refresh_candidate_capture_heartbeat_for_readiness "$APP_DIR" "$NEXT_DIR" \
  || abort_before_swap "candidate deadline capture heartbeat refresh failed after candidate worker freeze"
# The worker intentionally remains live during the long build. A match can
# therefore cross kickoff after the first archive migration while the assembled
# candidate still contains its already-recorded pre-cutoff prediction snapshot.
# Freeze production writes, stop the candidate so it cannot retain stale JSON or
# SQLite caches, then re-run only the archive attachment migration at one fixed
# instant. The migration's signed implementation accepts only existing
# pre-cutoff snapshots; it does not collect odds or create a new prediction.
stop_candidate || abort_before_swap "candidate could not stop for archive refresh"
chown -R "$BUILD_USER:$BUILD_USER" "$NEXT_DIR/public/data" \
  || abort_before_swap "candidate public data could not be prepared for archive refresh"
run_candidate_refresh_step candidate-archive-refresh env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  PUBLIC_DATA_DIR="$NEXT_DIR/public/data" \
  ARCHIVE_MIGRATION_EVIDENCE_DATA_DIR="$BUILD_DIR/.release-archive-evidence" \
  ARCHIVE_MIGRATION_CAPTURED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT" \
  "$NODE_HOME/bin/npm" run datastore:migrate-archives \
  || abort_before_swap "candidate pre-verification archive refresh failed"
run_candidate_refresh_step candidate-sqlite-refresh env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  "$NODE_HOME/bin/npm" run datastore:sqlite \
  || abort_before_swap "candidate sqlite refresh after archive migration failed"
run_candidate_refresh_step candidate-deadline-capture-refresh env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT="$CANDIDATE_ARCHIVE_REFRESH_CAPTURED_AT" \
  "$NODE_HOME/bin/node" scripts/captureCandidateProspectiveDeadline.cjs \
  || abort_before_swap "candidate deadline capture failed at archive refresh instant"
fix_app_permissions "$NEXT_DIR" \
  || abort_before_swap "candidate permissions failed after archive refresh"
fix_worker_write_permissions "$NEXT_DIR" \
  || abort_before_swap "candidate worker permissions failed after archive refresh"
validate_build_artifacts "$NEXT_DIR" \
  || abort_before_swap "candidate archive refresh changed artifact safety properties"

start_candidate_unit "$NEXT_DIR" env PATH="$PATH" HOME="$BUILD_HOME" NODE_ENV=production \
  ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_SECRET="$CANDIDATE_ACCESS_SECRET" \
  HOST="$HOST" PORT="$CANDIDATE_PORT" \
  ENABLE_SYNC_CRON=0 ENABLE_GPT_CRON=0 RELAY_FAST_WATCHER_ENABLED=0 SYNC_WORKER_EVENT_BRIDGE=0 \
  DATASTORE_READ_SOURCE=sqlite \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  "$NODE_HOME/bin/node" server/index.cjs \
  || abort_before_swap "refreshed candidate transient unit failed to start"
wait_for_health "http://${HOST}:${CANDIDATE_PORT}" "candidate-server-refreshed" 90 2 service \
  || abort_before_swap "refreshed candidate health failed"
# The candidate server and verifier use their isolated store. Resume the live
# worker before the long verifier so production result publication and the
# prospective cutoff heartbeat remain fresh. The worker is paused again only
# for the bounded live SQLite prebuild and atomic handoff below.
restart_worker_if_needed \
  || abort_before_swap "sync worker could not resume during isolated candidate verification"
run_trusted_candidate_verifier env PATH="$PATH" HOME="$BUILD_HOME" ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  MODEL_INPUT_AUDIT_MIN_MARKET_ROWS=30 \
  VERIFY_BASE_URL="http://${HOST}:${CANDIDATE_PORT}" VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=1 \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  "$NODE_HOME/bin/node" scripts/verifyProductionReadiness.cjs \
  || abort_before_swap "candidate production readiness failed"

stop_candidate || abort_before_swap "candidate transient cgroup did not clear"
assert_build_user_quiescent || abort_before_swap "build user is not quiescent after candidate stop"
cleanup_build_tree || abort_before_swap "isolated build tree cleanup failed"
snapshot_app_tree_identity "$RECOVERY_DIR" "new-app" "$NEXT_DIR" "/opt/football-predict.next" \
  || abort_before_swap "candidate app identity could not be persisted"
write_recovery_phase "candidate-validated" || abort_before_swap "recovery phase update failed"
link_runtime_env "$NEXT_DIR"

# Install and validate the trusted static-SPA routing while the current Node
# service is still healthy. The host config is already covered by the recovery
# snapshot, so any pre-swap failure restores the exact previous config. Doing
# this before the service pause prevents route refreshes from becoming 502s
# during the slower SQLite/tree handoff below.
HOST_CONFIG_DIRTY=1
log "install trusted nginx SPA routing before the live service pause"
write_recovery_phase "host-config-changing" \
  || abort_before_swap "recovery phase update failed before pre-swap host config"
install_systemd_units "$TRUSTED_SOURCE_DIR" \
  || abort_before_swap "trusted pre-swap systemd unit install failed"
install_nginx_config "$TRUSTED_SOURCE_DIR" \
  || abort_before_swap "trusted pre-swap nginx config reload failed"
systemctl daemon-reload || abort_before_swap "pre-swap systemd daemon reload failed"
write_recovery_phase "host-config-applied" \
  || abort_before_swap "recovery phase update failed after pre-swap host config"
wait_for_health "http://${HOST}:${PORT}" "post-preswap-nginx-reload" 90 2 service \
  || abort_before_swap "current service became unhealthy after pre-swap nginx reload"

# Stop timers and any already-running monitor/cleanup jobs before stopping the
# HTTP service. football-monitor.service has Wants=football-predict.service;
# if a timer fires during this window it can otherwise start the service again
# between `systemctl stop` and the active-state guard.
TIMER_STATE_DIRTY=1
quiesce_managed_maintenance_for_sqlite_snapshot \
  || abort_before_swap "managed maintenance could not be quiesced before watcher pause"
stop_worker_for_release_window \
  || abort_before_swap "sync worker could not be paused before live SQLite prebuild"
pause_current_fast_watcher_for_live_prebuild \
  || abort_before_swap "current fast result watcher could not be paused for live SQLite prebuild"
assert_live_sqlite_prebuild_capacity \
  || abort_before_swap "live SQLite prebuild capacity gate rejected the release host"
refresh_candidate_capture_heartbeat_for_readiness "$APP_DIR" "$NEXT_DIR" \
  || abort_before_swap "candidate deadline capture heartbeat refresh failed before live SQLite prebuild"
start_release_sync_write_barrier \
  || abort_before_swap "canonical live sync write barrier could not be acquired before sqlite snapshot"
if ! prepare_live_sqlite_prebuild "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"; then
  cleanup_live_sqlite_prebuild \
    || abort_before_swap "failed live SQLite prebuild could not be cleaned safely"
  if [ "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" != "1" ]; then
    abort_before_swap "live SQLite prebuild failed before service stop; refusing a long stopped-window export"
  fi
  log "BREAK-GLASS: live SQLite prebuild unavailable; explicitly allow the stopped-window export"
else
  assert_release_fast_watcher_pause_guard \
    || abort_before_swap "fast watcher pause guard failed after live SQLite prebuild"
  assert_candidate_capture_heartbeat_refresh_fresh \
    "$LIVE_SQLITE_PREBUILD_HEARTBEAT_MAX_AGE_SECONDS" post-live-sqlite-prebuild \
    || abort_before_swap "candidate deadline capture heartbeat exceeded 90 seconds after live SQLite prebuild"
  wait_for_health "http://${HOST}:${PORT}" "post-live-sqlite-prebuild" 60 2 service \
    || abort_before_swap "current service degraded during live SQLite prebuild"
  run_as_service_user_with_runtime_env env \
    PERF_BASE_URL="http://${HOST}:${PORT}" PERF_START_SERVER=0 \
    PERF_REQUESTS=12 PERF_CONCURRENCY=3 PERF_WARMUP_REQUESTS=3 \
    PERF_WARMUP_CONCURRENCY=1 PERF_MAX_P95_MS=1500 PERF_MAX_ERROR_RATE=0 \
    "$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/verifyApiPerformance.cjs" \
    || abort_before_swap "current HTTP pressure gate failed after live SQLite prebuild"
  assert_release_fast_watcher_pause_guard \
    || abort_before_swap "fast watcher pause guard failed after current HTTP pressure gate"
fi
assert_live_sqlite_prebuild_capacity \
  || abort_before_swap "post-pressure live SQLite prebuild capacity gate rejected the release host"
assert_candidate_capture_heartbeat_refresh_fresh \
  "$POST_PREBUILD_HTTP_HEARTBEAT_MAX_AGE_SECONDS" post-live-sqlite-http-pressure \
  || abort_before_swap "candidate deadline capture heartbeat exceeded 110 seconds before second refresh"
refresh_candidate_capture_heartbeat_for_readiness "$APP_DIR" "$NEXT_DIR" \
  || abort_before_swap "candidate deadline capture heartbeat refresh failed after live SQLite prebuild"
[ "${LIVE_SQLITE_PREBUILD_READY:-0}" != "1" ] \
  || start_release_pointer_commit_keeper \
  || abort_before_swap "canonical generation pointer-commit lock could not be acquired before SQLite seal CAS"
assert_release_fast_watcher_pause_guard \
  || abort_before_swap "fast watcher pause guard failed before the live service stop"
stop_service_for_release_window || abort_before_swap "live service could not be paused before swap"
stop_release_sync_write_barrier clean \
  || abort_before_swap "canonical live sync write barrier did not drain cleanly after service stop"
snapshot_external_model_artifacts_for_rollback \
  || abort_before_swap "external model artifact rollback snapshot failed"
"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/candidateReleaseContinuity.cjs" snapshot \
  --registry "$RECOVERY_DIR/external-model-artifacts/candidate-registry" \
  --output "$RECOVERY_DIR/candidate-release-continuity-before.json" \
  --bundle-sha256 "$BUNDLE_SHA256" \
  --release-sequence "$RELEASE_SEQUENCE" \
  || abort_before_swap "candidate release continuity baseline could not be captured"
if [ "${LIVE_SQLITE_PREBUILD_READY:-0}" = "1" ]; then
  if ! verify_live_sqlite_prebuild_after_freeze; then
    if [ "${LIVE_SQLITE_PREBUILD_ADOPTED:-0}" = "1" ]; then
      abort_before_swap "prebuilt rollback snapshot was adopted but its recovery phase could not be committed"
    fi
    stop_release_pointer_commit_keeper clean \
      || abort_before_swap "generation pointer-commit keeper did not drain after rejected SQLite prebuild"
    cleanup_live_sqlite_prebuild \
      || abort_before_swap "rejected live SQLite prebuild could not be cleaned safely"
    if [ "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" != "1" ]; then
      abort_before_swap "post-freeze SQLite seal CAS rejected the prebuild; restart without swapping"
    fi
    log "BREAK-GLASS: post-freeze SQLite seal CAS rejected the prebuild; use stopped-window snapshot/export"
    backup_live_sqlite_for_rollback "$LIVE_SQLITE_PATH" \
      || abort_before_swap "break-glass live sqlite rollback snapshot failed"
  else
    release_pointer_commit_keeper_is_healthy \
      || abort_before_swap "generation pointer-commit keeper failed after SQLite seal CAS"
  fi
else
  [ "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" = "1" ] \
    || abort_before_swap "live SQLite prebuild disappeared without break-glass authorization"
  backup_live_sqlite_for_rollback "$LIVE_SQLITE_PATH" \
    || abort_before_swap "break-glass live sqlite rollback snapshot failed"
fi

log "swap release"
[ ! -e "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] \
  || abort_before_swap "BACKUP appeared after transaction preparation"
[ ! -e "$FAILED_DIR" ] && [ ! -L "$FAILED_DIR" ] \
  || abort_before_swap "FAILED appeared after transaction preparation"
write_recovery_phase "swap-starting" || abort_before_swap "recovery phase update failed"
# BUILD_DIR has already been removed. Re-read the assembled NEXT current file,
# prove its transition-driving digest is unchanged, and retain the configured
# margin for the two atomic directory renames. This guard is intentionally the
# final operation before SWAP_STARTED; it never sleeps or retries while the
# worker and live service are paused.
CANDIDATE_TRANSITION_LEASE_VERIFIED_AT="$("$NODE_HOME/bin/node" -e 'process.stdout.write(new Date().toISOString())')" \
  || abort_before_swap "candidate transition lease verification instant could not be captured"
"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/releaseTransitionLease.cjs" verify \
  --current "$NEXT_DIR/public/data/matches-current.json" \
  --lease "$CANDIDATE_TRANSITION_LEASE" \
  --at "$CANDIDATE_TRANSITION_LEASE_VERIFIED_AT" \
  --required-margin-seconds "$POST_SWAP_TRANSITION_START_BUDGET_SECONDS" \
  || abort_before_swap "candidate transition crossed or atomic swap margin expired"
[ -z "${RELEASE_POINTER_COMMIT_KEEPER_UNIT:-}" ] \
  || release_pointer_commit_keeper_is_healthy \
  || abort_before_swap "generation pointer-commit keeper failed immediately before app swap"
SWAP_STARTED=1
mv "$APP_DIR" "$BACKUP_DIR" || rollback "current app could not be moved to backup"
mv "$NEXT_DIR" "$APP_DIR" || rollback "candidate app could not be activated"
[ -z "${RELEASE_POINTER_COMMIT_KEEPER_UNIT:-}" ] \
  || release_pointer_commit_keeper_is_healthy \
  || rollback "generation pointer-commit keeper failed during app swap"
write_recovery_phase "swap-complete" || rollback "recovery phase update failed after swap"
if [ -n "${BUNDLE_SHA256:-}" ]; then
  printf '%s\n' "$BUNDLE_SHA256" >"${APP_DIR}/.release-bundle-sha256.next" || rollback "bundle identity marker could not be written"
  chown root:root "${APP_DIR}/.release-bundle-sha256.next" || rollback "bundle identity marker ownership failed"
  chmod 0644 "${APP_DIR}/.release-bundle-sha256.next" || rollback "bundle identity marker permissions failed"
  mv "${APP_DIR}/.release-bundle-sha256.next" "${APP_DIR}/.release-bundle-sha256" || rollback "bundle identity marker could not be committed"
fi

cd "$APP_DIR"
sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR" store-only \
  || rollback "post-swap model artifact mirror failed"
if [ "${LIVE_SQLITE_PREBUILD_READY:-0}" = "1" ]; then
  release_pointer_commit_keeper_is_healthy \
    || rollback "generation pointer-commit keeper failed before prebuilt SQLite activation"
  activate_prebuilt_live_sqlite || rollback "CAS-verified prebuilt live SQLite activation failed"
  release_pointer_commit_keeper_is_healthy \
    || rollback "generation pointer-commit keeper failed during prebuilt SQLite activation"
  stop_release_pointer_commit_keeper clean \
    || rollback "generation pointer-commit keeper did not release cleanly after SQLite activation"
else
  [ -z "${RELEASE_POINTER_COMMIT_KEEPER_UNIT:-}" ] \
    || rollback "generation pointer-commit keeper remained active on the break-glass SQLite path"
  [ "$ALLOW_STOPPED_WINDOW_SQLITE_EXPORT" = "1" ] \
    || rollback "prebuilt live SQLite disappeared without break-glass authorization"
  refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH" \
    || rollback "post-swap live store refresh failed"
fi
verify_store_write_permissions "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH" \
  || rollback "live store write-permission verification failed"
verify_worker_write_permissions "$APP_DIR" || rollback "live worker write probe failed"
restart_service_if_needed || rollback "service restart failed"

wait_for_health "http://${HOST}:${PORT}" "post-swap-service" 120 2 service \
  || rollback "post-swap health failed"
assert_release_fast_watcher_health_state 1 \
  || rollback "post-swap service did not restore the fast watcher"
if [ "${RELEASE_REFRESH_AFTER_HEALTH:-0}" = "1" ]; then
  refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH" || rollback "post-health live store refresh failed"
  wait_for_health "http://${HOST}:${PORT}" "post-refresh-service" 120 2 service \
    || rollback "post-refresh health failed"
else
  log "skip post-health live sqlite refresh; already refreshed before service restart"
fi
if [ "${RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1}" = "1" ]; then
  if [ "${RELEASE_MODEL_CATCHUP_IN_MANDATORY_WORKER:-1}" = "1" ]; then
    log "defer live model catchup to the mandatory release worker cycle"
  else
    log "run deferred model catchup while the healthy HTTP service remains available"
    if run_model_artifact_catchup "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"; then
      if ! run_as_service_user_with_runtime_env env SERVER_STORE_DIR="$LIVE_STORE_DIR" \
        DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" \
        SQLITE_VACUUM_AFTER_EXPORT=0 \
        SQLITE_WAL_CHECKPOINT_MODE=PASSIVE \
        npm run datastore:sqlite; then
        log "warning: deferred model reconciliation export failed; sync worker will retry"
      fi
    else
      log "warning: deferred model catchup failed closed; recommendation safety gate remains authoritative"
    fi
    wait_for_health "http://${HOST}:${PORT}" "post-deferred-model-catchup" \
      "${RELEASE_DEFERRED_HEALTH_TIMEOUT_SECONDS:-180}" 2 service \
      || rollback "service health failed after deferred model catchup"
  fi
fi
if ! prepare_release_enrichment_reuse_request; then
  log "warning: enrichment reuse request preparation failed; continuing with the complete enrichment lane"
  clear_release_enrichment_reuse_request || true
fi
prepare_release_worker_priority_request \
  || rollback "release worker priority request could not be prepared"
WORKER_RELEASE_STARTED_AT="$("$NODE_HOME/bin/node" -e 'process.stdout.write(new Date().toISOString())')" \
  || rollback "worker release start marker could not be created"
start_worker_for_live_release || rollback "sync worker failed to start after release"
wait_for_worker_official_publish_after "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json" \
  || rollback "sync worker failed to publish official results for this release"
wait_for_worker_readiness_idle_after "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json" \
  || rollback "sync worker failed to reach readiness-safe idle for this release"
refresh_candidate_capture_heartbeat_for_readiness "$APP_DIR" "$APP_DIR" \
  || rollback "candidate deadline capture heartbeat refresh failed before worker freeze"
freeze_worker_for_readiness "$WORKER_RELEASE_STARTED_AT" "$LIVE_STORE_DIR/sync-worker-status.json" \
  || rollback "sync worker could not be frozen in readiness-safe idle"
wait_for_frozen_worker_children_to_drain "$WORKER_FROZEN_MAIN_PID" \
  || rollback "frozen sync worker child processes did not drain before keeper handoff"
start_release_candidate_heartbeat_keeper \
  || rollback "release heartbeat keeper failed its first exact evaluatedAt gate"
clear_release_worker_priority_request \
  || rollback "one-cycle release worker priority request could not be cleared"
clear_release_enrichment_reuse_request \
  || rollback "one-cycle enrichment reuse request could not be cleared"
run_as_service_user_with_runtime_env env VERIFY_BASE_URL="http://${HOST}:${PORT}" \
  VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=1 VERIFY_SQLITE_PREVALIDATED=1 \
  SERVER_STORE_DIR="$LIVE_STORE_DIR" \
  DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyProductionReadiness.cjs" \
  || rollback "post-swap production readiness failed"
release_candidate_heartbeat_keeper_is_healthy \
  || rollback "release heartbeat keeper failed during production readiness"
"$NODE_HOME/bin/node" "$TRUSTED_SOURCE_DIR/scripts/candidateReleaseContinuity.cjs" verify \
  --registry "$LIVE_STORE_DIR/model-artifacts/candidate-prospective-registry.json" \
  --snapshot "$RECOVERY_DIR/candidate-release-continuity-before.json" \
  --output "$RECOVERY_DIR/candidate-release-continuity-after.json" \
  --bundle-sha256 "$BUNDLE_SHA256" \
  --release-sequence "$RELEASE_SEQUENCE" \
  || rollback "candidate release continuity verification failed"
[ ! -e "${APP_DIR}/.release-candidate-continuity.next" ] \
  && [ ! -L "${APP_DIR}/.release-candidate-continuity.next" ] \
  || rollback "candidate release continuity temporary marker already exists"
[ ! -e "${APP_DIR}/.release-candidate-continuity.json" ] \
  && [ ! -L "${APP_DIR}/.release-candidate-continuity.json" ] \
  || rollback "candidate release continuity marker already exists"
install -o root -g root -m 0644 \
  "$RECOVERY_DIR/candidate-release-continuity-after.json" \
  "${APP_DIR}/.release-candidate-continuity.next" \
  || rollback "candidate release continuity marker could not be installed"
mv -fT -- "${APP_DIR}/.release-candidate-continuity.next" \
  "${APP_DIR}/.release-candidate-continuity.json" \
  || rollback "candidate release continuity marker could not be committed"
[ -f "${APP_DIR}/.release-candidate-continuity.json" ] \
  && [ ! -L "${APP_DIR}/.release-candidate-continuity.json" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "${APP_DIR}/.release-candidate-continuity.json")" = "0:0:644:1" ] \
  || rollback "candidate release continuity marker metadata validation failed"
sync -f "${APP_DIR}/.release-candidate-continuity.json" \
  || rollback "candidate release continuity marker file sync failed"
sync -f "$APP_DIR" \
  || rollback "candidate release continuity marker directory sync failed"
release_candidate_heartbeat_keeper_is_healthy \
  || rollback "release heartbeat keeper failed before public readiness"

if [ -n "$PUBLIC_BASE_URL" ]; then
  log "verify public origin ${PUBLIC_BASE_URL}"
  # Deployment readiness requires a functioning service, protected API,
  # SQLite, worker, and frontend assets. Upstream source freshness remains a
  # separate business-health signal and already fails formal picks closed; it
  # must not roll back a valid code release after a long enrichment cycle.
  REMOTE_BASE_URL="$PUBLIC_BASE_URL" \
  REMOTE_REQUIRE_HEALTHY=0 \
  REMOTE_REQUIRE_SQLITE=1 \
  REMOTE_REQUIRE_SYNC_WORKER=1 \
  REMOTE_SQLITE_READY_ATTEMPTS="${REMOTE_SQLITE_READY_ATTEMPTS:-12}" \
  REMOTE_SQLITE_READY_RETRY_DELAY_MS="${REMOTE_SQLITE_READY_RETRY_DELAY_MS:-5000}" \
  REMOTE_SYNC_WORKER_ATTEMPTS="${REMOTE_SYNC_WORKER_ATTEMPTS:-12}" \
  REMOTE_SYNC_WORKER_RETRY_DELAY_MS="${REMOTE_SYNC_WORKER_RETRY_DELAY_MS:-5000}" \
  run_as_service_user "$NODE_HOME/bin/node" "$APP_DIR/scripts/verifyRemotePublicReadiness.cjs" \
    || rollback "public origin readiness failed"
fi
release_candidate_heartbeat_keeper_is_healthy \
  || rollback "release heartbeat keeper failed during public readiness"
stop_release_candidate_heartbeat_keeper clean \
  || rollback "release heartbeat keeper could not be reaped after readiness"
resume_worker_after_readiness || rollback "sync worker failed to resume after readiness"
write_recovery_phase "readiness-passed" || rollback "recovery phase update failed after readiness"
enable_managed_timers_after_readiness || rollback "managed timers could not be enabled after readiness"

printf '%s\n' "$BUNDLE_SHA256" >"${APP_DIR}/.release-live-complete.next" || rollback "release completion marker could not be written"
chown root:root "${APP_DIR}/.release-live-complete.next" || rollback "release completion marker ownership failed"
chmod 0644 "${APP_DIR}/.release-live-complete.next" || rollback "release completion marker permissions failed"
mv "${APP_DIR}/.release-live-complete.next" "${APP_DIR}/.release-live-complete" || rollback "release completion marker could not be committed"
chmod 0644 "${APP_DIR}/.release-live-complete" || rollback "release completion marker permissions failed"
commit_release_transaction || rollback "recovery commit phase could not be recorded"
if ! clear_release_recovery_snapshot; then
  log "warning: committed release retained recovery/current for roll-forward verification"
fi
SERVICE_STOPPED_FOR_SWAP=0
WORKER_STOPPED_FOR_SWAP=0
WORKER_FROZEN_FOR_READINESS=0
WORKER_FROZEN_MAIN_PID=""
RELEASE_HEARTBEAT_KEEPER_UNIT=""
RELEASE_HEARTBEAT_KEEPER_RUNTIME_DIR=""
RELEASE_HEARTBEAT_KEEPER_CONTROL_FILE=""
trap - EXIT
cleanup_live_sqlite_backup || log "warning: could not remove live sqlite rollback snapshot after commit"
cleanup_live_sqlite_prebuild || log "warning: could not remove live SQLite prebuild evidence after commit"

if [ -d "$BACKUP_DIR" ]; then
  link_runtime_env "$BACKUP_DIR" || log "warning: could not replace legacy backup env with external runtime-env link"
fi

if [ "$KEEP_BACKUP" != "1" ]; then
  rm -rf "$BACKUP_DIR" || log "warning: could not remove ${BACKUP_DIR} after commit"
fi
rm -rf "$FAILED_DIR" || log "warning: could not remove ${FAILED_DIR} after commit"
log "bundle release complete"
