'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileMappings } = require('./mapping.cjs');
const NOW = Date.parse('2026-09-12T03:00:00Z');
const fixture = (extra = {}) => ({ siteMatchId: 'sporttery_2041418', homeName: '阿斯顿维拉', awayName: '诺丁汉森林', kickoffUtc: '2026-09-12T14:00:00.000Z', ...extra });
const candidate = (extra = {}) => ({ providerMatchId: '4558535', homeName: '阿斯顿维拉', awayName: '诺丁汉森林', kickoffUtc: '2026-09-12T22:00:00+08:00', sourceUrl: 'https://www.leisu.com/data/zuqiu/comp-82', ...extra });

test('exact teams and equivalent explicit timezones produce a provenance-complete mapping', () => {
  const result = reconcileMappings([fixture()], [candidate()], {}, NOW);
  assert.deepEqual(result, {
    mappings: [{ siteMatchId: 'sporttery_2041418', providerMatchId: '4558535', homeName: '阿斯顿维拉', awayName: '诺丁汉森林', providerHomeName: '阿斯顿维拉', providerAwayName: '诺丁汉森林', kickoffUtc: '2026-09-12T14:00:00.000Z', verifiedAt: '2026-09-12T03:00:00.000Z', verificationMethod: 'exact-team-names-and-kickoff', sourceUrl: 'https://www.leisu.com/data/zuqiu/comp-82' }],
    unmatched: [], conflicts: [],
  });
});

test('only explicit provider-to-website aliases are applied and original names remain traceable', () => {
  const target = fixture({ homeName: '托特纳姆热刺', awayName: '曼彻斯特联' });
  const source = candidate({ homeName: '热刺', awayName: '曼联' });
  assert.equal(reconcileMappings([target], [source], {}, NOW).mappings.length, 0);
  const result = reconcileMappings([target], [source], { 热刺: '托特纳姆热刺', 曼联: '曼彻斯特联' }, NOW);
  assert.equal(result.mappings.length, 1); assert.equal(result.mappings[0].providerHomeName, '热刺'); assert.equal(result.mappings[0].homeName, '托特纳姆热刺');
  assert.equal(reconcileMappings([target], [source], { 热刺: '中间别名', 中间别名: '托特纳姆热刺', 曼联: '曼彻斯特联' }, NOW).mappings.length, 0);
});

test('case, spacing, swapped teams and even one millisecond of kickoff difference never fuzzy-match', () => {
  for (const source of [candidate({ homeName: '阿斯顿维拉 ' }), candidate({ awayName: '诺丁汉' }), candidate({ homeName: '诺丁汉森林', awayName: '阿斯顿维拉' }), candidate({ kickoffUtc: '2026-09-12T14:00:00.001Z' })]) {
    const result = reconcileMappings([fixture()], [source], {}, NOW); assert.equal(result.mappings.length, 0); assert.equal(result.unmatched[0].reason, 'no_exact_candidate');
  }
  assert.equal(reconcileMappings([fixture({ homeName: 'Arsenal' })], [candidate({ homeName: 'arsenal' })], {}, NOW).mappings.length, 0);
});

test('invalid URLs and IDs are quarantined without preventing unrelated valid mappings', () => {
  const badUrls = ['http://www.leisu.com/data/zuqiu/comp-82', 'https://www.leisu.com/data/zuqiu/comp-0', 'https://www.leisu.com/data/zuqiu/comp-082', 'https://www.leisu.com/data/zuqiu/comp-82?q=1', 'https://www.leisu.com/data/zuqiu/comp-82#row', 'https://www.leisu.com:443/data/zuqiu/comp-82', 'https://www.leisu.com.attacker.invalid/data/zuqiu/comp-82', 'https://live.leisu.com/data/zuqiu/comp-82', 'https://user:pass@www.leisu.com/data/zuqiu/comp-82', 'https://www.leisu.com/data/zuqiu/comp-82\n'];
  for (const sourceUrl of badUrls) {
    const result = reconcileMappings([fixture()], [candidate(), candidate({ providerMatchId: '999', sourceUrl })], {}, NOW);
    assert.equal(result.mappings.length, 1); assert.equal(result.conflicts[0].reason, 'invalid_candidate');
  }
  for (const providerMatchId of ['0', '-12', '012', '1.5', 'abc', '4558535\n', Number.MAX_SAFE_INTEGER + 1]) {
    const result = reconcileMappings([fixture()], [candidate({ providerMatchId })], {}, NOW); assert.equal(result.mappings.length, 0); assert.equal(result.conflicts[0].reason, 'invalid_candidate');
  }
});

test('timezone-less, impossible dates and invalid offsets are rejected instead of Date.parse normalization', () => {
  for (const kickoffUtc of ['2026-09-12T14:00:00', '2026-02-30T14:00:00Z', '2026-13-12T14:00:00Z', '2026-09-12T24:00:00Z', '2026-09-12T14:60:00Z', '2026-09-12T14:00:00+24:00', '2026-09-12T14:00:00+08:60', '2026-09-12T14:00:00.0001Z', '2026/09/12 14:00 UTC', '2026-09-12T14:00:00Z\n']) {
    const result = reconcileMappings([fixture()], [candidate({ kickoffUtc })], {}, NOW); assert.equal(result.mappings.length, 0); assert.equal(result.conflicts[0].reason, 'invalid_candidate');
  }
  const leap = reconcileMappings([fixture({ kickoffUtc: '2028-02-29T14:00:00Z' })], [candidate({ kickoffUtc: '2028-02-29T22:00:00+08:00' })], {}, NOW);
  assert.equal(leap.mappings.length, 1);
});

