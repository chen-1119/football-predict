const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { acquireSyncLock } = require("../server/syncLock.cjs");
const { resolveActivePublication } = require("../server/dataGenerationBundle.cjs");
const { readPointer, storePaths } = require("../server/dataGenerationStore.cjs");
const {
  evaluateReleaseEnrichmentReuseRequest,
  inspectReleaseWorkerPriorityRequest,
} = require("./releaseEnrichmentReuse.cjs");
const {
  decisionDeadlineFor,
} = require("./candidateProspectiveLedger.cjs");
const {
  candidateHeartbeatAttemptBudget,
  candidateHeartbeatPreemptiveSchedule,
} = require("../server/candidateHeartbeatSchedule.cjs");

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
const sqliteReadSourceEnabled = process.env.DATASTORE_READ_SOURCE === "sqlite" || process.env.CURRENT_MATCH_SOURCE === "sqlite";
const sqliteExportEnabled = process.env.ENABLE_SQLITE_EXPORT === "1" || sqliteReadSourceEnabled;
const modelBacktestOnSync = process.env.ENABLE_MODEL_BACKTEST_ON_SYNC === "1";
const modelBacktestMinIntervalMs = Math.max(5, Number(process.env.MODEL_BACKTEST_ON_SYNC_MIN_INTERVAL_MINUTES || 30)) * 60 * 1000;
const modelBacktestForce = process.env.MODEL_BACKTEST_ON_SYNC_FORCE === "1";
const candidateDeadlineCaptureEnabled =
  process.env.ENABLE_CANDIDATE_PROSPECTIVE_DEADLINE_CAPTURE !== "0";
