"use strict";

const {
  HASH_PATTERN,
  stableHash,
} = require("./historicalAsOfFeatureBuilder.cjs");
const {
  buildDynamicGoalStrengthArtifact,
  probabilityAudit,
} = require("./dynamicGoalStrengthModel.cjs");

const HISTORICAL_MARKET_RESEARCH_VERSION = "historical-market-research-shadow-v3";
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const DEFAULT_MODEL_WEIGHTS = Object.freeze([
  -0.2,
  -0.1,
  -0.05,
  0,
  0.05,
  0.1,
  0.2,
  0.35,
  0.5,
  0.75,
  1,
]);
const DEFAULT_TEMPERATURES = Object.freeze([0.8, 0.9, 1, 1.1, 1.25]);
const DEFAULT_OUTCOME_BIAS_STRENGTHS = Object.freeze([0, 0.5, 1]);
const DEFAULT_OUTCOME_BIAS_SHRINKAGE_ROWS = 500;

class HistoricalMarketResearchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HistoricalMarketResearchError";
    this.code = details.code || "HISTORICAL_MARKET_RESEARCH_ERROR";
    Object.assign(this, details);
  }
}

const round = (value, digits = 10) => Number(Number(value).toFixed(digits));

const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? number : null;
};

const canonicalMarketOdds = (event) => {
  const odds = event?.preMatchOdds || {};
  const home = finitePositive(odds.home);
  const draw = finitePositive(odds.draw);
  const away = finitePositive(odds.away);
  if (home === null || draw === null || away === null) return null;
  return { "1": home, X: draw, "2": away };
};

const normalizeTriplet = (triplet) => {
  const values = Object.fromEntries(OUTCOMES.map((key) => [
    key,
    Math.max(1e-12, Number(triplet?.[key]) || 0),
  ]));
  const total = OUTCOMES.reduce((sum, key) => sum + values[key], 0);
  if (!(total > 0)) return { "1": 1 / 3, X: 1 / 3, "2": 1 / 3 };
  const home = values["1"] / total;
  const draw = values.X / total;
  return {
    "1": round(home),
    X: round(draw),
    "2": round(1 - home - draw),
  };
};

const devigOdds = (odds) => normalizeTriplet(Object.fromEntries(
  OUTCOMES.map((key) => [key, 1 / odds[key]]),
));

const candidateId = (modelWeight, temperature, outcomeBiasStrength = 0) => {
  const base = `log-pool-model-${String(modelWeight).replace(".", "_")}`
    + `-temp-${String(temperature).replace(".", "_")}`;
  return outcomeBiasStrength > 0
    ? `${base}-outcome-bias-${String(outcomeBiasStrength).replace(".", "_")}`
    : base;
};

const candidateGrid = (options = {}) => {
  const weights = Array.from(new Set(
    (options.modelWeights || DEFAULT_MODEL_WEIGHTS).map(Number).filter((value) => (
      Number.isFinite(value) && value >= -0.5 && value <= 1
    )),
  )).sort((left, right) => left - right);
  const temperatures = Array.from(new Set(
    (options.temperatures || DEFAULT_TEMPERATURES).map(Number).filter((value) => (
      Number.isFinite(value) && value >= 0.5 && value <= 2
    )),
  )).sort((left, right) => left - right);
  const outcomeBiasStrengths = Array.from(new Set(
    (options.outcomeBiasStrengths || DEFAULT_OUTCOME_BIAS_STRENGTHS)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1),
  )).sort((left, right) => left - right);
  if (!weights.includes(0)) weights.unshift(0);
  if (!weights.some((value) => value > 0)) weights.push(0.1);
  if (!temperatures.includes(1)) temperatures.push(1);
  if (!outcomeBiasStrengths.includes(0)) outcomeBiasStrengths.unshift(0);
  temperatures.sort((left, right) => left - right);
  return weights.flatMap((modelWeight) => temperatures.flatMap((temperature) => (
    outcomeBiasStrengths.map((outcomeBiasStrength) => ({
      id: candidateId(modelWeight, temperature, outcomeBiasStrength),
      calibrationVersion: outcomeBiasStrength > 0
        ? "market-outcome-intercept-calibration-v1"
        : "none",
      outcomeBiasStrength,
      outcomeBiasShrinkageRows: Math.max(
        0,
        Math.trunc(Number(options.outcomeBiasShrinkageRows)
          || DEFAULT_OUTCOME_BIAS_SHRINKAGE_ROWS),
      ),
    modelWeight,
    marketWeight: 1 - modelWeight,
    temperature,
    }))
  )));
};

