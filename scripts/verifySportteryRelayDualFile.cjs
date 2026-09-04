const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-relay-dual-file-"));
const fullPath = path.join(tempDir, "sporttery-relay-snapshot.json");
const fastPath = path.join(tempDir, "sporttery-relay-fast-lane.json");

process.env.SPORTTERY_RELAY_MODE = "prefer";
process.env.SPORTTERY_RELAY_SNAPSHOT = fullPath;
process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT = fastPath;
process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES = "20";
process.env.SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES = "180";
process.env.TRUSTED_MAX_FUTURE_SKEW_SECONDS = "300";

const {
  loadSportteryRelayHistorySnapshot,
  loadSportteryRelaySnapshot,
} = require("./syncData.cjs");
const { relaySnapshotFingerprint, relaySnapshotChanged } = require("./runSyncWorker.cjs");

const checks = [];
const push = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });
const iso = (ms) => new Date(ms).toISOString();
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rowsIn = (entry) => (entry?.payload?.value?.matchInfoList || [])
  .reduce((sum, day) => sum + (Array.isArray(day?.subMatchList) ? day.subMatchList.length : 0), 0);
const methodOf = (entry) => String(entry?.method || entry?.id || "").replace(/^method:/, "").toLowerCase();
const pageOf = (entry) => Number(entry?.page ?? 1);
const endpointKey = (entry) => `${methodOf(entry)}:${pageOf(entry)}`;

const endpoint = ({ method, page = null, receivedAt, cycle, matchId }) => ({
  id: method === "result" ? `method:result:${page ?? 1}` : method,
  method,
  page,
  requestedAt: iso(Date.parse(receivedAt) - 100),
  receivedAt,
  fetchedAt: receivedAt,
  sourceCycleId: cycle,
  collectorProvenance: {
    sourceCycleId: cycle,
    requestedAt: iso(Date.parse(receivedAt) - 100),
    receivedAt,
  },
  ok: true,
  payload: {
    value: {
      matchInfoList: [{
        businessDate: receivedAt.slice(0, 10),
        subMatchList: [{
          matchId,
          matchNum: Number(String(matchId).replace(/\D/g, "").slice(-4) || 1),
          matchStatus: method === "result" ? "11" : "Selling",
          sectionsNo999: method === "result" ? "1:0" : undefined,
        }],
      }],
    },
  },
});

const writeSnapshot = (file, snapshot) => {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, "utf8");
  fs.renameSync(temp, file);
};

const fullSnapshot = ({ capturedAt, cycle = "full-cycle-1", collectorState = null }) => {
  const endpoints = [
    endpoint({ method: "current", receivedAt: capturedAt, cycle, matchId: "full-current" }),
    endpoint({ method: "calculator", receivedAt: capturedAt, cycle, matchId: "full-calculator" }),
    endpoint({ method: "result", page: 1, receivedAt: capturedAt, cycle, matchId: "full-result-1" }),
    endpoint({ method: "result", page: 2, receivedAt: capturedAt, cycle, matchId: "full-result-2" }),
    endpoint({ method: "all", page: 1, receivedAt: capturedAt, cycle, matchId: "full-all-1" }),
  ];
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt,
    sourceCycleId: cycle,
    collectorProvenance: { sourceCycleId: cycle },
    producer: collectorState ? { collectorState } : undefined,
    maxAgeMinutes: 20,
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.reduce((sum, item) => sum + rowsIn(item), 0),
      methods: ["current", "calculator", "result", "all"],
    },
    endpoints,
    errors: [],
  };
};

const fastSnapshot = ({
  capturedAt,
  uploadCycle = "fast-upload-1",
  currentCycle = "fast-current-1",
  resultCycle = "fast-result-1",
  includeCalculator = true,
  calculatorError = false,
  collectorState = null,
}) => {
  const endpoints = [
    endpoint({ method: "current", receivedAt: capturedAt, cycle: currentCycle, matchId: "fast-current" }),
    ...(includeCalculator
      ? [endpoint({ method: "calculator", receivedAt: capturedAt, cycle: currentCycle, matchId: "fast-calculator" })]
      : []),
    endpoint({ method: "result", page: 1, receivedAt: capturedAt, cycle: resultCycle, matchId: "fast-result-1" }),
  ];
  const constituentCycleIds = [currentCycle, resultCycle].sort();
  return {
    version: 1,
    source: "sporttery-relay-snapshot",
    capturedAt,
    sourceCycleId: uploadCycle,
    sourceCycleKind: "upload-merge",
    uploadCycleId: uploadCycle,
    mergeCycleId: uploadCycle,
    constituentCycleIds,
    mixedCollectorSourceCycles: true,
    collectorProvenance: {
      sourceCycleId: uploadCycle,
      cycleKind: "upload-merge",
      constituentCycleIds,
      mixedCollectorSourceCycles: true,
      endpointObservationClocks: "preserved-from-constituent-collectors",
    },
    producer: collectorState ? { collectorState } : undefined,
    maxAgeMinutes: 20,
    summary: {
      endpoints: endpoints.length,
      usableEndpoints: endpoints.length,
      rows: endpoints.reduce((sum, item) => sum + rowsIn(item), 0),
      methods: [
        "current",
        ...(includeCalculator ? ["calculator"] : []),
        "result",
      ],
      fastResultLane: true,
    },
    endpoints,
    errors: calculatorError ? [{
      id: "calculator",
      method: "calculator",
      error: "official WAF 403",
      sourceCycleId: currentCycle,
      requestedAt: iso(Date.parse(capturedAt) - 100),
      receivedAt: capturedAt,
    }] : [],
  };
};

