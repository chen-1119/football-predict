const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { acquireSyncLock } = require("../server/syncLock.cjs");
const { resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
const { readPointer, storePaths } = require("../server/dataGenerationStore.cjs");
const { apiFootballRuntimePolicyFor } = require("../src/services/apiFootballRuntimePolicy.cjs");
const { runFootballDataFixtureRetry } = require("./footballDataFixtureRetry.cjs");
const {
  evaluateReleaseEnrichmentReuseRequest,
  inspectReleaseWorkerPriorityRequest,
} = require("./releaseEnrichmentReuse.cjs");
const {
  captureFinalizationFor,
  decisionDeadlineFor,
} = require("./candidateProspectiveLedger.cjs");
const {
  candidateHeartbeatAttemptBudget,
  candidateHeartbeatPreemptiveSchedule,
} = require("../server/candidateHeartbeatSchedule.cjs");
const {
  exactHeartbeatMatches,
} = require("./runReleaseCandidateHeartbeatKeeper.cjs");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const rootDir = path.resolve(__dirname, "..");
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || process.env.DATA_STORE_DIR || path.join(rootDir, "server-data"));
const sqliteDbPath = path.resolve(process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
// The production service supplies both the environment flag and an explicit
// argv contract.  Keeping the CLI form makes the long-running role unambiguous
// even if an EnvironmentFile is replaced or reordered during a unit reload.
const loop = process.env.SYNC_WORKER_LOOP === "1" || process.argv.includes("--loop");
const statusOnly = process.env.SYNC_WORKER_STATUS_ONLY === "1" || process.argv.includes("--status");
const apiFootballRuntimePolicy = Object.freeze(apiFootballRuntimePolicyFor(process.env));
const finiteEnvNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const baseIntervalMs = Math.max(60, finiteEnvNumber("SYNC_INTERVAL_SECONDS", 300)) * 1000;
const hotIntervalMs = Math.max(60, finiteEnvNumber("HOT_SYNC_INTERVAL_SECONDS", 90)) * 1000;
const postDeadlineHotIntervalMs = Math.max(
  hotIntervalMs / 1000,
  finiteEnvNumber("POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS", 300),
) * 1000;
const hotWindowMinutes = Math.max(15, finiteEnvNumber("HOT_SYNC_WINDOW_MINUTES", 120));
const candidateDeadlineHotWindowMinutes = Math.max(
  15,
  finiteEnvNumber("CANDIDATE_DEADLINE_HOT_WINDOW_MINUTES", hotWindowMinutes),
);
const postKickoffHotWindowMinutes = Math.max(30, finiteEnvNumber("POST_KICKOFF_HOT_WINDOW_MINUTES", 180));
const minimumLoopIdleMs = Math.max(1000, finiteEnvNumber("SYNC_WORKER_MIN_IDLE_SECONDS", 5) * 1000);
const phaseLockWaitMs = Math.max(
  5_000,
  finiteEnvNumber("SYNC_WORKER_PHASE_LOCK_WAIT_MS", 30_000),
);
const slowPublicationLockWaitMs = Math.max(
  phaseLockWaitMs,
  finiteEnvNumber("SYNC_WORKER_SLOW_PUBLICATION_LOCK_WAIT_MS", 900_000),
);
// These enrichers read the active match set and rewrite shared evidence files.
// A background slow phase may overlap the next official cycle, so serialize
// only those evidence writers on their own lock. The official result lane never
// waits on that lock; its deterministic projections are retried by the final
// rebased slow publication when a background writer is busy.
const sharedSlowArtifactScripts = new Set([
  "sync:500",
  "sync:500:details",
  "sync:api-football",
  "sync:k-league-standings",
  "sync:weather",
  "sync:open-research",
  "sync:web-consensus",
  "sync:free-football",
  "sync:prematch",
]);
const usesSharedSlowArtifact = (script) => sharedSlowArtifactScripts.has(String(script || ""));
const sharedSlowArtifactLockDir = path.join(storeDir, "locks", "sync-enrichment-artifacts.lock");
const relaySnapshotPath = path.resolve(
  process.env.SPORTTERY_RELAY_SNAPSHOT || path.join(storeDir, "sporttery-relay-snapshot.json")
);
const relayFastLaneSnapshotPath = path.resolve(
  process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT || path.join(storeDir, "sporttery-relay-fast-lane.json")
);
const relayWakeEnabled = process.env.SYNC_WORKER_RELAY_WAKE_ENABLED !== "0";
const relayWakePollMs = Math.min(
  30,
  Math.max(1, finiteEnvNumber("SYNC_WORKER_RELAY_WAKE_POLL_SECONDS", 2))
) * 1000;
const syncWorkerEventPollMs = Math.max(500, finiteEnvNumber("SYNC_WORKER_EVENT_POLL_MS", 1000));
const fastEventVisibilityMs = Math.max(
  syncWorkerEventPollMs + 250,
  finiteEnvNumber("SYNC_WORKER_FAST_EVENT_VISIBILITY_MS", 1500)
);
const statusFile = path.join(storeDir, "sync-worker-status.json");
const modelBacktestStatusFile = path.join(storeDir, "model-backtest-sync-status.json");
const candidateProspectiveCaptureStatusFile = path.join(
  storeDir,
  "candidate-prospective-capture-status.json",
);
const candidateProspectiveCaptureAttemptStatusFile = path.join(
  storeDir,
  "candidate-prospective-capture-attempt-status.json",
);
const benchmarkProspectiveCaptureStatusFile = path.join(
  storeDir,
  "benchmark-prospective-capture-status.json",
);
const benchmarkProspectiveCaptureAttemptStatusFile = path.join(
  storeDir,
  "benchmark-prospective-capture-attempt-status.json",
);
const sqliteReadSourceEnabled = process.env.DATASTORE_READ_SOURCE === "sqlite" || process.env.CURRENT_MATCH_SOURCE === "sqlite";
const sqliteExportEnabled = process.env.ENABLE_SQLITE_EXPORT === "1" || sqliteReadSourceEnabled;
const modelBacktestOnSync = process.env.ENABLE_MODEL_BACKTEST_ON_SYNC === "1";
const modelBacktestMinIntervalMs = Math.max(5, Number(process.env.MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES || 120)) * 60 * 1000;
const modelBacktestForce = process.env.MODEL_BACKTEST_ON_SYNC_FORCE === "1";
const slowPhaseMinIntervalMs = Math.max(
  5,
  finiteEnvNumber("SYNC_WORKER_SLOW_PHASE_MIN_INTERVAL_MINUTES", 60),
) * 60 * 1000;
const candidateDeadlineCaptureEnabled =
  process.env.ENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE !== "0";
const candidateDeadlineCaptureIntervalMs = Math.max(
  15,
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_INTERVAL_SECONDS", 30),
) * 1000;
const candidateDeadlineCaptureTimeoutMs = Math.max(
  5_000,
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS", 100_000),
);
const candidateDeadlineCaptureRetryMs = Math.max(
  1_000,
  Math.min(
    candidateDeadlineCaptureIntervalMs,
    finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_RETRY_MS", 5_000),
  ),
);
const candidateDeadlineHeartbeatFreshnessLimitMs = 180_000;
const candidateDeadlineCaptureRecoveryBudgetMs = Math.max(
  1_000,
  Math.min(
    candidateDeadlineCaptureTimeoutMs,
    finiteEnvNumber(
      "CANDIDATE_PROSPECTIVE_CAPTURE_RECOVERY_BUDGET_MS",
      55_000,
    ),
  ),
);
const candidateDeadlineCaptureSafetyMarginMs = Math.max(
  0,
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_SAFETY_MARGIN_MS", 10_000),
);
// `candidateDeadlineCaptureTimeoutMs` is an end-to-end attempt budget, not
// merely the child execution timer.  Keeping the normal 10s/10s command
// shutdown defaults here would make a nominal 45s attempt consume as much as
// 65s before the recovery attempt can start, invalidating the heartbeat
// proof.  Bound shutdown inside the advertised attempt budget instead.
const candidateDeadlineCaptureTerminateGraceMs = Math.max(
  50,
  Math.min(
    1_000,
    finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_TERMINATE_GRACE_MS", 500),
  ),
);
const candidateDeadlineCaptureForceSettleMs = Math.max(
  50,
  Math.min(
    1_000,
    finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_FORCE_SETTLE_MS", 500),
  ),
);
const candidateDeadlinePreemptiveSchedule = (evaluatedAt, nowMs = Date.now()) => (
  candidateHeartbeatPreemptiveSchedule({
    evaluatedAt,
    nowMs,
    freshnessLimitMs: candidateDeadlineHeartbeatFreshnessLimitMs,
    attemptTimeoutMs: candidateDeadlineCaptureTimeoutMs,
    retryMs: candidateDeadlineCaptureRetryMs,
    recoveryCaptureMs: candidateDeadlineCaptureRecoveryBudgetMs,
    safetyMarginMs: candidateDeadlineCaptureSafetyMarginMs,
  })
);
const candidateDeadlineAttemptBudget = ({
  evaluatedAt,
  nowMs = Date.now(),
  recoveryAttempt = false,
} = {}) => candidateHeartbeatAttemptBudget({
  evaluatedAt,
  nowMs,
  recoveryAttempt,
  freshnessLimitMs: candidateDeadlineHeartbeatFreshnessLimitMs,
  attemptTimeoutMs: candidateDeadlineCaptureTimeoutMs,
  retryMs: candidateDeadlineCaptureRetryMs,
  recoveryCaptureMs: candidateDeadlineCaptureRecoveryBudgetMs,
  safetyMarginMs: candidateDeadlineCaptureSafetyMarginMs,
});
const candidateDeadlineStartupSafetyWindowMs = Math.max(
  candidateDeadlineHeartbeatFreshnessLimitMs,
  candidateDeadlineCaptureTimeoutMs
    + candidateDeadlineCaptureRetryMs
    + candidateDeadlineCaptureRecoveryBudgetMs
    + candidateDeadlineCaptureSafetyMarginMs,
);
const candidateDeadlineCaptureScript = path.join(
  rootDir,
  "scripts",
  "captureCandidateProspectiveDeadline.cjs",
);
const benchmarkDeadlineCaptureEnabled =
  process.env.ENABLE_BENCHMARK_PROSPECTIVE_DEADLINE_CAPTURE !== "0";
const benchmarkDeadlineCaptureIntervalMs = Math.min(
  300,
  Math.max(
    60,
    finiteEnvNumber("BENCHMARK_PROSPECTIVE_CAPTURE_INTERVAL_SECONDS", 240),
  ),
) * 1000;
const benchmarkDeadlineCaptureTimeoutMs = Math.max(
  10_000,
  Math.min(
    benchmarkDeadlineCaptureIntervalMs - 10_000,
    finiteEnvNumber("BENCHMARK_PROSPECTIVE_CAPTURE_TIMEOUT_MS", 180_000),
  ),
);
const footballDataFixturesStatusFile = path.join(
  storeDir,
  "training",
  "raw",
  "football-data",
  "fixtures",
  "status.json"
);
const footballDataFixturesMinIntervalMs = Math.max(
  30,
  finiteEnvNumber("FOOTBALL_DATA_FIXTURES_MIN_INTERVAL_MINUTES", 360)
) * 60 * 1000;
const footballDataResultsStatusFile = path.join(
  storeDir,
  "training",
  "raw",
  "football-data",
  "sync-status.json"
);
const footballDataResultsMinIntervalMs = Math.max(
  60,
  finiteEnvNumber("FOOTBALL_DATA_RESULTS_MIN_INTERVAL_MINUTES", 720)
) * 60 * 1000;
// Daily enrichment follows the live season. The standalone historical-download
// CLI deliberately keeps its previous-season default and explicit overrides.
const footballDataResultsWorkerEnv = (env = process.env) => ({
  FOOTBALL_DATA_RESULTS_SEASON: env.FOOTBALL_DATA_RESULTS_SEASON || "current",
});
const webConsensusRefreshMs = Math.max(
  5,
  finiteEnvNumber("WEB_CONSENSUS_REFRESH_MINUTES", 30)
) * 60 * 1000;
const webConsensusOutputFile = path.join(rootDir, "public", "data", "web-consensus-signals.json");
const webConsensusInputFiles = [
  path.join(rootDir, "server-data", "web-consensus", "open-research-insights.json"),
  path.join(rootDir, "server-data", "web-consensus", "manual-insights.json"),
  path.join(rootDir, "public", "data", "web-consensus-input.json"),
];
const modelCoverageMinRatio = Math.min(1, Math.max(0.5, Number(
  process.env.MODEL_EVALUATION_SQLITE_COVERAGE_MIN
    || process.env.CLOUD_SYNC_MODEL_SQLITE_COVERAGE_MIN
    || 0.95
)));
const modelCoverageTriggerRatio = Math.min(1, Math.max(modelCoverageMinRatio, Number(
  process.env.MODEL_BACKTEST_SQLITE_COVERAGE_TRIGGER_RATIO
    || (modelCoverageMinRatio + 0.03)
)));
const configuredTimeout = (name, fallbackMs) => {
  const value = Number(process.env[name]);
  return Math.max(10_000, Number.isFinite(value) && value > 0 ? value : fallbackMs);
};
const commandTimeoutMs = configuredTimeout("SYNC_WORKER_COMMAND_TIMEOUT_MS", 15 * 60 * 1000);
const commandTerminateGraceMs = configuredTimeout("SYNC_WORKER_TERMINATE_GRACE_MS", 10_000);
const commandForceSettleMs = configuredTimeout("SYNC_WORKER_FORCE_SETTLE_MS", 10_000);
// The deadline heartbeat is intentionally independent from the long-running
// model backtest. Its child may hold the candidate registry lock until the
// bounded capture timeout (plus termination/settlement grace), so the
// backtest's short default lock wait is not sufficient. Give only the
// candidate-registry commit a bounded handoff window; the overall model
// command remains protected by commandTimeouts.model.
const candidateRegistryLockHandoffGraceMs = Math.max(
  5_000,
  finiteEnvNumber("SYNC_WORKER_MODEL_CANDIDATE_LOCK_HANDOFF_GRACE_MS", 5_000),
);
const modelCandidateRegistryLockTimeoutMs = Math.max(
  candidateDeadlineCaptureTimeoutMs
    + commandTerminateGraceMs
    + commandForceSettleMs
    + candidateRegistryLockHandoffGraceMs,
  finiteEnvNumber("SYNC_WORKER_MODEL_CANDIDATE_LOCK_TIMEOUT_MS", 0),
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT_MS", 0),
);
const commandTimeouts = {
  resultFallback: configuredTimeout(
    "SYNC_WORKER_500_RESULT_TIMEOUT_MS",
    Math.min(commandTimeoutMs, 20_000)
  ),
  enrichment: configuredTimeout("SYNC_WORKER_ENRICHMENT_TIMEOUT_MS", Math.min(commandTimeoutMs, 5 * 60 * 1000)),
  sync: configuredTimeout("SYNC_WORKER_SYNC_TIMEOUT_MS", Math.min(commandTimeoutMs, 10 * 60 * 1000)),
  validation: configuredTimeout("SYNC_WORKER_VALIDATION_TIMEOUT_MS", Math.min(commandTimeoutMs, 3 * 60 * 1000)),
  sqlite: configuredTimeout("SYNC_WORKER_SQLITE_TIMEOUT_MS", Math.min(commandTimeoutMs, 10 * 60 * 1000)),
  model: configuredTimeout("SYNC_WORKER_MODEL_TIMEOUT_MS", commandTimeoutMs)
};
const releaseCycleInitialLockWaitMs = Math.min(
  120_000,
  Math.max(
    phaseLockWaitMs,
    finiteEnvNumber("SYNC_WORKER_RELEASE_INITIAL_LOCK_WAIT_MS", 60_000),
  ),
);
const releaseCycleRetryMs = Math.max(
  1_000,
  Math.min(30_000, finiteEnvNumber("SYNC_WORKER_RELEASE_RETRY_MS", 5_000)),
);
const releaseSlowPhaseDrainBudgetMs = Math.max(
  5_000,
  finiteEnvNumber("SYNC_WORKER_RELEASE_SLOW_PHASE_DRAIN_BUDGET_MS", 120_000),
);
const shutdownDrainBudgetMs = Math.max(
  5_000,
  finiteEnvNumber("SYNC_WORKER_SHUTDOWN_DRAIN_BUDGET_MS", 30_000),
);
const interruptibleLockWaitSliceMs = Math.max(
  250,
  Math.min(5_000, finiteEnvNumber("SYNC_WORKER_INTERRUPTIBLE_LOCK_WAIT_SLICE_MS", 1_000)),
);

const terminateChildTree = (child, signal = "SIGTERM") => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") taskkillArgs.push("/F");
    try {
      const killer = spawn("taskkill", taskkillArgs, {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.unref();
      return true;
    } catch {
      return child.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    }
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
};

const createWorkerInterruptedError = (request = null) => {
  const signal = request?.signal || "shutdown";
  const error = new Error(`sync worker interrupted by ${signal}`);
  error.code = "SYNC_WORKER_INTERRUPTED";
  error.signal = request?.signal || null;
  error.requestedAt = request?.requestedAt || null;
  return error;
};

const createWorkerShutdownController = ({
  terminate = terminateChildTree,
  timer = setTimeout,
  clearTimer = clearTimeout,
  now = () => new Date().toISOString(),
  terminateGraceMs = commandTerminateGraceMs,
} = {}) => {
  const activeChildren = new Set();
  let request = null;
  let forceTimer = null;
  let resolveWake = null;
  const wakePromise = new Promise((resolve) => {
    resolveWake = resolve;
  });
  const clearForceTimer = () => {
    if (!forceTimer) return;
    clearTimer(forceTimer);
    forceTimer = null;
  };
  const scheduleForceKill = () => {
    clearForceTimer();
    if (activeChildren.size === 0) return;
    forceTimer = timer(() => {
      forceTimer = null;
      for (const child of activeChildren) terminate(child, "SIGKILL");
    }, Math.max(1, Number(terminateGraceMs) || 1));
    forceTimer?.unref?.();
  };
  return {
    get requested() { return request !== null; },
    get request() { return request; },
    get activeCount() { return activeChildren.size; },
    wakePromise,
    register(child) {
      if (!child) return;
      activeChildren.add(child);
      if (request) {
        terminate(child, "SIGTERM");
        scheduleForceKill();
      }
    },
    unregister(child) {
      activeChildren.delete(child);
      if (activeChildren.size === 0) clearForceTimer();
    },
    requestShutdown(signal = "SIGTERM") {
      if (request) return request;
      request = {
        signal: String(signal || "SIGTERM"),
        requestedAt: now(),
      };
      resolveWake?.({ reason: "worker-shutdown-requested", ...request });
      for (const child of activeChildren) terminate(child, "SIGTERM");
      scheduleForceKill();
      return request;
    },
    interruptionError() {
      return createWorkerInterruptedError(request);
    },
    dispose() {
      clearForceTimer();
    },
  };
};

const runtimeShutdownController = createWorkerShutdownController();

const commandTimeoutError = (command, args, timeoutMs) => {
  const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
  error.code = "SYNC_WORKER_COMMAND_TIMEOUT";
  error.command = command;
  error.args = args;
  error.timeoutMs = timeoutMs;
  return error;
};

const runCommand = (command, args, extraEnv = {}, options = {}) => {
  if (runtimeShutdownController.requested) {
    return Promise.reject(runtimeShutdownController.interruptionError());
  }
  return new Promise((resolve, reject) => {
  const startedAt = new Date().toISOString();
  const timeoutMs = Math.max(1, Number(options.timeoutMs || commandTimeoutMs));
  const terminateGraceMs = Math.max(1, Number(options.terminateGraceMs || commandTerminateGraceMs));
  const forceSettleMs = Math.max(1, Number(options.forceSettleMs || commandForceSettleMs));
  const useShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command));
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    shell: useShell,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: options.stdio || "inherit"
  });
  runtimeShutdownController.register(child);
  let settled = false;
  let timedOut = false;
  let timeoutTimer = null;
  let terminateTimer = null;
  let forceSettleTimer = null;
  let timeoutError = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearTimeout(terminateTimer);
    clearTimeout(forceSettleTimer);
    runtimeShutdownController.unregister(child);
    callback(value);
  };
  timeoutTimer = setTimeout(() => {
    timedOut = true;
    timeoutError = commandTimeoutError(command, args, timeoutMs);
    terminateChildTree(child, "SIGTERM");
    terminateTimer = setTimeout(() => {
      terminateChildTree(child, "SIGKILL");
      forceSettleTimer = setTimeout(() => finish(reject, timeoutError), forceSettleMs);
    }, terminateGraceMs);
  }, timeoutMs);
  child.on("error", (error) => finish(reject, timedOut ? timeoutError : error));
  child.on("exit", (code, signal) => {
    const finishedAt = new Date().toISOString();
    if (timedOut) {
      timeoutError.signal = signal || null;
      timeoutError.exitCode = code;
      finish(reject, timeoutError);
      return;
    }
    if (code === 0) {
      finish(resolve, { ok: true, command, args, startedAt, finishedAt });
      return;
    }
    const error = new Error(`${command} ${args.join(" ")} exited with ${code}${signal ? ` (${signal})` : ""}`);
    error.code = "SYNC_WORKER_COMMAND_FAILED";
    error.command = command;
    error.args = args;
    error.exitCode = code;
    error.signal = signal || null;
    finish(reject, error);
  });
  });
};

let candidateDeadlineCaptureInFlight = false;

const writeCandidateDeadlineCaptureAttempt = (payload) => {
  try {
    return writeJsonAtomic(candidateProspectiveCaptureAttemptStatusFile, {
      version: "candidate-prospective-capture-attempt-v1",
      ...payload,
    });
  } catch {
    // Attempt telemetry must never mutate the cutoff ledger or turn a
    // successfully published formal heartbeat into a failed capture.
    return null;
  }
};

const candidateDeadlineCaptureStatusAdvanced = (result, status) => {
  const startedAtMs = Date.parse(result?.startedAt || "");
  const evaluatedAtMs = Date.parse(status?.evaluatedAt || "");
  return Boolean(
    result?.ok === true
    && Number.isFinite(startedAtMs)
    && Number.isFinite(evaluatedAtMs)
    && evaluatedAtMs >= startedAtMs
    && exactHeartbeatMatches(status, status.evaluatedAt)
  );
};

