'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { TRAINED_ONLY_POLICY } = require('../server/recommendationAuthority.cjs');
const remote = require('../scripts/verifyRemoteRecommendationParity.cjs');
const NOW = Date.parse('2026-10-10T04:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = delta => new Date(NOW + delta).toISOString();
function fixture() {
  const receipt = { version: 'recommendation-publication-authority-v1', mode: 'reviewed-and-trained', legacyCurrentEnabled: false,
    businessDate: '2026-10-10', updatedAt: stamp(-2000), observedAt: stamp(-1000), currentBusinessDate: '2026-10-10',
    publicationState: 'current', availableForCurrentDay: true,
    activeValidation: { ok: true, reviewed: { status: 'verified', records: 2, openRecords: 2, closedRecords: 0 },
      trained: { status: 'unavailable', records: 0, openRecords: 0, closedRecords: 0 } } };
  const row = { id: 'sporttery_2041870', sourceMatchId: '2041870', status: 'SCHEDULED', sourceStatus: 'SCHEDULED',
    kickoffTime: stamp(3600000), eventVersion: stamp(3600000), buyEndTime: stamp(3300000),
    oddsSource: 'sporttery:HAD', odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 }, predictions: [],
    archivedPreMatchPrediction: { version: 'archived-pre-match-prediction-v1', source: 'immutable-pre-match-prediction-snapshot',
      sourceMatchId: '2041870', eventVersion: stamp(3600000), capturedAt: stamp(-5000), cutoffTime: stamp(3300000),
      marketEvidenceScope: 'result-pool', signature: 'synthetic-frozen-signature',
      prediction: { marketType: 'BEST', oddsPoolCode: 'HAD', tipCode: '1', odds: 1.8 } },
    recommendationAuthority: { ...clone(receipt), legacyArchiveState: 'valid' } };
  return { ok: true, recommendationAuthority: receipt, rows: [row] };
}
const validate = body => remote.validateRemoteRetirementReceipt(body, { policy: TRAINED_ONLY_POLICY, nowMs: NOW });

test('local policy plus complete top-level and row receipt can retire scheduled BEST continuity only', () => {
  const body = fixture();
  assert.equal(remote.scheduledWithoutBestIds(body.rows, NOW).length, 1);
  const checked = validate(body); assert.equal(checked.valid, true);
  const retired = new Set(checked.retiredRows);
  assert.equal(remote.scheduledWithoutBestIds(body.rows.filter(row => !retired.has(row)), NOW).length, 0);
  assert.equal(remote.compareRecommendationParity(body.rows[0], clone(body.rows[0]), NOW).ok, true);
});

test('a copied local policy and a row flag without the response receipt cannot grant retirement', () => {
  const body = fixture();
  assert.equal(remote.validateRemoteRetirementReceipt(body, { policy: { ...TRAINED_ONLY_POLICY }, nowMs: NOW }).valid, false);
  delete body.recommendationAuthority;
  assert.equal(validate(body).valid, false);
  assert.equal(remote.scheduledWithoutBestIds(body.rows, NOW).length, 1);
});

test('absence of all authority receipts leaves the original strict rule intact', () => {
  const body = fixture(); delete body.recommendationAuthority; delete body.rows[0].recommendationAuthority;
  assert.equal(validate(body).present, false);
  assert.equal(validate(body).retiredRows.length, 0);
  assert.equal(remote.scheduledWithoutBestIds(body.rows, NOW).length, 1);
});

for (const [name, mutate] of [
  ['wrong mode', r => { r.mode = 'legacy'; }],
  ['future observation', r => { r.observedAt = stamp(1); }],
  ['old observation', r => { r.observedAt = stamp(-60001); r.updatedAt = stamp(-60002); }],
  ['view after observation', r => { r.updatedAt = stamp(0); }],
  ['business date mismatch', r => { r.businessDate = '2026-10-09'; }],
  ['false integrity status', r => { r.activeValidation.ok = false; }],
  ['unavailable with records', r => { r.activeValidation.reviewed.status = 'unavailable'; }],
  ['incorrect lane totals', r => { r.activeValidation.reviewed.openRecords = 3; }],
  ['unbounded lane count', r => { r.activeValidation.reviewed.records = 33; r.activeValidation.reviewed.openRecords = 33; }],
]) test('reject receipt ' + name, () => {
  const body = fixture(); mutate(body.recommendationAuthority);
  body.rows[0].recommendationAuthority = { ...clone(body.recommendationAuthority), legacyArchiveState: 'valid' };
  assert.equal(validate(body).valid, false); assert.equal(validate(body).retiredRows.length, 0);
});

