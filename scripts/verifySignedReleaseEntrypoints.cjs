const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  DEFAULT_RELEASE_CHANNEL,
  DEFAULT_RELEASE_MANIFEST_TTL_HOURS,
  DEFAULT_RELEASE_SITE,
  MAX_RELEASE_MANIFEST_TTL_HOURS,
  RELEASE_MANIFEST_VERSION,
  RELEASE_SIGNATURE_ALGORITHM,
  publicKeyId,
  reserveReleaseSequence,
  resolveReleaseManifestConfig,
  signManifestBytes,
  validateReleaseManifestV3,
  verifyManifestSignature
} = require("./releaseSigning.cjs");

const rootDir = path.resolve(__dirname, "..");
const tmpRoot = path.join(rootDir, ".codex-tmp");
const files = {
  createBundle: path.join(rootDir, "scripts", "createReleaseBundle.cjs"),
  releaseSigning: path.join(rootDir, "scripts", "releaseSigning.cjs"),
  deployBundle: path.join(rootDir, "scripts", "deployReleaseBundle.cjs"),
  recoveryHelperRotation: path.join(rootDir, "scripts", "releaseRecoveryHelperRotation.cjs"),
  checkReleaseStatus: path.join(rootDir, "scripts", "checkReleaseStatus.cjs"),
  releaseSshHostKeyPin: path.join(rootDir, "scripts", "releaseSshHostKeyPin.cjs"),
  verifyReleaseSshHostKeyPin: path.join(rootDir, "scripts", "verifyReleaseSshHostKeyPin.cjs"),
  relayPush: path.join(rootDir, "scripts", "pushSportteryRelaySnapshot.cjs"),
  releaseWrapper: path.join(rootDir, "deploy", "light-server", "football-release"),
  recoveryHelper: path.join(rootDir, "deploy", "light-server", "football-release-recovery.cjs"),
  bundleRelease: path.join(rootDir, "deploy", "light-server", "release-from-bundle.sh"),
  compactPublicOddsHistory: path.join(rootDir, "scripts", "compactPublicOddsHistory.cjs"),
  privateModelArtifactStore: path.join(rootDir, "scripts", "privateModelArtifactStore.cjs"),
  relayPromoter: path.join(rootDir, "deploy", "light-server", "football-relay-promote"),
  bootstrap: path.join(rootDir, "deploy", "light-server", "bootstrap-release-entrypoints.sh"),
  sudoers: path.join(rootDir, "deploy", "light-server", "football-automation.sudoers")
};

const checks = [];
const pushCheck = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const read = (filePath) => fs.readFileSync(filePath, "utf8");
const hasAll = (text, tokens) => tokens.every((token) => text.includes(token));

for (const [name, filePath] of Object.entries(files)) {
  pushCheck(`required file exists: ${name}`, fs.existsSync(filePath), { filePath });
}

const createBundle = read(files.createBundle);
const releaseSigning = read(files.releaseSigning);
const deployBundle = read(files.deployBundle);
const recoveryHelperRotation = read(files.recoveryHelperRotation);
const checkReleaseStatus = read(files.checkReleaseStatus);
const releaseSshHostKeyPin = read(files.releaseSshHostKeyPin);
const verifyReleaseSshHostKeyPin = read(files.verifyReleaseSshHostKeyPin);
const relayPush = read(files.relayPush);
const releaseWrapper = read(files.releaseWrapper);
const recoveryHelper = read(files.recoveryHelper);
const bundleRelease = read(files.bundleRelease);
const compactPublicOddsHistory = read(files.compactPublicOddsHistory);
const privateModelArtifactStore = read(files.privateModelArtifactStore);
const relayPromoter = read(files.relayPromoter);
const bootstrap = read(files.bootstrap);
const sudoers = read(files.sudoers);

pushCheck("bundle creation signs the exact manifest bytes", hasAll(createBundle, [
  "loadReleasePrivateKey",
  "ensureMatchingPublicKeyFile",
  "signManifestBytes",
  "manifestVersion: RELEASE_MANIFEST_VERSION",
  "site: manifestConfig.site",
  "channel: manifestConfig.channel",
  "releaseSequence: sequenceReservation.releaseSequence",
  "expiresAt: manifestConfig.expiresAt",
  "signaturePath",
  "detached-binary"
]));

