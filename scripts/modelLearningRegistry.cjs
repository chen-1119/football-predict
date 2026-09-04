"use strict";

const crypto = require("node:crypto");

const REGISTRY_VERSION = "model-learning-registry-v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_THRESHOLDS = Object.freeze({
  minSameMatchRows: 500,
  minIndependentWindows: 6,
  minRollingPassRate: 0.6,
  minResidualFolds: 3,
  minPromotionEvidenceRows: 500,
});

class ModelLearningRegistryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ModelLearningRegistryError";
    this.code = "MODEL_LEARNING_REGISTRY_ERROR";
    Object.assign(this, details);
  }
}

const sha256 = (value) => crypto.createHash("sha256")
  .update(Buffer.isBuffer(value) ? value : String(value))
  .digest("hex");

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

const canonicalIso = (value, field) => {
  const millis = Date.parse(String(value || ""));
  if (!Number.isFinite(millis)) throw new ModelLearningRegistryError(`${field} must be a valid timestamp`);
  return new Date(millis).toISOString();
};

const nonempty = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const finite = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const integer = (value) => {
  const number = finite(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const forbiddenAiKey = (key) => /(^|_)(llm|prompt|messages|chatgpt|gemini|aiadvice|aiprobability|ai_probability)($|_)/i.test(key);

const assertNoAiControlFields = (value, path = "candidate") => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAiControlFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenAiKey(key)) {
      throw new ModelLearningRegistryError(`AI/LLM control field is forbidden: ${path}.${key}`);
    }
    assertNoAiControlFields(child, `${path}.${key}`);
  }
};

const canonicalActor = (actor) => {
  const type = nonempty(actor?.type);
  const id = nonempty(actor?.id);
  if (!type || !["automation", "operator"].includes(type)) {
    throw new ModelLearningRegistryError("actor.type must be automation or operator");
  }
  if (!id) throw new ModelLearningRegistryError("actor.id is required");
  return { type, id };
};

const canonicalStringArray = (value) => Array.from(new Set((Array.isArray(value) ? value : [])
  .map(nonempty)
  .filter(Boolean)))
  .sort();

const residualCandidateId = (residual = {}, identityContract = {}) => {
  const finalCandidate = residual?.finalCandidate || null;
  const explicit = nonempty(finalCandidate?.candidateId);
  if (explicit) return explicit;
  const identityHash = sha256(stableStringify({
    version: nonempty(residual?.version),
    manifestHash: nonempty(residual?.manifestHash),
    inputDataHash: nonempty(residual?.input?.dataHash),
    inferenceImplementationHash: nonempty(identityContract?.inferenceImplementationHash),
    featureSchemaVersion: nonempty(identityContract?.featureSchemaVersion),
    policyVersion: nonempty(identityContract?.policyVersion),
  }));
  return `residual-market-untrained:${identityHash}`;
};

const artifactBody = (artifact) => {
  const {
    artifactHash: _artifactHash,
    declaredArtifactHash: _declaredArtifactHash,
    validationBlockers: _validationBlockers,
    ...body
  } = artifact || {};
  return body;
};

