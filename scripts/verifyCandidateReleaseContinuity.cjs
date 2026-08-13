"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  GENESIS_HASH,
  appendEvent,
  buildCandidateCommitment,
  buildWindowBoundaries,
  candidateInventory,
  createLedger,
  createRegistry,
  verifyRegistry,
} = require("./candidateProspectiveLedger.cjs");
const {
  SNAPSHOT_VERSION,
  registrySnapshot,
  verifyContinuity,
} = require("./candidateReleaseContinuity.cjs");

const AT = "2026-08-01T00:00:00.000Z";
const RELEASE_IDENTITY = {
  bundleSha256: "b".repeat(64),
  releaseSequence: 351,
};

const candidate = (id) => ({
  id,
  role: "shadow-model-candidate",
  featureSet: ["market"],
  weights: { market: 1, currentModel: 0, temperature: 1 },
});

const implementation = {
  commitmentVersion: "candidate-implementation-commitment-v1",
  semanticHashes: { evaluator: "release-continuity-fixture-v1" },
  sourceHashes: { fixture: "release-continuity-fixture-v1" },
  dependencyLockHash: "release-continuity-fixture-lock",
};

const makeRegistry = (id = "release-continuity-a") => {
  const definition = candidate(id);
  const inventory = candidateInventory([definition], implementation);
  const commitment = buildCandidateCommitment(definition, implementation);
  const registry = createRegistry(AT);
  const ledger = createLedger({
    commitment,
    inventory,
    evaluatedAt: AT,
    totalCandidatesEverTested: 1,
  });
  appendEvent(ledger, {
    type: "activation",
    recordedAt: AT,
    activationAt: AT,
    state: "ACTIVE",
    candidateRevisionId: commitment.candidateRevisionId,
    candidateSpecHash: commitment.candidateSpecHash,
    gateSpecHash: ledger.header.gateSpecHash,
    robustnessVersion: "release-continuity-fixture-v1",
    robustnessInventoryHash: inventory.hash,
    robustnessEvidenceHash: "a".repeat(64),
    windowBoundaries: buildWindowBoundaries(AT),
    shadowRowsBeforeActivationAreObservationalOnly: true,
    onlineEffect: false,
  });
  registry.activeLedgerId = ledger.ledgerId;
  registry.candidateRegistry.push({
    candidateRevisionId: commitment.candidateRevisionId,
    baseCandidateId: commitment.baseCandidateId,
    candidateSpecHash: commitment.candidateSpecHash,
    firstSeenAt: AT,
  });
  registry.ledgers.push(ledger);
  assert.equal(verifyRegistry(registry).valid, true);
  return registry;
};

const activeLedger = (registry) => registry.ledgers.find((ledger) => (
  ledger.ledgerId === registry.activeLedgerId
));

const clone = (value) => JSON.parse(JSON.stringify(value));

const baselineRegistry = makeRegistry();
const baseline = registrySnapshot(baselineRegistry, { capturedAt: AT });
assert.equal(baseline.version, SNAPSHOT_VERSION);
assert.equal(baseline.chainValid, true);
assert.equal(baseline.rootHash, baseline.canonicalEventHashSequence.at(-1));

const appendedRegistry = clone(baselineRegistry);
appendEvent(activeLedger(appendedRegistry), {
  type: "release-continuity-observation",
  recordedAt: "2026-08-01T00:01:00.000Z",
  note: "a valid post-snapshot append remains continuous",
});
const passing = verifyContinuity(baseline, appendedRegistry, {
  checkedAt: "2026-08-01T00:02:00.000Z",
});
assert.equal(passing.ok, true);
assert.equal(passing.eventsAdded, 1);
assert.deepEqual(passing.blockers, []);

const driftedRevision = makeRegistry("release-continuity-b");
const revisionFailure = verifyContinuity(baseline, driftedRevision, {
  checkedAt: "2026-08-01T00:03:00.000Z",
});
assert.equal(revisionFailure.ok, false);
assert.ok(revisionFailure.blockers.includes("candidate-revision-id-changed"));
assert.ok(revisionFailure.blockers.includes("active-ledger-id-changed"));

const tamperedPrefixRegistry = clone(baselineRegistry);
const tamperedLedger = activeLedger(tamperedPrefixRegistry);
const rebuiltPayloads = tamperedLedger.events.map((event) => {
  const { sequence, previousHash, eventHash, ...payload } = event;
  return payload;
});
rebuiltPayloads[0].recordedAt = "2026-08-01T00:00:01.000Z";
tamperedLedger.events = [];
tamperedLedger.rootHash = GENESIS_HASH;
for (const payload of rebuiltPayloads) appendEvent(tamperedLedger, payload);
assert.equal(verifyRegistry(tamperedPrefixRegistry).valid, true);
const prefixFailure = verifyContinuity(baseline, tamperedPrefixRegistry, {
  checkedAt: "2026-08-01T00:04:00.000Z",
});
assert.equal(prefixFailure.ok, false);
assert.ok(prefixFailure.blockers.includes("event-prefix-mismatch:1"));