pushCheck("manifest v3 generator reserves an atomic monotonic local sequence", hasAll(releaseSigning, [
  "RELEASE_MANIFEST_VERSION = 3",
  "DEFAULT_RELEASE_MANIFEST_TTL_HOURS = 48",
  "MAX_RELEASE_MANIFEST_TTL_HOURS = 168",
  "football-release-sequence.json",
  "acquireSequenceLock",
  "fs.mkdirSync(lockPath, { mode: 0o700 })",
  "inspect owner.json",
  "writeSequenceStateAtomically",
  "fs.renameSync(tempPath, statePath)",
  "releaseSequence <= previous.highestReservedSequence"
]));

pushCheck("deploy verifies locally and uses immutable SHA remote names", hasAll(deployBundle, [
  "verifyManifestSignature",
  'const remoteDir = "/var/lib/football-release/incoming"',
  'const remoteEntrypoint = "/usr/local/sbin/football-release"',
  "`${actualSha256}.tgz`",
  "`${actualSha256}.manifest.sig`",
  "chmod 0600 ${shellQuote(remoteBundlePath)}",
  "remoteTrustedKeyMatches",
  "sudo -n ${shellQuote(remoteEntrypoint)} --check",
  "sudo -n ${shellQuote(remoteEntrypoint)} ${shellQuote(actualSha256)}"
]));

pushCheck("release SSH pins one explicit console-verified host key", hasAll(releaseSshHostKeyPin, [
  "RELEASE_DEPLOY_HOST_KEY_SHA256",
  "release known_hosts file must contain exactly one non-comment entry",
  "release SSH host-key fingerprint does not match the explicit pin",
  "StrictHostKeyChecking=yes",
  "UserKnownHostsFile=",
  "GlobalKnownHostsFile=",
  "UpdateHostKeys=no",
  "HostKeyAlgorithms="
]) && hasAll(deployBundle, [
  "resolveReleaseSshHostKeyPin",
  "buildPinnedSshBaseOptions",
  "release SSH host-key pin validation failed"
]) && hasAll(checkReleaseStatus, [
  "resolveReleaseSshHostKeyPin",
  "ssh host-key pin invalid"
]) && hasAll(verifyReleaseSshHostKeyPin, [
  "mismatched explicit fingerprint is rejected before SSH",
  "known_hosts entry for the wrong port is rejected",
  "fails closed when no explicit fingerprint is supplied"
]) && !deployBundle.includes("StrictHostKeyChecking=accept-new")
  && !checkReleaseStatus.includes("StrictHostKeyChecking=accept-new"));

const forbiddenDeployPatterns = [
  "sudo -n true",
  "sudo mv",
  "sudo PUBLIC_BASE_URL=",
  "remoteReleaseScriptPath",
  "releaseScriptPath",
  'remoteDir = process.env.RELEASE_DEPLOY_REMOTE_DIR || "/tmp"'
];
pushCheck("deploy no longer uploads or executes a mutable /tmp script", forbiddenDeployPatterns.every((token) => !deployBundle.includes(token)), {
  presentForbiddenPatterns: forbiddenDeployPatterns.filter((token) => deployBundle.includes(token))
});

pushCheck("release wrapper verifies identity, signature, manifest, archive types, and fixed entrypoint", hasAll(releaseWrapper, [
  'INCOMING_DIR="/var/lib/football-release/incoming"',
  "assert_regular_upload",
  "upload owner mismatch",
  "exactly one hard link",
  "openssl dgst -sha256 -verify",
  "manifest sha256 mismatch",
  "archive contains a link, device, fifo, or other forbidden entry type",
  "archive must contain exactly one release-from-bundle.sh",
  "archive must contain exactly one compactPublicOddsHistory.cjs",
  "signed odds compactor has invalid JavaScript syntax",
  "env -i",
  'APP_DIR="/opt/football-predict"'
]));

pushCheck("release wrapper classifies both signed entrypoints as regular tar files before sequence burn", hasAll(releaseWrapper, [
  'kind = "directory" if member.isdir() else "file"',
  'if normalized == "deploy/light-server/release-from-bundle.sh":',
  'if normalized == "scripts/compactPublicOddsHistory.cjs":',
  'reject("release-from-bundle.sh must be a regular file")',
  'reject("compactPublicOddsHistory.cjs must be a regular file")',
]) && (releaseWrapper.match(/if kind != "file":/g) || []).length >= 2
  && !releaseWrapper.includes('if kind != "regular":')
  && releaseWrapper.indexOf('archive must contain exactly one compactPublicOddsHistory.cjs')
    < releaseWrapper.indexOf('consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"'));

