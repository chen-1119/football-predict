'use strict';
// Synthetic integration assertions; fixture generation registers no tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const { forecastDynamicGoalStrengthV3 } = require('../scripts/dynamicGoalStrengthModel.cjs');
const { FEATURE_SCHEMA_HASH } = require('../src/services/prematchTeamEvidenceV3.cjs');
const { eventFromMatch, outcomeProjection, verifyPrematchV3Assessment } = require('../src/services/prematchV3Assessment.cjs');
const { predictionRecordHash } = require('../src/services/prematchV3Learning.cjs');
const { freezePrematchV3Record, joinPrematchV3ResearchResult } = require('../src/services/prematchV3FrozenRecord.cjs');
const { match, options, asOf, baseline, parameters, syntheticResult, clone, reseal, close, build, learned } = require('./fixtures/prematch-v3-synthetic.cjs');

test('synthetic build/restore/team-effect/assessment pipeline calculates with bound receipts and source limits', () => {
  const before = clone({ match, options });
  const direct = forecastDynamicGoalStrengthV3({ ...baseline, event: eventFromMatch(match), asOf });
  const out = build();
  assert.equal(direct.status, 'shadow-ready'); assert.equal(out.status, 'shadow-calculated'); assert.deepEqual(out.blockers, []);
  assert.deepEqual(out.baseline.baseRates, direct.baseRates); assert.equal(out.effects.status, 'shadow-applied');
  assert.ok(Object.values(out.teamSnapshot.features).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.equal(out.teamSnapshot.observations.length, 12); assert.equal(out.asianTimeline.observationCount, 6);
  assert.equal(out.sourceVerification, 'unverified'); assert.equal(out.formalEligible, false); assert.equal(out.productionEligible, false);
  assert.equal(out.primary, null); assert.equal(out.companion, null);
  const receipt = out.effects.receipt;
  assert.deepEqual(receipt.event, out.teamSnapshot.event); assert.equal(receipt.asOf, asOf);
  assert.equal(receipt.snapshotHash, out.teamSnapshot.contentHash); assert.equal(receipt.parameterHash, parameters.contentHash);
  assert.deepEqual(receipt.before, direct.baseRates); assert.notDeepEqual(receipt.after, receipt.before);
  assert.equal(parameters.training.sampleCount, 24); assert.equal(parameters.training.inputHashes.length, 24);
  assert.equal(learned.originalDeployment, false); assert.equal(learned.prospectiveEligible, false);
  assert.ok(parameters.training.optimization.completedIterations > 0);
  assert.equal(receipt.parameterHash, learned.artifact.contentHash, 'the fitted artifact actually drives these future rates');
  for (const side of ['home', 'away']) {
    const expectedShift = receipt.shifts[side].terms.reduce((n, term) => n + term.value * term.coefficient, receipt.shifts[side].intercept);
    close(receipt.shifts[side].unclampedLogShift, expectedShift);
    const shift = Math.max(-parameters.model.maxAbsLogShift, Math.min(parameters.model.maxAbsLogShift, expectedShift));
    close(receipt.after[side], Math.max(parameters.model.lambdaFloor,
      Math.min(parameters.model.lambdaCeiling, receipt.before[side] * Math.exp(shift))));
  }
  assert.equal(verifyPrematchV3Assessment(out, { match, options }), true);
  assert.deepEqual({ match, options }, before);
});

test('adaptive Poisson support supplies HAD, integer HHAD and exact Top3 without a fixed score quota', () => {
  const out = build(), team = out.comparisons.teamOnly, raw = outcomeProjection(out.effects.after, match.handicapLine);
  const matrix = raw.scoreDistribution;
  assert.ok(Math.max(...matrix.rows.map(row => row.home)) > 8);
  assert.ok(matrix.tailMass <= 1e-10); assert.equal(team.scoreDistributionHash, stableHash(matrix));
  close(Object.values(team.probabilities).reduce((a, b) => a + b, 0) + matrix.tailMass, 1);
  const hhad = { '1': 0, X: 0, '2': 0 };
  for (const row of matrix.rows) {
    const adjusted = row.home - row.away - 1; hhad[adjusted > 0 ? '1' : adjusted < 0 ? '2' : 'X'] += row.probability;
  }
  assert.equal(team.hhAd.market, 'HHAD'); assert.deepEqual(team.hhAd.probabilities, hhad);
  const expectedTop3 = matrix.rows.slice().sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away).slice(0, 3);
  assert.deepEqual(team.scoreTop3, expectedTop3); assert.equal(team.scoreTop3.length, 3);
  assert.ok(team.scoreTop3.every(row => row.probability > 0));
});

