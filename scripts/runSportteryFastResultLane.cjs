const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  acquireInstanceLock,
  cleanupFiles,
  compactFingerprint,
  computeFailureBackoffMs,
  computeDelayFromCompletion,
  createFastUploadSnapshot,
  fastLanePublishDecision,
  finiteNumber,
  postSnapshot,
  postSnapshotOverSsh,
  readJsonSafe,
  resultFingerprint,
  resultPageOneEndpoint,
  rootDir,
  runCollector,
  safeFailure,
  writeJsonAtomic
} = require("./sportteryFastResultLane.cjs");
const {
  run: syncCloudflareSportteryEvidence,
} = require("./syncCloudflareSportteryEvidence.cjs");

const argv = new Set(process.argv.slice(2));
const watchMode = argv.has("--watch");
const onceMode = argv.has("--once") || !watchMode;
const maxCyclesArg = process.argv.find((arg) => arg.startsWith("--max-cycles="));
const maxCycles = maxCyclesArg
  ? finiteNumber(maxCyclesArg.split("=")[1], 1, { min: 1, max: 1_000_000, integer: true })
  : Infinity;
const testMode = process.env.SPORTTERY_FAST_RESULT_TEST_MODE === "1";
const minimumIntervalSeconds = testMode ? 0.05 : 10;
const intervalSeconds = finiteNumber(process.env.SPORTTERY_FAST_RESULT_INTERVAL_SECONDS, 15, {
  min: minimumIntervalSeconds,
  max: testMode ? 60 : 300
});
const intervalMs = Math.round(intervalSeconds * 1000);
const currentHeartbeatSeconds = finiteNumber(process.env.SPORTTERY_FAST_CURRENT_HEARTBEAT_SECONDS, 60, {
  min: testMode ? 0.05 : 30,
  max: testMode ? 60 : 15 * 60
});
const currentHeartbeatMs = Math.round(currentHeartbeatSeconds * 1000);
const baseBackoffSeconds = finiteNumber(process.env.SPORTTERY_FAST_RESULT_BACKOFF_BASE_SECONDS, 30, {
  min: testMode ? 1 : 10,
  max: 60 * 60
});
const baseBackoffMs = Math.round(baseBackoffSeconds * 1000);
const maxBackoffSeconds = finiteNumber(process.env.SPORTTERY_FAST_RESULT_BACKOFF_MAX_SECONDS, 300, {
  min: baseBackoffSeconds,
  max: 24 * 60 * 60
});
const maxBackoffMs = Math.round(maxBackoffSeconds * 1000);
const wafBackoffMaxSeconds = finiteNumber(
  process.env.SPORTTERY_FAST_RESULT_WAF_BACKOFF_MAX_SECONDS,
  30 * 60,
  {
    min: maxBackoffSeconds,
    max: 24 * 60 * 60
  }
);
const wafBackoffMaxMs = Math.round(wafBackoffMaxSeconds * 1000);
const absoluteBackoffMaxMs = Math.max(maxBackoffMs, wafBackoffMaxMs);
// Direct official access can fail fast with WAF 403 and then hand off to the
// audited Edge transport. Give that bounded fallback enough wall-clock room to
// finish and report its authoritative status instead of killing the collector
// at the old 45 s direct+browser boundary.
const collectorTimeoutSeconds = finiteNumber(process.env.SPORTTERY_FAST_RESULT_COLLECT_TIMEOUT_SECONDS, 75, {
  min: testMode ? 1 : 5,
  max: 5 * 60
});
const collectorTimeoutMs = Math.round(collectorTimeoutSeconds * 1000);
const uploadTimeoutSeconds = finiteNumber(process.env.SPORTTERY_FAST_RESULT_UPLOAD_TIMEOUT_SECONDS, 30, {
  min: testMode ? 1 : 5,
  max: 5 * 60
});
const uploadTimeoutMs = Math.round(uploadTimeoutSeconds * 1000);
const heartbeatCycles = finiteNumber(process.env.SPORTTERY_FAST_RESULT_LOG_EVERY_CYCLES, 40, {
  min: 1,
  max: 100_000,
  integer: true
});
const statePath = path.resolve(
  rootDir,
  process.env.SPORTTERY_FAST_RESULT_STATE_PATH || path.join("logs", "sporttery-fast-result-state.json")
);
const snapshotPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_FAST_RESULT_SNAPSHOT_PATH || path.join(".codex-tmp", "sporttery-fast-result-snapshot.json")
);
const lockDir = path.resolve(
  rootDir,
  process.env.SPORTTERY_FAST_RESULT_LOCK_DIR || path.join("logs", "sporttery-fast-result.lock.d")
);
const collectorScript = path.resolve(
  rootDir,
  process.env.SPORTTERY_FAST_RESULT_COLLECTOR_SCRIPT || path.join("scripts", "collectSportterySnapshot.cjs")
);
const baseUrl = String(
  process.env.SPORTTERY_FAST_RESULT_PUSH_BASE_URL
  || process.env.SPORTTERY_RELAY_PUSH_BASE_URL
  || process.env.FOOTBALL_CLOUD_API_BASE
  || process.env.REMOTE_BASE_URL
  || ""
).trim();
const adminToken = String(
  process.env.SPORTTERY_FAST_RESULT_ADMIN_TOKEN
  || process.env.SPORTTERY_RELAY_ADMIN_TOKEN
  || process.env.FOOTBALL_CLOUD_ADMIN_TOKEN
  || process.env.ACCESS_CODE_ADMIN_TOKEN
  || process.env.ADMIN_TOKEN
  || ""
).trim();
const uploadTransport = String(process.env.SPORTTERY_RELAY_UPLOAD_TRANSPORT || "https").trim().toLowerCase();
const useSshUpload = uploadTransport === "ssh";
const cloudflareEvidenceConfigured = Boolean(
  String(process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL || "").trim()
  && String(process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN || "").trim()
);
const cloudflareEvidenceIntervalSeconds = finiteNumber(
  process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_INTERVAL_SECONDS,
  300,
  { min: testMode ? 1 : 60, max: 60 * 60, integer: true }
);
const cloudflareEvidenceIntervalMs = cloudflareEvidenceIntervalSeconds * 1000;
const sshHost = String(process.env.SPORTTERY_RELAY_SSH_HOST || process.env.FOOTBALL_CLOUD_HOST || "").trim();
const sshPort = String(process.env.SPORTTERY_RELAY_SSH_PORT || "22").trim();
const sshUser = String(process.env.SPORTTERY_RELAY_SSH_USER || "ubuntu").trim();
const sshKeyPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_SSH_KEY || path.join(".codex-tmp", "football.pem")
);
const sendSnapshot = (snapshot) => useSshUpload
  ? postSnapshotOverSsh({
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    adminToken,
    snapshot,
    timeoutMs: uploadTimeoutMs
  })
  : postSnapshot({
    baseUrl,
    adminToken,
    snapshot,
    timeoutMs: uploadTimeoutMs
  });