const candidateDeadlineCaptureIntervalMs = Math.max(
  15,
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_INTERVAL_SECONDS", 30),
) * 1000;
const candidateDeadlineCaptureTimeoutMs = Math.max(
  5_000,
  finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_TIMEOUT_MS", 45_000),
);
const candidateDeadlineCaptureRetryMs = Math.max(
  1_000,
  Math.min(
    candidateDeadlineCaptureIntervalMs,
    finiteEnvNumber("CANDIDATE_PROSPECTIVE_CAPTURE_RETRY_MS", 5_000),
  ),
);
const candidateDeadlineHeartbeatFreshnessLimitMs = 120_000;
const candidateDeadlineCaptureRecoveryBudgetMs = Math.max(
  1_000,
  Math.min(
    candidateDeadlineCaptureTimeoutMs,
    finiteEnvNumber(
      "CANDIDATE_PROSPECTIVE_CAPTURE_RECOVERY_BUDGET_MS",
      candidateDeadlineCaptureTimeoutMs,
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
// 65s before the recovery attempt can start, invalidating the 120s heartbeat
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
const candidateDeadlineCaptureScript = path.join(
  rootDir,
  "scripts",
  "captureCandidateProspectiveDeadline.cjs",
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

const commandTimeoutError = (command, args, timeoutMs) => {
  const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
  error.code = "SYNC_WORKER_COMMAND_TIMEOUT";
  error.command = command;
  error.args = args;
  error.timeoutMs = timeoutMs;
  return error;
};

const runCommand = (command, args, extraEnv = {}, options = {}) => new Promise((resolve, reject) => {
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
    && status?.version === "prospective-deadline-heartbeat-v2"
    && Number.isFinite(startedAtMs)
    && Number.isFinite(evaluatedAtMs)
    && evaluatedAtMs >= startedAtMs
  );
};

const runCandidateProspectiveDeadlineCapture = async ({
  timeoutMs = candidateDeadlineCaptureTimeoutMs,
  attemptKind = "scheduled",
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
    const result = await runCommand(
      process.execPath,
      [candidateDeadlineCaptureScript],
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
    const status = readJson(candidateProspectiveCaptureStatusFile, null);
    if (!candidateDeadlineCaptureStatusAdvanced(result, status)) {
      const failed = {
        ...result,
        ok: false,
        skipped: false,
        reason: "candidate-deadline-capture-status-not-advanced",
        statusAdvanced: false,
        statusEvaluatedAt: status?.evaluatedAt || null,
      };
      writeCandidateDeadlineCaptureAttempt({
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
    writeCandidateDeadlineCaptureAttempt({
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
    const failed = {
      ok: false,
      skipped: false,
      reason: "candidate-deadline-capture-failed",
      error: error?.message || String(error),
      errorCode: error?.code || null,
    };
    writeCandidateDeadlineCaptureAttempt({
      startedAt: attemptStartedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      skipped: false,
      reason: failed.reason,
      statusAdvanced: false,
      publishedEvaluatedAt:
        readJson(candidateProspectiveCaptureStatusFile, null)?.evaluatedAt || null,
      error: failed.error,
      errorCode: failed.errorCode,
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
  let nextRunAt = null;
  let lastSchedule = null;
  let inFlightTick = null;
  let lastResult = null;
  let resolveFirstPublication = null;
  const firstPublication = new Promise((resolve) => {
    resolveFirstPublication = resolve;
  });
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
    if (stopped) return null;
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
    if (stopped || retryHandle !== null) return;
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
      if (result?.ok === true && result?.skipped !== true) {
        lastResult = result;
        if (resolveFirstPublication) {
          resolveFirstPublication(result);
          resolveFirstPublication = null;
        }
        clearRetry();
        scheduleNormal(result.statusEvaluatedAt || readStatus()?.evaluatedAt || null);
      } else {
        lastResult = result;
        scheduleRetry();
      }
      return result;
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
    get lastResult() { return lastResult; },
    waitForIdle: () => inFlightTick || Promise.resolve(lastResult),
    waitForPublished: () => firstPublication,
    stop: () => {
      stopped = true;
      clearNormal();
      clearRetry();
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
  enabledInput = process.env.ENABLE_500_DETAILS_SYNC === "1"
    && process.env.ENABLE_500_RESULT_FALLBACK !== "0"
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

const describeModelBacktestNeed = ({ sqliteStep = null } = {}) => {
  const evaluation = readJson(path.join(rootDir, "public", "data", "model-evaluation.json"), null);
  const syncMeta = readJson(path.join(rootDir, "public", "data", "sync-meta.json"), null);
  const lastStatus = readJson(modelBacktestStatusFile, null);
  const candidateCaptureStatus = readJson(candidateProspectiveCaptureStatusFile, null);
  const candidateImplementationDrift = (
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

const maybeRunModelBacktest = async ({ sqliteStep = null } = {}) => {
  const decision = describeModelBacktestNeed({ sqliteStep });
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

const describeCycleStages = () => ([
  {
    id: "candidate-deadline-heartbeat",
    fatal: false,
    concurrent: true,
    operations: [
      "candidate:capture-deadline",
      "candidate:settle-prospective-ledger",
    ],
  },
  {
    id: "official-result-fast",
    fatal: false,
    operations: [
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
    operations: ["sync:data", "validate:data", "datastore:generation", "datastore:sqlite", "publish-event"]
  },
  {
    id: "slow-enrichment",
    fatal: false,
    operations: [
      "sync:500",
      "sync:500:details",
      "sync:weather",
      "sync:football-data-fixtures",
      "sync:open-research",
      "sync:web-consensus",
      "sync:free-football",
      "sync:prematch",
      "audit:recommendation-bias",
      "validate:sources",
      "validate:data:post-enrichment",
      "reconcile:fast-results-generation:post-enrichment",
      "datastore:generation:post-enrichment",
      "datastore:sqlite:post-enrichment",
      "observe:source-cycle",
      "model:backtest",
      "model:learn:autonomous",
      "model:learn",
      "audit:capability",
      "optimize:strategy",
      "reconcile:fast-results-generation:model-reconciled",
      "datastore:generation:model-reconciled",
      "datastore:sqlite:model-reconciled",
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
    lastCycleDurationMs: status?.lastCycleDurationMs !== null
      && status?.lastCycleDurationMs !== undefined
      && Number.isFinite(Number(status.lastCycleDurationMs))
      ? Math.max(0, Math.round(Number(status.lastCycleDurationMs)))
      : cycleDurationMs(lastCycle),
    lastError: lastError || null
  };
};

let workerStatusState = readJson(statusFile, null);

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

const runCycle = async (cadence = describeSyncCadence(), hooks = {}) => {
  const startedAt = new Date().toISOString();
  const onFastPublished = typeof hooks.onFastPublished === "function"
    ? hooks.onFastPublished
    : async () => {};
  const onOfficialPublished = typeof hooks.onOfficialPublished === "function"
    ? hooks.onOfficialPublished
    : async () => {};
  const onBeforeHeavyStep = typeof hooks.onBeforeHeavyStep === "function"
    ? hooks.onBeforeHeavyStep
    : async () => {};
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
  let syncLock = await acquireSyncLock({
    owner: "football-sync-worker",
    source: "sync-worker-cycle",
    waitMs: releaseCycle.initialLockWaitMs,
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
    const nextLock = await acquireSyncLock({
      owner: "football-sync-worker",
      source,
      waitMs: phaseLockWaitMs,
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
    const fastResultStep = await runBestEffort(
      "publish:official-results-fast",
      async () => {
        const { publishOfficialResultsFast } = require("./publishOfficialResultsFast.cjs");
        return {
          script: "publish:official-results-fast",
          ...publishOfficialResultsFast(),
        };
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
      fastResultStep,
      uefaOfficialResultStep,
      officialClubResultStep,
      fiveHundredResultFallbackStep,
      officialSyncStep,
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

    const slowPhaseStartedAt = new Date().toISOString();
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
      return runOptional(enabled, script, extraEnv, enrichmentOptions);
    };
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_500_SYNC !== "0", "sync:500"));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_500_DETAILS_SYNC === "1", "sync:500:details"));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_WEATHER_SYNC !== "0", "sync:weather"));
    const footballDataFixturesStatus = readJson(footballDataFixturesStatusFile, null);
    const footballDataFixturesDue = process.env.ENABLE_FOOTBALL_DATA_FIXTURES_SYNC !== "0"
      && ageMs(footballDataFixturesStatus?.checkedAt) >= footballDataFixturesMinIntervalMs;
    enrichmentSteps.push(await runEnrichment(
      footballDataFixturesDue,
      "sync:football-data-fixtures",
      {}
    ));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_OPEN_RESEARCH_SYNC !== "0", "sync:open-research"));
    enrichmentSteps.push(await runEnrichment(
      process.env.ENABLE_WEB_CONSENSUS_SYNC !== "0" && webConsensusRefreshDue(),
      "sync:web-consensus",
      {}
    ));
    enrichmentSteps.push(await runEnrichment(
      process.env.ENABLE_FREE_FOOTBALL_SYNC !== "0",
      "sync:free-football",
      {}
    ));
    enrichmentSteps.push(await runEnrichment(process.env.ENABLE_PREMATCH_SIGNALS_SYNC !== "0", "sync:prematch"));
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
    if (postEnrichmentPublicationPlan.required) {
      await acquirePhaseLock("sync-worker-post-enrichment-publication");
    }
    const postEnrichmentFastResultReconciliationStep = {
      ...(await runOptional(
        postEnrichmentPublicationPlan.required,
        "reconcile:fast-results-generation",
        {},
        { timeoutMs: commandTimeouts.validation }
      )),
      phase: "post-enrichment",
    };
    if (postEnrichmentDataValidationStep.ok === true
      && postEnrichmentPublicationPlan.required) {
      await onBeforeHeavyStep("datastore:generation:post-enrichment");
    }
    const postEnrichmentGenerationStep = {
      ...(await runOptional(
        postEnrichmentDataValidationStep.ok === true
          && postEnrichmentPublicationPlan.required,
        "datastore:generation",
        {
          SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        },
        { fatal: false, timeoutMs: commandTimeouts.sqlite }
      )),
      phase: "post-enrichment",
    };
    if (sqliteExportEnabled
      && postEnrichmentDataValidationStep.ok === true
      && postEnrichmentPublicationPlan.required) {
      await onBeforeHeavyStep("datastore:sqlite:post-enrichment");
    }
    const postEnrichmentSqliteStep = {
      ...(await runSqliteExportOrReuse({
        enabled: sqliteExportEnabled
          && postEnrichmentDataValidationStep.ok === true
          && postEnrichmentPublicationPlan.required,
        generationStep: postEnrichmentGenerationStep,
        options: { fatal: false, timeoutMs: commandTimeouts.sqlite },
      })),
      phase: "post-enrichment",
    };
    if (postEnrichmentPublicationPlan.required) {
      await releasePhaseLock();
    }
    const effectivePostEnrichmentGenerationStep = postEnrichmentPublicationPlan.required
      ? postEnrichmentGenerationStep
      : officialGenerationStep;
    const effectivePostEnrichmentSqliteStep = postEnrichmentPublicationPlan.required
      ? postEnrichmentSqliteStep
      : sqliteStep;
    const sourceCycleObservation = readSourceCycleObservation({
      phase: "post-enrichment",
      validationStep: postEnrichmentDataValidationStep,
      generationStep: effectivePostEnrichmentGenerationStep,
      sqliteStep: effectivePostEnrichmentSqliteStep,
    });
    if (sourceCycleObservation.ready) await onBeforeHeavyStep("model:backtest");
    const modelBacktestStep = sourceCycleObservation.ready
      ? await runBestEffort(
          "model:backtest",
          () => maybeRunModelBacktest({ sqliteStep: effectivePostEnrichmentSqliteStep })
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
    const modelStrategyFingerprintBefore = modelStrategyReconciliationFingerprint();
    if (modelStrategyEnabled) await onBeforeHeavyStep("optimize:strategy");
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
    if (modelReconciliationRequired) {
      await acquirePhaseLock("sync-worker-model-reconciled-publication");
    }
    const modelReconciledFastResultReconciliationStep = {
      ...(await runOptional(
        modelReconciliationRequired,
        "reconcile:fast-results-generation",
        {},
        { timeoutMs: commandTimeouts.validation }
      )),
      phase: "model-reconciled",
    };
    if (modelReconciliationRequired) {
      await onBeforeHeavyStep("datastore:generation:model-reconciled");
    }
    const modelReconciledGenerationStep = {
      ...(await runOptional(
        modelReconciliationRequired,
        "datastore:generation",
        {
          SERVER_STORE_DIR: process.env.SERVER_STORE_DIR || storeDir,
        },
        { fatal: false, timeoutMs: commandTimeouts.sqlite }
      )),
      phase: "model-reconciled",
    };
    if (sqliteExportEnabled
      && modelReconciliationRequired
      && modelReconciledGenerationStep?.skipped !== true) {
      await onBeforeHeavyStep("datastore:sqlite:model-reconciled");
    }
    const modelReconciledSqliteStep = await runSqliteExportOrReuse({
      enabled: sqliteExportEnabled
        && modelReconciliationRequired
        && modelReconciledGenerationStep?.skipped !== true,
      generationStep: modelReconciledGenerationStep,
      options: { fatal: false, timeoutMs: commandTimeouts.sqlite },
    });
    if (modelReconciliationRequired) {
      await releasePhaseLock();
    }
    const readinessSourceCycleObservation = readSourceCycleObservation({
      phase: "readiness",
      validationStep: postEnrichmentDataValidationStep,
      generationStep: modelReconciliationRequired
        ? modelReconciledGenerationStep
        : effectivePostEnrichmentGenerationStep,
      sqliteStep: modelReconciliationRequired
        ? modelReconciledSqliteStep
        : effectivePostEnrichmentSqliteStep,
    });
    const slowSteps = [
      ...enrichmentSteps,
      sourceValidationStep,
      postEnrichmentDataValidationStep,
      postEnrichmentPublicationPlan,
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
    const fastWarnings = [
      ...(fastResultStep?.ok === false
        ? [`${fastResultStep.script}: ${fastResultStep.error}`]
        : []),
      ...(uefaOfficialResultStep?.ok === false
        ? [`${uefaOfficialResultStep.script}: ${uefaOfficialResultStep.error}`]
        : []),
    ];
    const slowPhase = withCycleDuration({
      ok: degradedSteps.length === 0,
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
      fastPhase,
      fastResultStep,
      uefaOfficialResultStep,
      officialPhase,
      slowPhase,
      releaseEnrichmentReuse,
      enrichmentSteps,
      sourceValidationStep,
      postEnrichmentDataValidationStep,
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
    await sleeper(Math.min(enabled ? pollMs : remainingMs, remainingMs));
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

  const candidateDeadlineHeartbeat = loop
    ? startCandidateProspectiveDeadlineHeartbeat()
    : null;
  if (candidateDeadlineHeartbeat) {
    // The immediate heartbeat is deliberately awaited before the first full
    // sync.  Previously both child trees were launched together, which made
    // the first generation/export contend with cutoff capture inside the same
    // MemoryHigh cgroup.  Failed attempts keep their strict retry schedule and
    // the heavy cycle does not start until one exact status publication wins.
    await candidateDeadlineHeartbeat.waitForPublished();
  }
  let cycleWake = null;
  do {
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
        onBeforeHeavyStep: async () => {
          // Drain an already-running cutoff capture before admitting the next
          // memory-heavy child.  The heartbeat remains enabled during the
          // child; this barrier only prevents simultaneous child-tree launch
          // and does not relax or manufacture the 120s freshness contract.
          await candidateDeadlineHeartbeat?.waitForIdle();
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
        { fromCompletion: postDeadlineCooldown },
      );
      loopDelayMs = releaseCycleDelayMs(completedCycle, normalLoopDelayMs);
      postCycleRelaySemantic = relaySnapshotSemanticFingerprint();
      relayCatchupRequired = Boolean(
        loop
        && relayWakeEnabled
        && relayWakeEligible
        && relaySnapshotChanged(
          activeCycleRelaySemanticBaseline,
          postCycleRelaySemantic,
        )
      );
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
        eventCycle: activeEventCycle,
        lastCycle: completedCycle,
        lastCompleteCycle: completePublicationCycleEvidence(completedCycle)
          || runningHistory.lastCompleteCycle,
        lastSuccessAt: completedCycle.ok === true && completedCycle.skipped !== true
          ? completedCycle.finishedAt || new Date().toISOString()
          : runningHistory.lastSuccessAt,
        lastCycleDurationMs: completedCycle.durationMs,
        lastError: null,
        nextWakeAt
      });
      console.log(JSON.stringify({ type: "sync-worker-cycle", ...completedCycle }, null, 2));
    } catch (error) {
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
        { fromCompletion: postDeadlineCooldown },
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
    if (loop) {
      const postCycleRelayBaseline = relaySnapshotFingerprint();
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
          enabled: relayWakeEnabled && relayWakeEligible
        });
      }
    }
  } while (loop);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
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
  candidateDeadlineAttemptBudget,
  candidateDeadlineHeartbeatFreshnessLimitMs,
  candidateDeadlinePreemptiveSchedule,
  cycleDurationMs,
  describeCycleStages,
  describeFiveHundredResultFallbackNeed,
  describeModelStrategyReconciliationNeed,
  describeModelBacktestNeed,
  describePostEnrichmentPublicationNeed,
  describeSyncCadence,
  fastEventVisibilityMs,
  main,
  modelStrategyReconciliationFingerprint,
  modelCandidateRegistryLockTimeoutMs,
  nextCycleDelayMs,
  officialPublishEvidenceAfter,
  phaseLockWaitMs,
  releaseCycleDelayMs,
  releaseCycleInitialLockWaitMs,
  releaseCycleNeedsPriorityRetry,
  releaseCycleRetryMs,
  readinessIdleEvidenceAfter,
  relaySnapshotChanged,
  relaySnapshotFingerprint,
  relaySnapshotSemanticFingerprint,
  relaySnapshotSemanticFileFingerprint,
  readSourceCycleObservation,
  inspectSqlitePublicationReuse,
  runSqliteExportOrReuse,
  runCommand,
  runCandidateProspectiveDeadlineCapture,
  startCandidateProspectiveDeadlineHeartbeat,
  summarizeWorkerError,
  webConsensusRefreshDue,
  waitForFastEventVisibility,
  waitForNextCycle,
  writeJsonAtomic,
  withCycleDuration,
  workerHistoryFields
};
