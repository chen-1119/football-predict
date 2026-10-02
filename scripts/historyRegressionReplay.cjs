"use strict";

// This consumes records admitted by historyRegressionEvidence.cjs/the caller.
// It does not reconstruct original forecasts or promote a production model.
// Existing dynamicGoalStrengthModel.cjs supplies Elo/Poisson/Dixon-Coles via an
// adapter; walkForwardValidation.cjs owns promotion. Neither is duplicated here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const OUTCOMES = Object.freeze(["home", "draw", "away"]);
const VERSION = "history-regression-replay-v1";
const EPSILON = 1e-15;
const PROBABILITY_ROUNDING_TOLERANCE = 1e-5;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freezeCopy(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const visit = (object) => {
    if (object && typeof object === "object") {
      Object.values(object).forEach(visit);
      Object.freeze(object);
    }
    return object;
  };
  return visit(copy);
}

function instant(value, field) {
  assert(typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value), `${field}: explicit timezone required`);
  const number = Date.parse(value);
  assert(Number.isFinite(number), `${field}: invalid timestamp`);
  return number;
}

function offsetFor(timeZone) {
  assert(["UTC", "Asia/Shanghai"].includes(timeZone), "timeZone must be UTC or Asia/Shanghai (explicit fixed calendar boundary)");
  return timeZone === "UTC" ? 0 : 480;
}

function dayBoundary(day, offset) {
  assert(typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day), "window dates must be YYYY-MM-DD");
  const utc = Date.parse(`${day}T00:00:00Z`);
  assert(Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === day, `invalid window date: ${day}`);
  return utc - offset * 60000;
}

function matchDay(row, offset) {
  return new Date(instant(row.kickoffAt, "kickoffAt") + offset * 60000).toISOString().slice(0, 10);
}

function probabilities(value) {
  assert(value && OUTCOMES.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1), "invalid probability triplet");
  const total = OUTCOMES.reduce((sum, key) => sum + value[key], 0);
  assert(Math.abs(total - 1) <= PROBABILITY_ROUNDING_TOLERANCE, "probabilities must sum to 1 within declared rounding tolerance");
  return Object.fromEntries(OUTCOMES.map((key) => [key, value[key] / total]));
}

function marketProbabilities(row) {
  const sp = row.officialOdds?.sp;
  assert(sp && OUTCOMES.every((key) => typeof sp[key] === "number" && Number.isFinite(sp[key]) && sp[key] > 1), "invalid official SP triplet");
  const total = OUTCOMES.reduce((sum, key) => sum + 1 / sp[key], 0);
  return Object.fromEntries(OUTCOMES.map((key) => [key, (1 / sp[key]) / total]));
}

function score(probability, actual) {
  const p = probabilities(probability);
  assert(OUTCOMES.includes(actual), "invalid HAD outcome");
  const predicted = OUTCOMES.reduce((best, key) => p[key] > p[best] ? key : best, "home");
  return {
    brier: OUTCOMES.reduce((sum, key) => sum + (p[key] - Number(key === actual)) ** 2, 0),
    logLoss: -Math.log(Math.max(EPSILON, p[actual])),
    accuracy: Number(predicted === actual),
  };
}

function summarize(rows, predictionKey, denominator = rows.length) {
  const included = rows.filter((row) => row.predictions[predictionKey]);
  const totals = { brier: 0, logLoss: 0, accuracy: 0 };
  const reliability = Object.fromEntries(OUTCOMES.map((key) => [key, Array.from({ length: 10 }, (_, bin) => ({ lower: bin / 10, upper: (bin + 1) / 10, n: 0, probabilitySum: 0, positive: 0 }))]));
  for (const row of included) {
    const p = row.predictions[predictionKey];
    const metrics = score(p, row.actual);
    for (const key of Object.keys(totals)) totals[key] += metrics[key];
    for (const key of OUTCOMES) {
      const bin = reliability[key][Math.min(9, Math.floor(p[key] * 10))];
      bin.n += 1;
      bin.probabilitySum += p[key];
      bin.positive += Number(row.actual === key);
    }
  }
  for (const bins of Object.values(reliability)) {
    for (const bin of bins) {
      bin.meanProbability = bin.n ? bin.probabilitySum / bin.n : null;
      bin.observedFrequency = bin.n ? bin.positive / bin.n : null;
      delete bin.probabilitySum;
    }
  }
  return {
    n: included.length, denominator, coverage: denominator ? included.length / denominator : null,
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, included.length ? value / included.length : null])),
    reliability,
  };
}