const logPool = (market, model, candidate) => {
  const inverseTemperature = 1 / candidate.temperature;
  const raw = Object.fromEntries(OUTCOMES.map((key) => {
    const logProbability = candidate.marketWeight * Math.log(Math.max(1e-12, market[key]))
      + candidate.modelWeight * Math.log(Math.max(1e-12, model[key]));
    const outcomeBias = Number(candidate?.outcomeBias?.logOffsets?.[key]) || 0;
    return [key, Math.exp(logProbability * inverseTemperature + outcomeBias)];
  }));
  return normalizeTriplet(raw);
};

const fitOutcomeBias = (rows, candidate) => {
  const strength = Number(candidate?.outcomeBiasStrength) || 0;
  if (!(strength > 0) || !rows.length) return candidate;
  const baseCandidate = {
    ...candidate,
    outcomeBias: null,
  };
  const expected = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  const observed = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of rows) {
    const probabilities = logPool(row.market, row.model, baseCandidate);
    for (const outcome of OUTCOMES) expected[outcome] += probabilities[outcome];
    if (OUTCOMES.includes(row.actual)) observed[row.actual] += 1;
  }
  const shrinkageRows = Math.max(
    0,
    Number(candidate?.outcomeBiasShrinkageRows)
      || DEFAULT_OUTCOME_BIAS_SHRINKAGE_ROWS,
  );
  const logOffsets = Object.fromEntries(OUTCOMES.map((outcome) => {
    const expectedRate = Math.max(1e-12, expected[outcome] / rows.length);
    const shrunkObservedRate = (
      observed[outcome] + shrinkageRows * expectedRate
    ) / (rows.length + shrinkageRows);
    const rawOffset = strength * Math.log(Math.max(1e-12, shrunkObservedRate / expectedRate));
    return [outcome, round(Math.max(-0.5, Math.min(0.5, rawOffset)), 12)];
  }));
  const calibrationBody = {
    version: "market-outcome-intercept-calibration-v1",
    fitRows: rows.length,
    strength,
    shrinkageRows,
    observed,
    expected: Object.fromEntries(OUTCOMES.map((outcome) => [
      outcome,
      round(expected[outcome], 10),
    ])),
    logOffsets,
  };
  return {
    ...candidate,
    outcomeBias: {
      ...calibrationBody,
      fitHash: stableHash(calibrationBody),
    },
  };
};

const metricAccumulator = () => ({ rows: 0, hits: 0, brier: 0, logLoss: 0 });

const addMetricRow = (accumulator, probabilities, actual) => {
  const leader = OUTCOMES.slice().sort((left, right) => (
    probabilities[right] - probabilities[left] || left.localeCompare(right)
  ))[0];
  accumulator.rows += 1;
  accumulator.hits += leader === actual ? 1 : 0;
  for (const outcome of OUTCOMES) {
    const target = outcome === actual ? 1 : 0;
    accumulator.brier += (probabilities[outcome] - target) ** 2;
  }
  accumulator.logLoss += -Math.log(Math.max(1e-12, probabilities[actual]));
};

const finalizeMetrics = (accumulator) => {
  if (!accumulator.rows) return { rows: 0, accuracy: null, brier: null, logLoss: null };
  return {
    rows: accumulator.rows,
    accuracy: round(accumulator.hits / accumulator.rows),
    brier: round(accumulator.brier / accumulator.rows),
    logLoss: round(accumulator.logLoss / accumulator.rows),
  };
};

const metricsFor = (rows, probabilitiesFor) => {
  const accumulator = metricAccumulator();
  for (const row of rows) addMetricRow(accumulator, probabilitiesFor(row), row.actual);
  return finalizeMetrics(accumulator);
};

const comparison = (candidate, market) => ({
  rows: Math.min(Number(candidate?.rows || 0), Number(market?.rows || 0)),
  accuracyDelta: candidate?.accuracy === null || market?.accuracy === null
    ? null
    : round(candidate.accuracy - market.accuracy),
  brierImprovement: candidate?.brier === null || market?.brier === null
    ? null
    : round(market.brier - candidate.brier),
  logLossImprovement: candidate?.logLoss === null || market?.logLoss === null
    ? null
    : round(market.logLoss - candidate.logLoss),
});