test('one provider ID with different identity quarantines every record in either order', () => {
  for (const changed of [candidate({ homeName: '另一主队' }), candidate({ kickoffUtc: '2026-09-13T22:00:00+08:00' })]) {
    for (const sources of [[candidate(), changed], [changed, candidate()]]) {
      const result = reconcileMappings([fixture()], sources, {}, NOW); assert.equal(result.mappings.length, 0); assert.ok(result.conflicts.some(conflict => conflict.reason === 'provider_identity_conflict'));
    }
  }
});

test('a malformed record poisons its known provider ID instead of being hidden by a valid duplicate', () => {
  const result = reconcileMappings([fixture()], [candidate(), candidate({ kickoffUtc: 'not-a-time' })], {}, NOW);
  assert.equal(result.mappings.length, 0); assert.ok(result.conflicts.some(conflict => conflict.reason === 'provider_has_invalid_record'));
});

test('identical duplicate candidates are deduplicated and valid provenance selection is deterministic', () => {
  const first = candidate({ sourceUrl: 'https://www.leisu.com/data/zuqiu/comp-81' });
  const result = reconcileMappings([fixture(), fixture()], [candidate(), first, candidate()], {}, NOW);
  const reversed = reconcileMappings([fixture()], [candidate(), first].reverse(), {}, NOW);
  assert.equal(result.mappings.length, 1); assert.deepEqual(result.mappings, reversed.mappings); assert.equal(result.conflicts.length, 0);
  assert.equal(result.mappings[0].sourceUrl, first.sourceUrl);
});

test('multiple source IDs matching one fixture are ambiguous and never arbitrarily selected', () => {
  const result = reconcileMappings([fixture()], [candidate(), candidate({ providerMatchId: '4558536' })], {}, NOW);
  assert.equal(result.mappings.length, 0); assert.equal(result.unmatched[0].reason, 'multiple_exact_candidates');
  assert.deepEqual(result.conflicts[0].providerMatchIds, ['4558535', '4558536']);
});

test('one source matching multiple website fixtures rejects all affected fixtures', () => {
  const result = reconcileMappings([fixture(), fixture({ siteMatchId: 'sporttery_9999999' })], [candidate()], {}, NOW);
  assert.equal(result.mappings.length, 0); assert.equal(result.unmatched.length, 2);
  assert.equal(result.unmatched.every(item => item.reason === 'one_source_multiple_fixtures'), true);
  assert.deepEqual(result.conflicts[0].siteMatchIds, ['sporttery_2041418', 'sporttery_9999999']);
});

test('conflicting website identities are quarantined while unrelated fixtures remain matchable', () => {
  const other = fixture({ siteMatchId: 'sporttery_2041446', homeName: '曼联', awayName: '曼城' });
  const result = reconcileMappings([fixture(), fixture({ awayName: '另一客队' }), other], [candidate(), candidate({ providerMatchId: '4558548', homeName: '曼联', awayName: '曼城' })], {}, NOW);
  assert.equal(result.mappings.length, 1); assert.equal(result.mappings[0].siteMatchId, other.siteMatchId);
  assert.ok(result.conflicts.some(conflict => conflict.reason === 'fixture_identity_conflict'));
});

test('explicit aliases cannot collapse both sides or erase provider identity conflicts', () => {
  const collapsed = reconcileMappings([fixture()], [candidate({ homeName: 'A', awayName: 'B' })], { A: '同一队', B: '同一队' }, NOW);
  assert.equal(collapsed.conflicts[0].reason, 'invalid_candidate');
  const aliasConflict = reconcileMappings([fixture()], [candidate(), candidate({ homeName: '维拉' })], { 维拉: '阿斯顿维拉' }, NOW);
  assert.equal(aliasConflict.mappings.length, 0); assert.ok(aliasConflict.conflicts.some(conflict => conflict.reason === 'provider_identity_conflict'));
});

test('function is deterministic, does not mutate frozen inputs, and ignores inherited aliases', () => {
  const f = Object.freeze(fixture()), c = Object.freeze(candidate()), aliases = Object.freeze({});
  const fixtures = Object.freeze([f]), candidates = Object.freeze([c]);
  assert.deepEqual(reconcileMappings(fixtures, candidates, aliases, NOW), reconcileMappings(fixtures, candidates, aliases, new Date(NOW)));
  const result = reconcileMappings([fixture({ homeName: 'toString' })], [candidate({ homeName: 'toString' })], {}, NOW);
  assert.equal(result.mappings.length, 1);
});

test('invalid top-level inputs or alias configuration throw; invalid fixture rows are reported locally', () => {
  assert.throws(() => reconcileMappings(null, [], {}, NOW), /must be arrays/);
  assert.throws(() => reconcileMappings([], [], [], NOW), /aliases/);
  assert.throws(() => reconcileMappings([], [], { 热刺: null }, NOW), /alias value/);
  assert.throws(() => reconcileMappings([], [], {}, undefined), /now/);
  assert.throws(() => reconcileMappings([], [], {}, '2026-02-30T03:00:00Z'), /calendar date/);
  const result = reconcileMappings([null, fixture()], [candidate()], {}, NOW);
  assert.equal(result.mappings.length, 1); assert.equal(result.unmatched[0].reason, 'invalid_fixture');
});
