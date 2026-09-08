#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

die() {
  printf 'bootstrap-release-entrypoints: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
for command_name in install openssl visudo bash node id stat sha256sum awk sed head mktemp mv sync rm chown chmod flock; do
  command -v "$command_name" >/dev/null 2>&1 || die "missing command: ${command_name}"
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_BASELINE_SOURCE_DIR="${SCRIPT_DIR}/../../scripts"
readonly SOURCE_BASELINE_INSTALL_DIR="/usr/local/libexec/football-release-source-baseline"
readonly SOURCE_BASELINE_MODULES=(releaseSourceBaseline.cjs releaseSigning.cjs releaseArchiveSourceInventory.cjs releaseChangeClassification.cjs releasePrebuiltDist.cjs frontendReleaseAuthorization.cjs)
readonly FRONTEND_INSTALL_DIR="/usr/local/libexec/football-release-frontend"
readonly FRONTEND_MODULES=(frontendReleaseController.cjs frontendReleaseAuthorization.cjs frontendReleaseTransaction.cjs frontendInstalledRuntime.cjs frontendRuntimeBoundary.cjs frontendBuildSandbox.cjs frontendBuildEvidence.cjs frontendBuildDependencies.cjs releaseSourceBaseline.cjs releaseSigning.cjs releaseArchiveSourceInventory.cjs releaseChangeClassification.cjs releasePrebuiltDist.cjs)
PUBLIC_KEY_SOURCE="${1:-${FOOTBALL_RELEASE_PUBLIC_KEY:-}}"
PUBLIC_BASE_URL="${2:-${FOOTBALL_PUBLIC_BASE_URL:-http://127.0.0.1:8788}}"
UPLOAD_OWNER="${3:-${FOOTBALL_RELEASE_UPLOAD_USER:-ubuntu}}"
EXPECTED_SITE="${4:-${FOOTBALL_RELEASE_EXPECTED_SITE:-football-predict}}"
EXPECTED_CHANNEL="${5:-${FOOTBALL_RELEASE_EXPECTED_CHANNEL:-production}}"
INITIAL_SEQUENCE_INPUT="${6-${FOOTBALL_RELEASE_INITIAL_SEQUENCE-}}"
FRONTEND_MATERIAL="${7:-}"
FRONTEND_MATERIAL_MANIFEST_SHA="${8:-}"
FRONTEND_MATERIAL_ARCHIVE_SHA="${9:-}"
FRONTEND_DEPENDENCY_LOCK_SHA="${10:-}"
HIGHEST_SEQUENCE_PATH="/var/lib/football-release/highest-accepted-sequence"
RELEASE_LOCK_PATH="/run/lock/football-release.lock"
RECOVERY_CURRENT_PATH="/var/lib/football-release/recovery/current"
MAX_SAFE_SEQUENCE=9007199254740991

[ -n "$PUBLIC_KEY_SOURCE" ] || die "usage: bootstrap-release-entrypoints.sh <release-signing-public.pem> [public-base-url] [upload-user] [expected-site] [expected-channel] [initial-highest-sequence] [frontend-material-dir material-manifest-sha material-archive-sha dependency-lock-sha]"
[ -f "$PUBLIC_KEY_SOURCE" ] && [ ! -L "$PUBLIC_KEY_SOURCE" ] || die "public key source must be a regular non-symlink file"
openssl rsa -pubin -in "$PUBLIC_KEY_SOURCE" -noout >/dev/null 2>&1 || die "public key must be RSA"
KEY_BITS="$(openssl rsa -pubin -in "$PUBLIC_KEY_SOURCE" -text -noout 2>/dev/null | sed -n 's/^[[:space:]]*\(RSA \)\?Public-Key: (\([0-9][0-9]*\) bit).*$/\2/p' | head -n 1)"
[[ "$KEY_BITS" =~ ^[0-9]+$ ]] && (( KEY_BITS >= 3072 )) || die "public RSA key must be at least 3072 bits"
[[ "$PUBLIC_BASE_URL" =~ ^https?://[^[:space:]]+$ ]] || die "public base URL is invalid"
[[ "$UPLOAD_OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "upload user name is invalid"
[[ "$EXPECTED_SITE" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "expected site is invalid"
[[ "$EXPECTED_CHANNEL" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "expected channel is invalid"
id "$UPLOAD_OWNER" >/dev/null 2>&1 || die "upload user does not exist"
UPLOAD_GROUP="$(id -gn "$UPLOAD_OWNER")"

validate_nonnegative_sequence() {
  local value="$1"
  [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  if [ "${#value}" -gt "${#MAX_SAFE_SEQUENCE}" ]; then
    return 1
  fi
  if [ "${#value}" -eq "${#MAX_SAFE_SEQUENCE}" ] && [[ "$value" > "$MAX_SAFE_SEQUENCE" ]]; then
    return 1
  fi
  return 0
}

if [ -n "$INITIAL_SEQUENCE_INPUT" ]; then
  validate_nonnegative_sequence "$INITIAL_SEQUENCE_INPUT" \
    || die "initial highest sequence must be a non-negative safe integer without leading zeroes"
fi

for source in football-release football-release-recovery.cjs football-relay-promote football-automation.sudoers; do
  [ -f "${SCRIPT_DIR}/${source}" ] && [ ! -L "${SCRIPT_DIR}/${source}" ] || die "missing bootstrap source: ${source}"
done

for module in "${FRONTEND_MODULES[@]}"; do
  [ -f "${SOURCE_BASELINE_SOURCE_DIR}/${module}" ] && [ ! -L "${SOURCE_BASELINE_SOURCE_DIR}/${module}" ] \
    || die "missing independently reviewed frontend policy: ${module}"
  node --check "${SOURCE_BASELINE_SOURCE_DIR}/${module}" >/dev/null
done
[ -f "${SCRIPT_DIR}/../../server/frontendReleaseIdentity.cjs" ] && [ ! -L "${SCRIPT_DIR}/../../server/frontendReleaseIdentity.cjs" ] \
  || die "missing frontend identity reader"
node --check "${SCRIPT_DIR}/../../server/frontendReleaseIdentity.cjs" >/dev/null
if [ -n "$FRONTEND_MATERIAL$FRONTEND_MATERIAL_MANIFEST_SHA$FRONTEND_MATERIAL_ARCHIVE_SHA$FRONTEND_DEPENDENCY_LOCK_SHA" ]; then
  [[ "$FRONTEND_MATERIAL" =~ ^/tmp/football-frontend-materials-[A-Za-z0-9]+$ ]] || die "invalid inert frontend dependency material path"
  for value in "$FRONTEND_MATERIAL_MANIFEST_SHA" "$FRONTEND_MATERIAL_ARCHIVE_SHA" "$FRONTEND_DEPENDENCY_LOCK_SHA"; do
    [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die "exact frontend material hashes and lock are required"
  done
fi
bash -n "${SCRIPT_DIR}/football-release"
node --check "${SCRIPT_DIR}/football-release-recovery.cjs"
bash -n "${SCRIPT_DIR}/football-relay-promote"
visudo -cf "${SCRIPT_DIR}/football-automation.sudoers" >/dev/null
for module in "${SOURCE_BASELINE_MODULES[@]}"; do
  [ -f "${SOURCE_BASELINE_SOURCE_DIR}/${module}" ] && [ ! -L "${SOURCE_BASELINE_SOURCE_DIR}/${module}" ] \
    || die "missing independently reviewed source baseline policy: ${module}"
  node --check "${SOURCE_BASELINE_SOURCE_DIR}/${module}" >/dev/null
done

install -d -o root -g root -m 0755 /etc/football-release /var/lib/football-release /run/lock /usr/local/libexec
exec 9>"$RELEASE_LOCK_PATH"
flock 9
if [ -e "$RECOVERY_CURRENT_PATH" ] || [ -L "$RECOVERY_CURRENT_PATH" ]; then
  die "recovery transaction pending; run the fixed recovery entrypoint before bootstrap"
fi
current_highest_sequence=0
if [ -e "$HIGHEST_SEQUENCE_PATH" ] || [ -L "$HIGHEST_SEQUENCE_PATH" ]; then
  [ -f "$HIGHEST_SEQUENCE_PATH" ] && [ ! -L "$HIGHEST_SEQUENCE_PATH" ] \
    || die "highest accepted sequence state must be a regular non-symlink file"
  [ "$(stat -c '%U:%G' "$HIGHEST_SEQUENCE_PATH")" = "root:root" ] \
    || die "highest accepted sequence state must be owned by root:root"
  [ "$(stat -c '%h' "$HIGHEST_SEQUENCE_PATH")" = "1" ] \
    || die "highest accepted sequence state must have exactly one hard link"
  state_lines=()
  mapfile -t state_lines <"$HIGHEST_SEQUENCE_PATH"
  [ "${#state_lines[@]}" -eq 1 ] || die "highest accepted sequence state must contain exactly one line"
  current_highest_sequence="${state_lines[0]}"
  validate_nonnegative_sequence "$current_highest_sequence" \
    || die "existing highest accepted sequence state is invalid"
fi

target_highest_sequence="$current_highest_sequence"
if [ -n "$INITIAL_SEQUENCE_INPUT" ]; then
  (( 10#$INITIAL_SEQUENCE_INPUT >= 10#$current_highest_sequence )) \
    || die "initial highest sequence must not lower existing state (${current_highest_sequence})"
  target_highest_sequence="$INITIAL_SEQUENCE_INPUT"
fi

install -o root -g root -m 0644 "$PUBLIC_KEY_SOURCE" /etc/football-release/signing-public.pem
printf '%s\n' "$UPLOAD_OWNER" | install -o root -g root -m 0644 /dev/stdin /etc/football-release/upload-owner
printf '%s\n' "$PUBLIC_BASE_URL" | install -o root -g root -m 0644 /dev/stdin /etc/football-release/public-base-url
printf '%s\n' 'always' | install -o root -g root -m 0644 /dev/stdin /etc/football-release/release-export-live-sqlite
printf '%s\n' "$EXPECTED_SITE" | install -o root -g root -m 0644 /dev/stdin /etc/football-release/expected-site
printf '%s\n' "$EXPECTED_CHANNEL" | install -o root -g root -m 0644 /dev/stdin /etc/football-release/expected-channel

sequence_tmp="$(mktemp /var/lib/football-release/.highest-accepted-sequence.XXXXXX)"
cleanup_sequence_tmp() {
  rm -f -- "$sequence_tmp"
}
trap cleanup_sequence_tmp EXIT
printf '%s\n' "$target_highest_sequence" >"$sequence_tmp"
chown root:root "$sequence_tmp"
chmod 0600 "$sequence_tmp"
sync -f "$sequence_tmp"
mv -fT "$sequence_tmp" "$HIGHEST_SEQUENCE_PATH"
sync -f /var/lib/football-release
trap - EXIT

install -d -o "$UPLOAD_OWNER" -g "$UPLOAD_GROUP" -m 0750 /var/lib/football-release/incoming
install -d -o root -g root -m 0700 /var/lib/football-release/work
install -d -o root -g root -m 0700 /var/lib/football-release/recovery
install -d -o root -g root -m 0700 /var/lib/football-release/source-baselines
install -d -o root -g root -m 0700 /var/lib/football-release/frontend-builds /var/lib/football-release/frontend-dependencies /var/lib/football-release/frontend-authorizations /opt/.football-frontend-transactions
install -d -o root -g "$UPLOAD_GROUP" -m 0750 /var/lib/football-release/status /var/lib/football-release/logs
install -d -o "$UPLOAD_OWNER" -g "$UPLOAD_GROUP" -m 0750 /var/lib/football-relay/incoming
install -d -o root -g root -m 0700 /var/lib/football-relay/work

install -o root -g root -m 0644 "${SCRIPT_DIR}/football-release-recovery.cjs" /usr/local/libexec/football-release-recovery.cjs
if [ -e "$SOURCE_BASELINE_INSTALL_DIR" ] || [ -L "$SOURCE_BASELINE_INSTALL_DIR" ]; then
  [ -d "$SOURCE_BASELINE_INSTALL_DIR" ] && [ ! -L "$SOURCE_BASELINE_INSTALL_DIR" ] \
    || die "source baseline helper directory is not a plain directory"
  [ "$(stat -c '%u:%g:%a' -- "$SOURCE_BASELINE_INSTALL_DIR")" = "0:0:700" ] \
    || die "source baseline helper directory must be root:root 0700"
fi
install -d -o root -g root -m 0700 "$SOURCE_BASELINE_INSTALL_DIR"
for module in "${SOURCE_BASELINE_MODULES[@]}"; do
  [ ! -L "${SOURCE_BASELINE_INSTALL_DIR}/${module}" ] || die "linked source baseline policy target"
  install -o root -g root -m 0644 "${SOURCE_BASELINE_SOURCE_DIR}/${module}" "${SOURCE_BASELINE_INSTALL_DIR}/${module}"
  [ "$(sha256sum "${SOURCE_BASELINE_SOURCE_DIR}/${module}" | awk '{print $1}')" = "$(sha256sum "${SOURCE_BASELINE_INSTALL_DIR}/${module}" | awk '{print $1}')" ] \
    || die "installed source baseline policy differs from reviewed source: ${module}"
done
if [ -e "$FRONTEND_INSTALL_DIR" ] || [ -L "$FRONTEND_INSTALL_DIR" ]; then
  [ -d "$FRONTEND_INSTALL_DIR" ] && [ ! -L "$FRONTEND_INSTALL_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$FRONTEND_INSTALL_DIR")" = "0:0:700" ] \
    || die "frontend controller directory must be plain root:root 0700"
fi
install -d -o root -g root -m 0700 "$FRONTEND_INSTALL_DIR"
for module in "${FRONTEND_MODULES[@]}"; do
  [ ! -L "${FRONTEND_INSTALL_DIR}/${module}" ] || die "linked frontend controller policy target"
  install -o root -g root -m 0644 "${SOURCE_BASELINE_SOURCE_DIR}/${module}" "${FRONTEND_INSTALL_DIR}/${module}"
  [ "$(sha256sum "${SOURCE_BASELINE_SOURCE_DIR}/${module}" | awk '{print $1}')" = "$(sha256sum "${FRONTEND_INSTALL_DIR}/${module}" | awk '{print $1}')" ] \
    || die "installed frontend controller differs from reviewed source: ${module}"
done
[ ! -L "${FRONTEND_INSTALL_DIR}/frontendReleaseIdentity.cjs" ] || die "linked frontend identity policy target"
install -o root -g root -m 0644 "${SCRIPT_DIR}/../../server/frontendReleaseIdentity.cjs" "${FRONTEND_INSTALL_DIR}/frontendReleaseIdentity.cjs"
[ "$(sha256sum "${SCRIPT_DIR}/../../server/frontendReleaseIdentity.cjs" | awk '{print $1}')" = "$(sha256sum "${FRONTEND_INSTALL_DIR}/frontendReleaseIdentity.cjs" | awk '{print $1}')" ] \
  || die "installed frontend identity differs from reviewed source"
if [ -n "$FRONTEND_MATERIAL" ]; then
  env -i PATH="/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin" LANG=C.UTF-8 \
    /opt/node-v22.22.1/bin/node - "$FRONTEND_MATERIAL" "$FRONTEND_MATERIAL_MANIFEST_SHA" "$FRONTEND_MATERIAL_ARCHIVE_SHA" "$FRONTEND_DEPENDENCY_LOCK_SHA" <<'NODE'
const [materialDir, materialManifestSha256, materialArchiveSha256, lockSha256] = process.argv.slice(2);
const helper = require("/usr/local/libexec/football-release-frontend/frontendBuildDependencies.cjs");
(async () => {
  const imported = await helper.importFrontendBuildDependencies({ materialDir, materialManifestSha256, materialArchiveSha256, lockSha256 });
  const parser = await helper.installFrontendBuildParser({ lockSha256 });
  console.log(JSON.stringify({ frontendDependencies: imported, trustedFrontendParser: parser }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
fi
install -o root -g root -m 0755 "${SCRIPT_DIR}/football-release" /usr/local/sbin/football-release
install -o root -g root -m 0755 "${SCRIPT_DIR}/football-relay-promote" /usr/local/sbin/football-relay-promote

KEY_ID="$(openssl pkey -pubin -in /etc/football-release/signing-public.pem -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
printf 'release entrypoints installed; keyId=%s site=%s channel=%s highestAcceptedSequence=%s\n' \
  "$KEY_ID" "$EXPECTED_SITE" "$EXPECTED_CHANNEL" "$target_highest_sequence"
printf '%s\n' 'sudoers was NOT installed. After wrapper checks pass, install it explicitly with:'
printf '  install -o root -g root -m 0440 %q /etc/sudoers.d/football-automation\n' "${SCRIPT_DIR}/football-automation.sudoers"
printf '%s\n' '  visudo -cf /etc/sudoers'