const runCandidateProspectiveDeadlineCapture = async ({
  timeoutMs = candidateDeadlineCaptureTimeoutMs,
  attemptKind = "scheduled",
  run = runCommand,
  readStatus = () => readJson(candidateProspectiveCaptureStatusFile, null),
  writeAttempt = writeCandidateDeadlineCaptureAttempt,
} = {}) => {
  if (!candidateDeadlineCaptureEnabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (candidateDeadlineCaptureInFlight) {
    return { ok: true, skipped: true, reason: "capture-already-running" };
  }
  candidateDeadlineCaptureInFlight = true;
  const attemptStartedAt = new Date().toISOString();
  const boundedTimeoutMs = Math.max(
    1_000,
    Math.min(candidateDeadlineCaptureTimeoutMs, Number(timeoutMs || 0)),
  );
  const attemptTerminateGraceMs = Math.min(
    candidateDeadlineCaptureTerminateGraceMs,
    Math.max(1, Math.floor((boundedTimeoutMs - 1) / 2)),
  );
  const attemptForceSettleMs = Math.min(
    candidateDeadlineCaptureForceSettleMs,
    Math.max(1, boundedTimeoutMs - attemptTerminateGraceMs - 1),
  );
  const childExecutionTimeoutMs = Math.max(
    1,
    boundedTimeoutMs
      - attemptTerminateGraceMs
      - attemptForceSettleMs,
  );
  try {
    const result = await run(
      process.execPath,
      [candidateDeadlineCaptureScript, "--deadline-only"],
      {
        SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        DATASTORE_SQLITE_PATH: process.env.DATASTORE_SQLITE_PATH || sqliteDbPath,
      },
      {
        timeoutMs: childExecutionTimeoutMs,
        terminateGraceMs: attemptTerminateGraceMs,
        forceSettleMs: attemptForceSettleMs,
        stdio: "ignore",
      },
    );
    const status = readStatus();
    if (!candidateDeadlineCaptureStatusAdvanced(result, status)) {
      const failed = {
        ...result,
        ok: false,
        skipped: false,
        reason: "candidate-deadline-capture-status-not-advanced",
        statusAdvanced: false,
        statusEvaluatedAt: status?.evaluatedAt || null,
      };
      writeAttempt({
        startedAt: result.startedAt || attemptStartedAt,
        finishedAt: result.finishedAt || new Date().toISOString(),
        ok: false,
        skipped: false,
        reason: failed.reason,
        statusAdvanced: false,
        publishedEvaluatedAt: failed.statusEvaluatedAt,
        attemptKind,
        timeoutMs: boundedTimeoutMs,
        childExecutionTimeoutMs,
        terminateGraceMs: attemptTerminateGraceMs,
        forceSettleMs: attemptForceSettleMs,
      });
      return failed;
    }
    const completed = {
      ...result,
      statusAdvanced: true,
      statusEvaluatedAt: status.evaluatedAt,
    };
    writeAttempt({
      startedAt: result.startedAt || attemptStartedAt,
      finishedAt: result.finishedAt || new Date().toISOString(),
      ok: true,
      skipped: false,
      reason: status.reason || "candidate-deadline-capture-status-advanced",
      statusAdvanced: true,
      publishedEvaluatedAt: status.evaluatedAt,
      attemptKind,
      timeoutMs: boundedTimeoutMs,
      childExecutionTimeoutMs,
      terminateGraceMs: attemptTerminateGraceMs,
      forceSettleMs: attemptForceSettleMs,
      captureDurationMs: Number.isFinite(Number(status.captureDurationMs))
        ? Number(status.captureDurationMs)
        : null,
    });
    return completed;
  } catch (error) {
    const observedStatus = readStatus();
    const observedEvaluatedAtMs = Date.parse(observedStatus?.evaluatedAt || "");
    const attemptStartedAtMs = Date.parse(attemptStartedAt);
    const statusAdvanced = candidateDeadlineCaptureStatusAdvanced({
      ok: true,
      startedAt: attemptStartedAt,
    }, observedStatus);
    const failed = {
      ok: false,
      skipped: false,
      reason: "candidate-deadline-capture-failed",
      error: error?.message || String(error),
      errorCode: error?.code || null,
      exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
      signal: error?.signal || null,
      statusAdvanced,
      statusEvaluatedAt: observedStatus?.evaluatedAt || null,
      publishedStatusReason: observedStatus?.reason || null,
      publishedStatusOk:
        typeof observedStatus?.ok === "boolean" ? observedStatus.ok : null,
    };
    writeAttempt({
      startedAt: attemptStartedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      skipped: false,
      reason: failed.reason,
      statusAdvanced,
      publishedEvaluatedAt: failed.statusEvaluatedAt,
      publishedStatusReason: failed.publishedStatusReason,
      publishedStatusOk: failed.publishedStatusOk,
      error: failed.error,
      errorCode: failed.errorCode,
      exitCode: failed.exitCode,
      signal: failed.signal,
      attemptKind,
      timeoutMs: boundedTimeoutMs,
      childExecutionTimeoutMs,
      terminateGraceMs: attemptTerminateGraceMs,
      forceSettleMs: attemptForceSettleMs,
    });
    return failed;
  } finally {
    candidateDeadlineCaptureInFlight = false;
  }
};

const startCandidateProspectiveDeadlineHeartbeat = ({
  retryMs = candidateDeadlineCaptureRetryMs,
  run = runCandidateProspectiveDeadlineCapture,
  readStatus = () => readJson(candidateProspectiveCaptureStatusFile, null),
  now = Date.now,
  scheduleFor = candidateDeadlinePreemptiveSchedule,
  budgetFor = candidateDeadlineAttemptBudget,
  timer = setTimeout,
  clearTimer = clearTimeout,
  retryTimer = setTimeout,
  clearRetryTimer = clearTimeout,
  immediate = true,
} = {}) => {
  if (!candidateDeadlineCaptureEnabled) return null;
  const boundedRetryMs = Math.max(
    1_000,
    Math.min(candidateDeadlineHeartbeatFreshnessLimitMs, Number(retryMs || 0)),
  );
  let normalHandle = null;
  let retryHandle = null;
  let stopped = false;
  let paused = false;
  let nextRunAt = null;
  let lastSchedule = null;
  let inFlightTick = null;
  let lastResult = null;
  let resolveFirstPublication = null;
  let resolveFirstStartupAdmission = null;
  const firstPublication = new Promise((resolve) => {
    resolveFirstPublication = resolve;
  });
  const firstStartupAdmission = new Promise((resolve) => {
    resolveFirstStartupAdmission = resolve;
  });
  const exactPublishedStatus = ({ requireFresh = true } = {}) => {
    const status = readStatus();
    const expectedEvaluatedAt = status?.evaluatedAt || null;
    return {
      status,
      exact: Boolean(
        expectedEvaluatedAt
        && exactHeartbeatMatches(status, expectedEvaluatedAt, {
          requireFresh,
          nowMs: now(),
          maxAgeMs: candidateDeadlineHeartbeatFreshnessLimitMs,
        })
      ),
    };
  };
  const clearNormal = () => {
    if (normalHandle === null) return;
    clearTimer(normalHandle);
    normalHandle = null;
  };
  const clearRetry = () => {
    if (retryHandle === null) return;
    clearRetryTimer(retryHandle);
    retryHandle = null;
  };
  const scheduleNormal = (evaluatedAt = readStatus()?.evaluatedAt || null) => {
    if (stopped || paused) return null;
    clearNormal();
    const plan = scheduleFor(evaluatedAt, now());
    lastSchedule = plan;
    nextRunAt = plan.dueAt;
    normalHandle = timer(() => {
      normalHandle = null;
      nextRunAt = null;
      return tick({ recoveryAttempt: false });
    }, plan.delayMs);
    // An unresolved Promise does not keep Node alive.  Before the first exact
    // heartbeat is published, the scheduled retry is therefore the worker's
    // startup liveness handle and must remain referenced.  Later cadence
    // timers stay unref'ed so normal shutdown is still prompt.
    if (!resolveFirstPublication && typeof normalHandle?.unref === "function") {
      normalHandle.unref();
    }
    return plan;
  };
  const scheduleRetry = () => {
    if (stopped || paused || retryHandle !== null) return;
    clearNormal();
    nextRunAt = new Date(now() + boundedRetryMs).toISOString();
    retryHandle = retryTimer(() => {
      retryHandle = null;
      nextRunAt = null;
      return tick({ recoveryAttempt: true });
    }, boundedRetryMs);
    if (!resolveFirstPublication && typeof retryHandle?.unref === "function") {
      retryHandle.unref();
    }
  };
  const tick = ({ recoveryAttempt = false } = {}) => {
    if (paused) {
      return Promise.resolve({
        ok: true,
        skipped: true,
        reason: "candidate-deadline-heartbeat-paused",
      });
    }
    if (inFlightTick) return inFlightTick;
    clearNormal();
    const publishedStatus = readStatus();
    const budget = budgetFor({
      evaluatedAt: publishedStatus?.evaluatedAt || null,
      nowMs: now(),
      recoveryAttempt,
    });
    const pending = Promise.resolve()
    .then(() => run({
      timeoutMs: budget.timeoutMs,
      attemptKind: recoveryAttempt ? "preemptive-recovery" : "preemptive-primary",
      budget,
    }))
    .then((result) => {
      const published = exactPublishedStatus();
      const exactResult = Boolean(
        result?.ok === true
        && result?.skipped !== true
        && typeof result?.statusEvaluatedAt === "string"
        && result.statusEvaluatedAt === published.status?.evaluatedAt
        && published.exact
      );
      if (exactResult) {
        lastResult = result;
        if (resolveFirstPublication) {
          resolveFirstPublication(result);
          resolveFirstPublication = null;
        }
        if (resolveFirstStartupAdmission) {
          resolveFirstStartupAdmission({
            kind: "exact-heartbeat",
            recoveryRequired: false,
            result,
            status: published.status,
          });
          resolveFirstStartupAdmission = null;
        }
        clearRetry();
        scheduleNormal(result.statusEvaluatedAt || readStatus()?.evaluatedAt || null);
      } else {
        if (
          resolveFirstStartupAdmission
          && candidateImplementationDriftAwaitingRefreeze(published.status)
        ) {
          resolveFirstStartupAdmission({
            kind: "implementation-drift-refreeze",
            recoveryRequired: true,
            result,
            status: published.status,
          });
          resolveFirstStartupAdmission = null;
        }
        lastResult = {
          ...result,
          ok: false,
          skipped: false,
          reason: result?.reason || "candidate-deadline-heartbeat-exact-status-invalid",
          exactStatusValid: false,
          observedEvaluatedAt: published.status?.evaluatedAt || null,
        };
        scheduleRetry();
      }
      return lastResult;
    })
    .catch((error) => {
      lastResult = {
        ok: false,
        skipped: false,
        reason: "candidate-deadline-capture-run-rejected",
        error: error?.message || String(error),
      };
      scheduleRetry();
      return lastResult;
    })
    .finally(() => {
      if (inFlightTick === pending) inFlightTick = null;
    });
    inFlightTick = pending;
    return pending;
  };
  if (immediate) void tick();
  else scheduleNormal();
  return {
    get handle() { return normalHandle || retryHandle; },
    tick,
    intervalMs: candidateDeadlineCaptureIntervalMs,
    retryMs: boundedRetryMs,
    get nextRunAt() { return nextRunAt; },
    get schedule() { return lastSchedule; },
    get inFlight() { return inFlightTick !== null; },
    get paused() { return paused; },
    get lastResult() { return lastResult; },
    waitForIdle: () => inFlightTick || Promise.resolve(lastResult),
    waitForPublished: () => firstPublication,
    waitForStartupAdmission: () => firstStartupAdmission,
    waitForHealthy: async ({ allowImplementationDrift = false } = {}) => {
      if (inFlightTick) await inFlightTick;
      let published = exactPublishedStatus();
      if (published.exact) return published.status;
      if (
        allowImplementationDrift
        && candidateImplementationDriftAwaitingRefreeze(published.status)
      ) {
        return {
          ...published.status,
          exact: false,
          recoveryRequired: true,
        };
      }
      const recovery = await tick({ recoveryAttempt: true });
      published = exactPublishedStatus();
      if (recovery?.ok === true && published.exact) return published.status;
      if (
        allowImplementationDrift
        && candidateImplementationDriftAwaitingRefreeze(published.status)
      ) {
        return {
          ...published.status,
          exact: false,
          recoveryRequired: true,
        };
      }
      const error = new Error(
        `candidate deadline heartbeat is not exact: ${recovery?.reason || "status-invalid"}`,
      );
      error.code = "CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT";
      error.capture = recovery || null;
      error.statusEvaluatedAt = published.status?.evaluatedAt || null;
      throw error;
    },
    pause: () => {
      paused = true;
      clearNormal();
      clearRetry();
    },
    resume: () => {
      if (stopped || !paused) return null;
      paused = false;
      return scheduleNormal();
    },
    stop: () => {
      stopped = true;
      paused = true;
      clearNormal();
      clearRetry();
    },
  };
};

let benchmarkDeadlineCaptureInFlight = false;

const benchmarkDeadlineCaptureStatusAdvanced = (result, status) => {
  const startedAtMs = Date.parse(result?.startedAt || "");
  const evaluatedAtMs = Date.parse(status?.evaluatedAt || "");
  return Boolean(
    result?.ok === true
    && status?.version === "goodwin-benchmark-deadline-capture-v1"
    && status?.captureMode === "benchmark-only"
    && status?.ok === true
    && status?.skipped === false
    && Array.isArray(status?.blockers)
    && status.blockers.length === 0
    && Number.isFinite(startedAtMs)
    && Number.isFinite(evaluatedAtMs)
    && evaluatedAtMs >= startedAtMs
  );
};

const writeBenchmarkDeadlineCaptureAttempt = (payload) => {
  try {
    return writeJsonAtomic(benchmarkProspectiveCaptureAttemptStatusFile, {
      version: "benchmark-prospective-capture-attempt-v1",
      ...payload,
    });
  } catch {
    return null;
  }
};

const runBenchmarkProspectiveDeadlineCapture = async ({
  timeoutMs = benchmarkDeadlineCaptureTimeoutMs,
  run = runCommand,
  readStatus = () => readJson(benchmarkProspectiveCaptureStatusFile, null),
  writeAttempt = writeBenchmarkDeadlineCaptureAttempt,
} = {}) => {
  if (!benchmarkDeadlineCaptureEnabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (benchmarkDeadlineCaptureInFlight) {
    return { ok: true, skipped: true, reason: "benchmark-capture-already-running" };
  }
  benchmarkDeadlineCaptureInFlight = true;
  const attemptStartedAt = new Date().toISOString();
  const boundedTimeoutMs = Math.max(
    1_000,
    Math.min(benchmarkDeadlineCaptureTimeoutMs, Number(timeoutMs || 0)),
  );
  try {
    const result = await run(
      process.execPath,
      [candidateDeadlineCaptureScript, "--benchmark-only"],
      {
        SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        DATASTORE_SQLITE_PATH: process.env.DATASTORE_SQLITE_PATH || sqliteDbPath,
      },
      {
        timeoutMs: boundedTimeoutMs,
        stdio: "ignore",
      },
    );
    const status = readStatus();
    if (!benchmarkDeadlineCaptureStatusAdvanced(result, status)) {
      const failed = {
        ...result,
        ok: false,
        skipped: false,
        reason: "benchmark-deadline-capture-status-not-advanced",
        statusEvaluatedAt: status?.evaluatedAt || null,
      };
      writeAttempt({
        startedAt: result.startedAt || attemptStartedAt,
        finishedAt: result.finishedAt || new Date().toISOString(),
        ok: false,
        skipped: false,
        reason: failed.reason,
        publishedEvaluatedAt: failed.statusEvaluatedAt,
        timeoutMs: boundedTimeoutMs,
      });
      return failed;
    }
    const completed = {
      ...result,
      script: "candidate:benchmark-deadline-capture",
      statusEvaluatedAt: status.evaluatedAt,
      dueMatches: Number(status.dueMatches || 0),
      eventsAdded: Number(status.eventsAdded || 0),
    };
    writeAttempt({
      startedAt: result.startedAt || attemptStartedAt,
      finishedAt: result.finishedAt || new Date().toISOString(),
      ok: true,
      skipped: false,
      reason: status.reason || "benchmark-deadline-capture-advanced",
      publishedEvaluatedAt: status.evaluatedAt,
      timeoutMs: boundedTimeoutMs,
      dueMatches: completed.dueMatches,
      eventsAdded: completed.eventsAdded,
    });
    return completed;
  } catch (error) {
    const failed = {
      ok: false,
      skipped: false,
      script: "candidate:benchmark-deadline-capture",
      reason: "benchmark-deadline-capture-failed",
      error: error?.message || String(error),
      errorCode: error?.code || null,
      timeoutMs: boundedTimeoutMs,
    };
    writeAttempt({
      startedAt: attemptStartedAt,
      finishedAt: new Date().toISOString(),
      ...failed,
    });
    return failed;
  } finally {
    benchmarkDeadlineCaptureInFlight = false;
  }
};

const startBenchmarkProspectiveDeadlineCapture = ({
  intervalMs = benchmarkDeadlineCaptureIntervalMs,
  run = runBenchmarkProspectiveDeadlineCapture,
  now = Date.now,
  timer = setTimeout,
  clearTimer = clearTimeout,
  immediate = true,
} = {}) => {
  if (!benchmarkDeadlineCaptureEnabled) return null;
  const boundedIntervalMs = Math.min(300_000, Math.max(60_000, Number(intervalMs || 0)));
  let handle = null;
  let inFlightTick = null;
  let stopped = false;
  let paused = false;
  let lastResult = null;
  let nextRunAt = null;
  const clear = () => {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
  };
  const schedule = (attemptStartedAtMs = now()) => {
    if (stopped || paused) return;
    clear();
    const delayMs = Math.max(0, attemptStartedAtMs + boundedIntervalMs - now());
    nextRunAt = new Date(now() + delayMs).toISOString();
    handle = timer(() => {
      handle = null;
      nextRunAt = null;
      return tick();
    }, delayMs);
    handle?.unref?.();
  };
  const tick = () => {
    if (stopped || paused) {
      return Promise.resolve({ ok: true, skipped: true, reason: "benchmark-heartbeat-paused" });
    }
    if (inFlightTick) return inFlightTick;
    clear();
    const attemptStartedAtMs = now();
    const pending = Promise.resolve()
      .then(() => run({ timeoutMs: benchmarkDeadlineCaptureTimeoutMs }))
      .then((result) => {
        lastResult = result;
        schedule(attemptStartedAtMs);
        return result;
      })
      .catch((error) => {
        lastResult = {
          ok: false,
          skipped: false,
          reason: "benchmark-deadline-capture-run-rejected",
          error: error?.message || String(error),
        };
        schedule(attemptStartedAtMs);
        return lastResult;
      })
      .finally(() => {
        if (inFlightTick === pending) inFlightTick = null;
      });
    inFlightTick = pending;
    return pending;
  };
  if (immediate) void tick();
  else schedule();
  return {
    tick,
    intervalMs: boundedIntervalMs,
    get handle() { return handle; },
    get inFlight() { return inFlightTick !== null; },
    get lastResult() { return lastResult; },
    get nextRunAt() { return nextRunAt; },
    waitForIdle: () => inFlightTick || Promise.resolve(lastResult),
    pause: () => {
      paused = true;
      clear();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      schedule();
    },
    stop: () => {
      stopped = true;
      paused = true;
      clear();
    },
  };
};

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const contentFingerprintForFiles = (filePathsInput = []) => {
  const filePaths = [...new Set(
    (Array.isArray(filePathsInput) ? filePathsInput : [])
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath))
  )].sort();
  const hash = crypto.createHash("sha256");
  for (const filePath of filePaths) {
    hash.update(filePath);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(filePath));
    } catch (error) {
      hash.update(`missing:${error?.code || "read-error"}`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
};

const modelStrategyReconciliationFingerprint = ({
  publicDir = path.join(rootDir, "public", "data"),
  runtimeStoreDir = storeDir,
} = {}) => contentFingerprintForFiles([
  path.join(publicDir, "model-strategy.json"),
  path.join(runtimeStoreDir, "model-strategy.json"),
  path.join(publicDir, "sync-meta.json"),
  path.join(publicDir, "model-calibration.json"),
  path.join(publicDir, "matches-current.json"),
]);

const describeModelStrategyReconciliationNeed = ({
  publicDir = path.join(rootDir, "public", "data"),
  runtimeStoreDir = storeDir,
} = {}) => {
  const evaluation = readJson(path.join(publicDir, "model-evaluation.json"), null);
  const publicStrategy = readJson(path.join(publicDir, "model-strategy.json"), null);
  const runtimeStrategy = readJson(path.join(runtimeStoreDir, "model-strategy.json"), null);
  if (!evaluation || typeof evaluation !== "object") {
    return {
      shouldRun: false,
      reason: "model-evaluation-missing",
      reasons: ["model-evaluation-missing"],
    };
  }

  const reasons = [];
  if (!publicStrategy || typeof publicStrategy !== "object") {
    reasons.push("public-model-strategy-missing");
  }
  if (!runtimeStrategy || typeof runtimeStrategy !== "object") {
    reasons.push("runtime-model-strategy-missing");
  }
  if (publicStrategy && runtimeStrategy
    && JSON.stringify(publicStrategy) !== JSON.stringify(runtimeStrategy)) {
    reasons.push("model-strategy-mirrors-diverged");
  }

  const gate = publicStrategy?.activation?.promotionGate || null;
  const evaluationMs = Date.parse(evaluation?.generatedAt || "");
  const strategyMs = Math.max(
    Date.parse(publicStrategy?.generatedAt || "") || 0,
    Date.parse(gate?.checkedAt || "") || 0,
  );
  if (Number.isFinite(evaluationMs) && evaluationMs > 0
    && (!Number.isFinite(strategyMs) || strategyMs < evaluationMs)) {
    reasons.push("model-strategy-older-than-evaluation");
  }
  if (gate && gate.sourceEvaluationVersion !== evaluation?.version) {
    reasons.push("model-strategy-evaluation-version-mismatch");
  }

  const expectedBestCandidateId = evaluation?.shadowCandidates?.bestCandidateId
    || evaluation?.shadowCandidates?.bestCandidate?.id
    || null;
  if (gate && (gate?.shadowCandidate?.id || null) !== expectedBestCandidateId) {
    reasons.push("model-strategy-candidate-mismatch");
  }
  const expectedMarketRows = Number(evaluation?.sample?.marketBaselineRows);
  const actualMarketRows = Number(gate?.sample?.marketBaselineRows);
  if (gate && Number.isFinite(expectedMarketRows)
    && (!Number.isFinite(actualMarketRows) || actualMarketRows !== expectedMarketRows)) {
    reasons.push("model-strategy-market-sample-mismatch");
  }
  const expectedProbabilityRows = Number(evaluation?.sample?.probabilityRows);
  const actualProbabilityRows = Number(gate?.sample?.probabilityRows);
  if (gate && Number.isFinite(expectedProbabilityRows)
    && (!Number.isFinite(actualProbabilityRows) || actualProbabilityRows !== expectedProbabilityRows)) {
    reasons.push("model-strategy-probability-sample-mismatch");
  }
  const expectedHhadEvaluatedAt = evaluation?.hhadCompanionEvaluation?.evaluatedAt || null;
  const actualHhadEvaluatedAt = publicStrategy?.activation?.shadowTracks?.HHAD_COMPANION?.evaluatedAt || null;
  if (expectedHhadEvaluatedAt && actualHhadEvaluatedAt !== expectedHhadEvaluatedAt) {
    reasons.push("model-strategy-hhad-evaluation-mismatch");
  }

  return {
    shouldRun: reasons.length > 0,
    reason: reasons.length > 0
      ? "model-strategy-reconciliation-required"
      : "model-strategy-current",
    reasons,
    evaluationGeneratedAt: evaluation?.generatedAt || null,
    strategyGeneratedAt: publicStrategy?.generatedAt || null,
    gateCheckedAt: gate?.checkedAt || null,
    evaluationVersion: evaluation?.version || null,
    strategyEvaluationVersion: gate?.sourceEvaluationVersion || null,
  };
};

const writeJsonAtomic = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // A failed cleanup must not hide the original atomic publication error.
    }
  }
};

