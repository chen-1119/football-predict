'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prematchEvidenceState: state, prematchEvidenceLabel: label, prematchRecordCount: count } = require('../src/services/prematchEvidencePresentation.ts');
const section = (changes = {}) => ({ status: 'available', observedAt: '2026-10-02T08:00:00Z', lastAttemptAt: '2026-10-02T08:10:00Z', previousValue: false,
  data: { players: [{ name: 'Synthetic player', side: 'home' }] }, ...changes });
test('not collected and no source records remain distinct from available references', () => {
  assert.equal(state(undefined), 'loading');
  assert.equal(state(undefined, 'missing'), 'not-collected');
  assert.equal(state(section({ status: 'not-due', data: null }), 'ok'), 'not-collected');
  assert.equal(state(section({ status: 'source_empty', data: null }), 'ok'), 'source-empty');
  assert.equal(state(section(), 'ok'), 'reference');
  assert.equal(state(undefined, 'unauthorized'), 'unavailable');
});
test('stale, previous and unverified payloads cannot become fresh collected references', () => {
  const record = section(), saved = JSON.stringify(record);
  assert.equal(state(record, 'stale'), 'stale');
  assert.equal(state(section({ status: 'stale' }), 'ok'), 'stale');
  assert.equal(state(section({ status: 'stale', previousValue: true }), 'ok'), 'stale');
  assert.equal(state(section({ status: 'source_empty', previousValue: true }), 'ok'), 'previous');
  for (const observedAt of [null, '', 'invalid']) assert.equal(state(section({ observedAt }), 'ok'), 'unverified');
  assert.equal(state(section({ status: 'conflict' }), 'ok'), 'unverified');
  assert.equal(JSON.stringify(record), saved);
});
test('injury counts never infer a healthy team or zero from absent rows', () => {
  for (const value of [undefined, section({ data: null }), section({ data: {} }), section({ data: { players: [] } })]) {
    assert.equal(count(value, 'injuries'), null);
    assert.equal(count(value, 'injuries', 'away'), null);
  }
  assert.equal(count(section(), 'injuries'), 1);
  assert.equal(count(section(), 'injuries', 'home'), 1);
  assert.equal(count(section(), 'injuries', 'away'), null);
  assert.equal(count(section(), 'lineup'), null);
});
test('bilingual labels explicitly keep collected data in the reference state', () => {
  for (const language of ['zh', 'en']) {
    assert.match(label('reference', language), /仅供参考|reference only/);
    assert.match(label('stale', language), /已过期|Stale/);
    assert.match(label('not-collected', language), /尚未采集|Not collected/);
    for (const s of ['not-collected', 'source-empty', 'stale', 'previous', 'reference', 'unverified', 'unavailable']) {
      assert.doesNotMatch(label(s, language), /没有伤停|无伤停|伤停为零|no injuries|injury.free|Confirmed lineup|正式推荐/i);
    }
  }
});
