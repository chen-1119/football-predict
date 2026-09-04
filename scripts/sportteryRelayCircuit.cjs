const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CURRENT_METHODS = new Set(["current", "calculator"]);
const PAGED_METHODS = new Set(["concern", "live", "result", "all"]);
const REQUIRED_ARCHIVE_METHODS = Object.freeze(["result", "all"]);

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const parseTime = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : NaN;
};

const isoAt = (nowMs = Date.now()) => new Date(nowMs).toISOString();

const normalizeConfig = (config = {}) => {
  const failureThreshold = Math.max(1, finiteNumber(config.failureThreshold, 3));
  const baseMinutes = Math.max(1, finiteNumber(config.baseMinutes, 15));
  const maxMinutes = Math.max(baseMinutes, finiteNumber(config.maxMinutes, 60));
  const fullIntervalMinutes = Math.max(1, finiteNumber(config.fullIntervalMinutes, 60));
  return { failureThreshold, baseMinutes, maxMinutes, fullIntervalMinutes };
};

const endpointMethod = (endpoint) => String(endpoint?.method || endpoint?.id || "")
  .replace(/^method:/, "")
  .trim()
  .toLowerCase();

const rowsInEndpointPayload = (payload) => (payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);

const snapshotEntries = (snapshot) => Array.isArray(snapshot?.endpoints)
  ? snapshot.endpoints
  : Array.isArray(snapshot?.payloads)
    ? snapshot.payloads
    : [];

const snapshotCycleDetails = (snapshot) => {
  const endpoints = snapshotEntries(snapshot);
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  const attempts = endpoints.concat(errors);
  const sourceCycleId = String(snapshot?.sourceCycleId || "").trim();
  const collectorCycleId = String(snapshot?.collectorProvenance?.sourceCycleId || "").trim();
  const attemptCycles = Array.from(new Set(attempts
    .map((entry) => String(entry?.sourceCycleId || entry?.collectorProvenance?.sourceCycleId || "").trim())
    .filter(Boolean)));
  const missingCycleAttempts = attempts.filter((entry) => !String(
    entry?.sourceCycleId || entry?.collectorProvenance?.sourceCycleId || ""
  ).trim()).length;
  const blockers = [];
  if (!sourceCycleId) blockers.push("snapshot-source-cycle-missing");
  if (!collectorCycleId) blockers.push("snapshot-collector-cycle-missing");
  if (sourceCycleId && collectorCycleId && collectorCycleId !== sourceCycleId) {
    blockers.push("snapshot-collector-cycle-mismatch");
  }
  if (attempts.length === 0) blockers.push("snapshot-attempts-empty");
  if (missingCycleAttempts > 0) blockers.push("endpoint-source-cycle-missing");
  if (attemptCycles.length > 1) blockers.push("mixed-endpoint-source-cycles");
  if (attemptCycles.length === 1 && sourceCycleId && attemptCycles[0] !== sourceCycleId) {
    blockers.push("endpoint-source-cycle-mismatch");
  }
  return {
    atomic: blockers.length === 0,
    sourceCycleId: sourceCycleId || null,
    collectorCycleId: collectorCycleId || null,
    attemptCycles,
    attempts: attempts.length,
    endpoints: endpoints.length,
    errors: errors.length,
    missingCycleAttempts,
    blockers
  };
};

const isCompositeSnapshot = (snapshot) => Boolean(
  snapshot?.producer?.compositeFromTrustedSnapshot
  || snapshot?.summary?.composite
  || snapshot?.summary?.lanes?.composite
);

