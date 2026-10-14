'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createResearchArchiveRead, createResearchArchiveHandler, day, publicationKey } = require('../server/researchArchiveRead.cjs');
const reportStore = require('../server/researchReportStore.cjs');
const draft = { version: 3, businessDate: '2026-10-13', originalArchive: '球队资料' };
const key = 'reviewed-analysis-2026-10-13-batch-' + require('../scripts/recommendationPlatform/reviewedAnalysis.cjs').hash(draft), at = '2026-10-13T14:00:00.000Z';
const row = (k, payload) => {
  const json = JSON.stringify(payload);
  return { artifact_key: k, artifact_version: 'test-v1', generated_at: at, updated_at: at,
    payload_json: json, payload_sha256: crypto.createHash('sha256').update(json).digest('hex'), payload_bytes: Buffer.byteLength(json) };
};
function fixture({ ack = true, readonly = 'on', corrupt = false, bytes, actualBytes, replayError = false, readOfficial, trustRegistry, now = at, reports = [], reportMeta } = {}) {
  const records = new Map([[key, row(key, { version: 'reviewed-analysis-freeze-v1', draft, record: { businessDate: draft.businessDate } })]]);
  if (ack) records.set(key + '-ack', row(key + '-ack', { recordKey: key }));
  for (const report of reports) records.set(report.artifact_key, report);
  if (corrupt) records.get(key).payload_json += ' ';
  const queries = [], queryArgs = []; let released = 0, replayed = 0;
  const client = {
    async query(sql, args) {
      queries.push(sql); queryArgs.push(args);
      if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ now, readonly }] };
      if (sql.includes('artifact_key=ANY($1::text[])')) return { rows: reportMeta || args[0].filter(k => records.has(k)).map(k => {
        const r = records.get(k); return { ...r, actual_bytes: Buffer.byteLength(r.payload_json) };
      }) };
      if (sql.startsWith('SELECT artifact_key,payload_sha256')) return { rows: [records.get(key)] };
      if (sql.startsWith('SELECT payload_bytes')) return { rows: records.has(args[0]) ? [{ payload_bytes: bytes ?? records.get(args[0]).payload_bytes, actual_bytes: actualBytes ?? Buffer.byteLength(records.get(args[0]).payload_json) }] : [] };
      if (sql.includes('payload::text')) return { rows: records.has(args[0]) ? [records.get(args[0])] : [] };
      assert.match(sql, /^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/); return { rows: [] };
    }, release() { released++; },
  };
  const reader = createResearchArchiveRead({ pool: { connect: async () => client }, readOfficial, trustRegistry, replay: async (c, k, clock) => {
    assert.equal(c, client); assert.equal(k, key); assert.equal(clock, at); replayed++; if (replayError) throw Error('signature mismatch');
  } });
  return { reader, records, queries, queryArgs, released: () => released, replayed: () => replayed };
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

function savedReport(kind = reportStore.KINDS[0], date = draft.businessDate) {
  const k = reportStore.reportKey(date, kind);
  return { ...row(k, { version: reportStore.VERSION, businessDate: date, reportKind: kind,
    generatedAt: at, contents: { note: '独立报告；不是推荐采用证明' } }), artifact_version: reportStore.VERSION };
}

test('day index discovers the exact five scheduled slots without mixing publication counts', async () => {
  const r = savedReport(), otherDay = savedReport(reportStore.KINDS[0], '2026-10-12');
  const f = fixture({ reports: [r, otherDay] }), result = await f.reader.day(draft.businessDate);
  assert.equal(result.existingBatchCount, 1); assert.equal(result.existingReportCount, 1);
  assert.equal(result.reportSlots.length, 5); assert.equal(result.absenceDoesNotAuthorizeWriteRetry, true);
  const first = result.reportSlots[0];
  assert.equal(first.key, r.artifact_key); assert.equal(first.state, 'report-archived');
  assert.equal(first.payloadSha256, r.payload_sha256); assert.equal(first.payloadBytes, r.payload_bytes);
  assert.equal(first.generatedAt, at); assert.equal(first.receivedAt, at);
  assert.equal(first.archiveIntegrityVerified, true); assert.equal(first.publicationVerified, false);
  assert.equal(first.recommendationEligibilityVerified, false); assert.equal(first.verificationScope, 'archive-byte-integrity-only');
  assert.equal(first.originalJson, undefined);
  for (const missing of result.reportSlots.slice(1)) {
    assert.equal(missing.state, 'not-observed'); assert.equal(missing.archiveIntegrityVerified, false);
  }
  const sql = f.queries.findIndex(q => q.includes('artifact_key=ANY($1::text[])'));
  assert.match(f.queries[sql], /LIMIT 6/);
  assert.deepEqual(f.queryArgs[sql], [reportStore.KINDS.map(k => reportStore.reportKey(draft.businessDate, k))]);
  assert.equal(f.queries.at(-1), 'COMMIT'); assert.equal(result.productionWrites, 0);
});

test('all scheduled reports are independently hashed within the same readonly snapshot', async () => {
  const reports = reportStore.KINDS.map(k => savedReport(k));
  const f = fixture({ reports }), result = await f.reader.day(draft.businessDate);
  assert.equal(result.existingReportCount, 5);
  assert.ok(result.reportSlots.every(r => r.archiveIntegrityVerified && !r.publicationVerified));
  const readKeys = f.queries.flatMap((q, i) => q.includes('AS payload_json') ? f.queryArgs[i] : []);
  for (const r of reports) assert.equal(readKeys.filter(k => k === r.artifact_key).length, 1);
});

