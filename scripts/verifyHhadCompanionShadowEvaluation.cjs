const assert = require("node:assert/strict");
const {
  STRATEGY_HASH,
  evaluateHhadCompanionShadow,
} = require("../src/services/hhadCompanionShadow.cjs");
const {
  HHAD_COMPANION_EVALUATION_VERSION,
  evaluateHhadCompanionShadowHistory,
} = require("../src/services/hhadCompanionShadowEvaluation.cjs");

const OUTCOME_CODES = ["1", "X", "2"];
const BASE_TIME = Date.UTC(2025, 0, 1);
const clone = (value) => JSON.parse(JSON.stringify(value));
const rounded = (value, digits = 6) => Number(Number(value).toFixed(digits));

const instant = (day, hour, minute = 0, millis = 0) => new Date(
  BASE_TIME + day * 86400000 + hour * 3600000 + minute * 60000 + millis
).toISOString();

const rotateTriplet = (topCode, values) => {
  const order = [topCode, ...OUTCOME_CODES.filter((code) => code !== topCode)];
  return Object.fromEntries(order.map((code, index) => [code, values[index]]));
};

const oddsFromProbabilities = (probabilities) => Object.fromEntries(
  OUTCOME_CODES.map((code) => [code, rounded(1 / (probabilities[code] * 1.06), 3)])
);

const scoreForHhadOutcome = (code) => {
  if (code === "1") return { scoreHome: 2, scoreAway: 0 };
  if (code === "X") return { scoreHome: 1, scoreAway: 0 };
  return { scoreHome: 0, scoreAway: 0 };
};

const makeSnapshot = ({
  id,
  day,
  revision = 1,
  captureMinute = 0,
  captureMillis = revision,
  captureAfterCutoff = false,
  topCode = "1",
  modelValues = [0.65, 0.2, 0.15],
  marketValues = [0.55, 0.25, 0.2],
  omitSourceTimes = [],
}) => {
  const sourceMatchId = `shadow-${id}`;
  const cutoffTime = instant(day, 18);
  const kickoffTime = instant(day, 19);
  const capturedAt = captureAfterCutoff
    ? instant(day, 18, 1, captureMillis)
    : instant(day, 10, captureMinute, captureMillis);
  const capturedMs = Date.parse(capturedAt);
  const before = (minutes) => new Date(capturedMs - minutes * 60000).toISOString();
  const modelProbabilities = rotateTriplet(topCode, modelValues);
  const marketProbabilities = rotateTriplet(topCode, marketValues);
  const odds = oddsFromProbabilities(marketProbabilities);
  const sourceRevision = `${sourceMatchId}:r${revision}`;
  const sourceSnapshotHash = `feature-${sourceMatchId}-${revision}`;
  const modelVersion = "synthetic-unified-v1";
  const sourceTimes = {
    capturedAt,
    receivedAt: before(3),
    observedAt: before(4),
    modelGeneratedAt: before(2),
    unifiedPosteriorGeneratedAt: before(1),
    decisionAt: capturedAt,
    featureSnapshotCapturedAt: before(5),
  };
  for (const key of omitSourceTimes) sourceTimes[key] = undefined;
  const evaluated = evaluateHhadCompanionShadow({
    sourceMatchId,
    cutoffTime,
    ...sourceTimes,
    sourceRevision,
    sourceSnapshotHash,
    modelVersion,
    handicapLine: -1,
    modelHandicapLine: -1,
    odds,
    modelProbabilities,
    best: { oddsPoolCode: "HHAD", tipCode: topCode, handicapLine: -1 },
  });
  const track = {
    ...evaluated,
    publicVisible: false,
    provenance: {
      sourceRevision,
      sourceSnapshotHash,
      modelVersion,
    },
  };
  return {
    sourceMatchId,
    matchId: `sporttery_${sourceMatchId}`,
    businessDate: instant(day, 0).slice(0, 10),
    kickoffTime,
    cutoffTime,
    capturedAt,
    firstSeenAt: capturedAt,
    phase: "baseline",
    signature: `synthetic|${id}|${revision}`,
    featureSnapshotHash: sourceSnapshotHash,
    decisionId: sourceMatchId,
    decisionRevision: revision,
    decisionSnapshot: {
      kickoffTime,
      exposure: { shadowTracks: { HHAD_COMPANION: track } },
    },
  };
};

