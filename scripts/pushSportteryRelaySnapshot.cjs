const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  planFullProbe,
  transitionCollectorCycle,
  snapshotTrustDetails,
  snapshotCycleDetails,
  shouldRememberTrustedSnapshot,
  writeJsonAtomic,
  copyFileAtomic
} = require("./sportteryRelayCircuit.cjs");
const { summarizeRelayLanes } = require("./relayLaneFreshness.cjs");
const { boundedRuntimeEnv, boundedRuntimeNumber } = require("./boundedRuntimeNumber.cjs");
const { shadowObservationAuditValid } = require("../src/services/candidateCaptureState.cjs");

const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".codex-tmp");
const logsDir = path.join(rootDir, "logs");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const snapshotPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_SNAPSHOT_PATH
    || process.env.SPORTTERY_RELAY_SNAPSHOT_OUT
    || process.env.SPORTTERY_RELAY_SNAPSHOT
    || path.join(tmpDir, "sporttery-relay-snapshot.json")
);
const relayStatePath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_STATE_PATH || path.join(logsDir, "sporttery-relay-state.json")
);
const relayFailedSnapshotPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_FAILED_SNAPSHOT_OUT || `${snapshotPath}.last-failed.json`
);
const trustedSnapshotPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_TRUSTED_SNAPSHOT_PATH || `${snapshotPath}.last-good.json`
);
const fastLaneSnapshotPath = path.resolve(
  rootDir,
  process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH || `${snapshotPath}.fast-lanes.json`
);
const baseUrlInput = String(
  process.env.SPORTTERY_RELAY_PUSH_BASE_URL
    || process.env.FOOTBALL_CLOUD_API_BASE
    || process.env.REMOTE_BASE_URL
    || ""
).trim();
const adminToken = String(
  process.env.SPORTTERY_RELAY_ADMIN_TOKEN
    || process.env.FOOTBALL_CLOUD_ADMIN_TOKEN
    || process.env.ACCESS_CODE_ADMIN_TOKEN
    || process.env.ADMIN_TOKEN
    || ""
).trim();
const uploadTransport = String(process.env.SPORTTERY_RELAY_UPLOAD_TRANSPORT || "http").trim().toLowerCase();
const useSshUpload = uploadTransport === "ssh";
const sshHost = String(process.env.SPORTTERY_RELAY_SSH_HOST || process.env.FOOTBALL_CLOUD_HOST || "").trim();
const sshPort = String(process.env.SPORTTERY_RELAY_SSH_PORT || "22").trim();
const sshUser = String(process.env.SPORTTERY_RELAY_SSH_USER || "ubuntu").trim();
const sshKeyPath = path.resolve(rootDir, process.env.SPORTTERY_RELAY_SSH_KEY || path.join(tmpDir, "football.pem"));
const sshRelayIncomingDir = "/var/lib/football-relay/incoming";
const sshRelayPromoter = "/usr/local/sbin/football-relay-promote";
const argv = new Set(process.argv.slice(2));
const dryRun = process.env.SPORTTERY_RELAY_DRY_RUN === "1" || argv.has("--dry-run");
const validateOnly = process.env.SPORTTERY_RELAY_VALIDATE_ONLY === "1" || argv.has("--validate-only");
const skipCollect = process.env.SPORTTERY_RELAY_SKIP_COLLECT === "1" || argv.has("--skip-collect");
const allowStale = process.env.SPORTTERY_RELAY_ALLOW_STALE === "1" || argv.has("--allow-stale");
const tolerateCollectFailure = process.env.SPORTTERY_RELAY_TOLERATE_COLLECT_FAILURE === "1" || argv.has("--tolerate-collect-failure");
const runSync = !validateOnly
  && !argv.has("--no-run-sync")
  && (process.env.SPORTTERY_RELAY_RUN_SYNC === "1" || argv.has("--run-sync"));
const verifyRemote = !dryRun && process.env.SPORTTERY_RELAY_VERIFY_REMOTE !== "0";
const requestTimeoutMs = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_PUSH_TIMEOUT_MS", {
  fallback: 180_000, min: 5_000, max: 600_000, integer: true,
});
const uploadMode = String(process.env.SPORTTERY_RELAY_UPLOAD_MODE || "live").trim().toLowerCase();
const minTrustedRows = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_MIN_TRUSTED_ROWS", {
  fallback: 100, min: 1, max: 1_000_000, integer: true,
});
const minTrustedEndpoints = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS", {
  fallback: 2, min: 1, max: 32, integer: true,
});
const fallbackMaxAgeSeconds = boundedRuntimeEnv(process.env, "V1_FALLBACK_MAX_STALE_SECONDS", {
  fallback: 60 * 60, min: 60, max: 30 * 24 * 60 * 60,
});
const staleFallbackMaxAgeMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_STALE_FALLBACK_MAX_AGE_MINUTES",
  { fallback: fallbackMaxAgeSeconds / 60, min: 1, max: 30 * 24 * 60 },
);
const relayHistoryMaxAgeMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES",
  { fallback: 180, min: 1, max: 30 * 24 * 60 },
);
const trustedFullRetentionMaxAgeMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_TRUSTED_FULL_RETENTION_MAX_AGE_MINUTES",
  { fallback: 7 * 24 * 60, min: relayHistoryMaxAgeMinutes, max: 365 * 24 * 60 },
);
const relayBackoffEnabled = process.env.SPORTTERY_RELAY_BACKOFF_DISABLED !== "1";
const relayBackoffFailureThreshold = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_BACKOFF_FAILURES", {
  fallback: 3, min: 1, max: 100, integer: true,
});
const relayBackoffBaseMinutes = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_BACKOFF_BASE_MINUTES", {
  fallback: 15, min: 1, max: 24 * 60,
});
const relayBackoffMaxMinutes = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_BACKOFF_MAX_MINUTES", {
  fallback: 60, min: relayBackoffBaseMinutes, max: 7 * 24 * 60,
});
const relayFullIntervalMinutes = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_FULL_INTERVAL_MINUTES", {
  fallback: 60, min: 1, max: 7 * 24 * 60,
});
const relayFastResultPageDepth = boundedRuntimeEnv(process.env, "SPORTTERY_RELAY_FAST_RESULT_PAGE_DEPTH", {
  fallback: 1, min: 1, max: 100, integer: true,
});
const relayBackoffCurrentCollect = process.env.SPORTTERY_RELAY_BACKOFF_CURRENT_COLLECT !== "0";
const relayWafBackoffCurrentCollect =
  process.env.SPORTTERY_RELAY_WAF_BACKOFF_CURRENT_COLLECT !== "0";
const relayWafCurrentProbeMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MINUTES",
  { fallback: 10, min: 5, max: 24 * 60 },
);
const relayWafCurrentProbeMaxMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_WAF_CURRENT_PROBE_MAX_MINUTES",
  { fallback: 60, min: relayWafCurrentProbeMinutes, max: 7 * 24 * 60 },
);
const relayDeadlineUrgentWindowMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_DEADLINE_URGENT_WINDOW_MINUTES",
  { fallback: 120, min: 30, max: 7 * 24 * 60 },
);
const relayWafUrgentProbeMaxMinutes = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_WAF_URGENT_PROBE_MAX_MINUTES",
  { fallback: 10, min: 5, max: 24 * 60 },
);
const relayDeadlineQueryTimeoutMs = boundedRuntimeEnv(
  process.env,
  "SPORTTERY_RELAY_DEADLINE_QUERY_TIMEOUT_MS",
  { fallback: 10_000, min: 3_000, max: 20_000, integer: true },
);
const allowPartialLiveUpload = process.env.SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD === "1";
const minCurrentLaneRows = boundedRuntimeEnv(
  process.env,
  ["SPORTTERY_RELAY_MIN_CURRENT_ROWS", "SOURCE_MIN_CURRENT_MATCHES"],
  { fallback: 1, min: 1, max: 1_000_000, integer: true },
);
const relayCurrentMaxAgeMinutes = boundedRuntimeEnv(
  process.env,
  ["SPORTTERY_RELAY_MAX_AGE_MINUTES", "SOURCE_MAX_AGE_MINUTES"],
  { fallback: 20, min: 1, max: 30 * 24 * 60 },
);
const currentLaneMethods = new Set(["current", "calculator"]);
const resultLaneMethods = new Set(["result"]);
const relayCircuitConfig = Object.freeze({
  failureThreshold: relayBackoffFailureThreshold,
  baseMinutes: relayBackoffBaseMinutes,
  maxMinutes: relayBackoffMaxMinutes,
  fullIntervalMinutes: relayFullIntervalMinutes
});

const relayFailureIsWafBlocked = (failure) => Boolean(
  failure?.wafBlocked === true
  || Number(failure?.errorClasses?.["waf-blocked"] || 0) > 0
  || /(?:^|[-_])waf(?:[-_]|$)|HTTP\s+(?:403|567)|captcha/i.test(
    String(failure?.code || failure?.message || failure?.error || ""),
  )
);

const candidateDeadlineUrgencyFromEvaluation = ({
  evaluation = null,
  nowMs = Date.now(),
  urgentWindowMinutes = relayDeadlineUrgentWindowMinutes,
} = {}) => {
  const candidate = evaluation?.publicScorecard?.shadowTracks?.CANDIDATE_PROSPECTIVE;
  const heartbeat = candidate?.captureHeartbeat;
  const readiness = heartbeat?.readiness;
  const deadlineMs = Date.parse(readiness?.nearestDeadlineAt || "");
  const finalizationMs = Date.parse(readiness?.nearestFinalizationAt || "");
  const minutesUntilDeadline = Number.isFinite(deadlineMs)
    ? (deadlineMs - Number(nowMs)) / (60 * 1000)
    : null;
  const minutesUntilFinalization = Number.isFinite(finalizationMs)
    ? (finalizationMs - Number(nowMs)) / (60 * 1000)
    : null;
  const insideEvidenceGrace = Number.isFinite(minutesUntilDeadline)
    && Number.isFinite(minutesUntilFinalization)
    && minutesUntilDeadline <= 0
    && minutesUntilFinalization >= 0;
  const valid = (candidate?.state === "ACTIVE" || shadowObservationAuditValid(candidate))
    && candidate?.chainValid === true
    && heartbeat?.version === "prospective-deadline-heartbeat-v2"
    && heartbeat?.fresh === true
    && heartbeat?.skipped === false
    && readiness?.version === "candidate-prospective-readiness-preview-v2"
    && readiness?.readyInvariantOk === true
    && Number(readiness?.admission?.dueUnrecorded || 0) === 0
    && Number(readiness?.admission?.readyDueUnrecorded || 0) === 0
    && Number.isFinite(minutesUntilDeadline)
    && Number.isFinite(minutesUntilFinalization)
    && finalizationMs >= deadlineMs
    && minutesUntilFinalization >= 0
    && readiness?.nearestStatus !== "excluded";
  const boundedWindowMinutes = Math.max(30, Number(urgentWindowMinutes || 120));
  const insidePreDeadlineUrgentWindow = Number.isFinite(minutesUntilDeadline)
    && minutesUntilDeadline > 0
    && minutesUntilDeadline <= boundedWindowMinutes;
  const urgent = valid && (insidePreDeadlineUrgentWindow || insideEvidenceGrace);
  return {
    version: "candidate-deadline-collector-urgency-v2",
    valid,
    urgent,
    checkedAt: new Date(Number(nowMs)).toISOString(),
    candidateRevisionId: candidate?.candidateRevisionId || null,
    nearestDeadlineAt: Number.isFinite(deadlineMs)
      ? new Date(deadlineMs).toISOString()
      : null,
    nearestFinalizationAt: Number.isFinite(finalizationMs)
      ? new Date(finalizationMs).toISOString()
      : null,
    nearestStatus: readiness?.nearestStatus || null,
    minutesUntilDeadline: Number.isFinite(minutesUntilDeadline)
      ? Number(minutesUntilDeadline.toFixed(2))
      : null,
    minutesUntilFinalization: Number.isFinite(minutesUntilFinalization)
      ? Number(minutesUntilFinalization.toFixed(2))
      : null,
    phase: insideEvidenceGrace
      ? "evidence-finalization-grace"
      : Number.isFinite(minutesUntilDeadline) && minutesUntilDeadline > 0
        ? "pre-deadline"
        : "closed",
    urgentWindowMinutes: boundedWindowMinutes,
    reason: !valid
      ? "candidate-deadline-evidence-invalid-or-unavailable"
      : insideEvidenceGrace
        ? "candidate-deadline-finalization-grace"
        : urgent
        ? "candidate-deadline-inside-urgent-window"
        : "candidate-deadline-outside-urgent-window",
  };
};

