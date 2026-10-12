'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withVerifiedInputEvidence } = require('./fixtures/recommendation-input-helper.cjs');
const { makeDecision } = require('../scripts/recommendationPlatform/decision.cjs');
const { hash } = require('../src/services/publishedForecastPolicy.cjs');
const { bindPublicReferenceDecision, pendingPublicReferenceEvidence } = require('../src/services/publicReferenceDecision.cjs');
const { buildPublicReferenceArchive: originalArchive, buildPublicReferenceIndex } = require('../server/publicReferenceArchive.cjs');
const { collectResults, validResultEvent } = require('../scripts/recommendationPlatform/results.cjs');
const { buildPublicReferenceArchive: build, comparePublicReferenceArchive: compare, validPublicReferenceArchive: validArchive } = require('../scripts/recommendationPlatform/publicStrategyReferenceComparison.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '../outputs/recommendation-policy-v2-20261005');

function fixture() {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const match = withVerifiedInputEvidence({ id: 'sporttery_public-test', sourceMatchId: 'public-test', businessDate: '2026-10-05',
    status: 'SCHEDULED', homeTeamId: 'home-id', awayTeamId: 'away-id', homeTeamName: 'Home', awayTeamName: 'Away',
    kickoffTime: '2026-10-05T16:00:00Z', eventVersion: '2026-10-05T16:00:00Z',
    probabilityModel: { generatedAt: new Date(now).toISOString(), oneXTwo: { final: { home: 55, draw: 25, away: 20 } },
      calculationTrace: { poisson: { lambdas: { home: 1.7, away: 1.3 } } } },
    odds: { odds1: 1.9, oddsX: 4, odds2: 5 }, oddsSource: 'sporttery:had', oddsUpdatedAt: new Date(now).toISOString() });
  const d = makeDecision(match, { now, publication: { generationId: 'synthetic', manifestHash: 'a'.repeat(64) } }).decision;
  assert.ok(d);
  function reference(at, tipCode, extra = {}) {
    const m = { ...match, probabilityModel: { version: 'synthetic-reference', generatedAt: at, oneXTwo: { final: { home: 55, draw: 25, away: 20 } } },
      predictions: [{ marketType: 'BEST', recommendationAction: 'reference', oddsPoolCode: 'HAD', tipCode, odds: 2,
        confidence: { publicMetrics: { modelProbability: .55 } }, ...extra }],
      predictionMeta: { decisionGeneratedAt: at, decisionId: `public-${at}`, modelVersion: 'synthetic-reference', policyVersion: 'synthetic-reference-policy',
        featureSnapshot: { sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime, capturedAt: at } } };
    const bound = bindPublicReferenceDecision(m, null, at);
    return { record: bound.predictionMeta.publicReferenceDecision, entry: pendingPublicReferenceEvidence(bound) };
  }
  const records = [reference('2026-10-04T10:00:00Z', '2'), reference('2026-10-05T09:00:00Z', 'X'), reference('2026-10-05T09:30:00Z', '1')];
  function source(items = records) {
    const archive = originalArchive({ publicReferenceDecisions: items.map(x => x.record), publicReferenceEvidence: items.map(x => x.entry), updatedAt: '2026-10-05T14:01:00Z' });
    const index = buildPublicReferenceIndex(archive);
    return { version: 'target-public-reference-order-preserved-readonly-v1', readOnly: 'on', productionWrites: 0,
      observedAt: '2026-10-05T14:01:00Z', manifestJsonText: JSON.stringify(index.manifest),
      shards: index.shards.map(s => ({ id: s.id, payloadJsonText: JSON.stringify(s.payload) })) };
  }
  const input = source(), bytes = Buffer.from(JSON.stringify(input));
  return { d, records, source, input, bytes, options: { sourceSha256: sha(bytes), businessDate: '2026-10-05' } };
}
function result(d, { state = 'FINAL', scoreHome = 2, scoreAway = 0, at = '2026-10-05T18:00:00Z', revision = 1 } = {}) {
  const row = { ...d, status: state === 'VOID' ? 'VOID' : 'FINISHED', scoreHome, scoreAway, resultRevision: revision, resultSource: 'sporttery:official-api', voidSource: 'sporttery:official-api' };
  const value = collectResults([row], new Map(), { isFinal: () => state === 'FINAL', isVoid: () => state === 'VOID' }, Date.parse(at)).updates[0];
  assert.ok(validResultEvent(value)); return value;
}

test('original bytes and index/evidence create distinct today/prior cohorts without invented original scores', () => {
  const f = fixture(), before = hash(f.d), a = build(f.bytes, [f.d], f.options);
  assert.ok(validArchive(a)); assert.equal(a.rows.length, 3); assert.equal(a.independentMatchCount, 1);
  assert.equal(a.rows.filter(r => r.cohort === 'today').length, 2);
  assert.equal(a.rows.filter(r => r.cohort === 'previous-day').length, 1);
  assert.ok(a.rows.every(r => r.exactScore === null && r.formalEligible === false && r.pick.probability === .55));
  assert.ok(a.rows.every(r => r.originalTeamIdentityPresent === false && r.teamBinding === 'validated-final-decision-via-exact-event'));
  assert.equal(hash(f.d), before);
  const c = compare(a, [], { asOf: '2026-10-05T15:00:00Z' });
  assert.equal(c.cohorts.today.versionCounts.pending, 2);
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.pending, 1);
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.referenceHitRate, null);
});

