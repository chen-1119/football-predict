"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  FAST_RESULT_PUBLISHER_MACHINE_ENV,
  parseFastResultPublisherOutput,
} = require("../scripts/fastResultPublisherProtocol.cjs");
const {
  resultFingerprint,
  resultObservationRows,
  resultPageOneEndpoint,
  rowsInRelayPayload,
  stableStringify,
} = require("../scripts/sportteryFastResultLane.cjs");
const {
  auditTrustedFastResultEndpoints,
  relayEntries,
  relayMethod,
  summarizeTrustedMarketCollectorEvidence,
} = require("./relayCollectorEvidence.cjs");
const { boundedRuntimeEnv, boundedRuntimeNumber } = require("../scripts/boundedRuntimeNumber.cjs");

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const RESULT_SEMANTIC_FINGERPRINT_VERSION = "relay-result-semantic-fingerprint-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RETRYABLE_PUBLISHER_SKIP_REASONS = new Set([
  "sqlite-database-missing",
  "sqlite-schema-unavailable",
  "trusted-result-probe-clock-in-future",
  "trusted-result-probe-clock-unavailable",
  "trusted-relay-snapshot-unavailable",
  "trusted-fast-result-endpoints-unavailable",
  "fast-result-receipt-invalid",
  "fast-result-revision-invalid",
  "authority-high-water-invalid",
  "authority-high-water-uninitialized",
  "authority-high-water-event-missing",
  "authority-high-water-overflow",
  "authority-high-water-identity-conflict",
  "authority-high-water-score-conflict",
]);