const canonicalCandidateArtifact = (candidate = {}) => {
  assertNoAiControlFields(candidate);
  const model = candidate.model && typeof candidate.model === "object"
    ? stableValue(candidate.model)
    : null;
  const generatedAt = canonicalIso(
    model?.evaluationTime || candidate.generatedAt,
    "candidate.generatedAt",
  );
  const trainedThroughValue = model?.trainedThrough || candidate.trainedThrough;
  const trainedThrough = trainedThroughValue
    ? canonicalIso(trainedThroughValue, "candidate.trainedThrough")
    : null;
  const parameters = model?.parameters && typeof model.parameters === "object"
    ? stableValue(model.parameters)
    : null;
  const featureSchema = model?.featureSchema && typeof model.featureSchema === "object"
    ? stableValue(model.featureSchema)
    : null;
  const computedParametersHash = parameters ? sha256(stableStringify(parameters)) : null;
  const computedFeatureSchemaHash = featureSchema ? sha256(stableStringify(featureSchema)) : null;
  const declaredParametersHash = nonempty(candidate.parametersHash || model?.parametersHash);
  const declaredFeatureSchemaHash = nonempty(candidate.featureSchemaHash || model?.featureSchemaHash);
  const modelHash = nonempty(model?.modelHash || candidate.modelHash);
  const trainingDataHash = nonempty(model?.dataHash || candidate.trainingDataHash);
  const hyperparameters = model?.hyperparameters && typeof model.hyperparameters === "object"
    ? stableValue(model.hyperparameters)
    : candidate.hyperparameters && typeof candidate.hyperparameters === "object"
      ? stableValue(candidate.hyperparameters)
      : {};
  const body = {
    version: "model-candidate-artifact-v1",
    candidateId: nonempty(candidate.candidateId || candidate.id),
    candidateType: nonempty(candidate.candidateType) || "shadow-model",
    algorithmVersion: nonempty(candidate.algorithmVersion),
    modelVersion: nonempty(model?.version || candidate.modelVersion),
    featureSchemaVersion: nonempty(featureSchema?.version || candidate.featureSchemaVersion),
    featureSchemaHash: computedFeatureSchemaHash,
    policyVersion: nonempty(candidate.policyVersion),
    inferenceImplementationHash: nonempty(candidate.inferenceImplementationHash),
    modelHash,
    trainingDataHash,
    parametersHash: computedParametersHash,
    metricsManifestHash: nonempty(candidate.metricsManifestHash),
    generatedAt,
    trainedThrough,
    shadowOnly: model?.shadowOnly !== false,
    productionEligible: model?.productionEligible === true,
    candidateReady: model?.candidateReady === true,
    internalCandidateBlockers: canonicalStringArray(model?.internalCandidateBlockers),
    featureSet: canonicalStringArray(candidate.featureSet),
    hyperparameters,
    model,
  };
  const artifactHash = sha256(stableStringify(body));
  const declaredArtifactHash = nonempty(candidate.artifactHash || candidate.declaredArtifactHash);
  const validationBlockers = [];
  if (!body.candidateId) validationBlockers.push("candidate-id-missing");
  if (!body.algorithmVersion) validationBlockers.push("algorithm-version-missing");
  if (!body.modelVersion) validationBlockers.push("model-version-missing");
  if (!body.featureSchemaVersion) validationBlockers.push("feature-schema-version-missing");
  if (!body.policyVersion) validationBlockers.push("policy-version-missing");
  if (!model) validationBlockers.push("model-payload-missing");
  if (!parameters) validationBlockers.push("model-parameters-missing");
  if (!featureSchema) validationBlockers.push("model-feature-schema-missing");
  if (!HASH_PATTERN.test(body.inferenceImplementationHash || "")) validationBlockers.push("inference-implementation-hash-invalid");
  if (!HASH_PATTERN.test(body.modelHash || "")) validationBlockers.push("model-hash-invalid");
  if (!HASH_PATTERN.test(body.trainingDataHash || "")) validationBlockers.push("training-data-hash-invalid");
  if (!HASH_PATTERN.test(body.parametersHash || "")) validationBlockers.push("parameters-hash-invalid");
  if (!HASH_PATTERN.test(body.featureSchemaHash || "")) validationBlockers.push("feature-schema-hash-invalid");
  if (!HASH_PATTERN.test(body.metricsManifestHash || "")) validationBlockers.push("metrics-manifest-hash-invalid");
  if (declaredParametersHash && declaredParametersHash !== computedParametersHash) {
    validationBlockers.push("parameters-hash-mismatch");
  }
  if (declaredFeatureSchemaHash && declaredFeatureSchemaHash !== computedFeatureSchemaHash) {
    validationBlockers.push("feature-schema-hash-mismatch");
  }
  if (model?.featureSchemaHash && model.featureSchemaHash !== computedFeatureSchemaHash) {
    validationBlockers.push("model-feature-schema-hash-mismatch");
  }
  if (candidate.modelHash && model?.modelHash && candidate.modelHash !== model.modelHash) {
    validationBlockers.push("candidate-model-hash-mismatch");
  }
  if (candidate.trainingDataHash && model?.dataHash && candidate.trainingDataHash !== model.dataHash) {
    validationBlockers.push("candidate-training-data-hash-mismatch");
  }
  if (model && parameters && featureSchema && trainedThrough) {
    const expectedModelHash = sha256(stableStringify({
      version: model.version,
      featureSchemaHash: computedFeatureSchemaHash,
      dataHash: model.dataHash,
      evaluationTime: generatedAt,
      trainedThrough,
      hyperparameters,
      parameters,
    }));
    if (modelHash !== expectedModelHash) validationBlockers.push("model-content-hash-mismatch");
  }
  if (body.productionEligible) validationBlockers.push("model-self-production-eligibility-forbidden");
  if (body.candidateReady && body.internalCandidateBlockers.length) {
    validationBlockers.push("candidate-ready-with-internal-blockers");
  }
  if (declaredArtifactHash && declaredArtifactHash !== artifactHash) {
    validationBlockers.push("candidate-declared-hash-mismatch");
  }
  return {
    ...body,
    artifactHash,
    validationBlockers,
  };
};

