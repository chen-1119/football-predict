"use strict";

const assert = require("node:assert/strict");
const {
  REQUIRED_DECISION_FIELDS,
  REQUIRED_SETTLEMENT_FIELDS,
  evaluateCandidateProspectiveGoal,
} = require("./candidateProspectiveGoalProgress.cjs");

const fixture = () => ({
  state: "ACTIVE",
  chainValid: true,
  candidateRevisionId: "candidate@test",
  decisionRecord: {
    version: "candidate-atomic-decision-record-v3",
    validationVersion: "candidate-atomic-decision-validation-v2",
    dualMarketDecisionRecordVersion: "candidate-dual-market-decision-record-v1",
    formalMetricMarket: "HAD",
    companionMarket: "HHAD",
    decisionDeadlinePolicyVersion: "official-cutoff-first-v1",
    requiredFields: [...REQUIRED_DECISION_FIELDS],
    admittedRows: 0,
    atomicRows: 0,
    completeRows: 0,
    failedRows: 0,
    blockerCounts: {},
    coverage: 1,
    complete: true,
  },
  settlementRecord: {
    version: "candidate-official-settlement-record-v1",
    validationVersion: "candidate-official-settlement-validation-v1",
    requiredFields: [...REQUIRED_SETTLEMENT_FIELDS],
    rows: 0,
    completeRows: 0,
    failedRows: 0,
    blockerCounts: {},
    coverage: 1,
    complete: true,
  },
  cohort: {
    formal: {
      settled: 0,
      finalized: 0,
      denominatorReconciled: true,
    },
  },
  metrics: {
    formalRows: 0,
    brierImprovement: null,
    logLossImprovement: null,
    calendarWindows: 0,
    registeredCalendarWindows: 6,
    winningCalendarWindows: 0,
    calendarWindowGatePassed: false,
  },
  captureHeartbeat: {
    version: "prospective-deadline-heartbeat-v2",
    evaluatedAt: "2026-07-30T00:00:00.000Z",
    fresh: true,
    ok: true,
    skipped: false,
    dueMatches: 0,
    dueCaptureEventsAdded: 0,
    dueDecisionEventsAdded: 0,
    dueExclusionEventsAdded: 0,
    dueAtomicDecisionEventsAdded: 0,
    dueCaptureComplete: true,
    dueAtomicComplete: true,
    readiness: {
      version: "candidate-prospective-readiness-preview-v2",
      upcomingMatches: 13,
      evaluatedMatches: 13,
      detailedMatches: 13,
      rowsTruncated: 0,
      readyNow: 0,
      atomicReadyNow: 0,
      awaitingMarket: 9,
      blocked: 0,
      excluded: 4,
      readyInvariantOk: true,
      blockerCounts: {},
      excludedReasonCounts: {
        "eligible-deadline-snapshot-missing": 4,
      },
      nearestDeadlineAt: "2026-07-30T16:50:00.000Z",
      nearestFinalizationAt: "2026-07-30T16:52:00.000Z",
      deadlineBatches: [
        {
          version: "candidate-deadline-batch-summary-v1",
          deadlineAt: "2026-07-30T16:50:00.000Z",
          finalizationAt: "2026-07-30T16:52:00.000Z",
          phase: "upcoming",
          totalMatches: 13,
          actionableMatches: 9,
          readyNow: 0,
          awaitingMarket: 9,
          blocked: 0,
          excluded: 4,
          terminalDecisions: 0,
          terminalExclusions: 4,
          duplicateTerminalEvents: 0,
          terminalKeysWithDuplicates: 0,
          terminalMatches: 4,
          pendingMatches: 9,
          dueUnrecorded: 0,
          readyDueUnrecorded: 0,
          invariantOk: true,
        },
      ],
      nearestDeadlineBatch: {
        version: "candidate-deadline-batch-summary-v1",
        deadlineAt: "2026-07-30T16:50:00.000Z",
        finalizationAt: "2026-07-30T16:52:00.000Z",
        phase: "upcoming",
        totalMatches: 13,
        actionableMatches: 9,
        readyNow: 0,
        awaitingMarket: 9,
        blocked: 0,
        excluded: 4,
        terminalDecisions: 0,
        terminalExclusions: 4,
        duplicateTerminalEvents: 0,
        terminalKeysWithDuplicates: 0,
        terminalMatches: 4,
        pendingMatches: 9,
        dueUnrecorded: 0,
        readyDueUnrecorded: 0,
        invariantOk: true,
      },
      admission: {
        version: "candidate-prospective-admission-summary-v1",
        registryAvailable: true,
        reconciled: true,
        captureGap: false,
        dueUnrecorded: 0,
        readyDueUnrecorded: 0,
      },
    },
  },
});