const inflatedBaseline = clone(baseline);
inflatedBaseline.counts.admitted += 1;
const countFailure = verifyContinuity(inflatedBaseline, baselineRegistry, {
  checkedAt: "2026-08-01T00:05:00.000Z",
});
assert.equal(countFailure.ok, false);
assert.ok(countFailure.blockers.includes("admitted-count-regressed"));

const candidateRegistryRegression = clone(baselineRegistry);
candidateRegistryRegression.candidateRegistry = [];
assert.equal(verifyRegistry(candidateRegistryRegression).valid, true);
const candidateRegistryFailure = verifyContinuity(baseline, candidateRegistryRegression, {
  checkedAt: "2026-08-01T00:05:30.000Z",
});
assert.equal(candidateRegistryFailure.ok, false);
assert.ok(candidateRegistryFailure.blockers.includes("candidate-registry-regressed"));

const releaseBaseline = registrySnapshot(baselineRegistry, {
  capturedAt: AT,
  releaseIdentity: RELEASE_IDENTITY,
});
const releaseIdentityFailure = verifyContinuity(releaseBaseline, baselineRegistry, {
  checkedAt: "2026-08-01T00:05:45.000Z",
  releaseIdentity: {
    ...RELEASE_IDENTITY,
    releaseSequence: RELEASE_IDENTITY.releaseSequence + 1,
  },
});
assert.equal(releaseIdentityFailure.ok, false);
assert.ok(releaseIdentityFailure.blockers.includes("baseline-release-identity-mismatch"));

const rootDriftBaseline = clone(baseline);
rootDriftBaseline.rootHash = "f".repeat(64);
const rootFailure = verifyContinuity(rootDriftBaseline, baselineRegistry, {
  checkedAt: "2026-08-01T00:06:00.000Z",
});
assert.equal(rootFailure.ok, false);
assert.ok(rootFailure.blockers.includes("baseline-root-sequence-mismatch"));
assert.ok(rootFailure.blockers.includes("root-changed-without-new-events"));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-release-continuity-"));
try {
  const registryPath = path.join(tempRoot, "registry.json");
  const snapshotPath = path.join(tempRoot, "snapshot.json");
  const reportPath = path.join(tempRoot, "report.json");
  fs.writeFileSync(registryPath, `${JSON.stringify(baselineRegistry, null, 2)}\n`);
  const snapshotRun = spawnSync(process.execPath, [
    path.join(__dirname, "candidateReleaseContinuity.cjs"),
    "snapshot",
    "--registry", registryPath,
    "--output", snapshotPath,
    "--at", AT,
    "--bundle-sha256", RELEASE_IDENTITY.bundleSha256,
    "--release-sequence", String(RELEASE_IDENTITY.releaseSequence),
  ], { encoding: "utf8" });
  assert.equal(snapshotRun.status, 0, snapshotRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).version, SNAPSHOT_VERSION);
  const verifyRun = spawnSync(process.execPath, [
    path.join(__dirname, "candidateReleaseContinuity.cjs"),
    "verify",
    "--registry", registryPath,
    "--snapshot", snapshotPath,
    "--output", reportPath,
    "--at", "2026-08-01T00:07:00.000Z",
    "--bundle-sha256", RELEASE_IDENTITY.bundleSha256,
    "--release-sequence", String(RELEASE_IDENTITY.releaseSequence),
  ], { encoding: "utf8" });
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).ok, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(reportPath, "utf8")).releaseIdentity,
    RELEASE_IDENTITY,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  verifier: "candidate-release-continuity",
  assertions: {
    validAppendPasses: passing.ok,
    revisionDriftRejected: revisionFailure.blockers.includes("candidate-revision-id-changed"),
    prefixTamperRejected: prefixFailure.blockers.includes("event-prefix-mismatch:1"),
    countRegressionRejected: countFailure.blockers.includes("admitted-count-regressed"),
    candidateRegistryRegressionRejected: candidateRegistryFailure.blockers.includes("candidate-registry-regressed"),
    releaseIdentityMismatchRejected: releaseIdentityFailure.blockers.includes("baseline-release-identity-mismatch"),
    noEventRootDriftRejected: rootFailure.blockers.includes("root-changed-without-new-events"),
    cliSnapshotAndVerifyPass: true,
  },
}, null, 2));