const makeResult = (snapshot, actualCode, overrides = {}) => ({
  sourceMatchId: snapshot.sourceMatchId,
  matchId: snapshot.matchId,
  businessDate: snapshot.businessDate,
  kickoffTime: snapshot.kickoffTime,
  status: "FINISHED",
  official: true,
  sourceUrl: "https://webapi.sporttery.cn/gateway/result",
  resultSource: "sporttery:official-result",
  resultUpdatedAt: new Date(Date.parse(snapshot.kickoffTime) + 2 * 3600000).toISOString(),
  resultObservedAt: new Date(Date.parse(snapshot.kickoffTime) + 2 * 3600000).toISOString(),
  resultObservationSource: "sporttery-relay-endpoint-fetched-at",
  resultSourceUpdatedAt: null,
  resultObservationFallback: false,
  ...scoreForHhadOutcome(actualCode),
  ...overrides,
});

const predictionSnapshots = [];
const results = [];
for (let index = 0; index < 650; index += 1) {
  const day = Math.floor(index / 10);
  const topCode = OUTCOME_CODES[index % OUTCOME_CODES.length];
  const snapshot = makeSnapshot({ id: `base-${index}`, day, topCode });
  const actualCode = index % 5 === 0
    ? OUTCOME_CODES[(OUTCOME_CODES.indexOf(topCode) + 1 + (index % 2)) % OUTCOME_CODES.length]
    : topCode;
  predictionSnapshots.push(snapshot);
  results.push(makeResult(snapshot, actualCode));
}

// Identical public/SQLite copies of one revision must collapse by revisionHash.
predictionSnapshots.push(clone(predictionSnapshots[0]));

// A final pre-cutoff SKIP suppresses the earlier EVALUATE exposure.
const evaluateThenSkipEarly = makeSnapshot({ id: "evaluate-then-skip", day: 66, revision: 1, captureMinute: 0, topCode: "2" });
const evaluateThenSkipLate = makeSnapshot({
  id: "evaluate-then-skip",
  day: 66,
  revision: 2,
  captureMinute: 30,
  topCode: "2",
  modelValues: [0.44, 0.3, 0.26],
});
assert.equal(evaluateThenSkipEarly.decisionSnapshot.exposure.shadowTracks.HHAD_COMPANION.action, "EVALUATE");
assert.equal(evaluateThenSkipLate.decisionSnapshot.exposure.shadowTracks.HHAD_COMPANION.action, "SKIP");
predictionSnapshots.push(evaluateThenSkipEarly, evaluateThenSkipLate);
results.push(makeResult(evaluateThenSkipLate, "2"));

// A later EVALUATE is valid after an earlier SKIP.
const skipThenEvaluateEarly = makeSnapshot({
  id: "skip-then-evaluate",
  day: 67,
  revision: 1,
  captureMinute: 0,
  topCode: "1",
  modelValues: [0.44, 0.3, 0.26],
});
const skipThenEvaluateLate = makeSnapshot({ id: "skip-then-evaluate", day: 67, revision: 2, captureMinute: 30, topCode: "1" });
predictionSnapshots.push(skipThenEvaluateEarly, skipThenEvaluateLate);
results.push(makeResult(skipThenEvaluateLate, "1"));

// A post-cutoff revision cannot overwrite the last legitimate pre-cutoff exposure.
const preCutoffExposure = makeSnapshot({ id: "post-cutoff-pollution", day: 68, revision: 1, topCode: "X" });
const postCutoffPollution = makeSnapshot({
  id: "post-cutoff-pollution",
  day: 68,
  revision: 2,
  topCode: "X",
  captureAfterCutoff: true,
});
assert.equal(postCutoffPollution.decisionSnapshot.exposure.shadowTracks.HHAD_COMPANION.action, "SKIP");
predictionSnapshots.push(preCutoffExposure, postCutoffPollution);
results.push(makeResult(preCutoffExposure, "X"));