function missingFeature(value) {
  return value === null || value === undefined || value?.missing === true || value?.available === false
    || ["missing", "unavailable", "unknown", "excluded"].includes(value?.status);
}

function declaredFeatureKeys(records, specified) {
  if (specified) {
    assert(Array.isArray(specified) && specified.every((key) => typeof key === "string" && key), "featureKeys must be an array of nonempty strings");
    return [...new Set(specified)].sort();
  }
  return [...new Set(records.flatMap((row) => {
    const f = row.features ?? {};
    if (f.groups && typeof f.groups === "object") return Object.keys(f.groups);
    if (f.values && typeof f.values === "object") return Object.keys(f.values);
    return Object.keys(f).filter((key) => !["candidateEligible", "missing", "present", "bound", "timeValid", "capturedAt", "blocker", "xgPolicy"].includes(key));
  }))].sort();
}

function featureIsMissing(row, key) {
  const features = row.features ?? {};
  if (Array.isArray(features.missing) && features.missing.includes(key)) return true;
  return missingFeature(features.groups?.[key] ?? features.values?.[key] ?? features[key]);
}

function auditedFeatures(row, requiredFeatures = []) {
  if (!requiredFeatures.length) return {};
  assert(row.features?.candidateEligible !== false, "features-declared-ineligible-for-candidate-replay");
  const result = {};
  for (const key of requiredFeatures) {
    assert(!/(?:^|[_-])(result|outcome|finalscore|closing|postmatch)(?:$|[_-])/i.test(key), `forbidden feature: ${key}`);
    const feature = row.features?.values?.[key] ?? row.features?.[key];
    assert(feature && (typeof feature.value === "boolean" || (typeof feature.value === "number" && Number.isFinite(feature.value))), `audited numeric/boolean feature missing: ${key}`);
    assert(typeof feature.source === "string" && feature.source && /^[a-f0-9]{64}$/.test(feature.payloadSha256 ?? ""), `feature source/hash missing: ${key}`);
    assert(instant(feature.availableAt, `features.${key}.availableAt`) <= instant(row.decision.at, "decision.at"), `feature unavailable at decision: ${key}`);
    // No arbitrary nested fields, scores, or later observations are passed on.
    result[key] = { value: feature.value, availableAt: feature.availableAt, source: feature.source, payloadSha256: feature.payloadSha256 };
  }
  return result;
}

function oddsBand(row) {
  const favorite = Math.min(...OUTCOMES.map((key) => row.officialOdds.sp[key]));
  return favorite < 1.5 ? "[1,1.5)" : favorite < 2 ? "[1.5,2)" : favorite < 3 ? "[2,3)" : "[3,infinity)";
}

function groupedMetrics(rows, key) {
  const group = (getKey) => {
    const map = new Map();
    for (const row of rows) {
      const value = getKey(row);
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(row);
    }
    return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([value, groupRows]) => [value, summarize(groupRows, key)]));
  };
  const featureNames = [...new Set(rows.flatMap((row) => Object.keys(row.featureMissing)))].sort();
  return {
    league: group((row) => row.league), actualOutcome: group((row) => row.actual),
    favoriteSpBand: group((row) => row.favoriteSpBand),
    featureCoverage: group((row) => row.missingFeatureCount ? "missing-one-or-more" : "complete-declared-features"),
    featureMissing: Object.fromEntries(featureNames.map((feature) => [feature, group((row) => row.featureMissing[feature] ? "missing" : "present")])),
  };
}

