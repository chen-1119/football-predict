const {
  DEFAULT_MIN_ROWS,
  FEATURE_NAMES,
  OUTCOMES,
  fit,
  metrics,
  normalizeTriplet,
  predict,
  stableHash,
} = require("./residualMarketModel.cjs");

const RESIDUAL_MARKET_WALK_FORWARD_VERSION = "residual-market-walk-forward-v1";
const DEFAULT_HOLDOUT_ROWS = 20;
const DEFAULT_MIN_FOLDS = 3;
const DEFAULT_PROBABILITY_TOLERANCE = 1e-8;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const finiteNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const finiteInteger = (value, fallback, minimum, maximum) => {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
};

const finiteOption = (value, fallback, minimum, maximum) => {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const round = (value, digits = 12) => {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Number(parsed.toFixed(digits));
};

const timeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

const lexicalCompare = (left, right) => {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const rowKey = (row) => {
  const value = firstDefined(row?.sourceMatchId, row?.matchId, row?.id);
  return value === undefined || String(value).trim() === "" ? null : String(value).trim();
};

const explicitFallbackState = (row) => {
  const markers = [
    row?.resultObservedAtFallback,
    row?.resultObservationFallback,
    row?.resultObservation?.fallback,
    row?.resultObservation?.isFallback,
    row?.resultObservedAtProvenance?.fallback,
    row?.resultProvenance?.fallback,
  ].filter((value) => typeof value === "boolean");
  if (!markers.length) return null;
  return markers.some(Boolean);
};

const residualTriplet = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const one = finiteNumber(value["1"] ?? value.home);
  const draw = finiteNumber(value.X ?? value.draw);
  const two = finiteNumber(value["2"] ?? value.away);
  if ([one, draw, two].some((number) => number === null)) return null;
  return { "1": round(one), X: round(draw), "2": round(two) };
};

const canonicalTime = (value) => {
  const parsed = timeMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const optionalProbability = (value) => {
  if (value === undefined || value === null) return { ok: true, value: null };
  const normalized = normalizeTriplet(value);
  return normalized
    ? { ok: true, value: normalized }
    : { ok: false, value: null };
};

const optionalObservationTime = (row, name, forecastMs) => {
  if (row?.[name] === undefined || row?.[name] === null) return { ok: true, value: null };
  const parsed = timeMs(row[name]);
  if (parsed === null || parsed > forecastMs) return { ok: false, value: null };
  return { ok: true, value: new Date(parsed).toISOString() };
};

const canonicalizeRow = (row) => {
  const key = rowKey(row);
  if (!key) return { ok: false, reason: "match-key-missing" };

  const forecastMs = timeMs(firstDefined(row?.forecastTime, row?.predictionObservedAt));
  if (forecastMs === null) return { ok: false, reason: "forecast-time-missing" };
  const resultMs = timeMs(row?.resultObservedAt);
  if (resultMs === null) return { ok: false, reason: "result-observed-at-missing" };
  if (resultMs <= forecastMs) return { ok: false, reason: "invalid-forecast-result-order" };

  const fallback = explicitFallbackState(row);
  if (fallback === null) return { ok: false, reason: "result-observation-provenance-missing" };
  if (fallback) return { ok: false, reason: "fallback-result-observation" };
  if (!OUTCOMES.includes(row?.actual)) return { ok: false, reason: "actual-outcome-invalid" };

  const marketProbabilities = normalizeTriplet(row?.marketProbabilities);
  if (!marketProbabilities) return { ok: false, reason: "market-probabilities-invalid" };

  let kickoffTime = null;
  if (row?.kickoffTime !== undefined && row?.kickoffTime !== null) {
    const kickoffMs = timeMs(row.kickoffTime);
    if (kickoffMs === null || kickoffMs < forecastMs || resultMs < kickoffMs) {
      return { ok: false, reason: "invalid-kickoff-order" };
    }
    kickoffTime = new Date(kickoffMs).toISOString();
  }

  const featureObservedAt = optionalObservationTime(row, "featureObservedAt", forecastMs);
  const currentModelObservedAt = optionalObservationTime(row, "currentModelObservedAt", forecastMs);
  const historicalModelObservedAt = optionalObservationTime(row, "historicalModelObservedAt", forecastMs);
  const oddsMovementObservedAt = optionalObservationTime(row, "oddsMovementObservedAt", forecastMs);
  if (![featureObservedAt, currentModelObservedAt, historicalModelObservedAt, oddsMovementObservedAt]
    .every((entry) => entry.ok)) {
    return { ok: false, reason: "feature-observed-after-forecast" };
  }

  const canonical = {
    sourceMatchId: key,
    forecastTime: new Date(forecastMs).toISOString(),
    resultObservedAt: new Date(resultMs).toISOString(),
    resultObservedAtFallback: false,
    actual: row.actual,
    marketProbabilities,
  };
  if (kickoffTime) canonical.kickoffTime = kickoffTime;
  if (featureObservedAt.value) canonical.featureObservedAt = featureObservedAt.value;
  if (currentModelObservedAt.value) canonical.currentModelObservedAt = currentModelObservedAt.value;
  if (historicalModelObservedAt.value) canonical.historicalModelObservedAt = historicalModelObservedAt.value;
  if (oddsMovementObservedAt.value) canonical.oddsMovementObservedAt = oddsMovementObservedAt.value;

  if (row?.residualFeatures !== undefined && row?.residualFeatures !== null) {
    if (typeof row.residualFeatures !== "object" || Array.isArray(row.residualFeatures)) {
      return { ok: false, reason: "residual-features-invalid" };
    }
    canonical.residualFeatures = {};
    for (const featureName of FEATURE_NAMES) {
      const supplied = row.residualFeatures[featureName];
      if (supplied === undefined || supplied === null) continue;
      const normalized = residualTriplet(supplied);
      if (!normalized) return { ok: false, reason: `residual-feature-${featureName}-invalid` };
      canonical.residualFeatures[featureName] = normalized;
    }
  } else {
    const current = optionalProbability(firstDefined(
      row?.currentModelProbabilities,
      row?.modelProbabilities,
      row?.currentModel?.probabilities,
    ));
    const historical = optionalProbability(firstDefined(
      row?.historicalModelProbabilities,
      row?.historicalProbabilities,
      row?.historicalModel?.probabilities,
    ));
    if (!current.ok) return { ok: false, reason: "current-model-probabilities-invalid" };
    if (!historical.ok) return { ok: false, reason: "historical-model-probabilities-invalid" };
    if (current.value) canonical.currentModelProbabilities = current.value;
    if (historical.value) canonical.historicalModelProbabilities = historical.value;

    const movement = firstDefined(row?.oddsMovementResidual, row?.marketMovementResidual);
    if (movement !== undefined) {
      const normalized = residualTriplet(movement);
      if (!normalized) return { ok: false, reason: "odds-movement-residual-invalid" };
      canonical.oddsMovementResidual = normalized;
    } else {
      const opening = optionalProbability(firstDefined(
        row?.openingMarketProbabilities,
        row?.openingProbabilities,
      ));
      if (!opening.ok) return { ok: false, reason: "opening-market-probabilities-invalid" };
      if (opening.value) canonical.openingMarketProbabilities = opening.value;
    }
  }

  return {
    ok: true,
    key,
    row: canonical,
    fingerprint: stableHash(canonical),
    forecastMs,
    resultMs,
  };
};

const canonicalizeRows = (input) => {
  const inputRows = Array.isArray(input) ? input : [];
  const rejectedByReason = {};
  const accepted = [];
  for (const rawRow of inputRows) {
    const result = canonicalizeRow(rawRow);
    if (!result.ok) {
      rejectedByReason[result.reason] = Number(rejectedByReason[result.reason] || 0) + 1;
    } else {
      accepted.push(result);
    }
  }

  const groups = new Map();
  for (const entry of accepted) {
    if (!groups.has(entry.key)) groups.set(entry.key, { count: 0, variants: new Map() });
    const group = groups.get(entry.key);
    group.count += 1;
    group.variants.set(entry.fingerprint, entry);
  }

  const rows = [];
  const conflicts = [];
  let duplicateRowsRemoved = 0;
  for (const key of [...groups.keys()].sort(lexicalCompare)) {
    const group = groups.get(key);
    const variants = group.variants;
    const fingerprints = [...variants.keys()].sort(lexicalCompare);
    const countForKey = group.count;
    if (fingerprints.length > 1) {
      conflicts.push({
        keyHash: stableHash(key),
        fingerprints,
        rows: countForKey,
      });
      continue;
    }
    duplicateRowsRemoved += countForKey - 1;
    rows.push(variants.get(fingerprints[0]).row);
  }

  rows.sort((left, right) => (
    timeMs(left.forecastTime) - timeMs(right.forecastTime)
    || lexicalCompare(left.sourceMatchId, right.sourceMatchId)
    || timeMs(left.resultObservedAt) - timeMs(right.resultObservedAt)
  ));

  const rejectedRows = Object.values(rejectedByReason).reduce((sum, count) => sum + count, 0);
  const dataHash = stableHash({
    version: RESIDUAL_MARKET_WALK_FORWARD_VERSION,
    rows,
    conflicts,
    rejectedByReason,
  });
  return {
    rows,
    dataHash,
    inputRows: inputRows.length,
    rejectedRows,
    rejectedByReason,
    duplicateRowsRemoved,
    conflictingKeys: conflicts.length,
    conflicts,
  };
};

const normalizeOptions = (options = {}) => {
  const requestedMaximumGap = firstDefined(options.maximumForecastGapMs, options.maxForecastGapMs);
  const parsedMaximumGap = requestedMaximumGap === undefined || requestedMaximumGap === null
    ? null
    : finiteNumber(requestedMaximumGap);
  return {
    minTrainingRows: finiteInteger(options.minTrainingRows, DEFAULT_MIN_ROWS, 3, 1000000),
    holdoutRows: finiteInteger(firstDefined(options.holdoutRows, options.windowRows), DEFAULT_HOLDOUT_ROWS, 1, 100000),
    minFolds: finiteInteger(options.minFolds, DEFAULT_MIN_FOLDS, 1, 10000),
    probabilityTolerance: finiteOption(
      options.probabilityTolerance,
      DEFAULT_PROBABILITY_TOLERANCE,
      1e-15,
      1e-3,
    ),
    maximumForecastGapMs: parsedMaximumGap === null
      ? null
      : Math.max(1, Math.min(315576000000, Math.trunc(parsedMaximumGap))),
    fit: {
      iterations: finiteInteger(options.iterations, 1200, 50, 10000),
      learningRate: finiteOption(options.learningRate, 0.03, 0.00001, 1),
      l2: finiteOption(options.l2, 0.02, 0, 100),
      interceptL2: finiteOption(options.interceptL2, 0.002, 0, 100),
    },
  };
};

const improvement = (modelMetrics, marketMetrics) => ({
  brier: round(marketMetrics.brier - modelMetrics.brier, 9),
  logLoss: round(marketMetrics.logLoss - modelMetrics.logLoss, 9),
  accuracy: round(modelMetrics.accuracy - marketMetrics.accuracy, 9),
});

const manifestProjection = (manifest) => {
  const { manifestHash, ...projection } = manifest || {};
  return projection;
};

const sealManifest = (payload) => ({
  ...payload,
  manifestHash: stableHash(payload),
});

const sealEvaluationManifest = (manifest) => {
  if (manifest.candidateReady !== true && manifest.internalCandidateBlockers.length === 0) {
    manifest.internalCandidateBlockers.push(...manifest.blockers);
  }
  manifest.internalCandidateBlockers = [...new Set(manifest.internalCandidateBlockers)]
    .sort(lexicalCompare);
  manifest.candidateReady = manifest.candidateReady === true
    && manifest.internalCandidateBlockers.length === 0;
  return sealManifest(manifest);
};

const verifyManifestHash = (manifest) => (
  Boolean(manifest)
  && typeof manifest.manifestHash === "string"
  && /^[a-f0-9]{64}$/.test(manifest.manifestHash)
  && stableHash(manifestProjection(manifest)) === manifest.manifestHash
);

const rowsBefore = (sortedValues, boundary) => {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedValues[middle] < boundary) low = middle + 1;
    else high = middle;
  }
  return low;
};

