"use strict";

const assert = require("node:assert/strict");
const {
  advanceCandidateHeartbeatContinuity,
  cleanState,
} = require("./prospectiveHeartbeatContinuity.cjs");

const rootA = "a".repeat(64);
const rootB = "b".repeat(64);
const rootC = "c".repeat(64);
const candidateRevisionId = "candidate@test";
const observation = (overrides = {}) => ({
  candidateRevisionId,
  evaluatedAt: "2026-07-30T14:00:00.000Z",
  rootHash: rootA,
  eventsAdded: 0,
  admittedRows: 0,
  atomicRows: 0,
  ...overrides,
});

const baseline = advanceCandidateHeartbeatContinuity(
  cleanState(),
  observation(),
);
assert.equal(baseline.violation, null);
assert.equal(baseline.lastRootHash, rootA);

const sameCachedHeartbeat = advanceCandidateHeartbeatContinuity(
  baseline,
  observation(),
);
assert.equal(sameCachedHeartbeat.violation, null);
assert.equal(sameCachedHeartbeat.transitions, 0);

const captured = advanceCandidateHeartbeatContinuity(
  sameCachedHeartbeat,
  observation({
    evaluatedAt: "2026-07-30T14:00:30.000Z",
    rootHash: rootB,
    eventsAdded: 8,
    admittedRows: 8,
    atomicRows: 8,
  }),
);
assert.equal(captured.violation, null);
assert.equal(captured.pendingEventProof, true);
assert.equal(captured.idempotencyVerified, false);
assert.equal(captured.eventTransitions, 1);

const repeated = advanceCandidateHeartbeatContinuity(
  captured,
  observation({
    evaluatedAt: "2026-07-30T14:01:00.000Z",
    rootHash: rootB,
    eventsAdded: 0,
    admittedRows: 8,
    atomicRows: 8,
  }),
);
assert.equal(repeated.violation, null);
assert.equal(repeated.pendingEventProof, false);
assert.equal(repeated.idempotencyVerified, true);
assert.equal(repeated.stableNoOpTransitions, 1);

const noOpMutation = advanceCandidateHeartbeatContinuity(
  repeated,
  observation({
    evaluatedAt: "2026-07-30T14:01:30.000Z",
    rootHash: rootC,
    eventsAdded: 0,
    admittedRows: 8,
    atomicRows: 8,
  }),
);
assert.equal(noOpMutation.violation?.code, "no-op-heartbeat-mutated-ledger");

const sameHeartbeatMutation = advanceCandidateHeartbeatContinuity(
  repeated,
  observation({
    evaluatedAt: repeated.lastEvaluatedAt,
    rootHash: rootC,
    eventsAdded: 0,
    admittedRows: 8,
    atomicRows: 8,
  }),
);
assert.equal(sameHeartbeatMutation.violation?.code, "same-heartbeat-state-drift");

const eventWithoutRootAdvance = advanceCandidateHeartbeatContinuity(
  repeated,
  observation({
    evaluatedAt: "2026-07-30T14:02:00.000Z",
    rootHash: rootB,
    eventsAdded: 1,
    admittedRows: 8,
    atomicRows: 8,
  }),
);
assert.equal(
  eventWithoutRootAdvance.violation?.code,
  "event-heartbeat-did-not-advance-root",
);

const atomicMismatch = advanceCandidateHeartbeatContinuity(
  repeated,
  observation({
    evaluatedAt: "2026-07-30T14:02:00.000Z",
    rootHash: rootC,
    eventsAdded: 1,
    admittedRows: 9,
    atomicRows: 8,
  }),
);
assert.equal(
  atomicMismatch.violation?.code,
  "heartbeat-continuity-atomic-row-mismatch",
);

const candidateReset = advanceCandidateHeartbeatContinuity(
  repeated,
  observation({
    candidateRevisionId: "candidate-next@test",
    evaluatedAt: "2026-07-31T14:00:00.000Z",
    rootHash: rootA,
    eventsAdded: 0,
    admittedRows: 0,
    atomicRows: 0,
  }),
);
assert.equal(candidateReset.violation, null);
assert.equal(candidateReset.candidateResets, 1);
assert.equal(candidateReset.idempotencyVerified, false);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "prospective-heartbeat-continuity",
  assertions: 22,
  repeated: {
    idempotencyVerified: repeated.idempotencyVerified,
    stableNoOpTransitions: repeated.stableNoOpTransitions,
    rootHash: repeated.lastRootHash,
    admittedRows: repeated.lastAdmittedRows,
    atomicRows: repeated.lastAtomicRows,
  },
  rejected: {
    noOpMutation: noOpMutation.violation?.code,
    sameHeartbeatMutation: sameHeartbeatMutation.violation?.code,
    eventWithoutRootAdvance: eventWithoutRootAdvance.violation?.code,
    atomicMismatch: atomicMismatch.violation?.code,
  },
}, null, 2)}\n`);
