"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {
  assessSqliteStorageStability,
  candidateProspectiveCaptureRuntimeStatus,
  candidateProspectiveProgressStatus,
  candidateProspectiveRuntimeState,
  candidateProspectiveTemporalRuntimeState,
} = require("./checkServerRuntime.cjs");

// Execute the actual health-to-monitor block, including the missing-capability
// path used while an older signed release is still serving production.
const runtimeSource = fs.readFileSync(path.join(__dirname, "checkServerRuntime.cjs"), "utf8");
const storageStart = runtimeSource.indexOf("  const executionCapture = storage.predictionExecutionCapture || null;");
const storageEnd = runtimeSource.indexOf("  const servingMode", storageStart);
assert.ok(storageStart >= 0 && storageEnd > storageStart);
let storageHealthAssertions = 1;
for (const [value, expected] of [[{ status: "ok" }, "ok"], [{ status: "watch" }, "watch"],
  [{ status: "failed" }, "failed"], [null, "watch"], [{ status: "unrecognized" }, "watch"]]) {
  let observed;
  vm.runInNewContext(runtimeSource.slice(storageStart, storageEnd), {
    storage: { predictionExecutionCapture: value }, addCheck: (name, status, details) => { observed = { name, status, details }; },
  }, { timeout: 1000 });
  assert.equal(observed.name, "prediction execution evidence storage");
  assert.equal(observed.status, expected); storageHealthAssertions += 2;
}

const gib = 1024 * 1024 * 1024;
const stableLargeSqlite = assessSqliteStorageStability({
  bytes: 2.4 * gib,
  warnBytes: gib,
  failBytes: 2 * gib,
  freeRatio: 0.02,
  freeRatioWarn: 0.35,
  schemaVersion: "football-sqlite-v2-incremental",
  previousBytes: 2.39 * gib,
  previousCheckedAt: "2026-08-17T16:30:00.000Z",
  checkedAt: "2026-08-17T16:35:00.000Z",
});
assert.equal(stableLargeSqlite.status, "watch");
assert.equal(stableLargeSqlite.runawayGrowth, false);
assert.ok(stableLargeSqlite.reasons.includes("file-size-over-fail-budget"));

const runawaySqlite = assessSqliteStorageStability({
  bytes: 3 * gib,
  warnBytes: gib,
  failBytes: 2 * gib,
  freeRatio: 0.02,
  freeRatioWarn: 0.35,
  schemaVersion: "football-sqlite-v2-incremental",
  previousBytes: 2.4 * gib,
  previousCheckedAt: "2026-08-17T16:30:00.000Z",
  checkedAt: "2026-08-17T16:35:00.000Z",
});
assert.equal(runawaySqlite.status, "failed");
assert.equal(runawaySqlite.runawayGrowth, true);
assert.ok(runawaySqlite.reasons.includes("runaway-growth"));

const distantHeartbeatOnlyDegradation = {
  ok: false,
  blockers: [
    "candidate-capture-heartbeat-stale",
    "candidate-heartbeat-preemptive-budget-missed",
  ],
  heartbeat: {
    dueMatches: 0,
    dueCaptureComplete: true,
    dueAtomicComplete: true,
    nearestFinalizationAt: "2026-08-18T18:52:00.000Z",
  },
  admission: { dueUnrecorded: 0, readyDueUnrecorded: 0 },
};
assert.equal(candidateProspectiveCaptureRuntimeStatus(
  distantHeartbeatOnlyDegradation,
  Date.parse("2026-08-17T16:45:00.000Z"),
  600,
), "watch");
const nearDeadlineDegradation = structuredClone(distantHeartbeatOnlyDegradation);
nearDeadlineDegradation.heartbeat.nearestFinalizationAt = "2026-08-17T16:50:00.000Z";
assert.equal(candidateProspectiveCaptureRuntimeStatus(
  nearDeadlineDegradation,
  Date.parse("2026-08-17T16:45:00.000Z"),
  600,
), "failed");
const captureGapDegradation = structuredClone(distantHeartbeatOnlyDegradation);
captureGapDegradation.blockers.push("candidate-admission-capture-gap");
assert.equal(candidateProspectiveCaptureRuntimeStatus(
  captureGapDegradation,
  Date.parse("2026-08-17T16:45:00.000Z"),
  600,
), "failed");

