const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  acquireSyncLockInterruptibly,
  benchmarkDeadlineCaptureEnabled,
  benchmarkDeadlineCaptureIntervalMs,
  benchmarkDeadlineCaptureStatusAdvanced,
  benchmarkDeadlineCaptureTimeoutMs,
  candidateDeadlineCaptureEnabled,
  candidateDeadlineCaptureForceSettleMs,
  candidateDeadlineCaptureIntervalMs,
  candidateDeadlineCaptureRecoveryBudgetMs,
  candidateDeadlineCaptureRetryMs,
  candidateDeadlineCaptureSafetyMarginMs,
  candidateDeadlineCaptureStatusAdvanced,
  candidateDeadlineCaptureTerminateGraceMs,
  candidateDeadlineCaptureTimeoutMs,
  candidateDeadlineCaptureCompleteThrough,
  candidateImplementationDriftAwaitingRefreeze,
  candidateDeadlineAttemptBudget,
  candidateDeadlineHeartbeatFreshnessLimitMs,
  candidateDeadlinePreemptiveSchedule,
  candidateDeadlineStartupSafetyWindowMs,
  createBackgroundSlowPhaseTracker,
  createWorkerShutdownController,
  describeConsolidatedSlowPublicationNeed,
  describeCandidateDeadlineStartupAdmission,
  describeCycleStages,
  describeFiveHundredResultFallbackNeed,
  describeModelStrategyReconciliationNeed,
  describePostEnrichmentPublicationNeed,
  describeSlowPhaseNeed,
  describeSyncCadence,
  modelCandidateRegistryLockTimeoutMs,
  modelStrategyReconciliationFingerprint,
  nextCycleDelayMs,
  officialCompensationRequired,
  officialPublishEvidenceAfter,
  phaseLockWaitMs,
  releaseCycleDelayMs,
  releaseCycleInitialLockWaitMs,
  releaseCycleNeedsReadinessHandoff,
  releaseCycleNeedsPriorityRetry,
  releaseCycleRetryMs,
  releaseSlowPhaseDrainBudgetMs,
  readinessIdleEvidenceAfter,
  readSourceCycleObservation,
  relaySnapshotChanged,
  relayCatchupRequiredAfterCycle,
  relaySnapshotSemanticFileFingerprint,
  runCandidateProspectiveDeadlineCapture,
  runBenchmarkProspectiveDeadlineCapture,
  runWithSharedSlowArtifactLock,
  startCandidateProspectiveDeadlineHeartbeat,
  startBenchmarkProspectiveDeadlineCapture,
  slowPhaseMinIntervalMs,
  slowPublicationLockWaitMs,
  usesSharedSlowArtifact,
  waitForBackgroundSlowPhaseDrain,
  waitForNextCycle,
  writeWorkerStatusBestEffort,
  writeJsonAtomic,
} = require("./runSyncWorker.cjs");
const {
  candidateHeartbeatNextAttempt,
  candidateHeartbeatPreemptiveSchedule,
} = require("../server/candidateHeartbeatSchedule.cjs");

const workerSource = fs.readFileSync(path.join(__dirname, "runSyncWorker.cjs"), "utf8");
const modelBacktestSource = fs.readFileSync(path.join(__dirname, "runModelBacktest.cjs"), "utf8");
const remotePublicReadinessSource = fs.readFileSync(
  path.join(__dirname, "verifyRemotePublicReadiness.cjs"),
  "utf8",
);

const now = Date.parse("2026-07-13T12:00:00.000Z");
const kickoff = (minutesFromNow) => new Date(now + minutesFromNow * 60_000).toISOString();
const configuredMinimumLoopIdleSeconds = Number(process.env.SYNC_WORKER_MIN_IDLE_SECONDS);
const configuredMinimumLoopIdleMs = Math.max(
  1_000,
  (Number.isFinite(configuredMinimumLoopIdleSeconds) ? configuredMinimumLoopIdleSeconds : 5) * 1_000
);
const configuredHotIntervalMs = Math.max(
  60,
  Number(process.env.HOT_SYNC_INTERVAL_SECONDS || 90),
) * 1_000;
const configuredPostDeadlineHotIntervalMs = Math.max(
  configuredHotIntervalMs / 1_000,
  Number(process.env.POST_DEADLINE_HOT_SYNC_INTERVAL_SECONDS || 300),
) * 1_000;

const exactDeadlineHeartbeatFixture = (evaluatedAt, overrides = {}) => ({
  version: "prospective-deadline-heartbeat-v2",
  captureMode: "deadline-only",
  evaluatedAt,
  ok: true,
  skipped: false,
  dueCaptureComplete: true,
  dueAtomicComplete: true,
  dueUnrecorded: 0,
  readyDueUnrecorded: 0,
  blockers: [],
  audit: {
    evaluatedAt,
    state: "ACTIVE",
    chainValid: true,
    rootHash: "a".repeat(64),
    candidateRevisionId: "candidate@test",
    decisionRecord: {
      version: "candidate-atomic-decision-record-v3",
      admittedRows: 0,
      atomicRows: 0,
      completeRows: 0,
      failedRows: 0,
      coverage: 1,
      complete: true,
    },
  },
  readiness: {
    version: "candidate-prospective-readiness-preview-v2",
    evaluatedAt,
    candidateRevisionId: "candidate@test",
    evaluatedMatches: 0,
    detailedMatches: 0,
    rowsTruncated: 0,
    upcomingMatches: 0,
    readyNow: 0,
    atomicReadyNow: 0,
    awaitingMarket: 0,
    blocked: 0,
    excluded: 0,
    readyInvariantOk: true,
    nearestDeadlineAt: null,
    nearestFinalizationAt: null,
    nearestStatus: null,
    nearestDeadlineBatch: null,
    deadlineBatches: [],
  },
  ...overrides,
});

const implementationDriftHeartbeatFixture = (evaluatedAt, overrides = {}) => ({
  version: "prospective-deadline-heartbeat-v2",
  captureMode: "deadline-only",
  evaluatedAt,
  ok: true,
  skipped: true,
  changed: false,
  reason: "candidate-implementation-drift-awaiting-refreeze",
  candidateRevisionId: "candidate@test",
  blockers: ["semantic-hash-mismatch:candidate-probability-evaluator"],
  audit: {
    evaluatedAt,
    state: "ACTIVE",
    chainValid: true,
    rootHash: "b".repeat(64),
    candidateRevisionId: "candidate@test",
    decisionRecord: {
      version: "candidate-atomic-decision-record-v3",
      admittedRows: 12,
      atomicRows: 12,
      completeRows: 12,
      failedRows: 0,
      coverage: 1,
      complete: true,
    },
  },
  ...overrides,
});

const missingSlowHistory = describeSlowPhaseNeed({ status: null, now });
assert.equal(missingSlowHistory.due, true);
assert.equal(missingSlowHistory.reason, "no-slow-phase-history");
const freshSlowHistoryAt = new Date(now - Math.floor(slowPhaseMinIntervalMs / 2)).toISOString();
const freshSlowHistory = describeSlowPhaseNeed({
  status: { lastSlowPhaseAt: freshSlowHistoryAt },
  now,
});
assert.equal(freshSlowHistory.due, false);
assert.equal(freshSlowHistory.reason, "minimum-interval-not-elapsed");
const expiredSlowHistory = describeSlowPhaseNeed({
  status: { lastSlowPhaseAt: new Date(now - slowPhaseMinIntervalMs - 1).toISOString() },
  now,
});
assert.equal(expiredSlowHistory.due, true);
assert.equal(expiredSlowHistory.reason, "minimum-interval-elapsed");
const releasePrioritySlowPhase = describeSlowPhaseNeed({
  releasePriority: true,
  status: { lastSlowPhaseAt: freshSlowHistoryAt },
  now,
});
assert.equal(releasePrioritySlowPhase.due, true);
assert.equal(releasePrioritySlowPhase.reason, "release-priority");
const runningSlowPhase = describeSlowPhaseNeed({
  releasePriority: true,
  running: true,
  status: { lastSlowPhaseAt: freshSlowHistoryAt },
  now,
});
assert.equal(runningSlowPhase.due, false);
assert.equal(runningSlowPhase.reason, "slow-phase-already-running");

const pending = describeSyncCadence([{
  id: "pending",
  status: "PENDING_RESULT",
  kickoffTime: kickoff(-100),
}], now);
assert.equal(pending.mode, "hot");
assert.equal(pending.reason, "pending-result");
assert.equal(pending.pendingResultMatches.length, 1);
assert.equal(pending.intervalMs, configuredPostDeadlineHotIntervalMs);

const live = describeSyncCadence([{
  id: "live",
  status: "LIVE",
  kickoffTime: kickoff(-20),
}], now);
assert.equal(live.mode, "hot");
assert.equal(live.reason, "live-match");
assert.equal(live.intervalMs, configuredPostDeadlineHotIntervalMs);

const staleScheduled = describeSyncCadence([{
  id: "recent",
  status: "SCHEDULED",
  kickoffTime: kickoff(-90),
}], now);
assert.equal(staleScheduled.mode, "hot");
assert.equal(staleScheduled.reason, "recent-kickoff");
assert.equal(staleScheduled.intervalMs, configuredPostDeadlineHotIntervalMs);

const oldScheduled = describeSyncCadence([{
  id: "old",
  status: "SCHEDULED",
  kickoffTime: kickoff(-240),
}], now);
assert.equal(oldScheduled.mode, "base");

const oldPending = describeSyncCadence([{
  id: "old-pending",
  status: "PENDING_RESULT",
  kickoffTime: kickoff(-240),
}], now);
assert.equal(oldPending.mode, "base");
assert.equal(oldPending.pendingResultMatches.length, 0);

const deadlineHot = describeSyncCadence([{
  id: "official-cutoff-near",
  status: "SCHEDULED",
  kickoffTime: kickoff(720),
  predictionMeta: {
    cutoffTime: kickoff(60),
  },
}], now);
assert.equal(deadlineHot.mode, "hot");
assert.equal(deadlineHot.reason, "near-decision-deadline");
assert.equal(deadlineHot.deadlineHotMatches.length, 1);
assert.equal(deadlineHot.deadlineHotMatches[0].decisionDeadlineAt, kickoff(60));
assert.equal(deadlineHot.deadlineHotMatches[0].minutesToDecisionDeadline, 60);

const deadlineNotYetHot = describeSyncCadence([{
  id: "official-cutoff-later",
  status: "SCHEDULED",
  kickoffTime: kickoff(720),
  predictionMeta: {
    cutoffTime: kickoff(300),
  },
}], now);
assert.equal(deadlineNotYetHot.mode, "base");
assert.equal(deadlineNotYetHot.deadlineHotMatches.length, 0);

const fallbackCutoffNearKickoff = describeSyncCadence([{
  id: "fallback-cutoff-near-kickoff",
  status: "SCHEDULED",
  kickoffTime: kickoff(60),
}], now);
assert.equal(fallbackCutoffNearKickoff.mode, "hot");
assert.equal(fallbackCutoffNearKickoff.reason, "near-decision-deadline");
assert.equal(fallbackCutoffNearKickoff.intervalMs, configuredHotIntervalMs);
assert.equal(fallbackCutoffNearKickoff.preDeadlineHotMatches.length, 1);

const postDeadlineNearKickoff = describeSyncCadence([{
  id: "post-deadline-near-kickoff",
  status: "SCHEDULED",
  kickoffTime: kickoff(60),
  predictionMeta: {
    cutoffTime: kickoff(-30),
  },
}], now);
assert.equal(postDeadlineNearKickoff.mode, "hot");
assert.equal(postDeadlineNearKickoff.reason, "post-deadline-near-kickoff");
assert.equal(postDeadlineNearKickoff.intervalMs, configuredPostDeadlineHotIntervalMs);
assert.equal(postDeadlineNearKickoff.preDeadlineHotMatches.length, 0);

const undatedPending = describeSyncCadence([{
  id: "undated-pending",
  status: "PENDING_RESULT",
  kickoffTime: null,
}], now);
assert.equal(undatedPending.mode, "base");
assert.equal(undatedPending.pendingResultMatches.length, 0);

const pendingFallback = describeFiveHundredResultFallbackNeed([{
  id: "pending-fallback",
  sourceMatchId: "2040580",
  status: "PENDING_RESULT",
  kickoffTime: kickoff(-90),
}], now, true);
assert.equal(pendingFallback.needed, true, "a pending score triggers the bounded 500 result fallback");
assert.equal(pendingFallback.candidateCount, 1);

const lateScheduledFallback = describeFiveHundredResultFallbackNeed([{
  id: "late-scheduled",
  sourceMatchId: "2040581",
  status: "SCHEDULED",
  kickoffTime: kickoff(-101),
}], now, true);
assert.equal(lateScheduledFallback.needed, true, "a stale scheduled match triggers score recovery after 100 minutes");

const tooEarlyFallback = describeFiveHundredResultFallbackNeed([{
  id: "too-early",
  status: "SCHEDULED",
  kickoffTime: kickoff(-99),
}], now, true);
assert.equal(tooEarlyFallback.needed, false, "normal match duration does not trigger an early result request");

const settledFallback = describeFiveHundredResultFallbackNeed([{
  id: "already-settled",
  status: "PENDING_RESULT",
  kickoffTime: kickoff(-120),
  scoreHome: 1,
  scoreAway: 1,
}], now, true);
assert.equal(settledFallback.needed, false, "an exact score suppresses redundant result recovery");

