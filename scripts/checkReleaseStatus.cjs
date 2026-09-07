const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { revisionTransitionReportValid } = require("./candidateReleaseContinuity.cjs");
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

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const host = process.env.RELEASE_STATUS_HOST || process.env.RELEASE_DEPLOY_HOST || "134.175.132.183";
const user = process.env.RELEASE_STATUS_USER || process.env.RELEASE_DEPLOY_USER || "ubuntu";
const sshPort = Number(process.env.RELEASE_STATUS_PORT || process.env.RELEASE_DEPLOY_PORT || 22);
const keyPath = path.resolve(process.env.RELEASE_STATUS_KEY || process.env.RELEASE_DEPLOY_KEY || path.join(tmpDir, "football.pem"));
const publicBaseUrl = new URL(process.env.RELEASE_STATUS_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.REMOTE_BASE_URL || `https://${host}`);
const strict = process.env.RELEASE_STATUS_STRICT === "1";
const sshBannerTimeoutMs = Math.max(2000, Number(process.env.RELEASE_STATUS_SSH_BANNER_TIMEOUT_MS || 8000));
const sshAttempts = Math.max(1, Number(process.env.RELEASE_STATUS_SSH_ATTEMPTS || 4));
const sshRetryDelayMs = Math.max(250, Number(process.env.RELEASE_STATUS_SSH_RETRY_DELAY_MS || 1500));
const httpAttempts = Math.max(1, Number(process.env.RELEASE_STATUS_HTTP_ATTEMPTS || 4));
const httpRetryDelayMs = Math.max(100, Number(process.env.RELEASE_STATUS_HTTP_RETRY_DELAY_MS || 500));
const signingPublicKeyPath = resolvePublicKeyPath();
const recoveryHelperEntry = "deploy/light-server/football-release-recovery.cjs";
const remoteRecoveryHelperPath = "/usr/local/libexec/football-release-recovery.cjs";

let sshHostKeyPin = null;
let sshHostKeyPinError = null;
let sshBaseOptions = [];
try {
  sshHostKeyPin = resolveReleaseSshHostKeyPin({
    rootDir,
    tmpDir,
    host,
    port: sshPort,
    statusMode: true
  });
  sshBaseOptions = buildPinnedSshBaseOptions({
    keyPath,
    pin: sshHostKeyPin,
    serverAliveCountMax: 1
  });
} catch (error) {
  sshHostKeyPinError = error.message || String(error);
}
const statusSshOptions = ["-p", String(sshPort), ...sshBaseOptions];

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
const sleepSync = (delayMs) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
};

const requestJsonOnce = (pathname) => {
  const target = new URL(pathname, publicBaseUrl);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(target, { method: "GET", timeout: 12000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        resolve({
          status: res.statusCode,
          body,
          bytes: Buffer.byteLength(raw),
          error: null
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (error) => {
      resolve({ status: 0, body: null, bytes: 0, error: error.message || String(error) });
    });
    req.end();
  });
};

const requestJson = async (pathname) => {
  const attempts = [];
  let result = null;
  for (let attempt = 1; attempt <= httpAttempts; attempt += 1) {
    result = await requestJsonOnce(pathname);
    attempts.push({
      attempt,
      status: result.status,
      error: result.error || null
    });
    if (result.status !== 0) break;
    if (attempt < httpAttempts) await sleep(httpRetryDelayMs);
  }
  return {
    ...result,
    attempts
  };
};

const latestBundlePath = () => {
  if (process.env.RELEASE_BUNDLE_PATH) return path.resolve(process.env.RELEASE_BUNDLE_PATH);
  if (!fs.existsSync(tmpDir)) return "";
  const candidates = fs.readdirSync(tmpDir)
    .filter((name) => /^football-release-.+\.tgz$/.test(name))
    .map((name) => {
      const filePath = path.join(tmpDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || "";
};

const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const readSha = (filePath) => fs.readFileSync(filePath, "utf8").trim().split(/\s+/)[0]?.toLowerCase() || "";
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
    bytes,
    sha256: result.status === 0 && bytes.length > 0
      ? crypto.createHash("sha256").update(bytes).digest("hex")
      : null,
    error: result.error?.message || (result.status === 0 ? null : String(result.stderr || "").slice(-1000))
  };
};
const inspectBundleEntrySha256 = (filePath, entry) => {
  const inspection = inspectBundleEntryBytes(filePath, entry);
  return {
    ...inspection,
    bytes: inspection.bytes.length
  };
};

const ignoredFreshnessDirs = new Set([
  ".git",
  ".codex",
  ".agents",
  ".codex-tmp",
  "node_modules",
  "dist",
  "server-data",
  "logs",
  "coverage",
  ".vite"
]);
const ignoredFreshnessPathPatterns = [
  /^public\/data\/[^/]+\.json$/,
  /^public\/matches\.json$/,
  /^public\/odds-history\.json$/
];

const isIgnoredFreshnessPath = (relativePath) => (
  ignoredFreshnessPathPatterns.some((pattern) => pattern.test(relativePath))
);

const collectFilesNewerThan = (dir, cutoffMs, root = dir, rows = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    const firstSegment = relativePath.split("/")[0];
    if (entry.isDirectory()) {
      if (ignoredFreshnessDirs.has(entry.name) || ignoredFreshnessDirs.has(firstSegment)) continue;
      collectFilesNewerThan(filePath, cutoffMs, root, rows);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".log")) continue;
    if (isIgnoredFreshnessPath(relativePath)) continue;
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs > cutoffMs + 1000) {
      rows.push({
        path: relativePath,
        mtime: new Date(stat.mtimeMs).toISOString()
      });
    }
  }
  return rows;
};

