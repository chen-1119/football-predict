'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const { VERSION, PARAMETER_VERSION, FEATURE_SCHEMA, FEATURE_SCHEMA_HASH, buildPrematchTeamSnapshot,
  verifyPrematchTeamSnapshot, flattenPrematchTeamFeatures, applyPrematchTeamEffects } = require('../src/services/prematchTeamEvidenceV3.cjs');

const asOf = '2026-10-06T10:00:00.000Z';
const event = { sourceMatchId: 'fixture-v3', eventVersion: '2026-10-06T14:00:00.000Z', homeTeamId: 'home-v3',
  awayTeamId: 'away-v3', cutoffAt: '2026-10-06T13:00:00.000Z' };
const source = { provider: 'fixture-provider', endpoint: '/team-facts', receiptHash: 'a'.repeat(64), rawPayloadHash: 'b'.repeat(64) };
const metrics = { attack: 'provider-observed-attack-contribution-per90', defense: 'provider-observed-defense-contribution-per90' };
const clone = value => JSON.parse(JSON.stringify(value));

test('first-seen collector clocks and withdrawal meaning stay explicit; missing publication is never backdated',()=>{
 const observed='2026-10-06T09:00:00.123456Z';
 const row=observation('injuries',{availabilityMeaning:'withdrawn-from-call-up;medical-cause-unknown',
  players:[{playerId:'synthetic-player',availability:'out'}]},
  {clockBasis:'collector-response-body-completed',providerObservedAt:observed,receivedAt:observed,sourcePublishedAt:null});
 const snapshot=buildPrematchTeamSnapshot({event,asOf,observations:[row]});
 assert.equal(snapshot.observations[0].clockBasis,'collector-response-body-completed');
 assert.equal(snapshot.observations[0].sourcePublishedAt,null);
 assert.equal(snapshot.observations[0].data.availabilityMeaning,'withdrawn-from-call-up;medical-cause-unknown');
 assert.equal(snapshot.sides.home.injuries.features.knownUnavailablePlayers,1);
 assert.equal(snapshot.sides.home.injuries.features.knownUnavailableAttackGapPer90,null);
 assert.equal(verifyPrematchTeamSnapshot(snapshot),true);
 for(const changed of [{sourcePublishedAt:'2026-10-06T09:00:00.123457Z'},
   {sourcePublishedAt:'2026-10-06 09:00:00'},
   {receivedAt:'2026-10-06T09:00:00.123457Z'}]) {
  const rejected=buildPrematchTeamSnapshot({event,asOf,observations:[{...row,...changed}]});
  assert.equal(rejected.observations.length,0);
  assert.equal(rejected.sides.home.injuries.features.knownUnavailablePlayers,null);
 }
});
function observation(family, data, overrides = {}) {
  return { family, side: 'home', sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
    teamId: event.homeTeamId, source, providerObservedAt: '2026-10-06T09:00:00.000Z', receivedAt: '2026-10-06T09:01:00.000Z', data, ...overrides };
}
function players() {
  return Array.from({ length: 11 }, (_, i) => ({ playerId: `p${i}`, contributionPer90: { attack: .1, defense: .05 },
    replacementPer90: { attack: .03, defense: .01 }, expectedMinutes: 90 }));
}
function roster(status = 'confirmed', overrides = {}) {
  return observation('roster', { status, players: players(), contributionMetric: metrics, ...overrides });
}
function priorRow(family, overrides = {}) {
  return { sourceMatchId: 'earlier-event', eventVersion: '2026-10-01T11:00:00.000Z', teamId: event.homeTeamId,
    source, status: 'FINISHED', providerObservedAt: '2026-10-01T14:00:00.000Z', receivedAt: '2026-10-01T14:01:00.000Z',
    ...(family === 'history' ? { goalsFor: 2, goalsAgainst: 1 } : { observed: true, observedXgFor: 1.7, observedXgAgainst: .8 }), ...overrides };
}
test('mapping review knowledge cannot be backdated to raw receipt time, including nanoseconds and nested rows',()=>{
  const received='2026-10-06T09:01:00.000000000Z',reviewed='2026-10-06T09:01:00.000000001Z';
  const mapping={identityMappingHash:'c'.repeat(64),identityMappingReviewedAt:reviewed};
  const row=observation('xg',{rows:[priorRow('xg',{
    providerObservedAt:received,receivedAt:received,clockBasis:'collector-response-body-completed',sourcePublishedAt:null,...mapping})]},
    {providerObservedAt:received,receivedAt:received,clockBasis:'collector-response-body-completed',sourcePublishedAt:null,...mapping});
  const premature=buildPrematchTeamSnapshot({event,asOf:received,observations:[row]});
  assert.equal(premature.observations.length,0);
  assert.equal(premature.features['home.xg.sampleCount'],null);
  const usable=buildPrematchTeamSnapshot({event,asOf:reviewed,observations:[row]});
  assert.equal(usable.features['home.xg.sampleCount'],1);
  assert.equal(usable.observations[0].receivedAt,received);
  assert.equal(usable.observations[0].identityMappingReviewedAt,reviewed);
  assert.equal(usable.observations[0].data.rows[0].identityMappingHash,mapping.identityMappingHash);
  assert.equal(verifyPrematchTeamSnapshot(usable),true);
  const futureNested=clone(row); delete futureNested.identityMappingHash; delete futureNested.identityMappingReviewedAt;
  assert.equal(buildPrematchTeamSnapshot({event,asOf:received,observations:[futureNested]}).features['home.xg.sampleCount'],null);
  for(const invalid of [{identityMappingReviewedAt:'2026-10-06 09:01:00'},
    {identityMappingHash:null},{identityMappingReviewedAt:'2026-10-06T09:00:59Z'}]){
    assert.equal(buildPrematchTeamSnapshot({event,asOf:reviewed,observations:[{...row,...invalid}]}).features['home.xg.sampleCount'],null);
  }
});
function snapshot(observations = [], overrides = {}) { return buildPrematchTeamSnapshot({ event, asOf, observations, ...overrides }); }
function rehash(value) { const { contentHash, ...body } = value; return { ...body, contentHash: stableHash(body) }; }
function parameters(overrides = {}) {
  return rehash({ version: PARAMETER_VERSION, featureSchemaHash: FEATURE_SCHEMA_HASH, status: 'shadow-candidate', formalEligible: false,
    trainedThrough: '2026-10-05T14:00:00.000Z', createdAt: '2026-10-05T15:00:00.000Z', availableAt: '2026-10-05T15:01:00.000Z',
    training: { sampleCount: 100, split: 'time-ordered', trainingEventIds: ['train-only|2026-10-05T10:00:00.000Z'] },
    model: { kind: 'lambda-loglinear', intercept: { home: .01, away: -.01 }, coefficients: {
      home: { 'home.fatigue.restDays': .03 }, away: { 'home.fatigue.restDays': -.02 },
    }, maxAbsLogShift: .35, lambdaFloor: .05, lambdaCeiling: 12 }, ...overrides });
}
const fatigue = () => observation('fatigue', { lastMatchEndedAt: '2026-10-03T14:00:00.000Z', minutesLast7Days: 1200,
  minutesLast14Days: 2200, travelKm: 310, rotationCount: 3 });

