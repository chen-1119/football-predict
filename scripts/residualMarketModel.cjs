const crypto = require("node:crypto");

const RESIDUAL_MARKET_MODEL_VERSION = "residual-market-softmax-v1";
const FEATURE_SCHEMA_VERSION = "market-residual-features-v1";
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const FEATURE_NAMES = Object.freeze([
  "currentModelResidual",
  "historicalModelResidual",
  "oddsMovementResidual",
]);
const DEFAULT_MIN_ROWS = 120;
const PROBABILITY_FLOOR = 1e-9;
const RESIDUAL_LIMIT = 4;

const FEATURE_SCHEMA = Object.freeze({
  version: FEATURE_SCHEMA_VERSION,
  outcomes: OUTCOMES,
  offset: "log(normalize(marketProbabilities)[outcome])",
  features: Object.freeze([
    Object.freeze({
      name: "currentModelResidual",
      aliases: Object.freeze(["currentModelProbabilities", "modelProbabilities", "currentModel.probabilities"]),
      transform: "center(log(normalize(currentModelProbabilities) / normalize(marketProbabilities)))",
    }),
    Object.freeze({
      name: "historicalModelResidual",
      aliases: Object.freeze(["historicalModelProbabilities", "historicalProbabilities", "historicalModel.probabilities"]),
      transform: "center(log(normalize(historicalModelProbabilities) / normalize(marketProbabilities)))",
    }),
    Object.freeze({
      name: "oddsMovementResidual",
      aliases: Object.freeze(["oddsMovementResidual", "openingMarketProbabilities", "openingProbabilities"]),
      transform: "center(explicitResidual) or center(log(currentMarket / openingMarket))",
    }),
  ]),
  missingFeaturePolicy: "missing optional feature groups are encoded as an all-zero residual and cannot move the market offset",
  clipping: Object.freeze({ minimum: -RESIDUAL_LIMIT, maximum: RESIDUAL_LIMIT }),
  resultObservationPolicy: Object.freeze({
    requiresExplicitNonFallback: true,
    acceptedFalseMarkers: Object.freeze([
      "resultObservedAtFallback",
      "resultObservationFallback",
      "resultObservation.fallback",
      "resultObservation.isFallback",
      "resultObservedAtProvenance.fallback",
      "resultProvenance.fallback",
    ]),
    temporalBoundary: "resultObservedAt < evaluationTime",
  }),
});

const finiteNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const finiteInteger = (value, fallback, minimum, maximum) => {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
};

const finiteOption = (value, fallback, minimum, maximum) => {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
};

const round = (value, digits = 12) => {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(digits));
};

const timeMs = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stableHash only accepts finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
};

const stableHash = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null);

const rawTriplet = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const one = finiteNumber(value["1"] ?? value.home);
  const draw = finiteNumber(value.X ?? value.draw);
  const two = finiteNumber(value["2"] ?? value.away);
  if ([one, draw, two].some((number) => number === null)) return null;
  return { "1": one, X: draw, "2": two };
};

const normalizeTriplet = (value) => {
  const triplet = rawTriplet(value);
  if (!triplet || OUTCOMES.some((outcome) => triplet[outcome] < 0)) return null;
  const total = OUTCOMES.reduce((sum, outcome) => sum + triplet[outcome], 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, round(triplet[outcome] / total)]));
};

const zeroResidual = () => ({ "1": 0, X: 0, "2": 0 });

const centerAndClip = (value) => {
  const triplet = rawTriplet(value);
  if (!triplet) return null;
  const mean = OUTCOMES.reduce((sum, outcome) => sum + triplet[outcome], 0) / OUTCOMES.length;
  return Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    round(Math.max(-RESIDUAL_LIMIT, Math.min(RESIDUAL_LIMIT, triplet[outcome] - mean))),
  ]));
};

const logResidual = (candidate, baseline) => {
  const normalizedCandidate = normalizeTriplet(candidate);
  const normalizedBaseline = normalizeTriplet(baseline);
  if (!normalizedCandidate || !normalizedBaseline) return null;
  return centerAndClip(Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    Math.log(Math.max(PROBABILITY_FLOOR, normalizedCandidate[outcome]))
      - Math.log(Math.max(PROBABILITY_FLOOR, normalizedBaseline[outcome])),
  ])));
};

