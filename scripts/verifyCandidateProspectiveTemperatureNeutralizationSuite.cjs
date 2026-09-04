"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  atomicDecisionRecordValid,
  candidateEvaluatorSemanticHashes,
  candidateProbabilities,
  sha256,
} = require("./candidateProspectiveLedger.cjs");
const {
  buildCalibrationDeescalationPlan,
  updateCalibrationChallengerSuite,
  verifyChallengerSuite,
} = require("./candidateProspectiveChallengerSuite.cjs");
const {
  MARKET_CONTROL_ID,
  PLAN_VERSION,
  PUBLIC_AUDIT_VERSION,
  RESIDUAL_MINUS_10_ID,
  RESIDUAL_MINUS_20_ID,
  SUITE_VERSION,
  batchParityAudit,
  buildTemperatureNeutralizationPlan,
  compactTemperatureNeutralizationSuitePublic,
  inputEligibilityFor,
  settleTemperatureNeutralizationSuite,
  settlementMatchesForSuite,
  updateTemperatureNeutralizationSuite,
  verifyTemperatureNeutralizationSuite,
} = require("./candidateProspectiveTemperatureNeutralizationSuite.cjs");

const implementationCommitment = {
  commitmentVersion: CANDIDATE_IMPLEMENTATION_COMMITMENT_VERSION,
  semanticHashes: candidateEvaluatorSemanticHashes(),
};

const candidate = (id, market, model, temperature) => ({
  id,
  role: "shadow-feature-candidate",
  featureSet: ["sporttery-market", "current-probability-model"],
  weights: { market, model, temperature },
  metrics: { rows: 209 },
  comparison: { logLossImprovement: 0.01, brierImprovement: 0.004 },
  rolling: { windows: 5, passed: 5, passRate: 1 },
});

const calibrationCandidates = [
  candidate("market-current-model-residual-minus-20-temperature-0_9", 1.2, -0.2, 0.9),
  candidate("market-current-model-residual-minus-10-temperature-0_9", 1.1, -0.1, 0.9),
  candidate("market-current-model-residual-minus-5-temperature-0_9", 1.05, -0.05, 0.9),
  candidate("market-temperature-0_9", 1, 0, 0.9),
];