const healthyFixture = {
  publicScorecard: {
    shadowTracks: {
      CANDIDATE_PROSPECTIVE: {
        state: "ACTIVE",
        chainValid: true,
        candidateRevisionId: "candidate@test",
        decisionRecord: {
          version: "candidate-atomic-decision-record-v3",
          validationVersion: "candidate-atomic-decision-validation-v2",
          dualMarketDecisionRecordVersion: "candidate-dual-market-decision-record-v1",
          formalMetricMarket: "HAD",
          companionMarket: "HHAD",
          requiredFields: [
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
          ],
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
          requiredFields: [
            "decision-link",
            "official-result-identity",
            "score-outcome-consistency",
            "result-observation-clock",
            "result-provenance-hash",
          ],
          rows: 0,
          completeRows: 0,
          failedRows: 0,
          blockerCounts: {},
          coverage: 1,
          complete: true,
        },
        metrics: {
          formalRows: 0,
          calendarWindows: 0,
          registeredCalendarWindows: 6,
          winningCalendarWindows: 0,
          requiredWinningCalendarWindows: 5,
          windowEvaluation: {
            registeredWindows: 6,
            eligibleWindows: 0,
            winningWindows: 0,
            requiredWindows: 6,
            requiredWinningWindows: 5,
          },
        },
        promotionReviewReady: false,
        captureHeartbeat: {
          version: "prospective-deadline-heartbeat-v2",
          evaluatedAt: "2026-07-29T04:31:39.375Z",
          fresh: true,
          ok: true,
          skipped: false,
          reason: "settlement-heartbeat",
          dueMatches: 0,
          dueCaptureEventsAdded: 0,
          dueDecisionEventsAdded: 0,
          dueExclusionEventsAdded: 0,
          dueAtomicDecisionEventsAdded: 0,
          dueCaptureComplete: true,
          dueAtomicComplete: true,
          readiness: {
            version: "candidate-prospective-readiness-preview-v2",
            captureFinalizationPolicyVersion: "deadline-evidence-grace-v1",
            captureFinalizationGraceSeconds: 120,
            previewLimit: 16,
            evaluatedMatches: 12,
            detailedMatches: 12,
            rowsTruncated: 0,
            upcomingMatches: 12,
            readyNow: 6,
            atomicReadyNow: 6,
            awaitingMarket: 6,
            blocked: 0,
            excluded: 0,
            readyInvariantOk: true,
            awaitingReasonCounts: {
              "official-had-market-not-published": 6,
            },
            marketCoverage: {
              version: "candidate-official-market-coverage-preview-v1",
              evaluatedMatches: 12,
              decisionSnapshotObservedMatches: 12,
              officialHadPublishedMatches: 6,
              strictMarketEvidenceCompleteMatches: 6,
              atomicReadyMatches: 6,
              awaitingUnpublishedMatches: 6,
              awaitingSnapshotMissingMatches: 0,
              publishedChainGapMatches: 0,
              terminalExcludedMatches: 0,
              awaitingClassifiedMatches: 6,
              awaitingClassificationComplete: true,
              marketStateCounts: {
                "atomic-ready": 6,
                "official-had-market-not-published": 6,
              },
            },
            nearestDeadlineAt: "2026-07-29T14:00:00.000Z",
            nearestFinalizationAt: "2026-07-29T14:02:00.000Z",
            nearestStatus: "ready-now",
            nearestDeadlineBatch: {
              version: "candidate-deadline-batch-summary-v1",
              deadlineAt: "2026-07-29T14:00:00.000Z",
              finalizationAt: "2026-07-29T14:02:00.000Z",
              phase: "upcoming",
              totalMatches: 12,
              actionableMatches: 12,
              readyNow: 6,
              awaitingMarket: 6,
              blocked: 0,
              excluded: 0,
              terminalDecisions: 0,
              terminalExclusions: 0,
              duplicateTerminalEvents: 0,
              terminalKeysWithDuplicates: 0,
              terminalMatches: 0,
              pendingMatches: 12,
              dueUnrecorded: 0,
              readyDueUnrecorded: 0,
              invariantOk: true,
            },
            admission: {
              version: "candidate-prospective-admission-summary-v1",
              registryAvailable: true,
              reconciled: true,
              captureGap: false,
              expectedRows: 12,
              admitted: 0,
              excluded: 0,
              pendingDeadline: 12,
              dueUnrecorded: 0,
              readyDueUnrecorded: 0,
            },
          },
        },
      },
    },
  },
};