test('empty evidence remains unknown with a deterministic verifiable shadow snapshot', () => {
  const out = snapshot();
  assert.equal(out.version, VERSION); assert.equal(out.status, 'shadow-ready'); assert.equal(verifyPrematchTeamSnapshot(out), true);
  assert.equal(out.formalEligible, false); assert.equal(out.sourceVerification, 'unverified');
  assert.equal(Object.keys(out.features).length, 46); assert.ok(Object.values(out.features).every(v => v === null));
  assert.equal(out.sides.home.injuries.features.knownUnavailablePlayers, null);
  assert.deepEqual(flattenPrematchTeamFeatures(out), out.features);
});
test('known provider and row hashes are preserved without upgrading verified:true into source admission', () => {
  const input = roster(); input.verified = true; input.source.verified = true;
  const out = snapshot([input]);
  assert.equal(verifyPrematchTeamSnapshot(out), true); assert.equal(out.observations[0].source.receiptHash, source.receiptHash);
  assert.match(out.observations[0].rowHash, /^[a-f0-9]{64}$/);
  assert.equal(out.observations[0].source.sourceVerification, 'unverified');
  assert.equal(out.sides.home.roster.confirmed.formalEligible, false);
});
test('confirmed and projected elevens are separate; sourced contribution and replacement gaps are quantitative', () => {
  const confirmed = roster(), projected = roster('projected'); projected.data.players[0].contributionPer90.attack = .3;
  const out = snapshot([confirmed, projected]);
  assert.equal(out.sides.home.roster.confirmed.status, 'available');
  assert.ok(Math.abs(out.features['home.roster.confirmed.attackContributionPer90'] - 1.1) < 1e-12);
  assert.ok(Math.abs(out.features['home.roster.confirmed.attackReplacementGapPer90'] - .77) < 1e-12);
  assert.ok(Math.abs(out.features['home.roster.projected.attackContributionPer90'] - 1.3) < 1e-12);
});
test('incomplete or repeated starters cannot provide lineup contribution features', () => {
  const short = roster(); short.data.players.pop();
  const duplicate = roster(); duplicate.data.players[1].playerId = duplicate.data.players[0].playerId;
  for (const row of [short, duplicate]) {
    const out = snapshot([row]); assert.equal(out.sides.home.roster.confirmed.status, 'unknown');
    assert.ok(Object.values(out.sides.home.roster.confirmed.features).every(v => v === null));
  }
});
test('player contribution requires explicit provider metric labels, complete rates and replacement values', () => {
  const unnamed = roster(); delete unnamed.data.contributionMetric;
  assert.equal(snapshot([unnamed]).features['home.roster.confirmed.attackContributionPer90'], null);
  const missing = roster(); missing.data.players[0].contributionPer90.attack = null;
  const out = snapshot([missing]); assert.equal(out.features['home.roster.confirmed.attackContributionPer90'], null);
  assert.equal(out.features['home.roster.confirmed.attackReplacementGapPer90'], null);
  assert.ok(out.features['home.roster.confirmed.defenseContributionPer90'] > 0);
});
test('event id reuse, changed event clock and side/team confusion are rejected rather than attached', () => {
  for (const changes of [{ sourceMatchId: 'another-event' }, { eventVersion: '2026-10-07T14:00:00Z' },
    { teamId: event.awayTeamId }, { side: 'away' }, { side: 'unknown' }]) {
    const out = snapshot([observation('fatigue', fatigue().data, changes)]);
    assert.equal(out.observations.length, 0); assert.equal(out.rejected.length, 1);
    assert.equal(out.features['home.fatigue.restDays'], null); assert.equal(verifyPrematchTeamSnapshot(out), true);
    assert.equal(Object.hasOwn(out.rejected[0], 'data'), false);
  }
});
test('actual received time decides knowability; provider publication alone cannot admit a future receipt', () => {
  const row = roster(); row.receivedAt = '2026-10-06T10:01:00Z';
  const out = snapshot([row]); assert.equal(out.observations.length, 0);
  assert.ok(out.rejected[0].reasons.includes('observation-not-known-at-as-of'));
  assert.equal(verifyPrematchTeamSnapshot(out), true);
});
test('future provider time, time after receipt, missing source and unzoned clocks are not numeric evidence', () => {
  for (const changes of [{ providerObservedAt: '2026-10-06T10:02:00Z' }, { providerObservedAt: '2026-10-06T09:02:00Z' },
    { receivedAt: '2026-10-06 09:01:00' }, { providerObservedAt: null }, { source: {} }]) {
    const out = snapshot([observation('fatigue', fatigue().data, changes)]);
    assert.equal(out.observations.length, 0); assert.equal(out.features['home.fatigue.restDays'], null);
  }
});
test('cutoff is strict: equality, after cutoff, live, closed or suspended event cannot freeze usable features', () => {
  for (const input of [{ asOf: event.cutoffAt }, { asOf: event.eventVersion },
    { event: { ...event, status: 'LIVE' } }, { event: { ...event, isOnSale: false } },
    { event: { ...event, saleStatus: 'SUSPENDED' } }, { event: { ...event, cutoffAt: '2026-10-06T15:00:00Z' } }]) {
    const out = snapshot([fatigue()], input); assert.equal(out.status, 'blocked'); assert.equal(verifyPrematchTeamSnapshot(out), false);
    assert.ok(Object.values(out.features).every(v => v === null));
  }
});
test('empty injuries means unknown; doubtful players never receive a manufactured absence probability', () => {
  const empty = snapshot([observation('injuries', { players: [] })]);
  assert.equal(empty.features['home.injuries.knownUnavailablePlayers'], null);
  const doubtful = { ...players()[0], availability: 'doubtful' };
  const out = snapshot([observation('injuries', { players: [doubtful], contributionMetric: metrics })]);
  assert.equal(out.features['home.injuries.knownUnavailablePlayers'], 0);
  assert.equal(out.features['home.injuries.knownUnavailableAttackGapPer90'], null);
  assert.equal(out.sides.home.injuries.status, 'partial');
});
test('confirmed unavailable contributions use source rates and replacement gaps with no probability assumption', () => {
  const unavailable = { ...players()[0], availability: 'out' };
  const out = snapshot([observation('injuries', { players: [unavailable], contributionMetric: metrics })]);
  assert.equal(out.features['home.injuries.knownUnavailablePlayers'], 1);
  assert.ok(Math.abs(out.features['home.injuries.knownUnavailableAttackGapPer90'] - .07) < 1e-12);
});
test('null, strings, booleans and non-finite fatigue inputs never coerce into zero or days', () => {
  for (const bad of [null, undefined, '', '0', false, NaN, Infinity, -1]) {
    const out = snapshot([observation('fatigue', { lastMatchEndedAt: null, restDays: bad, minutesLast7Days: bad, travelKm: bad, rotationCount: bad })]);
    assert.equal(out.features['home.fatigue.restDays'], null); assert.equal(out.features['home.fatigue.minutesLast7Days'], null);
    assert.equal(out.features['home.fatigue.travelKm'], null); assert.equal(out.features['home.fatigue.rotationCount'], null);
  }
});
test('valid rest derives from ended time; measured zero values stay zero and future end times stay unknown', () => {
  const out = snapshot([fatigue()]); assert.equal(out.features['home.fatigue.restDays'], 3);
  assert.equal(out.features['home.fatigue.minutesLast14Days'], 2200); assert.equal(out.features['home.fatigue.rotationCount'], 3);
  const zero = snapshot([observation('fatigue', { minutesLast7Days: 0, minutesLast14Days: 0, travelKm: 0, rotationCount: 0 })]);
  assert.equal(zero.features['home.fatigue.travelKm'], 0);
  const future = snapshot([observation('fatigue', { lastMatchEndedAt: '2026-10-06T11:00:00Z' })]);
  assert.equal(future.features['home.fatigue.restDays'], null);
});
test('inconsistent minute windows do not become meaningful fatigue values', () => {
  const out = snapshot([observation('fatigue', { minutesLast7Days: 1000, minutesLast14Days: 100 })]);
  assert.equal(out.features['home.fatigue.minutesLast7Days'], null); assert.equal(out.features['home.fatigue.minutesLast14Days'], null);
});
test('historical scores produce sourced prior averages and points without reading odds', () => {
  const out = snapshot([observation('history', { rows: [priorRow('history')] })]);
  assert.equal(out.features['home.history.sampleCount'], 1); assert.equal(out.features['home.history.goalsForPerMatch'], 2);
  assert.equal(out.features['home.history.pointsPerMatch'], 3); assert.equal(verifyPrematchTeamSnapshot(out), true);
  assert.match(out.observations[0].data.rows[0].rowHash, /^[a-f0-9]{64}$/);
});
test('true xG requires observed measurements, independently known prior receipts and finished prior events', () => {
  const valid = snapshot([observation('xg', { rows: [priorRow('xg')] })]);
  assert.equal(valid.features['home.xg.observedXgForPerMatch'], 1.7);
  for (const changes of [{ observed: false }, { observedXgFor: null }, { observedXgFor: '1.7' }, { teamId: event.awayTeamId },
    { receivedAt: '2026-10-06T10:01:00Z' }, { status: 'LIVE' }, { source: {} }, { eventVersion: event.eventVersion }]) {
    const out = snapshot([observation('xg', { rows: [priorRow('xg', changes)] })]);
    assert.equal(out.features['home.xg.observedXgForPerMatch'], null); assert.equal(out.features['home.xg.sampleCount'], null);
  }
});
test('duplicate earlier match samples do not inflate history or observed xG', () => {
  for (const family of ['history', 'xg']) {
    const out = snapshot([observation(family, { rows: [priorRow(family), priorRow(family)] })]);
    assert.equal(out.sides.home[family].status, 'conflict'); assert.equal(out.features[`home.${family}.sampleCount`], null);
  }
});
test('same-time conflicting source values block that family; repeated identical observations are deduplicated', () => {
  const one = fatigue(), two = fatigue(); two.data.travelKm = 999;
  const out = snapshot([one, two]); assert.equal(out.sides.home.fatigue.status, 'conflict');
  assert.equal(out.features['home.fatigue.travelKm'], null); assert.equal(snapshot([one, one]).observations.length, 1);
});
test('snapshot order, extra odds and display metadata do not change a team snapshot', () => {
  const one = fatigue(), two = roster(); const original = snapshot([one, two]);
  const changed = clone({ event, asOf, observations: [two, one] });
  changed.event.odds = { odds1: 1.01, oddsX: 500, odds2: 900 }; changed.odds = { odds1: 400 };
  changed.observations[0].odds = { odds1: 90 }; changed.observations[0].data.odds = { odds1: 40 };
  assert.deepEqual(buildPrematchTeamSnapshot(changed), original);
});
test('building and applying do not mutate input evidence or base rates', () => {
  const input = { event: clone(event), asOf, observations: [roster(), fatigue()] }, before = clone(input);
  const out = buildPrematchTeamSnapshot(input); assert.deepEqual(input, before);
  const rates = { home: 1.3, away: 1.1 }, ratesBefore = clone(rates), stored = clone(out);
  applyPrematchTeamEffects(out, rates, parameters()); assert.deepEqual(rates, ratesBefore); assert.deepEqual(out, stored);
});
test('verifier rejects rehashed feature edits and false source admission as well as evidence tampering', () => {
  const original = snapshot([fatigue()]);
  const edited = clone(original); edited.features['home.fatigue.restDays'] = 99;
  assert.equal(verifyPrematchTeamSnapshot(rehash(edited)), false);
  const upgraded = clone(original); upgraded.sourceVerification = 'verified'; upgraded.formalEligible = true;
  assert.equal(verifyPrematchTeamSnapshot(rehash(upgraded)), false);
  const leaked = clone(original); leaked.observations[0].receivedAt = '2026-10-06T10:02:00Z';
  assert.equal(verifyPrematchTeamSnapshot(rehash(leaked)), false);
});
test('missing trained parameters explicitly block with unchanged goal rates', () => {
  const out = applyPrematchTeamEffects(snapshot([fatigue()]), { home: 1.3, away: 1.1 });
  assert.equal(out.status, 'blocked'); assert.equal(out.applied, false); assert.deepEqual(out.after, out.before);
  assert.ok(out.blockers.includes('trained-parameters-missing')); assert.equal(out.receipt, null);
});
test('fitted loglinear parameters actually change lambdas and retain before/after feature/parameter receipts', () => {
  const s = snapshot([fatigue()]), artifact = parameters(), base = { home: 1.3, away: 1.1 };
  const out = applyPrematchTeamEffects(s, base, artifact);
  assert.equal(out.status, 'shadow-applied'); assert.equal(out.applied, true);
  assert.ok(Math.abs(out.after.home - base.home * Math.exp(.1)) < 1e-12);
  assert.ok(Math.abs(out.after.away - base.away * Math.exp(-.07)) < 1e-12);
  assert.equal(out.receipt.snapshotHash, s.contentHash); assert.equal(out.receipt.parameterHash, artifact.contentHash);
  assert.equal(out.receipt.shifts.home.terms[0].value, 3); assert.equal(out.formalEligible, false);
  const { contentHash, ...body } = out.receipt; assert.equal(stableHash(body), contentHash);
});
test('parameter hash, schema, training clocks, artifact availability and same-event training are binding', () => {
  const s = snapshot([fatigue()]), good = parameters();
  const candidates = [ { ...good, contentHash: 'f'.repeat(64) }, parameters({ featureSchemaHash: 'f'.repeat(64) }),
    parameters({ trainedThrough: asOf }), parameters({ availableAt: '2026-10-06T10:01:00Z' }), parameters({ createdAt: asOf }),
    parameters({ training: { ...good.training, trainingEventIds: [`${event.sourceMatchId}|${event.eventVersion}`] } }),
    parameters({ training: { ...good.training, split: 'random' } }), parameters({ formalEligible: true }) ];
  for (const artifact of candidates) {
    const out = applyPrematchTeamEffects(s, { home: 1.3, away: 1.1 }, artifact);
    assert.equal(out.status, 'blocked'); assert.deepEqual(out.after, out.before);
  }
});
test('a fitted coefficient cannot silently impute an unknown feature or refer to odds', () => {
  const s = snapshot([fatigue()]), good = parameters();
  for (const coefficients of [{ home: { 'home.xg.observedXgForPerMatch': .1 }, away: {} },
    { home: { 'home.odds.odds1': .1 }, away: {} }]) {
    const out = applyPrematchTeamEffects(s, { home: 1.3, away: 1.1 }, parameters({ model: { ...good.model, coefficients } }));
    assert.equal(out.status, 'blocked'); assert.deepEqual(out.after, out.before);
  }
});
test('parameter caps are applied in log space and are explicit rather than default coefficients', () => {
  const s = snapshot([fatigue()]), good = parameters();
  const artifact = parameters({ model: { ...good.model, coefficients: { home: { 'home.fatigue.restDays': 10 }, away: {} } } });
  const out = applyPrematchTeamEffects(s, { home: 1, away: 1 }, artifact);
  assert.equal(out.applied, true); assert.equal(out.receipt.shifts.home.appliedLogShift, .35);
  assert.ok(Math.abs(out.after.home - Math.exp(.35)) < 1e-12);
  assert.equal(FEATURE_SCHEMA.features.includes('home.fatigue.restDays'), true);
});
test('explicit fitted lambda bounds are enforced and missing or inverted bounds cannot apply', () => {
  const s = snapshot([fatigue()]), good = parameters();
  const out = applyPrematchTeamEffects(s, { home: 100, away: .001 }, good);
  assert.equal(out.after.home, 12); assert.equal(out.after.away, .05);
  assert.deepEqual(out.receipt.rateBounds, { floor: .05, ceiling: 12 });
  for (const model of [{ ...good.model, lambdaFloor: null }, { ...good.model, lambdaFloor: 13 },
    { ...good.model, lambdaFloor: 2, lambdaCeiling: 1 }]) {
    assert.equal(applyPrematchTeamEffects(s, { home: 1, away: 1 }, parameters({ model })).status, 'blocked');
  }
});
test('malformed input and training metadata fail closed without throwing', () => {
  assert.equal(buildPrematchTeamSnapshot(null).status, 'blocked');
  const s = snapshot([fatigue()]), good = parameters();
  for (const training of [null, { ...good.training, trainingEventIds: 'bad' }, { ...good.training, trainingEventIds: [null] }]) {
    assert.equal(applyPrematchTeamEffects(s, { home: 1, away: 1 }, parameters({ training })).status, 'blocked');
  }
  assert.equal(applyPrematchTeamEffects(null, null, null).status, 'blocked');
});
test('a re-versioned source match cannot be used to train its own target effects', () => {
  const s = snapshot([fatigue()]), good = parameters();
  const artifact = parameters({ training: { ...good.training, trainingSourceMatchIds: [event.sourceMatchId] } });
  const out = applyPrematchTeamEffects(s, { home: 1, away: 1 }, artifact);
  assert.ok(out.blockers.includes('current-event-in-parameter-training'));
});
test('retained inner model, training input and schema hashes cannot be bypassed by rehashing the outer artifact', () => {
  const s = snapshot([fatigue()]), good = parameters();
  const artifact = parameters({ parametersHash: stableHash(good.model), featureSchema: FEATURE_SCHEMA,
    training: { ...good.training, inputHashes: ['c'.repeat(64)], artifactHash: stableHash(['c'.repeat(64)]), knowledgeThrough: good.trainedThrough } });
  assert.equal(applyPrematchTeamEffects(s, { home: 1, away: 1 }, artifact).applied, true);
  const changedModel = clone(artifact); changedModel.model.coefficients.home['home.fatigue.restDays'] = .3;
  const changedInputs = clone(artifact); changedInputs.training.inputHashes.push('d'.repeat(64));
  const changedSchema = clone(artifact); changedSchema.featureSchema.features.push('home.odds.odds1');
  const changedClock = clone(artifact); changedClock.training.knowledgeThrough = '2026-10-05T14:01:00Z';
  for (const changed of [changedModel, changedInputs, changedSchema, changedClock]) {
    const out = applyPrematchTeamEffects(s, { home: 1, away: 1 }, rehash(changed));
    assert.equal(out.status, 'blocked'); assert.deepEqual(out.after, out.before);
  }
});
test('microsecond and nanosecond source bytes are retained while future same-millisecond receipts are rejected', () => {
  const preciseAsOf = '2026-10-06T10:00:00.000000100Z';
  const known = observation('fatigue', fatigue().data, { providerObservedAt: '2026-10-06T10:00:00.000000098Z', receivedAt: '2026-10-06T10:00:00.000000099Z' });
  const out = snapshot([known], { asOf: preciseAsOf });
  assert.equal(verifyPrematchTeamSnapshot(out), true); assert.equal(out.asOf, preciseAsOf);
  assert.equal(out.observations[0].receivedAt, known.receivedAt); assert.equal(out.features['home.fatigue.restDays'], 3);
  const future = { ...known, receivedAt: '2026-10-06T10:00:00.000000101Z' };
  assert.equal(snapshot([future], { asOf: preciseAsOf }).observations.length, 0);
  const pastProviderFutureReceipt = { ...known, providerObservedAt: '2026-10-06T10:00:00.000000100Z', receivedAt: '2026-10-06T10:00:00.000000099Z' };
  assert.equal(snapshot([pastProviderFutureReceipt], { asOf: preciseAsOf }).observations.length, 0);
});
test('precise cutoff and precise latest receipt ordering never collapse to the same millisecond', () => {
  const preciseEvent = { ...event, cutoffAt: '2026-10-06T10:00:00.000000101Z' };
  assert.equal(snapshot([fatigue()], { event: preciseEvent, asOf: '2026-10-06T10:00:00.000000100Z' }).status, 'shadow-ready');
  assert.equal(snapshot([fatigue()], { event: preciseEvent, asOf: '2026-10-06T10:00:00.000000101Z' }).status, 'blocked');
  const earlier = { ...fatigue(), receivedAt: '2026-10-06T09:01:00.000000100Z' };
  const later = { ...fatigue(), receivedAt: '2026-10-06T09:01:00.000000101Z', data: { ...fatigue().data, travelKm: 700 } };
  const out = snapshot([earlier, later]); assert.equal(out.features['home.fatigue.travelKm'], 700);
  assert.equal(out.sides.home.fatigue.status, 'available');
});
test('parameter actual availability later by one nanosecond is still unavailable', () => {
  const preciseAsOf = '2026-10-06T10:00:00.000000100Z', s = snapshot([fatigue()], { asOf: preciseAsOf });
  const future = parameters({ availableAt: '2026-10-06T10:00:00.000000101Z' });
  assert.equal(applyPrematchTeamEffects(s, { home: 1, away: 1 }, future).status, 'blocked');
  const past = parameters({ availableAt: '2026-10-06T10:00:00.000000099Z' });
  assert.equal(applyPrematchTeamEffects(s, { home: 1, away: 1 }, past).applied, true);
});
test('same event clocks may use different zones but different nanoseconds cannot confuse identity', () => {
  const preciseEvent = { ...event, eventVersion: '2026-10-06T14:00:00.123456789Z' };
  const matched = { ...fatigue(), eventVersion: '2026-10-06T22:00:00.123456789+08:00' };
  const mismatched = { ...matched, eventVersion: '2026-10-06T22:00:00.123456790+08:00' };
  assert.equal(snapshot([matched], { event: preciseEvent }).observations.length, 1);
  assert.equal(snapshot([mismatched], { event: preciseEvent }).observations.length, 0);
  const row = priorRow('history'), sameRowAnotherZone = { ...row, eventVersion: '2026-10-01T19:00:00.000000000+08:00' };
  assert.equal(snapshot([observation('history', { rows: [row, sameRowAnotherZone] })]).sides.home.history.status, 'conflict');
});
