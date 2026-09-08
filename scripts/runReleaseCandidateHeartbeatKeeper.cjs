"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { shadowObservationAuditValid } = require("../src/services/candidateCaptureState.cjs");

const KEEPER_VERSION = "release-candidate-heartbeat-keeper-v2";
const HEARTBEAT_VERSION = "prospective-deadline-heartbeat-v2";
const READINESS_VERSION = "candidate-prospective-readiness-preview-v2";
const MAX_CAPTURE_OUTPUT_BYTES = 4 * 1024 * 1024;
const CAPTURE_ONCE_MODE = "--capture-once";
const CAPTURE_ONCE_TIMEOUT_EXIT_CODE = 124;
const CAPTURE_ONCE_SPAWN_EXIT_CODE = 125;
const CAPTURE_ONCE_TOTAL_BUDGET_MS = 100_000;

const readJson = (filePath, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const nonNegativeSafeInteger = (value) => (
  Number.isSafeInteger(value) && value >= 0
);

const readinessInvariantsMatch = (readiness) => {
  if (readiness?.version !== READINESS_VERSION) return false;
  const countKeys = [
    "evaluatedMatches", "detailedMatches", "rowsTruncated", "upcomingMatches",
    "readyNow", "atomicReadyNow", "awaitingMarket", "blocked", "excluded",
  ];
  if (countKeys.some((key) => !nonNegativeSafeInteger(readiness?.[key]))) return false;
  if (
    readiness.evaluatedMatches !== readiness.upcomingMatches
    || readiness.detailedMatches + readiness.rowsTruncated !== readiness.evaluatedMatches
    || readiness.readyNow !== readiness.atomicReadyNow
    || readiness.readyNow + readiness.awaitingMarket + readiness.blocked + readiness.excluded
      !== readiness.upcomingMatches
    || readiness.readyInvariantOk !== true
    || readiness.nearestStatus === "excluded"
    || !Array.isArray(readiness.deadlineBatches)
  ) return false;
  let batchMatches = 0;
  let batchReady = 0;
  let batchAwaiting = 0;
  let batchBlocked = 0;
  let batchExcluded = 0;
  let dueUnrecorded = 0;
  let readyDueUnrecorded = 0;
  for (const batch of readiness.deadlineBatches) {
    const keys = [
      "totalMatches", "readyNow", "awaitingMarket", "blocked", "excluded",
      "actionableMatches", "terminalMatches", "terminalDecisions", "terminalExclusions",
      "duplicateTerminalEvents", "terminalKeysWithDuplicates", "pendingMatches",
      "dueUnrecorded", "readyDueUnrecorded",
    ];
    if (keys.some((key) => !nonNegativeSafeInteger(batch?.[key]))) return false;
    const deadlineMs = Date.parse(batch?.deadlineAt || "");
    const finalizationMs = Date.parse(batch?.finalizationAt || "");
    const evaluatedAtMs = Date.parse(readiness.evaluatedAt || "");
    const expectedPhase = !Number.isFinite(deadlineMs)
      ? "deadline-missing"
      : evaluatedAtMs < deadlineMs
        ? "upcoming"
        : Number.isFinite(finalizationMs) && evaluatedAtMs < finalizationMs
          ? "finalization-grace"
          : "post-finalization";
    if (
      batch?.version !== "candidate-deadline-batch-summary-v1"
      || batch?.invariantOk !== true
      || batch.readyNow + batch.awaitingMarket + batch.blocked + batch.excluded
        !== batch.totalMatches
      || batch.terminalMatches !== batch.terminalDecisions + batch.terminalExclusions
      || batch.terminalMatches > batch.totalMatches
      || batch.pendingMatches !== batch.totalMatches - batch.terminalMatches
      || batch.actionableMatches !== batch.totalMatches - batch.excluded
      || batch.duplicateTerminalEvents !== 0
      || batch.terminalKeysWithDuplicates !== 0
      || batch.readyDueUnrecorded > batch.dueUnrecorded
      || batch.phase !== expectedPhase
    ) return false;
    batchMatches += batch.totalMatches;
    batchReady += batch.readyNow;
    batchAwaiting += batch.awaitingMarket;
    batchBlocked += batch.blocked;
    batchExcluded += batch.excluded;
    dueUnrecorded += batch.dueUnrecorded;
    readyDueUnrecorded += batch.readyDueUnrecorded;
  }
  if (
    batchMatches !== readiness.upcomingMatches
    || batchReady !== readiness.readyNow
    || batchAwaiting !== readiness.awaitingMarket
    || batchBlocked !== readiness.blocked
    || batchExcluded !== readiness.excluded
    || dueUnrecorded !== 0
    || readyDueUnrecorded !== 0
  ) return false;
  const expectedNearestBatch = readiness.deadlineBatches.find((batch) => (
    batch.pendingMatches > 0 && typeof batch.deadlineAt === "string" && batch.deadlineAt
  )) || null;
  if (expectedNearestBatch) {
    if (
      readiness?.nearestDeadlineBatch?.deadlineAt !== expectedNearestBatch.deadlineAt
      || readiness.nearestDeadlineBatch?.pendingMatches !== expectedNearestBatch.pendingMatches
      || readiness.nearestDeadlineAt !== expectedNearestBatch.deadlineAt
      || readiness.nearestFinalizationAt !== expectedNearestBatch.finalizationAt
      || !["ready-now", "awaiting-market", "blocked"].includes(readiness.nearestStatus)
    ) return false;
  } else if (readiness.nearestDeadlineBatch != null) {
    return false;
  } else if (
      readiness.nearestDeadlineAt != null
      || readiness.nearestFinalizationAt != null
      || readiness.nearestStatus != null
  ) return false;
  return true;
};

const atomicDecisionRecordInvariantsMatch = (decisionRecord) => {
  const countKeys = ["admittedRows", "atomicRows", "completeRows", "failedRows"];
  if (
    decisionRecord?.version !== "candidate-atomic-decision-record-v3"
    || countKeys.some((key) => !nonNegativeSafeInteger(decisionRecord?.[key]))
    || decisionRecord.admittedRows !== decisionRecord.atomicRows
    || decisionRecord.atomicRows !== decisionRecord.completeRows
    || decisionRecord.failedRows !== 0
    || decisionRecord.coverage !== 1
    || decisionRecord.complete !== true
  ) return false;
  return true;
};

const exactHeartbeatMatches = (
  status,
  expectedEvaluatedAt,
  {
    requireFresh = false,
    nowMs = Date.now(),
    maxAgeMs = 120_000,
    allowPreSwapLegacyTopLevelDueOmission = false,
  } = {},
) => {
  const evaluatedAtMs = Date.parse(status?.evaluatedAt || "");
  const fresh = !requireFresh || (
    Number.isFinite(evaluatedAtMs)
    && nowMs - evaluatedAtMs >= 0
    && nowMs - evaluatedAtMs <= maxAgeMs
  );
  const ownsTopLevelDueUnrecorded = Object.prototype.hasOwnProperty.call(
    status || {},
    "dueUnrecorded",
  );
  const ownsTopLevelReadyDueUnrecorded = Object.prototype.hasOwnProperty.call(
    status || {},
    "readyDueUnrecorded",
  );
  const ownsCaptureMode = Object.prototype.hasOwnProperty.call(
    status || {},
    "captureMode",
  );
  const captureModeMatches = status?.captureMode === "deadline-only" || (
    allowPreSwapLegacyTopLevelDueOmission === true
    && !ownsCaptureMode
  );
  const topLevelDueCountersMatch = (
    status?.dueUnrecorded === 0
    && status?.readyDueUnrecorded === 0
  ) || (
    allowPreSwapLegacyTopLevelDueOmission === true
    && !ownsTopLevelDueUnrecorded
    && !ownsTopLevelReadyDueUnrecorded
  );
  return (
    status?.version === HEARTBEAT_VERSION
    && captureModeMatches
    && status?.ok === true
    && status?.skipped === false
    && status?.dueCaptureComplete === true
    && status?.dueAtomicComplete === true
    && topLevelDueCountersMatch
    && status?.evaluatedAt === expectedEvaluatedAt
    && status?.readiness?.evaluatedAt === status.evaluatedAt
    && (status?.audit?.state === "ACTIVE" || shadowObservationAuditValid(status?.audit))
    && status?.audit?.chainValid === true
    && status?.audit?.evaluatedAt === status.evaluatedAt
    && typeof status?.audit?.candidateRevisionId === "string"
    && status.audit.candidateRevisionId.length > 0
    && status?.readiness?.candidateRevisionId === status.audit.candidateRevisionId
    && /^[a-f0-9]{64}$/u.test(String(status?.audit?.rootHash || ""))
    && atomicDecisionRecordInvariantsMatch(status?.audit?.decisionRecord)
    && Array.isArray(status?.blockers)
    && status.blockers.length === 0
    && readinessInvariantsMatch(status.readiness)
    && fresh
  );
};

const captureScheduleDelayMs = ({
  attemptStartedAtMs,
  nowMs,
  intervalMs,
}) => Math.max(0, Number(attemptStartedAtMs) + Number(intervalMs) - Number(nowMs));

const integerInRange = (value, minimum, maximum, label) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
};