const effectiveWafProbePolicy = ({
  deadlineUrgency = null,
  normalProbeMinutes = relayWafCurrentProbeMinutes,
  normalProbeMaxMinutes = relayWafCurrentProbeMaxMinutes,
  urgentProbeMaxMinutes = relayWafUrgentProbeMaxMinutes,
} = {}) => {
  const normalBase = Math.max(5, Number(normalProbeMinutes || 10));
  const normalMax = Math.max(normalBase, Number(normalProbeMaxMinutes || 60));
  if (deadlineUrgency?.urgent !== true) {
    return {
      urgent: false,
      probeMinutes: normalBase,
      probeMaxMinutes: normalMax,
    };
  }
  const urgentMax = Math.max(5, Number(urgentProbeMaxMinutes || 10));
  const probeMinutes = Math.min(normalBase, urgentMax);
  return {
    urgent: true,
    probeMinutes,
    probeMaxMinutes: Math.max(
      probeMinutes,
      Math.min(normalMax, urgentMax),
    ),
  };
};

const backoffCurrentLaneProbeMinutes = ({
  currentLaneState = null,
  wafProbeMinutes = relayWafCurrentProbeMinutes,
  wafProbeMaxMinutes = relayWafCurrentProbeMaxMinutes,
} = {}) => {
  const baseMinutes = Math.max(5, Number(wafProbeMinutes || 10));
  const maxMinutes = Math.max(baseMinutes, Number(wafProbeMaxMinutes || 60));
  const consecutiveFailures = Math.max(
    0,
    Math.floor(Number(currentLaneState?.consecutiveFailures || 0)),
  );
  if (consecutiveFailures <= 1) return baseMinutes;
  const exponent = Math.min(10, consecutiveFailures - 1);
  return Math.min(maxMinutes, baseMinutes * (2 ** exponent));
};

const nextBackoffCurrentLaneProbeAt = ({
  currentLaneState = null,
  wafProbeMinutes = relayWafCurrentProbeMinutes,
  wafProbeMaxMinutes = relayWafCurrentProbeMaxMinutes,
} = {}) => {
  const lastAttemptMs = Date.parse(currentLaneState?.lastAttemptAt || "");
  if (!Number.isFinite(lastAttemptMs)) return null;
  const delayMinutes = backoffCurrentLaneProbeMinutes({
    currentLaneState,
    wafProbeMinutes,
    wafProbeMaxMinutes,
  });
  return new Date(lastAttemptMs + delayMinutes * 60 * 1000).toISOString();
};

const shouldAttemptBackoffCurrentLane = ({
  currentCollectEnabled = relayBackoffCurrentCollect,
  wafCurrentCollectEnabled = relayWafBackoffCurrentCollect,
  wafProbeMinutes = relayWafCurrentProbeMinutes,
  wafProbeMaxMinutes = relayWafCurrentProbeMaxMinutes,
  healthyFullInterval = false,
  backoff = null,
  currentLaneState = null,
  nowMs = Date.now(),
} = {}) => {
  if (!currentCollectEnabled) return false;
  if (healthyFullInterval) return true;
  const fullFailure = backoff?.fullCircuit?.lastFullFailure
    || backoff?.lastFullFailure
    || null;
  if (relayFailureIsWafBlocked(fullFailure)) {
    if (!wafCurrentCollectEnabled) return false;
    const nextProbeAt = nextBackoffCurrentLaneProbeAt({
      currentLaneState,
      wafProbeMinutes,
      wafProbeMaxMinutes,
    });
    return !nextProbeAt || Number(nowMs) >= Date.parse(nextProbeAt);
  }
  return true;
};
const collectorCycleId = `${new Date().toISOString()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
let collectorCycleEvent = {
  cycleId: collectorCycleId,
  fullAttempted: false,
  fullOk: false,
  currentAttempted: false,
  currentOk: false
};

const updateCollectorCycleEvent = (next = {}) => {
  collectorCycleEvent = {
    ...collectorCycleEvent,
    ...next,
    cycleId: collectorCycleId
  };
  return collectorCycleEvent;
};

const maskUrl = (value) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return value.replace(/\/\/([^:@/]+):([^@/]+)@/, "//***:***@");
  }
};

const runCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...(options.env || {}) },
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  let stdout = "";
  let stderr = "";
  if (options.capture) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  }
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(new Error(`${command} ${args.join(" ")} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
  });
});

const relayPromotionAlreadyCurrent = (message) => String(message || "")
  .includes("capturedAt must be strictly newer than the current target");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const readJsonSafe = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, payload) => {
  writeJsonAtomic(filePath, payload);
};

const relayCollectBackoffState = () => {
  if (!relayBackoffEnabled || skipCollect || validateOnly || dryRun) return { active: false, reason: "disabled" };
  const previous = readJsonSafe(relayStatePath, {});
  const plan = planFullProbe(previous, {
    nowMs: Date.now(),
    config: relayCircuitConfig
  });
  return {
    ...plan,
    currentLaneState: previous?.currentLaneState || null,
  };
};

const classifySportteryError = (message) => {
  const text = String(message || "");
  if (/HTTP (?:403|429|567)|WAF|TencentCaptcha|WafCaptcha|__captcha|captcha\.qq\.com|Unexpected token '<'|<!DOCTYPE html|<script/i.test(text)) return "waf-blocked";
  if (/invalid JSON|Unexpected token '<'|<!DOCTYPE html/i.test(text)) return "html-response";
  if (/timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(text)) return "network";
  if (/sporttery_api_/i.test(text)) return "sporttery-api";
  return "unknown";
};