const disabledFallback = describeFiveHundredResultFallbackNeed([{
  id: "disabled-pending",
  status: "PENDING_RESULT",
  kickoffTime: kickoff(-120),
}], now, false);
assert.equal(disabledFallback.needed, false, "the explicit feature switch is respected");
assert.ok(
  !workerSource.includes('process.env.ENABLE_500_DETAILS_SYNC === "1"\n    && process.env.ENABLE_500_RESULT_FALLBACK'),
  "bounded result recovery must not depend on enabling full 500 detail enrichment",
);

assert.equal(
  candidateDeadlineStartupSafetyWindowMs,
  candidateDeadlineHeartbeatFreshnessLimitMs,
  "startup safety covers the complete failed-primary/retry/recovery chain",
);
const completeCaptureStatus = (evaluatedAt) => ({
  version: "prospective-deadline-heartbeat-v2",
  evaluatedAt,
  ok: true,
  skipped: false,
  dueCaptureComplete: true,
  dueAtomicComplete: true,
  dueUnrecorded: 0,
  readyDueUnrecorded: 0,
});
assert.equal(
  candidateDeadlineCaptureCompleteThrough(completeCaptureStatus(kickoff(-1)), now - 60_000),
  true,
);
assert.equal(
  candidateDeadlineCaptureCompleteThrough(completeCaptureStatus(kickoff(-2)), now - 60_000),
  false,
  "a healthy but pre-finalization heartbeat cannot prove an overdue cohort",
);

const farDeadlineAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [{
    id: "far-deadline",
    status: "SCHEDULED",
    kickoffTime: kickoff(180),
    predictionMeta: { cutoffTime: kickoff(60) },
  }],
  nowMs: now,
  captureStatus: null,
  resultRecoveryPlan: { needed: false },
});
assert.equal(farDeadlineAdmission.waitForPublished, false);
assert.equal(farDeadlineAdmission.fastOfficialLaneAdmitted, true);
assert.equal(farDeadlineAdmission.reason, "deadline-safety-window-clear");

const nearDeadlineAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [{
    id: "near-deadline",
    status: "SCHEDULED",
    kickoffTime: kickoff(180),
    predictionMeta: {
      cutoffTime: new Date(now + candidateDeadlineStartupSafetyWindowMs - 1).toISOString(),
    },
  }],
  nowMs: now,
  captureStatus: null,
  resultRecoveryPlan: { needed: false },
});
assert.equal(nearDeadlineAdmission.waitForPublished, true);
assert.equal(nearDeadlineAdmission.fastOfficialLaneAdmitted, true);
assert.equal(nearDeadlineAdmission.reason, "deadline-inside-startup-safety-window");

const overdueMatch = {
  id: "overdue-deadline",
  status: "SCHEDULED",
  kickoffTime: kickoff(120),
  predictionMeta: { cutoffTime: kickoff(-5) },
};
const overdueUnprovenAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [overdueMatch],
  nowMs: now,
  captureStatus: completeCaptureStatus(kickoff(-4)),
  resultRecoveryPlan: { needed: false },
});
assert.equal(overdueUnprovenAdmission.waitForPublished, true);
assert.equal(overdueUnprovenAdmission.reason, "deadline-capture-overdue-unproven");
const driftRecoveryStatus = implementationDriftHeartbeatFixture(kickoff(-1));
assert.equal(candidateImplementationDriftAwaitingRefreeze(driftRecoveryStatus), true);
const driftRecoveryAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [overdueMatch],
  nowMs: now,
  captureStatus: driftRecoveryStatus,
  resultRecoveryPlan: { needed: false },
});
assert.equal(driftRecoveryAdmission.waitForPublished, false);
assert.equal(driftRecoveryAdmission.refreezeRecoveryRequired, true);
assert.equal(
  driftRecoveryAdmission.reason,
  "candidate-implementation-drift-refreeze-recovery",
);
assert.equal(
  candidateImplementationDriftAwaitingRefreeze({
    ...driftRecoveryStatus,
    blockers: [...driftRecoveryStatus.blockers, "unknown-runtime-blocker"],
  }),
  false,
  "an unknown blocker can never enter the refreeze recovery lane",
);
const overdueProvenAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [overdueMatch],
  nowMs: now,
  captureStatus: completeCaptureStatus(kickoff(-1)),
  resultRecoveryPlan: { needed: false },
});
assert.equal(overdueProvenAdmission.waitForPublished, false);
assert.equal(overdueProvenAdmission.riskMatches.length, 0);

const missingDeadlineAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [{ id: "missing-deadline", status: "SCHEDULED", kickoffTime: null }],
  nowMs: now,
  captureStatus: completeCaptureStatus(kickoff(1)),
  resultRecoveryPlan: { needed: false },
});
assert.equal(missingDeadlineAdmission.waitForPublished, true);
assert.equal(missingDeadlineAdmission.reason, "decision-deadline-missing");

const recoveryFastLaneAdmission = describeCandidateDeadlineStartupAdmission({
  matches: [{
    id: "far-deadline-with-result-recovery",
    status: "SCHEDULED",
    kickoffTime: kickoff(180),
    predictionMeta: { cutoffTime: kickoff(60) },
  }],
  nowMs: now,
  captureStatus: null,
  resultRecoveryPlan: { needed: true },
});
assert.equal(recoveryFastLaneAdmission.waitForPublished, false);
assert.equal(recoveryFastLaneAdmission.reason, "overdue-result-recovery-fast-lane");

assert.equal(
  nextCycleDelayMs("2026-07-13T11:59:40.000Z", 90_000, now),
  70_000,
  "the worker interval is measured from cycle start, not cycle completion"
);
assert.equal(
  nextCycleDelayMs("2026-07-13T11:58:00.000Z", 90_000, now),
  configuredMinimumLoopIdleMs,
  "an overrun keeps a small idle floor instead of spinning or sleeping a second full interval"
);
assert.equal(
  nextCycleDelayMs(
    "2026-07-13T11:58:00.000Z",
    configuredPostDeadlineHotIntervalMs,
    now,
    { fromCompletion: true },
  ),
  configuredPostDeadlineHotIntervalMs,
  "a post-deadline or recent-kickoff cycle receives a full cooldown after completion",
);
assert.ok(workerSource.includes('"post-deadline-near-kickoff",'));
assert.ok(workerSource.includes('"recent-kickoff",'));
assert.ok(workerSource.includes('"live-match",'));
assert.ok(workerSource.includes('"pending-result",'));
assert.ok(workerSource.includes("nextCadence.mode === \"hot\" && !postDeadlineCooldown"));
assert.ok(workerSource.includes('nextCadence.mode === "hot"'));
assert.ok(workerSource.includes('completedCycle.slowPhase.skipped !== true'));
assert.ok(phaseLockWaitMs >= 5_000, "publication-phase lock reacquisition has a bounded wait");
assert.ok(
  releaseCycleInitialLockWaitMs >= phaseLockWaitMs
    && releaseCycleInitialLockWaitMs <= 120_000,
  "a hash-bound release cycle waits through a short result-watcher lock collision",
);
const oversizedReleaseLockWait = Number(execFileSync(
  process.execPath,
  ["-e", "process.stdout.write(String(require('./scripts/runSyncWorker.cjs').releaseCycleInitialLockWaitMs))"],
  {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      SYNC_WORKER_PHASE_LOCK_WAIT_MS: "600000",
      SYNC_WORKER_RELEASE_INITIAL_LOCK_WAIT_MS: "600000",
    },
    encoding: "utf8",
  },
));
assert.equal(
  oversizedReleaseLockWait,
  120_000,
  "even a bad runtime override cannot stretch the release lock wait past two minutes",
);
assert.ok(
  releaseCycleRetryMs >= 1_000 && releaseCycleRetryMs <= 30_000,
  "release-cycle retry remains fast and bounded",
);
const prioritySkippedCycle = {
  ok: true,
  skipped: true,
  releaseCycle: { priority: true },
};
assert.equal(releaseCycleNeedsPriorityRetry(prioritySkippedCycle), true);
assert.equal(
  releaseCycleDelayMs(prioritySkippedCycle, configuredPostDeadlineHotIntervalMs),
  Math.min(configuredPostDeadlineHotIntervalMs, releaseCycleRetryMs),
  "a release cycle that lost the initial lock retries instead of sleeping a normal cadence",
);
assert.equal(releaseCycleRetryMs, 5_000, "the production default release retry matches the incident recovery budget");
assert.equal(
  new Date(
    Date.parse("2026-08-01T12:29:10.000Z")
      + releaseCycleDelayMs(prioritySkippedCycle, 300_000),
  ).toISOString(),
  "2026-08-01T12:29:15.000Z",
  "the r379-shaped first lock skip retries at +5s instead of the observed +300s",
);
const completePriorityCycle = {
  ok: true,
  skipped: false,
  releaseCycle: { priority: true },
  officialPhase: { ok: true, phase: "official-result-published" },
  readinessSourceCycleObservation: {
    ready: true,
    samePublicationIdentity: true,
    blockers: [],
  },
};
assert.equal(releaseCycleNeedsPriorityRetry(completePriorityCycle), false);
assert.equal(releaseCycleNeedsReadinessHandoff(completePriorityCycle), true);
assert.equal(
  releaseCycleDelayMs(completePriorityCycle, configuredPostDeadlineHotIntervalMs),
  configuredPostDeadlineHotIntervalMs,
  "a complete publication returns to the ordinary cadence",
);
assert.equal(
  relayCatchupRequiredAfterCycle({
    loop: true,
    enabled: true,
    eligible: true,
    baseline: { exists: true, token: "before" },
    current: { exists: true, token: "after" },
    cycle: completePriorityCycle,
  }),
  false,
  "a complete release-priority cycle exposes readiness-safe idle even when the relay changed",
);
assert.equal(
  relayCatchupRequiredAfterCycle({
    loop: true,
    enabled: true,
    eligible: true,
    baseline: { exists: true, token: "before" },
    current: { exists: true, token: "after" },
    cycle: { ...completePriorityCycle, releaseCycle: { priority: false } },
  }),
  true,
  "ordinary cycles still perform immediate relay catch-up",
);

const stages = describeCycleStages();
assert.deepEqual(stages.map((stage) => stage.id), [
  "candidate-deadline-heartbeat",
  "official-result-fast",
  "official-result",
  "slow-enrichment",
]);
assert.equal(stages[0].fatal, false);
assert.equal(stages[0].concurrent, true);
assert.equal(stages[1].fatal, false);
assert.equal(stages[2].fatal, true);
assert.equal(stages[3].fatal, false);
assert.deepEqual(stages[0].operations, [
  "candidate:capture-deadline",
  "candidate:settle-prospective-ledger",
  "benchmark:capture-deadline-independent",
]);
assert.deepEqual(stages[1].operations, [
  "sync:server-direct-sporttery-evidence",
  "sync:cloudflare-sporttery-evidence",
  "sync:k-league-standings",
  "publish:official-results-fast",
  "sync:uefa-results",
  "sync:official-club-results",
  "sync:500:result-fallback-if-pending",
  "publish-fast-event-if-changed",
]);
assert.deepEqual(stages[2].operations, [
  "sync:data",
  "sync:free-football",
  "sync:prematch",
  "validate:data",
  "datastore:generation",
  "datastore:sqlite",
  "publish-event",
]);
assert.deepEqual(stages[3].operations, [
  "sync:500",
  "sync:500:details",
  "sync:api-football",
  "sync:weather",
  "sync:openfootball-observations",
  "sync:football-data-fixtures",
  "sync:football-data-results",
  "sync:open-research",
  "sync:web-consensus",
  "sync:free-football",
  "audit:recommendation-bias",
  "validate:sources",
  "validate:data:post-enrichment",
  "observe:source-cycle",
  "model:backtest",
  "model:learn:autonomous",
  "model:learn",
  "audit:capability",
  "optimize:strategy",
  "sync:prematch",
  "reconcile:fast-results-generation:consolidated-slow-publication",
  "validate:data:consolidated-slow-publication",
  "datastore:generation:consolidated-slow-publication",
  "datastore:sqlite:consolidated-slow-publication",
  "observe:publication-readiness"
]);
const slowWeatherIndex = workerSource.indexOf(
  'runEnrichment(process.env.ENABLE_WEATHER_SYNC !== "0", "sync:weather")'
);
const slowPreMatchIndex = workerSource.indexOf(
  "const consolidatedPreMatchStep =",
  slowWeatherIndex,
);
assert.ok(
  slowWeatherIndex >= 0 && slowPreMatchIndex > slowWeatherIndex,
  "the slow pipeline must rebuild pre-match evidence after enrichment",
);
assert.ok(
  workerSource.indexOf("const consolidatedPreMatchStep =", slowWeatherIndex)
    > workerSource.indexOf('await acquireSlowPhaseLock("sync-worker-consolidated-slow-publication")'),
  "the slow pre-match projection must run under the final publication lock",
);
assert.equal(usesSharedSlowArtifact("sync:weather"), true);
assert.equal(usesSharedSlowArtifact("sync:api-football"), true);
assert.equal(usesSharedSlowArtifact("sync:open-research"), true);
assert.equal(usesSharedSlowArtifact("sync:web-consensus"), true);
assert.equal(usesSharedSlowArtifact("sync:prematch"), true);
assert.equal(usesSharedSlowArtifact("sync:500"), true);
assert.equal(usesSharedSlowArtifact("sync:500:details"), true);
assert.equal(usesSharedSlowArtifact("sync:k-league-standings"), true);
assert.equal(usesSharedSlowArtifact("sync:football-data-fixtures"), false);
assert.equal(candidateDeadlineCaptureEnabled, true);
assert.ok(
  candidateDeadlineCaptureIntervalMs <= 60_000,
  "candidate deadline capture must check at least once per minute",
);