const checkBundle = () => {
  const bundlePath = latestBundlePath();
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    return { ok: false, exists: false, reason: "bundle not found", bundlePath: bundlePath || null };
  }
  const shaPath = `${bundlePath}.sha256`;
  const manifestPath = `${bundlePath}.manifest.json`;
  const signaturePath = `${bundlePath}.manifest.sig`;
  const missingSidecars = [shaPath, manifestPath, signaturePath, signingPublicKeyPath]
    .filter((filePath) => !fs.existsSync(filePath));
  if (missingSidecars.length) {
    return {
      ok: false,
      exists: true,
      bundlePath,
      missingSidecars
    };
  }

  let manifest = null;
  let signatureVerification = null;
  try {
    signatureVerification = verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath: signingPublicKeyPath });
    manifest = signatureVerification.manifest;
  } catch (error) {
    return {
      ok: false,
      exists: true,
      bundlePath,
      reason: `signed manifest verification failed: ${error.message || String(error)}`
    };
  }

  const actualSha256 = sha256File(bundlePath);
  const declaredSha256 = readSha(shaPath);
  const bytes = fs.statSync(bundlePath).size;
  const bundleInspection = inspectBundleEntries(bundlePath);
  const recoveryHelperInspection = inspectBundleEntrySha256(bundlePath, recoveryHelperEntry);
  const releaseShellInspection = inspectBundleEntryBytes(bundlePath, RELEASE_SHELL_ENTRY);
  const recoveryHelperRotationContract = releaseShellInspection.ok
    ? parseFixedRecoveryHelperRotationContract(releaseShellInspection.bytes)
    : { ok: false, reason: releaseShellInspection.error || "release-shell-inspection-failed" };
  const bundleStat = fs.statSync(bundlePath);
  const newerWorkspaceFiles = collectFilesNewerThan(rootDir, bundleStat.mtimeMs)
    .sort((a, b) => a.path.localeCompare(b.path));
  const workspaceFresh = newerWorkspaceFiles.length === 0;
  const manifestSensitiveEntriesValid = Array.isArray(manifest.sensitiveEntries)
    && manifest.sensitiveEntries.length === 0;
  const policyValid = manifest.policyVersion === RELEASE_BUNDLE_POLICY_VERSION;
  const signatureValid = manifest.manifestVersion === RELEASE_MANIFEST_VERSION
    && manifest.signature?.algorithm === RELEASE_SIGNATURE_ALGORITHM
    && manifest.signature?.keyId === signatureVerification.keyId;
  const sensitiveEntriesValid = bundleInspection.ok
    && bundleInspection.sensitiveEntries.length === 0;
  const ok = manifest.ok === true
    && policyValid
    && signatureValid
    && manifestSensitiveEntriesValid
    && sensitiveEntriesValid
    && recoveryHelperInspection.ok
    && releaseShellInspection.ok
    && actualSha256 === declaredSha256
    && actualSha256 === manifest.sha256
    && bytes === Number(manifest.bytes)
    && workspaceFresh;

  return {
    ok,
    exists: true,
    bundle: path.basename(bundlePath),
    bundlePath,
    shaPath,
    manifestPath,
    signaturePath,
    signingPublicKeyPath,
    signingKeyId: signatureVerification.keyId,
    bytes,
    actualSha256,
    localCandidateSha256: actualSha256,
    declaredSha256,
    manifestSha256: manifest.sha256 || null,
    manifestBytes: manifest.bytes ?? null,
    manifestOk: manifest.ok === true,
    expectedPolicyVersion: RELEASE_BUNDLE_POLICY_VERSION,
    manifestPolicyVersion: manifest.policyVersion || null,
    policyValid,
    signatureValid,
    bundleInspectionOk: bundleInspection.ok,
    bundleInspectionStatus: bundleInspection.status,
    bundleInspectionError: bundleInspection.error,
    inspectedEntries: bundleInspection.entries.length,
    manifestSensitiveEntries: Array.isArray(manifest.sensitiveEntries)
      ? manifest.sensitiveEntries.slice(0, 20)
      : null,
    manifestSensitiveEntriesValid,
    sensitiveEntries: bundleInspection.sensitiveEntries.slice(0, 20),
    sensitiveEntriesValid,
    recoveryHelperEntry,
    recoveryHelperSha256: recoveryHelperInspection.sha256,
    recoveryHelperInspectionOk: recoveryHelperInspection.ok,
    recoveryHelperInspectionError: recoveryHelperInspection.error,
    recoveryHelperRotationContract,
    entries: manifest.entries ?? null,
    createdAt: manifest.createdAt || null,
    workspaceFresh,
    newerWorkspaceFiles: newerWorkspaceFiles.slice(0, 30),
    newerWorkspaceFileCount: newerWorkspaceFiles.length
  };
};