const entryBody = (entry) => {
  const { entryHash: _entryHash, ...body } = entry || {};
  return body;
};

const registryBody = (registry) => {
  const { registryHash: _registryHash, ...body } = registry || {};
  return body;
};

const finalizeRegistry = (body) => {
  const normalized = stableValue(body);
  return {
    ...normalized,
    registryHash: sha256(stableStringify(normalized)),
  };
};

const createLearningRegistry = ({ createdAt } = {}) => finalizeRegistry({
  version: REGISTRY_VERSION,
  createdAt: canonicalIso(createdAt, "createdAt"),
  artifacts: [],
  entries: [],
  championArtifactHash: null,
  headEntryHash: null,
});

const validateLearningRegistry = (registry) => {
  const errors = [];
  if (!registry || typeof registry !== "object") return { valid: false, errors: ["registry-invalid"] };
  if (registry.version !== REGISTRY_VERSION) errors.push("registry-version-invalid");
  try {
    canonicalIso(registry.createdAt, "registry.createdAt");
  } catch {
    errors.push("registry-created-at-invalid");
  }
  const artifacts = Array.isArray(registry.artifacts) ? registry.artifacts : [];
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  if (!Array.isArray(registry.artifacts)) errors.push("registry-artifacts-invalid");
  if (!Array.isArray(registry.entries)) errors.push("registry-entries-invalid");

  const artifactHashes = new Set();
  const candidateIds = new Map();
  for (const artifact of artifacts) {
    const expected = sha256(stableStringify(artifactBody(artifact)));
    if (artifact.artifactHash !== expected) errors.push(`artifact-hash-mismatch:${artifact.candidateId || "unknown"}`);
    if (artifactHashes.has(artifact.artifactHash)) errors.push(`artifact-duplicate:${artifact.artifactHash}`);
    artifactHashes.add(artifact.artifactHash);
    const prior = candidateIds.get(artifact.candidateId);
    if (prior && prior !== artifact.artifactHash) errors.push(`candidate-id-conflict:${artifact.candidateId}`);
    candidateIds.set(artifact.candidateId, artifact.artifactHash);
  }

  let previousEntryHash = null;
  const promoted = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sequence !== index + 1) errors.push(`entry-sequence-invalid:${index + 1}`);
    if ((entry.previousEntryHash || null) !== previousEntryHash) errors.push(`entry-chain-invalid:${index + 1}`);
    const expected = sha256(stableStringify(entryBody(entry)));
    if (entry.entryHash !== expected) errors.push(`entry-hash-mismatch:${index + 1}`);
    if (entry.candidateArtifactHash && !artifactHashes.has(entry.candidateArtifactHash)) {
      errors.push(`entry-artifact-missing:${index + 1}`);
    }
    if (entry.status === "promoted" && entry.nextChampionArtifactHash) promoted.add(entry.nextChampionArtifactHash);
    if (entry.status === "rollback" && !promoted.has(entry.nextChampionArtifactHash)) {
      errors.push(`rollback-target-never-promoted:${index + 1}`);
    }
    previousEntryHash = entry.entryHash;
  }
  if ((registry.headEntryHash || null) !== previousEntryHash) errors.push("registry-head-mismatch");
  if (registry.championArtifactHash && !artifactHashes.has(registry.championArtifactHash)) {
    errors.push("registry-champion-artifact-missing");
  }
  if (registry.championArtifactHash && !promoted.has(registry.championArtifactHash)) {
    errors.push("registry-champion-never-promoted");
  }
  const expectedRegistryHash = sha256(stableStringify(registryBody(registry)));
  if (registry.registryHash !== expectedRegistryHash) errors.push("registry-hash-mismatch");
  return { valid: errors.length === 0, errors };
};

