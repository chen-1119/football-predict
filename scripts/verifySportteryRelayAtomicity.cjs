const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-relay-atomicity-"));
const activePath = path.join(tempDir, "active.json");
const trustedPath = path.join(tempDir, "last-good.json");
const fastPath = path.join(tempDir, "fast-lanes.json");

process.env.SPORTTERY_RELAY_SNAPSHOT_PATH = activePath;
process.env.SPORTTERY_RELAY_TRUSTED_SNAPSHOT_PATH = trustedPath;
process.env.SPORTTERY_RELAY_FAST_LANE_SNAPSHOT_PATH = fastPath;
process.env.SPORTTERY_RELAY_STATE_PATH = path.join(tempDir, "state.json");
process.env.SPORTTERY_RELAY_MIN_TRUSTED_ROWS = "100";
process.env.SPORTTERY_RELAY_MIN_TRUSTED_ENDPOINTS = "2";
process.env.SPORTTERY_RELAY_MAX_AGE_MINUTES = "20";
process.env.SPORTTERY_RELAY_HISTORY_MAX_AGE_MINUTES = "180";
process.env.SPORTTERY_RELAY_TRUSTED_FULL_RETENTION_MAX_AGE_MINUTES = "10080";

const {
  preserveAtomicTrustedSnapshotWithFastLane,
  snapshotForUpload,
  shouldPublishAtomicFastLaneUpload
} = require("./pushSportteryRelaySnapshot.cjs");
const {
  collectorErrorRecord
} = require("./collectSportterySnapshot.cjs");
const {
  snapshotCycleDetails,
  snapshotTrustDetails
} = require("./sportteryRelayCircuit.cjs");

const checks = [];
const check = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });
const nowMs = Date.now();
const oldAt = new Date(nowMs - 5 * 60_000).toISOString();
const fastAt = new Date(nowMs - 1_000).toISOString();
const oldCycle = "sporttery-relay:fixture-old-full-cycle";
const fastCycle = "sporttery-relay:fixture-fast-cycle";

const endpoint = ({ method, rows, cycle, at, page = null }) => ({
  id: page === null ? method : `method:${method}:${page}`,
  method,
  page,
  url: `https://webapi.sporttery.cn/fixture/${method}/${page ?? 0}`,
  requestedAt: at,
  receivedAt: new Date(Date.parse(at) + 10).toISOString(),
  fetchedAt: new Date(Date.parse(at) + 10).toISOString(),
  sourceCycleId: cycle,
  collectorProvenance: { sourceCycleId: cycle },
  collectorAttestation: {
    version: "sporttery-collector-attestation-v1",
    algorithm: "Ed25519",
    keyId: "fixture-existing-public-key-id",
    commitmentHash: `${method}-${page ?? 0}-commitment`,
    signature: `${method}-${page ?? 0}-existing-signature`
  },
  ok: true,
  rows,
  payload: {
    value: {
      matchInfoList: [{
        subMatchList: Array.from({ length: rows }, (_, index) => ({ matchId: `${method}-${page ?? 0}-${index}` }))
      }]
    }
  }
});

const envelope = ({ cycle, at, endpoints }) => ({
  version: 1,
  source: "sporttery-relay-snapshot",
  capturedAt: at,
  sourceCycleId: cycle,
  requestedAt: at,
  completedAt: new Date(Date.parse(at) + 100).toISOString(),
  provenanceVersion: 1,
  collectorProvenance: {
    sourceCycleId: cycle,
    requestedAt: at,
    completedAt: new Date(Date.parse(at) + 100).toISOString(),
    clock: "collector-owned-wall-clock"
  },
  maxAgeMinutes: 20,
  producer: { collectorAttestationKeyId: "fixture-existing-public-key-id" },
  summary: {
    endpoints: endpoints.length,
    usableEndpoints: endpoints.length,
    rows: endpoints.reduce((sum, item) => sum + item.rows, 0),
    errors: 0,
    methods: Array.from(new Set(endpoints.map((item) => item.method)))
  },
  endpoints,
  errors: []
});

const trusted = envelope({
  cycle: oldCycle,
  at: oldAt,
  endpoints: [
    endpoint({ method: "current", rows: 60, cycle: oldCycle, at: oldAt }),
    endpoint({ method: "calculator", rows: 60, cycle: oldCycle, at: oldAt }),
    endpoint({ method: "result", rows: 80, cycle: oldCycle, at: oldAt, page: 1 }),
    endpoint({ method: "all", rows: 80, cycle: oldCycle, at: oldAt, page: 1 })
  ]
});
const fast = envelope({
  cycle: fastCycle,
  at: fastAt,
  endpoints: [
    endpoint({ method: "current", rows: 23, cycle: fastCycle, at: fastAt }),
    endpoint({ method: "calculator", rows: 1, cycle: fastCycle, at: fastAt }),
    endpoint({ method: "result", rows: 80, cycle: fastCycle, at: fastAt, page: 1 })
  ]
});

