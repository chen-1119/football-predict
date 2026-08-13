"use strict";

const assert = require("node:assert/strict");
const {
  ModelLearningRegistryError,
  applyLearningCandidate,
  buildCandidateFromEvaluation,
  buildLearningEvidenceFromEvaluation,
  canonicalCandidateArtifact,
  createLearningRegistry,
  rollbackChampion,
  sha256,
  stableStringify,
  validateLearningRegistry,
} = require("./modelLearningRegistry.cjs");
const { evaluateResidualMarketWalkForward } = require("./residualMarketWalkForward.cjs");
const {
  FEATURE_SCHEMA_VERSION,
  predict,
} = require("./residualMarketModel.cjs");

let assertions = 0;
const check = (value, message) => {
  assert.ok(value, message);
  assertions += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};
const deepEqual = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (char) => char.repeat(64);

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOME_INDEX = Object.freeze({ "1": 0, X: 1, "2": 2 });
const actor = { type: "automation", id: "nightly-learning-cycle" };
const productionContract = {
  inferenceImplementationHash: hash("a"),
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  policyVersion: "multi-factor-market-evidence-v2",
};
const walkForwardOptions = {
  minTrainingRows: 30,
  holdoutRows: 85,
  minFolds: 6,
  iterations: 60,
};

const shiftedTriplet = (base, shiftOne, shiftDraw) => ({
  "1": Math.max(0.05, base["1"] + shiftOne),
  X: Math.max(0.05, base.X + shiftDraw),
  "2": Math.max(0.05, base["2"] - shiftOne - shiftDraw),
});

const syntheticRows = (count = 560, strength = 1) => {
  const start = Date.parse("2024-01-01T08:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const forecastMs = start + index * DAY_MS;
    const market = {
      "1": 0.39 + (index % 5) * 0.012,
      X: 0.29 + (index % 3) * 0.008,
      "2": 0.32 - (index % 5) * 0.012 - (index % 3) * 0.008,
    };
    const signalOutcome = ["1", "X", "2"][(index * 5 + Math.floor(index / 3)) % 3];
    const actual = index % 9 === 0
      ? ["1", "X", "2"][(OUTCOME_INDEX[signalOutcome] + 1) % 3]
      : signalOutcome;
    return {
      sourceMatchId: `registry-${strength}-${String(index).padStart(4, "0")}`,
      forecastTime: new Date(forecastMs).toISOString(),
      featureObservedAt: new Date(forecastMs - 60 * 60 * 1000).toISOString(),
      kickoffTime: new Date(forecastMs + 2 * 60 * 60 * 1000).toISOString(),
      resultObservedAt: new Date(forecastMs + 5 * 60 * 60 * 1000).toISOString(),
      resultObservedAtFallback: false,
      actual,
      marketProbabilities: market,
      currentModelProbabilities: shiftedTriplet(
        market,
        signalOutcome === "1" ? 0.07 * strength : -0.025 * strength,
        signalOutcome === "X" ? 0.055 * strength : -0.015 * strength,
      ),
      historicalModelProbabilities: shiftedTriplet(
        market,
        signalOutcome === "1" ? 0.035 * strength : -0.012 * strength,
        signalOutcome === "X" ? 0.025 * strength : -0.008 * strength,
      ),
      openingMarketProbabilities: shiftedTriplet(market, -0.015, 0.008),
    };
  });
};

const marketPerfectRows = (rows) => rows.map((row, index) => {
  const actual = ["1", "X", "2"][index % 3];
  const marketProbabilities = actual === "1"
    ? { "1": 0.98, X: 0.01, "2": 0.01 }
    : actual === "X"
      ? { "1": 0.01, X: 0.98, "2": 0.01 }
      : { "1": 0.01, X: 0.01, "2": 0.98 };
  return {
    ...row,
    actual,
    marketProbabilities,
    currentModelProbabilities: marketProbabilities,
    historicalModelProbabilities: marketProbabilities,
    openingMarketProbabilities: marketProbabilities,
  };
});

