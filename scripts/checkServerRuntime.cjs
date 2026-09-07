const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { acquireSyncLock } = require("../server/syncLock.cjs");
const { evaluateFallbackReadiness } = require("./fallbackReadiness.cjs");

const rootDir = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const defaultStoreDir = isWindows ? path.join(rootDir, "server-data") : "/var/lib/football-predict";
const storeDir = path.resolve(process.env.SERVER_STORE_DIR || defaultStoreDir);
const baseUrl = process.env.RUNTIME_MONITOR_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8788}`;
const statusPath = path.resolve(process.env.RUNTIME_MONITOR_STATUS_PATH || path.join(storeDir, "health-monitor-status.json"));
const requestTimeoutMs = Math.max(1000, Number(process.env.RUNTIME_MONITOR_TIMEOUT_MS || 12000));
const requestAttempts = Math.max(1, Number(process.env.RUNTIME_MONITOR_HTTP_ATTEMPTS || 2));
const requestRetryDelayMs = Math.max(0, Number(process.env.RUNTIME_MONITOR_HTTP_RETRY_DELAY_MS || 750));
const commandTimeoutMs = Math.max(1000, Number(process.env.RUNTIME_MONITOR_COMMAND_TIMEOUT_MS || 10000));
const cleanupTimeoutMs = Math.max(1000, Number(process.env.RUNTIME_MONITOR_CLEANUP_TIMEOUT_MS || 30000));
const sqliteRepairTimeoutMs = Math.max(30000, Number(process.env.RUNTIME_MONITOR_SQLITE_REPAIR_TIMEOUT_MS || 180000));
const sqliteRepairLockWaitMs = Math.max(0, Number(process.env.RUNTIME_MONITOR_SQLITE_REPAIR_LOCK_WAIT_MS || 0));
const minFallbackRunwaySeconds = Math.max(0, Number(process.env.RUNTIME_MONITOR_MIN_FALLBACK_RUNWAY_SECONDS || 600));
const diskWarnPercent = Math.max(1, Number(process.env.RUNTIME_MONITOR_DISK_WARN_PERCENT || 85));
const diskFailPercent = Math.max(diskWarnPercent + 1, Number(process.env.RUNTIME_MONITOR_DISK_FAIL_PERCENT || 95));
const sqliteWarnBytes = Math.max(64 * 1024 * 1024, Number(process.env.RUNTIME_MONITOR_SQLITE_WARN_BYTES || 1024 * 1024 * 1024));
const sqliteFailBytes = Math.max(sqliteWarnBytes + 1, Number(process.env.RUNTIME_MONITOR_SQLITE_FAIL_BYTES || 2 * 1024 * 1024 * 1024));
const sqliteFreeRatioWarn = Math.min(0.95, Math.max(0.1, Number(process.env.RUNTIME_MONITOR_SQLITE_FREE_RATIO_WARN || 0.35)));
const sqliteRunawayGrowthBytes = Math.max(
  64 * 1024 * 1024,
  Number(process.env.RUNTIME_MONITOR_SQLITE_RUNAWAY_GROWTH_BYTES || 512 * 1024 * 1024),
);
const sqliteRunawayGrowthBytesPerHour = Math.max(
  sqliteRunawayGrowthBytes,
  Number(process.env.RUNTIME_MONITOR_SQLITE_RUNAWAY_GROWTH_BYTES_PER_HOUR || 1024 * 1024 * 1024),
);
const requireSqlite = process.env.RUNTIME_MONITOR_REQUIRE_SQLITE !== "0";
const autoRepairSqlite = process.env.RUNTIME_MONITOR_AUTO_REPAIR_SQLITE === "1";
const readAllowedRuntimeValues = (filePath, allowedKeys) => {
  const selected = {};
  if (!String(filePath || "").trim()) return selected;
  try {
    const allowed = new Set(allowedKeys);
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
      if (!match || !allowed.has(match[1])) continue;
      let value = match[2].trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
      selected[match[1]] = value;
    }
  } catch { /* Missing runtime configuration remains fail-closed. */ }
  return selected;
};
const resolveMonitorPostgresMode = (env = process.env, readValues = readAllowedRuntimeValues) => {
  const value = env.FOOTBALL_POSTGRES_MODE
    ?? readValues(env.RUNTIME_MONITOR_AUTH_FILE, ["FOOTBALL_POSTGRES_MODE"]).FOOTBALL_POSTGRES_MODE;
  return String(value || "disabled").trim().toLowerCase();
};
const postgresMode = resolveMonitorPostgresMode();
const checkSystemd = process.env.RUNTIME_MONITOR_CHECK_SYSTEMD !== "0" && !isWindows;
const checkDisk = process.env.RUNTIME_MONITOR_CHECK_DISK !== "0" && !isWindows;
const checkCleanup = process.env.RUNTIME_MONITOR_CHECK_CLEANUP !== "0";
const checkModelEvaluation = process.env.RUNTIME_MONITOR_CHECK_MODEL_EVALUATION !== "0";
const requireCandidateTemporalAudit =
  process.env.RUNTIME_MONITOR_REQUIRE_CANDIDATE_TEMPORAL_AUDIT === "1";

const readPreviousRuntimeStatus = () => {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const publicationIdentityToken = (storage) => {
  const identity = storage?.publication || storage?.publicationIdentity || {};
  const values = [
    identity.generationId,
    identity.manifestHash,
    identity.sourceCycleId,
    identity.committedAt,
  ].map((value) => String(value || "").trim());
  return values.every(Boolean) ? values.join("|") : null;
};

const evaluateSqliteReadRequirement = ({
  sqlite,
  postgres,
  currentRead,
  requireSqlite: sqliteRequired,
  autoRepairSqlite: sqliteAutoRepair,
  postgresMode: configuredPostgresMode,
}) => {
  const sqliteAvailable = sqlite?.available === true;
  const readSource = String(currentRead?.source || "").trim().toLowerCase();
  const sqlitePublication = publicationIdentityToken(sqlite);
  const postgresPublication = publicationIdentityToken(postgres);
  const publicationParity = Boolean(
    sqlitePublication
    && postgresPublication
    && sqlitePublication === postgresPublication
  );
  // During generation-pair-refresh the public read source is intentionally a
  // transition label rather than `postgres`. If both storage projections are
  // already bound to the same immutable publication, rebuilding SQLite cannot
  // repair that resolver transition and only steals the worker's sync lock.
  const primaryPostgres = configuredPostgresMode === "primary"
    && (readSource === "postgres" || publicationParity);
  const requirementMet = sqliteAvailable && (
    !sqliteRequired
    || (primaryPostgres ? publicationParity : readSource === "sqlite")
  );
  const repairEligible = Boolean(
    sqliteAutoRepair
    && sqliteRequired
    && sqliteAvailable
    && (primaryPostgres ? !publicationParity : readSource !== "sqlite")
  );
  return {
    requirementMet,
    repairEligible,
    primaryPostgres,
    publicationParity,
    sqlitePublication,
    postgresPublication,
    reason: primaryPostgres
      ? (publicationParity ? "postgres-primary-read-with-sqlite-parity" : "postgres-primary-sqlite-publication-mismatch")
      : readSource === "sqlite"
        ? "sqlite-primary-read"
        : "sqlite-read-not-active",
  };
};

const assessSqliteStorageStability = ({
  bytes,
  warnBytes,
  failBytes,
  freeRatio,
  freeRatioWarn,
  schemaVersion,
  previousBytes = null,
  previousCheckedAt = null,
  checkedAt = new Date().toISOString(),
  runawayGrowthBytes = 512 * 1024 * 1024,
  runawayGrowthBytesPerHour = 1024 * 1024 * 1024,
} = {}) => {
  const currentBytes = Math.max(0, Number(bytes || 0));
  const currentFreeRatio = Math.max(0, Number(freeRatio || 0));
  const effectiveWarnBytes = Math.max(1, Number(warnBytes || 0));
  const effectiveFailBytes = Math.max(effectiveWarnBytes + 1, Number(failBytes || 0));
  const effectiveFreeRatioWarn = Math.max(0, Number(freeRatioWarn || 0));
  const incrementalSchema = schemaVersion === "football-sqlite-v2-incremental";
  const previous = Number(previousBytes);
  const previousMs = Date.parse(previousCheckedAt || "");
  const checkedMs = Date.parse(checkedAt || "");
  const elapsedHours = Number.isFinite(previousMs)
    && Number.isFinite(checkedMs)
    && checkedMs > previousMs
    ? (checkedMs - previousMs) / 3_600_000
    : null;
  const growthBytes = Number.isFinite(previous) && previous >= 0
    ? currentBytes - previous
    : null;
  const growthBytesPerHour = growthBytes !== null && elapsedHours && elapsedHours > 0
    ? growthBytes / elapsedHours
    : null;
  const runawayGrowth = growthBytes !== null
    && growthBytes >= Math.max(1, Number(runawayGrowthBytes || 0))
    && growthBytesPerHour !== null
    && growthBytesPerHour >= Math.max(1, Number(runawayGrowthBytesPerHour || 0));
  const reasons = [];
  if (!incrementalSchema) reasons.push("non-incremental-schema");
  if (currentBytes >= effectiveFailBytes) reasons.push("file-size-over-fail-budget");
  else if (currentBytes >= effectiveWarnBytes) reasons.push("file-size-over-warn-budget");
  if (currentFreeRatio >= effectiveFreeRatioWarn) reasons.push("free-page-ratio-high");
  if (runawayGrowth) reasons.push("runaway-growth");
  return {
    status: runawayGrowth ? "failed" : reasons.length > 0 ? "watch" : "ok",
    reasons,
    bytes: currentBytes,
    warnBytes: effectiveWarnBytes,
    failBytes: effectiveFailBytes,
    freeRatio: currentFreeRatio,
    freeRatioWarn: effectiveFreeRatioWarn,
    schemaVersion: schemaVersion || null,
    incrementalSchema,
    previousBytes: Number.isFinite(previous) && previous >= 0 ? previous : null,
    previousCheckedAt: previousCheckedAt || null,
    elapsedHours,
    growthBytes,
    growthBytesPerHour,
    runawayGrowth,
    runawayGrowthBytes: Math.max(1, Number(runawayGrowthBytes || 0)),
    runawayGrowthBytesPerHour: Math.max(1, Number(runawayGrowthBytesPerHour || 0)),
  };
};
const readAdminTokenFromFile = (filePath) => {
  const resolvedPath = String(filePath || "").trim();
  if (!resolvedPath) return "";
  try {
    const line = fs.readFileSync(resolvedPath, "utf8")
      .split(/\r?\n/)
      .find((candidate) => /^\s*ADMIN_TOKEN\s*=/.test(candidate));
    if (!line) return "";
    const rawValue = line.slice(line.indexOf("=") + 1).trim();
    if (
      rawValue.length >= 2
      && ((rawValue.startsWith("\"") && rawValue.endsWith("\""))
        || (rawValue.startsWith("'") && rawValue.endsWith("'")))
    ) {
      return rawValue.slice(1, -1).trim();
    }
    return rawValue;
  } catch {
    return "";
  }
};
const monitorAdminToken = String(
  process.env.RUNTIME_MONITOR_ADMIN_TOKEN
  || process.env.ADMIN_TOKEN
  || readAdminTokenFromFile(process.env.RUNTIME_MONITOR_AUTH_FILE)
  || "",
).trim();
const cleanupCandidateWatchLimit = Math.max(0, Number(process.env.RUNTIME_MONITOR_CLEANUP_CANDIDATE_WATCH_LIMIT || 0));
const allowLocalPushWorkerPause = process.env.RUNTIME_MONITOR_ALLOW_LOCAL_PUSH_PAUSE === "1";
const requireFastResultWatcher = process.env.RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER === "1"
  || (process.env.RUNTIME_MONITOR_REQUIRE_FAST_RESULT_WATCHER !== "0" && !isWindows);
const fastResultWatcherMaxPollMs = Math.max(
  250,
  Number(process.env.RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_POLL_MS || 5000)
);
const fastResultWatcherMaxCheckAgeSeconds = Math.max(
  5,
  Number(process.env.RUNTIME_MONITOR_FAST_RESULT_WATCHER_MAX_CHECK_AGE_SECONDS || 30)
);
const fastResultWatcherRetryableGraceSeconds = Math.max(
  fastResultWatcherMaxCheckAgeSeconds,
  Number(process.env.RUNTIME_MONITOR_FAST_RESULT_WATCHER_RETRYABLE_GRACE_SECONDS || 300)
);
const candidateCaptureDeadlineRiskSeconds = Math.max(
  120,
  Number(process.env.RUNTIME_MONITOR_CANDIDATE_DEADLINE_RISK_SECONDS || 600)
);
const cloudSyncProcessPattern = process.env.RUNTIME_MONITOR_CLOUD_SYNC_PROCESS_PATTERN
  || "football-cloud-data|pushCloudSync|/tmp/football-cloud-data|SPORTTERY_RELAY_MODE=prefer";
const npmCommand = isWindows ? "npm.cmd" : "npm";

const splitCsv = (value, fallback) => String(value || fallback)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const finiteNumber = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const candidateProspectiveCaptureRuntimeStatus = (
  candidateCapture,
  nowMs = Date.now(),
  deadlineRiskSeconds = 600,
) => {
  if (candidateCapture?.ok === true) return "ok";
  const blockers = Array.isArray(candidateCapture?.blockers)
    ? candidateCapture.blockers
    : [];
  const heartbeatOnlyBlockers = new Set([
    "candidate-capture-heartbeat-stale",
    "candidate-heartbeat-preemptive-budget-missed",
  ]);
  const onlyHeartbeatDegraded = blockers.length > 0
    && blockers.every((blocker) => heartbeatOnlyBlockers.has(blocker));
  const dueCaptureComplete = candidateCapture?.heartbeat?.dueMatches === 0
    && candidateCapture?.heartbeat?.dueCaptureComplete === true
    && candidateCapture?.heartbeat?.dueAtomicComplete === true;
  const noAdmissionGap = candidateCapture?.admission?.dueUnrecorded === 0
    && candidateCapture?.admission?.readyDueUnrecorded === 0;
  const finalizationMs = Date.parse(candidateCapture?.heartbeat?.nearestFinalizationAt || "");
  const outsideDeadlineRisk = Number.isFinite(finalizationMs)
    && finalizationMs - Number(nowMs) > Math.max(120, Number(deadlineRiskSeconds || 0)) * 1000;
  return onlyHeartbeatDegraded && dueCaptureComplete && noAdmissionGap && outsideDeadlineRisk
    ? "watch"
    : "failed";
};

const systemdUnits = splitCsv(
  process.env.RUNTIME_MONITOR_SYSTEMD_UNITS,
  "football-predict,football-sync-worker,nginx,football-cleanup.timer,football-monitor.timer"
);

const diskPaths = splitCsv(
  process.env.RUNTIME_MONITOR_DISK_PATHS,
  "/,/opt,/var/lib/football-predict,/tmp"
);

const checks = [];

const addCheck = (name, status, details = {}) => {
  const normalized = status === "failed" || status === "watch" ? status : "ok";
  checks.push({
    name,
    ...details,
    status: normalized,
    ok: normalized !== "failed"
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJsonOnce = (endpoint, options = {}) => new Promise((resolve) => {
  let url;
  try {
    url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch (error) {
    resolve({ ok: false, status: 0, error: `invalid url: ${error.message || String(error)}` });
    return;
  }

  const client = url.protocol === "https:" ? https : http;
  const startedAt = Date.now();
  const req = client.request(url, {
    method: "GET",
    timeout: requestTimeoutMs,
    headers: {
      accept: "application/json",
      "user-agent": "football-runtime-monitor/1.0",
      ...(options.authorization
        ? { authorization: options.authorization }
        : {}),
    }
  }, (res) => {
    const chunks = [];
    let bytes = 0;
    res.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 2 * 1024 * 1024) chunks.push(chunk);
    });
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      let parseError = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (error) {
        parseError = error.message || String(error);
      }
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300 && !parseError,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        body,
        bytes,
        parseError,
        sample: parseError ? text.slice(0, 240) : undefined
      });
    });
  });

  req.on("timeout", () => {
    req.destroy(new Error(`timeout after ${requestTimeoutMs}ms`));
  });
  req.on("error", (error) => {
    resolve({
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      error: error.message || String(error)
    });
  });
  req.end();
});

const requestJson = async (endpoint, options = {}) => {
  const attempts = [];
  for (let index = 0; index < requestAttempts; index += 1) {
    const result = await requestJsonOnce(endpoint, options);
    attempts.push({
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      error: result.error || result.parseError || null
    });
    if (result.ok) {
      return {
        ...result,
        attempts: index + 1,
        previousAttempts: attempts.slice(0, -1)
      };
    }
    if (index < requestAttempts - 1 && requestRetryDelayMs > 0) {
      await sleep(requestRetryDelayMs);
    }
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    status: last.status || 0,
    ms: attempts.reduce((sum, attempt) => sum + Number(attempt.ms || 0), 0),
    error: last.error || "request failed",
    attempts: attempts.length,
    previousAttempts: attempts.slice(0, -1),
    attemptErrors: attempts
  };
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || commandTimeoutMs,
    ...(options.killSignal ? { killSignal: options.killSignal } : {}),
    windowsHide: true
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error ? (result.error.message || String(result.error)) : null
  };
};

const MONITOR_POSTGRES_ENV_KEYS = Object.freeze([
  "FOOTBALL_POSTGRES_MODE", "FOOTBALL_POSTGRES_URL", "DATABASE_URL", "FOOTBALL_POSTGRES_SSL_MODE",
  "FOOTBALL_POSTGRES_CONNECT_TIMEOUT_MS", "FOOTBALL_POSTGRES_IDLE_TIMEOUT_MS",
  "FOOTBALL_POSTGRES_QUERY_TIMEOUT_MS", "FOOTBALL_POSTGRES_POOL_MAX", "FOOTBALL_POSTGRES_POOL_MIN",
]);
const monitorRepairEnvironment = (stage, env = process.env, readValues = readAllowedRuntimeValues) => {
  // Keep the monitor's admin/provider credentials out of repair children. Only
  // the PostgreSQL projection receives its narrowly selected connection values.
  const selected = {};
  const runtimeKeys = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "NODE_ENV", "NODE_OPTIONS", "SERVER_STORE_DIR", "DATASTORE_SQLITE_PATH"];
  for (const key of [...runtimeKeys, ...Object.keys(env).filter((key) => /^SQLITE_[A-Z0-9_]+$/.test(key))]) {
    if (env[key] !== undefined) selected[key] = env[key];
  }
  selected.SERVER_STORE_DIR = env.SERVER_STORE_DIR || storeDir;
  selected.DATASTORE_SQLITE_PATH = env.DATASTORE_SQLITE_PATH || path.join(selected.SERVER_STORE_DIR, "football.db");
  selected.SQLITE_VACUUM_AFTER_EXPORT = "0";
  selected.SQLITE_MAINTENANCE_WINDOW = "";
  if (stage === "projection") {
    const configured = readValues(env.RUNTIME_MONITOR_AUTH_FILE, MONITOR_POSTGRES_ENV_KEYS);
    for (const key of MONITOR_POSTGRES_ENV_KEYS) {
      const value = env[key] ?? configured[key];
      if (value !== undefined) selected[key] = value;
    }
  }
  return selected;
};
const runSqliteRepairCommands = ({ env = process.env, commandRunner = runCommand, now = Date.now } = {}) => {
  const deadline = now() + sqliteRepairTimeoutMs;
  const runStep = (stage, script, args = []) => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return {
      stage, ok: false, status: null, signal: null, payload: null, error: `${stage}-budget-exhausted`,
    };
    // These entrypoints run their database work in this process, with no npm
    // shell or grandchildren. spawnSync waits for that direct Node process to
    // finish (including timeout SIGKILL) before the canonical lock can release.
    const result = commandRunner(process.execPath, [path.join(rootDir, "scripts", script), ...args], {
      timeout: remainingMs,
      killSignal: "SIGKILL",
      env: monitorRepairEnvironment(stage, env),
    });
    let payload = null;
    try { payload = JSON.parse(result.stdout || "{}"); } catch { /* Reject malformed or multiple documents. */ }
    const ok = result.status === 0 && !result.error && payload?.ok === true;
    return {
      stage, ok, status: result.status, signal: result.signal || null,
      payload: ok ? payload : null,
      // Never copy raw child stderr/stdout: connection errors may contain secrets.
      error: ok ? null : result.error ? `${stage}-process-failed`
        : result.status !== 0 ? `${stage}-command-failed` : `${stage}-result-invalid`,
    };
  };
  const sqlite = runStep("sqlite", "exportDataStoreSqlite.cjs");
  const projection = sqlite.ok ? runStep("projection", "syncPostgresProjection.cjs", ["--if-enabled"]) : null;
  return { ok: sqlite.ok && projection?.ok === true, sqlite, projection };
};

const assessFastResultProbeFreshness = (watcher, { required = true, nowMs = Date.now() } = {}) => {
  const evidence = watcher?.inputEvidence;
  const receivedAt = typeof evidence?.resultProbeReceivedAt === "string"
    ? evidence.resultProbeReceivedAt : null;
  const receivedMs = Date.parse(receivedAt || "");
  const ageSeconds = Number.isFinite(receivedMs) && Number.isFinite(nowMs)
    ? (nowMs - receivedMs) / 1000 : null;
  const maxAgeSeconds = typeof evidence?.freshnessMaxAgeSeconds === "number"
    && Number.isFinite(evidence.freshnessMaxAgeSeconds) && evidence.freshnessMaxAgeSeconds > 0
    ? evidence.freshnessMaxAgeSeconds : null;
  const reported = String(evidence?.resultProbeFreshness || "unavailable").toLowerCase();
  const freshness = !evidence || ageSeconds === null ? "unavailable"
    : reported === "future" ? "future"
      : ["unknown", "unavailable"].includes(reported) ? reported
        : maxAgeSeconds === null ? "unknown"
          : reported === "stale" || ageSeconds > maxAgeSeconds ? "stale"
            : reported === "fresh" ? "fresh" : "unknown";
  // Source freshness is independent of a publisher's successful no-op. Never
  // substitute lastCheckedAt/lastSuccessAt or a fresh market companion clock.
  const status = !required || freshness === "fresh" ? "ok" : "watch";
  return {
    status,
    required,
    capabilityPresent: Boolean(evidence),
    freshness,
    reportedFreshness: evidence ? reported : null,
    resultProbeReceivedAt: receivedAt,
    resultProbeAgeSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
    freshnessMaxAgeSeconds: maxAgeSeconds,
    reason: !required ? "not-required-on-this-runtime"
      : !evidence ? "result-probe-freshness-capability-missing"
        : `result-probe-${freshness}`,
    scope: "collection-freshness-not-terminal-result-authority",
  };
};

const parseDf = (stdout) => {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const usePercent = Number(String(parts[4] || "").replace("%", ""));
    rows.push({
      filesystem: parts[0],
      blocks1024: Number(parts[1]),
      used1024: Number(parts[2]),
      available1024: Number(parts[3]),
      usePercent,
      mountedOn: parts.slice(5).join(" ")
    });
  }
  return rows;
};

const checkHealth = async () => {
  const health = await requestJson("/api/v1/health");
  const reachable = health.ok && health.body && health.status === 200;
  addCheck("health endpoint", reachable ? "ok" : "failed", {
    httpStatus: health.status,
    ms: health.ms,
    attempts: health.attempts || 1,
    previousAttempts: health.previousAttempts || [],
    error: health.error || health.parseError || null
  });
  if (!reachable) return null;

  const body = health.body;
  const status = body.status || {};
  const storage = body.storage || {};
  const currentRead = body.data?.currentRead || {};
  const sqlite = storage.sqlite || {};
  const postgres = storage.postgres || {};
  const executionCapture = storage.predictionExecutionCapture || null;
  addCheck("prediction execution evidence storage",
    ["ok", "watch", "failed"].includes(executionCapture?.status) ? executionCapture.status : "watch",
    executionCapture || { reason: "capture-storage-health-not-observed" });
  const servingMode = status.servingMode || "unknown";
  const hardFlags = {
    serviceOk: status.serviceOk === true,
    dataFresh: status.dataFresh === true
  };
  const missingHardFlags = Object.entries(hardFlags)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  addCheck("health reliability flags", missingHardFlags.length === 0 ? "ok" : "failed", {
    missingFlags: missingHardFlags,
    servingMode,
    sourceDataFresh: status.sourceDataFresh ?? null,
    fallbackWithinReliableWindow: status.fallbackWithinReliableWindow ?? null
  });

  const recommendationReliable = status.recommendationReliable === true;
  addCheck("recommendation safety gate", recommendationReliable ? "ok" : "watch", {
    recommendationReliable: status.recommendationReliable ?? null,
    modelRiskStable: status.modelRiskStable ?? null,
    promotionGateStatus: body.model?.promotionGateStatus || null,
    promotionEligibleScope: body.model?.promotionEligibleScope || null,
    reason: recommendationReliable ? "formal-recommendations-enabled" : "model-safety-gate-paused"
  });

  const officialSourceSinglePoint = status.officialSourceSinglePoint;
  const officialSourceRedundancy = status.officialSourceRedundancy || null;
  addCheck("official source redundancy", officialSourceSinglePoint === false ? "ok" : "watch", {
    officialSourceSinglePoint: officialSourceSinglePoint ?? null,
    redundancyStatus: officialSourceRedundancy?.status || "unknown",
    redundancyMode: officialSourceRedundancy?.mode || "unknown",
    serverDirectAvailable: officialSourceRedundancy?.serverDirectAvailable ?? null,
    trustedCollectorCount: officialSourceRedundancy?.trustedCollectorCount ?? null,
    requiredTrustedCollectors: officialSourceRedundancy?.requiredTrustedCollectors ?? null,
    reason: officialSourceRedundancy?.reason || "official source redundancy evidence unavailable"
  });

  const sourceHealthOk = status.sourceHealthOk === true;
  const primarySourceFresh = status.primarySourceFresh === true;
  const sourceDataFresh = status.sourceDataFresh === true;
  const fallbackReadiness = evaluateFallbackReadiness(status, minFallbackRunwaySeconds);
  const fallbackReliable = fallbackReadiness.fallbackReliable;
  const sourceFreshnessOk = sourceHealthOk && (sourceDataFresh || fallbackReliable);
  const sourceFreshnessStatus = sourceFreshnessOk
    ? "ok"
    : (sourceHealthOk && fallbackReliable ? "watch" : "failed");
  addCheck("source freshness mode", sourceFreshnessStatus, {
    servingMode,
    sourceHealthOk,
    primarySourceFresh,
    sourceDataFresh,
    fallbackDataFresh: status.fallbackDataFresh ?? null,
    fallbackWithinReliableWindow: status.fallbackWithinReliableWindow ?? null,
    recommendationReliable: status.recommendationReliable ?? null,
    modeReason: sourceDataFresh
      ? "primary-source-fresh"
      : (fallbackReliable ? "fallback-reliable" : "fallback-not-reliable")
  });

  const fallbackRunwayStatus = fallbackReadiness.ok
    ? "ok"
    : fallbackReliable
      ? "watch"
      : "failed";
  addCheck("fallback reliability runway", fallbackRunwayStatus, fallbackReadiness);

  const syncRunning = body.sync?.running === true;
  const lastSyncFailed = body.sync?.lastSync?.ok === false;
  addCheck("sync worker reported by health", syncRunning ? "ok" : (lastSyncFailed ? "failed" : "watch"), {
    running: body.sync?.running ?? null,
    lastSyncOk: body.sync?.lastSync?.ok ?? null,
    lastSyncSource: body.sync?.lastSync?.source || null,
    workerCheckedAt: body.sync?.workerCheckedAt || null,
    nextWakeAt: body.sync?.nextWakeAt || null
  });

  const fastResultWatcher = body.sync?.fastResultWatcher || null;
  const fastWatcherCheckedAtMs = Date.parse(fastResultWatcher?.lastCheckedAt || "");
  const fastWatcherCheckAgeSeconds = Number.isFinite(fastWatcherCheckedAtMs)
    ? Math.max(0, Math.round((Date.now() - fastWatcherCheckedAtMs) / 1000))
    : null;
  const fastWatcherSuccessAtMs = Date.parse(fastResultWatcher?.lastSuccessAt || "");
  const fastWatcherSuccessAgeSeconds = Number.isFinite(fastWatcherSuccessAtMs)
    ? Math.max(0, Math.round((Date.now() - fastWatcherSuccessAtMs) / 1000))
    : null;
  const fastWatcherLastErrorCode = String(fastResultWatcher?.lastError?.code || "");
  const fastWatcherRetryableSkip = fastWatcherLastErrorCode === "PUBLISHER_RETRYABLE_SKIP";
  const fastWatcherRetryableWithinGrace = fastWatcherRetryableSkip
    && fastWatcherSuccessAgeSeconds !== null
    && fastWatcherSuccessAgeSeconds <= fastResultWatcherRetryableGraceSeconds;
  const fastWatcherCapabilityPresent = Boolean(
    fastResultWatcher
    && Object.prototype.hasOwnProperty.call(fastResultWatcher, "enabled")
    && Object.prototype.hasOwnProperty.call(fastResultWatcher, "pollMs")
    && Object.prototype.hasOwnProperty.call(fastResultWatcher, "lastCheckedAt")
    && Object.prototype.hasOwnProperty.call(fastResultWatcher, "lastError")
  );
  const fastWatcherConfigured = fastWatcherCapabilityPresent
    && fastResultWatcher.enabled === true
    && Number(fastResultWatcher.pollMs || 0) > 0
    && Number(fastResultWatcher.pollMs || 0) <= fastResultWatcherMaxPollMs;
  const fastWatcherRecentlyChecked = fastWatcherCheckAgeSeconds !== null
    && fastWatcherCheckAgeSeconds <= fastResultWatcherMaxCheckAgeSeconds;
  const fastWatcherHealthy = fastWatcherConfigured
    && fastWatcherRecentlyChecked
    && !fastResultWatcher.lastError;
  const fastWatcherStatus = !requireFastResultWatcher
    ? "ok"
    : fastWatcherHealthy
      ? "ok"
      : fastWatcherConfigured && fastWatcherRecentlyChecked && fastWatcherRetryableWithinGrace
        ? "watch"
      : fastWatcherConfigured && fastWatcherCheckAgeSeconds === null && !fastResultWatcher.lastError
        ? "watch"
        : "failed";
  addCheck("fast result watcher", fastWatcherStatus, {
    required: requireFastResultWatcher,
    capabilityPresent: fastWatcherCapabilityPresent,
    enabled: fastResultWatcher?.enabled ?? null,
    pollMs: fastResultWatcher?.pollMs ?? null,
    maxPollMs: fastResultWatcherMaxPollMs,
    lastCheckedAt: fastResultWatcher?.lastCheckedAt || null,
    checkAgeSeconds: fastWatcherCheckAgeSeconds,
    maxCheckAgeSeconds: fastResultWatcherMaxCheckAgeSeconds,
    lastSuccessAt: fastResultWatcher?.lastSuccessAt || null,
    successAgeSeconds: fastWatcherSuccessAgeSeconds,
    retryableGraceSeconds: fastResultWatcherRetryableGraceSeconds,
    retryableSkipWithinGrace: fastWatcherRetryableWithinGrace,
    lastPublishedAt: fastResultWatcher?.lastPublishedAt || null,
    lastPublishedRows: fastResultWatcher?.lastPublishedRows ?? null,
    lastError: fastResultWatcher?.lastError || null,
    reason: !requireFastResultWatcher
      ? "not-required-on-this-runtime"
      : !fastWatcherCapabilityPresent
        ? "health-capability-missing"
        : !fastWatcherConfigured
          ? "watcher-disabled-or-poll-too-slow"
          : fastWatcherCheckAgeSeconds === null
            ? "watcher-starting"
            : !fastWatcherRecentlyChecked
              ? "watcher-heartbeat-stale"
              : fastWatcherRetryableWithinGrace
                ? "watcher-retryable-skip-within-grace"
              : fastResultWatcher.lastError
                ? "watcher-reported-error"
                : "watcher-healthy"
  });
  const resultProbeFreshness = assessFastResultProbeFreshness(fastResultWatcher, {
    required: requireFastResultWatcher,
  });
  addCheck("fast result probe freshness", resultProbeFreshness.status, resultProbeFreshness);

  const sqliteRequirement = evaluateSqliteReadRequirement({
    sqlite,
    postgres,
    currentRead,
    requireSqlite,
    autoRepairSqlite,
    postgresMode,
  });
  const sqliteOk = sqliteRequirement.requirementMet;
  const sqliteRepairEligible = sqliteRequirement.repairEligible;
  addCheck("sqlite primary read", sqliteOk ? "ok" : (sqliteRepairEligible ? "watch" : "failed"), {
    requireSqlite,
    autoRepairSqlite,
    repairEligible: sqliteRepairEligible,
    sqliteAvailable: sqlite.available ?? null,
    sqlitePath: sqlite.path || null,
    schemaVersion: sqlite.schemaVersion || null,
    currentReadSource: currentRead.source || null,
    postgresMode,
    publicationParity: sqliteRequirement.publicationParity,
    sqlitePublication: sqliteRequirement.sqlitePublication,
    postgresPublication: sqliteRequirement.postgresPublication,
    reason: sqliteRequirement.reason,
    currentRows: body.data?.currentCount ?? null,
    historyRows: body.data?.historyCount ?? null
  });

  const previousRuntimeStatus = readPreviousRuntimeStatus();
  const previousSqliteStorage = Array.isArray(previousRuntimeStatus?.checks)
    ? previousRuntimeStatus.checks.find((check) => check?.name === "sqlite storage stability")
    : null;
  const sqliteStorage = assessSqliteStorageStability({
    bytes: sqlite.bytes,
    warnBytes: sqliteWarnBytes,
    failBytes: sqliteFailBytes,
    freeRatio: sqlite.physical?.freeRatio,
    freeRatioWarn: sqliteFreeRatioWarn,
    schemaVersion: sqlite.schemaVersion,
    previousBytes: previousSqliteStorage?.bytes,
    previousCheckedAt: previousRuntimeStatus?.checkedAt,
    checkedAt: new Date().toISOString(),
    runawayGrowthBytes: sqliteRunawayGrowthBytes,
    runawayGrowthBytesPerHour: sqliteRunawayGrowthBytesPerHour,
  });
  addCheck("sqlite storage stability", sqliteStorage.status, {
    ...sqliteStorage,
    warehousePolicy: sqlite.warehousePolicy || null,
  });

  return body;
};

const markSqlitePrimaryReadRepaired = (details = {}) => {
  const check = checks.find((item) => item.name === "sqlite primary read");
  if (!check) return;
  check.status = "ok";
  check.ok = true;
  check.repaired = true;
  check.repair = {
    ...(check.repair || {}),
    ...details
  };
};

const maybeRepairSqliteRead = async (health) => {
  const currentRead = health?.data?.currentRead || {};
  const sqlite = health?.storage?.sqlite || {};
  const postgres = health?.storage?.postgres || {};
  const requirement = evaluateSqliteReadRequirement({
    sqlite,
    postgres,
    currentRead,
    requireSqlite,
    autoRepairSqlite,
    postgresMode,
  });
  if (!autoRepairSqlite) return health;
  if (!requireSqlite) {
    addCheck("sqlite auto-repair", "ok", { skipped: true, reason: "sqlite-not-required" });
    return health;
  }
  if (requirement.requirementMet) {
    addCheck("sqlite auto-repair", "ok", {
      skipped: true,
      reason: requirement.reason,
      currentReadSource: currentRead.source || null,
      publicationParity: requirement.publicationParity,
    });
    return health;
  }
  if (sqlite.available !== true) {
    addCheck("sqlite auto-repair", "failed", {
      skipped: true,
      reason: "sqlite-unavailable",
      currentReadSource: currentRead.source || null,
      sqliteReason: sqlite.reason || null
    });
    return health;
  }

  const syncLock = await acquireSyncLock({
    owner: "runtime-monitor",
    source: "sqlite-auto-repair",
    waitMs: sqliteRepairLockWaitMs
  });
  if (!syncLock.acquired) {
    addCheck("sqlite auto-repair", "watch", {
      skipped: true,
      reason: syncLock.reason || "sync lock held",
      beforeReadSource: currentRead.source || null,
      lock: {
        owner: syncLock.info?.owner || null,
        source: syncLock.info?.source || null,
        pid: syncLock.info?.pid || null,
        startedAt: syncLock.info?.startedAt || null,
        ageMs: Math.round(syncLock.ageMs || 0)
      }
    });
    return health;
  }

  const startedAt = new Date().toISOString();
  try {
    const result = runSqliteRepairCommands();
    const exportPayload = result.sqlite.payload;
    const exportOk = result.ok;
    addCheck("sqlite auto-repair", exportOk ? "ok" : "failed", {
      startedAt,
      finishedAt: new Date().toISOString(),
      timeoutMs: sqliteRepairTimeoutMs,
      exitStatus: result.projection?.status ?? result.sqlite.status,
      signal: result.projection?.signal || result.sqlite.signal || null,
      beforeReadSource: currentRead.source || null,
      lockOwner: syncLock.info?.owner || null,
      exportOk,
      sqliteExportOk: result.sqlite.ok,
      postgresProjectionOk: result.projection?.ok ?? null,
      counts: exportPayload?.counts || null,
      dbPath: exportPayload?.dbPath || process.env.DATASTORE_SQLITE_PATH || path.join(storeDir, "football.db"),
      error: result.sqlite.error || result.projection?.error || null
    });
    if (!exportOk) return health;

    const after = await requestJson("/api/v1/health");
    const afterRead = after.body?.data?.currentRead || {};
    const afterSqlite = after.body?.storage?.sqlite || {};
    const afterRequirement = evaluateSqliteReadRequirement({
      sqlite: afterSqlite,
      postgres: after.body?.storage?.postgres || {},
      currentRead: afterRead,
      requireSqlite,
      autoRepairSqlite,
      postgresMode,
    });
    const repaired = after.ok && afterRequirement.requirementMet;
    addCheck("sqlite primary read after repair", repaired ? "ok" : "failed", {
      httpStatus: after.status,
      currentReadSource: afterRead.source || null,
      sqliteAvailable: afterSqlite.available ?? null,
      publicationParity: afterRequirement.publicationParity,
      reason: afterRequirement.reason,
      currentRows: after.body?.data?.currentCount ?? null,
      historyRows: after.body?.data?.historyCount ?? null,
      error: after.error || after.parseError || null
    });
    if (repaired) {
      markSqlitePrimaryReadRepaired({
        beforeReadSource: currentRead.source || null,
        afterReadSource: afterRead.source || null,
        repairedAt: new Date().toISOString()
      });
      return after.body;
    }
    return health;
  } finally {
    if (syncLock.release) await syncLock.release();
  }
};

const checkSourceHealth = async () => {
  const sourceHealth = await requestJson("/api/v1/source-health");
  const reachable = sourceHealth.ok && sourceHealth.body && sourceHealth.status === 200;
  addCheck("source-health endpoint", reachable ? "ok" : "failed", {
    httpStatus: sourceHealth.status,
    ms: sourceHealth.ms,
    attempts: sourceHealth.attempts || 1,
    previousAttempts: sourceHealth.previousAttempts || [],
    error: sourceHealth.error || sourceHealth.parseError || null
  });
  if (!reachable) return null;

  const body = sourceHealth.body;
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const schemaOk = sources.length >= 4 && !body.admin;
  const fallbackUsable = body.fallbackCoverage?.usable === true;
  addCheck("source-health public schema", schemaOk ? "ok" : "failed", {
    sourceHealthOk: body.ok ?? null,
    sourceCount: sources.length,
    exposesAdmin: Boolean(body.admin),
    fallbackServingMode: body.fallbackCoverage?.servingMode || null
  });

  addCheck("source-health serving mode", body.ok === true ? "ok" : (fallbackUsable ? "watch" : "failed"), {
    sourceHealthOk: body.ok ?? null,
    fallbackUsable,
    fallbackServingMode: body.fallbackCoverage?.servingMode || null,
    fallbackReason: body.fallbackCoverage?.fallbackReason || null
  });

  const requiredStale = sources
    .filter((source) => source.required && source.stale)
    .map((source) => source.id || source.label || "unknown");
  const degradedRequired = sources
    .filter((source) => source.required && source.status && source.status !== "healthy")
    .map((source) => ({
      id: source.id || null,
      status: source.status,
      score: source.score ?? null,
      stale: source.stale ?? null,
      transport: source.metrics?.transport || null,
      egressStatus: source.metrics?.egress?.status || null
    }));
  const degradedOptional = sources
    .filter((source) => !source.required && source.status && source.status !== "healthy")
    .map((source) => ({
      id: source.id || null,
      status: source.status,
      score: source.score ?? null,
      stale: source.stale ?? null
    }));
  if (requiredStale.length > 0) {
    const primaryServing = body.fallbackCoverage?.servingMode === "primary";
    addCheck("required sources freshness", (primaryServing || fallbackUsable) ? "watch" : "failed", {
      requiredStale,
      primaryServing,
      fallbackUsable,
      fallbackServingMode: body.fallbackCoverage?.servingMode || null
    });
  } else {
    addCheck("required sources freshness", degradedRequired.length > 0 ? "watch" : "ok", {
      degraded: degradedRequired,
      optionalDegraded: degradedOptional,
      ignoredOptionalDegraded: degradedOptional.length
    });
  }

  const sporttery = sources.find((source) => source.id === "sporttery");
  const relaySnapshot = sporttery?.metrics?.relaySnapshot || null;
  const collector = relaySnapshot?.collectorState || null;
  const relayTrustLevel = collector?.lastUploadTrustLevel || null;
  const relayTrusted = collector?.lastUploadSnapshotTrusted === true || relayTrustLevel === "trusted";
  const relayPartialLive = relayTrustLevel === "partial-live";
  const relayRows = collector?.lastUploadSnapshotRows ?? relaySnapshot?.rows ?? null;
  const relayUsableEndpoints = collector?.lastUploadSnapshotUsableEndpoints ?? relaySnapshot?.usableEndpoints ?? null;
  const relayStatus = relayTrusted
    ? "ok"
    : relayPartialLive
      ? "watch"
      : relaySnapshot
        ? "watch"
        : "failed";
  addCheck("sporttery relay trust level", relayStatus, {
    trustLevel: relayTrustLevel,
    trusted: relayTrusted,
    partialLive: relayPartialLive,
    rows: relayRows,
    usableEndpoints: relayUsableEndpoints,
    methods: relaySnapshot?.methods || [],
    consecutiveCollectFailures: collector?.consecutiveCollectFailures ?? null,
    lastTrustedUploadAt: collector?.lastTrustedUploadAt || null,
    lastPartialLiveUploadAt: collector?.lastPartialLiveUploadAt || null,
    lastFailure: collector?.lastFailure || null,
    warnings: relaySnapshot?.warnings || []
  });

  return body;
};

const candidateProspectiveRuntimeState = (modelEvaluation) => {
  const candidate = modelEvaluation?.publicScorecard
    ?.shadowTracks?.CANDIDATE_PROSPECTIVE || null;
  const heartbeat = candidate?.captureHeartbeat || null;
  const readiness = heartbeat?.readiness || null;
  const admission = readiness?.admission || null;
  const decisionRecord = candidate?.decisionRecord || null;
  const settlementRecord = candidate?.settlementRecord || null;
  const blockers = [];
  const count = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
  };
  const upcomingMatches = count(readiness?.upcomingMatches);
  const evaluatedMatches = count(readiness?.evaluatedMatches);
  const detailedMatches = count(readiness?.detailedMatches);
  const rowsTruncated = count(readiness?.rowsTruncated);
  const previewLimit = count(readiness?.previewLimit);
  const readyNow = count(readiness?.readyNow);
  const atomicReadyNow = count(readiness?.atomicReadyNow);
  const awaitingMarket = count(readiness?.awaitingMarket);
  const blocked = count(readiness?.blocked);
  const excluded = count(readiness?.excluded);
  const dueMatches = count(heartbeat?.dueMatches);
  const dueCaptureEventsAdded = count(heartbeat?.dueCaptureEventsAdded);
  const dueDecisionEventsAdded = count(heartbeat?.dueDecisionEventsAdded);
  const dueExclusionEventsAdded = count(heartbeat?.dueExclusionEventsAdded);
  const dueAtomicDecisionEventsAdded = count(
    heartbeat?.dueAtomicDecisionEventsAdded,
  );
  const dueUnrecorded = count(admission?.dueUnrecorded);
  const readyDueUnrecorded = count(admission?.readyDueUnrecorded);
  const pendingDeadline = count(admission?.pendingDeadline);
  const captureFinalizationGraceSeconds = count(
    readiness?.captureFinalizationGraceSeconds,
  );
  const nearestDeadlineBatch = readiness?.nearestDeadlineBatch || null;
  const nearestBatchPendingMatches = count(
    nearestDeadlineBatch?.pendingMatches,
  );
  const marketCoverage = readiness?.marketCoverage || null;
  const marketEvaluatedMatches = count(marketCoverage?.evaluatedMatches);
  const decisionSnapshotObservedMatches = count(
    marketCoverage?.decisionSnapshotObservedMatches,
  );
  const officialHadPublishedMatches = count(
    marketCoverage?.officialHadPublishedMatches,
  );
  const strictMarketEvidenceCompleteMatches = count(
    marketCoverage?.strictMarketEvidenceCompleteMatches,
  );
  const atomicReadyMatches = count(marketCoverage?.atomicReadyMatches);
  const awaitingUnpublishedMatches = count(
    marketCoverage?.awaitingUnpublishedMatches,
  );
  const awaitingSnapshotMissingMatches = count(
    marketCoverage?.awaitingSnapshotMissingMatches,
  );
  const publishedChainGapMatches = count(
    marketCoverage?.publishedChainGapMatches,
  );
  const terminalExcludedMatches = count(
    marketCoverage?.terminalExcludedMatches,
  );
  const awaitingClassifiedMatches = count(
    marketCoverage?.awaitingClassifiedMatches,
  );
  const aggregateCountTotal = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.some(([key, total]) => (
      !/^[a-z0-9-]+$/.test(key)
      || count(total) === null
    ))) {
      return null;
    }
    return entries.reduce((sum, [, total]) => sum + count(total), 0);
  };
  const awaitingReasonRows = aggregateCountTotal(
    readiness?.awaitingReasonCounts,
  );
  const marketStateRows = aggregateCountTotal(
    marketCoverage?.marketStateCounts,
  );

  if (!candidate) blockers.push("candidate-prospective-track-missing");
  if (candidate?.state !== "ACTIVE") blockers.push("candidate-prospective-not-active");
  if (candidate?.chainValid !== true) blockers.push("candidate-prospective-chain-invalid");
  if (decisionRecord?.version !== "candidate-atomic-decision-record-v3") {
    blockers.push("atomic-decision-record-version-invalid");
  }
  if (
    decisionRecord?.validationVersion
    !== "candidate-atomic-decision-validation-v2"
  ) {
    blockers.push("atomic-decision-validation-version-invalid");
  }
  if (
    decisionRecord?.dualMarketDecisionRecordVersion
    !== "candidate-dual-market-decision-record-v1"
    || decisionRecord?.formalMetricMarket !== "HAD"
    || decisionRecord?.companionMarket !== "HHAD"
  ) {
    blockers.push("dual-market-decision-contract-invalid");
  }
  const requiredDecisionFields = [
    "identity",
    "official-market-provenance",
    "odds",
    "base-model-probabilities",
    "candidate-probabilities",
    "devigged-market-probabilities",
    "feature-snapshot",
    "strategy-versions",
    "source-clock",
    "dual-market-decision-record",
    "dual-market-decision-hash",
    "temporal-ordering",
    "atomic-decision-hash",
  ];
  const auditedDecisionFields = new Set(
    Array.isArray(decisionRecord?.requiredFields)
      ? decisionRecord.requiredFields.map((field) => String(field))
      : [],
  );
  if (requiredDecisionFields.some((field) => !auditedDecisionFields.has(field))) {
    blockers.push("atomic-decision-required-fields-incomplete");
  }
  const admittedDecisionRows = count(decisionRecord?.admittedRows);
  const atomicDecisionRows = count(decisionRecord?.atomicRows);
  const completeDecisionRows = count(decisionRecord?.completeRows);
  const failedDecisionRows = count(decisionRecord?.failedRows);
  const semanticBlockerCount = Object.values(decisionRecord?.blockerCounts || {})
    .reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  if (
    decisionRecord?.complete !== true
    || Number(decisionRecord?.coverage) !== 1
    || admittedDecisionRows === null
    || atomicDecisionRows !== admittedDecisionRows
    || completeDecisionRows !== admittedDecisionRows
  ) {
    blockers.push("atomic-decision-record-incomplete");
  }
  if (failedDecisionRows !== 0 || semanticBlockerCount !== 0) {
    blockers.push("atomic-decision-semantic-validation-failed");
  }
  if (settlementRecord?.version !== "candidate-official-settlement-record-v1") {
    blockers.push("settlement-record-version-invalid");
  }
  if (
    settlementRecord?.validationVersion
    !== "candidate-official-settlement-validation-v1"
  ) {
    blockers.push("settlement-validation-version-invalid");
  }
  const requiredSettlementFields = [
    "decision-link",
    "official-result-identity",
    "score-outcome-consistency",
    "result-observation-clock",
    "result-provenance-hash",
  ];
  const auditedSettlementFields = new Set(
    Array.isArray(settlementRecord?.requiredFields)
      ? settlementRecord.requiredFields.map((field) => String(field))
      : [],
  );
  if (requiredSettlementFields.some((field) => !auditedSettlementFields.has(field))) {
    blockers.push("settlement-required-fields-incomplete");
  }
  const settlementRows = count(settlementRecord?.rows);
  const completeSettlementRows = count(settlementRecord?.completeRows);
  const failedSettlementRows = count(settlementRecord?.failedRows);
  const settlementSemanticBlockerCount = Object.values(
    settlementRecord?.blockerCounts || {},
  ).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  if (
    settlementRecord?.complete !== true
    || Number(settlementRecord?.coverage) !== 1
    || settlementRows === null
    || completeSettlementRows !== settlementRows
  ) {
    blockers.push("settlement-record-incomplete");
  }
  if (failedSettlementRows !== 0 || settlementSemanticBlockerCount !== 0) {
    blockers.push("settlement-semantic-validation-failed");
  }
  if (heartbeat?.version !== "prospective-deadline-heartbeat-v2") {
    blockers.push("candidate-capture-heartbeat-version-invalid");
  }
  if (heartbeat?.fresh !== true) blockers.push("candidate-capture-heartbeat-stale");
  if (heartbeat?.ok !== true) blockers.push("candidate-capture-heartbeat-unhealthy");
  if (heartbeat?.skipped === true) blockers.push("candidate-capture-heartbeat-skipped");
  if (heartbeat?.scheduleVersion) {
    if (
      heartbeat.scheduleVersion !== "candidate-heartbeat-preemptive-schedule-v1"
      || heartbeat.scheduleMode !== "preemptive-evaluated-at"
    ) {
      blockers.push("candidate-heartbeat-preemptive-schedule-invalid");
    }
    if (heartbeat.nextAttemptBudgetFits !== true) {
      blockers.push("candidate-heartbeat-preemptive-budget-missed");
    }
  }
  if (
    dueMatches === null
    || dueCaptureEventsAdded === null
    || dueDecisionEventsAdded === null
    || dueExclusionEventsAdded === null
    || dueAtomicDecisionEventsAdded === null
  ) {
    blockers.push("candidate-deadline-cohort-audit-missing");
  } else {
    if (dueDecisionEventsAdded + dueExclusionEventsAdded !== dueCaptureEventsAdded) {
      blockers.push("candidate-deadline-cohort-event-count-mismatch");
    }
    if (dueCaptureEventsAdded !== dueMatches) {
      blockers.push("candidate-deadline-cohort-capture-incomplete");
    }
    if (dueAtomicDecisionEventsAdded !== dueDecisionEventsAdded) {
      blockers.push("candidate-deadline-cohort-atomic-incomplete");
    }
  }
  if (heartbeat?.dueCaptureComplete !== true) {
    blockers.push("candidate-deadline-cohort-completion-unconfirmed");
  }
  if (heartbeat?.dueAtomicComplete !== true) {
    blockers.push("candidate-deadline-cohort-atomic-completion-unconfirmed");
  }
  if (readiness?.version !== "candidate-prospective-readiness-preview-v2") {
    blockers.push("candidate-readiness-missing-or-invalid");
  }
  if (
    readiness?.captureFinalizationPolicyVersion !== "deadline-evidence-grace-v1"
    || captureFinalizationGraceSeconds !== 120
  ) {
    blockers.push("candidate-capture-finalization-policy-invalid");
  }
  if (
    upcomingMatches === null
    || readyNow === null
    || atomicReadyNow === null
    || awaitingMarket === null
    || blocked === null
    || excluded === null
  ) {
    blockers.push("candidate-readiness-count-invalid");
  } else {
    if (readyNow + awaitingMarket + blocked + excluded !== upcomingMatches) {
      blockers.push("candidate-readiness-denominator-mismatch");
    }
    if (
      evaluatedMatches === null
      || detailedMatches === null
      || rowsTruncated === null
      || previewLimit === null
    ) {
      blockers.push("candidate-readiness-full-coverage-metadata-missing");
    } else {
      if (evaluatedMatches !== upcomingMatches) {
        blockers.push("candidate-readiness-full-coverage-denominator-mismatch");
      }
      if (detailedMatches + rowsTruncated !== evaluatedMatches) {
        blockers.push("candidate-readiness-detail-truncation-mismatch");
      }
      if (detailedMatches > previewLimit) {
        blockers.push("candidate-readiness-detail-limit-exceeded");
      }
    }
    if (atomicReadyNow !== readyNow) {
      blockers.push("candidate-atomic-ready-count-mismatch");
    }
    if (blocked > 0) blockers.push("candidate-upcoming-blocked");
    if (
      marketCoverage?.version
        !== "candidate-official-market-coverage-preview-v1"
      || [
        marketEvaluatedMatches,
        decisionSnapshotObservedMatches,
        officialHadPublishedMatches,
        strictMarketEvidenceCompleteMatches,
        atomicReadyMatches,
        awaitingUnpublishedMatches,
        awaitingSnapshotMissingMatches,
        publishedChainGapMatches,
        terminalExcludedMatches,
        awaitingClassifiedMatches,
        awaitingReasonRows,
        marketStateRows,
      ].some((value) => value === null)
    ) {
      blockers.push("candidate-market-coverage-missing-or-invalid");
    } else {
      if (
        marketEvaluatedMatches !== evaluatedMatches
        || marketStateRows !== evaluatedMatches
        || atomicReadyMatches !== atomicReadyNow
        || terminalExcludedMatches !== excluded
      ) {
        blockers.push("candidate-market-coverage-denominator-mismatch");
      }
      if (
        awaitingUnpublishedMatches + awaitingSnapshotMissingMatches
          !== awaitingMarket
        || awaitingClassifiedMatches !== awaitingMarket
        || awaitingReasonRows !== awaitingMarket
        || marketCoverage?.awaitingClassificationComplete !== true
      ) {
        blockers.push("candidate-awaiting-market-classification-incomplete");
      }
      if (
        officialHadPublishedMatches < strictMarketEvidenceCompleteMatches
        || strictMarketEvidenceCompleteMatches < atomicReadyMatches
      ) {
        blockers.push("candidate-market-evidence-funnel-invalid");
      }
      if (publishedChainGapMatches > 0) {
        blockers.push("candidate-published-market-chain-gap");
      }
    }
    if (pendingDeadline !== null && pendingDeadline > 0) {
      const deadlineMs = Date.parse(readiness?.nearestDeadlineAt || "");
      const finalizationMs = Date.parse(readiness?.nearestFinalizationAt || "");
      if (
        !Number.isFinite(deadlineMs)
        || !Number.isFinite(finalizationMs)
        || finalizationMs - deadlineMs !== captureFinalizationGraceSeconds * 1000
        || nearestDeadlineBatch?.deadlineAt !== readiness?.nearestDeadlineAt
        || nearestBatchPendingMatches === null
        || nearestBatchPendingMatches <= 0
        || nearestDeadlineBatch?.invariantOk !== true
      ) {
        blockers.push("candidate-capture-finalization-clock-invalid");
      }
    }
    if (
      pendingDeadline === 0
      && (
        readiness?.nearestDeadlineAt !== null
        || readiness?.nearestFinalizationAt !== null
        || readiness?.nearestStatus !== null
        || nearestDeadlineBatch !== null
      )
    ) {
      blockers.push("candidate-terminal-cohort-still-nearest");
    }
  }
  if (readiness?.readyInvariantOk !== true) {
    blockers.push("candidate-ready-invariant-failed");
  }
  if (admission?.version !== "candidate-prospective-admission-summary-v1") {
    blockers.push("candidate-admission-summary-missing-or-invalid");
  }
  if (admission?.registryAvailable !== true) {
    blockers.push("candidate-admission-registry-unavailable");
  }
  if (admission?.reconciled !== true) {
    blockers.push("candidate-admission-unreconciled");
  }
  if (admission?.captureGap !== false) {
    blockers.push("candidate-admission-capture-gap");
  }
  if (pendingDeadline === null) {
    blockers.push("candidate-admission-pending-count-invalid");
  }
  if (dueUnrecorded === null || dueUnrecorded > 0) {
    blockers.push("candidate-due-unrecorded");
  }
  if (readyDueUnrecorded === null || readyDueUnrecorded > 0) {
    blockers.push("candidate-ready-due-unrecorded");
  }

  const windowEvaluation = candidate?.metrics?.windowEvaluation || null;
  const registeredWindows = count(
    candidate?.metrics?.registeredCalendarWindows
    ?? windowEvaluation?.registeredWindows,
  ) || 0;
  const eligibleWindows = count(
    candidate?.metrics?.calendarWindows
    ?? windowEvaluation?.eligibleWindows,
  ) || 0;
  const winningWindows = count(
    candidate?.metrics?.winningCalendarWindows
    ?? windowEvaluation?.winningWindows,
  ) || 0;
  const requiredWinningWindows = count(
    candidate?.metrics?.requiredWinningCalendarWindows
    ?? windowEvaluation?.requiredWinningWindows,
  ) || 5;
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    candidateRevisionId: candidate?.candidateRevisionId || null,
    state: candidate?.state || null,
    chainValid: candidate?.chainValid ?? null,
    settlementRecord: settlementRecord ? {
      version: settlementRecord.version || null,
      validationVersion: settlementRecord.validationVersion || null,
      rows: settlementRows,
      completeRows: completeSettlementRows,
      failedRows: failedSettlementRows,
      coverage: Number.isFinite(Number(settlementRecord.coverage))
        ? Number(settlementRecord.coverage)
        : null,
      complete: settlementRecord.complete === true,
    } : null,
    heartbeat: {
      version: heartbeat?.version || null,
      evaluatedAt: heartbeat?.evaluatedAt || null,
      captureDurationMs: heartbeat?.captureDurationMs ?? null,
      heartbeatAgeMs: heartbeat?.heartbeatAgeMs ?? null,
      freshnessLimitMs: heartbeat?.freshnessLimitMs ?? null,
      scheduleVersion: heartbeat?.scheduleVersion || null,
      preemptiveRefreshAgeMs: heartbeat?.preemptiveRefreshAgeMs ?? null,
      preemptiveRefreshDue: heartbeat?.preemptiveRefreshDue ?? null,
      nextAttemptType: heartbeat?.nextAttemptType || null,
      nextAttemptTimeoutMs: heartbeat?.nextAttemptTimeoutMs ?? null,
      nextAttemptProjectedCompletionAgeMs:
        heartbeat?.nextAttemptProjectedCompletionAgeMs ?? null,
      nextAttemptBudgetFits: heartbeat?.nextAttemptBudgetFits ?? null,
      fresh: heartbeat?.fresh ?? null,
      ok: heartbeat?.ok ?? null,
      skipped: heartbeat?.skipped ?? null,
      reason: heartbeat?.reason || null,
      lastAttemptAt: heartbeat?.lastAttemptAt || null,
      lastAttemptReason: heartbeat?.lastAttemptReason || null,
      lastAttemptStatusAdvanced: heartbeat?.lastAttemptStatusAdvanced ?? null,
      lastAttemptErrorCode: heartbeat?.lastAttemptErrorCode || null,
      lastAttemptExitCode: heartbeat?.lastAttemptExitCode ?? null,
      lastAttemptSignal: heartbeat?.lastAttemptSignal || null,
      lastAttemptPublishedStatusReason:
        heartbeat?.lastAttemptPublishedStatusReason || null,
      lastAttemptPublishedStatusOk:
        heartbeat?.lastAttemptPublishedStatusOk ?? null,
      captureFinalizationPolicyVersion:
        readiness?.captureFinalizationPolicyVersion || null,
      captureFinalizationGraceSeconds,
      nearestFinalizationAt: readiness?.nearestFinalizationAt || null,
      dueMatches,
      dueCaptureEventsAdded,
      dueDecisionEventsAdded,
      dueExclusionEventsAdded,
      dueAtomicDecisionEventsAdded,
      dueCaptureComplete: heartbeat?.dueCaptureComplete ?? null,
      dueAtomicComplete: heartbeat?.dueAtomicComplete ?? null,
    },
    readiness: {
      upcomingMatches,
      evaluatedMatches,
      detailedMatches,
      rowsTruncated,
      previewLimit,
      readyNow,
      atomicReadyNow,
      awaitingMarket,
      blocked,
      excluded,
      blockerCounts: readiness?.blockerCounts || {},
      awaitingReasonCounts: readiness?.awaitingReasonCounts || {},
      excludedReasonCounts: readiness?.excludedReasonCounts || {},
      marketCoverage: {
        version: marketCoverage?.version || null,
        evaluatedMatches: marketEvaluatedMatches,
        decisionSnapshotObservedMatches,
        officialHadPublishedMatches,
        strictMarketEvidenceCompleteMatches,
        atomicReadyMatches,
        awaitingUnpublishedMatches,
        awaitingSnapshotMissingMatches,
        publishedChainGapMatches,
        terminalExcludedMatches,
        awaitingClassifiedMatches,
        awaitingClassificationComplete:
          marketCoverage?.awaitingClassificationComplete ?? null,
        marketStateCounts: marketCoverage?.marketStateCounts || {},
      },
      readyInvariantOk: readiness?.readyInvariantOk ?? null,
    },
    admission: {
      reconciled: admission?.reconciled ?? null,
      captureGap: admission?.captureGap ?? null,
      admitted: count(admission?.admitted),
      excluded: count(admission?.excluded),
      pendingDeadline: count(admission?.pendingDeadline),
      dueUnrecorded,
      readyDueUnrecorded,
    },
    progress: {
      formalRows: count(candidate?.metrics?.formalRows) || 0,
      requiredRows: 500,
      registeredWindows,
      eligibleWindows,
      winningWindows,
      requiredWindows: count(windowEvaluation?.requiredWindows) || registeredWindows || 6,
      requiredWinningWindows,
      promotionReviewReady: candidate?.promotionReviewReady === true,
    },
  };
};

const candidateProspectiveProgressStatus = (candidateCapture) => {
  if (candidateCapture?.ok !== true) return "failed";
  return candidateCapture?.progress?.promotionReviewReady === true
    ? "ok"
    : "watch";
};

const candidateProspectiveTemporalRuntimeState = (modelEvaluation) => {
  const captureAudit = modelEvaluation?.candidateCaptureAudit || null;
  const temporal = captureAudit?.temporalStatus || null;
  const prospective = captureAudit?.prospectiveAudit || null;
  const formal = prospective?.cohort?.formal || null;
  const blockers = [];
  const count = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
  };
  const reasonCounts = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const entries = Object.entries(value);
    if (entries.some(([reason, total]) => (
      !/^[a-z0-9-]+$/.test(reason)
      || count(total) === null
    ))) {
      return null;
    }
    return Object.fromEntries(
      entries
        .map(([reason, total]) => [reason, count(total)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  const admittedRows = count(temporal?.admittedRows);
  const settledRows = count(temporal?.settledRows);
  const pendingRows = count(temporal?.pendingRows);
  const futureKickoffRows = count(temporal?.futureKickoffRows);
  const kickoffPassedRows = count(temporal?.kickoffPassedRows);
  const awaitingOfficialFinalRows = count(temporal?.awaitingOfficialFinalRows);
  const officialVoidRows = count(temporal?.officialVoidRows);
  const officialResultRecordMissingRows = count(
    temporal?.officialResultRecordMissingRows,
  );
  const officialFinishedIneligibleRows = count(
    temporal?.officialFinishedIneligibleRows,
  );
  const officialFinishedEligibleUnsettledRows = count(
    temporal?.officialFinishedEligibleUnsettledRows,
  );
  const invalidKickoffRows = count(temporal?.invalidKickoffRows);
  const officialFinishedIneligibleReasonCounts = reasonCounts(
    temporal?.officialFinishedIneligibleReasonCounts,
  );
  const officialFinishedIneligiblePrimaryReasonCounts = reasonCounts(
    temporal?.officialFinishedIneligiblePrimaryReasonCounts,
  );

  if (
    temporal?.version !== "candidate-prospective-temporal-audit-v1"
    || temporal?.activeLedgerPresent !== true
  ) {
    blockers.push("candidate-temporal-audit-missing-or-invalid");
  }
  if (
    [
      admittedRows,
      settledRows,
      pendingRows,
      futureKickoffRows,
      kickoffPassedRows,
      awaitingOfficialFinalRows,
      officialVoidRows,
      officialResultRecordMissingRows,
      officialFinishedIneligibleRows,
      officialFinishedEligibleUnsettledRows,
      invalidKickoffRows,
    ].some((value) => value === null)
  ) {
    blockers.push("candidate-temporal-audit-count-invalid");
  } else {
    if (
      temporal?.denominatorReconciled !== true
      || admittedRows !== settledRows + pendingRows
    ) {
      blockers.push("candidate-temporal-admission-denominator-mismatch");
    }
    if (
      pendingRows
      !== futureKickoffRows + kickoffPassedRows + invalidKickoffRows
    ) {
      blockers.push("candidate-temporal-pending-denominator-mismatch");
    }
    if (
      kickoffPassedRows
      !== awaitingOfficialFinalRows
        + officialVoidRows
        + officialResultRecordMissingRows
        + officialFinishedIneligibleRows
        + officialFinishedEligibleUnsettledRows
    ) {
      blockers.push("candidate-temporal-result-denominator-mismatch");
    }
  }
  if (
    admittedRows !== count(formal?.admitted)
    || settledRows !== count(formal?.settled)
    || pendingRows !== count(formal?.pending)
  ) {
    blockers.push("candidate-temporal-cohort-mismatch");
  }
  const primaryReasonRows =
    officialFinishedIneligiblePrimaryReasonCounts === null
      ? null
      : Object.values(officialFinishedIneligiblePrimaryReasonCounts)
        .reduce((sum, value) => sum + value, 0);
  if (
    officialFinishedIneligibleReasonCounts === null
    || officialFinishedIneligiblePrimaryReasonCounts === null
    || primaryReasonRows !== officialFinishedIneligibleRows
    || (
      officialFinishedIneligibleReasonCounts
      && Object.values(officialFinishedIneligibleReasonCounts)
        .some((value) => value > officialFinishedIneligibleRows)
    )
  ) {
    blockers.push("candidate-temporal-ineligible-reason-count-mismatch");
  }
  if (
    temporal?.settlementWorkerAttentionRequired === true
    || (
      officialFinishedEligibleUnsettledRows !== null
      && officialFinishedEligibleUnsettledRows > 0
    )
  ) {
    blockers.push("candidate-official-result-settlement-missed");
  }
  if (
    officialResultRecordMissingRows !== null
    && officialResultRecordMissingRows > 0
  ) {
    blockers.push("candidate-settlement-read-model-row-missing");
  }

  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    version: temporal?.version || null,
    evaluatedAt: temporal?.evaluatedAt || null,
    activeLedgerPresent: temporal?.activeLedgerPresent ?? null,
    admittedRows,
    settledRows,
    pendingRows,
    futureKickoffRows,
    kickoffPassedRows,
    awaitingOfficialFinalRows,
    officialVoidRows,
    officialResultRecordMissingRows,
    officialFinishedIneligibleRows,
    officialFinishedIneligibleReasonCounts,
    officialFinishedIneligiblePrimaryReasonCounts,
    officialFinishedEligibleUnsettledRows,
    invalidKickoffRows,
    settlementWorkerAttentionRequired:
      temporal?.settlementWorkerAttentionRequired ?? null,
    denominatorReconciled: temporal?.denominatorReconciled ?? null,
    pendingKickoffRange: temporal?.pendingKickoffRange || {
      earliest: null,
      latest: null,
    },
  };
};

const checkModel = async () => {
  if (!checkModelEvaluation) {
    addCheck("model evaluation endpoint", "watch", { skipped: true });
    return null;
  }
  const model = await requestJson("/api/v1/model/evaluation");
  const reachable = model.ok && model.body && model.status === 200;
  addCheck("model evaluation endpoint", reachable && model.body?.ok !== false ? "ok" : "failed", {
    httpStatus: model.status,
    ms: model.ms,
    attempts: model.attempts || 1,
    previousAttempts: model.previousAttempts || [],
    ok: model.body?.ok ?? null,
    modelVersion: model.body?.modelVersion || model.body?.version || null,
    error: model.error || model.parseError || null
  });
  const body = reachable ? model.body : null;
  const candidateCapture = candidateProspectiveRuntimeState(body);
  const candidateCaptureStatus = candidateProspectiveCaptureRuntimeStatus(
    candidateCapture,
    Date.now(),
    candidateCaptureDeadlineRiskSeconds,
  );
  addCheck(
    "candidate prospective capture",
    candidateCaptureStatus,
    candidateCapture,
  );
  addCheck(
    "candidate prospective collection progress",
    candidateCaptureStatus === "failed"
      ? "failed"
      : candidateCapture.progress?.promotionReviewReady === true
        ? "ok"
        : "watch",
    candidateCapture.progress,
  );
  return body;
};

const checkCandidateTemporalAudit = async () => {
  if (!checkModelEvaluation) {
    addCheck("candidate settlement temporal audit", "watch", {
      skipped: true,
      reason: "model-evaluation-check-disabled",
    });
    return null;
  }
  if (!monitorAdminToken) {
    addCheck(
      "candidate settlement temporal audit",
      requireCandidateTemporalAudit ? "failed" : "watch",
      {
        skipped: true,
        reason: "runtime-monitor-admin-token-missing",
      },
    );
    return null;
  }
  const model = await requestJson(
    "/api/v1/model/evaluation?detail=admin",
    { authorization: `Bearer ${monitorAdminToken}` },
  );
  const reachable = model.ok && model.body && model.status === 200;
  const temporal = candidateProspectiveTemporalRuntimeState(
    reachable ? model.body : null,
  );
  addCheck(
    "candidate settlement temporal audit",
    reachable && temporal.ok ? "ok" : "failed",
    {
      httpStatus: model.status,
      ms: model.ms,
      attempts: model.attempts || 1,
      previousAttempts: model.previousAttempts || [],
      error: model.error || model.parseError || null,
      ...temporal,
    },
  );
  return reachable ? model.body : null;
};

const checkSystemdUnits = (health = null) => {
  if (!checkSystemd) {
    addCheck("systemd units", "watch", { skipped: true, reason: "systemd check disabled or non-linux platform" });
    return;
  }
  const units = systemdUnits.map((unit) => {
    const result = runCommand("systemctl", ["is-active", unit], { timeout: commandTimeoutMs });
    const active = result.status === 0 && result.stdout === "active";
    return {
      unit,
      active,
      state: result.stdout || result.stderr || result.error || "unknown"
    };
  });
  const inactive = units.filter((unit) => !unit.active);
  const workerPausedForApiSync = inactive.length === 1
    && inactive[0].unit === "football-sync-worker"
    && health?.sync?.apiSyncRunning === true;
  const cloudSyncProcess = allowLocalPushWorkerPause && inactive.length === 1 && inactive[0].unit === "football-sync-worker"
    ? runCommand("pgrep", ["-af", cloudSyncProcessPattern], { timeout: Math.min(commandTimeoutMs, 3000) })
    : null;
  const cloudSyncProcessLines = String(cloudSyncProcess?.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/pgrep -af|checkServerRuntime\.cjs/.test(line));
  const workerPausedForCloudSync = inactive.length === 1
    && inactive[0].unit === "football-sync-worker"
    && cloudSyncProcessLines.length > 0;
  const workerPauseIsExpected = workerPausedForApiSync || workerPausedForCloudSync;
  addCheck("systemd units", inactive.length === 0 ? "ok" : (workerPauseIsExpected ? "watch" : "failed"), {
    units,
    inactive,
    workerPausedForApiSync,
    workerPausedForCloudSync,
    allowLocalPushWorkerPause,
    cloudSyncProcessPattern,
    cloudSyncProcessLines: cloudSyncProcessLines.slice(0, 5)
  });
};

const checkDiskUsage = () => {
  if (!checkDisk) {
    addCheck("disk usage", "watch", { skipped: true, reason: "disk check disabled or non-linux platform" });
    return;
  }
  const result = runCommand("df", ["-Pk", ...diskPaths], { timeout: commandTimeoutMs });
  if (result.status !== 0) {
    addCheck("disk usage", "failed", { error: result.stderr || result.error || result.stdout });
    return;
  }
  const filesystems = parseDf(result.stdout);
  const maxUsePercent = filesystems.reduce((max, row) => Math.max(max, Number(row.usePercent || 0)), 0);
  const status = maxUsePercent >= diskFailPercent ? "failed" : maxUsePercent >= diskWarnPercent ? "watch" : "ok";
  addCheck("disk usage", status, {
    maxUsePercent,
    warnPercent: diskWarnPercent,
    failPercent: diskFailPercent,
    filesystems
  });
};

const checkCleanupDryRun = () => {
  if (!checkCleanup) {
    addCheck("cleanup dry-run", "watch", { skipped: true });
    return null;
  }
  const scriptPath = path.join(rootDir, "scripts", "cleanupServerArtifacts.cjs");
  if (!fs.existsSync(scriptPath)) {
    addCheck("cleanup dry-run", "failed", { error: "cleanup script missing", scriptPath });
    return null;
  }
  const result = runCommand(process.execPath, [scriptPath], {
    timeout: cleanupTimeoutMs,
    env: {
      ...process.env,
      SERVER_CLEANUP_APPLY: "0",
      SERVER_CLEANUP_STORE_DIR: process.env.SERVER_CLEANUP_STORE_DIR || storeDir
    }
  });
  let body = null;
  try {
    body = JSON.parse(result.stdout || "{}");
  } catch (error) {
    addCheck("cleanup dry-run", "failed", {
      exitStatus: result.status,
      parseError: error.message || String(error),
      stderr: result.stderr || null,
      sample: result.stdout.slice(0, 240)
    });
    return null;
  }
  const candidates = Number(body.summary?.candidates || 0);
  const failed = Number(body.summary?.failed || 0);
  const checkStatus = result.status === 0 && body.ok !== false && failed === 0
    ? (candidates > cleanupCandidateWatchLimit ? "watch" : "ok")
    : "failed";
  addCheck("cleanup dry-run", checkStatus, {
    candidates,
    failed,
    bytes: body.summary?.bytes || 0,
    byCategory: body.summary?.byCategory || {},
    firstCandidates: Array.isArray(body.candidates)
      ? body.candidates.slice(0, 5).map((item) => ({ path: item.path, category: item.category, bytes: item.bytes || 0 }))
      : []
  });
  return body;
};

const statusFromChecks = () => {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.some((check) => check.status === "watch")) return "watch";
  return "ok";
};

const buildPayload = (
  health,
  sourceHealth,
  modelEvaluation,
  candidateTemporalEvaluation,
  cleanup,
) => {
  const sourceCounts = {};
  for (const source of Array.isArray(sourceHealth?.sources) ? sourceHealth.sources : []) {
    const key = source.status || "unknown";
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
  }
  const sportterySource = Array.isArray(sourceHealth?.sources)
    ? sourceHealth.sources.find((source) => source.id === "sporttery")
    : null;
  const sportteryRelaySnapshot = sportterySource?.metrics?.relaySnapshot || null;
  const sportteryRelayCollector = sportteryRelaySnapshot?.collectorState || null;
  const diskCheck = checks.find((check) => check.name === "disk usage");
  const cleanupCheck = checks.find((check) => check.name === "cleanup dry-run");
  const candidateCapture = candidateProspectiveRuntimeState(modelEvaluation);
  const candidateTemporal = candidateProspectiveTemporalRuntimeState(
    candidateTemporalEvaluation,
  );
  const status = statusFromChecks();
  return {
    ok: status !== "failed",
    status,
    checkedAt: new Date().toISOString(),
    baseUrl,
    statusPath,
    summary: {
      servingMode: health?.status?.servingMode || null,
      recommendationReliable: health?.status?.recommendationReliable ?? null,
      dataFresh: health?.status?.dataFresh ?? null,
      fallbackAgeSeconds: health?.status?.fallbackAgeSeconds ?? null,
      fallbackMaxAgeSeconds: health?.status?.fallbackMaxAgeSeconds ?? null,
      fallbackRunwaySeconds: finiteNumber(health?.status?.fallbackMaxAgeSeconds) !== null
        && finiteNumber(health?.status?.fallbackAgeSeconds) !== null
          ? Math.max(0, finiteNumber(health.status.fallbackMaxAgeSeconds) - finiteNumber(health.status.fallbackAgeSeconds))
          : null,
      currentReadSource: health?.data?.currentRead?.source || null,
      currentRows: health?.data?.currentCount ?? null,
      historyRows: health?.data?.historyCount ?? null,
      syncRunning: health?.sync?.running ?? null,
      fastResultWatcherEnabled: health?.sync?.fastResultWatcher?.enabled ?? null,
      fastResultWatcherLastCheckedAt: health?.sync?.fastResultWatcher?.lastCheckedAt || null,
      fastResultWatcherLastPublishedAt: health?.sync?.fastResultWatcher?.lastPublishedAt || null,
      fastResultWatcherLastError: health?.sync?.fastResultWatcher?.lastError || null,
      fastResultProbeFreshness: assessFastResultProbeFreshness(health?.sync?.fastResultWatcher, {
        required: requireFastResultWatcher,
      }).freshness,
      fastResultProbeReceivedAt: health?.sync?.fastResultWatcher?.inputEvidence?.resultProbeReceivedAt || null,
      sqliteBytes: health?.storage?.sqlite?.bytes ?? null,
      sqliteSchemaVersion: health?.storage?.sqlite?.schemaVersion || null,
      sqliteFreeRatio: health?.storage?.sqlite?.physical?.freeRatio ?? null,
      modelEvaluationFresh: health?.status?.modelEvaluationFresh ?? null,
      modelEvaluationOk: modelEvaluation?.ok ?? null,
      candidateRevisionId: candidateCapture.candidateRevisionId,
      candidateCaptureOk: candidateCapture.ok,
      candidateReadyNow: candidateCapture.readiness.readyNow,
      candidateAtomicReadyNow: candidateCapture.readiness.atomicReadyNow,
      candidateDueUnrecorded: candidateCapture.admission.dueUnrecorded,
      candidateFormalRows: candidateCapture.progress.formalRows,
      candidateWinningWindows: candidateCapture.progress.winningWindows,
      candidateTemporalAuditOk: candidateTemporal.ok,
      candidateTemporalPendingRows: candidateTemporal.pendingRows,
      candidateTemporalFutureKickoffRows:
        candidateTemporal.futureKickoffRows,
      candidateTemporalAwaitingOfficialFinalRows:
        candidateTemporal.awaitingOfficialFinalRows,
      candidateTemporalFinishedIneligibleRows:
        candidateTemporal.officialFinishedIneligibleRows,
      candidateTemporalFinishedIneligiblePrimaryReasonCounts:
        candidateTemporal.officialFinishedIneligiblePrimaryReasonCounts,
      candidateTemporalEligibleUnsettledRows:
        candidateTemporal.officialFinishedEligibleUnsettledRows,
      candidateSettlementWorkerAttentionRequired:
        candidateTemporal.settlementWorkerAttentionRequired,
      sourceCounts,
      sportteryRelayTrustLevel: sportteryRelayCollector?.lastUploadTrustLevel || null,
      sportteryRelayRows: sportteryRelayCollector?.lastUploadSnapshotRows ?? sportteryRelaySnapshot?.rows ?? null,
      sportteryRelayUsableEndpoints: sportteryRelayCollector?.lastUploadSnapshotUsableEndpoints ?? sportteryRelaySnapshot?.usableEndpoints ?? null,
      sportteryRelayConsecutiveFailures: sportteryRelayCollector?.consecutiveCollectFailures ?? null,
      diskMaxUsePercent: diskCheck?.maxUsePercent ?? null,
      cleanupCandidates: cleanupCheck?.candidates ?? cleanup?.summary?.candidates ?? null
    },
    checks
  };
};

const ensureStatusPathWritable = () => {
  const dir = path.dirname(statusPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
};

const writeStatus = (payload) => {
  const tmpPath = `${statusPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmpPath, statusPath);
};