const snapshotTrustDetails = (snapshot, options = {}) => {
  const minRows = Math.max(1, finiteNumber(options.minRows, 100));
  const minEndpoints = Math.max(1, finiteNumber(options.minEndpoints, 2));
  const entries = snapshotEntries(snapshot);
  const usable = entries.filter((entry) => (
    entry?.payload
    && entry.ok !== false
    && rowsInEndpointPayload(entry.payload) > 0
  ));
  const rows = usable.reduce((sum, entry) => sum + rowsInEndpointPayload(entry.payload), 0);
  const current = usable.filter((entry) => CURRENT_METHODS.has(endpointMethod(entry)));
  const paged = usable.filter((entry) => PAGED_METHODS.has(endpointMethod(entry)));
  const methods = Array.from(new Set(usable.map(endpointMethod).filter(Boolean)));
  const archiveCoverageComplete = REQUIRED_ARCHIVE_METHODS.every((method) => methods.includes(method));
  const schemaOk = snapshot?.version === 1 && String(snapshot?.source || "").includes("sporttery");
  const cycle = snapshotCycleDetails(snapshot);
  const usableSnapshot = schemaOk && rows > 0 && usable.length > 0;
  const fullTrusted = usableSnapshot
    && cycle.atomic
    && rows >= minRows
    && usable.length >= minEndpoints
    && paged.length > 0
    && archiveCoverageComplete;
  return {
    schemaOk,
    usable: usableSnapshot,
    fullTrusted,
    composite: isCompositeSnapshot(snapshot),
    rows,
    usableEndpoints: usable.length,
    currentRows: current.reduce((sum, entry) => sum + rowsInEndpointPayload(entry.payload), 0),
    currentUsableEndpoints: current.length,
    pagedRows: paged.reduce((sum, entry) => sum + rowsInEndpointPayload(entry.payload), 0),
    pagedUsableEndpoints: paged.length,
    archiveCoverageComplete,
    atomicCycle: cycle.atomic,
    cycle,
    requiredArchiveMethods: REQUIRED_ARCHIVE_METHODS,
    methods
  };
};

const shouldRememberTrustedSnapshot = (snapshot, options = {}) => {
  const details = snapshotTrustDetails(snapshot, options);
  return details.fullTrusted && !details.composite;
};