const extractSection = (text, name, nextName = null) => {
  const startToken = `---${name}---`;
  const source = String(text || "");
  const start = source.indexOf(startToken);
  if (start < 0) return "";
  const bodyStart = start + startToken.length;
  const end = nextName ? source.indexOf(`---${nextName}---`, bodyStart) : -1;
  return source.slice(bodyStart, end >= 0 ? end : undefined).trim();
};

const parseJsonSection = (value) => {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
};

const runPinnedSsh = (command, { timeout = 35000, maxBuffer = 1024 * 1024 } = {}) => {
  const args = [
    ...statusSshOptions,
    `${user}@${host}`,
    command
  ];
  const attempts = [];
  let result = null;
  for (let attempt = 1; attempt <= sshAttempts; attempt += 1) {
    result = spawnSync("ssh", args, {
      cwd: rootDir,
      encoding: "utf8",
      timeout,
      maxBuffer
    });
    attempts.push({
      attempt,
      status: result.status,
      stderrTail: (result.stderr || "").slice(-500),
      error: result.error?.message || null
    });
    if (result.status === 0) break;
    if (attempt < sshAttempts) sleepSync(sshRetryDelayMs);
  }
  return { args, result, attempts };
};

const checkSsh = () => {
  if (sshHostKeyPinError) {
    return {
      ok: false,
      keyExists: fs.existsSync(keyPath),
      keyPath,
      hostKeyPin: null,
      reason: `ssh host-key pin invalid: ${sshHostKeyPinError}`
    };
  }
  if (!fs.existsSync(keyPath)) {
    return { ok: false, keyExists: false, keyPath, hostKeyPin: sshHostKeyPin, reason: "ssh key not found" };
  }
  const preflightCommand = [
    "set -euo pipefail",
    "test -x /usr/local/sbin/football-release || { echo \"release-entrypoint-missing\"; exit 20; }",
    "test -d /var/lib/football-release/incoming && test -w /var/lib/football-release/incoming || { echo \"release-incoming-not-writable\"; exit 21; }",
    "entrypoint_check=\"$(sudo -n /usr/local/sbin/football-release --check)\" || { echo \"release-entrypoint-check-failed\"; exit 22; }",
    "printf '%s\\n' \"$entrypoint_check\"",
    "case \"$entrypoint_check\" in *\"recoveryPending=0\"*) ;; *) echo \"release-recovery-pending\"; exit 24 ;; esac",
    "test -d /opt/football-predict || { echo \"app-dir-missing\"; exit 23; }",
    "systemctl is-active football-predict >/dev/null || { echo \"service-inactive\"; exit 23; }",
    "echo preflight-ok"
  ].join("; ");
  const command = [
    "set +e",
    "printf '%s\\n' '---date---'",
    "date -Is",
    "printf '%s\\n' '---marker---'",
    "cat /opt/football-predict/.release-bundle-sha256 2>/dev/null || true",
    "printf '%s\\n' '---live-complete---'",
    "cat /opt/football-predict/.release-live-complete 2>/dev/null || true",
    "printf '%s\\n' '---candidate-continuity---'",
    "cat /opt/football-predict/.release-candidate-continuity.json 2>/dev/null || true",
    "printf '%s\\n' '---recovery-helper---'",
    `sha256sum ${remoteRecoveryHelperPath} 2>/dev/null || true`,
    "printf '%s\\n' '---preflight---'",
    `(${preflightCommand})`,
    "preflight_status=$?",
    "printf '%s\\n' '---preflight-exit---'",
    "printf '%s\\n' \"$preflight_status\"",
    "exit 0"
  ].join("; ");
  const run = runPinnedSsh(command, { timeout: 45000 });
  const result = run.result;
  const date = extractSection(result.stdout, "date", "marker").split(/\r?\n/)[0] || "";
  const markerSha256 = extractSection(result.stdout, "marker", "live-complete").split(/\s+/)[0] || null;
  const liveCompleteSha256 = extractSection(result.stdout, "live-complete", "candidate-continuity").split(/\s+/)[0] || null;
  const candidateContinuity = parseJsonSection(extractSection(result.stdout, "candidate-continuity", "recovery-helper"));
  const recoveryHelperSha256 = extractSection(result.stdout, "recovery-helper", "preflight").split(/\s+/)[0]?.toLowerCase() || null;
  const preflightOutput = extractSection(result.stdout, "preflight", "preflight-exit");
  const preflightExit = Number(extractSection(result.stdout, "preflight-exit").split(/\s+/)[0]);
  return {
    ok: result.status === 0 && Boolean(date),
    keyExists: true,
    keyPath,
    hostKeyPin: sshHostKeyPin,
    status: result.status,
    stdout: date,
    stderrTail: (result.stderr || "").slice(-1000),
    error: result.error?.message || null,
    attempts: run.attempts,
    aggregate: {
      version: "release-status-ssh-aggregate-v3",
      markerSha256,
      liveCompleteSha256,
      candidateContinuity,
      recoveryHelperSha256,
      preflightExit: Number.isFinite(preflightExit) ? preflightExit : null,
      preflightOk: preflightExit === 0 && preflightOutput.includes("preflight-ok"),
      preflightOutput
    }
  };
};