const activeLedger = {
  rootHash: "a".repeat(64),
  header: {
    candidateRevisionId:
      "market-current-model-residual-minus-20-temperature-0_9@active",
    candidateDefinition: calibrationCandidates[0],
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

const calibrationPlan = buildCalibrationDeescalationPlan({
  candidates: calibrationCandidates,
  activeLedger,
  activeAudit,
  evaluatedAt: "2026-07-31T11:05:00.000Z",
});
const calibrationSuiteUpdate = updateCalibrationChallengerSuite({
  plan: calibrationPlan,
  matches: [],
  snapshots: [],
  evaluatedAt: "2026-07-31T11:05:00.000Z",
  trustedCollectorCount: 2,
});
const calibrationSuite = calibrationSuiteUpdate.suite;
const frozenCalibrationSuite = structuredClone(calibrationSuite);

const strictSnapshot = ({
  sourceMatchId,
  kickoffTime,
  capturedAt,
}) => ({
  id: `sporttery_${sourceMatchId}`,
  matchId: `sporttery_${sourceMatchId}`,
  sourceMatchId,
  source: "sporttery",
  kickoffTime,
  capturedAt,
  firstSeenAt: capturedAt,
  sourceCycleId: `cycle-${sourceMatchId}`,
  modelGeneratedAt: capturedAt,
  policyVersion: "prediction-policy-temperature-test-v1",
  promptVersion: "prediction-prompt-temperature-test-v1",
  modelVersion: "prediction-model-temperature-test-v1",
  calibrationVersion: "prediction-calibration-temperature-test-v1",
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
    version: "prediction-feature-snapshot-temperature-test-v1",
    capturedAt,
    modelGeneratedAt: capturedAt,
    sourceCycleId: `cycle-${sourceMatchId}`,
    modelVersion: "prediction-model-temperature-test-v1",
    calibrationVersion: "prediction-calibration-temperature-test-v1",
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
    policyVersion: "prediction-policy-temperature-test-v1",
    promptVersion: "prediction-prompt-temperature-test-v1",
    modelVersion: "prediction-model-temperature-test-v1",
    calibrationVersion: "prediction-calibration-temperature-test-v1",
    sourceTimestamps: { modelGeneratedAt: capturedAt },
    clockAudit: {
      version: "decision-clock-audit-v1",
      eligible: true,
      blockers: [],
    },
    probabilities: {
      HAD: { "1": 0.59, X: 0.25, "2": 0.16 },
      HHAD: {
        line: -1,
        outcomes: { "1": 0.39, X: 0.31, "2": 0.3 },
      },
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

const match = ({
  sourceMatchId,
  source = "sporttery",
  kickoffTime,
  buyEndTime,
  status = "SCHEDULED",
  scoreHome = null,
  scoreAway = null,
  resultObservedAt = null,
}) => ({
  id: `${source === "sporttery" ? "sporttery" : "fivehundred"}_${sourceMatchId}`,
  sourceMatchId,
  source,
  sourceUrl: source === "sporttery"
    ? "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry"
    : "https://trade.500.com/",
  kickoffTime,
  eventVersion: kickoffTime,
  buyEndTime,
  status,
  scoreHome,
  scoreAway,
  resultObservedAt,
  resultProvenance: status === "FINISHED" ? {
    version: "result-provenance-v2",
    official: true,
    trusted: true,
    provider: "sporttery",
    source: "sporttery",
    sourceUrl:
      "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry",
    sourceMatchId,
    sourceStatus: "FINISHED",
    scoreHome,
    scoreAway,
    kickoffTime,
    observedAt: resultObservedAt,
    observationSource: "sporttery-relay-result-observed-at",
    resultObservationFallback: false,
    promotionEligible: true,
    eventVersion: kickoffTime,
  } : null,
});

const historicalMatch = match({
  sourceMatchId: "history-before-plan",
  kickoffTime: "2026-07-31T12:30:00.000Z",
  buyEndTime: "2026-07-31T11:50:00.000Z",
});
const historicalSnapshot = strictSnapshot({
  sourceMatchId: historicalMatch.sourceMatchId,
  kickoffTime: historicalMatch.kickoffTime,
  capturedAt: "2026-07-31T11:45:00.000Z",
});
const formalMatch = match({
  sourceMatchId: "future-formal-1",
  kickoffTime: "2026-07-31T13:00:00.000Z",
  buyEndTime: "2026-07-31T12:10:00.000Z",
});
const formalSnapshot = strictSnapshot({
  sourceMatchId: formalMatch.sourceMatchId,
  kickoffTime: formalMatch.kickoffTime,
  capturedAt: "2026-07-31T12:05:00.000Z",
});
const reference500Match = match({
  sourceMatchId: "reference-500-1",
  source: "five-hundred",
  kickoffTime: "2026-07-31T13:10:00.000Z",
  buyEndTime: "2026-07-31T12:15:00.000Z",
});

const plan = buildTemperatureNeutralizationPlan({
  activeLedger,
  calibrationChallengerSuite: calibrationSuite,
  evaluatedAt: "2026-07-31T12:00:00.000Z",
});

const checks = [];
const check = (name, callback) => {
  try {
    callback();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error?.message || String(error) });
  }
};

check("deadline capture wires an isolated lock, settlement-first flow and guarded due query", () => {
  const captureSource = fs.readFileSync(
    path.join(__dirname, "captureCandidateProspectiveDeadline.cjs"),
    "utf8",
  );
  assert.match(
    captureSource,
    /CANDIDATE_PROSPECTIVE_TEMPERATURE_NEUTRALIZATION_SUITE_FILE/,
  );
  assert.match(
    captureSource,
    /withCandidateProspectiveRegistryLock\(\s*temperatureNeutralizationSuiteFile/,
  );
  assert.ok(
    captureSource.indexOf("settleTemperatureNeutralization({ matches })")
      < captureSource.indexOf("const dueMatches = pendingCaptureMatches"),
  );
  assert.match(
    captureSource,
    /\.\.\.temperatureNeutralizationDueMatchRows/,
  );
  assert.match(
    captureSource,
    /temperatureNeutralizationEvidenceQueryComplete/,
  );
  assert.match(
    captureSource,
    /evidenceQueryComplete:\s*temperatureNeutralizationEvidenceQueryComplete/,
  );
  assert.match(captureSource, /temperatureNeutralizationSuite,/);
});

check("the plan freezes exactly two T=1 candidates and one non-promotable T=1 market control", () => {
  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.onlineEffect, false);
  assert.equal(plan.inputPolicy.backfillPolicy, "forbidden");
  assert.equal(plan.inputPolicy.reference500Policy, "excluded-before-ledger");
  assert.deepEqual(plan.arms.map((arm) => arm.candidate.id), [
    RESIDUAL_MINUS_20_ID,
    RESIDUAL_MINUS_10_ID,
    MARKET_CONTROL_ID,
  ]);
  assert.deepEqual(plan.arms.map((arm) => arm.candidate.weights), [
    { market: 1.2, model: -0.2, temperature: 1 },
    { market: 1.1, model: -0.1, temperature: 1 },
    { market: 1, model: 0, temperature: 1 },
  ]);
  assert.equal(plan.arms[2].promotable, false);
  assert.equal(plan.arms[2].promotionPolicy, "never-promote-control-arm");
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
});

check("family-wise accounting combines all six shadow experiment arms", () => {
  assert.equal(plan.familyWiseComparison.existingChallengerArmCount, 3);
  assert.equal(plan.familyWiseComparison.temperatureNeutralizationArmCount, 3);
  assert.equal(plan.familyWiseComparison.totalExperimentArmCount, 6);
  assert.equal(plan.familyWiseComparison.sourceActiveComparatorCount, 1);
  assert.equal(plan.familyWiseComparison.totalProspectiveTracksIncludingActive, 7);
  assert.equal(plan.familyWiseComparison.primaryEndpointCount, 2);
  assert.equal(plan.familyWiseComparison.totalPrimaryHypothesisCount, 12);
  assert.equal(plan.familyWiseInventory.length, 6);
});

check("an incompatible active formula cannot silently register this experiment", () => {
  const incompatible = structuredClone(activeLedger);
  incompatible.header.candidateDefinition.weights.temperature = 1;
  assert.equal(buildTemperatureNeutralizationPlan({
    activeLedger: incompatible,
    calibrationChallengerSuite: calibrationSuite,
    evaluatedAt: "2026-07-31T12:00:00.000Z",
  }), null);
});

const initial = updateTemperatureNeutralizationSuite({
  plan,
  matches: [historicalMatch, formalMatch, reference500Match],
  snapshots: [historicalSnapshot, formalSnapshot],
  evaluatedAt: "2026-07-31T12:00:00.000Z",
  trustedCollectorCount: 2,
});

check("the suite uses an isolated identity and leaves the frozen source suite byte-stable", () => {
  assert.equal(initial.chainValid, true);
  assert.equal(initial.suite.version, SUITE_VERSION);
  assert.notEqual(initial.suite.rootHash, calibrationSuite.rootHash);
  assert.equal(sha256(calibrationSuite), sha256(frozenCalibrationSuite));
  assert.deepEqual(verifyChallengerSuite(calibrationSuite), { valid: true, blockers: [] });
  assert.equal(initial.suite.trials.length, 3);
  assert.equal(initial.audit.trials.every((trial) => (
    trial.state === "ACTIVE"
    && trial.onlineEffect === false
    && trial.decisionRecord.admittedRows === 0
  )), true);
});

check("pre-activation deadlines and 500-reference rows are excluded before every ledger", () => {
  const eligibility = inputEligibilityFor({
    plan,
    matches: [historicalMatch, formalMatch, reference500Match],
  });
  assert.equal(eligibility.receivedMatches, 3);
  assert.equal(eligibility.eligibleMatches, 1);
  assert.equal(eligibility.excludedPreActivationDeadline, 1);
  assert.equal(eligibility.excludedReferenceOrNonOfficial, 1);
  for (const trial of initial.suite.trials) {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    assert.equal(ledger.events.some((event) => (
      event.matchId?.includes("history-before-plan")
      || event.matchId?.includes("reference-500-1")
    )), false);
  }
});

const incompleteEvidence = updateTemperatureNeutralizationSuite({
  priorSuite: initial.suite,
  matches: [historicalMatch, formalMatch, reference500Match],
  snapshots: [historicalSnapshot],
  evaluatedAt: "2026-07-31T12:12:01.000Z",
  trustedCollectorCount: 2,
  dueMatches: 1,
  evidenceQueryComplete: false,
});

check("an incomplete deadline evidence query cannot append any decision", () => {
  assert.equal(incompleteEvidence.chainValid, true);
  assert.equal(incompleteEvidence.changed, false);
  assert.equal(incompleteEvidence.suite.rootHash, initial.suite.rootHash);
  assert.equal(incompleteEvidence.audit.skipped, true);
  assert.equal(
    incompleteEvidence.audit.reason,
    "temperature-neutralization-deadline-evidence-query-incomplete",
  );
  assert.equal(incompleteEvidence.suite.trials.every((trial) => {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    return ledger.events.every((event) => event.type !== "decision");
  }), true);
});

const captured = updateTemperatureNeutralizationSuite({
  priorSuite: incompleteEvidence.suite,
  matches: [historicalMatch, formalMatch, reference500Match],
  snapshots: [historicalSnapshot, formalSnapshot],
  evaluatedAt: "2026-07-31T12:12:01.000Z",
  trustedCollectorCount: 2,
});

check("one post-deadline atomic row is captured once in the same batch for all arms", () => {
  assert.equal(captured.chainValid, true);
  assert.equal(captured.changed, true);
  assert.equal(captured.audit.batchParity.complete, true);
  assert.deepEqual(captured.audit.batchParity.terminalRowsPerTrial, [1, 1, 1]);
  assert.deepEqual(captured.audit.batchParity.decisionRowsPerTrial, [1, 1, 1]);
  assert.equal(captured.audit.trials.every((trial) => (
    trial.decisionRecord.admittedRows === 1
    && trial.decisionRecord.atomicRows === 1
    && trial.decisionRecord.coverage === 1
    && trial.decisionRecord.complete === true
  )), true);
  for (const trial of captured.suite.trials) {
    const ledger = trial.registry.ledgers.find(
      (row) => row.ledgerId === trial.registry.activeLedgerId,
    );
    const decision = ledger.events.find((event) => event.type === "decision");
    assert.equal(decision.phase, "formal");
    assert.equal(decision.decisionDeadlineAt, "2026-07-31T12:10:00.000Z");
    assert.equal(decision.captureFinalizationAt, "2026-07-31T12:12:00.000Z");
    assert.equal(decision.recordedAt, "2026-07-31T12:12:01.000Z");
    assert.equal(decision.sourceClass, "official");
    assert.equal(atomicDecisionRecordValid(decision), true);
  }
});

check("all three arms share the exact odds, model, feature, clock and provenance inputs", () => {
  const parity = batchParityAudit(captured.suite);
  assert.equal(parity.identityParity, true);
  assert.equal(parity.terminalTypeParity, true);
  assert.equal(parity.sharedInputParity, true);
  assert.equal(parity.atomicDecisionComplete, true);
});

check("T=1 preserves the market control and only the two residual arms change probabilities", () => {
  const market = { "1": 0.51, X: 0.28, "2": 0.21 };
  const model = { "1": 0.6, X: 0.24, "2": 0.16 };
  const residual20 = candidateProbabilities(plan.arms[0].candidate, market, model);
  const residual10 = candidateProbabilities(plan.arms[1].candidate, market, model);
  const control = candidateProbabilities(plan.arms[2].candidate, market, model);
  assert.deepEqual(control, market);
  assert.notDeepEqual(residual20, market);
  assert.notDeepEqual(residual10, market);
});

const repeated = updateTemperatureNeutralizationSuite({
  priorSuite: captured.suite,
  plan: { ...plan, planHash: "f".repeat(64) },
  matches: [historicalMatch, formalMatch, reference500Match],
  snapshots: [historicalSnapshot, formalSnapshot],
  evaluatedAt: "2026-07-31T12:12:30.000Z",
  trustedCollectorCount: 2,
});

check("repeat heartbeats are root-idempotent and cannot replace the frozen plan", () => {
  assert.equal(repeated.chainValid, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.suite.rootHash, captured.suite.rootHash);
  assert.equal(repeated.suite.header.planHash, plan.planHash);
  assert.equal(repeated.audit.planHash, plan.planHash);
  assert.equal(sha256(calibrationSuite), sha256(frozenCalibrationSuite));
});

const settledFormalMatch = match({
  sourceMatchId: formalMatch.sourceMatchId,
  kickoffTime: formalMatch.kickoffTime,
  buyEndTime: formalMatch.buyEndTime,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 0,
  resultObservedAt: "2026-07-31T14:00:00.000Z",
});
const settled = settleTemperatureNeutralizationSuite({
  priorSuite: repeated.suite,
  matches: [
    historicalMatch,
    settledFormalMatch,
    reference500Match,
  ],
  evaluatedAt: "2026-07-31T14:05:00.000Z",
});

check("the formal metric denominator contains only the future official atomic row", () => {
  assert.equal(settlementMatchesForSuite(repeated.suite, [
    historicalMatch,
    settledFormalMatch,
    reference500Match,
  ]).length, 1);
  assert.equal(settled.chainValid, true);
  assert.equal(settled.audit.trials.every((trial) => (
    trial.cohort.formal.universe === 1
    && trial.cohort.formal.admitted === 1
    && trial.cohort.formal.settled === 1
    && trial.metrics.formalRows === 1
  )), true);
  assert.equal(settled.audit.formalEvidencePolicy.historicalBackfillRows, 0);
  assert.equal(settled.audit.formalEvidencePolicy.reference500Rows, 0);
  assert.equal(settled.audit.settlementOnly, true);
  assert.equal(settled.settlementsAdded, 3);
});

check("the market control remains permanently non-promotable in internal and public audits", () => {
  const control = settled.audit.trials.find(
    (trial) => trial.candidateId === MARKET_CONTROL_ID,
  );
  assert.equal(control.promotable, false);
  assert.equal(control.promotionReviewReady, false);
  assert.equal(control.formalPromotionEligible, false);
  assert.deepEqual(control.permanentBlockers, ["control-arm-non-promotable"]);
  const publicAudit = compactTemperatureNeutralizationSuitePublic({
    ...settled.audit,
    ok: true,
    skipped: false,
  });
  assert.equal(publicAudit.version, PUBLIC_AUDIT_VERSION);
  assert.equal(publicAudit.onlineEffect, false);
  assert.equal(publicAudit.controlArmCount, 1);
  assert.equal(publicAudit.promotableArmCount, 2);
  assert.equal(publicAudit.controlArmPromotionEligible, false);
  assert.equal(publicAudit.familyWiseComparison.totalExperimentArmCount, 6);
  assert.equal(publicAudit.formalPromotionEligibleTrialCount, 0);
  assert.deepEqual(publicAudit.formalRows, { min: 1, max: 1 });
  assert.doesNotMatch(
    JSON.stringify(publicAudit),
    /candidateId|candidateRevisionId|weights|probabilities|featureSnapshot|sourceClock/,
  );
});

check("tampering an arm or adding a control promotion invalidates the isolated suite", () => {
  const tampered = structuredClone(settled.suite);
  tampered.header.frozenPlan.arms[0].candidate.weights.temperature = 0.9;
  assert.equal(verifyTemperatureNeutralizationSuite(tampered).valid, false);
  const promotedControl = structuredClone(settled.suite);
  const controlTrial = promotedControl.trials.find(
    (trial) => trial.candidateId === MARKET_CONTROL_ID,
  );
  const controlLedger = controlTrial.registry.ledgers.find(
    (row) => row.ledgerId === controlTrial.registry.activeLedgerId,
  );
  controlLedger.events.push({ type: "promotion" });
  assert.equal(verifyTemperatureNeutralizationSuite(promotedControl).valid, false);
});

check("the final suite remains independently hash-valid", () => {
  assert.deepEqual(
    verifyTemperatureNeutralizationSuite(settled.suite),
    { valid: true, blockers: [] },
  );
});

const ok = checks.every((row) => row.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  verifier: "candidate-prospective-temperature-neutralization-suite",
  assertions: checks.length,
  checks,
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