const coverageSummary = (rows, maximumForecastGapMs) => {
  let maximumObservedForecastGapMs = 0;
  let excessiveForecastGaps = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const gap = timeMs(rows[index].forecastTime) - timeMs(rows[index - 1].forecastTime);
    maximumObservedForecastGapMs = Math.max(maximumObservedForecastGapMs, gap);
    if (maximumForecastGapMs !== null && gap > maximumForecastGapMs) excessiveForecastGaps += 1;
  }
  return {
    maximumForecastGapMs,
    maximumObservedForecastGapMs,
    excessiveForecastGaps,
  };
};

const baseManifest = (canonical, config, coverage) => ({
  version: RESIDUAL_MARKET_WALK_FORWARD_VERSION,
  status: "blocked-shadow",
  shadowOnly: true,
  productionEligible: false,
  eligibleForProduction: false,
  candidateReady: false,
  internalCandidateBlockers: [],
  finalCandidate: null,
  policy: {
    training: "Every fold is refit from scratch on the expanding set whose explicit non-fallback resultObservedAt is strictly before the holdout forecast window start.",
    holdout: "Chronologically ordered, fixed-size, contiguous-by-row and non-overlapping windows.",
    finalFit: "After complete out-of-sample evaluation, one deterministic shadow candidate is fit with the same fixed hyperparameters on every canonical row through the latest explicit result watermark.",
    candidateReadiness: "Internal candidateReady requires complete fold coverage plus strictly positive aggregate out-of-sample Brier and log-loss improvement; it never makes this artifact production-eligible by itself.",
    activation: "This artifact is offline shadow evidence only and cannot activate a production model.",
  },
  config,
  input: {
    dataHash: canonical.dataHash,
    inputRows: canonical.inputRows,
    acceptedUniqueRows: canonical.rows.length,
    rejectedRows: canonical.rejectedRows,
    rejectedByReason: canonical.rejectedByReason,
    duplicateRowsRemoved: canonical.duplicateRowsRemoved,
    conflictingKeys: canonical.conflictingKeys,
    conflicts: canonical.conflicts,
  },
  coverage,
  sample: {
    warmupRows: 0,
    eligibleTrainingRowsAtFirstFold: 0,
    completeFolds: 0,
    evaluatedRows: 0,
    tailRowsExcluded: 0,
  },
  folds: [],
  aggregate: null,
  blockers: [],
  integrity: {
    algorithm: "sha256",
    deterministic: true,
    foldLocalFit: true,
    futureLabelsExcluded: true,
    conflictPolicy: "fail-closed",
    finalModelContentBound: true,
  },
});

