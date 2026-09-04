"use strict";

const assert = require("node:assert/strict");
const {
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  candidateEvaluatorSemanticHashes,
} = require("./candidateProspectiveLedger.cjs");
const {
  PLAN_VERSION,
  PUBLIC_AUDIT_VERSION,
  SUITE_VERSION,
  advanceCalibrationChallengerContinuity,
  buildCalibrationDeescalationPlan,
  compactCalibrationChallengerSuitePublic,
  settleCalibrationChallengerSuite,
  updateCalibrationChallengerSuite,
  verifyChallengerSuite,
} = require("./candidateProspectiveChallengerSuite.cjs");

const checks = [];
const check = (name, callback) => {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error?.message || String(error) });
  }
};

const implementationCommitment = {
  commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  semanticHashes: candidateEvaluatorSemanticHashes(),
};

const strictSnapshot = ({ sourceMatchId, kickoffTime, capturedAt }) => ({
  sourceMatchId,
  matchId: `sporttery_${sourceMatchId}`,
  kickoffTime,
  capturedAt,
  firstSeenAt: capturedAt,
  phase: "final",
  sourceCycleId: `cycle-${sourceMatchId}`,
  modelGeneratedAt: capturedAt,
  policyVersion: "prediction-policy-test-v1",
  promptVersion: "prediction-prompt-test-v1",
  modelVersion: "prediction-model-test-v1",
  calibrationVersion: "prediction-calibration-test-v1",
  best: {
    tipCode: "1",
    oddsPoolCode: "HAD",
    odds: 1.8,
    recommendationAction: "reference",
  },
  oneXTwo: {
    tipCode: "1",
    oddsPoolCode: "HAD",
    odds: 1.8,
    recommendationAction: "reference",
  },
  featureSnapshot: {
    version: "prediction-feature-snapshot-test-v1",
    capturedAt,
    modelGeneratedAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    modelVersion: "prediction-model-test-v1",
    calibrationVersion: "prediction-calibration-test-v1",
    modelInputs: {
      market: { home: 0.510729613734, draw: 0.270386266094, away: 0.218884120172 },
      form: { home: 1.8, away: 1.1 },
    },
  },
  decisionSnapshot: {
    version: "candidate-decision-snapshot-v2",
    sourceMatchId,
    matchId: `sporttery_${sourceMatchId}`,
    kickoffTime,
    capturedAt,
    decisionAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    policyVersion: "prediction-policy-test-v1",
    promptVersion: "prediction-prompt-test-v1",
    modelVersion: "prediction-model-test-v1",
    calibrationVersion: "prediction-calibration-test-v1",
    sourceTimestamps: { modelGeneratedAt: capturedAt },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
    },
    probabilities: {
      HAD: { "1": 0.59, X: 0.25, "2": 0.16 },
      HHAD: { line: -1, outcomes: { "1": 0.39, X: 0.31, "2": 0.3 } },
    },
    markets: {
      HAD: {
        odds: { "1": 1.8, X: 3.4, "2": 4.2 },
        marketProbabilities: {
          "1": 0.510729613734,
          X: 0.270386266094,
          "2": 0.218884120172,
        },
        observedAt: capturedAt,
        receivedAt: capturedAt,
        provenanceHash: "4".repeat(64),
        provenance: {
          hash: "4".repeat(64),
          strict: {
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "6".repeat(64) },
        },
      },
      HHAD: {
        line: -1,
        odds: { "1": 2.45, X: 3.5, "2": 2.35 },
        marketProbabilities: {
          "1": 0.364623739333,
          X: 0.255236617533,
          "2": 0.380139643134,
        },
        observedAt: capturedAt,
        receivedAt: capturedAt,
        provenanceHash: "7".repeat(64),
        provenance: {
          hash: "7".repeat(64),
          strict: {
            collectorAttestationKeyId: "collector-a",
            collectorAttestationCommitmentHash: "5".repeat(64),
            trustedCollectorCount: 2,
          },
          extraction: { hash: "8".repeat(64) },
        },
      },
    },
    exposure: {
      shadowTracks: {
        HHAD_COMPANION: {
          selection: {
            code: "1",
            handicapLine: -1,
            odds: 2.45,
            modelProbability: 0.39,
            marketProbability: 0.364623739333,
          },
        },
      },
    },
  },
});

const candidate = (id, market, model, temperature, {
  rows = 209,
  windows = 5,
  passRate = 1,
  logLossImprovement = 0.01,
  brierImprovement = 0.004,
} = {}) => ({
  id,
  role: "shadow-feature-candidate",
  featureSet: ["current-market", "base-model"],
  weights: { market, model, temperature },
  metrics: { rows },
  comparison: { logLossImprovement, brierImprovement },
  rolling: { windows, passed: Math.floor(windows * passRate), passRate },
});

