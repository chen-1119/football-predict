'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableHash } = require('../scripts/historicalAsOfFeatureBuilder.cjs');
const { buildDynamicGoalStrengthArtifact, verifyDynamicGoalStrengthArtifact, forecastDynamicGoalStrengthV3 } = require('../scripts/dynamicGoalStrengthModel.cjs');

const asOf = '2026-10-06T10:00:00.000000100Z';
const event = { sourceMatchId: 'new-fixture', eventVersion: '2026-10-06T14:00:00Z', kickoffTime: '2026-10-06T14:00:00Z',
  cutoffAt: '2026-10-06T13:00:00Z', homeTeamId: 'alpha', awayTeamId: 'bravo', competition: 'fixture-league', neutral: false,
  status: 'SCHEDULED', isOnSale: true };
const clocks = { createdAt: '2026-10-05T10:00:00Z', availableAt: '2026-10-05T10:01:00Z' };
function syntheticEvents() {
  return Array.from({ length: 12 }, (_, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, '0')}`;
    return { sourceEventId: `synthetic-training-${i}`, date, sourceDataset: 'synthetic-v3-adapter-tests', competition: 'fixture-league',
      homeTeam: { entityId: i % 2 ? 'bravo' : 'alpha', raw: i % 2 ? 'Bravo' : 'Alpha' },
      awayTeam: { entityId: i % 2 ? 'alpha' : 'bravo', raw: i % 2 ? 'Alpha' : 'Bravo' },
      score: { home: 2 + (i % 3), away: i % 2 }, availableAt: `${date}T16:00:00.000Z` };
  });
}
const artifact = buildDynamicGoalStrengthArtifact(syntheticEvents());
const clone = value => JSON.parse(JSON.stringify(value));
const forecast = (overrides = {}) => forecastDynamicGoalStrengthV3({ artifact, event, asOf, ...clocks, ...overrides });
function rehash(value, key) { const copy = { ...value }; delete copy[key]; return { ...copy, [key]: stableHash(copy) }; }
function reseal(value) {
  const out = clone(value); out.featureArtifact = rehash(out.featureArtifact, 'artifactHash');
  out.model.finalStateHash = stableHash(out.featureArtifact.finalState); out.model.featureArtifactHash = out.featureArtifact.artifactHash;
  out.model = rehash(out.model, 'modelHash'); return rehash(out, 'artifactHash');
}
function expectedRates() {
  const state = artifact.featureArtifact.finalState, config = artifact.model.config;
  const decay = (clock, halfLife) => Math.exp(-Math.log(2) * (Date.parse(asOf) - Date.parse(clock)) / (halfLife * 86400000));
  const global = state.competitions.__global__, league = state.competitions['fixture-league'];
  const gd = decay(global.updatedAt, config.leagueHalfLifeDays), ld = decay(league.updatedAt, config.leagueHalfLifeDays);
  const globalHome = (global.homeGoals * gd + config.priorHomeGoals * config.leaguePriorMatches) / (global.weightedMatches * gd + config.leaguePriorMatches);
  const globalAway = (global.awayGoals * gd + config.priorAwayGoals * config.leaguePriorMatches) / (global.weightedMatches * gd + config.leaguePriorMatches);
  const homeBase = (league.homeGoals * ld + globalHome * config.leaguePriorMatches) / (league.weightedMatches * ld + config.leaguePriorMatches);
  const awayBase = (league.awayGoals * ld + globalAway * config.leaguePriorMatches) / (league.weightedMatches * ld + config.leaguePriorMatches);
  const attack = team => team.attack * decay(team.updatedAt, config.latentHalfLifeDays) * team.matches / (team.matches + config.coldStartPriorMatches);
  const defense = team => team.defense * decay(team.updatedAt, config.latentHalfLifeDays) * team.matches / (team.matches + config.coldStartPriorMatches);
  const bound = value => Math.min(config.maxLambda, Math.max(config.minLambda, value));
  return { home: bound(homeBase * Math.exp(attack(state.teams.alpha) - defense(state.teams.bravo))),
    away: bound(awayBase * Math.exp(attack(state.teams.bravo) - defense(state.teams.alpha))) };
}
function mappedEvent(overrides = {}) {
  return { ...event, homeTeamId: 'official-home', awayTeamId: 'official-away', competitionId: 'official-league', competition: undefined,
    entityMapping: { sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
      providerObservedAt: '2026-10-06T09:00:00Z', receivedAt: '2026-10-06T09:01:00Z',
      source: { provider: 'fixture-entity-registry', receiptHash: 'c'.repeat(64), verified: true },
      home: { sourceTeamId: 'official-home', entityId: 'alpha' }, away: { sourceTeamId: 'official-away', entityId: 'bravo' },
      competition: { sourceCompetitionId: 'official-league', entityId: 'fixture-league' } }, ...overrides };
}

test('restores a verified artifact and computes unrounded zero-market team rates using its real formula', () => {
  assert.equal(verifyDynamicGoalStrengthArtifact(artifact), true);
  const out = forecast(), expected = expectedRates();
  assert.equal(out.status, 'shadow-ready'); assert.equal(out.formalEligible, false); assert.equal(out.sourceVerification, 'unverified');
  for (const side of ['home', 'away']) assert.ok(Math.abs(out.baseRates[side] - expected[side]) < 1e-14);
  assert.notEqual(out.baseRates.home, Number(out.baseRates.home.toFixed(10)));
  assert.equal(out.baseRatesEvidence.kind, 'zero-market-team-strength'); assert.equal(out.baseRatesEvidence.marketIncluded, false);
  assert.equal(out.baseRatesEvidence.trainingReplayVerified, true);
  assert.equal(out.baseRatesEvidence.artifactHash, artifact.artifactHash);
  assert.equal(out.baseRatesEvidence.trainedThrough, artifact.model.trainingWatermark.maxConsumedAvailableAt);
  assert.equal(out.baseRatesEvidence.availableAt, clocks.availableAt);
});
test('odds and unbound display labels cannot change baseline rates or their evidence commitment', () => {
  assert.deepEqual(forecast({ odds: { odds1: 1.01 }, event: { ...event, odds: { odds1: 40, oddsX: 3, odds2: 1.01 },
    handicapLine: -7, homeTeamName: 'misleading-name', awayTeamName: 'wrong-name' } }), forecast());
});
test('bare tagged rates, missing artifacts and corrupted artifact hashes fail closed', () => {
  for (const bad of [null, { version: artifact.version, baseRates: { home: 2, away: 1 }, marketIncluded: false },
    { ...artifact, artifactHash: 'f'.repeat(64) }]) {
    const out = forecast({ artifact: bad }); assert.equal(out.status, 'blocked'); assert.equal(out.baseRates, null);
  }
});
test('a rehashed arbitrary final state is rejected by embedded training replay, beyond content seals', () => {
  const changed = clone(artifact); changed.featureArtifact.finalState.teams.alpha.attack += .01;
  const rehashed = reseal(changed); assert.equal(verifyDynamicGoalStrengthArtifact(rehashed), true);
  const out = forecast({ artifact: rehashed }); assert.equal(out.status, 'blocked');
  assert.ok(out.blockers.includes('baseline-embedded-training-replay-mismatch'));
});
test('complete final-state watermark must agree with model commitment and be known before asOf', () => {
  const changed = clone(artifact); changed.model.trainingWatermark.consumedRows -= 1;
  changed.model = rehash(changed.model, 'modelHash'); const rehashed = rehash(changed, 'artifactHash');
  assert.equal(verifyDynamicGoalStrengthArtifact(rehashed), true);
  assert.ok(forecast({ artifact: rehashed }).blockers.includes('baseline-training-watermark-incomplete-or-future'));
  const futureRows = syntheticEvents(); futureRows.at(-1).availableAt = '2026-10-06T10:00:00.000000101Z';
  assert.equal(forecast({ artifact: buildDynamicGoalStrengthArtifact(futureRows) }).status, 'blocked');
});
test('actual artifact creation and receipt clocks must precede prediction, including one-nanosecond futures', () => {
  for (const bad of [{ availableAt: asOf }, { createdAt: asOf }, { availableAt: '2026-10-06T10:00:00.000000101Z' },
    { createdAt: '2026-10-05 10:00:00' }, { availableAt: '2026-10-05T09:59:00Z' }, { createdAt: '2026-01-01T00:00:00Z' }]) {
    assert.equal(forecast(bad).status, 'blocked');
  }
  assert.equal(forecast({ availableAt: '2026-10-06T10:00:00.000000099Z' }).status, 'shadow-ready');
});
test('legacy training clock quantization cannot admit a source receipt one nanosecond after prediction', () => {
  const rows = syntheticEvents(); rows.at(-1).availableAt = '2026-10-06T10:00:00.000000101Z';
  const legacyArtifact = buildDynamicGoalStrengthArtifact(rows);
  assert.equal(legacyArtifact.model.trainingWatermark.maxConsumedAvailableAt, '2026-10-06T10:00:00.000Z');
  const out = forecast({ artifact: legacyArtifact, createdAt: '2026-10-06T10:00:00.000000050Z',
    availableAt: '2026-10-06T10:00:00.000000050Z' });
  assert.equal(out.status, 'blocked'); assert.equal(out.baseRates, null);
  assert.ok(out.blockers.includes('training-clock-precision-overlaps-as-of'));
  const nextBucket = forecast({ artifact: legacyArtifact, asOf: '2026-10-06T10:00:00.002Z',
    createdAt: '2026-10-06T10:00:00.001Z', availableAt: '2026-10-06T10:00:00.001Z' });
  assert.equal(nextBucket.status, 'shadow-ready');
  assert.equal(nextBucket.baseRatesEvidence.precisionGuard.originalClockBytesPreserved, false);
});
test('legacy training-clock upper bound must be known by actual artifact creation even when prediction is later', () => {
  const rows = syntheticEvents(); rows.at(-1).availableAt = '2026-10-06T10:00:00.000000101Z';
  const legacyArtifact = buildDynamicGoalStrengthArtifact(rows);
  const out = forecast({ artifact: legacyArtifact, asOf: '2026-10-06T10:00:00.002Z',
    createdAt: '2026-10-06T10:00:00.000000050Z', availableAt: '2026-10-06T10:00:00.000000050Z' });
  assert.equal(out.status, 'blocked');
  assert.ok(out.blockers.includes('baseline-training-precision-after-artifact-creation'));
  assert.ok(!out.blockers.includes('training-clock-precision-overlaps-as-of'));
  const exactUpperBound = forecast({ artifact: legacyArtifact, asOf: '2026-10-06T10:00:00.002Z',
    createdAt: '2026-10-06T10:00:00.000999999Z', availableAt: '2026-10-06T10:00:00.001Z' });
  assert.equal(exactUpperBound.status, 'shadow-ready', 'training knowledge may equal creation but must precede prediction');
});
test('future, finished, stopped or mismatched event clocks cannot create a pre-cutoff baseline', () => {
  for (const bad of [{ cutoffAt: asOf }, { kickoffTime: '2026-10-06T14:00:00.000001Z' }, { status: 'FINISHED' },
    { isOnSale: false }, { saleStatus: 'CLOSED' }, { neutral: undefined }, { eventVersion: '2026-10-06 14:00:00' }]) {
    assert.equal(forecast({ event: { ...event, ...bad } }).status, 'blocked');
  }
});
test('the current source event cannot be forecast from a state already trained on that event', () => {
  for (const sourceMatchId of ['synthetic-training-1', 'sporttery_synthetic-training-1']) {
    const out = forecast({ event: { ...event, sourceMatchId } });
    assert.ok(out.blockers.includes('baseline-current-event-in-training')); assert.equal(out.baseRates, null);
  }
});
test('a team name or unknown competition cannot silently substitute for exact artifact entity ids', () => {
  assert.equal(forecast({ event: { ...event, homeTeamId: 'official-home', homeTeamName: 'Alpha' } }).status, 'blocked');
  assert.equal(forecast({ event: { ...event, competition: 'unknown-league' } }).status, 'blocked');
  assert.equal(forecast({ event: { ...event, competition: '__global__' } }).status, 'blocked');
});
test('explicit source-bound entity mapping enables shadow predictions without source verification', () => {
  const out = forecast({ event: mappedEvent() }); assert.equal(out.status, 'shadow-ready');
  assert.deepEqual(out.baseRates, forecast().baseRates); assert.equal(out.sourceVerification, 'unverified');
  assert.equal(out.baseRatesEvidence.mapping.mode, 'explicit-source-bound-mapping');
});
test('mapping binds current event, each source team, competition and actual known clocks', () => {
  for (const mutate of [m => { m.sourceMatchId = 'another-event'; }, m => { m.eventVersion = '2026-10-07T14:00:00Z'; },
    m => { m.home.sourceTeamId = 'official-away'; }, m => { m.away.entityId = 'alpha'; },
    m => { m.competition.sourceCompetitionId = 'another-league'; }, m => { m.source.receiptHash = null; },
    m => { m.receivedAt = '2026-10-06T10:00:00.000000101Z'; }, m => { m.providerObservedAt = '2026-10-06T09:02:00Z'; }]) {
    const mapped = mappedEvent(); mutate(mapped.entityMapping);
    assert.equal(forecast({ event: mapped }).status, 'blocked');
  }
});
test('forecast is a pure evaluation and does not mutate the stored artifact, event or mapping', () => {
  const input = { artifact: clone(artifact), event: mappedEvent(), asOf, ...clocks }, before = structuredClone(input);
  assert.equal(forecastDynamicGoalStrengthV3(input).status, 'shadow-ready'); assert.deepEqual(input, before);
  assert.equal(forecastDynamicGoalStrengthV3(null).status, 'blocked');
});