test('wrong digest, reordered evidence, duplicate IDs, and event mismatch reject admission', () => {
  const f = fixture();
  assert.throws(() => build(f.bytes, [f.d], { ...f.options, sourceSha256: '0'.repeat(64) }), /HASH_MISMATCH/);
  assert.throws(() => build(f.input, [f.d], f.options), /SOURCE_BYTES/);
  const altered = structuredClone(f.input), shard = JSON.parse(altered.shards[0].payloadJsonText);
  shard.record.prediction.odds = 8; altered.shards[0].payloadJsonText = JSON.stringify(shard);
  const bytes = Buffer.from(JSON.stringify(altered));
  assert.throws(() => build(bytes, [f.d], { ...f.options, sourceSha256: sha(bytes) }), /RECORD_EVIDENCE_INDEX_INVALID/);
  const duplicate = structuredClone(f.input); duplicate.shards.push(duplicate.shards[0]);
  const dup = Buffer.from(JSON.stringify(duplicate));
  assert.throws(() => build(dup, [f.d], { ...f.options, sourceSha256: sha(dup) }), /DUPLICATE/);
  assert.throws(() => build(f.bytes, [f.d, f.d], f.options), /DUPLICATE_FINAL_EVENT/);
  const reordered = structuredClone(f.input), value = JSON.parse(reordered.shards[0].payloadJsonText);
  value.record.prediction = Object.fromEntries(Object.entries(value.record.prediction).reverse());
  reordered.shards[0].payloadJsonText = JSON.stringify(value);
  const changedOrder = Buffer.from(JSON.stringify(reordered));
  assert.throws(() => build(changedOrder, [f.d], { ...f.options, sourceSha256: sha(changedOrder) }), /RECORD_EVIDENCE_INDEX_INVALID/);
});

test('source observation cannot predate the bound final decision by even one nanosecond', () => {
  const f = fixture(), source = structuredClone(f.input);
  source.observedAt = '2026-10-05T10:00:00.000000000Z';
  let bytes = Buffer.from(JSON.stringify(source));
  assert.ok(validArchive(build(bytes, [f.d], { ...f.options, sourceSha256: sha(bytes) })));
  source.observedAt = '2026-10-05T09:59:59.999999999Z'; bytes = Buffer.from(JSON.stringify(source));
  assert.throws(() => build(bytes, [f.d], { ...f.options, sourceSha256: sha(bytes) }), /FINAL_DECISION_AFTER_SOURCE/);
});

