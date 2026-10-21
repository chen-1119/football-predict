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
readonly SOURCE_BASELINE_MODULES=(releaseSourceBaseline.cjs releaseSigning.cjs releaseSigningTrust.cjs releaseArchiveSourceInventory.cjs releaseChangeClassification.cjs releasePrebuiltDist.cjs frontendReleaseAuthorization.cjs)
readonly FRONTEND_INSTALL_DIR="/usr/local/libexec/football-release-frontend"
readonly FRONTEND_MODULES=(frontendReleaseController.cjs frontendPolicyRefresh.cjs frontendReleaseAttempt.cjs frontendReleaseAuthorization.cjs frontendReleaseTransaction.cjs frontendInstalledRuntime.cjs frontendRuntimeBoundary.cjs frontendBuildSandbox.cjs frontendBuildEvidence.cjs frontendBuildDependencies.cjs releaseSourceBaseline.cjs releaseSigning.cjs releaseSigningTrust.cjs releaseArchiveSourceInventory.cjs releaseChangeClassification.cjs releasePrebuiltDist.cjs)
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

# Existing accepted runtime maintenance must preserve configuration before the
# first write. Different provisioning arguments require a separate reviewed
# configuration operation; a failed maintenance audit cannot undo them later.
if [ -e /var/lib/football-release/frontend-runtime-binding.json ] || [ -L /var/lib/football-release/frontend-runtime-binding.json ]; then
  [ "$target_highest_sequence" = "$current_highest_sequence" ] || die "frontend policy maintenance must preserve the consumed sequence"
  [ "$(sha256sum "$PUBLIC_KEY_SOURCE" | awk '{print $1}')" = "$(sha256sum /etc/football-release/signing-public.pem | awk '{print $1}')" ] \
    || die "frontend policy maintenance must preserve signing trust"
  for entry in "upload-owner:$UPLOAD_OWNER" "public-base-url:$PUBLIC_BASE_URL" "release-export-live-sqlite:always" "expected-site:$EXPECTED_SITE" "expected-channel:$EXPECTED_CHANNEL"; do
    name="${entry%%:*}"; expected="${entry#*:}"
    [ "$(printf '%s\n' "$expected" | sha256sum | awk '{print $1}')" = "$(sha256sum "/etc/football-release/$name" | awk '{print $1}')" ] \
      || die "frontend policy maintenance must preserve ${name}"
  done
fi