const validateKeeperOptions = (raw) => {
  const options = {
    instanceId: String(raw?.instanceId || "").trim(),
    captureScript: path.resolve(String(raw?.captureScript || "")),
    heartbeatStatusFile: path.resolve(String(raw?.heartbeatStatusFile || "")),
    controlFile: path.resolve(String(raw?.controlFile || "")),
    workingDirectory: path.resolve(String(raw?.workingDirectory || "")),
    storeDir: path.resolve(String(raw?.storeDir || "")),
    sqlitePath: path.resolve(String(raw?.sqlitePath || "")),
    intervalSeconds: integerInRange(raw?.intervalSeconds ?? 20, 5, 30, "intervalSeconds"),
    attemptTimeoutMs: integerInRange(
      raw?.attemptTimeoutMs ?? 100_000,
      1_000,
      110_000,
      "attemptTimeoutMs",
    ),
    lockTimeoutMs: integerInRange(
      raw?.lockTimeoutMs ?? 10_000,
      1_000,
      20_000,
      "lockTimeoutMs",
    ),
  };
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(options.instanceId)) {
    throw new Error("instanceId is missing or unsafe");
  }
  if (options.lockTimeoutMs >= options.attemptTimeoutMs) {
    throw new Error("lockTimeoutMs must leave time for exact heartbeat validation");
  }
  for (const [label, value] of Object.entries({
    captureScript: options.captureScript,
    heartbeatStatusFile: options.heartbeatStatusFile,
    controlFile: options.controlFile,
    workingDirectory: options.workingDirectory,
    storeDir: options.storeDir,
    sqlitePath: options.sqlitePath,
  })) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  return options;
};

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || value === undefined) {
      throw new Error(`invalid keeper argument near ${token || "<end>"}`);
    }
    values.set(token.slice(2), value);
  }
  return validateKeeperOptions({
    instanceId: values.get("instance-id"),
    captureScript: values.get("capture-script"),
    heartbeatStatusFile: values.get("heartbeat-status-file"),
    controlFile: values.get("control-file"),
    workingDirectory: values.get("working-directory"),
    storeDir: values.get("store-dir"),
    sqlitePath: values.get("sqlite-path"),
    intervalSeconds: values.get("interval-seconds"),
    attemptTimeoutMs: values.get("attempt-timeout-ms"),
    lockTimeoutMs: values.get("lock-timeout-ms"),
  });
};