pushCheck("release wrapper exposes fixed cold recovery under the same lock and a clean environment", hasAll(releaseWrapper, [
  'RECOVERY_HELPER="/usr/local/libexec/football-release-recovery.cjs"',
  'if [ "${1:-}" = "--recover" ]',
  'acquire_release_lock',
  'NODE_NO_WARNINGS="1"',
  '"$NODE_BIN" "$RECOVERY_HELPER"',
  'RELEASE_SITE="$EXPECTED_SITE"',
  'RELEASE_CHANNEL="$EXPECTED_CHANNEL"',
  'RELEASE_SEQUENCE="$MANIFEST_SEQUENCE"'
]) && releaseWrapper.indexOf('if [ "${1:-}" = "--recover" ]') < releaseWrapper.indexOf('readonly BUNDLE_NAME='));

pushCheck("cold recovery helper fixes paths and enforces transaction v3 phase direction", hasAll(recoveryHelper, [
  "const TRANSACTION_VERSION = 3",
  'const APP_PATH = "/opt/football-predict"',
  'const RECOVERY_CURRENT_PATH = `${RECOVERY_ROOT_PATH}/current`',
  'treeMarker: readTreeMarker(mapped, ".release-tree-identity")',
  'value !== identity.treeMarker',
  '"finalizing", "committed", "recovering-commit"',
  "inspectTopology",
  "prevalidateRestoreTargets",
  "quiesceAll",
  "resolveTransaction",
  "isolateKnownFailedTree"
]));

pushCheck("bundle and fixed helper share the complete external model recovery contract", hasAll(bundleRelease, [
  "MODEL_ARTIFACT_TOKENS=(strategy evaluation candidate-registry candidate-challenger-suite candidate-temperature-suite candidate-common-cohort-g2-v1 candidate-common-cohort-g2-v2 candidate-capture-status benchmark-prospective-ledger)",
  "/var/lib/football-predict/model-strategy.json",
  "/var/lib/football-predict/model-artifacts/evaluation.json",
  "/var/lib/football-predict/model-artifacts/candidate-prospective-registry.json",
  "/var/lib/football-predict/model-artifacts/candidate-prospective-challenger-suite.json",
  "/var/lib/football-predict/model-artifacts/candidate-prospective-temperature-neutralization-suite.json",
  "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2.json",
  "/var/lib/football-predict/model-artifacts/candidate-common-cohort-shadow-g2-v2.json",
  "/var/lib/football-predict/candidate-prospective-capture-status.json",
  "/var/lib/football-predict/model-artifacts/benchmark-prospective-ledger.json",
  "backup_live_sqlite_for_rollback",
  "restore_live_sqlite_after_rollback"
]) && hasAll(recoveryHelper, [
  '["strategy", `${STORE_PATH}/model-strategy.json`]',
  '["evaluation", `${STORE_PATH}/model-artifacts/evaluation.json`]',
  '["candidate-registry", `${STORE_PATH}/model-artifacts/candidate-prospective-registry.json`]',
  '["candidate-challenger-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-challenger-suite.json`]',
  '["candidate-temperature-suite", `${STORE_PATH}/model-artifacts/candidate-prospective-temperature-neutralization-suite.json`]',
  '["candidate-common-cohort-g2-v1", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2.json`]',
  '["candidate-common-cohort-g2-v2", `${STORE_PATH}/model-artifacts/candidate-common-cohort-shadow-g2-v2.json`]',
  '["candidate-capture-status", `${STORE_PATH}/candidate-prospective-capture-status.json`]',
  '["benchmark-prospective-ledger", `${STORE_PATH}/model-artifacts/benchmark-prospective-ledger.json`]',
  '["candidate-common-cohort-g2", COMMON_COHORT_G2_V1_PATH]',
  "const LEGACY_MODEL_ARTIFACT_COUNTS = new Set([2, 4, 5, 6, 7])"
]) && hasAll(privateModelArtifactStore, [
  "private_model_artifacts",
  "CREATE TABLE IF NOT EXISTS",
  "BEGIN IMMEDIATE"
]) && !/hhad[_-]companion[_-]audit/i.test(bundleRelease)
  && !/hhad[_-]companion[_-]audit/i.test(recoveryHelper));

