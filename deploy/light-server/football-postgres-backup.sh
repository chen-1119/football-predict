#!/usr/bin/env bash
set -euo pipefail

umask 0077

readonly BACKUP_DIR="${FOOTBALL_POSTGRES_BACKUP_DIR:-/var/lib/football-predict/postgres-backups}"
readonly RETENTION_DAYS="${FOOTBALL_POSTGRES_BACKUP_RETENTION_DAYS:-14}"
readonly DATABASE="${PGDATABASE:-football}"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly FINAL_PATH="${BACKUP_DIR}/football-${TIMESTAMP}.dump"
readonly TEMP_PATH="${FINAL_PATH}.partial"
readonly FINAL_SHA_PATH="${FINAL_PATH}.sha256"
readonly TEMP_SHA_PATH="${FINAL_SHA_PATH}.partial"
readonly LATEST_PATH="${BACKUP_DIR}/latest.json"
readonly TEMP_LATEST_PATH="${LATEST_PATH}.partial"

if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid PostgreSQL backup retention" >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" || -L "$BACKUP_DIR" ]]; then
  echo "PostgreSQL backup directory is missing or unsafe: $BACKUP_DIR" >&2
  exit 3
fi

cleanup() {
  rm -f -- "$TEMP_PATH" "$TEMP_SHA_PATH" "$TEMP_LATEST_PATH"
}
trap cleanup EXIT

pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  --file="$TEMP_PATH" \
  "$DATABASE"

pg_restore --list "$TEMP_PATH" >/dev/null

readonly SHA256="$(sha256sum "$TEMP_PATH" | awk '{print $1}')"
readonly BYTES="$(stat -c '%s' "$TEMP_PATH")"
printf '%s  %s\n' "$SHA256" "$(basename "$FINAL_PATH")" > "$TEMP_SHA_PATH"
mv -f -- "$TEMP_PATH" "$FINAL_PATH"
mv -f -- "$TEMP_SHA_PATH" "$FINAL_SHA_PATH"

printf '{"version":1,"database":"%s","createdAt":"%s","path":"%s","bytes":%s,"sha256":"%s","verified":"pg_restore-list"}\n' \
  "$DATABASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FINAL_PATH" "$BYTES" "$SHA256" > "$TEMP_LATEST_PATH"
mv -f -- "$TEMP_LATEST_PATH" "$LATEST_PATH"

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'football-*.dump' -o -name 'football-*.dump.sha256' \) \
  -mtime "+$RETENTION_DAYS" -delete

printf 'postgres-backup-ok path=%s bytes=%s sha256=%s\n' "$FINAL_PATH" "$BYTES" "$SHA256"