function pairedDayBootstrap(rows, leftKey, rightKey, options = {}) {
  const iterations = options.iterations ?? 2000;
  const minBlocks = options.minBlocks ?? 10;
  const minRows = options.minRows ?? 30;
  assert(Number.isInteger(iterations) && iterations >= 200 && iterations <= 10000, "bootstrap iterations must be 200..10000");
  assert(Number.isInteger(minBlocks) && minBlocks >= 2, "bootstrap minBlocks must be >=2");
  assert(Number.isInteger(minRows) && minRows >= 2, "bootstrap minRows must be >=2");
  const paired = rows.filter((row) => row.predictions[leftKey] && row.predictions[rightKey]);
  const days = new Map();
  const total = { brier: 0, logLoss: 0, accuracy: 0 };
  for (const row of paired) {
    const left = score(row.predictions[leftKey], row.actual);
    const right = score(row.predictions[rightKey], row.actual);
    if (!days.has(row.matchDay)) days.set(row.matchDay, { n: 0, brier: 0, logLoss: 0, accuracy: 0 });
    const day = days.get(row.matchDay);
    day.n += 1;
    for (const key of Object.keys(total)) {
      const delta = left[key] - right[key];
      total[key] += delta;
      day[key] += delta;
    }
  }
  const eligible = days.size >= minBlocks && paired.length >= minRows;
  const result = {
    left: leftKey, right: rightKey, pairedRows: paired.length, matchDayBlocks: days.size,
    method: "paired match-day cluster percentile bootstrap; resampled whole days, match-weighted mean",
    deltaConvention: "left minus right; lower Brier/LogLoss and higher accuracy are better",
    iterations, seed: options.seed ?? 104729, minBlocks, minRows, intervalLevel: 0.95,
    intervalAvailable: eligible,
    insufficientReason: eligible ? null : "insufficient-independent-match-days-or-paired-rows",
    metrics: Object.fromEntries(Object.keys(total).map((key) => [key, { delta: paired.length ? total[key] / paired.length : null, interval: null }])),
    promotionEvidence: false,
  };
  assert(Number.isSafeInteger(result.seed) && result.seed >= 0 && result.seed <= 0xffffffff, "bootstrap seed must be an unsigned 32-bit integer");
  if (!eligible) return result;
  let state = (result.seed >>> 0) || 1;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const blocks = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const samples = Object.fromEntries(Object.keys(total).map((key) => [key, []]));
  for (let i = 0; i < iterations; i += 1) {
    const aggregate = { n: 0, brier: 0, logLoss: 0, accuracy: 0 };
    for (let j = 0; j < blocks.length; j += 1) {
      const block = blocks[Math.floor(random() * blocks.length)];
      for (const key of Object.keys(aggregate)) aggregate[key] += block[key];
    }
    for (const key of Object.keys(total)) samples[key].push(aggregate[key] / aggregate.n);
  }
  for (const key of Object.keys(total)) {
    samples[key].sort((a, b) => a - b);
    result.metrics[key].interval = [samples[key][Math.floor(iterations * 0.025)], samples[key][Math.min(iterations - 1, Math.ceil(iterations * 0.975) - 1)]];
  }
  return result;
}

function validateRecords(records, offset) {
  assert(Array.isArray(records), "records must be an array of upstream-admitted evidence records");
  assert(records.length <= 500, "first-batch maximum is 500 distinct settled matches");
  const keys = new Set();
  for (const row of records) {
    assert(row && typeof row.matchId === "string" && row.matchId.trim(), "matchId must be a nonempty string");
    assert(row.market === "HAD", "only HAD is supported; markets must not be mixed");
    const key = `${row.matchId}:${row.market}`;
    assert(!keys.has(key), `duplicate match/market requires upstream resolution: ${key}`);
    keys.add(key);
    const kickoff = instant(row.kickoffAt, "kickoffAt");
    const decision = instant(row.decision?.at, "decision.at");
    assert(typeof row.decision?.id === "string" && row.decision.id, "frozen decision id required");
    assert(typeof row.decision?.modelVersion === "string" && row.decision.modelVersion, "frozen model version required");
    assert(decision < kickoff, "decision must be strictly prematch");
    assert(instant(row.result?.observedAt, "result.observedAt") >= kickoff, "result observed before kickoff");
    assert(OUTCOMES.includes(row.result?.outcome), "settled HAD outcome required");
    probabilities(row.decision.probabilities);
    marketProbabilities(row);
    matchDay(row, offset);
  }
}

function normalizeWindow(window, offset, label) {
  assert(window && typeof window === "object", `${label} window required`);
  const startMs = dayBoundary(window.start, offset);
  const endMs = dayBoundary(window.end, offset);
  assert(startMs < endMs, `${label} must be a nonempty half-open window`);
  return { start: window.start, end: window.end, startMs, endMs };
}