const canonicalAvailability = (event) => ({
  explicitObservation: event?.availabilityProvenance?.explicitObservation === true,
  policyVersion: String(event?.availabilityProvenance?.policyVersion || "unknown"),
  source: String(event?.availabilityProvenance?.source || "unknown"),
  strictPromotionEligible: event?.availabilityProvenance?.strictPromotionEligible === true,
});

const buildResearchRows = (events, dynamicArtifact) => {
  const sourceById = new Map(events.map((event) => [event.sourceEventId, event]));
  const labelById = new Map(dynamicArtifact.featureArtifact.labels.map((label) => [label.sourceEventId, label]));
  return dynamicArtifact.featureArtifact.snapshots.map((snapshot) => {
    const event = sourceById.get(snapshot.sourceEventId);
    const label = labelById.get(snapshot.sourceEventId);
    const odds = canonicalMarketOdds(event);
    if (!event || !label || !odds) return null;
    const market = devigOdds(odds);
    const model = normalizeTriplet(snapshot.probabilities?.final);
    if (!probabilityAudit(market).valid || !probabilityAudit(model).valid) return null;
    return {
      sourceEventId: snapshot.sourceEventId,
      sourceDataset: event.sourceDataset || "unknown",
      date: snapshot.forecastDate,
      availableAt: label.availableAt,
      competition: snapshot.match?.competition || event.competition || "unknown",
      actual: label.outcome,
      odds,
      market,
      model,
      stateWatermark: snapshot.stateWatermark,
      featureHash: snapshot.featureHash,
      labelHash: label.labelHash,
      availability: canonicalAvailability(event),
    };
  }).filter(Boolean).sort((left, right) => (
    left.date.localeCompare(right.date) || left.sourceEventId.localeCompare(right.sourceEventId)
  ));
};

const groupRowsByDate = (rows) => {
  const groups = [];
  for (const row of rows) {
    const previous = groups[groups.length - 1];
    if (previous?.date === row.date) previous.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  }
  return groups;
};

const selectionSplit = (rows) => {
  const groups = groupRowsByDate(rows);
  const minimumFitRows = Math.min(
    Math.max(100, Math.floor(rows.length * 0.6)),
    Math.max(1, rows.length - 1),
  );
  const targetValidationRows = Math.max(50, Math.floor(rows.length * 0.2));
  let validationRows = [];
  let splitIndex = groups.length;
  while (
    splitIndex > 0
    && validationRows.length < targetValidationRows
    && rows.length - validationRows.length > minimumFitRows
  ) {
    const candidate = groups[splitIndex - 1].rows;
    if (rows.length - validationRows.length - candidate.length < minimumFitRows) break;
    validationRows = candidate.concat(validationRows);
    splitIndex -= 1;
  }
  if (!validationRows.length) return null;
  const fitPool = groups.slice(0, splitIndex).flatMap((group) => group.rows);
  const boundary = Date.parse(`${validationRows[0].date}T00:00:00.000Z`);
  const fitRows = fitPool.filter(row => Date.parse(row.availableAt) < boundary);
  // Never fall back to a row split that divides a date batch. Results from
  // earlier matches must also have been available before inner validation.
  if (fitRows.length < minimumFitRows || !fitRows.length) return null;
  return { fitRows, validationRows, unavailableFitRows: fitPool.length - fitRows.length };
};

const fitCandidateGrid = (rows, grid) => grid.map((candidate) => (
  fitOutcomeBias(rows, candidate)
));

const metricsByCandidate = (rows, grid) => new Map(grid.map((candidate) => [
  candidate.id,
  metricsFor(rows, (row) => logPool(row.market, row.model, candidate)),
]));

const candidateScore = (metrics) => Number.isFinite(metrics?.logLoss) && Number.isFinite(metrics?.brier)
  ? metrics.logLoss + 0.5 * metrics.brier : Infinity;