const waitForFastEventVisibility = () => new Promise((resolve) => {
  setTimeout(resolve, fastEventVisibilityMs);
});

const officialPublishEvidenceAfter = (status, workerStartedAt) => {
  const markerMs = Date.parse(workerStartedAt || "");
  if (!Number.isFinite(markerMs)) {
    return { state: "invalid-marker", workerStartedAt: workerStartedAt || null };
  }

  const eventCycle = status?.eventCycle && typeof status.eventCycle === "object"
    ? status.eventCycle
    : null;
  const eventFinishedMs = Date.parse(eventCycle?.finishedAt || "");
  if (
    eventCycle?.phase === "official-result-published"
    && eventCycle?.ok === true
    && Number.isFinite(eventFinishedMs)
    && eventFinishedMs >= markerMs
  ) {
    return {
      state: "published",
      workerStartedAt,
      startedAt: eventCycle.startedAt || null,
      finishedAt: eventCycle.finishedAt,
      durationMs: eventCycle.durationMs ?? null,
    };
  }

  const failedCycle = [status?.eventCycle, status?.lastCycle]
    .filter((cycle) => cycle && typeof cycle === "object" && cycle.ok === false)
    .find((cycle) => {
      const cycleStartedMs = Date.parse(cycle.startedAt || "");
      const cycleFinishedMs = Date.parse(cycle.finishedAt || "");
      return (Number.isFinite(cycleStartedMs) && cycleStartedMs >= markerMs)
        || (Number.isFinite(cycleFinishedMs) && cycleFinishedMs >= markerMs);
    });
  const lastErrorMs = Date.parse(status?.lastError?.at || status?.at || status?.checkedAt || "");
  if (failedCycle || (status?.ok === false && Number.isFinite(lastErrorMs) && lastErrorMs >= markerMs)) {
    return {
      state: "failed",
      workerStartedAt,
      startedAt: failedCycle?.startedAt || null,
      finishedAt: failedCycle?.finishedAt || status?.lastError?.at || status?.checkedAt || null,
      phase: failedCycle?.phase || status?.phase || null,
      error: failedCycle?.error || status?.lastError?.message || status?.error || null,
      errorCode: failedCycle?.errorCode || status?.lastError?.code || status?.errorCode || null,
    };
  }

  return {
    state: "pending",
    workerStartedAt,
    checkedAt: status?.checkedAt || status?.at || null,
    cycleState: status?.cycleState || null,
  };
};

const readinessIdleEvidenceAfter = (status, workerStartedAt) => {
  const markerMs = Date.parse(workerStartedAt || "");
  if (!Number.isFinite(markerMs)) {
    return { state: "invalid-marker", workerStartedAt: workerStartedAt || null };
  }

  const latestCycle = status?.lastCycle && typeof status.lastCycle === "object"
    ? status.lastCycle
    : null;
  const latestStartedMs = Date.parse(latestCycle?.startedAt || "");
  const latestFinishedMs = Date.parse(latestCycle?.finishedAt || "");
  const latestFresh = Number.isFinite(latestStartedMs)
    && Number.isFinite(latestFinishedMs)
    && latestStartedMs >= markerMs
    && latestFinishedMs >= latestStartedMs;

  if (latestFresh && latestCycle?.ok === false) {
    return {
      state: "failed",
      workerStartedAt,
      startedAt: latestCycle.startedAt || null,
      finishedAt: latestCycle.finishedAt || null,
      phase: latestCycle.phase || status?.phase || null,
      error: latestCycle.error || status?.lastError?.message || status?.error || null,
      errorCode: latestCycle.errorCode || status?.lastError?.code || status?.errorCode || null,
    };
  }

  const lastCompleteCycle = status?.lastCompleteCycle
    && typeof status.lastCompleteCycle === "object"
    ? status.lastCompleteCycle
    : null;
  const completeStartedMs = Date.parse(lastCompleteCycle?.startedAt || "");
  const completeFinishedMs = Date.parse(lastCompleteCycle?.finishedAt || "");
  const completeFresh = Number.isFinite(completeStartedMs)
    && Number.isFinite(completeFinishedMs)
    && completeStartedMs >= markerMs
    && completeFinishedMs >= completeStartedMs;
  // A queued trigger can record a harmless `sync lock held` skip immediately
  // after a complete release cycle. Preserve that complete cycle as the
  // readiness proof instead of letting the later skip erase it.
  const lastCycle = latestFresh
    && latestCycle?.ok === true
    && latestCycle?.skipped !== true
    ? latestCycle
    : (completeFresh ? lastCompleteCycle : latestCycle);
  const cycleStartedMs = Date.parse(lastCycle?.startedAt || "");
  const cycleFinishedMs = Date.parse(lastCycle?.finishedAt || "");
  const freshCycle = Number.isFinite(cycleStartedMs)
    && Number.isFinite(cycleFinishedMs)
    && cycleStartedMs >= markerMs
    && cycleFinishedMs >= cycleStartedMs;

  const officialPhase = lastCycle?.officialPhase && typeof lastCycle.officialPhase === "object"
    ? lastCycle.officialPhase
    : null;
  const readinessObservation = lastCycle?.readinessSourceCycleObservation
    && typeof lastCycle.readinessSourceCycleObservation === "object"
    ? lastCycle.readinessSourceCycleObservation
    : null;
  const publicationIdentityEvidence = compareObservationPublicationIdentity(readinessObservation);
  const modelReconciliationRequired = lastCycle?.modelStrategyStep?.ok === true
    && lastCycle?.modelStrategyStep?.skipped !== true;
  const modelGenerationReconciled = !modelReconciliationRequired || (
    lastCycle?.modelReconciledGenerationStep?.ok === true
    && lastCycle?.modelReconciledGenerationStep?.skipped !== true
  );
  const modelSqliteReconciled = !modelReconciliationRequired || (
    lastCycle?.modelReconciledSqliteStep?.ok === true
    && lastCycle?.modelReconciledSqliteStep?.skipped !== true
  );
  const readinessBlockers = [
    ...(
      Array.isArray(readinessObservation?.blockers)
        ? readinessObservation.blockers
        : ["readiness-publication-observation-missing"]
    ),
    ...publicationIdentityEvidence.blockers,
  ];
  if (!modelGenerationReconciled) {
    readinessBlockers.push("model-strategy-generation-reconciliation-not-ready");
  }
  if (!modelSqliteReconciled) {
    readinessBlockers.push("model-strategy-sqlite-reconciliation-not-ready");
  }
  const uniqueReadinessBlockers = [...new Set(readinessBlockers)];
  const publicationReady = readinessObservation?.ready === true
    && publicationIdentityEvidence.samePublicationIdentity
    && modelGenerationReconciled
    && modelSqliteReconciled
    && uniqueReadinessBlockers.length === 0;
  const officialFinishedMs = Date.parse(officialPhase?.finishedAt || "");
  const statusCheckedMs = Date.parse(status?.checkedAt || status?.at || "");
  const idleState = status?.cycleState === "sleeping" || status?.cycleState === "stopped";
  const phaseMatchesIdle = status?.phase === status?.cycleState;
  if (
    freshCycle
    && lastCycle?.ok === true
    && lastCycle?.skipped !== true
    && officialPhase?.phase === "official-result-published"
    && officialPhase?.ok === true
    && Number.isFinite(officialFinishedMs)
    && officialFinishedMs >= markerMs
    && officialFinishedMs <= cycleFinishedMs
    && Number.isFinite(statusCheckedMs)
    && statusCheckedMs >= cycleFinishedMs
    && status?.ok === true
    && idleState
    && phaseMatchesIdle
    && publicationReady
  ) {
    return {
      state: "idle",
      workerStartedAt,
      cycleState: status.cycleState,
      pid: status.pid ?? null,
      startedAt: lastCycle.startedAt,
      officialPublishedAt: officialPhase.finishedAt,
      finishedAt: lastCycle.finishedAt,
      durationMs: lastCycle.durationMs ?? null,
      publicationIdentity: publicationIdentityEvidence.publicIdentity,
    };
  }

  const lastErrorMs = Date.parse(status?.lastError?.at || status?.at || status?.checkedAt || "");
  if (status?.ok === false && Number.isFinite(lastErrorMs) && lastErrorMs >= markerMs) {
    return {
      state: "failed",
      workerStartedAt,
      startedAt: lastCycle?.startedAt || null,
      finishedAt: lastCycle?.finishedAt || status?.lastError?.at || status?.checkedAt || null,
      phase: lastCycle?.phase || status?.phase || null,
      error: lastCycle?.error || status?.lastError?.message || status?.error || null,
      errorCode: lastCycle?.errorCode || status?.lastError?.code || status?.errorCode || null,
    };
  }

  return {
    state: "pending",
    workerStartedAt,
    checkedAt: status?.checkedAt || status?.at || null,
    cycleState: status?.cycleState || null,
    phase: status?.phase || null,
    readinessBlockers: uniqueReadinessBlockers,
  };
};

const parseTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : NaN;
};

const ageMs = (value) => {
  const time = parseTime(value);
  return Number.isFinite(time) ? Date.now() - time : Infinity;
};

const fileMtimeMs = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return NaN;
  }
};

const webConsensusRefreshDue = (nowMs = Date.now()) => {
  const outputMtime = fileMtimeMs(webConsensusOutputFile);
  if (!Number.isFinite(outputMtime)) return true;
  const newestInputMtime = Math.max(...webConsensusInputFiles.map(fileMtimeMs).filter(Number.isFinite), 0);
  return newestInputMtime > outputMtime || nowMs - outputMtime >= webConsensusRefreshMs;
};

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const safeCoverageRatio = (modelRows, sqliteRows) => {
  const total = asNumber(sqliteRows, 0);
  if (total <= 0) return 1;
  return asNumber(modelRows, 0) / total;
};

const readSqliteCounts = () => {
  if (!DatabaseSync) return { ok: false, reason: "node:sqlite unavailable", path: sqliteDbPath };
  if (!fs.existsSync(sqliteDbPath)) return { ok: false, reason: "sqlite database not found", path: sqliteDbPath };
  let db = null;
  try {
    db = new DatabaseSync(sqliteDbPath, { readOnly: true });
    const scalar = (sql) => Number(db.prepare(sql).get()?.value || 0);
    return {
      ok: true,
      path: sqliteDbPath,
      counts: {
        oddsSnapshots: scalar("SELECT COUNT(*) AS value FROM odds_snapshots"),
        predictionSnapshots: scalar("SELECT COUNT(*) AS value FROM prediction_snapshots")
      }
    };
  } catch (error) {
    return { ok: false, path: sqliteDbPath, reason: error.message || String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures for worker diagnostics.
    }
  }
};

const publicationIdentityFields = Object.freeze([
  "generationId",
  "manifestHash",
  "sourceCycleId",
  "committedAt",
]);

const normalizedIdentityValue = (value) => (
  typeof value === "string" ? value.trim() || null : null
);

const compareObservationPublicationIdentity = (observation) => {
  const publicIdentity = {
    generationId: normalizedIdentityValue(observation?.generation?.generationId),
    manifestHash: normalizedIdentityValue(observation?.generation?.manifestHash),
    sourceCycleId: normalizedIdentityValue(observation?.generation?.sourceCycleId),
    committedAt: normalizedIdentityValue(observation?.generation?.committedAt),
  };
  const sqliteIdentity = {
    generationId: normalizedIdentityValue(observation?.sqlite?.generationId),
    manifestHash: normalizedIdentityValue(observation?.sqlite?.manifestHash),
    sourceCycleId: normalizedIdentityValue(observation?.sqlite?.generationSourceCycleId),
    committedAt: normalizedIdentityValue(observation?.sqlite?.committedAt),
  };
  const missingPublicFields = publicationIdentityFields.filter((field) => !publicIdentity[field]);
  const missingSqliteFields = publicationIdentityFields.filter((field) => !sqliteIdentity[field]);
  const mismatchedFields = publicationIdentityFields.filter((field) => (
    publicIdentity[field]
    && sqliteIdentity[field]
    && publicIdentity[field] !== sqliteIdentity[field]
  ));
  const blockers = [
    ...missingPublicFields.map((field) => `published-generation-identity-missing:${field}`),
    ...missingSqliteFields.map((field) => `sqlite-publication-identity-missing:${field}`),
    ...mismatchedFields.map((field) => `public-sqlite-publication-identity-mismatch:${field}`),
  ];
  return {
    publicIdentity,
    sqliteIdentity,
    missingPublicFields,
    missingSqliteFields,
    mismatchedFields,
    samePublicationIdentity: blockers.length === 0,
    blockers,
  };
};

const inspectSqlitePublicationReuse = ({
  enabled = sqliteExportEnabled,
  sqlitePath: sqlitePathInput = sqliteDbPath,
  publicationStoreDir = storeDir,
  DatabaseClass = DatabaseSync,
} = {}) => {
  const inspectedAt = new Date().toISOString();
  const sqlitePath = path.resolve(sqlitePathInput);
  const result = {
    reusable: false,
    inspectedAt,
    sqlitePath,
    reason: null,
    publicationIdentity: null,
    sqliteIdentity: null,
  };
  if (!enabled) return { ...result, reason: "sqlite-export-disabled" };
  if (
    process.env.SQLITE_VACUUM_AFTER_EXPORT === "1"
    && process.env.SQLITE_MAINTENANCE_WINDOW === "release-stopped"
  ) return { ...result, reason: "sqlite-maintenance-requested" };
  if (!DatabaseClass) return { ...result, reason: "node:sqlite-unavailable" };
  if (!fs.existsSync(sqlitePath)) return { ...result, reason: "sqlite-database-not-found" };

  let pointer;
  try {
    pointer = readPointer(storePaths(path.resolve(publicationStoreDir)).currentPointer);
  } catch (error) {
    return { ...result, reason: error?.code || error?.message || "publication-pointer-unavailable" };
  }
  const publicationIdentity = {
    generationId: normalizedIdentityValue(pointer?.generationId),
    manifestHash: normalizedIdentityValue(pointer?.manifestHash),
    sourceCycleId: normalizedIdentityValue(pointer?.sourceCycleId),
    committedAt: normalizedIdentityValue(pointer?.committedAt),
  };

  let db = null;
  try {
    db = new DatabaseClass(sqlitePath, { readOnly: true });
    const schemaValue = (key) => normalizedIdentityValue(db.prepare(
      "SELECT value FROM schema_meta WHERE key = ?"
    ).get(key)?.value);
    const sqliteIdentity = {
      generationId: schemaValue("data_generation_id"),
      manifestHash: schemaValue("manifest_hash"),
      sourceCycleId: schemaValue("data_generation_source_cycle_id"),
      committedAt: schemaValue("committed_at"),
    };
    const reusable = publicationIdentityFields.every((field) => (
      publicationIdentity[field]
      && sqliteIdentity[field]
      && publicationIdentity[field] === sqliteIdentity[field]
    ));
    return {
      ...result,
      reusable,
      reason: reusable ? "sqlite-publication-identity-already-current" : "sqlite-publication-identity-differs",
      publicationIdentity,
      sqliteIdentity,
    };
  } catch (error) {
    return {
      ...result,
      reason: error?.message || String(error),
      publicationIdentity,
    };
  } finally {
    try { db?.close(); } catch { /* reuse inspection is fail-closed */ }
  }
};

const runSqliteExportOrReuse = async ({
  enabled,
  generationStep,
  extraEnv = {},
  options = {},
  inspect = inspectSqlitePublicationReuse,
  run = runOptional,
} = {}) => {
  const shouldExport = enabled === true && generationStep?.ok === true;
  if (!shouldExport) return run(false, "datastore:sqlite", extraEnv, options);
  const reuse = inspect({ enabled: true });
  if (reuse.reusable) {
    return {
      ok: true,
      skipped: false,
      reused: true,
      script: "datastore:sqlite",
      reason: reuse.reason,
      startedAt: reuse.inspectedAt,
      finishedAt: new Date().toISOString(),
      publicationIdentity: reuse.publicationIdentity,
      sqliteIdentity: reuse.sqliteIdentity,
    };
  }
  return run(true, "datastore:sqlite", extraEnv, options);
};

const readSourceCycleObservation = ({
  phase = null,
  validationStep = null,
  generationStep = null,
  sqliteStep = null,
  syncMetaPath: syncMetaPathInput = path.join(rootDir, "public", "data", "sync-meta.json"),
  sqlitePath: sqlitePathInput = sqliteDbPath,
  publicationStoreDir = storeDir,
  DatabaseClass = DatabaseSync,
  resolvePublication = resolveActivePublication,
} = {}) => {
  const observedAt = new Date().toISOString();
  const syncMetaPath = path.resolve(syncMetaPathInput);
  const observedSqlitePath = path.resolve(sqlitePathInput);
  const syncMeta = readJson(syncMetaPath, null);
  const mutableSourceCycleId = typeof syncMeta?.sourceCycleId === "string"
    ? syncMeta.sourceCycleId.trim() || null
    : null;
  let publicSourceCycleId = mutableSourceCycleId;
  let generation = {
    mode: "legacy-bootstrap",
    generationId: null,
    sourceCycleId: null,
    manifestHash: null,
    committedAt: null,
    reason: null,
  };
  try {
    const publication = resolvePublication({
      storeDir: path.resolve(publicationStoreDir),
      publicDataDir: path.dirname(syncMetaPath),
    });
    generation = {
      mode: publication.identity.mode,
      generationId: publication.identity.generationId,
      sourceCycleId: publication.identity.sourceCycleId,
      manifestHash: publication.identity.manifestHash,
      committedAt: publication.identity.committedAt,
      reason: null,
    };
    if (publication.identity.generationId) publicSourceCycleId = publication.identity.sourceCycleId;
  } catch (error) {
    generation.reason = error.message || String(error);
  }
  const observation = {
    phase,
    observedAt,
    public: {
      path: syncMetaPath,
      sourceCycleId: publicSourceCycleId,
      mutableSourceCycleId,
      updatedAt: syncMeta?.updatedAt || null,
      capturedAt: syncMeta?.capturedAt || null,
    },
    generation,
    sqlite: {
      path: observedSqlitePath,
      sourceCycleId: null,
      generationId: null,
      manifestHash: null,
      generationSourceCycleId: null,
      committedAt: null,
      syncMetaUpdatedAt: null,
      exportedAt: null,
      readable: false,
      reason: null,
    },
    validationReady: validationStep?.ok === true && validationStep?.skipped !== true,
    generationReady: generationStep?.ok === true && generationStep?.skipped !== true,
    sqliteExportReady: sqliteStep?.ok === true && sqliteStep?.skipped !== true,
    sameSourceCycle: false,
    samePublicationIdentity: false,
    publicationIdentityMismatches: [],
    ready: false,
    blockers: [],
  };

  if (!DatabaseClass) {
    observation.sqlite.reason = "node:sqlite unavailable";
  } else if (!fs.existsSync(observedSqlitePath)) {
    observation.sqlite.reason = "sqlite database not found";
  } else {
    let db = null;
    try {
      db = new DatabaseClass(observedSqlitePath, { readOnly: true });
      const row = db.prepare("SELECT payload FROM source_snapshots WHERE id = ?").get("sync-meta:current");
      const sqliteSyncMeta = row?.payload ? JSON.parse(row.payload) : null;
      const sqliteSourceCycleId = typeof sqliteSyncMeta?.sourceCycleId === "string"
        ? sqliteSyncMeta.sourceCycleId.trim() || null
        : null;
      const schemaValue = (key) => db.prepare(
        "SELECT value FROM schema_meta WHERE key = ?"
      ).get(key)?.value || null;
      observation.sqlite = {
        path: observedSqlitePath,
        sourceCycleId: sqliteSourceCycleId,
        generationId: schemaValue("data_generation_id"),
        manifestHash: schemaValue("manifest_hash"),
        generationSourceCycleId: schemaValue("data_generation_source_cycle_id"),
        committedAt: schemaValue("committed_at"),
        syncMetaUpdatedAt: schemaValue("sync_meta_updated_at"),
        exportedAt: schemaValue("exported_at"),
        readable: true,
        reason: null,
      };
    } catch (error) {
      observation.sqlite.reason = error.message || String(error);
    } finally {
      try {
        db?.close();
      } catch {
        // Observation is diagnostic; close failure must not hide its result.
      }
    }
  }

  const publicationIdentityEvidence = compareObservationPublicationIdentity(observation);
  observation.sameSourceCycle = Boolean(
    publicationIdentityEvidence.publicIdentity.sourceCycleId
    && publicationIdentityEvidence.sqliteIdentity.sourceCycleId
    && publicationIdentityEvidence.publicIdentity.sourceCycleId
      === publicationIdentityEvidence.sqliteIdentity.sourceCycleId
  );
  observation.samePublicationIdentity = publicationIdentityEvidence.samePublicationIdentity;
  observation.publicationIdentityMismatches = publicationIdentityEvidence.mismatchedFields;
  if (!observation.validationReady) observation.blockers.push("post-enrichment-validation-not-ready");
  if (!observation.generationReady) observation.blockers.push("post-enrichment-generation-not-ready");
  if (generation.reason) observation.blockers.push("published-generation-invalid");
  if (!observation.sqliteExportReady) observation.blockers.push("post-enrichment-sqlite-export-not-ready");
  if (!publicSourceCycleId) observation.blockers.push("public-source-cycle-id-missing");
  if (!observation.sqlite.sourceCycleId) observation.blockers.push("sqlite-source-cycle-id-missing");
  if (
    publicationIdentityEvidence.publicIdentity.sourceCycleId
    && publicationIdentityEvidence.sqliteIdentity.sourceCycleId
    && publicationIdentityEvidence.publicIdentity.sourceCycleId
      !== publicationIdentityEvidence.sqliteIdentity.sourceCycleId
  ) {
    observation.blockers.push("public-sqlite-source-cycle-mismatch");
  }
  observation.blockers.push(...publicationIdentityEvidence.blockers);
  observation.blockers = [...new Set(observation.blockers)];
  observation.ready = observation.blockers.length === 0;
  return observation;
};