test('AH prices retain all five settlement classes and derive price expectation from the team goal rows', () => {
  const out = build(); assert.equal(out.asianPrices.length, 6);
  const classes = ['fullWin', 'halfWin', 'push', 'halfLoss', 'fullLoss'];
  const totals = Object.fromEntries(classes.map(key => [key, 0]));
  for (const quote of out.asianPrices) {
    assert.equal(quote.available, true); assert.equal(quote.market, 'AH'); assert.equal(quote.formalEligible, false);
    assert.deepEqual(Object.keys(quote.probabilities), classes);
    const p = quote.probabilities;
    close(Object.values(p).reduce((a, b) => a + b, 0) + quote.tailMass, 1);
    close(quote.expectedNetReturn, (p.fullWin + p.halfWin / 2) * (quote.decimalOdds - 1) - p.halfLoss / 2 - p.fullLoss);
    close(quote.expectedGrossReturn, quote.expectedNetReturn + quote.probabilityMass);
    for (const key of classes) totals[key] += p[key];
  }
  assert.ok(classes.every(key => totals[key] > 0), 'integer and both quarter lines exercise every settlement category');
  assert.equal(out.asianTimeline.streams[0].segments[0].priceChanges.length, 0);
  assert.ok(out.asianTimeline.streams.some(stream => stream.lineTransitions.length === 1));
});

test('same-time market and 50/50 comparator remain separate from baseline and team-rate effects', () => {
  const out = build(), reference = out.comparisons.marketOnly, hybrid = out.comparisons.hybrid;
  assert.equal(reference.available, true); assert.equal(hybrid.formalEligible, false);
  assert.match(hybrid.role, /fixed-50\/50-research-comparator/); assert.deepEqual(hybrid.weights, { team: .5, market: .5 });
  for (const outcome of ['1', 'X', '2']) close(hybrid.probabilities[outcome],
    (out.comparisons.teamOnly.probabilities[outcome] + reference.probabilities[outcome]) / 2);
  const changed = clone(match); changed.odds = { odds1: 1.5, oddsX: 7, odds2: 8 };
  const changedOut = build(changed);
  assert.deepEqual(changedOut.baseline, out.baseline); assert.deepEqual(changedOut.teamSnapshot, out.teamSnapshot);
  assert.deepEqual(changedOut.effects, out.effects); assert.deepEqual(changedOut.comparisons.teamOnly, out.comparisons.teamOnly);
  assert.notDeepEqual(changedOut.comparisons.marketOnly.probabilities, reference.probabilities);
  assert.notDeepEqual(changedOut.comparisons.hybrid.probabilities, hybrid.probabilities);
});

test('cutoff and stopped sale null the calculable team and mixed projections with complete inputs', () => {
  for (const [m, o] of [[match, { ...options, asOf: match.predictionMeta.cutoffTime }], [{ ...match, isOnSale: false }, options]]) {
    const out = build(m, o); assert.equal(out.status, 'blocked'); assert.equal(out.baseline.baseRates, null);
    assert.equal(out.comparisons.teamOnly, null); assert.equal(out.comparisons.hybrid, null); assert.equal(out.effects.receipt, null);
    assert.equal(out.asianPrices.length, 0); assert.ok(out.blockers.includes('event-or-sale-clock-ineligible'));
    assert.equal(verifyPrematchV3Assessment(out, { match: m, options: o }), true);
  }
});