const healthy = candidateProspectiveRuntimeState(healthyFixture);
assert.equal(healthy.ok, true);
assert.deepEqual(healthy.blockers, []);
assert.equal(healthy.progress.formalRows, 0);
assert.equal(healthy.progress.requiredRows, 500);
assert.equal(healthy.progress.requiredWinningWindows, 5);
assert.equal(
  candidateProspectiveProgressStatus(healthy),
  "watch",
  "an operational ledger that is still collecting 500 rows is a watch state",
);
assert.equal(
  candidateProspectiveProgressStatus({
    ok: true,
    progress: { promotionReviewReady: true },
  }),
  "ok",
);
assert.equal(
  candidateProspectiveProgressStatus({
    ok: false,
    progress: { promotionReviewReady: false },
  }),
  "failed",
);

const preemptiveBudgetHealthy = structuredClone(healthyFixture);
Object.assign(
  preemptiveBudgetHealthy.publicScorecard.shadowTracks
    .CANDIDATE_PROSPECTIVE.captureHeartbeat,
  {
    scheduleVersion: "candidate-heartbeat-preemptive-schedule-v1",
    scheduleMode: "preemptive-evaluated-at",
    nextAttemptBudgetFits: true,
  },
);
assert.equal(candidateProspectiveRuntimeState(preemptiveBudgetHealthy).ok, true);

const preemptiveBudgetMissed = structuredClone(preemptiveBudgetHealthy);
preemptiveBudgetMissed.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.nextAttemptBudgetFits = false;
const preemptiveBudgetMissedState =
  candidateProspectiveRuntimeState(preemptiveBudgetMissed);
assert.equal(preemptiveBudgetMissedState.ok, false);
assert.ok(preemptiveBudgetMissedState.blockers.includes(
  "candidate-heartbeat-preemptive-budget-missed",
));

const missingMarketCoverage = structuredClone(healthyFixture);
delete missingMarketCoverage.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.readiness.marketCoverage;
const missingMarketCoverageState =
  candidateProspectiveRuntimeState(missingMarketCoverage);
assert.equal(missingMarketCoverageState.ok, false);
assert.ok(missingMarketCoverageState.blockers.includes(
  "candidate-market-coverage-missing-or-invalid",
));

const publishedMarketChainGap = structuredClone(healthyFixture);
publishedMarketChainGap.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.readiness
  .marketCoverage.publishedChainGapMatches = 1;
const publishedMarketChainGapState =
  candidateProspectiveRuntimeState(publishedMarketChainGap);
assert.equal(publishedMarketChainGapState.ok, false);
assert.ok(publishedMarketChainGapState.blockers.includes(
  "candidate-published-market-chain-gap",
));

const incompleteAwaitingClassification = structuredClone(healthyFixture);
incompleteAwaitingClassification.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.readiness
  .marketCoverage.awaitingClassifiedMatches = 5;
const incompleteAwaitingClassificationState =
  candidateProspectiveRuntimeState(incompleteAwaitingClassification);
assert.equal(incompleteAwaitingClassificationState.ok, false);
assert.ok(incompleteAwaitingClassificationState.blockers.includes(
  "candidate-awaiting-market-classification-incomplete",
));

const marketCoverageDenominatorMismatch = structuredClone(healthyFixture);
marketCoverageDenominatorMismatch.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.readiness
  .marketCoverage.marketStateCounts["atomic-ready"] = 5;
const marketCoverageDenominatorMismatchState =
  candidateProspectiveRuntimeState(marketCoverageDenominatorMismatch);
