const crypto = require("node:crypto");

const WALK_FORWARD_VALIDATION_VERSION = "walk-forward-promotion-validation-v3";
const WALK_FORWARD_PROTOCOL_VERSION = "nested-expanding-window-candidate-selection-v2";
const PROMOTION_MIN_REQUIRED_FOLDS = 6;
const PROMOTION_MIN_PASS_RATE = 0.6;

const finiteNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const finiteImprovementPair = (comparison) => {
  const logLossImprovement = finiteNumber(comparison?.logLossImprovement);
  const brierImprovement = finiteNumber(comparison?.brierImprovement);
  if (logLossImprovement === null || brierImprovement === null) return null;
  return { logLossImprovement, brierImprovement };
};

const hasNonNegativeImprovementPair = (comparison) => {
  const pair = finiteImprovementPair(comparison);
  return pair !== null
    && pair.logLossImprovement >= 0
    && pair.brierImprovement >= 0;
};

const round = (value, digits = 6) => {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(digits));
};

const timeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const stableHash = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const isSha256 = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));

const rowKey = (row) => String(
  row?.sourceMatchId
  || row?.matchId
  || `${row?.kickoffTime || "missing-kickoff"}:${row?.homeTeamName || ""}:${row?.awayTeamName || ""}`
);

const normalizeTriplet = (value) => {
  if (!value || typeof value !== "object") return null;
  const one = finiteNumber(value["1"] ?? value.home);
  const draw = finiteNumber(value.X ?? value.draw);
  const two = finiteNumber(value["2"] ?? value.away);
  if (![one, draw, two].every((number) => number !== null && number >= 0)) return null;
  const total = one + draw + two;
  if (!(total > 0)) return null;
  return {
    "1": round(one / total, 12),
    X: round(draw / total, 12),
    "2": round(two / total, 12),
  };
};

const summarizeProbabilityRows = (rows) => {
  const scored = (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    probabilities: normalizeTriplet(row?.probabilities),
  })).filter((row) => row.probabilities && ["1", "X", "2"].includes(row.actual));

  if (!scored.length) {
    return { rows: 0, brier: null, logLoss: null, accuracy: null };
  }

  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  for (const row of scored) {
    const predicted = Object.entries(row.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (predicted === row.actual) correct += 1;
    for (const code of ["1", "X", "2"]) {
      brier += (row.probabilities[code] - (code === row.actual ? 1 : 0)) ** 2;
    }
    logLoss += -Math.log(Math.max(0.000001, Math.min(0.999999, row.probabilities[row.actual])));
  }

  return {
    rows: scored.length,
    brier: round(brier / scored.length),
    logLoss: round(logLoss / scored.length),
    accuracy: round(correct / scored.length),
  };
};

const compareMetrics = (candidate, market) => ({
  rows: Math.min(Number(candidate?.rows || 0), Number(market?.rows || 0)),
  brierImprovement: candidate?.brier === null || market?.brier === null
    ? null
    : round(market.brier - candidate.brier),
  logLossImprovement: candidate?.logLoss === null || market?.logLoss === null
    ? null
    : round(market.logLoss - candidate.logLoss),
  accuracyDelta: candidate?.accuracy === null || market?.accuracy === null
    ? null
    : round(candidate.accuracy - market.accuracy),
});

const candidateUsesModelSignal = (candidate) => {
  const weights = candidate?.weights || {};
  const features = Array.isArray(candidate?.featureSet) ? candidate.featureSet : [];
  const modelWeight = Number(weights.model);
  return (Number.isFinite(modelWeight) && modelWeight !== 0)
    || Number(weights.historical || 0) > 0
    || Number(weights.elo || 0) > 0
    || Number(weights.poisson || 0) > 0
    || features.some((feature) => /model|historical|elo|poisson/i.test(String(feature)));
};

const candidateRows = (candidate) => {
  if (Array.isArray(candidate?._rows)) return candidate._rows;
  if (Array.isArray(candidate?.rowsForValidation)) return candidate.rowsForValidation;
  return [];
};

const baseRowProjection = (row) => ({
  key: rowKey(row),
  forecastTime: new Date(timeMs(row?.forecastTime || row?.kickoffTime)).toISOString(),
  kickoffTime: timeMs(row?.kickoffTime) === null ? null : new Date(timeMs(row.kickoffTime)).toISOString(),
  resultObservedAt: new Date(timeMs(row?.resultObservedAt)).toISOString(),
  actual: row.actual,
  marketProbabilities: normalizeTriplet(row.marketProbabilities),
});

const canonicalizeBaseRows = (rows) => {
  const accepted = (Array.isArray(rows) ? rows : []).filter((row) => (
    normalizeTriplet(row?.marketProbabilities)
    && ["1", "X", "2"].includes(row?.actual)
    && timeMs(row?.forecastTime || row?.kickoffTime) !== null
    && timeMs(row?.resultObservedAt) !== null
    && timeMs(row?.resultObservedAt) > timeMs(row?.forecastTime || row?.kickoffTime)
    && (timeMs(row?.kickoffTime) === null || timeMs(row?.resultObservedAt) >= timeMs(row?.kickoffTime))
  ));
  const byKey = new Map();
  const conflicts = [];
  let duplicateRows = 0;
  for (const row of accepted) {
    const key = rowKey(row);
    const projection = baseRowProjection(row);
    const fingerprint = stableHash(projection);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { row, projection, fingerprint });
    } else if (previous.fingerprint === fingerprint) {
      duplicateRows += 1;
    } else {
      conflicts.push({ keyHash: stableHash(key), first: previous.fingerprint, conflicting: fingerprint });
    }
  }
  const entries = [...byKey.values()].sort((a, b) => (
    timeMs(a.projection.forecastTime) - timeMs(b.projection.forecastTime)
    || a.projection.key.localeCompare(b.projection.key)
  ));
  const canonicalRows = entries.map((entry) => entry.row);
  const projections = entries.map((entry) => entry.projection);
  const rowKeyHashes = projections.map((row) => stableHash(row.key));
  const rowCommitmentHashes = projections.map((row) => stableHash(row));
  return {
    rows: canonicalRows,
    index: new Map(projections.map((projection, index) => [projection.key, {
      row: canonicalRows[index],
      projection,
    }])),
    inputRows: Array.isArray(rows) ? rows.length : 0,
    acceptedRows: accepted.length,
    duplicateRows,
    rejectedRows: (Array.isArray(rows) ? rows.length : 0) - accepted.length,
    conflicts,
    manifest: {
      rows: projections.length,
      rowKeyHashes,
      rowCommitmentHashes,
      hash: stableHash({ rowKeyHashes, rowCommitmentHashes }),
    },
  };
};