const snapshotFailureEvidence = (payload) => {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const errorClasses = errors.reduce((acc, item) => {
    const key = classifySportteryError(item?.error);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    errors: errors.length,
    errorClasses,
    wafBlocked: Boolean(errorClasses["waf-blocked"]),
    sampleErrors: errors.slice(0, 3).map((item) => ({
      id: item?.id || null,
      method: item?.method || null,
      class: classifySportteryError(item?.error)
    }))
  };
};

const failedSnapshotSummary = () => {
  const payload = readJsonSafe(relayFailedSnapshotPath, null);
  if (!payload) return null;
  const trust = snapshotTrustDetails(payload, {
    minRows: minTrustedRows,
    minEndpoints: minTrustedEndpoints
  });
  return {
    path: relayFailedSnapshotPath,
    capturedAt: payload.capturedAt || null,
    rows: Number(payload?.summary?.rows || 0),
    currentRows: trust.currentRows,
    currentUsableEndpoints: trust.currentUsableEndpoints,
    pagedRows: trust.pagedRows,
    pagedUsableEndpoints: trust.pagedUsableEndpoints,
    ...snapshotFailureEvidence(payload)
  };
};

const buildRelayState = ({
  collectOk: _collectOk,
  collectSkipped,
  collectFailure = null,
  uploadOk = false,
  remote = null,
  usedTrustedFallback = false,
  fallbackSnapshot = null,
  uploadSnapshot = null
}) => {
  const previous = readJsonSafe(relayStatePath, {});
  const now = new Date().toISOString();
  const transition = transitionCollectorCycle(previous, {
    ...collectorCycleEvent,
    fullFailure: collectorCycleEvent.fullFailure || collectFailure || null
  }, {
    nowMs: Date.now(),
    config: relayCircuitConfig
  });
  const fullCircuit = transition.fullCircuit;
  const currentLaneState = transition.currentLaneState;
  const consecutiveCollectFailures = transition.compatibility.consecutiveCollectFailures;
  const lastFailure = transition.compatibility.lastFailure;
  const fullCollectSkipped = Boolean(
    collectSkipped
    || (!collectorCycleEvent.fullAttempted && collectorCycleEvent.currentAttempted)
  );
  const previousFallbackTrusted = Number(previous.fallbackSnapshotRows || 0) >= minTrustedRows
    && Number(previous.fallbackSnapshotUsableEndpoints || 0) >= minTrustedEndpoints;
  const uploadSnapshotTrusted = Boolean(uploadSnapshot?.trusted);
  const uploadSnapshotUsable = Boolean(uploadSnapshot?.usable);
  const realFullRecovered = Boolean(
    collectorCycleEvent.fullAttempted
    && collectorCycleEvent.fullOk
    && !usedTrustedFallback
  );
  const healthyScheduledBaseline = Boolean(
    collectorCycleEvent.fullSkipReason === "healthy-full-interval"
    && collectorCycleEvent.currentOk
    && fullCircuit.consecutiveFullFailures === 0
    && !usedTrustedFallback
  );
  const clearFallbackState = realFullRecovered || healthyScheduledBaseline;
  const uploadTrustLevel = uploadOk
    ? uploadSnapshotTrusted
      ? "trusted"
      : uploadSnapshotUsable
        ? "partial-live"
        : "unknown"
    : previous.lastUploadTrustLevel || null;
  const state = {
    version: 2,
    updatedAt: now,
    snapshotPath,
    relayFailedSnapshotPath,
    collectorCycleId,
    lastCollectorTransitionCycleId: transition.transitionApplied
      ? collectorCycleId
      : previous.lastCollectorTransitionCycleId || fullCircuit.lastTransitionCycleId || null,
    fullCircuit,
    currentLaneState,
    circuitState: fullCircuit.circuitState,
    consecutiveFullFailures: fullCircuit.consecutiveFullFailures,
    lastFullAttemptAt: fullCircuit.lastFullAttemptAt,
    lastFullOkAt: fullCircuit.lastFullOkAt,
    lastFullFailedAt: fullCircuit.lastFullFailedAt,
    nextFullProbeAt: fullCircuit.nextFullProbeAt,
    legacyInflatedFailureCount: fullCircuit.legacyInflatedFailureCount,
    migratedFromVersion: fullCircuit.migratedFromVersion,
    // Compatibility aliases consumed by the existing server and verifiers.
    consecutiveCollectFailures,
    lastCollectOkAt: fullCircuit.lastFullOkAt,
    lastCollectFailedAt: fullCircuit.lastFullFailedAt,
    lastCollectSkippedAt: fullCollectSkipped ? now : previous.lastCollectSkippedAt || null,
    lastUploadOkAt: uploadOk ? now : previous.lastUploadOkAt || null,
    lastUploadSnapshotCapturedAt: uploadOk
      ? uploadSnapshot?.capturedAt || previous.lastUploadSnapshotCapturedAt || null
      : previous.lastUploadSnapshotCapturedAt || null,
    lastUploadSnapshotRows: uploadOk
      ? uploadSnapshot?.rows ?? previous.lastUploadSnapshotRows ?? null
      : previous.lastUploadSnapshotRows ?? null,
    lastUploadSnapshotUsableEndpoints: uploadOk
      ? uploadSnapshot?.usableEndpoints ?? previous.lastUploadSnapshotUsableEndpoints ?? null
      : previous.lastUploadSnapshotUsableEndpoints ?? null,
    lastUploadSnapshotTrusted: uploadOk
      ? uploadSnapshotTrusted
      : previous.lastUploadSnapshotTrusted ?? null,
    lastUploadTrustLevel: uploadTrustLevel,
    lastTrustedUploadAt: uploadOk && uploadSnapshotTrusted ? now : previous.lastTrustedUploadAt || null,
    lastPartialLiveUploadAt: uploadOk && !uploadSnapshotTrusted && uploadSnapshotUsable
      ? now
      : previous.lastPartialLiveUploadAt || null,
    lastTrustedFallbackAt: clearFallbackState
      ? null
      : usedTrustedFallback
        ? now
        : previousFallbackTrusted ? previous.lastTrustedFallbackAt || null : null,
    fallbackSnapshotCapturedAt: clearFallbackState
      ? null
      : fallbackSnapshot?.capturedAt || (previousFallbackTrusted ? previous.fallbackSnapshotCapturedAt || null : null),
    fallbackSnapshotRows: clearFallbackState
      ? null
      : fallbackSnapshot?.rows ?? (previousFallbackTrusted ? previous.fallbackSnapshotRows ?? null : null),
    fallbackSnapshotUsableEndpoints: clearFallbackState
      ? null
      : fallbackSnapshot?.usableEndpoints ?? (previousFallbackTrusted ? previous.fallbackSnapshotUsableEndpoints ?? null : null),
    lastRemotePrimaryAt: remote?.servingMode === "primary" ? now : previous.lastRemotePrimaryAt || null,
    lastRemoteServingMode: remote?.servingMode || previous.lastRemoteServingMode || null,
    lastFailure
  };
  return state;
};

const writeRelayState = (options) => {
  const state = buildRelayState(options);
  writeJson(relayStatePath, state);
  return state;
};

const compactRelayStateForUpload = (state) => {
  if (!state || typeof state !== "object") return null;
  const failure = state.lastFailure && typeof state.lastFailure === "object"
    ? {
        capturedAt: state.lastFailure.capturedAt || null,
        rows: Number(state.lastFailure.rows || 0),
        errors: Number(state.lastFailure.errors || 0),
        errorClasses: state.lastFailure.errorClasses || null,
        wafBlocked: Boolean(state.lastFailure.wafBlocked),
        sampleErrors: Array.isArray(state.lastFailure.sampleErrors)
          ? state.lastFailure.sampleErrors.slice(0, 3)
          : []
      }
    : null;
  const fullCircuit = state.fullCircuit && typeof state.fullCircuit === "object"
    ? {
        version: 2,
        circuitState: state.fullCircuit.circuitState || state.circuitState || null,
        consecutiveFullFailures: Number(state.fullCircuit.consecutiveFullFailures || 0),
        lastFullAttemptAt: state.fullCircuit.lastFullAttemptAt || null,
        lastFullOkAt: state.fullCircuit.lastFullOkAt || null,
        lastFullFailedAt: state.fullCircuit.lastFullFailedAt || null,
        nextFullProbeAt: state.fullCircuit.nextFullProbeAt || null,
        backoffMinutes: Number(state.fullCircuit.backoffMinutes || 0),
        lastFullFailure: failure,
        legacyInflatedFailureCount: state.fullCircuit.legacyInflatedFailureCount ?? null,
        migratedFromVersion: state.fullCircuit.migratedFromVersion ?? null
      }
    : null;
  const currentLaneState = state.currentLaneState && typeof state.currentLaneState === "object"
    ? {
        version: 1,
        consecutiveFailures: Number(state.currentLaneState.consecutiveFailures || 0),
        lastAttemptAt: state.currentLaneState.lastAttemptAt || null,
        lastOkAt: state.currentLaneState.lastOkAt || null,
        lastFailedAt: state.currentLaneState.lastFailedAt || null,
        rows: Number(state.currentLaneState.rows || 0),
        usableEndpoints: Number(state.currentLaneState.usableEndpoints || 0)
      }
    : null;
  return {
    version: Number(state.version || 1),
    updatedAt: state.updatedAt || null,
    collectorCycleId: state.collectorCycleId || null,
    circuitState: state.circuitState || fullCircuit?.circuitState || null,
    consecutiveFullFailures: Number(state.consecutiveFullFailures ?? fullCircuit?.consecutiveFullFailures ?? 0),
    lastFullAttemptAt: state.lastFullAttemptAt || fullCircuit?.lastFullAttemptAt || null,
    lastFullOkAt: state.lastFullOkAt || fullCircuit?.lastFullOkAt || null,
    lastFullFailedAt: state.lastFullFailedAt || fullCircuit?.lastFullFailedAt || null,
    nextFullProbeAt: state.nextFullProbeAt || fullCircuit?.nextFullProbeAt || null,
    legacyInflatedFailureCount: state.legacyInflatedFailureCount ?? fullCircuit?.legacyInflatedFailureCount ?? null,
    fullCircuit,
    currentLaneState,
    consecutiveCollectFailures: Number(state.consecutiveCollectFailures || 0),
    lastCollectOkAt: state.lastCollectOkAt || null,
    lastCollectFailedAt: state.lastCollectFailedAt || null,
    lastUploadOkAt: state.lastUploadOkAt || null,
    lastUploadSnapshotCapturedAt: state.lastUploadSnapshotCapturedAt || null,
    lastUploadSnapshotRows: state.lastUploadSnapshotRows ?? null,
    lastUploadSnapshotUsableEndpoints: state.lastUploadSnapshotUsableEndpoints ?? null,
    lastUploadSnapshotTrusted: state.lastUploadSnapshotTrusted ?? null,
    lastUploadTrustLevel: state.lastUploadTrustLevel || null,
    lastTrustedUploadAt: state.lastTrustedUploadAt || null,
    lastPartialLiveUploadAt: state.lastPartialLiveUploadAt || null,
    lastTrustedFallbackAt: state.lastTrustedFallbackAt || null,
    fallbackSnapshotCapturedAt: state.fallbackSnapshotCapturedAt || null,
    fallbackSnapshotRows: Number(state.fallbackSnapshotRows || 0),
    fallbackSnapshotUsableEndpoints: Number(state.fallbackSnapshotUsableEndpoints || 0),
    lastRemotePrimaryAt: state.lastRemotePrimaryAt || null,
    lastRemoteServingMode: state.lastRemoteServingMode || null,
    lastFailure: failure
  };
};

const snapshotStatus = (filePath) => {
  try {
    const payload = readJson(filePath);
    const capturedMs = Date.parse(payload?.capturedAt || "");
    const configuredMaxAgeMinutes = relayCurrentMaxAgeMinutes;
    const maxAgeMinutes = Math.max(configuredMaxAgeMinutes, boundedRuntimeNumber(
      payload?.maxAgeMinutes,
      { fallback: configuredMaxAgeMinutes, min: 1, max: 30 * 24 * 60 },
    ));
    const ageMinutes = Number.isFinite(capturedMs) ? (Date.now() - capturedMs) / 60000 : Infinity;
    const trust = snapshotTrustDetails(payload, {
      minRows: minTrustedRows,
      minEndpoints: minTrustedEndpoints
    });
    const lanes = summarizeRelayLanes(payload, {
      currentMaxAgeMinutes: configuredMaxAgeMinutes,
      historyMaxAgeMinutes: relayHistoryMaxAgeMinutes
    });
    const rows = trust.rows;
    const usableEndpoints = trust.usableEndpoints;
    const methods = trust.methods;
    const usable = trust.usable;
    const trusted = trust.fullTrusted;
    const currentAgeMinutes = Number(lanes.current?.ageMinutes);
    const fresh = usable && lanes.current?.stale === false;
    const staleFallbackUsable = trusted
      && Number.isFinite(currentAgeMinutes)
      && currentAgeMinutes <= staleFallbackMaxAgeMinutes;
    return {
      exists: true,
      usable,
      trusted,
      fresh,
      staleFallbackUsable,
      capturedAt: payload?.capturedAt || null,
      ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
      maxAgeMinutes,
      staleFallbackMaxAgeMinutes,
      rows,
      usableEndpoints,
      minTrustedRows,
      minTrustedEndpoints,
      atomicCycle: trust.atomicCycle,
      cycle: trust.cycle,
      composite: trust.composite,
      currentRows: trust.currentRows,
      currentUsableEndpoints: trust.currentUsableEndpoints,
      pagedRows: trust.pagedRows,
      pagedUsableEndpoints: trust.pagedUsableEndpoints,
      lanes,
      endpoints: Number(payload?.summary?.endpoints || 0),
      errors: Number(payload?.summary?.errors || 0),
      methods,
      producer: payload?.producer || null
    };
  } catch (error) {
    return {
      exists: fs.existsSync(filePath),
      usable: false,
      trusted: false,
      fresh: false,
      error: error.message || String(error)
    };
  }
};

const currentLaneCycleEvent = (status, failure = null) => ({
  currentAttempted: true,
  currentOk: Boolean(
    status?.lanes?.current?.stale === false
    && Number(status?.lanes?.current?.rows ?? status?.currentRows ?? 0) >= minCurrentLaneRows
    && Number(status?.lanes?.current?.usableEndpoints ?? status?.currentUsableEndpoints ?? 0) > 0
  ),
  currentRows: Number(status?.lanes?.current?.rows ?? status?.currentRows ?? 0),
  currentUsableEndpoints: Number(status?.lanes?.current?.usableEndpoints ?? status?.currentUsableEndpoints ?? 0),
  currentFailure: failure
});

const rememberTrustedSnapshot = (filePath = snapshotPath, status = snapshotStatus(filePath)) => {
  if (!status.trusted) return null;
  const payload = readJsonSafe(filePath, null);
  if (!payload || !shouldRememberTrustedSnapshot(payload, {
    minRows: minTrustedRows,
    minEndpoints: minTrustedEndpoints
  })) return null;
  copyFileAtomic(filePath, trustedSnapshotPath);
  return {
    path: trustedSnapshotPath,
    capturedAt: status.capturedAt || null,
    rows: status.rows,
    usableEndpoints: status.usableEndpoints
  };
};

const restoreTrustedSnapshot = () => {
  const trusted = snapshotStatus(trustedSnapshotPath);
  if (!trusted.trusted || (!trusted.fresh && !trusted.staleFallbackUsable && !allowStale)) return null;
  copyFileAtomic(trustedSnapshotPath, snapshotPath);
  return {
    path: trustedSnapshotPath,
    capturedAt: trusted.capturedAt || null,
    fresh: trusted.fresh,
    staleFallbackUsable: trusted.staleFallbackUsable,
    ageMinutes: trusted.ageMinutes,
    staleFallbackMaxAgeMinutes: trusted.staleFallbackMaxAgeMinutes,
    rows: trusted.rows,
    usableEndpoints: trusted.usableEndpoints
  };
};

const rowsInRelayPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const rowsInEndpoint = (endpoint) => {
  const explicitRows = Number(endpoint?.rows);
  const payloadRows = rowsInRelayPayload(endpoint?.payload);
  return Number.isFinite(explicitRows) && explicitRows > 0 ? explicitRows : payloadRows;
};

const relayEndpointKey = (endpoint) => [
  String(endpoint?.method || endpoint?.id || "unknown"),
  endpoint?.page === null || endpoint?.page === undefined ? "" : String(endpoint.page)
].join(":");

const relayEndpointCapturedMs = (endpoint) => {
  const value = endpoint?.fetchedAt || endpoint?.capturedAt || endpoint?.updatedAt || "";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

const isCurrentLaneEndpoint = (endpoint) => currentLaneMethods.has(String(endpoint?.method || endpoint?.id || ""));
const isResultLaneEndpoint = (endpoint) => resultLaneMethods.has(String(endpoint?.method || endpoint?.id || ""));

const isUsableRelayEndpoint = (endpoint) => endpoint?.payload && endpoint.ok !== false && rowsInEndpoint(endpoint) > 0;

const summarizeEndpoints = (endpoints) => {
  const rows = endpoints.reduce((sum, endpoint) => sum + rowsInEndpoint(endpoint), 0);
  const usableEndpoints = endpoints.filter(isUsableRelayEndpoint).length;
  const methods = Array.from(new Set(endpoints
    .map((endpoint) => endpoint?.method || endpoint?.id)
    .filter(Boolean)
    .map(String)));
  return { rows, usableEndpoints, methods };
};

const currentLaneSummary = (endpoints) => {
  const currentEndpoints = endpoints.filter((endpoint) => isCurrentLaneEndpoint(endpoint) && isUsableRelayEndpoint(endpoint));
  if (!currentEndpoints.length) {
    return {
      capturedAt: null,
      rows: 0,
      usableEndpoints: 0,
      methods: []
    };
  }
  const latestMs = currentEndpoints.reduce((max, endpoint) => Math.max(max, relayEndpointCapturedMs(endpoint)), 0);
  return {
    capturedAt: latestMs ? new Date(latestMs).toISOString() : null,
    rows: currentEndpoints.reduce((sum, endpoint) => sum + rowsInEndpoint(endpoint), 0),
    usableEndpoints: currentEndpoints.length,
    methods: Array.from(new Set(currentEndpoints.map((endpoint) => String(endpoint?.method || endpoint?.id || "")).filter(Boolean)))
  };
};

const resultLaneSummary = (endpoints) => {
  const resultEndpoints = endpoints.filter((endpoint) => isResultLaneEndpoint(endpoint) && isUsableRelayEndpoint(endpoint));
  if (!resultEndpoints.length) {
    return {
      capturedAt: null,
      rows: 0,
      usableEndpoints: 0,
      methods: []
    };
  }
  const latestMs = resultEndpoints.reduce((max, endpoint) => Math.max(max, relayEndpointCapturedMs(endpoint)), 0);
  return {
    capturedAt: latestMs ? new Date(latestMs).toISOString() : null,
    rows: resultEndpoints.reduce((sum, endpoint) => sum + rowsInEndpoint(endpoint), 0),
    usableEndpoints: resultEndpoints.length,
    methods: ["result"]
  };
};

const preserveAtomicTrustedSnapshotWithFastLane = (weakSnapshot, collectedStatus, options = {}) => {
  const includeRecentResults = options.includeRecentResults === true;
  if (!weakSnapshot || typeof weakSnapshot !== "object") return null;
  const weakCycle = snapshotCycleDetails(weakSnapshot);
  if (!weakCycle.atomic) return null;

  const weakEndpoints = Array.isArray(weakSnapshot?.endpoints) ? weakSnapshot.endpoints : [];
  const fastLaneErrors = Array.isArray(weakSnapshot?.errors) ? weakSnapshot.errors.slice(-10) : [];
  const freshCurrentEndpoints = weakEndpoints.filter((endpoint) => isCurrentLaneEndpoint(endpoint) && isUsableRelayEndpoint(endpoint));
  const freshResultEndpoints = includeRecentResults
    ? weakEndpoints.filter((endpoint) => isResultLaneEndpoint(endpoint) && isUsableRelayEndpoint(endpoint))
    : [];
  const freshCurrentLane = currentLaneSummary(freshCurrentEndpoints);
  const freshResultLane = resultLaneSummary(freshResultEndpoints);
  const freshCurrentMs = Date.parse(freshCurrentLane.capturedAt || "");
  const currentLaneFresh = Number.isFinite(freshCurrentMs)
    && (Date.now() - freshCurrentMs) / 60000 <= Number(collectedStatus?.maxAgeMinutes || 20);
  if (freshCurrentLane.rows < minCurrentLaneRows || !currentLaneFresh) {
    return null;
  }
  const freshResultMs = Date.parse(freshResultLane.capturedAt || "");
  const resultLaneFresh = freshResultEndpoints.length > 0
    && Number.isFinite(freshResultMs)
    && (Date.now() - freshResultMs) / 60000 <= Number(collectedStatus?.maxAgeMinutes || 20);

  // A fast lane and the retained full snapshot are two independent collector
  // transactions. Keep them in separate atomically-replaced files. Flattening
  // them into one `endpoints` array would make the top-level cycle claim false
  // and would also detach signed endpoint commitments from their cycle.
  writeJson(fastLaneSnapshotPath, {
    ...weakSnapshot,
    producer: {
      ...(weakSnapshot.producer || {}),
      atomicLane: "current-result-fast"
    }
  });

  const trustedStatus = snapshotStatus(trustedSnapshotPath);
  const trustedFullCapturedAt = trustedStatus?.lanes?.full?.capturedAt || trustedStatus.capturedAt || null;
  const trustedFullAgeMinutes = Number(trustedStatus?.lanes?.full?.ageMinutes);
  const trustedFullRetained = Number.isFinite(trustedFullAgeMinutes)
    && trustedFullAgeMinutes <= trustedFullRetentionMaxAgeMinutes;
  const trustedSnapshot = trustedStatus.trusted && (trustedFullRetained || allowStale)
    ? readJsonSafe(trustedSnapshotPath, null)
    : null;
  const trustedCycle = trustedSnapshot && typeof trustedSnapshot === "object"
    ? snapshotCycleDetails(trustedSnapshot)
    : null;
  const trustedFullAvailable = Boolean(trustedCycle?.atomic);
  const restored = trustedFullAvailable ? restoreTrustedSnapshot() : null;
  const activeStatus = snapshotStatus(snapshotPath);
  return {
    path: snapshotPath,
    trustedPath: trustedSnapshotPath,
    uploadSnapshotPath: fastLaneSnapshotPath,
    capturedAt: activeStatus.capturedAt || null,
    fresh: activeStatus.fresh,
    staleFallbackUsable: activeStatus.staleFallbackUsable,
    ageMinutes: activeStatus.ageMinutes,
    staleFallbackMaxAgeMinutes: activeStatus.staleFallbackMaxAgeMinutes,
    rows: activeStatus.rows,
    usableEndpoints: activeStatus.usableEndpoints,
    currentLane: freshCurrentLane,
    resultLane: resultLaneFresh ? freshResultLane : null,
    fastResultMerged: resultLaneFresh,
    lanes: activeStatus.lanes,
    composite: false,
    atomic: true,
    activeSourceCycleId: trustedCycle?.sourceCycleId || null,
    fastLaneSourceCycleId: weakCycle.sourceCycleId,
    trustedFullAvailable,
    trustedFullRestored: Boolean(restored),
    trustedFullCapturedAt: trustedFullAvailable ? trustedFullCapturedAt : null,
    trustedFullAgeMinutes: Number.isFinite(trustedFullAgeMinutes) ? trustedFullAgeMinutes : null,
    trustedFullRetentionMaxAgeMinutes,
    fastLaneErrors: fastLaneErrors.length
  };
};

const endpointSourceCycleId = (endpoint) => String(
  endpoint?.sourceCycleId || endpoint?.collectorProvenance?.sourceCycleId || ""
).trim();

const atomicSubsetEnvelope = (snapshot, endpoints, mode) => {
  const cycles = Array.from(new Set(endpoints.map(endpointSourceCycleId).filter(Boolean)));
  if (endpoints.length === 0 || cycles.length !== 1 || endpoints.some((endpoint) => !endpointSourceCycleId(endpoint))) {
    throw new Error(`refused non-atomic relay upload subset: ${JSON.stringify({
      endpoints: endpoints.length,
      cycles,
      missingCycleEndpoints: endpoints.filter((endpoint) => !endpointSourceCycleId(endpoint)).length
    })}`);
  }
  const sourceCycleId = cycles[0];
  const sourceEnvelopeMatches = snapshot?.sourceCycleId === sourceCycleId
    && snapshot?.collectorProvenance?.sourceCycleId === sourceCycleId;
  const requestedTimes = endpoints.map((endpoint) => Date.parse(endpoint?.requestedAt || "")).filter(Number.isFinite);
  const receivedTimes = endpoints.map((endpoint) => Date.parse(endpoint?.receivedAt || "")).filter(Number.isFinite);
  const requestedAt = sourceEnvelopeMatches && Number.isFinite(Date.parse(snapshot?.requestedAt || ""))
    ? snapshot.requestedAt
    : requestedTimes.length ? new Date(Math.min(...requestedTimes)).toISOString() : null;
  const completedAt = sourceEnvelopeMatches && Number.isFinite(Date.parse(snapshot?.completedAt || ""))
    ? snapshot.completedAt
    : receivedTimes.length ? new Date(Math.max(...receivedTimes)).toISOString() : null;
  if (!requestedAt || !completedAt || Date.parse(completedAt) < Date.parse(requestedAt)) {
    throw new Error(`refused relay upload subset with invalid collector envelope clocks: ${JSON.stringify({
      sourceCycleId,
      requestedAt,
      completedAt
    })}`);
  }
  const { compositeFromTrustedSnapshot, ...producer } = snapshot?.producer || {};
  return {
    ...snapshot,
    capturedAt: sourceEnvelopeMatches ? snapshot.capturedAt : requestedAt,
    sourceCycleId,
    requestedAt,
    completedAt,
    provenanceVersion: Math.max(1, Number(snapshot?.provenanceVersion || 0)),
    collectorProvenance: sourceEnvelopeMatches
      ? snapshot.collectorProvenance
      : {
          sourceCycleId,
          requestedAt,
          completedAt,
          clock: "collector-owned-wall-clock"
        },
    producer: {
      ...producer,
      uploadMode: mode,
      atomicSubset: endpoints.length !== (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints.length : endpoints.length),
      subsetFromSourceCycleId: sourceCycleId
    },
    endpoints,
    errors: []
  };
};

const snapshotForUpload = (snapshot, mode = uploadMode) => {
  const endpoints = Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : [];
  if (mode === "full" || endpoints.length === 0) {
    const cycle = snapshotCycleDetails(snapshot);
    if (!cycle.atomic) {
      throw new Error(`refused non-atomic full relay upload: ${JSON.stringify(cycle)}`);
    }
    return {
      snapshot,
      summary: {
        mode: "full",
        originalEndpoints: endpoints.length,
        uploadEndpoints: endpoints.length,
        originalRows: Number(snapshot?.summary?.rows || 0),
        uploadRows: Number(snapshot?.summary?.rows || 0)
      }
    };
  }

  // The one-minute payload is deliberately bounded to the two current-market
  // endpoints plus result page 1. Concern/live and archive pages are restored
  // by the periodic full HTTP upload, not repeated on every fast cycle.
  const compactMethods = new Set(["current", "calculator"]);
  let selected = endpoints.filter((endpoint) => {
    const method = String(endpoint?.method || endpoint?.id || "");
    if (compactMethods.has(method)) {
      return endpoint?.ok !== false && rowsInRelayPayload(endpoint?.payload) > 0;
    }
    if (mode === "current" || method !== "result") return false;
    const page = Number(endpoint?.page ?? 1);
    return endpoint?.ok !== false
      && rowsInRelayPayload(endpoint?.payload) > 0
      && Number.isFinite(page)
      && page === 1;
  });
  if (!selected.some((endpoint) => rowsInRelayPayload(endpoint?.payload) > 0)) {
    const firstUsable = endpoints.find((endpoint) => endpoint?.ok !== false && rowsInRelayPayload(endpoint?.payload) > 0);
    selected = firstUsable ? [firstUsable] : selected;
  }

  const selectedCycles = Array.from(new Set(selected.map(endpointSourceCycleId).filter(Boolean)));
  if (selectedCycles.length !== 1 || selected.some((endpoint) => !endpointSourceCycleId(endpoint))) {
    throw new Error(`refused mixed-cycle compact relay upload: ${JSON.stringify({
      selectedEndpoints: selected.map((endpoint) => relayEndpointKey(endpoint)),
      selectedCycles,
      snapshotCycle: snapshot?.sourceCycleId || null
    })}`);
  }

  const uploadSummary = summarizeEndpoints(selected);
  const uploadLanes = summarizeRelayLanes({ endpoints: selected }, {
    currentMaxAgeMinutes: relayCurrentMaxAgeMinutes,
    historyMaxAgeMinutes: relayHistoryMaxAgeMinutes
  });
  const compact = {
    ...atomicSubsetEnvelope(snapshot, selected, mode),
    summary: {
      ...(snapshot.summary || {}),
      endpoints: selected.length,
      usableEndpoints: uploadSummary.usableEndpoints,
      rows: uploadSummary.rows,
      lanes: uploadLanes,
      errors: 0,
      methods: uploadSummary.methods,
      omittedEndpoints: Math.max(0, endpoints.length - selected.length),
      originalEndpoints: endpoints.length,
      originalRows: Number(snapshot?.summary?.rows || 0),
      uploadMode: mode
    },
    endpoints: selected,
    errors: []
  };

  return {
    snapshot: compact,
    summary: {
      mode: mode === "current" ? "current" : "live",
      originalEndpoints: endpoints.length,
      uploadEndpoints: selected.length,
      omittedEndpoints: Math.max(0, endpoints.length - selected.length),
      originalRows: Number(snapshot?.summary?.rows || 0),
      uploadRows: uploadSummary.rows,
      uploadMethods: uploadSummary.methods
    }
  };
};

const realFullCollectionSucceeded = ({ cycleEvent, collectOk, collectSkipped, usedTrustedFallback }) => Boolean(
  cycleEvent?.fullAttempted
  && cycleEvent?.fullOk
  && collectOk
  && !collectSkipped
  && !usedTrustedFallback
);

const resolveEffectiveUploadMode = ({
  requestedMode,
  sshUpload,
  fullCollectionSucceeded,
  staleTrustedFallback
}) => {
  if (sshUpload || fullCollectionSucceeded || staleTrustedFallback) return "full";
  return requestedMode;
};

const shouldPublishAtomicFastLaneUpload = ({
  atomicUploadSnapshotPath: candidatePath,
  sshUpload,
  validate,
  dry
}) => Boolean(candidatePath && !sshUpload && !validate && !dry);

const collectSnapshot = async (options = {}) => {
  if (skipCollect) return { skipped: true };
  const outputPath = path.resolve(options.outputPath || snapshotPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runCommand(npmCommand, ["run", "sync:sporttery-snapshot"], {
    env: {
      SPORTTERY_RELAY_SNAPSHOT_OUT: outputPath,
      ...(Object.prototype.hasOwnProperty.call(options, "methods")
        ? { SPORTTERY_RELAY_METHODS: options.methods }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(options, "resultPageDepth")
        ? { SPORTTERY_RELAY_RESULT_PAGE_DEPTH: String(options.resultPageDepth) }
        : {})
    }
  });
  return { skipped: false, outputPath };
};

const evaluateCollectedSnapshot = ({
  checks,
  warnings,
  collect,
  preferFreshPartial = false,
  checkName = "collect snapshot"
}) => {
  const collectSkipped = Boolean(collect?.skipped);
  const collectedStatus = snapshotStatus(snapshotPath);
  if (!collectSkipped && !collectedStatus.trusted) {
    const weakSnapshot = readJsonSafe(snapshotPath, null);
    const collectFailure = {
      code: "untrusted-relay-snapshot",
      message: `relay snapshot below trusted floor rows>=${minTrustedRows}, usableEndpoints>=${minTrustedEndpoints}`,
      capturedAt: collectedStatus.capturedAt || null,
      rows: collectedStatus.rows || 0,
      usableEndpoints: collectedStatus.usableEndpoints || 0,
      minTrustedRows,
      minTrustedEndpoints,
      ...snapshotFailureEvidence(weakSnapshot)
    };
    if (weakSnapshot) {
      writeJson(relayFailedSnapshotPath, {
        ...weakSnapshot,
        untrustedReason: collectFailure
      });
    }
    const shouldPreferFreshPartial = preferFreshPartial && collectedStatus.usable && collectedStatus.fresh;
    const atomicLaneFallback = shouldPreferFreshPartial
      ? null
      : preserveAtomicTrustedSnapshotWithFastLane(weakSnapshot, collectedStatus);
    const fallbackSnapshot = shouldPreferFreshPartial
      ? null
      : (atomicLaneFallback || restoreTrustedSnapshot());
    const usedTrustedFallback = Boolean(fallbackSnapshot);
    if (shouldPreferFreshPartial) {
      warnings.push({
        code: "collector-backoff-current-partial-upload",
        message: "collector is in full-lane backoff; uploading fresh current/calculator partial snapshot to preserve C-end freshness",
        collected: collectFailure
      });
    } else if (atomicLaneFallback) {
      warnings.push({
        code: "collector-produced-untrusted-snapshot-preserved-atomic-lanes",
        message: "collector returned a weak Sporttery snapshot; retained it as a separate atomic fast lane and restored the latest atomic full snapshot",
        collected: collectFailure,
        fallback: atomicLaneFallback
      });
    } else if (usedTrustedFallback) {
      warnings.push({
        code: "collector-produced-untrusted-snapshot-using-last-good",
        message: "collector returned a weak Sporttery snapshot; uploading the latest trusted snapshot instead",
        collected: collectFailure,
        fallback: fallbackSnapshot
      });
    } else {
      warnings.push({
        code: "collector-produced-untrusted-snapshot-no-last-good",
        message: "collector returned a weak Sporttery snapshot and no fresh trusted fallback is available",
        collected: collectFailure
      });
    }
    checks.push({
      name: checkName,
      ok: true,
      status: atomicLaneFallback
        ? "using-separate-atomic-fast-and-full-snapshots"
        : usedTrustedFallback ? "using-trusted-fallback-snapshot" : "using-untrusted-snapshot",
      collected: true,
      trusted: false,
      weakSnapshot: collectedStatus,
      fallbackSnapshot,
      warning: warnings.at(-1)
    });
    return {
      collectOk: false,
      collectSkipped,
      collectFailure,
      collectedStatus,
      fallbackSnapshot,
      usedTrustedFallback,
      uploadSnapshotPath: atomicLaneFallback?.uploadSnapshotPath || null
    };
  }

  if (!collectSkipped) rememberTrustedSnapshot(snapshotPath, collectedStatus);
  checks.push({
    name: checkName,
    ok: true,
    skipped: collectSkipped,
    trusted: collectedStatus.trusted,
    rows: collectedStatus.rows || 0,
    usableEndpoints: collectedStatus.usableEndpoints || 0
  });
  return {
    collectOk: true,
    collectSkipped,
    collectFailure: null,
    collectedStatus,
    fallbackSnapshot: null,
    usedTrustedFallback: false
  };
};

const requiredChecksOk = (checks) => checks
  .filter((check) => check.required !== false)
  .every((check) => check.ok);

const postJson = async (pathname, body) => {
  if (typeof fetch !== "function") {
    throw new Error("Node fetch is unavailable; use Node 18+ on the collector");
  }
  const baseUrl = new URL(baseUrlInput);
  const target = new URL(pathname, baseUrl);
  const loopbackHost = target.hostname === "localhost"
    || target.hostname === "::1"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(target.hostname);
  if (target.protocol !== "https:" && !loopbackHost) {
    throw new Error("refusing to send bearer credentials to a non-HTTPS public origin");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(target, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      status: response.status,
      ok: response.ok && payload?.ok !== false,
      payload,
      text: payload ? undefined : text.slice(0, 500)
    };
  } finally {
    clearTimeout(timer);
  }
};

const uploadRelayState = async (state, reason) => {
  if (!state || useSshUpload || !baseUrlInput || !adminToken || dryRun || validateOnly) return null;
  try {
    const response = await postJson("/api/admin/sporttery-relay-state", {
      collectorState: compactRelayStateForUpload(state),
      reason
    });
    return {
      ok: response.ok && response.status >= 200 && response.status < 300,
      status: response.status,
      error: response.payload?.error || response.text || null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message || String(error)
    };
  }
};

const uploadSnapshotOverSsh = async (snapshot) => {
  if (!sshHost) throw new Error("SPORTTERY_RELAY_SSH_HOST or FOOTBALL_CLOUD_HOST is required for SSH upload");
  if (!fs.existsSync(sshKeyPath)) throw new Error(`SPORTTERY_RELAY_SSH_KEY does not exist: ${sshKeyPath}`);
  if (validateOnly) throw new Error("SSH relay transport does not support validate-only mode");

  const preparedPath = `${snapshotPath}.ssh-upload.tmp`;
  writeJson(preparedPath, snapshot);
  const preparedStatus = snapshotStatus(preparedPath);
  if (!preparedStatus.trusted) {
    throw new Error(`prepared SSH relay snapshot is below the trusted floor: ${JSON.stringify(preparedStatus)}`);
  }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(preparedPath)).digest("hex");
  const timestampId = new Date().toISOString().replace(/[-:.]/g, "");
  const remoteIncomingPath = `${sshRelayIncomingDir}/${sha256}.${timestampId}.json`;
  const remoteTarget = `${sshUser}@${sshHost}`;
  const commonOptions = [
    "-i", sshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new"
  ];
  try {
    await runCommand("scp", [
      ...commonOptions,
      "-C",
      "-P", sshPort,
      preparedPath,
      `${remoteTarget}:${remoteIncomingPath}`
    ], { capture: true });
    const remoteCommand = [
      "set -eu",
      `incoming='${remoteIncomingPath}'`,
      "trap 'rm -f \"$incoming\"' EXIT",
      "chmod 0600 \"$incoming\"",
      `sudo -n '${sshRelayPromoter}' '${sha256}' '${timestampId}'`,
      "systemctl is-active --quiet football-sync-worker"
    ].join("; ");
    let alreadyCurrentOrNewer = false;
    try {
      await runCommand("ssh", [
        ...commonOptions,
        "-p", sshPort,
        remoteTarget,
        remoteCommand
      ], { capture: true });
    } catch (error) {
      const message = String(error?.message || error);
      if (!relayPromotionAlreadyCurrent(message)) throw error;
      // The root-owned promoter rejected a replay because the canonical target
      // is already at least as new. Confirm the consumer is still healthy, then
      // treat the upload as an idempotent no-op instead of making the minute
      // scheduler report a false failure.
      await runCommand("ssh", [
        ...commonOptions,
        "-p", sshPort,
        remoteTarget,
        "systemctl is-active --quiet football-sync-worker"
      ], { capture: true });
      alreadyCurrentOrNewer = true;
    }
    return {
      status: 200,
      ok: true,
      payload: {
        ok: true,
        transport: "ssh",
        sha256,
        timestampId,
        promoted: !alreadyCurrentOrNewer,
        alreadyCurrentOrNewer,
        validation: {
          rows: preparedStatus.rows,
          usableEndpoints: preparedStatus.usableEndpoints
        },
        sync: {
          ok: true,
          mode: "deferred-worker-cycle",
          deferred: true
        }
      }
    };
  } finally {
    fs.rmSync(preparedPath, { force: true });
  }
};

const getJson = async (pathname, { timeoutMs = requestTimeoutMs } = {}) => {
  const baseUrl = new URL(baseUrlInput);
  const target = new URL(pathname, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs)));
  try {
    const response = await fetch(target, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

const remoteHealthSummary = async () => {
  const [health, sourceHealth] = await Promise.all([
    getJson("/api/v1/health"),
    getJson("/api/v1/source-health")
  ]);
  const sporttery = Array.isArray(sourceHealth.body?.sources)
    ? sourceHealth.body.sources.find((source) => source.id === "sporttery")
    : null;
  return {
    healthStatus: health.status,
    sourceHealthStatus: sourceHealth.status,
    ok: health.body?.ok ?? null,
    servingMode: health.body?.status?.servingMode || null,
    recommendationReliable: health.body?.status?.recommendationReliable ?? null,
    currentReadSource: health.body?.data?.currentRead?.source || null,
    sportteryStatus: sporttery?.status || null,
    sportteryTransport: sporttery?.metrics?.transport || null,
    relayCapturedAt: sporttery?.metrics?.relaySnapshot?.capturedAt || null,
    sourceHealthOk: sourceHealth.body?.ok ?? null,
    sourceHealthErrors: Array.isArray(sourceHealth.body?.errors) ? sourceHealth.body.errors.slice(0, 5) : []
  };
};

const run = async () => {
  const checks = [];
  const warnings = [];
  let collect = null;
  let collectOk = false;
  let collectSkipped = false;
  let collectFailure = null;
  let usedTrustedFallback = false;
  let fallbackSnapshot = null;
  let atomicUploadSnapshotPath = null;
  rememberTrustedSnapshot();
  try {
    const collectBackoff = relayCollectBackoffState();
    if (collectBackoff.active) {
      const healthyFullInterval = collectBackoff.reason === "healthy-full-interval";
      let deadlineUrgency = {
        version: "candidate-deadline-collector-urgency-v2",
        valid: false,
        urgent: false,
        reason: "candidate-deadline-not-queried",
      };
      const fullFailure = collectBackoff?.fullCircuit?.lastFullFailure
        || collectBackoff?.lastFullFailure
        || null;
      if (
        relayFailureIsWafBlocked(fullFailure)
        && baseUrlInput
        && !dryRun
        && !validateOnly
      ) {
        try {
          const evaluation = await getJson("/api/v1/model/evaluation", {
            timeoutMs: relayDeadlineQueryTimeoutMs,
          });
          deadlineUrgency = candidateDeadlineUrgencyFromEvaluation({
            evaluation: evaluation.body,
          });
        } catch (error) {
          deadlineUrgency = {
            ...deadlineUrgency,
            reason: "candidate-deadline-query-failed",
            error: error.message || String(error),
          };
        }
      }
      const wafProbePolicy = effectiveWafProbePolicy({ deadlineUrgency });
      const backoffCurrentAttemptAllowed = shouldAttemptBackoffCurrentLane({
        healthyFullInterval,
        backoff: collectBackoff,
        currentLaneState: collectBackoff.currentLaneState,
        wafProbeMinutes: wafProbePolicy.probeMinutes,
        wafProbeMaxMinutes: wafProbePolicy.probeMaxMinutes,
      });
      const backoffCurrentNextProbeAt = nextBackoffCurrentLaneProbeAt({
        currentLaneState: collectBackoff.currentLaneState,
        wafProbeMinutes: wafProbePolicy.probeMinutes,
        wafProbeMaxMinutes: wafProbePolicy.probeMaxMinutes,
      });
      updateCollectorCycleEvent({ fullSkipReason: collectBackoff.reason });
      let backoffCurrentCollected = false;
      let backoffCurrentError = null;
      if (backoffCurrentAttemptAllowed && !skipCollect) {
        try {
          collect = await collectSnapshot({
            methods: healthyFullInterval ? "result" : "none",
            outputPath: fastLaneSnapshotPath,
            ...(healthyFullInterval ? { resultPageDepth: relayFastResultPageDepth } : {})
          });
          const currentStatus = snapshotStatus(fastLaneSnapshotPath);
          const fastLaneSnapshot = readJsonSafe(fastLaneSnapshotPath, null);
          const atomicLaneFallback = preserveAtomicTrustedSnapshotWithFastLane(
            fastLaneSnapshot,
            currentStatus,
            { includeRecentResults: healthyFullInterval }
          );
          const currentEvent = currentLaneCycleEvent(currentStatus, atomicLaneFallback ? null : {
            code: "fast-lane-atomic-preservation-failed",
            message: "fresh current/result lane could not be retained beside the atomic trusted full snapshot"
          });
          updateCollectorCycleEvent({
            fullAttempted: false,
            ...currentEvent
          });
          backoffCurrentCollected = currentEvent.currentOk && Boolean(atomicLaneFallback);
          checks.push({
            name: healthyFullInterval ? "fast current/result lane collect" : "backoff current-lane collect",
            ok: backoffCurrentCollected,
            skipped: false,
            status: backoffCurrentCollected
              ? (atomicLaneFallback?.fastResultMerged ? "separate-atomic-current-result-lane" : "separate-atomic-current-lane")
              : "no-atomic-fast-lane",
            backoff: collectBackoff,
            current: currentStatus,
            atomicLanes: atomicLaneFallback
          });
          if (backoffCurrentCollected) {
            const fastResultMerged = Boolean(atomicLaneFallback?.fastResultMerged);
            warnings.push({
              code: healthyFullInterval
                ? (fastResultMerged
                    ? "collector-full-interval-current-result-lanes"
                    : "collector-full-interval-result-lane-unavailable")
                : "collector-backoff-current-lane",
              message: healthyFullInterval
                ? (fastResultMerged
                    ? "full Sporttery relay collection is not due yet; current/calculator and the newest result page were retained in one separate atomic fast-lane cycle"
                    : "full Sporttery relay collection is not due yet; current/calculator were retained in a separate atomic fast-lane cycle")
                : "full Sporttery relay collection is cooling down, but an atomic current/calculator fast-lane collection still ran",
              backoff: collectBackoff,
              atomicLanes: atomicLaneFallback
            });
            collectOk = false;
            // The lightweight current lane ran, but the full lane was skipped.
            // Do not advance the full-lane failure counter or cooldown anchor.
            collectSkipped = true;
            collectFailure = null;
            fallbackSnapshot = atomicLaneFallback;
            atomicUploadSnapshotPath = atomicLaneFallback.uploadSnapshotPath || null;
            usedTrustedFallback = false;
          }
        } catch (error) {
          backoffCurrentError = error.message || String(error);
          updateCollectorCycleEvent({
            fullAttempted: false,
            currentAttempted: true,
            currentOk: false,
            currentFailure: {
              code: "current-lane-collect-failed",
              message: backoffCurrentError
            }
          });
          checks.push({
            name: "backoff current-lane collect",
            ok: false,
            skipped: false,
            status: "failed",
            backoff: collectBackoff,
            error: backoffCurrentError
          });
        }
      }
      if (
        relayBackoffCurrentCollect
        && !backoffCurrentAttemptAllowed
        && !skipCollect
      ) {
        checks.push({
          name: "backoff current-lane policy",
          ok: true,
          skipped: true,
          status: relayWafBackoffCurrentCollect
            ? "deferred-until-bounded-current-probe"
            : "suppressed-during-waf-cooldown",
          backoff: collectBackoff,
          nextAttemptAt:
            (relayWafBackoffCurrentCollect ? backoffCurrentNextProbeAt : null)
            || collectBackoff.nextFullProbeAt
            || collectBackoff.nextCollectAt
            || null,
          policy: {
            currentCollectEnabled: relayBackoffCurrentCollect,
            wafCurrentCollectEnabled: relayWafBackoffCurrentCollect,
            wafCurrentProbeMinutes: wafProbePolicy.probeMinutes,
            wafCurrentProbeMaxMinutes: wafProbePolicy.probeMaxMinutes,
            deadlineUrgency,
          },
        });
        warnings.push({
          code: relayWafBackoffCurrentCollect
            ? "collector-waf-current-lane-deferred"
            : "collector-waf-current-lane-suppressed",
          message: relayWafBackoffCurrentCollect
            ? "current/calculator requests are deferred until the independent bounded probe; minute scheduler ticks do not hit the provider during the WAF cooldown"
            : "current/calculator requests are paused until the fixed half-open probe so repeated WAF responses cannot slide or prolong the provider block",
          backoff: collectBackoff,
          nextCurrentProbeAt: relayWafBackoffCurrentCollect ? backoffCurrentNextProbeAt : null,
          deadlineUrgency,
          wafProbePolicy,
        });
      }

      if (!backoffCurrentCollected) {
        collect = { skipped: true, reason: "adaptive-backoff", backoff: collectBackoff };
        collectSkipped = true;
        collectOk = false;
        collectFailure = {
          code: healthyFullInterval ? "healthy-full-interval" : "adaptive-backoff",
          message: healthyFullInterval
            ? "Sporttery relay full collection skipped until its healthy cadence deadline"
            : "Sporttery relay full collection skipped during WAF/backoff cooldown",
          currentLaneAttempted: Boolean(backoffCurrentAttemptAllowed && !skipCollect),
          currentLaneSuppressedForWaf:
            relayBackoffCurrentCollect
            && !backoffCurrentAttemptAllowed
            && !skipCollect,
          currentLaneError: backoffCurrentError,
          ...collectBackoff
        };
        fallbackSnapshot = restoreTrustedSnapshot();
        usedTrustedFallback = Boolean(fallbackSnapshot);
      }

      const existingStatus = snapshotStatus(snapshotPath);
      const existingAcceptable = existingStatus.usable
        && (existingStatus.fresh || existingStatus.staleFallbackUsable || allowStale);
      if (!backoffCurrentCollected && !existingAcceptable) {
        const relayState = writeRelayState({
          collectOk: false,
          collectSkipped: true,
          collectFailure,
          uploadOk: false,
          remote: null,
          usedTrustedFallback,
          fallbackSnapshot
        });
        const relayStateUpload = await uploadRelayState(relayState, "collect-backoff-no-acceptable-snapshot");
        checks.push({
          name: "collect snapshot",
          ok: false,
          skipped: true,
          status: "backoff-no-acceptable-snapshot",
          backoff: collectBackoff,
          existing: existingStatus,
          fallbackSnapshot,
          relayStateUpload
        });
        if (tolerateCollectFailure) {
          console.log(JSON.stringify({
            ok: true,
            status: "watch",
            checkedAt: new Date().toISOString(),
            dryRun,
            validateOnly,
            runSync,
            baseUrl: baseUrlInput ? maskUrl(baseUrlInput).replace(/\/$/, "") : null,
            snapshotPath,
            uploaded: false,
            reason: "collect-backoff-no-acceptable-snapshot",
            relayState,
            relayStateUpload,
            warnings: [{
              code: "relay-collector-backoff-no-upload",
              message: "Sporttery relay collection is in backoff and no uploadable snapshot is available; server fallback remains authoritative."
            }],
            checks
          }, null, 2));
          return;
        }
        throw new Error(`relay collection backoff active and no acceptable snapshot is available: ${JSON.stringify(existingStatus)}`);
      }
      if (!backoffCurrentCollected) {
        const warning = {
          code: healthyFullInterval ? "collector-full-interval-active" : "collector-backoff-active",
          message: healthyFullInterval
            ? "Sporttery relay full collection is not due yet; existing full data is reused with the current lane refreshed"
            : "Sporttery relay full collection is cooling down after repeated weak/WAF results; existing relay data is reused",
          backoff: collectBackoff,
          existing: existingStatus,
          fallback: fallbackSnapshot
        };
        warnings.push(warning);
        checks.push({
          name: "collect snapshot",
          ok: true,
          skipped: true,
          status: usedTrustedFallback ? "backoff-using-trusted-fallback-snapshot" : "backoff-using-existing-snapshot",
          backoff: collectBackoff,
          existing: existingStatus,
          fallbackSnapshot,
          warning
        });
      }
    } else {
      if (!skipCollect) {
        updateCollectorCycleEvent({
          fullAttempted: true,
          fullOk: false,
          currentAttempted: true,
          currentOk: false
        });
      }
      collect = await collectSnapshot();
      const evaluated = evaluateCollectedSnapshot({ checks, warnings, collect });
      collectOk = evaluated.collectOk;
      collectSkipped = evaluated.collectSkipped;
      collectFailure = evaluated.collectFailure;
      fallbackSnapshot = evaluated.fallbackSnapshot;
      usedTrustedFallback = evaluated.usedTrustedFallback;
      atomicUploadSnapshotPath = evaluated.uploadSnapshotPath || null;
      if (!evaluated.collectSkipped) {
        updateCollectorCycleEvent({
          fullAttempted: true,
          fullOk: Boolean(evaluated.collectOk && evaluated.collectedStatus?.trusted),
          fullFailure: evaluated.collectOk ? null : evaluated.collectFailure,
          ...currentLaneCycleEvent(evaluated.collectedStatus, evaluated.collectFailure)
        });
      }
    }
  } catch (error) {
    const existing = snapshotStatus(snapshotPath);
    collectFailure = failedSnapshotSummary() || {
      error: error.message || String(error)
    };
    if (collectorCycleEvent.fullAttempted) {
      const currentRows = Number(collectFailure?.currentRows || 0);
      const currentUsableEndpoints = Number(collectFailure?.currentUsableEndpoints || 0);
      updateCollectorCycleEvent({
        fullOk: false,
        fullFailure: collectFailure,
        currentOk: currentRows >= minCurrentLaneRows && currentUsableEndpoints > 0,
        currentRows,
        currentUsableEndpoints,
        currentFailure: currentRows >= minCurrentLaneRows ? null : collectFailure
      });
    }
    fallbackSnapshot = restoreTrustedSnapshot();
    usedTrustedFallback = Boolean(fallbackSnapshot);
    if (!usedTrustedFallback && (!existing.usable || (!existing.fresh && !allowStale))) {
      const relayState = writeRelayState({
        collectOk: false,
        collectSkipped: false,
        collectFailure,
        uploadOk: false,
        remote: null,
        usedTrustedFallback,
        fallbackSnapshot
      });
      const relayStateUpload = await uploadRelayState(relayState, "collect-failed-no-acceptable-snapshot");
      checks.push({
        name: "collect snapshot",
        ok: false,
        error: error.message || String(error),
        existing,
        relayStateUpload
      });
      if (tolerateCollectFailure) {
        console.log(JSON.stringify({
          ok: true,
          status: "watch",
          checkedAt: new Date().toISOString(),
          dryRun,
          validateOnly,
          runSync,
          baseUrl: baseUrlInput ? maskUrl(baseUrlInput).replace(/\/$/, "") : null,
          snapshotPath,
          uploaded: false,
          reason: "collect-failed-no-acceptable-snapshot",
          relayState,
          relayStateUpload,
          warnings: [{
            code: "relay-collector-waf-no-upload",
            message: "Sporttery relay collection failed and no uploadable snapshot is available; server fallback remains authoritative."
          }],
          checks
        }, null, 2));
        return;
      }
      throw new Error(`snapshot collection failed and no acceptable existing snapshot is available: ${JSON.stringify(existing)}`);
    }
    const warning = {
      code: "collector-failed-using-existing-snapshot",
      message: usedTrustedFallback
        ? "snapshot collection failed; using the latest trusted relay snapshot for upload"
        : "snapshot collection failed; using the existing acceptable relay snapshot for upload",
      error: error.message || String(error),
      existing,
      fallback: fallbackSnapshot
    };
    warnings.push(warning);
    checks.push({
      name: "collect snapshot",
      ok: true,
      status: existing.fresh ? "using-existing-fresh-snapshot" : "using-existing-stale-snapshot",
      collected: false,
      existingFresh: existing.fresh,
      existingAgeMinutes: existing.ageMinutes,
      allowStale,
      warning
    });
  }

  const activeSnapshotStatus = snapshotStatus(snapshotPath);
  const status = atomicUploadSnapshotPath
    ? snapshotStatus(atomicUploadSnapshotPath)
    : activeSnapshotStatus;
  checks.push({
    name: "snapshot usable",
    ok: status.usable,
    uploadSource: atomicUploadSnapshotPath ? "atomic-fast-lane" : "active-full",
    ...status
  });
  const snapshotFreshEnough = status.fresh || status.staleFallbackUsable || allowStale;
  const fullCollectionSucceeded = realFullCollectionSucceeded({
    cycleEvent: collectorCycleEvent,
    collectOk,
    collectSkipped,
    usedTrustedFallback
  });
  const staleTrustedFallback = Boolean(
    usedTrustedFallback
    && status.staleFallbackUsable
    && !status.fresh
    && !process.env.SPORTTERY_RELAY_UPLOAD_MODE
  );
  const effectiveUploadMode = resolveEffectiveUploadMode({
    requestedMode: uploadMode,
    sshUpload: useSshUpload,
    fullCollectionSucceeded,
    staleTrustedFallback
  });
  checks.push({
    name: "snapshot fresh",
    ok: snapshotFreshEnough,
    fresh: status.fresh,
    staleFallbackUsable: status.staleFallbackUsable,
    ageMinutes: status.ageMinutes,
    maxAgeMinutes: status.maxAgeMinutes,
    staleFallbackMaxAgeMinutes: status.staleFallbackMaxAgeMinutes,
    allowStale
  });
  if (effectiveUploadMode !== uploadMode) {
    checks.push({
      name: "upload mode adjusted",
      ok: true,
      uploadMode,
      effectiveUploadMode,
      reason: useSshUpload
        ? "SSH transport atomically replaces the source file, so it always uploads the complete trusted snapshot"
        : fullCollectionSucceeded
          ? "successful periodic full collection is uploaded in full over HTTP to restore and refresh every result/all archive page"
          : "stale trusted fallback snapshots are uploaded full so the server can validate the complete trusted payload"
    });
  }
  if (!status.usable) throw new Error(`Sporttery relay snapshot is not usable: ${JSON.stringify(status)}`);
  if (!snapshotFreshEnough) throw new Error(`Sporttery relay snapshot is stale beyond fallback window: ${JSON.stringify(status)}`);
  const relayStateBeforeUpload = buildRelayState({
    collectOk,
    collectSkipped,
    collectFailure,
    uploadOk: false,
    remote: null,
    usedTrustedFallback,
    fallbackSnapshot,
    uploadSnapshot: status
  });
  writeJson(relayStatePath, relayStateBeforeUpload);
  // The state embedded in the snapshot may safely anticipate a successful
  // upload: if the upload fails the snapshot is never promoted remotely, while
  // the local pre-upload state still records no upload success.
  const relayStateForUpload = (!dryRun && !validateOnly)
    ? buildRelayState({
        collectOk,
        collectSkipped,
        collectFailure,
        uploadOk: true,
        remote: null,
        usedTrustedFallback,
        fallbackSnapshot,
        uploadSnapshot: status
      })
    : relayStateBeforeUpload;
  const relayStatePreview = compactRelayStateForUpload(relayStateForUpload);

  if (!status.trusted && !atomicUploadSnapshotPath && !allowPartialLiveUpload) {
    const relayState = writeRelayState({
      collectOk,
      collectSkipped,
      collectFailure: collectFailure || {
        code: "partial-live-upload-disabled",
        message: "relay snapshot is below the trusted floor and SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD is not enabled",
        rows: status.rows || 0,
        usableEndpoints: status.usableEndpoints || 0,
        minTrustedRows,
        minTrustedEndpoints
      },
      uploadOk: false,
      remote: null,
      usedTrustedFallback,
      fallbackSnapshot,
      uploadSnapshot: status
    });
    const relayStateUpload = await uploadRelayState(relayState, "partial-live-upload-disabled");
    const warning = {
      code: "partial-live-upload-disabled",
      message: "Sporttery relay produced only a partial live/current snapshot; upload is disabled by default so the server keeps the last trusted fallback.",
      rows: status.rows || 0,
      usableEndpoints: status.usableEndpoints || 0,
      minTrustedRows,
      minTrustedEndpoints,
      enableWith: "SPORTTERY_RELAY_ALLOW_PARTIAL_LIVE_UPLOAD=1"
    };
    checks.push({
      name: "partial live upload disabled",
      ok: true,
      uploaded: false,
      relayStateUpload,
      warning
    });
    if (tolerateCollectFailure) {
      console.log(JSON.stringify({
        ok: true,
        status: "watch",
        checkedAt: new Date().toISOString(),
        dryRun,
        validateOnly,
        runSync,
        baseUrl: baseUrlInput ? maskUrl(baseUrlInput).replace(/\/$/, "") : null,
        snapshotPath,
        uploaded: false,
        reason: "partial-live-upload-disabled",
        relayState,
        relayStateUpload,
        warnings: [...warnings, warning],
        checks
      }, null, 2));
      return;
    }
    throw new Error(`partial live relay upload disabled: ${JSON.stringify(status)}`);
  }

  let upload = null;
  let uploadAccepted = false;
  let uploadedSnapshotStatus = status;
  let toleratedStaleFallbackUploadReject = false;
  let remoteAfterUploadReject = null;
  const atomicFastLanePublishable = shouldPublishAtomicFastLaneUpload({
    atomicUploadSnapshotPath,
    sshUpload: useSshUpload,
    validate: validateOnly,
    dry: dryRun
  });
  if (dryRun) {
    checks.push({ name: "upload skipped", ok: true, reason: "dry-run" });
  } else if (atomicFastLanePublishable) {
    if (!baseUrlInput) throw new Error("SPORTTERY_RELAY_PUSH_BASE_URL or FOOTBALL_CLOUD_API_BASE is required");
    if (!adminToken) throw new Error("SPORTTERY_RELAY_ADMIN_TOKEN or FOOTBALL_CLOUD_ADMIN_TOKEN is required");
    const fastLaneSnapshot = readJson(atomicUploadSnapshotPath);
    const fastLaneUploadMode = effectiveUploadMode === "current" ? "current" : "live";
    const preparedFastLane = snapshotForUpload(fastLaneSnapshot, fastLaneUploadMode);
    if (relayStatePreview) {
      preparedFastLane.snapshot.producer = {
        ...(preparedFastLane.snapshot.producer || {}),
        collectorState: relayStatePreview
      };
      preparedFastLane.snapshot.summary = {
        ...(preparedFastLane.snapshot.summary || {}),
        collector: {
          consecutiveCollectFailures: relayStatePreview.consecutiveCollectFailures,
          lastCollectFailedAt: relayStatePreview.lastCollectFailedAt,
          lastCollectOkAt: relayStatePreview.lastCollectOkAt
        }
      };
    }
    checks.push({
      name: "prepare atomic fast lane upload",
      ok: preparedFastLane.summary.uploadRows > 0,
      uploadSourcePath: atomicUploadSnapshotPath,
      ...preparedFastLane.summary
    });
    upload = await postJson("/api/admin/sporttery-relay-fast-lane?runSync=0", {
      snapshot: preparedFastLane.snapshot,
      collectorState: relayStatePreview,
      runSync: false
    });
    uploadAccepted = upload.ok
      && upload.status >= 200
      && upload.status < 300
      && upload.payload?.storedValidation?.ok === true;
    uploadedSnapshotStatus = snapshotStatus(atomicUploadSnapshotPath);
    checks.push({
      name: "remote upload atomic fast lane",
      ok: uploadAccepted,
      status: upload.status,
      validationRows: upload.payload?.storedValidation?.rows ?? null,
      usableEndpoints: upload.payload?.storedValidation?.usableEndpoints ?? null,
      provenanceMode: upload.payload?.storedValidation?.provenanceMode ?? null,
      fullSnapshotUntouched: upload.payload?.fullSnapshotUntouched === true,
      replacedPrevious: upload.payload?.replacedPrevious === true,
      error: upload.payload?.error || upload.text || null
    });
    if (!uploadAccepted) {
      throw new Error(`remote atomic fast lane upload failed: ${JSON.stringify(checks.at(-1))}`);
    }
  } else {
    if (!useSshUpload && !baseUrlInput) throw new Error("SPORTTERY_RELAY_PUSH_BASE_URL or FOOTBALL_CLOUD_API_BASE is required");
    if (!useSshUpload && !adminToken) throw new Error("SPORTTERY_RELAY_ADMIN_TOKEN or FOOTBALL_CLOUD_ADMIN_TOKEN is required");
    const uploadSourcePath = atomicUploadSnapshotPath && effectiveUploadMode !== "full"
      ? atomicUploadSnapshotPath
      : snapshotPath;
    const snapshot = readJson(uploadSourcePath);
    const uploadSnapshot = snapshotForUpload(snapshot, effectiveUploadMode);
    if (relayStatePreview) {
      uploadSnapshot.snapshot.producer = {
        ...(uploadSnapshot.snapshot.producer || {}),
        collectorState: relayStatePreview
      };
      uploadSnapshot.snapshot.summary = {
        ...(uploadSnapshot.snapshot.summary || {}),
        collector: {
          consecutiveCollectFailures: relayStatePreview.consecutiveCollectFailures,
          lastCollectFailedAt: relayStatePreview.lastCollectFailedAt,
          lastCollectOkAt: relayStatePreview.lastCollectOkAt
        }
      };
    }
    checks.push({
      name: "prepare upload snapshot",
      ok: uploadSnapshot.summary.mode === "full" || uploadSnapshot.summary.uploadRows > 0,
      uploadMode,
      uploadSourcePath,
      ...uploadSnapshot.summary
    });
    if (useSshUpload) {
      upload = await uploadSnapshotOverSsh(uploadSnapshot.snapshot);
    } else {
      const query = validateOnly ? "validateOnly=1" : `runSync=${runSync ? "1" : "0"}`;
      upload = await postJson(`/api/admin/sporttery-relay-snapshot?${query}`, {
        snapshot: uploadSnapshot.snapshot,
        collectorState: relayStatePreview,
        validateOnly,
        runSync
      });
    }
    uploadAccepted = upload.ok && upload.status >= 200 && upload.status < 300;
    if (!uploadAccepted && usedTrustedFallback && status.staleFallbackUsable && !validateOnly && verifyRemote) {
      remoteAfterUploadReject = await remoteHealthSummary();
      toleratedStaleFallbackUploadReject = upload.status === 400
        && remoteAfterUploadReject.recommendationReliable === true
        && remoteAfterUploadReject.currentReadSource === "sqlite";
      if (toleratedStaleFallbackUploadReject) {
        warnings.push({
          code: "stale-trusted-fallback-upload-rejected-remote-reliable",
          message: "server rejected a stale trusted relay snapshot, but the public runtime is still inside the reliable fallback window; collector state will still be uploaded",
          uploadStatus: upload.status,
          remote: remoteAfterUploadReject
        });
      }
    }
    checks.push({
      name: validateOnly ? "remote validate snapshot" : "remote upload snapshot",
      ok: uploadAccepted || toleratedStaleFallbackUploadReject,
      status: upload.status,
      toleratedStaleFallbackUploadReject,
      validationRows: upload.payload?.storedValidation?.rows ?? upload.payload?.validation?.rows ?? null,
      usableEndpoints: upload.payload?.storedValidation?.usableEndpoints ?? upload.payload?.validation?.usableEndpoints ?? null,
      syncOk: upload.payload?.sync?.ok ?? null,
      error: upload.payload?.error || upload.text || null
    });
    if (!uploadAccepted && !toleratedStaleFallbackUploadReject) {
      throw new Error(`remote relay upload failed: ${JSON.stringify(checks.at(-1))}`);
    }
  }

  let remote = null;
  if (verifyRemote && !validateOnly) {
    remote = remoteAfterUploadReject || await remoteHealthSummary();
    const remoteReachable = remote.healthStatus === 200 && remote.sourceHealthStatus === 200;
    const remoteHealthy = remote.ok === true && remote.currentReadSource === "sqlite" && remote.sourceHealthOk === true;
    if (remoteReachable && !remoteHealthy) {
      warnings.push({
        code: "remote-health-after-upload-watch",
        message: "relay upload succeeded but immediate remote health is not fully healthy; verifyCloudSyncFreshness owns the durable health gate",
        remote
      });
    }
    checks.push({
      name: "remote health after relay upload",
      ok: remoteReachable,
      required: false,
      healthy: remoteHealthy,
      ...remote
    });
  }

  const relayState = writeRelayState({
    collectOk,
    collectSkipped,
    collectFailure,
    uploadOk: uploadAccepted,
    remote,
    usedTrustedFallback,
    fallbackSnapshot,
    uploadSnapshot: uploadedSnapshotStatus
  });
  const relayStateUpload = await uploadRelayState(relayState, "post-snapshot-upload");
  if (relayStateUpload) {
    checks.push({
      name: "remote upload relay state",
      ok: relayStateUpload.ok,
      required: false,
      status: relayStateUpload.status,
      error: relayStateUpload.error
    });
  }

  const payload = {
    ok: requiredChecksOk(checks),
    status: warnings.length ? "watch" : "healthy",
    checkedAt: new Date().toISOString(),
    dryRun,
    validateOnly,
    runSync,
    uploadTransport,
    baseUrl: baseUrlInput ? maskUrl(baseUrlInput).replace(/\/$/, "") : null,
    snapshotPath,
    trustedSnapshotPath,
    snapshot: status,
    uploadMode: effectiveUploadMode,
    requestedUploadMode: uploadMode,
    usedTrustedFallback,
    fallbackSnapshot,
    relayState,
    upload: upload ? {
      status: upload.status,
      accepted: uploadAccepted,
      toleratedStaleFallbackUploadReject,
      validationRows: upload.payload?.storedValidation?.rows ?? upload.payload?.validation?.rows ?? null,
      usableEndpoints: upload.payload?.storedValidation?.usableEndpoints ?? upload.payload?.validation?.usableEndpoints ?? null,
      syncOk: upload.payload?.sync?.ok ?? null
    } : null,
    relayStateUpload,
    remote,
    warnings,
    checks
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
};

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      dryRun,
      validateOnly,
      runSync,
      baseUrl: baseUrlInput ? maskUrl(baseUrlInput).replace(/\/$/, "") : null,
      snapshotPath,
      error: error.message || String(error)
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  backoffCurrentLaneProbeMinutes,
  candidateDeadlineUrgencyFromEvaluation,
  effectiveWafProbePolicy,
  realFullCollectionSucceeded,
  relayFailureIsWafBlocked,
  nextBackoffCurrentLaneProbeAt,
  resolveEffectiveUploadMode,
  shouldAttemptBackoffCurrentLane,
  shouldPublishAtomicFastLaneUpload,
  snapshotForUpload,
  preserveAtomicTrustedSnapshotWithFastLane,
  relayPromotionAlreadyCurrent,
  snapshotFailureEvidence
};