const readModelEvaluationCoverage = (evaluation) => {
  const sample = evaluation?.backtest?.sample || evaluation?.sample || {};
  const dataSources = sample?.dataSources || {};
  const oddsHistory = dataSources.oddsHistory || {};
  const predictionSnapshots = dataSources.predictionSnapshots || {};
  return {
    oddsRows: asNumber(oddsHistory.sqliteRows ?? sample.oddsHistoryRows, 0),
    predictionRows: asNumber(predictionSnapshots.sqliteRows ?? sample.predictionSnapshots, 0)
  };
};

const readCurrentMatches = () => {
  const matches = readJson(path.join(rootDir, "public", "data", "matches-current.json"), []);
  return Array.isArray(matches) ? matches : [];
};

const candidateDeadlineCaptureCompleteThrough = (status, requiredThroughMs) => {
  const evaluatedAtMs = Date.parse(status?.evaluatedAt || "");
  return Boolean(
    status?.version === "prospective-deadline-heartbeat-v2"
    && status?.ok === true
    && status?.skipped !== true
    && status?.dueCaptureComplete === true
    && status?.dueAtomicComplete === true
    && Number(status?.dueUnrecorded) === 0
    && Number(status?.readyDueUnrecorded) === 0
    && Number.isFinite(evaluatedAtMs)
    && Number.isFinite(Number(requiredThroughMs))
    && evaluatedAtMs >= Number(requiredThroughMs)
  );
};

const candidateImplementationDriftAwaitingRefreeze = (status) => {
  const blockers = Array.isArray(status?.blockers) ? status.blockers : [];
  const decisionRecord = status?.audit?.decisionRecord || {};
  const implementationDriftBlocker = (blocker) => (
    blocker === "semantic-commitment-version-mismatch"
    || blocker === "dependency-lock-hash-mismatch"
    || /^semantic-hash-mismatch:[A-Za-z0-9_.@/-]+$/u.test(String(blocker || ""))
    || /^source-hash-mismatch:[A-Za-z0-9_.@/-]+$/u.test(String(blocker || ""))
  );
  return Boolean(
    status?.version === "prospective-deadline-heartbeat-v2"
    && status?.captureMode === "deadline-only"
    && status?.ok === true
    && status?.skipped === true
    && status?.reason === "candidate-implementation-drift-awaiting-refreeze"
    && typeof status?.evaluatedAt === "string"
    && Number.isFinite(Date.parse(status.evaluatedAt))
    && typeof status?.candidateRevisionId === "string"
    && status.candidateRevisionId.length > 0
    && status?.audit?.state === "ACTIVE"
    && status?.audit?.chainValid === true
    && status?.audit?.evaluatedAt === status.evaluatedAt
    && status?.audit?.candidateRevisionId === status.candidateRevisionId
    && /^[a-f0-9]{64}$/u.test(String(status?.audit?.rootHash || ""))
    && decisionRecord.version === "candidate-atomic-decision-record-v3"
    && Number.isSafeInteger(decisionRecord.admittedRows)
    && decisionRecord.admittedRows >= 0
    && decisionRecord.admittedRows === decisionRecord.atomicRows
    && decisionRecord.atomicRows === decisionRecord.completeRows
    && decisionRecord.failedRows === 0
    && decisionRecord.coverage === 1
    && decisionRecord.complete === true
    && blockers.length > 0
    && blockers.every(implementationDriftBlocker)
  );
};

const describeCandidateDeadlineStartupAdmission = ({
  matches: matchesInput = null,
  nowMs: nowInput = Date.now(),
  captureStatus: captureStatusInput,
  resultRecoveryPlan: resultRecoveryPlanInput,
  safetyWindowMs: safetyWindowInput = candidateDeadlineStartupSafetyWindowMs,
} = {}) => {
  const matches = Array.isArray(matchesInput) ? matchesInput : readCurrentMatches();
  const nowMs = Number.isFinite(Number(nowInput)) ? Number(nowInput) : Date.now();
  const safetyWindowMs = Math.max(0, Number(safetyWindowInput || 0));
  const captureStatus = captureStatusInput === undefined
    ? readJson(candidateProspectiveCaptureStatusFile, null)
    : captureStatusInput;
  const resultRecoveryPlan = resultRecoveryPlanInput
    || describeFiveHundredResultFallbackNeed(matches, nowMs);
  const refreezeRecoveryRequired = candidateImplementationDriftAwaitingRefreeze(captureStatus);
  const terminalStatuses = new Set([
    "FINISHED",
    "CANCELLED",
    "POSTPONED",
    "ABANDONED",
  ]);
  const riskMatches = [];
  let nearestDeadlineMs = null;

  for (const match of matches) {
    const status = String(match?.status || "").trim().toUpperCase();
    if (terminalStatuses.has(status)) continue;
    const deadline = decisionDeadlineFor(match);
    const deadlineMs = Number(deadline?.millis);
    const finalization = captureFinalizationFor(match);
    const finalizationMs = Number(finalization?.millis);
    if (!Number.isFinite(deadlineMs)) {
      riskMatches.push({
        ...compactCadenceMatch(match, nowMs),
        reason: "decision-deadline-missing",
        captureProvenThroughFinalization: false,
      });
      continue;
    }
    if (nearestDeadlineMs === null || deadlineMs < nearestDeadlineMs) {
      nearestDeadlineMs = deadlineMs;
    }
    const captureProvenThroughFinalization = Number.isFinite(finalizationMs)
      && candidateDeadlineCaptureCompleteThrough(captureStatus, finalizationMs);
    const millisecondsToDeadline = deadlineMs - nowMs;
    const overdueUnproven = millisecondsToDeadline <= 0
      && !captureProvenThroughFinalization;
    const insideSafetyWindow = millisecondsToDeadline > 0
      && millisecondsToDeadline <= safetyWindowMs;
    if (!overdueUnproven && !insideSafetyWindow) continue;
    riskMatches.push({
      ...compactCadenceMatch(match, nowMs),
      reason: overdueUnproven
        ? "deadline-passed-without-complete-capture"
        : "deadline-inside-startup-safety-window",
      captureFinalizationAt: finalization?.value || null,
      captureProvenThroughFinalization,
    });
  }

  // An implementation-drift heartbeat is deliberately not exact: it blocks
  // every new formal decision until model:backtest retires the old revision.
  // Waiting for exact here would deadlock that refreeze behind this very gate.
  // Admit only the data/model recovery lane; main() requires a fresh exact
  // heartbeat immediately after the refreeze before later heavy steps run.
  const waitForPublished = riskMatches.length > 0 && !refreezeRecoveryRequired;
  return {
    version: "candidate-deadline-startup-admission-v1",
    checkedAt: new Date(nowMs).toISOString(),
    waitForPublished,
    refreezeRecoveryRequired,
    fastOfficialLaneAdmitted: true,
    reason: refreezeRecoveryRequired
      ? "candidate-implementation-drift-refreeze-recovery"
      : waitForPublished
      ? riskMatches.some((match) => match.reason === "decision-deadline-missing")
        ? "decision-deadline-missing"
        : riskMatches.some((match) => match.reason === "deadline-passed-without-complete-capture")
          ? "deadline-capture-overdue-unproven"
          : "deadline-inside-startup-safety-window"
      : resultRecoveryPlan?.needed === true
        ? "overdue-result-recovery-fast-lane"
        : "deadline-safety-window-clear",
    safetyWindowMs,
    nearestDeadlineAt: Number.isFinite(nearestDeadlineMs)
      ? new Date(nearestDeadlineMs).toISOString()
      : null,
    millisecondsToNearestDeadline: Number.isFinite(nearestDeadlineMs)
      ? nearestDeadlineMs - nowMs
      : null,
    resultRecoveryNeeded: resultRecoveryPlan?.needed === true,
    riskMatches,
  };
};

const compactCadenceMatch = (match, now = Date.now()) => {
  const kickoffMs = Date.parse(match?.kickoffTime || "");
  const deadline = decisionDeadlineFor(match);
  const deadlineMs = Number(deadline?.millis);
  return {
    id: match?.id || null,
    sourceMatchId: match?.sourceMatchId || null,
    status: match?.status || null,
    kickoffTime: match?.kickoffTime || null,
    minutesToKickoff: Number.isFinite(kickoffMs) ? Math.round((kickoffMs - now) / 60000) : null,
    decisionDeadlineAt: deadline?.value || null,
    decisionDeadlineSource: deadline?.source || null,
    minutesToDecisionDeadline:
      Number.isFinite(deadlineMs) ? Math.round((deadlineMs - now) / 60000) : null,
    homeTeamName: match?.homeTeamName || null,
    awayTeamName: match?.awayTeamName || null
  };
};

const describeSyncCadence = (matchesInput = null, nowInput = Date.now()) => {
  const matches = Array.isArray(matchesInput) ? matchesInput : readCurrentMatches();
  const now = Number.isFinite(Number(nowInput)) ? Number(nowInput) : Date.now();
  const hotWindowMs = hotWindowMinutes * 60 * 1000;
  const candidateDeadlineHotWindowMs = candidateDeadlineHotWindowMinutes * 60 * 1000;
  const liveStatuses = new Set(["LIVE", "IN_PLAY", "FIRST_HALF", "SECOND_HALF", "HALFTIME"]);
  const pendingResultStatuses = new Set(["PENDING_RESULT", "WAITING_RESULT"]);
  const terminalStatuses = new Set(["FINISHED", "CANCELLED", "POSTPONED", "ABANDONED"]);
  const liveMatches = [];
  const pendingResultMatches = [];
  const recentKickoffMatches = [];
  const deadlineHotMatches = [];
  const preDeadlineHotMatches = [];
  const hotMatches = [];
  const upcomingMatches = [];

  for (const match of matches) {
    const status = String(match?.status || "").toUpperCase();
    const kickoff = Date.parse(match?.kickoffTime || "");
    const decisionDeadline = decisionDeadlineFor(match);
    const decisionDeadlineMs = Number(decisionDeadline?.millis);
    if (liveStatuses.has(status)) liveMatches.push(match);
    if (
      pendingResultStatuses.has(status)
      && Number.isFinite(kickoff)
      && kickoff <= now
      && now - kickoff <= postKickoffHotWindowMinutes * 60 * 1000
    ) {
      pendingResultMatches.push(match);
    }
    if (
      Number.isFinite(kickoff)
      && kickoff < now
      && now - kickoff <= postKickoffHotWindowMinutes * 60 * 1000
      && !terminalStatuses.has(status)
    ) {
      recentKickoffMatches.push(match);
    }
    if (Number.isFinite(kickoff) && kickoff >= now) {
      upcomingMatches.push(match);
      if (kickoff - now <= hotWindowMs) {
        hotMatches.push(match);
        if (Number.isFinite(decisionDeadlineMs) && decisionDeadlineMs >= now) {
          preDeadlineHotMatches.push(match);
        }
      }
    }
    if (
      Number.isFinite(decisionDeadlineMs)
      && decisionDeadline?.source !== "kickoff-minus-10-minutes"
      && decisionDeadlineMs >= now
      && decisionDeadlineMs - now <= candidateDeadlineHotWindowMs
      && !terminalStatuses.has(status)
    ) {
      deadlineHotMatches.push(match);
    }
  }

  upcomingMatches.sort((a, b) => Date.parse(a?.kickoffTime || "") - Date.parse(b?.kickoffTime || ""));
  hotMatches.sort((a, b) => Date.parse(a?.kickoffTime || "") - Date.parse(b?.kickoffTime || ""));
  deadlineHotMatches.sort((a, b) => (
    Number(decisionDeadlineFor(a)?.millis || Infinity)
    - Number(decisionDeadlineFor(b)?.millis || Infinity)
  ));
  const hot = liveMatches.length > 0
    || pendingResultMatches.length > 0
    || recentKickoffMatches.length > 0
    || deadlineHotMatches.length > 0
    || hotMatches.length > 0;
  const reason = liveMatches.length > 0
    ? "live-match"
    : pendingResultMatches.length > 0
      ? "pending-result"
      : recentKickoffMatches.length > 0
        ? "recent-kickoff"
        : deadlineHotMatches.length > 0
          ? "near-decision-deadline"
          : preDeadlineHotMatches.length > 0
            ? "near-kickoff"
            : hotMatches.length > 0
              ? "post-deadline-near-kickoff"
            : "normal";
  const postDeadlineCooldownReasons = new Set([
    "live-match",
    "pending-result",
    "recent-kickoff",
    "post-deadline-near-kickoff",
  ]);
  const intervalMs = !hot
    ? baseIntervalMs
    : postDeadlineCooldownReasons.has(reason)
      ? postDeadlineHotIntervalMs
      : hotIntervalMs;
  return {
    checkedAt: new Date(now).toISOString(),
    mode: hot ? "hot" : "base",
    reason,
    intervalMs,
    intervalSeconds: Math.round(intervalMs / 1000),
    workflowMinutes: Math.max(1, Number((intervalMs / 60000).toFixed(2))),
    baseIntervalSeconds: Math.round(baseIntervalMs / 1000),
    hotIntervalSeconds: Math.round(hotIntervalMs / 1000),
    postDeadlineHotIntervalSeconds: Math.round(postDeadlineHotIntervalMs / 1000),
    hotWindowMinutes,
    candidateDeadlineHotWindowMinutes,
    postKickoffHotWindowMinutes,
    currentMatches: matches.length,
    liveMatches: liveMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    pendingResultMatches: pendingResultMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    recentKickoffMatches: recentKickoffMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    deadlineHotMatches: deadlineHotMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    preDeadlineHotMatches: preDeadlineHotMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    hotMatches: hotMatches.slice(0, 5).map((match) => compactCadenceMatch(match, now)),
    nextMatch: upcomingMatches[0] ? compactCadenceMatch(upcomingMatches[0], now) : null
  };
};

const describeFiveHundredResultFallbackNeed = (
  matchesInput = null,
  nowInput = Date.now(),
  enabledInput = process.env.ENABLE_500_RESULT_FALLBACK !== "0"
) => {
  const matches = Array.isArray(matchesInput) ? matchesInput : readCurrentMatches();
  const now = Number.isFinite(Number(nowInput)) ? Number(nowInput) : Date.now();
  const enabled = Boolean(enabledInput);
  const pendingStatuses = new Set(["PENDING_RESULT", "WAITING_RESULT"]);
  const lateStatuses = new Set([
    "LIVE",
    "IN_PLAY",
    "FIRST_HALF",
    "SECOND_HALF",
    "HALFTIME",
    "SCHEDULED",
  ]);
  const maxAgeMs = 72 * 60 * 60 * 1000;
  const lateThresholdMs = 100 * 60 * 1000;
  const candidates = matches.filter((match) => {
    if (Number.isFinite(match?.scoreHome) && Number.isFinite(match?.scoreAway)) return false;
    const kickoffMs = Date.parse(match?.kickoffTime || "");
    if (!Number.isFinite(kickoffMs)) return false;
    const ageMs = now - kickoffMs;
    if (ageMs < 0 || ageMs > maxAgeMs) return false;
    const status = String(match?.status || "").toUpperCase();
    if (pendingStatuses.has(status)) return true;
    return lateStatuses.has(status) && ageMs >= lateThresholdMs;
  });
  return {
    enabled,
    needed: enabled && candidates.length > 0,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 10).map((match) => ({
      id: match?.id || null,
      sourceMatchId: match?.sourceMatchId || null,
      status: match?.status || null,
      kickoffTime: match?.kickoffTime || null,
    })),
  };
};

