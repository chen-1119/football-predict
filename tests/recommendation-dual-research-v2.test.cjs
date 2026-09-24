'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { match, publication, validators } = require('./recommendationFixture.cjs');
const { withVerifiedInputEvidence } = require('./fixtures/recommendation-input-helper.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const { collectResults } = require('../scripts/recommendationPlatform/results.cjs');
const { createDualResearchV2Record, validDualResearchV2Record, settleDualResearchV2, VERSION } =
  require('../scripts/recommendationPlatform/dualChoiceResearchV2.cjs');

const NOW = Date.parse('2026-09-17T13:00:00Z');
const SP = { odds1: 2.05, oddsX: 3.4, odds2: 2.75 };
function input({ had = false, hhad = true, id = 1, ...patch } = {}) {
  const raw = match(id, NOW, {
    odds: had ? { odds1: 1.8, oddsX: 3.5, odds2: 4.5 } : null,
    oddsSource: had ? 'sporttery:had' : null,
    handicapLine: hhad ? -2 : null,
    handicapOdds: hhad ? SP : null,
    handicapOddsSource: hhad ? 'sporttery:HHAD' : null,
    handicapOddsUpdatedAt: hhad ? new Date(NOW).toISOString() : null,
    ...patch,
  });
  raw.probabilityModel.calculationTrace = { poisson: { lambdas: { home: 2.2, away: .6 } } };
  return withVerifiedInputEvidence(raw);
}
const create = (m, at = NOW, pub = publication(NOW)) =>
  createDualResearchV2Record(m, { now: at, publication: pub });

function resultHead(m, home, away, disposition = 'FINAL') {
  const row = { ...m, status: disposition === 'FINAL' ? 'FINISHED' : 'SCHEDULED',
    resultDisposition: disposition === 'VOID' ? 'VOID' : null,
    testOfficial: true, scoreHome: home, scoreAway: away, resultRevision: 1 };
  const { updates } = collectResults([row], new Map(), validators, NOW + 9 * 3600000);
  assert.equal(updates.length, 1);
  return updates[0];
}

test('without a HAD sale, freeze two different official HHAD directions from one line and one quote', () => {
  const m = input(), before = JSON.stringify(m), r = create(m);
  assert(r); assert.equal(r.version, VERSION); assert.equal(r.decisionId, null);
  assert.equal(r.formalPromotion, false); assert.equal(r.cohort, 'independent-research-only');
  assert.deepEqual(r.selections.map(s => s.market), ['HHAD', 'HHAD']);
  assert.equal(new Set(r.selections.map(s => s.tipCode)).size, 2);
  assert.deepEqual(r.selections.map(s => s.handicapLine), [-2, -2]);
  assert.equal(new Set(r.selections.map(s => s.quoteSnapshotHash)).size, 1);
  assert(r.selections.every(s => s.odds === r.selections[0].quoteOdds[s.tipCode]));
  assert.equal(r.bothProbability, 0);
  assert.equal(r.unionProbability, Number(r.selectionProbabilities.reduce((a, b) => a + b, 0).toFixed(6)));
  assert.equal(r.totalStake, 2); assert.equal(r.stakePerSelection, 1);
  assert(validDualResearchV2Record(r, m));
  assert(validDualResearchV2Record(r, r.inputSnapshot));
  assert.equal(JSON.stringify(m), before);
});

test('available official markets form a market-neutral pool without a fixed direction pair', () => {
  const hadOnly = create(input({ had: true, hhad: false }));
  assert(hadOnly); assert.deepEqual(hadOnly.selections.map(s => s.market), ['HAD', 'HAD']);
  assert.equal(hadOnly.bothProbability, 0);
  const mixed = create(input({ had: true }));
  assert(mixed); assert.deepEqual(mixed.selections.map(s => s.market), ['HAD', 'HHAD']);
  assert(mixed.bothProbability > 0);
  assert.equal(mixed.unionProbability, Number((mixed.selectionProbabilities[0]
    + mixed.selectionProbabilities[1] - mixed.bothProbability).toFixed(6)));
  assert.equal(create(input({ had: false, hhad: false })), null);
});

test('an explicit non-HHAD pool code cannot authorize an HHAD leg', () => {
  assert.equal(create(input({ handicapOddsPoolCode: 'HAD' })), null);
  const hadOnly = create(input({ had: true, handicapOddsPoolCode: 'HAD' }));
  assert(hadOnly);
  assert.deepEqual(hadOnly.selections.map(s => s.market), ['HAD', 'HAD']);
  const valid = create(input({ handicapOddsPoolCode: 'HHAD' }));
  assert(valid);
  assert.equal(valid.inputSnapshot.handicapOddsPoolCode, 'HHAD');
  assert(validDualResearchV2Record(valid, valid.inputSnapshot));
});

test('quote, cutoff, identity, model arithmetic and sample gates fail closed', () => {
  assert.equal(create(input({ handicapOddsSource: '500.com:jczq:HHAD' })), null);
  assert.equal(create(input({ handicapOddsUpdatedAt: new Date(NOW - 16 * 60000).toISOString() })), null);
  assert.equal(create(input({ handicapLine: -0.5 })), null);
  assert.equal(create(input({ handicapOdds: { ...SP, oddsX: null } })), null);
  assert.equal(create(input({ externalSignals: { bookmakerOdds: { hhad: {
    ...SP, source: 'sporttery:HHAD', handicapLine: -1,
    sourceMatchId: '1', eventVersion: '2026-09-17T15:00:00Z',
    receivedAt: new Date(NOW).toISOString(),
  } } } })), null);
  assert.equal(create(input({ externalSignals: { bookmakerOdds: { hhad: {
    ...SP, source: 'sporttery:HHAD', handicapLine: -2,
    sourceMatchId: 'wrong', eventVersion: '2026-09-17T15:00:00Z',
    receivedAt: new Date(NOW).toISOString(),
  } } }, handicapOdds: null })), null);
  assert.equal(create(input({ saleStatus: 'SUSPENDED' })), null);
  assert.equal(create(input({ buyEndTime: new Date(NOW).toISOString() })), null);
  assert.equal(create(input({ homeTeamId: 'wrong', awayTeamId: 'wrong' })), null);
  const invalid = input(); invalid.probabilityModel.inputEvidence.proof.receipts[0] = '{}';
  assert.equal(create(invalid), null);
  const weak = withVerifiedInputEvidence(input(), { eloHome: 0, eloAway: 0 });
  assert.equal(create(weak), null);
});

test('a committed older generation may pair with a new official HHAD quote while the model age gate holds', () => {
  const pub = { ...publication(NOW), committedAt: new Date(NOW - 30 * 60000).toISOString() };
  const older = input();
  older.probabilityModel.generatedAt = new Date(NOW - 40 * 60000).toISOString();
  const m = withVerifiedInputEvidence(older);
  assert(create(m, NOW, pub));
  assert.equal(create(m, NOW, { ...pub, committedAt: new Date(NOW + 1).toISOString() }), null);
  assert.equal(create(input(), NOW, pub), null, 'model cannot postdate its committed generation');
});

test('record rehashing cannot change a frozen selection, price, line, probability or model proof', () => {
  const m = input(), r = create(m);
  for (const mutate of [
    v => { v.selections[0].odds = 9; },
    v => { v.selections[0].tipCode = v.selections[1].tipCode; },
    v => { v.selections[0].handicapLine = -1; },
    v => { v.unionProbability = 1; },
    v => { v.modelEvidenceHash = '0'.repeat(64); },
    v => { v.inputSnapshot.handicapOdds.odds1 = 9; v.inputSnapshotHash = hash(v.inputSnapshot); },
  ]) {
    const altered = structuredClone(r); mutate(altered);
    const { recordHash, ...body } = altered; altered.recordHash = hash(body);
    assert.equal(validDualResearchV2Record(altered, m), false);
    assert.throws(() => settleDualResearchV2(altered, undefined), /Invalid dual-choice/);
  }
});

test('settlement counts two unit stakes, market lines separately, and no accumulator payout', () => {
  const m = input(), r = create(m);
  const won = settleDualResearchV2(r, resultHead(m, 3, 0));
  assert.equal(won.state, 'WON');
  assert.equal(won.selections.filter(s => s.state === 'WON').length, 1);
  assert.equal(won.grossReturn, won.selections.find(s => s.state === 'WON').odds);
  assert.equal(won.netProfit, Number((won.grossReturn - 2).toFixed(6)));
  const none = settleDualResearchV2(r, resultHead(m, 2, 0));
  assert.equal(none.state, 'LOST'); assert.equal(none.grossReturn, 0); assert.equal(none.netProfit, -2);
  const voided = settleDualResearchV2(r, resultHead(m, null, null, 'VOID'));
  assert.equal(voided.state, 'VOID'); assert.equal(voided.grossReturn, 2); assert.equal(voided.netProfit, 0);
  assert.equal(settleDualResearchV2(r, undefined).state, 'PENDING');
  const conflicting = { ...resultHead(m, 3, 0), sourceMatchId: 'wrong' };
  assert.equal(settleDualResearchV2(r, conflicting).state, 'DISPUTED');
  const mixed = create(input({ had: true }));
  const settledMixed = settleDualResearchV2(mixed, resultHead(input({ had: true }), 3, 0));
  assert.equal(settledMixed.grossReturn, Number(settledMixed.selections
    .filter(s => s.state === 'WON').reduce((n, s) => n + s.odds, 0).toFixed(6)));
});
