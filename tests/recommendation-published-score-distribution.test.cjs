'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPublishedScoreDistribution } = require('../src/services/publishedScoreDistribution.cjs');
const { makeDecision, validDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const { buildHandicapCalibration } = require('../src/services/handicapCalibration.cjs');
const { coherentHandicapDistribution } = require('../src/services/handicapMarginDecision.cjs');

const NOW = Date.parse('2026-09-20T02:00:00Z');
const PUB = { generationId: 'g', manifestHash: 'a'.repeat(64), sourceCycleId: 'cycle' };
const CODES = ['1', 'X', '2'];
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
function fixture({ home = 1.2, away = 1.1, line = -1, final = { home: .4, draw: .35, away: .25 }, calibration = null, stale = false } = {}) {
  const at = new Date(NOW).toISOString();
  const match = {
    id: 'sporttery_1', sourceMatchId: '1', businessDate: '2026-09-20', status: 'SCHEDULED',
    homeTeamId: 'h1', awayTeamId: 'a1', homeTeamName: 'Home', awayTeamName: 'Away',
    kickoffTime: '2026-09-20T10:00:00Z', eventVersion: '2026-09-20T10:00:00Z', buyEndTime: '2026-09-20T09:30:00Z',
    odds: { odds1: 1.7, oddsX: 3.5, odds2: 4.8 }, oddsSource: 'sporttery:had', oddsUpdatedAt: at,
    handicapLine: line, handicapOdds: { odds1: 2.05, oddsX: 3.4, odds2: 2.75 }, handicapOddsSource: 'sporttery:HHAD',
    handicapOddsUpdatedAt: stale ? '2026-09-20T00:00:00Z' : at,
    probabilityModel: { version: 'score-test', generatedAt: at, oneXTwo: { final }, calculationTrace: { poisson: { lambdas: { home, away } } } },
  };
  const decision = makeDecision(match, { now: NOW, publication: PUB, handicapCalibration: calibration }).decision;
  assert.ok(decision);
  assert.equal(validDecision(decision), true);
  return decision;
}
function assertMarginals(decision) {
  const result = buildPublishedScoreDistribution(decision, { limit: 1369 });
  assert.equal(result.status, 'available');
  const h = decision.handicapAnalysis;
  const sums = { had: { '1': 0, X: 0, '2': 0 }, hhad: { '1': 0, X: 0, '2': 0 }, conditional: { '1': 0, X: 0, '2': 0 } };
  for (const row of result.topScores) {
    assert.ok(Number.isFinite(row.probability) && row.probability > 0 && row.probability <= 1);
    assert.equal(row.hadCode, row.home > row.away ? '1' : row.home < row.away ? '2' : 'X');
    const margin = row.home - row.away + h.handicapLine;
    assert.equal(row.hhadCode, margin > 0 ? '1' : margin < 0 ? '2' : 'X');
    sums.had[row.hadCode] += row.probability;
    sums.hhad[row.hhadCode] += row.probability;
    if (row.hadCode === decision.tipCode) sums.conditional[row.hhadCode] += row.probability;
  }
  for (const c of CODES) {
    near(sums.had[c], decision.probabilities[c]);
    near(sums.hhad[c], h.overallProbabilities[c], 1e-6 + 1e-12);
    near(sums.conditional[c] / decision.modelProbability, h.probabilities[c], 1e-6 + 1e-12);
    near(sums.had[c], result.hadProbabilities[c]);
    near(sums.hhad[c], result.hhadProbabilities[c]);
  }
  near(result.topScoresProbability, 1);
  return result;
}

test('score cells reproduce published HAD and both unconditional and conditional HHAD marginals', () => {
  for (const config of [
    {}, { home: 2.8, away: .5, line: -2, final: { home: .62, draw: .23, away: .15 } },
    { home: .7, away: 1.8, line: 1, final: { home: .15, draw: .23, away: .62 } },
    { home: 12, away: 11, line: -3, final: { home: .51, draw: .2, away: .29 } },
    { home: 0, away: 1.8, line: 1, final: { home: 0, draw: .2, away: .8 } },
  ]) assertMarginals(fixture(config));
});

test('global modal draw can coexist with HAD home primary while aligned scores retain unconditional mass', () => {
  const d = fixture(), result = buildPublishedScoreDistribution(d);
  assert.equal(d.tipCode, '1');
  assert.equal(result.topScores[0].hadCode, 'X');
  assert.ok(result.alignedScores.length > 0);
  assert.ok(result.alignedScores.every(row => row.hadCode === '1' && row.hhadCode === d.handicapAnalysis.tipCode));
  const full = buildPublishedScoreDistribution(d, { limit: 1369 });
  for (const row of result.alignedScores) near(row.probability, full.topScores.find(value => value.label === row.label).probability);
  near(result.alignedProbability, d.modelProbability * d.handicapAnalysis.probabilities[d.handicapAnalysis.tipCode], 1e-6);
  assert.ok(result.topScoresProbability < 1);
  near(result.topScoresProbability + result.omittedProbability, 1);
});

test('draw plus official handicap yields only the corresponding shifted draw scores, never 100 percent individual scores', () => {
  for (const line of [-1, 1]) {
    const d = fixture({ line, final: { home: .25, draw: .5, away: .25 } });
    const result = assertMarginals(d);
    assert.equal(d.handicapAnalysis.modelProbability, 1);
    assert.ok(result.alignedScores.every(row => row.home === row.away && row.hhadCode === (line < 0 ? '2' : '1') && row.probability < .5));
    near(result.alignedProbability, .5);
  }
});

test('within-bucket scores preserve original Poisson ratios', () => {
  const result = buildPublishedScoreDistribution(fixture({ home: 2, away: .7, line: -2 }), { limit: 1369 });
  const a = result.topScores.find(row => row.label === '2-0');
  const b = result.topScores.find(row => row.label === '3-1');
  assert.equal(a.hadCode, b.hadCode); assert.equal(a.hhadCode, b.hhadCode);
  near(b.probability / a.probability, 2 * .7 / 3);
});

function calibrationFixture() {
  const decisions = [], heads = new Map();
  for (let i = 0; i < 24; i++) {
    const date = `2026-08-${String(i + 1).padStart(2, '0')}`, eventVersion = `${date}T10:00:00.000Z`;
    const sourceMatchId = `cal${i}`, eventKey = JSON.stringify([sourceMatchId, eventVersion]);
    const raw = { '1': .35, X: .25, '2': .4 };
    const body = { decisionId: `d${i}`, sourceMatchId, eventVersion, businessDate: date, publishedAt: `${date}T09:00:00.000Z`,
      homeTeamId: `h${i}`, awayTeamId: `a${i}`, tipCode: '1',
      handicapAnalysis: { version: 'handicap-margin-v2', companionPolicyVersion: 'straight-conditioned-margin-v1', straightTipCode: '1',
        handicapLine: -2, companionRawProbabilities: raw, rawProbabilities: raw, probabilities: raw, tipCode: '2' } };
    decisions.push({ ...body, recordHash: hash(body) });
    heads.set(eventKey, { eventKey, state: 'FINAL', sourceMatchId, eventVersion, observedAt: `${date}T12:00:00.000Z`, scoreHome: 3, scoreAway: 0, homeTeamId: `h${i}`, awayTeamId: `a${i}` });
  }
  return buildHandicapCalibration(decisions, heads, '2026-09-20', { asOf: NOW });
}

test('frozen calibration is reproduced inside primary HAD buckets without changing HAD mass', () => {
  const d = fixture({ home: 2, away: .7, line: -2, final: { home: .62, draw: .23, away: .15 }, calibration: calibrationFixture() });
  assert.equal(d.handicapAnalysis.historicalCalibration.applied, true);
  assertMarginals(d);
  const raw = coherentHandicapDistribution(2, .7, -2, d.probabilities, d.tipCode);
  assert.notDeepEqual(d.handicapAnalysis.probabilities, raw.conditionalProbabilities);
});

test('projection is deterministic, evidence-bound and does not mutate frozen recommendation records', () => {
  const d = fixture(), original = JSON.stringify(d);
  const result = buildPublishedScoreDistribution(d);
  assert.deepEqual(buildPublishedScoreDistribution(structuredClone(d)), result);
  assert.equal(JSON.stringify(d), original); assert.equal(validDecision(d), true);
  assert.equal(result.decisionId, d.decisionId); assert.equal(result.recordHash, d.recordHash);
  assert.equal(result.handicapInputHash, d.handicapAnalysis.inputHash);
  assert.equal(result.probabilityBasis, 'unconditional-score-matrix');
  assert.equal(result.modelValidation, 'unvalidated');
});

test('stale HHAD SP does not remove score projections supported by a frozen official handicap', () => {
  const d = fixture({ stale: true });
  assert.equal(d.handicapAnalysis.marketReference, null);
  assert.equal(buildPublishedScoreDistribution(d).status, 'available');
});

test('invalid records and missing coherent inputs return unavailable without supplemental-score fallback', () => {
  assert.equal(buildPublishedScoreDistribution(null).reason, 'decision-missing');
  const d = fixture();
  for (const change of [row => { row.recordHash = 'f'.repeat(64); }, row => { row.handicapAnalysis.lambdas.home = 5; },
    row => { row.handicapAnalysis.version = 'handicap-margin-v2'; }, row => { row.probabilities['1'] = .8; }]) {
    const invalid = structuredClone(d); change(invalid);
    assert.equal(buildPublishedScoreDistribution(invalid).reason, 'invalid-decision-record');
  }
  const hadOnly = fixture({ line: 0 });
  assert.equal(hadOnly.handicapAnalysis, null);
  assert.equal(buildPublishedScoreDistribution(hadOnly).reason, 'unsupported-distribution-version');
});

test('a valid older frozen v2 record remains valid but cannot claim coherent v3 score evidence', () => {
  const legacy = structuredClone(fixture());
  legacy.handicapAnalysis = require('./fixtures/handicap-margin-v2.json');
  delete legacy.selectionPolicyVersion;
  legacy.inputEvidence.model.handicapMarginInputHash = legacy.handicapAnalysis.inputHash;
  legacy.inputHash = hash({ hadInputHash: legacy.hadInputHash, handicapInputHash: legacy.handicapAnalysis.inputHash });
  legacy.decisionId = `decision_${hash([legacy.version, legacy.sourceMatchId, legacy.eventVersion, legacy.market, legacy.inputHash])}`;
  legacy.id = legacy.decisionId;
  const { recordHash, ...body } = legacy; legacy.recordHash = hash(body);
  assert.equal(validDecision(legacy), true);
  const original = JSON.stringify(legacy);
  assert.equal(buildPublishedScoreDistribution(legacy).reason, 'unsupported-distribution-version');
  assert.equal(JSON.stringify(legacy), original);
  assert.equal(validDecision(legacy), true);
});

test('display limits never renormalize score probabilities or truncate the aligned search prematurely', () => {
  const d = fixture(), one = buildPublishedScoreDistribution(d, { limit: 1 }), all = buildPublishedScoreDistribution(d, { limit: 1369 });
  assert.deepEqual(one.topScores, all.topScores.slice(0, 1));
  assert.deepEqual(one.alignedScores, all.alignedScores.slice(0, 1));
  assert.equal(buildPublishedScoreDistribution(d, { limit: -1 }).topScores.length, 5);
  near(one.alignedProbability, all.alignedProbability);
});