const runOptional = async (enabled, script, extraEnv = {}, options = {}) => {
  if (!enabled) return { ok: true, skipped: true, script };
  const fatal = options.fatal !== false;
  try {
    return await runCommand(npmCommand, ["run", script], extraEnv, {
      timeoutMs: options.timeoutMs || commandTimeoutMs
    });
  } catch (error) {
    const result = {
      ok: false,
      script,
      fatal,
      error: error.message || String(error),
      errorCode: error.code || null,
      timeoutMs: error.timeoutMs || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
    if (fatal) throw error;
    return result;
  }
};

const acquireSyncLockInterruptibly = async ({
  waitMs = 0,
  acquireLock = acquireSyncLock,
  isInterrupted = () => runtimeShutdownController.requested,
  ...lockOptions
} = {}) => {
  const totalWaitMs = Math.max(0, Number(waitMs) || 0);
  const startedAtMs = Date.now();
  let lastResult = null;
  do {
    if (isInterrupted()) throw runtimeShutdownController.interruptionError();
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    const remainingMs = Math.max(0, totalWaitMs - elapsedMs);
    lastResult = await acquireLock({
      ...lockOptions,
      waitMs: Math.min(remainingMs, interruptibleLockWaitSliceMs),
    });
    if (lastResult?.acquired || lastResult?.reason !== "sync lock held") return lastResult;
    if (Date.now() - startedAtMs >= totalWaitMs) return lastResult;
  } while (true);
};

const runWithSharedSlowArtifactLock = async ({
  enabled,
  script,
  task,
  waitMs = 0,
  acquireLock = acquireSyncLock,
  isInterrupted = () => runtimeShutdownController.requested,
} = {}) => {
  if (typeof task !== "function") throw new TypeError("shared artifact task is required");
  if (isInterrupted()) throw runtimeShutdownController.interruptionError();
  if (!enabled || !usesSharedSlowArtifact(script)) return task();
  const lock = await acquireSyncLockInterruptibly({
    lockDir: sharedSlowArtifactLockDir,
    owner: "football-sync-worker",
    source: `shared-artifact:${script}`,
    waitMs,
    acquireLock,
    isInterrupted,
  });
  if (!lock.acquired) {
    return {
      ok: true,
      skipped: true,
      deferred: true,
      fatal: false,
      script,
      reason: "shared-artifact-writer-busy",
      lock: {
        owner: lock.info?.owner || null,
        source: lock.info?.source || null,
        pid: lock.info?.pid || null,
        startedAt: lock.info?.startedAt || null,
        ageMs: Math.round(lock.ageMs || 0),
      },
    };
  }
  try {
    return {
      ...(await task()),
      sharedArtifactSerialized: true,
    };
  } finally {
    await lock.release();
  }
};

const describePostEnrichmentPublicationNeed = (stepsInput = []) => {
  const steps = Array.isArray(stepsInput) ? stepsInput : [];
  // A command that was actually invoked may have mutated part of the source
  // tree before returning a failure. Treat every non-skipped attempt as a
  // possible publication change; the post-enrichment validator remains the
  // authority that decides whether the new state is publishable.
  const attempted = steps.filter((step) => step && step.skipped !== true);
  return {
    required: attempted.length > 0,
    reason: attempted.length > 0
      ? "enrichment-command-attempted"
      : "no-enrichment-command-executed",
    attemptedScripts: attempted.map((step) => step.script || null).filter(Boolean),
    failedScripts: attempted
      .filter((step) => step.ok !== true)
      .map((step) => step.script || null)
      .filter(Boolean),
    reusedScripts: steps
      .filter((step) => step?.reused === true)
      .map((step) => step.script || null)
      .filter(Boolean),
    skippedScripts: steps
      .filter((step) => step?.skipped === true && step?.reused !== true)
      .map((step) => step.script || null)
      .filter(Boolean),
  };
};

const describeConsolidatedSlowPublicationNeed = ({
  postEnrichmentPublicationPlan = null,
  modelReconciliationRequired = false,
  validationOk = false,
} = {}) => {
  const enrichmentRequired = postEnrichmentPublicationPlan?.required === true;
  const required = validationOk === true
    && (enrichmentRequired || modelReconciliationRequired === true);
  return {
    required,
    enrichmentRequired,
    modelReconciliationRequired: modelReconciliationRequired === true,
    reason: required
      ? "enrichment-or-model-artifact-changed"
      : (validationOk === true
          ? "no-publishable-slow-phase-change"
          : "post-enrichment-validation-not-ready"),
  };
};

const describeModelBacktestNeed = ({
  sqliteStep = null,
  forceCandidateImplementationRefreeze = false,
} = {}) => {
  const evaluation = readJson(path.join(rootDir, "public", "data", "model-evaluation.json"), null);
  const syncMeta = readJson(path.join(rootDir, "public", "data", "sync-meta.json"), null);
  const lastStatus = readJson(modelBacktestStatusFile, null);
  const candidateCaptureStatus = readJson(candidateProspectiveCaptureStatusFile, null);
  const candidateImplementationDrift = forceCandidateImplementationRefreeze === true || (
    candidateCaptureStatus?.reason === "candidate-implementation-drift-awaiting-refreeze"
  );
  const sqliteCoverage = readSqliteCounts();
  const modelCoverage = readModelEvaluationCoverage(evaluation);
  const sqliteOddsRows = asNumber(sqliteCoverage.counts?.oddsSnapshots, 0);
  const sqlitePredictionRows = asNumber(sqliteCoverage.counts?.predictionSnapshots, 0);
  const oddsCoverageRatio = safeCoverageRatio(modelCoverage.oddsRows, sqliteOddsRows);
  const predictionCoverageRatio = safeCoverageRatio(modelCoverage.predictionRows, sqlitePredictionRows);
  const coverageCritical = sqliteCoverage.ok === true && (
    (sqliteOddsRows > 0 && oddsCoverageRatio < modelCoverageMinRatio)
    || (sqlitePredictionRows > 0 && predictionCoverageRatio < modelCoverageMinRatio)
  );
  const coverageBehind = sqliteCoverage.ok === true && (
    (sqliteOddsRows > 0 && oddsCoverageRatio < modelCoverageTriggerRatio)
    || (sqlitePredictionRows > 0 && predictionCoverageRatio < modelCoverageTriggerRatio)
  );
  const lastSuccessAgeMs = ageMs(lastStatus?.lastSuccessAt);
  const lastSuccessMs = parseTime(lastStatus?.lastSuccessAt);
  const evaluationGeneratedAt = evaluation?.generatedAt || null;
  const syncUpdatedAt = syncMeta?.updatedAt || syncMeta?.capturedAt || null;
  const evaluationMs = parseTime(evaluationGeneratedAt);
  const syncMs = parseTime(syncUpdatedAt);
  const evaluationMissing = !evaluation;
  const evaluationStale = Number.isFinite(syncMs)
    && (!Number.isFinite(evaluationMs) || evaluationMs + 60_000 < syncMs);
  const evaluationDowngraded = Number.isFinite(lastSuccessMs)
    && (!Number.isFinite(evaluationMs) || evaluationMs + 60_000 < lastSuccessMs);
  const intervalReady = !Number.isFinite(lastSuccessAgeMs) || lastSuccessAgeMs >= modelBacktestMinIntervalMs;
  const sqliteReady = !sqliteStep || sqliteStep.ok === true;
  const enabled = modelBacktestOnSync || modelBacktestForce;
  const shouldRun = enabled
    && sqliteReady
    && (
      modelBacktestForce
      || candidateImplementationDrift
      || evaluationMissing
      || evaluationDowngraded
      || coverageCritical
      || coverageBehind
      || (evaluationStale && intervalReady)
    );
  return {
    enabled,
    shouldRun,
    reason: !enabled
      ? "disabled"
      : !sqliteReady
        ? "sqlite-export-not-ready"
        : modelBacktestForce
          ? "forced"
          : candidateImplementationDrift
            ? "candidate-implementation-drift"
          : evaluationMissing
            ? "evaluation-missing"
            : evaluationDowngraded
              ? "evaluation-downgraded-after-success"
            : coverageCritical
              ? "model-coverage-below-health-floor"
              : coverageBehind
                ? "model-coverage-behind-sqlite"
                : evaluationStale && intervalReady
                  ? "evaluation-stale"
                  : evaluationStale
                    ? "min-interval-not-ready"
                    : "evaluation-current",
    evaluationGeneratedAt,
    syncUpdatedAt,
    candidateImplementationDrift,
    lastSuccessAt: lastStatus?.lastSuccessAt || null,
    evaluationDowngraded,
    lastSuccessAgeMinutes: Number.isFinite(lastSuccessAgeMs) ? Number((lastSuccessAgeMs / 60000).toFixed(2)) : null,
    minIntervalMinutes: Number((modelBacktestMinIntervalMs / 60000).toFixed(2)),
    coverage: {
      sqliteReady: sqliteCoverage.ok === true,
      sqliteReason: sqliteCoverage.reason || null,
      sqlitePath: sqliteCoverage.path || sqliteDbPath,
      minRatio: modelCoverageMinRatio,
      triggerRatio: modelCoverageTriggerRatio,
      critical: coverageCritical,
      behind: coverageBehind,
      odds: {
        modelRows: modelCoverage.oddsRows,
        sqliteRows: sqliteOddsRows,
        coverageRatio: Number(oddsCoverageRatio.toFixed(4))
      },
      predictionSnapshots: {
        modelRows: modelCoverage.predictionRows,
        sqliteRows: sqlitePredictionRows,
        coverageRatio: Number(predictionCoverageRatio.toFixed(4))
      }
    }
  };
};

const maybeRunModelBacktest = async ({
  sqliteStep = null,
  forceCandidateImplementationRefreeze = false,
} = {}) => {
  const decision = describeModelBacktestNeed({
    sqliteStep,
    forceCandidateImplementationRefreeze,
  });
  if (!decision.shouldRun) {
    return { ok: true, skipped: true, script: "model:backtest", decision };
  }
  // Keep the prospective deadline heartbeat alive during the potentially
  // long-running backtest. Candidate registry mutations already use the
  // ledger lock, so pausing the heartbeat here only creates a stale window.
  const result = await runCommand(npmCommand, ["run", "model:backtest"], {
    SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
    DATASTORE_SQLITE_PATH: process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"),
    MODEL_BACKTEST_SQLITE_ODDS_LIMIT: process.env.MODEL_BACKTEST_SQLITE_ODDS_LIMIT || "120000",
    MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT: process.env.MODEL_BACKTEST_SQLITE_PREDICTION_LIMIT || "50000",
    CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT_MS:
      String(modelCandidateRegistryLockTimeoutMs),
  }, {
    timeoutMs: commandTimeouts.model
  });
  const status = {
    ok: true,
    lastSuccessAt: new Date().toISOString(),
    decision,
    result
  };
  writeJsonAtomic(modelBacktestStatusFile, status);
  return { ...result, script: "model:backtest", decision };
};

const assertCandidateImplementationRefreezeBacktest = (step) => {
  if (
    step?.ok === true
    && step?.skipped !== true
    && step?.decision?.candidateImplementationDrift === true
  ) {
    return step;
  }
  const error = new Error(
    "candidate implementation refreeze did not complete before the exact-heartbeat gate",
  );
  error.code = "CANDIDATE_IMPLEMENTATION_REFREEZE_INCOMPLETE";
  error.step = step || null;
  throw error;
};

const describeCycleStages = () => ([
  {
    id: "candidate-deadline-heartbeat",
    fatal: false,
    concurrent: true,
    operations: [
      "candidate:capture-deadline",
      "candidate:settle-prospective-ledger",
      "benchmark:capture-deadline-independent",
    ],
  },
  {
    id: "official-result-fast",
    fatal: false,
    operations: [
      "sync:server-direct-sporttery-evidence",
      "sync:cloudflare-sporttery-evidence",
      "sync:k-league-standings",
      "publish:official-results-fast",
      "sync:uefa-results",
      "sync:official-club-results",
      "sync:500:result-fallback-if-pending",
      "publish-fast-event-if-changed",
    ]
  },
  {
    id: "official-result",
    fatal: true,
    operations: [
      "sync:data",
      "sync:free-football",
      "sync:prematch",
      "validate:data",
      "datastore:generation",
      "datastore:sqlite",
      "publish-event",
    ]
  },
  {
    id: "slow-enrichment",
    fatal: false,
    operations: [
      "sync:500",
      "sync:500:details",
      "sync:api-football",
      "sync:weather",
      "sync:football-data-fixtures",
      "sync:football-data-results",
      "sync:open-research",
      "sync:web-consensus",
      "sync:free-football",
      "audit:recommendation-bias",
      "validate:sources",
      "validate:data:post-enrichment",
      "observe:source-cycle",
      "model:backtest",
      "model:learn:autonomous",
      "model:learn",
      "audit:capability",
      "optimize:strategy",
      "sync:prematch",
      "reconcile:fast-results-generation:consolidated-slow-publication",
      "validate:data:consolidated-slow-publication",
      "datastore:generation:consolidated-slow-publication",
      "datastore:sqlite:consolidated-slow-publication",
      "observe:publication-readiness"
    ]
  }
]);

const runBestEffort = async (script, task) => {
  try {
    return await task();
  } catch (error) {
    return {
      ok: false,
      script,
      fatal: false,
      error: error.message || String(error),
      errorCode: error.code || null,
      timeoutMs: error.timeoutMs || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
  }
};

const cycleDurationMs = (cycle) => {
  const explicitValue = cycle?.durationMs;
  const explicit = Number(explicitValue);
  if (explicitValue !== null && explicitValue !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(explicit);
  }
  const startedAt = Date.parse(cycle?.startedAt || "");
  const finishedAt = Date.parse(cycle?.finishedAt || "");
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt)
    ? Math.max(0, finishedAt - startedAt)
    : null;
};

const withCycleDuration = (cycle) => {
  if (!cycle || typeof cycle !== "object") return null;
  return {
    ...cycle,
    durationMs: cycleDurationMs(cycle)
  };
};

const summarizeWorkerError = (error, at = new Date().toISOString()) => ({
  at,
  message: error?.message || String(error),
  code: error?.code || null,
  command: error?.command || null,
  args: Array.isArray(error?.args) ? error.args : null,
  timeoutMs: error?.timeoutMs || null,
  exitCode: error?.exitCode ?? null,
  signal: error?.signal || null
});

const isCompletePublicationCycle = (cycle) => Boolean(
  cycle
  && cycle.ok === true
  && cycle.skipped !== true
  && cycle.officialPhase?.ok === true
  && cycle.officialPhase?.phase === "official-result-published"
  && cycle.readinessSourceCycleObservation?.ready === true
  && cycle.readinessSourceCycleObservation?.samePublicationIdentity === true
  && (
    !Array.isArray(cycle.readinessSourceCycleObservation?.blockers)
    || cycle.readinessSourceCycleObservation.blockers.length === 0
  )
);

const releaseCycleNeedsPriorityRetry = (cycle) => Boolean(
  cycle?.releaseCycle?.priority === true
  && !isCompletePublicationCycle(cycle)
);

const releaseCycleDelayMs = (cycle, normalDelayMs) => (
  releaseCycleNeedsPriorityRetry(cycle)
    ? Math.min(Math.max(0, Number(normalDelayMs || 0)), releaseCycleRetryMs)
    : Math.max(0, Number(normalDelayMs || 0))
);

// A complete bundle-priority cycle must expose one real sleeping window so
// the signed release can freeze the worker and verify the exact publication.
// Relay snapshots are allowed to wake the following ordinary cycle, but they
// must not turn this handoff into an unbounded chain of immediate catch-up
// cycles while the release is waiting for readiness-safe idle.
const releaseCycleNeedsReadinessHandoff = (cycle) => Boolean(
  cycle?.releaseCycle?.priority === true
  && isCompletePublicationCycle(cycle)
);

const relayCatchupRequiredAfterCycle = ({
  loop,
  enabled,
  eligible,
  baseline,
  current,
  cycle,
}) => Boolean(
  loop
  && enabled
  && eligible
  && !releaseCycleNeedsReadinessHandoff(cycle)
  && relaySnapshotChanged(baseline, current)
);

const completePublicationCycleEvidence = (cycle) => {
  if (!isCompletePublicationCycle(cycle)) return null;
  return Object.freeze({
    ok: true,
    skipped: false,
    degraded: cycle.degraded === true,
    startedAt: cycle.startedAt || null,
    finishedAt: cycle.finishedAt || null,
    durationMs: cycleDurationMs(cycle),
    officialPhase: cycle.officialPhase,
    slowPhase: cycle.slowPhase,
    slowPhasePlan: cycle.slowPhasePlan,
    modelStrategyStep: cycle.modelStrategyStep,
    modelReconciledGenerationStep: cycle.modelReconciledGenerationStep,
    modelReconciledSqliteStep: cycle.modelReconciledSqliteStep,
    readinessSourceCycleObservation: cycle.readinessSourceCycleObservation,
  });
};

const workerHistoryFields = (status = null) => {
  const lastCycle = withCycleDuration(status?.lastCycle || null);
  const lastCompleteCycle = completePublicationCycleEvidence(status?.lastCompleteCycle)
    || completePublicationCycleEvidence(lastCycle);
  const legacyError = status?.ok === false && status?.error
    ? {
        at: status.at || status.checkedAt || null,
        message: status.error,
        code: status.errorCode || null,
        command: null,
        args: null,
        timeoutMs: status.timeoutMs || null,
        exitCode: null,
        signal: null
      }
    : null;
  const lastError = status && Object.prototype.hasOwnProperty.call(status, "lastError")
    ? status.lastError
    : legacyError;
  return {
    lastCycle,
    lastCompleteCycle,
    lastSuccessAt: status?.lastSuccessAt
      || (lastCycle?.ok === true && lastCycle?.skipped !== true ? lastCycle.finishedAt || null : null),
    lastSlowPhaseAt: Number.isFinite(Date.parse(status?.lastSlowPhaseAt || ""))
      ? status.lastSlowPhaseAt
      : null,
    lastSlowPhase: status?.lastSlowPhase && typeof status.lastSlowPhase === "object"
      ? status.lastSlowPhase
      : null,
    backgroundSlowPhase: status?.backgroundSlowPhase
      && typeof status.backgroundSlowPhase === "object"
      ? status.backgroundSlowPhase
      : null,
    lastCycleDurationMs: status?.lastCycleDurationMs !== null
      && status?.lastCycleDurationMs !== undefined
      && Number.isFinite(Number(status.lastCycleDurationMs))
      ? Math.max(0, Math.round(Number(status.lastCycleDurationMs)))
      : cycleDurationMs(lastCycle),
    lastError: lastError || null
  };
};

let workerStatusState = readJson(statusFile, null);

const describeSlowPhaseNeed = ({
  releasePriority = false,
  running = false,
  status = workerStatusState,
  now = Date.now(),
} = {}) => {
  const lastCompletedAt = status?.lastSlowPhaseAt || null;
  const lastCompletedMs = Date.parse(lastCompletedAt || "");
  const hasSuccessfulHistory = Number.isFinite(lastCompletedMs);
  const ageMs = hasSuccessfulHistory ? Math.max(0, now - lastCompletedMs) : null;
  if (running === true) {
    return {
      due: false,
      reason: "slow-phase-already-running",
      minIntervalMs: slowPhaseMinIntervalMs,
      lastCompletedAt: hasSuccessfulHistory ? lastCompletedAt : null,
      ageMs,
    };
  }
  const due = releasePriority === true
    || !hasSuccessfulHistory
    || ageMs >= slowPhaseMinIntervalMs;
  return {
    due,
    reason: releasePriority === true
      ? "release-priority"
      : (!hasSuccessfulHistory
          ? "no-slow-phase-history"
          : (due ? "minimum-interval-elapsed" : "minimum-interval-not-elapsed")),
    minIntervalMs: slowPhaseMinIntervalMs,
    lastCompletedAt: hasSuccessfulHistory ? lastCompletedAt : null,
    ageMs,
  };
};

const writeWorkerStatus = (payload) => {
  const body = {
    version: 1,
    worker: "football-sync-worker",
    commandTimeouts,
    ...payload
  };
  writeJsonAtomic(statusFile, body);
  workerStatusState = body;
  return body;
};

const writeWorkerStatusBestEffort = (
  payload,
  { write = writeWorkerStatus, log = console.error } = {},
) => {
  try {
    return { ok: true, value: write(payload), error: null };
  } catch (error) {
    try {
      log(JSON.stringify({
        type: "sync-worker-status-write-failed",
        at: new Date().toISOString(),
        error: error?.message || String(error),
        errorCode: error?.code || null,
      }));
    } catch {
      // Diagnostics are best effort too. Never let telemetry failure become an
      // unhandled rejection in the background lane.
    }
    return { ok: false, value: null, error };
  }
};

const createBackgroundSlowPhaseTracker = ({
  readStatus = () => workerStatusState,
  writeStatus = writeWorkerStatus,
  log = console.error,
  isInterrupted = () => runtimeShutdownController.requested,
  onCurrentChange = () => {},
} = {}) => {
  let currentPromise = null;
  const safeWrite = (payload) => writeWorkerStatusBestEffort(payload, {
    write: writeStatus,
    log,
  });
  const safelyNotifyCurrentChange = (value) => {
    try {
      onCurrentChange(value);
    } catch (error) {
      try {
        log(JSON.stringify({
          type: "sync-worker-background-tracker-notify-failed",
          at: new Date().toISOString(),
          error: error?.message || String(error),
        }));
      } catch {
        // The task promise already has a terminal rejection handler.
      }
    }
  };
  const track = (task, metadata = {}) => {
    const startedAt = metadata.startedAt || new Date().toISOString();
    const runningState = {
      state: "running",
      startedAt,
      finishedAt: null,
      plan: metadata.plan || null,
      error: null,
    };
    let trackedPromise = null;
    const observedTask = Promise.resolve(task).then(
      (result) => ({ fulfilled: true, result }),
      (error) => ({ fulfilled: false, error }),
    );
    const pipeline = observedTask
      .then((outcome) => {
        const finishedAt = new Date().toISOString();
        const interrupted = isInterrupted();
        if (outcome.fulfilled) {
          const slowPhase = withCycleDuration(outcome.result?.slowPhase || outcome.result || null);
          safeWrite({
            ...(readStatus() || {}),
            checkedAt: finishedAt,
            lastSlowPhase: interrupted ? readStatus()?.lastSlowPhase || null : slowPhase,
            lastSlowPhaseAt: !interrupted && slowPhase?.skipped !== true
              ? slowPhase?.finishedAt || finishedAt
              : readStatus()?.lastSlowPhaseAt || null,
            backgroundSlowPhase: {
              ...runningState,
              state: interrupted
                ? "interrupted"
                : slowPhase?.ok === false ? "degraded" : "completed",
              finishedAt,
              degraded: slowPhase?.degraded === true,
              warnings: slowPhase?.warnings || [],
              signal: interrupted ? runtimeShutdownController.request?.signal || null : null,
            },
          });
          return outcome.result;
        }
        const error = outcome.error;
        const failure = withCycleDuration({
          ok: false,
          skipped: false,
          phase: interrupted ? "slow-enrichment-interrupted" : "slow-enrichment-failed",
          startedAt,
          finishedAt,
          error: error?.message || String(error),
          errorCode: error?.code || null,
        });
        safeWrite({
          ...(readStatus() || {}),
          checkedAt: finishedAt,
          lastSlowPhase: interrupted ? readStatus()?.lastSlowPhase || null : failure,
          backgroundSlowPhase: {
            ...runningState,
            state: interrupted ? "interrupted" : "failed",
            finishedAt,
            error: error?.message || String(error),
            errorCode: error?.code || null,
            signal: interrupted ? runtimeShutdownController.request?.signal || null : null,
          },
        });
        return null;
      })
      .finally(() => {
        if (currentPromise === trackedPromise) {
          currentPromise = null;
          safelyNotifyCurrentChange(null);
        }
      });
    // This catch is deliberately terminal and is attached before the first
    // status write below. Status I/O, notification, or finally failures can
    // never leave a rejected promise floating in the long-running worker.
    trackedPromise = pipeline.catch((error) => {
      try {
        log(JSON.stringify({
          type: "sync-worker-background-terminal-failure",
          at: new Date().toISOString(),
          error: error?.message || String(error),
          errorCode: error?.code || null,
        }));
      } catch {
        // Terminal means terminal: diagnostics cannot rethrow.
      }
      return null;
    });
    currentPromise = trackedPromise;
    safelyNotifyCurrentChange(trackedPromise);
    safeWrite({
      ...(readStatus() || {}),
      checkedAt: new Date().toISOString(),
      backgroundSlowPhase: runningState,
    });
    return trackedPromise;
  };
  return {
    track,
    get current() { return currentPromise; },
    get running() { return currentPromise !== null; },
  };
};

const waitForBackgroundSlowPhaseDrain = async (
  task,
  {
    budgetMs = releaseSlowPhaseDrainBudgetMs,
    timer = setTimeout,
    clearTimer = clearTimeout,
    interruptPromise = null,
  } = {},
) => {
  if (!task) return { ok: true, skipped: true, reason: "no-background-slow-phase" };
  const startedAt = new Date().toISOString();
  const boundedBudgetMs = Math.max(1, Number(budgetMs) || 1);
  const observedTask = Promise.resolve(task).then(
    (value) => ({ type: "settled", value }),
    (error) => ({ type: "rejected", error }),
  );
  let timeoutHandle = null;
  const timeout = new Promise((resolve) => {
    timeoutHandle = timer(() => resolve({ type: "timeout" }), boundedBudgetMs);
  });
  const interruption = interruptPromise
    ? Promise.resolve(interruptPromise).then(
        (value) => ({ type: "interrupted", value }),
        (error) => ({ type: "interrupted", error }),
      )
    : null;
  const outcome = await Promise.race([
    observedTask,
    timeout,
    ...(interruption ? [interruption] : []),
  ]);
  if (timeoutHandle) clearTimer(timeoutHandle);
  const finishedAt = new Date().toISOString();
  if (outcome.type === "settled") {
    return { ok: true, skipped: false, startedAt, finishedAt, budgetMs: boundedBudgetMs };
  }
  if (outcome.type === "rejected") {
    return {
      ok: false,
      blocked: true,
      reason: "background-slow-phase-rejected-during-release-drain",
      code: "SYNC_WORKER_RELEASE_DRAIN_REJECTED",
      error: outcome.error?.message || String(outcome.error),
      startedAt,
      finishedAt,
      budgetMs: boundedBudgetMs,
    };
  }
  if (outcome.type === "interrupted") {
    return {
      ok: false,
      blocked: true,
      interrupted: true,
      reason: "background-slow-phase-release-drain-interrupted",
      code: "SYNC_WORKER_RELEASE_DRAIN_INTERRUPTED",
      startedAt,
      finishedAt,
      budgetMs: boundedBudgetMs,
    };
  }
  return {
    ok: false,
    blocked: true,
    timedOut: true,
    reason: "background-slow-phase-release-drain-budget-exhausted",
    code: "SYNC_WORKER_RELEASE_DRAIN_TIMEOUT",
    startedAt,
    finishedAt,
    budgetMs: boundedBudgetMs,
  };
};

const slowPublicationLockSources = new Set([
  "sync-worker-model-strategy-and-publication",
  "sync-worker-consolidated-slow-publication",
]);
const officialCompensationRequired = ({ cycle = null, slowPhaseRunning = false } = {}) => Boolean(
  cycle?.skipped === true
  && cycle?.reason === "sync lock held"
  && slowPhaseRunning === true
  && slowPublicationLockSources.has(String(cycle?.lock?.source || ""))
);

const runCycle = async (cadence = describeSyncCadence(), hooks = {}) => {
  const startedAt = new Date().toISOString();
  const isInterrupted = typeof hooks.isInterrupted === "function"
    ? hooks.isInterrupted
    : () => runtimeShutdownController.requested;
  if (isInterrupted()) throw runtimeShutdownController.interruptionError();
  const onFastPublished = typeof hooks.onFastPublished === "function"
    ? hooks.onFastPublished
    : async () => {};
  const onOfficialPublished = typeof hooks.onOfficialPublished === "function"
    ? hooks.onOfficialPublished
    : async () => {};
  const onBeforeHeavyStep = typeof hooks.onBeforeHeavyStep === "function"
    ? hooks.onBeforeHeavyStep
    : async () => {};
  const onAfterModelBacktest = typeof hooks.onAfterModelBacktest === "function"
    ? hooks.onAfterModelBacktest
    : async () => {};
  const requiresCandidateImplementationRefreeze = (
    typeof hooks.requiresCandidateImplementationRefreeze === "function"
      ? hooks.requiresCandidateImplementationRefreeze
      : () => false
  );
  const onSlowPhaseDeferred = typeof hooks.onSlowPhaseDeferred === "function"
    ? hooks.onSlowPhaseDeferred
    : () => {};
  const releaseRequestEnvelope = inspectReleaseWorkerPriorityRequest({
    rootDir,
    storeDir,
  });
  const releaseCycle = {
    priority: releaseRequestEnvelope.pending === true,
    checkedAt: releaseRequestEnvelope.checkedAt,
    blockers: releaseRequestEnvelope.blockers,
    requestHash: releaseRequestEnvelope.evidence.requestHash,
    bundleSha256: releaseRequestEnvelope.evidence.bundleSha256,
    expiresAt: releaseRequestEnvelope.evidence.expiresAt,
    initialLockWaitMs: releaseRequestEnvelope.pending === true
      ? releaseCycleInitialLockWaitMs
      : Math.max(0, Number(process.env.SYNC_WORKER_LOCK_WAIT_MS || 0)),
    retryMs: releaseCycleRetryMs,
  };
  const slowPhasePlan = describeSlowPhaseNeed({
    releasePriority: releaseCycle.priority,
    running: hooks.slowPhaseRunning === true,
  });
  if (releaseCycle.priority === true && hooks.slowPhaseRunning === true) {
    return {
      ok: true,
      skipped: true,
      reason: "release-priority-awaits-background-slow-phase",
      startedAt,
      finishedAt: new Date().toISOString(),
      cadence,
      releaseCycle,
      slowPhasePlan,
    };
  }
  let syncLock = await acquireSyncLockInterruptibly({
    owner: "football-sync-worker",
    source: "sync-worker-cycle",
    waitMs: releaseCycle.initialLockWaitMs,
    isInterrupted,
  });
  if (!syncLock.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: syncLock.reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      cadence,
      releaseCycle,
      slowPhasePlan,
      lock: {
        owner: syncLock.info?.owner || null,
        source: syncLock.info?.source || null,
        pid: syncLock.info?.pid || null,
        startedAt: syncLock.info?.startedAt || null,
        ageMs: Math.round(syncLock.ageMs || 0)
      }
    };
  }

  const releasePhaseLock = async () => {
    if (!syncLock?.acquired) return;
    const heldLock = syncLock;
    syncLock = null;
    await heldLock.release();
  };
  const acquirePhaseLock = async (source) => {
    if (syncLock?.acquired) return syncLock;
    const nextLock = await acquireSyncLockInterruptibly({
      owner: "football-sync-worker",
      source,
      waitMs: phaseLockWaitMs,
      isInterrupted,
    });
    if (!nextLock.acquired) {
      const error = new Error(
        `sync worker could not reacquire the publication lock during ${source}: ${nextLock.reason || "sync lock unavailable"}`
      );
      error.code = "SYNC_WORKER_PHASE_LOCK_TIMEOUT";
      error.lock = {
        owner: nextLock.info?.owner || null,
        source: nextLock.info?.source || null,
        pid: nextLock.info?.pid || null,
        startedAt: nextLock.info?.startedAt || null,
        ageMs: Math.round(nextLock.ageMs || 0),
      };
      throw error;
    }
    syncLock = nextLock;
    return syncLock;
  };

  try {
    const serverDirectSportteryEvidenceStep = await runOptional(
      Boolean(
        String(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_PRIVATE_KEY_PATH || "").trim()
        && String(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_ID || "").trim()
        && String(process.env.SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_FINGERPRINT || "").trim()
      ),
      "sync:server-direct-sporttery-evidence",
      {},
      {
        fatal: false,
        timeoutMs: commandTimeouts.resultFallback,
      }
    );
    const cloudflareSportteryEvidenceStep = await runOptional(
      Boolean(
        String(process.env.SPORTTERY_CLOUDFLARE_EVIDENCE_URL || "").trim()
        && String(process.env.SPORTTERY_CLOUDFLARE_PULL_TOKEN || "").trim()
      ),
      "sync:cloudflare-sporttery-evidence",
      {},
      {
        fatal: false,
        timeoutMs: commandTimeouts.resultFallback,
      }
    );
    const kLeagueOfficialStandingsEnabled = process.env.ENABLE_K_LEAGUE_OFFICIAL_STANDINGS_SYNC !== "0";
    const kLeagueOfficialStandingsStep = await runWithSharedSlowArtifactLock({
      enabled: kLeagueOfficialStandingsEnabled,
      script: "sync:k-league-standings",
      waitMs: 0,
      isInterrupted,
      task: () => runOptional(
        kLeagueOfficialStandingsEnabled,
        "sync:k-league-standings",
        {},
        {
          fatal: false,
          timeoutMs: commandTimeouts.resultFallback,
        }
      ),
    });
    const fastResultStep = await runBestEffort(
      "publish:official-results-fast",
      async () => {
        const { publishOfficialResultsFast } = require("./publishOfficialResultsFast.cjs");
        let result = {
          script: "publish:official-results-fast",
          ...publishOfficialResultsFast(),
        };
        const postgresMode = String(process.env.FOOTBALL_POSTGRES_MODE || "disabled").trim().toLowerCase();
        if (
          ["shadow-write", "shadow-read", "primary"].includes(postgresMode)
          && result.ok === true
          && (Number(result.publishedRows || 0) > 0 || result.visibleStateChanged === true)
        ) {
          const { syncPostgresProjectionFromSqlite } = require("./postgresProjectionSync.cjs");
          try {
            result = {
              ...result,
              postgresProjection: await syncPostgresProjectionFromSqlite({ mode: "fast-result" }),
            };
          } catch (error) {
            if (postgresMode === "primary") throw error;
            result = {
              ...result,
              postgresProjection: {
                ok: false,
                warning: true,
                code: error.code || null,
                error: error.message || String(error),
              },
            };
          }
        }
        return result;
      }
    );
    const uefaOfficialResultStep = await runOptional(
      process.env.ENABLE_UEFA_OFFICIAL_RESULTS_SYNC !== "0",
      "sync:uefa-results",
      {},
      {
        fatal: false,
        timeoutMs: commandTimeouts.resultFallback,
      }
    );
    const officialClubResultStep = await runOptional(
      process.env.ENABLE_OFFICIAL_CLUB_RESULTS_SYNC !== "0",
      "sync:official-club-results",
      {},
      {
        fatal: false,
        timeoutMs: commandTimeouts.resultFallback,
      }
    );
    const fiveHundredResultFallbackPlan = describeFiveHundredResultFallbackNeed();
    const fiveHundredResultFallbackStep = {
      ...(await runOptional(
        fiveHundredResultFallbackPlan.needed,
        "sync:500:details",
        {
          FIVE_HUNDRED_RESULT_ONLY: "1",
          FIVE_HUNDRED_DETAILS_TIMEOUT_SECONDS:
            process.env.FIVE_HUNDRED_FAST_RESULT_HTTP_TIMEOUT_SECONDS || "6",
          FIVE_HUNDRED_DETAILS_MAX_ERRORS: "1",
        },
        {
          fatal: false,
          timeoutMs: commandTimeouts.resultFallback,
        }
      )),
      mode: "result-only-recent-archive",
      plan: fiveHundredResultFallbackPlan,
    };
    const fastPhase = fastResultStep?.ok === true
      && fastResultStep?.skipped !== true
      && (
        Number(fastResultStep?.publishedRows || 0) > 0
        || fastResultStep?.visibleStateChanged === true
      )
      ? withCycleDuration({
          ...fastResultStep,
          phase: "official-result-fast-published",
          cadence,
        })
      : null;
    if (fastPhase) await onFastPublished(fastPhase);

    const officialPhaseStartedAt = new Date().toISOString();
    await onBeforeHeavyStep("sync:data");
    const officialSyncStep = await runCommand("node", ["scripts/syncData.cjs"], {
      SYNC_WORKFLOW_MINUTES: String(cadence.workflowMinutes)
    }, {
      timeoutMs: commandTimeouts.sync
    });
    // These two stages are local deterministic projections of the just-built
    // current match set. Run them in every official cycle so source quality is
    // published atomically with the current fixtures instead of lagging behind
    // until the hourly network-enrichment phase.
    await onBeforeHeavyStep("sync:free-football");
    const officialFreeFootballEnabled = process.env.ENABLE_FREE_FOOTBALL_SYNC !== "0";
    const officialFreeFootballStep = await runWithSharedSlowArtifactLock({
      enabled: officialFreeFootballEnabled,
      script: "sync:free-football",
      waitMs: 0,
      isInterrupted,
      task: () => runOptional(
        officialFreeFootballEnabled,
        "sync:free-football",
        {},
        { timeoutMs: commandTimeouts.enrichment }
      ),
    });
    await onBeforeHeavyStep("sync:prematch");
    const officialPreMatchEnabled = process.env.ENABLE_PREMATCH_SIGNALS_SYNC !== "0";
    const officialPreMatchStep = await runWithSharedSlowArtifactLock({
      enabled: officialPreMatchEnabled,
      script: "sync:prematch",
      waitMs: 0,
      isInterrupted,
      task: () => runOptional(
        officialPreMatchEnabled,
        "sync:prematch",
        {},
        { timeoutMs: commandTimeouts.enrichment }
      ),
    });
    // The fast receipt can own an older frozen review than a rebuilt JSON row.
    // Reconcile before the FIRST generation is visible, not only after slow
    // enrichment; otherwise totals can disagree with guarded SQLite for minutes.
    await onBeforeHeavyStep("reconcile:fast-results-generation:official");
    const officialFastResultReconciliationStep = await runOptional(true, "reconcile:fast-results-generation", {}, {
      timeoutMs: commandTimeouts.validation,
    });
    const dataValidationStep = await runCommand(npmCommand, ["run", "validate:data"], {}, {
      timeoutMs: commandTimeouts.validation
    });
    await onBeforeHeavyStep("datastore:generation:official");
    const officialGenerationStep = await runOptional(true, "datastore:generation", {
      SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
    }, {
      timeoutMs: commandTimeouts.sqlite
    });
    await onBeforeHeavyStep("datastore:sqlite:official");
    const sqliteStep = await runSqliteExportOrReuse({
      enabled: sqliteExportEnabled,
      generationStep: officialGenerationStep,
      options: { timeoutMs: commandTimeouts.sqlite },
    });
    let officialPhaseFinishedAt = new Date().toISOString();
    if (
      fastPhase?.finishedAt
      && Date.parse(officialPhaseFinishedAt) <= Date.parse(fastPhase.finishedAt)
    ) {
      officialPhaseFinishedAt = new Date(Date.parse(fastPhase.finishedAt) + 1).toISOString();
    }
    const officialPhase = withCycleDuration({
      ok: true,
      phase: "official-result-published",
      startedAt: officialPhaseStartedAt,
      finishedAt: officialPhaseFinishedAt,
      cadence,
      serverDirectSportteryEvidenceStep,
      cloudflareSportteryEvidenceStep,
      kLeagueOfficialStandingsStep,
      fastResultStep,
      uefaOfficialResultStep,
      officialClubResultStep,
      fiveHundredResultFallbackStep,
      officialSyncStep,
      officialFreeFootballStep,
      officialPreMatchStep,
      officialFastResultReconciliationStep,
      dataValidationStep,
      officialGenerationStep,
      sqliteStep
    });
    await onOfficialPublished(officialPhase);
    // The official match rebuild and its immutable SQLite publication are now
    // complete. Slow enrichment and model computation touch independent
    // inputs, so do not hold the global writer permit for their full runtime.
    // This gives the one-second official-result watcher a safe window to
    // publish a newly arrived terminal score instead of waiting several
    // minutes for the whole cycle.
    await releasePhaseLock();

    const fastWarnings = [
      ...(fastResultStep?.ok === false
        ? [`${fastResultStep.script}: ${fastResultStep.error}`]
        : []),
      ...(uefaOfficialResultStep?.ok === false
        ? [`${uefaOfficialResultStep.script}: ${uefaOfficialResultStep.error}`]
        : []),
    ];
    if (!slowPhasePlan.due) {
      const readinessSourceCycleObservation = readSourceCycleObservation({
        phase: "readiness",
        validationStep: dataValidationStep,
        generationStep: officialGenerationStep,
        sqliteStep,
      });
      const slowPhaseFinishedAt = new Date().toISOString();
      const slowPhase = withCycleDuration({
        ok: true,
        skipped: true,
        phase: "slow-enrichment",
        reason: slowPhasePlan.reason,
        startedAt: slowPhaseFinishedAt,
        finishedAt: slowPhaseFinishedAt,
        plan: slowPhasePlan,
        sourceCycleObservation: readinessSourceCycleObservation,
        readinessSourceCycleObservation,
        warnings: [],
      });
      return {
        ok: true,
        degraded: fastWarnings.length > 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        cadence,
        releaseCycle,
        slowPhasePlan,
        fastPhase,
        fastResultStep,
        uefaOfficialResultStep,
        officialPhase,
        slowPhase,
        sourceCycleObservation: readinessSourceCycleObservation,
        sqliteStep,
        readinessSourceCycleObservation,
        warnings: fastWarnings,
      };
    }

    const executeSlowPhase = async () => {
    const slowPhaseStartedAt = new Date().toISOString();
    let slowPhaseLock = null;
    let slowFinalArtifactLock = null;
    const releaseSlowFinalArtifactLock = async () => {
      if (!slowFinalArtifactLock?.acquired) return;
      const heldLock = slowFinalArtifactLock;
      slowFinalArtifactLock = null;
      await heldLock.release();
    };
    const acquireSlowFinalArtifactLock = async (source) => {
      if (slowFinalArtifactLock?.acquired) return slowFinalArtifactLock;
      const nextLock = await acquireSyncLockInterruptibly({
        lockDir: sharedSlowArtifactLockDir,
        owner: "football-sync-worker",
        source: `shared-artifact:${source}`,
        waitMs: phaseLockWaitMs,
        isInterrupted,
      });
      if (!nextLock.acquired) {
        const error = new Error(
          `sync worker could not acquire the final shared artifact lock during ${source}: ${nextLock.reason || "shared artifact lock unavailable"}`
        );
        error.code = "SYNC_WORKER_SHARED_ARTIFACT_LOCK_TIMEOUT";
        error.lock = {
          owner: nextLock.info?.owner || null,
          source: nextLock.info?.source || null,
          pid: nextLock.info?.pid || null,
          startedAt: nextLock.info?.startedAt || null,
          ageMs: Math.round(nextLock.ageMs || 0),
        };
        throw error;
      }
      slowFinalArtifactLock = nextLock;
      return slowFinalArtifactLock;
    };
    const releaseSlowPhaseLock = async () => {
      if (!slowPhaseLock?.acquired) return;
      const heldLock = slowPhaseLock;
      slowPhaseLock = null;
      await heldLock.release();
    };
    const acquireSlowPhaseLock = async (source) => {
      if (slowPhaseLock?.acquired) return slowPhaseLock;
      const nextLock = await acquireSyncLockInterruptibly({
        owner: "football-sync-worker",
        source,
        waitMs: slowPublicationLockWaitMs,
        isInterrupted,
      });
      if (!nextLock.acquired) {
        const error = new Error(
          `sync worker could not reacquire the publication lock during ${source}: ${nextLock.reason || "sync lock unavailable"}`
        );
        error.code = "SYNC_WORKER_PHASE_LOCK_TIMEOUT";
        error.lock = {
          owner: nextLock.info?.owner || null,
          source: nextLock.info?.source || null,
          pid: nextLock.info?.pid || null,
          startedAt: nextLock.info?.startedAt || null,
          ageMs: Math.round(nextLock.ageMs || 0),
        };
        throw error;
      }
      slowPhaseLock = nextLock;
      return slowPhaseLock;
    };
    try {
    const enrichmentSteps = [];
    const enrichmentOptions = { fatal: false, timeoutMs: commandTimeouts.enrichment };
    const releaseEnrichmentReuse = evaluateReleaseEnrichmentReuseRequest({
      rootDir,
      storeDir,
    });
    const runEnrichment = async (enabled, script, extraEnv = {}) => {
      if (enabled && releaseEnrichmentReuse.approved) {
        return {
          ok: true,
          skipped: true,
          reused: true,
          fatal: false,
          script,
          reason: "signed-release-hash-bound-reuse",
          reuseEvidence: releaseEnrichmentReuse.evidence,
        };
      }
      if (enabled) await onBeforeHeavyStep(script);
      return runWithSharedSlowArtifactLock({
        enabled,
        script,
        waitMs: phaseLockWaitMs,
        isInterrupted,
        task: () => runOptional(enabled, script, extraEnv, enrichmentOptions),
      });
    };
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_500_SYNC !== "0", "sync:500"));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_500_DETAILS_SYNC === "1", "sync:500:details"));
    enrichmentSteps.push(await runEnrichment(apiFootballRuntimePolicy.enabled, "sync:api-football"));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_WEATHER_SYNC !== "0", "sync:weather"));
    const footballDataFixturesStatus = readJson(footballDataFixturesStatusFile, null);
    enrichmentSteps.push(await runFootballDataFixtureRetry({
      enabled: process.env.ENABLE_FOOTBALL_DATA_FIXTURES_SYNC !== "0",
      checkedAt: footballDataFixturesStatus?.checkedAt,
      minIntervalMs: footballDataFixturesMinIntervalMs,
      attemptFile: path.join(path.dirname(footballDataFixturesStatusFile), "attempt.json"),
      read: readJson,
      write: writeJsonAtomic,
      run: () => runEnrichment(true, "sync:football-data-fixtures", {}),
    }));
    const footballDataResultsStatus = readJson(footballDataResultsStatusFile, null);
    const footballDataResultsPostgresMode = String(
      process.env.FOOTBALL_POSTGRES_MODE || "disabled"
    ).trim().toLowerCase();
    const footballDataResultsDue = process.env.ENABLE_FOOTBALL_DATA_RESULTS_SYNC !== "0"
      && ["shadow-write", "shadow-read", "primary"].includes(footballDataResultsPostgresMode)
      && ageMs(footballDataResultsStatus?.completedAt) >= footballDataResultsMinIntervalMs;
    enrichmentSteps.push(await runEnrichment(
      footballDataResultsDue,
      "sync:football-data-results",
      footballDataResultsWorkerEnv()
    ));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_OPEN_RESEARCH_SYNC !== "0", "sync:open-research"));
    enrichmentSteps.push(await runEnrichment(
      process.env.ENABLE_WEB_CONSENSUS_SYNC !== "0" && webConsensusRefreshDue(),
      "sync:web-consensus",
      {}
    ));
    enrichmentSteps.push({
      ...officialFreeFootballStep,
      skipped: true,
      reused: true,
      script: "sync:free-football",
      reason: "refreshed-before-official-publication",
    });
    const consolidatedPreMatchEnabled = process.env.ENABLE_PREMATCH_SIGNALS_SYNC !== "0";
    enrichmentSteps.push(await runEnrichment(true, "audit:recommendation-bias"));
    const sourceValidationStep = await runOptional(true, "validate:sources", {
      REQUIRE_EXTERNAL_SIGNALS: process.env.REQUIRE_EXTERNAL_SIGNALS === "0" ? "0" : "1"
    }, {
      fatal: false,
      timeoutMs: commandTimeouts.validation
    });
    const postEnrichmentDataValidationStep = {
      ...(await runOptional(true, "validate:data", {}, {
        fatal: false,
        timeoutMs: commandTimeouts.validation
      })),
      phase: "post-enrichment",
    };
    const postEnrichmentPublicationPlan = describePostEnrichmentPublicationNeed(enrichmentSteps);
    // Backtests consume the already-committed immutable SQLite history. Keep
    // enrichment and strategy computation off the publication lock, then
    // publish their combined effect once. This removes the former
    // post-enrichment export followed by a second model-reconciled export.
    const sourceCycleObservation = readSourceCycleObservation({
      phase: "pre-consolidated-publication",
      validationStep: postEnrichmentDataValidationStep,
      generationStep: officialGenerationStep,
      sqliteStep,
    });
    if (sourceCycleObservation.ready) await onBeforeHeavyStep("model:backtest");
    const modelBacktestStep = sourceCycleObservation.ready
      ? await runBestEffort(
          "model:backtest",
          () => maybeRunModelBacktest({
            sqliteStep,
            forceCandidateImplementationRefreeze:
              requiresCandidateImplementationRefreeze() === true,
          })
        )
      : {
          ok: sqliteExportEnabled === false,
          skipped: true,
          blocked: true,
          fatal: false,
          script: "model:backtest",
          reason: "post-enrichment-model-input-not-ready",
          error: sqliteExportEnabled
            ? `model input blocked: ${sourceCycleObservation.blockers.join(", ")}`
            : null,
          sourceCycleObservation,
        };
    await onAfterModelBacktest(modelBacktestStep);
    await onBeforeHeavyStep("model:learn:autonomous");
    const autonomousModelLearningStep = await runOptional(
      sourceCycleObservation.ready
        && process.env.ENABLE_AUTONOMOUS_MODEL_LEARNING !== "0"
        && modelBacktestStep?.ok === true
        && fs.existsSync(path.join(rootDir, "public", "data", "model-evaluation.json")),
      "model:learn:autonomous",
      {
        SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        MODEL_LEARNING_ACTOR_ID: process.env.MODEL_LEARNING_ACTOR_ID || "football-sync-worker",
      },
      { fatal: false, timeoutMs: commandTimeouts.model }
    );
    await onBeforeHeavyStep("model:learn");
    const modelLearningStep = await runOptional(
      sourceCycleObservation.ready
        && process.env.ENABLE_MODEL_LEARNING_REGISTRY !== "0"
        && modelBacktestStep?.ok === true
        && modelBacktestStep?.skipped !== true,
      "model:learn",
      {
        SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        MODEL_LEARNING_ACTOR_ID: process.env.MODEL_LEARNING_ACTOR_ID || "football-sync-worker",
        MODEL_LEARNING_PRODUCTION_INFERENCE_HASH: process.env.MODEL_LEARNING_PRODUCTION_INFERENCE_HASH || "",
        MODEL_LEARNING_PRODUCTION_FEATURE_SCHEMA_VERSION: process.env.MODEL_LEARNING_PRODUCTION_FEATURE_SCHEMA_VERSION || "",
        MODEL_LEARNING_PRODUCTION_POLICY_VERSION: process.env.MODEL_LEARNING_PRODUCTION_POLICY_VERSION || ""
      },
      { fatal: false, timeoutMs: commandTimeouts.model }
    );
    await onBeforeHeavyStep("audit:capability");
    const capabilityAuditStep = await runOptional(
      process.env.ENABLE_CAPABILITY_AUDIT !== "0",
      "audit:capability",
      {
        SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
      },
      { fatal: false, timeoutMs: commandTimeouts.model }
    );
    const modelStrategyRecovery = describeModelStrategyReconciliationNeed();
    const modelStrategyEnabled = process.env.ENABLE_MODEL_STRATEGY_ON_SYNC === "1"
      || (modelBacktestStep?.ok === true && modelBacktestStep?.skipped !== true)
      || modelStrategyRecovery.shouldRun;
    if (modelStrategyEnabled) await onBeforeHeavyStep("optimize:strategy");
    // Strategy reconciliation rewrites sync-meta/model-calibration and can
    // reconcile matches-current. Hold the publication lock from that mutation
    // through the one consolidated generation/export so a newer official cycle
    // cannot be overwritten by an older background strategy process.
    if (modelStrategyEnabled) {
      await acquireSlowPhaseLock("sync-worker-model-strategy-and-publication");
    }
    const modelStrategyFingerprintBefore = modelStrategyReconciliationFingerprint();
    const modelStrategyCommandStep = await runOptional(modelStrategyEnabled, "optimize:strategy", {
      SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
      DATA_STORE_DIR: process.env.DATA_STORE_DIR || process.env.SERVER_STORE_DIR || storeDir
    }, {
      fatal: false,
      timeoutMs: commandTimeouts.model
    });
    const modelStrategyFingerprintAfter = modelStrategyReconciliationFingerprint();
    const modelStrategyArtifactsChanged = modelStrategyCommandStep?.ok === true
      && modelStrategyCommandStep?.skipped !== true
      && modelStrategyFingerprintBefore !== modelStrategyFingerprintAfter;
    const modelStrategyStep = modelStrategyCommandStep?.ok === true
      && modelStrategyCommandStep?.skipped !== true
      && !modelStrategyArtifactsChanged
      ? {
          ...modelStrategyCommandStep,
          recovery: modelStrategyRecovery,
          skipped: true,
          changed: false,
          reason: "strategy-artifacts-unchanged",
          fingerprintBefore: modelStrategyFingerprintBefore,
          fingerprintAfter: modelStrategyFingerprintAfter,
        }
      : {
          ...modelStrategyCommandStep,
          recovery: modelStrategyRecovery,
          changed: modelStrategyArtifactsChanged,
          fingerprintBefore: modelStrategyFingerprintBefore,
          fingerprintAfter: modelStrategyFingerprintAfter,
        };
    const modelReconciliationRequired = modelStrategyStep?.ok === true
      && modelStrategyStep?.skipped !== true;
    const consolidatedPublicationPlan = describeConsolidatedSlowPublicationNeed({
      postEnrichmentPublicationPlan,
      modelReconciliationRequired,
      validationOk: postEnrichmentDataValidationStep.ok === true,
    });
    const consolidatedPublicationRequired = consolidatedPublicationPlan.required;
    if (consolidatedPublicationRequired) {
      await acquireSlowPhaseLock("sync-worker-consolidated-slow-publication");
      // Hold the shared evidence permit through the complete final rebase,
      // validation, generation, and SQLite export. A second worker or manual
      // writer cannot interleave a shared artifact mutation inside the
      // immutable publication. Official P->A attempts are zero-wait and slow
      // A writers never wait P, so this does not create a circular wait.
      await acquireSlowFinalArtifactLock("sync-worker-consolidated-slow-publication");
    }
    // Shared enrichers above may have been followed by a newer official cycle.
    // Re-project free evidence and pre-match evidence while holding the final
    // publication lock so generation always consumes the latest match set.
    const consolidatedFreeFootballEnabled = process.env.ENABLE_FREE_FOOTBALL_SYNC !== "0";
    if (consolidatedPublicationRequired && consolidatedFreeFootballEnabled) {
      await onBeforeHeavyStep("sync:free-football:consolidated-slow-publication");
    }
    const consolidatedFreeFootballStep = {
      ...(await runOptional(
        consolidatedPublicationRequired && consolidatedFreeFootballEnabled,
        "sync:free-football",
        {},
        enrichmentOptions
      )),
      phase: "consolidated-slow-publication",
      rebasedAfterOfficialLane: true,
    };
    enrichmentSteps.push(consolidatedFreeFootballStep);
    if (consolidatedPublicationRequired && consolidatedPreMatchEnabled) {
      await onBeforeHeavyStep("sync:prematch:consolidated-slow-publication");
    }
    const consolidatedPreMatchStep = {
      ...(await runOptional(
        consolidatedPublicationRequired && consolidatedPreMatchEnabled,
        "sync:prematch",
        {},
        enrichmentOptions
      )),
      phase: "consolidated-slow-publication",
      rebasedAfterOfficialLane: true,
    };
    enrichmentSteps.push(consolidatedPreMatchStep);
    const consolidatedFastResultReconciliationStep = {
      ...(await runOptional(
        consolidatedPublicationRequired,
        "reconcile:fast-results-generation",
        {},
        { timeoutMs: commandTimeouts.validation }
      )),
      phase: "consolidated-slow-publication",
    };
    const consolidatedDataValidationStep = {
      ...(await runOptional(
        consolidatedPublicationRequired,
        "validate:data",
        {},
        { fatal: false, timeoutMs: commandTimeouts.validation }
      )),
      phase: "consolidated-slow-publication",
      rebasedAfterOfficialLane: true,
    };
    if (consolidatedPublicationRequired
      && consolidatedDataValidationStep.ok === true) {
      await onBeforeHeavyStep("datastore:generation:consolidated-slow-publication");
    }
    const consolidatedGenerationStep = {
      ...(await runOptional(
        consolidatedPublicationRequired
          && consolidatedDataValidationStep.ok === true,
        "datastore:generation",
        {
          SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        },
        { fatal: false, timeoutMs: commandTimeouts.sqlite }
      )),
      phase: "consolidated-slow-publication",
    };
    if (sqliteExportEnabled
      && consolidatedPublicationRequired
      && consolidatedDataValidationStep.ok === true
      && consolidatedGenerationStep?.skipped !== true) {
      await onBeforeHeavyStep("datastore:sqlite:consolidated-slow-publication");
    }
    const consolidatedSqliteStep = await runSqliteExportOrReuse({
      enabled: sqliteExportEnabled
        && consolidatedPublicationRequired
        && consolidatedDataValidationStep.ok === true
        && consolidatedGenerationStep?.skipped !== true,
      generationStep: consolidatedGenerationStep,
      options: { fatal: false, timeoutMs: commandTimeouts.sqlite },
    });
    await releaseSlowFinalArtifactLock();
    await releaseSlowPhaseLock();
    const aliasConsolidatedStep = (step, phase, required) => required
      ? { ...step, phase, consolidated: true }
      : {
          ok: true,
          skipped: true,
          consolidated: true,
          script: step?.script || null,
          phase,
          reason: "consolidated-publication-not-required",
        };
    const postEnrichmentFastResultReconciliationStep = aliasConsolidatedStep(
      consolidatedFastResultReconciliationStep,
      "post-enrichment",
      postEnrichmentPublicationPlan.required,
    );
    const postEnrichmentGenerationStep = aliasConsolidatedStep(
      consolidatedGenerationStep,
      "post-enrichment",
      postEnrichmentPublicationPlan.required,
    );
    const postEnrichmentSqliteStep = aliasConsolidatedStep(
      consolidatedSqliteStep,
      "post-enrichment",
      postEnrichmentPublicationPlan.required,
    );
    const modelReconciledFastResultReconciliationStep = aliasConsolidatedStep(
      consolidatedFastResultReconciliationStep,
      "model-reconciled",
      modelReconciliationRequired,
    );
    const modelReconciledGenerationStep = aliasConsolidatedStep(
      consolidatedGenerationStep,
      "model-reconciled",
      modelReconciliationRequired,
    );
    const modelReconciledSqliteStep = aliasConsolidatedStep(
      consolidatedSqliteStep,
      "model-reconciled",
      modelReconciliationRequired,
    );
    const effectivePostEnrichmentGenerationStep = consolidatedPublicationRequired
      ? consolidatedGenerationStep
      : officialGenerationStep;
    const effectivePostEnrichmentSqliteStep = consolidatedPublicationRequired
      ? consolidatedSqliteStep
      : sqliteStep;
    const readinessSourceCycleObservation = readSourceCycleObservation({
      phase: "readiness",
      validationStep: consolidatedPublicationRequired
        ? consolidatedDataValidationStep
        : postEnrichmentDataValidationStep,
      generationStep: effectivePostEnrichmentGenerationStep,
      sqliteStep: effectivePostEnrichmentSqliteStep,
    });
    const slowSteps = [
      ...enrichmentSteps,
      sourceValidationStep,
      postEnrichmentDataValidationStep,
      postEnrichmentPublicationPlan,
      consolidatedPublicationPlan,
      consolidatedFreeFootballStep,
      consolidatedPreMatchStep,
      consolidatedFastResultReconciliationStep,
      consolidatedDataValidationStep,
      consolidatedGenerationStep,
      consolidatedSqliteStep,
      postEnrichmentFastResultReconciliationStep,
      postEnrichmentGenerationStep,
      postEnrichmentSqliteStep,
      modelBacktestStep,
      autonomousModelLearningStep,
      modelLearningStep,
      capabilityAuditStep,
      modelStrategyStep,
      modelReconciledFastResultReconciliationStep,
      modelReconciledGenerationStep,
      modelReconciledSqliteStep
    ];
    const degradedSteps = slowSteps.filter((step) => step && step.ok === false);
    const slowPhase = withCycleDuration({
      ok: degradedSteps.length === 0,
      skipped: false,
      degraded: degradedSteps.length > 0,
      phase: "slow-enrichment",
      startedAt: slowPhaseStartedAt,
      finishedAt: new Date().toISOString(),
      releaseEnrichmentReuse,
      sourceCycleObservation,
      readinessSourceCycleObservation,
      warnings: degradedSteps.map((step) => `${step.script}: ${step.error}`)
    });
    return {
      ok: true,
      degraded: fastWarnings.length > 0 || degradedSteps.length > 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      cadence,
      releaseCycle,
      slowPhasePlan,
      fastPhase,
      fastResultStep,
      uefaOfficialResultStep,
      officialPhase,
      slowPhase,
      releaseEnrichmentReuse,
      enrichmentSteps,
      sourceValidationStep,
      postEnrichmentDataValidationStep,
      postEnrichmentPublicationPlan,
      consolidatedPublicationPlan,
      consolidatedFreeFootballStep,
      consolidatedPreMatchStep,
      consolidatedFastResultReconciliationStep,
      consolidatedDataValidationStep,
      consolidatedGenerationStep,
      consolidatedSqliteStep,
      postEnrichmentFastResultReconciliationStep,
      postEnrichmentGenerationStep,
      postEnrichmentSqliteStep,
      sourceCycleObservation,
      sqliteStep,
      modelBacktestStep,
      autonomousModelLearningStep,
      modelLearningStep,
      capabilityAuditStep,
      modelStrategyStep,
      modelReconciledFastResultReconciliationStep,
      modelReconciledGenerationStep,
      modelReconciledSqliteStep,
      readinessSourceCycleObservation,
      warnings: [
        ...fastWarnings,
        ...degradedSteps.map((step) => `${step.script}: ${step.error}`)
      ]
    };
    } finally {
      await releaseSlowFinalArtifactLock();
      await releaseSlowPhaseLock();
    }
    };

    if (hooks.deferSlowPhase === true && releaseCycle.priority !== true) {
      const deferredAt = new Date().toISOString();
      const deferredSlowPhase = withCycleDuration({
        ok: true,
        skipped: true,
        deferred: true,
        phase: "slow-enrichment",
        reason: "slow-phase-deferred-to-background-lane",
        startedAt: deferredAt,
        finishedAt: deferredAt,
        plan: slowPhasePlan,
        warnings: [],
      });
      const readinessSourceCycleObservation = readSourceCycleObservation({
        phase: "readiness",
        validationStep: dataValidationStep,
        generationStep: officialGenerationStep,
        sqliteStep,
      });
      const slowPhaseTask = Promise.resolve().then(executeSlowPhase);
      onSlowPhaseDeferred(slowPhaseTask, {
        startedAt: deferredAt,
        plan: slowPhasePlan,
      });
      return {
        ok: true,
        degraded: fastWarnings.length > 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        cadence,
        releaseCycle,
        slowPhasePlan,
        fastPhase,
        fastResultStep,
        uefaOfficialResultStep,
        officialPhase,
        slowPhase: deferredSlowPhase,
        sourceCycleObservation: readinessSourceCycleObservation,
        sqliteStep,
        readinessSourceCycleObservation,
        warnings: fastWarnings,
      };
    }

    return await executeSlowPhase();
  } finally {
    await releasePhaseLock();
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const relaySnapshotFileFingerprint = (filePath) => {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) return { exists: false, token: null };
    return {
      exists: true,
      token: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"),
      bytes: Number(stat.size),
      modifiedAt: new Date(Number(stat.mtimeNs / 1_000_000n)).toISOString()
    };
  } catch {
    return { exists: false, token: null };
  }
};