// VOID is retained for audit but excluded from paired metrics, hit rate, and ROI.
const voidExposure = makeSnapshot({ id: "void", day: 69, revision: 1, topCode: "2" });
predictionSnapshots.push(voidExposure);
results.push(makeResult(voidExposure, "2", {
  status: "CANCELLED",
  scoreHome: undefined,
  scoreAway: undefined,
}));

const options = {
  predictionSnapshots,
  results,
  bootstrapIterations: 500,
  evaluatedAt: "2026-07-13T00:00:00.000Z",
  globalRiskTier: "stable",
  includeInternalRows: true,
};
const evaluation = evaluateHhadCompanionShadowHistory(options);
assert.equal(evaluation.version, HHAD_COMPANION_EVALUATION_VERSION);
assert.equal(evaluation.strategyHash, STRATEGY_HASH);
assert.equal(evaluation.onlineEffect, "shadow");
assert.equal(evaluation.promotionAllowed, false);
assert.equal(evaluation.candidateReady, true, JSON.stringify(evaluation.gate.checks));
assert.equal(evaluation.candidateStatus, "candidate-ready-for-manual-evaluation");
assert.ok(evaluation.counts.pairedNonVoidRows >= 650);
assert.equal(evaluation.counts.settledVoid, 1);
assert.ok(evaluation.counts.duplicateRevisionRows >= 1);
assert.ok(evaluation.counts.postCutoffOrUnorderableRows >= 1);
assert.equal(evaluation.exactReplay.rate, 1);
assert.equal(evaluation.windows.count, 6);
assert.ok(evaluation.windows.rows.every((window) => window.rows >= 40));
assert.ok(evaluation.windows.improvingBothMetrics >= 5);
assert.equal(evaluation.windows.recentTwoNonNegative, true);
assert.ok(evaluation.pairedThreeWay.improvement.brier > 0);
assert.ok(evaluation.pairedThreeWay.improvement.logLoss > 0);
assert.ok(evaluation.bootstrap.lowerBounds.brierImprovement > 0);
assert.ok(evaluation.bootstrap.lowerBounds.logLossImprovement > 0);
assert.equal(evaluation.bootstrap.percentileLowerProbability, 0.05);
assert.equal(evaluation.globalRiskTier, "stable");
assert.equal(evaluation.gate.checks.globalRiskTierStable, true);
assert.equal(evaluation.descriptive.gateUsage, "descriptive-only");

const evaluateThenSkipFinal = evaluation.finalExposureRows.find((row) => row.matchKey === evaluateThenSkipLate.sourceMatchId);
assert.equal(evaluateThenSkipFinal.action, "SKIP");
assert.equal(evaluateThenSkipFinal.settlementStatus, null, "final SKIP must not fall back to the earlier EVALUATE");
const skipThenEvaluateFinal = evaluation.finalExposureRows.find((row) => row.matchKey === skipThenEvaluateLate.sourceMatchId);
assert.equal(skipThenEvaluateFinal.action, "EVALUATE");
assert.equal(skipThenEvaluateFinal.settlementStatus, "WON");
const pollutionFinal = evaluation.finalExposureRows.find((row) => row.matchKey === preCutoffExposure.sourceMatchId);
assert.equal(pollutionFinal.revisionHash, preCutoffExposure.decisionSnapshot.exposure.shadowTracks.HHAD_COMPANION.revisionHash);
assert.equal(pollutionFinal.settlementStatus, "WON");
const voidSettlement = evaluation.settlementRows.find((row) => row.matchKey === voidExposure.sourceMatchId);
assert.equal(voidSettlement.settlement.status, "VOID");
assert.equal(voidSettlement.pairedLosses, null);

// Internal rows contain only audit identities/numbers/provenance and can recompute aggregates.
assert.ok(evaluation.finalExposureRows.length === evaluation.counts.finalRevisions);
assert.ok(evaluation.settlementRows.length === evaluation.counts.settlementRows);
assert.equal(/homeTeam|awayTeam|tipLabel|explanation/.test(JSON.stringify(evaluation.settlementRows)), false);
const pairedAuditRows = evaluation.settlementRows.filter((row) => row.pairedLosses);
const auditBrierImprovement = pairedAuditRows.reduce((sum, row) => sum + row.pairedLosses.brierImprovement, 0) / pairedAuditRows.length;
const auditLogLossImprovement = pairedAuditRows.reduce((sum, row) => sum + row.pairedLosses.logLossImprovement, 0) / pairedAuditRows.length;
assert.ok(Math.abs(auditBrierImprovement - evaluation.pairedThreeWay.improvement.brier) < 1e-6);
assert.ok(Math.abs(auditLogLossImprovement - evaluation.pairedThreeWay.improvement.logLoss) < 1e-6);

