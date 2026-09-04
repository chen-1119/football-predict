#!/usr/bin/env bash
set -euo pipefail

builtin printf '%s\n' 'deploy/light-server/release.sh is disabled: unsigned Git-based production releases are not permitted.' >&2
builtin printf '%s\n' 'Use only the signed path: npm run release:bundle && npm run verify:release-bundle && npm run release:deploy-bundle' >&2
builtin exit 64

APP_DIR="${APP_DIR:-/opt/football-predict}"
NEXT_DIR="${NEXT_DIR:-${APP_DIR}.next}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}.previous}"
FAILED_DIR="${FAILED_DIR:-${APP_DIR}.failed}"
CANDIDATE_STORE_DIR="${CANDIDATE_STORE_DIR:-${NEXT_DIR}/server-data}"
CANDIDATE_SQLITE_PATH="${CANDIDATE_SQLITE_PATH:-${CANDIDATE_STORE_DIR}/football.db}"
REPO_URL="${REPO_URL:-}"
REF="${REF:-origin/main}"
SERVICE_NAME="${SERVICE_NAME:-football-predict}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-football-sync-worker}"
NODE_HOME="${NODE_HOME:-/opt/node-v22.22.1}"
PRIMARY_READ_SOURCE="sqlite"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8788}"
CANDIDATE_PORT="${CANDIDATE_PORT:-8789}"
KEEP_BACKUP="${KEEP_BACKUP:-1}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-/etc/football-predict/env}"
BUILD_USER="${BUILD_USER:-football-build}"