try {
  fs.writeFileSync(trustedPath, `${JSON.stringify(trusted, null, 2)}\n`, "utf8");
  const preserved = preserveAtomicTrustedSnapshotWithFastLane(fast, {
    maxAgeMinutes: 20
  }, { includeRecentResults: true });
  const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
  const storedFast = JSON.parse(fs.readFileSync(fastPath, "utf8"));
  const activeCycle = snapshotCycleDetails(active);
  const fastCycleAudit = snapshotCycleDetails(storedFast);

  check("retained full snapshot stays one atomic collector cycle", (
    preserved?.atomic === true
    && activeCycle.atomic === true
    && activeCycle.sourceCycleId === oldCycle
    && activeCycle.attemptCycles.length === 1
  ), { preserved, activeCycle });
  check("fast current/result lane stays a separate atomic collector cycle", (
    fastCycleAudit.atomic === true
    && fastCycleAudit.sourceCycleId === fastCycle
    && fastCycleAudit.attemptCycles.length === 1
    && preserved?.fastLaneSourceCycleId === fastCycle
  ), { fastCycle: fastCycleAudit });
  check("existing Ed25519 attestation commitments are preserved byte-for-byte", (
    JSON.stringify(storedFast.endpoints.map((item) => item.collectorAttestation))
      === JSON.stringify(fast.endpoints.map((item) => item.collectorAttestation))
  ));

  const compact = snapshotForUpload(storedFast, "live").snapshot;
  check("compact upload is re-enveloped as one cycle without provenance laundering", (
    snapshotCycleDetails(compact).atomic === true
    && compact.sourceCycleId === fastCycle
    && compact.endpoints.every((item) => item.sourceCycleId === fastCycle)
  ), { compactCycle: snapshotCycleDetails(compact) });
  const partialWithTransportFailures = {
    ...fast,
    summary: {
      ...fast.summary,
      errors: 4,
    },
    errors: ["concern", "live", "result", "all"].map((method) => collectorErrorRecord({
      id: `method:${method}`,
      method,
      error: new Error(`fixture-${method}-transport-failure`),
      sourceCycleId: fastCycle,
    })),
  };
  const partialFailureCycle = snapshotCycleDetails(partialWithTransportFailures);
  check("transport failures retain the issuing cycle and cannot invalidate signed current lanes", (
    partialFailureCycle.atomic === true
    && partialFailureCycle.sourceCycleId === fastCycle
    && partialFailureCycle.missingCycleAttempts === 0
    && partialWithTransportFailures.errors.every((item) => item.sourceCycleId === fastCycle)
  ), {
    partialFailureCycle,
    errors: partialWithTransportFailures.errors,
  });
  const currentWithEmptyCalculator = envelope({
    cycle: fastCycle,
    at: fastAt,
    endpoints: [
      endpoint({ method: "current", rows: 23, cycle: fastCycle, at: fastAt }),
      endpoint({ method: "calculator", rows: 0, cycle: fastCycle, at: fastAt })
    ]
  });
  const compactWithEmptyCalculator = snapshotForUpload(currentWithEmptyCalculator, "live").snapshot;
  check("compact upload omits empty optional calculator lane without dropping signed current data", (
    compactWithEmptyCalculator.endpoints.length === 1
    && compactWithEmptyCalculator.endpoints[0]?.method === "current"
    && compactWithEmptyCalculator.endpoints[0]?.rows === 23
    && snapshotCycleDetails(compactWithEmptyCalculator).atomic === true
    && compactWithEmptyCalculator.sourceCycleId === fastCycle
  ), {
    endpointMethods: compactWithEmptyCalculator.endpoints.map((item) => item.method),
    rows: compactWithEmptyCalculator.endpoints.map((item) => item.rows),
    cycle: snapshotCycleDetails(compactWithEmptyCalculator)
  });
  check("production HTTP publication sends the separate atomic fast lane independently", (
    shouldPublishAtomicFastLaneUpload({
      atomicUploadSnapshotPath: fastPath,
      sshUpload: false,
      validate: false,
      dry: false
    }) === true
    && shouldPublishAtomicFastLaneUpload({
      atomicUploadSnapshotPath: fastPath,
      sshUpload: false,
      validate: true,
      dry: false
    }) === false
    && shouldPublishAtomicFastLaneUpload({
      atomicUploadSnapshotPath: fastPath,
      sshUpload: true,
      validate: false,
      dry: false
    }) === false
  ));

  fs.rmSync(trustedPath, { force: true });
  fs.rmSync(activePath, { force: true });
  const standaloneFast = preserveAtomicTrustedSnapshotWithFastLane(fast, {
    maxAgeMinutes: 20
  }, { includeRecentResults: true });
  check("atomic fast lane remains publishable without a local trusted full snapshot", (
    standaloneFast?.atomic === true
    && standaloneFast?.trustedFullAvailable === false
    && standaloneFast?.trustedFullRestored === false
    && standaloneFast?.uploadSnapshotPath === fastPath
    && fs.existsSync(fastPath)
    && !fs.existsSync(activePath)
  ), { standaloneFast });

  const mixed = {
    ...trusted,
    capturedAt: fastAt,
    endpoints: trusted.endpoints.map((item) => (
      ["current", "calculator"].includes(item.method)
        ? fast.endpoints.find((candidate) => candidate.method === item.method)
        : item
    ))
  };
  const mixedTrust = snapshotTrustDetails(mixed, { minRows: 100, minEndpoints: 2 });
  let mixedUploadRejected = false;
  try {
    snapshotForUpload(mixed, "live");
  } catch (error) {
    mixedUploadRejected = String(error?.message || error).includes("mixed-cycle compact relay upload");
  }
  check("old flat merge shape fails trust and upload closed", (
    mixedTrust.fullTrusted === false
    && mixedTrust.atomicCycle === false
    && mixedUploadRejected
  ), { mixedCycle: mixedTrust.cycle, mixedUploadRejected });

  const residue = fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp"));
  check("atomic replacements leave no staging residue", residue.length === 0, { residue });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  verifier: "sporttery-relay-cycle-atomicity",
  checkedAt: new Date().toISOString(),
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