const evaluationFromResidual = (residual, options = {}) => ({
  version: "rolling-backtest-real-residual-fixture-v1",
  generatedAt: options.generatedAt || "2026-07-16T02:45:00.000Z",
  residualMarketWalkForward: residual,
  inputAudit: {
    ok: options.inputAuditClean !== false,
    promotionEligible: options.inputAuditClean !== false,
  },
  promotionEvidenceAudit: {
    manifest: {
      promotionEligible: options.promotionEvidenceEligible !== false,
      eligibleRows: options.eligibleRows ?? residual?.aggregate?.rows ?? 0,
      conflictingDuplicateKeys: options.conflictingDuplicateKeys || 0,
      manifestHash: options.promotionManifestHash || hash("e"),
    },
    summary: {
      eligibleRows: options.eligibleRows ?? residual?.aggregate?.rows ?? 0,
    },
  },
  recommendationSelection: {
    gate: { eligible: options.productionPolicyReplayEligible !== false },
  },
  riskTiers: {
    overall: { tier: options.riskTier || "stable" },
  },
  // Deliberately unrelated values prove the registry no longer reads the old
  // shadowCandidates identity or performance path.
  shadowCandidates: options.shadowCandidates || {
    bestCandidate: { id: "must-not-be-read-market", metrics: { rows: 1, brier: 0, logLoss: 0 } },
    bestModelCandidate: {
      id: "must-not-be-read-model",
      weights: { model: 0 },
      metrics: { rows: 1, brier: 99, logLoss: 99 },
      comparison: { rows: 1, pairedByMatch: false, brierImprovement: -99, logLossImprovement: -99 },
    },
  },
});

const registry0 = createLearningRegistry({ createdAt: "2026-07-16T02:00:00.000Z" });
equal(validateLearningRegistry(registry0).valid, true, "empty registry must verify");

const rowsA = syntheticRows();
const residualA = evaluateResidualMarketWalkForward(rowsA, walkForwardOptions);
equal(residualA.status, "evaluated-shadow");
equal(residualA.productionEligible, false, "the residual artifact must never self-authorize production");
equal(residualA.candidateReady, true, "real complete OOS improvement should make the internal candidate ready");
check(residualA.aggregate.rows >= 500, "the real OOS result set must satisfy the immutable evidence floor");
check(residualA.folds.length >= 6, "the real walk-forward result must contain independent windows");

const evaluationA = evaluationFromResidual(residualA);
const evidenceA = buildLearningEvidenceFromEvaluation(evaluationA);
const candidateA = buildCandidateFromEvaluation(evaluationA, productionContract);
equal(candidateA.candidateId, residualA.finalCandidate.candidateId);
equal(candidateA.candidateId, `residual-market:${residualA.finalCandidate.modelHash}`);
check(!candidateA.candidateId.includes(evaluationA.generatedAt), "candidate identity must not contain scheduler time");
equal(candidateA.modelHash, residualA.finalCandidate.modelHash);
equal(candidateA.trainingDataHash, residualA.finalCandidate.dataHash);
equal(candidateA.parametersHash, residualA.finalCandidate.parametersHash);
equal(candidateA.featureSchemaHash, residualA.finalCandidate.featureSchemaHash);
equal(candidateA.trainedThrough, residualA.finalCandidate.trainedThrough);
equal(candidateA.generatedAt, residualA.finalCandidate.evaluationTime);
equal(candidateA.productionEligible, false);
equal(candidateA.candidateReady, true);
deepEqual(candidateA.model, residualA.finalCandidate, "the registry artifact must persist the exact final fitted model");
equal(candidateA.parametersHash, sha256(stableStringify(candidateA.model.parameters)));
deepEqual(candidateA.validationBlockers, [], "a content-bound real final model must validate cleanly");
equal(evidenceA.candidateId, candidateA.candidateId);
equal(evidenceA.sameMatch.rows, residualA.aggregate.rows);
equal(evidenceA.sameMatch.brierImprovement, residualA.aggregate.improvement.brier);
equal(evidenceA.sameMatch.logLossImprovement, residualA.aggregate.improvement.logLoss);
equal(evidenceA.residualWalkForward.modelHash, candidateA.modelHash);
equal(evidenceA.residualWalkForward.parametersHash, candidateA.parametersHash);
equal(evidenceA.residualWalkForward.productionEligible, false);
equal(evidenceA.residualWalkForward.candidateReady, true);
const persistedPrediction = predict(candidateA.model, rowsA[rowsA.length - 1]);
equal(persistedPrediction.modelHash, candidateA.modelHash, "the registered model payload must be directly loadable");