const checkSshBanner = () => new Promise((resolve) => {
  const startedAt = Date.now();
  let settled = false;
  let connected = false;
  let banner = "";
  const socket = net.createConnection({ host, port: sshPort });

  const done = (result) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve({
      host,
      port: sshPort,
      timeoutMs: sshBannerTimeoutMs,
      elapsedMs: Date.now() - startedAt,
      connected,
      bannerReceived: Boolean(banner),
      banner: banner.slice(0, 120),
      ...result
    });
  };

  socket.setTimeout(sshBannerTimeoutMs);
  socket.on("connect", () => {
    connected = true;
  });
  socket.on("data", (chunk) => {
    banner += chunk.toString("utf8");
    if (banner.includes("\n") || banner.length >= 32) {
      done({ ok: /^SSH-/i.test(banner), reason: /^SSH-/i.test(banner) ? "ssh-banner-received" : "non-ssh-banner" });
    }
  });
  socket.on("timeout", () => {
    done({ ok: false, reason: connected ? "tcp-open-no-ssh-banner" : "tcp-connect-timeout" });
  });
  socket.on("error", (error) => {
    done({ ok: false, reason: "tcp-error", error: error.message || String(error) });
  });
  socket.on("close", () => {
    done({ ok: false, reason: connected ? "tcp-closed-before-ssh-banner" : "tcp-closed-before-connect" });
  });
});