const optionalProbabilityFeature = (value, marketProbabilities) => {
  if (value === undefined || value === null) {
    return { valid: true, present: false, residual: zeroResidual() };
  }
  const residual = logResidual(value, marketProbabilities);
  return residual
    ? { valid: true, present: true, residual }
    : { valid: false, present: true, residual: null };
};

const extractResidualFeatures = (row, marketProbabilities) => {
  if (row?.residualFeatures && typeof row.residualFeatures === "object") {
    const canonical = {};
    const presence = {};
    for (const featureName of FEATURE_NAMES) {
      const supplied = row.residualFeatures[featureName];
      if (supplied === undefined || supplied === null) {
        canonical[featureName] = zeroResidual();
        presence[featureName] = false;
        continue;
      }
      const residual = centerAndClip(supplied);
      if (!residual) return { valid: false, reason: `invalid-${featureName}` };
      canonical[featureName] = residual;
      presence[featureName] = true;
    }
    return { valid: true, features: canonical, presence };
  }

  const currentValue = firstDefined(
    row?.currentModelProbabilities,
    row?.modelProbabilities,
    row?.currentModel?.probabilities,
  );
  const historicalValue = firstDefined(
    row?.historicalModelProbabilities,
    row?.historicalProbabilities,
    row?.historicalModel?.probabilities,
  );
  const current = optionalProbabilityFeature(currentValue, marketProbabilities);
  const historical = optionalProbabilityFeature(historicalValue, marketProbabilities);
  if (!current.valid) return { valid: false, reason: "invalid-current-model-probabilities" };
  if (!historical.valid) return { valid: false, reason: "invalid-historical-model-probabilities" };

  const explicitMovement = firstDefined(row?.oddsMovementResidual, row?.marketMovementResidual);
  const openingMarket = firstDefined(row?.openingMarketProbabilities, row?.openingProbabilities);
  let movement = { valid: true, present: false, residual: zeroResidual() };
  if (explicitMovement !== undefined) {
    const residual = centerAndClip(explicitMovement);
    movement = residual
      ? { valid: true, present: true, residual }
      : { valid: false, present: true, residual: null };
  } else if (openingMarket !== undefined) {
    const residual = logResidual(marketProbabilities, openingMarket);
    movement = residual
      ? { valid: true, present: true, residual }
      : { valid: false, present: true, residual: null };
  }
  if (!movement.valid) return { valid: false, reason: "invalid-odds-movement" };

  return {
    valid: true,
    features: {
      currentModelResidual: current.residual,
      historicalModelResidual: historical.residual,
      oddsMovementResidual: movement.residual,
    },
    presence: {
      currentModelResidual: current.present,
      historicalModelResidual: historical.present,
      oddsMovementResidual: movement.present,
    },
  };
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

const rowKey = (row) => {
  const value = firstDefined(row?.sourceMatchId, row?.matchId, row?.id);
  return value === undefined || String(value).trim() === "" ? null : String(value).trim();
};

const reject = (reasons, reason) => {
  reasons[reason] = Number(reasons[reason] || 0) + 1;
  return null;
};

const validateFeatureTimestamps = (row, forecastMs) => {
  const candidates = [
    row?.featureObservedAt,
    row?.currentModelObservedAt,
    row?.historicalModelObservedAt,
    row?.oddsMovementObservedAt,
  ].filter((value) => value !== undefined && value !== null);
  for (const value of candidates) {
    const parsed = timeMs(value);
    if (parsed === null || parsed > forecastMs) return false;
  }
  return true;
};

const canonicalTrainingRows = (rows, evaluationMs) => {
  const reasons = {};
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = rowKey(row);
    if (!key) {
      reject(reasons, "match-key-missing");
      continue;
    }
    const fallback = explicitFallbackState(row);
    if (fallback === null) {
      reject(reasons, "result-observation-provenance-missing");
      continue;
    }
    if (fallback) {
      reject(reasons, "fallback-result-observation");
      continue;
    }
    const resultMs = timeMs(row?.resultObservedAt);
    if (resultMs === null) {
      reject(reasons, "result-observed-at-missing");
      continue;
    }
    if (resultMs >= evaluationMs) {
      reject(reasons, "result-observed-after-evaluation-start");
      continue;
    }
    const forecastMs = timeMs(firstDefined(row?.forecastTime, row?.predictionObservedAt));
    if (forecastMs === null || resultMs <= forecastMs) {
      reject(reasons, "invalid-forecast-result-order");
      continue;
    }
    const kickoffMs = row?.kickoffTime === undefined || row?.kickoffTime === null
      ? null
      : timeMs(row.kickoffTime);
    if ((row?.kickoffTime !== undefined && row?.kickoffTime !== null && kickoffMs === null)
        || (kickoffMs !== null && resultMs < kickoffMs)) {
      reject(reasons, "invalid-kickoff-result-order");
      continue;
    }
    if (!validateFeatureTimestamps(row, forecastMs)) {
      reject(reasons, "feature-observed-after-forecast");
      continue;
    }
    if (!OUTCOMES.includes(row?.actual)) {
      reject(reasons, "actual-outcome-invalid");
      continue;
    }
    const marketProbabilities = normalizeTriplet(row?.marketProbabilities);
    if (!marketProbabilities) {
      reject(reasons, "market-probabilities-invalid");
      continue;
    }
    const featureResult = extractResidualFeatures(row, marketProbabilities);
    if (!featureResult.valid) {
      reject(reasons, featureResult.reason);
      continue;
    }
    const commitment = {
      key,
      forecastTime: new Date(forecastMs).toISOString(),
      kickoffTime: kickoffMs === null ? null : new Date(kickoffMs).toISOString(),
      resultObservedAt: new Date(resultMs).toISOString(),
      actual: row.actual,
      marketProbabilities,
      residualFeatures: featureResult.features,
      featurePresence: featureResult.presence,
    };
    candidates.push({ key, commitment, fingerprint: stableHash(commitment) });
  }

  const byKey = new Map();
  const conflicts = [];
  let duplicateRows = 0;
  for (const candidate of candidates) {
    const previous = byKey.get(candidate.key);
    if (!previous) byKey.set(candidate.key, candidate);
    else if (previous.fingerprint === candidate.fingerprint) duplicateRows += 1;
    else conflicts.push({
      keyHash: stableHash(candidate.key),
      firstFingerprint: previous.fingerprint,
      conflictingFingerprint: candidate.fingerprint,
    });
  }
  const canonicalRows = [...byKey.values()]
    .map((entry) => entry.commitment)
    .sort((left, right) => (
      timeMs(left.resultObservedAt) - timeMs(right.resultObservedAt)
      || timeMs(left.forecastTime) - timeMs(right.forecastTime)
      || left.key.localeCompare(right.key)
    ));
  return {
    rows: canonicalRows,
    reasons,
    duplicateRows,
    conflicts,
    inputRows: Array.isArray(rows) ? rows.length : 0,
  };
};