const pickCandidate = ({ grid, metrics, requireModel = false }) => {
  const marketCandidate = grid.find((candidate) => (
    candidate.modelWeight === 0
    && candidate.temperature === 1
    && candidate.outcomeBiasStrength === 0
  ));
  if (!marketCandidate) throw new HistoricalMarketResearchError("candidate grid must contain the raw market baseline");
  const marketMetrics = metrics.get(marketCandidate.id);
  const eligible = grid.filter((candidate) => {
    if (requireModel && !(candidate.modelWeight > 0)) return false;
    const candidateMetrics = metrics.get(candidate.id);
    return candidateMetrics?.rows > 0
      && candidateMetrics.brier <= marketMetrics.brier
      && candidateMetrics.logLoss <= marketMetrics.logLoss;
  });
  const fallbackPool = requireModel
    ? grid.filter((candidate) => candidate.modelWeight > 0)
    : [marketCandidate];
  const pool = eligible.length ? eligible : fallbackPool;
  return pool.slice().sort((left, right) => (
    candidateScore(metrics.get(left.id)) - candidateScore(metrics.get(right.id))
      || Math.abs(left.modelWeight) - Math.abs(right.modelWeight)
      || left.modelWeight - right.modelWeight
      || left.outcomeBiasStrength - right.outcomeBiasStrength
      || Math.abs(left.temperature - 1) - Math.abs(right.temperature - 1)
      || left.id.localeCompare(right.id)
  ))[0];
};