const checkRemoteReleaseMarker = (ssh) => {
  if (!ssh.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "ssh is not reachable"
    };
  }
  const markerSha256 = ssh.aggregate?.markerSha256 || null;
  const liveCompleteSha256 = ssh.aggregate?.liveCompleteSha256 || null;
  const committed = /^[0-9a-f]{64}$/.test(String(markerSha256 || ""))
    && markerSha256 === liveCompleteSha256;
  return {
    ok: committed,
    skipped: false,
    status: ssh.status,
    markerSha256,
    liveCompleteSha256,
    committed,
    stdoutTail: markerSha256 || "",
    stderrTail: "",
    error: null,
    evidenceSource: ssh.aggregate?.version || null
  };
};

const checkRemotePreflight = (ssh) => {
  if (!ssh.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "ssh is not reachable"
    };
  }
  const preflightOutput = ssh.aggregate?.preflightOutput || "";
  const preflightOk = ssh.aggregate?.preflightOk === true;
  return {
    ok: preflightOk,
    skipped: false,
    status: ssh.aggregate?.preflightExit ?? null,
    stdoutTail: preflightOutput.slice(-2000),
    stderrTail: "",
    error: null,
    evidenceSource: ssh.aggregate?.version || null
  };
};

const checkRemoteRecoveryHelper = (ssh, expectedSha256, rotationContract) => {
  if (!ssh.ok || !/^[0-9a-f]{64}$/.test(String(expectedSha256 || ""))) {
    return {
      ok: false,
      skipped: true,
      expectedSha256: expectedSha256 || null,
      reason: ssh.ok ? "candidate recovery helper hash is unavailable" : "ssh is not reachable"
    };
  }
  const actualSha256 = ssh.aggregate?.recoveryHelperSha256 || null;
  const matchesCandidate = actualSha256 === expectedSha256;
  const rotationRequired = !matchesCandidate && rotationContract?.ok === true;
  return {
    ok: matchesCandidate,
    acceptableForDeploy: matchesCandidate || rotationRequired,
    rotationRequired,
    rotationContract: rotationContract || null,
    skipped: false,
    status: ssh.status,
    path: remoteRecoveryHelperPath,
    expectedSha256,
    actualSha256,
    matchesCandidate,
    stderrTail: "",
    error: null,
    evidenceSource: ssh.aggregate?.version || null
  };
};

