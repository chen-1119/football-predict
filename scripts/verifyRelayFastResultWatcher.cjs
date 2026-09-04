"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { DatabaseSync } = require("node:sqlite");
const {
  RESULT_SEMANTIC_FINGERPRINT_VERSION,
  createRelayFastResultWatcher,
  createRelayResultSemanticFingerprintReader,
  relayResultSemanticFingerprint,
  relaySnapshotFingerprint,
  retryablePublisherSkip,
  runFastPublisherChild,
} = require("../server/relayFastResultWatcher.cjs");
const {
  buildCollectorCommitment,
  createCollectorKeyPair,
  signCollectorCommitment,
} = require("../src/services/collectorAttestation.cjs");
const { resultFingerprint } = require("./sportteryFastResultLane.cjs");
const {
  SPORTTERY_CALCULATOR_URL,
  SPORTTERY_CURRENT_URL,
  SPORTTERY_RESULT_URL,
} = require("./sportteryEndpointContract.cjs");
const {
  FAST_RESULT_PUBLISHER_PROTOCOL,
  encodeFastResultPublisherOutput,
  parseFastResultPublisherOutput,
} = require("./fastResultPublisherProtocol.cjs");

const rootDir = path.resolve(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok: Boolean(ok), ...details });
const SEMANTIC_RESULT_OBSERVED_AT = new Date().toISOString();

const isolatedRelayChildEnv = ({
  baseEnv = process.env,
  caseDir,
  relaySnapshotPath,
  fastLaneSnapshotPath = path.join(caseDir, "isolated-fast-lane.json"),
  dbPath,
}) => ({
  ...baseEnv,
  // Every real publisher child below owns only its temporary SQLite fixture.
  // Do not inherit the host's PostgreSQL-primary mode during post-swap
  // production readiness.
  FOOTBALL_POSTGRES_MODE: "disabled",
  SERVER_STORE_DIR: caseDir,
  DATA_STORE_DIR: caseDir,
  DATASTORE_SQLITE_PATH: dbPath,
  SYNC_META_PATH: path.join(caseDir, "sync-meta.json"),
  RECOMMENDATION_PUBLICATION_LEDGER_PATH: path.join(caseDir, "publication-ledger.json"),
  SPORTTERY_RELAY_MODE: "prefer",
  SPORTTERY_RELAY_ALLOW_STALE: "0",
  SPORTTERY_RELAY_MAX_AGE_MINUTES: "1",
  SOURCE_MAX_AGE_MINUTES: "1",
  SPORTTERY_RELAY_SNAPSHOT: relaySnapshotPath,
  SPORTTERY_RELAY_SNAPSHOT_PATH: relaySnapshotPath,
  // Production readiness inherits the host runtime environment. Isolate both
  // relay lanes so a valid production fast lane cannot replace an intentionally
  // stale/empty/broken full-lane fixture and redirect the child into its empty
  // SQLite fixture. This is test isolation, not a relaxation of publisher gates.
  SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: fastLaneSnapshotPath,
  SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH: fastLaneSnapshotPath,
});

const rawRelayMatch = ({ matchId, status = "0", score = null }) => ({
  matchId,
  businessDate: "2026-07-16",
  matchDate: "2026-07-16",
  matchTime: "10:00:00",
  matchStatus: status,
  matchStatusName: status === "11" ? "Finished" : "Selling",
  matchNumStr: "周四001",
  homeTeamAllName: "测试主队",
  awayTeamAllName: "测试客队",
  homeTeamId: "watcher-home",
  awayTeamId: "watcher-away",
  leagueAllName: "测试联赛",
  ...(score ? { sectionsNo999: score } : {}),
});

const freshFastLaneSnapshot = () => {
  const capturedAt = new Date().toISOString();
  const endpoint = ({ method, page = 1, match }) => ({
    id: `method:${method}:${page}`,
    method,
    page,
    ok: true,
    fetchedAt: capturedAt,
    receivedAt: capturedAt,
    url: `https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=${method}`,
    payload: {
      value: {
        matchInfoList: [{
          businessDate: "2026-07-16",
          subMatchList: [match],
        }],
      },
    },
  });
  return {
    version: 1,
    source: "sporttery-fast-result-lane",
    capturedAt,
    sourceCycleId: `watcher-fixture-${Date.now()}`,
    endpoints: [
      endpoint({ method: "current", match: rawRelayMatch({ matchId: "watcher-current" }) }),
      endpoint({ method: "calculator", match: rawRelayMatch({ matchId: "watcher-calculator" }) }),
      endpoint({ method: "result", match: rawRelayMatch({ matchId: "watcher-finished", status: "11", score: "2:1" }) }),
    ],
  };
};

const signedRelayEndpoint = ({
  method,
  match,
  keyPair,
  sourceCycleId,
  observedAt,
}) => {
  const url = {
    current: SPORTTERY_CURRENT_URL,
    calculator: SPORTTERY_CALCULATOR_URL,
    result: SPORTTERY_RESULT_URL,
  }[method];
  const page = method === "result" ? 1 : null;
  const collectorRole = method === "result" ? "method:result" : method;
  const payload = {
    value: {
      matchInfoList: [{
        businessDate: "2026-07-16",
        subMatchList: [match],
      }],
    },
  };
  const endpoint = {
    id: method === "result" ? `method:${method}:${page}` : method,
    method,
    page,
    ok: true,
    url,
    fetchedAt: observedAt,
    requestedAt: observedAt,
    receivedAt: observedAt,
    sourceCycleId,
    sourceRequest: { url, method: "GET", page, role: collectorRole },
    collectorRole,
    payload,
    fastResultConstituent: {
      role: method === "result" ? "probe" : "companion",
      sourceCycleIds: [sourceCycleId],
      sourceCycleId,
      mixedSourceCycles: false,
      provenancePreserved: true,
    },
  };
  const commitment = buildCollectorCommitment({
    provider: "sporttery",
    endpoint: { url, method: "GET", page, role: collectorRole },
    collectorCycleId: sourceCycleId,
    requestedAt: observedAt,
    receivedAt: observedAt,
    providerObservedAt: null,
    response: {},
    payload,
  });
  const collectorAttestation = signCollectorCommitment(commitment, keyPair);
  endpoint.canonicalPayloadSha256 = commitment.canonicalPayloadSha256;
  endpoint.collectorAttestation = collectorAttestation;
  endpoint.collectorProvenance = {
    sourceCycleId,
    requestedAt: observedAt,
    receivedAt: observedAt,
    sourceRequest: endpoint.sourceRequest,
    canonicalPayloadSha256: commitment.canonicalPayloadSha256,
    collectorAttestation,
  };
  return endpoint;
};