const optionNowMs = (options) => {
  const value = typeof options?.nowMs === "function" ? options.nowMs() : options?.nowMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const isoNow = () => new Date().toISOString();

const relaySnapshotFingerprint = (filePath) => {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) return null;
    return [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].map(String).join(":");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const validateRelayFastResultStructure = (snapshot) => {
  try {
    const entries = relayEntries(snapshot);
    const resultEndpoint = resultPageOneEndpoint(snapshot);
    const declaredFingerprint = String(snapshot?.producer?.resultFingerprint || "").trim().toLowerCase();
    const computedFingerprint = resultEndpoint ? resultFingerprint(resultEndpoint) : null;
    const endpointDetails = entries.map((entry) => {
      const method = relayMethod(entry);
      const rawPage = entry?.page;
      const page = rawPage === null || rawPage === undefined || rawPage === ""
        ? null
        : Number(rawPage);
      return {
        entry,
        method,
        page: Number.isFinite(page) ? page : rawPage,
        key: `${method}:${page === null ? "none" : page}`,
      };
    });
    const methods = new Set(endpointDetails.map((detail) => detail.method).filter(Boolean));
    const actualMethods = [...methods].sort();
    const declaredMethods = Array.isArray(snapshot?.summary?.methods)
      ? [...new Set(snapshot.summary.methods.map((method) => String(method || "").trim().toLowerCase()).filter(Boolean))].sort()
      : [];
    const usableEntries = entries.filter((entry) => (
      entry?.ok !== false
      && entry?.payload
      && rowsInRelayPayload(entry.payload) > 0
    ));
    const resultRows = resultEndpoint ? rowsInRelayPayload(resultEndpoint.payload) : 0;
    const collectionErrors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
    const endpointKeysUnique = new Set(endpointDetails.map((detail) => detail.key)).size === endpointDetails.length;
    const allowedEndpoints = endpointDetails.every((detail) => (
      (["current", "calculator"].includes(detail.method) && detail.page === null)
      || (detail.method === "result" && detail.page === 1)
    ));
    const constituentRolesConsistent = endpointDetails.every(({ entry, method }) => (
      entry?.fastResultConstituent?.provenancePreserved === true
      && entry?.fastResultConstituent?.role === (method === "result" ? "probe" : "companion")
    ));
    const resultEndpointCount = endpointDetails.filter((detail) => detail.method === "result").length;
    const structureConsistent = Boolean(
      snapshot?.version === 1
      && String(snapshot?.source || "").includes("sporttery")
      && snapshot?.sourceCycleKind === "upload-merge"
      && snapshot?.producer?.fastResultLane === true
      && snapshot?.summary?.fastResultLane === true
      && resultEndpoint
      && resultEndpoint?.fastResultConstituent?.role === "probe"
      && resultEndpoint?.fastResultConstituent?.provenancePreserved === true
      && entries.length === usableEntries.length
      && allowedEndpoints
      && constituentRolesConsistent
      && endpointKeysUnique
      && resultEndpointCount === 1
      && methods.has("result")
      && (methods.has("current") || methods.has("calculator"))
      && stableStringify(declaredMethods) === stableStringify(actualMethods)
      && Number(snapshot?.summary?.endpoints) === entries.length
      && Number(snapshot?.summary?.usableEndpoints) === usableEntries.length
      && Number(snapshot?.summary?.rows) === usableEntries.reduce(
        (sum, entry) => sum + rowsInRelayPayload(entry.payload),
        0,
      )
      && Number(snapshot?.summary?.resultRows) === resultRows
      && collectionErrors.length === 0
      && Number(snapshot?.summary?.errors) === collectionErrors.length
      && SHA256_PATTERN.test(declaredFingerprint)
      && computedFingerprint === declaredFingerprint
    );
    return {
      eligible: structureConsistent,
      entries,
      resultEndpoint,
      endpointDetails,
      usableEntries,
      declaredFingerprint,
      computedFingerprint,
      blocker: structureConsistent ? null : "relay-fast-structure-invalid",
    };
  } catch (error) {
    return {
      eligible: false,
      entries: [],
      resultEndpoint: null,
      endpointDetails: [],
      usableEntries: [],
      declaredFingerprint: null,
      computedFingerprint: null,
      blocker: "relay-fast-structure-invalid",
      error: String(error?.message || error),
    };
  }
};

const auditRelayFastResultEligibility = (snapshot, options = {}) => {
  const structure = validateRelayFastResultStructure(snapshot);
  if (!structure.eligible) {
    return {
      eligible: false,
      blocker: structure.blocker,
      structure,
      endpointTrust: null,
      marketAudit: null,
    };
  }
  const endpointTrust = auditTrustedFastResultEndpoints(snapshot, {
    trustRegistry: options.trustRegistry,
    allowAdditionalEndpoints: false,
    requireMarketLane: true,
  });
  if (!endpointTrust.eligible) {
    return {
      eligible: false,
      blocker: "relay-fast-endpoint-trust-invalid",
      structure,
      endpointTrust,
      marketAudit: null,
    };
  }

  const nowMs = optionNowMs(options);
  const defaultFutureSkewMs = boundedRuntimeEnv(
    process.env,
    "TRUSTED_MAX_FUTURE_SKEW_SECONDS",
    { fallback: 300, min: 0, max: 3600 },
  ) * 1000;
  const defaultMaxAgeMs = boundedRuntimeEnv(
    process.env,
    ["SPORTTERY_RELAY_MAX_AGE_MINUTES", "SOURCE_MAX_AGE_MINUTES"],
    { fallback: 20, min: 1, max: 30 * 24 * 60 },
  ) * 60_000;
  const maxFutureSkewMs = boundedRuntimeNumber(options.maxFutureSkewMs, {
    fallback: defaultFutureSkewMs, min: 0, max: 3_600_000,
  });
  const maxAgeMs = boundedRuntimeNumber(options.maxAgeMs, {
    fallback: defaultMaxAgeMs, min: 60_000, max: 30 * 24 * 60 * 60_000,
  });
  const capturedMs = Date.parse(snapshot?.capturedAt || "");
  if (
    !Number.isFinite(capturedMs)
    || capturedMs > nowMs + maxFutureSkewMs
    || nowMs - capturedMs > maxAgeMs
  ) {
    return {
      eligible: false,
      blocker: "relay-fast-envelope-clock-invalid",
      structure,
      endpointTrust,
      marketAudit: null,
    };
  }
  for (let index = 0; index < endpointTrust.details.length; index += 1) {
    const detail = endpointTrust.details[index];
    const receivedMs = Date.parse(
      endpointTrust.audits[index]?.attestation?.commitment?.receivedAt || "",
    );
    if (!Number.isFinite(receivedMs) || receivedMs > nowMs + maxFutureSkewMs) {
      return {
        eligible: false,
        blocker: "relay-fast-endpoint-clock-invalid",
        structure,
        endpointTrust,
        marketAudit: null,
      };
    }
    if (["current", "calculator"].includes(detail.method) && nowMs - receivedMs > maxAgeMs) {
      return {
        eligible: false,
        blocker: "relay-fast-market-clock-stale",
        structure,
        endpointTrust,
        marketAudit: null,
      };
    }
  }

  const marketAudit = summarizeTrustedMarketCollectorEvidence(snapshot, {
    trustRegistry: options.trustRegistry,
  });
  if (
    Number(marketAudit.trustedEndpoints || 0) < 1
    || Number(marketAudit.trustedCollectorCount || 0) < 1
  ) {
    return {
      eligible: false,
      blocker: "relay-fast-market-collector-untrusted",
      structure,
      endpointTrust,
      marketAudit,
    };
  }
  return {
    eligible: true,
    blocker: null,
    structure,
    endpointTrust,
    marketAudit,
    nowMs,
    maxFutureSkewMs,
    maxAgeMs,
  };
};

const relayResultSemanticFingerprint = (snapshot, options = {}) => {
  try {
    const eligibility = auditRelayFastResultEligibility(snapshot, options);
    if (!eligibility.eligible) return null;
    const { endpointTrust } = eligibility;

    // Only the verified result:1 probe can produce settlement candidates.
    // Companion current/calculator rows and clocks are structural evidence,
    // never outcome authority, so they remain outside the semantic digest.
    const officialResultProjection = resultObservationRows(endpointTrust.resultEndpoint);
    const semanticDigest = crypto.createHash("sha256")
      .update(stableStringify({
        officialResultProjection,
        // Only the verified result probe owns correction chronology. Current
        // and calculator heartbeat clocks stay outside this digest.
        resultProbeRevision: endpointTrust.resultProbeRevision,
      }))
      .digest("hex");
    return `${RESULT_SEMANTIC_FINGERPRINT_VERSION}:${semanticDigest}`;
  } catch {
    return null;
  }
};

const createRelayResultSemanticFingerprintReader = (filePath, options = {}) => {
  let cachedFileFingerprint = null;
  let cachedResultFingerprint = null;
  return () => {
    const before = relaySnapshotFingerprint(filePath);
    if (!before) {
      cachedFileFingerprint = null;
      cachedResultFingerprint = null;
      return null;
    }
    if (
      before === cachedFileFingerprint
      && String(cachedResultFingerprint || "")
        .startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
    ) return cachedResultFingerprint;

    let semanticFingerprint = null;
    try {
      const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
      semanticFingerprint = relayResultSemanticFingerprint(snapshot, options);
    } catch {
      semanticFingerprint = null;
    }
    const after = relaySnapshotFingerprint(filePath);
    if (!after) {
      cachedFileFingerprint = null;
      cachedResultFingerprint = null;
      return null;
    }
    if (after !== before) {
      // The atomic relay file moved while it was being parsed. Return the new
      // full identity so the watcher runs fail-closed and parses it next poll.
      cachedFileFingerprint = null;
      cachedResultFingerprint = null;
      return after;
    }
    cachedFileFingerprint = after;
    cachedResultFingerprint = semanticFingerprint || after;
    return cachedResultFingerprint;
  };
};

const compactError = (error) => ({
  at: isoNow(),
  code: error?.code || null,
  message: String(error?.message || error || "unknown relay watcher error").slice(0, 500),
});

const retryablePublisherSkip = (result) => Boolean(
  result?.skipped === true
  && RETRYABLE_PUBLISHER_SKIP_REASONS.has(String(result?.reason || ""))
);

const normalizeTerminationGraceMs = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TERMINATION_GRACE_MS;
  return Math.min(MAX_TERMINATION_GRACE_MS, Math.max(25, Math.floor(parsed)));
};