const candidates = [
  candidate("market-current-model-residual-minus-20-temperature-0_9", 1.2, -0.2, 0.9),
  candidate("market-current-model-residual-minus-10-temperature-0_9", 1.1, -0.1, 0.9),
  candidate("market-current-model-residual-minus-5-temperature-0_9", 1.05, -0.05, 0.9),
  candidate("market-temperature-0_9", 1, 0, 0.9, { passRate: 0.8 }),
  candidate("too-sharp", 1.3, -0.3, 0.9),
  candidate("wrong-temperature", 1.1, -0.1, 0.75),
  candidate("weak-evidence", 1.15, -0.15, 0.9, { rows: 50 }),
  candidate("market-baseline", 1, 0, 1, {
    logLossImprovement: 0,
    brierImprovement: 0,
  }),
];

const activeLedger = {
  rootHash: "a".repeat(64),
  header: {
    candidateRevisionId:
      "market-current-model-residual-minus-20-temperature-0_9@active",
    candidateDefinition: {
      id: "market-current-model-residual-minus-20-temperature-0_9",
      role: "shadow-feature-candidate",
      featureSet: ["current-market", "base-model"],
      weights: { market: 1.2, model: -0.2, temperature: 0.9 },
    },
    candidateImplementation: implementationCommitment,
  },
};

const activeAudit = {
  candidateRevisionId: activeLedger.header.candidateRevisionId,
  evaluatedAt: "2026-07-31T11:00:00.000Z",
  metrics: {
    formalRows: 4,
    logLossImprovement: -0.010861,
    brierImprovement: -0.007234,
    diagnostics: {
      version: "candidate-formal-metric-diagnostic-v1",
      attributionCounts: {
        directionRegression: 0,
        directionGain: 0,
        calibrationRegression: 2,
        calibrationGain: 2,
      },
    },
  },
};

const plan = buildCalibrationDeescalationPlan({
  candidates,
  activeLedger,
  activeAudit,
  evaluatedAt: "2026-07-31T11:05:00.000Z",
});

check("calibration regression preregisters exactly the three milder same-temperature arms", () => {
  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.onlineEffect, false);
  assert.deepEqual(
    plan.challengers.map((row) => row.candidate.id),
    [
      "market-current-model-residual-minus-10-temperature-0_9",
      "market-current-model-residual-minus-5-temperature-0_9",
      "market-temperature-0_9",
    ],
  );
  assert.equal(plan.triggerEvidence.formalRows, 4);
  assert.equal(plan.triggerEvidence.directionRegression, 0);
  assert.equal(plan.triggerEvidence.calibrationRegression, 2);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.challengers.every((row) => (
    row.robustness.candidateReadyForProspectiveTest === true
  )), true);
});

check("direction regression or non-negative aggregate metrics do not trigger post-hoc arms", () => {
  const directionRegression = structuredClone(activeAudit);
  directionRegression.metrics.diagnostics.attributionCounts.directionRegression = 1;
  assert.equal(buildCalibrationDeescalationPlan({
    candidates,
    activeLedger,
    activeAudit: directionRegression,
  }), null);
  const winning = structuredClone(activeAudit);
  winning.metrics.logLossImprovement = 0.01;
  winning.metrics.brierImprovement = 0.01;
  assert.equal(buildCalibrationDeescalationPlan({
    candidates,
    activeLedger,
    activeAudit: winning,
  }), null);
});

const first = updateCalibrationChallengerSuite({
  plan,
  evaluatedAt: "2026-07-31T11:05:00.000Z",
  matches: [],
  snapshots: [],
  trustedCollectorCount: 1,
});

check("each challenger receives an independent active prospective ledger with zero online effect", () => {
  assert.equal(first.chainValid, true);
  assert.equal(first.changed, true);
  assert.equal(first.suite.version, SUITE_VERSION);
  assert.equal(first.suite.trials.length, 3);
  assert.equal(first.audit.trialCount, 3);
  assert.equal(first.audit.onlineEffect, false);
  assert.equal(first.audit.trials.every((trial) => (
    trial.state === "ACTIVE"
      && trial.chainValid === true
      && trial.onlineEffect === false
      && trial.decisionRecord.admittedRows === 0
  )), true);
  assert.deepEqual(verifyChallengerSuite(first.suite), { valid: true, blockers: [] });
});

