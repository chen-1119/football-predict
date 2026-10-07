#!/usr/bin/env bash
set -euo pipefail

umask 0077

readonly BACKUP_DIR="${FOOTBALL_POSTGRES_BACKUP_DIR:-/var/lib/football-predict/postgres-backups}"
readonly RETENTION_DAYS="${FOOTBALL_POSTGRES_BACKUP_RETENTION_DAYS:-7}"
readonly DATABASE="${PGDATABASE:-football}"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly FINAL_PATH="${BACKUP_DIR}/football-${TIMESTAMP}.dump"
readonly TEMP_PATH="${FINAL_PATH}.partial"
readonly FINAL_SHA_PATH="${FINAL_PATH}.sha256"
readonly TEMP_SHA_PATH="${FINAL_SHA_PATH}.partial"
readonly LATEST_PATH="${BACKUP_DIR}/latest.json"
readonly TEMP_LATEST_PATH="${LATEST_PATH}.partial"

if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,2}$ ]] || (( RETENTION_DAYS > 365 )); then
  echo "invalid PostgreSQL backup retention" >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" || -L "$BACKUP_DIR" || "$(realpath -- "$BACKUP_DIR")" != "$BACKUP_DIR" ]]; then
  echo "PostgreSQL backup directory is missing or unsafe: $BACKUP_DIR" >&2
  exit 3
fi

