'use strict';

// All fixtures are synthetic boundary/algorithm tests. These scores and
// metrics are not measured prediction accuracy or promotion evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const team = require('../src/services/prematchTeamEvidenceV3.cjs');
const learning = require('../src/services/prematchV3Learning.cjs');
const { DEFAULT_THRESHOLDS } = require('../scripts/modelLearningRegistry.cjs');

const FEATURE = 'home.roster.confirmed.attackReplacementGapPer90';
const FATIGUE = 'away.fatigue.restDays';
const FEATURES = [FEATURE, FATIGUE];
const EVALUATED = '2026-09-15T10:00:00.000Z';
const days = [1, 2, 3, 4, 5, 6].map(day => `2026-09-${String(day).padStart(2, '0')}`);
const SPLIT = { trainDays: days.slice(0, 3), calibrationDays: days.slice(3, 5), testDays: days.slice(5) };
const hash = tag => stableHash({ synthetic: tag });
function stamp(value) { const { contentHash, ...body } = value; return { ...body, contentHash: stableHash(body) }; }
function seal(record) {
  const copy = structuredClone(record);
  copy.result = copy.result == null ? copy.result : stamp(copy.result);
  copy.predictionHash = learning.predictionRecordHash(copy);
  return stamp(copy);
}
function fixture(day, index) {
  const date = days[day - 1], sourceMatchId = `synthetic-${day}-${index}`;
  const depleted = index % 2 === 1;
  return seal({ version: learning.RECORD_VERSION, frozen: true,
    event: { sourceMatchId, eventVersion: `${date}T12:00:00.000Z`, cutoffAt: `${date}T11:00:00.000Z`,
      homeTeamId: 'synthetic-home', awayTeamId: 'synthetic-away' },
    asOf: `${date}T10:00:00.000Z`, frozenAt: `${date}T10:00:00.000Z`,
    featureKnownAt: `${date}T09:59:00.000Z`, featureSchemaHash: team.FEATURE_SCHEMA_HASH,
    featureSnapshotHash: hash(`snapshot-${sourceMatchId}`),
    featureVector: { [FEATURE]: Number(depleted), [FATIGUE]: depleted ? 5 : 1 },
    baseRates: { home: 1, away: 1 },
    baseRatesEvidence: { kind: 'zero-market-team-strength', marketIncluded: false,
      artifactHash: hash('synthetic-base-model'), trainedThrough: '2026-08-01T12:00:00.000Z',
      availableAt: '2026-08-02T12:00:00.000Z' },
    market: { source: 'synthetic-market-research', sourceHash: hash(`market-${sourceMatchId}`),
      observedAt: `${date}T09:58:00.000Z`, receivedAt: `${date}T09:59:00.000Z`,
      asOf: `${date}T10:00:00.000Z`, probabilities: { '1': 0.4, X: 0.25, '2': 0.35 } },
    result: { regulationMinutes: 90, confirmation: 'research-confirmed-90min',
      source: 'sporttery:official-api', sourceHash: hash(`result-${sourceMatchId}`),
      observedAt: `${date}T14:00:00.000Z`, receivedAt: `${date}T14:01:00.000Z`,
      match: { sourceMatchId, eventVersion: `${date}T12:00:00.000Z`, kickoffTime: `${date}T12:00:00.000Z`,
        homeTeamId: 'synthetic-home', awayTeamId: 'synthetic-away', status: 'FINISHED',
        scoreHome: depleted ? 0 : 3, scoreAway: depleted ? 3 : 0,
        resultSource: 'sporttery:official-api', sourceUrl: 'https://webapi.sporttery.cn/synthetic-results' } } });
}
function records() { return days.flatMap((_, day) => Array.from({ length: 8 }, (_, index) => fixture(day + 1, index))); }
function fit(rows = records(), overrides = {}) {
  return learning.learnPrematchV3Candidate({ records: rows, asOf: EVALUATED,
    featureSchema: team.FEATURE_SCHEMA, featureNames: FEATURES, split: SPLIT, ...overrides });
}
function evaluate(artifact, rows = records(), overrides = {}) {
  return learning.evaluatePrematchV3Records({ artifact, records: rows, asOf: EVALUATED, ...overrides });
}