log() {
  printf '[football-release] %s\n' "$*"
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

run_as_build_user() {
  runuser -u "$BUILD_USER" -- "$@"
}

run_as_service_user() {
  runuser -u football -- "$@"
}

run_as_service_user_with_runtime_env() {
  runuser -u football -- bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' bash "$RUNTIME_ENV_FILE" "$@"
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

assert_release_tree_has_no_sensitive_entries() {
  local candidate_root="$1"
  local candidate_path
  local relative_path
  while IFS= read -r -d '' candidate_path; do
    relative_path="${candidate_path#${candidate_root}/}"
    if is_sensitive_release_path "$relative_path"; then
      printf 'candidate contains forbidden sensitive entry: %s\n' "$relative_path" >&2
      return 1
    fi
  done < <(find "$candidate_root" -mindepth 1 -path "${candidate_root}/.git" -prune -o -print0)
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
  local persisted_postgres_mode
  PRIMARY_READ_SOURCE="sqlite"
  persisted_postgres_mode="$(sed -n 's/^FOOTBALL_POSTGRES_MODE=//p' "$env_file" | tail -n 1 | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  if [ "$persisted_postgres_mode" = "primary" ]; then
    PRIMARY_READ_SOURCE="postgres"
  fi
  set_env_value "$env_file" "CURRENT_MATCH_SOURCE" "$PRIMARY_READ_SOURCE"
  set_env_value "$env_file" "DATASTORE_READ_SOURCE" "$PRIMARY_READ_SOURCE"
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
  set_env_value "$env_file" "SYNC_WORKER_MIN_IDLE_SECONDS" "5"
  set_env_value "$env_file" "SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES" "60"
  set_env_value "$env_file" "SYNC_WORKER_EVENT_BRIDGE" "1"
  set_env_value "$env_file" "SYNC_WORKER_EVENT_POLL_MS" "1000"
  set_env_value "$env_file" "DATASTORE_COMPACT_ON_SYNC" "1"
  set_env_value "$env_file" "DATASTORE_COMPACT_INTERVAL_MINUTES" "60"
  set_env_value "$env_file" "NODE_OPTIONS" "--max-old-space-size=1536"
  set_env_value "$env_file" "ODDS_HISTORY_RETENTION_DAYS" "14"
  set_env_value "$env_file" "ODDS_HISTORY_MAX_ROWS" "12000"
  if ! grep -q '^ENABLE_API_FOOTBALL_SYNC=' "$env_file"; then
    set_env_value "$env_file" "ENABLE_API_FOOTBALL_SYNC" "0"
  fi
  set_env_value "$env_file" "ENABLE_FREE_FOOTBALL_SYNC" "1"
  set_env_value "$env_file" "ENABLE_PREMATCH_SIGNALS_SYNC" "1"
  set_env_value "$env_file" "FIVE_HUNDRED_DETAILS_MAX_MATCHES" "24"
  set_env_value "$env_file" "FIVE_HUNDRED_DETAILS_NEAR_REFRESH_MINUTES" "60"
  set_env_value "$env_file" "FIVE_HUNDRED_DETAILS_URGENT_REFRESH_MINUTES" "20"
  set_env_value "$env_file" "SQLITE_BUSY_TIMEOUT_MS" "60000"
  set_env_value "$env_file" "SQLITE_EXPORT_ATTEMPTS" "3"
  set_env_value "$env_file" "SQLITE_EXPORT_RETRY_DELAY_MS" "5000"
  set_env_value "$env_file" "ENABLE_MODEL_BACKTEST_ON_SYNC" "1"
  set_env_value "$env_file" "MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES" "120"
  set_env_value "$env_file" "ENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE" "1"
  set_env_value "$env_file" "CANDIDATE_PROSPECTIVE_CAPTURE_INTERVAL_SECONDS" "30"
  set_env_value "$env_file" "CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS" "100000"
  set_env_value "$env_file" "CANDIDATE_PROSPECTIVE_CAPTURE_RECOVERY_BUDGET_MS" "55000"
  set_env_value "$env_file" "MODEL_BACKTEST_SQLITE_ODDS_LIMIT" "120000"
  set_env_value "$env_file" "MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT" "50000"
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
  local public_data_dir="${app_dir}/public/data"
  mkdir -p "$store_dir" "${store_dir}/model-artifacts" || return 1
  mkdir -p "$public_data_dir" || return 1
  if [ -f "${store_dir}/model-strategy.json" ]; then
    cp "${store_dir}/model-strategy.json" "${public_data_dir}/model-strategy.json" || return 1
    chmod 0644 "${public_data_dir}/model-strategy.json" || return 1
  elif [ -f "${public_data_dir}/model-strategy.json" ]; then
    cp "${public_data_dir}/model-strategy.json" "${store_dir}/model-strategy.json" || return 1
    chmod 0644 "${store_dir}/model-strategy.json" || return 1
  fi
  if [ -f "${store_dir}/model-artifacts/evaluation.json" ]; then
    cp "${store_dir}/model-artifacts/evaluation.json" "${public_data_dir}/model-evaluation.json" || return 1
    chmod 0644 "${public_data_dir}/model-evaluation.json" || return 1
  elif [ -f "${public_data_dir}/model-evaluation.json" ]; then
    cp "${public_data_dir}/model-evaluation.json" "${store_dir}/model-artifacts/evaluation.json" || return 1
    chmod 0644 "${store_dir}/model-artifacts/evaluation.json" || return 1
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
  run_as_service_user env SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    npm run model:backtest || return 1
  run_as_service_user env SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    npm run optimize:strategy || return 1
  sync_model_artifact_mirrors "$store_dir" "$app_dir" || return 1
}

run_candidate_model_artifact_catchup() {
  local store_dir="$1"
  local sqlite_path="$2"
  run_as_build_user env HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    npm run model:backtest || return 1
  run_as_build_user env HOME="${BUILD_HOME:-/nonexistent}" SERVER_STORE_DIR="$store_dir" \
    DATASTORE_SQLITE_PATH="$sqlite_path" \
    npm run optimize:strategy || return 1
  sync_model_artifact_mirrors "$store_dir" "$NEXT_DIR" || return 1
}

refresh_live_store_after_swap() {
  local store_dir="$1"
  local sqlite_path="$2"
  local export_mode="${RELEASE_EXPORT_LIVE_SQLITE:-always}"
  local defer_model_catchup="${RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1}"

  live_sqlite_export() {
    run_as_service_user env SERVER_STORE_DIR="$store_dir" \
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
    else
      log "defer live model catchup until the HTTP service is healthy"
    fi
    return 0
  fi

  log "refresh live sqlite ${sqlite_path}"
  live_sqlite_export || return 1
  if [ "$defer_model_catchup" != "1" ]; then
    run_model_artifact_catchup "$store_dir" "$sqlite_path" || return 1
  else
    log "defer live model catchup until the HTTP service is healthy"
  fi
}

preserve_live_public_data_cache() {
  local source_app_dir="$1"
  local target_app_dir="$2"
  if [ ! -d "${source_app_dir}/public/data" ] || [ ! -d "${target_app_dir}/public/data" ]; then
    return 0
  fi

  local copied=0
  local data_files=(
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
  )
  for file in "${data_files[@]}"; do
    if [ -f "${source_app_dir}/public/data/${file}" ]; then
      cp -p "${source_app_dir}/public/data/${file}" "${target_app_dir}/public/data/${file}"
      copied=$((copied + 1))
    fi
  done

  local root_files=(matches.json odds-history.json)
  for file in "${root_files[@]}"; do
    if [ -f "${source_app_dir}/public/${file}" ]; then
      cp -p "${source_app_dir}/public/${file}" "${target_app_dir}/public/${file}"
      copied=$((copied + 1))
    fi
  done

  if [ "$copied" -gt 0 ]; then
    log "preserved ${copied} live public data cache files"
  fi
}

fix_store_permissions() {
  local store_dir="$1"
  if id football >/dev/null 2>&1 && [ -d "$store_dir" ]; then
    chown -R football:football "$store_dir" >/dev/null 2>&1 || return 1
  fi
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
  find "$app_dir" -path "${app_dir}/node_modules" -prune -o -type f -exec chmod 0644 {} + >/dev/null 2>&1 || return 1
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
  run_as_build_user env COMPACT_APP_DIR="$app_dir" \
    COMPACT_RETENTION_DAYS="${ODDS_HISTORY_RETENTION_DAYS:-14}" \
    COMPACT_MAX_ROWS="${ODDS_HISTORY_MAX_ROWS:-12000}" \
    NODE_OPTIONS=--max-old-space-size=4096 \
    node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const appDir = process.env.COMPACT_APP_DIR;
const retentionDays = Math.max(1, Number(process.env.COMPACT_RETENTION_DAYS || 14));
const maxRows = Math.max(1000, Number(process.env.COMPACT_MAX_ROWS || 12000));
const files = [
  path.join(appDir, "public", "data", "odds-history.json"),
  path.join(appDir, "public", "odds-history.json")
];
const source = files.find((file) => fs.existsSync(file));
if (!source) process.exit(0);

const payload = JSON.parse(fs.readFileSync(source, "utf8"));
const rows = Array.isArray(payload.rows) ? payload.rows : [];
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const kept = rows.filter((row) => {
  const time = Date.parse(row?.capturedAt || row?.oddsUpdatedAt || row?.kickoffTime || "");
  return Number.isFinite(time) && time >= cutoff;
}).slice(-maxRows);
const compact = {
  ...payload,
  retentionDays,
  maxRows,
  compactedAt: new Date().toISOString(),
  rows: kept
};
const body = `${JSON.stringify(compact, null, 2)}\n`;
for (const file of files) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, body);
  fs.renameSync(`${file}.tmp`, file);
}
console.log(JSON.stringify({ ok: true, compactedOddsHistory: true, beforeRows: rows.length, keptRows: kept.length, bytes: Buffer.byteLength(body) }));
NODE
}

install_systemd_units() {
  if [ -f deploy/light-server/football-predict.service ]; then
    install -m 0644 deploy/light-server/football-predict.service /etc/systemd/system/football-predict.service || return 1
  fi
  if [ -f deploy/light-server/football-sync-worker.service ]; then
    install -m 0644 deploy/light-server/football-sync-worker.service /etc/systemd/system/football-sync-worker.service || return 1
  fi
  for unit in football-cleanup.service football-cleanup.timer football-monitor.service football-monitor.timer; do
    if [ -f "deploy/light-server/${unit}" ]; then
      install -m 0644 "deploy/light-server/${unit}" "/etc/systemd/system/${unit}" || return 1
    fi
  done
}

install_nginx_config() {
  if ! command -v nginx >/dev/null 2>&1 || [ ! -f deploy/light-server/nginx.conf ]; then
    return 0
  fi
  local tls_site_enabled=0
  if [ -e /etc/nginx/sites-enabled/football-predict-tls ] || [ -L /etc/nginx/sites-enabled/football-predict-tls ]; then
    tls_site_enabled=1
  fi
  # Ubuntu's stock site also declares default_server on port 80. The football
  # site owns that role after deployment, so the stock symlink must be removed.
  rm -f /etc/nginx/sites-enabled/default || return 1
  if [ ! -f deploy/light-server/nginx-http-common.conf ] || [ ! -f deploy/light-server/nginx-server-common.conf ] || [ ! -f deploy/light-server/nginx-security-headers.conf ]; then
    log "legacy monolithic nginx config detected"
    install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled || return 1
    install -m 0644 deploy/light-server/nginx.conf /etc/nginx/sites-available/football-predict || return 1
    if [ "$tls_site_enabled" = "1" ]; then
      if [ ! -f /etc/nginx/conf.d/football-predict-common.conf ] || [ ! -f /etc/nginx/snippets/football-predict-server.conf ] || [ ! -f /etc/nginx/snippets/football-predict-security-headers.conf ]; then
        printf 'enabled TLS site requires installed managed nginx common config\n' >&2
        return 1
      fi
      rm -f /etc/nginx/sites-enabled/football-predict || return 1
    else
      rm -f /etc/nginx/conf.d/football-predict-common.conf /etc/nginx/snippets/football-predict-server.conf /etc/nginx/snippets/football-predict-security-headers.conf || return 1
      ln -sfn /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict || return 1
    fi
  else
    install -d -m 0755 /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled || return 1
    install -m 0644 deploy/light-server/nginx-http-common.conf /etc/nginx/conf.d/football-predict-common.conf || return 1
    install -m 0644 deploy/light-server/nginx-server-common.conf /etc/nginx/snippets/football-predict-server.conf || return 1
    install -m 0644 deploy/light-server/nginx-security-headers.conf /etc/nginx/snippets/football-predict-security-headers.conf || return 1
    install -m 0644 deploy/light-server/nginx.conf /etc/nginx/sites-available/football-predict || return 1
    if [ "$tls_site_enabled" = "1" ]; then
      log "preserve enabled host-local TLS site"
      rm -f /etc/nginx/sites-enabled/football-predict || return 1
    else
      ln -sfn /etc/nginx/sites-available/football-predict /etc/nginx/sites-enabled/football-predict || return 1
    fi
  fi
  nginx -t || return 1
  if command -v systemctl >/dev/null 2>&1 && systemctl cat nginx >/dev/null 2>&1; then
    systemctl reload nginx || return 1
  else
    nginx -s reload || return 1
  fi
}

http_ok() {
  curl -fsS --max-time 8 "$1" >/dev/null
}

wait_for_health() {
  local base_url="$1"
  local deadline=$((SECONDS + 60))
  until http_ok "${base_url}/api/v1/health"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'timed out waiting for %s/api/v1/health\n' "$base_url" >&2
      return 1
    fi
    sleep 2
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
  if [ -n "${CANDIDATE_PID:-}" ] && kill -0 "$CANDIDATE_PID" >/dev/null 2>&1; then
    kill "$CANDIDATE_PID" >/dev/null 2>&1 || true
    wait "$CANDIDATE_PID" >/dev/null 2>&1 || true
  fi
  CANDIDATE_PID=""
}

restore_model_artifacts_after_rollback() {
  if [ ! -d "$APP_DIR" ]; then
    return 0
  fi
  (
    cd "$APP_DIR" || exit 0
    local rollback_store_dir="/var/lib/football-predict"
    local rollback_sqlite_path="${rollback_store_dir}/football.db"
    if run_model_artifact_catchup "$rollback_store_dir" "$rollback_sqlite_path"; then
      log "rollback model artifacts refreshed"
    else
      log "rollback model catch-up failed; mirroring restored public artifacts"
      sync_model_artifact_mirrors "$rollback_store_dir" || true
    fi
    fix_store_permissions "$rollback_store_dir" || true
    fix_worker_write_permissions "$APP_DIR" || true
  ) || true
}

WORKER_STOPPED_FOR_SWAP=0
SERVICE_STOPPED_FOR_SWAP=0
SWAP_STARTED=0
ROLLBACK_IN_PROGRESS=0
LIVE_SQLITE_PATH=""
LIVE_SQLITE_BACKUP_DIR=""

cleanup_live_sqlite_backup() {
  local cleanup_status=0
  if [ -n "${LIVE_SQLITE_BACKUP_DIR:-}" ] && [ -d "$LIVE_SQLITE_BACKUP_DIR" ]; then
    rm -rf "$LIVE_SQLITE_BACKUP_DIR" || cleanup_status=$?
  fi
  LIVE_SQLITE_BACKUP_DIR=""
  return "$cleanup_status"
}

backup_live_sqlite_for_rollback() {
  local sqlite_path="$1"
  local sqlite_name="${sqlite_path##*/}"
  local suffix
  LIVE_SQLITE_PATH="$sqlite_path"
  LIVE_SQLITE_BACKUP_DIR="${sqlite_path}.release-backup.$$"
  rm -rf "$LIVE_SQLITE_BACKUP_DIR" || return 1
  mkdir -p "$LIVE_SQLITE_BACKUP_DIR" || return 1
  for suffix in "" "-wal" "-shm"; do
    if [ -f "${sqlite_path}${suffix}" ]; then
      cp -p "${sqlite_path}${suffix}" "${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}" || return 1
    fi
  done
  log "captured live sqlite rollback state at ${LIVE_SQLITE_BACKUP_DIR}"
}

restore_live_sqlite_after_rollback() {
  if [ -z "${LIVE_SQLITE_PATH:-}" ] || [ -z "${LIVE_SQLITE_BACKUP_DIR:-}" ] || [ ! -d "$LIVE_SQLITE_BACKUP_DIR" ]; then
    return 0
  fi
  local sqlite_name="${LIVE_SQLITE_PATH##*/}"
  local suffix
  rm -f "$LIVE_SQLITE_PATH" "${LIVE_SQLITE_PATH}-wal" "${LIVE_SQLITE_PATH}-shm" || return 1
  for suffix in "" "-wal" "-shm"; do
    if [ -f "${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}" ]; then
      cp -p "${LIVE_SQLITE_BACKUP_DIR}/${sqlite_name}${suffix}" "${LIVE_SQLITE_PATH}${suffix}" || return 1
    fi
  done
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
  SERVICE_STOPPED_FOR_SWAP=0
}

stop_worker_for_release_window() {
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

abort_before_swap() {
  local reason="$1"
  if [ "${SWAP_STARTED:-0}" = "1" ]; then
    rollback "$reason"
  fi
  log "abort before swap: ${reason}"
  stop_candidate
  exit 1
}

rollback() {
  local reason="$1"
  if [ "${SWAP_STARTED:-0}" != "1" ]; then
    abort_before_swap "$reason"
  fi
  ROLLBACK_IN_PROGRESS=1
  trap - EXIT
  log "rollback: ${reason}"
  stop_candidate
  local rollback_failed=0
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
  if [ -d "$BACKUP_DIR" ]; then
    rm -rf "${FAILED_DIR}" || rollback_failed=1
    if [ -e "$APP_DIR" ]; then
      mv "$APP_DIR" "${FAILED_DIR}" || rollback_failed=1
    fi
    mv "$BACKUP_DIR" "$APP_DIR" || rollback_failed=1
  elif [ ! -d "$APP_DIR" ]; then
    log "rollback cannot restore app: ${BACKUP_DIR} is missing"
    rollback_failed=1
  fi
  restore_live_sqlite_after_rollback || rollback_failed=1
  if [ -d "$APP_DIR" ]; then
    cd "$APP_DIR" || rollback_failed=1
    restore_model_artifacts_after_rollback || rollback_failed=1
    install_systemd_units || rollback_failed=1
    systemctl daemon-reload || rollback_failed=1
    install_nginx_config || rollback_failed=1
    fix_app_permissions "$APP_DIR" || rollback_failed=1
    fix_worker_write_permissions "$APP_DIR" || rollback_failed=1
  fi
  if restart_service_if_needed; then
    wait_for_health "http://${HOST}:${PORT}" || rollback_failed=1
  else
    rollback_failed=1
  fi
  restart_worker_if_needed || rollback_failed=1
  cleanup_live_sqlite_backup || rollback_failed=1
  if [ "$rollback_failed" -ne 0 ]; then
    log "rollback incomplete; operator intervention required"
  else
    log "rollback restored the previous app, runtime config, sqlite, service, and worker"
  fi
  exit 1
}

release_exit_trap() {
  local status="$?"
  trap - EXIT
  stop_candidate || true
  if [ "$status" -ne 0 ] && [ "${SWAP_STARTED:-0}" = "1" ] && [ "${ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
    rollback "unexpected command failure (exit ${status})"
  fi
  if [ "$status" -ne 0 ]; then
    restart_service_if_needed || log "failed to restart ${SERVICE_NAME} after interrupted release"
    restart_worker_if_needed || log "failed to restart ${WORKER_SERVICE_NAME} after interrupted release"
  fi
  cleanup_live_sqlite_backup || true
  exit "$status"
}

require_cmd git
require_cmd npm
require_cmd node
require_cmd curl
require_cmd systemctl
require_cmd runuser
require_cmd useradd

if [ ! -d "$APP_DIR" ]; then
  printf 'APP_DIR does not exist: %s\n' "$APP_DIR" >&2
  exit 1
fi

if [ -z "$REPO_URL" ]; then
  REPO_URL="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
fi
if [ -z "$REPO_URL" ]; then
  printf 'REPO_URL is required when %s has no origin remote\n' "$APP_DIR" >&2
  exit 1
fi

trap release_exit_trap EXIT
log "pause the sync worker before current-service health preflight"
stop_worker_for_release_window || abort_before_swap "sync worker could not be paused before health preflight"
log "preflight current service"
wait_for_health "http://${HOST}:${PORT}" || abort_before_swap "current service is not healthy before release"
stop_worker_for_release_window || abort_before_swap "sync worker could not be paused"

log "prepare candidate at ${NEXT_DIR}"
rm -rf "$NEXT_DIR"
git clone "$REPO_URL" "$NEXT_DIR"
git -C "$NEXT_DIR" fetch --all --tags --prune
git -C "$NEXT_DIR" checkout "$REF"
assert_release_tree_has_no_sensitive_entries "$NEXT_DIR"

prepare_runtime_env "${NEXT_DIR}/deploy/light-server/env.example"
assert_runtime_env_safe
preserve_live_public_data_cache "$APP_DIR" "$NEXT_DIR"
ensure_build_user
chown -R "$BUILD_USER:$BUILD_USER" "$NEXT_DIR"
BUILD_HOME="${NEXT_DIR}/.build-home"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0700 "$BUILD_HOME"

cd "$NEXT_DIR"

log "build candidate"
run_as_build_user env HOME="$BUILD_HOME" npm_config_cache="${BUILD_HOME}/.npm" NODE_ENV=development npm ci --include=dev
compact_public_odds_history "$NEXT_DIR"
run_as_build_user env HOME="$BUILD_HOME" NODE_ENV=production npm run build
run_as_build_user env HOME="$BUILD_HOME" SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" \
  DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  npm run datastore:sqlite
run_candidate_model_artifact_catchup "$CANDIDATE_STORE_DIR" "$CANDIDATE_SQLITE_PATH"
chown -R "$BUILD_USER:$BUILD_USER" "$CANDIDATE_STORE_DIR"
run_as_build_user env HOME="$BUILD_HOME" npm run verify:deployment-config

log "start candidate on ${HOST}:${CANDIDATE_PORT}"
CANDIDATE_ADMIN_TOKEN="release-candidate-admin-$$"
CANDIDATE_ACCESS_SECRET="release-candidate-secret-$$"
run_as_build_user env HOME="$BUILD_HOME" NODE_ENV=production \
  ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_SECRET="$CANDIDATE_ACCESS_SECRET" \
  HOST="$HOST" PORT="$CANDIDATE_PORT" \
  ENABLE_SYNC_CRON=0 ENABLE_GPT_CRON=0 DATASTORE_READ_SOURCE=sqlite \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  node server/index.cjs >"${NEXT_DIR}/candidate.out.log" 2>"${NEXT_DIR}/candidate.err.log" &
CANDIDATE_PID="$!"

wait_for_health "http://${HOST}:${CANDIDATE_PORT}" || abort_before_swap "candidate health failed"
run_as_build_user env HOME="$BUILD_HOME" ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  ACCESS_CODE_ADMIN_TOKEN="$CANDIDATE_ADMIN_TOKEN" \
  VERIFY_BASE_URL="http://${HOST}:${CANDIDATE_PORT}" VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=1 \
  SERVER_STORE_DIR="$CANDIDATE_STORE_DIR" DATASTORE_SQLITE_PATH="$CANDIDATE_SQLITE_PATH" \
  npm run verify:production || abort_before_swap "candidate production readiness failed"

stop_candidate
rm -rf "$BUILD_HOME"
fix_app_permissions "$NEXT_DIR"
fix_worker_write_permissions "$NEXT_DIR"
verify_worker_write_permissions "$NEXT_DIR" || abort_before_swap "candidate worker write probe failed"
link_runtime_env "$NEXT_DIR"
stop_worker_for_release_window || abort_before_swap "sync worker could not be paused before swap"
LIVE_STORE_DIR="/var/lib/football-predict"
LIVE_SQLITE_PATH="${LIVE_STORE_DIR}/football.db"
stop_service_for_release_window || abort_before_swap "live service could not be paused before swap"
backup_live_sqlite_for_rollback "$LIVE_SQLITE_PATH" || abort_before_swap "live sqlite rollback snapshot failed"

log "swap release"
rm -rf "$BACKUP_DIR" || abort_before_swap "stale backup directory could not be cleared"
SWAP_STARTED=1
mv "$APP_DIR" "$BACKUP_DIR" || rollback "current app could not be moved to backup"
mv "$NEXT_DIR" "$APP_DIR" || rollback "candidate app could not be activated"

cd "$APP_DIR"
LIVE_STORE_DIR="/var/lib/football-predict"
LIVE_SQLITE_PATH="${LIVE_STORE_DIR}/football.db"
sync_model_artifact_mirrors "$LIVE_STORE_DIR" "$APP_DIR" \
  || rollback "post-swap model artifact mirror failed"
refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH" || rollback "post-swap live store refresh failed"
fix_store_permissions "$LIVE_STORE_DIR" || rollback "live store permissions failed"
fix_app_permissions "$APP_DIR" || rollback "live app permissions failed"
fix_worker_write_permissions "$APP_DIR" || rollback "live worker write permissions failed"
verify_worker_write_permissions "$APP_DIR" || rollback "live worker write probe failed"

if [ "$PRIMARY_READ_SOURCE" = "postgres" ]; then
  log "apply PostgreSQL schema migrations and rebuild the order-preserving primary projection"
  run_as_service_user_with_runtime_env env \
    FOOTBALL_POSTGRES_QUERY_TIMEOUT_MS=300000 \
    "$NODE_HOME/bin/npm" run postgres:migrate-schema \
    || rollback "PostgreSQL schema migration failed"
  run_as_service_user_with_runtime_env "$NODE_HOME/bin/npm" run postgres:backfill \
    || rollback "PostgreSQL order-preserving backfill failed"
fi

install_systemd_units || rollback "systemd unit install failed"
install_nginx_config || rollback "nginx config reload failed"
systemctl daemon-reload || rollback "systemd daemon reload failed"
for timer in football-cleanup.timer football-monitor.timer; do
  if systemctl cat "$timer" >/dev/null 2>&1; then
    systemctl enable --now "$timer" >/dev/null 2>&1 || rollback "timer enable failed: ${timer}"
  fi
done
restart_service_if_needed || rollback "service restart failed"

wait_for_health "http://${HOST}:${PORT}" || rollback "post-swap health failed"
if [ "${RELEASE_REFRESH_AFTER_HEALTH:-0}" = "1" ]; then
  refresh_live_store_after_swap "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH" || rollback "post-health live store refresh failed"
  wait_for_health "http://${HOST}:${PORT}" || rollback "post-refresh health failed"
else
  log "skip post-health live sqlite refresh; already refreshed before service restart"
fi
if [ "${RELEASE_DEFER_MODEL_CATCHUP_UNTIL_HEALTH:-1}" = "1" ]; then
  log "run deferred model catchup while the healthy HTTP service remains available"
  if run_model_artifact_catchup "$LIVE_STORE_DIR" "$LIVE_SQLITE_PATH"; then
    if ! run_as_service_user env SERVER_STORE_DIR="$LIVE_STORE_DIR" \
      DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" \
      SQLITE_VACUUM_AFTER_EXPORT=0 \
      SQLITE_WAL_CHECKPOINT_MODE=PASSIVE \
      npm run datastore:sqlite; then
      log "warning: deferred model reconciliation export failed; sync worker will retry"
    fi
  else
    log "warning: deferred model catchup failed closed; recommendation safety gate remains authoritative"
  fi
  wait_for_health "http://${HOST}:${PORT}" || rollback "service health failed after deferred model catchup"
fi
run_as_service_user_with_runtime_env env VERIFY_BASE_URL="http://${HOST}:${PORT}" \
  VERIFY_START_SERVER=0 VERIFY_REQUIRE_SQLITE=1 VERIFY_REQUIRED_READ_SOURCE="$PRIMARY_READ_SOURCE" SERVER_STORE_DIR="$LIVE_STORE_DIR" \
  DATASTORE_SQLITE_PATH="$LIVE_SQLITE_PATH" npm run verify:production \
  || rollback "post-swap production readiness failed"

start_worker_for_live_release || rollback "sync worker failed to start after release"

if [ -n "$PUBLIC_BASE_URL" ]; then
  log "verify public origin ${PUBLIC_BASE_URL}"
  REMOTE_BASE_URL="$PUBLIC_BASE_URL" \
  REMOTE_REQUIRE_HEALTHY=1 \
  REMOTE_REQUIRE_SQLITE=1 REMOTE_REQUIRED_READ_SOURCE="$PRIMARY_READ_SOURCE" \
  REMOTE_REQUIRE_SYNC_WORKER=1 \
  REMOTE_SQLITE_READY_ATTEMPTS="${REMOTE_SQLITE_READY_ATTEMPTS:-12}" \
  REMOTE_SQLITE_READY_RETRY_DELAY_MS="${REMOTE_SQLITE_READY_RETRY_DELAY_MS:-5000}" \
  REMOTE_SYNC_WORKER_ATTEMPTS="${REMOTE_SYNC_WORKER_ATTEMPTS:-12}" \
  REMOTE_SYNC_WORKER_RETRY_DELAY_MS="${REMOTE_SYNC_WORKER_RETRY_DELAY_MS:-5000}" \
  run_as_service_user npm run verify:remote-public || rollback "public origin readiness failed"
fi

RELEASE_IDENTITY="$(git -C "$APP_DIR" rev-parse HEAD)" || rollback "release identity could not be resolved"
printf '%s\n' "$RELEASE_IDENTITY" >"${APP_DIR}/.release-live-complete.next" || rollback "release completion marker could not be written"
mv "${APP_DIR}/.release-live-complete.next" "${APP_DIR}/.release-live-complete" || rollback "release completion marker could not be committed"
chmod 0644 "${APP_DIR}/.release-live-complete" || rollback "release completion marker permissions failed"

SWAP_STARTED=0
SERVICE_STOPPED_FOR_SWAP=0
WORKER_STOPPED_FOR_SWAP=0
trap - EXIT
cleanup_live_sqlite_backup || log "warning: could not remove live sqlite rollback snapshot after commit"

if [ -d "$BACKUP_DIR" ]; then
  link_runtime_env "$BACKUP_DIR" || log "warning: could not replace legacy backup env with external runtime-env link"
fi

if [ "$KEEP_BACKUP" != "1" ]; then
  rm -rf "$BACKUP_DIR" || log "warning: could not remove ${BACKUP_DIR} after commit"
fi
rm -rf "$FAILED_DIR" || log "warning: could not remove ${FAILED_DIR} after commit"

log "release complete"
