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

function coverageFixture() {
  return { version: 'current-recommendation-coverage-v6', publicationAuthority: fixture().recommendationAuthority,
    scheduledMatches: 50, bestDirectionMatches: 0, watchMatches: 0, missingDirectionMatches: 50,
    publicationDispositionMatches: 0, missingDispositionMatches: 50,
    trainingBackedMatches: 50, trainingCoverageOk: true,
    hhadMarketMatches: 12, hhadBoundDirectionMatches: 10, hhadMissingDirectionMatches: 2, hhadOnlyMarketMatches: 2,
    dualMarketEligibleMatches: 10, dualMarketAtomicMatches: 10, dualMarketAtomicMissingMatches: 0,
    retiredDispositionMatches: 50, retiredHhadOnlyDirectionMatches: 2,
    effectiveMissingDispositionMatches: 0, effectiveHhadMissingDirectionMatches: 0,
    coverageOk: true, legacyCoverageOk: false, dualMarketAtomicCoverageOk: false,
    projectionParity: { version: 'current-list-detail-recommendation-parity-v1',
      scope: 'same-current-read-model-list-detail-projection', disclosure: 'aggregate-counts-only', mismatchRows: 0, ok: true } };
}
const validateCoverage = value => remote.validateRemoteRecommendationCoverage(value, { policy: TRAINED_ONLY_POLICY, nowMs: NOW });

test('aggregate coverage validates the complete authority without fabricating a current row set', () => {
  const value = coverageFixture(), before = JSON.stringify(value);
  assert.equal(remote.validateRemoteAuthoritySummary(value.publicationAuthority, { policy: TRAINED_ONLY_POLICY, nowMs: NOW }).valid, true);
  assert.equal(validateCoverage(value).valid, true);
  assert.equal(JSON.stringify(value), before);
  assert.equal(value.hhadMissingDirectionMatches, 2); assert.equal(value.missingDispositionMatches, 50);
  assert.equal(value.dualMarketAtomicCoverageOk, false, 'the raw legacy diagnostic remains visible');
  assert.equal(remote.validateRemoteRecommendationCoverage(value, { policy: { ...TRAINED_ONLY_POLICY }, nowMs: NOW }).valid, false);
});

test('legacy aggregate coverage retains strict raw dispositions and supports old responses without new counters', () => {
  const value = coverageFixture(); delete value.publicationAuthority;
  for (const field of ['retiredDispositionMatches', 'retiredHhadOnlyDirectionMatches', 'effectiveMissingDispositionMatches', 'effectiveHhadMissingDirectionMatches']) delete value[field];
  assert.equal(validateCoverage(value).valid, false);
  Object.assign(value, { bestDirectionMatches: 48, watchMatches: 2, missingDirectionMatches: 2,
    publicationDispositionMatches: 50, missingDispositionMatches: 0, hhadBoundDirectionMatches: 12,
    hhadMissingDirectionMatches: 0, legacyCoverageOk: true, dualMarketAtomicCoverageOk: true });
  assert.equal(validateCoverage(value).valid, true);
  Object.assign(value, { retiredDispositionMatches: 0, retiredHhadOnlyDirectionMatches: 0,
    effectiveMissingDispositionMatches: 0, effectiveHhadMissingDirectionMatches: 0 });
  assert.equal(validateCoverage(value).valid, true);
});