safe_backup_file() {
  local file="$1" details
  [[ -f "$file" && ! -L "$file" ]] || return 1
  details="$(stat -c '%u:%h:%a' -- "$file")" || return 1
  [[ "$details" =~ ^([0-9]+):1:([0-7]{3,4})$ ]] || return 1
  [[ "${BASH_REMATCH[1]}" == "$(id -u)" ]] || return 1
  (( (8#${BASH_REMATCH[2]} & 8#022) == 0 ))
}
file_stamp() { stat -c '%d:%i:%s:%y:%z:%u:%g:%h:%a' -- "$1"; }
file_identity() { stat -c '%d:%i' -- "$1"; }
owned_temp_matches() {
  local file="$1" identity="$2"
  [[ "$identity" =~ ^[0-9]+:[0-9]+$ ]] && safe_backup_file "$file" && [[ "$(file_identity "$file")" == "$identity" ]]
}
pair_matches() {
  local dump="$1" sidecar="${1}.sha256" expected name actual_hash
  safe_backup_file "$dump" && safe_backup_file "$sidecar" || return 1
  [[ "$(stat -c '%s' -- "$sidecar")" -le 256 ]] || return 1
  name="$(basename -- "$dump")"
  expected="$(cat -- "$sidecar")"
  [[ "$expected" =~ ^[a-f0-9]{64}\ \ [A-Za-z0-9_.-]+$ && "${expected:66}" == "$name" ]] || return 1
  actual_hash="$(sha256sum -- "$dump" | awk '{print $1}')" || return 1
  [[ "$actual_hash" =~ ^[a-f0-9]{64}$ && "$actual_hash" == "${expected:0:64}" ]]
}

# A backup and its retention pass share one local lock. The latest verified pair
# is published before retention; no failed backup can remove an older backup.
readonly LOCK_PATH="${BACKUP_DIR}/.postgres-backup.lock"
if [[ ( -e "$LOCK_PATH" || -L "$LOCK_PATH" ) ]] && ! safe_backup_file "$LOCK_PATH"; then
  echo "unsafe PostgreSQL backup lock" >&2
  exit 3
fi
exec 9>>"$LOCK_PATH"
flock -n 9 || { echo "PostgreSQL backup is already active" >&2; exit 4; }
safe_backup_file "$LOCK_PATH" || { echo "unsafe PostgreSQL backup lock identity" >&2; exit 3; }

for reserved in "$TEMP_PATH" "$TEMP_SHA_PATH" "$TEMP_LATEST_PATH" "$FINAL_PATH" "$FINAL_SHA_PATH"; do
  if [[ -e "$reserved" || -L "$reserved" ]]; then
    echo "PostgreSQL backup filename already exists; preserve it" >&2
    exit 3
  fi
done
latest_before=absent
if [[ -e "$LATEST_PATH" || -L "$LATEST_PATH" ]]; then
  safe_backup_file "$LATEST_PATH" || { echo "unsafe existing PostgreSQL backup pointer" >&2; exit 3; }
  latest_before="$(file_stamp "$LATEST_PATH")"
fi

owned_temp_dump=''
owned_temp_sha=''
owned_temp_latest=''
cleanup() {
  # Only this invocation's reserved paths may be removed. A changed or linked
  # temporary file remains available for inspection.
  if owned_temp_matches "$TEMP_PATH" "$owned_temp_dump"; then unlink -- "$TEMP_PATH"; fi
  if owned_temp_matches "$TEMP_SHA_PATH" "$owned_temp_sha"; then unlink -- "$TEMP_SHA_PATH"; fi
  if owned_temp_matches "$TEMP_LATEST_PATH" "$owned_temp_latest"; then unlink -- "$TEMP_LATEST_PATH"; fi
}
trap cleanup EXIT

# Create the dump exclusively and bind ownership to the open file, not to a
# pathname which another invocation could have replaced before a failure.
set -o noclobber
exec {dump_fd}>"$TEMP_PATH"
set +o noclobber
owned_temp_dump="$(stat -Lc '%d:%i' -- "/proc/self/fd/$dump_fd")"
owned_temp_matches "$TEMP_PATH" "$owned_temp_dump" || { echo "new PostgreSQL dump identity changed" >&2; exit 3; }
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  "$DATABASE" >&"$dump_fd"

pg_restore --list "/proc/self/fd/$dump_fd" >/dev/null
owned_temp_matches "$TEMP_PATH" "$owned_temp_dump" || { echo "unsafe new PostgreSQL dump identity" >&2; exit 3; }

SHA256="$(sha256sum "/proc/self/fd/$dump_fd" | awk '{print $1}')"
BYTES="$(stat -Lc '%s' -- "/proc/self/fd/$dump_fd")"
readonly SHA256 BYTES
[[ "$SHA256" =~ ^[a-f0-9]{64}$ && "$BYTES" =~ ^[1-9][0-9]*$ ]] || { echo "invalid new PostgreSQL backup metadata" >&2; exit 5; }
set -o noclobber
exec {sha_fd}>"$TEMP_SHA_PATH"
set +o noclobber
owned_temp_sha="$(stat -Lc '%d:%i' -- "/proc/self/fd/$sha_fd")"
printf '%s  %s\n' "$SHA256" "$(basename "$FINAL_PATH")" >&"$sha_fd"
owned_temp_matches "$TEMP_PATH" "$owned_temp_dump" && owned_temp_matches "$TEMP_SHA_PATH" "$owned_temp_sha" || { echo "PostgreSQL backup temporary identity changed" >&2; exit 3; }
ln -T -- "$TEMP_PATH" "$FINAL_PATH"
unlink -- "$TEMP_PATH"
owned_temp_dump=''
ln -T -- "$TEMP_SHA_PATH" "$FINAL_SHA_PATH"
unlink -- "$TEMP_SHA_PATH"
owned_temp_sha=''
exec {dump_fd}>&-
exec {sha_fd}>&-
pair_matches "$FINAL_PATH" || { echo "latest PostgreSQL backup pair failed verification" >&2; exit 5; }
sync -- "$FINAL_PATH" "$FINAL_SHA_PATH"
sync -- "$BACKUP_DIR"

readonly LATEST_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
readonly LATEST_EXPECTED="$(printf '{"version":1,"database":"%s","createdAt":"%s","path":"%s","bytes":%s,"sha256":"%s","verified":"pg_restore-list"}' \
  "$DATABASE" "$LATEST_CREATED_AT" "$FINAL_PATH" "$BYTES" "$SHA256")"
set -o noclobber
exec {latest_fd}>"$TEMP_LATEST_PATH"
set +o noclobber
owned_temp_latest="$(stat -Lc '%d:%i' -- "/proc/self/fd/$latest_fd")"
printf '%s\n' "$LATEST_EXPECTED" >&"$latest_fd"
owned_temp_matches "$TEMP_LATEST_PATH" "$owned_temp_latest" || { echo "unsafe new PostgreSQL backup pointer identity" >&2; exit 5; }
sync -- "$TEMP_LATEST_PATH"
owned_temp_matches "$TEMP_LATEST_PATH" "$owned_temp_latest" && [[ "$(cat -- "$TEMP_LATEST_PATH")" == "$LATEST_EXPECTED" ]] || { echo "new PostgreSQL backup pointer identity changed" >&2; exit 5; }
if [[ "$latest_before" == absent ]]; then
  [[ ! -e "$LATEST_PATH" && ! -L "$LATEST_PATH" ]] || { echo "PostgreSQL latest pointer appeared during backup" >&2; exit 3; }
else
  safe_backup_file "$LATEST_PATH" && [[ "$(file_stamp "$LATEST_PATH")" == "$latest_before" ]] || { echo "PostgreSQL latest pointer changed during backup" >&2; exit 3; }
fi
mv -f -- "$TEMP_LATEST_PATH" "$LATEST_PATH"
owned_temp_latest=''
exec {latest_fd}>&-
sync -- "$BACKUP_DIR"

# Validate the new latest pair before considering any older pair. Unknown names,
# incomplete pairs, unsafe files, newer files and mismatching hashes are retained.
json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}
pair_matches "$FINAL_PATH" || { echo "latest PostgreSQL backup pair failed verification" >&2; exit 5; }
safe_backup_file "$LATEST_PATH" || { echo "latest PostgreSQL backup pointer is unsafe" >&2; exit 5; }
[[ "$(cat -- "$LATEST_PATH")" == "$LATEST_EXPECTED" ]] || { echo "latest PostgreSQL backup pointer drift" >&2; exit 5; }
readonly LATEST_STAMP="$(file_stamp "$LATEST_PATH")"
readonly FINAL_STAMP="$(file_stamp "$FINAL_PATH")"
readonly FINAL_SHA_STAMP="$(file_stamp "$FINAL_SHA_PATH")"
readonly RETENTION_NOW="$(date -u +%s)"
readonly RETENTION_CUTOFF="$(( RETENTION_NOW - RETENTION_DAYS * 86400 ))"
readonly RETENTION_AUDIT="${BACKUP_DIR}/retention-${TIMESTAMP}-$$.jsonl"
( set -o noclobber; printf '{"version":1,"type":"started","retentionDays":%s,"protectedLatest":"%s","cutoffEpoch":%s}\n' \
  "$RETENTION_DAYS" "$(json_string "$FINAL_PATH")" "$RETENTION_CUTOFF" > "$RETENTION_AUDIT" )
sync -- "$RETENTION_AUDIT"
sync -- "$BACKUP_DIR"
deleted_pairs=0
deleted_files=0
deleted_bytes=0
shopt -s nullglob
for candidate in "$BACKUP_DIR"/football-*.dump; do
  name="$(basename -- "$candidate")"
  [[ "$candidate" != "$FINAL_PATH" ]] || continue
  [[ "$name" =~ ^football-([0-9]{8})T([0-9]{6})Z\.dump$ ]] || continue
  timestamp="${BASH_REMATCH[1]}T${BASH_REMATCH[2]}Z"
  # Require both filename time and both filesystem mtimes to be old. A copied or
  # freshly restored older backup remains available for review.
  epoch="$(date -u -d "${timestamp:0:4}-${timestamp:4:2}-${timestamp:6:2} ${timestamp:9:2}:${timestamp:11:2}:${timestamp:13:2}Z" +%s 2>/dev/null)" || continue
  (( epoch < RETENTION_CUTOFF )) || continue
  sidecar="${candidate}.sha256"
  pair_matches "$candidate" || continue
  dump_mtime="$(stat -c '%Y' -- "$candidate")"
  sha_mtime="$(stat -c '%Y' -- "$sidecar")"
  (( dump_mtime < RETENTION_CUTOFF && sha_mtime < RETENTION_CUTOFF )) || continue
  dump_stamp="$(file_stamp "$candidate")"
  sha_stamp="$(file_stamp "$sidecar")"
  pair_bytes="$(( $(stat -c '%s' -- "$candidate") + $(stat -c '%s' -- "$sidecar") ))"
  [[ "$(file_stamp "$LATEST_PATH")" == "$LATEST_STAMP" && "$(file_stamp "$FINAL_PATH")" == "$FINAL_STAMP" && "$(file_stamp "$FINAL_SHA_PATH")" == "$FINAL_SHA_STAMP" ]] || { echo "protected latest PostgreSQL backup drift" >&2; exit 6; }
  printf '{"version":1,"type":"pair-intent","dump":"%s","sidecar":"%s","dumpStamp":"%s","sidecarStamp":"%s","bytes":%s}\n' \
    "$(json_string "$candidate")" "$(json_string "$sidecar")" "$dump_stamp" "$sha_stamp" "$pair_bytes" >> "$RETENTION_AUDIT"
  sync -- "$RETENTION_AUDIT"
  [[ "$(file_stamp "$candidate")" == "$dump_stamp" && "$(file_stamp "$sidecar")" == "$sha_stamp" ]] || { echo "PostgreSQL backup pair changed before retention" >&2; exit 6; }
  unlink -- "$candidate"
  sync -- "$BACKUP_DIR"
  deleted_files=$(( deleted_files + 1 ))
  printf '{"version":1,"type":"file-deleted","path":"%s"}\n' "$(json_string "$candidate")" >> "$RETENTION_AUDIT"
  sync -- "$RETENTION_AUDIT"
  [[ "$(file_stamp "$sidecar")" == "$sha_stamp" ]] || { echo "PostgreSQL backup hash changed during retention" >&2; exit 6; }
  unlink -- "$sidecar"
  sync -- "$BACKUP_DIR"
  deleted_files=$(( deleted_files + 1 ))
  deleted_pairs=$(( deleted_pairs + 1 ))
  deleted_bytes=$(( deleted_bytes + pair_bytes ))
  printf '{"version":1,"type":"file-deleted","path":"%s"}\n' "$(json_string "$sidecar")" >> "$RETENTION_AUDIT"
  sync -- "$RETENTION_AUDIT"
done
[[ "$(file_stamp "$LATEST_PATH")" == "$LATEST_STAMP" && "$(file_stamp "$FINAL_PATH")" == "$FINAL_STAMP" && "$(file_stamp "$FINAL_SHA_PATH")" == "$FINAL_SHA_STAMP" ]] || { echo "protected latest PostgreSQL backup drift" >&2; exit 6; }
printf '{"version":1,"type":"complete","deletedPairs":%s,"deletedFiles":%s,"deletedBytes":%s,"protectedLatest":"%s"}\n' \
  "$deleted_pairs" "$deleted_files" "$deleted_bytes" "$(json_string "$FINAL_PATH")" >> "$RETENTION_AUDIT"
sync -- "$RETENTION_AUDIT"
printf 'postgres-backup-retention-ok pairs=%s files=%s bytes=%s receipt=%s\n' "$deleted_pairs" "$deleted_files" "$deleted_bytes" "$RETENTION_AUDIT"

printf 'postgres-backup-ok path=%s bytes=%s sha256=%s\n' "$FINAL_PATH" "$BYTES" "$SHA256"
