#!/usr/bin/env bash
set -euo pipefail

umask 0077

readonly BACKUP_DIR="${FOOTBALL_POSTGRES_BACKUP_DIR:-/var/lib/football-predict/postgres-backups}"
readonly STATUS_PATH="${BACKUP_DIR}/cos-upload-status.json"
readonly STATUS_TEMP_PATH="${STATUS_PATH}.partial"
readonly LATEST_PATH="${BACKUP_DIR}/latest.json"
readonly COSCLI_BIN="${COSCLI_BIN:-/usr/local/bin/coscli}"
readonly NODE_BIN="${NODE_BIN:-/opt/node-v22.22.1/bin/node}"
readonly COS_BUCKET="${FOOTBALL_COS_BUCKET:-}"
readonly COS_REGION="${FOOTBALL_COS_REGION:-}"
readonly COS_PREFIX="${FOOTBALL_COS_PREFIX:-postgres}"
readonly RUNTIME_DIR="${RUNTIME_DIRECTORY:-/run/football-postgres-cos-upload}"
readonly CONFIG_PATH="${RUNTIME_DIR}/cos.yaml"

cleanup() {
  rm -f -- "$CONFIG_PATH" "$STATUS_TEMP_PATH" "${RUNTIME_DIR}/verified.dump"
}
trap cleanup EXIT

fail() {
  printf 'postgres-cos-upload-error %s\n' "$1" >&2
  exit 2
}

yaml_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

[[ -x "$COSCLI_BIN" ]] || fail "coscli is missing or not executable"
[[ -x "$NODE_BIN" ]] || fail "node is missing or not executable"
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail "backup directory is missing or unsafe"
[[ -f "$LATEST_PATH" && ! -L "$LATEST_PATH" ]] || fail "latest backup metadata is missing or unsafe"
[[ -n "${COS_SECRET_ID:-}" && "$COS_SECRET_ID" != *$'\n'* && "$COS_SECRET_ID" != *$'\r'* ]] || fail "COS_SECRET_ID is missing or invalid"
[[ -n "${COS_SECRET_KEY:-}" && "$COS_SECRET_KEY" != *$'\n'* && "$COS_SECRET_KEY" != *$'\r'* ]] || fail "COS_SECRET_KEY is missing or invalid"
[[ "$COS_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{0,62}-[0-9]{5,20}$ ]] || fail "FOOTBALL_COS_BUCKET is invalid"
[[ "$COS_REGION" =~ ^[a-z0-9-]{3,32}$ ]] || fail "FOOTBALL_COS_REGION is invalid"
[[ "$COS_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ && "$COS_PREFIX" != *".."* ]] || fail "FOOTBALL_COS_PREFIX is invalid"
mkdir -p -- "$RUNTIME_DIR"

mapfile -t backup_fields < <(
  "$NODE_BIN" - "$LATEST_PATH" "$BACKUP_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [latestPath, backupDir] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(latestPath, "utf8"));
const resolvedDir = path.resolve(backupDir);
const resolvedPath = path.resolve(String(value.path || ""));
if (path.dirname(resolvedPath) !== resolvedDir) throw new Error("backup path escapes backup directory");
if (!/^football-[0-9]{8}T[0-9]{6}Z\.dump$/.test(path.basename(resolvedPath))) throw new Error("backup filename is invalid");
if (!/^[a-f0-9]{64}$/.test(String(value.sha256 || ""))) throw new Error("backup sha256 is invalid");
if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error("backup byte size is invalid");
process.stdout.write(`${resolvedPath}\n${value.sha256}\n${value.bytes}\n${value.createdAt || ""}\n`);
NODE
)

[[ "${#backup_fields[@]}" -eq 4 ]] || fail "latest backup metadata could not be parsed"
readonly BACKUP_PATH="${backup_fields[0]}"
readonly EXPECTED_SHA256="${backup_fields[1]}"
readonly EXPECTED_BYTES="${backup_fields[2]}"
readonly CREATED_AT="${backup_fields[3]}"
[[ -f "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || fail "latest backup file is missing or unsafe"
[[ "$(stat -c '%s' "$BACKUP_PATH")" == "$EXPECTED_BYTES" ]] || fail "latest backup byte size changed"
[[ "$(sha256sum "$BACKUP_PATH" | awk '{print $1}')" == "$EXPECTED_SHA256" ]] || fail "latest backup sha256 changed"

cat > "$CONFIG_PATH" <<EOF
cos:
  base:
    secretid: $(yaml_quote "$COS_SECRET_ID")
    secretkey: $(yaml_quote "$COS_SECRET_KEY")
    sessiontoken: $(yaml_quote "${COS_SESSION_TOKEN:-}")
    protocol: https
    disableAutoFetchBucketType: true
  buckets:
  - name: $(yaml_quote "$COS_BUCKET")
    alias: football-backup
    region: $(yaml_quote "$COS_REGION")
    endpoint: $(yaml_quote "cos.${COS_REGION}.myqcloud.com")
    ofs: false
EOF
chmod 0600 "$CONFIG_PATH"

readonly BACKUP_NAME="$(basename "$BACKUP_PATH")"
readonly DATE_PATH="${BACKUP_NAME:9:4}/${BACKUP_NAME:13:2}/${BACKUP_NAME:15:2}"
readonly REMOTE_BASE="cos://football-backup/${COS_PREFIX}/daily/${DATE_PATH}/${BACKUP_NAME}"

"$COSCLI_BIN" cp "$BACKUP_PATH" "$REMOTE_BASE" --config-path "$CONFIG_PATH"
"$COSCLI_BIN" cp "$REMOTE_BASE" "${RUNTIME_DIR}/verified.dump" --config-path "$CONFIG_PATH"
[[ "$(stat -c '%s' "${RUNTIME_DIR}/verified.dump")" == "$EXPECTED_BYTES" ]] || fail "downloaded COS backup byte size mismatch"
[[ "$(sha256sum "${RUNTIME_DIR}/verified.dump" | awk '{print $1}')" == "$EXPECTED_SHA256" ]] || fail "downloaded COS backup sha256 mismatch"

"$COSCLI_BIN" cp "${BACKUP_PATH}.sha256" "${REMOTE_BASE}.sha256" --config-path "$CONFIG_PATH"
"$COSCLI_BIN" cp "$LATEST_PATH" "cos://football-backup/${COS_PREFIX}/latest.json" --config-path "$CONFIG_PATH"

printf '{"version":1,"uploadedAt":"%s","backupCreatedAt":"%s","bucket":"%s","region":"%s","object":"%s","bytes":%s,"sha256":"%s","verified":"cos-download-sha256"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CREATED_AT" "$COS_BUCKET" "$COS_REGION" \
  "${COS_PREFIX}/daily/${DATE_PATH}/${BACKUP_NAME}" "$EXPECTED_BYTES" "$EXPECTED_SHA256" > "$STATUS_TEMP_PATH"
mv -f -- "$STATUS_TEMP_PATH" "$STATUS_PATH"

printf 'postgres-cos-upload-ok object=%s bytes=%s sha256=%s\n' \
  "${COS_PREFIX}/daily/${DATE_PATH}/${BACKUP_NAME}" "$EXPECTED_BYTES" "$EXPECTED_SHA256"