const candidateSpec = (candidate) => ({
  id: String(candidate?.id || ""),
  role: candidate?.role || null,
  weights: candidate?.weights || null,
  featureSet: Array.isArray(candidate?.featureSet) ? candidate.featureSet : [],
});

const candidateBindingConflicts = (row, baseProjection) => {
  const conflicts = [];
  if (row?.actual !== undefined && row.actual !== baseProjection.actual) conflicts.push("actual");
  if (row?.forecastTime !== undefined || row?.kickoffTime !== undefined) {
    const candidateForecast = timeMs(row?.forecastTime || row?.kickoffTime);
    if (candidateForecast !== timeMs(baseProjection.forecastTime)) conflicts.push("forecastTime");
  }
  if (row?.resultObservedAt !== undefined
      && timeMs(row.resultObservedAt) !== timeMs(baseProjection.resultObservedAt)) {
    conflicts.push("resultObservedAt");
  }
  if (row?.marketProbabilities !== undefined
      && stableHash(normalizeTriplet(row.marketProbabilities)) !== stableHash(baseProjection.marketProbabilities)) {
    conflicts.push("marketProbabilities");
  }
  return conflicts;
};

const buildCandidateDescriptor = (candidate, baseIndex) => {
  const spec = candidateSpec(candidate);
  const index = new Map();
  const conflicts = [];
  let duplicateRows = 0;
  let rejectedRows = 0;
  let outsideRows = 0;
  for (const row of candidateRows(candidate)) {
    const key = rowKey(row);
    const base = baseIndex.get(key);
    const probabilities = normalizeTriplet(row?.probabilities);
    if (!base) {
      outsideRows += 1;
      continue;
    }
    if (!probabilities) {
      rejectedRows += 1;
      continue;
    }
    const bindingConflicts = candidateBindingConflicts(row, base.projection);
    if (bindingConflicts.length) {
      conflicts.push({ keyHash: stableHash(key), fields: bindingConflicts });
      continue;
    }
    const projection = { key, probabilities };
    const fingerprint = stableHash(projection);
    const previous = index.get(key);
    if (!previous) {
      index.set(key, { projection, fingerprint });
    } else if (previous.fingerprint === fingerprint) {
      duplicateRows += 1;
    } else {
      conflicts.push({ keyHash: stableHash(key), fields: ["probabilities"] });
    }
  }
  const predictionRows = [...index.values()]
    .map((entry) => entry.projection)
    .sort((a, b) => a.key.localeCompare(b.key));
  const manifest = {
    ...spec,
    specHash: stableHash(spec),
    predictionRows: predictionRows.length,
    predictionDataHash: stableHash(predictionRows),
    duplicateRows,
    rejectedRows,
    outsideRows,
    conflicts: conflicts.length,
  };
  return {
    candidate,
    index: new Map([...index.entries()].map(([key, entry]) => [key, entry.projection])),
    manifest,
    conflicts,
  };
};

const pairedMetricsForKeys = (candidateIndex, baseIndex, keys) => {
  const modelRows = [];
  const marketRows = [];
  const coveredKeys = [];
  for (const key of keys) {
    const candidate = candidateIndex.get(key);
    const base = baseIndex.get(key);
    if (!candidate || !base) continue;
    coveredKeys.push(key);
    modelRows.push({
      ...base.projection,
      probabilities: candidate.probabilities,
    });
    marketRows.push({
      ...base.projection,
      probabilities: base.projection.marketProbabilities,
    });
  }
  const model = summarizeProbabilityRows(modelRows);
  const market = summarizeProbabilityRows(marketRows);
  return {
    model,
    market,
    comparison: compareMetrics(model, market),
    coveredKeys,
  };
};

const selectTrainingCandidate = (descriptors, baseIndex, trainingKeys) => {
  const ranked = [];
  for (const descriptor of descriptors) {
    const paired = pairedMetricsForKeys(descriptor.index, baseIndex, trainingKeys);
    if (paired.coveredKeys.length !== trainingKeys.length
        || paired.model.rows !== trainingKeys.length
        || paired.market.rows !== trainingKeys.length) continue;
    ranked.push({
      descriptor,
      ...paired,
      balanced: hasNonNegativeImprovementPair(paired.comparison),
    });
  }

  ranked.sort((a, b) => {
    if (a.balanced !== b.balanced) return a.balanced ? -1 : 1;
    if (a.model.logLoss !== b.model.logLoss) return a.model.logLoss - b.model.logLoss;
    return a.model.brier - b.model.brier;
  });
  return ranked[0] || null;
};

const keyHashesFor = (keys) => keys.map((key) => stableHash(key));

const rowCommitmentsFor = (keys, baseIndex, candidateIndex) => keys.map((key) => stableHash({
  row: baseIndex.get(key)?.projection || null,
  candidateProbabilities: candidateIndex.get(key)?.probabilities || null,
}));

const foldHashProjection = (fold) => ({
  index: fold.index,
  selectedCandidateId: fold.selectedCandidateId,
  selectedCandidateSpecHash: fold.selectedCandidateSpecHash,
  selectedCandidatePredictionDataHash: fold.selectedCandidatePredictionDataHash,
  offsetStart: fold.offsetStart,
  offsetEndExclusive: fold.offsetEndExclusive,
  training: fold.training,
  evaluation: fold.evaluation,
  watermark: fold.watermark,
  keySeparationVerified: fold.keySeparationVerified,
  metricsHash: fold.metricsHash,
  passed: fold.passed,
});