const finalFitEvaluationTime = (rows) => {
  if (!rows.length) return null;
  const latestResultMs = rows.reduce(
    (latest, row) => Math.max(latest, timeMs(row.resultObservedAt) ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestResultMs)) return null;
  const boundary = new Date(latestResultMs + 1);
  return Number.isFinite(boundary.getTime()) ? boundary.toISOString() : null;
};

const buildFinalCandidate = ({ canonical, config, aggregate, folds, completeFoldCount }) => {
  const internalCandidateBlockers = [];
  const evaluationTime = finalFitEvaluationTime(canonical.rows);
  const finalModel = evaluationTime
    ? fit(canonical.rows, {
      evaluationTime,
      minRows: config.minTrainingRows,
      ...config.fit,
    })
    : null;

  const foldsComplete = folds.length === completeFoldCount
    && completeFoldCount >= config.minFolds
    && folds.every((fold) => (
      Array.isArray(fold.blockers)
      && fold.blockers.length === 0
      && fold.sampleGates?.minimumTrainingRows === true
      && fold.sampleGates?.completeHoldout === true
      && fold.sampleGates?.completePredictionCoverage === true
      && fold.sampleGates?.strictWatermark === true
    ));
  if (!foldsComplete) internalCandidateBlockers.push("residual-final-candidate-folds-incomplete");
  if (!(aggregate?.improvement?.brier > 0)) {
    internalCandidateBlockers.push("residual-final-candidate-oos-brier-not-improved");
  }
  if (!(aggregate?.improvement?.logLoss > 0)) {
    internalCandidateBlockers.push("residual-final-candidate-oos-logloss-not-improved");
  }
  if (!finalModel || finalModel.status !== "trained-shadow" || finalModel.eligible !== true) {
    internalCandidateBlockers.push(...(
      Array.isArray(finalModel?.blockers) && finalModel.blockers.length
        ? finalModel.blockers.map((blocker) => `residual-final-candidate-fit:${blocker}`)
        : ["residual-final-candidate-fit-blocked"]
    ));
  }
  if (finalModel?.sample?.acceptedRows !== canonical.rows.length) {
    internalCandidateBlockers.push(
      `residual-final-candidate-training-coverage:${finalModel?.sample?.acceptedRows || 0}<${canonical.rows.length}`,
    );
  }
  if (!finalModel?.parameters || typeof finalModel.parameters !== "object") {
    internalCandidateBlockers.push("residual-final-candidate-parameters-missing");
  }
  if (!HASH_PATTERN.test(finalModel?.modelHash || "")) {
    internalCandidateBlockers.push("residual-final-candidate-model-hash-invalid");
  }
  if (!HASH_PATTERN.test(finalModel?.dataHash || "")) {
    internalCandidateBlockers.push("residual-final-candidate-data-hash-invalid");
  }
  if (!finalModel?.featureSchema || !HASH_PATTERN.test(finalModel?.featureSchemaHash || "")) {
    internalCandidateBlockers.push("residual-final-candidate-feature-schema-invalid");
  }
  if (!finalModel?.trainedThrough || timeMs(finalModel.trainedThrough) === null) {
    internalCandidateBlockers.push("residual-final-candidate-trained-through-invalid");
  }

  const parametersHash = finalModel?.parameters ? stableHash(finalModel.parameters) : null;
  if (!HASH_PATTERN.test(parametersHash || "")) {
    internalCandidateBlockers.push("residual-final-candidate-parameters-hash-invalid");
  }
  const uniqueBlockers = [...new Set(internalCandidateBlockers)].sort(lexicalCompare);
  const candidateReady = uniqueBlockers.length === 0;
  const fallbackIdentityHash = stableHash({
    version: RESIDUAL_MARKET_WALK_FORWARD_VERSION,
    dataHash: canonical.dataHash,
    config,
  });
  const candidateId = `residual-market:${finalModel?.modelHash || fallbackIdentityHash}`;
  const finalCandidate = finalModel ? {
    ...finalModel,
    candidateId,
    candidateType: "market-residual-shadow",
    shadowOnly: true,
    productionEligible: false,
    candidateReady,
    candidateStatus: candidateReady ? "candidate-ready-shadow" : "candidate-blocked-shadow",
    internalCandidateBlockers: uniqueBlockers,
    parametersHash,
  } : null;

  return {
    candidateReady,
    internalCandidateBlockers: uniqueBlockers,
    finalCandidate,
  };
};