assert.equal(marketCoverageDenominatorMismatchState.ok, false);
assert.ok(marketCoverageDenominatorMismatchState.blockers.includes(
  "candidate-market-coverage-denominator-mismatch",
));

const healthyTemporalFixture = {
  candidateCaptureAudit: {
    temporalStatus: {
      version: "candidate-prospective-temporal-audit-v1",
      evaluatedAt: "2026-07-30T22:24:33.977Z",
      activeLedgerPresent: true,
      admittedRows: 5,
      settledRows: 0,
      pendingRows: 5,
      futureKickoffRows: 1,
      kickoffPassedRows: 4,
      awaitingOfficialFinalRows: 1,
      officialVoidRows: 0,
      officialResultRecordMissingRows: 0,
      officialFinishedIneligibleRows: 3,
      officialFinishedIneligibleReasonCounts: {
        "not-official-sporttery-final": 3,
        "result-promotion-ineligible": 3,
      },
      officialFinishedIneligiblePrimaryReasonCounts: {
        "not-official-sporttery-final": 3,
      },
      officialFinishedEligibleUnsettledRows: 0,
      invalidKickoffRows: 0,
      settlementWorkerAttentionRequired: false,
      denominatorReconciled: true,
      pendingKickoffRange: {
        earliest: "2026-07-30T17:00:00.000Z",
        latest: "2026-07-30T22:30:00.000Z",
      },
    },
    prospectiveAudit: {
      cohort: {
        formal: {
          admitted: 5,
          settled: 0,
          pending: 5,
        },
      },
    },
  },
};
const healthyTemporal = candidateProspectiveTemporalRuntimeState(
  healthyTemporalFixture,
);
assert.equal(healthyTemporal.ok, true);
assert.deepEqual(healthyTemporal.blockers, []);
assert.equal(healthyTemporal.officialFinishedIneligibleRows, 3);
assert.deepEqual(
  healthyTemporal.officialFinishedIneligiblePrimaryReasonCounts,
  { "not-official-sporttery-final": 3 },
);

const missedSettlement = structuredClone(healthyTemporalFixture);
Object.assign(missedSettlement.candidateCaptureAudit.temporalStatus, {
  officialFinishedIneligibleRows: 2,
  officialFinishedIneligibleReasonCounts: {
    "not-official-sporttery-final": 2,
    "result-promotion-ineligible": 2,
  },
  officialFinishedIneligiblePrimaryReasonCounts: {
    "not-official-sporttery-final": 2,
  },
  officialFinishedEligibleUnsettledRows: 1,
  settlementWorkerAttentionRequired: true,
});
const missedSettlementState = candidateProspectiveTemporalRuntimeState(
  missedSettlement,
);
assert.equal(missedSettlementState.ok, false);
assert.ok(missedSettlementState.blockers.includes(
  "candidate-official-result-settlement-missed",
));

const missingReadModel = structuredClone(healthyTemporalFixture);
Object.assign(missingReadModel.candidateCaptureAudit.temporalStatus, {
  officialResultRecordMissingRows: 1,
  officialFinishedIneligibleRows: 2,
  officialFinishedIneligibleReasonCounts: {
    "not-official-sporttery-final": 2,
    "result-promotion-ineligible": 2,
  },
  officialFinishedIneligiblePrimaryReasonCounts: {
    "not-official-sporttery-final": 2,
  },
});
const missingReadModelState = candidateProspectiveTemporalRuntimeState(
  missingReadModel,
);
assert.equal(missingReadModelState.ok, false);
assert.ok(missingReadModelState.blockers.includes(
  "candidate-settlement-read-model-row-missing",
));

const temporalDenominatorMismatch = structuredClone(healthyTemporalFixture);
temporalDenominatorMismatch.candidateCaptureAudit.temporalStatus
  .futureKickoffRows = 0;
const temporalDenominatorMismatchState =
  candidateProspectiveTemporalRuntimeState(temporalDenominatorMismatch);
assert.equal(temporalDenominatorMismatchState.ok, false);
assert.ok(temporalDenominatorMismatchState.blockers.includes(
  "candidate-temporal-pending-denominator-mismatch",
));