const softmax = (logits) => {
  const maximum = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
};

const parameterArrays = (parameters) => ({
  bias: OUTCOMES.map((outcome) => finiteNumber(parameters?.bias?.[outcome]) ?? 0),
  coefficients: FEATURE_NAMES.map((featureName) => finiteNumber(parameters?.coefficients?.[featureName]) ?? 0),
});

const predictProjection = (parameters, projection) => {
  const arrays = parameterArrays(parameters);
  const logits = OUTCOMES.map((outcome, outcomeIndex) => {
    let value = Math.log(Math.max(PROBABILITY_FLOOR, projection.marketProbabilities[outcome]))
      + arrays.bias[outcomeIndex];
    for (let featureIndex = 0; featureIndex < FEATURE_NAMES.length; featureIndex += 1) {
      value += arrays.coefficients[featureIndex]
        * projection.residualFeatures[FEATURE_NAMES[featureIndex]][outcome];
    }
    return value;
  });
  const values = softmax(logits);
  return Object.fromEntries(OUTCOMES.map((outcome, index) => [outcome, values[index]]));
};

const summarize = (rows, probabilitySelector) => {
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  let rejectedRows = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!OUTCOMES.includes(row?.actual)) {
      rejectedRows += 1;
      continue;
    }
    let probabilities = null;
    try {
      probabilities = normalizeTriplet(probabilitySelector(row));
    } catch {
      probabilities = null;
    }
    if (!probabilities) {
      rejectedRows += 1;
      continue;
    }
    const predicted = OUTCOMES.reduce((best, outcome) => (
      probabilities[outcome] > probabilities[best] ? outcome : best
    ), OUTCOMES[0]);
    if (predicted === row.actual) correct += 1;
    for (const outcome of OUTCOMES) {
      brier += (probabilities[outcome] - (row.actual === outcome ? 1 : 0)) ** 2;
    }
    logLoss += -Math.log(Math.max(PROBABILITY_FLOOR, probabilities[row.actual]));
  }
  const acceptedRows = (Array.isArray(rows) ? rows.length : 0) - rejectedRows;
  return acceptedRows > 0 ? {
    rows: acceptedRows,
    rejectedRows,
    accuracy: round(correct / acceptedRows, 9),
    brier: round(brier / acceptedRows, 9),
    logLoss: round(logLoss / acceptedRows, 9),
  } : {
    rows: 0,
    rejectedRows,
    accuracy: null,
    brier: null,
    logLoss: null,
  };
};