pushCheck("signed candidate odds compaction is file-based and fail-closed", hasAll(bundleRelease, [
  "compact_public_odds_history",
  '"$NODE_HOME/bin/node" scripts/compactPublicOddsHistory.cjs',
  'compact_public_odds_history "$BUILD_DIR"',
]) && !/compact_script|node\s+-e\s+"\$compact/i.test(bundleRelease) && hasAll(compactPublicOddsHistory, [
  "public-odds-history-compaction-v2",
  "odds history input is not valid JSON",
  "odds history mirror digests differ after compaction",
  "mirrorDigestsMatch: true",
  "assertRegularFile",
  "fs.fsyncSync",
]));

pushCheck("deploy recovery branches before bundle discovery and verifies public readiness", hasAll(deployBundle, [
  "const recoverMode =",
  "sudo -n ${shellQuote(remoteEntrypoint)} --recover",
  'REMOTE_REQUIRE_SQLITE: recoveredNativeStorage ? "0" : "1"',
  'REMOTE_REQUIRE_POSTGRES_ONLY: recoveredNativeStorage ? "1" : "0"',
  'REMOTE_REQUIRE_SYNC_WORKER: "1"',
  'mode: "recover"',
  "recoveryPending=0"
]) && deployBundle.indexOf("if (recoverMode)") < deployBundle.indexOf("const bundlePath = latestBundlePath()"));

pushCheck("release wrapper creates a bounded root-private normalized trusted extraction", hasAll(releaseWrapper, [
  "MAX_ARCHIVE_ENTRIES=100000",
  "MAX_ARCHIVE_ENTRY_BYTES",
  "MAX_ARCHIVE_EXTRACTED_BYTES",
  "duplicate normalized path",
  "--no-same-owner --no-same-permissions",
  "trusted extraction inventory mismatch",
  'chmod 0700 "$RELEASE_SCRIPT_PATH"',
  'TRUSTED_SOURCE_DIR="${work_dir}/trusted"'
]) && !releaseWrapper.includes("tar -xOzf"));

pushCheck("release archive normalizer accepts only the standard tar root dot marker", hasAll(releaseWrapper, [
  'if not name or name == ".":',
  'if posixpath.normpath(name) != name:',
  'part in ("", ".", "..")'
]));

pushCheck("bundle release isolates mutable builds and assembles only validated outputs", hasAll(bundleRelease, [
  "assert_build_user_quiescent",
  "systemd-run --quiet --wait --collect --pipe",
  "assert_transient_unit_cleared",
  "ci --include=dev --ignore-scripts",
  "prune --omit=dev --ignore-scripts",
  "validate_build_artifacts",
  "assemble_final_tree",
  "ensure_app_tree_identity_marker",
  '.release-tree-identity',
  "symlink escapes node_modules",
  "group/world-writable artifact",
  'install_systemd_units "$NEXT_DIR"',
  'install_nginx_config "$NEXT_DIR"',
  '"$NODE_HOME/bin/node" scripts/verifyProductionReadiness.cjs'
]) && !bundleRelease.includes("tar -xzf") && !bundleRelease.includes("run_as_build_user"));

pushCheck("release wrapper enforces manifest v3 identity, expiry, and anti-replay fields", hasAll(releaseWrapper, [
  'EXPECTED_MANIFEST_VERSION="3"',
  "/etc/football-release/expected-site",
  "/etc/football-release/expected-channel",
  "/var/lib/football-release/highest-accepted-sequence",
  "manifest.site",
  "manifest.channel",
  "manifest.releaseSequence",
  "manifest.createdAt",
  "manifest.expiresAt"
]));

const wrapperLockIndex = releaseWrapper.indexOf("flock -n 9");
const wrapperProtectedStateReads = [
  'readonly EXPECTED_SITE="$(read_single_line',
  'readonly EXPECTED_CHANNEL="$(read_single_line',
  'readonly HIGHEST_ACCEPTED_SEQUENCE="$(read_single_line'
].map((token) => releaseWrapper.indexOf(token));
pushCheck("release wrapper reads manifest identity and replay state under the release lock",
  wrapperLockIndex >= 0
    && wrapperProtectedStateReads.every((index) => index > wrapperLockIndex), {
    wrapperLockIndex,
    protectedStateReadIndexes: wrapperProtectedStateReads
  });