test('trusted FINAL settles exact events and each cohort aggregates latest per event, not repeated versions', () => {
  const f = fixture(), a = build(f.bytes, [f.d], f.options), head = result(f.d);
  const c = compare(a, [head], { asOf: '2026-10-05T18:01:00Z' });
  assert.equal(c.cohorts.today.versionCounts.won, 1); assert.equal(c.cohorts.today.versionCounts.lost, 1);
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.settled, 1); assert.equal(c.cohorts.today.uniqueLatestPerEvent.referenceHitRate, 1);
  assert.equal(c.cohorts['previous-day'].uniqueLatestPerEvent.referenceHitRate, 0);
  assert.equal(c.formalHitRateEligible, false);
  const bad = structuredClone(a); bad.rows[0].pick.tipCode = '1';
  assert.throws(() => compare(bad, [head], { asOf: '2026-10-05T18:01:00Z' }), /ARCHIVE_OR_HEADS_INVALID/);
});

test('result clocks, identity/hash conflicts and malformed unrelated heads never create a false miss', () => {
  const f = fixture(), a = build(f.bytes, [f.d], f.options), head = result(f.d);
  const junk = [{ sourceMatchId: 'unrelated', eventVersion: 'not-a-date' }, null, {}];
  assert.equal(compare(a, junk, { asOf: '2026-10-05T15:00:00Z' }).cohorts.today.uniqueLatestPerEvent.pending, 1);
  for (const bad of [{ ...head, scoreHome: 5 }, { ...head, homeTeamId: 'wrong-team' }]) {
    const c = compare(a, [...junk, bad], { asOf: '2026-10-05T18:01:00Z' });
    assert.equal(c.cohorts.today.uniqueLatestPerEvent.disputed, 1); assert.equal(c.cohorts.today.uniqueLatestPerEvent.settled, 0);
  }
  assert.equal(compare(a, [head], { asOf: '2026-10-05T17:59:59.999999999Z' }).cohorts.today.uniqueLatestPerEvent.disputed, 1);
  assert.throws(() => compare(a, [], { asOf: '2026-10-05T14:00:59.999999999Z' }), /CLOCK_INVALID/);
  const changed = result(f.d, { scoreHome: 0, scoreAway: 2 });
  assert.equal(compare(a, [head, changed], { asOf: '2026-10-05T18:01:00Z' }).cohorts.today.uniqueLatestPerEvent.disputed, 1);
});

test('official VOID may be observed before kickoff and remains outside the hit-rate denominator', () => {
  const f = fixture(), a = build(f.bytes, [f.d], f.options);
  const voided = result(f.d, { state: 'VOID', at: '2026-10-05T15:00:00Z' });
  const c = compare(a, [voided], { asOf: '2026-10-05T15:01:00Z' });
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.void, 1); assert.equal(c.cohorts.today.uniqueLatestPerEvent.settled, 0);
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.referenceHitRate, null);
});

test('new result revision replaces projection only and keeps frozen reference archive unchanged', () => {
  const f = fixture(), a = build(f.bytes, [f.d], f.options), before = hash(a);
  const old = result(f.d), updated = result(f.d, { scoreHome: 0, scoreAway: 1, revision: 2, at: '2026-10-05T18:30:00Z' });
  const c = compare(a, [old, updated], { asOf: '2026-10-05T18:31:00Z' });
  assert.equal(c.cohorts.today.uniqueLatestPerEvent.referenceHitRate, 0); assert.equal(hash(a), before);
});

test('actual pinned online originals: 85 today/7 prior references remain pending for seven events',
  { skip: !fs.existsSync(path.join(root, 'public-reference-order-preserved.json')) }, () => {
    const source = fs.readFileSync(path.join(root, 'public-reference-order-preserved.json'));
    const target = JSON.parse(fs.readFileSync(path.join(root, 'precutoff-target-versions.json')));
    const a = build(source, target.latestFull, { sourceSha256: sha(source), businessDate: '2026-10-05' });
    assert.equal(a.rows.length, 92); assert.equal(a.independentMatchCount, 7);
    const c = compare(a, target.currentResultHeads, { asOf: '2026-10-05T15:10:00Z' });
    assert.equal(c.cohorts.today.versionCounts.versions, 85); assert.equal(c.cohorts['previous-day'].versionCounts.versions, 7);
    assert.equal(c.cohorts.today.uniqueLatestPerEvent.pending, 7); assert.equal(c.cohorts.today.uniqueLatestPerEvent.referenceHitRate, null);
    assert.ok(a.rows.every(r => r.exactScore === null)); assert.equal(c.formalEligible, false);
  });