const atomicTempPath = (filePath) => `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;

const writeJsonAtomic = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = atomicTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

const copyFileAtomic = (sourcePath, targetPath) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = atomicTempPath(targetPath);
  try {
    fs.copyFileSync(sourcePath, tempPath);
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

const backoffMinutesForFailures = (failures, config = {}) => {
  const normalized = normalizeConfig(config);
  if (failures < normalized.failureThreshold) return 0;
  const step = Math.max(0, failures - normalized.failureThreshold);
  return Math.min(normalized.maxMinutes, normalized.baseMinutes * (2 ** Math.min(step, 20)));
};

const normalizeFullCircuit = (previous = {}, options = {}) => {
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const config = normalizeConfig(options.config);
  const stored = previous?.fullCircuit && typeof previous.fullCircuit === "object"
    ? previous.fullCircuit
    : null;

  if (previous?.version >= 2 && stored) {
    const consecutiveFullFailures = Math.max(0, finiteNumber(
      stored.consecutiveFullFailures ?? stored.consecutiveFailures,
      finiteNumber(previous.consecutiveCollectFailures, 0)
    ));
    const lastFullOkAt = stored.lastFullOkAt || previous.lastCollectOkAt || null;
    const lastFullFailedAt = stored.lastFullFailedAt || previous.lastCollectFailedAt || null;
    const nextFullProbeAt = stored.nextFullProbeAt || null;
    return {
      version: 2,
      circuitState: consecutiveFullFailures >= config.failureThreshold ? "open" : "closed",
      consecutiveFullFailures,
      lastFullAttemptAt: stored.lastFullAttemptAt || lastFullFailedAt || lastFullOkAt || null,
      lastFullOkAt,
      lastFullFailedAt,
      nextFullProbeAt: consecutiveFullFailures >= config.failureThreshold
        ? (nextFullProbeAt || isoAt(nowMs))
        : null,
      backoffMinutes: consecutiveFullFailures >= config.failureThreshold
        ? Math.max(1, finiteNumber(stored.backoffMinutes, backoffMinutesForFailures(consecutiveFullFailures, config)))
        : 0,
      lastFullFailure: stored.lastFullFailure || previous.lastFailure || null,
      lastTransitionCycleId: stored.lastTransitionCycleId || previous.lastCollectorTransitionCycleId || null,
      legacyInflatedFailureCount: stored.legacyInflatedFailureCount ?? previous.legacyInflatedFailureCount ?? null,
      migratedFromVersion: stored.migratedFromVersion ?? previous.migratedFromVersion ?? null
    };
  }

  const legacyFailures = Math.max(0, finiteNumber(previous?.consecutiveCollectFailures, 0));
  const legacyInflated = legacyFailures >= config.failureThreshold;
  const operationalFailures = legacyInflated ? config.failureThreshold : legacyFailures;
  return {
    version: 2,
    circuitState: operationalFailures >= config.failureThreshold ? "open" : "closed",
    consecutiveFullFailures: operationalFailures,
    lastFullAttemptAt: previous?.lastFullAttemptAt
      || previous?.lastCollectFailedAt
      || previous?.lastCollectOkAt
      || null,
    lastFullOkAt: previous?.lastFullOkAt || previous?.lastCollectOkAt || null,
    lastFullFailedAt: legacyFailures > 0
      ? (previous?.lastFullFailedAt || previous?.lastCollectFailedAt || null)
      : null,
    // A v1 counter may have been inflated by current-only cycles. Probe now
    // instead of inheriting a sliding cooldown from an unreliable timestamp.
    nextFullProbeAt: operationalFailures >= config.failureThreshold ? isoAt(nowMs) : null,
    backoffMinutes: operationalFailures >= config.failureThreshold
      ? backoffMinutesForFailures(operationalFailures, config)
      : 0,
    lastFullFailure: previous?.lastFullFailure || previous?.lastFailure || null,
    lastTransitionCycleId: previous?.lastCollectorTransitionCycleId || null,
    legacyInflatedFailureCount: legacyInflated ? legacyFailures : null,
    migratedFromVersion: Number(previous?.version || 1)
  };
};

const normalizeCurrentLaneState = (previous = {}) => {
  const stored = previous?.currentLaneState && typeof previous.currentLaneState === "object"
    ? previous.currentLaneState
    : {};
  return {
    version: 1,
    consecutiveFailures: Math.max(0, finiteNumber(stored.consecutiveFailures, 0)),
    lastAttemptAt: stored.lastAttemptAt || null,
    lastOkAt: stored.lastOkAt || null,
    lastFailedAt: stored.lastFailedAt || null,
    rows: Math.max(0, finiteNumber(stored.rows, 0)),
    usableEndpoints: Math.max(0, finiteNumber(stored.usableEndpoints, 0)),
    lastFailure: stored.lastFailure || null,
    lastTransitionCycleId: stored.lastTransitionCycleId || previous.lastCollectorTransitionCycleId || null
  };
};

const planFullProbe = (previous = {}, options = {}) => {
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const config = normalizeConfig(options.config);
  const fullCircuit = normalizeFullCircuit(previous, { nowMs, config });
  const failures = fullCircuit.consecutiveFullFailures;
  if (failures < config.failureThreshold) {
    const lastFullOkMs = parseTime(fullCircuit.lastFullOkAt);
    const nextScheduledFullMs = failures === 0 && Number.isFinite(lastFullOkMs)
      ? lastFullOkMs + config.fullIntervalMinutes * 60000
      : NaN;
    if (Number.isFinite(nextScheduledFullMs) && nowMs < nextScheduledFullMs) {
      return {
        active: true,
        mode: "current-only",
        reason: "healthy-full-interval",
        circuitState: "closed",
        failures,
        threshold: config.failureThreshold,
        fullIntervalMinutes: config.fullIntervalMinutes,
        lastFullOkAt: fullCircuit.lastFullOkAt,
        nextCollectAt: new Date(nextScheduledFullMs).toISOString(),
        nextScheduledFullAt: new Date(nextScheduledFullMs).toISOString(),
        fullCircuit
      };
    }
    return {
      active: false,
      mode: "full",
      reason: failures > 0 ? "retry-below-threshold" : "healthy-full-due",
      circuitState: "closed",
      failures,
      threshold: config.failureThreshold,
      fullIntervalMinutes: config.fullIntervalMinutes,
      lastFullOkAt: fullCircuit.lastFullOkAt,
      fullCircuit
    };
  }

  const nextProbeMs = parseTime(fullCircuit.nextFullProbeAt);
  const probeReady = !Number.isFinite(nextProbeMs) || nowMs >= nextProbeMs;
  return {
    active: !probeReady,
    mode: probeReady ? "half-open" : "current-only",
    reason: probeReady
      ? (fullCircuit.migratedFromVersion === 1 ? "legacy-state-immediate-probe" : "half-open-probe-ready")
      : "cooldown-active",
    circuitState: probeReady ? "half-open" : "open",
    failures,
    threshold: config.failureThreshold,
    backoffMinutes: fullCircuit.backoffMinutes,
    lastCollectFailedAt: fullCircuit.lastFullFailedAt,
    lastFullAttemptAt: fullCircuit.lastFullAttemptAt,
    lastFullOkAt: fullCircuit.lastFullOkAt,
    nextCollectAt: fullCircuit.nextFullProbeAt,
    nextFullProbeAt: fullCircuit.nextFullProbeAt,
    legacyInflatedFailureCount: fullCircuit.legacyInflatedFailureCount,
    fullCircuit
  };
};

const transitionCollectorCycle = (previous = {}, event = {}, options = {}) => {
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const now = isoAt(nowMs);
  const config = normalizeConfig(options.config);
  const cycleId = String(event.cycleId || "").trim() || `cycle-${now}`;
  const fullCircuit = normalizeFullCircuit(previous, { nowMs, config });
  const currentLaneState = normalizeCurrentLaneState(previous);
  const duplicate = fullCircuit.lastTransitionCycleId === cycleId
    || previous?.lastCollectorTransitionCycleId === cycleId;

  if (!duplicate && event.fullAttempted) {
    fullCircuit.lastFullAttemptAt = event.fullAttemptAt || now;
    fullCircuit.lastTransitionCycleId = cycleId;
    if (event.fullOk) {
      fullCircuit.circuitState = "closed";
      fullCircuit.consecutiveFullFailures = 0;
      fullCircuit.lastFullOkAt = event.fullOkAt || now;
      fullCircuit.lastFullFailedAt = null;
      fullCircuit.nextFullProbeAt = null;
      fullCircuit.backoffMinutes = 0;
      fullCircuit.lastFullFailure = null;
    } else {
      const failures = fullCircuit.consecutiveFullFailures + 1;
      const backoffMinutes = backoffMinutesForFailures(failures, config);
      fullCircuit.consecutiveFullFailures = failures;
      fullCircuit.lastFullFailedAt = event.fullFailedAt || now;
      fullCircuit.lastFullFailure = event.fullFailure || fullCircuit.lastFullFailure || null;
      fullCircuit.backoffMinutes = backoffMinutes;
      if (failures >= config.failureThreshold) {
        fullCircuit.circuitState = "open";
        fullCircuit.nextFullProbeAt = isoAt(nowMs + backoffMinutes * 60000);
      } else {
        fullCircuit.circuitState = "closed";
        fullCircuit.nextFullProbeAt = null;
      }
    }
  }

  if (!duplicate && event.currentAttempted) {
    currentLaneState.lastAttemptAt = event.currentAttemptAt || now;
    currentLaneState.lastTransitionCycleId = cycleId;
    currentLaneState.rows = Math.max(0, finiteNumber(event.currentRows, currentLaneState.rows));
    currentLaneState.usableEndpoints = Math.max(0, finiteNumber(
      event.currentUsableEndpoints,
      currentLaneState.usableEndpoints
    ));
    if (event.currentOk) {
      currentLaneState.consecutiveFailures = 0;
      currentLaneState.lastOkAt = event.currentOkAt || now;
      currentLaneState.lastFailedAt = null;
      currentLaneState.lastFailure = null;
    } else {
      currentLaneState.consecutiveFailures += 1;
      currentLaneState.lastFailedAt = event.currentFailedAt || now;
      currentLaneState.lastFailure = event.currentFailure || currentLaneState.lastFailure || null;
    }
  }

  const transitionApplied = !duplicate && Boolean(event.fullAttempted || event.currentAttempted);
  return {
    transitionApplied,
    duplicate,
    cycleId,
    fullCircuit,
    currentLaneState,
    compatibility: {
      consecutiveCollectFailures: fullCircuit.consecutiveFullFailures,
      lastCollectOkAt: fullCircuit.lastFullOkAt,
      lastCollectFailedAt: fullCircuit.lastFullFailedAt,
      lastFailure: fullCircuit.lastFullFailure
    }
  };
};

module.exports = {
  CURRENT_METHODS,
  PAGED_METHODS,
  REQUIRED_ARCHIVE_METHODS,
  normalizeConfig,
  snapshotTrustDetails,
  snapshotCycleDetails,
  isCompositeSnapshot,
  shouldRememberTrustedSnapshot,
  writeJsonAtomic,
  copyFileAtomic,
  backoffMinutesForFailures,
  normalizeFullCircuit,
  planFullProbe,
  transitionCollectorCycle
};