const collecting = evaluateCandidateProspectiveGoal(fixture());
assert.equal(collecting.healthy, true);
assert.equal(collecting.complete, false);
assert.equal(collecting.status, "collecting");
assert.deepEqual(collecting.operationalBlockers, []);
assert.deepEqual(collecting.goalBlockers, [
  "calendar-window-gate-not-passed",
  "calendar-window-target-not-reached",
  "formal-finalized-target-not-reached",
  "formal-settled-target-not-reached",
  "winning-window-target-not-reached",
]);
assert.equal(collecting.thresholds.targetRows, 500);
assert.equal(collecting.thresholds.requiredWindows, 6);
assert.equal(collecting.thresholds.requiredWinningWindows, 5);
assert.ok(REQUIRED_DECISION_FIELDS.includes("dual-market-decision-record"));
assert.ok(REQUIRED_DECISION_FIELDS.includes("dual-market-decision-hash"));
assert.equal(collecting.readiness.excluded, 4);
assert.equal(collecting.readiness.captureGap, false);

const completeFixture = fixture();
Object.assign(completeFixture.decisionRecord, {
  admittedRows: 500,
  atomicRows: 500,
  completeRows: 500,
});
Object.assign(completeFixture.settlementRecord, {
  rows: 500,
  completeRows: 500,
});
Object.assign(completeFixture.cohort.formal, {
  settled: 500,
  finalized: 500,
});
Object.assign(completeFixture.metrics, {
  formalRows: 500,
  brierImprovement: 0.012,
  logLossImprovement: 0.008,
  calendarWindows: 6,
  winningCalendarWindows: 5,
  calendarWindowGatePassed: true,
});
const complete = evaluateCandidateProspectiveGoal(completeFixture);
assert.equal(complete.healthy, true);
assert.equal(complete.complete, true);
assert.equal(complete.status, "complete");
assert.deepEqual(complete.goalBlockers, []);
assert.equal(complete.formal.rows, 500);
assert.equal(complete.evaluation.calendarWindows, 6);
assert.equal(complete.evaluation.registeredWindows, 6);
assert.equal(complete.evaluation.winningWindows, 5);

const rawLedgerMetrics = structuredClone(completeFixture);
rawLedgerMetrics.metrics = {
  formalRows: 500,
  brierImprovement: 0.012,
  logLossImprovement: 0.008,
  windows: Array.from({ length: 6 }, (_, index) => ({
    index: index + 1,
    rows: 80 + index,
  })),
  windowEvaluation: {
    registeredWindows: 6,
    winningWindows: 5,
    passes: true,
  },
};
const rawLedgerMetricsResult = evaluateCandidateProspectiveGoal(
  rawLedgerMetrics,
);
assert.equal(rawLedgerMetricsResult.complete, true);
assert.equal(rawLedgerMetricsResult.evaluation.calendarWindows, 6);
assert.equal(rawLedgerMetricsResult.evaluation.registeredWindows, 6);
assert.equal(rawLedgerMetricsResult.evaluation.winningWindows, 5);
assert.equal(rawLedgerMetricsResult.evaluation.calendarWindowGatePassed, true);

const missingDualMarketContract = structuredClone(completeFixture);
missingDualMarketContract.decisionRecord.requiredFields =
  missingDualMarketContract.decisionRecord.requiredFields.filter(
    (field) => ![
      "dual-market-decision-record",
      "dual-market-decision-hash",
    ].includes(field),
  );