const optimize = (rows, hyperparameters) => {
  const parameterCount = OUTCOMES.length + FEATURE_NAMES.length;
  const values = Array(parameterCount).fill(0);
  const firstMoment = Array(parameterCount).fill(0);
  const secondMoment = Array(parameterCount).fill(0);
  const betaOne = 0.9;
  const betaTwo = 0.999;
  const epsilon = 1e-8;
  let objective = null;

  for (let iteration = 1; iteration <= hyperparameters.iterations; iteration += 1) {
    const gradient = Array(parameterCount).fill(0);
    let negativeLogLikelihood = 0;
    for (const row of rows) {
      const parameters = {
        bias: Object.fromEntries(OUTCOMES.map((outcome, index) => [outcome, values[index]])),
        coefficients: Object.fromEntries(FEATURE_NAMES.map((feature, index) => [
          feature,
          values[OUTCOMES.length + index],
        ])),
      };
      const probabilities = predictProjection(parameters, row);
      negativeLogLikelihood += -Math.log(Math.max(PROBABILITY_FLOOR, probabilities[row.actual]));
      for (let outcomeIndex = 0; outcomeIndex < OUTCOMES.length; outcomeIndex += 1) {
        const outcome = OUTCOMES[outcomeIndex];
        const difference = probabilities[outcome] - (row.actual === outcome ? 1 : 0);
        gradient[outcomeIndex] += difference;
        for (let featureIndex = 0; featureIndex < FEATURE_NAMES.length; featureIndex += 1) {
          gradient[OUTCOMES.length + featureIndex] += difference
            * row.residualFeatures[FEATURE_NAMES[featureIndex]][outcome];
        }
      }
    }
    objective = negativeLogLikelihood / rows.length;
    for (let index = 0; index < parameterCount; index += 1) {
      const penalty = index < OUTCOMES.length
        ? hyperparameters.interceptL2
        : hyperparameters.l2;
      objective += 0.5 * penalty * values[index] ** 2;
      gradient[index] = gradient[index] / rows.length + penalty * values[index];
      firstMoment[index] = betaOne * firstMoment[index] + (1 - betaOne) * gradient[index];
      secondMoment[index] = betaTwo * secondMoment[index] + (1 - betaTwo) * gradient[index] ** 2;
      const correctedFirst = firstMoment[index] / (1 - betaOne ** iteration);
      const correctedSecond = secondMoment[index] / (1 - betaTwo ** iteration);
      values[index] -= hyperparameters.learningRate
        * correctedFirst / (Math.sqrt(correctedSecond) + epsilon);
    }
    const biasMean = values.slice(0, OUTCOMES.length).reduce((sum, value) => sum + value, 0) / OUTCOMES.length;
    for (let index = 0; index < OUTCOMES.length; index += 1) values[index] -= biasMean;
  }

  return {
    parameters: {
      bias: Object.fromEntries(OUTCOMES.map((outcome, index) => [outcome, round(values[index])])),
      coefficients: Object.fromEntries(FEATURE_NAMES.map((feature, index) => [
        feature,
        round(values[OUTCOMES.length + index]),
      ])),
    },
    objective: round(objective),
  };
};

