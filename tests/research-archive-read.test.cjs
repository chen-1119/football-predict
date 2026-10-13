'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createResearchArchiveRead, createResearchArchiveHandler, day, publicationKey } = require('../server/researchArchiveRead.cjs');
const draft = { version: 3, businessDate: '2026-10-13', originalArchive: '球队资料' };
const key = 'reviewed-analysis-2026-10-13-batch-' + require('../scripts/recommendationPlatform/reviewedAnalysis.cjs').hash(draft), at = '2026-10-13T14:00:00.000Z';
const row = (k, payload) => {
  const json = JSON.stringify(payload);
  return { artifact_key: k, artifact_version: 'test-v1', generated_at: at, updated_at: at,
    payload_json: json, payload_sha256: crypto.createHash('sha256').update(json).digest('hex'), payload_bytes: Buffer.byteLength(json) };
};
function fixture({ ack = true, readonly = 'on', corrupt = false, bytes, actualBytes, replayError = false } = {}) {
  const records = new Map([[key, row(key, { version: 'reviewed-analysis-freeze-v1', draft, record: { businessDate: draft.businessDate } })]]);
  if (ack) records.set(key + '-ack', row(key + '-ack', { recordKey: key }));
  if (corrupt) records.get(key).payload_json += ' ';
  const queries = []; let released = 0, replayed = 0;
  const client = {
    async query(sql, args) {
      queries.push(sql);
      if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ now: at, readonly }] };
      if (sql.startsWith('SELECT artifact_key,payload_sha256')) return { rows: [records.get(key)] };
      if (sql.startsWith('SELECT payload_bytes')) return { rows: records.has(args[0]) ? [{ payload_bytes: bytes ?? records.get(args[0]).payload_bytes, actual_bytes: actualBytes ?? Buffer.byteLength(records.get(args[0]).payload_json) }] : [] };
      if (sql.includes('payload::text')) return { rows: records.has(args[0]) ? [records.get(args[0])] : [] };
      assert.match(sql, /^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/); return { rows: [] };
    }, release() { released++; },
  };
  const reader = createResearchArchiveRead({ pool: { connect: async () => client }, replay: async (c, k, clock) => {
    assert.equal(c, client); assert.equal(k, key); assert.equal(clock, at); replayed++; if (replayError) throw Error('signature mismatch');
  } });
  return { reader, records, queries, released: () => released, replayed: () => replayed };
}
test('invalid dates and arbitrary artifact keys are rejected', () => {
  for (const value of ['2026-02-30', '2026-1-1', '../secrets', '', null]) assert.throws(() => day(value));
  for (const value of ['model-registry', key + '-ack', key.replace('2026-10-13', '2026-02-30')]) assert.throws(() => publicationKey(value));
});
test('archive preserves original JSON bytes and independently invokes signed replay', async () => {
  const f = fixture(), result = await f.reader.artifact(key);
  assert.equal(result.state, 'committed-and-acknowledged'); assert.equal(result.verified, true);
  assert.equal(result.record.json, f.records.get(key).payload_json); assert.equal(f.replayed(), 1);
  assert.match(f.queries[0], /REPEATABLE READ READ ONLY/); assert.equal(f.queries.at(-1), 'COMMIT'); assert.equal(f.released(), 1);
  assert.equal(result.publishSupported, false); assert.equal(result.retryPublicationAutomatically, false);
});
test('missing ACK is explicit and never reported as unpublished or verified', async () => {
  const f = fixture({ ack: false }), r = await f.reader.artifact(key);
  assert.equal(r.state, 'record-present-ack-missing'); assert.equal(r.verified, false); assert.equal(f.replayed(), 0);
  assert.equal(r.retryPublicationAutomatically, false);
});
for (const options of [{ readonly: 'off' }, { corrupt: true }, { bytes: 8 * 1024 * 1024 + 1 }, {actualBytes: 8 * 1024 * 1024 + 1}, { replayError: true }]) {
  test('archive rejects unsafe evidence ' + JSON.stringify(options), async () => {
    const f = fixture(options); await assert.rejects(f.reader.artifact(key),
      options.readonly ? /READ_ONLY_REQUIRED/ : (options.corrupt || options.bytes || options.actualBytes) ? /ARCHIVE_BYTE_BOUND/ : /signature mismatch/);
    assert.equal(f.queries.at(-1), 'ROLLBACK'); assert.equal(f.released(), 1);
    if (options.bytes || options.actualBytes) assert.ok(!f.queries.some(q => q.includes('AS payload_json')));
  });
}
test('day index explicitly requires further verification', async () => {
  const r = await fixture().reader.day('2026-10-13');
  assert.equal(r.existingBatchCount, 1); assert.equal(r.publications[0].verified, false);
  assert.equal(r.publications[0].state, 'record-and-ack-present-unverified');
});
test('copied valid archive under a different batch identity cannot be accepted', async () => {
  const f=fixture();
  f.records.set(key,row(key,{version:'reviewed-analysis-freeze-v1',draft:{...draft,originalArchive:'different'},record:{businessDate:draft.businessDate}}));
  await assert.rejects(f.reader.artifact(key),/ARCHIVE_IDENTITY_CONFLICT/);
  assert.equal(f.replayed(),0);
});
async function request({ role = 'operator', method = 'GET', pathname = '/api/operator/research/day?date=2026-10-13', reader } = {}) {
  let response, calls = 0;
  const handler = createResearchArchiveHandler({ authenticate: async () => role ? { user: { role } } : null,
    reader: reader || { day: async () => { calls++; return { existingBatchCount: 0 }; } } });
  const res = { writeHead(status, headers) { response = { status, headers }; }, end(text) { response.body = JSON.parse(text); } };
  await handler({ method }, res, new URL(pathname, 'https://example.test'));
  return { ...response, calls };
}
for (const [role, status] of [[null, 401], ['user', 403], ['operator', 200], ['admin', 200]]) {
  test('role authorization ' + role, async () => {
    const r = await request({ role }); assert.equal(r.status, status); assert.equal(r.calls, status === 200 ? 1 : 0);
    assert.match(r.headers['Cache-Control'], /private, no-store/);
  });
}
test('POST cannot publish through the read gateway', async () => {
  const r = await request({ method: 'POST' }); assert.equal(r.status, 405); assert.equal(r.calls, 0);
});
for (const query of ['?date=2026-10-13&date=2026-10-14', '?path=/etc/passwd', '?date=2026-10-13&publish=true']) {
  test('query shape rejects ' + query, async () => {
    const r = await request({ pathname: '/api/operator/research/day' + query }); assert.equal(r.status, 400); assert.equal(r.calls, 0);
  });
}
test('signature failures are unavailable and never leak internal paths', async () => {
  const r = await request({ reader: { day: async () => { throw Error('/private/path/key'); } } });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'ARCHIVE_READ_UNAVAILABLE'); assert.equal(r.body.retryPublicationAutomatically, false);
});
test('concurrent cloud readers are bounded and capacity is returned after completion', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const handler = createResearchArchiveHandler({ authenticate: async () => ({ user: { role: 'operator' } }),
    reader: { day: async () => { await pending; return {}; } } });
  const response = () => ({ status: null, writeHead(status) { this.status = status; }, end() {} });
  const req = { method: 'GET' }, url = new URL('https://example.test/api/operator/research/day?date=2026-10-13');
  const a = response(), b = response(), c = response();
  const first = handler(req, a, url), second = handler(req, b, url);
  await handler(req, c, url); assert.equal(c.status, 503);
  release(); await Promise.all([first, second]); assert.equal(a.status, 200); assert.equal(b.status, 200);
  const next = response(); await handler(req, next, url); assert.equal(next.status, 200);
});