test('invalid verifier clock is a rejection rather than an exception', () => {
  assert.equal(remote.validateRemoteRetirementReceipt(fixture(), { policy: TRAINED_ONLY_POLICY, nowMs: NaN }).valid, false);
});

test('stale prior-day publication keeps retirement but never claims currently open records', () => {
  const body = fixture(), r = body.recommendationAuthority;
  Object.assign(r, { businessDate: '2026-10-09', updatedAt: '2026-10-09T04:00:00.000Z', publicationState: 'stale', availableForCurrentDay: false });
  r.activeValidation.reviewed.openRecords = 0; r.activeValidation.reviewed.closedRecords = 2;
  body.rows[0].recommendationAuthority = { ...clone(r), legacyArchiveState: 'valid' };
  assert.equal(validate(body).valid, true);
  r.activeValidation.reviewed.openRecords = 2; r.activeValidation.reviewed.closedRecords = 0;
  body.rows[0].recommendationAuthority = { ...clone(r), legacyArchiveState: 'valid' };
  assert.equal(validate(body).valid, false);
});

test('per-row receipt drift, leaked direction and malformed existing archive each fail', () => {
  for (const mutate of [
    row => { row.recommendationAuthority.observedAt = stamp(-999); },
    row => { row.predictions = [{ marketType: '1X2', oddsPoolCode: 'HAD', tipCode: '1', odds: 1.8 }]; },
    row => { row.archivedPreMatchPrediction.sourceMatchId = 'different-event'; },
    row => { row.recommendationAuthority.legacyArchiveState = 'missing'; },
  ]) { const body = fixture(); mutate(body.rows[0]); assert.equal(validate(body).valid, false); }
});

// Exercise the actual verifier without sockets. This transport implements the
// request callback/event protocol and returns controlled protected responses.
function verifierWithResponses(current, detail) {
  const requested = [];
  const transport = { request(target, options, callback) {
    requested.push(target.pathname + target.search);
    const req = new EventEmitter(); req.write = () => {};
    req.destroy = error => req.emit('error', error);
    req.end = () => process.nextTick(() => {
      const res = new EventEmitter(); res.statusCode = 200; callback(res);
      const payload = target.pathname === '/api/v1/matches/current' ? current : { ok: true, match: detail };
      res.emit('data', Buffer.from(JSON.stringify(payload))); res.emit('end');
    });
    return req;
  } };
  const filename = path.resolve(__dirname, '../scripts/verifyRemoteRecommendationParity.cjs'), native = Module.createRequire(filename), module = { exports: {} };
  class Clock extends Date { static now() { return NOW; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, Buffer, URL, Date: Clock,
    setTimeout, clearTimeout, require: id => ['node:http', 'node:https'].includes(id) ? transport : native(id) }, { filename });
  return { run: () => module.exports.runVerificationWithAccess({ baseUrl: new URL('https://example.invalid'), accessToken: 'synthetic',
    maxBytes: 1000000, timeoutMs: 1000, readRetries: 0, detailConcurrency: 1 }), requested };
}

test('actual remote verifier applies retirement and still performs the detail comparison', async () => {
  const body = fixture(), verifier = verifierWithResponses(body, clone(body.rows[0])), result = await verifier.run();
  assert.equal(result.ok, true); assert.equal(result.summary.retiredCurrentRows, 1);
  assert.equal(result.summary.scheduledWithoutBest, 0); assert.equal(result.summary.checked, 1);
  assert.equal(verifier.requested.length, 2);
});

test('actual remote verifier rejects changed post-kickoff archive direction despite retirement receipt', async () => {
  const body = fixture(), row = body.rows[0]; row.status = row.sourceStatus = 'FINISHED';
  const detail = clone(row); detail.archivedPreMatchPrediction.prediction.tipCode = '2';
  const result = await verifierWithResponses(body, detail).run();
  assert.equal(result.ok, false); assert.equal(result.summary.mismatches, 1);
  assert.ok(result.mismatches[0].reasons.includes('canonical-decision-mismatch'));
});

test('actual remote verifier rejects malformed archive even on an otherwise result-only row', async () => {
  const body = fixture(), row = body.rows[0]; row.status = row.sourceStatus = 'FINISHED'; row.scoreHome = 2; row.scoreAway = 0;
  row.archivedPreMatchPrediction.prediction.tipCode = 'WATCH';
  const result = await verifierWithResponses(body, clone(row)).run();
  assert.equal(result.ok, false); assert.equal(result.summary.invalidExistingArchives, 1);
});