const blockedArtifact = ({ evaluationTime, hyperparameters, canonical, blockers, dataHash }) => ({
  version: RESIDUAL_MARKET_MODEL_VERSION,
  status: "blocked",
  eligible: false,
  featureSchema: FEATURE_SCHEMA,
  featureSchemaHash: stableHash(FEATURE_SCHEMA),
  dataHash,
  modelHash: null,
  evaluationTime,
  trainedThrough: canonical?.rows?.length
    ? canonical.rows[canonical.rows.length - 1].resultObservedAt
    : null,
  sample: {
    inputRows: canonical?.inputRows || 0,
    acceptedRows: canonical?.rows?.length || 0,
    duplicateRowsRemoved: canonical?.duplicateRows || 0,
    conflictingKeys: canonical?.conflicts?.length || 0,
    rejectedRows: Object.values(canonical?.reasons || {}).reduce((sum, count) => sum + count, 0),
    rejectedByReason: canonical?.reasons || {},
    outcomeRows: Object.fromEntries(OUTCOMES.map((outcome) => [
      outcome,
      canonical?.rows?.filter((row) => row.actual === outcome).length || 0,
    ])),
  },
  hyperparameters,
  parameters: null,
  trainingMetrics: null,
  blockers,
  integrity: {
    conflicts: canonical?.conflicts || [],
    deterministic: true,
    futureLabelsExcluded: true,
  },
});

const modelHashProjection = (model) => ({
  version: model?.version,
  featureSchemaHash: model?.featureSchemaHash,
  dataHash: model?.dataHash,
  evaluationTime: model?.evaluationTime,
  trainedThrough: model?.trainedThrough,
  hyperparameters: model?.hyperparameters,
  parameters: model?.parameters,
});