test('fits bounded Poisson parameters and actually applies them on independent later test days', () => {
  const rows = records(), before = JSON.stringify(rows), result = fit(rows);
  assert.equal(result.status, 'shadow-candidate', JSON.stringify(result.reasons));
  assert.equal(JSON.stringify(rows), before, 'fitting does not mutate frozen caller input');
  assert.equal(result.formalEligible, false); assert.equal(result.productionEligible, false);
  assert.equal(result.calibrated, false); assert.equal(result.originalDeployment, false);
  assert.equal(result.artifact.training.sampleCount, 24);
  assert.equal(result.artifact.training.trainingEventIds.length, 24);
  assert.deepEqual(result.artifact.training.trainingMatchDays, SPLIT.trainDays);
  assert.equal(result.artifact.trainedThrough, '2026-09-03T14:01:00.000Z');
  assert.equal(result.artifact.createdAt, EVALUATED, 'real creation time is not backdated to a training day');
  assert.equal(result.artifact.availableAt, EVALUATED);
  assert.equal(result.artifact.featureSchemaHash, team.FEATURE_SCHEMA_HASH);
  assert.deepEqual(result.artifact.registration.promotionThresholds, DEFAULT_THRESHOLDS);
  assert.equal(result.artifact.registration.status, 'not-registered');
  assert.ok(result.artifact.training.optimization.finalObjective < result.artifact.training.optimization.initialObjective);
  assert.equal(result.artifact.model.lambdaFloor, 0.05); assert.equal(result.artifact.model.lambdaCeiling, 12);
  assert.equal(result.validation.rows.length, 8);
  for (const row of result.validation.rows) {
    assert.equal(row.matchDay, SPLIT.testDays[0]);
    assert.ok(!result.artifact.training.trainingSourceMatchIds.includes(row.sourceMatchId));
    assert.equal(row.parameterArtifactHash, result.artifact.contentHash);
    assert.ok(Math.abs(row.rates.home - 1) > 1e-6 || Math.abs(row.rates.away - 1) > 1e-6);
  }
  const later = evaluate(result.artifact);
  assert.equal(later.status, 'shadow-evaluated');
  assert.deepEqual(later.validation.metrics, result.validation.metrics);
});

test('all four same-match comparators report Brier, log loss, daily metrics and coverage', () => {
  const result = fit();
  for (const name of ['candidate', 'baseline', 'marketOnly', 'hybrid']) {
    const metric = result.validation.metrics[name];
    assert.equal(metric.rows, 8); assert.ok(Number.isFinite(metric.brier)); assert.ok(Number.isFinite(metric.logLoss));
  }
  const row = result.validation.rows[0];
  const outcome = row.outcome;
  const brier = ['1', 'X', '2'].reduce((sum, code) => sum + (row.candidate[code] - Number(code === outcome)) ** 2, 0);
  assert.ok(brier >= 0 && brier <= 2);
  assert.equal(result.coverage.inputRecordCount, 48); assert.equal(result.coverage.independentEventCount, 48);
  assert.equal(result.coverage.trainingRows, 24); assert.equal(result.coverage.calibrationRows, 16);
  assert.equal(result.coverage.pairedTestRows, 8); assert.equal(result.validation.dailyMetrics.length, 1);
  assert.equal(result.calibration.fitted, false); assert.equal(result.calibration.rows.length, 16);
});