const assertRegularFile = (filePath, label) => {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
};

const assertRuntimePaths = (options) => {
  assertRegularFile(options.captureScript, "capture script");
  const workingInfo = fs.lstatSync(options.workingDirectory);
  const storeInfo = fs.lstatSync(options.storeDir);
  const controlDirInfo = fs.lstatSync(path.dirname(options.controlFile));
  if (!workingInfo.isDirectory() || workingInfo.isSymbolicLink()) {
    throw new Error("working directory is unsafe");
  }
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink()) {
    throw new Error("store directory is unsafe");
  }
  if (!controlDirInfo.isDirectory() || controlDirInfo.isSymbolicLink()) {
    throw new Error("control directory is unsafe");
  }
  if (fs.existsSync(options.heartbeatStatusFile)) {
    assertRegularFile(options.heartbeatStatusFile, "heartbeat status");
  }
  if (fs.existsSync(options.sqlitePath)) {
    assertRegularFile(options.sqlitePath, "SQLite database");
  }
};

const validateCaptureOnceOptions = (raw) => {
  const options = {
    captureScript: path.resolve(String(raw?.captureScript || "")),
    workingDirectory: path.resolve(String(raw?.workingDirectory || "")),
    timeoutMs: integerInRange(raw?.timeoutMs ?? 90_000, 100, 95_000, "timeoutMs"),
    killAfterMs: integerInRange(raw?.killAfterMs ?? 5_000, 100, 5_000, "killAfterMs"),
  };
  if (options.timeoutMs + options.killAfterMs > CAPTURE_ONCE_TOTAL_BUDGET_MS) {
    throw new Error("capture-once TERM/KILL budget must not exceed 100000ms");
  }
  if (!path.isAbsolute(String(raw?.captureScript || ""))) {
    throw new Error("captureScript must be absolute");
  }
  if (!path.isAbsolute(String(raw?.workingDirectory || ""))) {
    throw new Error("workingDirectory must be absolute");
  }
  return options;
};