const nestedWalkForward = (rows, options = {}) => {
  const seen = new Set();
  for (const row of rows) {
    if (!row?.sourceEventId || seen.has(row.sourceEventId)) throw new HistoricalMarketResearchError("research rows must contain one revision per event", { code: "DUPLICATE_RESEARCH_EVENT" });
    seen.add(row.sourceEventId);
    const date = Date.parse(`${row.date}T00:00:00.000Z`), available = Date.parse(row.availableAt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || "") || !Number.isFinite(date)
      || new Date(date).toISOString().slice(0, 10) !== row.date || !Number.isFinite(available) || available <= date) {
      throw new HistoricalMarketResearchError("research rows require a valid result availability clock after the event date", { code: "INVALID_RESEARCH_AVAILABILITY" });
    }
  }
  rows = rows.slice().sort((a, b) => a.date.localeCompare(b.date) || a.sourceEventId.localeCompare(b.sourceEventId));
  const minimumTrainingRows = Math.max(100, Math.trunc(Number(options.minimumTrainingRows) || 5000));
  const holdoutRows = Math.max(50, Math.trunc(Number(options.holdoutRows) || 2000));
  const minimumFolds = Math.max(2, Math.trunc(Number(options.minimumFolds) || 6));
  const grid = candidateGrid(options);
  const dateGroups = groupRowsByDate(rows);
  let groupIndex = 0;
  let trainingRows = [];
  while (groupIndex < dateGroups.length && trainingRows.length < minimumTrainingRows) {
    trainingRows = trainingRows.concat(dateGroups[groupIndex].rows);
    groupIndex += 1;
  }
  const folds = [];
  const skippedWindows = [];
  const selectedRows = [];
  const selectedModelRows = [];
  const marketRows = [];
  const dynamicRows = [];

  while (groupIndex < dateGroups.length) {
    const windowGroups = [];
    let holdout = [];
    while (groupIndex < dateGroups.length && holdout.length < holdoutRows) {
      windowGroups.push(dateGroups[groupIndex]);
      holdout = holdout.concat(dateGroups[groupIndex].rows);
      groupIndex += 1;
    }
    if (holdout.length < holdoutRows) {
      skippedWindows.push({ startDate: holdout[0]?.date || null, endDate: holdout.at(-1)?.date || null, rows: holdout.length, reason: "holdout-rows-insufficient" });
      break;
    }
    const boundary = Date.parse(`${holdout[0].date}T00:00:00.000Z`);
    const availableTraining = trainingRows.filter(row => Date.parse(row.availableAt) < boundary);
    const selectionRows = availableTraining.length >= minimumTrainingRows ? selectionSplit(availableTraining) : null;
    if (!selectionRows) {
      skippedWindows.push({ startDate: holdout[0].date, endDate: holdout.at(-1).date, rows: holdout.length,
        reason: availableTraining.length < minimumTrainingRows ? "available-training-rows-insufficient" : "inner-date-split-insufficient",
        availableTrainingRows: availableTraining.length, unavailableTrainingRows: trainingRows.length - availableTraining.length });
      trainingRows = trainingRows.concat(holdout);
      continue;
    }
    const selectionGrid = fitCandidateGrid(selectionRows.fitRows, grid);
    const selectionMetrics = metricsByCandidate(selectionRows.validationRows, selectionGrid);
    const selectedForRefit = pickCandidate({
      grid: selectionGrid,
      metrics: selectionMetrics,
    });
    const selectedModelForRefit = pickCandidate({
      grid: selectionGrid,
      metrics: selectionMetrics,
      requireModel: true,
    });
    const selected = fitOutcomeBias(
      availableTraining,
      grid.find((candidate) => candidate.id === selectedForRefit.id),
    );
    const selectedModel = fitOutcomeBias(
      availableTraining,
      grid.find((candidate) => candidate.id === selectedModelForRefit.id),
    );
    const marketMetrics = metricsFor(holdout, (row) => row.market);
    const dynamicMetrics = metricsFor(holdout, (row) => row.model);
    const selectedMetrics = metricsFor(holdout, (row) => logPool(row.market, row.model, selected));
    const selectedModelMetrics = metricsFor(holdout, (row) => logPool(row.market, row.model, selectedModel));
    const predictionCommitments = holdout.map((row) => ({
      sourceEventId: row.sourceEventId,
      featureHash: row.featureHash,
      labelHash: row.labelHash,
      selectedCandidateId: selected.id,
      selectedProbabilities: logPool(row.market, row.model, selected),
      selectedModelCandidateId: selectedModel.id,
      selectedModelProbabilities: logPool(row.market, row.model, selectedModel),
    }));
    const foldBody = {
      fold: folds.length + 1,
      training: {
        rows: availableTraining.length,
        excludedUnavailableRows: trainingRows.length - availableTraining.length,
        latestAvailableAt: new Date(Math.max(...availableTraining.map(row => Date.parse(row.availableAt)))).toISOString(),
        startDate: availableTraining[0]?.date || null,
        endDate: availableTraining.at(-1)?.date || null,
        rootHash: stableHash(availableTraining.map((row) => `${row.sourceEventId}:${row.featureHash}:${row.labelHash}`)),
      },
      window: {
        rows: holdout.length,
        dateBatches: windowGroups.length,
        startDate: windowGroups[0].date,
        endDate: windowGroups.at(-1).date,
      },
      selection: {
        policy: "whole-date chronological validation; fit labels available strictly before validation; refit only labels available strictly before holdout; require both Brier and Log Loss non-worse than raw no-vig market; ties prefer lower model weight and weaker calibration",
        fit: {
          rows: selectionRows.fitRows.length,
          excludedUnavailableRows: selectionRows.unavailableFitRows,
          latestAvailableAt: new Date(Math.max(...selectionRows.fitRows.map(row => Date.parse(row.availableAt)))).toISOString(),
          startDate: selectionRows.fitRows[0]?.date || null,
          endDate: selectionRows.fitRows.at(-1)?.date || null,
          rootHash: stableHash(selectionRows.fitRows.map((row) => (
            `${row.sourceEventId}:${row.featureHash}:${row.labelHash}`
          ))),
        },
        validation: {
          rows: selectionRows.validationRows.length,
          latestAvailableAt: new Date(Math.max(...selectionRows.validationRows.map(row => Date.parse(row.availableAt)))).toISOString(),
          startDate: selectionRows.validationRows[0]?.date || null,
          endDate: selectionRows.validationRows.at(-1)?.date || null,
          rootHash: stableHash(selectionRows.validationRows.map((row) => (
            `${row.sourceEventId}:${row.featureHash}:${row.labelHash}`
          ))),
        },
        selectedCandidate: selected,
        selectedModelCandidate: selectedModel,
        validationMarketMetrics: selectionMetrics.get(candidateId(0, 1, 0)),
        selectedValidationMetrics: selectionMetrics.get(selected.id),
        selectedModelValidationMetrics: selectionMetrics.get(selectedModel.id),
      },
      metrics: {
        market: marketMetrics,
        dynamicModel: dynamicMetrics,
        selected: selectedMetrics,
        selectedModel: selectedModelMetrics,
      },
      comparisons: {
        dynamicVsMarket: comparison(dynamicMetrics, marketMetrics),
        selectedVsMarket: comparison(selectedMetrics, marketMetrics),
        selectedModelVsMarket: comparison(selectedModelMetrics, marketMetrics),
      },
      holdoutDataHash: stableHash(predictionCommitments),
    };
    folds.push({ ...foldBody, foldManifestHash: stableHash(foldBody) });
    for (const row of holdout) {
      marketRows.push({ ...row, probabilities: row.market });
      dynamicRows.push({ ...row, probabilities: row.model });
      selectedRows.push({ ...row, probabilities: logPool(row.market, row.model, selected) });
      selectedModelRows.push({ ...row, probabilities: logPool(row.market, row.model, selectedModel) });
    }
    trainingRows = trainingRows.concat(holdout);
  }

  const rowMetrics = (values) => metricsFor(values, (row) => row.probabilities);
  const aggregate = {
    market: rowMetrics(marketRows),
    dynamicModel: rowMetrics(dynamicRows),
    selected: rowMetrics(selectedRows),
    selectedModel: rowMetrics(selectedModelRows),
  };
  aggregate.comparisons = {
    dynamicVsMarket: comparison(aggregate.dynamicModel, aggregate.market),
    selectedVsMarket: comparison(aggregate.selected, aggregate.market),
    selectedModelVsMarket: comparison(aggregate.selectedModel, aggregate.market),
  };
  return {
    config: { minimumTrainingRows, holdoutRows, minimumFolds, candidateGrid: grid },
    skippedWindows,
    coverage: { inputRows: rows.length, initialTrainingRows: rows.length - selectedRows.length - skippedWindows.reduce((n, row) => n + row.rows, 0),
      evaluatedRows: selectedRows.length, skippedRows: skippedWindows.reduce((n, row) => n + row.rows, 0) },
    folds,
    aggregate,
    status: folds.length >= minimumFolds ? "evaluated-research-shadow" : "blocked-research-shadow",
    blockers: folds.length >= minimumFolds ? [] : [`research-folds:${folds.length}<${minimumFolds}`],
  };
};