test('learned artifact directly drives the team apply function with exactly the same future prediction rates', () => {
  const artifact = fit().artifact, date = '2026-10-06', asOf = `${date}T10:00:00.000Z`;
  const predictions = [];
  for (let index = 0; index < 2; index++) {
    const event = { sourceMatchId: `synthetic-future-${index}`, eventVersion: `${date}T12:00:00.000Z`,
      cutoffAt: `${date}T11:00:00.000Z`, homeTeamId: 'synthetic-home', awayTeamId: 'synthetic-away' };
    const source = { provider: 'synthetic-provider', endpoint: '/synthetic-team-facts',
      receiptHash: hash(`receipt-${index}`), rawPayloadHash: hash(`raw-${index}`) };
    const observation = (family, side, data) => ({ family, side, sourceMatchId: event.sourceMatchId,
      eventVersion: event.eventVersion, teamId: event[`${side}TeamId`], source,
      providerObservedAt: `${date}T09:00:00.000Z`, receivedAt: `${date}T09:01:00.000Z`, data });
    const snapshot = team.buildPrematchTeamSnapshot({ event, asOf, observations: [
      observation('roster', 'home', { status: 'confirmed',
        contributionMetric: { attack: 'provider-observed-attack-contribution-per90', defense: 'provider-observed-defense-contribution-per90' },
        players: Array.from({ length: 11 }, (_, player) => ({ playerId: `synthetic-player-${player}`, expectedMinutes: 90,
          contributionPer90: { attack: 0.1, defense: 0.05 }, replacementPer90: { attack: 0.03, defense: 0.01 } })) }),
      observation('fatigue', 'away', { lastMatchEndedAt: '2026-10-02T10:00:00.000Z',
        minutesLast7Days: 800, minutesLast14Days: 1700, travelKm: 300, rotationCount: 3 }),
    ] });
    const applied = team.applyPrematchTeamEffects(snapshot, { home: 1, away: 1 }, artifact);
    assert.equal(applied.status, 'shadow-applied', JSON.stringify(applied.blockers));
    assert.equal(applied.receipt.parameterHash, artifact.contentHash);
    const template = fixture(6, index);
    const record = seal({ ...template, event, asOf, frozenAt: asOf, featureKnownAt: `${date}T09:01:00.000Z`,
      featureSnapshotHash: snapshot.contentHash, featureVector: snapshot.features,
      market: { ...template.market, asOf, observedAt: `${date}T09:58:00.000Z`, receivedAt: `${date}T09:59:00.000Z` },
      result: { ...template.result, observedAt: `${date}T14:00:00.000Z`, receivedAt: `${date}T14:01:00.000Z`,
        match: { ...template.result.match, sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
          kickoffTime: event.eventVersion } } });
    predictions.push({ record, applied });
  }
  const replay = evaluate(artifact, predictions.map(row => row.record), { asOf: '2026-10-07T10:00:00.000Z', testDays: [date] });
  assert.equal(replay.status, 'shadow-evaluated');
  for (const row of replay.validation.rows) {
    const expected = predictions.find(entry => entry.record.event.sourceMatchId === row.sourceMatchId);
    assert.deepEqual(row.rates, expected.applied.after);
  }
});

test('changing a real selected feature changes candidate rates while zero-effect baseline stays identical', () => {
  const artifact = fit().artifact;
  const testRows = records().filter(row => SPLIT.testDays.includes(row.event.eventVersion.slice(0, 10)));
  const altered = testRows.map(row => seal({ ...row, featureVector: { ...row.featureVector, [FEATURE]: row.featureVector[FEATURE] === 1 ? 0 : 1 } }));
  const first = evaluate(artifact, testRows), second = evaluate(artifact, altered);
  assert.equal(second.status, 'shadow-evaluated');
  assert.deepEqual(first.validation.rows.map(row => row.baseline), second.validation.rows.map(row => row.baseline));
  assert.notDeepEqual(first.validation.rows.map(row => row.rates), second.validation.rows.map(row => row.rates));
});