let stopping = false;
let pendingSleep = null;

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => {
  if (stopping) {
    resolve();
    return;
  }
  const safeDelayMs = finiteNumber(ms, intervalMs, { min: 0, max: 24 * 60 * 60_000, integer: true });
  const timer = setTimeout(() => {
    pendingSleep = null;
    resolve();
  }, safeDelayMs);
  pendingSleep = { timer, resolve };
});

const emit = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const probeOutputPath = () => path.join(
  path.dirname(snapshotPath),
  `sporttery-fast-result-probe.${process.pid}.${crypto.randomBytes(4).toString("hex")}.json`
);
const companionOutputPath = () => path.join(
  path.dirname(snapshotPath),
  `sporttery-fast-result-companion.${process.pid}.${crypto.randomBytes(4).toString("hex")}.json`
);

const initialState = () => ({
  version: 1,
  mode: watchMode ? "watch" : "once",
  updatedAt: nowIso(),
  intervalSeconds,
  backoffBaseSeconds: baseBackoffMs / 1000,
  backoffMaxSeconds: maxBackoffMs / 1000,
  consecutiveFailures: 0,
  cycles: 0,
  probes: 0,
  companionCollections: 0,
  uploads: 0,
  unchangedCycles: 0,
  lastObservedResultFingerprint: null,
  lastUploadedResultFingerprint: null,
  lastCurrentHeartbeatAt: null,
  lastUploadReason: null,
  lastCycleStatus: null,
  currentHeartbeatUploaded: false
});