const assertValidRegistry = (registry) => {
  const validation = validateLearningRegistry(registry);
  if (!validation.valid) {
    throw new ModelLearningRegistryError("registry validation failed", { errors: validation.errors });
  }
};

const buildLearningEvidenceFromEvaluation = (evaluation = {}, identityContract = {}) => {
  assertNoAiControlFields(evaluation?.learningControl || {});
  const residual = evaluation?.residualMarketWalkForward || {};
  const finalCandidate = residual?.finalCandidate || {};
  const aggregate = residual?.aggregate || {};
  const aggregateImprovement = aggregate?.improvement || {};
  const folds = Array.isArray(residual?.folds) ? residual.folds : [];
  const completeFolds = integer(residual?.sample?.completeFolds ?? folds.length);
  const foldRows = folds.reduce((sum, fold) => sum + (integer(fold?.window?.rows) || 0), 0);
  const completeFoldCoverage = completeFolds !== null
    && folds.length === completeFolds
    && folds.every((fold) => (
      Array.isArray(fold?.blockers)
      && fold.blockers.length === 0
      && fold?.window?.contiguousWithPrevious === true
      && fold?.sampleGates?.completeHoldout === true
      && fold?.sampleGates?.completePredictionCoverage === true
      && fold?.sampleGates?.strictWatermark === true
    ));
  const improvingFolds = folds.filter((fold) => (
    finite(fold?.metrics?.improvement?.brier) > 0
    && finite(fold?.metrics?.improvement?.logLoss) > 0
  )).length;
  const rollingPassRate = folds.length ? improvingFolds / folds.length : null;
  const candidateId = residualCandidateId(residual, identityContract);
  const evidenceGeneratedAt = finalCandidate?.evaluationTime
    ? canonicalIso(finalCandidate.evaluationTime, "residual.finalCandidate.evaluationTime")
    : "1970-01-01T00:00:00.000Z";
  const promotionManifest = evaluation?.promotionEvidenceAudit?.manifest || {};
  const promotionSummary = evaluation?.promotionEvidenceAudit?.summary || {};
  const recommendationGate = evaluation?.recommendationSelection?.gate || {};
  return stableValue({
    version: "model-learning-evidence-v1",
    sourceEvaluationVersion: nonempty(evaluation.version),
    generatedAt: evidenceGeneratedAt,
    candidateId,
    usesModelSignal: Boolean(
      finalCandidate?.parameters
      && HASH_PATTERN.test(finalCandidate?.modelHash || "")
      && HASH_PATTERN.test(finalCandidate?.parametersHash || "")
    ),
    sameMatch: {
      rows: integer(aggregate.rows),
      brierImprovement: finite(aggregateImprovement.brier),
      logLossImprovement: finite(aggregateImprovement.logLoss),
      pairedByMatch: completeFoldCoverage && integer(aggregate.rows) === foldRows,
      marginalBrierImprovementVsCalibratedMarket: finite(aggregateImprovement.brier),
      marginalLogLossImprovementVsCalibratedMarket: finite(aggregateImprovement.logLoss),
    },
    rolling: {
      windows: folds.length,
      passRate: finite(rollingPassRate),
      sufficientIndependentWindows: completeFoldCoverage,
    },
    walkForward: {
      status: residual?.candidateReady === true ? "validated" : nonempty(residual.status),
      eligible: residual?.candidateReady === true,
      folds: completeFolds,
      watermarkVerified: completeFoldCoverage,
    },
    residualWalkForward: {
      status: nonempty(residual.status),
      productionEligible: residual.productionEligible === true,
      candidateReady: residual.candidateReady === true,
      internalCandidateBlockers: canonicalStringArray(residual.internalCandidateBlockers),
      completeFolds,
      manifestHash: nonempty(residual.manifestHash),
      modelHash: nonempty(finalCandidate.modelHash),
      trainingDataHash: nonempty(finalCandidate.dataHash),
      parametersHash: nonempty(finalCandidate.parametersHash),
      featureSchemaHash: nonempty(finalCandidate.featureSchemaHash),
      trainedThrough: finalCandidate.trainedThrough
        ? canonicalIso(finalCandidate.trainedThrough, "residual.finalCandidate.trainedThrough")
        : null,
    },
    promotionEvidence: {
      eligible: promotionManifest.promotionEligible === true,
      eligibleRows: integer(promotionManifest.eligibleRows ?? promotionSummary.eligibleRows),
      conflictingDuplicateKeys: integer(promotionManifest.conflictingDuplicateKeys),
      manifestHash: nonempty(promotionManifest.manifestHash),
    },
    inputAuditClean: evaluation?.inputAudit?.ok === true
      && evaluation?.inputAudit?.promotionEligible !== false,
    riskTier: nonempty(evaluation?.riskTiers?.overall?.tier),
    productionPolicyReplayEligible: recommendationGate.eligible === true,
  });
};

