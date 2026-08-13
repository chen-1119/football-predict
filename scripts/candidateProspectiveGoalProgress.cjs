"use strict";

const REQUIRED_DECISION_FIELDS = [
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
];

const REQUIRED_SETTLEMENT_FIELDS = [
  "decision-link",
  "official-result-identity",
  "score-outcome-consistency",
  "result-observation-clock",
  "result-provenance-hash",
];

const count = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const blockerTotal = (value) => Object.values(
  value && typeof value === "object" ? value : {},
).reduce((sum, item) => sum + Math.max(0, Number(item || 0)), 0);

const includesEvery = (values, required) => {
  const set = new Set(Array.isArray(values) ? values : []);
  return required.every((field) => set.has(field));
};

const evaluateCandidateProspectiveGoal = (
  prospective,
  {
    targetRows = 500,
    requiredWindows = 6,
    requiredWinningWindows = 5,
  } = {},
) => {
  const thresholds = {
    targetRows: positiveInteger(targetRows, 500),
    requiredWindows: positiveInteger(requiredWindows, 6),
    requiredWinningWindows: positiveInteger(requiredWinningWindows, 5),
  };
  const candidate = prospective && typeof prospective === "object"
    ? prospective
    : {};
  const decision = candidate.decisionRecord || {};
  const settlement = candidate.settlementRecord || {};
  const formal = candidate.cohort?.formal || {};
  const metrics = candidate.metrics || {};
  const heartbeat = candidate.captureHeartbeat || {};
  const readiness = heartbeat.readiness || {};
  const admission = readiness.admission || {};

  const admittedRows = count(decision.admittedRows);
  const atomicRows = count(decision.atomicRows);
  const completeDecisionRows = count(decision.completeRows);
  const failedDecisionRows = count(decision.failedRows);
  const settlementRows = count(settlement.rows);
  const completeSettlementRows = count(settlement.completeRows);
  const failedSettlementRows = count(settlement.failedRows);
  const formalRows = count(metrics.formalRows);
  const formalSettled = count(formal.settled);
  const formalFinalized = count(formal.finalized);
  const rawCalendarWindows = Array.isArray(metrics.windows)
    ? metrics.windows
    : [];
  const rawWindowEvaluation =
    metrics.windowEvaluation
    && typeof metrics.windowEvaluation === "object"
      ? metrics.windowEvaluation
      : {};
  const calendarWindows = count(
    metrics.calendarWindows
    ?? rawCalendarWindows.filter((window) => Number(window?.rows || 0) > 0).length,
  );
  const registeredWindows = count(
    metrics.registeredCalendarWindows
    ?? rawWindowEvaluation.registeredWindows,
  );
  const winningWindows = count(
    metrics.winningCalendarWindows
    ?? rawWindowEvaluation.winningWindows,
  );
  const calendarWindowGatePassed =
    metrics.calendarWindowGatePassed === true
    || (
      metrics.calendarWindowGatePassed == null
      && rawWindowEvaluation.passes === true
    );
  const dueMatches = count(heartbeat.dueMatches);
  const dueCaptureEventsAdded = count(heartbeat.dueCaptureEventsAdded);
  const dueDecisionEventsAdded = count(heartbeat.dueDecisionEventsAdded);
  const dueExclusionEventsAdded = count(heartbeat.dueExclusionEventsAdded);
  const dueAtomicDecisionEventsAdded = count(
    heartbeat.dueAtomicDecisionEventsAdded,
  );
  const upcomingMatches = count(readiness.upcomingMatches);
  const evaluatedMatches = count(readiness.evaluatedMatches);
  const detailedMatches = count(readiness.detailedMatches);
  const rowsTruncated = count(readiness.rowsTruncated);
  const readyNow = count(readiness.readyNow);
  const atomicReadyNow = count(readiness.atomicReadyNow);
  const awaitingMarket = count(readiness.awaitingMarket);
  const blocked = count(readiness.blocked);
  const excluded = count(readiness.excluded);
  const deadlineBatches = Array.isArray(readiness.deadlineBatches)
    ? readiness.deadlineBatches
    : [];
  const deadlineBatchTotals = deadlineBatches.reduce((sum, batch) => (
    sum + Math.max(0, Number(batch?.totalMatches || 0))
  ), 0);
  const invalidDeadlineBatch = deadlineBatches.some((batch) => {
    const total = count(batch?.totalMatches);
    const actionable = count(batch?.actionableMatches);
    const ready = count(batch?.readyNow);
    const awaiting = count(batch?.awaitingMarket);
    const batchBlocked = count(batch?.blocked);
    const batchExcluded = count(batch?.excluded);
    const terminalDecisions = count(batch?.terminalDecisions);
    const terminalExclusions = count(batch?.terminalExclusions);
    const duplicateTerminalEvents = count(batch?.duplicateTerminalEvents);
    const terminalKeysWithDuplicates = count(
      batch?.terminalKeysWithDuplicates,
    );
    const terminalMatches = count(batch?.terminalMatches);
    const pendingMatches = count(batch?.pendingMatches);
    const dueUnrecorded = count(batch?.dueUnrecorded);
    const readyDueUnrecorded = count(batch?.readyDueUnrecorded);
    return (
      batch?.version !== "candidate-deadline-batch-summary-v1"
      || ![
        "upcoming",
        "finalization-grace",
        "post-finalization",
        "deadline-missing",
      ].includes(batch?.phase)
      || total === null
      || actionable === null
      || ready === null
      || awaiting === null
      || batchBlocked === null
      || batchExcluded === null
      || terminalDecisions === null
      || terminalExclusions === null
      || duplicateTerminalEvents === null
      || terminalKeysWithDuplicates === null
      || terminalMatches === null
      || pendingMatches === null
      || dueUnrecorded === null
      || readyDueUnrecorded === null
      || ready + awaiting + batchBlocked + batchExcluded !== total
      || actionable !== total - batchExcluded
      || terminalMatches !== terminalDecisions + terminalExclusions
      || pendingMatches !== total - terminalMatches
      || terminalMatches > total
      || duplicateTerminalEvents !== 0
      || terminalKeysWithDuplicates !== 0
      || readyDueUnrecorded > dueUnrecorded
      || (
        batch?.phase === "post-finalization"
        && dueUnrecorded !== 0
      )
      || batch?.invariantOk !== true
    );
  });
  const expectedNearestDeadlineBatch = deadlineBatches.find((batch) => (
    Number(batch?.pendingMatches || 0) > 0
    && Boolean(batch?.deadlineAt)
  )) || null;
  const nearestDeadlineBatch = readiness.nearestDeadlineBatch || null;
  const nearestDeadlineBatchMismatch = expectedNearestDeadlineBatch
    ? (
      !nearestDeadlineBatch
      || nearestDeadlineBatch.deadlineAt
        !== expectedNearestDeadlineBatch.deadlineAt
    )
    : nearestDeadlineBatch !== null;

  const operationalBlockers = [];
  if (candidate.state !== "ACTIVE") {
    operationalBlockers.push("candidate-state-not-active");
  }
  if (candidate.chainValid !== true) {
    operationalBlockers.push("candidate-chain-invalid");
  }
  if (
    decision.version !== "candidate-atomic-decision-record-v3"
    || decision.validationVersion !== "candidate-atomic-decision-validation-v2"
    || decision.dualMarketDecisionRecordVersion
      !== "candidate-dual-market-decision-record-v1"
    || decision.formalMetricMarket !== "HAD"
    || decision.companionMarket !== "HHAD"
    || decision.decisionDeadlinePolicyVersion !== "official-cutoff-first-v1"
    || !includesEvery(decision.requiredFields, REQUIRED_DECISION_FIELDS)
  ) {
    operationalBlockers.push("atomic-decision-contract-invalid");
  }
  if (
    admittedRows === null
    || atomicRows === null
    || completeDecisionRows === null
    || failedDecisionRows !== 0
    || admittedRows !== atomicRows
    || atomicRows !== completeDecisionRows
    || Number(decision.coverage) !== 1
    || decision.complete !== true
    || blockerTotal(decision.blockerCounts) !== 0
  ) {
    operationalBlockers.push("atomic-decision-record-incomplete");
  }
  if (
    settlement.version !== "candidate-official-settlement-record-v1"
    || settlement.validationVersion !== "candidate-official-settlement-validation-v1"
    || !includesEvery(settlement.requiredFields, REQUIRED_SETTLEMENT_FIELDS)
  ) {
    operationalBlockers.push("official-settlement-contract-invalid");
  }
  if (
    settlementRows === null
    || completeSettlementRows === null
    || failedSettlementRows !== 0
    || settlementRows !== completeSettlementRows
    || Number(settlement.coverage) !== 1
    || settlement.complete !== true
    || blockerTotal(settlement.blockerCounts) !== 0
  ) {
    operationalBlockers.push("official-settlement-record-incomplete");
  }
  if (
    formalRows === null
    || formalSettled === null
    || formalFinalized === null
    || formalRows !== formalSettled
    || formalFinalized < formalSettled
    || formal.denominatorReconciled !== true
  ) {
    operationalBlockers.push("formal-denominator-unreconciled");
  }
  if (
    heartbeat.version !== "prospective-deadline-heartbeat-v2"
    || heartbeat.fresh !== true
    || heartbeat.ok !== true
    || heartbeat.skipped === true
  ) {
    operationalBlockers.push("candidate-capture-heartbeat-unhealthy");
  }
  if (
    dueMatches === null
    || dueCaptureEventsAdded === null
    || dueDecisionEventsAdded === null
    || dueExclusionEventsAdded === null
    || dueAtomicDecisionEventsAdded === null
    || dueCaptureEventsAdded !== dueMatches
    || dueDecisionEventsAdded + dueExclusionEventsAdded !== dueCaptureEventsAdded
    || dueAtomicDecisionEventsAdded !== dueDecisionEventsAdded
    || heartbeat.dueCaptureComplete !== true
    || heartbeat.dueAtomicComplete !== true
  ) {
    operationalBlockers.push("deadline-cohort-capture-incomplete");
  }
  if (
    readiness.version !== "candidate-prospective-readiness-preview-v2"
    || upcomingMatches === null
    || evaluatedMatches === null
    || detailedMatches === null
    || rowsTruncated === null
    || readyNow === null
    || atomicReadyNow === null
    || awaitingMarket === null
    || blocked === null
    || excluded === null
    || evaluatedMatches !== upcomingMatches
    || detailedMatches + rowsTruncated !== evaluatedMatches
    || atomicReadyNow !== readyNow
    || readyNow + awaitingMarket + blocked + excluded !== upcomingMatches
    || readiness.readyInvariantOk !== true
  ) {
    operationalBlockers.push("candidate-readiness-invariant-failed");
  }
  if (blocked !== 0) {
    operationalBlockers.push("candidate-upcoming-blocked");
  }
  if (
    upcomingMatches === null
    || deadlineBatchTotals !== upcomingMatches
    || invalidDeadlineBatch
    || nearestDeadlineBatchMismatch
  ) {
    operationalBlockers.push("candidate-deadline-batch-invariant-failed");
  }
  if (
    admission.version !== "candidate-prospective-admission-summary-v1"
    || admission.registryAvailable !== true
    || admission.reconciled !== true
    || admission.captureGap !== false
    || count(admission.dueUnrecorded) !== 0
    || count(admission.readyDueUnrecorded) !== 0
  ) {
    operationalBlockers.push("candidate-admission-capture-gap");
  }

  const goalBlockers = [];
  if (formalRows === null || formalRows < thresholds.targetRows) {
    goalBlockers.push("formal-settled-target-not-reached");
  }
  if (formalFinalized === null || formalFinalized < thresholds.targetRows) {
    goalBlockers.push("formal-finalized-target-not-reached");
  }
  if (calendarWindows === null || calendarWindows < thresholds.requiredWindows) {
    goalBlockers.push("calendar-window-target-not-reached");
  }
  if (
    registeredWindows === null
    || registeredWindows !== thresholds.requiredWindows
  ) {
    goalBlockers.push("registered-calendar-window-target-not-reached");
  }
  if (
    winningWindows === null
    || winningWindows < thresholds.requiredWinningWindows
  ) {
    goalBlockers.push("winning-window-target-not-reached");
  }
  if (!calendarWindowGatePassed) {
    goalBlockers.push("calendar-window-gate-not-passed");
  }

  const uniqueOperationalBlockers = [...new Set(operationalBlockers)].sort();
  const uniqueGoalBlockers = [...new Set(goalBlockers)].sort();
  const healthy = uniqueOperationalBlockers.length === 0;
  const complete = healthy && uniqueGoalBlockers.length === 0;
  return {
    version: "candidate-prospective-goal-progress-v1",
    healthy,
    complete,
    status: complete ? "complete" : healthy ? "collecting" : "unhealthy",
    thresholds,
    candidateRevisionId: candidate.candidateRevisionId || null,
    operationalBlockers: uniqueOperationalBlockers,
    goalBlockers: uniqueGoalBlockers,
    atomicDecision: {
      admittedRows,
      atomicRows,
      completeRows: completeDecisionRows,
      coverage: Number.isFinite(Number(decision.coverage))
        ? Number(decision.coverage)
        : null,
    },
    settlement: {
      rows: settlementRows,
      completeRows: completeSettlementRows,
      coverage: Number.isFinite(Number(settlement.coverage))
        ? Number(settlement.coverage)
        : null,
    },
    formal: {
      rows: formalRows,
      settled: formalSettled,
      finalized: formalFinalized,
      denominatorReconciled: formal.denominatorReconciled === true,
    },
    evaluation: {
      calendarWindows,
      registeredWindows,
      winningWindows,
      calendarWindowGatePassed,
      brierImprovement: metrics.brierImprovement ?? null,
      logLossImprovement: metrics.logLossImprovement ?? null,
    },
    heartbeat: {
      evaluatedAt: heartbeat.evaluatedAt || null,
      dueMatches,
      dueCaptureEventsAdded,
      dueDecisionEventsAdded,
      dueExclusionEventsAdded,
      dueAtomicDecisionEventsAdded,
      dueCaptureComplete: heartbeat.dueCaptureComplete === true,
      dueAtomicComplete: heartbeat.dueAtomicComplete === true,
    },
    readiness: {
      upcomingMatches,
      evaluatedMatches,
      detailedMatches,
      rowsTruncated,
      readyNow,
      atomicReadyNow,
      awaitingMarket,
      blocked,
      excluded,
      nearestDeadlineAt: readiness.nearestDeadlineAt || null,
      nearestFinalizationAt: readiness.nearestFinalizationAt || null,
      deadlineBatches,
      nearestDeadlineBatch,
      blockerCounts: readiness.blockerCounts || {},
      excludedReasonCounts: readiness.excludedReasonCounts || {},
      captureGap: admission.captureGap ?? null,
      dueUnrecorded: count(admission.dueUnrecorded),
      readyDueUnrecorded: count(admission.readyDueUnrecorded),
    },
  };
};

module.exports = {
  REQUIRED_DECISION_FIELDS,
  REQUIRED_SETTLEMENT_FIELDS,
  evaluateCandidateProspectiveGoal,
};