const foldManifestProjection = ({ thresholds, featureModelHash, inputDataset, folds }) => ({
  protocolVersion: WALK_FORWARD_PROTOCOL_VERSION,
  thresholds,
  featureModelHash,
  inputDatasetHash: inputDataset.hash,
  folds: folds.map((fold) => ({
    index: fold.index,
    offsetStart: fold.offsetStart,
    offsetEndExclusive: fold.offsetEndExclusive,
    selectedCandidateId: fold.selectedCandidateId,
    foldHash: fold.foldHash,
    passed: fold.passed,
  })),
});

const uniqueStrings = (values) => Array.from(new Set((Array.isArray(values) ? values : []).map(String)));

const deepValidateWalkForwardArtifact = (validation) => {
  const errors = [];
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) {
    return { eligible: false, errors: ["artifact-missing"], watermarkVerified: false };
  }
  if (validation.version !== WALK_FORWARD_VALIDATION_VERSION) errors.push("version-unsupported");
  if (validation.protocolVersion !== WALK_FORWARD_PROTOCOL_VERSION) errors.push("protocol-unsupported");

  const thresholds = validation.thresholds || {};
  const minimumTrainingRows = Number(thresholds.minimumTrainingRows);
  const evaluationWindowRows = Number(thresholds.evaluationWindowRows);
  const requiredFolds = Number(thresholds.requiredFolds);
  const minimumPassRate = Number(thresholds.minimumPassRate);
  if (!Number.isSafeInteger(minimumTrainingRows) || minimumTrainingRows < 1) errors.push("minimum-training-rows-invalid");
  if (!Number.isSafeInteger(evaluationWindowRows) || evaluationWindowRows < 1) errors.push("evaluation-window-rows-invalid");
  if (!Number.isSafeInteger(requiredFolds) || requiredFolds < PROMOTION_MIN_REQUIRED_FOLDS) errors.push("required-folds-below-policy");
  if (!Number.isFinite(minimumPassRate)
      || minimumPassRate < PROMOTION_MIN_PASS_RATE
      || minimumPassRate > 1) errors.push("minimum-pass-rate-below-policy");

  const inputDataset = validation.inputDataset || {};
  const inputKeyHashes = Array.isArray(inputDataset.rowKeyHashes) ? inputDataset.rowKeyHashes.map(String) : [];
  const inputCommitments = Array.isArray(inputDataset.rowCommitmentHashes)
    ? inputDataset.rowCommitmentHashes.map(String)
    : [];
  if (inputKeyHashes.some((hash) => !isSha256(hash))
      || inputCommitments.some((hash) => !isSha256(hash))) errors.push("input-dataset-hash-invalid");
  if (new Set(inputKeyHashes).size !== inputKeyHashes.length) errors.push("input-dataset-keys-duplicated");
  if (inputKeyHashes.length !== Number(inputDataset.rows)
      || inputCommitments.length !== Number(inputDataset.rows)) errors.push("input-dataset-count-mismatch");
  if (stableHash({ rowKeyHashes: inputKeyHashes, rowCommitmentHashes: inputCommitments }) !== inputDataset.hash) {
    errors.push("input-dataset-manifest-mismatch");
  }

  const candidateManifest = Array.isArray(validation.candidateManifest) ? validation.candidateManifest : [];
  const candidateIds = candidateManifest.map((candidate) => String(candidate?.id || ""));
  if (!candidateManifest.length || candidateIds.some((id) => !id)) errors.push("candidate-manifest-missing");
  if (new Set(candidateIds).size !== candidateIds.length) errors.push("candidate-manifest-ids-duplicated");
  for (const candidate of candidateManifest) {
    const spec = candidateSpec(candidate);
    if (stableHash(spec) !== candidate.specHash) errors.push(`candidate-spec-hash-mismatch:${candidate.id}`);
    if (!Number.isSafeInteger(Number(candidate.predictionRows))
        || Number(candidate.predictionRows) < 1
        || !isSha256(candidate.predictionDataHash)) {
      errors.push(`candidate-prediction-hash-invalid:${candidate.id}`);
    }
    if (Number(candidate.conflicts || 0) !== 0) errors.push(`candidate-conflicts:${candidate.id}`);
  }
  const normalizedCandidateManifest = candidateManifest.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (stableHash(normalizedCandidateManifest) !== validation.featureModelHash) errors.push("feature-model-hash-mismatch");

  const folds = Array.isArray(validation.folds) ? validation.folds : [];
  const allEvaluationKeys = new Set();
  let priorOffsetEnd = null;
  let passedFolds = 0;
  let allWatermarksVerified = folds.length > 0;
  for (let position = 0; position < folds.length; position += 1) {
    const fold = folds[position] || {};
    if (fold.index !== position + 1) errors.push(`fold-index-invalid:${position + 1}`);
    if (!Number.isSafeInteger(fold.offsetStart)
        || !Number.isSafeInteger(fold.offsetEndExclusive)
        || fold.offsetStart < minimumTrainingRows
        || fold.offsetEndExclusive - fold.offsetStart !== evaluationWindowRows) {
      errors.push(`fold-offset-invalid:${position + 1}`);
    }
    if (priorOffsetEnd !== null && fold.offsetStart !== priorOffsetEnd) {
      errors.push(`fold-window-gap:${position + 1}`);
    }
    priorOffsetEnd = fold.offsetEndExclusive;

    const trainingKeys = Array.isArray(fold.training?.keyHashes) ? fold.training.keyHashes.map(String) : [];
    const evaluationKeys = Array.isArray(fold.evaluation?.keyHashes) ? fold.evaluation.keyHashes.map(String) : [];
    const trainingCommitments = Array.isArray(fold.training?.rowCommitmentHashes)
      ? fold.training.rowCommitmentHashes.map(String)
      : [];
    const evaluationCommitments = Array.isArray(fold.evaluation?.rowCommitmentHashes)
      ? fold.evaluation.rowCommitmentHashes.map(String)
      : [];
    if (trainingKeys.some((hash) => !isSha256(hash)) || evaluationKeys.some((hash) => !isSha256(hash))) {
      errors.push(`fold-key-hash-invalid:${position + 1}`);
    }
    if (new Set(trainingKeys).size !== trainingKeys.length
        || new Set(evaluationKeys).size !== evaluationKeys.length) {
      errors.push(`fold-keys-duplicated:${position + 1}`);
    }
    if (trainingKeys.length !== Number(fold.training?.rows)
        || trainingCommitments.length !== Number(fold.training?.rows)
        || evaluationKeys.length !== evaluationWindowRows
        || evaluationCommitments.length !== evaluationWindowRows) {
      errors.push(`fold-row-count-mismatch:${position + 1}`);
    }
    if (Number(fold.training?.rows) < minimumTrainingRows
        || Number(fold.training?.model?.rows) !== Number(fold.training?.rows)
        || Number(fold.training?.market?.rows) !== Number(fold.training?.rows)
        || Number(fold.training?.comparison?.rows) !== Number(fold.training?.rows)
        || Number(fold.evaluation?.model?.rows) !== evaluationWindowRows
        || Number(fold.evaluation?.market?.rows) !== evaluationWindowRows
        || Number(fold.evaluation?.comparison?.rows) !== evaluationWindowRows) {
      errors.push(`fold-metric-row-count-mismatch:${position + 1}`);
    }
    const trainingSet = new Set(trainingKeys);
    if (evaluationKeys.some((key) => trainingSet.has(key))) errors.push(`fold-training-evaluation-overlap:${position + 1}`);
    if (evaluationKeys.some((key) => allEvaluationKeys.has(key))) errors.push(`fold-evaluation-overlap:${position + 1}`);
    evaluationKeys.forEach((key) => allEvaluationKeys.add(key));
    if (fold.keySeparationVerified !== true) errors.push(`fold-key-separation-unverified:${position + 1}`);
    if (stableHash(trainingKeys) !== fold.training?.keySetHash
        || stableHash(trainingCommitments) !== fold.training?.dataHash
        || stableHash(evaluationKeys) !== fold.evaluation?.keySetHash
        || stableHash(evaluationCommitments) !== fold.evaluation?.dataHash) {
      errors.push(`fold-data-hash-mismatch:${position + 1}`);
    }

    const trainingObservedAt = timeMs(fold.watermark?.trainingDataMaxObservedAt);
    const evaluationStartedAt = timeMs(fold.watermark?.evaluationWindowStartedAt);
    const watermarkVerified = trainingObservedAt !== null
      && evaluationStartedAt !== null
      && trainingObservedAt < evaluationStartedAt
      && fold.watermark?.noOverlapVerified === true;
    if (!watermarkVerified) errors.push(`fold-watermark-unverified:${position + 1}`);
    allWatermarksVerified = allWatermarksVerified && watermarkVerified;

    const trainingImprovementPair = finiteImprovementPair(fold.training?.comparison);
    const evaluationImprovementPair = finiteImprovementPair(fold.evaluation?.comparison);
    if (!trainingImprovementPair || !evaluationImprovementPair) {
      errors.push(`fold-improvement-metrics-invalid:${position + 1}`);
    }
    const recomputedBalancedCandidate = hasNonNegativeImprovementPair(fold.training?.comparison);
    if (fold.training?.balancedCandidate !== recomputedBalancedCandidate) {
      errors.push(`fold-balanced-candidate-mismatch:${position + 1}`);
    }
    const recomputedPassed = recomputedBalancedCandidate
      && watermarkVerified
      && fold.keySeparationVerified === true
      && hasNonNegativeImprovementPair(fold.evaluation?.comparison);
    if (fold.passed !== recomputedPassed) errors.push(`fold-pass-mismatch:${position + 1}`);
    if (fold.passed) passedFolds += 1;
    const metricsHash = stableHash({
      training: {
        model: fold.training?.model,
        market: fold.training?.market,
        comparison: fold.training?.comparison,
        balancedCandidate: fold.training?.balancedCandidate,
      },
      evaluation: {
        model: fold.evaluation?.model,
        market: fold.evaluation?.market,
        comparison: fold.evaluation?.comparison,
      },
      passed: fold.passed,
    });
    if (metricsHash !== fold.metricsHash) errors.push(`fold-metrics-hash-mismatch:${position + 1}`);
    if (stableHash(foldHashProjection(fold)) !== fold.foldHash) errors.push(`fold-hash-mismatch:${position + 1}`);
    const candidate = candidateManifest.find((entry) => entry.id === fold.selectedCandidateId);
    if (!candidate
        || candidate.specHash !== fold.selectedCandidateSpecHash
        || candidate.predictionDataHash !== fold.selectedCandidatePredictionDataHash) {
      errors.push(`fold-candidate-binding-mismatch:${position + 1}`);
    }
  }

  const passRate = folds.length ? round(passedFolds / folds.length) : null;
  if (Number(validation.sample?.sourceRows) !== Number(inputDataset.rows)
      || Number(validation.sample?.candidateCount) !== candidateManifest.length
      || Number(validation.sample?.folds) !== folds.length
      || Number(validation.sample?.evaluationRows) !== folds.length * evaluationWindowRows
      || Number(validation.sample?.passedFolds) !== passedFolds
      || validation.sample?.passRate !== passRate) {
    errors.push("sample-summary-mismatch");
  }
  const expectedManifestHash = stableHash(foldManifestProjection({
    thresholds,
    featureModelHash: validation.featureModelHash,
    inputDataset,
    folds,
  }));
  if (expectedManifestHash !== validation.foldManifestHash) errors.push("fold-manifest-hash-mismatch");
  if (validation.continuity?.verified !== true
      || Number(validation.continuity?.coverageGapWindows || 0) !== 0) errors.push("evaluation-window-continuity-unverified");
  if (Number(validation.integrity?.baseRowConflicts || 0) !== 0
      || Number(validation.integrity?.candidateRowConflicts || 0) !== 0) errors.push("row-conflicts-present");
  const firstFold = folds[0] || null;
  if (folds.length) {
    if (validation.watermark?.trainingDataMaxObservedAt !== firstFold.watermark?.trainingDataMaxObservedAt
        || validation.watermark?.evaluationWindowStartedAt !== firstFold.watermark?.evaluationWindowStartedAt
        || validation.watermark?.noOverlapVerified !== allWatermarksVerified
        || validation.watermark?.perFoldVerified !== allWatermarksVerified) {
      errors.push("top-level-watermark-mismatch");
    }
  } else if (validation.watermark?.trainingDataMaxObservedAt !== null
      || validation.watermark?.evaluationWindowStartedAt !== null
      || validation.watermark?.noOverlapVerified !== false
      || validation.watermark?.perFoldVerified !== false) {
    errors.push("top-level-watermark-mismatch");
  }

  const enoughFolds = folds.length >= requiredFolds;
  const passRateReady = passRate !== null && passRate >= minimumPassRate;
  const claimedBlockers = uniqueStrings(validation.blockers);
  const structurallyEligible = errors.length === 0
    && enoughFolds
    && passRateReady
    && allWatermarksVerified
    && claimedBlockers.length === 0;
  if (validation.eligible !== structurallyEligible) errors.push("eligible-claim-mismatch");
  const expectedStatus = structurallyEligible
    ? "validated"
    : (folds.length && !errors.some((error) => /conflict|continuity|window-gap/.test(error)) ? "collecting" : "blocked");
  if (validation.status !== expectedStatus) errors.push("status-claim-mismatch");

  return {
    eligible: structurallyEligible && errors.length === 0,
    errors: uniqueStrings(errors),
    watermarkVerified: allWatermarksVerified,
    folds: folds.length,
    passedFolds,
    passRate,
  };
};