const buildCandidateFromEvaluation = (evaluation = {}, options = {}) => {
  const residual = evaluation?.residualMarketWalkForward || {};
  const finalCandidate = residual?.finalCandidate || null;
  const featureSet = Array.isArray(finalCandidate?.featureSchema?.features)
    ? [
      "market-offset",
      ...finalCandidate.featureSchema.features.map((feature) => feature?.name).filter(Boolean),
    ]
    : [];
  return canonicalCandidateArtifact({
    candidateId: residualCandidateId(residual, options),
    candidateType: "market-residual-shadow",
    algorithmVersion: residual.version || options.algorithmVersion,
    modelVersion: finalCandidate?.version || options.modelVersion,
    featureSchemaVersion: finalCandidate?.featureSchema?.version || options.featureSchemaVersion,
    featureSchemaHash: finalCandidate?.featureSchemaHash,
    policyVersion: options.policyVersion,
    inferenceImplementationHash: options.inferenceImplementationHash,
    modelHash: finalCandidate?.modelHash || options.modelHash,
    trainingDataHash: finalCandidate?.dataHash || residual?.input?.dataHash || options.trainingDataHash,
    parametersHash: finalCandidate?.parametersHash,
    metricsManifestHash: residual.manifestHash || options.metricsManifestHash,
    generatedAt: finalCandidate?.evaluationTime || "1970-01-01T00:00:00.000Z",
    trainedThrough: finalCandidate?.trainedThrough || options.trainedThrough,
    featureSet,
    hyperparameters: finalCandidate?.hyperparameters || residual?.config?.fit || {},
    model: finalCandidate,
  });
};

