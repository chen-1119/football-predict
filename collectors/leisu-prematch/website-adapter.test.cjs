'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scope = require('./scope.cjs');
const { selectEvidence } = require('./website-adapter.cjs');

const NOW = '2026-09-12T13:40:00.000Z';
function row(kickoffTime = '2026-09-12T14:00:00.000Z') {
  return { id: 'sporttery_123', sourceMatchId: '123', homeTeamName: '主队', awayTeamName: '客队',
    kickoffTime, eventVersion: kickoffTime, status: 'SCHEDULED', leagueName: '测试联赛' };
}
function sample(current = row(), now = NOW) {
  const fixture = scope.selectFixtures([current], now).selected[0];
  const generatedAt = new Date(Date.parse(now) - 60000).toISOString();
  const success = { siteMatchId: fixture.siteMatchId, eventVersion: fixture.eventVersion,
    providerMatchId: '456', kind: 'injuries', status: 'available', receivedAt: '2026-09-12T12:00:00.000Z',
    sourceUrl: 'https://live.leisu.com/shujufenxi-456', sourcePublishedAt: null, predictionEligible: false,
    data: { providerMatchId: '456', homeName: fixture.homeName, awayName: fixture.awayName,
      kickoffUtc: fixture.kickoffUtc, sourcePublishedAt: null,
      injuries: [{ side: 'home', name: '球员', providerPlayerId: '789', reasonAsDisplayed: '受伤' }] } };
  return { generatedAt, predictionEligible: false, items: [{ fixture,
    evidence: { siteMatchId: fixture.siteMatchId, eventVersion: fixture.eventVersion, predictionEligible: false,
      sections: { injuries: { latestValid: success, latestAttempt: structuredClone(success) },
        lineup: { latestValid: null, latestAttempt: null } } } }] };
}

test('exports older than ten minutes, future dates and naive timestamps cannot be used', () => {
  const doc = sample();
  doc.generatedAt = '2026-09-12T13:30:00.000Z';
  assert.equal(selectEvidence(doc, row(), NOW).status, 'ok');
  doc.generatedAt = '2026-09-12T13:29:59.999Z';
  assert.equal(selectEvidence(doc, row(), NOW).status, 'stale');
  for (const time of ['2026-09-12T13:40:00.001Z', '2026-09-12T13:39:00', '2026-02-30T13:39:00Z']) {
    doc.generatedAt = time;
    assert.equal(selectEvidence(doc, row(), NOW).status, 'conflict');
  }
});

test('Shanghai midnight and month rollover recompute the current today/tomorrow window', () => {
  const before = '2026-09-30T15:59:00.000Z', after = '2026-09-30T16:01:00.000Z';
  const current = row('2026-10-01T14:00:00.000Z'), doc = sample(current, before);
  assert.equal(selectEvidence(doc, current, after).status, 'ok');
  assert.equal(selectEvidence(doc, row('2026-10-02T16:00:00.000Z'), after).status, 'ineligible');
  const newTomorrow = row('2026-10-02T14:00:00.000Z');
  assert.equal(selectEvidence(doc, newTomorrow, before).status, 'ineligible');
  assert.equal(selectEvidence(doc, newTomorrow, after).status, 'conflict');
});

test('started, canceled, postponed and malformed current fixtures cannot expose evidence', () => {
  const doc = sample();
  assert.equal(selectEvidence(doc, row(), row().kickoffTime).status, 'ineligible');
  for (const status of ['LIVE', 'FINISHED', 'PENDING_RESULT', 'POSTPONED', 'CANCELED', 'UNKNOWN']) {
    assert.equal(selectEvidence(doc, { ...row(), status }, NOW).status, 'ineligible');
  }
  assert.equal(selectEvidence(doc, { ...row(), homeTeamName: '' }, NOW).status, 'ineligible');
  assert.equal(selectEvidence(doc, { ...row(), kickoffTime: '2026-09-12T22:00:00' }, NOW).status, 'ineligible');
});

