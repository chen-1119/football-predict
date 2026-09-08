const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  RELEASE_BUNDLE_POLICY_VERSION,
  findSensitiveReleaseEntries
} = require("./releaseBundlePolicy.cjs");
const {
  RELEASE_MANIFEST_VERSION,
  RELEASE_SIGNATURE_ALGORITHM,
  resolvePublicKeyPath,
  verifyManifestSignature
} = require("./releaseSigning.cjs");
const {
  buildPinnedSshBaseOptions,
  resolveReleaseSshHostKeyPin
} = require("./releaseSshHostKeyPin.cjs");
const {
  RELEASE_SHELL_ENTRY,
  parseFixedRecoveryHelperRotationContract
} = require("./releaseRecoveryHelperRotation.cjs");
const { buildReadOnlyWorkerProbe } = require("./releaseWorkerPreflight.cjs");
const { collectFilesNewerThan } = require("./releaseWorkspaceFreshness.cjs");
const { buildFrontendIdentityReaderSource, frontendIdentityMatchesCandidate } = require("../server/frontendReleaseIdentity.cjs");

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const dryRun = process.env.RELEASE_DEPLOY_DRY_RUN === "1" || process.argv.includes("--dry-run");
const recoverMode = process.env.RELEASE_DEPLOY_RECOVER === "1" || process.argv.includes("--recover");
const host = process.env.RELEASE_DEPLOY_HOST || "134.175.132.183";
const user = process.env.RELEASE_DEPLOY_USER || "ubuntu";
const sshPort = Number(process.env.RELEASE_DEPLOY_PORT || 22);
const keyPath = path.resolve(process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, "football.pem"));
const remoteDir = "/var/lib/football-release/incoming";
const remoteEntrypoint = "/usr/local/sbin/football-release";
const remoteStatusDir = "/var/lib/football-release/status";
const remoteLogDir = "/var/lib/football-release/logs";
const recoveryHelperEntry = "deploy/light-server/football-release-recovery.cjs";
const remoteRecoveryHelperPath = "/usr/local/libexec/football-release-recovery.cjs";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.REMOTE_BASE_URL || `https://${host}`;
const sshTarget = `${user}@${host}`;
const serverAliveCountMax = String(process.env.RELEASE_DEPLOY_SERVER_ALIVE_COUNT_MAX || 6);
const uploadAttempts = Math.max(1, Number(process.env.RELEASE_DEPLOY_UPLOAD_ATTEMPTS || 5));
const uploadRetryDelayMs = Math.max(1000, Number(process.env.RELEASE_DEPLOY_UPLOAD_RETRY_DELAY_MS || 5000));
const recoveryAttempts = Math.max(1, Number(process.env.RELEASE_DEPLOY_RECOVERY_ATTEMPTS || 6));
const recoveryRetryDelayMs = Math.max(1000, Number(process.env.RELEASE_DEPLOY_RECOVERY_RETRY_DELAY_MS || 5000));

const fail = (message, details = {}) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: message,
    ...details
  }, null, 2));
  process.exit(1);
};

let sshHostKeyPin;
try {
  sshHostKeyPin = resolveReleaseSshHostKeyPin({ rootDir, tmpDir, host, port: sshPort });
} catch (error) {
  fail("release SSH host-key pin validation failed", {
    host,
    port: sshPort,
    reason: error.message || String(error)
  });
}
const baseSshOptions = buildPinnedSshBaseOptions({
  keyPath,
  pin: sshHostKeyPin,
  serverAliveCountMax
});
const sshOptions = [
  "-p",
  String(sshPort),
  ...baseSshOptions
];
const scpOptions = [
  "-P",
  String(sshPort),
  ...baseSshOptions
];

const allowStaleBundle = process.env.RELEASE_DEPLOY_ALLOW_STALE_BUNDLE === "1";