function within(row, window, offset) {
  const day = dayBoundary(matchDay(row, offset), offset);
  return day >= window.startMs && day < window.endMs;
}

function readyDays(rows, boundary, offset, stage, exclusions) {
  const lateDays = new Set(rows.filter((row) => instant(row.result.observedAt, "result.observedAt") >= boundary).map((row) => matchDay(row, offset)));
  return rows.filter((row) => {
    if (!lateDays.has(matchDay(row, offset))) return true;
    exclusions.push({ matchId: row.matchId, market: row.market, matchDay: matchDay(row, offset), stage, reason: "whole-match-day-has-result-unavailable-at-next-decision-boundary", requiredBefore: new Date(boundary).toISOString() });
    return false;
  });
}

function predictionBoundary(rows, window) {
  return Math.min(window.startMs, ...rows.map((row) => instant(row.decision.at, "decision.at")));
}

function predictInput(row, requiredFeatures = []) {
  // No outcome, result observation, later closing price, or arbitrary top-level
  // payload is handed to prediction adapters. Feature as-of proof is upstream.
  return freezeCopy({
    matchId: row.matchId, market: row.market,
    league: String(typeof row.league === "object" ? row.league?.name ?? row.league?.id ?? "unknown" : row.league ?? "unknown"),
    kickoffAt: row.kickoffAt,
    decision: { id: row.decision.id, at: row.decision.at, modelVersion: row.decision.modelVersion, probabilities: probabilities(row.decision.probabilities) },
    officialOdds: { sp: Object.fromEntries(OUTCOMES.map((key) => [key, row.officialOdds.sp[key]])) },
    features: auditedFeatures(row, requiredFeatures),
  });
}

function labeledInput(row, requiredFeatures = []) {
  return freezeCopy({ ...predictInput(row, requiredFeatures), result: { outcome: row.result.outcome, observedAt: row.result.observedAt } });
}

function syncCall(fn, ...args) {
  const result = fn(...args);
  assert(!(result && typeof result.then === "function"), "plugins must be synchronous pure functions");
  return result;
}

const frequencyBaseline = Object.freeze({
  id: "training-frequency-laplace-v1", version: "1", selectable: false, requiresCalibration: false,
  fit(rows) {
    const counts = { home: 1, draw: 1, away: 1 };
    for (const row of rows) counts[row.result.outcome] += 1;
    return Object.fromEntries(OUTCOMES.map((key) => [key, counts[key] / (rows.length + 3)]));
  },
  predict(state) { return state; },
});

function evidenceRows(rows, predictionMaps, featureKeys, offset) {
  return rows.map((row) => {
    const missing = Object.fromEntries(featureKeys.map((key) => [key, featureIsMissing(row, key)]));
    return {
      matchId: row.matchId, market: row.market, matchDay: matchDay(row, offset), kickoffAt: row.kickoffAt,
      decisionId: row.decision.id, decisionAt: row.decision.at, originalModelVersion: row.decision.modelVersion,
      actual: row.result.outcome, resultObservedAt: row.result.observedAt,
      league: String(typeof row.league === "object" ? row.league?.name ?? row.league?.id ?? "unknown" : row.league ?? "unknown"),
      favoriteSpBand: oddsBand(row), featureMissing: missing, missingFeatureCount: Object.values(missing).filter(Boolean).length,
      inputRecordHash: hash(row),
      predictions: { publishedModel: probabilities(row.decision.probabilities), sameDecisionMarket: marketProbabilities(row), ...Object.fromEntries([...predictionMaps].map(([key, map]) => [key, map.get(row.matchId) ?? null])) },
    };
  });
}

function summarizeSet(rows, keys, bootstrap) {
  return {
    rows: rows.length, matchDays: new Set(rows.map((row) => row.matchDay)).size,
    metrics: Object.fromEntries(keys.map((key) => [key, summarize(rows, key)])),
    groups: Object.fromEntries(keys.map((key) => [key, groupedMetrics(rows, key)])),
    pairedAgainstMarket: Object.fromEntries(keys.filter((key) => key !== "sameDecisionMarket").map((key) => [key, pairedDayBootstrap(rows, key, "sameDecisionMarket", bootstrap)])),
  };
}