test('duplicate identities, changed teams and rescheduled fixtures are rejected', () => {
  const doc = sample();
  assert.equal(selectEvidence(doc, { ...row(), homeTeamName: '另一支主队' }, NOW).status, 'conflict');
  assert.equal(selectEvidence(doc, row('2026-09-12T15:00:00.000Z'), NOW).status, 'conflict');
  doc.items.push(structuredClone(doc.items[0]));
  assert.equal(selectEvidence(doc, row(), NOW).status, 'conflict');
});

test('previous success and a later empty or failed attempt remain distinct', () => {
  for (const status of ['source_empty', 'parse_error', 'blocked', 'login_required', 'conflict']) {
    const doc = sample(), original = doc.items[0].evidence.sections.injuries.latestValid;
    doc.items[0].evidence.sections.injuries.latestAttempt = { ...original, status,
      receivedAt: '2026-09-12T13:38:00.000Z', data: null };
    const result = selectEvidence(doc, row(), NOW);
    assert.equal(result.status, 'ok');
    assert.equal(result.predictionEligible, false);
    assert.equal(result.sections.injuries.latestValid.status, 'available');
    assert.equal(result.sections.injuries.latestValid.receivedAt, original.receivedAt);
    assert.equal(result.sections.injuries.latestAttempt.status, status);
    assert.equal(result.sections.injuries.latestAttempt.data, null);
    assert.equal(result.sections.lineup.latestValid, null);
    result.sections.injuries.latestValid.data.injuries[0].name = '调用方修改';
    assert.equal(original.data.injuries[0].name, '球员');
  }
});

test('wrong observation kind, identity, team, future or post-kickoff receipt cannot pass', () => {
  for (const update of [
    { kind: 'lineup' }, { siteMatchId: 'sporttery_999' }, { eventVersion: '2026-09-12T15:00:00.000Z' },
    { receivedAt: '2026-09-12T13:40:00.001Z' }, { receivedAt: '2026-09-12T14:00:00.000Z' },
    { receivedAt: '2026-09-12T13:30:00' }, { status: 'source_empty', data: null }, { predictionEligible: true },
  ]) {
    const doc = sample();
    Object.assign(doc.items[0].evidence.sections.injuries.latestValid, update);
    assert.equal(selectEvidence(doc, row(), NOW).status, 'conflict');
  }
  const doc = sample();
  doc.items[0].evidence.sections.injuries.latestValid.data.awayName = '错误客队';
  assert.equal(selectEvidence(doc, row(), NOW).status, 'conflict');
});

test('missing records and invalid eligibility flags return no usable data', () => {
  assert.equal(selectEvidence(null, row(), NOW).status, 'missing');
  const doc = sample();
  doc.items = [];
  assert.equal(selectEvidence(doc, row(), NOW).status, 'missing');
  doc.predictionEligible = true;
  const result = selectEvidence(doc, row(), NOW);
  assert.equal(result.status, 'conflict');
  assert.equal(result.predictionEligible, false);
  assert.equal(result.sections.injuries.latestValid, null);
});

test('lineup evidence and failed-only sections preserve their own kinds and statuses', () => {
  const doc = sample(), sections = doc.items[0].evidence.sections;
  const base = sections.injuries.latestValid;
  const lineup = { ...base, kind: 'lineup', sourceUrl: 'https://live.leisu.com/detail-456',
    data: { ...base.data, teams: [{ side: 'home', name: '主队' }, { side: 'away', name: '客队' }] } };
  delete lineup.data.injuries;
  sections.lineup = { latestValid: lineup, latestAttempt: structuredClone(lineup) };
  sections.injuries = { latestValid: null, latestAttempt: { ...base, status: 'source_empty', data: null } };
  const result = selectEvidence(doc, row(), NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.sections.lineup.latestValid.kind, 'lineup');
  assert.equal(result.sections.injuries.latestValid, null);
  assert.equal(result.sections.injuries.latestAttempt.status, 'source_empty');
});
