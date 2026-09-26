'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { teamKey, buildEloSnapshots, buildFormSnapshots } = require('../scripts/syncData.cjs');
const seed = require('./fixtures/national-team-history-seed.json');

const teams = [
  ['斯洛文尼亚', 'slovenia', 317],
  ['爱沙尼亚', 'estonia', 549],
  ['北马其顿', 'north macedonia', 306],
  ['秘鲁', 'peru', 714],
  ['罗马尼亚', 'romania', 766],
];
function match(name, id) {
  return {
    sourceMatchId: id,
    homeTeamName: name,
    awayTeamName: 'unresolved-test-opponent',
    status: 'SCHEDULED',
    kickoffTime: '2026-09-27T18:00:00Z',
    predictionMeta: { generatedAt: '2026-09-26T15:30:00Z' },
  };
}

test('five current senior national names reach their actual historical Elo and form seeds', () => {
  const before = JSON.stringify(seed);
  const matches = teams.flatMap(([local, canonical], i) => [match(local, `local-${i}`), match(canonical, `canonical-${i}`)]);
  const elo = buildEloSnapshots(matches, seed);
  const form = buildFormSnapshots(matches, seed);
  for (const [i, [local, canonical, count]] of teams.entries()) {
    assert.equal(teamKey(local), canonical);
    assert.equal(elo.get(`local-${i}`).homeMatches, count);
    assert.equal(elo.get(`local-${i}`).homeRating, seed.teams[canonical].latestElo);
    assert.equal(elo.get(`local-${i}`).homeRating, elo.get(`canonical-${i}`).homeRating);
    assert.equal(form.get(`local-${i}`).home.sampleSize, 12);
    assert.deepEqual(form.get(`local-${i}`).home, form.get(`canonical-${i}`).home);
  }
  assert.equal(JSON.stringify(seed), before, 'alias lookup must not alter source results or observation times');
});

test('youth, women, reserve and Asian Games names never borrow the new senior national history', () => {
  const names = teams.flatMap(([local, canonical]) =>
    [' U21', ' U23', ' U19', ' 女足', ' Women', ' 青年队', ' B', '亚'].flatMap(suffix => [local + suffix, canonical + suffix]));
  const matches = names.map((name, i) => match(name, `category-${i}`));
  const elo = buildEloSnapshots(matches, seed);
  const form = buildFormSnapshots(matches, seed);
  for (const m of matches) {
    assert.equal(elo.get(m.sourceMatchId).homeMatches, 0, m.homeTeamName);
    assert.equal(form.get(m.sourceMatchId).home.sampleSize, 0, m.homeTeamName);
  }
});

test('ambiguous Ireland stays unresolved despite both senior Irish teams having real history', () => {
  assert.ok(seed.teams['republic of ireland'].matches > 0);
  assert.ok(seed.teams['northern ireland'].matches > 0);
  const matches = [match('爱尔兰', 'ambiguous'), match('republic of ireland', 'republic'), match('northern ireland', 'northern')];
  const elo = buildEloSnapshots(matches, seed);
  const form = buildFormSnapshots(matches, seed);
  assert.equal(teamKey('爱尔兰'), '爱尔兰');
  assert.equal(elo.get('ambiguous').homeMatches, 0);
  assert.equal(form.get('ambiguous').home.sampleSize, 0);
  assert.equal(elo.get('republic').homeMatches, 633);
  assert.equal(elo.get('northern').homeMatches, 707);
});

test('an exact alias cannot invent samples when its training seed is missing', () => {
  const matches = teams.map(([local], i) => match(local, `missing-${i}`));
  const elo = buildEloSnapshots(matches, { teams: {} });
  const form = buildFormSnapshots(matches, { teams: {} });
  for (const m of matches) {
    assert.equal(elo.get(m.sourceMatchId).homeMatches, 0);
    assert.equal(elo.get(m.sourceMatchId).homeRating, 1500);
    assert.equal(form.get(m.sourceMatchId).home.sampleSize, 0);
  }
});