const antiReplayWrapper = releaseWrapper.replace(/\r\n?/g, "\n");
const consumeSequenceToken = 'consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"';
const signatureValidated = antiReplayWrapper.indexOf('|| die "manifest signature verification failed"');
const sequenceValidated = antiReplayWrapper.indexOf('readonly MANIFEST_SEQUENCE="$manifest_sequence"');
const inventoryValidationStarted = antiReplayWrapper.indexOf('python3 - "$BUNDLE_PATH" "$inventory_path"');
const inventoryValidationCompleted = antiReplayWrapper.indexOf("\nPY\n", inventoryValidationStarted);
const frontendBranchStarted = antiReplayWrapper.indexOf('if [ "$MANIFEST_KIND" = "frontend-only" ]; then', inventoryValidationCompleted);
const fullContinuationStarted = antiReplayWrapper.indexOf('readonly TRUSTED_SOURCE_DIR="${work_dir}/trusted"');
const archiveValidationCompleted = antiReplayWrapper.indexOf('bash -n "$RELEASE_SCRIPT_PATH"', fullContinuationStarted);
const sequenceConsumed = antiReplayWrapper.indexOf(consumeSequenceToken, fullContinuationStarted);
const guardedReleaseStarted = antiReplayWrapper.indexOf('bash "$RELEASE_SCRIPT_PATH" "$TRUSTED_SOURCE_DIR"', fullContinuationStarted);
const frontendBranch = antiReplayWrapper.slice(frontendBranchStarted, fullContinuationStarted);
const frontendSequenceConsumed = frontendBranch.indexOf(consumeSequenceToken);
const frontendControllerStarted = frontendBranch.indexOf('"${FRONTEND_HELPER_DIR}/frontendReleaseController.cjs" \\\n    apply "$BUNDLE_SHA" "$MANIFEST_SEQUENCE" "$work_dir"');
pushCheck("release anti-replay sequence is atomically burned after validation and before execution", hasAll(releaseWrapper, [
  "highest accepted sequence changed while the release lock was held",
  "sync -f \"$state_tmp\"",
  "mv -fT \"$state_tmp\" \"$HIGHEST_SEQUENCE_FILE\"",
  "sync -f \"$state_dir\""
]) && signatureValidated >= 0
  && sequenceValidated > signatureValidated
  && inventoryValidationStarted > sequenceValidated
  && inventoryValidationCompleted > inventoryValidationStarted
  && frontendBranchStarted > inventoryValidationCompleted
  && fullContinuationStarted > frontendBranchStarted
  && frontendSequenceConsumed >= 0
  && frontendControllerStarted > frontendSequenceConsumed
  && frontendBranch.split(consumeSequenceToken).length === 2
  && archiveValidationCompleted > fullContinuationStarted
  && sequenceConsumed > archiveValidationCompleted
  && guardedReleaseStarted > sequenceConsumed
  && antiReplayWrapper.slice(fullContinuationStarted, guardedReleaseStarted).split(consumeSequenceToken).length === 2
  && !releaseWrapper.includes("commit_highest_accepted_sequence"));

pushCheck("release wrapper does not accept caller-controlled production paths", [
  "APP_DIR=\"${APP_DIR:-",
  "INCOMING_DIR=\"${INCOMING_DIR:-",
  "PUBLIC_KEY=\"${PUBLIC_KEY:-",
  "SERVICE_NAME=\"${"
].every((token) => !releaseWrapper.includes(token)));

pushCheck("relay upload uses the fixed promoter", hasAll(relayPush, [
  'sshRelayIncomingDir = "/var/lib/football-relay/incoming"',
  'sshRelayPromoter = "/usr/local/sbin/football-relay-promote"',
  "timestampId",
  "chmod 0600",
  "trap 'rm -f",
  "sudo -n '${sshRelayPromoter}' '${sha256}' '${timestampId}'"
]) && !relayPush.includes("sudo install -o football") && !relayPush.includes("sudo mv"));

pushCheck("relay promoter only installs the fixed snapshot", hasAll(relayPromoter, [
  'INCOMING_DIR="/var/lib/football-relay/incoming"',
  'TARGET="/var/lib/football-predict/sporttery-relay-snapshot.json"',
  "snapshot upload owner mismatch",
  "snapshot sha256 mismatch",
  "actual endpoint rows are below 100",
  "summary.rows does not match endpoint payload rows",
  "capturedAt must be strictly newer than the current target",
  "flock -x 9",
  "mv -fT \"$PROMOTED\" \"$TARGET\""
]));