const walkForwardPromotionState = (evaluation) => {
  const validation = evaluation?.walkForwardValidation || null;
  const protocolVersion = String(validation?.protocolVersion || "").trim();
  const watermark = validation?.watermark || null;
  const trainingDataMaxObservedAt = timeMs(watermark?.trainingDataMaxObservedAt);
  const evaluationWindowStartedAt = timeMs(watermark?.evaluationWindowStartedAt);
  const hasWatermark = trainingDataMaxObservedAt !== null && evaluationWindowStartedAt !== null;
  const topLevelWatermarkVerified = hasWatermark
    && watermark?.noOverlapVerified === true
    && trainingDataMaxObservedAt < evaluationWindowStartedAt;
  const audit = deepValidateWalkForwardArtifact(validation);
  const blockers = [];
  if (!protocolVersion) blockers.push("walk-forward-protocol-missing");
  if (!hasWatermark) blockers.push("walk-forward-watermark-missing");
  else if (!topLevelWatermarkVerified || !audit.watermarkVerified) blockers.push("walk-forward-watermark-unverified");
  if (!audit.eligible) blockers.push("walk-forward-validation-unvalidated");
  return {
    validation,
    protocolVersion: protocolVersion || null,
    watermarkVerified: topLevelWatermarkVerified && audit.watermarkVerified,
    eligible: audit.eligible,
    blockers,
    audit,
  };
};