const promotedA = applyLearningCandidate({
  registry: registry0,
  candidate: candidateA,
  evaluation: evidenceA,
  productionContract,
  at: "2026-07-16T03:00:00.000Z",
  actor,
});
equal(promotedA.decision.status, "promoted", "external gates may promote a ready shadow artifact");
equal(promotedA.registry.championArtifactHash, candidateA.artifactHash);
equal(promotedA.registry.entries.length, 1);
equal(validateLearningRegistry(promotedA.registry).valid, true);

const evaluationSameDataLater = evaluationFromResidual(residualA, {
  generatedAt: "2026-07-17T12:34:56.000Z",
  shadowCandidates: {
    bestCandidate: { id: "changed-but-ignored" },
    bestModelCandidate: { id: "changed-but-ignored", weights: { model: 1 } },
  },
});
const candidateSameDataLater = buildCandidateFromEvaluation(evaluationSameDataLater, productionContract);
const evidenceSameDataLater = buildLearningEvidenceFromEvaluation(evaluationSameDataLater);
deepEqual(candidateSameDataLater, candidateA, "same residual input must produce the same artifact despite generatedAt changes");
deepEqual(evidenceSameDataLater, evidenceA, "model evidence must ignore unrelated shadow candidates and scheduler time");
const duplicateA = applyLearningCandidate({
  registry: promotedA.registry,
  candidate: candidateSameDataLater,
  evaluation: evidenceSameDataLater,
  productionContract,
  at: "2026-07-17T13:00:00.000Z",
  actor,
});
equal(duplicateA.idempotent, true, "same data with a later generatedAt must be a no-op");
equal(duplicateA.registry.entries.length, 1);

const belowEvidenceEvaluation = evaluationFromResidual(residualA, { eligibleRows: 499 });
const belowEvidence = applyLearningCandidate({
  registry: promotedA.registry,
  candidate: buildCandidateFromEvaluation(belowEvidenceEvaluation, productionContract),
  evaluation: belowEvidenceEvaluation,
  productionContract,
  thresholds: { minPromotionEvidenceRows: 1 },
  at: "2026-07-17T14:00:00.000Z",
  actor,
});
equal(belowEvidence.decision.status, "shadow-blocked", "fewer than 500 promotion rows must remain shadow");
check(belowEvidence.decision.blockers.includes("promotion-evidence-rows-insufficient"));
equal(belowEvidence.registry.championArtifactHash, candidateA.artifactHash);

const noGainResidual = evaluateResidualMarketWalkForward(
  marketPerfectRows(syntheticRows()),
  walkForwardOptions,
);
equal(noGainResidual.status, "evaluated-shadow");
equal(noGainResidual.productionEligible, false);
equal(noGainResidual.candidateReady, false);
check(noGainResidual.internalCandidateBlockers.some((blocker) => /oos-(brier|logloss)-not-improved/.test(blocker)));
const noGainEvaluation = evaluationFromResidual(noGainResidual);
const noGainCandidate = buildCandidateFromEvaluation(noGainEvaluation, productionContract);
const noGain = applyLearningCandidate({
  registry: belowEvidence.registry,
  candidate: noGainCandidate,
  evaluation: noGainEvaluation,
  productionContract,
  at: "2026-07-17T15:00:00.000Z",
  actor,
});
equal(noGain.decision.status, "shadow-blocked", "a real final fit without OOS gain must not promote");
check(noGain.decision.blockers.includes("residual-final-candidate-not-ready"));
check(noGain.decision.blockers.includes("residual-final-candidate-internal-blockers"));
equal(noGain.registry.championArtifactHash, candidateA.artifactHash);