const runCommand = (name, args, options = {}) => {
  if (dryRun) {
    return {
      status: 0,
      dryRun: true,
      command: name,
      args
    };
  }
  const result = spawnSync(name, args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
  return {
    status: result.status,
    command: name,
    args,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null
  };
};

const latestBundlePath = () => {
  if (process.env.RELEASE_BUNDLE_PATH) return path.resolve(process.env.RELEASE_BUNDLE_PATH);
  const candidates = fs.existsSync(tmpDir)
    ? fs.readdirSync(tmpDir)
      .filter((name) => /^football-release-.+\.tgz$/.test(name))
      .map((name) => {
        const filePath = path.join(tmpDir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];
  return candidates[0]?.filePath || "";
};

const readShaFile = (filePath) => fs.readFileSync(filePath, "utf8").trim().split(/\s+/)[0]?.toLowerCase() || "";
const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const inspectBundleEntries = (filePath) => {
  const result = spawnSync("tar", ["-tzf", filePath], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const entries = result.status === 0
    ? (result.stdout || "").split(/\r?\n/).filter(Boolean)
    : [];
  return {
    ok: result.status === 0,
    status: result.status,
    entries,
    sensitiveEntries: findSensitiveReleaseEntries(entries),
    error: result.error?.message || (result.status === 0 ? null : (result.stderr || "").slice(-1000))
  };
};
const inspectBundleEntryBytes = (filePath, entry) => {
  const result = spawnSync("tar", ["-xOzf", filePath, `./${entry}`], {
    cwd: rootDir,
    encoding: null,
    maxBuffer: 20 * 1024 * 1024
  });
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  return {
    ok: result.status === 0 && bytes.length > 0,
    status: result.status,
    bytes: bytes.length,
    content: result.status === 0 && bytes.length > 0 ? bytes : null,
    sha256: result.status === 0 && bytes.length > 0
      ? crypto.createHash("sha256").update(bytes).digest("hex")
      : null,
    error: result.error?.message || (result.status === 0 ? null : String(result.stderr || "").slice(-1000))
  };
};
const inspectBundleEntrySha256 = (filePath, entry) => {
  const inspection = inspectBundleEntryBytes(filePath, entry);
  return {
    ok: inspection.ok,
    status: inspection.status,
    bytes: inspection.bytes,
    sha256: inspection.sha256,
    error: inspection.error
  };
};
const remoteJoin = (...parts) => parts.join("/").replace(/\/+/g, "/");
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const parseKeyValue = (text) => {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
};
const sleepSync = (delayMs) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
};
const extractSection = (text, name, nextName = null) => {
  const startToken = `---${name}---`;
  const start = String(text || "").indexOf(startToken);
  if (start < 0) return "";
  const bodyStart = start + startToken.length;
  const end = nextName ? String(text || "").indexOf(`---${nextName}---`, bodyStart) : -1;
  return String(text || "").slice(bodyStart, end >= 0 ? end : undefined).trim();
};

const buildRemotePreflightCommand = (expectedRecoveryHelperSha256, rotationContractReady) => [
  "set -euo pipefail",
  `test -x ${shellQuote(remoteEntrypoint)} || { echo "release-entrypoint-missing"; exit 20; }`,
  `test -d ${shellQuote(remoteDir)} && test -w ${shellQuote(remoteDir)} || { echo "release-incoming-not-writable"; exit 21; }`,
  `test -f ${shellQuote(remoteRecoveryHelperPath)} && test ! -L ${shellQuote(remoteRecoveryHelperPath)} || { echo "release-recovery-helper-missing"; exit 25; }`,
  `test "$(stat -c '%F:%u:%g:%a:%h' ${shellQuote(remoteRecoveryHelperPath)})" = "regular file:0:0:644:1" || { echo "release-recovery-helper-unsafe"; exit 25; }`,
  `test -x /opt/node-v22.22.1/bin/node && /opt/node-v22.22.1/bin/node --check ${shellQuote(remoteRecoveryHelperPath)} >/dev/null || { echo "release-recovery-helper-invalid"; exit 25; }`,
  `recovery_helper_sha="$(sha256sum ${shellQuote(remoteRecoveryHelperPath)} | awk '{print $1}')"`,
  "printf 'recoveryHelperSha=%s\\n' \"$recovery_helper_sha\"",
  `entrypoint_check="$(sudo -n ${shellQuote(remoteEntrypoint)} --check)" || { echo "release-entrypoint-check-failed"; exit 22; }`,
  "printf '%s\\n' \"$entrypoint_check\"",
  "case \"$entrypoint_check\" in *\"recoveryPending=0\"*) ;; *) echo \"release-recovery-pending\"; exit 24 ;; esac",
  "case \"$entrypoint_check\" in *\"appPresent=1\"*) ;; *) echo \"app-dir-missing\"; exit 22 ;; esac",
  "systemctl is-active football-predict >/dev/null || { echo \"service-inactive\"; exit 23; }",
  `sudo -n /opt/node-v22.22.1/bin/node -e ${shellQuote(buildReadOnlyWorkerProbe())} || { echo "release-worker-preflight-rejected"; exit 27; }`,
  `if test "$recovery_helper_sha" = ${shellQuote(expectedRecoveryHelperSha256)}; then echo "recoveryHelperRotationRequired=0"; elif test ${shellQuote(rotationContractReady ? "1" : "0")} = "1"; then echo "recoveryHelperRotationRequired=1"; else echo "release-recovery-helper-mismatch"; exit 26; fi`,
  `echo "recoveryHelperRotationContractReady=${rotationContractReady ? "1" : "0"}"`,
  "echo preflight-ok"
].join("; ");

if (recoverMode) {
  if (!fs.existsSync(keyPath)) fail("ssh key not found", { keyPath });
  const remoteRecoveryCommand = [
    "set -euo pipefail",
    `test -x ${shellQuote(remoteEntrypoint)} || { echo "release-entrypoint-missing"; exit 20; }`,
    `recovery_output="$(sudo -n ${shellQuote(remoteEntrypoint)} --recover)"`,
    "printf '%s\\n' \"$recovery_output\"",
    `check_output="$(sudo -n ${shellQuote(remoteEntrypoint)} --check)"`,
    "printf '%s\\n' \"$check_output\"",
    "case \"$check_output\" in *\"recoveryPending=0\"*\"appPresent=1\"*) ;; *) echo \"recovery-postcheck-failed\"; exit 25 ;; esac",
    "test ! -e /var/lib/football-release/recovery/current && test ! -L /var/lib/football-release/recovery/current",
    "systemctl is-active --quiet football-predict.service",
    "curl -fsS --max-time 8 http://127.0.0.1:8788/api/v1/health >/dev/null",
    "echo recovery-ok"
  ].join("; ");
  const recovery = runCommand("ssh", [
    ...sshOptions,
    sshTarget,
    remoteRecoveryCommand
  ]);
  const sshRecoveryOk = recovery.status === 0
    && (recovery.dryRun || (recovery.stdout || "").includes("recovery-ok"));
  const publicVerify = sshRecoveryOk
    ? runCommand(process.execPath, ["scripts/verifyRemotePublicReadiness.cjs"], {
      env: {
        ...process.env,
        REMOTE_BASE_URL: publicBaseUrl,
        REMOTE_REQUIRE_HEALTHY: "0",
        REMOTE_REQUIRE_SQLITE: "1",
        REMOTE_REQUIRE_SYNC_WORKER: "1",
        REMOTE_SQLITE_READY_ATTEMPTS: process.env.REMOTE_SQLITE_READY_ATTEMPTS || "12",
        REMOTE_SQLITE_READY_RETRY_DELAY_MS: process.env.REMOTE_SQLITE_READY_RETRY_DELAY_MS || "5000"
      }
    })
    : null;
  const publicPayload = parseJson(publicVerify?.stdout || "");
  const publicOk = Boolean(publicVerify?.dryRun || (publicVerify?.status === 0 && publicPayload?.ok === true));
  const ok = sshRecoveryOk && publicOk;
  console.log(JSON.stringify({
    ok,
    checkedAt: new Date().toISOString(),
    mode: "recover",
    host,
    user,
    publicBaseUrl,
    sshHostKeyPin,
    dryRun,
    step: {
      name: "remote cold release recovery",
      ok,
      status: recovery.status,
      dryRun: recovery.dryRun || false,
      command: recovery.command,
      args: recovery.args,
      stdoutTail: recovery.stdout?.slice(-3000) || "",
      stderrTail: recovery.stderr?.slice(-2000) || "",
      error: recovery.error || null
    },
    publicVerification: publicVerify ? {
      ok: publicOk,
      status: publicVerify.status,
      dryRun: publicVerify.dryRun || false,
      sqliteReady: publicPayload?.summary?.sqliteReady ?? null,
      syncWorkerActive: publicPayload?.summary?.syncWorkerActive ?? null,
      currentReadSource: publicPayload?.summary?.currentReadSource || null,
      stdoutTail: publicVerify.stdout?.slice(-3000) || "",
      stderrTail: publicVerify.stderr?.slice(-2000) || "",
      error: publicVerify.error || null
    } : null
  }, null, 2));
  if (!ok) process.exit(1);
  process.exit(0);
}

async function deploySelectedBundle() {
const bundlePath = latestBundlePath();
if (!bundlePath || !fs.existsSync(bundlePath)) fail("release bundle not found", { bundlePath });

if (!fs.existsSync(keyPath)) fail("ssh key not found", { keyPath });

// Local routing begins only with the reviewed signature verifier. Neither an
// environment flag nor an unverified manifest may suppress the full workflow.
const shaPath = `${bundlePath}.sha256`;
const manifestPath = `${bundlePath}.manifest.json`;
const signaturePath = `${bundlePath}.manifest.sig`;
const signingPublicKeyPath = resolvePublicKeyPath();
for (const requiredPath of [shaPath, manifestPath, signaturePath, signingPublicKeyPath]) {
  if (!fs.existsSync(requiredPath)) fail("required release sidecar missing", { requiredPath });
}

const actualSha256 = sha256File(bundlePath);
const sidecarSha256 = readShaFile(shaPath);
let signatureVerification;
try {
  signatureVerification = verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath: signingPublicKeyPath });
} catch (error) {
  fail("release manifest signature verification failed", {
    manifestPath,
    signaturePath,
    signingPublicKeyPath,
    reason: error.message || String(error)
  });
}
const manifest = signatureVerification.manifest;
const releaseCandidate = { releaseKind: manifest.releaseKind === undefined ? "full" : manifest.releaseKind,
  sha256: actualSha256, releaseSequence: manifest.releaseSequence };
if (!["full", "frontend-only"].includes(releaseCandidate.releaseKind)) fail("unsupported signed release kind");
const frontendOnly = releaseCandidate.releaseKind === "frontend-only";
const bundleInspection = inspectBundleEntries(bundlePath);
if (!bundleInspection.ok) {
  fail("release bundle contents could not be inspected", {
    bundlePath,
    status: bundleInspection.status,
    error: bundleInspection.error
  });
}
const recoveryHelperInspection = inspectBundleEntrySha256(bundlePath, recoveryHelperEntry);
if (!recoveryHelperInspection.ok) {
  fail("release bundle recovery helper could not be inspected", {
    bundlePath,
    recoveryHelperEntry,
    status: recoveryHelperInspection.status,
    error: recoveryHelperInspection.error
  });
}
const releaseShellInspection = inspectBundleEntryBytes(bundlePath, RELEASE_SHELL_ENTRY);
if (!releaseShellInspection.ok) {
  fail("release bundle guarded shell could not be inspected", {
    bundlePath,
    releaseShellEntry: RELEASE_SHELL_ENTRY,
    status: releaseShellInspection.status,
    error: releaseShellInspection.error
  });
}
if (manifest.policyVersion !== RELEASE_BUNDLE_POLICY_VERSION) {
  fail("release bundle policy version mismatch", {
    bundlePath,
    expectedPolicyVersion: RELEASE_BUNDLE_POLICY_VERSION,
    manifestPolicyVersion: manifest.policyVersion || null
  });
}
if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION
  || manifest.signature?.algorithm !== RELEASE_SIGNATURE_ALGORITHM
  || manifest.signature?.keyId !== signatureVerification.keyId) {
  fail("release manifest signing metadata mismatch", {
    manifestVersion: manifest.manifestVersion ?? null,
    expectedManifestVersion: RELEASE_MANIFEST_VERSION,
    signatureAlgorithm: manifest.signature?.algorithm || null,
    expectedSignatureAlgorithm: RELEASE_SIGNATURE_ALGORITHM,
    manifestKeyId: manifest.signature?.keyId || null,
    trustedKeyId: signatureVerification.keyId
  });
}
if (!Array.isArray(manifest.sensitiveEntries) || manifest.sensitiveEntries.length > 0) {
  fail("release bundle manifest does not declare an empty sensitive entry set", {
    bundlePath,
    sensitiveEntries: Array.isArray(manifest.sensitiveEntries)
      ? manifest.sensitiveEntries.slice(0, 20)
      : null
  });
}
if (bundleInspection.sensitiveEntries.length > 0) {
  fail("release bundle contains sensitive entries", {
    bundlePath,
    sensitiveEntries: bundleInspection.sensitiveEntries.slice(0, 20)
  });
}
if (actualSha256 !== sidecarSha256 || actualSha256 !== manifest.sha256) {
  fail("release bundle sha256 mismatch", {
    bundlePath,
    actualSha256,
    sidecarSha256,
    manifestSha256: manifest.sha256 || null
  });
}
if (fs.statSync(bundlePath).size !== Number(manifest.bytes)) {
  fail("release bundle size mismatch", {
    bundlePath,
    actualBytes: fs.statSync(bundlePath).size,
    manifestBytes: manifest.bytes
  });
}
if (manifest.ok !== true) fail("release bundle manifest is not ok", { manifestPath });

let releaseWindowPreflight = { windowChecked: false, reason: frontendOnly ? "frontend-only-no-data-cutover" : "dry-run",
  readyToCutover: false, windowPreauthorized: false };
if (frontendOnly) {
  // The signer validates the exact frontend source authorization and no-action
  // scope. Now bind every archive member/byte to that same signed inventory.
  // The server still compares it with the retained authenticated baseline.
  try {
    const evidence = await require("./releaseArchiveSourceInventory.cjs").verifyArchiveSourceEvidence(bundlePath, manifest);
    if (evidence.status !== "authenticated-inventory-build-unavailable" || evidence.archiveSha256 !== actualSha256)
      fail("frontend source archive lacks complete authenticated inventory");
  } catch (error) { fail("frontend source archive verification failed", { reason: error.message }); }
} else {
  // Reject a closed window before the archive scan, local clone, or uploads.
  // This fresh advisory check does not replace any signed server-side gate.
  if (!dryRun) {
    try {
      const windowPreflight = require("./runReleaseWindowPreflight.cjs").runLiveReleaseWindowPreflight();
      if (!windowPreflight.ok) fail("release window unavailable before clone/upload", { windowPreflight });
      releaseWindowPreflight = { windowChecked: true, ...windowPreflight };
    } catch (error) { fail("release window preflight rejected before clone/upload", { reason: error.message }); }
    try {
      const { report } = require("./runReleaseArchivePreflight.cjs").runLiveArchivePreflight();
      if (!report.ok) fail("release archive preflight rejected before clone/upload", { archivePreflight: report });
    } catch (error) { fail("release archive preflight observation failed", { reason: error.message }); }
  }
  const localCloneVerifier = runCommand(process.execPath, [
    "scripts/verifyFastResultProductionClone.cjs",
    "--sqlite-path", path.join(rootDir, "server-data", "football.db"),
    "--require-receipt",
  ]);
  if (localCloneVerifier.status !== 0) {
    fail("local production-clone fast-result migration verification failed", {
      status: localCloneVerifier.status,
      stdoutTail: localCloneVerifier.stdout?.slice(-3000) || "",
      stderrTail: localCloneVerifier.stderr?.slice(-3000) || "",
      error: localCloneVerifier.error || null,
    });
  }
}
// End authenticated local routing; upload and server authorization remain below.
const recoveryHelperRotationContract = parseFixedRecoveryHelperRotationContract(
  releaseShellInspection.content
);

const newerWorkspaceFiles = collectFilesNewerThan(rootDir, fs.statSync(bundlePath).mtimeMs)
  .sort((a, b) => a.path.localeCompare(b.path));
if (newerWorkspaceFiles.length && !allowStaleBundle) {
  fail("release bundle is older than current workspace changes; rerun npm run release:bundle", {
    bundlePath,
    newerWorkspaceFileCount: newerWorkspaceFiles.length,
    newerWorkspaceFiles: newerWorkspaceFiles.slice(0, 30)
  });
}

const releaseRunId = actualSha256;
const expectedRecoveryHelperSha256 = recoveryHelperInspection.sha256;
const remotePreflightCommand = buildRemotePreflightCommand(
  expectedRecoveryHelperSha256,
  !frontendOnly && recoveryHelperRotationContract.ok === true
);
const remoteBundlePath = remoteJoin(remoteDir, `${actualSha256}.tgz`);
const remoteShaPath = remoteJoin(remoteDir, `${actualSha256}.sha256`);
const remoteManifestPath = remoteJoin(remoteDir, `${actualSha256}.manifest.json`);
const remoteSignaturePath = remoteJoin(remoteDir, `${actualSha256}.manifest.sig`);
const remoteReleaseLogPath = remoteJoin(remoteLogDir, `${releaseRunId}.log`);
const remoteReleaseStatusPath = remoteJoin(remoteStatusDir, `${releaseRunId}.status`);
const uploads = [
  { name: "bundle", localPath: bundlePath, remotePath: remoteBundlePath },
  { name: "sha256", localPath: shaPath, remotePath: remoteShaPath },
  { name: "manifest", localPath: manifestPath, remotePath: remoteManifestPath },
  { name: "manifest signature", localPath: signaturePath, remotePath: remoteSignaturePath }
];
const releaseCommand = [
  "set -euo pipefail",
  `chmod 0600 ${shellQuote(remoteBundlePath)} ${shellQuote(remoteShaPath)} ${shellQuote(remoteManifestPath)} ${shellQuote(remoteSignaturePath)}`,
  "set +e",
  `sudo -n ${shellQuote(remoteEntrypoint)} ${shellQuote(actualSha256)}`,
  "release_status=$?",
  "set -e",
  `tail -n 180 ${shellQuote(remoteReleaseLogPath)} 2>/dev/null || true`,
  "exit \"$release_status\""
].join("; ");
const sshArgs = [
  ...sshOptions,
  sshTarget,
  releaseCommand
];

const steps = [];
steps.push({
  name: "preflight",
  ok: true,
  bundlePath,
  shaPath,
  manifestPath,
  signaturePath,
  signingPublicKeyPath,
  signingKeyId: signatureVerification.keyId,
  bytes: fs.statSync(bundlePath).size,
  sha256: actualSha256,
  policyVersion: RELEASE_BUNDLE_POLICY_VERSION,
  inspectedEntries: bundleInspection.entries.length,
  sensitiveEntries: bundleInspection.sensitiveEntries,
  remoteBundlePath,
  remoteShaPath,
  remoteManifestPath,
  remoteSignaturePath,
  remoteEntrypoint,
  recoveryHelperEntry,
  remoteRecoveryHelperPath,
  expectedRecoveryHelperSha256,
  recoveryHelperRotationContract,
  remoteReleaseLogPath,
  remoteReleaseStatusPath,
  publicBaseUrl,
  sshServerAliveCountMax: serverAliveCountMax,
  sshHostKeyPin,
  dryRun,
  allowStaleBundle,
  workspaceFresh: newerWorkspaceFiles.length === 0,
  newerWorkspaceFileCount: newerWorkspaceFiles.length,
  newerWorkspaceFiles: newerWorkspaceFiles.slice(0, 30)
});

const remotePreflight = runCommand("ssh", [
  ...sshOptions,
  sshTarget,
  remotePreflightCommand
]);
const remotePreflightOutput = remotePreflight.stdout || "";
const remoteTrustedKeyId = remotePreflightOutput.match(/\bkeyId=([0-9a-f]{64})\b/)?.[1] || null;
const remoteTrustedKeyMatches = Boolean(remotePreflight.dryRun || remoteTrustedKeyId === signatureVerification.keyId);
const remoteRecoveryHelperSha256 = remotePreflightOutput.match(/\brecoveryHelperSha=([0-9a-f]{64})\b/)?.[1] || null;
const remoteRecoveryHelperMatches = Boolean(remotePreflight.dryRun || remoteRecoveryHelperSha256 === expectedRecoveryHelperSha256);
const remoteRecoveryHelperRotationRequired = Boolean(
  !remotePreflight.dryRun
  && remotePreflightOutput.includes("recoveryHelperRotationRequired=1")
);
const remoteRecoveryHelperAcceptable = Boolean(
  remotePreflight.dryRun
  || remoteRecoveryHelperMatches
  || (recoveryHelperRotationContract.ok === true && remoteRecoveryHelperRotationRequired)
);
steps.push({
  name: "remote release preflight",
  status: remotePreflight.status,
  dryRun: remotePreflight.dryRun || false,
  ok: remotePreflight.status === 0
    && (remotePreflight.dryRun || remotePreflightOutput.includes("preflight-ok"))
    && remoteTrustedKeyMatches
    && remoteRecoveryHelperAcceptable,
  command: remotePreflight.command,
  args: remotePreflight.args,
  remoteTrustedKeyId,
  localSigningKeyId: signatureVerification.keyId,
  remoteTrustedKeyMatches,
  remoteRecoveryHelperPath,
  remoteRecoveryHelperSha256,
  expectedRecoveryHelperSha256,
  remoteRecoveryHelperMatches,
  remoteRecoveryHelperRotationRequired,
  remoteRecoveryHelperAcceptable,
  recoveryHelperRotationContract,
  stdoutTail: remotePreflight.stdout?.slice(-2000) || "",
  stderrTail: remotePreflight.stderr?.slice(-2000) || "",
  error: remotePreflight.error || null
});
if (steps[steps.length - 1].ok !== true) {
  console.log(JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), steps }, null, 2));
  process.exit(1);
}