const relaySnapshotSemanticFileFingerprint = (filePath) => {
  const fileFingerprint = relaySnapshotFileFingerprint(filePath);
  if (!fileFingerprint.exists) return fileFingerprint;
  try {
    const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const endpoints = (Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : [])
      .map((endpoint) => {
        const canonicalPayloadSha256 = String(endpoint?.canonicalPayloadSha256 || "").trim();
        const rawSha256 = String(endpoint?.rawSha256 || "").trim();
        const payloadHash = /^[a-f0-9]{64}$/i.test(canonicalPayloadSha256)
          ? canonicalPayloadSha256.toLowerCase()
          : /^[a-f0-9]{64}$/i.test(rawSha256)
            ? rawSha256.toLowerCase()
            : crypto.createHash("sha256")
              .update(JSON.stringify(endpoint?.payload ?? null))
              .digest("hex");
        return {
          key: [
            String(endpoint?.method || endpoint?.sourceRequest?.method || "").toLowerCase(),
            Number(endpoint?.page || endpoint?.sourceRequest?.page || 0),
            String(endpoint?.url || ""),
          ].join("|"),
          ok: endpoint?.ok !== false,
          rows: Number(endpoint?.rows || 0),
          payloadHash,
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    if (endpoints.length === 0) {
      return {
        ...fileFingerprint,
        semantic: false,
        reason: "relay-endpoints-missing",
      };
    }
    return {
      ...fileFingerprint,
      semantic: true,
      token: crypto.createHash("sha256")
        .update(JSON.stringify(endpoints))
        .digest("hex"),
      endpointCount: endpoints.length,
    };
  } catch (error) {
    return {
      ...fileFingerprint,
      semantic: false,
      reason: `relay-semantic-fingerprint-failed:${error?.code || error?.name || "error"}`,
    };
  }
};

const relaySnapshotFingerprint = (filePath = null) => {
  if (filePath) return relaySnapshotFileFingerprint(filePath);
  const full = relaySnapshotFileFingerprint(relaySnapshotPath);
  const fast = relaySnapshotFileFingerprint(relayFastLaneSnapshotPath);
  return {
    exists: full.exists === true || fast.exists === true,
    token: `full:${full.token || "missing"}|fast:${fast.token || "missing"}`,
    full,
    fast
  };
};

const relaySnapshotSemanticFingerprint = (filePath = null) => {
  if (filePath) return relaySnapshotSemanticFileFingerprint(filePath);
  const full = relaySnapshotSemanticFileFingerprint(relaySnapshotPath);
  const fast = relaySnapshotSemanticFileFingerprint(relayFastLaneSnapshotPath);
  return {
    exists: full.exists === true || fast.exists === true,
    token: `full:${full.token || "missing"}|fast:${fast.token || "missing"}`,
    full,
    fast,
  };
};

const relaySnapshotChanged = (baseline, current) => Boolean(
  current?.exists === true
  && current?.token
  && current.token !== baseline?.token
);

const waitForNextCycle = async (delayMs, options = {}) => {
  const enabled = options.enabled ?? relayWakeEnabled;
  const pollMs = Math.max(100, Number(options.pollMs || relayWakePollMs));
  const readFingerprint = options.readFingerprint || (() => relaySnapshotFingerprint());
  const sleeper = options.sleep || sleep;
  const now = options.now || Date.now;
  const baseline = options.baseline || readFingerprint();
  const startedAtMs = now();
  const deadlineMs = startedAtMs + Math.max(0, Number(delayMs || 0));
  const externalWake = options.wakePromise
    ? Promise.resolve(options.wakePromise).then(
        (value) => ({ external: true, value }),
        (error) => ({
          external: true,
          value: {
            reason: "external-wake-rejected",
            error: error?.message || String(error),
          },
        }),
      )
    : null;

  const waitStep = async (milliseconds) => {
    if (!externalWake) {
      await sleeper(milliseconds);
      return null;
    }
    return Promise.race([
      externalWake,
      Promise.resolve(sleeper(Math.min(milliseconds, pollMs))).then(() => null),
    ]);
  };

  if (externalWake) {
    const immediateWake = await Promise.race([
      externalWake,
      Promise.resolve().then(() => null),
    ]);
    if (immediateWake?.external) {
      return {
        reason: immediateWake.value?.reason || "external-wake",
        waitedMs: 0,
        baseline,
        current: enabled ? readFingerprint() : null,
        external: immediateWake.value || null,
      };
    }
  }

  if (enabled) {
    const current = readFingerprint();
    if (relaySnapshotChanged(baseline, current)) {
      return {
        reason: "relay-snapshot-updated",
        waitedMs: 0,
        baseline,
        current
      };
    }
  }

  while (now() < deadlineMs) {
    const remainingMs = Math.max(0, deadlineMs - now());
    const wake = await waitStep(Math.min(enabled || externalWake ? pollMs : remainingMs, remainingMs));
    if (wake?.external) {
      return {
        reason: wake.value?.reason || "external-wake",
        waitedMs: Math.max(0, now() - startedAtMs),
        baseline,
        current: enabled ? readFingerprint() : null,
        external: wake.value || null,
      };
    }
    if (!enabled) continue;
    const current = readFingerprint();
    if (relaySnapshotChanged(baseline, current)) {
      return {
        reason: "relay-snapshot-updated",
        waitedMs: Math.max(0, now() - startedAtMs),
        baseline,
        current
      };
    }
  }

  return {
    reason: "interval-elapsed",
    waitedMs: Math.max(0, now() - startedAtMs),
    baseline,
    current: enabled ? readFingerprint() : null
  };
};

const nextCycleDelayMs = (
  cycleStartedAt,
  intervalMs,
  now = Date.now(),
  options = {},
) => {
  if (options.fromCompletion === true) {
    return Math.max(minimumLoopIdleMs, Math.max(0, Number(intervalMs || 0)));
  }
  const startedAtMs = Date.parse(cycleStartedAt || "");
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
  return Math.max(minimumLoopIdleMs, Math.max(0, Number(intervalMs || 0) - elapsedMs));
};

const main = async () => {
  if (statusOnly) {
    const cadence = describeSyncCadence();
    const status = workerStatusState
      ? {
          ...workerStatusState,
          query: {
            type: "sync-worker-status",
            queriedAt: new Date().toISOString(),
            queryPid: process.pid,
            cadence
          }
        }
      : {
          version: 1,
          worker: "football-sync-worker",
          ok: false,
          type: "sync-worker-status",
          cycleState: "missing",
          checkedAt: null,
          loop,
          pid: null,
          cadence,
          pipeline: describeCycleStages(),
          ...workerHistoryFields(null)
        };
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  let candidateDeadlineHeartbeat = null;
  let benchmarkDeadlineHeartbeat = null;
  let backgroundSlowPhasePromise = null;
  let releaseDrainBlocker = null;
  let officialCompensationPending = false;
  const markShutdownInterrupted = (state = "requested") => {
    const request = runtimeShutdownController.request || {};
    const currentBackground = workerStatusState?.backgroundSlowPhase || null;
    writeWorkerStatusBestEffort({
      ...(workerStatusState || {}),
      ok: true,
      checkedAt: new Date().toISOString(),
      cycleState: state === "completed" ? "stopped" : "stopping",
      phase: "interrupted",
      shutdown: {
        state,
        signal: request.signal || null,
        requestedAt: request.requestedAt || null,
        activeCommands: runtimeShutdownController.activeCount,
      },
      backgroundSlowPhase: (backgroundSlowPhasePromise || currentBackground?.state === "running")
        ? {
            ...(currentBackground || {}),
            state: "interrupted",
            finishedAt: state === "completed" ? new Date().toISOString() : null,
            signal: request.signal || null,
          }
        : currentBackground,
    });
  };
  const handleShutdownSignal = (signal) => {
    runtimeShutdownController.requestShutdown(signal);
    candidateDeadlineHeartbeat?.pause();
    benchmarkDeadlineHeartbeat?.pause();
    markShutdownInterrupted("requested");
  };
  const handleSigterm = () => handleShutdownSignal("SIGTERM");
  const handleSigint = () => handleShutdownSignal("SIGINT");
  process.once("SIGTERM", handleSigterm);
  process.once("SIGINT", handleSigint);
  candidateDeadlineHeartbeat = loop
    ? startCandidateProspectiveDeadlineHeartbeat()
    : null;
  if (loop && candidateDeadlineHeartbeat && benchmarkDeadlineCaptureEnabled) {
    // Formal cutoff publication owns startup priority. Arm the independent
    // benchmark lane only after the first exact heartbeat, and schedule its
    // first attempt one normal interval later so it cannot compete with the
    // formal child or block the heavy-step admission barrier.
    void candidateDeadlineHeartbeat.waitForPublished().then(() => {
      if (runtimeShutdownController.requested || benchmarkDeadlineHeartbeat) return;
      benchmarkDeadlineHeartbeat = startBenchmarkProspectiveDeadlineCapture({ immediate: false });
    });
  }
  const startupResultRecoveryPlan = describeFiveHundredResultFallbackNeed();
  let startupDeadlineAdmissionPending = candidateDeadlineHeartbeat !== null;
  let candidateImplementationRefreezePending = false;
  // The official fixture/result lane is append-only with respect to frozen
  // recommendations, so it must not be held behind an unhealthy candidate
  // heartbeat. The first heavy-step barrier below recomputes deadline risk and
  // remains fail-closed when a cutoff is missing, near, or overdue without a
  // complete capture. Otherwise it drains only the current bounded attempt;
  // the independent heartbeat keeps retrying in the background.
  let cycleWake = null;
  const backgroundSlowPhaseTracker = createBackgroundSlowPhaseTracker({
    onCurrentChange: (current) => {
      backgroundSlowPhasePromise = current;
    },
  });
  const trackBackgroundSlowPhase = backgroundSlowPhaseTracker.track;
  do {
    if (runtimeShutdownController.requested) break;
    candidateDeadlineHeartbeat?.resume();
    benchmarkDeadlineHeartbeat?.resume();
    const preCycleReleaseRequest = inspectReleaseWorkerPriorityRequest({
      rootDir,
      storeDir,
    });
    if (preCycleReleaseRequest.pending === true && backgroundSlowPhasePromise) {
      if (releaseDrainBlocker?.task !== backgroundSlowPhasePromise) {
        const drainTask = backgroundSlowPhasePromise;
        const drain = await waitForBackgroundSlowPhaseDrain(drainTask, {
          budgetMs: releaseSlowPhaseDrainBudgetMs,
          interruptPromise: runtimeShutdownController.wakePromise,
        });
        releaseDrainBlocker = drain.ok === true
          ? null
          : { ...drain, task: drainTask };
      }
      if (runtimeShutdownController.requested) break;
      if (releaseDrainBlocker?.task === backgroundSlowPhasePromise) {
        const diagnostic = {
          ...releaseDrainBlocker,
          task: undefined,
          pendingSince: releaseDrainBlocker.startedAt || null,
        };
        writeWorkerStatusBestEffort({
          ...(workerStatusState || {}),
          ok: false,
          checkedAt: new Date().toISOString(),
          cycleState: "release-blocked",
          phase: "release-priority-drain-blocked",
          releaseDrain: diagnostic,
          error: diagnostic.reason,
          errorCode: diagnostic.code,
          nextWakeAt: new Date(Date.now() + releaseCycleRetryMs).toISOString(),
        });
        cycleWake = await waitForNextCycle(releaseCycleRetryMs, {
          enabled: false,
          wakePromise: Promise.race([
            backgroundSlowPhasePromise.then(() => ({
              reason: "background-slow-phase-settled-after-release-drain-block",
            })),
            runtimeShutdownController.wakePromise,
          ]),
        });
        continue;
      }
      releaseDrainBlocker = null;
    }
    const cadence = describeSyncCadence();
    const activeCycleStartedAt = new Date().toISOString();
    const activeCycleRelaySemanticBaseline = relaySnapshotSemanticFingerprint();
    let relayWakeEligible = cadence.mode === "hot";
    let loopDelayMs = cadence.intervalMs;
    let relayCatchupRequired = false;
    let postCycleRelaySemantic = null;
    let activeEventCycle = workerStatusState?.eventCycle || workerStatusState?.lastCycle || null;
    let fastPublishedThisCycle = false;
    let fullOfficialPublishedThisCycle = false;
    const slowPhaseRunningAtCycleStart = backgroundSlowPhasePromise !== null;
    try {
      const previousHistory = workerHistoryFields(workerStatusState);
      writeWorkerStatus({
        ok: true,
        type: "sync-worker-cycle",
        cycleState: "running",
        checkedAt: activeCycleStartedAt,
        loop,
        pid: process.pid,
        cadence,
        phase: "official-result",
        pipeline: describeCycleStages(),
        wake: cycleWake,
        relayWake: {
          enabled: relayWakeEnabled,
          eligible: relayWakeEligible,
          pollSeconds: Number((relayWakePollMs / 1000).toFixed(2))
        },
        eventCycle: activeEventCycle,
        nextWakeAt: null,
        ...previousHistory
      });
      const result = await runCycle(cadence, {
        deferSlowPhase: loop,
        slowPhaseRunning: slowPhaseRunningAtCycleStart,
        onSlowPhaseDeferred: trackBackgroundSlowPhase,
        isInterrupted: () => runtimeShutdownController.requested,
        requiresCandidateImplementationRefreeze: () => (
          candidateImplementationRefreezePending
        ),
        onBeforeHeavyStep: async () => {
          if (runtimeShutdownController.requested) {
            throw runtimeShutdownController.interruptionError();
          }
          if (startupDeadlineAdmissionPending && candidateDeadlineHeartbeat) {
            // The immediate startup capture may replace a structurally valid
            // pre-swap heartbeat with an implementation-drift hold. Observe
            // that first attempt before deciding which admission wait applies.
            await candidateDeadlineHeartbeat.waitForIdle();
            let captureStatus = readJson(candidateProspectiveCaptureStatusFile, null);
            if (candidateImplementationDriftAwaitingRefreeze(captureStatus)) {
              candidateImplementationRefreezePending = true;
            }
            const startupDeadlineAdmission = describeCandidateDeadlineStartupAdmission({
              captureStatus,
              resultRecoveryPlan: startupResultRecoveryPlan,
            });
            if (startupDeadlineAdmission.waitForPublished) {
              const admission = await Promise.race([
                candidateDeadlineHeartbeat.waitForStartupAdmission(),
                runtimeShutdownController.wakePromise,
              ]);
              if (admission?.recoveryRequired === true) {
                candidateImplementationRefreezePending = true;
              }
            }
            startupDeadlineAdmissionPending = false;
          }
          const captureStatus = readJson(candidateProspectiveCaptureStatusFile, null);
          if (candidateImplementationDriftAwaitingRefreeze(captureStatus)) {
            // Latch this state for the complete cycle. A later lock-busy or
            // retry status cannot erase the obligation to refreeze and prove
            // a new exact heartbeat.
            candidateImplementationRefreezePending = true;
          }
          // Drain an already-running cutoff capture before admitting the next
          // memory-heavy child.  The heartbeat remains enabled during the
          // child; this barrier only prevents simultaneous child-tree launch
          // and does not relax or manufacture the 120s freshness contract.
          await candidateDeadlineHeartbeat?.waitForHealthy({
            allowImplementationDrift: candidateImplementationRefreezePending,
          });
          if (runtimeShutdownController.requested) {
            throw runtimeShutdownController.interruptionError();
          }
        },
        onAfterModelBacktest: async (modelBacktestStep) => {
          if (!candidateImplementationRefreezePending) return;
          assertCandidateImplementationRefreezeBacktest(modelBacktestStep);
          // The model backtest retires the old implementation revision and
          // freezes the replacement. No learning, strategy, publication, or
          // readiness step may proceed until that live registry produces a
          // genuinely exact formal heartbeat.
          await candidateDeadlineHeartbeat?.waitForHealthy();
          candidateImplementationRefreezePending = false;
        },
        onFastPublished: async (fastPhase) => {
          activeEventCycle = fastPhase;
          fastPublishedThisCycle = true;
          const currentHistory = workerHistoryFields(workerStatusState);
          writeWorkerStatus({
            ok: true,
            type: "sync-worker-cycle",
            cycleState: "running",
            checkedAt: new Date().toISOString(),
            loop,
            pid: process.pid,
            cadence,
            phase: "official-result",
            pipeline: describeCycleStages(),
            wake: cycleWake,
            relayWake: {
              enabled: relayWakeEnabled,
              eligible: relayWakeEligible,
              pollSeconds: Number((relayWakePollMs / 1000).toFixed(2))
            },
            eventCycle: activeEventCycle,
            nextWakeAt: null,
            ...currentHistory
          });
          // The server observes this single-slot status file on a timer. Keep the
          // fast event visible for at least one complete poll window so a very
          // quick full sync cannot overwrite it before API caches and SSE update.
          await waitForFastEventVisibility();
        },
        onOfficialPublished: async (officialPhase) => {
          activeEventCycle = officialPhase;
          fullOfficialPublishedThisCycle = true;
          const currentHistory = workerHistoryFields(workerStatusState);
          writeWorkerStatus({
            ok: true,
            type: "sync-worker-cycle",
            cycleState: "running",
            checkedAt: new Date().toISOString(),
            loop,
            pid: process.pid,
            cadence,
            phase: "slow-enrichment",
            pipeline: describeCycleStages(),
            wake: cycleWake,
            relayWake: {
              enabled: relayWakeEnabled,
              eligible: relayWakeEligible,
              pollSeconds: Number((relayWakePollMs / 1000).toFixed(2))
            },
            eventCycle: activeEventCycle,
            nextWakeAt: null,
            ...currentHistory
          });
        }
      });
      const completedCycle = withCycleDuration(result);
      if (officialCompensationRequired({
        cycle: completedCycle,
        slowPhaseRunning: slowPhaseRunningAtCycleStart,
      })) {
        officialCompensationPending = true;
      } else if (fullOfficialPublishedThisCycle) {
        officialCompensationPending = false;
      }
      if (releaseCycleNeedsReadinessHandoff(completedCycle)) {
        // The release validator publishes its own exact cutoff heartbeat after
        // observing sleeping state. Stop scheduling worker captures and drain
        // the current child before advertising that handoff, otherwise both
        // writers can contend on the prospective registry lock and force a
        // healthy signed release to roll back.
        candidateDeadlineHeartbeat?.pause();
        benchmarkDeadlineHeartbeat?.pause();
        await candidateDeadlineHeartbeat?.waitForIdle();
        await benchmarkDeadlineHeartbeat?.waitForIdle();
      }
      if (activeEventCycle && completedCycle.degraded === true) {
        activeEventCycle = {
          ...activeEventCycle,
          degraded: true,
          warnings: completedCycle.warnings || []
        };
      }
      const runningHistory = workerHistoryFields(workerStatusState);
      const nextCadence = describeSyncCadence();
      const postDeadlineCooldown = [
        "live-match",
        "pending-result",
        "post-deadline-near-kickoff",
        "recent-kickoff",
      ].includes(nextCadence.reason);
      relayWakeEligible = nextCadence.mode === "hot" && !postDeadlineCooldown;
      const normalLoopDelayMs = nextCycleDelayMs(
        activeCycleStartedAt,
        nextCadence.intervalMs,
        Date.now(),
        {
          fromCompletion: postDeadlineCooldown
            || nextCadence.mode === "hot"
            || (completedCycle.slowPhase && completedCycle.slowPhase.skipped !== true),
        },
      );
      loopDelayMs = releaseCycleDelayMs(completedCycle, normalLoopDelayMs);
      postCycleRelaySemantic = relaySnapshotSemanticFingerprint();
      relayCatchupRequired = relayCatchupRequiredAfterCycle({
        loop,
        enabled: relayWakeEnabled,
        eligible: relayWakeEligible,
        baseline: activeCycleRelaySemanticBaseline,
        current: postCycleRelaySemantic,
        cycle: completedCycle,
      });
      const nextWakeAt = loop
        ? new Date(Date.now() + (relayCatchupRequired ? 0 : loopDelayMs)).toISOString()
        : null;
      writeWorkerStatus({
        ok: true,
        type: "sync-worker-cycle",
        cycleState: loop ? (relayCatchupRequired ? "running" : "sleeping") : "stopped",
        checkedAt: new Date().toISOString(),
        loop,
        pid: process.pid,
        cadence: nextCadence,
        phase: loop ? (relayCatchupRequired ? "relay-catchup-pending" : "sleeping") : "stopped",
        pipeline: describeCycleStages(),
        wake: cycleWake,
        relayWake: {
          enabled: relayWakeEnabled,
          eligible: relayWakeEligible,
          pollSeconds: Number((relayWakePollMs / 1000).toFixed(2)),
          catchupRequired: relayCatchupRequired,
          cycleSemanticBaseline: activeCycleRelaySemanticBaseline,
          cycleSemanticCurrent: postCycleRelaySemantic,
        },
        officialCompensation: {
          pending: officialCompensationPending,
          reason: officialCompensationPending
            ? "background-slow-publication-lock-blocked-official-cycle"
            : null,
        },
        eventCycle: activeEventCycle,
        lastCycle: completedCycle,
        lastCompleteCycle: completePublicationCycleEvidence(completedCycle)
          || runningHistory.lastCompleteCycle,
        lastSuccessAt: completedCycle.ok === true && completedCycle.skipped !== true
          ? completedCycle.finishedAt || new Date().toISOString()
          : runningHistory.lastSuccessAt,
        lastSlowPhaseAt: completedCycle.slowPhase && completedCycle.slowPhase.skipped !== true
          ? completedCycle.slowPhase.finishedAt || completedCycle.finishedAt || new Date().toISOString()
          : runningHistory.lastSlowPhaseAt,
        lastCycleDurationMs: completedCycle.durationMs,
        lastError: null,
        nextWakeAt
      });
      console.log(JSON.stringify({ type: "sync-worker-cycle", ...completedCycle }, null, 2));
    } catch (error) {
      if (runtimeShutdownController.requested) {
        loopDelayMs = 0;
        markShutdownInterrupted("draining");
        try {
          console.error(JSON.stringify({
            type: "sync-worker-interrupted",
            at: new Date().toISOString(),
            signal: runtimeShutdownController.request?.signal || null,
            error: error?.message || String(error),
            errorCode: error?.code || null,
          }));
        } catch {
          // Shutdown diagnostics remain best effort.
        }
      } else {
      const failedAt = new Date().toISOString();
      const runningHistory = workerHistoryFields(workerStatusState);
      const lastError = summarizeWorkerError(error, failedAt);
      const failedCycle = withCycleDuration({
        ok: false,
        phase: fullOfficialPublishedThisCycle ? "slow-enrichment-failed" : "official-result-failed",
        startedAt: activeCycleStartedAt,
        finishedAt: failedAt,
        error: lastError.message,
        errorCode: lastError.code,
        timeoutMs: lastError.timeoutMs
      });
      const nextCadence = describeSyncCadence();
      const postDeadlineCooldown = [
        "live-match",
        "pending-result",
        "post-deadline-near-kickoff",
        "recent-kickoff",
      ].includes(nextCadence.reason);
      relayWakeEligible = nextCadence.mode === "hot" && !postDeadlineCooldown;
      loopDelayMs = nextCycleDelayMs(
        activeCycleStartedAt,
        nextCadence.intervalMs,
        Date.now(),
        { fromCompletion: postDeadlineCooldown || nextCadence.mode === "hot" },
      );
      const nextWakeAt = loop ? new Date(Date.now() + loopDelayMs).toISOString() : null;
      const failure = {
        type: "sync-worker-failed",
        ok: false,
        cycleState: loop ? "sleeping" : "failed",
        at: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        loop,
        pid: process.pid,
        cadence: nextCadence,
        phase: "failed",
        pipeline: describeCycleStages(),
        wake: cycleWake,
        relayWake: {
          enabled: relayWakeEnabled,
          eligible: relayWakeEligible,
          pollSeconds: Number((relayWakePollMs / 1000).toFixed(2))
        },
        fastPublishedThisCycle,
        eventCycle: fullOfficialPublishedThisCycle ? activeEventCycle : failedCycle,
        lastCycle: failedCycle,
        lastCompleteCycle: runningHistory.lastCompleteCycle,
        lastSuccessAt: runningHistory.lastSuccessAt,
        lastSlowPhaseAt: runningHistory.lastSlowPhaseAt,
        lastCycleDurationMs: failedCycle.durationMs,
        lastError,
        nextWakeAt,
        error: lastError.message,
        errorCode: lastError.code,
        timeoutMs: lastError.timeoutMs
      };
      writeWorkerStatus(failure);
      console.error(JSON.stringify(failure, null, 2));
      if (!loop) process.exitCode = 1;
      }
    }
    if (loop && !runtimeShutdownController.requested) {
      const postCycleRelayBaseline = relaySnapshotFingerprint();
      const compensationWakePromise = officialCompensationPending
        ? backgroundSlowPhasePromise
          ? backgroundSlowPhasePromise.then(() => ({
              reason: "background-slow-phase-settled-official-compensation",
            }))
          : Promise.resolve({
              reason: "background-slow-phase-already-settled-official-compensation",
            })
        : null;
      const externalWakePromise = compensationWakePromise
        ? Promise.race([
            compensationWakePromise,
            runtimeShutdownController.wakePromise,
          ])
        : runtimeShutdownController.wakePromise;
      if (relayCatchupRequired) {
        cycleWake = {
          reason: "relay-semantic-change-during-cycle",
          waitedMs: 0,
          baseline: activeCycleRelaySemanticBaseline,
          current: postCycleRelaySemantic,
        };
      } else {
        cycleWake = await waitForNextCycle(loopDelayMs, {
          baseline: postCycleRelayBaseline,
          enabled: relayWakeEnabled && relayWakeEligible,
          wakePromise: externalWakePromise,
        });
      }
    }
  } while (loop && !runtimeShutdownController.requested);
  candidateDeadlineHeartbeat?.pause();
  candidateDeadlineHeartbeat?.stop?.();
  benchmarkDeadlineHeartbeat?.pause();
  benchmarkDeadlineHeartbeat?.stop?.();
  await benchmarkDeadlineHeartbeat?.waitForIdle();
  if (backgroundSlowPhasePromise) {
    await waitForBackgroundSlowPhaseDrain(backgroundSlowPhasePromise, {
      budgetMs: shutdownDrainBudgetMs,
    });
  }
  if (runtimeShutdownController.requested) markShutdownInterrupted("completed");
  runtimeShutdownController.dispose();
  process.removeListener("SIGTERM", handleSigterm);
  process.removeListener("SIGINT", handleSigint);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  acquireSyncLockInterruptibly,
  assertCandidateImplementationRefreezeBacktest,
  benchmarkDeadlineCaptureEnabled,
  benchmarkDeadlineCaptureIntervalMs,
  benchmarkDeadlineCaptureStatusAdvanced,
  benchmarkDeadlineCaptureTimeoutMs,
  commandTimeouts,
  candidateDeadlineCaptureEnabled,
  candidateDeadlineCaptureForceSettleMs,
  candidateDeadlineCaptureIntervalMs,
  candidateDeadlineCaptureRecoveryBudgetMs,
  candidateDeadlineCaptureRetryMs,
  candidateDeadlineCaptureSafetyMarginMs,
  candidateDeadlineCaptureStatusAdvanced,
  candidateDeadlineCaptureTerminateGraceMs,
  candidateDeadlineCaptureTimeoutMs,
  candidateDeadlineCaptureCompleteThrough,
  candidateImplementationDriftAwaitingRefreeze,
  candidateDeadlineAttemptBudget,
  candidateDeadlineHeartbeatFreshnessLimitMs,
  candidateDeadlinePreemptiveSchedule,
  candidateDeadlineStartupSafetyWindowMs,
  cycleDurationMs,
  createBackgroundSlowPhaseTracker,
  createWorkerShutdownController,
  describeCycleStages,
  describeConsolidatedSlowPublicationNeed,
  describeFiveHundredResultFallbackNeed,
  describeCandidateDeadlineStartupAdmission,
  describeModelStrategyReconciliationNeed,
  describeModelBacktestNeed,
  describePostEnrichmentPublicationNeed,
  describeSlowPhaseNeed,
  describeSyncCadence,
  fastEventVisibilityMs,
  footballDataResultsWorkerEnv,
  main,
  modelStrategyReconciliationFingerprint,
  modelCandidateRegistryLockTimeoutMs,
  nextCycleDelayMs,
  officialPublishEvidenceAfter,
  officialCompensationRequired,
  phaseLockWaitMs,
  releaseCycleDelayMs,
  releaseCycleInitialLockWaitMs,
  releaseCycleNeedsPriorityRetry,
  releaseCycleNeedsReadinessHandoff,
  releaseCycleRetryMs,
  releaseSlowPhaseDrainBudgetMs,
  readinessIdleEvidenceAfter,
  relaySnapshotChanged,
  relayCatchupRequiredAfterCycle,
  relaySnapshotFingerprint,
  relaySnapshotSemanticFingerprint,
  relaySnapshotSemanticFileFingerprint,
  readSourceCycleObservation,
  inspectSqlitePublicationReuse,
  runSqliteExportOrReuse,
  runCommand,
  runCandidateProspectiveDeadlineCapture,
  runBenchmarkProspectiveDeadlineCapture,
  runWithSharedSlowArtifactLock,
  startCandidateProspectiveDeadlineHeartbeat,
  startBenchmarkProspectiveDeadlineCapture,
  summarizeWorkerError,
  slowPhaseMinIntervalMs,
  slowPublicationLockWaitMs,
  usesSharedSlowArtifact,
  webConsensusRefreshDue,
  waitForFastEventVisibility,
  waitForNextCycle,
  waitForBackgroundSlowPhaseDrain,
  writeWorkerStatusBestEffort,
  writeJsonAtomic,
  withCycleDuration,
  workerHistoryFields
};