# A bootstrap is an independently reviewed root operation, never part of a
# candidate release. Retain durable old/new policy pins before refreshing a
# binding; a source package cannot manufacture these records through APP.
audit_frontend_policies() {
  env -i PATH="/opt/node-v22.22.1/bin:/usr/sbin:/usr/bin:/sbin:/bin" LANG=C.UTF-8 \
    /opt/node-v22.22.1/bin/node - "$1" "${2:-}" "${BASH_SOURCE[0]}" <<'NODE'
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const [mode, requestedId, bootstrap] = process.argv.slice(2);
const root = "/var/lib/football-release/frontend-policy-bootstrap", install = "/usr/local/libexec/football-release-frontend";
const version = "frontend-policy-bootstrap-v1", sha = b => crypto.createHash("sha256").update(b).digest("hex"), json = v => Buffer.from(JSON.stringify(v) + "\n");
const fail = reason => { throw new Error(reason); };
function directory(name) { for (let p = name; ; p = path.dirname(p)) { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || fs.realpathSync(p) !== p) fail("bootstrap-audit-unsafe-directory"); if (p === "/") break; } }
function read(name, optional = false) { let s; try { s = fs.lstatSync(name); } catch(e) { if (optional && e.code === "ENOENT") return null; throw e; } directory(path.dirname(name)); if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o022) || s.size > 16 * 1024 * 1024) fail("bootstrap-audit-unsafe-file"); const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd); if (s.dev !== after.dev || s.ino !== after.ino || s.size !== after.size || s.mtimeMs !== after.mtimeMs || s.ctimeMs !== after.ctimeMs || bytes.length !== s.size) fail("bootstrap-audit-read-drift"); return bytes; } finally { fs.closeSync(fd); } }
function sync(name) { const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function write(name, value) { const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); try { fs.writeFileSync(fd, json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } sync(path.dirname(name)); }
function snapshot(protectedOnly = false) {
  const controller = read(install + "/frontendReleaseController.cjs", true); let modulePins = [], policies = null;
  if (controller && !protectedOnly) { const match = /const MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(controller.toString()); if (!match) fail("bootstrap-audit-module-list-unavailable"); const tokens = match[1].match(/"[A-Za-z]+\.cjs"/g); if (!tokens || tokens.length < 10 || tokens.length > 32) fail("bootstrap-audit-module-count"); const names = tokens.map(t => JSON.parse(t)); if (new Set(names).size !== names.length) fail("bootstrap-audit-duplicate-module"); modulePins = names.map(name => ({ name, sha256: sha(read(install + "/" + name)) })); policies = { authorizationSha256: sha(JSON.stringify(modulePins)), runtimeBoundarySha256: modulePins.find(p => p.name === "frontendRuntimeBoundary.cjs").sha256, sandboxSha256: sha(JSON.stringify(modulePins.filter(p => ["frontendBuildSandbox.cjs", "frontendBuildEvidence.cjs", "releasePrebuiltDist.cjs"].includes(p.name)))) }; }
  const paths = ["/var/lib/football-release/frontend-runtime-binding.json", "/opt/football-predict/.frontend-release-binding.json", "/var/lib/football-release/frontend-state.json", "/opt/football-predict/.frontend-release-state.json", "/opt/football-predict/.frontend-release-acceptance.json", "/opt/football-predict/.release-bundle-sha256", "/opt/football-predict/.release-live-complete", "/var/lib/football-release/highest-accepted-sequence", "/etc/football-release/signing-public.pem", "/etc/football-release/upload-owner", "/etc/football-release/public-base-url", "/etc/football-release/release-export-live-sqlite", "/etc/football-release/expected-site", "/etc/football-release/expected-channel", "/etc/football-predict/env", "/etc/sudoers.d/football-automation"];
  const protectedFiles = paths.map(filename => ({ path: filename, sha256: (() => { const bytes = read(filename, true); return bytes === null ? null : sha(bytes); })() }));
  return { modulePins, policies, protectedFiles };
}
function sources() {
  const base = path.dirname(path.resolve(bootstrap)), scripts = path.resolve(base, "../../scripts"), server = path.resolve(base, "../../server");
  const text = read(scripts + "/frontendReleaseController.cjs").toString(), match = /const MODULES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(text);
  if (!match) fail("bootstrap-audit-reviewed-module-list");
  const names = match[1].match(/"[A-Za-z]+\.cjs"/g).map(t => JSON.parse(t));
  const modulePins = names.map(name => ({ name, sha256: sha(read((name === "frontendReleaseIdentity.cjs" ? server : scripts) + "/" + name)) }));
  const extra = [path.resolve(bootstrap), scripts + "/frontendBuildDependencies.cjs", base + "/football-release", base + "/football-release-recovery.cjs", base + "/football-relay-promote", base + "/football-automation.sudoers"];
  return { bootstrapSha256: sha(read(path.resolve(bootstrap))), modulePins, extraPins: extra.map(filename => ({ name: path.basename(filename), sha256: sha(read(filename)) })) };
}
directory("/var/lib/football-release");
if (mode === "before") {
  if (!fs.existsSync(root)) { fs.mkdirSync(root, { mode: 0o700 }); sync(path.dirname(root)); }
  directory(root); if ((fs.statSync(root).mode & 0o777) !== 0o700) fail("bootstrap-audit-private-root-required");
  const approved = sources(), pendingBytes = read(root + "/pending.json", true);
  if (pendingBytes) {
    const pending = JSON.parse(pendingBytes); if (pending.version !== version || !/^[a-f0-9]{24}$/.test(pending.id || "") || !pendingBytes.equals(json(pending))) fail("bootstrap-audit-pending-contract");
    const folder = root + "/" + pending.id; directory(folder);
    const priorSource = read(folder + "/source.json"), prior = JSON.parse(read(folder + "/before.json"));
    if (sha(priorSource) !== pending.sourceSha256 || !priorSource.equals(json(approved)) || JSON.stringify(prior.protectedFiles) !== JSON.stringify(snapshot(true).protectedFiles)) fail("bootstrap-audit-resume-source-or-baseline-drift");
    process.stdout.write(pending.id); process.exit(0);
  }
  const id = crypto.randomBytes(12).toString("hex"), folder = root + "/" + id;
  fs.mkdirSync(folder, { mode: 0o700 }); sync(root);
  write(folder + "/before.json", snapshot()); write(folder + "/source.json", approved);
  write(root + "/pending.json", { version, id, sourceSha256: sha(json(approved)) });
  process.stdout.write(id);
} else if (mode === "after" && /^[a-f0-9]{24}$/.test(requestedId)) {
  directory(root); const folder = root + "/" + requestedId; directory(folder);
  const before = JSON.parse(read(folder + "/before.json")), after = snapshot();
  const source = JSON.parse(read(folder + "/source.json"));
  if (!json(source).equals(json(sources())) || JSON.stringify(after.modulePins) !== JSON.stringify(source.modulePins)) fail("bootstrap-audit-source-drift");
  if (before.protectedFiles.find(r => r.path === "/var/lib/football-release/frontend-runtime-binding.json").sha256 !== null && JSON.stringify(before.protectedFiles) !== JSON.stringify(after.protectedFiles)) fail("bootstrap-audit-protected-baseline-changed");
  const complete = { version, id: requestedId, bootstrapSha256: source.bootstrapSha256, before, after };
  const existingComplete = read(folder + "/complete.json", true); if (existingComplete ? !existingComplete.equals(json(complete)) : false) fail("bootstrap-audit-complete-conflict");
  if (!existingComplete) write(folder + "/complete.json", complete);
  const temporary = root + "/.current-" + requestedId, nextPointer = { version, id: requestedId, recordSha256: sha(json(complete)) };
  const existingTemporary = read(temporary, true); if (existingTemporary ? !existingTemporary.equals(json(nextPointer)) : false) fail("bootstrap-audit-pointer-temp-conflict");
  if (!existingTemporary) write(temporary, nextPointer);
  read(root + "/current.json", true); fs.renameSync(temporary, root + "/current.json"); sync(root);
  const pending = JSON.parse(read(root + "/pending.json")); if (pending.version !== version || pending.id !== requestedId || pending.sourceSha256 !== sha(json(source))) fail("bootstrap-audit-pending-final-conflict");
  fs.unlinkSync(root + "/pending.json"); sync(root);
} else fail("bootstrap-audit-mode-invalid");
NODE
}
policy_audit_id="$(audit_frontend_policies before)"

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
install -d -o root -g root -m 0700 /var/lib/football-release/frontend-builds /var/lib/football-release/frontend-dependencies /var/lib/football-release/frontend-authorizations /var/lib/football-release/frontend-attempts /opt/.football-frontend-transactions
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

audit_frontend_policies after "$policy_audit_id"

KEY_ID="$(openssl pkey -pubin -in /etc/football-release/signing-public.pem -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
printf 'release entrypoints installed; keyId=%s site=%s channel=%s highestAcceptedSequence=%s\n' \
  "$KEY_ID" "$EXPECTED_SITE" "$EXPECTED_CHANNEL" "$target_highest_sequence"
printf '%s\n' 'sudoers was NOT installed. After wrapper checks pass, install it explicitly with:'
printf '  install -o root -g root -m 0440 %q /etc/sudoers.d/football-automation\n' "${SCRIPT_DIR}/football-automation.sudoers"
printf '%s\n' '  visudo -cf /etc/sudoers'