const fit = (rows, options = {}) => {
  const evaluationMs = timeMs(options.evaluationTime);
  const hyperparameters = {
    minRows: finiteInteger(options.minRows, DEFAULT_MIN_ROWS, 3, 1000000),
    iterations: finiteInteger(options.iterations, 1200, 50, 10000),
    learningRate: finiteOption(options.learningRate, 0.03, 0.00001, 1),
    l2: finiteOption(options.l2, 0.02, 0, 100),
    interceptL2: finiteOption(options.interceptL2, 0.002, 0, 100),
  };
  if (evaluationMs === null) {
    const canonical = { rows: [], reasons: {}, conflicts: [], duplicateRows: 0, inputRows: Array.isArray(rows) ? rows.length : 0 };
    return blockedArtifact({
      evaluationTime: null,
      hyperparameters,
      canonical,
      blockers: ["residual-market-evaluation-time-invalid"],
      dataHash: stableHash({ featureSchema: FEATURE_SCHEMA, rows: [] }),
    });
  }

  const evaluationTime = new Date(evaluationMs).toISOString();
  const canonical = canonicalTrainingRows(rows, evaluationMs);
  const dataHash = stableHash({
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    rows: canonical.rows,
  });
  const outcomeRows = Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    canonical.rows.filter((row) => row.actual === outcome).length,
  ]));
  const minimumOutcomeRows = Math.max(2, Math.floor(hyperparameters.minRows * 0.05));
  const blockers = [];
  if (canonical.conflicts.length) blockers.push(`residual-market-conflicting-keys:${canonical.conflicts.length}`);
  if (canonical.rows.length < hyperparameters.minRows) {
    blockers.push(`residual-market-min-training-rows:${canonical.rows.length}<${hyperparameters.minRows}`);
  }
  for (const outcome of OUTCOMES) {
    if (outcomeRows[outcome] < minimumOutcomeRows) {
      blockers.push(`residual-market-outcome-rows-${outcome}:${outcomeRows[outcome]}<${minimumOutcomeRows}`);
    }
  }
  if (blockers.length) {
    return blockedArtifact({ evaluationTime, hyperparameters, canonical, blockers, dataHash });
  }

  const optimized = optimize(canonical.rows, hyperparameters);
  const marketMetrics = summarize(canonical.rows, (row) => row.marketProbabilities);
  const modelMetrics = summarize(canonical.rows, (row) => predictProjection(optimized.parameters, row));
  const trainedThrough = canonical.rows[canonical.rows.length - 1].resultObservedAt;
  const featureCoverage = Object.fromEntries(FEATURE_NAMES.map((featureName) => [
    featureName,
    canonical.rows.filter((row) => row.featurePresence[featureName]).length,
  ]));
  const modelHashPayload = {
    version: RESIDUAL_MARKET_MODEL_VERSION,
    featureSchemaHash: stableHash(FEATURE_SCHEMA),
    dataHash,
    evaluationTime,
    trainedThrough,
    hyperparameters,
    parameters: optimized.parameters,
  };
  return {
    version: RESIDUAL_MARKET_MODEL_VERSION,
    status: "trained-shadow",
    eligible: true,
    featureSchema: FEATURE_SCHEMA,
    featureSchemaHash: modelHashPayload.featureSchemaHash,
    dataHash,
    modelHash: stableHash(modelHashPayload),
    evaluationTime,
    trainedThrough,
    sample: {
      inputRows: canonical.inputRows,
      acceptedRows: canonical.rows.length,
      duplicateRowsRemoved: canonical.duplicateRows,
      conflictingKeys: canonical.conflicts.length,
      rejectedRows: Object.values(canonical.reasons).reduce((sum, count) => sum + count, 0),
      rejectedByReason: canonical.reasons,
      outcomeRows,
      featureCoverage,
    },
    hyperparameters,
    parameters: optimized.parameters,
    trainingMetrics: {
      model: modelMetrics,
      market: marketMetrics,
      improvement: {
        brier: round(marketMetrics.brier - modelMetrics.brier, 9),
        logLoss: round(marketMetrics.logLoss - modelMetrics.logLoss, 9),
        accuracy: round(modelMetrics.accuracy - marketMetrics.accuracy, 9),
      },
      regularizedObjective: optimized.objective,
    },
    blockers: [],
    integrity: {
      conflicts: canonical.conflicts,
      deterministic: true,
      futureLabelsExcluded: true,
      policy: "Only unique rows with an explicit non-fallback result observation strictly before evaluationTime are committed to dataHash and training.",
    },
  };
};

const predict = (model, row) => {
  if (!model || model.version !== RESIDUAL_MARKET_MODEL_VERSION || model.eligible !== true || !model.parameters) {
    throw new Error("residual market model is not eligible for prediction");
  }
  if (stableHash(model.featureSchema) !== model.featureSchemaHash) {
    throw new Error("residual market model feature schema hash mismatch");
  }
  if (stableHash(modelHashProjection(model)) !== model.modelHash) {
    throw new Error("residual market model hash mismatch");
  }
  const marketProbabilities = normalizeTriplet(row?.marketProbabilities);
  if (!marketProbabilities) throw new TypeError("marketProbabilities must be a finite non-negative triplet");
  const featureResult = extractResidualFeatures(row, marketProbabilities);
  if (!featureResult.valid) throw new TypeError(`invalid residual model input: ${featureResult.reason}`);
  const projection = {
    marketProbabilities,
    residualFeatures: featureResult.features,
  };
  const probabilities = predictProjection(model.parameters, projection);
  return {
    probabilities: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, round(probabilities[outcome])])),
    marketProbabilities,
    residualFeatures: featureResult.features,
    featurePresence: featureResult.presence,
    modelHash: model.modelHash,
    trainedThrough: model.trainedThrough,
  };
};

const metrics = (rows, model = null) => summarize(rows, (row) => {
  if (model) return predict(model, row).probabilities;
  return firstDefined(row?.probabilities, row?.predictedProbabilities, row?.marketProbabilities);
});

module.exports = {
  DEFAULT_MIN_ROWS,
  FEATURE_NAMES,
  FEATURE_SCHEMA,
  FEATURE_SCHEMA_VERSION,
  OUTCOMES,
  RESIDUAL_MARKET_MODEL_VERSION,
  fit,
  metrics,
  normalizeTriplet,
  predict,
  stableHash,
};