const signedFastLaneSnapshot = ({
  keyPair,
  currentMarker,
  currentStatus = "0",
  currentScore = null,
  currentOverrides = {},
  resultStatus = "11",
  resultScore = "2:1",
  resultOverrides = {},
  resultObservedAt = SEMANTIC_RESULT_OBSERVED_AT,
  resultSourceCycleId = null,
  padding = "",
}) => {
  const observedAt = new Date().toISOString();
  const cyclePrefix = `semantic-${currentMarker}-${Date.now()}`;
  const resultCycleId = resultSourceCycleId || `semantic-result-${crypto.createHash("sha256")
    .update(JSON.stringify({ resultStatus, resultScore, resultOverrides }))
    .digest("hex")
    .slice(0, 20)}`;
  const current = signedRelayEndpoint({
    method: "current",
    match: {
      matchId: "semantic-current",
      matchStatus: currentStatus,
      ...(currentScore ? { sectionsNo999: currentScore } : {}),
      currentMarker,
      ...currentOverrides,
    },
    keyPair,
    sourceCycleId: `${cyclePrefix}-current`,
    observedAt,
  });
  const calculator = signedRelayEndpoint({
    method: "calculator",
    match: { matchId: "semantic-calculator", currentMarker },
    keyPair,
    sourceCycleId: `${cyclePrefix}-calculator`,
    observedAt,
  });
  const result = signedRelayEndpoint({
    method: "result",
    match: {
      matchId: "semantic-result",
      matchNum: 201,
      matchStatus: resultStatus,
      sectionsNo999: resultScore,
      ...resultOverrides,
    },
    keyPair,
    sourceCycleId: resultCycleId,
    observedAt: resultObservedAt,
  });
  const endpoints = [calculator, current, result];
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt: observedAt,
    sourceCycleId: `${cyclePrefix}-merge`,
    sourceCycleKind: "upload-merge",
    uploadCycleId: `${cyclePrefix}-merge`,
    mergeCycleId: `${cyclePrefix}-merge`,
    producer: {
      fastResultLane: true,
      resultFingerprint: resultFingerprint(result),
    },
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.length,
      resultRows: 1,
      errors: 0,
      methods: ["calculator", "current", "result"],
      fastResultLane: true,
    },
    endpoints,
    errors: [],
    padding,
  };
};