const temporalCohortMismatch = structuredClone(healthyTemporalFixture);
temporalCohortMismatch.candidateCaptureAudit.prospectiveAudit
  .cohort.formal.pending = 4;
const temporalCohortMismatchState = candidateProspectiveTemporalRuntimeState(
  temporalCohortMismatch,
);
assert.equal(temporalCohortMismatchState.ok, false);
assert.ok(temporalCohortMismatchState.blockers.includes(
  "candidate-temporal-cohort-mismatch",
));

const temporalReasonCountMismatch = structuredClone(healthyTemporalFixture);
temporalReasonCountMismatch.candidateCaptureAudit.temporalStatus
  .officialFinishedIneligiblePrimaryReasonCounts[
    "not-official-sporttery-final"
  ] = 2;
const temporalReasonCountMismatchState =
  candidateProspectiveTemporalRuntimeState(temporalReasonCountMismatch);
assert.equal(temporalReasonCountMismatchState.ok, false);
assert.ok(temporalReasonCountMismatchState.blockers.includes(
  "candidate-temporal-ineligible-reason-count-mismatch",
));

const temporalNullCount = structuredClone(healthyTemporalFixture);
temporalNullCount.candidateCaptureAudit.temporalStatus.pendingRows = null;
const temporalNullCountState =
  candidateProspectiveTemporalRuntimeState(temporalNullCount);
assert.equal(temporalNullCountState.ok, false);
assert.ok(temporalNullCountState.blockers.includes(
  "candidate-temporal-audit-count-invalid",
));

const missingTemporal = candidateProspectiveTemporalRuntimeState({});
assert.equal(missingTemporal.ok, false);
assert.ok(missingTemporal.blockers.includes(
  "candidate-temporal-audit-missing-or-invalid",
));

const atomicMismatch = structuredClone(healthyFixture);
atomicMismatch.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.readiness.atomicReadyNow = 5;
const atomicMismatchState = candidateProspectiveRuntimeState(atomicMismatch);
assert.equal(atomicMismatchState.ok, false);
assert.ok(atomicMismatchState.blockers.includes("candidate-atomic-ready-count-mismatch"));

const semanticDecisionFailure = structuredClone(healthyFixture);
const failedDecisionRecord = semanticDecisionFailure.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.decisionRecord;
failedDecisionRecord.admittedRows = 1;
failedDecisionRecord.atomicRows = 0;
failedDecisionRecord.completeRows = 0;
failedDecisionRecord.failedRows = 1;
failedDecisionRecord.coverage = 0;
failedDecisionRecord.complete = false;
failedDecisionRecord.blockerCounts = { "odds-triplet-invalid": 1 };
const semanticDecisionFailureState =
  candidateProspectiveRuntimeState(semanticDecisionFailure);
assert.equal(semanticDecisionFailureState.ok, false);
assert.ok(semanticDecisionFailureState.blockers.includes(
  "atomic-decision-semantic-validation-failed",
));

const cappedDenominator = structuredClone(healthyFixture);
cappedDenominator.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.readiness.evaluatedMatches = 20;
cappedDenominator.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.readiness.detailedMatches = 16;
cappedDenominator.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.readiness.rowsTruncated = 4;
const cappedDenominatorState = candidateProspectiveRuntimeState(cappedDenominator);
assert.equal(cappedDenominatorState.ok, false);
assert.ok(cappedDenominatorState.blockers.includes(
  "candidate-readiness-full-coverage-denominator-mismatch",
));

const captureGap = structuredClone(healthyFixture);
const captureGapAdmission = captureGap.publicScorecard.shadowTracks
  .CANDIDATE_PROSPECTIVE.captureHeartbeat.readiness.admission;
captureGapAdmission.captureGap = true;
captureGapAdmission.dueUnrecorded = 1;
captureGapAdmission.readyDueUnrecorded = 1;
const captureGapState = candidateProspectiveRuntimeState(captureGap);
assert.equal(captureGapState.ok, false);
assert.ok(captureGapState.blockers.includes("candidate-admission-capture-gap"));
assert.ok(captureGapState.blockers.includes("candidate-due-unrecorded"));
assert.ok(captureGapState.blockers.includes("candidate-ready-due-unrecorded"));