const runCycle = async (previousState) => {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const state = {
    ...initialState(),
    ...(previousState || {}),
    mode: watchMode ? "watch" : "once",
    intervalSeconds,
    backoffBaseSeconds: baseBackoffMs / 1000,
    backoffMaxSeconds: maxBackoffMs / 1000,
    wafBackoffMaxSeconds: wafBackoffMaxMs / 1000,
    updatedAt: startedAt,
    lastProbeStartedAt: startedAt,
    currentHeartbeatUploaded: false,
    cycles: finiteNumber(previousState?.cycles, 0, { min: 0, max: Number.MAX_SAFE_INTEGER - 1, integer: true }) + 1,
    probes: finiteNumber(previousState?.probes, 0, { min: 0, max: Number.MAX_SAFE_INTEGER - 1, integer: true }) + 1
  };
  const probePath = probeOutputPath();
  const companionPath = companionOutputPath();
  let probeCompleted = false;
  try {
    const previousCloudflareAttemptMs = Date.parse(String(previousState?.lastCloudflareEvidenceAttemptAt || ""));
    const cloudflareEvidenceDue = cloudflareEvidenceConfigured && (
      !Number.isFinite(previousCloudflareAttemptMs)
      || Date.now() - previousCloudflareAttemptMs >= cloudflareEvidenceIntervalMs
    );
    if (cloudflareEvidenceDue) {
      state.lastCloudflareEvidenceAttemptAt = nowIso();
      try {
        const result = await syncCloudflareSportteryEvidence({ logger: null });
        state.lastCloudflareEvidenceOkAt = nowIso();
        state.lastCloudflareEvidenceFailure = null;
        state.lastCloudflareEvidence = {
          capturedAt: result.capturedAt,
          endpoints: result.endpoints,
          rows: result.rows,
          acceptedRows: result.acceptedRows,
          storeRows: result.storeRows,
          transport: result.transport,
        };
      } catch (error) {
        state.lastCloudflareEvidenceFailedAt = nowIso();
        state.lastCloudflareEvidenceFailure = safeFailure(error);
      }
    }
    const probeSnapshot = await runCollector({
      collectorScript,
      outputPath: probePath,
      methods: "result",
      skipInitial: true,
      timeoutMs: collectorTimeoutMs
    });
    const resultEndpoint = resultPageOneEndpoint(probeSnapshot);
    if (!resultEndpoint) throw new Error("fast-result-probe-invalid");
    const fingerprint = resultFingerprint(resultEndpoint);
    probeCompleted = true;
    const publishDecision = fastLanePublishDecision({
      fingerprint,
      lastUploadedResultFingerprint: previousState?.lastUploadedResultFingerprint,
      lastUploadOkAt: previousState?.lastUploadOkAt,
      currentHeartbeatMs,
      nowMs: Date.now()
    });
    state.lastProbeOkAt = nowIso();
    state.lastProbeFailedAt = null;
    state.lastObservedResultFingerprint = fingerprint;
    state.lastObservedResultFingerprintShort = compactFingerprint(fingerprint);

    state.lastPublishDecision = publishDecision;

    if (!publishDecision.publish) {
      state.updatedAt = nowIso();
      state.consecutiveFailures = 0;
      state.unchangedCycles = finiteNumber(previousState?.unchangedCycles, 0, {
        min: 0,
        max: Number.MAX_SAFE_INTEGER - 1,
        integer: true
      }) + 1;
      state.lastCycleStatus = "unchanged";
      state.lastCycleDurationMs = Date.now() - startedMs;
      state.nextAttemptAt = new Date(Date.now() + intervalMs).toISOString();
      state.lastFailure = null;
      writeJsonAtomic(statePath, state);
      return { ok: true, status: "unchanged", state, uploaded: false, fingerprint, publishDecision };
    }

    const companionSnapshot = await runCollector({
      collectorScript,
      outputPath: companionPath,
      methods: "none",
      skipInitial: false,
      timeoutMs: collectorTimeoutMs
    });
    state.companionCollections = finiteNumber(previousState?.companionCollections, 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER - 1,
      integer: true
    }) + 1;
    const uploadSnapshot = createFastUploadSnapshot({
      probeSnapshot,
      companionSnapshot,
      fingerprint
    });
    writeJsonAtomic(snapshotPath, uploadSnapshot);
    const upload = await sendSnapshot(uploadSnapshot);
    state.updatedAt = nowIso();
    state.consecutiveFailures = 0;
    state.uploads = finiteNumber(previousState?.uploads, 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER - 1,
      integer: true
    }) + 1;
    state.lastUploadOkAt = state.updatedAt;
    state.lastUploadFailedAt = null;
    state.lastUploadedResultFingerprint = fingerprint;
    state.lastUploadedResultFingerprintShort = compactFingerprint(fingerprint);
    state.lastUploadReason = publishDecision.reason;
    if (publishDecision.currentHeartbeatDue) state.lastCurrentHeartbeatAt = state.updatedAt;
    state.lastUploadStatus = upload.status;
    state.lastCycleStatus = "uploaded";
    state.lastCycleDurationMs = Date.now() - startedMs;
    state.nextAttemptAt = new Date(Date.now() + intervalMs).toISOString();
    state.lastFailure = null;
    writeJsonAtomic(statePath, state);
    return {
      ok: true,
      status: "uploaded",
      state,
      upload,
      uploaded: true,
      fingerprint,
      publishDecision
    };
  } catch (error) {
    const failure = safeFailure(error);
    const consecutiveFailures = finiteNumber(previousState?.consecutiveFailures, 0, {
      min: 0,
      max: 1023,
      integer: true
    }) + 1;
    const delayMs = computeFailureBackoffMs({
      failureCode: failure.code,
      consecutiveFailures,
      baseMs: baseBackoffMs,
      maxMs: maxBackoffMs,
      wafMaxMs: wafBackoffMaxMs
    });
    const heartbeatDecision = fastLanePublishDecision({
      fingerprint: previousState?.lastObservedResultFingerprint
        || previousState?.lastUploadedResultFingerprint
        || null,
      lastUploadedResultFingerprint: previousState?.lastUploadedResultFingerprint || null,
      lastUploadOkAt: previousState?.lastUploadOkAt,
      currentHeartbeatMs,
      nowMs: Date.now()
    });
    let currentHeartbeatUpload = null;
    let currentHeartbeatFailure = null;
    if (failure.code === "official-waf" && heartbeatDecision.currentHeartbeatDue) {
      try {
        const companionSnapshot = await runCollector({
          collectorScript,
          outputPath: companionPath,
          methods: "none",
          skipInitial: false,
          timeoutMs: collectorTimeoutMs
        });
        state.companionCollections = finiteNumber(previousState?.companionCollections, 0, {
          min: 0,
          max: Number.MAX_SAFE_INTEGER - 1,
          integer: true
        }) + 1;
        currentHeartbeatUpload = await sendSnapshot(companionSnapshot);
        state.uploads = finiteNumber(previousState?.uploads, 0, {
          min: 0,
          max: Number.MAX_SAFE_INTEGER - 1,
          integer: true
        }) + 1;
        state.lastUploadOkAt = nowIso();
        state.lastCurrentHeartbeatAt = state.lastUploadOkAt;
        state.lastUploadFailedAt = null;
        state.lastUploadReason = "current-heartbeat-result-probe-unavailable";
        state.lastUploadStatus = currentHeartbeatUpload.status;
      } catch (fallbackError) {
        currentHeartbeatFailure = safeFailure(fallbackError);
        if (currentHeartbeatFailure.code === "remote-upload") {
          state.lastUploadFailedAt = nowIso();
        }
      }
    }
    state.updatedAt = nowIso();
    state.consecutiveFailures = consecutiveFailures;
    state.lastProbeFailedAt = probeCompleted ? null : state.updatedAt;
    if (failure.code === "remote-upload") state.lastUploadFailedAt = state.updatedAt;
    state.lastCycleStatus = "failed";
    state.lastCycleDurationMs = Date.now() - startedMs;
    state.currentHeartbeatUploaded = Boolean(currentHeartbeatUpload);
    state.lastFailure = currentHeartbeatFailure
      ? {
          ...failure,
          currentHeartbeatFailure
        }
      : failure;
    state.lastPublishDecision = heartbeatDecision;
    const resultRetryMs = Date.now() + delayMs;
    const heartbeatBaseMs = Date.parse(String(state.lastUploadOkAt || ""));
    const heartbeatRetryMs = Number.isFinite(heartbeatBaseMs)
      ? heartbeatBaseMs + currentHeartbeatMs
      : Date.now();
    state.nextAttemptAt = new Date(Math.min(resultRetryMs, heartbeatRetryMs)).toISOString();
    writeJsonAtomic(statePath, state);
    return {
      ok: false,
      status: "failed",
      state,
      failure: state.lastFailure,
      delayMs,
      upload: currentHeartbeatUpload,
      uploaded: Boolean(currentHeartbeatUpload),
      currentHeartbeatUploaded: Boolean(currentHeartbeatUpload)
    };
  } finally {
    await cleanupFiles([
      probePath,
      `${probePath}.last-failed.json`,
      companionPath,
      `${companionPath}.last-failed.json`
    ]);
  }
};