// Day blocks are chronological, disjoint, and deterministic.
const dayWindow = new Map();
for (const window of evaluation.windows.rows) {
  const rows = pairedAuditRows.filter((row) => row.matchDay >= window.startMatchDay && row.matchDay <= window.endMatchDay);
  for (const row of rows) {
    const previousWindow = dayWindow.get(row.matchDay);
    assert.ok(!previousWindow || previousWindow === window.index, `match day ${row.matchDay} leaked across windows`);
    dayWindow.set(row.matchDay, window.index);
  }
}
const repeated = evaluateHhadCompanionShadowHistory(options);
assert.deepEqual(repeated.bootstrap, evaluation.bootstrap, "match-day bootstrap must be deterministic");

const aggregateOnly = evaluateHhadCompanionShadowHistory({ ...options, includeInternalRows: false });
assert.equal("finalExposureRows" in aggregateOnly, false);
assert.equal("settlementRows" in aggregateOnly, false);

// Risk is an independent gate and never changes onlineEffect from shadow.
const missingRisk = evaluateHhadCompanionShadowHistory({ ...options, globalRiskTier: undefined, includeInternalRows: false });
assert.equal(missingRisk.candidateReady, false);
assert.equal(missingRisk.gate.checks.globalRiskTierStable, false);
assert.equal(missingRisk.onlineEffect, "shadow");
const watchRisk = evaluateHhadCompanionShadowHistory({ ...options, globalRiskTier: "watch", includeInternalRows: false });
assert.equal(watchRisk.candidateReady, false);
assert.equal(watchRisk.gate.checks.globalRiskTierStable, false);

// Missing any required source time retains settlement audit but cannot enter promotion pairing.
const incompleteTimeSnapshot = makeSnapshot({
  id: "incomplete-source-time",
  day: 70,
  topCode: "1",
  omitSourceTimes: ["receivedAt"],
});
const incompleteTime = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [incompleteTimeSnapshot],
  results: [makeResult(incompleteTimeSnapshot, "1")],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
  includeInternalRows: true,
});
assert.equal(incompleteTime.counts.settlementRows, 1);
assert.equal(incompleteTime.counts.pairedNonVoidRows, 0);
assert.equal(incompleteTime.counts.promotionTimeIneligibleSettlements, 1);
assert.ok(incompleteTime.promotionTimeBlockerCounts["missing-or-invalid-receivedAt"] >= 1);
assert.equal(incompleteTime.settlementRows[0].pairedLosses, null);
assert.equal(incompleteTime.settlementRows[0].promotionSourceTimeAudit.eligible, false);

// Same source identity can host rescheduled events; result kickoff must match eventVersion.
const originalEvent = makeSnapshot({ id: "rescheduled-event", day: 71, revision: 1, topCode: "2" });
const rescheduledEvent = makeSnapshot({ id: "rescheduled-event", day: 72, revision: 2, topCode: "2" });
const eventVersionEvaluation = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [originalEvent, rescheduledEvent],
  results: [makeResult(rescheduledEvent, "2")],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
  includeInternalRows: true,
});
assert.equal(eventVersionEvaluation.counts.finalRevisions, 2);
assert.equal(eventVersionEvaluation.counts.settlementRows, 1);
assert.equal(eventVersionEvaluation.counts.missingOfficialResults, 1);
assert.ok(eventVersionEvaluation.counts.resultEventMismatches >= 1);
assert.equal(eventVersionEvaluation.settlementRows[0].kickoffTime, rescheduledEvent.kickoffTime);