const run = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-relay-fast-watcher-"));
  try {
    const relayPath = path.join(tempDir, "relay.json");
    fs.writeFileSync(relayPath, JSON.stringify({ revision: "a" }));
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const calls = [];
    const published = [];
    const watcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      runPublisher: async ({ fingerprint }) => {
        calls.push({ fingerprint, at: Date.now() });
        if (calls.length === 1) {
          await firstBlocked;
          return { ok: true, skipped: true, publishedRows: 0, finishedAt: new Date().toISOString() };
        }
        return {
          ok: true,
          skipped: false,
          publishedRows: 1,
          phase: "official-result-fast-published",
          finishedAt: new Date().toISOString(),
        };
      },
      onPublished: async (result) => { published.push(result); },
      logger: { warn: () => {} },
    });

    const startedAt = Date.now();
    const firstRun = watcher.check({ force: true });
    await wait(10);
    fs.writeFileSync(relayPath, JSON.stringify({ revision: "b", padding: "1" }));
    void watcher.check();
    await wait(10);
    fs.writeFileSync(relayPath, JSON.stringify({ revision: "c", padding: "22" }));
    void watcher.check();
    await wait(10);
    assert.equal(calls.length, 1, "single-flight must keep only one active publisher");
    releaseFirst();
    await firstRun;
    for (let index = 0; index < 20 && calls.length < 2; index += 1) await wait(10);
    for (let index = 0; index < 20 && published.length < 1; index += 1) await wait(10);
    const state = watcher.health();
    check("changes during an active long task coalesce into one immediate rerun", (
      calls.length === 2
      && calls[0].fingerprint !== calls[1].fingerprint
      && state.coalesced >= 1
    ), { runs: calls.length, coalesced: state.coalesced });
    check("fast watcher publishes independently within the ten-second objective", (
      published.length === 1 && Date.now() - startedAt < 10_000
    ), { elapsedMs: Date.now() - startedAt, published: published.length });
    check("visible publication updates watcher health", (
      state.lastPublishedRows === 1
      && Boolean(state.lastPublishedAt)
      && Boolean(state.lastCheckedAt)
      && Number.isFinite(state.lastLatencyMs)
      && state.lastError === null
    ), state);

    await watcher.check();
    await wait(20);
    check("unchanged fingerprint is idempotent", calls.length === 2, { runs: calls.length });
    watcher.stop();

    fs.writeFileSync(relayPath, JSON.stringify({ revision: "failure-a" }));
    let rejectFailedRun;
    const failedRunGate = new Promise((resolve, reject) => { rejectFailedRun = reject; });
    const supersededCalls = [];
    const supersededWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      runPublisher: async ({ fingerprint }) => {
        supersededCalls.push(fingerprint);
        if (supersededCalls.length === 1) return failedRunGate;
        return { ok: true, skipped: true, publishedRows: 0, finishedAt: new Date().toISOString() };
      },
      logger: { warn: () => {} },
    });
    const failedFirstRun = supersededWatcher.check({ force: true });
    await wait(10);
    fs.writeFileSync(relayPath, JSON.stringify({ revision: "failure-c", padding: "latest" }));
    void supersededWatcher.check();
    await wait(10);
    const failedError = new Error("simulated first-child failure");
    failedError.code = "SQLITE_BUSY";
    rejectFailedRun(failedError);
    await failedFirstRun;
    for (let index = 0; index < 20 && supersededCalls.length < 2; index += 1) await wait(10);
    check("failed active run preserves and immediately drains the newest coalesced fingerprint", (
      supersededCalls.length === 2
      && supersededCalls[0] !== supersededCalls[1]
      && supersededWatcher.health().pending === false
      && supersededWatcher.health().lastError === null
    ), { calls: supersededCalls, health: supersededWatcher.health() });
    supersededWatcher.stop();

    let retryCalls = 0;
    const retryWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      runPublisher: async () => {
        retryCalls += 1;
        if (retryCalls === 1) {
          const error = new Error("simulated SQLITE_BUSY");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        return { ok: true, skipped: true, publishedRows: 0, finishedAt: new Date().toISOString() };
      },
      logger: { warn: () => {} },
    });
    await retryWatcher.check({ force: true });
    await wait(550);
    await retryWatcher.check();
    check("failed fingerprint retries without requiring another file change", (
      retryCalls === 2 && retryWatcher.health().lastError === null
    ), { retryCalls, health: retryWatcher.health() });
    retryWatcher.stop();

    let permitHeld = true;
    let permitRuns = 0;
    let permitReleases = 0;
    const permitWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      acquireRunPermit: async () => {
        if (permitHeld) return { acquired: false, reason: "sync lock held" };
        return {
          acquired: true,
          release: async () => { permitReleases += 1; },
        };
      },
      runPublisher: async () => {
        permitRuns += 1;
        return { ok: true, skipped: true, publishedRows: 0, finishedAt: new Date().toISOString() };
      },
      logger: { warn: () => {} },
    });
    await permitWatcher.check({ force: true });
    const permitDeferredHealth = permitWatcher.health();
    permitHeld = false;
    await wait(550);
    await permitWatcher.check();
    const permitFinishedHealth = permitWatcher.health();
    check("sync writer permit defers the fast publisher without creating SQLite lock contention", (
      permitDeferredHealth.pending === true
      && permitDeferredHealth.deferred === 1
      && permitDeferredHealth.runs === 0
      && permitDeferredHealth.lastDeferredReason === "sync lock held"
      && permitRuns === 1
      && permitReleases === 1
      && permitFinishedHealth.pending === false
      && permitFinishedHealth.runs === 1
      && permitFinishedHealth.lastError === null
    ), {
      permitRuns,
      permitReleases,
      deferred: permitDeferredHealth,
      finished: permitFinishedHealth,
    });
    permitWatcher.stop();

    let deferredCalls = 0;
    const deferredWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      runPublisher: async () => {
        deferredCalls += 1;
        if (deferredCalls === 1) {
          return {
            ok: true,
            skipped: true,
            reason: "fast-result-receipt-invalid",
            publishedRows: 0,
            finishedAt: new Date().toISOString(),
          };
        }
        return { ok: true, skipped: true, reason: "no-result-state-change", publishedRows: 0 };
      },
      logger: { warn: () => {} },
    });
    await deferredWatcher.check({ force: true });
    const deferredHealth = deferredWatcher.health();
    await wait(550);
    await deferredWatcher.check();
    check("retryable publisher integrity skips remain pending until SQLite becomes valid", (
      [
        "fast-result-receipt-invalid",
        "fast-result-revision-invalid",
        "authority-high-water-invalid",
        "authority-high-water-uninitialized",
        "authority-high-water-event-missing",
        "authority-high-water-overflow",
        "authority-high-water-identity-conflict",
        "authority-high-water-score-conflict",
      ].every((reason) => retryablePublisherSkip({ skipped: true, reason }))
      && deferredHealth.pending === true
      && deferredHealth.lastError?.code === "PUBLISHER_RETRYABLE_SKIP"
      && deferredCalls === 2
      && deferredWatcher.health().pending === false
      && deferredWatcher.health().lastError === null
    ), { deferredCalls, firstHealth: deferredHealth, finalHealth: deferredWatcher.health() });
    deferredWatcher.stop();

    let stopAborted = false;
    const stopWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "unused-in-injected-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      runPublisher: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          stopAborted = true;
          const error = new Error("aborted by watcher stop");
          error.code = "ABORT_ERR";
          reject(error);
        }, { once: true });
      }),
      logger: { warn: () => {} },
    });
    const stoppedRun = stopWatcher.check({ force: true });
    await wait(10);
    stopWatcher.stop();
    await stoppedRun;
    check("watcher stop aborts the active child runner", stopAborted && stopWatcher.health().pending === false, {
      stopAborted,
      health: stopWatcher.health(),
    });

    fs.writeFileSync(relayPath, JSON.stringify({ revision: "timeout-a" }));
    let timeoutPublisherCalls = 0;
    let timeoutChildClosed = false;
    let activeTimeoutChildren = 0;
    let maxActiveTimeoutChildren = 0;
    const timeoutKillSignals = [];
    const timeoutPermitReleaseStates = [];
    const timeoutSpawnImpl = () => {
      const child = new EventEmitter();
      child.pid = 90001;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let emittedClose = false;
      const childLifecycleHandle = setInterval(() => {}, 1000);
      activeTimeoutChildren += 1;
      maxActiveTimeoutChildren = Math.max(maxActiveTimeoutChildren, activeTimeoutChildren);
      child.kill = (signalName = "SIGTERM") => {
        timeoutKillSignals.push(signalName);
        if (signalName === "SIGKILL" && !emittedClose) {
          emittedClose = true;
          setTimeout(() => {
            clearInterval(childLifecycleHandle);
            timeoutChildClosed = true;
            activeTimeoutChildren -= 1;
            child.signalCode = "SIGKILL";
            child.stdout.end();
            child.stderr.end();
            child.emit("close", null, "SIGKILL");
          }, 5);
        }
        // Intentionally ignore SIGTERM so the regression proves escalation.
        return true;
      };
      return child;
    };
    const timeoutWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "ignored-by-timeout-spawn.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      terminationGraceMs: 30,
      acquireRunPermit: async () => ({
        acquired: true,
        release: async () => {
          timeoutPermitReleaseStates.push({
            childClosed: timeoutChildClosed,
            activeChildren: activeTimeoutChildren,
          });
        },
      }),
      runPublisher: ({ signal }) => {
        timeoutPublisherCalls += 1;
        if (timeoutPublisherCalls > 1) {
          return Promise.resolve({
            ok: true,
            skipped: true,
            reason: "no-result-state-change",
            publishedRows: 0,
            finishedAt: new Date().toISOString(),
          });
        }
        return runFastPublisherChild({
          publisherPath: "ignored-by-timeout-spawn.cjs",
          cwd: tempDir,
          env: process.env,
          timeoutMs: 20,
          terminationGraceMs: 30,
          spawnImpl: timeoutSpawnImpl,
          signal,
        });
      },
      logger: { warn: () => {} },
    });
    const timedOutRun = timeoutWatcher.check({ force: true });
    await wait(28);
    fs.writeFileSync(relayPath, JSON.stringify({ revision: "timeout-b", padding: "newest" }));
    void timeoutWatcher.check();
    const terminatingHealth = timeoutWatcher.health();
    check("publisher timeout keeps the watcher single-flight while SIGTERM cleanup is pending", (
      timeoutPublisherCalls === 1
      && timeoutPermitReleaseStates.length === 0
      && activeTimeoutChildren === 1
      && terminatingHealth.running === true
    ), {
      timeoutPublisherCalls,
      timeoutPermitReleaseStates,
      activeTimeoutChildren,
      health: terminatingHealth,
    });
    await timedOutRun;
    for (let index = 0; index < 30 && timeoutPublisherCalls < 2; index += 1) await wait(10);
    for (let index = 0; index < 30 && timeoutWatcher.health().running; index += 1) await wait(10);
    const timeoutHealth = timeoutWatcher.health();
    check("publisher timeout escalates TERM to KILL and releases its permit only after child close", (
      timeoutKillSignals[0] === "SIGTERM"
      && timeoutKillSignals.includes("SIGKILL")
      && timeoutChildClosed === true
      && maxActiveTimeoutChildren === 1
      && timeoutPermitReleaseStates.length === 2
      && timeoutPermitReleaseStates[0]?.childClosed === true
      && timeoutPermitReleaseStates[0]?.activeChildren === 0
      && timeoutPublisherCalls === 2
      && timeoutHealth.running === false
      && timeoutHealth.pending === false
      && timeoutHealth.lastError === null
    ), {
      timeoutKillSignals,
      timeoutPublisherCalls,
      maxActiveTimeoutChildren,
      timeoutPermitReleaseStates,
      health: timeoutHealth,
    });
    timeoutWatcher.stop();

    let stopLifecycleClosed = false;
    let stopLifecyclePermitReleases = 0;
    const stopLifecycleSignals = [];
    const stopLifecycleSpawn = () => {
      const child = new EventEmitter();
      child.pid = 90002;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const childLifecycleHandle = setInterval(() => {}, 1000);
      let closeScheduled = false;
      child.kill = (signalName = "SIGTERM") => {
        stopLifecycleSignals.push(signalName);
        if (signalName === "SIGKILL" && !closeScheduled) {
          closeScheduled = true;
          setTimeout(() => {
            clearInterval(childLifecycleHandle);
            stopLifecycleClosed = true;
            child.signalCode = "SIGKILL";
            child.stdout.end();
            child.stderr.end();
            child.emit("close", null, "SIGKILL");
          }, 5);
        }
        return true;
      };
      return child;
    };
    const stopLifecycleWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: relayPath,
      publisherPath: "ignored-by-stop-lifecycle-spawn.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      terminationGraceMs: 30,
      acquireRunPermit: async () => ({
        acquired: true,
        release: async () => { stopLifecyclePermitReleases += 1; },
      }),
      runPublisher: ({ signal }) => runFastPublisherChild({
        publisherPath: "ignored-by-stop-lifecycle-spawn.cjs",
        cwd: tempDir,
        env: process.env,
        timeoutMs: 10_000,
        terminationGraceMs: 30,
        spawnImpl: stopLifecycleSpawn,
        signal,
      }),
      logger: { warn: () => {} },
    });
    void stopLifecycleWatcher.check({ force: true });
    await wait(10);
    const stopLifecycleCompletion = stopLifecycleWatcher.stop();
    await wait(10);
    check("watcher stop remains pending while its child and permit are still active", (
      stopLifecycleCompletion instanceof Promise
      && stopLifecycleClosed === false
      && stopLifecyclePermitReleases === 0
      && stopLifecycleWatcher.health().running === true
    ), {
      stopLifecycleClosed,
      stopLifecyclePermitReleases,
      signals: stopLifecycleSignals,
      health: stopLifecycleWatcher.health(),
    });
    await stopLifecycleCompletion;
    check("watcher stop resolves only after TERM KILL close and permit release", (
      stopLifecycleSignals[0] === "SIGTERM"
      && stopLifecycleSignals.includes("SIGKILL")
      && stopLifecycleClosed === true
      && stopLifecyclePermitReleases === 1
      && stopLifecycleWatcher.health().running === false
      && stopLifecycleWatcher.health().pending === false
    ), {
      stopLifecycleClosed,
      stopLifecyclePermitReleases,
      signals: stopLifecycleSignals,
      health: stopLifecycleWatcher.health(),
    });

    const semanticKeyPair = createCollectorKeyPair({
      keyId: "relay-semantic-regression",
      independenceDomain: "regression/relay-semantic",
    });
    const semanticTrustRegistryPath = path.join(tempDir, "semantic-collector-trust-registry.json");
    fs.writeFileSync(
      semanticTrustRegistryPath,
      `${JSON.stringify(semanticKeyPair.registry, null, 2)}\n`,
      "utf8",
    );
    const semanticRelayPath = path.join(tempDir, "relay-semantic.json");
    const writeSemanticSnapshot = (snapshot) => {
      fs.writeFileSync(semanticRelayPath, JSON.stringify(snapshot), "utf8");
    };
    const semanticReader = createRelayResultSemanticFingerprintReader(semanticRelayPath, {
      trustRegistry: semanticKeyPair.registry,
    });
    const futureRecoveryPath = path.join(tempDir, "relay-semantic-future-recovery.json");
    let simulatedNowMs = Date.now() + 5_000;
    const futureResultAt = new Date(simulatedNowMs + 60_000).toISOString();
    fs.writeFileSync(futureRecoveryPath, JSON.stringify(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "future-recovery",
      resultObservedAt: futureResultAt,
      resultSourceCycleId: "semantic-result-future-recovery",
    })), "utf8");
    const futureRecoveryReader = createRelayResultSemanticFingerprintReader(futureRecoveryPath, {
      trustRegistry: semanticKeyPair.registry,
      nowMs: () => simulatedNowMs,
      maxFutureSkewMs: 0,
    });
    const futureInvalidFingerprint = futureRecoveryReader();
    simulatedNowMs = Date.parse(futureResultAt) + 1_000;
    const futureRecoveredFingerprint = futureRecoveryReader();
    check("unchanged signed future snapshot is re-evaluated and becomes semantic when its clock is reached", (
      futureInvalidFingerprint === relaySnapshotFingerprint(futureRecoveryPath)
      && !futureInvalidFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && futureRecoveredFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && futureRecoveredFingerprint !== futureInvalidFingerprint
    ), { futureInvalidFingerprint, futureRecoveredFingerprint });
    const explicitTerminalSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "explicit-terminal-clock-stability",
      resultStatus: "0",
      resultScore: "2:1",
      resultOverrides: {
        matchResultStatus: "2",
        poolStatus: "Payout",
        matchStatusName: "Selling",
      },
      resultSourceCycleId: "semantic-explicit-terminal-clock-stability",
    });
    const explicitCapturedMs = Date.parse(explicitTerminalSnapshot.capturedAt);
    const explicitEarlyFingerprint = relayResultSemanticFingerprint(explicitTerminalSnapshot, {
      trustRegistry: semanticKeyPair.registry,
      nowMs: explicitCapturedMs + 60_000,
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    const explicitLateFingerprint = relayResultSemanticFingerprint(explicitTerminalSnapshot, {
      trustRegistry: semanticKeyPair.registry,
      nowMs: explicitCapturedMs + 130 * 60_000,
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    check("explicit terminal snapshot keeps one semantic fingerprint across the 125-minute boundary", (
      explicitEarlyFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && explicitLateFingerprint === explicitEarlyFingerprint
    ), { explicitEarlyFingerprint, explicitLateFingerprint });
    const semanticInitial = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-a",
      padding: "a",
    });
    writeSemanticSnapshot(semanticInitial);
    const initialSemanticFingerprint = semanticReader();
    const semanticCurrentOnly = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-b",
      padding: "current-only-padding",
    });
    writeSemanticSnapshot(semanticCurrentOnly);
    const currentOnlyFingerprint = semanticReader();
    const semanticAliasBase = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "alias-score-base",
      padding: "alias-score-base-padding",
    });
    writeSemanticSnapshot(semanticAliasBase);
    const aliasBaseFingerprint = semanticReader();
    const semanticHomeScoreChanged = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "alias-score-base",
      resultOverrides: { homeScore: 2, awayScore: 1 },
      padding: "home-score-only-padding",
    });
    writeSemanticSnapshot(semanticHomeScoreChanged);
    const homeScoreOnlyFingerprint = semanticReader();
    const semanticSellStatusBase = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "sell-status-base",
      resultOverrides: { sellStatus: "2" },
      padding: "sell-status-base-padding",
    });
    writeSemanticSnapshot(semanticSellStatusBase);
    const sellStatusBaseFingerprint = semanticReader();
    const semanticSellStatusChanged = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "sell-status-base",
      resultOverrides: { sellStatus: "3" },
      padding: "sell-status-only-padding",
    });
    writeSemanticSnapshot(semanticSellStatusChanged);
    const sellStatusOnlyFingerprint = semanticReader();
    const semanticFinalScoreBase = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "final-score-base",
      resultOverrides: { finalScore: "1:0" },
      padding: "final-score-base-padding",
    });
    writeSemanticSnapshot(semanticFinalScoreBase);
    const finalScoreBaseFingerprint = semanticReader();
    const semanticFinalScoreChanged = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "final-score-base",
      resultOverrides: { finalScore: "2:1" },
      padding: "final-score-only-padding",
    });
    writeSemanticSnapshot(semanticFinalScoreChanged);
    const finalScoreOnlyFingerprint = semanticReader();
    const fixedAliasCycle = "semantic-result-alias-fixed";
    const aliasFingerprints = [];
    for (const [alias, value] of [
      ["homeTeamCode", "HOME-CODE"],
      ["homeTeamAbbEnName", "HOME-ABB"],
      ["awayTeamCode", "AWAY-CODE"],
      ["awayTeamAbbEnName", "AWAY-ABB"],
    ]) {
      writeSemanticSnapshot(signedFastLaneSnapshot({
        keyPair: semanticKeyPair,
        currentMarker: `team-alias-${alias}`,
        resultOverrides: { [alias]: value },
        resultSourceCycleId: fixedAliasCycle,
        padding: `team-alias-${alias}`,
      }));
      aliasFingerprints.push([alias, semanticReader()]);
    }
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "payout-a",
      resultOverrides: { officialPayoutSp: { had: { h: "1.50" } } },
      resultSourceCycleId: "semantic-payout-fixed",
      padding: "payout-a",
    }));
    const payoutFingerprintA = semanticReader();
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "payout-b",
      resultOverrides: { officialPayoutSp: { had: { h: "1.60" } } },
      resultSourceCycleId: "semantic-payout-fixed",
      padding: "payout-b",
    }));
    const payoutFingerprintB = semanticReader();
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "revision-a",
      resultSourceCycleId: "semantic-result-revision-a",
      resultObservedAt: "2026-08-02T00:00:00.000Z",
      padding: "revision-a",
    }));
    const resultRevisionFingerprintA = semanticReader();
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "revision-b",
      resultSourceCycleId: "semantic-result-revision-b",
      resultObservedAt: "2026-08-02T00:00:01.000Z",
      padding: "revision-b",
    }));
    const resultRevisionFingerprintB = semanticReader();
    const semanticCurrentFinished = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-current-final",
      currentStatus: "11",
      currentScore: "2:1",
      padding: "current-final-padding-longer",
    });
    writeSemanticSnapshot(semanticCurrentFinished);
    const currentFinishedFingerprint = semanticReader();
    const semanticStatusChanged = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-c",
      currentStatus: "11",
      currentScore: "2:1",
      resultStatus: "10",
      padding: "status-changed-padding-longer",
    });
    writeSemanticSnapshot(semanticStatusChanged);
    const statusChangedFingerprint = semanticReader();
    const semanticScoreChanged = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-d",
      currentStatus: "11",
      currentScore: "2:1",
      resultStatus: "11",
      resultScore: "3:1",
      padding: "score-changed-padding-longest",
    });
    writeSemanticSnapshot(semanticScoreChanged);
    const scoreChangedFingerprint = semanticReader();
    const invalidSignedSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-e",
      currentStatus: "11",
      currentScore: "2:1",
      resultStatus: "11",
      resultScore: "3:1",
      padding: "invalid-signature-padding-longest-of-all",
    });
    const invalidResultEndpoint = invalidSignedSnapshot.endpoints.find((entry) => entry.method === "result");
    invalidResultEndpoint.collectorAttestation.signature = "invalid-signature";
    invalidResultEndpoint.collectorProvenance.collectorAttestation.signature = "invalid-signature";
    writeSemanticSnapshot(invalidSignedSnapshot);
    const invalidSignatureFingerprint = semanticReader();
    const invalidMarketSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-invalid-current",
      resultScore: "3:1",
      padding: "invalid-market-signature-padding",
    });
    const invalidCurrentEndpoint = invalidMarketSnapshot.endpoints.find((entry) => entry.method === "current");
    invalidCurrentEndpoint.collectorAttestation.signature = "invalid-current-signature";
    invalidCurrentEndpoint.collectorProvenance.collectorAttestation.signature = "invalid-current-signature";
    writeSemanticSnapshot(invalidMarketSnapshot);
    const invalidMarketFingerprint = semanticReader();
    const duplicateEndpointSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-duplicate-result",
      resultScore: "3:1",
      padding: "duplicate-result-endpoint-padding",
    });
    const duplicateResult = signedRelayEndpoint({
      method: "result",
      match: {
        matchId: "semantic-result-duplicate",
        matchNum: 202,
        matchStatus: "11",
        sectionsNo999: "5:0",
      },
      keyPair: semanticKeyPair,
      sourceCycleId: `semantic-duplicate-result-${Date.now()}`,
      observedAt: new Date().toISOString(),
    });
    duplicateEndpointSnapshot.endpoints.push(duplicateResult);
    duplicateEndpointSnapshot.summary.endpoints += 1;
    duplicateEndpointSnapshot.summary.usableEndpoints += 1;
    duplicateEndpointSnapshot.summary.rows += 1;
    writeSemanticSnapshot(duplicateEndpointSnapshot);
    const duplicateEndpointFingerprint = semanticReader();
    const roleSwapSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "market-role-swap",
      resultScore: "3:1",
      padding: "signed-result-role-swap-padding",
    });
    const signedResultForRoleSwap = roleSwapSnapshot.endpoints.find((entry) => entry.method === "result");
    const forgedCurrent = {
      ...signedResultForRoleSwap,
      id: "method:current",
      method: "current",
      page: null,
      collectorRole: "current",
      fastResultConstituent: {
        ...signedResultForRoleSwap.fastResultConstituent,
        role: "companion",
      },
    };
    roleSwapSnapshot.endpoints = roleSwapSnapshot.endpoints.map((entry) => (
      entry.method === "current" ? forgedCurrent : entry
    ));
    writeSemanticSnapshot(roleSwapSnapshot);
    const roleSwapFingerprint = semanticReader();
    check("signed result semantic fingerprint ignores current/calculator-only rewrites", (
      initialSemanticFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && currentOnlyFingerprint === initialSemanticFingerprint
    ), {
      initialSemanticFingerprint,
      currentOnlyFingerprint,
    });
    check("companion terminal rows are ignored while result status and score advance the fingerprint", (
      currentFinishedFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && statusChangedFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && scoreChangedFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && currentFinishedFingerprint === currentOnlyFingerprint
      && statusChangedFingerprint !== currentFinishedFingerprint
      && scoreChangedFingerprint !== statusChangedFingerprint
    ), {
      currentOnlyFingerprint,
      currentFinishedFingerprint,
      statusChangedFingerprint,
      scoreChangedFingerprint,
    });
    check("homeScore and awayScore aliases advance the signed semantic fingerprint", (
      aliasBaseFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && homeScoreOnlyFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && homeScoreOnlyFingerprint !== aliasBaseFingerprint
    ), { aliasBaseFingerprint, homeScoreOnlyFingerprint });
    check("sellStatus-only changes advance the signed semantic fingerprint", (
      sellStatusBaseFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && sellStatusOnlyFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && sellStatusOnlyFingerprint !== sellStatusBaseFingerprint
    ), { sellStatusBaseFingerprint, sellStatusOnlyFingerprint });
    check("finalScore-only changes advance the signed semantic fingerprint", (
      finalScoreBaseFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && finalScoreOnlyFingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && finalScoreOnlyFingerprint !== finalScoreBaseFingerprint
    ), { finalScoreBaseFingerprint, finalScoreOnlyFingerprint });
    check("all four official team-code aliases participate in the result semantic digest", (
      aliasFingerprints.every(([, fingerprint]) => (
        fingerprint?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      ))
      && new Set(aliasFingerprints.map(([, fingerprint]) => fingerprint)).size === 4
    ), { aliasFingerprints: Object.fromEntries(aliasFingerprints) });
    check("official payout SP changes advance the result semantic digest", (
      payoutFingerprintA?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && payoutFingerprintB?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && payoutFingerprintA !== payoutFingerprintB
    ), { payoutFingerprintA, payoutFingerprintB });
    check("same score with a newer signed result probe revision advances the semantic digest", (
      resultRevisionFingerprintA?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && resultRevisionFingerprintB?.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && resultRevisionFingerprintA !== resultRevisionFingerprintB
    ), { resultRevisionFingerprintA, resultRevisionFingerprintB });
    check("invalid result signature falls back to the full file identity", (
      !invalidSignatureFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && !invalidMarketFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && !duplicateEndpointFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
      && roleSwapFingerprint === relaySnapshotFingerprint(semanticRelayPath)
      && !roleSwapFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
    ), {
      invalidSignatureFingerprint,
      invalidMarketFingerprint,
      duplicateEndpointFingerprint,
      roleSwapFingerprint,
      fileFingerprint: relaySnapshotFingerprint(semanticRelayPath),
    });
    check("duplicate keys, one bad signature, and a signed result relabeled as current all fail closed", (
      invalidMarketFingerprint !== currentOnlyFingerprint
      && duplicateEndpointFingerprint !== scoreChangedFingerprint
      && roleSwapFingerprint !== scoreChangedFingerprint
      && !invalidSignatureFingerprint.startsWith(`${RESULT_SEMANTIC_FINGERPRINT_VERSION}:`)
    ), {
      invalidMarketFingerprint,
      duplicateEndpointFingerprint,
      roleSwapFingerprint,
    });

    let semanticPublisherRuns = 0;
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "watcher-a",
      padding: "watcher-a",
    }));
    const semanticWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: semanticRelayPath,
      publisherPath: "unused-in-semantic-test.cjs",
      cwd: tempDir,
      pollMs: 250,
      timeoutMs: 1000,
      fingerprintTrustRegistry: semanticKeyPair.registry,
      runPublisher: async () => {
        semanticPublisherRuns += 1;
        return {
          ok: true,
          skipped: true,
          reason: "no-result-state-change",
          publishedRows: 0,
          finishedAt: new Date().toISOString(),
        };
      },
      logger: { warn: () => {} },
    });
    await semanticWatcher.check({ force: true });
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "watcher-b",
      padding: "watcher-current-only-rewrite",
    }));
    await semanticWatcher.check();
    const runsAfterCurrentOnly = semanticPublisherRuns;
    const semanticHealthAfterCurrentOnly = semanticWatcher.health();
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "watcher-current-final",
      currentStatus: "11",
      currentScore: "2:1",
      padding: "watcher-current-final-rewrite",
    }));
    await semanticWatcher.check();
    const runsAfterCurrentFinal = semanticPublisherRuns;
    writeSemanticSnapshot(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "watcher-c",
      currentStatus: "11",
      currentScore: "2:1",
      resultScore: "4:2",
      padding: "watcher-score-rewrite-longer",
    }));
    await semanticWatcher.check();
    const runsAfterScoreChange = semanticPublisherRuns;
    const invalidStructureSnapshot = signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "watcher-d",
      resultScore: "4:2",
      padding: "watcher-invalid-structure-rewrite-longest",
    });
    invalidStructureSnapshot.producer.resultFingerprint = "0".repeat(64);
    writeSemanticSnapshot(invalidStructureSnapshot);
    await semanticWatcher.check();
    check("watcher suppresses all signed companion-only rewrites but runs for result or invalid snapshots", (
      runsAfterCurrentOnly === 1
      && semanticHealthAfterCurrentOnly.fingerprintPolicy === RESULT_SEMANTIC_FINGERPRINT_VERSION
      && semanticHealthAfterCurrentOnly.resultSemanticFingerprintActive === true
      && semanticHealthAfterCurrentOnly.completedResultSemanticFingerprint === true
      && runsAfterCurrentFinal === 1
      && runsAfterScoreChange === 2
      && semanticPublisherRuns === 3
      && semanticWatcher.health().running === false
      && semanticWatcher.health().pending === false
      && semanticWatcher.health().lastError === null
    ), {
      runsAfterCurrentOnly,
      semanticHealthAfterCurrentOnly,
      runsAfterCurrentFinal,
      runsAfterScoreChange,
      semanticPublisherRuns,
      health: semanticWatcher.health(),
    });
    semanticWatcher.stop();

    const explicitChildDir = path.join(tempDir, "explicit-terminal-real-child");
    fs.mkdirSync(explicitChildDir, { recursive: true });
    const explicitChildDbPath = path.join(explicitChildDir, "football.db");
    const explicitChildRelayPath = path.join(explicitChildDir, "relay-fast.json");
    const explicitObservedAt = new Date(Date.now() - 1_000).toISOString();
    const explicitKickoffDate = new Date(Date.now() - 10 * 60_000);
    const explicitKickoffLocal = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(explicitKickoffDate);
    const [explicitMatchDate, explicitMatchTime] = explicitKickoffLocal.split(" ");
    const explicitKickoffTime = `${explicitMatchDate}T${explicitMatchTime}+08:00`;
    const explicitSourceMatchId = "watcher-explicit-terminal-real-child";
    const explicitDb = new DatabaseSync(explicitChildDbPath);
    explicitDb.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE match_snapshots (
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        match_id TEXT,
        source_match_id TEXT,
        kickoff_time TEXT,
        status TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE prediction_snapshots (
        id TEXT PRIMARY KEY,
        state_key TEXT UNIQUE,
        match_id TEXT,
        source_match_id TEXT,
        phase TEXT,
        captured_at TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        seen_count INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL
      );
    `);
    const explicitCurrentMatch = {
      id: `sporttery_${explicitSourceMatchId}`,
      sourceMatchId: explicitSourceMatchId,
      source: "sporttery",
      sourceMethod: "relay:current",
      sourceUrl: SPORTTERY_CURRENT_URL,
      status: "PENDING_RESULT",
      sourceStatus: "PENDING_RESULT",
      effectiveStatus: "PENDING_RESULT",
      kickoffTime: explicitKickoffTime,
      eventVersion: explicitKickoffTime,
      matchDate: explicitMatchDate,
      businessDate: explicitMatchDate,
      matchNo: "周日001",
      homeTeamId: "watcher-explicit-home",
      awayTeamId: "watcher-explicit-away",
      homeTeamName: "显式完场主队",
      awayTeamName: "显式完场客队",
      predictions: [],
    };
    explicitDb.prepare(`
      INSERT INTO match_snapshots
        (id, dataset, match_id, source_match_id, kickoff_time, status, payload)
      VALUES (?, 'current', ?, ?, ?, 'PENDING_RESULT', ?)
    `).run(
      `current:${explicitCurrentMatch.id}`,
      explicitCurrentMatch.id,
      explicitSourceMatchId,
      explicitKickoffTime,
      JSON.stringify(explicitCurrentMatch),
    );
    explicitDb.close();
    fs.writeFileSync(
      path.join(explicitChildDir, "sync-meta.json"),
      `${JSON.stringify({ version: "watcher-explicit-terminal-fixture" })}\n`,
      "utf8",
    );
    fs.writeFileSync(explicitChildRelayPath, JSON.stringify(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "explicit-terminal-real-child",
      resultStatus: "0",
      resultScore: "2:1",
      resultObservedAt: explicitObservedAt,
      resultSourceCycleId: "watcher-explicit-terminal-result-cycle",
      resultOverrides: {
        matchId: explicitSourceMatchId,
        businessDate: explicitMatchDate,
        matchDate: explicitMatchDate,
        matchTime: explicitMatchTime,
        matchStatus: "0",
        matchStatusName: "Selling",
        matchResultStatus: "2",
        poolStatus: "Payout",
        matchNumStr: "周日001",
        homeTeamAllName: explicitCurrentMatch.homeTeamName,
        awayTeamAllName: explicitCurrentMatch.awayTeamName,
        homeTeamId: explicitCurrentMatch.homeTeamId,
        awayTeamId: explicitCurrentMatch.awayTeamId,
        leagueAllName: "显式完场回归联赛",
        sectionsNo999: "2:1",
      },
    })), "utf8");
    const explicitChildWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: explicitChildRelayPath,
      publisherPath: path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs"),
      cwd: rootDir,
      env: isolatedRelayChildEnv({
        baseEnv: {
          ...process.env,
          SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: semanticTrustRegistryPath,
          SPORTTERY_RELAY_MAX_AGE_MINUTES: "5",
          SOURCE_MAX_AGE_MINUTES: "5",
        },
        caseDir: explicitChildDir,
        relaySnapshotPath: explicitChildRelayPath,
        fastLaneSnapshotPath: explicitChildRelayPath,
        dbPath: explicitChildDbPath,
      }),
      pollMs: 250,
      timeoutMs: 15_000,
      fingerprintTrustRegistry: semanticKeyPair.registry,
      logger: { warn: () => {} },
    });
    const explicitChildResult = await explicitChildWatcher.check({ force: true });
    const explicitChildStateDb = new DatabaseSync(explicitChildDbPath, { readOnly: true });
    const explicitChildRows = explicitChildStateDb.prepare(`
      SELECT dataset, status, payload FROM match_snapshots ORDER BY dataset, id
    `).all().map((row) => ({ ...row, match: JSON.parse(row.payload) }));
    explicitChildStateDb.close();
    const explicitChildHistory = explicitChildRows.find((row) => row.dataset === "history")?.match;
    check("watcher real child publishes explicit terminal status before 125 elapsed minutes", (
      explicitChildResult?.protocol === FAST_RESULT_PUBLISHER_PROTOCOL
      && explicitChildResult?.ok === true
      && explicitChildResult?.skipped === false
      && explicitChildResult?.publishedRows === 1
      && explicitChildRows.filter((row) => row.dataset === "current").length === 0
      && explicitChildRows.filter((row) => row.dataset === "history").length === 1
      && explicitChildHistory?.status === "FINISHED"
      && explicitChildHistory?.scoreHome === 2
      && explicitChildHistory?.scoreAway === 1
      && explicitChildWatcher.health().lastPublishedRows === 1
    ), {
      result: explicitChildResult,
      rows: explicitChildRows.map((row) => ({
        dataset: row.dataset,
        status: row.status,
        sourceMatchId: row.match?.sourceMatchId || null,
      })),
      health: explicitChildWatcher.health(),
    });
    await explicitChildWatcher.stop();

    const fingerprint = relaySnapshotFingerprint(relayPath);
    check("relay fingerprint includes a stable file identity", typeof fingerprint === "string" && fingerprint.split(":").length === 5, {
      fingerprint,
    });

    let garbageError = null;
    try {
      parseFastResultPublisherOutput(`unexpected diagnostic on stdout\n${encodeFastResultPublisherOutput({
        ok: true,
        skipped: true,
        phase: "official-result-fast-publication",
        publishedRows: 0,
      })}`);
    } catch (error) {
      garbageError = error;
    }
    check("publisher protocol rejects stdout garbage instead of masking it", (
      garbageError?.code === "PUBLISHER_OUTPUT_INVALID"
    ), { error: garbageError?.message || null });

    const inheritedFastLanePath = path.join(tempDir, "inherited-production-fast-lane.json");
    fs.writeFileSync(inheritedFastLanePath, JSON.stringify(freshFastLaneSnapshot()));

    const realChildCases = [{
      key: "stale",
      label: "stale relay snapshot",
      contents: JSON.stringify({
        capturedAt: "2020-01-01T00:00:00.000Z",
        maxAgeMinutes: 1,
        endpoints: [{
          id: "method:result:1",
          method: "result",
          ok: true,
          url: "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result",
          payload: {
            value: {
              matchInfoList: [{
                businessDate: "2026-07-13",
                subMatchList: [{ matchId: "real-child-stale" }],
              }],
            },
          },
        }],
      }),
    }, {
      key: "empty",
      label: "empty relay snapshot",
      contents: JSON.stringify({
        capturedAt: new Date().toISOString(),
        maxAgeMinutes: 1,
        endpoints: [{
          id: "method:result:1",
          method: "result",
          ok: true,
          payload: { value: { matchInfoList: [] } },
        }],
      }),
    }, {
      key: "read-fail",
      label: "read-failed relay snapshot",
      contents: "{not-valid-json",
    }];

    for (const fixture of realChildCases) {
      const caseDir = path.join(tempDir, `real-child-${fixture.key}`);
      fs.mkdirSync(caseDir, { recursive: true });
      const caseRelayPath = path.join(caseDir, "relay.json");
      const caseDbPath = path.join(caseDir, "football.db");
      const isolatedFastLanePath = path.join(caseDir, "isolated-fast-lane.json");
      fs.writeFileSync(caseRelayPath, fixture.contents);
      fs.writeFileSync(caseDbPath, "");
      const childEnv = isolatedRelayChildEnv({
        baseEnv: {
          ...process.env,
          // Reproduce the post-swap readiness environment that caused r61 to
          // read the live fast lane instead of the real-child fixture.
          SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: inheritedFastLanePath,
          SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH: inheritedFastLanePath,
        },
        caseDir,
        relaySnapshotPath: caseRelayPath,
        fastLaneSnapshotPath: isolatedFastLanePath,
        dbPath: caseDbPath,
      });
      check(`real child isolates inherited fast lane for ${fixture.label}`, (
        childEnv.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT === isolatedFastLanePath
        && childEnv.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH === isolatedFastLanePath
        && childEnv.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT !== inheritedFastLanePath
      ), {
        fastLaneSnapshot: childEnv.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT,
      });
      const realChildWatcher = createRelayFastResultWatcher({
        enabled: true,
        relaySnapshotPath: caseRelayPath,
        publisherPath: path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs"),
        cwd: rootDir,
        env: fixture.key === "read-fail"
          ? {
              ...childEnv,
              // A valid inherited candidate must not rescue a malformed file
              // that the watcher actually fingerprinted.
              SPORTTERY_RELAY_FAST_LANE_SNAPSHOT: inheritedFastLanePath,
              SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH: inheritedFastLanePath,
            }
          : childEnv,
        pollMs: 250,
        timeoutMs: 15_000,
        logger: { warn: () => {} },
      });
      const result = await realChildWatcher.check({ force: true });
      await wait(550);
      await realChildWatcher.check();
      const childHealth = realChildWatcher.health();
      const expectedRetryReason = fixture.key === "read-fail"
        ? "trusted-relay-snapshot-unavailable"
        : "trusted-fast-result-endpoints-unavailable";
      check(`real child keeps ${fixture.label} pending until relay trust is repaired`, (
        result === null
        && childHealth.runs >= 2
        && childHealth.pending === true
        && childHealth.lastError?.code === "PUBLISHER_RETRYABLE_SKIP"
        && childHealth.lastError?.message?.includes(expectedRetryReason)
        && childHealth.lastSuccessAt === null
      ), { result, health: childHealth });
      realChildWatcher.stop();
    }

    const schemaCaseDir = path.join(tempDir, "real-child-schema-unavailable");
    fs.mkdirSync(schemaCaseDir, { recursive: true });
    const schemaRelayPath = path.join(schemaCaseDir, "relay-fast.json");
    const schemaDbPath = path.join(schemaCaseDir, "football.db");
    fs.writeFileSync(schemaRelayPath, JSON.stringify(signedFastLaneSnapshot({
      keyPair: semanticKeyPair,
      currentMarker: "schema-unavailable",
      resultOverrides: rawRelayMatch({
        matchId: "schema-unavailable-result",
        status: "11",
        score: "2:1",
      }),
    })));
    fs.writeFileSync(schemaDbPath, "");
    const schemaWatcher = createRelayFastResultWatcher({
      enabled: true,
      relaySnapshotPath: schemaRelayPath,
      publisherPath: path.join(rootDir, "scripts", "publishOfficialResultsFast.cjs"),
      cwd: rootDir,
      env: isolatedRelayChildEnv({
        baseEnv: {
          ...process.env,
          SPORTTERY_COLLECTOR_TRUST_REGISTRY_PATH: semanticTrustRegistryPath,
        },
        caseDir: schemaCaseDir,
        relaySnapshotPath: schemaRelayPath,
        fastLaneSnapshotPath: schemaRelayPath,
        dbPath: schemaDbPath,
      }),
      pollMs: 250,
      timeoutMs: 15_000,
      logger: { warn: () => {} },
    });
    const schemaResult = await schemaWatcher.check({ force: true });
    const schemaHealth = schemaWatcher.health();
    check("real child keeps a genuinely missing SQLite schema fail-closed and retryable", (
      schemaResult === null
      && schemaHealth.runs === 1
      && schemaHealth.pending === true
      && schemaHealth.lastSuccessAt === null
      && schemaHealth.lastPublishedAt === null
      && schemaHealth.lastError?.code === "PUBLISHER_RETRYABLE_SKIP"
      && schemaHealth.lastError?.message.includes("sqlite-schema-unavailable")
    ), { result: schemaResult, health: schemaHealth });
    schemaWatcher.stop();

    const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
    const syncDataSource = fs.readFileSync(path.join(rootDir, "scripts", "syncData.cjs"), "utf8");
    const fastLaneSource = fs.readFileSync(path.join(rootDir, "scripts", "sportteryFastResultLane.cjs"), "utf8");
    check("publisher normalization and relay semantic digest share one Sporttery result contract", (
      syncDataSource.includes("scoreFromSportteryRow(row)")
      && syncDataSource.includes("statusFromSportteryRow(row, kickoffTime)")
      && syncDataSource.includes("officialVoidDispositionFromSportteryRow(row)")
      && !syncDataSource.includes("function scoreFromRow(row)")
      && fastLaneSource.includes("sportteryResultObservation(match)")
    ));
    check("server publication callback clears caches and emits compatible SSE phase", (
      serverSource.includes("clearApiReadCaches();")
      && serverSource.includes('type: "sync_completed"')
      && serverSource.includes('phase: "official-result-fast-published"')
      && serverSource.includes("fastResultWatcher: relayFastResultWatcher.health()")
      && serverSource.includes("const relayFastWatcherStop = relayFastResultWatcher.stop();")
      && serverSource.includes("await relayFastWatcherStop;")
    ));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = checks.filter((item) => !item.ok);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    checks: checks.length,
    passed: checks.length - failed.length,
    failed,
    results: checks,
  }, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