test('multiple prediction versions of one event cannot expand the denominator or cross a split', () => {
  const rows = records();
  const first = rows[0];
  const later = seal({ ...first, asOf: '2026-09-01T10:30:00.000Z', frozenAt: '2026-09-01T10:30:00.000Z',
    market: { ...first.market, asOf: '2026-09-01T10:30:00.000Z' } });
  const normal = fit(rows), repeated = fit([...rows, structuredClone(first), later, ...rows.slice(0, 8)]);
  assert.equal(repeated.status, 'shadow-candidate');
  assert.equal(repeated.artifact.training.sampleCount, 24);
  assert.deepEqual(repeated.artifact.model, normal.artifact.model);
  assert.equal(repeated.coverage.independentEventCount, 48);
  assert.equal(repeated.coverage.exclusionReasons['duplicate-event-version'], 10);
  assert.equal(repeated.validation.metrics.candidate.rows, 8);
  const forcedIntoTest = evaluate(normal.artifact, rows, { testDays: [days[0]] });
  assert.equal(forcedIntoTest.status, 'blocked'); assert.equal(forcedIntoTest.probabilities, null);
  assert.equal(forcedIntoTest.coverage.exclusionReasons['training-and-test-not-independent'], 8);
  const calibrationAsTest = evaluate(normal.artifact, rows, { testDays: [days[3], days[4]] });
  assert.equal(calibrationAsTest.status, 'blocked');
  assert.equal(calibrationAsTest.coverage.exclusionReasons['calibration-and-test-not-independent'], 16);
});

test('contradictory team identity, rescheduled versions, same-clock predictions or result conflicts quarantine the whole event', () => {
  for (const mutate of [
    row => { row.event.homeTeamId = 'other-home'; row.result.match.homeTeamId = 'other-home'; },
    row => { row.event.eventVersion = '2026-09-06T12:00:00.000Z'; row.event.cutoffAt = '2026-09-06T11:00:00.000Z';
      row.result.match.eventVersion = row.event.eventVersion; row.result.match.kickoffTime = row.event.eventVersion; },
    row => { row.featureVector[FEATURE] = 0.4; },
    row => { row.result.match.scoreHome = 2; },
  ]) {
    const rows = records(), conflicting = structuredClone(rows[0]); mutate(conflicting);
    const result = fit([...rows, seal(conflicting)]);
    assert.equal(result.status, 'shadow-candidate'); assert.equal(result.artifact.training.sampleCount, 23);
    assert.ok(result.exclusions.some(row => row.sourceMatchId === rows[0].event.sourceMatchId));
    assert.ok(!result.artifact.training.trainingSourceMatchIds.includes(rows[0].event.sourceMatchId));
  }
});

test('null, VOID, disputed, extra-time, unattributed and fallback labels are excluded', () => {
  const mutations = [row => { row.result = null; }, row => { row.result.voided = true; },
    row => { row.result.disputed = true; }, row => { row.result.regulationMinutes = 120; },
    row => { row.result.source = null; }, row => { row.result.sourceHash = null; },
    row => { row.result.match.resultSource = '500.com:HAD'; }, row => { row.result.match.resultObservationFallback = true; },
    row => { row.result.match.scoreHome = null; }, row => { row.result.match.scoreAway = '0'; }];
  for (const mutate of mutations) {
    const rows = records(); mutate(rows[0]); rows[0] = seal(rows[0]);
    const result = fit(rows); assert.equal(result.status, 'shadow-candidate');
    assert.equal(result.artifact.training.sampleCount, 23); assert.equal(result.coverage.excludedRecordCount, 1);
  }
});

test('each supplied result event/kickoff clock must exactly match the frozen fixture, while equivalent zones remain valid', () => {
  for (const mutate of [
    row => { row.result.match.kickoffTime = '2026-09-01T12:00:00.000000001Z'; },
    row => { row.result.match.eventVersion = '2026-09-01T12:00:00.000000001Z'; },
    row => { row.result.match.kickoffTime = '2026-09-01T12:00:00'; },
    row => { row.result.match.eventVersion = '2026-09-01T12:00:00'; },
    row => { row.result.match.kickoffTime = null; },
    row => { row.result.match.eventVersion = ''; },
    row => { delete row.result.match.eventVersion; delete row.result.match.kickoffTime; },
  ]) {
    const rows = records(); mutate(rows[0]); rows[0] = seal(rows[0]);
    const result = fit(rows);
    assert.equal(result.status, 'shadow-candidate'); assert.equal(result.artifact.training.sampleCount, 23);
    assert.ok(!result.artifact.training.trainingSourceMatchIds.includes(rows[0].event.sourceMatchId));
    assert.ok(result.exclusions.some(row => row.sourceMatchId === rows[0].event.sourceMatchId
      && row.reasons.includes('result-event-identity-mismatch')));
  }
  for (const mutate of [
    row => { row.result.match.kickoffTime = '2026-09-01T20:00:00.000000000+08:00'; },
    row => { delete row.result.match.eventVersion; },
    row => { delete row.result.match.kickoffTime; },
  ]) {
    const rows = records(); mutate(rows[0]); rows[0] = seal(rows[0]);
    const result = fit(rows);
    assert.equal(result.status, 'shadow-candidate'); assert.equal(result.artifact.training.sampleCount, 24);
    assert.equal(result.exclusions.length, 0);
  }
});