test('future source clocks and corrupt parameter seals block effects and cannot verify an earlier assessment', () => {
  const original = build(), future = clone(match);
  const fatigue = future.externalSignals.prematchV3.teamObservations.find(row => row.family === 'fatigue' && row.side === 'home');
  fatigue.receivedAt = '2026-10-06T10:00:00.000000101Z';
  const changed = build(future); assert.equal(changed.status, 'blocked'); assert.equal(changed.comparisons.teamOnly, null);
  assert.ok(changed.effects.blockers.includes('required-feature-unknown:home.fatigue.restDays'));
  assert.equal(verifyPrematchV3Assessment(original, { match: future, options }), false);
  const altered = clone(parameters); altered.model.coefficients.home['home.fatigue.restDays'] += .01;
  const unsealed = build(match, { ...options, parameters: altered });
  assert.ok(unsealed.blockers.includes('parameter-artifact-hash-mismatch')); assert.equal(unsealed.comparisons.teamOnly, null);
  const onlyOuterResealed = build(match, { ...options, parameters: reseal(altered) });
  assert.ok(onlyOuterResealed.blockers.includes('parameters-hash-mismatch'));
  assert.equal(verifyPrematchV3Assessment(original, { match, options: { ...options, parameters: altered } }), false);
});

test('assessment verification requires original inputs and replay beyond an outer content seal', () => {
  const out = build(); assert.equal(verifyPrematchV3Assessment(out), false);
  assert.equal(verifyPrematchV3Assessment(out, { match }), false, 'external baseline and parameter inputs must also be supplied');
  const altered = clone(out); altered.comparisons.teamOnly.probabilities['1'] += .01;
  assert.equal(verifyPrematchV3Assessment(reseal(altered), { match, options }), false);
  const foreign = clone(match); foreign.sourceMatchId = 'another-synthetic-event';
  assert.equal(verifyPrematchV3Assessment(out, { match: foreign, options }), false);
  assert.equal(verifyPrematchV3Assessment(out, { match, options }), true);
});

test('freezing and joining a later result keeps original prediction bytes and hash unchanged', () => {
  const assessment = build(), frozen = freezePrematchV3Record(assessment, { match, options });
  assert.ok(frozen); assert.equal(frozen.result, null); assert.equal(frozen.frozen, true);
  assert.equal(frozen.formalEligible, false); assert.equal(frozen.asOf, asOf);
  const original = clone(frozen), joined = joinPrematchV3ResearchResult(frozen, syntheticResult(match));
  assert.deepEqual(frozen, original); assert.equal(frozen.result, null);
  assert.notEqual(joined.contentHash, frozen.contentHash); assert.equal(joined.predictionHash, frozen.predictionHash);
  assert.equal(predictionRecordHash(joined), predictionRecordHash(frozen));
  assert.deepEqual(joined.featureVector, frozen.featureVector); assert.deepEqual(joined.baseRatesEvidence, frozen.baseRatesEvidence);
  assert.equal(joined.result.match.scoreHome, 3);
  const wrong = syntheticResult({ ...match, sourceMatchId: 'another-synthetic-event' });
  assert.throws(() => joinPrematchV3ResearchResult(frozen, wrong), /V3_FREEZE_RESULT_EVENT_MISMATCH/);
  assert.equal(freezePrematchV3Record(assessment), null, 'freezing still requires original input replay');
});

test('missing parameters still allow pre-cutoff base-feature freeze to bootstrap future fitting', () => {
  const noParameters = { asOf, baseline }, assessment = build(match, noParameters);
  assert.equal(assessment.status, 'blocked'); assert.equal(assessment.baseline.status, 'shadow-ready');
  assert.equal(assessment.comparisons.teamOnly, null); assert.equal(assessment.effects.applied, false);
  assert.ok(assessment.blockers.includes('trained-parameters-missing'));
  const frozen = freezePrematchV3Record(assessment, { match, options: noParameters });
  assert.ok(frozen); assert.equal(frozen.featureSchemaHash, FEATURE_SCHEMA_HASH);
  assert.ok(Object.values(frozen.featureVector).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.deepEqual(frozen.baseRates, assessment.baseline.baseRates);
  assert.equal(frozen.baseRatesEvidence.marketIncluded, false); assert.equal(frozen.result, null);
  const postOptions = { ...noParameters, asOf: match.predictionMeta.cutoffTime }, post = build(match, postOptions);
  assert.equal(freezePrematchV3Record(post, { match, options: postOptions }), null);
});
