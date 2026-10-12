'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { teamKey, buildEloSnapshots, buildFormSnapshots } = require('../scripts/syncData.cjs');

const TEAMS = [
  ['塞浦路斯', 'cyprus', 426, 1402.64],
  ['拉脱维亚', 'latvia', 460, 1374.56],
  ['北爱尔兰', 'northern ireland', 707, 1627.90],
  ['格鲁吉亚', 'georgia', 307, 1674.47],
  ['黑山', 'montenegro', 170, 1542.85],
  ['亚美尼亚', 'armenia', 271, 1448.05],
];

test('six exact senior national aliases resolve without merging qualified teams', () => {
  for (const [zh, canonical] of TEAMS) {
    assert.equal(teamKey(zh), canonical);
    assert.equal(teamKey(canonical), canonical);
    assert.equal(teamKey(` ${zh} `), canonical);
    for (const name of [zh, canonical]) {
      for (const suffix of [' U19', ' U21', ' U23', ' 女足', ' Women', ' 青年队', ' B', ' B队', ' FC', 'FC', ' CF', ' AFC', ' SC', ' Club', ' 俱乐部']) {
        assert.notEqual(teamKey(name + suffix), canonical, name + suffix);
      }
      assert.notEqual(teamKey('FC ' + name), canonical);
    }
  }
});

test('existing national and club aliases retain their identities', () => {
  for (const [name, expected] of [
    ['法国', 'france'], ['比利时', 'belgium'], ['罗马尼亚', 'romania'],
    ['瑞典', 'sweden'], ['意大利', 'italy'], ['土耳其', 'turkey'],
    ['波黑', 'bosnia and herzegovina'], ['波兰', 'poland'],
    ['米尔顿凯恩斯', 'milton keynes dons'], ['巴黎圣日尔曼', 'paris sg'],
    ['FC Barcelona', 'barcelona'],
  ]) assert.equal(teamKey(name), expected, name);
});

// Optional evidence regression uses exact previously retrieved online bytes.
// Neither the training payload nor the live export is committed as a fixture.
const seedPath = process.env.FOOTBALL_ALIAS_VERIFIED_SEED_PATH;
test('the signed r792 online seed reaches all six identities through real seven-match inputs',
  { skip: !seedPath && 'Set FOOTBALL_ALIAS_VERIFIED_SEED_PATH and FOOTBALL_ALIAS_LIVE_EXPORT_PATH for the bounded online evidence regression.' }, () => {
    const bytes = fs.readFileSync(seedPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b6c58416e9bb0b36273bacb7aa065a2deb4d97a5a614f6ec0e359daeb15f9d17');
    const seed = JSON.parse(bytes);
    const exported = JSON.parse(fs.readFileSync(process.env.FOOTBALL_ALIAS_LIVE_EXPORT_PATH, 'utf8'));
    assert.equal(exported.productionWrites, 0);
    assert.equal(exported.postgres.transactionReadOnly, 'on');
    const current = exported.postgres.todayCurrent;
    assert.equal(current.length, 7);
    assert.deepEqual(current.map(r => r.sourceMatchId).sort(), Array.from({ length: 7 }, (_, i) => String(2041805 + i)));
    const before = JSON.stringify(current);
    // Seed-only lookup audit: no incremental result import, prediction run,
    // clock rewrite, frozen data mutation or claim of new live predictions.
    const elo = buildEloSnapshots(current, seed);
    const form = buildFormSnapshots(current, seed);
    for (const [name, canonical, count, rating] of TEAMS) {
      const team = seed.teams[teamKey(name)];
      assert.equal(team, seed.teams[canonical]);
      assert.equal(team.matches, count);
      assert.equal(team.latestElo, rating);
      assert.equal(team.recent.length, 32);
      const match = current.find(r => r.homeTeamName === name || r.awayTeamName === name);
      assert.ok(match, name);
      const side = match.homeTeamName === name ? 'home' : 'away';
      const ratingSnapshot = elo.get(match.sourceMatchId);
      assert.equal(ratingSnapshot[side + 'Matches'], count);
      assert.equal(ratingSnapshot[side + 'Rating'], rating);
      assert.equal(form.get(match.sourceMatchId)[side].sampleSize, 12);
    }
    assert.equal(JSON.stringify(current), before);
  });