const skippedHeartbeat = structuredClone(healthyFixture);
skippedHeartbeat.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.skipped = true;
const skippedHeartbeatState = candidateProspectiveRuntimeState(skippedHeartbeat);
assert.equal(skippedHeartbeatState.ok, false);
assert.ok(skippedHeartbeatState.blockers.includes("candidate-capture-heartbeat-skipped"));

const invalidFinalization = structuredClone(healthyFixture);
invalidFinalization.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
  .captureHeartbeat.readiness.nearestFinalizationAt = "2026-07-29T14:01:00.000Z";
const invalidFinalizationState = candidateProspectiveRuntimeState(invalidFinalization);
assert.equal(invalidFinalizationState.ok, false);
assert.ok(invalidFinalizationState.blockers.includes(
  "candidate-capture-finalization-clock-invalid",
));

const partialDeadlineCohort = structuredClone(healthyFixture);
Object.assign(
  partialDeadlineCohort.publicScorecard.shadowTracks.CANDIDATE_PROSPECTIVE
    .captureHeartbeat,
  {
    reason: "deadline-cohort-evaluated",
    dueMatches: 6,
    dueCaptureEventsAdded: 5,
    dueDecisionEventsAdded: 5,
    dueExclusionEventsAdded: 0,
    dueAtomicDecisionEventsAdded: 4,
    dueCaptureComplete: false,
    dueAtomicComplete: false,
  },
);
const partialDeadlineCohortState =
  candidateProspectiveRuntimeState(partialDeadlineCohort);
assert.equal(partialDeadlineCohortState.ok, false);
assert.ok(partialDeadlineCohortState.blockers.includes(
  "candidate-deadline-cohort-capture-incomplete",
));
assert.ok(partialDeadlineCohortState.blockers.includes(
  "candidate-deadline-cohort-atomic-incomplete",
));
assert.ok(partialDeadlineCohortState.blockers.includes(
  "candidate-deadline-cohort-completion-unconfirmed",
));
assert.ok(partialDeadlineCohortState.blockers.includes(
  "candidate-deadline-cohort-atomic-completion-unconfirmed",
));

const missing = candidateProspectiveRuntimeState({});
assert.equal(missing.ok, false);
assert.ok(missing.blockers.includes("candidate-prospective-track-missing"));

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "runtime-candidate-capture-monitor",
  assertions: 59,
  storageHealthAssertions,
  healthy: {
    candidateRevisionId: healthy.candidateRevisionId,
    readiness: healthy.readiness,
    progress: healthy.progress,
    temporal: healthyTemporal,
  },
  rejectedBlockers: {
    atomicMismatch: atomicMismatchState.blockers,
    semanticDecisionFailure: semanticDecisionFailureState.blockers,
    cappedDenominator: cappedDenominatorState.blockers,
    captureGap: captureGapState.blockers,
    skippedHeartbeat: skippedHeartbeatState.blockers,
    invalidFinalization: invalidFinalizationState.blockers,
    partialDeadlineCohort: partialDeadlineCohortState.blockers,
    missing: missing.blockers,
    missedSettlement: missedSettlementState.blockers,
    missingReadModel: missingReadModelState.blockers,
    temporalDenominatorMismatch: temporalDenominatorMismatchState.blockers,
    temporalCohortMismatch: temporalCohortMismatchState.blockers,
    temporalReasonCountMismatch: temporalReasonCountMismatchState.blockers,
    temporalNullCount: temporalNullCountState.blockers,
    missingMarketCoverage: missingMarketCoverageState.blockers,
    publishedMarketChainGap: publishedMarketChainGapState.blockers,
    incompleteAwaitingClassification:
      incompleteAwaitingClassificationState.blockers,
    marketCoverageDenominatorMismatch:
      marketCoverageDenominatorMismatchState.blockers,
    missingTemporal: missingTemporal.blockers,
  },
}, null, 2)}\n`);