const runFastPublisherChild = ({
  publisherPath,
  cwd,
  env,
  timeoutMs,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  spawnImpl = spawn,
  signal,
}) => new Promise((resolve, reject) => {
  const safeTerminationGraceMs = normalizeTerminationGraceMs(terminationGraceMs);
  const child = spawnImpl(process.execPath, [publisherPath], {
    cwd,
    env: {
      ...(env || process.env),
      [FAST_RESULT_PUBLISHER_MACHINE_ENV]: "1",
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let closed = false;
  let timeout = null;
  let terminationGraceTimeout = null;
  let terminalError = null;
  let terminationRequested = false;
  let abortListener = null;
  const clearLifecycleTimers = () => {
    clearTimeout(timeout);
    timeout = null;
    clearTimeout(terminationGraceTimeout);
    terminationGraceTimeout = null;
  };
  const detachAbortListener = () => {
    if (abortListener) signal?.removeEventListener?.("abort", abortListener);
    abortListener = null;
  };
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearLifecycleTimers();
    detachAbortListener();
    fn(value);
  };
  const requestTermination = (error) => {
    if (!terminalError) terminalError = error;
    if (terminationRequested || closed) return;
    terminationRequested = true;
    clearTimeout(timeout);
    timeout = null;

    // A watcher run is not complete merely because SIGTERM was sent. Keep the
    // caller (and therefore its writer permit) pending until the child emits
    // close. Escalate after a bounded grace period when the publisher ignores
    // the cooperative signal.
    try {
      child.kill("SIGTERM");
    } catch (killError) {
      terminalError.terminationSignalError = String(killError?.message || killError);
    }
    if (closed) return;
    terminationGraceTimeout = setTimeout(() => {
      terminationGraceTimeout = null;
      if (closed) return;
      try {
        child.kill("SIGKILL");
      } catch (killError) {
        terminalError.killSignalError = String(killError?.message || killError);
      }
      // Deliberately do not settle here. If the OS cannot confirm close, the
      // run permit remains held fail-closed instead of allowing an overlapping
      // SQLite publisher to start.
    }, safeTerminationGraceMs);
    terminationGraceTimeout.unref?.();
  };
  const appendBounded = (current, chunk, streamName) => {
    if (terminalError) return current;
    const next = current + String(chunk || "");
    if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
      const error = new Error(`fast result publisher ${streamName} exceeded ${maxOutputBytes} bytes`);
      error.code = "PUBLISHER_OUTPUT_LIMIT";
      requestTermination(error);
      return current;
    }
    return next;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, "stdout"); });
  child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, "stderr"); });
  child.on("error", (error) => {
    if (settled) return;
    // A spawn failure has no live process to reap. Any error after a PID was
    // assigned is treated as a terminal child failure and still waits for the
    // close event before the publisher promise can settle.
    if (!child.pid) return finish(reject, error);
    requestTermination(error);
  });
  child.once("close", (code, signal) => {
    closed = true;
    clearLifecycleTimers();
    if (settled) return;
    if (terminalError) return finish(reject, terminalError);
    if (code !== 0) {
      const error = new Error(
        `fast result publisher exited ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${stderr.trim().slice(-500)}`
      );
      error.code = "PUBLISHER_EXIT_FAILED";
      return finish(reject, error);
    }
    try {
      const result = parseFastResultPublisherOutput(stdout);
      return finish(resolve, result);
    } catch (error) {
      if (!error.code) error.code = "PUBLISHER_OUTPUT_INVALID";
      return finish(reject, error);
    }
  });
  timeout = setTimeout(() => {
    const error = new Error(`fast result publisher timed out after ${timeoutMs}ms`);
    error.code = "PUBLISHER_TIMEOUT";
    requestTermination(error);
  }, timeoutMs);
  timeout.unref?.();
  if (signal) {
    abortListener = () => {
      const error = new Error("fast result publisher aborted");
      error.code = "ABORT_ERR";
      requestTermination(error);
    };
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }
});