for (const artifact of uploads) {
  const uploadRuns = [];
  let upload = null;
  for (let attempt = 1; attempt <= uploadAttempts; attempt += 1) {
    upload = runCommand("scp", [
      ...scpOptions,
      artifact.localPath,
      `${sshTarget}:${artifact.remotePath}`
    ]);
    uploadRuns.push({
      attempt,
      status: upload.status,
      stderrTail: upload.stderr?.slice(-500) || "",
      error: upload.error || null
    });
    if (upload.status === 0 || upload.dryRun) break;
    if (attempt < uploadAttempts) sleepSync(uploadRetryDelayMs);
  }
  steps.push({
    name: `upload signed release ${artifact.name}`,
    status: upload.status,
    dryRun: upload.dryRun || false,
    ok: upload.status === 0,
    attempts: uploadRuns,
    command: upload.command,
    args: upload.args,
    remotePath: artifact.remotePath,
    stdoutTail: upload.stdout?.slice(-1000) || "",
    stderrTail: upload.stderr?.slice(-1000) || "",
    error: upload.error || null
  });
  if (upload.status !== 0) {
    console.log(JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), steps }, null, 2));
    process.exit(1);
  }
}

const release = runCommand("ssh", sshArgs);
const releaseStep = {
  name: "remote bundle release",
  status: release.status,
  dryRun: release.dryRun || false,
  ok: release.status === 0,
  command: release.command,
  args: release.args,
  stdoutTail: release.stdout?.slice(-3000) || "",
  stderrTail: release.stderr?.slice(-3000) || "",
  error: release.error || null
};
steps.push(releaseStep);