const leagueSlices = (rows, minimumRows = 200) => Object.fromEntries(
  [...rows.reduce((map, row) => {
    const values = map.get(row.competition) || [];
    values.push(row);
    map.set(row.competition, values);
    return map;
  }, new Map()).entries()]
    .filter(([, values]) => values.length >= minimumRows)
    .map(([competition, values]) => {
      const market = metricsFor(values, (row) => row.market);
      const dynamicModel = metricsFor(values, (row) => row.model);
      return [competition, { rows: values.length, market, dynamicModel, comparison: comparison(dynamicModel, market) }];
    })
    .sort((left, right) => right[1].rows - left[1].rows || left[0].localeCompare(right[0]))
    .slice(0, 50),
);

function buildHistoricalMarketResearch(events, options = {}) {
  const eligibleEvents = (Array.isArray(events) ? events : [])
    .filter((event) => canonicalMarketOdds(event))
    .slice()
    .sort((left, right) => (
      String(left?.date || "").localeCompare(String(right?.date || ""))
        || String(left?.sourceEventId || "").localeCompare(String(right?.sourceEventId || ""))
    ));
  if (eligibleEvents.length < 100) {
    throw new HistoricalMarketResearchError("at least 100 full-odds historical events are required", {
      code: "INSUFFICIENT_RESEARCH_ROWS",
      rows: eligibleEvents.length,
    });
  }
  const dynamicArtifact = buildDynamicGoalStrengthArtifact(eligibleEvents, {
    config: options.modelConfig || options.config?.modelConfig || {},
  });
  const rows = buildResearchRows(eligibleEvents, dynamicArtifact)
    .filter((row) => Number(row.stateWatermark?.consumedRows || 0) >= Math.max(
      1,
      Math.trunc(Number(options.minimumModelTrainingRows) || 80),
    ));
  const walkForward = nestedWalkForward(rows, options);
  const derivedAvailabilityRows = rows.filter((row) => row.availability.explicitObservation !== true).length;
  const strictPromotionEligibleRows = rows.filter((row) => row.availability.strictPromotionEligible === true).length;
  const inputCommitments = eligibleEvents.map((event) => ({
    sourceEventId: event.sourceEventId,
    odds: canonicalMarketOdds(event),
    availableAt: event.availableAt,
    availability: canonicalAvailability(event),
  }));
  const body = {
    version: HISTORICAL_MARKET_RESEARCH_VERSION,
    status: walkForward.status,
    researchOnly: true,
    shadowOnly: true,
    productionEligible: false,
    strictPromotionEligible: false,
    source: {
      dataset: eligibleEvents[0]?.sourceDataset || "unknown",
      url: "https://github.com/xgabora/Club-Football-Match-Data-2000-2025",
      rights: {
        repositoryDeclaredLicense: "MIT",
        upstreamSources: ["Football-Data.co.uk", "ClubElo"],
        permittedUse: "research-and-model-evaluation-only",
        redistributionAllowed: "unverified",
        rightsStatus: "upstream-terms-review-required-before-commercial-redistribution",
      },
      inputRows: eligibleEvents.length,
      evaluatedRows: rows.length,
      firstDate: eligibleEvents[0]?.date || null,
      lastDate: eligibleEvents.at(-1)?.date || null,
      inputRootHash: stableHash(inputCommitments),
      marketOddsPolicy: "dataset-declared pre-match odds; provider observation timestamp is unavailable",
    },
    model: {
      version: dynamicArtifact.version,
      artifactHash: dynamicArtifact.artifactHash,
      modelHash: dynamicArtifact.model.modelHash,
      featureArtifactHash: dynamicArtifact.featureArtifact.artifactHash,
      config: dynamicArtifact.model.config,
    },
    evidenceBoundary: {
      derivedAvailabilityRows,
      strictPromotionEligibleRows,
      marketOddsObservedAtCoverage: 0,
      sourceCycleIdCoverage: 0,
      blockers: [
        "historical-market-observed-at-missing",
        "historical-market-received-at-missing",
        "historical-market-source-cycle-id-missing",
        "result-availability-derived",
        "research-dataset-not-production-decision-snapshot",
      ],
    },
    walkForward,
    leagueSlices: leagueSlices(rows, Number(options.minimumLeagueRows) || 200),
  };
  return { ...body, manifestHash: stableHash(body) };
}