const normalizedThresholds = (thresholds = {}) => ({
  minSameMatchRows: Math.max(DEFAULT_THRESHOLDS.minSameMatchRows, integer(thresholds.minSameMatchRows) || 0),
  minIndependentWindows: Math.max(DEFAULT_THRESHOLDS.minIndependentWindows, integer(thresholds.minIndependentWindows) || 0),
  minRollingPassRate: Math.max(DEFAULT_THRESHOLDS.minRollingPassRate, finite(thresholds.minRollingPassRate) || 0),
  minResidualFolds: Math.max(DEFAULT_THRESHOLDS.minResidualFolds, integer(thresholds.minResidualFolds) || 0),
  minPromotionEvidenceRows: Math.max(DEFAULT_THRESHOLDS.minPromotionEvidenceRows, integer(thresholds.minPromotionEvidenceRows) || 0),
});

const promotionBlockers = ({ artifact, evidence, productionContract, thresholds }) => {
  const blockers = [...(artifact.validationBlockers || [])];
  const required = normalizedThresholds(thresholds);
  const contract = productionContract || {};
  if (!evidence.candidateId || artifact.candidateId !== evidence.candidateId) {
    blockers.push("candidate-evidence-id-mismatch");
  }
  if (!evidence.usesModelSignal) blockers.push("model-signal-missing");
  if (!evidence.sameMatch.pairedByMatch) blockers.push("same-match-pairing-unverified");
  if ((evidence.sameMatch.rows ?? -1) < required.minSameMatchRows) blockers.push(`same-match-rows:${evidence.sameMatch.rows ?? "missing"}<${required.minSameMatchRows}`);
  if (!(evidence.sameMatch.brierImprovement > 0)) blockers.push("same-match-brier-not-improved");
  if (!(evidence.sameMatch.logLossImprovement > 0)) blockers.push("same-match-logloss-not-improved");
  if (!(evidence.sameMatch.marginalBrierImprovementVsCalibratedMarket > 0)) blockers.push("model-marginal-brier-not-improved");
  if (!(evidence.sameMatch.marginalLogLossImprovementVsCalibratedMarket > 0)) blockers.push("model-marginal-logloss-not-improved");
  if ((evidence.rolling.windows ?? -1) < required.minIndependentWindows) blockers.push(`independent-windows:${evidence.rolling.windows ?? "missing"}<${required.minIndependentWindows}`);
  if (!(evidence.rolling.passRate >= required.minRollingPassRate)) blockers.push("rolling-pass-rate-insufficient");
  if (!evidence.rolling.sufficientIndependentWindows) blockers.push("independent-windows-unverified");
  if (!evidence.walkForward.eligible || evidence.walkForward.status !== "validated") blockers.push("walk-forward-unvalidated");
  if (!evidence.walkForward.watermarkVerified) blockers.push("walk-forward-watermark-unverified");
  if (!evidence.residualWalkForward.candidateReady) blockers.push("residual-final-candidate-not-ready");
  if (evidence.residualWalkForward.productionEligible !== false) {
    blockers.push("residual-artifact-self-production-eligibility-invalid");
  }
  if (Array.isArray(evidence.residualWalkForward.internalCandidateBlockers)
      && evidence.residualWalkForward.internalCandidateBlockers.length) {
    blockers.push("residual-final-candidate-internal-blockers");
  }
  if ((evidence.residualWalkForward.completeFolds ?? -1) < required.minResidualFolds) blockers.push(`residual-folds:${evidence.residualWalkForward.completeFolds ?? "missing"}<${required.minResidualFolds}`);
  if (!evidence.promotionEvidence.eligible) blockers.push("promotion-evidence-ineligible");
  if ((evidence.promotionEvidence.eligibleRows ?? -1) < required.minPromotionEvidenceRows) blockers.push("promotion-evidence-rows-insufficient");
  if ((evidence.promotionEvidence.conflictingDuplicateKeys || 0) > 0) blockers.push("promotion-evidence-conflict");
  if (!HASH_PATTERN.test(evidence.promotionEvidence.manifestHash || "")) blockers.push("promotion-evidence-manifest-hash-invalid");
  if (!HASH_PATTERN.test(evidence.residualWalkForward.manifestHash || "")
      || artifact.metricsManifestHash !== evidence.residualWalkForward.manifestHash) blockers.push("residual-manifest-mismatch");
  if (!HASH_PATTERN.test(evidence.residualWalkForward.modelHash || "")
      || artifact.modelHash !== evidence.residualWalkForward.modelHash) blockers.push("residual-model-identity-mismatch");
  if (!HASH_PATTERN.test(evidence.residualWalkForward.trainingDataHash || "")
      || artifact.trainingDataHash !== evidence.residualWalkForward.trainingDataHash) blockers.push("residual-training-data-identity-mismatch");
  if (!HASH_PATTERN.test(evidence.residualWalkForward.parametersHash || "")
      || artifact.parametersHash !== evidence.residualWalkForward.parametersHash) blockers.push("residual-parameters-identity-mismatch");
  if (!HASH_PATTERN.test(evidence.residualWalkForward.featureSchemaHash || "")
      || artifact.featureSchemaHash !== evidence.residualWalkForward.featureSchemaHash) blockers.push("residual-feature-schema-identity-mismatch");
  if (!evidence.residualWalkForward.trainedThrough
      || artifact.trainedThrough !== evidence.residualWalkForward.trainedThrough) blockers.push("residual-trained-through-identity-mismatch");
  if (!evidence.inputAuditClean) blockers.push("input-audit-not-promotion-clean");
  if (evidence.riskTier !== "stable") blockers.push(`risk-tier:${evidence.riskTier || "unknown"}!=stable`);
  if (!evidence.productionPolicyReplayEligible) blockers.push("production-policy-replay-ineligible");
  if (!nonempty(contract.inferenceImplementationHash)
      || artifact.inferenceImplementationHash !== contract.inferenceImplementationHash) blockers.push("inference-implementation-mismatch");
  if (!nonempty(contract.featureSchemaVersion)
      || artifact.featureSchemaVersion !== contract.featureSchemaVersion) blockers.push("feature-schema-mismatch");
  if (!nonempty(contract.policyVersion)
      || artifact.policyVersion !== contract.policyVersion) blockers.push("policy-version-mismatch");
  return Array.from(new Set(blockers)).sort();
};