const buildWalkForwardValidation = ({
  rows,
  candidates,
  minimumTrainingRows = 80,
  evaluationWindowRows = 40,
  requiredFolds = PROMOTION_MIN_REQUIRED_FOLDS,
  minimumPassRate = PROMOTION_MIN_PASS_RATE,
} = {}) => {
  const thresholds = {
    minimumTrainingRows,
    evaluationWindowRows,
    requiredFolds,
    minimumPassRate,
  };
  const canonical = canonicalizeBaseRows(rows);
  const baseRows = canonical.rows;
  const modelCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.id && candidate.id !== "market-baseline" && candidateUsesModelSignal(candidate));
  const descriptors = modelCandidates.map((candidate) => buildCandidateDescriptor(candidate, canonical.index));
  const candidateManifest = descriptors.map((descriptor) => descriptor.manifest)
    .sort((a, b) => a.id.localeCompare(b.id));
  const featureModelHash = stableHash(candidateManifest);
  const candidateRowConflicts = descriptors.reduce((sum, descriptor) => sum + descriptor.conflicts.length, 0);
  const folds = [];
  const boundaryAudit = [];
  let coverageGapWindows = 0;

  let evaluationStart = minimumTrainingRows;
  while (evaluationStart + evaluationWindowRows <= baseRows.length) {
    const evaluationRows = baseRows.slice(evaluationStart, evaluationStart + evaluationWindowRows);
    const evaluationStartedMs = Math.min(...evaluationRows.map((row) => timeMs(row.forecastTime || row.kickoffTime)));
    const priorRows = baseRows.slice(0, evaluationStart);
    const trainingRows = priorRows.filter((row) => timeMs(row.resultObservedAt) < evaluationStartedMs);
    const boundary = {
      offset: evaluationStart,
      evaluationStartedAt: new Date(evaluationStartedMs).toISOString(),
      nominalTrainingRows: priorRows.length,
      observedTrainingRows: trainingRows.length,
      evaluationRows: evaluationRows.length,
      reason: null,
    };
    if (trainingRows.length < minimumTrainingRows && folds.length === 0) {
      boundary.reason = "insufficient-observed-training";
      boundaryAudit.push(boundary);
      evaluationStart += 1;
      continue;
    }
    if (trainingRows.length < minimumTrainingRows) {
      boundary.reason = "continuous-window-training-watermark-gap";
      boundaryAudit.push(boundary);
      coverageGapWindows += 1;
      break;
    }

    const trainingKeys = trainingRows.map(rowKey);
    const evaluationKeys = evaluationRows.map(rowKey);
    const selected = selectTrainingCandidate(descriptors, canonical.index, trainingKeys);
    if (!selected) {
      boundary.reason = "continuous-window-training-coverage-incomplete";
      boundary.bestCandidateCoverage = descriptors.map((descriptor) => ({
        id: descriptor.candidate.id,
        rows: pairedMetricsForKeys(descriptor.index, canonical.index, trainingKeys).coveredKeys.length,
      })).sort((a, b) => b.rows - a.rows)[0] || null;
      boundaryAudit.push(boundary);
      coverageGapWindows += 1;
      break;
    }

    const evaluationPaired = pairedMetricsForKeys(
      selected.descriptor.index,
      canonical.index,
      evaluationKeys,
    );
    if (evaluationPaired.coveredKeys.length !== evaluationWindowRows
        || evaluationPaired.model.rows !== evaluationWindowRows
        || evaluationPaired.market.rows !== evaluationWindowRows) {
      boundary.reason = "continuous-window-evaluation-coverage-incomplete";
      boundary.selectedCandidateId = selected.descriptor.candidate.id;
      boundary.evaluationModelRows = evaluationPaired.model.rows;
      boundary.evaluationMarketRows = evaluationPaired.market.rows;
      boundaryAudit.push(boundary);
      coverageGapWindows += 1;
      break;
    }

    const trainingKeyHashes = keyHashesFor(trainingKeys);
    const evaluationKeyHashes = keyHashesFor(evaluationKeys);
    const trainingSet = new Set(trainingKeyHashes);
    const keySeparationVerified = new Set(trainingKeyHashes).size === trainingKeyHashes.length
      && new Set(evaluationKeyHashes).size === evaluationKeyHashes.length
      && !evaluationKeyHashes.some((key) => trainingSet.has(key));
    const trainingWatermarkMs = Math.max(...trainingRows.map((row) => timeMs(row.resultObservedAt)));
    const evaluationEndedMs = Math.max(...evaluationRows.map((row) => timeMs(row.forecastTime || row.kickoffTime)));
    const watermarkVerified = Number.isFinite(trainingWatermarkMs)
      && trainingWatermarkMs < evaluationStartedMs;
    const passed = selected.balanced
      && watermarkVerified
      && keySeparationVerified
      && hasNonNegativeImprovementPair(evaluationPaired.comparison);
    const trainingCommitments = rowCommitmentsFor(
      trainingKeys,
      canonical.index,
      selected.descriptor.index,
    );
    const evaluationCommitments = rowCommitmentsFor(
      evaluationKeys,
      canonical.index,
      selected.descriptor.index,
    );
    const fold = {
      index: folds.length + 1,
      selectedCandidateId: selected.descriptor.candidate.id,
      selectedCandidateSpecHash: selected.descriptor.manifest.specHash,
      selectedCandidatePredictionDataHash: selected.descriptor.manifest.predictionDataHash,
      offsetStart: evaluationStart,
      offsetEndExclusive: evaluationStart + evaluationWindowRows,
      training: {
        rows: trainingRows.length,
        firstForecastAt: trainingRows[0]?.forecastTime || trainingRows[0]?.kickoffTime || null,
        lastResultObservedAt: new Date(trainingWatermarkMs).toISOString(),
        keyHashes: trainingKeyHashes,
        rowCommitmentHashes: trainingCommitments,
        keySetHash: stableHash(trainingKeyHashes),
        dataHash: stableHash(trainingCommitments),
        balancedCandidate: selected.balanced,
        model: selected.model,
        market: selected.market,
        comparison: selected.comparison,
      },
      evaluation: {
        rows: evaluationWindowRows,
        startedAt: new Date(evaluationStartedMs).toISOString(),
        endedAt: new Date(evaluationEndedMs).toISOString(),
        keyHashes: evaluationKeyHashes,
        rowCommitmentHashes: evaluationCommitments,
        keySetHash: stableHash(evaluationKeyHashes),
        dataHash: stableHash(evaluationCommitments),
        model: evaluationPaired.model,
        market: evaluationPaired.market,
        comparison: evaluationPaired.comparison,
      },
      watermark: {
        trainingDataMaxObservedAt: new Date(trainingWatermarkMs).toISOString(),
        evaluationWindowStartedAt: new Date(evaluationStartedMs).toISOString(),
        noOverlapVerified: watermarkVerified,
      },
      keySeparationVerified,
      passed,
    };
    fold.metricsHash = stableHash({
      training: {
        model: fold.training.model,
        market: fold.training.market,
        comparison: fold.training.comparison,
        balancedCandidate: fold.training.balancedCandidate,
      },
      evaluation: {
        model: fold.evaluation.model,
        market: fold.evaluation.market,
        comparison: fold.evaluation.comparison,
      },
      passed: fold.passed,
    });
    fold.foldHash = stableHash(foldHashProjection(fold));
    folds.push(fold);
    boundary.reason = "fold-created";
    boundary.selectedCandidateId = selected.descriptor.candidate.id;
    boundaryAudit.push(boundary);
    evaluationStart += evaluationWindowRows;
  }

  const passedFolds = folds.filter((fold) => fold.passed).length;
  const passRate = folds.length ? round(passedFolds / folds.length) : null;
  const allWatermarksVerified = folds.length > 0
    && folds.every((fold) => fold.watermark.noOverlapVerified === true);
  const allKeySeparationVerified = folds.length > 0
    && folds.every((fold) => fold.keySeparationVerified === true);
  const firstFold = folds[0] || null;
  const enoughFolds = folds.length >= requiredFolds;
  const passRateReady = passRate !== null && passRate >= minimumPassRate;
  const blockers = [];
  if (!modelCandidates.length) blockers.push("walk-forward-model-candidates-missing");
  if (canonical.conflicts.length) blockers.push(`walk-forward-row-conflicts:${canonical.conflicts.length}`);
  if (candidateRowConflicts) blockers.push(`walk-forward-candidate-row-conflicts:${candidateRowConflicts}`);
  if (coverageGapWindows) blockers.push(`walk-forward-continuous-window-coverage-gaps:${coverageGapWindows}`);
  if (!folds.length) blockers.push("walk-forward-folds-missing");
  if (!enoughFolds) blockers.push(`walk-forward-folds:${folds.length}<${requiredFolds}`);
  if (!passRateReady) blockers.push(`walk-forward-pass-rate:${passRate ?? "missing"}<${minimumPassRate}`);
  if (!allWatermarksVerified) blockers.push("walk-forward-watermark-unverified");
  if (!allKeySeparationVerified) blockers.push("walk-forward-key-separation-unverified");
  const eligible = enoughFolds
    && passRateReady
    && allWatermarksVerified
    && allKeySeparationVerified
    && blockers.length === 0;
  const continuity = {
    verified: coverageGapWindows === 0,
    coverageGapWindows,
    policy: "After the first eligible boundary, every evaluation block is contiguous; missing candidate coverage blocks promotion instead of skipping a window.",
  };
  const integrity = {
    inputRows: canonical.inputRows,
    acceptedRows: canonical.acceptedRows,
    canonicalRows: canonical.rows.length,
    duplicateRowsRemoved: canonical.duplicateRows,
    rejectedRows: canonical.rejectedRows,
    baseRowConflicts: canonical.conflicts.length,
    candidateRowConflicts,
  };
  const sample = {
    sourceRows: baseRows.length,
    inputRows: canonical.inputRows,
    duplicateRowsRemoved: canonical.duplicateRows,
    candidateCount: modelCandidates.length,
    folds: folds.length,
    evaluationRows: folds.length * evaluationWindowRows,
    passedFolds,
    passRate,
  };
  const artifact = {
    version: WALK_FORWARD_VALIDATION_VERSION,
    status: eligible ? "validated" : (folds.length && !coverageGapWindows && !canonical.conflicts.length && !candidateRowConflicts
      ? "collecting"
      : "blocked"),
    eligible,
    protocolVersion: WALK_FORWARD_PROTOCOL_VERSION,
    featureModelHash,
    inputDataset: canonical.manifest,
    candidateManifest,
    thresholds,
    sample,
    integrity,
    continuity,
    boundaryAudit: {
      considered: boundaryAudit.length,
      outcomes: boundaryAudit.reduce((summary, boundary) => {
        summary[boundary.reason] = Number(summary[boundary.reason] || 0) + 1;
        return summary;
      }, {}),
      truncated: boundaryAudit.length > 6,
      samples: boundaryAudit.length > 6
        ? [...boundaryAudit.slice(0, 3), ...boundaryAudit.slice(-3)]
        : boundaryAudit,
    },
    watermark: {
      trainingDataMaxObservedAt: firstFold?.watermark?.trainingDataMaxObservedAt || null,
      evaluationWindowStartedAt: firstFold?.watermark?.evaluationWindowStartedAt || null,
      noOverlapVerified: allWatermarksVerified,
      perFoldVerified: allWatermarksVerified,
    },
    folds,
    blockers,
    policy: "Each fold selects a frozen model-signal candidate only from unique outcomes observed before that fold, then scores every untouched contiguous chronological block against the canonical same-match devigged market. Candidate coverage gaps and conflicting duplicate rows fail closed.",
  };
  artifact.foldManifestHash = stableHash(foldManifestProjection({
    thresholds,
    featureModelHash,
    inputDataset: artifact.inputDataset,
    folds,
  }));
  return artifact;
};