const createRelayFastResultWatcher = ({
  enabled,
  relaySnapshotPath,
  publisherPath,
  cwd,
  env = process.env,
  pollMs = 1000,
  timeoutMs = 8000,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  readFingerprint = null,
  fingerprintTrustRegistry = null,
  runPublisher,
  acquireRunPermit,
  onPublished = async () => {},
  logger = console,
}) => {
  const safePollMs = Math.max(250, Number(pollMs || 1000));
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs || 8000));
  const safeTerminationGraceMs = normalizeTerminationGraceMs(terminationGraceMs);
  const defaultSemanticFingerprintReader = typeof readFingerprint !== "function";
  const readCurrentFingerprint = readFingerprint || createRelayResultSemanticFingerprintReader(
    relaySnapshotPath,
    { trustRegistry: fingerprintTrustRegistry },
  );
  const publish = runPublisher || (({ signal }) => runFastPublisherChild({
    publisherPath,
    cwd,
    env: {
      ...(env || process.env),
      // The child must consume the exact file whose semantic fingerprint
      // triggered this run. Override both legacy aliases so a conflicting host
      // environment cannot redirect validation or enable fallback to another
      // fast-lane candidate.
      SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: relaySnapshotPath,
      SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH: relaySnapshotPath,
    },
    timeoutMs: safeTimeoutMs,
    terminationGraceMs: safeTerminationGraceMs,
    maxOutputBytes,
    signal,
  }));
  const state = {
    enabled: Boolean(enabled),
    pollMs: safePollMs,
    timeoutMs: safeTimeoutMs,
    terminationGraceMs: safeTerminationGraceMs,
    fingerprintPolicy: defaultSemanticFingerprintReader
      ? RESULT_SEMANTIC_FINGERPRINT_VERSION
      : "injected-fingerprint-reader",
    running: false,
    pending: false,
    stopped: false,
    observedFingerprint: null,
    completedFingerprint: null,
    queuedFingerprint: null,
    lastCheckedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastPublishedAt: null,
    lastLatencyMs: null,
    lastPublishedRows: 0,
    lastError: null,
    checks: 0,
    runs: 0,
    coalesced: 0,
    deferred: 0,
    lastDeferredAt: null,
    lastDeferredReason: null,
    retryNotBefore: 0,
  };
  let activePromise = null;
  let activeAbortController = null;

  const health = () => ({
    enabled: state.enabled,
    pollMs: state.pollMs,
    timeoutMs: state.timeoutMs,
    terminationGraceMs: state.terminationGraceMs,
    fingerprintPolicy: state.fingerprintPolicy,
    resultSemanticFingerprintActive: String(state.observedFingerprint || "")
      .startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`),
    completedResultSemanticFingerprint: String(state.completedFingerprint || "")
      .startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`),
    running: state.running,
    pending: state.pending,
    lastCheckedAt: state.lastCheckedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastPublishedAt: state.lastPublishedAt,
    lastLatencyMs: state.lastLatencyMs,
    lastPublishedRows: state.lastPublishedRows,
    lastError: state.lastError,
    checks: state.checks,
    runs: state.runs,
    coalesced: state.coalesced,
    deferred: state.deferred,
    lastDeferredAt: state.lastDeferredAt,
    lastDeferredReason: state.lastDeferredReason,
  });

  const drain = async () => {
    if (!state.enabled || state.stopped || state.running || !state.pending) return null;
    if (Date.now() < state.retryNotBefore) return null;
    const token = state.queuedFingerprint;
    if (!token) return null;
    state.pending = false;
    state.running = true;
    const startedMs = Date.now();
    const abortController = new AbortController();
    activeAbortController = abortController;
    let runPermit = null;
    try {
      if (typeof acquireRunPermit === "function") {
        runPermit = await acquireRunPermit({ fingerprint: token, signal: abortController.signal });
        if (!runPermit?.acquired) {
          state.pending = true;
          state.queuedFingerprint = token;
          state.deferred += 1;
          state.lastDeferredAt = isoNow();
          state.lastDeferredReason = String(runPermit?.reason || "run permit unavailable");
          state.retryNotBefore = Date.now() + Math.min(5000, Math.max(500, safePollMs * 2));
          return null;
        }
      }
      state.lastAttemptAt = isoNow();
      state.runs += 1;
      const result = await publish({ fingerprint: token, signal: abortController.signal });
      if (!result || result.ok !== true) {
        const error = new Error(result?.error || "fast result publisher returned a failed result");
        error.code = result?.errorCode || "PUBLISHER_RESULT_FAILED";
        throw error;
      }
      if (retryablePublisherSkip(result)) {
        const error = new Error(`fast result publisher deferred: ${result.reason}`);
        error.code = "PUBLISHER_RETRYABLE_SKIP";
        throw error;
      }
      state.completedFingerprint = token;
      state.lastSuccessAt = isoNow();
      state.lastLatencyMs = Math.max(0, Date.now() - startedMs);
      state.lastError = null;
      state.lastDeferredReason = null;
      state.retryNotBefore = 0;
      const visibleStateChanged = result.skipped !== true && (
        Number(result.publishedRows || 0) > 0 || result.visibleStateChanged === true
      );
      if (visibleStateChanged) {
        state.lastPublishedAt = result.publishedAt || result.finishedAt || state.lastSuccessAt;
        state.lastPublishedRows = Number(result.publishedRows || 0);
        await onPublished(result, health());
      }
      return result;
    } catch (error) {
      state.lastLatencyMs = Math.max(0, Date.now() - startedMs);
      state.lastError = compactError(error);
      if (state.stopped) {
        state.pending = false;
        state.retryNotBefore = 0;
      } else if (state.queuedFingerprint && state.queuedFingerprint !== token) {
        // A newer relay version arrived while this child was running. Preserve
        // the latest token and drain it immediately; retrying the older token
        // would both add latency and risk dropping the coalesced update.
        state.pending = true;
        state.retryNotBefore = 0;
      } else {
        state.pending = true;
        state.queuedFingerprint = token;
        state.retryNotBefore = Date.now() + Math.min(5000, Math.max(500, safePollMs * 2));
      }
      if (!state.stopped) logger.warn?.("[football-server] relay fast result watcher failed", state.lastError);
      return null;
    } finally {
      try {
        await runPermit?.release?.();
      } catch (error) {
        state.lastError = compactError(error);
        if (!state.stopped) logger.warn?.("[football-server] relay fast result watcher permit release failed", state.lastError);
      }
      state.running = false;
      activePromise = null;
      if (activeAbortController === abortController) activeAbortController = null;
      if (
        state.pending
        && !state.stopped
        && state.queuedFingerprint !== token
        && Date.now() >= state.retryNotBefore
      ) {
        activePromise = drain();
      }
    }
  };

  const check = async ({ force = false } = {}) => {
    if (!state.enabled || state.stopped) return null;
    state.lastCheckedAt = isoNow();
    state.checks += 1;
    let fingerprint;
    try {
      fingerprint = await readCurrentFingerprint();
    } catch (error) {
      state.lastError = compactError(error);
      return null;
    }
    if (!fingerprint) return null;
    const changed = fingerprint !== state.observedFingerprint;
    if (changed || force) {
      if (state.running && state.pending && state.queuedFingerprint !== fingerprint) state.coalesced += 1;
      state.observedFingerprint = fingerprint;
      state.queuedFingerprint = fingerprint;
      state.pending = fingerprint !== state.completedFingerprint || force;
    }
    if (!state.pending || state.running || Date.now() < state.retryNotBefore) return activePromise;
    activePromise = drain();
    return activePromise;
  };

  const stop = async () => {
    state.stopped = true;
    state.pending = false;
    const running = activePromise;
    activeAbortController?.abort();
    if (running) await running;
  };

  return { check, health, stop };
};

module.exports = {
  DEFAULT_TERMINATION_GRACE_MS,
  RESULT_SEMANTIC_FINGERPRINT_VERSION,
  createRelayFastResultWatcher,
  createRelayResultSemanticFingerprintReader,
  auditRelayFastResultEligibility,
  relayResultSemanticFingerprint,
  relaySnapshotFingerprint,
  retryablePublisherSkip,
  runFastPublisherChild,
  validateRelayFastResultStructure,
};
