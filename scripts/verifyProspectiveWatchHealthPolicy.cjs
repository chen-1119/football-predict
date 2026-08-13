"use strict";

const assert = require("node:assert/strict");
const {
  advanceWatchHealthState,
  cleanWatchHealthState,
} = require("./prospectiveWatchHealthPolicy.cjs");

const healthyObservation = (overrides = {}) => ({
  checkedAt: "2026-07-30T08:00:00.000Z",
  healthy: true,
  operationalBlockers: [],
  candidateState: "ACTIVE",
  chainValid: true,
  heartbeatSkipped: false,
  continuityViolation: null,
  ...overrides,
});

const baseline = advanceWatchHealthState(
  cleanWatchHealthState(),
  healthyObservation(),
);
assert.equal(baseline.lastSeverity, "healthy");
assert.equal(baseline.keepRunning, true);
assert.equal(baseline.shouldExit, false);
assert.equal(baseline.healthyPolls, 1);

const releaseTransition = advanceWatchHealthState(
  baseline,
  healthyObservation({
    checkedAt: "2026-07-30T08:00:20.000Z",
    healthy: false,
    operationalBlockers: ["candidate-capture-heartbeat-unhealthy"],
  }),
);
assert.equal(releaseTransition.lastSeverity, "transient");
assert.equal(
  releaseTransition.classification,
  "release-or-freshness-transient",
);
assert.equal(releaseTransition.keepRunning, true);
assert.equal(releaseTransition.consecutiveUnhealthyPolls, 1);

let prolongedTransition = releaseTransition;
for (let index = 0; index < 20; index += 1) {
  prolongedTransition = advanceWatchHealthState(
    prolongedTransition,
    healthyObservation({
      checkedAt: new Date(
        Date.parse("2026-07-30T08:00:40.000Z") + index * 20_000,
      ).toISOString(),
      healthy: false,
      operationalBlockers: ["candidate-capture-heartbeat-unhealthy"],
    }),
  );
}
assert.equal(prolongedTransition.lastSeverity, "transient");
assert.equal(prolongedTransition.keepRunning, true);
assert.equal(prolongedTransition.consecutiveUnhealthyPolls, 21);

const recovered = advanceWatchHealthState(
  prolongedTransition,
  healthyObservation({
    checkedAt: "2026-07-30T08:08:00.000Z",
  }),
);
assert.equal(recovered.lastSeverity, "healthy");
assert.equal(recovered.consecutiveUnhealthyPolls, 0);
assert.equal(recovered.recoveries, 1);
assert.equal(recovered.keepRunning, true);

const skippedHeartbeat = advanceWatchHealthState(
  recovered,
  healthyObservation({
    checkedAt: "2026-07-30T08:08:20.000Z",
    healthy: false,
    operationalBlockers: ["candidate-capture-heartbeat-unhealthy"],
    heartbeatSkipped: true,
  }),
);
assert.equal(skippedHeartbeat.lastSeverity, "critical");
assert.equal(skippedHeartbeat.classification, "operational-unhealthy");
assert.equal(skippedHeartbeat.keepRunning, true);

const captureGap = advanceWatchHealthState(
  skippedHeartbeat,
  healthyObservation({
    checkedAt: "2026-07-30T08:08:40.000Z",
    healthy: false,
    operationalBlockers: [
      "candidate-admission-capture-gap",
      "candidate-ready-due-unrecorded",
    ],
  }),
);
assert.equal(captureGap.lastSeverity, "critical");
assert.equal(captureGap.keepRunning, true);
assert.equal(captureGap.shouldExit, false);

const invalidChain = advanceWatchHealthState(
  captureGap,
  healthyObservation({
    checkedAt: "2026-07-30T08:09:00.000Z",
    healthy: false,
    operationalBlockers: ["candidate-prospective-chain-invalid"],
    chainValid: false,
  }),
);
assert.equal(invalidChain.lastSeverity, "critical");
assert.equal(invalidChain.keepRunning, true);

const continuityFailure = advanceWatchHealthState(
  invalidChain,
  healthyObservation({
    checkedAt: "2026-07-30T08:09:20.000Z",
    healthy: false,
    operationalBlockers: [],
    continuityViolation: "no-op-heartbeat-mutated-ledger",
  }),
);
assert.equal(continuityFailure.lastSeverity, "fatal");
assert.equal(continuityFailure.classification, "ledger-continuity-failure");
assert.equal(continuityFailure.keepRunning, false);
assert.equal(continuityFailure.shouldExit, true);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "prospective-watch-health-policy",
  assertions: 28,
  releaseTransition: {
    severity: releaseTransition.lastSeverity,
    classification: releaseTransition.classification,
    keepRunning: releaseTransition.keepRunning,
  },
  prolongedTransition: {
    consecutiveUnhealthyPolls:
      prolongedTransition.consecutiveUnhealthyPolls,
    keepRunning: prolongedTransition.keepRunning,
  },
  recovered: {
    recoveries: recovered.recoveries,
    lastSeverity: recovered.lastSeverity,
  },
  criticalMonitoring: {
    skippedHeartbeat: skippedHeartbeat.lastSeverity,
    captureGap: captureGap.lastSeverity,
    invalidChain: invalidChain.lastSeverity,
  },
  fatal: {
    classification: continuityFailure.classification,
    shouldExit: continuityFailure.shouldExit,
  },
}, null, 2)}\n`);