const serverDirectEvidenceIndex = workerSource.indexOf('"sync:server-direct-sporttery-evidence"');
const cloudflareEvidenceIndex = workerSource.indexOf('"sync:cloudflare-sporttery-evidence"');
const kLeagueStandingsIndex = workerSource.indexOf('"sync:k-league-standings"', cloudflareEvidenceIndex);
const fastResultIndex = workerSource.indexOf('"publish:official-results-fast"');
const uefaResultIndex = workerSource.indexOf('"sync:uefa-results"');
const officialClubResultIndex = workerSource.indexOf('"sync:official-club-results"');
const resultFallbackIndex = workerSource.indexOf("const fiveHundredResultFallbackPlan = describeFiveHundredResultFallbackNeed()");
const fastPublishIndex = workerSource.indexOf("await onFastPublished(fastPhase)");
const officialSyncIndex = workerSource.indexOf("const officialSyncStep = await runCommand");
const officialGenerationIndex = workerSource.indexOf("const officialGenerationStep = await runOptional");
const officialSqliteIndex = workerSource.indexOf("const sqliteStep = await runRuntimeProjectionOrReuse");
const officialPublishIndex = workerSource.indexOf("await onOfficialPublished(officialPhase)");
const officialLockReleaseIndex = workerSource.indexOf("await releasePhaseLock();", officialPublishIndex);
const slowEnrichmentIndex = workerSource.indexOf("const enrichmentSteps = []");
const sourceValidationIndex = workerSource.indexOf("const sourceValidationStep = await runOptional");
const postEnrichmentValidationIndex = workerSource.indexOf("const postEnrichmentDataValidationStep = {");
const postEnrichmentPublicationPlanIndex = workerSource.indexOf("const postEnrichmentPublicationPlan =");
const sourceCycleObservationIndex = workerSource.indexOf("const sourceCycleObservation = await readRuntimeSourceCycleObservation");
const modelBacktestIndex = workerSource.indexOf("const modelBacktestStep = sourceCycleObservation.ready");
const autonomousModelLearningIndex = workerSource.indexOf("const autonomousModelLearningStep = await runOptional");
const modelLearningIndex = workerSource.indexOf("const modelLearningStep = await runOptional");
const capabilityAuditIndex = workerSource.indexOf("const capabilityAuditStep = await runOptional");
const modelStrategyIndex = workerSource.indexOf("const modelStrategyEnabled =");
const modelStrategyLockAcquireIndex = workerSource.indexOf(
  'await acquireSlowPhaseLock("sync-worker-model-strategy-and-publication")',
  modelStrategyIndex,
);
const modelStrategyCommandIndex = workerSource.indexOf(
  "const modelStrategyCommandStep = await runOptional",
  modelStrategyLockAcquireIndex,
);
const consolidatedPublicationPlanIndex = workerSource.indexOf(
  "const consolidatedPublicationPlan = describeConsolidatedSlowPublicationNeed",
  modelStrategyIndex,
);
const consolidatedLockAcquireIndex = workerSource.indexOf(
  'await acquireSlowPhaseLock("sync-worker-consolidated-slow-publication")',
  consolidatedPublicationPlanIndex,
);
const consolidatedArtifactLockAcquireIndex = workerSource.indexOf(
  'await acquireSlowFinalArtifactLock("sync-worker-consolidated-slow-publication")',
  consolidatedLockAcquireIndex,
);
const consolidatedFastReconciliationIndex = workerSource.indexOf(
  "const consolidatedFastResultReconciliationStep =",
  consolidatedLockAcquireIndex,
);
const consolidatedPreMatchStepIndex = workerSource.indexOf(
  "const consolidatedPreMatchStep =",
  consolidatedLockAcquireIndex,
);
const consolidatedFreeFootballStepIndex = workerSource.indexOf(
  "const consolidatedFreeFootballStep =",
  consolidatedLockAcquireIndex,
);
const consolidatedValidationIndex = workerSource.indexOf(
  "const consolidatedDataValidationStep =",
  consolidatedFastReconciliationIndex,
);
const consolidatedGenerationIndex = workerSource.indexOf("const consolidatedGenerationStep = {");
const consolidatedSqliteIndex = workerSource.indexOf("const consolidatedSqliteStep = await runRuntimeProjectionOrReuse");
const consolidatedLockReleaseIndex = workerSource.indexOf(
  "await releaseSlowPhaseLock();",
  consolidatedSqliteIndex,
);
const consolidatedArtifactLockReleaseIndex = workerSource.indexOf(
  "await releaseSlowFinalArtifactLock();",
  consolidatedSqliteIndex,
);
const readinessObservationIndex = workerSource.indexOf(
  "const readinessSourceCycleObservation = await readRuntimeSourceCycleObservation",
  consolidatedSqliteIndex,
);
assert.ok(fastResultIndex >= 0);
assert.ok(serverDirectEvidenceIndex >= 0 && serverDirectEvidenceIndex < cloudflareEvidenceIndex);
assert.ok(cloudflareEvidenceIndex >= 0 && cloudflareEvidenceIndex < kLeagueStandingsIndex);
assert.ok(kLeagueStandingsIndex >= 0 && kLeagueStandingsIndex < fastResultIndex);
assert.ok(
  workerSource.includes('process.env.ENABLE_K_LEAGUE_OFFICIAL_STANDINGS_SYNC !== "0"'),
  "official K League standings refresh must be independently configurable",
);
assert.ok(
  workerSource.includes("SPORTTERY_SERVER_DIRECT_COLLECTOR_PRIVATE_KEY_PATH")
    && workerSource.includes("SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_ID")
    && workerSource.includes("SPORTTERY_SERVER_DIRECT_COLLECTOR_KEY_FINGERPRINT"),
  "new-server direct evidence requires its private key identity",
);
assert.ok(
  workerSource.includes("SPORTTERY_CLOUDFLARE_EVIDENCE_URL")
    && workerSource.includes("SPORTTERY_CLOUDFLARE_PULL_TOKEN"),
  "independent evidence pull must require both URL and bearer token",
);
assert.ok(uefaResultIndex > fastResultIndex, "UEFA official result supplement follows the primary official fast publisher");
assert.ok(
  officialClubResultIndex > uefaResultIndex,
  "official club result supplement follows the competition-organizer lane"
);
assert.ok(
  resultFallbackIndex > officialClubResultIndex,
  "500 shadow score recovery follows every official result lane"
);
assert.ok(fastPublishIndex > resultFallbackIndex, "fast-event publication follows the result fallback stage");
assert.ok(fastPublishIndex > fastResultIndex);
assert.ok(officialSyncIndex > fastPublishIndex);
assert.ok(officialSyncIndex > kLeagueStandingsIndex, "official standings must refresh before recommendation rebuild");
assert.ok(officialGenerationIndex > officialSyncIndex);
assert.ok(officialSqliteIndex > officialGenerationIndex);
assert.ok(officialPublishIndex > officialSqliteIndex);
assert.ok(
  officialLockReleaseIndex > officialPublishIndex,
  "the global writer permit is released after the atomic official publication",
);
assert.ok(slowEnrichmentIndex > officialPublishIndex);
assert.ok(
  slowEnrichmentIndex > officialLockReleaseIndex,
  "slow enrichment runs without monopolizing the official-result writer permit",
);
assert.ok(sourceValidationIndex > slowEnrichmentIndex);
assert.ok(postEnrichmentValidationIndex > sourceValidationIndex);
assert.ok(postEnrichmentPublicationPlanIndex > postEnrichmentValidationIndex);
assert.ok(sourceCycleObservationIndex > postEnrichmentPublicationPlanIndex);
assert.ok(modelBacktestIndex > sourceCycleObservationIndex);
assert.ok(autonomousModelLearningIndex > modelBacktestIndex);
assert.ok(modelLearningIndex > autonomousModelLearningIndex);
assert.ok(capabilityAuditIndex > modelLearningIndex);
assert.ok(modelStrategyIndex > capabilityAuditIndex);
assert.ok(
  consolidatedPublicationPlanIndex > modelStrategyIndex
    && consolidatedLockAcquireIndex > consolidatedPublicationPlanIndex,
  "the consolidated publication need is planned before its final permit",
);
assert.ok(
  consolidatedArtifactLockAcquireIndex > consolidatedLockAcquireIndex
    && consolidatedArtifactLockAcquireIndex < consolidatedFreeFootballStepIndex,
  "the final publication serializes shared evidence before rebasing it",
);
assert.ok(
  modelStrategyLockAcquireIndex > modelStrategyIndex
    && modelStrategyLockAcquireIndex < modelStrategyCommandIndex
    && modelStrategyCommandIndex < consolidatedPublicationPlanIndex,
  "strategy reconciliation mutates current/publication inputs only while holding the publication lock",
);
assert.ok(
  consolidatedFreeFootballStepIndex > consolidatedLockAcquireIndex
    && consolidatedFreeFootballStepIndex < consolidatedPreMatchStepIndex
    && consolidatedPreMatchStepIndex < consolidatedFastReconciliationIndex,
  "free and pre-match evidence are rebased under the final permit before result reconciliation and generation",
);
assert.ok(
  consolidatedFastReconciliationIndex > consolidatedLockAcquireIndex
    && consolidatedFastReconciliationIndex < consolidatedValidationIndex,
  "a fast result committed during slow computation is rebased under the writer lock",
);
assert.ok(
  consolidatedValidationIndex > consolidatedFastReconciliationIndex
    && consolidatedValidationIndex < consolidatedGenerationIndex,
  "the slow lane validates the latest official files under lock before consolidated generation",
);
assert.ok(
  consolidatedSqliteIndex > consolidatedGenerationIndex,
  "the combined enrichment and strategy output receives one immutable generation and SQLite export"
);
assert.ok(
  readinessObservationIndex > consolidatedSqliteIndex,
  "release readiness observes the consolidated generation and SQLite identities"
);
assert.ok(
  consolidatedArtifactLockReleaseIndex > consolidatedSqliteIndex
    && consolidatedArtifactLockReleaseIndex < consolidatedLockReleaseIndex
    && consolidatedLockReleaseIndex > consolidatedSqliteIndex
    && consolidatedLockReleaseIndex < readinessObservationIndex,
  "artifact and publication permits are released in reverse order before readiness observation",
);
assert.equal(
  (workerSource.match(/\["scripts\/syncData\.cjs"\]/g) || []).length,
  1,
  "the official pipeline must not rerun the full sync in the same cycle"
);
assert.match(
  workerSource,
  /maybeRunModelBacktest\(\{[\s\S]*?sqliteStep,[\s\S]*?forceCandidateImplementationRefreeze:/,
  "the backtest consumes immutable official SQLite history and honors a latched refreeze",
);
assert.match(
  workerSource,
  /const runEnrichment = async[\s\S]*?runWithSharedSlowArtifactLock\(\{[\s\S]*?waitMs: phaseLockWaitMs[\s\S]*?runOptional\(enabled, script/,
  "background evidence writers use the dedicated shared-artifact lock instead of the official publication lock",
);
assert.match(
  workerSource,
  /officialFreeFootballStep = await runWithSharedSlowArtifactLock\(\{[\s\S]*?waitMs: 0[\s\S]*?officialPreMatchStep = await runWithSharedSlowArtifactLock\(\{[\s\S]*?waitMs: 0/,
  "the official result lane never waits for a background evidence writer",
);
assert.ok(
  slowPublicationLockWaitMs >= phaseLockWaitMs,
  "the background final rebase can wait for an in-flight official publication without making the official lane wait",
);
assert.deepEqual(
  describePostEnrichmentPublicationNeed([
    { ok: true, skipped: true, reused: true, script: "sync:500" },
    { ok: true, skipped: true, script: "sync:weather" },
  ]),
  {
    required: false,
    reason: "no-enrichment-command-executed",
    attemptedScripts: [],
    failedScripts: [],
    reusedScripts: ["sync:500"],
    skippedScripts: ["sync:weather"],
  },
  "a signed-release reuse cycle must reuse the official generation instead of rebuilding it",
);
assert.deepEqual(
  describePostEnrichmentPublicationNeed([
    { ok: true, skipped: true, reused: true, script: "sync:500" },
    { ok: true, script: "sync:weather" },
  ]),
  {
    required: true,
    reason: "enrichment-command-attempted",
    attemptedScripts: ["sync:weather"],
    failedScripts: [],
    reusedScripts: ["sync:500"],
    skippedScripts: [],
  },
  "any executed enrichment command conservatively requires a new immutable publication",
);
assert.deepEqual(
  describePostEnrichmentPublicationNeed([
    { ok: false, script: "sync:500", error: "partial-write-before-failure" },
    { ok: true, skipped: true, script: "sync:weather" },
  ]),
  {
    required: true,
    reason: "enrichment-command-attempted",
    attemptedScripts: ["sync:500"],
    failedScripts: ["sync:500"],
    reusedScripts: [],
    skippedScripts: ["sync:weather"],
  },
  "a failed enrichment attempt may have partially mutated data and must force validation and republication",
);
assert.deepEqual(
  describeConsolidatedSlowPublicationNeed({
    postEnrichmentPublicationPlan: { required: true },
    modelReconciliationRequired: true,
    validationOk: true,
  }),
  {
    required: true,
    enrichmentRequired: true,
    modelReconciliationRequired: true,
    reason: "enrichment-or-model-artifact-changed",
  },
  "enrichment and model changes collapse into one slow publication",
);
assert.deepEqual(
  describeConsolidatedSlowPublicationNeed({
    postEnrichmentPublicationPlan: { required: true },
    modelReconciliationRequired: true,
    validationOk: false,
  }),
  {
    required: false,
    enrichmentRequired: true,
    modelReconciliationRequired: true,
    reason: "post-enrichment-validation-not-ready",
  },
  "the consolidated publication remains fail-closed when validation is not ready",
);
assert.ok(
  workerSource.includes("ok: runtimeProjectionEnabled === false"),
  "a requested runtime projection with invalid source-cycle evidence must degrade the cycle"
);
assert.ok(
  /sourceCycleObservation\.ready\s*&& process\.env\.ENABLE_AUTONOMOUS_MODEL_LEARNING/.test(workerSource),
  "autonomous learning must fail closed when post-enrichment source-cycle evidence is not ready"
);
assert.ok(
  /sourceCycleObservation\.ready\s*&& process\.env\.ENABLE_MODEL_LEARNING_REGISTRY/.test(workerSource),
  "registry learning must fail closed when post-enrichment source-cycle evidence is not ready"
);
assert.ok(
  /consolidatedPublicationRequired[\s\S]*?"datastore:generation"[\s\S]*?consolidatedGenerationStep[\s\S]*?runRuntimeProjectionOrReuse/.test(workerSource),
  "slow enrichment and strategy output must share one consolidated generation and runtime projection"
);
assert.ok(
  workerSource.includes('reason: "strategy-artifacts-unchanged"')
    && workerSource.includes("modelStrategyFingerprintBefore !== modelStrategyFingerprintAfter"),
  "an idempotent strategy run must not force a model-only publication"
);
assert.ok(
  workerSource.includes("modelStrategyRecovery.shouldRun"),
  "a later cycle must retry strategy reconciliation after a successful backtest left stale artifacts"
);
assert.ok(workerSource.includes("eventCycle: activeEventCycle"));
assert.ok(workerSource.includes("inspectReleaseWorkerPriorityRequest"));
assert.ok(workerSource.includes("waitMs: releaseCycle.initialLockWaitMs"));
assert.ok(
  workerSource.includes("deferSlowPhase: loop")
    && workerSource.includes("slowPhaseRunning: slowPhaseRunningAtCycleStart")
    && workerSource.includes("onSlowPhaseDeferred: trackBackgroundSlowPhase"),
  "the official loop delegates one slow phase to a tracked single-instance background lane",
);
assert.match(
  workerSource,
  /preCycleReleaseRequest\.pending === true && backgroundSlowPhasePromise[\s\S]*?waitForBackgroundSlowPhaseDrain\(drainTask[\s\S]*?release-priority-drain-blocked[\s\S]*?const result = await runCycle/,
  "a release-priority cycle uses a bounded fail-closed drain before readiness work",
);
assert.match(
  workerSource,
  /releaseCycle\.priority === true && hooks\.slowPhaseRunning === true[\s\S]*?reason: "release-priority-awaits-background-slow-phase"/,
  "a release request that races the pre-cycle check retries instead of claiming readiness over a running slow lane",
);
assert.ok(workerSource.includes("fatal: false, timeoutMs: commandTimeouts.sqlite"));
assert.ok(workerSource.includes("cycleWake = await waitForNextCycle"));
assert.ok(workerSource.includes("SYNC_WORKER_RELAY_WAKE_POLL_SECONDS"));
assert.ok(workerSource.includes("enabled: relayWakeEnabled && relayWakeEligible"));
assert.ok(workerSource.includes('finiteEnvNumber("WEB_CONSENSUS_REFRESH_MINUTES", 30)'));
assert.ok(workerSource.includes('process.env.ENABLE_WEB_CONSENSUS_SYNC !== "0" && webConsensusRefreshDue()'));
assert.ok(workerSource.includes('FIVE_HUNDRED_RESULT_ONLY: "1"'), "the fallback uses bounded archive result-only mode");
assert.ok(
  workerSource.includes('mode: "result-only-recent-archive"'),
  "the fallback records that it queries recent result archives instead of only the current page"
);
assert.ok(workerSource.includes("timeoutMs: commandTimeouts.resultFallback"), "the fallback has a dedicated bounded timeout");
assert.ok(
  /fiveHundredResultFallbackPlan\.needed[\s\S]*?"sync:500:details"[\s\S]*?fatal:\s*false/.test(workerSource),
  "the result fallback is conditional and fail-soft",
);
const sleepingPublicationIndex = workerSource.indexOf('cycleState: loop ? "sleeping" : "stopped"');
const postCycleRelayBaselineIndex = workerSource.indexOf("const postCycleRelayBaseline = relaySnapshotFingerprint()");
const postCycleWaitIndex = workerSource.indexOf("baseline: postCycleRelayBaseline");
assert.ok(postCycleRelayBaselineIndex > sleepingPublicationIndex, "relay wake baseline is captured only after the complete-cycle idle status is published");
assert.ok(postCycleWaitIndex > postCycleRelayBaselineIndex, "next-cycle wait uses the post-cycle relay baseline");
assert.ok(!workerSource.includes("const relayBaseline = relaySnapshotFingerprint();"), "cycle-start relay changes cannot cause an immediate post-cycle wake");

const releaseWorkerStartedAt = "2026-07-13T12:00:00.000Z";
const oldPublishedStatus = {
  ok: true,
  cycleState: "running",
  checkedAt: "2026-07-13T12:00:01.000Z",
  eventCycle: {
    ok: true,
    phase: "official-result-published",
    startedAt: "2026-07-13T11:58:00.000Z",
    finishedAt: "2026-07-13T11:59:00.000Z",
  },
};
assert.equal(
  officialPublishEvidenceAfter(oldPublishedStatus, releaseWorkerStartedAt).state,
  "pending",
  "a previous worker publication must not satisfy a new release"
);
const freshPublishedStatus = {
  ...oldPublishedStatus,
  eventCycle: {
    ...oldPublishedStatus.eventCycle,
    startedAt: "2026-07-13T12:00:01.000Z",
    finishedAt: "2026-07-13T12:00:45.000Z",
  },
};
const fastOnlyPublishedStatus = {
  ...oldPublishedStatus,
  eventCycle: {
    ok: true,
    phase: "official-result-fast-published",
    startedAt: "2026-07-13T12:00:01.000Z",
    finishedAt: "2026-07-13T12:00:02.000Z",
  },
};
assert.equal(
  officialPublishEvidenceAfter(fastOnlyPublishedStatus, releaseWorkerStartedAt).state,
  "pending",
  "the release gate never downgrades a fast result event into full official publication evidence",
);
assert.equal(
  officialPublishEvidenceAfter(freshPublishedStatus, releaseWorkerStartedAt).state,
  "published"
);
const freshFailedStatus = {
  ok: false,
  checkedAt: "2026-07-13T12:00:20.000Z",
  eventCycle: {
    ok: false,
    phase: "official-result-failed",
    startedAt: "2026-07-13T12:00:01.000Z",
    finishedAt: "2026-07-13T12:00:20.000Z",
    error: "sync failed",
  },
};
assert.equal(
  officialPublishEvidenceAfter(freshFailedStatus, releaseWorkerStartedAt).state,
  "failed"
);

assert.equal(
  readinessIdleEvidenceAfter(freshPublishedStatus, releaseWorkerStartedAt).state,
  "pending",
  "official publication alone is not safe for release readiness while slow enrichment is running"
);
const readinessPublicationIdentity = {
  generationId: `g-${"a".repeat(64)}`,
  manifestHash: "b".repeat(64),
  sourceCycleId: "sporttery-full-sync:2026-07-13T12:00:00.000Z",
  committedAt: "2026-07-13T12:02:30.000Z",
};
const readyPublicationObservation = {
  ready: true,
  sameSourceCycle: true,
  samePublicationIdentity: true,
  blockers: [],
  generation: {
    mode: "active-generation",
    ...readinessPublicationIdentity,
    reason: null,
  },
  sqlite: {
    generationId: readinessPublicationIdentity.generationId,
    manifestHash: readinessPublicationIdentity.manifestHash,
    generationSourceCycleId: readinessPublicationIdentity.sourceCycleId,
    committedAt: readinessPublicationIdentity.committedAt,
    readable: true,
    reason: null,
  },
};
const freshIdleStatus = {
  ok: true,
  cycleState: "sleeping",
  phase: "sleeping",
  pid: 4321,
  checkedAt: "2026-07-13T12:03:01.000Z",
  eventCycle: freshPublishedStatus.eventCycle,
  lastCycle: {
    ok: true,
    startedAt: "2026-07-13T12:00:01.000Z",
    finishedAt: "2026-07-13T12:03:00.000Z",
    durationMs: 179000,
    officialPhase: freshPublishedStatus.eventCycle,
    modelStrategyStep: {
      ok: true,
      skipped: true,
      script: "optimize:strategy",
    },
    modelReconciledGenerationStep: {
      ok: true,
      skipped: true,
      script: "datastore:generation",
    },
    modelReconciledSqliteStep: {
      ok: true,
      skipped: true,
      script: "datastore:sqlite",
    },
    readinessSourceCycleObservation: readyPublicationObservation,
  },
};
assert.equal(
  readinessIdleEvidenceAfter(freshIdleStatus, releaseWorkerStartedAt).state,
  "idle",
  "a fresh completed cycle is readiness-safe only after the worker reports an idle state"
);
const skippedTriggerAfterCompleteCycle = {
  ...freshIdleStatus,
  checkedAt: "2026-07-13T12:03:06.000Z",
  lastCompleteCycle: freshIdleStatus.lastCycle,
  lastCycle: {
    ok: true,
    skipped: true,
    reason: "sync lock held",
    startedAt: "2026-07-13T12:03:05.000Z",
    finishedAt: "2026-07-13T12:03:05.003Z",
    durationMs: 3,
  },
};
assert.equal(
  readinessIdleEvidenceAfter(skippedTriggerAfterCompleteCycle, releaseWorkerStartedAt).state,
  "idle",
  "a post-cycle lock skip cannot erase the preserved readiness-safe complete cycle"
);
const identityMismatchReadiness = readinessIdleEvidenceAfter({
  ...freshIdleStatus,
  lastCycle: {
    ...freshIdleStatus.lastCycle,
    readinessSourceCycleObservation: {
      ...readyPublicationObservation,
      ready: false,
      samePublicationIdentity: false,
      blockers: ["public-sqlite-publication-identity-mismatch:generationId"],
      sqlite: {
        ...readyPublicationObservation.sqlite,
        generationId: `g-${"c".repeat(64)}`,
      },
    },
  },
}, releaseWorkerStartedAt);
assert.equal(
  identityMismatchReadiness.state,
  "pending",
  "matching sourceCycleId alone cannot make a cross-generation SQLite snapshot release-ready"
);
assert.ok(
  identityMismatchReadiness.readinessBlockers.includes(
    "public-sqlite-publication-identity-mismatch:generationId"
  )
);
const missingModelGenerationReconciliation = readinessIdleEvidenceAfter({
  ...freshIdleStatus,
  lastCycle: {
    ...freshIdleStatus.lastCycle,
    modelStrategyStep: {
      ok: true,
      skipped: false,
      script: "optimize:strategy",
    },
    modelReconciledGenerationStep: {
      ok: true,
      skipped: true,
      script: "datastore:generation",
    },
    modelReconciledSqliteStep: {
      ok: true,
      skipped: false,
      script: "datastore:sqlite",
    },
  },
}, releaseWorkerStartedAt);
assert.equal(missingModelGenerationReconciliation.state, "pending");
assert.ok(
  missingModelGenerationReconciliation.readinessBlockers.includes(
    "model-strategy-generation-reconciliation-not-ready"
  )
);
assert.equal(
  readinessIdleEvidenceAfter({ ...freshIdleStatus, cycleState: "running", phase: "official-result" }, releaseWorkerStartedAt).state,
  "pending",
  "a new running cycle invalidates a previously completed idle window"
);
assert.equal(
  readinessIdleEvidenceAfter({
    ...freshIdleStatus,
    lastCycle: {
      ...freshIdleStatus.lastCycle,
      startedAt: "2026-07-13T11:55:00.000Z",
      finishedAt: "2026-07-13T11:59:59.000Z",
    },
  }, releaseWorkerStartedAt).state,
  "pending",
  "a completed cycle from before the release marker is not readiness evidence"
);
assert.equal(
  readinessIdleEvidenceAfter({
    ...freshIdleStatus,
    ok: false,
    cycleState: "sleeping",
    phase: "failed",
    checkedAt: "2026-07-13T12:02:00.000Z",
    lastCycle: {
      ok: false,
      phase: "slow-enrichment-failed",
      startedAt: "2026-07-13T12:00:01.000Z",
      finishedAt: "2026-07-13T12:02:00.000Z",
      error: "post-enrichment export failed",
    },
  }, releaseWorkerStartedAt).state,
  "failed",
  "a failed fresh cycle must fail closed instead of being treated as idle"
);

const atomicStatusDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-status-"));
try {
  const atomicStatusPath = path.join(atomicStatusDir, "sync-worker-status.json");
  writeJsonAtomic(atomicStatusPath, oldPublishedStatus);
  writeJsonAtomic(atomicStatusPath, freshPublishedStatus);
  assert.deepEqual(JSON.parse(fs.readFileSync(atomicStatusPath, "utf8")), freshPublishedStatus);
  assert.deepEqual(
    fs.readdirSync(atomicStatusDir),
    ["sync-worker-status.json"],
    "atomic worker status publication must not leave temporary files"
  );
} finally {
  fs.rmSync(atomicStatusDir, { recursive: true, force: true });
}

const relaySemanticDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-relay-semantic-"));
try {
  const relaySemanticPath = path.join(relaySemanticDir, "sporttery-relay-fast-lane.json");
  const relaySemanticFixture = {
    capturedAt: "2026-07-13T12:00:00.000Z",
    sourceCycleId: "sporttery-relay:heartbeat-a",
    endpoints: [
      {
        method: "current",
        page: 1,
        url: "https://webapi.sporttery.cn/current",
        ok: true,
        rows: 2,
        canonicalPayloadSha256: "a".repeat(64),
        payload: { value: "current-a" },
      },
      {
        method: "calculator",
        page: 1,
        url: "https://webapi.sporttery.cn/calculator",
        ok: true,
        rows: 2,
        canonicalPayloadSha256: "b".repeat(64),
        payload: { value: "calculator-a" },
      },
    ],
  };
  fs.writeFileSync(relaySemanticPath, JSON.stringify(relaySemanticFixture), "utf8");
  const semanticBefore = relaySnapshotSemanticFileFingerprint(relaySemanticPath);
  fs.writeFileSync(relaySemanticPath, JSON.stringify({
    ...relaySemanticFixture,
    capturedAt: "2026-07-13T12:01:00.000Z",
    sourceCycleId: "sporttery-relay:heartbeat-b",
  }), "utf8");
  const semanticHeartbeatOnly = relaySnapshotSemanticFileFingerprint(relaySemanticPath);
  assert.equal(
    semanticHeartbeatOnly.token,
    semanticBefore.token,
    "relay envelope heartbeat clocks must not manufacture a semantic catch-up cycle",
  );
  fs.writeFileSync(relaySemanticPath, JSON.stringify({
    ...relaySemanticFixture,
    capturedAt: "2026-07-13T12:02:00.000Z",
    sourceCycleId: "sporttery-relay:market-change",
    endpoints: relaySemanticFixture.endpoints.map((endpoint, index) => (
      index === 0
        ? { ...endpoint, canonicalPayloadSha256: "c".repeat(64), payload: { value: "current-b" } }
        : endpoint
    )),
  }), "utf8");
  const semanticMarketChange = relaySnapshotSemanticFileFingerprint(relaySemanticPath);
  assert.equal(
    relaySnapshotChanged(semanticHeartbeatOnly, semanticMarketChange),
    true,
    "a signed current/calculator payload change during a long cycle must require immediate catch-up",
  );
} finally {
  fs.rmSync(relaySemanticDir, { recursive: true, force: true });
}

const strategyFingerprintDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-strategy-fingerprint-"));
try {
  const publicDir = path.join(strategyFingerprintDir, "public");
  const runtimeStoreDir = path.join(strategyFingerprintDir, "store");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(runtimeStoreDir, { recursive: true });
  const files = [
    path.join(publicDir, "model-strategy.json"),
    path.join(runtimeStoreDir, "model-strategy.json"),
    path.join(publicDir, "sync-meta.json"),
    path.join(publicDir, "model-calibration.json"),
    path.join(publicDir, "matches-current.json"),
  ];
  files.forEach((file, index) => fs.writeFileSync(file, JSON.stringify({ index }), "utf8"));
  const first = modelStrategyReconciliationFingerprint({ publicDir, runtimeStoreDir });
  files.forEach((file, index) => fs.writeFileSync(file, JSON.stringify({ index }), "utf8"));
  const sameContent = modelStrategyReconciliationFingerprint({ publicDir, runtimeStoreDir });
  assert.equal(sameContent, first, "mtime-only rewrites must not manufacture a model reconciliation");
  fs.writeFileSync(path.join(publicDir, "sync-meta.json"), JSON.stringify({ index: 2, changed: true }), "utf8");
  const changedContent = modelStrategyReconciliationFingerprint({ publicDir, runtimeStoreDir });
  assert.notEqual(changedContent, first, "a strategy reconciliation input change must require publication");

  const evaluation = {
    version: "rolling-backtest-v19",
    generatedAt: "2026-07-31T04:23:15.714Z",
    sample: { probabilityRows: 227, marketBaselineRows: 170 },
    shadowCandidates: { bestCandidateId: "candidate-current" },
    hhadCompanionEvaluation: { evaluatedAt: "2026-07-31T04:23:15.714Z" },
  };
  const staleStrategy = {
    generatedAt: "2026-07-29T12:05:18.076Z",
    activation: {
      promotionGate: {
        checkedAt: "2026-07-29T12:05:18.076Z",
        sourceEvaluationVersion: "rolling-backtest-v19",
        sample: { probabilityRows: 225, marketBaselineRows: 168 },
        shadowCandidate: { id: "candidate-current" },
      },
      shadowTracks: {
        HHAD_COMPANION: { evaluatedAt: "2026-07-29T12:04:04.116Z" },
      },
    },
  };
  fs.writeFileSync(path.join(publicDir, "model-evaluation.json"), JSON.stringify(evaluation), "utf8");
  fs.writeFileSync(path.join(publicDir, "model-strategy.json"), JSON.stringify(staleStrategy), "utf8");
  fs.writeFileSync(path.join(runtimeStoreDir, "model-strategy.json"), JSON.stringify(staleStrategy), "utf8");
  const staleRecovery = describeModelStrategyReconciliationNeed({ publicDir, runtimeStoreDir });
  assert.equal(staleRecovery.shouldRun, true);
  assert.deepEqual(staleRecovery.reasons, [
    "model-strategy-older-than-evaluation",
    "model-strategy-market-sample-mismatch",
    "model-strategy-probability-sample-mismatch",
    "model-strategy-hhad-evaluation-mismatch",
  ]);

  const currentStrategy = {
    ...staleStrategy,
    generatedAt: evaluation.generatedAt,
    activation: {
      ...staleStrategy.activation,
      promotionGate: {
        ...staleStrategy.activation.promotionGate,
        checkedAt: evaluation.generatedAt,
        sample: { probabilityRows: 227, marketBaselineRows: 170 },
      },
      shadowTracks: {
        HHAD_COMPANION: { evaluatedAt: evaluation.generatedAt },
      },
    },
  };
  fs.writeFileSync(path.join(publicDir, "model-strategy.json"), JSON.stringify(currentStrategy), "utf8");
  fs.writeFileSync(path.join(runtimeStoreDir, "model-strategy.json"), JSON.stringify(currentStrategy), "utf8");
  const currentRecovery = describeModelStrategyReconciliationNeed({ publicDir, runtimeStoreDir });
  assert.equal(currentRecovery.shouldRun, false);
  assert.deepEqual(currentRecovery.reasons, []);
} finally {
  fs.rmSync(strategyFingerprintDir, { recursive: true, force: true });
}

const sourceCycleDir = fs.mkdtempSync(path.join(os.tmpdir(), "football-worker-source-cycle-"));
try {
  const sourceCycleId = "sporttery-full-sync:2026-07-13T12:00:00.000Z";
  const publicationIdentity = {
    mode: "active-generation",
    generationId: `g-${"d".repeat(64)}`,
    manifestHash: "e".repeat(64),
    sourceCycleId,
    committedAt: "2026-07-13T12:00:06.000Z",
  };
  const syncMetaPath = path.join(sourceCycleDir, "sync-meta.json");
  const sqlitePath = path.join(sourceCycleDir, "football.db");
  fs.writeFileSync(syncMetaPath, JSON.stringify({
    sourceCycleId,
    updatedAt: "2026-07-13T12:00:05.000Z",
    capturedAt: "2026-07-13T12:00:00.000Z",
  }), "utf8");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE source_snapshots (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      captured_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO source_snapshots (id, source, captured_at, payload) VALUES (?, ?, ?, ?)").run(
    "sync-meta:current",
    "sporttery",
    "2026-07-13T12:00:00.000Z",
    JSON.stringify({ sourceCycleId })
  );
  const insertMeta = db.prepare(
    "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)"
  );
  const metaUpdatedAt = "2026-07-13T12:00:06.000Z";
  for (const [key, value] of Object.entries({
    sync_meta_updated_at: "2026-07-13T12:00:05.000Z",
    exported_at: metaUpdatedAt,
    data_generation_id: publicationIdentity.generationId,
    manifest_hash: publicationIdentity.manifestHash,
    data_generation_source_cycle_id: publicationIdentity.sourceCycleId,
    committed_at: publicationIdentity.committedAt,
  })) {
    insertMeta.run(key, value, metaUpdatedAt);
  }
  db.close();

  const readyStep = { ok: true, skipped: false };
  const resolvePublication = () => ({ identity: publicationIdentity });
  const matching = readSourceCycleObservation({
    phase: "self-test",
    validationStep: readyStep,
    generationStep: readyStep,
    sqliteStep: readyStep,
    syncMetaPath,
    sqlitePath,
    publicationStoreDir: sourceCycleDir,
    DatabaseClass: DatabaseSync,
    resolvePublication,
  });
  assert.equal(matching.ready, true, "matching public and SQLite source cycles open the model-input gate");
  assert.equal(matching.sameSourceCycle, true);
  assert.equal(matching.samePublicationIdentity, true);
  assert.equal(matching.public.sourceCycleId, sourceCycleId);
  assert.equal(matching.sqlite.sourceCycleId, sourceCycleId);
  assert.equal(matching.sqlite.generationId, publicationIdentity.generationId);
  assert.equal(matching.sqlite.manifestHash, publicationIdentity.manifestHash);
  assert.equal(matching.sqlite.generationSourceCycleId, publicationIdentity.sourceCycleId);
  assert.equal(matching.sqlite.committedAt, publicationIdentity.committedAt);

  const nextPublicationIdentity = {
    ...publicationIdentity,
    generationId: `g-${"f".repeat(64)}`,
    manifestHash: "1".repeat(64),
    committedAt: "2026-07-13T12:01:00.000Z",
  };
  const crossGeneration = readSourceCycleObservation({
    phase: "self-test",
    validationStep: readyStep,
    generationStep: readyStep,
    sqliteStep: readyStep,
    syncMetaPath,
    sqlitePath,
    publicationStoreDir: sourceCycleDir,
    DatabaseClass: DatabaseSync,
    resolvePublication: () => ({ identity: nextPublicationIdentity }),
  });
  assert.equal(
    crossGeneration.sameSourceCycle,
    true,
    "two distinct publications may legitimately share one source cycle"
  );
  assert.equal(crossGeneration.samePublicationIdentity, false);
  assert.equal(
    crossGeneration.ready,
    false,
    "a stale SQLite generation must fail closed even when sourceCycleId still matches"
  );
  for (const field of ["generationId", "manifestHash", "committedAt"]) {
    assert.ok(
      crossGeneration.blockers.includes(`public-sqlite-publication-identity-mismatch:${field}`)
    );
  }

  const mismatchDb = new DatabaseSync(sqlitePath);
  mismatchDb.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run(
    "sporttery-full-sync:stale",
    "data_generation_source_cycle_id"
  );
  mismatchDb.close();
  const mismatchedSourceCycle = readSourceCycleObservation({
    phase: "self-test",
    validationStep: readyStep,
    generationStep: readyStep,
    sqliteStep: readyStep,
    syncMetaPath,
    sqlitePath,
    publicationStoreDir: sourceCycleDir,
    DatabaseClass: DatabaseSync,
    resolvePublication,
  });
  assert.equal(mismatchedSourceCycle.ready, false, "a stale SQLite source cycle must fail closed");
  assert.ok(mismatchedSourceCycle.blockers.includes("public-sqlite-source-cycle-mismatch"));
  assert.ok(
    mismatchedSourceCycle.blockers.includes(
      "public-sqlite-publication-identity-mismatch:sourceCycleId"
    )
  );
} finally {
  fs.rmSync(sourceCycleDir, { recursive: true, force: true });
}

const verifyRelayWake = async () => {
  // Execute the real official-publication orchestration with transport doubles;
  // an invalid reconciliation must stop before validation or generation commit.
  const start = workerSource.indexOf('await onBeforeHeavyStep("reconcile:fast-results-generation:official")');
  const end = workerSource.indexOf("let officialPhaseFinishedAt", start);
  assert.ok(start > 0 && end > start);
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
    "onBeforeHeavyStep", "runOptional", "commandTimeouts", "runCommand", "npmCommand", "storeDir", "runtimeProjectionEnabled", "runRuntimeProjectionOrReuse", "storageMode",
    workerSource.slice(start, end) + "return officialFastResultReconciliationStep;",
  );
  for (const failing of [null, "reconcile:fast-results-generation", "validate:data"]) {
    const calls = [];
    const record = async name => { calls.push(name); if (name === failing) throw new Error("synthetic-stop"); return {ok:true,script:name}; };
    const task = () => execute(async () => {}, async (enabled, name, env, options) => {
      assert.equal(enabled, true); assert.notEqual(options?.fatal, false); return record(name);
    }, {validation:1000,sqlite:1000}, async (_npm, args) => record(args[1]), "synthetic-npm", "synthetic-store", true, async () => record("datastore:sqlite"), {postgresOnly:false});
    if (failing) await assert.rejects(task, /synthetic-stop/); else assert.equal((await task()).ok, true);
    assert.deepEqual(calls, failing === "reconcile:fast-results-generation" ? [failing]
      : failing === "validate:data" ? ["reconcile:fast-results-generation", failing]
      : ["reconcile:fast-results-generation", "validate:data", "datastore:generation", "datastore:sqlite"]);
  }
  const sharedArtifactEvents = [];
  const sharedArtifactResult = await runWithSharedSlowArtifactLock({
    enabled: true,
    script: "sync:weather",
    waitMs: 1234,
    acquireLock: async (options) => {
      sharedArtifactEvents.push(["acquire", options.waitMs, options.source]);
      return {
        acquired: true,
        release: async () => sharedArtifactEvents.push(["release"]),
      };
    },
    task: async () => {
      sharedArtifactEvents.push(["task"]);
      return { ok: true, script: "sync:weather" };
    },
  });
  assert.equal(sharedArtifactResult.ok, true);
  assert.equal(sharedArtifactResult.sharedArtifactSerialized, true);
  assert.equal(sharedArtifactEvents[0][0], "acquire");
  assert.ok(sharedArtifactEvents[0][1] > 0 && sharedArtifactEvents[0][1] <= 1234);
  assert.equal(sharedArtifactEvents[0][2], "shared-artifact:sync:weather");
  assert.deepEqual(sharedArtifactEvents.slice(1), [["task"], ["release"]]);
  let busyTaskRuns = 0;
  const busyArtifactResult = await runWithSharedSlowArtifactLock({
    enabled: true,
    script: "sync:prematch",
    waitMs: 0,
    acquireLock: async () => ({
      acquired: false,
      reason: "sync lock held",
      info: { owner: "background-slow" },
      ageMs: 42,
    }),
    task: async () => {
      busyTaskRuns += 1;
      return { ok: true };
    },
  });
  assert.equal(busyTaskRuns, 0);
  assert.equal(busyArtifactResult.ok, true);
  assert.equal(busyArtifactResult.skipped, true);
  assert.equal(busyArtifactResult.deferred, true);
  assert.equal(busyArtifactResult.reason, "shared-artifact-writer-busy");

  assert.doesNotMatch(
    workerSource,
    /capture-paused-for-model-backtest|withCandidateDeadlineCapturePaused/,
    "model backtests must not suspend the independent candidate deadline heartbeat",
  );

  assert.equal(candidateDeadlineCaptureTimeoutMs, 100_000);
  assert.equal(candidateDeadlineCaptureRetryMs, 5_000);
  assert.equal(candidateDeadlineCaptureRecoveryBudgetMs, 55_000);
  assert.equal(candidateDeadlineCaptureSafetyMarginMs, 10_000);
  assert.equal(candidateDeadlineHeartbeatFreshnessLimitMs, 180_000);
  assert.equal(candidateDeadlineCaptureTerminateGraceMs, 500);
  assert.equal(candidateDeadlineCaptureForceSettleMs, 500);
  assert.ok(
    candidateDeadlineCaptureTerminateGraceMs
      + candidateDeadlineCaptureForceSettleMs
      < candidateDeadlineCaptureTimeoutMs,
    "capture shutdown overhead is reserved inside the advertised 100s attempt budget",
  );
  assert.match(
    workerSource,
    /attemptTerminateGraceMs[\s\S]*attemptForceSettleMs[\s\S]*childExecutionTimeoutMs[\s\S]*boundedTimeoutMs[\s\S]*attemptTerminateGraceMs[\s\S]*attemptForceSettleMs/,
    "the candidate child execution timer subtracts termination and force-settle overhead",
  );
  assert.ok(
    (workerSource.match(/childExecutionTimeoutMs,/g) || []).length >= 4
      && (workerSource.match(/terminateGraceMs: attemptTerminateGraceMs/g) || []).length >= 4
      && (workerSource.match(/forceSettleMs: attemptForceSettleMs/g) || []).length >= 4,
    "attempt telemetry exposes execution and shutdown slices inside the total timeout",
  );
  assert.match(
    workerSource,
    /const startupResultRecoveryPlan = describeFiveHundredResultFallbackNeed\(\);[\s\S]*let startupDeadlineAdmissionPending = candidateDeadlineHeartbeat !== null;[\s\S]*const result = await runCycle/,
    "loop startup enters the official fast lane without awaiting candidate publication",
  );
  assert.match(
    workerSource,
    /candidateDeadlineHeartbeat = loop[\s\S]*startCandidateProspectiveDeadlineHeartbeat\(\)[\s\S]*candidateDeadlineHeartbeat\.waitForPublished\(\)\.then[\s\S]*startBenchmarkProspectiveDeadlineCapture\(\{ immediate: false \}\)/,
    "the benchmark lane is scheduled only after the first exact formal heartbeat",
  );
  assert.match(
    workerSource,
    /onBeforeHeavyStep: async \(\) => \{[\s\S]*candidateDeadlineHeartbeat\.waitForIdle\(\)[\s\S]*describeCandidateDeadlineStartupAdmission\([\s\S]*startupDeadlineAdmission\.waitForPublished[\s\S]*candidateDeadlineHeartbeat\.waitForStartupAdmission\(\)[\s\S]*candidateDeadlineHeartbeat\?\.waitForHealthy\(\{[\s\S]*allowImplementationDrift: candidateImplementationRefreezePending/,
    "startup observes the first capture and every heavy step enforces exact or latched refreeze admission",
  );
  assert.ok(
    (workerSource.match(/await onBeforeHeavyStep\(/g) || []).length >= 8,
    "memory-heavy generation, sqlite, enrichment and model stages drain an in-flight capture before launch",
  );
  assert.ok(
    workerSource.includes("candidate-prospective-capture-attempt-status.json")
      && workerSource.includes("candidate-prospective-capture-attempt-v1")
      && workerSource.includes("candidate-deadline-capture-status-not-advanced"),
    "deadline retries persist the real attempt result without advancing heartbeat evaluatedAt",
  );
  assert.ok(
    modelCandidateRegistryLockTimeoutMs > candidateDeadlineCaptureTimeoutMs,
    "the model candidate-registry commit must outwait one bounded deadline-capture child",
  );
  assert.match(
    workerSource,
    /CANDIDATE_PROSPECTIVE_REGISTRY_LOCK_TIMEOUT_MS:\s*\n\s*String\(modelCandidateRegistryLockTimeoutMs\)/,
    "the worker must pass its bounded handoff budget only to model:backtest",
  );
  assert.match(
    modelBacktestSource,
    /withCandidateProspectiveRegistryLock\(\s*\n\s*candidateProspectiveRegistryFile,[\s\S]*?\{ timeoutMs: candidateProspectiveRegistryLockTimeoutMs \},\s*\n\);/,
    "the backtest candidate-registry commit must consume the worker handoff budget",
  );
  const commandResult = {
    ok: true,
    startedAt: "2026-08-01T11:30:30.000Z",
  };
  assert.equal(candidateDeadlineCaptureStatusAdvanced(
    commandResult,
    exactDeadlineHeartbeatFixture("2026-08-01T11:30:30.001Z"),
  ), true);
  assert.equal(candidateDeadlineCaptureStatusAdvanced(
    commandResult,
    exactDeadlineHeartbeatFixture("2026-08-01T11:30:24.000Z"),
  ), false, "a lock-busy child cannot reuse the prior heartbeat as a successful refresh");
  assert.equal(candidateDeadlineCaptureStatusAdvanced(
    commandResult,
    exactDeadlineHeartbeatFixture("2026-08-01T11:30:30.001Z", {
      ok: false,
      skipped: true,
      blockers: ["registry-lock-busy"],
    }),
  ), false, "a newly timestamped lock-busy status cannot resolve first publication");

  let persistedFailureAttempt = null;
  let observedCaptureArgs = null;
  const captureFailure = new Error("fixture capture timed out");
  captureFailure.code = "SYNC_WORKER_COMMAND_TIMEOUT";
  captureFailure.exitCode = 1;
  captureFailure.signal = "SIGKILL";
  const failedCapture = await runCandidateProspectiveDeadlineCapture({
    timeoutMs: 5_000,
    attemptKind: "telemetry-self-test",
    run: async (_command, args) => {
      observedCaptureArgs = args;
      throw captureFailure;
    },
    readStatus: () => ({
      version: "prospective-deadline-heartbeat-v2",
      evaluatedAt: "9999-01-01T00:00:00.000Z",
      ok: false,
      reason: "deadline-evidence-query-incomplete",
    }),
    writeAttempt: (attempt) => { persistedFailureAttempt = attempt; },
  });
  assert.equal(failedCapture.ok, false);
  assert.equal(failedCapture.errorCode, "SYNC_WORKER_COMMAND_TIMEOUT");
  assert.equal(failedCapture.statusAdvanced, false);
  assert.equal(
    failedCapture.publishedStatusReason,
    "deadline-evidence-query-incomplete",
  );
  assert.equal(persistedFailureAttempt.exitCode, 1);
  assert.equal(persistedFailureAttempt.signal, "SIGKILL");
  assert.equal(persistedFailureAttempt.publishedStatusOk, false);
  assert.deepEqual(
    observedCaptureArgs,
    [path.join(__dirname, "captureCandidateProspectiveDeadline.cjs"), "--deadline-only"],
    "the worker heartbeat must not wait for the benchmark lane",
  );

  let observedBenchmarkArgs = null;
  let persistedBenchmarkAttempt = null;
  const benchmarkStartedAt = "2026-08-01T11:31:00.000Z";
  const benchmarkEvaluatedAt = "2026-08-01T11:31:00.001Z";
  const benchmarkCapture = await runBenchmarkProspectiveDeadlineCapture({
    run: async (_command, args) => {
      observedBenchmarkArgs = args;
      return { ok: true, startedAt: benchmarkStartedAt, finishedAt: benchmarkEvaluatedAt };
    },
    readStatus: () => ({
      version: "goodwin-benchmark-deadline-capture-v1",
      captureMode: "benchmark-only",
      evaluatedAt: benchmarkEvaluatedAt,
      ok: true,
      skipped: false,
      blockers: [],
      dueMatches: 1,
      eventsAdded: 1,
    }),
    writeAttempt: (attempt) => { persistedBenchmarkAttempt = attempt; },
  });
  assert.equal(benchmarkCapture.ok, true);
  assert.equal(benchmarkCapture.dueMatches, 1);
  assert.deepEqual(
    observedBenchmarkArgs,
    [path.join(__dirname, "captureCandidateProspectiveDeadline.cjs"), "--benchmark-only"],
  );
  assert.equal(persistedBenchmarkAttempt.ok, true);
  assert.equal(benchmarkDeadlineCaptureStatusAdvanced(
    { ok: true, startedAt: benchmarkStartedAt },
    {
      version: "goodwin-benchmark-deadline-capture-v1",
      captureMode: "benchmark-only",
      evaluatedAt: benchmarkEvaluatedAt,
      ok: true,
      skipped: false,
      blockers: [],
    },
  ), true);
  assert.equal(benchmarkDeadlineCaptureStatusAdvanced(
    { ok: true, startedAt: benchmarkStartedAt },
    {
      version: "goodwin-benchmark-deadline-capture-v1",
      captureMode: "benchmark-only",
      evaluatedAt: benchmarkEvaluatedAt,
      ok: false,
      skipped: true,
      blockers: ["ledger-lock-busy"],
    },
  ), false);
  assert.equal(benchmarkDeadlineCaptureEnabled, true);
  assert.ok(benchmarkDeadlineCaptureIntervalMs <= 5 * 60_000);
  assert.ok(benchmarkDeadlineCaptureTimeoutMs < benchmarkDeadlineCaptureIntervalMs);

  const benchmarkCutoffMs = Date.parse("2026-08-01T12:00:00.000Z");
  const benchmarkKickoffMs = benchmarkCutoffMs + 10 * 60_000;
  let benchmarkClockMs = benchmarkCutoffMs - 60_000;
  let benchmarkScheduledDelayMs = null;
  const benchmarkWindowScheduler = startBenchmarkProspectiveDeadlineCapture({
    immediate: false,
    now: () => benchmarkClockMs,
    timer: (_callback, milliseconds) => {
      benchmarkScheduledDelayMs = milliseconds;
      return { unref: () => {} };
    },
    clearTimer: () => {},
  });
  assert.equal(benchmarkScheduledDelayMs, benchmarkDeadlineCaptureIntervalMs);
  const firstPostCutoffCaptureMs = benchmarkClockMs + benchmarkScheduledDelayMs;
  assert.ok(firstPostCutoffCaptureMs >= benchmarkCutoffMs);
  assert.ok(
    firstPostCutoffCaptureMs < benchmarkKickoffMs,
    "a <=5-minute resident cadence must observe the kickoff-minus-10-minute benchmark window",
  );
  benchmarkWindowScheduler.stop();

  let resolveBenchmarkAttempt = null;
  let benchmarkSingleFlightCalls = 0;
  const benchmarkSingleFlight = startBenchmarkProspectiveDeadlineCapture({
    immediate: true,
    run: () => {
      benchmarkSingleFlightCalls += 1;
      return new Promise((resolve) => { resolveBenchmarkAttempt = resolve; });
    },
    timer: () => ({ unref: () => {} }),
    clearTimer: () => {},
  });
  await Promise.resolve();
  const activeBenchmarkAttempt = benchmarkSingleFlight.tick();
  assert.equal(benchmarkSingleFlightCalls, 1, "benchmark cadence must remain single-flight");
  resolveBenchmarkAttempt({ ok: false, skipped: false, reason: "fixture-nonfatal" });
  assert.equal((await activeBenchmarkAttempt).ok, false);
  benchmarkSingleFlight.stop();

  const heartbeatEpochMs = Date.parse("2026-08-01T11:30:00.000Z");
  const preemptivePlan = candidateDeadlinePreemptiveSchedule(
    new Date(heartbeatEpochMs).toISOString(),
    heartbeatEpochMs,
  );
  assert.equal(preemptivePlan.version, "candidate-heartbeat-preemptive-schedule-v1");
  assert.equal(preemptivePlan.refreshAgeMs, 10_000);
  assert.equal(preemptivePlan.requiredReserveMs, 170_000);
  assert.equal(preemptivePlan.projectedWorstCaseCompletionAgeMs, 170_000);
  assert.equal(preemptivePlan.budgetFits, true);
  assert.ok(
    remotePublicReadinessSource.includes(
      "Number(candidateCaptureHeartbeat?.intervalSeconds || 0) >= 1",
    ),
    "public readiness accepts the derived ten-second preemptive heartbeat interval",
  );
  assert.equal(
    preemptivePlan.refreshAgeMs + 100_000 + 5_000 + 55_000,
    170_000,
    "a full 100s failure, 5s retry and bounded 55s recovery completes before 180s",
  );
  assert.ok(
    preemptivePlan.refreshAgeMs + 100_000 + 5_000 + 55_000
      < candidateDeadlineHeartbeatFreshnessLimitMs,
  );
  const explicitlyImpossibleBudget = candidateHeartbeatPreemptiveSchedule({
    evaluatedAt: new Date(heartbeatEpochMs).toISOString(),
    nowMs: heartbeatEpochMs,
    freshnessLimitMs: 120_000,
    attemptTimeoutMs: 60_000,
    retryMs: 10_000,
    recoveryCaptureMs: 60_000,
    safetyMarginMs: 10_000,
  });
  assert.equal(
    explicitlyImpossibleBudget.budgetFits,
    false,
    "an impossible failure budget remains visibly unsafe instead of faking freshness",
  );
  assert.ok(explicitlyImpossibleBudget.projectedWorstCaseCompletionAgeMs > 120_000);
  const latePrimaryBudget = candidateDeadlineAttemptBudget({
    evaluatedAt: new Date(heartbeatEpochMs).toISOString(),
    nowMs: heartbeatEpochMs + 43_000,
    recoveryAttempt: false,
  });
  assert.equal(latePrimaryBudget.heartbeatAgeMs, 43_000);
  assert.equal(latePrimaryBudget.timeoutMs, 67_000);
  assert.equal(latePrimaryBudget.projectedCompletionAgeMs, 170_000);
  assert.equal(latePrimaryBudget.budgetFits, true);
  assert.equal(
    43_000 + latePrimaryBudget.timeoutMs + 5_000 + 55_000,
    170_000,
    "a prior capture dynamically shortens the next primary attempt before retry",
  );
  const failedPrimaryAttempt = {
    finishedAt: new Date(heartbeatEpochMs + 61_000).toISOString(),
    statusAdvanced: false,
    attemptKind: "preemptive-primary",
  };
  const recoveryNextAttempt = candidateHeartbeatNextAttempt({
    evaluatedAt: new Date(heartbeatEpochMs).toISOString(),
    attempt: failedPrimaryAttempt,
    nowMs: heartbeatEpochMs + 65_000,
    freshnessLimitMs: 120_000,
    attemptTimeoutMs: 45_000,
    retryMs: 5_000,
    recoveryCaptureMs: 45_000,
    safetyMarginMs: 10_000,
  });
  assert.equal(recoveryNextAttempt.attemptType, "preemptive-recovery");
  assert.equal(recoveryNextAttempt.recoveryAttempt, true);
  assert.equal(recoveryNextAttempt.timeoutMs, 45_000);
  assert.equal(recoveryNextAttempt.projectedCompletionAgeMs, 110_000);
  assert.equal(recoveryNextAttempt.budgetFits, true);
  const staleRecoveryNextAttempt = candidateHeartbeatNextAttempt({
    evaluatedAt: new Date(heartbeatEpochMs).toISOString(),
    attempt: failedPrimaryAttempt,
    nowMs: heartbeatEpochMs + 145_000,
    freshnessLimitMs: 120_000,
    attemptTimeoutMs: 45_000,
    retryMs: 5_000,
    recoveryCaptureMs: 45_000,
    safetyMarginMs: 10_000,
  });
  assert.equal(staleRecoveryNextAttempt.attemptType, "preemptive-recovery");
  assert.equal(
    staleRecoveryNextAttempt.timeoutMs,
    45_000,
    "a stale heartbeat reports the real recovery timeout instead of the 1s primary floor",
  );
  assert.equal(staleRecoveryNextAttempt.projectedCompletionAgeMs, 190_000);
  assert.equal(staleRecoveryNextAttempt.budgetFits, false);
  const newerPublishedHeartbeat = candidateHeartbeatNextAttempt({
    evaluatedAt: new Date(heartbeatEpochMs + 70_000).toISOString(),
    attempt: failedPrimaryAttempt,
    nowMs: heartbeatEpochMs + 75_000,
    freshnessLimitMs: 120_000,
    attemptTimeoutMs: 45_000,
    retryMs: 5_000,
    recoveryCaptureMs: 45_000,
    safetyMarginMs: 10_000,
  });
  assert.equal(
    newerPublishedHeartbeat.attemptType,
    "preemptive-primary",
    "a failed attempt older than the published heartbeat cannot force recovery telemetry",
  );
  assert.equal(newerPublishedHeartbeat.recoveryAttempt, false);

  let clockMs = heartbeatEpochMs;
  let normalCallback = null;
  let normalDelayMs = null;
  let normalTimerCalls = 0;
  let normalTimerUnrefCalls = 0;
  let retryCallback = null;
  let retryDelayMs = null;
  let retryTimerCalls = 0;
  let retryTimerUnrefCalls = 0;
  let heartbeatTicks = 0;
  let resolveFirstAttempt = null;
  let firstRunOptions = null;
  let recoveryRunOptions = null;
  let publishedHeartbeatStatus = exactDeadlineHeartbeatFixture(
    new Date(heartbeatEpochMs).toISOString(),
  );
  const heartbeat = startCandidateProspectiveDeadlineHeartbeat({
    immediate: false,
    now: () => clockMs,
    readStatus: () => publishedHeartbeatStatus,
    run: async (options) => {
      heartbeatTicks += 1;
      if (heartbeatTicks === 1) {
        firstRunOptions = options;
        return new Promise((resolve) => { resolveFirstAttempt = resolve; });
      }
      recoveryRunOptions = options;
      const recoveryStartedAt = clockMs;
      clockMs += 55_000;
      publishedHeartbeatStatus = exactDeadlineHeartbeatFixture(
        new Date(recoveryStartedAt).toISOString(),
      );
      return {
        ok: true,
        skipped: false,
        statusEvaluatedAt: new Date(recoveryStartedAt).toISOString(),
      };
    },
    timer: (callback, milliseconds) => {
      normalTimerCalls += 1;
      normalCallback = callback;
      normalDelayMs = milliseconds;
      return { unref: () => { normalTimerUnrefCalls += 1; } };
    },
    clearTimer: () => {},
    retryTimer: (callback, milliseconds) => {
      retryTimerCalls += 1;
      retryCallback = callback;
      retryDelayMs = milliseconds;
      return { unref: () => { retryTimerUnrefCalls += 1; } };
    },
    clearRetryTimer: () => {
      retryCallback = null;
    },
  });
  assert.ok(heartbeat);
  assert.equal(normalDelayMs, 10_000);
  assert.equal(normalTimerCalls, 1);
  assert.equal(
    normalTimerUnrefCalls,
    0,
    "a pre-publication timer keeps startup alive while the first exact heartbeat is pending",
  );
  clockMs += normalDelayMs;
  const firstPending = normalCallback();
  await Promise.resolve();
  assert.strictEqual(
    heartbeat.tick(),
    firstPending,
    "a phase barrier observes the existing capture instead of spawning a competing child",
  );
  assert.equal(heartbeatTicks, 1);
  assert.equal(firstRunOptions.attemptKind, "preemptive-primary");
  assert.equal(firstRunOptions.timeoutMs, 100_000);
  assert.equal(normalTimerCalls, 1, "no setInterval tick is armed while capture is in flight");
  assert.equal(retryTimerCalls, 0, "retry is scheduled only after the attempt fails");
  clockMs += 100_000;
  resolveFirstAttempt({
    ok: false,
    skipped: false,
    reason: "candidate-deadline-capture-status-not-advanced",
  });
  await firstPending;
  let firstPublicationResolved = false;
  heartbeat.waitForPublished().then(() => { firstPublicationResolved = true; });
  await Promise.resolve();
  assert.equal(
    firstPublicationResolved,
    false,
    "a failed or lock-busy first attempt cannot resolve firstPublication",
  );
  assert.equal(retryDelayMs, 5_000);
  assert.equal(typeof retryCallback, "function");
  assert.equal(
    retryTimerUnrefCalls,
    0,
    "a failed first heartbeat keeps its recovery timer referenced instead of letting Node exit cleanly",
  );
  const firstRetry = retryCallback;
  clockMs += retryDelayMs;
  await firstRetry();
  const firstPublished = await heartbeat.waitForPublished();
  assert.equal(firstPublished.ok, true);
  assert.equal(
    firstPublished.statusEvaluatedAt,
    new Date(heartbeatEpochMs + 115_000).toISOString(),
    "startup admission observes the exact heartbeat published by recovery",
  );
  assert.equal(heartbeatTicks, 2);
  assert.equal(recoveryRunOptions.attemptKind, "preemptive-recovery");
  assert.equal(recoveryRunOptions.timeoutMs, 55_000);
  assert.equal(retryTimerCalls, 1, "a successful retry does not schedule another retry");
  assert.equal(normalTimerUnrefCalls, 1, "steady-state cadence timers are unref'ed after startup admission");
  assert.equal(
    clockMs - heartbeatEpochMs,
    170_000,
    "the deterministic full-failure recovery path publishes before freshness expires",
  );
  assert.ok(clockMs - heartbeatEpochMs < candidateDeadlineHeartbeatFreshnessLimitMs);
  assert.equal(normalDelayMs, 0, "a missed preventive slot is caught up immediately after recovery");
  assert.equal(heartbeat.schedule.due, true);
  assert.equal(
    (await heartbeat.waitForHealthy()).evaluatedAt,
    firstPublished.statusEvaluatedAt,
    "every heavy-step barrier revalidates the exact published status",
  );
  const timerCallsBeforePause = normalTimerCalls;
  heartbeat.pause();
  assert.equal(heartbeat.paused, true);
  const pausedTick = await heartbeat.tick();
  assert.equal(pausedTick.skipped, true);
  assert.equal(pausedTick.reason, "candidate-deadline-heartbeat-paused");
  assert.equal(heartbeatTicks, 2, "a release handoff cannot launch another registry writer");
  heartbeat.resume();
  assert.equal(heartbeat.paused, false);
  assert.equal(
    normalTimerCalls,
    timerCallsBeforePause + 1,
    "the ordinary heartbeat cadence resumes after the release handoff",
  );
  heartbeat.stop();

  let driftRaceClockMs = heartbeatEpochMs + 20_000;
  let driftRaceRuns = 0;
  let driftRaceStatus = exactDeadlineHeartbeatFixture(
    new Date(heartbeatEpochMs).toISOString(),
  );
  const driftRaceHeartbeat = startCandidateProspectiveDeadlineHeartbeat({
    immediate: true,
    now: () => driftRaceClockMs,
    readStatus: () => driftRaceStatus,
    run: async () => {
      driftRaceRuns += 1;
      if (driftRaceRuns === 1) {
        const evaluatedAt = new Date(driftRaceClockMs).toISOString();
        driftRaceStatus = implementationDriftHeartbeatFixture(evaluatedAt);
        return {
          ok: false,
          skipped: false,
          reason: "candidate-deadline-capture-status-not-advanced",
          statusEvaluatedAt: evaluatedAt,
        };
      }
      driftRaceClockMs += 1_000;
      const evaluatedAt = new Date(driftRaceClockMs).toISOString();
      driftRaceStatus = exactDeadlineHeartbeatFixture(evaluatedAt);
      return {
        ok: true,
        skipped: false,
        statusEvaluatedAt: evaluatedAt,
      };
    },
    timer: () => ({ unref() {} }),
    clearTimer: () => {},
    retryTimer: () => ({ unref() {} }),
    clearRetryTimer: () => {},
  });
  await driftRaceHeartbeat.waitForIdle();
  const driftStartupAdmission = await driftRaceHeartbeat.waitForStartupAdmission();
  assert.equal(driftStartupAdmission.kind, "implementation-drift-refreeze");
  assert.equal(driftStartupAdmission.recoveryRequired, true);
  assert.equal(
    (await driftRaceHeartbeat.waitForHealthy({ allowImplementationDrift: true }))
      .recoveryRequired,
    true,
    "only the pre-refreeze heavy lane may observe the explicit recovery hold",
  );
  let driftRacePublicationResolved = false;
  driftRaceHeartbeat.waitForPublished().then(() => {
    driftRacePublicationResolved = true;
  });
  await Promise.resolve();
  assert.equal(
    driftRacePublicationResolved,
    false,
    "implementation drift never manufactures an exact publication or starts benchmark work",
  );
  await driftRaceHeartbeat.tick({ recoveryAttempt: true });
  const refrozenPublication = await driftRaceHeartbeat.waitForPublished();
  assert.equal(refrozenPublication.statusEvaluatedAt, driftRaceStatus.evaluatedAt);
  assert.equal(driftRacePublicationResolved, true);
  assert.equal(
    (await driftRaceHeartbeat.waitForHealthy()).evaluatedAt,
    driftRaceStatus.evaluatedAt,
    "strict health becomes available only after the refrozen exact heartbeat",
  );
  driftRaceHeartbeat.stop();

  // A newly refrozen, non-nominated revision must not need fake activation
  // to cross the real heavy-step health barrier (the r704 failure).
  const { updateCandidateProspectiveLedger } = require("./candidateProspectiveLedger.cjs");
  const { buildShadowObservationState } = require("../src/services/candidateCaptureState.cjs");
  const shadowCandidate = { id: "shadow-worker-test", role: "shadow-feature-candidate", weights: { market: 1, temperature: 1.25 } };
  const shadowAt = new Date(heartbeatEpochMs).toISOString();
  const shadowUpdate = updateCandidateProspectiveLedger({
    candidates: [shadowCandidate], selectedCandidate: shadowCandidate, evaluatedAt: shadowAt,
  });
  assert.equal(shadowUpdate.audit.state, "SHADOW");
  const shadowStatus = exactDeadlineHeartbeatFixture(shadowAt);
  shadowStatus.audit = { ...shadowUpdate.audit, captureState: buildShadowObservationState(shadowUpdate.audit) };
  shadowStatus.readiness.candidateRevisionId = shadowUpdate.audit.candidateRevisionId;
  const shadowHeartbeat = startCandidateProspectiveDeadlineHeartbeat({
    immediate: false, now: () => heartbeatEpochMs + 1000, readStatus: () => shadowStatus,
    run: async () => { throw new Error("valid shadow status should not trigger recovery"); },
    timer: () => ({ unref() {} }), clearTimer: () => {},
    retryTimer: () => ({ unref() {} }), clearRetryTimer: () => {},
  });
  try {
    const healthyShadow = await shadowHeartbeat.waitForHealthy();
    assert.equal(healthyShadow.audit.state, "SHADOW");
    assert.equal(healthyShadow.audit.activationAt, null);
    assert.equal(healthyShadow.audit.formalPromotionEligible, false);
  } finally { shadowHeartbeat.stop(); }

  const baseline = { exists: true, token: "relay-a" };
  assert.equal(relaySnapshotChanged(baseline, { exists: true, token: "relay-b" }), true);
  assert.equal(relaySnapshotChanged(baseline, { exists: false, token: null }), false);

  let clock = 0;
  let sleeps = 0;
  let token = "relay-a";
  const wake = await waitForNextCycle(90_000, {
    baseline,
    pollMs: 2_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps += 1;
      if (sleeps === 2) token = "relay-b";
    },
    readFingerprint: () => ({ exists: true, token })
  });
  assert.equal(wake.reason, "relay-snapshot-updated");
  assert.equal(wake.waitedMs, 4_000);

  clock = 0;
  const interval = await waitForNextCycle(5_000, {
    baseline,
    pollMs: 2_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readFingerprint: () => baseline
  });
  assert.equal(interval.reason, "interval-elapsed");
  assert.equal(interval.waitedMs, 5_000);

  clock = 0;
  const baseCadenceWait = await waitForNextCycle(5_000, {
    baseline,
    enabled: false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readFingerprint: () => ({ exists: true, token: "relay-b" })
  });
  assert.equal(baseCadenceWait.reason, "interval-elapsed");
  assert.equal(baseCadenceWait.waitedMs, 5_000);

  let statusWriteLogs = 0;
  const failedStatusWrite = writeWorkerStatusBestEffort(
    { phase: "fault-injection" },
    {
      write: () => {
        const error = new Error("simulated-status-disk-failure");
        error.code = "ENOSPC";
        throw error;
      },
      log: () => { statusWriteLogs += 1; },
    },
  );
  assert.equal(failedStatusWrite.ok, false);
  assert.equal(failedStatusWrite.error.code, "ENOSPC");
  assert.equal(statusWriteLogs, 1);

  let unhandledRejections = 0;
  const observeUnhandled = () => { unhandledRejections += 1; };
  process.on("unhandledRejection", observeUnhandled);
  let trackerCurrentChanges = 0;
  const statusFailingTracker = createBackgroundSlowPhaseTracker({
    readStatus: () => ({ cycleState: "sleeping" }),
    writeStatus: () => { throw new Error("simulated-background-status-write-failure"); },
    log: () => {},
    onCurrentChange: () => { trackerCurrentChanges += 1; },
  });
  const terminalTrackedTask = statusFailingTracker.track(
    Promise.reject(new Error("simulated-background-task-rejection")),
    { startedAt: "2026-07-13T12:00:00.000Z" },
  );
  assert.strictEqual(statusFailingTracker.current, terminalTrackedTask);
  assert.equal(await terminalTrackedTask, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandledRejections, 0);
  assert.equal(statusFailingTracker.current, null);
  assert.equal(trackerCurrentChanges, 2);

  let rejectDrainTask = null;
  const neverSettledUntilRejected = new Promise((resolve, reject) => {
    rejectDrainTask = reject;
  });
  let drainTimerBudget = null;
  const drainTimeout = await waitForBackgroundSlowPhaseDrain(
    neverSettledUntilRejected,
    {
      budgetMs: 25,
      timer: (callback, milliseconds) => {
        drainTimerBudget = milliseconds;
        queueMicrotask(callback);
        return { id: "release-drain-timeout" };
      },
      clearTimer: () => {},
    },
  );
  assert.equal(drainTimeout.ok, false);
  assert.equal(drainTimeout.blocked, true);
  assert.equal(drainTimeout.code, "SYNC_WORKER_RELEASE_DRAIN_TIMEOUT");
  assert.equal(drainTimerBudget, 25);
  rejectDrainTask(new Error("late-background-rejection-after-release-timeout"));
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", observeUnhandled);
  assert.equal(unhandledRejections, 0);

  assert.equal(
    officialCompensationRequired({
      slowPhaseRunning: true,
      cycle: {
        skipped: true,
        reason: "sync lock held",
        lock: { source: "sync-worker-consolidated-slow-publication" },
      },
    }),
    true,
  );
  assert.equal(
    officialCompensationRequired({
      slowPhaseRunning: true,
      cycle: {
        skipped: true,
        reason: "sync lock held",
        lock: { source: "manual-unrelated-writer" },
      },
    }),
    false,
  );
  clock = 0;
  const compensationWake = await waitForNextCycle(300_000, {
    baseline,
    enabled: false,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    wakePromise: Promise.resolve({
      reason: "background-slow-phase-settled-official-compensation",
    }),
  });
  assert.equal(
    compensationWake.reason,
    "background-slow-phase-settled-official-compensation",
  );
  assert.ok(compensationWake.waitedMs <= 2_000);

  const shutdownSignals = [];
  let forceShutdown = null;
  const fakeShutdownChild = { pid: 4242, exitCode: null, signalCode: null };
  const shutdownController = createWorkerShutdownController({
    terminate: (child, signal) => {
      shutdownSignals.push([child.pid, signal]);
      return true;
    },
    timer: (callback) => {
      forceShutdown = callback;
      return { unref: () => {} };
    },
    clearTimer: () => {},
    now: () => "2026-07-13T12:00:00.000Z",
    terminateGraceMs: 25,
  });
  shutdownController.register(fakeShutdownChild);
  const shutdownWake = shutdownController.wakePromise;
  const shutdownRequest = shutdownController.requestShutdown("SIGINT");
  assert.equal(shutdownRequest.signal, "SIGINT");
  assert.deepEqual(shutdownSignals, [[4242, "SIGTERM"]]);
  assert.equal((await shutdownWake).reason, "worker-shutdown-requested");
  forceShutdown();
  assert.deepEqual(shutdownSignals, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  shutdownController.unregister(fakeShutdownChild);
  shutdownController.dispose();

  let lockAttempts = 0;
  await assert.rejects(
    acquireSyncLockInterruptibly({
      waitMs: 30_000,
      isInterrupted: () => lockAttempts > 0,
      acquireLock: async () => {
        lockAttempts += 1;
        return { acquired: false, reason: "sync lock held" };
      },
    }),
    (error) => error?.code === "SYNC_WORKER_INTERRUPTED",
  );
  assert.equal(lockAttempts, 1);

  return {
    wake,
    interval,
    baseCadenceWait,
    compensationWake,
    drainTimeout,
    heartbeatTicks,
    preemptivePlan,
    deterministicRecoveryAgeMs: clockMs - heartbeatEpochMs,
  };
};

verifyRelayWake().then(({
  wake,
  interval,
  baseCadenceWait,
  compensationWake,
  drainTimeout,
  heartbeatTicks,
  preemptivePlan,
  deterministicRecoveryAgeMs,
}) => {
  console.log(JSON.stringify({
    ok: true,
    verifier: "sync-worker-cadence",
    pendingReason: pending.reason,
    pendingIntervalMs: pending.intervalMs,
    liveReason: live.reason,
    liveIntervalMs: live.intervalMs,
    oldPendingMode: oldPending.mode,
    undatedPendingMode: undatedPending.mode,
    recentKickoffReason: staleScheduled.reason,
    officialDeadlineHotReason: deadlineHot.reason,
    officialDeadlineHotMinutes: deadlineHot.deadlineHotMatches[0].minutesToDecisionDeadline,
    officialDeadlineLaterMode: deadlineNotYetHot.mode,
    fallbackCutoffNearKickoffIntervalMs: fallbackCutoffNearKickoff.intervalMs,
    postDeadlineNearKickoffIntervalMs: postDeadlineNearKickoff.intervalMs,
    pendingResultFallback: pendingFallback.needed,
    lateScheduledFallback: lateScheduledFallback.needed,
    fixedStartDelayMs: 70_000,
    overrunIdleMs: configuredMinimumLoopIdleMs,
    postDeadlineCooldownMs: configuredPostDeadlineHotIntervalMs,
    relayWakeReason: wake.reason,
    relayWakeLatencyMs: wake.waitedMs,
    unchangedRelayWaitMs: interval.waitedMs,
    baseCadenceWaitMs: baseCadenceWait.waitedMs,
    officialCompensationWakeReason: compensationWake.reason,
    releaseDrainTimeoutCode: drainTimeout.code,
    releaseDrainBudgetSeconds: releaseSlowPhaseDrainBudgetMs / 1000,
    candidateDeadlineConfiguredIntervalSeconds:
      candidateDeadlineCaptureIntervalMs / 1000,
    candidateDeadlinePreemptiveRefreshSeconds:
      preemptivePlan.refreshAgeMs / 1000,
    candidateDeadlinePreemptiveReserveSeconds:
      preemptivePlan.requiredReserveMs / 1000,
    candidateDeadlineWorstCaseCompletionSeconds:
      preemptivePlan.projectedWorstCaseCompletionAgeMs / 1000,
    candidateDeadlineDeterministicRecoverySeconds:
      deterministicRecoveryAgeMs / 1000,
    candidateDeadlinePreemptiveBudgetFits: preemptivePlan.budgetFits,
    candidateDeadlineHeartbeatRetrySeconds: candidateDeadlineCaptureRetryMs / 1000,
    candidateDeadlineHeartbeatTimeoutSeconds: candidateDeadlineCaptureTimeoutMs / 1000,
    modelCandidateRegistryLockTimeoutSeconds: modelCandidateRegistryLockTimeoutMs / 1000,
    candidateDeadlineHeartbeatTicks: heartbeatTicks,
    candidateDeadlineHeartbeatPausesForModelBacktest: false,
    candidateDeadlineAttemptTelemetry: true,
    stages,
    officialFirst: true,
    officialReconciliationBeforeGeneration: true,
    failedOfficialReconciliationPreventsPublication: true,
    releaseEvidenceRejectsOldCycle: true,
    releaseReadinessRejectsRunningCycle: true,
    releaseReadinessRequiresFreshCompletedIdle: true,
    workerStatusAtomic: true,
    fullSyncRunsPerCycle: 1,
  }, null, 2));
}).catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