const checkRemoteCandidateContinuity = (ssh, remoteRelease) => {
  if (!ssh.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "ssh is not reachable"
    };
  }
  const report = ssh.aggregate?.candidateContinuity || null;
  const blockers = Array.isArray(report?.blockers) ? report.blockers : null;
  const releaseBundleSha256 = String(report?.releaseIdentity?.bundleSha256 || "").toLowerCase();
  const releaseSequence = Number(report?.releaseIdentity?.releaseSequence);
  const releaseIdentityValid = /^[0-9a-f]{64}$/.test(releaseBundleSha256)
    && Number.isSafeInteger(releaseSequence)
    && releaseSequence > 0
    && releaseBundleSha256 === remoteRelease?.markerSha256
    && releaseBundleSha256 === remoteRelease?.liveCompleteSha256;
  const identityStable = Boolean(
    report?.before?.activeLedgerId
    && report.before.activeLedgerId === report?.after?.activeLedgerId
    && report?.before?.candidateRevisionId
    && report.before.candidateRevisionId === report?.after?.candidateRevisionId
  );
  const chainValid = report?.before?.chainValid === true && report?.after?.chainValid === true;
  const declaredTransitionValid = revisionTransitionReportValid(report);
  const continuityAfter = declaredTransitionValid ? report.continuedLedger : report?.after;
  const rootHashesValid = /^[0-9a-f]{64}$/.test(String(report?.before?.rootHash || ""))
    && /^[0-9a-f]{64}$/.test(String(continuityAfter?.rootHash || ""));
  const eventCountsValid = Number.isSafeInteger(Number(report?.before?.eventCount))
    && Number.isSafeInteger(Number(continuityAfter?.eventCount))
    && Number(continuityAfter.eventCount) >= Number(report.before.eventCount)
    && Number(report?.eventsAdded) === Number(continuityAfter.eventCount) - Number(report.before.eventCount);
  const countsValid = ["admitted", "atomic", "settled", "formal", "finalized"].every((field) => (
    Number.isSafeInteger(Number(report?.before?.counts?.[field]))
    && Number.isSafeInteger(Number(continuityAfter?.counts?.[field]))
    && Number(continuityAfter.counts[field]) >= Number(report.before.counts[field])
  ));
  const checkedAtValid = Number.isFinite(Date.parse(report?.checkedAt || ""));
  const ok = report?.version === "candidate-release-continuity-verification-v1"
    && report?.ok === true
    && blockers?.length === 0
    && (identityStable || declaredTransitionValid)
    && chainValid
    && rootHashesValid
    && eventCountsValid
    && countsValid
    && checkedAtValid
    && releaseIdentityValid
    && remoteRelease?.committed === true;
  return {
    ok,
    skipped: false,
    version: report?.version || null,
    checkedAt: report?.checkedAt || null,
    blockers,
    identityStable,
    declaredTransitionValid,
    chainValid,
    rootHashesValid,
    eventCountsValid,
    countsValid,
    checkedAtValid,
    releaseIdentityValid,
    releaseBundleSha256: releaseBundleSha256 || null,
    releaseSequence: Number.isSafeInteger(releaseSequence) ? releaseSequence : null,
    eventsAdded: Number.isInteger(report?.eventsAdded) ? report.eventsAdded : null,
    activeLedgerId: report?.after?.activeLedgerId || null,
    candidateRevisionId: report?.after?.candidateRevisionId || null,
    beforeRootHash: report?.before?.rootHash || null,
    afterRootHash: continuityAfter?.rootHash || null,
    activeLedgerRootHash: report?.after?.rootHash || null,
    evidenceSource: ssh.aggregate?.version || null
  };
};