const zeroResidual = evaluateResidualMarketWalkForward([], walkForwardOptions);
const zeroEvaluation = evaluationFromResidual(zeroResidual);
const zeroCandidate = buildCandidateFromEvaluation(zeroEvaluation, productionContract);
const zeroEvidence = buildLearningEvidenceFromEvaluation(zeroEvaluation, productionContract);
const zeroResult = applyLearningCandidate({
  registry: noGain.registry,
  candidate: zeroCandidate,
  evaluation: zeroEvidence,
  productionContract,
  at: "2026-07-17T16:00:00.000Z",
  actor,
});
equal(zeroResidual.candidateReady, false);
equal(zeroResidual.productionEligible, false);
equal(zeroResult.decision.status, "shadow-blocked", "a real zero-sample evaluation must remain shadow");
check(zeroResult.decision.blockers.includes("model-payload-missing"));
equal(zeroResult.registry.championArtifactHash, candidateA.artifactHash);

const nextInferenceContract = {
  ...productionContract,
  inferenceImplementationHash: hash("b"),
};
const zeroCandidateNextContract = buildCandidateFromEvaluation(zeroEvaluation, nextInferenceContract);
const zeroEvidenceNextContract = buildLearningEvidenceFromEvaluation(zeroEvaluation, nextInferenceContract);
check(
  zeroCandidateNextContract.candidateId !== zeroCandidate.candidateId,
  "an untrained candidate id must change when its inference contract changes",
);
equal(
  zeroEvidenceNextContract.candidateId,
  zeroCandidateNextContract.candidateId,
  "untrained evidence must bind the same runtime contract as its candidate artifact",
);
const zeroNextContractResult = applyLearningCandidate({
  registry: zeroResult.registry,
  candidate: zeroCandidateNextContract,
  evaluation: zeroEvidenceNextContract,
  productionContract: nextInferenceContract,
  at: "2026-07-17T16:30:00.000Z",
  actor,
});
equal(
  zeroNextContractResult.decision.status,
  "shadow-blocked",
  "a new untrained runtime contract must append shadow evidence without colliding with the prior immutable id",
);
equal(
  validateLearningRegistry(zeroNextContractResult.registry).valid,
  true,
  "the registry must remain valid after an untrained runtime-contract migration",
);

const forgedRawCandidate = {
  ...candidateA,
  candidateId: "forged-self-hash",
  declaredArtifactHash: hash("9"),
};
delete forgedRawCandidate.artifactHash;
delete forgedRawCandidate.validationBlockers;
const forgedCandidate = canonicalCandidateArtifact(forgedRawCandidate);
check(forgedCandidate.validationBlockers.includes("candidate-declared-hash-mismatch"));
check(forgedCandidate.artifactHash !== hash("9"), "self-reported hash must never replace recomputed hash");

const tamperedParameters = clone(candidateA);
tamperedParameters.model.parameters.bias["1"] += 0.01;
delete tamperedParameters.artifactHash;
delete tamperedParameters.validationBlockers;
const tamperedParameterCandidate = canonicalCandidateArtifact(tamperedParameters);
check(tamperedParameterCandidate.validationBlockers.includes("parameters-hash-mismatch"));
check(tamperedParameterCandidate.validationBlockers.includes("model-content-hash-mismatch"));