test('all prediction, feature, base-model and result knowledge clocks reject future and naive values', () => {
  const mutations = [row => { row.asOf = '2026-09-01T11:00:00.000Z'; },
    row => { row.featureKnownAt = '2026-09-01T10:00:00.000000001Z'; },
    row => { row.frozenAt = '2026-09-01T10:00:00.000000001Z'; },
    row => { row.asOf = '2026-09-01 10:00:00'; },
    row => { row.result.observedAt = '2026-09-01T12:10:00Z'; },
    row => { row.result.receivedAt = '2026-10-01T12:00:00Z'; },
    row => { row.baseRatesEvidence.trainedThrough = row.asOf; },
    row => { row.baseRatesEvidence.availableAt = '2026-09-01T10:00:00.000000001Z'; },
    row => { row.baseRatesEvidence.availableAt = '2026-07-01T12:00:00Z'; },
    row => { row.featureVector[FEATURE] = null; }];
  for (const mutate of mutations) {
    const rows = records(); mutate(rows[0]); rows[0] = seal(rows[0]);
    const result = fit(rows); assert.equal(result.status, 'shadow-candidate');
    assert.equal(result.artifact.training.sampleCount, 23);
  }
  const rows = records(); rows[0].result.receivedAt = '2026-09-04T10:00:00.000000001Z'; rows[0] = seal(rows[0]);
  const leak = fit(rows); assert.equal(leak.status, 'blocked');
  assert.ok(leak.reasons.includes('training-knowledge-clock-overlaps-holdout')); assert.equal(leak.probabilities, null);
});

test('split overlap, inverted chronology, insufficient days and insufficient rows block without p or artifact', () => {
  for (const overrides of [
    { split: { ...SPLIT, testDays: [days[0], days[5]] } },
    { split: { trainDays: [days[5]], calibrationDays: days.slice(1, 5), testDays: [days[0]] } },
    { split: { trainDays: SPLIT.trainDays, calibrationDays: [], testDays: SPLIT.testDays } },
  ]) {
    const result = fit(records(), overrides); assert.equal(result.status, 'blocked');
    assert.equal(result.probabilities, null); assert.equal(result.artifact, null);
  }
  for (const rows of [[], records().slice(0, 7), [null]]) {
    const result = fit(rows, { split: undefined }); assert.equal(result.status, 'blocked');
    assert.equal(result.probabilities, null); assert.equal(result.artifact, null);
  }
});

test('missing or time-mismatched market excludes the same test row from every comparator', () => {
  const artifact = fit().artifact;
  for (const mutate of [row => { row.market = null; }, row => { row.market.asOf = '2026-09-06T09:00:00Z'; },
    row => { row.market.receivedAt = '2026-09-06T10:00:00.000000001Z'; }]) {
    const rows = records(); mutate(rows.at(-1)); rows[rows.length - 1] = seal(rows.at(-1));
    const result = evaluate(artifact, rows); assert.equal(result.status, 'shadow-evaluated');
    assert.equal(result.coverage.pairedTestRows, 7);
    for (const metric of Object.values(result.validation.metrics)) assert.equal(metric.rows, 7);
  }
  const rows = records().map(row => seal({ ...row, market: null }));
  const result = fit(rows); assert.equal(result.status, 'blocked'); assert.equal(result.probabilities, null);
});