const evaluateResidualMarketWalkForward = (inputRows, options = {}) => {
  const config = normalizeOptions(options);
  const canonical = canonicalizeRows(inputRows);
  const coverage = coverageSummary(canonical.rows, config.maximumForecastGapMs);
  const manifest = baseManifest(canonical, config, coverage);

  if (canonical.rejectedRows > 0) {
    manifest.blockers.push(`residual-walk-forward-coverage-gap-invalid-rows:${canonical.rejectedRows}`);
  }
  if (canonical.conflictingKeys > 0) {
    manifest.blockers.push(`residual-walk-forward-conflicting-keys:${canonical.conflictingKeys}`);
  }
  if (coverage.excessiveForecastGaps > 0) {
    manifest.blockers.push(`residual-walk-forward-coverage-gap-forecast:${coverage.excessiveForecastGaps}`);
  }
  if (manifest.blockers.length) {
    manifest.blockers.sort(lexicalCompare);
    return sealEvaluationManifest(manifest);
  }

  const resultTimeline = canonical.rows
    .map((row) => timeMs(row.resultObservedAt))
    .sort((left, right) => left - right);
  let holdoutStartIndex = null;
  let eligibleAtFirstFold = 0;
  for (let index = 0; index < canonical.rows.length; index += 1) {
    const startMs = timeMs(canonical.rows[index].forecastTime);
    const eligible = rowsBefore(resultTimeline, startMs);
    if (eligible >= config.minTrainingRows) {
      holdoutStartIndex = index;
      eligibleAtFirstFold = eligible;
      break;
    }
  }

  if (holdoutStartIndex === null) {
    manifest.blockers.push(
      `residual-walk-forward-min-training-rows:0<${config.minTrainingRows}`,
    );
    return sealEvaluationManifest(manifest);
  }

  const availableHoldoutRows = canonical.rows.length - holdoutStartIndex;
  const completeFoldCount = Math.floor(availableHoldoutRows / config.holdoutRows);
  manifest.sample.warmupRows = holdoutStartIndex;
  manifest.sample.eligibleTrainingRowsAtFirstFold = eligibleAtFirstFold;
  manifest.sample.completeFolds = completeFoldCount;
  manifest.sample.tailRowsExcluded = availableHoldoutRows - completeFoldCount * config.holdoutRows;
  if (completeFoldCount < config.minFolds) {
    manifest.blockers.push(
      `residual-walk-forward-min-folds:${completeFoldCount}<${config.minFolds}`,
    );
    return sealEvaluationManifest(manifest);
  }

  const allModelEvaluationRows = [];
  const allMarketEvaluationRows = [];
  for (let foldOffset = 0; foldOffset < completeFoldCount; foldOffset += 1) {
    const startIndex = holdoutStartIndex + foldOffset * config.holdoutRows;
    const endIndex = startIndex + config.holdoutRows - 1;
    const holdout = canonical.rows.slice(startIndex, endIndex + 1);
    const windowStartMs = timeMs(holdout[0].forecastTime);
    const windowStart = new Date(windowStartMs).toISOString();
    const trainingRows = canonical.rows.filter((row) => timeMs(row.resultObservedAt) < windowStartMs);
    const model = fit(trainingRows, {
      evaluationTime: windowStart,
      minRows: config.minTrainingRows,
      ...config.fit,
    });

    const foldBlockers = [];
    if (!model || model.status !== "trained-shadow" || model.eligible !== true) {
      foldBlockers.push(...(Array.isArray(model?.blockers) && model.blockers.length
        ? model.blockers
        : ["residual-walk-forward-fit-blocked"]));
    }
    if (model?.sample?.acceptedRows !== trainingRows.length) {
      foldBlockers.push(
        `residual-walk-forward-training-coverage:${model?.sample?.acceptedRows || 0}<${trainingRows.length}`,
      );
    }
    if (trainingRows.length < config.minTrainingRows) {
      foldBlockers.push(
        `residual-walk-forward-min-training-rows:${trainingRows.length}<${config.minTrainingRows}`,
      );
    }
    const trainedThroughMs = timeMs(model?.trainedThrough);
    if (trainedThroughMs === null || trainedThroughMs >= windowStartMs) {
      foldBlockers.push("residual-walk-forward-watermark-not-strictly-before-window");
    }

    const modelEvaluationRows = [];
    const marketEvaluationRows = [];
    let maximumProbabilitySumError = 0;
    let minimumProbability = 1;
    let maximumProbability = 0;
    let invalidProbabilityRows = 0;
    if (!foldBlockers.length) {
      for (const row of holdout) {
        try {
          const prediction = predict(model, row);
          const probabilities = prediction.probabilities;
          const values = OUTCOMES.map((outcome) => probabilities[outcome]);
          const sum = values.reduce((total, value) => total + value, 0);
          const sumError = Math.abs(sum - 1);
          maximumProbabilitySumError = Math.max(maximumProbabilitySumError, sumError);
          minimumProbability = Math.min(minimumProbability, ...values);
          maximumProbability = Math.max(maximumProbability, ...values);
          if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
              || sumError > config.probabilityTolerance) {
            invalidProbabilityRows += 1;
          }
          modelEvaluationRows.push({ actual: row.actual, probabilities });
          marketEvaluationRows.push({
            actual: row.actual,
            marketProbabilities: row.marketProbabilities,
          });
        } catch {
          invalidProbabilityRows += 1;
        }
      }
    }
    if (modelEvaluationRows.length !== holdout.length || invalidProbabilityRows > 0) {
      foldBlockers.push(
        `residual-walk-forward-prediction-coverage:${modelEvaluationRows.length}/${holdout.length};invalid=${invalidProbabilityRows}`,
      );
    }

    const modelMetrics = foldBlockers.length ? null : metrics(modelEvaluationRows);
    const marketMetrics = foldBlockers.length ? null : metrics(marketEvaluationRows);
    if (!foldBlockers.length
        && (modelMetrics.rows !== holdout.length || marketMetrics.rows !== holdout.length)) {
      foldBlockers.push("residual-walk-forward-metric-coverage-gap");
    }

    const fold = {
      fold: foldOffset + 1,
      shadowOnly: true,
      productionEligible: false,
      window: {
        startIndex,
        endIndex,
        startForecastTime: windowStart,
        endForecastTime: canonicalTime(holdout[holdout.length - 1].forecastTime),
        rows: holdout.length,
        contiguousWithPrevious: foldOffset === 0
          ? true
          : startIndex === manifest.folds[manifest.folds.length - 1].window.endIndex + 1,
      },
      training: {
        rows: trainingRows.length,
        evaluationTime: windowStart,
        trainedThrough: model?.trainedThrough || null,
        strictWatermark: trainedThroughMs !== null && trainedThroughMs < windowStartMs,
      },
      modelHash: model?.modelHash || null,
      dataHash: model?.dataHash || null,
      holdoutDataHash: stableHash({
        version: RESIDUAL_MARKET_WALK_FORWARD_VERSION,
        fold: foldOffset + 1,
        rows: holdout,
      }),
      metrics: foldBlockers.length ? null : {
        model: modelMetrics,
        market: marketMetrics,
        improvement: improvement(modelMetrics, marketMetrics),
      },
      probabilityAudit: {
        tolerance: config.probabilityTolerance,
        invalidRows: invalidProbabilityRows,
        maximumSumError: round(maximumProbabilitySumError, 15),
        minimum: modelEvaluationRows.length ? round(minimumProbability, 12) : null,
        maximum: modelEvaluationRows.length ? round(maximumProbability, 12) : null,
      },
      sampleGates: {
        minimumTrainingRows: trainingRows.length >= config.minTrainingRows,
        completeHoldout: holdout.length === config.holdoutRows,
        completePredictionCoverage: modelEvaluationRows.length === holdout.length
          && invalidProbabilityRows === 0,
        strictWatermark: trainedThroughMs !== null && trainedThroughMs < windowStartMs,
      },
      blockers: [...new Set(foldBlockers)].sort(lexicalCompare),
    };
    fold.foldManifestHash = stableHash(fold);
    manifest.folds.push(fold);

    if (fold.blockers.length) {
      manifest.blockers.push(...fold.blockers.map((blocker) => `fold-${fold.fold}:${blocker}`));
      break;
    }
    allModelEvaluationRows.push(...modelEvaluationRows);
    allMarketEvaluationRows.push(...marketEvaluationRows);
  }

  if (!manifest.blockers.length && manifest.folds.length !== completeFoldCount) {
    manifest.blockers.push(
      `residual-walk-forward-fold-coverage:${manifest.folds.length}<${completeFoldCount}`,
    );
  }

  const expectedEvaluationRows = completeFoldCount * config.holdoutRows;
  if (!manifest.blockers.length && allModelEvaluationRows.length !== expectedEvaluationRows) {
    manifest.blockers.push(
      `residual-walk-forward-overall-coverage:${allModelEvaluationRows.length}<${expectedEvaluationRows}`,
    );
  }

  if (!manifest.blockers.length) {
    const modelMetrics = metrics(allModelEvaluationRows);
    const marketMetrics = metrics(allMarketEvaluationRows);
    manifest.status = "evaluated-shadow";
    manifest.sample.evaluatedRows = allModelEvaluationRows.length;
    manifest.aggregate = {
      folds: manifest.folds.length,
      rows: allModelEvaluationRows.length,
      model: modelMetrics,
      market: marketMetrics,
      improvement: improvement(modelMetrics, marketMetrics),
    };
    const finalState = buildFinalCandidate({
      canonical,
      config,
      aggregate: manifest.aggregate,
      folds: manifest.folds,
      completeFoldCount,
    });
    manifest.candidateReady = finalState.candidateReady;
    manifest.internalCandidateBlockers = finalState.internalCandidateBlockers;
    manifest.finalCandidate = finalState.finalCandidate;
  } else {
    manifest.blockers = [...new Set(manifest.blockers)].sort(lexicalCompare);
  }

  return sealEvaluationManifest(manifest);
};

module.exports = {
  DEFAULT_HOLDOUT_ROWS,
  DEFAULT_MIN_FOLDS,
  DEFAULT_PROBABILITY_TOLERANCE,
  RESIDUAL_MARKET_WALK_FORWARD_VERSION,
  evaluateResidualMarketWalkForward,
  verifyManifestHash,
};