// A zero SSH exit is not enough for UI: both normal success and transport
// recovery must observe the exact accepted receipt/current index commitment.
if ((release.status !== 0 || frontendOnly) && !dryRun) {
  const remoteStatusCommand = [
    "set +e",
    "printf '%s\\n' '---status---'",
    `cat ${shellQuote(remoteReleaseStatusPath)} 2>/dev/null || true`,
    "printf '%s\\n' '---marker---'",
    "cat /opt/football-predict/.release-bundle-sha256 2>/dev/null || true",
    "printf '%s\\n' '---live-complete---'",
    "cat /opt/football-predict/.release-live-complete 2>/dev/null || true",
    "printf '%s\\n' '---frontend-identity---'",
    `/opt/node-v22.22.1/bin/node -e ${shellQuote("console.log(JSON.stringify(" + buildFrontendIdentityReaderSource() + ".readFrontendReleaseIdentity()))")}`,
    "printf '%s\\n' '---log-tail---'",
    `tail -n 220 ${shellQuote(remoteReleaseLogPath)} 2>/dev/null || true`,
    "printf '%s\\n' '---units---'",
    "systemctl is-active football-predict football-sync-worker football-cleanup.timer football-monitor.timer 2>/dev/null || true"
  ].join("; ");
  let remoteStatus = null;
  let remoteStatusKv = {};
  for (let attempt = 1; attempt <= recoveryAttempts; attempt += 1) {
    remoteStatus = runCommand("ssh", [
      ...sshOptions,
      sshTarget,
      remoteStatusCommand
    ]);
    const polledStatusText = extractSection(remoteStatus.stdout || "", "status", "marker");
    remoteStatusKv = parseKeyValue(polledStatusText);
    if (["complete", "failed"].includes(remoteStatusKv.status)) break;
    if (attempt < recoveryAttempts) sleepSync(recoveryRetryDelayMs);
  }
  const statusText = extractSection(remoteStatus.stdout || "", "status", "marker");
  const marker = extractSection(remoteStatus.stdout || "", "marker", "live-complete").split(/\s+/)[0] || "";
  const liveComplete = extractSection(remoteStatus.stdout || "", "live-complete", "frontend-identity").split(/\s+/)[0] || "";
  const frontendRelease = parseJson(extractSection(remoteStatus.stdout || "", "frontend-identity", "log-tail"));
  const logTail = extractSection(remoteStatus.stdout || "", "log-tail", "units");
  const units = extractSection(remoteStatus.stdout || "", "units");
  remoteStatusKv = parseKeyValue(statusText);
  const frontendAccepted = frontendOnly && frontendIdentityMatchesCandidate(frontendRelease, releaseCandidate);
  const markerMatches = marker === (frontendOnly ? frontendRelease?.runtimeSha256 : actualSha256);
  const liveCompleteMatches = liveComplete === (frontendOnly ? frontendRelease?.runtimeSha256 : actualSha256);
  const remoteStatusComplete = remoteStatus.status === 0
    && remoteStatusKv.status === "complete"
    && remoteStatusKv.ok === "1"
    && remoteStatusKv.exitCode === "0"
    && remoteStatusKv.bundleSha256 === actualSha256
    && Boolean(remoteStatusKv.finishedAt);
  const publicVerifySkipReason = frontendOnly ? null
    : !remoteStatusComplete ? "remote-status-not-complete-for-requested-bundle"
      : !markerMatches ? "bundle-marker-mismatch"
        : !liveCompleteMatches ? "live-complete-marker-mismatch" : null;
  // Only an already completed matching full release can be recovered after a
  // transport failure. Do not run business verification against an old release.
  const publicVerify = !frontendOnly && publicVerifySkipReason === null ? runCommand(process.execPath, ["scripts/verifyRemotePublicReadiness.cjs"], {
    env: {
      ...process.env,
      REMOTE_BASE_URL: publicBaseUrl,
      REMOTE_REQUIRE_HEALTHY: "0",
      REMOTE_REQUIRE_SQLITE: "1",
      REMOTE_REQUIRE_SYNC_WORKER: "1",
      REMOTE_SQLITE_READY_ATTEMPTS: process.env.REMOTE_SQLITE_READY_ATTEMPTS || "12",
      REMOTE_SQLITE_READY_RETRY_DELAY_MS: process.env.REMOTE_SQLITE_READY_RETRY_DELAY_MS || "5000"
    }
  }) : null;
  const publicPayload = parseJson(publicVerify?.stdout || "");
  const remotePublicOk = frontendOnly ? frontendAccepted && units.split(/\r?\n/).filter(Boolean).slice(0, 2).length === 2
    && units.split(/\r?\n/).filter(Boolean).slice(0, 2).every(state => state === "active") : publicVerify?.status === 0 && publicPayload?.ok === true;
  const recovered = remoteStatusComplete && markerMatches && liveCompleteMatches && remotePublicOk;
  releaseStep.ok = recovered;
  releaseStep.recovered = release.status !== 0 && recovered;
  steps.push({
    name: frontendOnly ? "remote frontend acceptance check" : "remote release recovery check",
    status: remoteStatus.status,
    ok: recovered,
    command: remoteStatus.command,
    args: remoteStatus.args,
    marker,
    markerMatches,
    liveComplete,
    liveCompleteMatches,
    remoteStatusComplete,
    remoteStatus: remoteStatusKv,
    remoteReleaseLogPath,
    remoteReleaseStatusPath,
    units: units.split(/\r?\n/).filter(Boolean),
    publicVerifyStatus: publicVerify?.status ?? null,
    ...(frontendOnly ? { frontendRelease, frontendAccepted, acceptanceSource: "exact-root-receipt-current-index", repeatedBusinessVerification: false } : {}),
    ...(!frontendOnly ? { publicVerifySkipped: publicVerify === null, publicVerifySkipReason } : {}),
    publicVerifyOk: publicPayload?.ok ?? null,
    publicCurrentReadSource: publicPayload?.summary?.currentReadSource || null,
    publicSqliteReady: publicPayload?.summary?.sqliteReady ?? null,
    logTail: logTail.slice(-3000),
    stdoutTail: remoteStatus.stdout?.slice(-3000) || "",
    stderrTail: remoteStatus.stderr?.slice(-2000) || "",
    publicVerifyTail: publicVerify?.stdout?.slice(-2000) || "",
    recoveryAttempts,
    recoveryRetryDelayMs,
    error: remoteStatus.error || publicVerify?.error || null
  });
}