test('hash, schema and parameter tampering are rejected, including a recomputed outer hash', () => {
  const original = fit().artifact;
  for (const mutate of [artifact => { artifact.model.coefficients.home[FEATURE] += 0.01; },
    artifact => { artifact.model.coefficients.home[FEATURE] += 0.01; Object.assign(artifact, stamp(artifact)); },
    artifact => { artifact.training.inputHashes[0] = hash('tampered-input'); Object.assign(artifact, stamp(artifact)); },
    artifact => { artifact.featureSchemaHash = hash('other-schema'); Object.assign(artifact, stamp(artifact)); },
    artifact => { delete artifact.evaluationPlan; Object.assign(artifact, stamp(artifact)); },
    artifact => { artifact.registration.promotionThresholds.minSameMatchRows = 8; Object.assign(artifact, stamp(artifact)); },
    artifact => { artifact.formalEligible = true; Object.assign(artifact, stamp(artifact)); },
    artifact => { artifact.model.intercept.home = 100; artifact.parametersHash = stableHash(artifact.model); Object.assign(artifact, stamp(artifact)); }]) {
    const artifact = structuredClone(original); mutate(artifact);
    const result = evaluate(artifact); assert.equal(result.status, 'blocked'); assert.equal(result.probabilities, null);
  }
  const rows = records(); rows.at(-1).featureVector[FEATURE] = 0.2;
  const result = evaluate(original, rows);
  assert.equal(result.coverage.pairedTestRows, 7);
  assert.ok(result.coverage.exclusionReasons['frozen-prediction-hash-mismatch']);
});

test('odds-included or missing base-model artifacts cannot be called a roster-free team baseline', () => {
  for (const mutate of [row => { row.baseRatesEvidence.marketIncluded = true; },
    row => { row.baseRatesEvidence.kind = 'odds-implied-lambda'; },
    row => { row.baseRatesEvidence.artifactHash = null; },
    row => { row.baseRatesEvidence.trainingSourceMatchIds = [row.event.sourceMatchId]; }]) {
    const rows = records(); mutate(rows[0]); rows[0] = seal(rows[0]);
    const result = fit(rows); assert.equal(result.status, 'shadow-candidate');
    assert.equal(result.artifact.training.sampleCount, 23);
    assert.ok(result.coverage.exclusionReasons['zero-market-base-rates-unverified']);
  }
});

test('prospective mode requires artifact availability and exact pre-match candidate binding', () => {
  const artifact = fit().artifact;
  const retrospective = evaluate(artifact);
  assert.equal(retrospective.status, 'shadow-evaluated');
  const attempted = evaluate(artifact, records(), { mode: 'prospective-frozen' });
  assert.equal(attempted.status, 'blocked');
  assert.equal(attempted.coverage.exclusionReasons['candidate-not-frozen-before-prediction'], 8);
  const futureEvaluation = evaluate(artifact, records(), { asOf: '2026-09-10T00:00:00Z' });
  assert.equal(futureEvaluation.status, 'blocked');
  assert.ok(futureEvaluation.reasons.includes('parameter-artifact-not-yet-available'));
});

test('extreme iterations, regularization, steps, nonnumeric data and unrelated feature names fail closed', () => {
  for (const fitOptions of [{ iterations: 100000 }, { iterations: 0 }, { regularization: 0 },
    { regularization: -1 }, { learningRate: 10 }, { learningRate: NaN }]) {
    const result = fit(records(), { fitOptions }); assert.equal(result.status, 'blocked'); assert.equal(result.probabilities, null);
  }
  for (const featureNames of [['market.favorite'], [FEATURE, FEATURE], ['home.history.pointsPerMatch']]) {
    assert.equal(fit(records(), { featureNames }).status, 'blocked');
  }
  const defaultSplit = fit(records(), { split: undefined });
  assert.equal(defaultSplit.status, 'shadow-candidate');
  assert.ok(defaultSplit.split.trainDays.at(-1) < defaultSplit.split.calibrationDays[0]);
  assert.ok(defaultSplit.split.calibrationDays.at(-1) < defaultSplit.split.testDays[0]);
  assert.equal(learning.learnPrematchV3Candidate(null).status, 'blocked');
  assert.equal(learning.evaluatePrematchV3Records(null).status, 'blocked');
});