const missingDualMarketContractResult = evaluateCandidateProspectiveGoal(
  missingDualMarketContract,
);
assert.equal(missingDualMarketContractResult.healthy, false);
assert.ok(missingDualMarketContractResult.operationalBlockers.includes(
  "atomic-decision-contract-invalid",
));

const wrongDualMarketIdentity = structuredClone(completeFixture);
wrongDualMarketIdentity.decisionRecord.companionMarket = "HAD";
const wrongDualMarketIdentityResult = evaluateCandidateProspectiveGoal(
  wrongDualMarketIdentity,
);
assert.equal(wrongDualMarketIdentityResult.healthy, false);
assert.ok(wrongDualMarketIdentityResult.operationalBlockers.includes(
  "atomic-decision-contract-invalid",
));

const incompleteRegisteredWindows = structuredClone(completeFixture);
incompleteRegisteredWindows.metrics.registeredCalendarWindows = 5;
const incompleteRegisteredWindowsResult = evaluateCandidateProspectiveGoal(
  incompleteRegisteredWindows,
);
assert.equal(incompleteRegisteredWindowsResult.complete, false);
assert.ok(incompleteRegisteredWindowsResult.goalBlockers.includes(
  "registered-calendar-window-target-not-reached",
));

const admittedOnly = structuredClone(completeFixture);
Object.assign(admittedOnly.settlementRecord, {
  rows: 499,
  completeRows: 499,
});
Object.assign(admittedOnly.cohort.formal, {
  settled: 499,
  finalized: 500,
});
admittedOnly.metrics.formalRows = 499;
const admittedOnlyResult = evaluateCandidateProspectiveGoal(admittedOnly);
assert.equal(admittedOnlyResult.healthy, true);
assert.equal(admittedOnlyResult.complete, false);
assert.ok(admittedOnlyResult.goalBlockers.includes(
  "formal-settled-target-not-reached",
));

const fourWinningWindows = structuredClone(completeFixture);
fourWinningWindows.metrics.winningCalendarWindows = 4;
fourWinningWindows.metrics.calendarWindowGatePassed = false;
const fourWinningWindowsResult = evaluateCandidateProspectiveGoal(
  fourWinningWindows,
);
assert.equal(fourWinningWindowsResult.healthy, true);
assert.equal(fourWinningWindowsResult.complete, false);
assert.ok(fourWinningWindowsResult.goalBlockers.includes(
  "winning-window-target-not-reached",
));
assert.ok(fourWinningWindowsResult.goalBlockers.includes(
  "calendar-window-gate-not-passed",
));

const atomicMismatch = fixture();
atomicMismatch.decisionRecord.admittedRows = 1;
const atomicMismatchResult = evaluateCandidateProspectiveGoal(atomicMismatch);
assert.equal(atomicMismatchResult.healthy, false);
assert.equal(atomicMismatchResult.status, "unhealthy");
assert.ok(atomicMismatchResult.operationalBlockers.includes(
  "atomic-decision-record-incomplete",
));

const settlementMismatch = fixture();
settlementMismatch.settlementRecord.rows = 1;
const settlementMismatchResult = evaluateCandidateProspectiveGoal(
  settlementMismatch,
);
assert.equal(settlementMismatchResult.healthy, false);
assert.ok(settlementMismatchResult.operationalBlockers.includes(
  "official-settlement-record-incomplete",
));

const captureGap = fixture();
captureGap.captureHeartbeat.readiness.admission.captureGap = true;
captureGap.captureHeartbeat.readiness.admission.dueUnrecorded = 1;
const captureGapResult = evaluateCandidateProspectiveGoal(captureGap);
assert.equal(captureGapResult.healthy, false);
assert.ok(captureGapResult.operationalBlockers.includes(
  "candidate-admission-capture-gap",
));

const blockedUpcoming = fixture();
blockedUpcoming.captureHeartbeat.readiness.awaitingMarket = 8;
blockedUpcoming.captureHeartbeat.readiness.blocked = 1;
const blockedUpcomingResult = evaluateCandidateProspectiveGoal(blockedUpcoming);
assert.equal(blockedUpcomingResult.healthy, false);
assert.ok(blockedUpcomingResult.operationalBlockers.includes(
  "candidate-upcoming-blocked",
));