const appendEntry = (registry, entry) => {
  const body = {
    ...entry,
    sequence: registry.entries.length + 1,
    previousEntryHash: registry.headEntryHash || null,
  };
  const nextEntry = { ...body, entryHash: sha256(stableStringify(body)) };
  return finalizeRegistry({
    ...registryBody(registry),
    entries: registry.entries.concat(nextEntry),
    championArtifactHash: nextEntry.nextChampionArtifactHash || null,
    headEntryHash: nextEntry.entryHash,
  });
};

const applyLearningCandidate = ({
  registry,
  candidate,
  evaluation,
  productionContract,
  at,
  actor,
  thresholds,
} = {}) => {
  assertValidRegistry(registry);
  const artifact = candidate?.artifactHash && candidate?.version === "model-candidate-artifact-v1"
    ? canonicalCandidateArtifact(candidate)
    : canonicalCandidateArtifact(candidate || {});
  const evidence = evaluation?.version === "model-learning-evidence-v1"
    ? stableValue(evaluation)
    : buildLearningEvidenceFromEvaluation(evaluation || {}, {
      inferenceImplementationHash: artifact.inferenceImplementationHash,
      featureSchemaVersion: artifact.featureSchemaVersion,
      policyVersion: artifact.policyVersion,
    });
  const eventAt = canonicalIso(at, "at");
  const eventActor = canonicalActor(actor);
  const existingForId = registry.artifacts.find((item) => item.candidateId === artifact.candidateId);
  if (existingForId && existingForId.artifactHash !== artifact.artifactHash) {
    throw new ModelLearningRegistryError(`candidate id conflict: ${artifact.candidateId}`);
  }
  const blockers = promotionBlockers({ artifact, evidence, productionContract, thresholds });
  const status = blockers.length ? "shadow-blocked" : "promoted";
  const evidenceHash = sha256(stableStringify(evidence));
  const eventKey = sha256(stableStringify({
    type: "candidate-evaluation",
    artifactHash: artifact.artifactHash,
    evidenceHash,
    status,
    actor: eventActor,
  }));
  const duplicate = registry.entries.find((entry) => entry.eventKey === eventKey);
  if (duplicate) {
    return {
      registry: clone(registry),
      transition: clone(duplicate),
      idempotent: true,
      decision: { status, blockers, candidateArtifactHash: artifact.artifactHash, evidenceHash },
    };
  }
  const artifacts = existingForId ? registry.artifacts : registry.artifacts.concat(artifact);
  const prepared = finalizeRegistry({ ...registryBody(registry), artifacts });
  const previousChampionArtifactHash = prepared.championArtifactHash || null;
  const nextChampionArtifactHash = status === "promoted"
    ? artifact.artifactHash
    : previousChampionArtifactHash;
  const nextRegistry = appendEntry(prepared, {
    type: "candidate-evaluation",
    at: eventAt,
    actor: eventActor,
    eventKey,
    status,
    candidateArtifactHash: artifact.artifactHash,
    evidenceHash,
    blockers,
    previousChampionArtifactHash,
    nextChampionArtifactHash,
  });
  assertValidRegistry(nextRegistry);
  return {
    registry: nextRegistry,
    transition: clone(nextRegistry.entries[nextRegistry.entries.length - 1]),
    idempotent: false,
    decision: { status, blockers, candidateArtifactHash: artifact.artifactHash, evidenceHash },
  };
};