const run = async () => {
  if (!fs.existsSync(collectorScript)) throw new Error("fast-result-collector-script-missing");
  if (!baseUrl) throw new Error("fast-result-push-base-url-missing");
  if (!adminToken) throw new Error("fast-result-admin-token-missing");

  const lock = acquireInstanceLock({ lockDir });
  if (!lock.acquired) {
    const verifiedExistingRunner = lock.unsafe !== true && lock.reason === "verified-runner-active";
    emit({
      ok: verifiedExistingRunner,
      status: verifiedExistingRunner ? "already-running" : "lock-health-failed",
      checkedAt: nowIso(),
      reason: lock.reason || "lock-acquisition-failed",
      owner: lock.owner || null,
      pidReuseSuspected: lock.pidReuseSuspected === true
    });
    if (!verifiedExistingRunner) process.exitCode = 1;
    return;
  }

  const requestStop = () => {
    stopping = true;
    if (pendingSleep) {
      clearTimeout(pendingSleep.timer);
      const resolve = pendingSleep.resolve;
      pendingSleep = null;
      resolve();
    }
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.once("exit", () => lock.release?.());

  try {
    emit({
      ok: true,
      status: watchMode ? "watch-started" : "once-started",
      checkedAt: nowIso(),
      intervalSeconds,
      currentHeartbeatSeconds,
      resultProbeRequestsPerCycle: 1,
      companionRequestsOnChange: 2,
      uploadOnResultChangeOrCurrentHeartbeat: true,
      cloudflareEvidenceConfigured,
      cloudflareEvidenceIntervalSeconds,
      uploadTransport: useSshUpload ? "ssh-local-http" : "https"
    });
    let state = readJsonSafe(statePath, initialState());
    let cycle = 0;
    while (!stopping && cycle < maxCycles) {
      cycle += 1;
      lock.heartbeat?.();
      const result = await runCycle(state);
      state = result.state;
      lock.heartbeat?.();
      if (result.status === "uploaded" || result.status === "failed" || cycle % heartbeatCycles === 0 || onceMode) {
        emit({
          ok: result.ok,
          status: result.status,
          checkedAt: nowIso(),
          cycle,
          durationMs: result.state.lastCycleDurationMs,
          fingerprint: compactFingerprint(result.fingerprint || result.state.lastObservedResultFingerprint),
          uploadReason: result.publishDecision?.reason || result.state.lastUploadReason || null,
          uploads: result.state.uploads,
          consecutiveFailures: result.state.consecutiveFailures,
          nextAttemptAt: result.state.nextAttemptAt,
          uploadStatus: result.upload?.status || null,
          currentHeartbeatUploaded: result.currentHeartbeatUploaded === true,
          cloudflareEvidence: result.state.lastCloudflareEvidence || null,
          cloudflareEvidenceFailure: result.state.lastCloudflareEvidenceFailure || null,
          failure: result.failure || null
        });
      }
      if (onceMode) {
        if (!result.ok) process.exitCode = 1;
        break;
      }
      const fallbackDelayMs = result.ok ? intervalMs : finiteNumber(result.delayMs, baseBackoffMs, {
        min: baseBackoffMs,
        max: absoluteBackoffMaxMs,
        integer: true
      });
      const delayFromCompletionMs = computeDelayFromCompletion({
        nextAttemptAt: result.state.nextAttemptAt,
        nowMs: Date.now(),
        fallbackMs: fallbackDelayMs,
        maxMs: absoluteBackoffMaxMs
      });
      await sleep(delayFromCompletionMs);
    }
  } finally {
    lock.release?.();
  }
};

if (require.main === module) {
  run().catch((error) => {
    emit({
      ok: false,
      status: "fatal",
      checkedAt: nowIso(),
      failure: safeFailure(error)
    });
    process.exitCode = 1;
  });
}

module.exports = { runCycle };