pushCheck("bootstrap installs wrappers but leaves sudoers to an explicit operator step", hasAll(bootstrap, [
  "/usr/local/sbin/football-release",
  "/usr/local/libexec/football-release-recovery.cjs",
  "/usr/local/sbin/football-relay-promote",
  "sudoers was NOT installed",
  "visudo -cf"
]) && !/^\s*install\s+.*\/etc\/sudoers\.d\//m.test(bootstrap));

pushCheck("bootstrap installs fixed manifest identity and non-regressing sequence state", hasAll(bootstrap, [
  "/etc/football-release/expected-site",
  "/etc/football-release/expected-channel",
  "/var/lib/football-release/highest-accepted-sequence",
  "/var/lib/football-release/recovery",
  'RECOVERY_CURRENT_PATH="/var/lib/football-release/recovery/current"',
  "recovery transaction pending; run the fixed recovery entrypoint before bootstrap",
  "initial highest sequence must not lower existing state",
  'RELEASE_LOCK_PATH="/run/lock/football-release.lock"',
  "flock 9",
  "chmod 0600",
  "mv -fT"
]) && bootstrap.indexOf("flock 9") < bootstrap.indexOf('if [ -e "$RECOVERY_CURRENT_PATH"')
  && bootstrap.indexOf("recovery transaction pending") < bootstrap.indexOf("current_highest_sequence=0"));

pushCheck("sudoers template grants only fixed NOSETENV entrypoints", hasAll(sudoers, [
  "NOPASSWD: NOSETENV:",
  "/usr/local/sbin/football-release",
  "/usr/local/sbin/football-release --recover",
  "/usr/local/sbin/football-relay-promote",
  "^[0-9a-f]{64}$",
  "^[0-9a-f]{64}[[:space:]][0-9]{8}T[0-9]{9}Z$"
]) && !/NOPASSWD:\s*ALL/.test(sudoers));

pushCheck("deploy preflight only accepts a helper mismatch through the exact signed rotation contract", hasAll(deployBundle, [
  "inspectBundleEntrySha256",
  "inspectBundleEntryBytes",
  "RELEASE_SHELL_ENTRY",
  "parseFixedRecoveryHelperRotationContract",
  "expectedRecoveryHelperSha256",
  "release-recovery-helper-mismatch",
  "remoteRecoveryHelperMatches",
  "remoteRecoveryHelperRotationRequired",
  "remoteRecoveryHelperAcceptable",
  "release-recovery-helper-postcheck-mismatch",
  "recovery-helper-postcheck-ok"
]) && hasAll(recoveryHelperRotation, [
  "football-fixed-recovery-helper-rotation-v1",
  "deploy/light-server/release-from-bundle.sh",
  "parseFixedRecoveryHelperRotationContract",
  "declarationsOk",
  "orderingOk"
]));

pushCheck("status preflight still requires the candidate fixed recovery helper", hasAll(checkReleaseStatus, [
  "inspectBundleEntrySha256",
  "checkRemoteRecoveryHelper",
  "remote cold-recovery helper does not match the candidate bundle",
  "recoveryPending=0"
]));

const nodeFiles = [
  "scripts/releaseSigning.cjs",
  "scripts/generateReleaseSigningKey.cjs",
  "scripts/createReleaseBundle.cjs",
  "scripts/deployReleaseBundle.cjs",
  "scripts/releaseRecoveryHelperRotation.cjs",
  "scripts/verifyRecoveryHelperRotation.cjs",
  "scripts/checkReleaseStatus.cjs",
  "scripts/compactPublicOddsHistory.cjs",
  "deploy/light-server/football-release-recovery.cjs",
  "scripts/pushSportteryRelaySnapshot.cjs",
  "scripts/verifyReleaseTransactionSafety.cjs",
  "scripts/verifyReleaseRecovery.cjs",
  "scripts/verifyReleaseSidecarRecovery.cjs",
  "scripts/verifyNativeSidecarLifecycle.cjs",
  "scripts/verifySignedReleaseEntrypoints.cjs"
];
for (const relativePath of nodeFiles) {
  const result = spawnSync(process.execPath, ["--check", path.join(rootDir, relativePath)], { encoding: "utf8" });
  pushCheck(`node syntax: ${relativePath}`, result.status === 0, {
    status: result.status,
    error: (result.stderr || result.stdout || "").slice(-1000)
  });
}

const bashCandidates = [
  process.env.BASH_EXE,
  "bash",
  "D:\\app\\Git\\bin\\bash.exe"
].filter(Boolean);
let bashCommand = null;
for (const candidate of bashCandidates) {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    bashCommand = candidate;
    break;
  }
}
pushCheck("bash runtime is available for syntax checks", Boolean(bashCommand), { bashCommand });
if (bashCommand) {
  for (const relativePath of [
    "deploy/light-server/football-release",
    "deploy/light-server/release-from-bundle.sh",
    "deploy/light-server/football-relay-promote",
    "deploy/light-server/bootstrap-release-entrypoints.sh"
  ]) {
    const result = spawnSync(bashCommand, ["-n", path.join(rootDir, relativePath)], { encoding: "utf8" });
    pushCheck(`bash syntax: ${relativePath}`, result.status === 0, {
      status: result.status,
      error: (result.stderr || result.stdout || "").slice(-1000)
    });
  }
}