const repeated = updateCalibrationChallengerSuite({
  priorSuite: first.suite,
  plan: {
    ...plan,
    planHash: "f".repeat(64),
  },
  evaluatedAt: "2026-07-31T11:05:30.000Z",
  matches: [],
  snapshots: [],
  trustedCollectorCount: 1,
});

check("repeat heartbeats are root-idempotent and cannot replace the frozen plan", () => {
  assert.equal(repeated.chainValid, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.suite.rootHash, first.suite.rootHash);
  assert.equal(repeated.suite.header.planHash, plan.planHash);
  assert.equal(repeated.audit.planHash, plan.planHash);
});

const challengerMatch = {
  id: "sporttery_challenger-settlement-1",
  sourceMatchId: "challenger-settlement-1",
  kickoffTime: "2026-07-31T12:00:00.000Z",
  buyEndTime: "2026-07-31T11:45:00.000Z",
  status: "SCHEDULED",
};
const challengerSnapshot = strictSnapshot({
  sourceMatchId: challengerMatch.sourceMatchId,
  kickoffTime: challengerMatch.kickoffTime,
  capturedAt: "2026-07-31T11:40:00.000Z",
});
const pendingChallengers = updateCalibrationChallengerSuite({
  priorSuite: first.suite,
  evaluatedAt: "2026-07-31T11:47:30.000Z",
  matches: [challengerMatch],
  snapshots: [challengerSnapshot],
  trustedCollectorCount: 2,
});

check("challenger settlement-only closes pending decisions exactly once", () => {
  assert.equal(pendingChallengers.chainValid, true);
  assert.equal(pendingChallengers.audit.trials.every((trial) => (
    trial.decisionRecord.admittedRows === 1
      && trial.settlementRecord.rows === 0
  )), true);
  const officialFinal = {
    ...challengerMatch,
    status: "PENDING_RESULT",
    effectiveStatus: "FINISHED",
    scoreHome: 2,
    scoreAway: 0,
    resultObservedAt: "2026-07-31T14:05:00.000Z",
    resultObservationSource: "sporttery-relay-result-observation",
    resultObservationFallback: false,
    resultSource: "sporttery:official-api",
    sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
    resultProvenance: {
      provider: "sporttery",
      source: "sporttery:official-api",
      sourceUrl: "https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry",
      official: true,
      trusted: true,
      promotionEligible: true,
      eventVersionConsistent: true,
      resultObservationFallback: false,
      observationSource: "sporttery-relay-result-observation",
      sourceMatchId: challengerMatch.sourceMatchId,
      eventVersion: challengerMatch.kickoffTime,
      observedAt: "2026-07-31T14:05:00.000Z",
      scoreHome: 2,
      scoreAway: 0,
    },
  };
  const settled = settleCalibrationChallengerSuite({
    priorSuite: pendingChallengers.suite,
    matches: [officialFinal],
    evaluatedAt: "2026-07-31T14:06:00.000Z",
  });
  assert.equal(settled.chainValid, true);
  assert.equal(settled.changed, true);
  assert.equal(settled.settlementsAdded, 3);
  assert.equal(settled.suite.trials.every((trial) => {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    return ledger.events.filter((event) => event.type === "decision").length === 1
      && ledger.events.filter((event) => event.type === "exclusion").length === 0
      && ledger.events.filter((event) => event.type === "settlement").length === 1;
  }), true);
  const settledRoots = settled.suite.trials.map((trial) => (
    trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    )?.rootHash
  ));
  const repeatedSettlement = settleCalibrationChallengerSuite({
    priorSuite: settled.suite,
    matches: [officialFinal],
    evaluatedAt: "2026-07-31T14:07:00.000Z",
  });
  assert.equal(repeatedSettlement.changed, false);
  assert.equal(repeatedSettlement.settlementsAdded, 0);
  assert.deepEqual(
    repeatedSettlement.suite.trials.map((trial) => (
      trial.registry.ledgers.find(
        (row) => row.ledgerId === trial.registry.activeLedgerId,
      )?.rootHash
    )),
    settledRoots,
  );
});

const publicFirst = compactCalibrationChallengerSuitePublic({
  ...first.audit,
  ok: true,
  skipped: false,
  changed: true,
  dueMatches: 0,
});