function verifyHistoricalMarketResearch(artifact) {
  try {
    if (!artifact || artifact.version !== HISTORICAL_MARKET_RESEARCH_VERSION) return false;
    if (artifact.researchOnly !== true || artifact.shadowOnly !== true) return false;
    if (artifact.productionEligible !== false || artifact.strictPromotionEligible !== false) return false;
    if (!HASH_PATTERN.test(String(artifact.manifestHash || ""))) return false;
    const { manifestHash: _manifestHash, ...body } = artifact;
    if (stableHash(body) !== artifact.manifestHash) return false;
    if (!(artifact.source?.inputRows >= artifact.source?.evaluatedRows)) return false;
    if (artifact.evidenceBoundary?.strictPromotionEligibleRows !== 0) return false;
    if (!Array.isArray(artifact.evidenceBoundary?.blockers) || artifact.evidenceBoundary.blockers.length < 4) return false;
    if (!Array.isArray(artifact.walkForward?.folds)) return false;
    for (const fold of artifact.walkForward.folds) {
      const { foldManifestHash: _foldHash, ...foldBody } = fold;
      if (stableHash(foldBody) !== fold.foldManifestHash) return false;
      if (!(fold.training?.endDate < fold.window?.startDate)) return false;
      if (!(fold.selection?.fit?.endDate < fold.selection?.validation?.startDate)) return false;
      if (!(fold.selection?.validation?.endDate <= fold.training.endDate)) return false;
      if (!(Date.parse(fold.selection.fit.latestAvailableAt) < Date.parse(`${fold.selection.validation.startDate}T00:00:00.000Z`))) return false;
      if (!(Date.parse(fold.training.latestAvailableAt) < Date.parse(`${fold.window.startDate}T00:00:00.000Z`))) return false;
      if (!(Date.parse(fold.selection.validation.latestAvailableAt) < Date.parse(`${fold.window.startDate}T00:00:00.000Z`))) return false;
      if (!(fold.window?.rows >= artifact.walkForward.config.holdoutRows)) return false;
      if (!fold.selection?.selectedCandidate || !fold.selection?.selectedModelCandidate) return false;
    }
    if (artifact.status === "evaluated-research-shadow"
        && artifact.walkForward.folds.length < artifact.walkForward.config.minimumFolds) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_MODEL_WEIGHTS,
  DEFAULT_OUTCOME_BIAS_SHRINKAGE_ROWS,
  DEFAULT_OUTCOME_BIAS_STRENGTHS,
  DEFAULT_TEMPERATURES,
  HISTORICAL_MARKET_RESEARCH_VERSION,
  HistoricalMarketResearchError,
  buildHistoricalMarketResearch,
  candidateGrid,
  canonicalMarketOdds,
  comparison,
  devigOdds,
  fitOutcomeBias,
  logPool,
  metricsFor,
  nestedWalkForward,
  verifyHistoricalMarketResearch,
};