const main = async () => {
  let health = await checkHealth();
  health = await maybeRepairSqliteRead(health);
  const sourceHealth = await checkSourceHealth();
  const modelEvaluation = await checkModel();
  const candidateTemporalEvaluation = await checkCandidateTemporalAudit();
  checkSystemdUnits(health);
  checkDiskUsage();
  const cleanup = checkCleanupDryRun();

  let payload = buildPayload(
    health,
    sourceHealth,
    modelEvaluation,
    candidateTemporalEvaluation,
    cleanup,
  );
  try {
    ensureStatusPathWritable();
    addCheck("status file writable", "ok", { path: statusPath });
    payload = buildPayload(
      health,
      sourceHealth,
      modelEvaluation,
      candidateTemporalEvaluation,
      cleanup,
    );
    writeStatus(payload);
  } catch (error) {
    addCheck("status file writable", "failed", {
      path: statusPath,
      error: error.message || String(error)
    });
    payload = buildPayload(
      health,
      sourceHealth,
      modelEvaluation,
      candidateTemporalEvaluation,
      cleanup,
    );
  }

  console.log(JSON.stringify(payload, null, 2));
  if (payload.status === "failed") process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    addCheck("runtime monitor", "failed", { error: error.stack || error.message || String(error) });
    const payload = buildPayload(null, null, null, null, null);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  readAllowedRuntimeValues,
  resolveMonitorPostgresMode,
  monitorRepairEnvironment,
  runSqliteRepairCommands,
  assessFastResultProbeFreshness,
  assessSqliteStorageStability,
  evaluateSqliteReadRequirement,
  candidateProspectiveCaptureRuntimeStatus,
  candidateProspectiveProgressStatus,
  candidateProspectiveRuntimeState,
  candidateProspectiveTemporalRuntimeState,
};