fs.mkdirSync(tmpRoot, { recursive: true });
const testDir = fs.mkdtempSync(path.join(tmpRoot, "signed-release-selftest-"));
try {
  const privateKeyPath = path.join(testDir, "private.pem");
  const publicKeyPath = path.join(testDir, "public.pem");
  const manifestPath = path.join(testDir, "manifest.json");
  const signaturePath = path.join(testDir, "manifest.sig");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
  const keyObject = crypto.createPrivateKey(privateKey);
  const keyId = publicKeyId(keyObject);
  const verificationNow = new Date();
  const manifest = {
    ok: true,
    manifestVersion: RELEASE_MANIFEST_VERSION,
    site: DEFAULT_RELEASE_SITE,
    channel: DEFAULT_RELEASE_CHANNEL,
    releaseSequence: 1,
    createdAt: verificationNow.toISOString(),
    expiresAt: new Date(verificationNow.getTime() + DEFAULT_RELEASE_MANIFEST_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    policyVersion: "release-secret-policy-v2",
    sha256: "a".repeat(64),
    bytes: 123,
    blockedEntries: [],
    sensitiveEntries: [],
    missingEntries: [],
    signature: {
      algorithm: RELEASE_SIGNATURE_ALGORITHM,
      keyId,
      format: "detached-binary"
    }
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestPath, manifestBytes);
  fs.writeFileSync(signaturePath, signManifestBytes(manifestBytes, keyObject));

  const verified = verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath, now: verificationNow });
  pushCheck("valid detached manifest signature is accepted", verified.manifest.sha256 === manifest.sha256 && verified.keyId === keyId);

  const defaultConfig = resolveReleaseManifestConfig({ env: {}, now: verificationNow });
  pushCheck("manifest v3 defaults are fixed and bounded", defaultConfig.site === DEFAULT_RELEASE_SITE
    && defaultConfig.channel === DEFAULT_RELEASE_CHANNEL
    && defaultConfig.ttlHours === DEFAULT_RELEASE_MANIFEST_TTL_HOURS
    && (new Date(defaultConfig.expiresAt) - new Date(defaultConfig.createdAt)) === DEFAULT_RELEASE_MANIFEST_TTL_HOURS * 60 * 60 * 1000
    && DEFAULT_RELEASE_MANIFEST_TTL_HOURS < MAX_RELEASE_MANIFEST_TTL_HOURS);

  const invalidGeneratorConfigs = [
    { RELEASE_SITE: "" },
    { RELEASE_CHANNEL: "../production" },
    { RELEASE_MANIFEST_TTL_HOURS: "1.5" },
    { RELEASE_MANIFEST_TTL_HOURS: String(MAX_RELEASE_MANIFEST_TTL_HOURS + 1) }
  ];
  const rejectedGeneratorConfigs = invalidGeneratorConfigs.filter((env) => {
    try {
      resolveReleaseManifestConfig({ env, now: verificationNow });
      return false;
    } catch {
      return true;
    }
  });
  pushCheck("manifest v3 generator rejects invalid identity and TTL overrides",
    rejectedGeneratorConfigs.length === invalidGeneratorConfigs.length);

  let invalidSequenceRejected = false;
  try {
    validateReleaseManifestV3({ ...manifest, releaseSequence: "1" }, { now: verificationNow });
  } catch {
    invalidSequenceRejected = true;
  }
  pushCheck("manifest v3 rejects non-numeric release sequences", invalidSequenceRejected);

  let expiredManifestRejected = false;
  try {
    validateReleaseManifestV3({
      ...manifest,
      createdAt: new Date(verificationNow.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(verificationNow.getTime() - 2 * 60 * 60 * 1000).toISOString()
    }, { now: verificationNow });
  } catch {
    expiredManifestRejected = true;
  }
  pushCheck("manifest v3 rejects expired authorization windows", expiredManifestRejected);

  let excessiveLifetimeRejected = false;
  try {
    validateReleaseManifestV3({
      ...manifest,
      expiresAt: new Date(verificationNow.getTime() + (MAX_RELEASE_MANIFEST_TTL_HOURS + 1) * 60 * 60 * 1000).toISOString()
    }, { now: verificationNow });
  } catch {
    excessiveLifetimeRejected = true;
  }
  pushCheck("manifest v3 rejects authorization windows above the cap", excessiveLifetimeRejected);

  const sequenceStatePath = path.join(testDir, "sequence-state.json");
  const firstReservation = reserveReleaseSequence({
    site: DEFAULT_RELEASE_SITE,
    channel: DEFAULT_RELEASE_CHANNEL,
    statePath: sequenceStatePath,
    now: verificationNow
  });
  const recoveryReservation = reserveReleaseSequence({
    site: DEFAULT_RELEASE_SITE,
    channel: DEFAULT_RELEASE_CHANNEL,
    statePath: sequenceStatePath,
    requestedSequence: "7",
    now: verificationNow
  });
  let sequenceRegressionRejected = false;
  try {
    reserveReleaseSequence({
      site: DEFAULT_RELEASE_SITE,
      channel: DEFAULT_RELEASE_CHANNEL,
      statePath: sequenceStatePath,
      requestedSequence: "7",
      now: verificationNow
    });
  } catch {
    sequenceRegressionRejected = true;
  }
  const sequenceState = JSON.parse(fs.readFileSync(sequenceStatePath, "utf8"));
  pushCheck("local release sequence state advances atomically and never regresses",
    firstReservation.releaseSequence === 1
      && recoveryReservation.releaseSequence === 7
      && sequenceRegressionRejected
      && sequenceState.highestReservedSequence === 7
      && !fs.existsSync(`${sequenceStatePath}.lock`));

  const concurrentStatePath = path.join(testDir, "concurrent-sequence-state.json");
  const concurrencyHarness = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [signingPath, statePath] = process.argv.slice(1);
const childCode = "const s=require(process.argv[1]);const r=s.reserveReleaseSequence({site:'football-predict',channel:'production',statePath:process.argv[2]});process.stdout.write(String(r.releaseSequence));";
const run = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", childCode, signingPath, statePath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve(Number(stdout)) : reject(new Error(stderr || "reservation child failed")));
});
Promise.all([run(), run(), run(), run()]).then((values) => {
  const sequences = values.sort((a, b) => a - b);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (JSON.stringify(sequences) !== JSON.stringify([1, 2, 3, 4]) || state.highestReservedSequence !== 4) process.exit(2);
}).catch((error) => { console.error(error.stack || error); process.exit(1); });
`;
  const concurrencyResult = spawnSync(process.execPath, [
    "-e",
    concurrencyHarness,
    files.releaseSigning,
    concurrentStatePath
  ], { encoding: "utf8", timeout: 30000 });
  pushCheck("concurrent release sequence reservations are unique and monotonic", concurrencyResult.status === 0
    && !fs.existsSync(`${concurrentStatePath}.lock`), {
    status: concurrencyResult.status,
    error: (concurrencyResult.stderr || concurrencyResult.stdout || "").slice(-1000)
  });

  fs.appendFileSync(manifestPath, " ");
  let tamperedRejected = false;
  try {
    verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath });
  } catch {
    tamperedRejected = true;
  }
  pushCheck("tampered manifest is rejected", tamperedRejected);
} catch (error) {
  pushCheck("detached signature self-test completed", false, { error: error.stack || error.message || String(error) });
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({
  ok,
  checkedAt: new Date().toISOString(),
  checks: checks.length,
  failed: checks.filter((check) => !check.ok)
}, null, 2));
if (!ok) process.exit(1);