for (const [name, change, code, loadsPayload] of [
  ['wrong version', r => { r.artifact_version = 'unreviewed-v1'; }, 'REPORT_INDEX_IDENTITY', false],
  ['oversized bytes', r => { r.payload_bytes = reportStore.MAX_BYTES + 1; }, 'REPORT_INDEX_BYTE_BOUND', false],
  ['byte mismatch', r => { r.payload_bytes++; }, 'REPORT_INDEX_BYTE_BOUND', false],
  ['changed JSON', r => { r.payload_json = r.payload_json.replace('独立报告', '修改报告'); }, 'REPORT_HASH', true],
  ['future receipt', r => { r.updated_at = '2026-10-13T14:00:01.000Z'; }, 'REPORT_INDEX_FUTURE_CLOCK', true],
  ['receipt before generation', r => { r.updated_at = '2026-10-13T13:59:59.000Z'; }, 'REPORT_STORED_CLOCK', true],
  ['transplanted date', r => { const k = r.artifact_key; Object.assign(r, savedReport(reportStore.KINDS[0], '2026-10-12'), { artifact_key: k }); }, 'REPORT_STORED_IDENTITY', true],
]) {
  test('report index refuses ' + name + ' instead of treating the slot as missing', async () => {
    const r = savedReport(); change(r); const f = fixture({ reports: [r] });
    await assert.rejects(f.reader.day(draft.businessDate), { code });
    assert.equal(f.queries.at(-1), 'ROLLBACK'); assert.equal(f.released(), 1);
    const readKeys = f.queries.flatMap((q, i) => q.includes('AS payload_json') ? f.queryArgs[i] : []);
    assert.equal(readKeys.includes(r.artifact_key), loadsPayload);
  });
}

test('report index rejects count overflow and unexpected or duplicate identities', async () => {
  const r = savedReport(), meta = { ...r, actual_bytes: r.payload_bytes };
  for (const [reportMeta, code] of [
    [Array(6).fill(meta), 'REPORT_INDEX_COUNT_BOUND'],
    [[{ ...meta, artifact_key: 'private-model-registry' }], 'REPORT_INDEX_IDENTITY'],
    [[meta, meta], 'REPORT_INDEX_IDENTITY'],
  ]) {
    const f = fixture({ reports: [r], reportMeta });
    await assert.rejects(f.reader.day(draft.businessDate), { code });
    assert.equal(f.queries.at(-1), 'ROLLBACK');
  }
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

function officialFixture(change = () => {}, clockDelta = 0) {
  const signed = require('./fixtures/signed-live-had.cjs');
  const first = signed.snapshot([signed.source(1)]);
  const second = signed.snapshot([signed.source(1)], { pair: first.pair, mutate: e => {
    e.method = 'calculator';
    e.url = require('../scripts/sportteryEndpointContract.cjs').SPORTTERY_CALCULATOR_URL;
    e.sourceRequest = { ...e.sourceRequest, url: e.url, role: 'calculator' };
  } });
  const input = { endpoints: [...first.snapshot.endpoints, ...second.snapshot.endpoints] };
  change(input, first);
  return { input, f: fixture({ readOfficial: () => input, trustRegistry: first.registry,
    now: signed.stamp(signed.NOW + clockDelta) }) };
}
test('official source exports both complete Ed25519 signed payloads without promising event eligibility', async () => {
  const {input,f} = officialFixture();
  const result = await f.reader.official('2026-09-17');
  assert.equal(result.collectorSignatureVerified, true); assert.equal(result.eventEligibilityVerified, false);
  assert.equal(result.publishSupported, false); assert.equal(result.productionWrites, 0);
  assert.deepEqual(JSON.parse(result.source.json), input);
  assert.equal(result.source.bytes, Buffer.byteLength(result.source.json));
  assert.equal(result.source.sha256, crypto.createHash('sha256').update(result.source.json).digest('hex'));
  assert.match(f.queries[0], /READ ONLY/);
});
for (const [name,change,delta] of [
  ['tampered price', s => { s.endpoints[0].payload.value.matchInfoList[0].subMatchList[0].oddsList[0].h = 99; }, 0],
  ['missing calculator', s => { s.endpoints.pop(); }, 0],
  ['duplicate current', s => { s.endpoints.push(s.endpoints[0]); }, 0],
  ['untrusted key', (_s,first) => { first.registry.keys = []; }, 0],
  ['future acquisition', () => {}, -60000],
  ['expired acquisition', () => {}, 16*60000],
  ['cycle mismatch', s => { s.endpoints[1].sourceCycleId = 'other'; }, 0],
  ['oversize snapshot', s => { s.padding = 'x'.repeat(4*1024*1024); }, 0],
]) {
  test('official source refuses ' + name, async () => {
    const {f} = officialFixture(change,delta);
    await assert.rejects(f.reader.official('2026-09-17'), /OFFICIAL_SOURCE_UNAVAILABLE/);
    assert.equal(f.queries.at(-1), 'ROLLBACK'); assert.equal(f.released(), 1);
  });
}
test('official route uses existing authorization and cannot trigger collection or publish', async () => {
  const path = '/api/operator/research/official?date=2026-09-17';
  let calls = 0; const reader = { official: async () => { calls++; return {collectorSignatureVerified:true}; } };
  for (const [role,method,status] of [[null,'GET',401],['user','GET',403],['operator','POST',405],['operator','GET',200]]) {
    const result = await request({pathname:path,role,method,reader}); assert.equal(result.status,status);
  }
  assert.equal(calls,1);
});