const parseCaptureOnceArgs = (argv) => {
  const values = new Map();
  const allowed = new Set([
    "capture-script",
    "working-directory",
    "timeout-ms",
    "kill-after-ms",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    const key = token?.startsWith("--") ? token.slice(2) : null;
    if (!key || value === undefined || !allowed.has(key)) {
      throw new Error(`invalid capture-once argument near ${token || "<end>"}`);
    }
    values.set(key, value);
  }
  return validateCaptureOnceOptions({
    captureScript: values.get("capture-script"),
    workingDirectory: values.get("working-directory"),
    timeoutMs: values.get("timeout-ms"),
    killAfterMs: values.get("kill-after-ms"),
  });
};

const assertCaptureOncePaths = (options) => {
  const captureInfo = fs.lstatSync(options.captureScript);
  const workingInfo = fs.lstatSync(options.workingDirectory);
  if (!captureInfo.isFile() || captureInfo.isSymbolicLink() || captureInfo.nlink !== 1) {
    throw new Error("capture-once script must be a single-link regular file");
  }
  if (!workingInfo.isDirectory() || workingInfo.isSymbolicLink()) {
    throw new Error("capture-once working directory is unsafe");
  }
};

const runCaptureProcessBounded = (rawOptions) => new Promise((resolve) => {
  const options = validateCaptureOnceOptions(rawOptions);
  assertCaptureOncePaths(options);
  const startedAtMs = Date.now();
  const detached = process.platform !== "win32";
  let child;
  let timeout = null;
  let forceKillTimer = null;
  let timedOut = false;
  let settled = false;

  const signalTree = (signal) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    if (detached && Number.isSafeInteger(child.pid) && child.pid > 0) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {}
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    resolve({
      durationMs: Date.now() - startedAtMs,
      timeoutMs: options.timeoutMs,
      killAfterMs: options.killAfterMs,
      ...result,
    });
  };

  try {
    child = spawn(process.execPath, [options.captureScript, "--deadline-only"], {
      cwd: options.workingDirectory,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      detached,
    });
  } catch (error) {
    finish({
      ok: false,
      reason: "capture-spawn-failed",
      exitCode: CAPTURE_ONCE_SPAWN_EXIT_CODE,
      error: error?.message || String(error),
    });
    return;
  }

  child.once("error", (error) => finish({
    ok: false,
    reason: "capture-spawn-failed",
    exitCode: CAPTURE_ONCE_SPAWN_EXIT_CODE,
    error: error?.message || String(error),
  }));
  child.once("close", (code, signal) => {
    if (timedOut) {
      finish({
        ok: false,
        reason: "capture-timeout",
        exitCode: CAPTURE_ONCE_TIMEOUT_EXIT_CODE,
        childExitCode: Number.isInteger(code) ? code : null,
        childSignal: signal || null,
      });
      return;
    }
    finish({
      ok: code === 0 && !signal,
      reason: code === 0 && !signal ? "capture-complete" : "capture-process-failed",
      exitCode: code === 0 && !signal
        ? 0
        : Number.isInteger(code) && code > 0 && code <= 255
          ? code
          : 1,
      childExitCode: Number.isInteger(code) ? code : null,
      childSignal: signal || null,
    });
  });

  timeout = setTimeout(() => {
    timedOut = true;
    signalTree("SIGTERM");
    forceKillTimer = setTimeout(() => {
      signalTree("SIGKILL");
      child?.unref?.();
      finish({
        ok: false,
        reason: "capture-timeout",
        exitCode: CAPTURE_ONCE_TIMEOUT_EXIT_CODE,
        childExitCode: null,
        childSignal: "SIGKILL",
      });
    }, options.killAfterMs);
  }, options.timeoutMs);
});

const writeJsonAtomic = (filePath, payload) => {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    fs.renameSync(tempFile, filePath);
  } finally {
    if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
  }
};