// Exact ties on all four ordering clocks with different revisions are ambiguous and never settle.
const ambiguousA = makeSnapshot({
  id: "ambiguous-event",
  day: 73,
  revision: 1,
  captureMinute: 10,
  captureMillis: 0,
  topCode: "X",
});
const ambiguousB = makeSnapshot({
  id: "ambiguous-event",
  day: 73,
  revision: 2,
  captureMinute: 10,
  captureMillis: 0,
  topCode: "X",
});
const ambiguous = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [ambiguousA, ambiguousB],
  results: [makeResult(ambiguousB, "X")],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
  includeInternalRows: true,
});
assert.equal(ambiguous.counts.ambiguousFinalGroups, 1);
assert.equal(ambiguous.counts.settlementRows, 0);
assert.equal(ambiguous.gate.checks.noAmbiguousFinalRevisions, false);
assert.equal(ambiguous.candidateReady, false);
assert.equal(ambiguous.finalExposureRows[0].ambiguous, true);
assert.equal(ambiguous.finalExposureRows[0].ambiguousRevisionHashes.length, 2);

// Missing or fallback result observation clocks are excluded; explicit pre-cutoff observation is rejected.
const fallbackTimeSnapshot = makeSnapshot({ id: "result-time-fallback", day: 74, topCode: "1" });
const fallbackTimeResult = makeResult(fallbackTimeSnapshot, "1");
delete fallbackTimeResult.resultObservedAt;
delete fallbackTimeResult.resultObservationSource;
const fallbackTime = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [fallbackTimeSnapshot],
  results: [fallbackTimeResult],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
});
assert.equal(fallbackTime.counts.settlementRows, 0);
assert.equal(fallbackTime.counts.resultTimeRejected, 1);
const declaredFallbackTime = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [fallbackTimeSnapshot],
  results: [makeResult(fallbackTimeSnapshot, "1", { resultObservationFallback: true })],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
});
assert.equal(declaredFallbackTime.counts.settlementRows, 0);
assert.equal(declaredFallbackTime.counts.resultTimeRejected, 1);
const earlyResultTime = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [fallbackTimeSnapshot],
  results: [makeResult(fallbackTimeSnapshot, "1", { resultObservedAt: fallbackTimeSnapshot.cutoffTime })],
  globalRiskTier: "stable",
  bootstrapIterations: 200,
});
assert.equal(earlyResultTime.counts.settlementRows, 0);
assert.equal(earlyResultTime.counts.resultTimeRejected, 1);

// Semantic tampering under an old hash must fail exact replay and never settle.
const tamperedSnapshot = clone(predictionSnapshots[1]);
tamperedSnapshot.decisionSnapshot.exposure.shadowTracks.HHAD_COMPANION.selection.odds += 0.1;
const tampered = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [tamperedSnapshot],
  results: [results[1]],
  bootstrapIterations: 200,
  includeInternalRows: true,
});
assert.equal(tampered.exactReplay.rate, 0);
assert.equal(tampered.counts.settlementRows, 0);
assert.equal(tampered.candidateReady, false);

// A non-official fallback result never closes the evaluation loop.
const fallbackOnly = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [predictionSnapshots[2]],
  results: [{ ...results[2], official: false, sourceUrl: "https://500.com/result", resultSource: "500.com:jczq-result" }],
  bootstrapIterations: 200,
});
assert.equal(fallbackOnly.counts.settlementRows, 0);
assert.equal(fallbackOnly.counts.missingOfficialResults, 1);

// Empty cohorts must never report the recent-window guard as passing.
const emptyCohort = evaluateHhadCompanionShadowHistory({
  predictionSnapshots: [],
  results: [],
  globalRiskTier: 'stable',
  bootstrapIterations: 200,
});
assert.equal(emptyCohort.candidateReady, false);
assert.equal(emptyCohort.windows.recentTwoNonNegative, false);
assert.equal(emptyCohort.gate.checks.recentTwoWindowsNonNegative, false);

console.log(JSON.stringify({
  ok: true,
  version: evaluation.version,
  strategyHash: evaluation.strategyHash,
  candidateReady: evaluation.candidateReady,
  counts: evaluation.counts,
  pairedImprovement: evaluation.pairedThreeWay.improvement,
  improvingWindows: evaluation.windows.improvingBothMetrics,
  bootstrapLowerBounds: evaluation.bootstrap.lowerBounds,
  internalRows: {
    finalExposureRows: evaluation.finalExposureRows.length,
    settlementRows: evaluation.settlementRows.length,
  },
}, null, 2));