/**
 * Pure plugin contract:
 * {id, version, implementationHash?, selectable?, requiresCalibration?, requiredFeatures?: string[],
 *  fit(labeledTrainRows, frozenContext) -> JSON state,
 *  calibrate?(state, labeledCalibrationRows, frozenContext) -> JSON state,
 *  predict(state, unlabeledAsOfRow, frozenContext) -> triplet | null}
 * Plugins are trusted audited code, not sandboxed here. They must not read files,
 * network, clocks, global future data, or mutate inputs. State is JSON/frozen.
 * Candidate definitions are fixed before execution; no final-test tuning/refit.
 * Feature plugins must name requiredFeatures. Each features.values[name] (or
 * features[name]) must contain a finite numeric/boolean value, availableAt <=
 * decision.at, nonempty source and payloadSha256. Diagnostic-only features
 * with candidateEligible:false are withheld. No undeclared feature is exposed.
 */
function runHistoryRegressionReplay(records, options = {}) {
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const offset = offsetFor(timeZone);
  validateRecords(records, offset);
  const input = freezeCopy(records).slice().sort((a, b) => instant(a.kickoffAt, "kickoffAt") - instant(b.kickoffAt, "kickoffAt") || a.matchId.localeCompare(b.matchId));
  const rawFolds = options.folds ?? [{ id: "fixed-1", ...options.windows }];
  assert(Array.isArray(rawFolds) && rawFolds.length > 0, "at least one explicit fold is required");
  const finalWindow = normalizeWindow(options.finalTest ?? options.windows?.finalTest, offset, "finalTest");
  const foldIds = new Set();
  const folds = rawFolds.map((fold, index) => {
    const id = fold.id ?? `fold-${index + 1}`;
    assert(typeof id === "string" && id && !foldIds.has(id), "fold ids must be unique");
    foldIds.add(id);
    const windows = Object.fromEntries(["train", "calibration", "validation"].map((key) => [key, normalizeWindow(fold[key], offset, `${id}.${key}`)]));
    assert(windows.train.endMs <= windows.calibration.startMs && windows.calibration.endMs <= windows.validation.startMs && windows.validation.endMs <= finalWindow.startMs, "train/calibration/validation/finalTest windows must be ordered and non-overlapping");
    return { id, windows };
  });
  for (let i = 1; i < folds.length; i += 1) {
    assert(folds[i - 1].windows.validation.endMs <= folds[i].windows.validation.startMs, "rolling validation days must advance without overlap");
    assert(folds[i - 1].windows.train.endMs <= folds[i].windows.train.endMs && folds[i - 1].windows.calibration.endMs <= folds[i].windows.calibration.endMs, "rolling training/calibration cutoffs must advance");
  }
  const min = { training: 30, calibration: 20, validation: 30, finalTest: 30, ...options.minimumRows };
  for (const [key, value] of Object.entries(min)) assert(Number.isInteger(value) && value >= 1, `minimumRows.${key} must be >=1`);
  const plugins = [frequencyBaseline, ...(options.candidates ?? [])];
  const pluginIds = new Set(["publishedModel", "sameDecisionMarket"]);
  for (const plugin of plugins) {
    assert(typeof plugin.id === "string" && /^[a-zA-Z0-9._-]+$/.test(plugin.id) && !pluginIds.has(plugin.id), "unique safe plugin id required");
    pluginIds.add(plugin.id);
    assert(typeof plugin.version === "string" && plugin.version && typeof plugin.fit === "function" && typeof plugin.predict === "function", "plugin version/fit/predict required");
    assert(!plugin.requiresCalibration || typeof plugin.calibrate === "function", "calibration required but adapter missing");
    assert(plugin.requiredFeatures === undefined || (Array.isArray(plugin.requiredFeatures) && plugin.requiredFeatures.every((key) => typeof key === "string" && key)), "plugin requiredFeatures must be string names");
  }
  const keys = [...pluginIds];
  const featureKeys = declaredFeatureKeys(input, options.featureKeys);
  const finalRows = input.filter((row) => within(row, finalWindow, offset));
  const finalBoundary = predictionBoundary(finalRows, finalWindow);
  const protocol = {
    timeZone, windowSemantics: "half-open whole kickoff-calendar days; outcomes must be observed strictly before next stage's earliest decision/start",
    folds, finalTest: finalWindow, minimumRows: min, featureKeys,
    selection: "pooled past validation logLoss, then Brier, then plugin id; full validation coverage required; final test read only after selection",
    candidates: plugins.map((plugin) => ({ id: plugin.id, version: plugin.version, implementationHash: plugin.implementationHash ?? null, selectable: plugin.selectable !== false, requiredFeatures: plugin.requiredFeatures ?? [] })),
    bootstrap: options.bootstrap ?? {},
  };
  const protocolHash = hash(protocol);
  const foldReports = [];
  const pooledValidation = [];
  let lastStates = new Map();
  const trainOrCalibrate = (plugin, trainRows, calibrationRows, context) => {
    assert(trainRows.length >= min.training, "insufficient-training-rows");
    if (plugin.calibrate || plugin.requiresCalibration) assert(calibrationRows.length >= min.calibration, "insufficient-calibration-rows");
    let state = freezeCopy(syncCall(plugin.fit, freezeCopy(trainRows.map((row) => labeledInput(row, plugin.requiredFeatures))), context));
    if (plugin.calibrate) state = freezeCopy(syncCall(plugin.calibrate, state, freezeCopy(calibrationRows.map((row) => labeledInput(row, plugin.requiredFeatures))), context));
    return state;
  };
  const predictRows = (plugin, state, rows, context) => {
    const map = new Map();
    const failures = [];
    for (const row of rows) {
      try {
        const value = syncCall(plugin.predict, state, predictInput(row, plugin.requiredFeatures), context);
        if (value === null || value === undefined) failures.push({ matchId: row.matchId, reason: "plugin-abstained" });
        else map.set(row.matchId, probabilities(value));
      } catch (error) { failures.push({ matchId: row.matchId, reason: String(error.message).slice(0, 250) }); }
    }
    return { map, failures };
  };
  for (const fold of folds) {
    const exclusions = [];
    const raw = Object.fromEntries(["train", "calibration", "validation"].map((key) => [key, input.filter((row) => within(row, fold.windows[key], offset))]));
    const calibrationBoundary = predictionBoundary(raw.calibration, fold.windows.calibration);
    const validationBoundary = predictionBoundary(raw.validation, fold.windows.validation);
    // Early decisions can precede their kickoff day: use the earliest applicable
    // decision as well as day boundaries, not merely the nominal window date.
    const trainRows = readyDays(raw.train, Math.min(calibrationBoundary, validationBoundary, finalBoundary), offset, "train", exclusions);
    const calibrationRows = readyDays(raw.calibration, Math.min(validationBoundary, finalBoundary), offset, "calibration", exclusions);
    const validationRows = readyDays(raw.validation, finalBoundary, offset, "validation-selection", exclusions);
    const context = freezeCopy({ foldId: fold.id, protocolHash, trainingResultBefore: new Date(Math.min(calibrationBoundary, validationBoundary, finalBoundary)).toISOString(), calibrationResultBefore: new Date(Math.min(validationBoundary, finalBoundary)).toISOString(), shadowOnly: true });
    const predictionMaps = new Map();
    const states = new Map();
    const pluginStatus = [];
    for (const plugin of plugins) {
      try {
        const state = trainOrCalibrate(plugin, trainRows, calibrationRows, context);
        const predictions = predictRows(plugin, state, validationRows, context);
        states.set(plugin.id, { state, context, stateHash: hash(state) });
        predictionMaps.set(plugin.id, predictions.map);
        pluginStatus.push({ id: plugin.id, status: predictions.failures.length ? "partial-predictions" : "evaluated-shadow", stateHash: hash(state), failures: predictions.failures });
      } catch (error) {
        predictionMaps.set(plugin.id, new Map());
        pluginStatus.push({ id: plugin.id, status: "blocked-shadow", reason: String(error.message).slice(0, 250) });
      }
    }
    const scored = evidenceRows(validationRows, predictionMaps, featureKeys, offset);
    pooledValidation.push(...scored);
    const membership = (rows) => rows.map((row) => ({ matchId: row.matchId, market: row.market, matchDay: matchDay(row, offset), inputRecordHash: hash(row) }));
    foldReports.push({ id: fold.id, windows: fold.windows, context, counts: Object.fromEntries(Object.keys(raw).map((key) => [key, { input: raw[key].length, used: ({ train: trainRows, calibration: calibrationRows, validation: validationRows })[key].length }])), membership: { train: membership(trainRows), calibration: membership(calibrationRows), validation: membership(validationRows) }, exclusions, pluginStatus, evaluation: summarizeSet(scored, keys, options.bootstrap), perMatch: scored });
    lastStates = states;
  }
  const eligible = plugins.filter((plugin) => plugin.selectable !== false).map((plugin) => ({ plugin, metric: summarize(pooledValidation, plugin.id) })).filter(({ plugin, metric }) => metric.n >= min.validation && metric.coverage === 1 && lastStates.has(plugin.id));
  eligible.sort((a, b) => a.metric.logLoss - b.metric.logLoss || a.metric.brier - b.metric.brier || a.plugin.id.localeCompare(b.plugin.id));
  const selected = eligible[0]?.plugin ?? null;
  const finalMaps = new Map();
  const finalPluginStatus = [];
  // Keep the interpretable baseline and the one selected candidate only. Final
  // test never scores a menu of candidates for post-hoc cherry-picking.
  for (const plugin of [frequencyBaseline, ...(selected ? [selected] : [])]) {
    const fitted = lastStates.get(plugin.id);
    if (!fitted) {
      finalMaps.set(plugin.id, new Map());
      finalPluginStatus.push({ id: plugin.id, status: "blocked-shadow", reason: "no-state-from-last-training-calibration-window" });
      continue;
    }
    const predictions = predictRows(plugin, fitted.state, finalRows, fitted.context);
    finalMaps.set(plugin.id, predictions.map);
    finalPluginStatus.push({ id: plugin.id, stateHash: fitted.stateHash, status: predictions.failures.length ? "partial-predictions" : "evaluated-shadow", failures: predictions.failures });
  }
  const finalScored = evidenceRows(finalRows, finalMaps, featureKeys, offset);
  const selectedKeys = ["publishedModel", "sameDecisionMarket", frequencyBaseline.id, ...(selected ? [selected.id] : [])];
  const windowMembership = new Set(foldReports.flatMap((fold) => Object.values(fold.membership).flat().map((row) => row.matchId)).concat(finalRows.map((row) => row.matchId)));
  const report = {
    version: VERSION, shadowOnly: true, productionEligible: false,
    status: selected && finalRows.length >= min.finalTest && finalPluginStatus.every((entry) => entry.status === "evaluated-shadow") ? "evaluated-shadow" : "blocked-or-baseline-only-shadow",
    evaluationKinds: { publishedModel: "original-frozen-prediction-review", sameDecisionMarket: "same-decision-proportional-de-vig-benchmark", [frequencyBaseline.id]: "simple-baseline-replay", candidate: "candidateReplay-not-original-prediction" },
    input: { records: input.length, recordSetHash: hash(input), source: options.source ?? null, admission: "caller must provide independently admitted production evidence; this module rechecks structure, chronology and uniqueness only" },
    protocol, protocolHash, folds: foldReports,
    validation: summarizeSet(pooledValidation, keys, options.bootstrap),
    selection: { selectedCandidate: selected?.id ?? null, candidateStateHash: selected ? lastStates.get(selected.id).stateHash : null, eligibleCandidates: eligible.map(({ plugin, metric }) => ({ id: plugin.id, n: metric.n, logLoss: metric.logLoss, brier: metric.brier })), reason: selected ? "selected-using-past-validation-only" : "no-full-coverage-candidate-with-sufficient-validation", finalTestUsedForSelection: false, stateFromFold: folds[folds.length - 1].id },
    finalTest: { ...summarizeSet(finalScored, selectedKeys, options.bootstrap), window: finalWindow, requiredRows: min.finalTest, sufficientRows: finalRows.length >= min.finalTest, pluginStatus: finalPluginStatus, perMatch: finalScored },
    unassignedOrExcluded: input.filter((row) => !windowMembership.has(row.matchId)).map((row) => ({ matchId: row.matchId, market: row.market, matchDay: matchDay(row, offset), reason: "outside-fixed-windows-or-excluded-for-label-availability" })),
    limitations: ["No ROI or drawdown: complete frozen betting execution and settlement evidence is not assumed.", "Intervals describe this admitted sample; they do not prove improvement or support model promotion.", "Feature availability/source authorization and exact same-decision official SP provenance must already pass upstream admission.", "Plugins are audited trusted pure code, not a sandbox; the host withholds future labels but cannot prevent external plugin I/O.", "Declared feature completeness is not proof of feature quality; absence of a feature declaration is not evidence that all relevant inputs exist.", "Final-test selection is isolated within this run. Preserve protocol/input hashes and an external experiment registry to prevent repeated-test tuning."],
    metricDefinitions: { probabilities: `frozen triplets must sum to 1 within ${PROBABILITY_ROUNDING_TOLERANCE}; divide by their sum solely to remove rounding error when scoring; original input record hashes preserved`, brier: "mean sum over three classes (range 0..2)", logLoss: `mean negative natural log of actual-class probability; lower clip ${EPSILON}`, accuracy: "argmax direction; exact ties resolve home, draw, away", reliability: "one-versus-rest class bins [lower,upper), last includes 1" },
  };
  return { ...report, reportHash: hash(report) };
}