const readinessCoverageMismatch = fixture();
readinessCoverageMismatch.captureHeartbeat.readiness.detailedMatches = 12;
const readinessCoverageMismatchResult = evaluateCandidateProspectiveGoal(
  readinessCoverageMismatch,
);
assert.equal(readinessCoverageMismatchResult.healthy, false);
assert.ok(readinessCoverageMismatchResult.operationalBlockers.includes(
  "candidate-readiness-invariant-failed",
));

const atomicReadyMismatch = fixture();
atomicReadyMismatch.captureHeartbeat.readiness.readyNow = 1;
const atomicReadyMismatchResult = evaluateCandidateProspectiveGoal(
  atomicReadyMismatch,
);
assert.equal(atomicReadyMismatchResult.healthy, false);
assert.ok(atomicReadyMismatchResult.operationalBlockers.includes(
  "candidate-readiness-invariant-failed",
));

const deadlineBatchMismatch = fixture();
deadlineBatchMismatch.captureHeartbeat.readiness.deadlineBatches[0]
  .awaitingMarket = 8;
const deadlineBatchMismatchResult = evaluateCandidateProspectiveGoal(
  deadlineBatchMismatch,
);
assert.equal(deadlineBatchMismatchResult.healthy, false);
assert.ok(deadlineBatchMismatchResult.operationalBlockers.includes(
  "candidate-deadline-batch-invariant-failed",
));

const deadlineBatchMissing = fixture();
deadlineBatchMissing.captureHeartbeat.readiness.deadlineBatches = [];
deadlineBatchMissing.captureHeartbeat.readiness.nearestDeadlineBatch = null;
const deadlineBatchMissingResult = evaluateCandidateProspectiveGoal(
  deadlineBatchMissing,
);
assert.equal(deadlineBatchMissingResult.healthy, false);
assert.ok(deadlineBatchMissingResult.operationalBlockers.includes(
  "candidate-deadline-batch-invariant-failed",
));

const deadlineBatchDuplicate = fixture();
deadlineBatchDuplicate.captureHeartbeat.readiness.deadlineBatches[0]
  .duplicateTerminalEvents = 1;
deadlineBatchDuplicate.captureHeartbeat.readiness.deadlineBatches[0]
  .terminalKeysWithDuplicates = 1;
deadlineBatchDuplicate.captureHeartbeat.readiness.deadlineBatches[0]
  .invariantOk = false;
const deadlineBatchDuplicateResult = evaluateCandidateProspectiveGoal(
  deadlineBatchDuplicate,
);
assert.equal(deadlineBatchDuplicateResult.healthy, false);
assert.ok(deadlineBatchDuplicateResult.operationalBlockers.includes(
  "candidate-deadline-batch-invariant-failed",
));

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "candidate-prospective-goal-progress",
  assertions: 57,
  collecting: {
    status: collecting.status,
    thresholds: collecting.thresholds,
    goalBlockers: collecting.goalBlockers,
  },
  complete: {
    status: complete.status,
    formal: complete.formal,
    evaluation: complete.evaluation,
  },
  rejected: {
    atomicMismatch: atomicMismatchResult.operationalBlockers,
    settlementMismatch: settlementMismatchResult.operationalBlockers,
    captureGap: captureGapResult.operationalBlockers,
    blockedUpcoming: blockedUpcomingResult.operationalBlockers,
    readinessCoverageMismatch:
      readinessCoverageMismatchResult.operationalBlockers,
    atomicReadyMismatch: atomicReadyMismatchResult.operationalBlockers,
    deadlineBatchMismatch:
      deadlineBatchMismatchResult.operationalBlockers,
    deadlineBatchMissing:
      deadlineBatchMissingResult.operationalBlockers,
    deadlineBatchDuplicate:
      deadlineBatchDuplicateResult.operationalBlockers,
  },
}, null, 2)}\n`);