for (const [name, mutate] of [
  ['authority missing', v => { delete v.publicationAuthority; }],
  ['retirement flag alone', v => { v.publicationAuthority = { legacyCurrentEnabled: false, activeValidation: { ok: true } }; }],
  ['authority bad mode', v => { v.publicationAuthority.mode = 'legacy'; }],
  ['authority stale observation', v => { v.publicationAuthority.observedAt = stamp(-60001); }],
  ['authority future clock', v => { v.publicationAuthority.observedAt = stamp(1); }],
  ['authority invalid lane totals', v => { v.publicationAuthority.activeValidation.reviewed.openRecords = 3; }],
  ['unavailable lane with records', v => { v.publicationAuthority.activeValidation.reviewed.status = 'unavailable'; }],
  ['missing effective counter', v => { delete v.effectiveHhadMissingDirectionMatches; }],
  ['negative counter', v => { v.retiredHhadOnlyDirectionMatches = -1; }],
  ['string counter', v => { v.retiredDispositionMatches = '50'; }],
  ['unbounded counter', v => { v.scheduledMatches = 513; }],
  ['retirement overcounts raw absence', v => { v.retiredDispositionMatches = 51; }],
  ['HHAD-only exemption exceeds HHAD-only rows', v => { v.retiredHhadOnlyDirectionMatches = 3; }],
  ['uncovered raw disposition', v => { v.retiredDispositionMatches = 49; v.effectiveMissingDispositionMatches = 1; }],
  ['false effective zero', v => { v.retiredHhadOnlyDirectionMatches = 1; }],
  ['raw HHAD count drift', v => { v.hhadBoundDirectionMatches = 11; }],
  ['actual dual-market binding failure', v => { v.dualMarketAtomicMatches = 9; v.dualMarketAtomicMissingMatches = 1; v.hhadBoundDirectionMatches = 9; v.hhadMissingDirectionMatches = 3; }],
  ['training missing', v => { v.trainingBackedMatches = 49; }],
  ['training false', v => { v.trainingCoverageOk = false; }],
  ['projection mismatch', v => { v.projectionParity.mismatchRows = 1; }],
  ['projection false', v => { v.projectionParity.ok = false; }],
  ['server coverage false', v => { v.coverageOk = false; }],
  ['raw dual atomic diagnostic drift', v => { v.dualMarketAtomicCoverageOk = true; }],
  ['legacy raw diagnostic falsified', v => { v.legacyCoverageOk = true; }],
]) test('aggregate coverage rejects ' + name, () => {
  const value = coverageFixture(); mutate(value); assert.equal(validateCoverage(value).valid, false);
});

test('zero currently open records are only an integrity readiness observation', () => {
  const value = coverageFixture(), receipt = value.publicationAuthority;
  receipt.activeValidation.reviewed.openRecords = 0; receipt.activeValidation.reviewed.closedRecords = 2;
  assert.equal(validateCoverage(value).valid, true);
  assert.equal(receipt.activeValidation.reviewed.openRecords, 0);
  Object.assign(receipt, { businessDate: '2026-10-09', updatedAt: '2026-10-09T04:00:00.000Z', publicationState: 'stale', availableForCurrentDay: false });
  assert.equal(validateCoverage(value).valid, true);
});

test('actual public readiness block uses complete aggregate validation and retains both health gates', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/verifyRemotePublicReadiness.cjs'), 'utf8');
  const begin = source.indexOf('  const recommendationCoverage = health.body?.data?.recommendations || {};');
  const end = source.indexOf('  const trainingAsset =', begin);
  assert.ok(begin >= 0 && end > begin);
  class Clock extends Date { static now() { return NOW; } }
  const run = (coverage, status = {}) => {
    const checks = [];
    vm.runInNewContext(source.slice(begin, end), { checks, health: { body: { data: { recommendations: coverage },
      status: { recommendationCoverageOk: true, recommendationProjectionParityOk: true, ...status } } },
      TRAINED_ONLY_POLICY, Date: Clock, validateRemoteRecommendationCoverage: remote.validateRemoteRecommendationCoverage,
      pushCheck: (out, name, ok, evidence) => out.push({ name, ok, evidence }) });
    assert.equal(checks.length, 1); return checks[0];
  };
  assert.equal(run(coverageFixture()).ok, true);
  assert.equal(run(coverageFixture(), { recommendationCoverageOk: false }).ok, false);
  assert.equal(run(coverageFixture(), { recommendationProjectionParityOk: false }).ok, false);
  const invalid = coverageFixture(); delete invalid.publicationAuthority;
  assert.equal(run(invalid).ok, false);
});

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