// Original-prediction review across every admitted record, independent of any
// training windows. Does not fit a candidate or imply these labels were known
// before kickoff. The caller retains the complete original evidence records.
function summarizePublishedHistory(records, options = {}) {
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const offset = offsetFor(timeZone);
  validateRecords(records, offset);
  const input = freezeCopy(records).slice().sort((a, b) => instant(a.kickoffAt, "kickoffAt") - instant(b.kickoffAt, "kickoffAt") || a.matchId.localeCompare(b.matchId));
  const rows = evidenceRows(input, new Map(), declaredFeatureKeys(input, options.featureKeys), offset);
  const report = {
    version: `${VERSION}-published-review`, evaluationKind: "original-frozen-prediction-review", productionEligible: false,
    timeZone, inputRecordSetHash: hash(input), source: options.source ?? null,
    ...summarizeSet(rows, ["publishedModel", "sameDecisionMarket"], options.bootstrap),
    perMatch: rows,
    metricDefinitions: { brier: "three-class squared-error sum averaged per match", logLoss: `natural logarithm; lower clip ${EPSILON}`, roundingTolerance: PROBABILITY_ROUNDING_TOLERANCE, roundingPolicy: "divide accepted frozen triplets by their sum only within rounding tolerance", interval: "paired whole-match-day bootstrap; diagnostic, not promotion evidence" },
  };
  return { ...report, reportHash: hash(report) };
}

