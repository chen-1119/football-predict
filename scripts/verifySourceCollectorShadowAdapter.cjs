'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createCollectorKeyPair } = require('../src/services/collectorAttestation.cjs');
const { fetchEndpoint, collectorErrorRecord } = require('./collectSportterySnapshot.cjs');
const { adaptSourceCollectorAttempt: adapt, adaptSourceCollectorSnapshot: snapshot,
  readSourceCollectorShadowFiles: readFiles, adaptSourceCollectorFailure: failureAdapter } = require('./sourceCollectorShadowAdapter.cjs');
const url = 'https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry?clientCode=3001';
const at = '2026-10-02T11:52:02.311Z', end = '2026-10-02T11:52:03.311Z', asOf = '2026-10-02T11:53:00Z';
const pair = createCollectorKeyPair({ keyId: 'test-source-shadow', independenceDomain: 'test-source-shadow' });
const closure = { verified: true, scope: 'current-schedule', startsAt: '2026-10-01T00:00:00+08:00',
  endsAt: '2026-10-05T00:00:00+08:00', verifiedAt: '2026-10-02T11:00:00Z',
  noticeUrl: 'https://www.mof.gov.cn/gp/xxgkml/zhs/202512/t20251225_3980248.htm' };
const options = { asOf, closure, trustRegistry: pair.registry, sourceDataUpdatedAt: '2026-09-30T15:34:00Z' };
const empty = () => ({ success: true, errorCode: '0', value: { totalCount: 0, matchInfoList: [] } });
async function collect(payload = empty(), failureStatus = null, rawOverride) {
  const rawBody = rawOverride || Buffer.from(JSON.stringify(payload));
  let ticks = 0;
  try {
    const entry = await fetchEndpoint({ id: 'current', method: 'current', role: 'current', url,
      sourceCycleId: 'test-cycle', attestationSigner: pair, clock: () => ticks++ ? end : at,
      request: async () => {
        const response = { statusCode: failureStatus ?? 200, headers: { 'content-type': 'application/json' }, rawBody, payload };
        if (failureStatus || rawOverride) { const e = new Error('private error text must not be copied'); e.response = response; throw e; }
        return response;
      } });
    return { entry, rawBody };
  } catch (error) { return { entry: collectorErrorRecord({ id: 'current', url, sourceCycleId: 'test-cycle', error }), rawBody }; }
}
test('real collector endpoint serialization connects signed empty response to shadow closure', async () => {
  const { entry } = await collect(); const before = JSON.stringify(entry), r = adapt(entry, options);
  assert.equal(r.state, 'closed'); assert.equal(r.evidence.signatureVerified, true);
  assert.equal(r.evidence.requestedAt, at); assert.equal(r.evidence.receivedAt, end);
  assert.equal(r.sourceDataUpdatedAt, options.sourceDataUpdatedAt); assert.equal(r.publicationAction, 'none');
  assert.equal(r.schedulingApplied, false); assert.equal(JSON.stringify(entry), before);
});
test('raw bytes rehash and canonical payload mismatch are independently checked', async () => {
  const { entry, rawBody } = await collect();
  assert.equal(adapt(entry, { ...options, rawBody }).evidence.rawBodyRehashed, true);
  assert.equal(adapt(entry, { ...options, rawBody: Buffer.from('tampered') }).state, 'unknown-evidence');
  const tampered = structuredClone(entry); tampered.payload.success = false;
  assert.equal(adapt(tampered, options).state, 'unknown-evidence');
});
test('HTTP status, endpoint scope, clocks and cycle cannot be relabelled after signing', async () => {
  const { entry } = await collect();
  for (const mutate of [e => e.httpStatus = 567, e => e.sourceCycleId = 'other',
    e => e.receivedAt = at, e => e.sourceRequest.role = 'all', e => e.sourceRequest.url = 'https://example.org/',
    e => e.rawSha256 = 'b'.repeat(64)]) {
    const e = structuredClone(entry); mutate(e); assert.equal(adapt(e, options).state, 'unknown-evidence');
  }
});
test('collector HTTP 567 audit is blocked even when response body looks like JSON', async () => {
  const { entry } = await collect(empty(), 567); const r = adapt(entry, options);
  assert.equal(r.state, 'blocked'); assert.equal(r.retryAfterSeconds, 21600);
  assert.equal(r.evidence.httpStatus, 567); assert.ok(r.evidence.rawSha256);
  assert.ok(!JSON.stringify(r).includes('private error text'));
});
test('proven JSON parse error differs from unknown legacy parser message', async () => {
  const { entry, rawBody } = await collect(undefined, null, Buffer.from('<html>bad</html>'));
  const r = adapt(entry, { ...options, rawBody });
  assert.equal(r.state, 'failed'); assert.equal(r.reason, 'raw-response-json-parse-failed');
  assert.equal(adapt(entry, options).state, 'unknown-evidence');
  assert.equal(adapt({ id: 'current', error: 'HTTP 567 invalid JSON' }, options).state, 'unknown-evidence');
});
test('in-process collector failure adapter consumes actual Error response bytes and audit', async () => {
  let ticks = 0;
  try {
    await fetchEndpoint({ id: 'current', role: 'current', url, sourceCycleId: 'failed-cycle',
      clock: () => ticks++ ? end : at, request: async () => {
        const error = new Error('private parser error');
        error.response = { statusCode: 200, headers: {}, rawBody: Buffer.from('broken JSON') }; throw error;
      } });
    assert.fail('collector must rethrow');
  } catch (error) {
    const r = failureAdapter(error, options);
    assert.equal(r.state, 'failed'); assert.equal(r.reason, 'raw-response-json-parse-failed');
    assert.equal(r.evidence.rawBodyRehashed, true); assert.equal(r.evidence.sourceCycleId, 'failed-cycle');
    assert.ok(!JSON.stringify(r).includes('private parser error'));
  }
});
test('valid JSON with wrong schema/provider rejection is failed and cannot become closed', async () => {
  for (const payload of [{ success: true, value: {} }, { ...empty(), success: false },
    { ...empty(), errorCode: '99' }, { success: true, value: { matchInfoList: [{ subMatchList: [null] }] } }]) {
    const { entry } = await collect(payload); assert.equal(adapt(entry, options).state, 'failed');
  }
});
test('rows are derived from payload and not borrowed from endpoint summary', async () => {
  const { entry } = await collect(); entry.rows = 999;
  assert.equal(adapt(entry, options).state, 'closed');
  const { entry: nonempty } = await collect({ success: true, value: { totalCount: 1, matchInfoList: [{ subMatchList: [{ matchId: '1' }] }] } });
  assert.equal(adapt(nonempty, options).state, 'available');
});
test('stale and future response evidence remains unknown, never refreshed by asOf', async () => {
  const { entry } = await collect();
  assert.equal(adapt(entry, { ...options, asOf: '2026-10-03T00:00:00Z' }).state, 'unknown-evidence');
  assert.equal(adapt(entry, { ...options, asOf: at }).state, 'unknown-evidence');
  assert.equal(adapt(entry, options).evidence.receivedAt, end);
});
test('reobserving same failed attempt does not increment failure count or retry clock', async () => {
  const { entry } = await collect(empty(), 567), first = adapt(entry, options);
  const second = adapt(entry, { ...options, previous: first, asOf: '2026-10-02T11:54:00Z' });
  assert.equal(first.consecutiveFailures, second.consecutiveFailures);
  assert.equal(first.nextAttemptAt, second.nextAttemptAt);
  assert.throws(() => adapt(entry, { ...options, previous: { consecutiveFailures: '1' } }));
});
test('latest current failure is selected; archive and calculator do not confer current freshness', async () => {
  const success = (await collect()).entry, failed = (await collect(empty(), 567)).entry;
  failed.receivedAt = '2026-10-02T11:52:04Z';
  assert.equal(snapshot({ endpoints: [success], errors: [failed] }, options).state, 'blocked');
  assert.equal(snapshot({ endpoints: [{ ...success, id: 'all', sourceRequest: { ...success.sourceRequest, role: 'all' } }] }, options).state, 'unknown-evidence');
  assert.equal(snapshot({ sourceCycleId: 'other', endpoints: [success] }, options).reason, 'snapshot-source-cycle-mismatch');
});
test('equal-clock conflicting attempts fail closed', async () => {
  const success = (await collect()).entry, failed = (await collect(empty(), 567)).entry;
  assert.equal(snapshot({ endpoints: [success], errors: [failed] }, options).reason, 'conflicting-current-attempts');
});
test('bounded snapshot file reader hashes originals and treats missing evidence explicitly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-shadow-'));
  try {
    const file = path.join(dir, 'snapshot.json'); const entry = (await collect()).entry;
    fs.writeFileSync(file, JSON.stringify({ sourceCycleId: entry.sourceCycleId, endpoints: [entry] }));
    assert.equal(readFiles([file], options).state, 'closed');
    assert.match(readFiles([file], options).inputFiles[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(readFiles([file, path.join(dir, 'missing.json')], options).state, 'unknown-evidence');
    const failedFile = path.join(dir, 'failed.json'), failure = (await collect(empty(), 567)).entry;
    fs.writeFileSync(failedFile, JSON.stringify({ errors: [failure] }));
    assert.equal(readFiles([file, failedFile], options).reason, 'conflicting-current-files');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('source-shadow-')); fs.rmSync(dir, { recursive: true, force: true });
  }
});