check("public challenger projection proves parity without leaking candidate parameters", () => {
  assert.equal(publicFirst.version, PUBLIC_AUDIT_VERSION);
  assert.equal(publicFirst.available, true);
  assert.equal(publicFirst.onlineEffect, false);
  assert.equal(publicFirst.trialCount, 3);
  assert.equal(publicFirst.chainValid, true);
  assert.equal(publicFirst.allTrialsActive, true);
  assert.equal(publicFirst.allTrialsShadowOnly, true);
  assert.equal(publicFirst.countParity, true);
  assert.equal(publicFirst.decisionCoverageComplete, true);
  assert.equal(publicFirst.settlementCoverageComplete, true);
  assert.equal(publicFirst.metricCoverageComplete, true);
  assert.equal(publicFirst.windowEvaluationCoverageComplete, true);
  assert.deepEqual(publicFirst.admittedRows, { min: 0, max: 0 });
  assert.deepEqual(publicFirst.atomicRows, { min: 0, max: 0 });
  assert.deepEqual(publicFirst.formalRows, { min: 0, max: 0 });
  assert.deepEqual(publicFirst.eligibleWindows, { min: 0, max: 0 });
  assert.deepEqual(publicFirst.winningWindows, { min: 0, max: 0 });
  assert.deepEqual(publicFirst.logLossImprovement, { min: null, max: null });
  assert.deepEqual(publicFirst.brierImprovement, { min: null, max: null });
  assert.equal(publicFirst.promotionReviewReadyTrialCount, 0);
  assert.equal(publicFirst.formalPromotionEligibleTrialCount, 0);
  assert.match(publicFirst.rootHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(publicFirst),
    /candidateRevisionId|candidateId|weights|probabilities|featureSnapshot|sourceClock/,
  );
});

check("public challenger projection preserves aggregate winning-window differences", () => {
  const divergentAudit = structuredClone(first.audit);
  divergentAudit.trials[0].metrics.windowEvaluation.winningWindows = 1;
  const publicDivergent = compactCalibrationChallengerSuitePublic(divergentAudit);
  assert.equal(publicDivergent.countParity, true);
  assert.deepEqual(publicDivergent.eligibleWindows, { min: 0, max: 0 });
  assert.deepEqual(publicDivergent.winningWindows, { min: 0, max: 1 });
  assert.doesNotMatch(
    JSON.stringify(publicDivergent),
    /candidateRevisionId|candidateId|weights|probabilities|featureSnapshot|sourceClock/,
  );
});

check("public challenger projection represents a not-yet-triggered staging store honestly", () => {
  const unavailable = compactCalibrationChallengerSuitePublic({
    version: "candidate-prospective-challenger-suite-audit-v1",
    evaluatedAt: "2026-07-31T11:05:00.000Z",
    available: false,
    ok: true,
    skipped: false,
    onlineEffect: false,
    dueMatches: 0,
    chainValid: true,
    blockers: ["challenger-plan-not-triggered"],
    trials: [],
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.trialCount, 0);
  assert.equal(unavailable.rootHash, null);
  assert.equal(unavailable.blockerCount, 1);
  assert.equal(unavailable.countParity, true);
  assert.equal(unavailable.allTrialsShadowOnly, false);
  assert.equal(unavailable.decisionCoverageComplete, false);
  assert.equal(unavailable.metricCoverageComplete, false);
  assert.equal(unavailable.windowEvaluationCoverageComplete, false);
});

check("public challenger continuity rejects root drift and accepts idempotent heartbeats", () => {
  const baseline = advanceCalibrationChallengerContinuity(null, publicFirst, {
    checkedAt: "2026-07-31T11:05:00.000Z",
  });
  const stable = advanceCalibrationChallengerContinuity(baseline, {
    ...publicFirst,
    changed: false,
  }, {
    checkedAt: "2026-07-31T11:05:30.000Z",
  });
  assert.equal(stable.violation, null);
  const drift = advanceCalibrationChallengerContinuity(stable, {
    ...publicFirst,
    rootHash: "f".repeat(64),
    changed: false,
  }, {
    checkedAt: "2026-07-31T11:06:00.000Z",
  });
  assert.equal(drift.violation.code, "challenger-root-changed-without-progress");
  const missing = advanceCalibrationChallengerContinuity(stable, null, {
    checkedAt: "2026-07-31T11:06:00.000Z",
  });
  assert.equal(missing.violation.code, "challenger-suite-disappeared");
});

check("tampering any challenger event invalidates the suite", () => {
  const tampered = structuredClone(first.suite);
  tampered.trials[0].registry.ledgers[0].events[0].state = "PROMOTED";
  const verification = verifyChallengerSuite(tampered);
  assert.equal(verification.valid, false);
  assert.equal(verification.blockers.length > 0, true);
});

const ok = checks.every((row) => row.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  verifier: "candidate-prospective-challenger-suite",
  assertions: checks.length,
  checks,
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