// Additional diagnostic evidence only. Keep the v3 row-based promotion artifact
// and its verifier unchanged; a day-grouped review cannot activate a model.
const buildMatchDayWalkForwardResearch = ({
  rows = [], candidates = [], minimumTrainingRows = 80,
  minimumEvaluationRows = 40, requiredFolds = PROMOTION_MIN_REQUIRED_FOLDS,
  minimumPassRate = PROMOTION_MIN_PASS_RATE,
} = {}) => {
  if (![minimumTrainingRows, minimumEvaluationRows, requiredFolds].every(n => Number.isSafeInteger(n) && n > 0)
      || !Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1) {
    throw new TypeError("Valid match-day research thresholds required");
  }
  const validDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const input = Array.isArray(rows) ? rows : [];
  const exclusions = { missingBusinessDate: 0, invalidBusinessDate: 0, conflictingBusinessDates: 0 };
  const dated = [], datesByKey = new Map();
  for (const row of input) {
    if (row?.businessDate === null || row?.businessDate === undefined || row.businessDate === "") {
      exclusions.missingBusinessDate++; continue;
    }
    if (!validDay(row.businessDate)) { exclusions.invalidBusinessDate++; continue; }
    const key = rowKey(row), dates = datesByKey.get(key) || new Set();
    dates.add(row.businessDate); datesByKey.set(key, dates); dated.push(row);
  }
  exclusions.conflictingBusinessDates = [...datesByKey.values()].filter(dates => dates.size > 1).length;
  const canonical = canonicalizeBaseRows(dated);
  const descriptors = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate?.id && candidate.id !== "market-baseline" && candidateUsesModelSignal(candidate))
    .map(candidate => buildCandidateDescriptor(candidate, canonical.index))
    // The caller may rank candidates using all outcomes. Resolve training ties
    // by immutable identity, never by that evaluation-informed input order.
    .sort((a, b) => a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1
      : a.manifest.specHash < b.manifest.specHash ? -1 : a.manifest.specHash > b.manifest.specHash ? 1 : 0);
  const candidateConflicts = descriptors.reduce((n, descriptor) => n + descriptor.conflicts.length, 0);
  const candidateDateBindings = { explicit: 0, matched: 0, inherited: 0, conflicts: 0 };
  for (const descriptor of descriptors) {
    for (const row of candidateRows(descriptor.candidate)) {
      if (!row || !Object.prototype.hasOwnProperty.call(row, "businessDate")) {
        candidateDateBindings.inherited++; continue;
      }
      candidateDateBindings.explicit++;
      const base = canonical.index.get(rowKey(row))?.row;
      if (!validDay(row.businessDate) || !base || row.businessDate !== base.businessDate) {
        candidateDateBindings.conflicts++;
      } else candidateDateBindings.matched++;
    }
  }
  const dayMap = new Map();
  for (const row of canonical.rows) {
    const group = dayMap.get(row.businessDate) || [];
    group.push(row); dayMap.set(row.businessDate, group);
  }
  const days = [...dayMap.keys()].sort(), folds = [], boundaries = [], blockers = [];
  if (exclusions.missingBusinessDate) blockers.push("business-date-missing");
  if (exclusions.invalidBusinessDate) blockers.push("business-date-invalid");
  if (exclusions.conflictingBusinessDates) blockers.push("business-date-conflict");
  if (canonical.conflicts.length) blockers.push("base-row-conflict");
  if (canonical.rejectedRows) blockers.push("invalid-base-rows");
  if (candidateConflicts) blockers.push("candidate-row-conflict");
  if (candidateDateBindings.conflicts) blockers.push("candidate-business-date-conflict");
  if (new Set(descriptors.map(d => d.candidate.id)).size !== descriptors.length) blockers.push("candidate-id-conflict");
  if (!descriptors.length) blockers.push("model-candidates-missing");
  // Missing/invalid rows may hide an unobserved result on an otherwise usable
  // day. Do not claim whole-day evidence by silently dropping those rows.
  if (!blockers.length) {
    let start = 0;
    while (start < days.length) {
      let end = start, evaluationRows = [];
      while (end < days.length && evaluationRows.length < minimumEvaluationRows) {
        evaluationRows.push(...dayMap.get(days[end++]));
      }
      if (evaluationRows.length < minimumEvaluationRows) {
        boundaries.push({ startBusinessDate: days[start], reason: "incomplete-final-evaluation-block", rows: evaluationRows.length });
        break;
      }
      const evaluationStartedMs = Math.min(...evaluationRows.map(row => timeMs(row.forecastTime || row.kickoffTime)));
      const priorDays = days.slice(0, start);
      const trainingDays = priorDays.filter(date => dayMap.get(date)
        .every(row => timeMs(row.resultObservedAt) < evaluationStartedMs));
      const trainingRows = trainingDays.flatMap(date => dayMap.get(date));
      const excludedUnobservedDays = priorDays.filter(date => !trainingDays.includes(date));
      if (trainingRows.length < minimumTrainingRows) {
        boundaries.push({ startBusinessDate: days[start], reason: "insufficient-fully-observed-training-days", rows: trainingRows.length, excludedUnobservedDays });
        if (folds.length) { blockers.push("continuous-evaluation-training-gap"); break; }
        start++; continue;
      }
      const trainingKeys = trainingRows.map(rowKey), evaluationKeys = evaluationRows.map(rowKey);
      const selected = selectTrainingCandidate(descriptors, canonical.index, trainingKeys);
      if (!selected) { blockers.push("training-candidate-coverage-gap"); break; }
      const evaluated = pairedMetricsForKeys(selected.descriptor.index, canonical.index, evaluationKeys);
      if (evaluated.coveredKeys.length !== evaluationRows.length) {
        blockers.push("evaluation-candidate-coverage-gap");
        boundaries.push({ startBusinessDate: days[start], selectedCandidateId: selected.descriptor.candidate.id,
          reason: "evaluation-candidate-coverage-gap", expectedRows: evaluationRows.length, coveredRows: evaluated.coveredKeys.length });
        break;
      }
      const trainingWatermarkMs = Math.max(...trainingRows.map(row => timeMs(row.resultObservedAt)));
      folds.push({ index: folds.length + 1, selectedCandidateId: selected.descriptor.candidate.id,
        selectedCandidateSpecHash: selected.descriptor.manifest.specHash,
        training: { businessDates: trainingDays, rows: trainingRows.length, excludedUnobservedDays,
          model: selected.model, market: selected.market, comparison: selected.comparison },
        evaluation: { businessDates: days.slice(start, end), rows: evaluationRows.length,
          model: evaluated.model, market: evaluated.market, comparison: evaluated.comparison },
        watermark: { trainingDataMaxObservedAt: new Date(trainingWatermarkMs).toISOString(),
          evaluationWindowStartedAt: new Date(evaluationStartedMs).toISOString(),
          noOverlapVerified: trainingWatermarkMs < evaluationStartedMs },
        passed: hasNonNegativeImprovementPair(evaluated.comparison),
      });
      start = end;
    }
  }
  const passedFolds = folds.filter(fold => fold.passed).length, passRate = folds.length ? passedFolds / folds.length : null;
  if (folds.length < requiredFolds) blockers.push("insufficient-independent-match-day-folds");
  if (passRate !== null && passRate < minimumPassRate) blockers.push("match-day-pass-rate-below-target");
  const structuralBlock = blockers.some(reason => ![
    "insufficient-independent-match-day-folds", "match-day-pass-rate-below-target",
  ].includes(reason));
  const report = {
    version: "match-day-walk-forward-research-v1", promotionEligible: false,
    status: structuralBlock ? "blocked" : !blockers.length ? "research-complete" : "collecting",
    scope: "explicit-business-date-whole-day-frozen-candidate-selection",
    thresholds: { minimumTrainingRows, minimumEvaluationRows, requiredFolds, minimumPassRate },
    sample: { inputRows: input.length, acceptedRows: canonical.rows.length, duplicateRows: canonical.duplicateRows,
      rejectedRows: canonical.rejectedRows, independentMatchDays: days.length,
      folds: folds.length, evaluationRows: folds.reduce((n, fold) => n + fold.evaluation.rows, 0), passedFolds, passRate },
    inputDatasetHash: stableHash({ canonical: canonical.manifest.hash,
      businessDays: canonical.rows.map(row => [rowKey(row), row.businessDate]) }),
    candidateManifestHash: stableHash(descriptors.map(descriptor => descriptor.manifest)),
    exclusions, candidateDateBindings, folds, boundaries, blockers,
    policy: "Explicit businessDate only; whole days remain indivisible. Every training-day result must be observed before the earliest evaluation forecast. Select frozen candidates using training rows only, then evaluate the complete contiguous day block against the same-event market. Diagnostic selection review, not model refitting or formal promotion.",
  };
  return { ...report, reportHash: stableHash(report) };
};

module.exports = {
  PROMOTION_MIN_PASS_RATE,
  PROMOTION_MIN_REQUIRED_FOLDS,
  WALK_FORWARD_PROTOCOL_VERSION,
  WALK_FORWARD_VALIDATION_VERSION,
  buildWalkForwardValidation,
  buildMatchDayWalkForwardResearch,
  candidateUsesModelSignal,
  compareMetrics,
  deepValidateWalkForwardArtifact,
  finiteImprovementPair,
  hasNonNegativeImprovementPair,
  normalizeTriplet,
  stableHash,
  summarizeProbabilityRows,
  walkForwardPromotionState,
};