try {
  const now = Date.now();
  const staleClosedCollectorState = {
    version: 2,
    updatedAt: iso(now - 25 * 60_000),
    circuitState: "closed",
    consecutiveFullFailures: 0,
    lastFullAttemptAt: iso(now - 25 * 60_000),
    fullCircuit: {
      circuitState: "closed",
      consecutiveFullFailures: 0,
      lastFullAttemptAt: iso(now - 25 * 60_000),
    },
  };
  const freshOpenCollectorState = {
    version: 2,
    updatedAt: iso(now - 30_000),
    circuitState: "open",
    consecutiveFullFailures: 109,
    lastFullAttemptAt: iso(now - 30_000),
    lastFullFailedAt: iso(now - 30_000),
    fullCircuit: {
      circuitState: "open",
      consecutiveFullFailures: 109,
      lastFullAttemptAt: iso(now - 30_000),
      lastFullFailedAt: iso(now - 30_000),
    },
    lastFailure: {
      capturedAt: iso(now - 30_000),
      rows: 78,
      errors: 3,
      wafBlocked: true,
    },
  };
  writeSnapshot(fullPath, fullSnapshot({
    capturedAt: iso(now - 25 * 60_000),
    collectorState: staleClosedCollectorState,
  }));
  writeSnapshot(fastPath, fastSnapshot({
    capturedAt: iso(now - 30_000),
    collectorState: freshOpenCollectorState,
  }));
  const fullHashBefore = sha256File(fullPath);
  let baselineFingerprint = relaySnapshotFingerprint();
  const overlay = loadSportteryRelaySnapshot();
  const byKey = new Map((overlay?.entries || []).map((entry) => [endpointKey(entry), entry]));
  push("fresh fast current calculator overrides stale full current without flattening files", (
    overlay?.summary?.runtimeLaneOverlay?.version === "sporttery-relay-dual-file-v1"
    && byKey.get("current:1")?.sourceCycleId === "fast-current-1"
    && byKey.get("calculator:1")?.sourceCycleId === "fast-current-1"
  ), { summary: overlay?.summary || null });
  push("fast result page one overrides only the head while full archive pages remain", (
    byKey.get("result:1")?.sourceCycleId === "fast-result-1"
    && byKey.get("result:2")?.sourceCycleId === "full-cycle-1"
    && byKey.get("all:1")?.sourceCycleId === "full-cycle-1"
    && overlay?.summary?.runtimeLaneOverlay?.archiveEndpoints === 2
  ), { keys: Array.from(byKey.keys()).sort() });
  push("runtime overlay declares every constituent cycle and preserves endpoint clocks", (
    overlay?.payload?.sourceCycleKind === "runtime-lane-overlay"
    && overlay.payload.constituentCycleIds.includes("full-cycle-1")
    && overlay.payload.constituentCycleIds.includes("fast-current-1")
    && overlay.payload.constituentCycleIds.includes("fast-result-1")
    && Date.parse(byKey.get("current:1")?.receivedAt || "") >= now - 2 * 60_000
  ), { constituentCycleIds: overlay?.payload?.constituentCycleIds || [] });
  push("reading and composing the dual lanes never mutates the full archive file", (
    sha256File(fullPath) === fullHashBefore
  ), { fullSha256: fullHashBefore });
  push("fresh fast collector state prevents stale full closed state from hiding WAF failures", (
    overlay?.summary?.collectorState?.circuitState === "open"
    && overlay.summary.collectorState.consecutiveFullFailures === 109
    && overlay.summary.collectorState.lastFailure?.wafBlocked === true
    && overlay.payload?.producer?.collectorState?.circuitState === "open"
  ), { collectorState: overlay?.summary?.collectorState || null });

  writeSnapshot(fullPath, fullSnapshot({
    capturedAt: iso(now - 25 * 60_000),
    collectorState: {
      ...staleClosedCollectorState,
      updatedAt: iso(now + 10 * 60_000),
      lastFullAttemptAt: iso(now - 25 * 60_000),
    },
  }));
  const futureClockOverlay = loadSportteryRelaySnapshot();
  push("untrusted future collector clock cannot hide the fresher fast WAF state", (
    futureClockOverlay?.summary?.collectorState?.circuitState === "open"
    && futureClockOverlay.summary.collectorState.consecutiveFullFailures === 109
    && futureClockOverlay.summary.collectorState.lastFailure?.wafBlocked === true
  ), { collectorState: futureClockOverlay?.summary?.collectorState || null });

  writeSnapshot(fullPath, fullSnapshot({
    capturedAt: iso(now - 25 * 60_000),
    collectorState: staleClosedCollectorState,
  }));

  writeSnapshot(fastPath, fastSnapshot({
    capturedAt: iso(now - 20_000),
    uploadCycle: "fast-upload-current-only",
    currentCycle: "fast-current-only",
    resultCycle: "fast-result-current-only",
    includeCalculator: false,
    calculatorError: true,
    collectorState: freshOpenCollectorState,
  }));
  const currentOnlyOverlay = loadSportteryRelaySnapshot();
  const currentOnlyByKey = new Map(
    (currentOnlyOverlay?.entries || []).map((entry) => [endpointKey(entry), entry]),
  );
  push("fresh signed current-only fast lane remains usable when optional calculator is WAF-blocked", (
    currentOnlyOverlay?.summary?.runtimeLaneOverlay?.version === "sporttery-relay-dual-file-v1"
    && currentOnlyByKey.get("current:1")?.sourceCycleId === "fast-current-only"
    && !currentOnlyByKey.has("calculator:1")
    && currentOnlyOverlay?.summary?.currentLane?.stale === false
  ), {
    methods: currentOnlyOverlay?.summary?.methods || [],
    currentLane: currentOnlyOverlay?.summary?.currentLane || null,
  });

  const newerFullCollectorState = {
    ...staleClosedCollectorState,
    updatedAt: iso(now + 1_000),
    lastFullAttemptAt: iso(now + 1_000),
    fullCircuit: {
      ...staleClosedCollectorState.fullCircuit,
      lastFullAttemptAt: iso(now + 1_000),
    },
  };
  writeSnapshot(fullPath, fullSnapshot({
    capturedAt: iso(now),
    cycle: "full-cycle-newer-state",
    collectorState: newerFullCollectorState,
  }));
  const newerFullOverlay = loadSportteryRelaySnapshot();
  push("newer fresh full collector state remains authoritative over an older fast state", (
    newerFullOverlay?.summary?.collectorState?.circuitState === "closed"
    && newerFullOverlay.summary.collectorState.consecutiveFullFailures === 0
    && newerFullOverlay.payload?.producer?.collectorState?.lastFullAttemptAt
      === newerFullCollectorState.lastFullAttemptAt
  ), { collectorState: newerFullOverlay?.summary?.collectorState || null });
  writeSnapshot(fullPath, fullSnapshot({
    capturedAt: iso(now - 25 * 60_000),
    collectorState: staleClosedCollectorState,
  }));
  baselineFingerprint = relaySnapshotFingerprint();

  writeSnapshot(fastPath, fastSnapshot({
    capturedAt: iso(now - 25 * 60_000),
    uploadCycle: "fast-upload-stale",
    currentCycle: "fast-current-stale",
    resultCycle: "fast-result-stale",
  }));
  const staleOverlay = loadSportteryRelaySnapshot();
  const staleHistory = loadSportteryRelayHistorySnapshot();
  push("stale fast current fails closed while the independent full archive stays intact", (
    staleOverlay === null && sha256File(fullPath) === fullHashBefore
  ), { staleOverlay: Boolean(staleOverlay), fullSha256: sha256File(fullPath) });
  push("stale current market still exposes only the fresh immutable history lanes", (
    staleHistory?.summary?.historyOnly === true
    && staleHistory?.summary?.currentLane?.stale === true
    && staleHistory.entries.every((entry) => ["all", "result"].includes(methodOf(entry)))
    && staleHistory.entries.some((entry) => methodOf(entry) === "result")
  ), {
    methods: staleHistory?.summary?.methods || [],
    historyLane: staleHistory?.summary?.historyLane || null,
  });

  writeSnapshot(fastPath, fastSnapshot({
    capturedAt: iso(now),
    uploadCycle: "fast-upload-2-with-longer-token",
    currentCycle: "fast-current-2",
    resultCycle: "fast-result-2",
  }));
  const changedFingerprint = relaySnapshotFingerprint();
  push("worker wake fingerprint changes when only the fast file changes", (
    relaySnapshotChanged(baselineFingerprint, changedFingerprint)
    && baselineFingerprint.full.token === changedFingerprint.full.token
    && baselineFingerprint.fast.token !== changedFingerprint.fast.token
  ), { baseline: baselineFingerprint, changed: changedFingerprint });
  push("full and fast paths remain physically independent", (
    path.resolve(fullPath) !== path.resolve(fastPath)
    && fs.existsSync(fullPath)
    && fs.existsSync(fastPath)
  ));

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`${JSON.stringify({
    ok: failed.length === 0,
    verifier: "sporttery-relay-dual-file",
    checkedAt: new Date().toISOString(),
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
    checks,
  }, null, 2)}\n`);
  assert.equal(failed.length, 0);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