const appendBounded = (prior, chunk) => {
  if (prior.length >= MAX_CAPTURE_OUTPUT_BYTES) return prior;
  const remaining = MAX_CAPTURE_OUTPUT_BYTES - prior.length;
  return Buffer.concat([prior, Buffer.from(chunk).subarray(0, remaining)]);
};

const compactOutput = (buffer) => buffer
  .toString("utf8")
  .replace(/[\r\n\t]+/g, " ")
  .trim()
  .slice(-2_000);

const interruptibleDelay = (delayMs, signalState) => new Promise((resolve) => {
  if (delayMs <= 0 || signalState.stopping) {
    resolve();
    return;
  }
  const timer = setTimeout(() => {
    signalState.wake = null;
    resolve();
  }, delayMs);
  signalState.wake = () => {
    clearTimeout(timer);
    signalState.wake = null;
    resolve();
  };
});

const holdUntilExplicitStop = async (signalState) => {
  while (!signalState.stopping) {
    await interruptibleDelay(60_000, signalState);
  }
};

const runCaptureAttempt = (options, signalState, { onAttemptStarted = null } = {}) => new Promise((resolve) => {
  const evaluatedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const activeAttempt = {
    sequence: Number(signalState.captureSequence || 0) + 1,
    evaluatedAt,
    startedAt: new Date(startedAtMs).toISOString(),
  };
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let overflowed = false;
  let settled = false;
  let forceKillTimer = null;
  let child = null;
  let timeout = null;

  const terminate = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    forceKillTimer.unref?.();
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signalState.activeChild = null;
    resolve({
      evaluatedAt,
      attemptStartedAtMs: startedAtMs,
      durationMs: Date.now() - startedAtMs,
      stdout: compactOutput(stdout),
      stderr: compactOutput(stderr),
      ...result,
    });
  };

  signalState.activeAttempt = activeAttempt;
  try {
    onAttemptStarted?.(activeAttempt);
  } catch (error) {
    signalState.activeAttempt = null;
    finish({
      ok: false,
      reason: "active-attempt-control-write-failed",
      error: error?.message || String(error),
    });
    return;
  }
  try {
    child = spawn(process.execPath, [options.captureScript, "--deadline-only"], {
      cwd: options.workingDirectory,
      env: {
        ...process.env,
        SERVER_STORE_DIR: options.storeDir,
        DATASTORE_SQLITE_PATH: options.sqlitePath,
        CANDIDATE_PROSPECTIVE_CAPTURE_LOCK_TIMEOUT_MS: String(options.lockTimeoutMs),
        CANDIDATE_PROSPECTIVE_CAPTURE_EVALUATED_AT: evaluatedAt,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    finish({ ok: false, reason: "capture-spawn-failed", error: error?.message || String(error) });
    return;
  }
  signalState.activeChild = child;
  timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.attemptTimeoutMs);

  child.stdout.on("data", (chunk) => {
    const before = stdout.length;
    stdout = appendBounded(stdout, chunk);
    if (stdout.length - before < chunk.length) {
      overflowed = true;
      terminate();
    }
  });
  child.stderr.on("data", (chunk) => {
    const before = stderr.length;
    stderr = appendBounded(stderr, chunk);
    if (stderr.length - before < chunk.length) {
      overflowed = true;
      terminate();
    }
  });

  child.once("error", (error) => finish({
    ok: false,
    reason: "capture-spawn-failed",
    error: error?.message || String(error),
  }));
  child.once("close", (code, signal) => {
    if (timedOut) {
      finish({ ok: false, reason: "capture-timeout", code, signal });
      return;
    }
    if (overflowed) {
      finish({ ok: false, reason: "capture-output-overflow", code, signal });
      return;
    }
    if (code !== 0 || signal) {
      finish({ ok: false, reason: "capture-process-failed", code, signal });
      return;
    }
    const heartbeat = readJson(options.heartbeatStatusFile, null);
    if (!exactHeartbeatMatches(heartbeat, evaluatedAt, { requireFresh: true })) {
      const captureOutput = compactOutput(stdout);
      const observedTransientReason = /"reason"\s*:\s*"registry-lock-busy"/u.test(captureOutput)
        ? "registry-lock-busy"
        : null;
      finish({
        ok: false,
        reason: "exact-heartbeat-not-published",
        code,
        signal,
        observedEvaluatedAt: heartbeat?.evaluatedAt || null,
        observedVersion: heartbeat?.version || null,
        observedOk: heartbeat?.ok === true,
        observedSkipped: heartbeat?.skipped ?? null,
        observedTransientReason,
      });
      return;
    }
    finish({ ok: true, code, signal, heartbeat });
  });
});

const runKeeper = async (rawOptions) => {
  const options = validateKeeperOptions(rawOptions);
  assertRuntimePaths(options);
  const startedAt = new Date().toISOString();
  const signalState = {
    activeChild: null,
    activeAttempt: null,
    captureSequence: 0,
    stopping: false,
    signal: null,
    stopRequestedAt: null,
    wake: null,
  };
  let captureSequence = 0;
  let lastSuccessAt = null;
  let lastEvaluatedAt = null;
  let lastRegistryRootHash = null;
  let lastCandidateRevisionId = null;
  let latchedFailure = null;

  const onSignal = (signal) => {
    if (signalState.stopping) return;
    signalState.stopping = true;
    signalState.signal = signal;
    signalState.stopRequestedAt = new Date().toISOString();
    signalState.wake?.();
  };
  const onControlMessage = (message) => {
    if (
      message?.type === "release-candidate-heartbeat-keeper-signal"
      && ["SIGTERM", "SIGINT"].includes(message?.signal)
    ) onSignal(message.signal);
  };
  const cleanupSignalHandlers = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.off("message", onControlMessage);
    process.channel?.unref?.();
  };
  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  if (typeof process.send === "function") process.on("message", onControlMessage);

  const latchFailureAndHold = async (result) => {
    const failedAt = new Date().toISOString();
    latchedFailure = {
      failedAt,
      attemptedEvaluatedAt: result.evaluatedAt || null,
      attemptDurationMs: result.durationMs ?? null,
      reason: result.reason || "keeper-attempt-failed",
      captureExitCode: result.code ?? null,
      captureSignal: result.signal ?? null,
      observedEvaluatedAt: result.observedEvaluatedAt ?? null,
      observedVersion: result.observedVersion ?? null,
      observedOk: result.observedOk ?? null,
      observedSkipped: result.observedSkipped ?? null,
      observedTransientReason: result.observedTransientReason ?? null,
      error: result.error || null,
      stdout: result.stdout || null,
      stderr: result.stderr || null,
    };
    const failureControl = {
      version: KEEPER_VERSION,
      instanceId: options.instanceId,
      pid: process.pid,
      ok: false,
      state: "failed-latched",
      failedClosed: true,
      awaitingExplicitStop: true,
      startedAt,
      captureSequence,
      lastSuccessAt,
      lastEvaluatedAt,
      lastRegistryRootHash,
      lastCandidateRevisionId,
      activeAttempt: null,
      ...latchedFailure,
    };
    try {
      writeJsonAtomic(options.controlFile, failureControl);
    } catch (error) {
      // A stale successful lease must not survive a failed attempt. Removing it
      // makes the release health probe fail closed even if the diagnostic write
      // itself cannot be committed.
      try {
        fs.rmSync(options.controlFile, { force: true });
      } catch {}
      process.stderr.write(
        `[release-heartbeat-keeper] failed to publish latched failure evidence: `
        + `${error?.message || String(error)}\n`,
      );
    }
    process.stderr.write(
      `[release-heartbeat-keeper] capture failed closed and latched until explicit stop: `
      + `${latchedFailure.reason}`
      + `${latchedFailure.observedTransientReason ? ` (${latchedFailure.observedTransientReason})` : ""}\n`,
    );
    await holdUntilExplicitStop(signalState);
  };

  const publishActiveAttempt = (activeAttempt) => {
    writeJsonAtomic(options.controlFile, {
      version: KEEPER_VERSION,
      instanceId: options.instanceId,
      pid: process.pid,
      ok: captureSequence >= 1,
      state: captureSequence >= 1 ? "running" : "starting",
      failedClosed: false,
      awaitingExplicitStop: false,
      startedAt,
      intervalSeconds: options.intervalSeconds,
      attemptTimeoutMs: options.attemptTimeoutMs,
      lockTimeoutMs: options.lockTimeoutMs,
      captureSequence,
      lastSuccessAt,
      lastEvaluatedAt,
      lastRegistryRootHash,
      lastCandidateRevisionId,
      activeAttempt,
    });
  };

  while (!signalState.stopping) {
    let result;
    try {
      result = await runCaptureAttempt(options, signalState, {
        onAttemptStarted: publishActiveAttempt,
      });
    } catch (error) {
      result = {
        ok: false,
        reason: "keeper-attempt-error",
        evaluatedAt: new Date().toISOString(),
        durationMs: 0,
        error: error?.message || String(error),
      };
    }
    signalState.activeAttempt = null;
    if (!result.ok) {
      await latchFailureAndHold(result);
      break;
    }

    captureSequence += 1;
    signalState.captureSequence = captureSequence;
    lastSuccessAt = new Date().toISOString();
    lastEvaluatedAt = result.evaluatedAt;
    lastRegistryRootHash = result.heartbeat?.audit?.rootHash || null;
    lastCandidateRevisionId = result.heartbeat?.audit?.candidateRevisionId || null;
    try {
      writeJsonAtomic(options.controlFile, {
        version: KEEPER_VERSION,
        instanceId: options.instanceId,
        pid: process.pid,
        ok: true,
        state: "running",
        failedClosed: false,
        awaitingExplicitStop: false,
        startedAt,
        intervalSeconds: options.intervalSeconds,
        attemptTimeoutMs: options.attemptTimeoutMs,
        lockTimeoutMs: options.lockTimeoutMs,
        captureSequence,
        lastAttemptStartedAt: new Date(result.attemptStartedAtMs).toISOString(),
        lastSuccessAt,
        lastEvaluatedAt,
        lastRegistryRootHash,
        lastCandidateRevisionId,
        activeAttempt: null,
        attemptDurationMs: result.durationMs,
      });
    } catch (error) {
      await latchFailureAndHold({
        ...result,
        ok: false,
        reason: "keeper-control-write-failed",
        error: error?.message || String(error),
      });
      break;
    }
    process.stdout.write(
      `[release-heartbeat-keeper] exact heartbeat ${captureSequence} published at ${lastEvaluatedAt}\n`,
    );

    if (signalState.stopping) break;

    const delayMs = captureScheduleDelayMs({
      attemptStartedAtMs: result.attemptStartedAtMs,
      nowMs: Date.now(),
      intervalMs: options.intervalSeconds * 1_000,
    });
    await interruptibleDelay(delayMs, signalState);
  }

  try {
    writeJsonAtomic(options.controlFile, {
      version: KEEPER_VERSION,
      instanceId: options.instanceId,
      pid: process.pid,
      ok: latchedFailure === null && captureSequence >= 1,
      state: "stopped",
      failedClosed: latchedFailure !== null || captureSequence < 1,
      awaitingExplicitStop: false,
      startedAt,
      stoppedAt: new Date().toISOString(),
      stopSignal: signalState.signal,
      stopRequestedAt: signalState.stopRequestedAt,
      stopDrained: signalState.activeAttempt === null,
      captureSequence,
      lastSuccessAt,
      lastEvaluatedAt,
      lastRegistryRootHash,
      lastCandidateRevisionId,
      activeAttempt: null,
      failure: latchedFailure,
    });
  } catch (error) {
    process.stderr.write(
      `[release-heartbeat-keeper] failed to publish explicit stop evidence: `
      + `${error?.message || String(error)}\n`,
    );
  }
  cleanupSignalHandlers();
  return 0;
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === CAPTURE_ONCE_MODE) {
    const result = await runCaptureProcessBounded(parseCaptureOnceArgs(argv.slice(1)));
    if (!result.ok) {
      process.stderr.write(
        `[release-heartbeat-keeper] bounded capture failed: ${result.reason} `
        + `(exit=${result.exitCode}, durationMs=${result.durationMs})\n`,
      );
    }
    return result.exitCode;
  }
  const options = parseArgs(argv);
  const code = await runKeeper(options);
  return code;
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(
      `[release-heartbeat-keeper] fatal: ${error?.stack || error?.message || String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  HEARTBEAT_VERSION,
  KEEPER_VERSION,
  READINESS_VERSION,
  CAPTURE_ONCE_MODE,
  CAPTURE_ONCE_TIMEOUT_EXIT_CODE,
  CAPTURE_ONCE_TOTAL_BUDGET_MS,
  atomicDecisionRecordInvariantsMatch,
  captureScheduleDelayMs,
  exactHeartbeatMatches,
  parseCaptureOnceArgs,
  readinessInvariantsMatch,
  runCaptureProcessBounded,
  runKeeper,
  validateCaptureOnceOptions,
  validateKeeperOptions,
};