const run = async () => {
  const bundle = checkBundle();
  const sshBanner = await checkSshBanner();
  const ssh = checkSsh();
  const remoteRelease = checkRemoteReleaseMarker(ssh);
  const remotePreflight = checkRemotePreflight(ssh);
  const remoteRecoveryHelper = checkRemoteRecoveryHelper(
    ssh,
    bundle.recoveryHelperSha256,
    bundle.recoveryHelperRotationContract,
  );
  const remoteCandidateContinuity = checkRemoteCandidateContinuity(ssh, remoteRelease);
  const health = await requestJson("/api/v1/health");
  const sourceHealth = await requestJson("/api/v1/source-health");

  const sqlite = health.body?.storage?.sqlite || {};
  const postgres = health.body?.storage?.postgres || {};
  const currentRead = health.body?.data?.currentRead || health.body?.currentRead || {};
  const protectedChecks = await Promise.all([
    requestJson("/api/v1/matches/current?view=list"),
    requestJson("/api/v1/matches/history?limit=1"),
    requestJson("/api/v1/odds/history?limit=1")
  ]);
  const protectedStatic = await Promise.all([
    requestJson("/matches.json"),
    requestJson("/odds-history.json"),
    requestJson("/data/matches-history.json"),
    requestJson("/data/odds-history.json")
  ]);
  const protectedStaticDisabled = protectedStatic.every((result) => [401, 403, 404, 410].includes(Number(result.status)));
  const anonymousDenied = protectedChecks.every((result) => Number(result.status) === 401);
  const publicReachable = health.status === 200 && health.body?.apiVersion === "v1";
  const sqliteReady = sqlite.available === true && (currentRead.source === "sqlite" || sqlite.readSource === "sqlite");
  const postgresReady = postgres.available === true
    && postgres.baseReady !== false
    && !postgres.baseBlockedReason
    && currentRead.source === "postgres";
  const primaryStoreReady = sqliteReady || postgresReady;

  const canAttemptDeploy = bundle.ok
    && ssh.ok
    && remotePreflight.ok
    && remoteRecoveryHelper.acceptableForDeploy === true;
  const liveComplete = publicReachable
    && primaryStoreReady
    && anonymousDenied
    && protectedStaticDisabled
    && ssh.ok
    && remotePreflight.ok
    && remoteRecoveryHelper.ok
    && remoteRelease.committed
    && remoteCandidateContinuity.ok;
  const blockers = [];
  if (!bundle.ok) blockers.push(bundle.workspaceFresh === false
    ? "release bundle is older than current workspace changes"
    : "local release bundle is not valid");
  if (!ssh.ok) {
    blockers.push(ssh.reason?.startsWith("ssh host-key pin invalid:")
      ? ssh.reason
      : (sshBanner.connected
        ? `ssh authentication is not available (${ssh.reason || sshBanner.reason})`
        : `ssh is not reachable (${ssh.reason || sshBanner.reason})`));
  }
  if (ssh.ok && !remotePreflight.ok) blockers.push("remote release preflight failed");
  if (ssh.ok && remoteRecoveryHelper.acceptableForDeploy !== true) {
    blockers.push("remote cold-recovery helper does not match the candidate bundle and no signed rotation contract is available");
  }
  if (ssh.ok && !remoteCandidateContinuity.ok) blockers.push("remote candidate release continuity proof is missing or invalid");
  if (!remoteRelease.committed) blockers.push("remote release completion marker is missing or does not match the bundle marker");
  if (bundle.ok && remoteRelease.ok && remoteRelease.markerSha256 !== bundle.actualSha256) {
    blockers.push("remote release marker does not match local candidate bundle");
  }
  if (!publicReachable) blockers.push("public /api/v1/health is not reachable");
  if (!primaryStoreReady) blockers.push("public origin has no ready configured primary store");
  if (!anonymousDenied) blockers.push("protected v1 reads do not deny anonymous access");
  if (!protectedStaticDisabled) blockers.push("protected static payloads are still exposed");

  const payload = {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    host,
    user,
    publicBaseUrl: publicBaseUrl.origin,
    sshHostKeyPin,
    sshHostKeyPinError,
    canAttemptDeploy,
    liveComplete,
    blockers,
    bundle,
    sshBanner,
    ssh,
    remoteRelease: {
      ...remoteRelease,
      matchesLocalCandidate: Boolean(
        bundle.actualSha256
        && remoteRelease.markerSha256 === bundle.actualSha256
      )
    },
    remotePreflight,
    remoteRecoveryHelper,
    remoteCandidateContinuity,
    public: {
      health: {
        status: health.status,
        ok: health.body?.ok ?? null,
        apiVersion: health.body?.apiVersion || null,
        serviceOk: health.body?.status?.serviceOk ?? null,
        dataFresh: health.body?.status?.dataFresh ?? null,
        recommendationReliable: health.body?.status?.recommendationReliable ?? null,
        checkedAt: health.body?.checkedAt || null,
        error: health.error || null
      },
      sqlite: {
        ready: sqliteReady,
        available: sqlite.available ?? null,
        reason: sqlite.reason || null,
        path: sqlite.path || null,
        counts: sqlite.counts || null,
        readSource: currentRead.source || sqlite.readSource || null
      },
      postgres: {
        ready: postgresReady,
        available: postgres.available ?? null,
        baseReady: postgres.baseReady ?? null,
        baseBlockedReason: postgres.baseBlockedReason || null,
        counts: postgres.counts || null,
        readSource: currentRead.source || postgres.readSource || null
      },
      sourceHealth: {
        status: sourceHealth.status,
        ok: sourceHealth.body?.ok ?? null,
        errors: sourceHealth.body?.errors || [],
        sourceIds: Array.isArray(sourceHealth.body?.sources)
          ? sourceHealth.body.sources.map((source) => source.id).filter(Boolean)
          : []
      },
      anonymousDenied,
      protectedStatuses: protectedChecks.map((result) => result.status),
      protectedStaticDisabled,
      protectedStaticStatuses: protectedStatic.map((result) => result.status)
    }
  };

  console.log(JSON.stringify(payload, null, 2));
  if (strict && !payload.ok) process.exit(1);
};

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: new Date().toISOString(),
    error: error.message || String(error)
  }, null, 2));
  if (strict) process.exit(1);
});
