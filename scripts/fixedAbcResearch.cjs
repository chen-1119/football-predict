"use strict";

const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const OUTCOMES = Object.freeze(["1", "X", "2"]);
const VERSION = "fixed-abc-historical-research-v1";
const PROTOCOL = Object.freeze({
  version: "fixed-abc-protocol-v1", market: "HAD", sourceDataset: "xgabora/Club-Football-Match-Data-2000-2025:Matches.csv",
  scope: "all-competitions-in-the-frozen-source-inventory", maximumEvents: 20000,
  dates: { start: "2023-01-01", tune: "2024-01-01", calibrate: "2024-07-01", test: "2025-01-01", end: "2025-06-02" },
  routes: { A: "de-vigged-market", B: "dynamic-goal-strength-shadow-v1", C: "quality-bounded-positive-linear-residual" },
  residualWeights: [0, 0.1, 0.2], temperatures: [0.9, 1, 1.1],
  minimumModelTrainingRows: 80, minimumFitRows: 150,
  quality: "minimum-team-reliability-times-60-day-rest-decay",
  selection: "tuning-log-loss-then-brier-then-lower-weight",
  calibration: "separate-calendar-segment-log-loss-then-brier-then-nearest-one",
  stateUpdates: "prequential-only-from-results-available-strictly-before-forecast",
  tiePolicy: "abstain-on-equal-highest-probability",
  filter: { minimumQuality: 0.5, minimumMaximumProbability: 0.45 },
  metricScope: "HAD-only-same-event-paired-probability-scores",
  historicalOutcomesPreviouslyInspected: true, researchOnly: true, productionEligible: false,
});
const round = value => value === null ? null : Number(value.toFixed(10));
const dateMs = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("invalid protocol date");
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error("invalid calendar date");
  return ms;
};
const validProbabilities = p => Boolean(p && OUTCOMES.every(k => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= 0 && p[k] <= 1)
  && Math.abs(OUTCOMES.reduce((s, k) => s + p[k], 0) - 1) < 1e-7);
const canonicalTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function freezeProtocol(overrides = {}) {
  const body = structuredClone({ ...PROTOCOL, ...overrides });
  if (typeof body.sourceDataset !== "string" || !body.sourceDataset.trim() || body.sourceDataset !== body.sourceDataset.trim()) throw new Error("invalid canonical source identity");
  const configurable = new Set(["dates", "sourceDataset", "minimumFitRows", "minimumModelTrainingRows", "maximumEvents"]);
  for (const key of Object.keys(body)) {
    if (!(key in PROTOCOL) || (!configurable.has(key) && stableHash(body[key]) !== stableHash(PROTOCOL[key]))) throw new Error(`policy change requires a new implementation version: ${key}`);
  }
  if (body.market !== "HAD" || body.productionEligible !== false || body.researchOnly !== true
      || body.historicalOutcomesPreviouslyInspected !== true) throw new Error("historical research boundary cannot be promoted");
  if (stableHash(body.routes) !== stableHash(PROTOCOL.routes)) throw new Error("exactly the fixed A/B/C routes are required");
  if (stableHash(body.residualWeights) !== stableHash(PROTOCOL.residualWeights)
      || stableHash(body.temperatures) !== stableHash(PROTOCOL.temperatures)) throw new Error("candidate grid is fixed by protocol version");
  const boundaries = ["start", "tune", "calibrate", "test", "end"].map(k => dateMs(body.dates?.[k]));
  if (boundaries.some((n, i) => i > 0 && n <= boundaries[i - 1])) throw new Error("calendar segments must be strictly ordered");
  for (const key of ["minimumFitRows", "minimumModelTrainingRows", "maximumEvents"]) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 1) throw new Error(`invalid ${key}`);
  }
  // Commit the actual policy; no wall clock is invented as preregistration.
  return { ...body, protocolHash: stableHash(body) };
}
function verifyProtocol(p) {
  const { protocolHash, ...body } = p || {};
  return freezeProtocol(body).protocolHash === protocolHash;
}
function partitionRows(rows, protocol) {
  if (!verifyProtocol(protocol)) throw new Error("invalid protocol commitment");
  if (!Array.isArray(rows) || rows.length > protocol.maximumEvents) throw new Error("input exceeds committed event inventory limit");
  const d = protocol.dates;
  const segments = { training: [], tuning: [], calibration: [], test: [] };
  const excluded = [], identities = new Set();
  for (const row of [...rows].sort((a, b) => String(a.forecastAt).localeCompare(String(b.forecastAt)) || String(a.eventId).localeCompare(String(b.eventId)))) {
    if (typeof row.eventId !== "string" || !row.eventId.trim() || row.eventId !== row.eventId.trim() || identities.has(row.eventId)) throw new Error("duplicate or missing event identity; snapshots cannot cross partitions");
    identities.add(row.eventId);
    if (row.marketFamily !== "HAD") throw new Error("mixed market families are forbidden");
    if (!canonicalTime(row.forecastAt) || !canonicalTime(row.availableAt)
        || Date.parse(row.availableAt) <= Date.parse(row.forecastAt)) throw new Error("invalid decision/result clock");
    if (row.featureKnownThrough !== null && (!canonicalTime(row.featureKnownThrough)
        || Date.parse(row.featureKnownThrough) >= Date.parse(row.forecastAt))) throw new Error("feature information leaks past forecast boundary");
    if (!OUTCOMES.includes(row.actual)) throw new Error("invalid HAD outcome");
    const date = row.forecastAt.slice(0, 10);
    let segment = date < d.start || date >= d.end ? null : date < d.tune ? "training" : date < d.calibrate ? "tuning" : date < d.test ? "calibration" : "test";
    let reason = !segment ? "outside-fixed-calendar" : row.sourceDataset !== protocol.sourceDataset ? "outside-fixed-source"
      : !validProbabilities(row.market) ? "market-probability-missing-or-invalid"
      : !validProbabilities(row.model) ? "model-probability-missing-or-invalid"
      : !Number.isSafeInteger(row.trainingRows) || row.trainingRows < protocol.minimumModelTrainingRows ? "model-warmup"
      : typeof row.quality !== "number" || !Number.isFinite(row.quality) || row.quality < 0 || row.quality > 1 ? "input-quality-unrecorded" : null;
    const labelCutoff = { training: d.tune, tuning: d.calibrate, calibration: d.test }[segment];
    if (!reason && labelCutoff && Date.parse(row.availableAt) >= dateMs(labelCutoff)) reason = "result-unavailable-at-next-fitting-boundary";
    if (reason) excluded.push({ eventId: row.eventId, segment, reason });
    else segments[segment].push(row);
  }
  return { segments, excluded, totalRows: rows.length };
}
function temperature(p, t) {
  const weights = OUTCOMES.map(k => Math.pow(Math.max(1e-12, p[k]), 1 / t));
  const total = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(OUTCOMES.map((k, i) => [k, weights[i] / total]));
}
function routeProbabilities(row, route, weight = 0, t = 1) {
  if (route === "A") return row.market;
  if (route === "B") return temperature(row.model, t);
  if (route !== "C") throw new Error("unknown route");
  const effective = weight * row.quality;
  return temperature(Object.fromEntries(OUTCOMES.map(k => [k, (1 - effective) * row.market[k] + effective * row.model[k]])), t);
}
const direction = p => {
  const maximum = Math.max(...OUTCOMES.map(k => p[k]));
  const winners = OUTCOMES.filter(k => Math.abs(p[k] - maximum) < 1e-12);
  return winners.length === 1 ? winners[0] : null;
};
function score(rows, probabilitiesFor) {
  let hits = 0, decided = 0, brier = 0, logLoss = 0;
  const calibration = Object.fromEntries(OUTCOMES.map(k => [k, Array.from({ length: 10 }, (_, bin) => ({ lower: bin / 10, upper: (bin + 1) / 10, rows: 0, sumProbability: 0, positives: 0 }))]));
  for (const row of rows) {
    const p = probabilitiesFor(row);
    if (!validProbabilities(p)) throw new Error("invalid score probabilities");
    const pick = direction(p);
    if (pick !== null) { decided++; hits += Number(pick === row.actual); }
    logLoss -= Math.log(Math.max(1e-12, p[row.actual]));
    for (const k of OUTCOMES) {
      const y = Number(row.actual === k);
      brier += (p[k] - y) ** 2;
      const bin = calibration[k][Math.min(9, Math.floor(p[k] * 10))];
      bin.rows++; bin.sumProbability += p[k]; bin.positives += y;
    }
  }
  const z = 1.959963984540054;
  const accuracy = decided ? hits / decided : null;
  let accuracyInterval = null;
  if (decided) {
    const denominator = 1 + z * z / decided;
    const center = (accuracy + z * z / (2 * decided)) / denominator;
    const half = z * Math.sqrt(accuracy * (1 - accuracy) / decided + z * z / (4 * decided * decided)) / denominator;
    accuracyInterval = [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
  }
  return { rows: rows.length, hits, decided, abstainedTies: rows.length - decided,
    accuracy: round(accuracy), directionCoverage: rows.length ? round(decided / rows.length) : null,
    brier: rows.length ? round(brier / rows.length) : null, logLoss: rows.length ? round(logLoss / rows.length) : null,
    uncertainty: { accuracyWilson95: accuracyInterval, caveat: "binomial-descriptive-not-cluster-adjusted-or-promotion-evidence" },
    calibration: Object.fromEntries(OUTCOMES.map(k => [k, calibration[k].map(bin => ({ lower: bin.lower, upper: bin.upper, rows: bin.rows,
      meanProbability: bin.rows ? round(bin.sumProbability / bin.rows) : null, observedFrequency: bin.rows ? round(bin.positives / bin.rows) : null }))])) };
}
const fittingScore = (rows, route, weight, t) => {
  const s = score(rows, row => routeProbabilities(row, route, weight, t));
  return { weight, temperature: t, rows: s.rows, brier: s.brier, logLoss: s.logLoss };
};
function runFixedAbcResearch(rows, protocol = freezeProtocol()) {
  const split = partitionRows(rows, protocol);
  for (const name of ["training", "tuning", "calibration", "test"]) {
    if (split.segments[name].length < protocol.minimumFitRows) {
      const error = new Error(`insufficient fixed ${name} rows`);
      error.audit = { counts: Object.fromEntries(Object.entries(split.segments).map(([key, values]) => [key, values.length])),
        reasons: split.excluded.reduce((a, row) => ({ ...a, [row.reason]: (a[row.reason] || 0) + 1 }), {}) };
      throw error;
    }
  }
  const rankedWeights = protocol.residualWeights.map(w => fittingScore(split.segments.tuning, "C", w, 1))
    .sort((a, b) => a.logLoss - b.logLoss || a.brier - b.brier || a.weight - b.weight);
  const weight = rankedWeights[0].weight;
  const calibrationFits = Object.fromEntries(["B", "C"].map(route => [route, protocol.temperatures.map(t => fittingScore(split.segments.calibration, route, weight, t))
    .sort((a, b) => a.logLoss - b.logLoss || a.brier - b.brier || Math.abs(a.temperature - 1) - Math.abs(b.temperature - 1) || a.temperature - b.temperature)]));
  const temperatures = { A: 1, B: calibrationFits.B[0].temperature, C: calibrationFits.C[0].temperature };
  const test = split.segments.test;
  const commonDecisions = test.filter(row => ["A", "B", "C"].every(route => direction(routeProbabilities(row, route, weight, temperatures[route])) !== null));
  const reports = Object.fromEntries(["A", "B", "C"].map(route => {
    const predict = row => routeProbabilities(row, route, weight, temperatures[route]);
    const selected = test.filter(row => row.quality >= protocol.filter.minimumQuality && Math.max(...OUTCOMES.map(k => predict(row)[k])) >= protocol.filter.minimumMaximumProbability);
    return [route, { allPaired: score(test, predict), commonDecisions: score(commonDecisions, predict), rawUncalibrated: score(test, row => routeProbabilities(row, route, weight, 1)),
      fixedFilter: { rows: selected.length, coverage: round(selected.length / test.length), eventIdsHash: stableHash(selected.map(row => row.eventId)),
        candidate: score(selected, predict), sameRowsMarket: score(selected, row => row.market) } }];
  }));
  const partition = Object.fromEntries(Object.entries(split.segments).map(([name, values]) => [name, { rows: values.length,
    firstForecastAt: values[0]?.forecastAt || null, lastForecastAt: values.at(-1)?.forecastAt || null,
    latestAvailableAt: values.map(row => row.availableAt).sort().at(-1) || null, eventIdsHash: stableHash(values.map(row => row.eventId)) }]));
  const body = { version: VERSION, researchOnly: true, productionEligible: false, strictPromotionEligible: false,
    protocol, inputHash: stableHash([...rows].sort((a, b) => a.eventId.localeCompare(b.eventId))),
    coverage: { totalRows: split.totalRows, pairedTestRows: test.length, commonDirectionRows: commonDecisions.length,
      commonDirectionEventIdsHash: stableHash(commonDecisions.map(row => row.eventId)),
      excluded: split.excluded, reasons: split.excluded.reduce((a, r) => ({ ...a, [r.reason]: (a[r.reason] || 0) + 1 }), {}) },
    partition, fitted: { residualWeight: weight, temperatures, tuningCandidates: rankedWeights, calibrationCandidates: calibrationFits,
      testLabelsUsedForFitting: false, fittingCommitment: stableHash({ tuning: split.segments.tuning, calibration: split.segments.calibration, weight, temperatures }) },
    reports, conclusion: { candidateHasPositivePointEstimates: reports.C.allPaired.brier < reports.A.allPaired.brier && reports.C.allPaired.logLoss < reports.A.allPaired.logLoss,
      candidateUsesModelResidual: weight > 0, nominationAllowed: false,
      blockers: ["previously-inspected-historical-data", "historical-source-clock-proof-missing", "independent-prospective-evidence-required", "paired-cluster-uncertainty-not-yet-computed", "feature-ablation-not-yet-completed"] } };
  return { ...body, manifestHash: stableHash(body) };
}
module.exports = { VERSION, PROTOCOL, freezeProtocol, partitionRows, runFixedAbcResearch, validProbabilities, direction, score };