function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--input", "--config", "--output"].includes(argv[i]) && argv[i + 1], "usage: node scripts/historyRegressionReplay.cjs --input admitted.json --config windows.json --output replay.json");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  assert(args.input && args.config && args.output, "--input, --config, --output are required");
  assert(path.resolve(args.output) !== path.resolve(args.input) && path.resolve(args.output) !== path.resolve(args.config), "output must not overwrite inputs");
  assert(fs.statSync(args.input).size <= 16 * 1024 * 1024, "admitted input exceeds 16 MiB bound");
  assert(fs.statSync(args.config).size <= 1024 * 1024, "config exceeds 1 MiB bound");
  const inputBytes = fs.readFileSync(args.input);
  const input = JSON.parse(inputBytes.toString("utf8"));
  const configBytes = fs.readFileSync(args.config);
  const options = JSON.parse(configBytes.toString("utf8"));
  assert(!options.candidates?.length, "CLI is baseline-only; use audited in-process plugin adapters for candidates");
  const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const report = runHistoryRegressionReplay(Array.isArray(input) ? input : input.records, { ...options, source: { ...(input.source ?? {}), ...(options.source ?? {}), inputFileSha256: digest(inputBytes), configFileSha256: digest(configBytes) } });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), reportHash: report.reportHash, records: report.input.records, finalTestRows: report.finalTest.rows, status: report.status, productionEligible: false })}\n`);
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { VERSION, OUTCOMES, score, summarize, probabilities, marketProbabilities, pairedDayBootstrap, runHistoryRegressionReplay, summarizePublishedHistory, frequencyBaseline };