if (releaseStep.ok === true) {
  const remoteRecoveryHelperPostcheckCommand = [
    "set -euo pipefail",
    `test -f ${shellQuote(remoteRecoveryHelperPath)} && test ! -L ${shellQuote(remoteRecoveryHelperPath)} || { echo "release-recovery-helper-postcheck-missing"; exit 30; }`,
    `test "$(stat -c '%F:%u:%g:%a:%h' ${shellQuote(remoteRecoveryHelperPath)})" = "regular file:0:0:644:1" || { echo "release-recovery-helper-postcheck-unsafe"; exit 30; }`,
    `test -x /opt/node-v22.22.1/bin/node && /opt/node-v22.22.1/bin/node --check ${shellQuote(remoteRecoveryHelperPath)} >/dev/null || { echo "release-recovery-helper-postcheck-invalid"; exit 30; }`,
    `postcheck_recovery_helper_sha="$(sha256sum ${shellQuote(remoteRecoveryHelperPath)} | awk '{print $1}')"`,
    "printf 'recoveryHelperPostcheckSha=%s\\n' \"$postcheck_recovery_helper_sha\"",
    `test "$postcheck_recovery_helper_sha" = ${shellQuote(expectedRecoveryHelperSha256)} || { echo "release-recovery-helper-postcheck-mismatch"; exit 31; }`,
    `postcheck_entrypoint="$(sudo -n ${shellQuote(remoteEntrypoint)} --check)" || { echo "release-entrypoint-postcheck-failed"; exit 32; }`,
    "printf '%s\\n' \"$postcheck_entrypoint\"",
    "case \"$postcheck_entrypoint\" in *\"recoveryPending=0\"*) ;; *) echo \"release-postcheck-recovery-pending\"; exit 32 ;; esac",
    "case \"$postcheck_entrypoint\" in *\"appPresent=1\"*) ;; *) echo \"release-postcheck-app-missing\"; exit 32 ;; esac",
    "echo recovery-helper-postcheck-ok"
  ].join("; ");
  const remoteRecoveryHelperPostcheck = runCommand("ssh", [
    ...sshOptions,
    sshTarget,
    remoteRecoveryHelperPostcheckCommand
  ]);
  const remoteRecoveryHelperPostcheckOutput = remoteRecoveryHelperPostcheck.stdout || "";
  const remoteRecoveryHelperPostcheckSha256 = remoteRecoveryHelperPostcheckOutput
    .match(/\brecoveryHelperPostcheckSha=([0-9a-f]{64})\b/)?.[1] || null;
  steps.push({
    name: "remote recovery helper postcheck",
    status: remoteRecoveryHelperPostcheck.status,
    dryRun: remoteRecoveryHelperPostcheck.dryRun || false,
    ok: remoteRecoveryHelperPostcheck.status === 0
      && (remoteRecoveryHelperPostcheck.dryRun
        || remoteRecoveryHelperPostcheckOutput.includes("recovery-helper-postcheck-ok"))
      && (remoteRecoveryHelperPostcheck.dryRun
        || remoteRecoveryHelperPostcheckSha256 === expectedRecoveryHelperSha256),
    command: remoteRecoveryHelperPostcheck.command,
    args: remoteRecoveryHelperPostcheck.args,
    remoteRecoveryHelperPath,
    remoteRecoveryHelperPostcheckSha256,
    expectedRecoveryHelperSha256,
    stdoutTail: remoteRecoveryHelperPostcheck.stdout?.slice(-2000) || "",
    stderrTail: remoteRecoveryHelperPostcheck.stderr?.slice(-2000) || "",
    error: remoteRecoveryHelperPostcheck.error || null
  });
}

const ok = steps.every((step) => step.ok);
console.log(JSON.stringify({
  ok,
  releaseWindowPreflight,
  checkedAt: new Date().toISOString(),
  host,
  user,
  remoteDir,
  publicBaseUrl,
  dryRun,
  steps
}, null, 2));
if (!ok) process.exit(1);
}
deploySelectedBundle().catch(error => fail("release deployment failed", { reason: error.message || String(error) }));