const rollbackChampion = ({ registry, targetArtifactHash, at, actor, reason } = {}) => {
  assertValidRegistry(registry);
  const target = nonempty(targetArtifactHash);
  const rollbackReason = nonempty(reason);
  if (!target || !registry.artifacts.some((artifact) => artifact.artifactHash === target)) {
    throw new ModelLearningRegistryError("rollback target artifact is not registered");
  }
  const wasChampion = registry.entries.some((entry) => entry.status === "promoted" && entry.nextChampionArtifactHash === target);
  if (!wasChampion) throw new ModelLearningRegistryError("rollback target was never a promoted champion");
  if (!rollbackReason) throw new ModelLearningRegistryError("rollback reason is required");
  const eventActor = canonicalActor(actor);
  const eventAt = canonicalIso(at, "at");
  const eventKey = sha256(stableStringify({ type: "rollback", target, reason: rollbackReason, actor: eventActor }));
  const duplicate = registry.entries.find((entry) => entry.eventKey === eventKey);
  if (duplicate) return { registry: clone(registry), transition: clone(duplicate), idempotent: true };
  const nextRegistry = appendEntry(registry, {
    type: "rollback",
    at: eventAt,
    actor: eventActor,
    eventKey,
    status: "rollback",
    reason: rollbackReason,
    candidateArtifactHash: target,
    evidenceHash: null,
    blockers: [],
    previousChampionArtifactHash: registry.championArtifactHash || null,
    nextChampionArtifactHash: target,
  });
  assertValidRegistry(nextRegistry);
  return {
    registry: nextRegistry,
    transition: clone(nextRegistry.entries[nextRegistry.entries.length - 1]),
    idempotent: false,
  };
};

module.exports = {
  DEFAULT_THRESHOLDS,
  HASH_PATTERN,
  ModelLearningRegistryError,
  REGISTRY_VERSION,
  applyLearningCandidate,
  buildCandidateFromEvaluation,
  buildLearningEvidenceFromEvaluation,
  canonicalCandidateArtifact,
  createLearningRegistry,
  promotionBlockers,
  rollbackChampion,
  sha256,
  stableStringify,
  validateLearningRegistry,
};