const tamperedRegistry = clone(promotedA.registry);
tamperedRegistry.artifacts[0].model.parameters.bias["1"] += 0.01;
const tamperValidation = validateLearningRegistry(tamperedRegistry);
equal(tamperValidation.valid, false);
check(tamperValidation.errors.some((error) => error.startsWith("artifact-hash-mismatch")));
check(tamperValidation.errors.includes("registry-hash-mismatch"));

let conflictRejected = false;
try {
  const conflictingCandidate = clone(candidateA);
  conflictingCandidate.model.parameters.bias["1"] += 0.01;
  delete conflictingCandidate.artifactHash;
  delete conflictingCandidate.validationBlockers;
  applyLearningCandidate({
    registry: promotedA.registry,
    candidate: conflictingCandidate,
    evaluation: evidenceA,
    productionContract,
    at: "2026-07-17T17:00:00.000Z",
    actor,
  });
} catch (error) {
  conflictRejected = error instanceof ModelLearningRegistryError && /candidate id conflict/.test(error.message);
}
check(conflictRejected, "same candidate id with different content must fail closed");

let llmRejected = false;
try {
  canonicalCandidateArtifact({ ...candidateA, candidateId: "llm-candidate", llm: { prompt: "raise probability" } });
} catch (error) {
  llmRejected = error instanceof ModelLearningRegistryError && /AI\/LLM control field/.test(error.message);
}
check(llmRejected, "LLM control fields must be rejected from model artifacts");

const rowsB = syntheticRows(560, 1.15);
const residualB = evaluateResidualMarketWalkForward(rowsB, walkForwardOptions);
equal(residualB.candidateReady, true);
const evaluationB = evaluationFromResidual(residualB, { promotionManifestHash: hash("f") });
const candidateB = buildCandidateFromEvaluation(evaluationB, productionContract);
const promotedB = applyLearningCandidate({
  registry: zeroNextContractResult.registry,
  candidate: candidateB,
  evaluation: evaluationB,
  productionContract,
  at: "2026-07-17T18:00:00.000Z",
  actor,
});
equal(promotedB.decision.status, "promoted");
equal(promotedB.registry.championArtifactHash, candidateB.artifactHash);
equal(validateLearningRegistry(promotedB.registry).valid, true);

const rolledBack = rollbackChampion({
  registry: promotedB.registry,
  targetArtifactHash: candidateA.artifactHash,
  at: "2026-07-17T19:00:00.000Z",
  actor: { type: "operator", id: "ops-reviewer" },
  reason: "post-deploy drift threshold exceeded",
});
equal(rolledBack.registry.championArtifactHash, candidateA.artifactHash);
equal(rolledBack.transition.status, "rollback");
equal(validateLearningRegistry(rolledBack.registry).valid, true);

const duplicateRollback = rollbackChampion({
  registry: rolledBack.registry,
  targetArtifactHash: candidateA.artifactHash,
  at: "2026-07-17T20:00:00.000Z",
  actor: { type: "operator", id: "ops-reviewer" },
  reason: "post-deploy drift threshold exceeded",
});
equal(duplicateRollback.idempotent, true);
equal(duplicateRollback.registry.entries.length, rolledBack.registry.entries.length);

console.log(JSON.stringify({
  ok: true,
  verifier: "model-learning-registry-v1",
  assertions,
  realResidualCandidate: candidateA.candidateId,
  parameterBytesHash: candidateA.parametersHash,
  promotedCandidate: candidateA.artifactHash,
  blockedNoGainCandidate: noGainCandidate.artifactHash,
  zeroSampleShadow: zeroResult.decision.status === "shadow-blocked",
  sameInputGeneratedAtNoOp: duplicateA.idempotent,
  shadowCandidatePathIgnored: true,
  finalChampion: rolledBack.registry.championArtifactHash,
  entries: rolledBack.registry.entries.length,
  tamperDetected: !tamperValidation.valid,
  llmControlRejected: llmRejected,
  rollbackVerified: true,
}, null, 2));
